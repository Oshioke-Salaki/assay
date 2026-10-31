import { TOPICS } from "assayscore-core";
import Database from "better-sqlite3";
import { type Hex, pad } from "viem";
import { describe, expect, it } from "vitest";
import { loadContext } from "../src/analysis.js";
import { migrate } from "../src/db.js";
import {
  FUNDING_TOKENS,
  fundingPass,
  recheckContractFunding,
  rescanFunding,
  scanFirstFunders,
} from "../src/enrich/funding-scan.js";
import type { BlockSource, SqdBlock, SqdQuery } from "../src/indexer/sqd.js";
import { memoryDb } from "./helpers.js";

// Findings from the Savant.Chat audit of 30 Oct 2026, reproduced before they were fixed.

const SELLER = "0x00000000000000000000000000000000000005e1";
const DISPERSE = "0x000000000000000000000000000000000000d15e";
const BURNER = "0x0000000000000000000000000000000000000b0b";
const P1 = "0x00000000000000000000000000000000000000a1";
const CELO = FUNDING_TOKENS[0]!;
const NOW = Math.floor(Date.now() / 1000);
const txOf = (block: number) => `0x${block.toString(16).padStart(64, "0")}` as Hex;

function transfer(
  block: number,
  from: string,
  to: string,
  amount = 1n,
  ts = 1_700_000_000 + block,
): SqdBlock {
  return {
    header: { number: block, timestamp: ts },
    logs: [
      {
        address: CELO,
        topics: [TOPICS.erc20Transfer, pad(from as Hex, { size: 32 }), pad(to as Hex, { size: 32 })],
        data: `0x${amount.toString(16).padStart(64, "0")}`,
        logIndex: 0,
        transactionIndex: 0,
        transactionHash: txOf(block),
      },
    ],
  } as SqdBlock;
}

