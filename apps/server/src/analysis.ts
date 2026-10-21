import {
  type Address,
  type Assessment,
  type AssessmentContext,
  assess,
  type EconomySummary,
  type FundingInfo,
  type Hash,
  type HumanInfo,
  Ledger,
  type PairFlow,
  summarizeEconomy,
} from "assayscore-core";
import type { DB } from "./db.js";
import { log } from "./lib/log.js";

export interface DailyPoint {
  day: number;
  grossUsd: number;
  organicUsd: number;
  settlements: number;
}

export interface Snapshot {
  builtAt: number;
  ledger: Ledger;
  ctx: AssessmentContext;
  summary: EconomySummary;
  daily: DailyPoint[];
  organicShare: Map<Address, number>;
  reviews: { total: number; fromPayers: number; proven: number };
}

export type ReviewTier = "proven" | "paid" | "unverified";

export interface ReviewRow {
  agentId: string;
  client: Address;
  index: number;
  value: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  uri: string;
  ts: number;
  txHash: Hash;
  revoked: boolean;
  proofTx: Hash | null;
  comment: string | null;
  tier: ReviewTier;
  clientPaidUsd: number;
}

export interface AgentRow {
  agentId: string;
  owner: Address;
  wallet: Address | null;
  uri: string | null;
  name: string | null;
  description: string | null;
  image: string | null;
  x402: boolean | null;
  registeredTs: number;
  reviews: number;
  paidReviews: number;
  revenueUsd: number;
}

/**
 * In-memory view of the payment graph. Rebuilt from SQLite after new data lands,
 * at most every `minIntervalMs`, so a burst of settlements causes one rebuild.
 */
export class Analysis {
  private snapshot: Snapshot | null = null;
  private stale = true;
  private building = false;

  constructor(
    private readonly db: DB,
    private readonly minIntervalMs = 10_000,
  ) {}

  invalidate(): void {
    this.stale = true;
  }

  current(): Snapshot {
    const s = this.snapshot;
    const due = !s || (this.stale && Date.now() - s.builtAt >= this.minIntervalMs);
    if (due && !this.building) {
      this.building = true;
      try {
        this.stale = false;
        this.snapshot = this.build();
      } catch (err) {
        this.stale = true;
        if (!this.snapshot) throw err;
        log.error("analysis rebuild failed", { error: String(err) });
      } finally {
        this.building = false;
      }
    }
    return this.snapshot!;
  }

  assess(address: Address): Assessment {
    const s = this.current();
    return assess(s.ledger, address, s.ctx);
  }

  private build(): Snapshot {
    const started = Date.now();
    const ledger = new Ledger(loadFlows(this.db));
    const ctx = loadContext(this.db);
    const summary = summarizeEconomy(ledger, ctx);
    const organicShare = new Map<Address, number>();
    for (const s of summary.sellersRanked) {
      organicShare.set(s.address, s.grossUsd > 0 ? s.organicUsd / s.grossUsd : 0);
    }
    const daily = loadDaily(this.db, organicShare);
    const reviews = loadReviewStats(this.db);
    log.info("analysis built", {
      ms: Date.now() - started,
      sellers: summary.sellers,
      settlements: summary.settlements,
    });
    return { builtAt: Date.now(), ledger, ctx, summary, daily, organicShare, reviews };
  }

  agentsFor(address: Address): AgentRow[] {
    const rows = this.db
      .prepare(`${AGENT_SELECT} WHERE a.owner = @a OR a.wallet = @a ORDER BY CAST(a.agent_id AS INTEGER)`)
      .all({ a: address }) as RawAgent[];
    return rows.map(toAgentRow);
  }

  agent(agentId: string): AgentRow | null {
    const row = this.db.prepare(`${AGENT_SELECT} WHERE a.agent_id = @id`).get({ id: agentId }) as
      | RawAgent
      | undefined;
    return row ? toAgentRow(row) : null;
  }

  private agentCache: { builtAt: number; rows: AgentRow[] } | null = null;

