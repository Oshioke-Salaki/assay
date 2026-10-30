import type { PairFlow } from "assayscore-core";
import { describe, expect, it } from "vitest";
import { Analysis, loadFlowsAt } from "../src/analysis.js";
import { Attester } from "../src/attest.js";
import { setCursor } from "../src/db.js";
import { SETTLEMENT_CURSOR } from "../src/indexer/settlements.js";
import { compare, fieldsFrom, parseAttestation, reassess, verifyScore } from "../src/verify.js";
import { memoryDb } from "./helpers.js";

const KEY = `0x${"11".repeat(32)}` as const;
const OTHER = `0x${"22".repeat(32)}` as const;
const REGISTRY = `0x${"ab".repeat(20)}` as `0x${string}`;
const SELLER = `0x${"5".repeat(40)}` as `0x${string}`;
const DAY = 86_400;
const T0 = 1_790_000_000;

/** Settlements written the way the indexer writes them: one row each, plus its pair_days row. */
function seed(rows: { payer: string; block: number; ts: number; usd: number }[], cursor: number) {
  const db = memoryDb();
  const ins = db.prepare(
    "INSERT INTO settlements (tx_hash, log_index, block, ts, relayer, token, payer, payee, amount, usd, scored) VALUES (?, 0, ?, ?, 'r', 't', ?, ?, '1', ?, 1)",
  );
  const pd = db.prepare(
    `INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT (payer, payee, day) DO UPDATE SET count = count + 1, usd = usd + excluded.usd,
       first_ts = MIN(first_ts, excluded.first_ts), last_tx = CASE WHEN excluded.last_ts >= last_ts THEN excluded.last_tx ELSE last_tx END,
       last_ts = MAX(last_ts, excluded.last_ts)`,
  );
  rows.forEach((r, i) => {
    const tx = `0x${(i + 1).toString(16).padStart(64, "0")}`;
    ins.run(tx, r.block, r.ts, r.payer, SELLER, r.usd);
    pd.run(r.payer, SELLER, Math.floor(r.ts / DAY), r.usd, r.ts, r.ts, tx);
  });
  setCursor(db, SETTLEMENT_CURSOR, cursor, null);
  return db;
}

function customers(n: number, upToBlock: number) {
  const out: { payer: string; block: number; ts: number; usd: number }[] = [];
  for (let i = 0; i < n; i++)
    for (let d = 0; d < 6; d++)
      out.push({
        payer: `0x${(i + 16).toString(16).padStart(40, "0")}`,
        block: 100 + i * 10 + d,
        ts: T0 + (i % 5) * DAY + d * 2 * DAY,
        usd: 0.1 * (i + 1) + d * 0.01,
      });
  return out.filter((r) => r.block <= upToBlock);
}

describe("loadFlowsAt", () => {
  it("rebuilds exactly the flows the indexer's pair_days hold, when cut at the indexed block", () => {
    const db = seed(customers(8, 10_000), 10_000);
    const fromSettlements = loadFlowsAt(db, 10_000);
    const analysis = new Analysis(db, 0);
    const fromPairDays = analysis.current().ledger;
    const norm = (fl: PairFlow[]) =>
      fl.map((f) => ({ ...f, usd: Math.round(f.usd * 1e9) })).sort((a, b) => a.payer.localeCompare(b.payer));
    expect(norm(fromSettlements)).toEqual(norm([...fromPairDays.incoming.get(SELLER)!.values()]));
  });

  it("leaves out settlements after the block", () => {
    const db = seed(customers(8, 10_000), 10_000);
    const early = loadFlowsAt(db, 150);
    expect(early.reduce((n, f) => n + f.count, 0)).toBe(customers(8, 150).length);
  });
});

