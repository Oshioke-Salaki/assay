import { TOPICS } from "@assay/core";
import { type Hex, pad } from "viem";
import { describe, expect, it } from "vitest";
import { Enricher } from "../src/enrich/enricher.js";
import { FUNDING_TOKENS, fundingPass, scanFirstFunders } from "../src/enrich/funding-scan.js";
import type { BlockSource, SqdBlock, SqdQuery } from "../src/indexer/sqd.js";
import { memoryDb } from "./helpers.js";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const FUNDER = "0x0000000000000000000000000000000000000f01";
const OTHER = "0x0000000000000000000000000000000000000f02";
const ZERO = "0x0000000000000000000000000000000000000000";
const CELO = FUNDING_TOKENS[0]!;

function transfer(block: number, from: string, to: string, token = CELO, logIndex = 0): SqdBlock {
  return {
    header: { number: block, timestamp: 1_700_000_000 + block },
    logs: [
      {
        address: token,
        topics: [TOPICS.erc20Transfer, pad(from as Hex, { size: 32 }), pad(to as Hex, { size: 32 })],
        data: "0x01",
        logIndex,
        transactionIndex: 0,
        transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
      },
    ],
  } as SqdBlock;
}

/** Serves blocks the way the portal would: from/to honoured, logs filtered by token and recipient. */
function portal(blocks: SqdBlock[], head = 1_000): BlockSource & { queries: SqdQuery[] } {
  const queries: SqdQuery[] = [];
  return {
    queries,
    finalizedHead: async () => ({ number: head, hash: "0x" }),
    async *stream(q: SqdQuery) {
      queries.push(q);
      const f = (q.logs as { address: string[]; topic2: string[] }[])[0]!;
      for (const b of blocks) {
        if (b.header.number < q.fromBlock || b.header.number > (q.toBlock ?? head)) continue;
        const logs = (b.logs ?? []).filter(
          (l) => f.address.includes(l.address) && f.topic2.includes(l.topics[2]!),
        );
        if (logs.length > 0) yield { ...b, logs };
      }
    },
  };
}

const quiet = { getCode: async () => "0x" as Hex, getTransactionCount: async () => 3 };

describe("SQD funding scan", () => {
  it("takes the first inbound transfer from someone else, skipping mints and self-transfers", async () => {
    const src = portal([
      transfer(10, ZERO, A),
      transfer(11, A, A),
      transfer(12, FUNDER, A),
      transfer(13, OTHER, A),
      transfer(20, OTHER, B),
    ]);
    const found = await scanFirstFunders(src, [A, B, C], { toBlock: 1_000 });
    expect(found.get(A)).toMatchObject({ funder: FUNDER, block: 12 });
    expect(found.get(B)).toMatchObject({ funder: OTHER, block: 20 });
    expect(found.has(C)).toBe(false);
  });

  it("ignores tokens that are not funding tokens", async () => {
    const src = portal([
      transfer(5, OTHER, A, "0x00000000000000000000000000000000000000dd"),
      transfer(9, FUNDER, A),
    ]);
    expect((await scanFirstFunders(src, [A], { toBlock: 100 })).get(A)?.funder).toBe(FUNDER);
  });

  it("narrows the filter as addresses settle, resuming after the last block", async () => {
    const addrs = Array.from({ length: 10 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const src = portal(addrs.map((a, i) => transfer(100 + i, FUNDER, a)));
    const found = await scanFirstFunders(src, addrs as `0x${string}`[], { toBlock: 1_000 });
    expect(found.size).toBe(10);
    expect(src.queries.length).toBeGreaterThan(1);
    const second = src.queries[1]!;
    expect(second.fromBlock).toBeGreaterThan(100);
    expect((second.logs as { topic2: string[] }[])[0]!.topic2.length).toBeLessThan(10);
  });

  it("fills the funding table and hands what it could not find to the Blockscout fallback", async () => {
    const db = memoryDb();
    const pd = db.prepare(
      "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 1, ?, 1, 1, '0x1')",
    );
    pd.run(A, B, 50);
    pd.run(C, B, 5);
    const src = portal([transfer(12, FUNDER, A), transfer(30, OTHER, B)]);
    const done = await fundingPass(db, src, quiet, { toBlock: 1_000 });
    expect(done).toBe(3);
    const rows = db.prepare("SELECT address, funder, fetched_at FROM funding ORDER BY address").all() as {
      address: string;
      funder: string | null;
      fetched_at: number;
    }[];
    expect(rows).toEqual([
      { address: A, funder: FUNDER, fetched_at: expect.any(Number) },
      { address: B, funder: OTHER, fetched_at: expect.any(Number) },
      { address: C, funder: null, fetched_at: 0 },
    ]);
    // A second pass has nothing new to do.
    expect(await fundingPass(db, src, quiet, { toBlock: 1_000 })).toBe(0);

    // With a scan configured, Blockscout leaves never-seen addresses alone and takes only C.
    const enricher = new Enricher(db, {} as never, {} as never, () => {}, {
      source: src,
      rpc: quiet,
      head: async () => 1_000,
    });
    expect(enricher.fundingQueue(10)).toEqual([C]);
    pd.run("0x00000000000000000000000000000000000000d4", B, 1);
    expect(enricher.fundingQueue(10)).toEqual([C]);
    // Without one, Blockscout looks up everything itself, as before.
    const plain = new Enricher(db, {} as never, {} as never, () => {});
    expect(plain.fundingQueue(10)).toContain("0x00000000000000000000000000000000000000d4");
  });

  it("marks contract and very busy funders as public, never an x402 participant", async () => {
    const db = memoryDb();
    db.prepare(
      "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 1, 10, 1, 1, '0x1')",
    ).run(A, B);
    const src = portal([transfer(12, FUNDER, A), transfer(13, A, B)]);
    const busy = { getCode: async () => "0x" as Hex, getTransactionCount: async () => 50_000 };
    await fundingPass(db, src, busy, { toBlock: 1_000 });
    const pub = db.prepare("SELECT address, funder_is_public FROM funding ORDER BY address").all();
    // FUNDER sent 50,000 transactions: public. A is busy too but pays over x402, so it is not.
    expect(pub).toEqual([
      { address: A, funder_is_public: 1 },
      { address: B, funder_is_public: 0 },
    ]);
  });
});