function portal(blocks: SqdBlock[], head = 1_000): BlockSource {
  return {
    finalizedHead: async () => ({ number: head, hash: "0x" }),
    async *stream(q: SqdQuery) {
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

/** DISPERSE is a contract; every transaction was sent by SELLER unless told otherwise. */
function chain(opts: { codeFails?: boolean; senderFails?: boolean } = {}) {
  return {
    getCode: async ({ address }: { address: string }) => {
      if (opts.codeFails) throw new Error("429 Too Many Requests");
      return address === DISPERSE ? ("0x6080" as Hex) : ("0x" as Hex);
    },
    getTransactionCount: async () => 4,
    getTransaction: async () => {
      if (opts.senderFails) throw new Error("timeout");
      return { from: SELLER as `0x${string}` };
    },
  };
}

function paying(db: ReturnType<typeof memoryDb>) {
  db.prepare(
    "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 1, 10, 1, 1, '0x1')",
  ).run(P1, SELLER);
}

const row = (db: ReturnType<typeof memoryDb>, a = P1) =>
  db
    .prepare("SELECT funder, funder_is_public, funded_via, funding_tx, error FROM funding WHERE address = ?")
    .get(a) as
    | {
        funder: string;
        funder_is_public: number;
        funded_via: string | null;
        funding_tx: string | null;
        error: string | null;
      }
    | undefined;

describe("audit 3.1: a cached public profile never outranks x402 participation", () => {
  it("credits a batch send to a seller that was profiled as public before it traded", async () => {
    const db = memoryDb();
    paying(db);
    // The seller (a smart wallet, say) was classified before its first x402 settlement.
    db.prepare(
      "INSERT INTO funder_profiles (address, is_public, reason, fetched_at) VALUES (?, 1, 'contract', ?)",
    ).run(SELLER, NOW);
    await fundingPass(db, portal([transfer(40, DISPERSE, P1)]), chain(), { toBlock: 1_000 });
    expect(row(db)).toMatchObject({ funder: SELLER, funder_is_public: 0, funded_via: DISPERSE });
  });
});

describe("audit 3.2: a zero-value transfer is not funding", () => {
  it("skips zero-value transfers to the real first funding", async () => {
    const found = await scanFirstFunders(
      portal([transfer(10, BURNER, P1, 0n), transfer(20, SELLER, P1, 5n)]),
      [P1 as `0x${string}`],
      { toBlock: 1_000 },
    );
    expect(found.get(P1 as `0x${string}`)).toMatchObject({ funder: SELLER, block: 20 });
  });
});

describe("audit 3.3: an RPC failure is not a classification", () => {
  it("does not record a contract as a private funder when getCode fails", async () => {
    const db = memoryDb();
    paying(db);
    await fundingPass(db, portal([transfer(40, DISPERSE, P1)]), chain({ codeFails: true }), {
      toBlock: 1_000,
    });
    const r = row(db);
    // Either not recorded yet or recorded as an error to retry; never "private funder DISPERSE".
    expect(r === undefined || r.error !== null).toBe(true);
    expect(db.prepare("SELECT * FROM funder_profiles WHERE address = ?").get(DISPERSE)).toBeUndefined();
  });
});

describe("audit 3.4: the recheck does not give up on fundings it could still resolve", () => {
  it("keeps the transaction when the sender lookup fails, and credits the seller from it later", async () => {
    const db = memoryDb();
    paying(db);
    await fundingPass(db, portal([transfer(40, DISPERSE, P1)]), chain({ senderFails: true }), {
      toBlock: 1_000,
    });
    // Recheck while the portal no longer serves that range (or never did, for a native transfer).
    await recheckContractFunding(db, portal([]), chain(), { toBlock: 1_000 });
    expect(row(db)).toMatchObject({ funder: SELLER, funded_via: DISPERSE, funding_tx: txOf(40) });
    expect(loadContext(db).funding.get(P1 as `0x${string}`)?.funderIsPublic).toBe(false);
  });

  it("does not finalize a recent funding the portal has not reached yet", async () => {
    const db = memoryDb();
    paying(db);
    db.prepare(
      "INSERT INTO funder_profiles (address, is_public, reason, fetched_at) VALUES (?, 1, 'contract', ?)",
    ).run(DISPERSE, NOW);
    // Found by the Blockscout fallback a minute ago, sender unread, no transaction kept.
    db.prepare(
      `INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error, funding_tx, funded_via)
       VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, NULL)`,
    ).run(P1, DISPERSE, NOW - 60, NOW - 60, NOW - 60);
    await recheckContractFunding(db, portal([]), chain(), { toBlock: 1_000 });
    expect(row(db)?.funding_tx).not.toBe("");
  });
});

describe("audit repairs on rows written before the fixes", () => {
  it("migration v11 re-queues the fundings the old rules may have got wrong", () => {
    const db = new Database(":memory:");
    migrate(db, 10);
    const EXCHANGE = "0x0000000000000000000000000000000000000e0e";
    const RPC_VICTIM = "0x0000000000000000000000000000000000000c0c";
    const P2 = "0x00000000000000000000000000000000000000a2";
    const P3 = "0x00000000000000000000000000000000000000a3";
    const P4 = "0x00000000000000000000000000000000000000a4";
    const P5 = "0x00000000000000000000000000000000000000a5";
    db.prepare(
      "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 1, 10, 1, 1, '0x1')",
    ).run(SELLER, BURNER);
    const profile = db.prepare(
      "INSERT INTO funder_profiles (address, is_public, reason, fetched_at) VALUES (?, ?, ?, ?)",
    );
    profile.run(DISPERSE, 1, "contract", NOW);
    profile.run(SELLER, 1, "contract", NOW); // profiled public, but trades over x402
    profile.run(RPC_VICTIM, 0, "0 transactions sent", NOW); // what a failed getCode used to produce
    profile.run(EXCHANGE, 1, "90000 transactions sent", NOW);
    const fund = db.prepare(
      `INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error, funding_tx, funded_via)
       VALUES (?, ?, 1, 1, ?, 1, NULL, ?, ?)`,
    );
    fund.run(P1, DISPERSE, 1, txOf(1), null); // settled under a cached-public sender: redo
    fund.run(P2, DISPERSE, 1, "", null); // given up on: redo, and forget the ""
    fund.run(P3, RPC_VICTIM, 0, txOf(3), null); // classified during an RPC failure: redo
    fund.run(P4, EXCHANGE, 1, txOf(4), null); // a real exchange: leave
    fund.run(P5, SELLER, 0, txOf(5), DISPERSE); // already credited through a contract: leave
    migrate(db);
    const state = (a: string) =>
      db.prepare("SELECT attributed, funding_tx, scan_version FROM funding WHERE address = ?").get(a);
    expect(state(P1)).toEqual({ attributed: 0, funding_tx: txOf(1), scan_version: 0 });
    expect(state(P2)).toEqual({ attributed: 0, funding_tx: null, scan_version: 0 });
    expect(state(P3)).toMatchObject({ attributed: 0 });
    expect(state(P4)).toMatchObject({ attributed: 1 });
    expect(state(P5)).toMatchObject({ attributed: 1 });
    const left = db.prepare("SELECT address FROM funder_profiles ORDER BY address").all();
    expect(left).toEqual(
      [{ address: EXCHANGE }, { address: DISPERSE }].sort((a, b) => (a.address < b.address ? -1 : 1)),
    );
  });

  it("the rescan replaces a first funding that was a zero-value transfer, and leaves the rest", async () => {
    const db = memoryDb();
    paying(db);
    const P2 = "0x00000000000000000000000000000000000000a2";
    const fund = db.prepare(
      `INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error, funding_tx, funded_via, scan_version)
       VALUES (?, ?, ?, ?, 0, 1, NULL, ?, NULL, 0)`,
    );
    // P1 was "funded" by a burner's zero-value transfer at block 10; the seller funded it at 20.
    fund.run(P1, BURNER, 1_700_000_010, 1_700_000_010, txOf(10));
    // P2 was funded natively before any token arrived (found by Blockscout): it stands.
    fund.run(P2, BURNER, 1_700_000_005, 1_700_000_005, txOf(5));
    const src_ = [transfer(10, BURNER, P1, 0n), transfer(20, SELLER, P1, 5n), transfer(30, SELLER, P2, 5n)];
    const src = portal(src_);
    // P3's only token transfer was zero-value: it is left unfunded, for the Blockscout fallback.
    const P3 = "0x00000000000000000000000000000000000000a3";
    fund.run(P3, BURNER, 1_700_000_040, 1_700_000_040, txOf(40));
    src_.push(transfer(40, BURNER, P3, 0n));
    expect(await rescanFunding(db, portal(src_), chain(), { toBlock: 1_000 })).toBe(3);
    expect(row(db, P1)).toMatchObject({ funder: SELLER, funding_tx: txOf(20) });
    expect(row(db, P2)).toMatchObject({ funder: BURNER, funding_tx: txOf(5) });
    expect(row(db, P3)).toMatchObject({ funder: null, funding_tx: null, error: null });
    expect(await rescanFunding(db, src, chain(), { toBlock: 1_000 })).toBe(0);
  });

  it("the recheck settles what it can while the portal is down, and leaves the rest queued", async () => {
    const db = memoryDb();
    paying(db);
    const P2 = "0x00000000000000000000000000000000000000a2";
    db.prepare(
      "INSERT INTO funder_profiles (address, is_public, reason, fetched_at) VALUES (?, 1, 'contract', ?)",
    ).run(DISPERSE, NOW);
    const fund = db.prepare(
      `INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error, funding_tx, funded_via, attributed)
       VALUES (?, ?, 1, 1, 1, 1, NULL, ?, NULL, 0)`,
    );
    fund.run(P1, DISPERSE, txOf(40)); // transaction known: no scan needed
    fund.run(P2, DISPERSE, null); // needs the scan
    const down: BlockSource = {
      finalizedHead: async () => {
        throw new Error("529");
      },
      // biome-ignore lint/correctness/useYield: a portal that fails before yielding anything
      async *stream() {
        throw new Error("529");
      },
    };
    expect(await recheckContractFunding(db, down, chain(), { toBlock: null })).toBe(1);
    expect(row(db, P1)).toMatchObject({ funder: SELLER, funded_via: DISPERSE });
    expect(db.prepare("SELECT attributed, error FROM funding WHERE address = ?").get(P2)).toEqual({
      attributed: 0,
      error: null,
    });
  });

  it("the recheck re-attributes a participant funder recorded as public, without a scan", async () => {
    const db = memoryDb();
    paying(db);
    const WASH = "0x0000000000000000000000000000000000000a5a";
    // WASH was profiled public (busy) before it started paying over x402.
    db.prepare(
      "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 1, 10, 1, 1, '0x1')",
    ).run(WASH, BURNER);
    db.prepare(
      `INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error, funding_tx, funded_via, attributed)
       VALUES (?, ?, 1, 1, 1, 1, NULL, NULL, NULL, 0)`,
    ).run(P1, WASH);
    const empty = portal([]);
    expect(await recheckContractFunding(db, empty, chain(), { toBlock: 1_000 })).toBe(1);
    expect(row(db)).toMatchObject({ funder: WASH, funder_is_public: 0, error: null });
  });
});