describe("verifyScore", () => {
  async function signed(db: ReturnType<typeof seed>, key = KEY) {
    const analysis = new Analysis(db, 0);
    const { assessment, block, now } = analysis.scored(SELLER);
    const att = await new Attester(key, REGISTRY).sign(assessment, block, now);
    return { att: JSON.parse(JSON.stringify({ attestation: att })), block, now, assessment };
  }

  it("verifies a score Assay signed, replayed from the same data at the same block and time", async () => {
    const db = seed(customers(8, 10_000), 10_000);
    const { att, block } = await signed(db);
    expect(block).toBe(10_000);
    const parsed = parseAttestation(att);
    const signer = new Attester(KEY, REGISTRY).address;
    const r = await verifyScore(db, parsed, { expectedSigner: signer });
    expect(r.outcome).toBe("verified");
    expect(r.signature).toMatchObject({ checked: true, recovered: signer, valid: true });
    expect(r.fields.map((f) => f.field)).toEqual([
      "score",
      "rating",
      "grossUsdMicros",
      "organicUsdMicros",
      "effectivePayersX100",
    ]);
    expect(r.fields.every((f) => f.match)).toBe(true);
    expect(r.explain).toEqual([]);
  });

  it("still verifies after more settlements land: the replay stops at the signed block", async () => {
    const db = seed(customers(8, 10_000), 10_000);
    const { att } = await signed(db);
    // New revenue after signing changes today's score but not the one signed at block 10,000.
    db.prepare(
      "INSERT INTO settlements (tx_hash, log_index, block, ts, relayer, token, payer, payee, amount, usd, scored) VALUES (?, 0, 20000, ?, 'r', 't', ?, ?, '1', 500, 1)",
    ).run(`0x${"f".repeat(64)}`, T0 + 20 * DAY, `0x${"9".repeat(40)}`, SELLER);
    setCursor(db, SETTLEMENT_CURSOR, 20_000, null);
    const r = await verifyScore(db, parseAttestation(att), {
      expectedSigner: new Attester(KEY, REGISTRY).address,
    });
    expect(r.outcome).toBe("verified");
  });

  it("refuses a score signed by a different key, and a tampered one", async () => {
    const db = seed(customers(8, 10_000), 10_000);
    const { att } = await signed(db, OTHER);
    const r = await verifyScore(db, parseAttestation(att), {
      expectedSigner: new Attester(KEY, REGISTRY).address,
    });
    expect(r.outcome).toBe("signature-invalid");
    expect(r.explain[0]).toMatch(/not by the attester the registry trusts/);

    const good = await signed(db);
    const tampered = JSON.parse(JSON.stringify(good.att));
    tampered.attestation.message.score = String(Number(tampered.attestation.message.score) + 10);
    const t = await verifyScore(db, parseAttestation(tampered), {
      expectedSigner: new Attester(KEY, REGISTRY).address,
    });
    expect(t.outcome).toBe("signature-invalid");
  });

  it("reports a node that has not indexed far enough, instead of a false difference", async () => {
    const db = seed(customers(8, 10_000), 10_000);
    const { att } = await signed(db);
    setCursor(db, SETTLEMENT_CURSOR, 9_000, null);
    const r = await verifyScore(db, parseAttestation(att), {
      expectedSigner: new Attester(KEY, REGISTRY).address,
    });
    expect(r.outcome).toBe("node-behind");
    expect(r.explain[0]).toMatch(/indexed settlements to block 9000.*block 10000/);
  });

  it("names the cause of a difference: missing settlements versus enrichment", async () => {
    const db = seed(customers(8, 10_000), 10_000);
    const { att } = await signed(db);
    db.prepare("DELETE FROM settlements WHERE block = 100").run();
    const r = await verifyScore(db, parseAttestation(att), {
      expectedSigner: new Attester(KEY, REGISTRY).address,
    });
    expect(r.outcome).toBe("differs");
    expect(r.fields.find((f) => f.field === "grossUsdMicros")?.match).toBe(false);
    expect(r.explain[0]).toMatch(/settlement index is incomplete/);

    const db2 = seed(customers(8, 10_000), 10_000);
    const s2 = await signed(db2);
    // Funding traced after signing: the first payer turns out to be seller-funded.
    db2
      .prepare(
        "INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error) VALUES (?, ?, 1, 1, 0, 1, NULL)",
      )
      .run(`0x${(16).toString(16).padStart(40, "0")}`, SELLER);
    const r2 = await verifyScore(db2, parseAttestation(s2.att), {
      expectedSigner: new Attester(KEY, REGISTRY).address,
    });
    expect(r2.outcome).toBe("differs");
    expect(r2.fields.find((f) => f.field === "grossUsdMicros")?.match).toBe(true);
    expect(r2.explain[0]).toMatch(/enrichment/);
  });

  it("accepts a score read from the registry, which has no signature to check", async () => {
    const db = seed(customers(8, 10_000), 10_000);
    const { att } = await signed(db);
    const p = parseAttestation(att);
    const r = await verifyScore(
      db,
      { fields: p.fields, signature: null, registry: REGISTRY },
      { fromRegistry: true },
    );
    expect(r.outcome).toBe("verified");
    expect(r.signature).toMatchObject({ checked: true, valid: true, recovered: null });
  });
});

describe("parseAttestation and compare", () => {
  it("reads a check response, a bare attestation, or a bare message, and refuses junk", async () => {
    const db = seed(customers(3, 10_000), 10_000);
    const a = reassess(db, SELLER, 10_000, T0 + 30 * DAY);
    const f = fieldsFrom(a, 10_000, T0 + 30 * DAY);
    const message = Object.fromEntries(
      Object.entries(f).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
    );
    expect(parseAttestation({ message }).fields.score).toBe(f.score);
    expect(parseAttestation(message).fields.asOfBlock).toBe(10_000n);
    expect(() => parseAttestation({ message: { ...message, subject: "nope" } })).toThrow(/subject/);
    expect(() => parseAttestation({ message: { ...message, score: "-1" } })).toThrow(/score/);
    expect(() => parseAttestation({ message: { ...message, rating: "9" } })).toThrow(/out of range/);
  });

  it("allows one micro-dollar of float rounding, and nothing on score or rating", () => {
    const base = {
      subject: SELLER,
      score: 50,
      rating: 5,
      organicUsdMicros: 1_000_000n,
      grossUsdMicros: 2_000_000n,
      effectivePayersX100: 300,
      asOfBlock: 1n,
      issuedAt: 1n,
      expiresAt: 1n,
    };
    expect(compare(base, { ...base, grossUsdMicros: 2_000_001n }).every((x) => x.match)).toBe(true);
    expect(
      compare(base, { ...base, grossUsdMicros: 2_000_002n }).find((x) => x.field === "grossUsdMicros")?.match,
    ).toBe(false);
    expect(compare(base, { ...base, score: 51 })[0]?.match).toBe(false);
    expect(compare(base, { ...base, rating: 4 })[1]).toMatchObject({
      signed: "BBB",
      recomputed: "BB",
      match: false,
    });
  });
});
