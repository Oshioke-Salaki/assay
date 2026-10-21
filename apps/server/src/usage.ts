import { createHash } from "node:crypto";
import type { DB } from "./db.js";
import { log } from "./lib/log.js";

/**
 * What the API is used for, counted per day and kind of request. Counting happens in memory and
 * is written to SQLite every half minute, so a crowd costs a map increment per request, not a
 * write. Callers are counted as salted hashes of their address; no address is ever stored.
 */
export type UsageKind =
  | "report" // a free report for an address
  | "check_paid" // a paid pre-payment check, delivered
  | "check_quoted" // a 402 price quote for a check
  | "attest_paid" // a paid signed score, delivered
  | "attest_quoted"
  | "agents" // ERC-8004 agent lists and pages
  | "economy" // economy totals, daily series, seller lists
  | "api_other" // every other successful API read
  | "rate_limited"; // a free request turned away at the per-IP limit

export const USAGE_KINDS: readonly UsageKind[] = [
  "report",
  "check_paid",
  "check_quoted",
  "attest_paid",
  "attest_quoted",
  "agents",
  "economy",
  "api_other",
  "rate_limited",
];

const DAY = 86_400;
/** Distinct callers held in memory per day before counting stops growing (memory bound). */
const MAX_VISITORS_PER_DAY = 200_000;

/** Which kind of use a finished request was, or null for requests that are not usage (health, status, preflight). */
export function classify(method: string, path: string, status: number): UsageKind | null {
  if (method !== "GET") return null;
  if (status === 429) return "rate_limited";
  if (path.startsWith("/v1/check/"))
    return status === 200 ? "check_paid" : status === 402 ? "check_quoted" : null;
  if (path.startsWith("/v1/attest/"))
    return status === 200 ? "attest_paid" : status === 402 ? "attest_quoted" : null;
  if (status !== 200) return null;
  if (path === "/v1/status" || path === "/health" || path === "/v1/stats" || path === "/v1/admin")
    return null;
  if (path.startsWith("/v1/address/")) return "report";
  if (path.startsWith("/v1/agents")) return "agents";
  if (path.startsWith("/v1/economy") || path.startsWith("/v1/sellers")) return "economy";
  if (path.startsWith("/v1/")) return "api_other";
  return null;
}

export class Usage {
  private counts = new Map<string, number>(); // `${day}:${kind}` -> count since last flush
  private visitors = new Map<number, Set<string>>(); // day -> hashes seen today
  private fresh: [number, string][] = []; // visitor hashes not yet written

  constructor(
    private readonly db: DB,
    private readonly salt: string,
  ) {}

  record(kind: UsageKind, caller: string | null, now = Date.now()): void {
    const day = Math.floor(now / 1000 / DAY);
    const key = `${day}:${kind}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (!caller || kind === "rate_limited") return;
    let seen = this.visitors.get(day);
    if (!seen) {
      // A new day: forget the older ones, they are already written.
      this.visitors.clear();
      seen = new Set();
      this.visitors.set(day, seen);
    }
    if (seen.size >= MAX_VISITORS_PER_DAY) return;
    const hash = createHash("sha256").update(`${this.salt}:${day}:${caller}`).digest("hex").slice(0, 32);
    if (seen.has(hash)) return;
    seen.add(hash);
    this.fresh.push([day, hash]);
  }

  /** Write what has been counted since the last flush. Safe to call at any time. */
  flush(): void {
    if (this.counts.size === 0 && this.fresh.length === 0) return;
    const counts = this.counts;
    const fresh = this.fresh;
    this.counts = new Map();
    this.fresh = [];
    const add = this.db.prepare(
      `INSERT INTO usage_daily (day, kind, count) VALUES (?, ?, ?)
       ON CONFLICT (day, kind) DO UPDATE SET count = count + excluded.count`,
    );
    const seen = this.db.prepare("INSERT OR IGNORE INTO usage_visitors (day, hash) VALUES (?, ?)");
    try {
      this.db.transaction(() => {
        for (const [key, n] of counts) {
          const [day, kind] = key.split(":");
          add.run(Number(day), kind, n);
        }
        for (const [day, hash] of fresh) seen.run(day, hash);
      })();
    } catch (err) {
      // Put the counts back so a failed write loses nothing.
      for (const [key, n] of counts) this.counts.set(key, (this.counts.get(key) ?? 0) + n);
      this.fresh.push(...fresh);
      log.warn("usage flush failed", { error: String(err) });
    }
  }

  /** Per-day counts for the last `days` days, oldest first, every kind present (zero when unused). */
  daily(
    days: number,
    now = Date.now(),
  ): { day: number; visitors: number; counts: Record<UsageKind, number> }[] {
    this.flush();
    const today = Math.floor(now / 1000 / DAY);
    const from = today - days + 1;
    const rows = this.db.prepare("SELECT day, kind, count FROM usage_daily WHERE day >= ?").all(from) as {
      day: number;
      kind: UsageKind;
      count: number;
    }[];
    const visitors = this.db
      .prepare("SELECT day, COUNT(*) AS n FROM usage_visitors WHERE day >= ? GROUP BY day")
      .all(from) as { day: number; n: number }[];
    const out = [];
    for (let d = from; d <= today; d++) {
      const counts = Object.fromEntries(USAGE_KINDS.map((k) => [k, 0])) as Record<UsageKind, number>;
      for (const r of rows) if (r.day === d && r.kind in counts) counts[r.kind] = r.count;
      out.push({ day: d, visitors: visitors.find((v) => v.day === d)?.n ?? 0, counts });
    }
    return out;
  }

  /** All-time totals per kind. */
  totals(): Record<UsageKind, number> {
    this.flush();
    const rows = this.db.prepare("SELECT kind, SUM(count) AS n FROM usage_daily GROUP BY kind").all() as {
      kind: UsageKind;
      n: number;
    }[];
    const out = Object.fromEntries(USAGE_KINDS.map((k) => [k, 0])) as Record<UsageKind, number>;
    for (const r of rows) if (r.kind in out) out[r.kind] = r.n;
    return out;
  }

  /** Days of visitor hashes kept; older ones are deleted, since only the daily count matters. */
  prune(keepDays = 90, now = Date.now()): void {
    const cutoff = Math.floor(now / 1000 / DAY) - keepDays;
    this.db.prepare("DELETE FROM usage_visitors WHERE day < ?").run(cutoff);
  }
}
