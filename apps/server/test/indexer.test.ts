import { describe, expect, it } from "vitest";
import { SettlementIndexer } from "../src/indexer/settlements.js";
import { FIXTURE_BLOCKS, fakeSqd, fixedFx, memoryDb } from "./helpers.js";

const first = FIXTURE_BLOCKS[0]!.header.number;
const last = FIXTURE_BLOCKS.at(-1)!.header.number;

describe("SettlementIndexer", () => {
  it("indexes fixtures into settlements, pair_days and relayers", async () => {
    const db = memoryDb();
    const ingested: number[] = [];
    const indexer = new SettlementIndexer(db, fakeSqd(FIXTURE_BLOCKS), fixedFx(db), {
      fromBlock: first,
      onIngest: (rows) => ingested.push(rows.length),
    });
    expect(await indexer.step(last)).toBe(FIXTURE_BLOCKS.length);
    expect(indexer.cursor).toBe(last);
    expect(ingested.reduce((a, b) => a + b, 0)).toBe(FIXTURE_BLOCKS.length);
    const relayers = db
      .prepare("SELECT address, settlements FROM relayers ORDER BY settlements DESC")
      .all() as {
      settlements: number;
    }[];
    expect(relayers.reduce((n, r) => n + r.settlements, 0)).toBe(FIXTURE_BLOCKS.length);
    const pd = db.prepare("SELECT SUM(count) AS n FROM pair_days").get() as { n: number };
    expect(pd.n).toBe(FIXTURE_BLOCKS.length);
  });

  it("never double counts when a range is replayed", async () => {
    const db = memoryDb();
    const fx = fixedFx(db);
    await new SettlementIndexer(db, fakeSqd(FIXTURE_BLOCKS), fx, { fromBlock: first }).step(last);
    db.prepare("DELETE FROM cursors").run();
    const again = await new SettlementIndexer(db, fakeSqd(FIXTURE_BLOCKS), fx, { fromBlock: first }).step(
      last,
    );
    expect(again).toBe(0);
    expect((db.prepare("SELECT SUM(count) AS n FROM pair_days").get() as { n: number }).n).toBe(
      FIXTURE_BLOCKS.length,
    );
  });

  it("respects toBlock and resumes from the cursor", async () => {
    const db = memoryDb();
    const fx = fixedFx(db);
    const mid = FIXTURE_BLOCKS[2]!.header.number;
    await new SettlementIndexer(db, fakeSqd(FIXTURE_BLOCKS), fx, { fromBlock: first, toBlock: mid }).step(
      last,
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM settlements").get() as { n: number }).n).toBe(3);
    const rest = await new SettlementIndexer(db, fakeSqd(FIXTURE_BLOCKS), fx, { fromBlock: first }).step(
      last,
    );
    expect(rest).toBe(2);
  });

  it("leaves the cursor alone when the portal sends nothing", async () => {
    const db = memoryDb();
    const indexer = new SettlementIndexer(db, fakeSqd([]), fixedFx(db), { fromBlock: 500 });
    expect(await indexer.step(1_000)).toBe(0);
    expect(indexer.cursor).toBe(499);
  });

  it("stops cleanly when aborted", async () => {
    const db = memoryDb();
    const controller = new AbortController();
    controller.abort();
    const indexer = new SettlementIndexer(db, fakeSqd(FIXTURE_BLOCKS), fixedFx(db), { fromBlock: first });
    expect(await indexer.step(last, controller.signal)).toBe(0);
    expect(indexer.cursor).toBe(first - 1);
  });
});

describe("SqdClient retries", () => {
  it("treats overload, rate limits and 5xx as retryable, and client errors as final", async () => {
    const { isRetryable } = await import("../src/indexer/sqd.js");
    for (const s of [408, 429, 500, 502, 503, 504, 529]) expect(isRetryable(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422]) expect(isRetryable(s)).toBe(false);
  });

  it("recovers from a 529 and streams the blocks", async () => {
    const { SqdClient } = await import("../src/indexer/sqd.js");
    const { vi } = await import("vitest");
    let calls = 0;
    const block = JSON.stringify({ header: { number: 5, timestamp: 1 } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1)
          return new Response('{"error":"overloaded"}', { status: 529, headers: { "retry-after": "0" } });
        if (calls === 2) return new Response(`${block}\n`, { status: 200 });
        return new Response(null, { status: 204 });
      }),
    );
    const got: number[] = [];
    for await (const b of new SqdClient("https://sqd.test").stream({ fromBlock: 5, toBlock: 9 }))
      got.push(b.header.number);
    expect(got).toEqual([5]);
    expect(calls).toBe(3);
    vi.unstubAllGlobals();
  });
});
