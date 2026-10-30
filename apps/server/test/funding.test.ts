import { assess, Ledger, type PairFlow, TOPICS } from "assayscore-core";
import { type Hex, pad } from "viem";
import { describe, expect, it } from "vitest";
import { loadContext } from "../src/analysis.js";
import { Enricher } from "../src/enrich/enricher.js";
import {
  attributeFunding,
  FUNDING_TOKENS,
  fundingPass,
  recheckContractFunding,
  scanFirstFunders,
} from "../src/enrich/funding-scan.js";
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

const noSender = async (): Promise<never> => {
  throw new Error("no contract funders here, so no sender lookups");
};
const quiet = {
  getCode: async () => "0x" as Hex,
  getTransactionCount: async () => 3,
  getTransaction: noSender,
};

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
    const busy = {
      getCode: async () => "0x" as Hex,
      getTransactionCount: async () => 50_000,
      getTransaction: noSender,
    };
    await fundingPass(db, src, busy, { toBlock: 1_000 });
    const pub = db.prepare("SELECT address, funder_is_public FROM funding ORDER BY address").all();
    // FUNDER sent 50,000 transactions: public. A is busy too but pays over x402, so it is not.
    expect(pub).toEqual([
      { address: A, funder_is_public: 1 },
      { address: B, funder_is_public: 0 },
    ]);
  });
});

