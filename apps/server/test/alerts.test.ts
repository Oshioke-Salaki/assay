import { createHmac } from "node:crypto";
import type { Assessment } from "assayscore-core";
import { describe, expect, it, vi } from "vitest";
import { changes, signDelivery, stateOf, WATCH_DAYS, Watches, type WatchState } from "../src/alerts.js";
import { memoryDb } from "./helpers.js";

const ADDR = `0x${"a".repeat(40)}` as const;
const DAY = 86_400;

/** The parts of an assessment the alerts read. */
function assessment(over: Partial<Assessment> & { gross?: number; organic?: number } = {}): Assessment {
  const gross = over.gross ?? 100;
  const organic = over.organic ?? 90;
  return {
    address: ADDR,
    role: "seller",
    score: 70,
    rating: "A",
    components: null,
    seller: {
      grossUsd: gross,
      organicUsd: organic,
      loopOffsetUsd: 0,
      fundedUsd: gross - organic,
      settlements: 40,
      payers: 10,
      organicPayers: 9,
      firstTs: 1,
      lastTs: 2,
      payerLines: [],
    },
    buyer: {
      spentUsd: 0,
      loopSpendUsd: 0,
      settlements: 0,
      sellers: 0,
      firstTs: null,
      lastTs: null,
      counterparties: [],
    },
    loop: null,
    flags: [],
    identity: { agentIds: [], human: null, funding: null },
    fundingCoverage: 1,
    methodologyVersion: "test",
    ...over,
  } as Assessment;
}

function harness(
  opts: { fetchImpl?: typeof fetch; lookup?: (h: string) => Promise<{ address: string }[]> } = {},
) {
  const db = memoryDb();
  let current = assessment();
  const analysis = { assess: () => current };
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl =
    opts.fetchImpl ??
    (vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch);
  const w = new Watches(db, analysis, {
    fetchImpl,
    lookup: opts.lookup ?? (async () => [{ address: "93.184.216.34" }]),
    publicUrl: "https://api.test",
    webUrl: "https://web.test",
  });
  return { db, w, calls, set: (a: Assessment) => (current = a) };
}

describe("state and changes", () => {
  it("reads the rating, verdict, critical findings and X warnings", () => {
    const s = stateOf(assessment(), null);
    expect(s).toEqual({ rating: "A", score: 70, verdict: "pass", critical: [], xWarnings: 0 });
  });

  it("names each change, and nothing on the first look", () => {
    const a: WatchState = { rating: "A", score: 70, verdict: "pass", critical: [], xWarnings: 0 };
    expect(changes(null, a)).toEqual([]);
    expect(changes(a, a)).toEqual([]);
    const b: WatchState = {
      rating: "D",
      score: 5,
      verdict: "block",
      critical: ["SELLER_FUNDED_PAYERS"],
      xWarnings: 2,
    };
    expect(changes(a, b).map((c) => c.event)).toEqual([
      "rating.changed",
      "verdict.changed",
      "finding.critical",
      "x.warnings",
    ]);
    expect(changes(a, b)[0]?.detail).toBe("Rating moved from A to D.");
    // Warnings that were already there are not news again.
    expect(changes(b, { ...b, xWarnings: 3 })).toEqual([]);
  });
});