  /** Agents ranked by reviews from paying clients, then x402 revenue. Cached per snapshot. */
  agents(opts: { limit: number; offset: number; q?: string; onlyPaid?: boolean }): {
    total: number;
    rows: AgentRow[];
  } {
    const snap = this.current();
    if (!this.agentCache || this.agentCache.builtAt !== snap.builtAt) {
      const rows = (this.db.prepare(AGENT_SELECT).all() as RawAgent[]).map(toAgentRow);
      rows.sort(
        (x, y) =>
          y.paidReviews - x.paidReviews ||
          y.revenueUsd - x.revenueUsd ||
          y.reviews - x.reviews ||
          Number(y.agentId) - Number(x.agentId),
      );
      this.agentCache = { builtAt: snap.builtAt, rows };
    }
    let rows = this.agentCache.rows;
    if (opts.onlyPaid) rows = rows.filter((r) => r.paidReviews > 0 || r.revenueUsd > 0);
    const q = opts.q?.trim().toLowerCase();
    if (q) {
      const id = q.replace(/^#/, "");
      rows = rows.filter(
        (r) =>
          r.agentId === id || r.owner === q || r.wallet === q || (r.name?.toLowerCase().includes(q) ?? false),
      );
    }
    return { total: rows.length, rows: rows.slice(opts.offset, opts.offset + opts.limit) };
  }

  /** Settlements a client made to an agent's owner or wallet, newest first: the proofs it can review with. */
  payments(
    agentId: string,
    client: Address,
    limit = 25,
  ): { txHash: Hash; ts: number; token: Address; usd: number; payee: Address }[] {
    return this.db
      .prepare(
        `SELECT s.tx_hash AS txHash, s.ts, s.token, s.usd, s.payee FROM settlements s JOIN agents a ON a.agent_id = ?
         WHERE s.payer = ? AND s.payee IN (a.owner, COALESCE(a.wallet, a.owner))
         ORDER BY s.ts DESC LIMIT ?`,
      )
      .all(agentId, client, limit) as {
      txHash: Hash;
      ts: number;
      token: Address;
      usd: number;
      payee: Address;
    }[];
  }

  reviews(agentId: string, limit = 100): ReviewRow[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, a.owner, a.wallet,
           (SELECT COALESCE(SUM(p.usd), 0) FROM pair_days p
             WHERE p.payer = f.client AND p.payee IN (a.owner, COALESCE(a.wallet, a.owner)) AND p.first_ts <= f.ts) AS paid_usd,
           (SELECT COUNT(*) FROM settlements s
             WHERE s.tx_hash = f.proof_tx AND s.payer = f.client AND s.payee IN (a.owner, COALESCE(a.wallet, a.owner))) AS proven
         FROM feedback f JOIN agents a ON a.agent_id = f.agent_id
         WHERE f.agent_id = ? ORDER BY f.block DESC, f.idx DESC LIMIT ?`,
      )
      .all(agentId, limit) as RawFeedback[];
    return rows.map((r) => ({
      agentId: r.agent_id,
      client: r.client,
      index: r.idx,
      value: scaleValue(r.value, r.decimals),
      tag1: r.tag1,
      tag2: r.tag2,
      endpoint: r.endpoint,
      uri: r.uri.startsWith("data:") ? "data:" : r.uri,
      ts: r.ts,
      txHash: r.tx_hash,
      revoked: r.revoked === 1,
      proofTx: r.proof_tx,
      comment: r.comment,
      tier: r.proven > 0 ? "proven" : r.paid_usd > 0 ? "paid" : "unverified",
      clientPaidUsd: r.paid_usd,
    }));
  }
}

interface RawAgent {
  agentId: string;
  owner: Address;
  wallet: Address | null;
  uri: string | null;
  name: string | null;
  description: string | null;
  image: string | null;
  x402: number | null;
  registeredTs: number;
  reviews: number;
  paidReviews: number;
  revenueUsd: number;
}

interface RawFeedback {
  agent_id: string;
  client: Address;
  idx: number;
  value: string;
  decimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  uri: string;
  ts: number;
  tx_hash: Hash;
  revoked: number;
  proof_tx: Hash | null;
  comment: string | null;
  paid_usd: number;
  proven: number;
}

const AGENT_SELECT = `
  SELECT a.agent_id AS agentId, a.owner, a.wallet, a.uri, a.name, a.description, a.image, a.x402,
    a.registered_ts AS registeredTs,
    (SELECT COUNT(*) FROM feedback f WHERE f.agent_id = a.agent_id AND f.revoked = 0) AS reviews,
    (SELECT COUNT(*) FROM feedback f WHERE f.agent_id = a.agent_id AND f.revoked = 0 AND EXISTS (
       SELECT 1 FROM pair_days p WHERE p.payer = f.client AND p.payee IN (a.owner, COALESCE(a.wallet, a.owner))
         AND p.first_ts <= f.ts)) AS paidReviews,
    (SELECT COALESCE(SUM(p.usd), 0) FROM pair_days p
       WHERE p.payee = a.owner OR (a.wallet IS NOT NULL AND a.wallet <> a.owner AND p.payee = a.wallet)) AS revenueUsd
  FROM agents a`;

function toAgentRow(r: RawAgent): AgentRow {
  return { ...r, x402: r.x402 === null ? null : r.x402 === 1 };
}

/** ERC-8004 values are fixed point: value / 10^decimals. Decimals are capped at 18 by the registry. */
export function scaleValue(value: string, decimals: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n / 10 ** Math.min(Math.max(decimals, 0), 18);
}

function loadFlows(db: DB): PairFlow[] {
  const rows = db
    .prepare(
      "SELECT payer, payee, day, count, usd, first_ts, last_ts, last_tx FROM pair_days ORDER BY payer, payee, day",
    )
    .iterate() as IterableIterator<{
    payer: Address;
    payee: Address;
    day: number;
    count: number;
    usd: number;
    first_ts: number;
    last_ts: number;
    last_tx: Hash;
  }>;
  const flows: PairFlow[] = [];
  let cur: PairFlow | null = null;
  for (const r of rows) {
    if (!cur || cur.payer !== r.payer || cur.payee !== r.payee) {
      if (cur) flows.push(finishFlow(cur));
      cur = {
        payer: r.payer,
        payee: r.payee,
        count: 0,
        usd: 0,
        firstTs: r.first_ts,
        lastTs: r.last_ts,
        days: [],
        sampleTxs: [],
      };
    }
    cur.count += r.count;
    cur.usd += r.usd;
    cur.firstTs = Math.min(cur.firstTs, r.first_ts);
    cur.lastTs = Math.max(cur.lastTs, r.last_ts);
    cur.days.push(r.day);
    cur.sampleTxs.push(r.last_tx);
  }
  if (cur) flows.push(finishFlow(cur));
  return flows;
}

function finishFlow(f: PairFlow): PairFlow {
  // Rows arrive oldest day first; keep the newest few transactions as evidence.
  return { ...f, sampleTxs: f.sampleTxs.slice(-5).reverse() };
}

function loadContext(db: DB): AssessmentContext {
  const funding = new Map<Address, FundingInfo>();
  for (const r of db
    .prepare(
      "SELECT address, funder, funded_at, first_seen_at, funder_is_public FROM funding WHERE error IS NULL",
    )
    .iterate() as IterableIterator<{
    address: Address;
    funder: Address | null;
    funded_at: number | null;
    first_seen_at: number | null;
    funder_is_public: number;
  }>) {
    funding.set(r.address, {
      funder: r.funder,
      fundedAt: r.funded_at,
      firstSeenAt: r.first_seen_at,
      funderIsPublic: r.funder_is_public === 1,
    });
  }
  const humans = new Map<Address, HumanInfo>();
  for (const r of db
    .prepare(
      "SELECT address, agent_id, nullifier, fresh, visa_tier FROM humans WHERE agent_id IS NOT NULL AND nullifier IS NOT NULL",
    )
    .iterate() as IterableIterator<{
    address: Address;
    agent_id: string;
    nullifier: string;
    fresh: number;
    visa_tier: number;
  }>) {
    humans.set(r.address, {
      agentId: r.agent_id,
      nullifier: r.nullifier,
      fresh: r.fresh === 1,
      visaTier: r.visa_tier,
    });
  }
  const agentIds = new Map<Address, string[]>();
  const add = (a: Address | null, id: string) => {
    if (!a) return;
    const list = agentIds.get(a) ?? [];
    if (!list.includes(id)) list.push(id);
    agentIds.set(a, list);
  };
  for (const r of db.prepare("SELECT agent_id, owner, wallet FROM agents").iterate() as IterableIterator<{
    agent_id: string;
    owner: Address;
    wallet: Address | null;
  }>) {
    add(r.owner, r.agent_id);
    add(r.wallet, r.agent_id);
  }
  return { funding, humans, agentIds, now: Math.floor(Date.now() / 1000) };
}

function loadDaily(db: DB, share: Map<Address, number>): DailyPoint[] {
  const byDay = new Map<number, DailyPoint>();
  for (const r of db
    .prepare("SELECT day, payee, SUM(usd) AS usd, SUM(count) AS n FROM pair_days GROUP BY day, payee")
    .iterate() as IterableIterator<{ day: number; payee: Address; usd: number; n: number }>) {
    const p = byDay.get(r.day) ?? { day: r.day, grossUsd: 0, organicUsd: 0, settlements: 0 };
    p.grossUsd += r.usd;
    p.organicUsd += r.usd * (share.get(r.payee) ?? 0);
    p.settlements += r.n;
    byDay.set(r.day, p);
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day);
}

function loadReviewStats(db: DB): Snapshot["reviews"] {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN EXISTS (
           SELECT 1 FROM pair_days p WHERE p.payer = f.client AND p.payee IN (a.owner, COALESCE(a.wallet, a.owner))
             AND p.first_ts <= f.ts) THEN 1 ELSE 0 END), 0) AS fromPayers,
         COALESCE(SUM(CASE WHEN f.proof_tx IS NOT NULL AND EXISTS (
           SELECT 1 FROM settlements s WHERE s.tx_hash = f.proof_tx AND s.payer = f.client
             AND s.payee IN (a.owner, COALESCE(a.wallet, a.owner))) THEN 1 ELSE 0 END), 0) AS proven
       FROM feedback f JOIN agents a ON a.agent_id = f.agent_id WHERE f.revoked = 0`,
    )
    .get() as { total: number; fromPayers: number; proven: number };
  return row;
}