describe("funding through a contract", () => {
  const SELLER = "0x00000000000000000000000000000000000005e1";
  const DISPERSE = "0x000000000000000000000000000000000000d15e";
  const RELAYER = "0x0000000000000000000000000000000000000e1a";
  const P1 = "0x00000000000000000000000000000000000000a1";
  const P2 = "0x00000000000000000000000000000000000000a2";
  const txOf = (block: number) => `0x${block.toString(16).padStart(64, "0")}` as Hex;

  /** A chain where DISPERSE is a contract, RELAYER is busy, and each transaction has a known sender. */
  function chain(senders: Record<number, string>, opts: { failSender?: boolean } = {}) {
    const lookups: Hex[] = [];
    return {
      lookups,
      getCode: async ({ address }: { address: string }) =>
        address === DISPERSE ? ("0x6080" as Hex) : ("0x" as Hex),
      getTransactionCount: async ({ address }: { address: string }) => (address === RELAYER ? 80_000 : 4),
      getTransaction: async ({ hash }: { hash: Hex }) => {
        lookups.push(hash);
        if (opts.failSender) throw new Error("rpc down");
        const block = Number.parseInt(hash, 16);
        return { from: senders[block] as `0x${string}` };
      },
    };
  }

  function paying(db: ReturnType<typeof memoryDb>, ...payers: string[]) {
    const pd = db.prepare(
      "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 1, 10, 1, 1, '0x1')",
    );
    for (const p of payers) pd.run(p, SELLER);
  }

  const row = (db: ReturnType<typeof memoryDb>, a: string) =>
    db
      .prepare("SELECT funder, funder_is_public, funded_via, funding_tx FROM funding WHERE address = ?")
      .get(a) as {
      funder: string;
      funder_is_public: number;
      funded_via: string | null;
      funding_tx: string | null;
    };

  it("credits a batch send to the seller that called the contract, and the seller's revenue from it is struck out", async () => {
    const db = memoryDb();
    paying(db, P1, P2);
    const src = portal([transfer(40, DISPERSE, P1, CELO, 0), transfer(41, DISPERSE, P2, CELO, 0)]);
    const rpc = chain({ 40: SELLER, 41: SELLER.toUpperCase().replace("0X", "0x") });
    await fundingPass(db, src, rpc, { toBlock: 1_000 });
    for (const [p, b] of [
      [P1, 40],
      [P2, 41],
    ] as const)
      expect(row(db, p)).toEqual({
        funder: SELLER,
        funder_is_public: 0,
        funded_via: DISPERSE,
        funding_tx: txOf(b),
      });

    // End to end: both payers count as funded by the seller, and the finding says how.
    const flows: PairFlow[] = [P1, P2].map((p) => ({
      payer: p as `0x${string}`,
      payee: SELLER,
      count: 3,
      usd: 10,
      firstTs: 1_792_000_000,
      lastTs: 1_792_400_000,
      days: [20740, 20741, 20742],
      sampleTxs: [],
    }));
    const a = assess(new Ledger(flows), SELLER, loadContext(db, 1_792_500_000));
    expect(a.seller.organicUsd).toBe(0);
    expect(a.seller.fundedUsd).toBe(20);
    const flag = a.flags.find((f) => f.code === "SELLER_FUNDED_PAYERS");
    expect(flag?.detail).toMatch(/All of them were funded through a contract this address called/);
    expect(loadContext(db).funding.get(P1)?.fundedVia).toBe(DISPERSE);
  });

  it("keeps the contract as a public source when the wallet funded itself through it, or a busy relayer called it", async () => {
    const db = memoryDb();
    paying(db, P1, P2);
    // P1 swapped for itself; RELAYER (80,000 transactions) sent P2's funding for someone.
    const src = portal([transfer(50, DISPERSE, P1), transfer(51, DISPERSE, P2)]);
    await fundingPass(db, src, chain({ 50: P1, 51: RELAYER }), { toBlock: 1_000 });
    expect(row(db, P1)).toEqual({
      funder: DISPERSE,
      funder_is_public: 1,
      funded_via: null,
      funding_tx: txOf(50),
    });
    expect(row(db, P2)).toEqual({
      funder: DISPERSE,
      funder_is_public: 1,
      funded_via: null,
      funding_tx: txOf(51),
    });
  });

  it("does not look up senders for direct transfers", async () => {
    const db = memoryDb();
    paying(db, P1);
    const rpc = chain({});
    await fundingPass(db, portal([transfer(60, FUNDER, P1)]), rpc, { toBlock: 1_000 });
    expect(rpc.lookups).toEqual([]);
    expect(row(db, P1)).toEqual({
      funder: FUNDER,
      funder_is_public: 0,
      funded_via: null,
      funding_tx: txOf(60),
    });
  });

  it("leaves the contract in place when the sender cannot be read, and the recheck credits it later", async () => {
    const db = memoryDb();
    paying(db, P1);
    const src = portal([transfer(70, DISPERSE, P1)]);
    await fundingPass(db, src, chain({ 70: SELLER }, { failSender: true }), { toBlock: 1_000 });
    expect(row(db, P1)).toEqual({
      funder: DISPERSE,
      funder_is_public: 1,
      funded_via: null,
      funding_tx: null,
    });
    // Still failing: the row stays queued, nothing is counted as done.
    expect(
      await recheckContractFunding(db, src, chain({ 70: SELLER }, { failSender: true }), { toBlock: 1_000 }),
    ).toBe(0);
    expect(await recheckContractFunding(db, src, chain({ 70: SELLER }), { toBlock: 1_000 })).toBe(1);
    expect(row(db, P1)).toEqual({
      funder: SELLER,
      funder_is_public: 0,
      funded_via: DISPERSE,
      funding_tx: txOf(70),
    });
    // Done rows are not looked at again.
    expect(await recheckContractFunding(db, src, chain({ 70: SELLER }), { toBlock: 1_000 })).toBe(0);
  });

  it("rechecks contract funding recorded before contracts were seen through, and gives up on transfers it cannot find", async () => {
    const db = memoryDb();
    paying(db, P1, P2);
    const old = db.prepare(
      "INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error) VALUES (?, ?, 1, 1, 1, 5, NULL)",
    );
    old.run(P1, DISPERSE);
    old.run(P2, DISPERSE);
    db.prepare(
      "INSERT INTO funder_profiles (address, is_public, reason, fetched_at) VALUES (?, 1, 'contract', ?)",
    ).run(DISPERSE, Math.floor(Date.now() / 1000));
    // Only P1's transfer is in the source.
    const src = portal([transfer(80, DISPERSE, P1)]);
    expect(await recheckContractFunding(db, src, chain({ 80: SELLER }), { toBlock: 1_000 })).toBe(2);
    expect(row(db, P1)).toEqual({
      funder: SELLER,
      funder_is_public: 0,
      funded_via: DISPERSE,
      funding_tx: txOf(80),
    });
    expect(row(db, P2)).toEqual({ funder: DISPERSE, funder_is_public: 1, funded_via: null, funding_tx: "" });
    expect(await recheckContractFunding(db, src, chain({ 80: SELLER }), { toBlock: 1_000 })).toBe(0);
  });

  it("credits contract funding found by the Blockscout fallback too", async () => {
    const db = memoryDb();
    paying(db, P1);
    db.prepare(
      "INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error) VALUES (?, NULL, NULL, NULL, 0, 0, NULL)",
    ).run(P1);
    const blockscout = {
      funding: async () => ({ funder: DISPERSE, fundedAt: 100, firstSeenAt: 90, tx: txOf(90) }),
      funderProfile: async (a: string) =>
        a === DISPERSE
          ? { isPublic: true, reason: "contract Disperse" }
          : { isPublic: false, reason: "4 transactions" },
    };
    const client = { getTransaction: async () => ({ from: SELLER }) };
    const enricher = new Enricher(db, blockscout as never, client as never, () => {});
    // The queue holds P1 and the seller itself (a party with no funding row yet).
    expect(await enricher.fundingBatch(10)).toBe(2);
    expect(row(db, P1)).toEqual({
      funder: SELLER,
      funder_is_public: 0,
      funded_via: DISPERSE,
      funding_tx: txOf(90),
    });
  });

  it("attributes in the order the rules give", async () => {
    const profile = async (a: string) =>
      a === DISPERSE ? { isPublic: true, reason: "contract" } : { isPublic: a === RELAYER, reason: "n" };
    const hit = { funder: DISPERSE as `0x${string}`, tx: txOf(1) };
    const via = (from: string) => async () => from as `0x${string}`;
    expect(await attributeFunding(P1, hit, profile, via(SELLER))).toEqual({
      funder: SELLER,
      isPublic: false,
      via: DISPERSE,
      settled: true,
    });
    expect((await attributeFunding(P1, hit, profile, via(P1))).funder).toBe(DISPERSE);
    expect((await attributeFunding(P1, hit, profile, via(RELAYER))).funder).toBe(DISPERSE);
    expect((await attributeFunding(P1, { ...hit, tx: null }, profile, via(SELLER))).settled).toBe(false);
    // A busy wallet that is not a contract is public on its own terms; no sender lookup.
    const busyEoa = { funder: RELAYER as `0x${string}`, tx: txOf(2) };
    expect(await attributeFunding(P1, busyEoa, profile, noSender)).toEqual({
      funder: RELAYER,
      isPublic: true,
      via: null,
      settled: true,
    });
  });
});