describe("Watches", () => {
  it("refuses URLs that are not public https, before anything is stored", () => {
    const { w, db } = harness();
    for (const url of [
      "http://a.example/h",
      "https://localhost/h",
      "https://10.0.0.1/h",
      "ftp://a.example",
      "https://user:pw@a.example/h",
      `https://a.example/${"x".repeat(600)}`,
    ]) {
      const r = w.create(ADDR, url, 1000);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM watches").get() as { n: number }).n).toBe(0);
  });

  it("creates a watch with a one-time secret, queues watch.started, and renews instead of duplicating", () => {
    const { w, db } = harness();
    const r = w.create(ADDR, "https://hooks.example/assay", 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toMatch(/^w_[0-9a-f]{16}$/);
    expect(r.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(r.expiresAt).toBe(1000 + WATCH_DAYS * DAY);
    expect(r.renewed).toBe(false);
    const queued = db.prepare("SELECT event FROM watch_deliveries").all();
    expect(queued).toEqual([{ event: "watch.started" }]);
    const again = w.create(ADDR, "https://hooks.example/assay", 2000);
    expect(again).toMatchObject({
      ok: true,
      id: r.id,
      secret: null,
      renewed: true,
      expiresAt: r.expiresAt + WATCH_DAYS * DAY,
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM watches").get() as { n: number }).n).toBe(1);
  });

  it("caps watches per host", () => {
    const { w } = harness();
    for (let i = 0; i < 100; i++)
      expect(w.create(`0x${i.toString(16).padStart(40, "0")}`, `https://flood.example/${i}`, 1).ok).toBe(
        true,
      );
    const r = w.create(ADDR, "https://flood.example/one-more", 1);
    expect(r).toMatchObject({ ok: false, status: 429 });
  });

  it("delivers a signed POST that the receiver can verify, and marks it delivered", async () => {
    const { w, calls, db } = harness();
    const r = w.create(ADDR, "https://hooks.example/assay", 1000);
    if (!r.ok) throw new Error("no watch");
    const out = await w.deliverDue(1000);
    expect(out).toEqual({ delivered: 1, failed: 0 });
    const [call] = calls;
    expect(call?.url).toBe("https://hooks.example/assay");
    expect(call?.init.redirect).toBe("manual");
    const h = call!.init.headers as Record<string, string>;
    const body = String(call!.init.body);
    expect(h["x-assay-event"]).toBe("watch.started");
    expect(h["x-assay-watch"]).toBe(r.id);
    const expected = `sha256=${createHmac("sha256", r.secret!).update(`${h["x-assay-timestamp"]}.${body}`).digest("hex")}`;
    expect(h["x-assay-signature"]).toBe(expected);
    expect(signDelivery(r.secret!, Number(h["x-assay-timestamp"]), body)).toBe(expected);
    const payload = JSON.parse(body) as {
      id: number;
      event: string;
      address: string;
      current: WatchState;
      previous: null;
      report: string;
    };
    expect(payload).toMatchObject({
      event: "watch.started",
      address: ADDR,
      previous: null,
      report: `https://web.test/address/${ADDR}`,
    });
    expect(payload.current.rating).toBe("A");
    expect(db.prepare("SELECT delivered_at, last_status FROM watch_deliveries").get()).toEqual({
      delivered_at: 1000,
      last_status: 200,
    });
  });

  it("queues one delivery per change when the picture moves, with previous and current", async () => {
    const { w, set, calls, db } = harness();
    w.create(ADDR, "https://hooks.example/assay", 1000);
    await w.deliverDue(1000);
    expect(w.detect(2000)).toBe(0);
    set(
      assessment({
        rating: "D",
        score: 3,
        organic: 5,
        flags: [{ code: "SELLER_FUNDED_PAYERS", severity: "critical", title: "t", detail: "d" }],
      } as never),
    );
    expect(w.detect(3000)).toBe(3);
    await w.deliverDue(3000);
    const events = calls.map((c) => (c.init.headers as Record<string, string>)["x-assay-event"]);
    expect(events).toEqual(["watch.started", "rating.changed", "verdict.changed", "finding.critical"]);
    const last = JSON.parse(String(calls[3]!.init.body)) as {
      previous: WatchState;
      current: WatchState;
      detail: string;
    };
    expect(last.previous.rating).toBe("A");
    expect(last.current.rating).toBe("D");
    expect(last.detail).toBe("New critical finding: SELLER_FUNDED_PAYERS.");
    // The new state is remembered, so nothing is sent twice.
    expect(w.detect(4000)).toBe(0);
    expect(
      (db.prepare("SELECT last_state FROM watches").get() as { last_state: string }).last_state,
    ).toContain('"rating":"D"');
  });

  it("retries with growing waits, then gives up on the delivery and counts a failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const { w, db } = harness({ fetchImpl });
    w.create(ADDR, "https://down.example/h", 1000);
    const waits: number[] = [];
    let t = 1000;
    for (let i = 0; i < 6; i++) {
      const row = db.prepare("SELECT next_at, attempts FROM watch_deliveries").get() as {
        next_at: number;
        attempts: number;
      };
      t = row.next_at;
      await w.deliverDue(t);
      const after = db
        .prepare("SELECT next_at, attempts, last_status, last_error FROM watch_deliveries")
        .get() as { next_at: number; attempts: number; last_status: number; last_error: string };
      waits.push(after.next_at - t);
      expect(after.last_status).toBe(500);
      expect(after.last_error).toBe("answered 500");
    }
    expect(waits).toEqual([60, 300, 1800, 7200, 43200, 43200]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    // Past the limit it is left alone.
    await w.deliverDue(t + 100_000);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(
      (
        db.prepare("SELECT failures, disabled_at FROM watches").get() as {
          failures: number;
          disabled_at: null;
        }
      ).failures,
    ).toBe(1);
  });

  it("never posts to a host that resolves inside a network, and does not follow redirects", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 302, headers: { location: "https://elsewhere" } }),
    ) as unknown as typeof fetch;
    const { w, db } = harness({ fetchImpl, lookup: async () => [{ address: "10.1.2.3" }] });
    w.create(ADDR, "https://rebinding.example/h", 1000);
    await w.deliverDue(1000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      (db.prepare("SELECT last_error FROM watch_deliveries").get() as { last_error: string }).last_error,
    ).toMatch(/private address/);

    const { w: w2, db: db2 } = harness({ fetchImpl });
    w2.create(ADDR, "https://moved.example/h", 1000);
    await w2.deliverDue(1000);
    expect(
      (
        db2.prepare("SELECT last_error, delivered_at FROM watch_deliveries").get() as {
          last_error: string;
          delivered_at: null;
        }
      ).last_error,
    ).toBe("redirects are not followed");
  });

  it("skips expired watches, and status and cancel need the secret", async () => {
    const { w, calls, set } = harness();
    const r = w.create(ADDR, "https://hooks.example/assay", 1000);
    if (!r.ok) throw new Error("no watch");
    await w.deliverDue(1000);
    set(assessment({ rating: "B" }));
    expect(w.detect(1000 + WATCH_DAYS * DAY + 1)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(w.status(r.id, undefined).kind).toBe("forbidden");
    expect(w.status(r.id, "wrong").kind).toBe("forbidden");
    expect(w.status("w_nope", r.secret!).kind).toBe("missing");
    const s = w.status(r.id, r.secret!);
    expect(s.kind).toBe("ok");
    if (s.kind === "ok") {
      expect(s.watch).toMatchObject({ id: r.id, address: ADDR, failures: 0 });
      expect(s.deliveries).toHaveLength(1);
    }
    expect(w.cancel(r.id, "wrong")).toBe("forbidden");
    expect(w.cancel(r.id, r.secret!)).toBe("ok");
    expect(w.cancel(r.id, r.secret!)).toBe("missing");
  });

  it("prunes old deliveries and long-expired watches", () => {
    const { w, db } = harness();
    w.create(ADDR, "https://hooks.example/assay", 1000);
    w.prune(1000 + 200 * DAY);
    expect((db.prepare("SELECT COUNT(*) AS n FROM watches").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM watch_deliveries").get() as { n: number }).n).toBe(0);
  });
});
