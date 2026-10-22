import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  type Address,
  type Assessment,
  checkHttpsUrl,
  isPrivateIp,
  type Rating,
  type Verdict,
  verdictFor,
} from "assayscore-core";
import type { DB } from "./db.js";
import { readXMentions, type XMentions } from "./enrich/xmentions.js";
import { log } from "./lib/log.js";

/**
 * Rating-change alerts. An agent (or a person) pays once to watch an address for thirty days;
 * Assay POSTs to their URL when the rating or verdict moves, a critical finding appears, or
 * posts with warning words show up on X. Every delivery is signed with the watch's secret, so
 * the receiver can prove it came from Assay. Webhooks go only to public hosts, checked at each
 * delivery, and redirects are never followed.
 */
export const WATCH_DAYS = 30;
export const WATCH_URL_MAX = 500;
const MAX_PER_HOST = 100;
const MAX_ATTEMPTS = 6;
/** Seconds to wait after the nth failed attempt. */
const BACKOFF = [60, 300, 1_800, 7_200, 43_200];
const DISABLE_AFTER_FAILURES = 20;
const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERIES_PER_TICK = 50;
const DAY = 86_400;

export interface WatchState {
  rating: Rating;
  score: number | null;
  verdict: Verdict;
  critical: string[];
  xWarnings: number;
}

export function stateOf(a: Assessment, x: XMentions | null): WatchState {
  return {
    rating: a.rating,
    score: a.score,
    verdict: verdictFor(a).verdict,
    critical: a.flags
      .filter((f) => f.severity === "critical")
      .map((f) => f.code)
      .sort(),
    xWarnings: x?.status === "ok" ? x.warnings : 0,
  };
}

/** What changed between two states, as events worth a delivery. */
export function changes(prev: WatchState | null, next: WatchState): { event: string; detail: string }[] {
  if (!prev) return [];
  const out: { event: string; detail: string }[] = [];
  if (prev.rating !== next.rating)
    out.push({ event: "rating.changed", detail: `Rating moved from ${prev.rating} to ${next.rating}.` });
  if (prev.verdict !== next.verdict)
    out.push({
      event: "verdict.changed",
      detail: `Pre-payment check moved from ${prev.verdict} to ${next.verdict}.`,
    });
  const fresh = next.critical.filter((c) => !prev.critical.includes(c));
  if (fresh.length > 0)
    out.push({ event: "finding.critical", detail: `New critical finding: ${fresh.join(", ")}.` });
  if (prev.xWarnings === 0 && next.xWarnings > 0)
    out.push({
      event: "x.warnings",
      detail: `${next.xWarnings} post${next.xWarnings === 1 ? "" : "s"} on X name this address next to words like scam or hack.`,
    });
  return out;
}

export function signDelivery(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface WatchRow {
  id: string;
  address: Address;
  url: string;
  secret: string;
  created_at: number;
  expires_at: number;
  last_state: string | null;
  failures: number;
  disabled_at: number | null;
  note: string | null;
}

export type Lookup = (host: string) => Promise<{ address: string }[]>;

export interface WatchesOptions {
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  publicUrl?: string;
  webUrl?: string;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export class Watches {
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: Lookup;

  constructor(
    private readonly db: DB,
    private readonly analysis: { assess: (a: Address) => Assessment },
    private readonly opts: WatchesOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.lookup = opts.lookup ?? ((host) => dnsLookup(host, { all: true }));
  }

  /** Why a webhook URL cannot be used, or null when it can. */
  static urlProblem(url: string): string | null {
    const bad = checkHttpsUrl(url, WATCH_URL_MAX);
    return bad ? `Webhook URL ${bad}` : null;
  }

  /**
   * Start watching, or extend an existing watch on the same address and URL. A new watch gets a
   * secret, shown once, and a first delivery ("watch.started") so the receiver can confirm the
   * pipe works before anything changes.
   */
  create(
    address: Address,
    url: string,
    now = nowSec(),
    opts: { days?: number; note?: string | null; maxForAddress?: number } = {},
  ):
    | { ok: true; id: string; secret: string | null; expiresAt: number; renewed: boolean }
    | { ok: false; status: 400 | 429; error: string } {
    const problem = Watches.urlProblem(url);
    if (problem) return { ok: false, status: 400, error: problem };
    const a = address.toLowerCase() as Address;
    const days = opts.days ?? WATCH_DAYS;
    const existing = this.db
      .prepare(
        "SELECT * FROM watches WHERE address = ? AND url = ? AND disabled_at IS NULL AND expires_at > ?",
      )
      .get(a, url, now) as WatchRow | undefined;
    if (existing) {
      const expiresAt = Math.max(existing.expires_at, now) + days * DAY;
      this.db.prepare("UPDATE watches SET expires_at = ? WHERE id = ?").run(expiresAt, existing.id);
      return { ok: true, id: existing.id, secret: null, expiresAt, renewed: true };
    }
    if (opts.maxForAddress !== undefined) {
      const mine = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM watches WHERE address = ? AND note = ? AND disabled_at IS NULL AND expires_at > ?",
          )
          .get(a, opts.note ?? null, now) as { n: number }
      ).n;
      if (mine >= opts.maxForAddress)
        return {
          ok: false,
          status: 429,
          error: `This address already has ${opts.maxForAddress} free alert URLs. Remove one first.`,
        };
    }
    const host = new URL(url).hostname.toLowerCase();
    const active = this.db
      .prepare("SELECT url FROM watches WHERE disabled_at IS NULL AND expires_at > ?")
      .all(now) as { url: string }[];
    if (active.filter((w) => new URL(w.url).hostname.toLowerCase() === host).length >= MAX_PER_HOST)
      return { ok: false, status: 429, error: `That host already receives ${MAX_PER_HOST} watches.` };
    const id = `w_${randomBytes(8).toString("hex")}`;
    const secret = randomBytes(32).toString("hex");
    const expiresAt = now + days * DAY;
    const state = this.currentState(a);
    this.db
      .prepare(
        "INSERT INTO watches (id, address, url, secret, created_at, expires_at, last_state, failures, note) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
      )
      .run(id, a, url, secret, now, expiresAt, JSON.stringify(state), opts.note ?? null);
    this.enqueue(
      { id, address: a } as WatchRow,
      "watch.started",
      "Assay is now watching this address.",
      null,
      state,
      now,
    );
    return { ok: true, id, secret, expiresAt, renewed: false };
  }

  cancel(id: string, secret: string | undefined): "ok" | "missing" | "forbidden" {
    const w = this.db.prepare("SELECT id, secret FROM watches WHERE id = ?").get(id) as
      | Pick<WatchRow, "id" | "secret">
      | undefined;
    if (!w) return "missing";
    if (!secret || !sameSecret(secret, w.secret)) return "forbidden";
    this.db.prepare("DELETE FROM watch_deliveries WHERE watch_id = ?").run(id);
    this.db.prepare("DELETE FROM watches WHERE id = ?").run(id);
    return "ok";
  }

  status(id: string, secret: string | undefined) {
    const w = this.db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as WatchRow | undefined;
    if (!w) return { kind: "missing" as const };
    if (!secret || !sameSecret(secret, w.secret)) return { kind: "forbidden" as const };
    const deliveries = this.db
      .prepare(
        "SELECT id, event, attempts, next_at AS nextAt, delivered_at AS deliveredAt, last_status AS lastStatus, last_error AS lastError, created_at AS createdAt FROM watch_deliveries WHERE watch_id = ? ORDER BY id DESC LIMIT 10",
      )
      .all(id);
    return {
      kind: "ok" as const,
      watch: {
        id: w.id,
        address: w.address,
        url: w.url,
        createdAt: w.created_at,
        expiresAt: w.expires_at,
        disabledAt: w.disabled_at,
        failures: w.failures,
        state: w.last_state ? (JSON.parse(w.last_state) as WatchState) : null,
      },
      deliveries,
    };
  }

  private currentState(address: Address): WatchState {
    return stateOf(this.analysis.assess(address), readXMentions(this.db, address));
  }

  private enqueue(
    w: Pick<WatchRow, "id" | "address">,
    event: string,
    detail: string,
    previous: WatchState | null,
    current: WatchState,
    now: number,
  ): void {
    const base = (this.opts.webUrl ?? "https://assayscore.xyz").replace(/\/+$/, "");
    const api = (this.opts.publicUrl ?? "https://api.assayscore.xyz").replace(/\/+$/, "");
    const payload = {
      event,
      watch: w.id,
      address: w.address,
      at: now,
      detail,
      previous,
      current,
      report: `${base}/address/${w.address}`,
      api: `${api}/v1/address/${w.address}`,
    };
    this.db
      .prepare(
        "INSERT INTO watch_deliveries (watch_id, event, payload, attempts, next_at, created_at) VALUES (?, ?, ?, 0, ?, ?)",
      )
      .run(w.id, event, JSON.stringify(payload), now, now);
  }

  /** Find what changed for every live watch and queue a delivery for each change. */
  detect(now = nowSec()): number {
    const live = this.db
      .prepare("SELECT * FROM watches WHERE disabled_at IS NULL AND expires_at > ?")
      .all(now) as WatchRow[];
    let queued = 0;
    const save = this.db.prepare("UPDATE watches SET last_state = ? WHERE id = ?");
    for (const w of live) {
      let next: WatchState;
      try {
        next = this.currentState(w.address);
      } catch (err) {
        log.warn("watch: could not assess", { id: w.id, error: String(err) });
        continue;
      }
      const prev = w.last_state ? (JSON.parse(w.last_state) as WatchState) : null;
      for (const ch of changes(prev, next)) {
        this.enqueue(w, ch.event, ch.detail, prev, next, now);
        queued++;
      }
      if (JSON.stringify(prev) !== JSON.stringify(next)) save.run(JSON.stringify(next), w.id);
    }
    return queued;
  }

  /** Send every delivery that is due, a bounded number per call. */
  async deliverDue(now = nowSec()): Promise<{ delivered: number; failed: number }> {
    const due = this.db
      .prepare(
        `SELECT d.id, d.watch_id, d.event, d.payload, d.attempts, w.url, w.secret, w.failures, w.disabled_at
         FROM watch_deliveries d JOIN watches w ON w.id = d.watch_id
         WHERE d.delivered_at IS NULL AND d.next_at <= ? AND d.attempts < ? AND w.disabled_at IS NULL
         ORDER BY d.next_at LIMIT ?`,
      )
      .all(now, MAX_ATTEMPTS, DELIVERIES_PER_TICK) as {
      id: number;
      watch_id: string;
      event: string;
      payload: string;
      attempts: number;
      url: string;
      secret: string;
      failures: number;
    }[];
    let delivered = 0;
    let failed = 0;
    for (const d of due) {
      const r = await this.send(d.url, d.secret, d.id, d.watch_id, d.event, d.payload, now);
      if (r.ok) {
        this.db
          .prepare(
            "UPDATE watch_deliveries SET delivered_at = ?, attempts = attempts + 1, last_status = ?, last_error = NULL WHERE id = ?",
          )
          .run(now, r.status, d.id);
        this.db.prepare("UPDATE watches SET failures = 0 WHERE id = ?").run(d.watch_id);
        delivered++;
        continue;
      }
      failed++;
      const attempts = d.attempts + 1;
      const wait = BACKOFF[Math.min(attempts, BACKOFF.length) - 1] ?? BACKOFF[BACKOFF.length - 1]!;
      this.db
        .prepare(
          "UPDATE watch_deliveries SET attempts = ?, next_at = ?, last_status = ?, last_error = ? WHERE id = ?",
        )
        .run(attempts, now + wait, r.status ?? null, r.error.slice(0, 200), d.id);
      if (attempts >= MAX_ATTEMPTS) {
        const failures = d.failures + 1;
        const disable = failures >= DISABLE_AFTER_FAILURES;
        this.db
          .prepare(
            "UPDATE watches SET failures = ?, disabled_at = CASE WHEN ? THEN ? ELSE disabled_at END, note = CASE WHEN ? THEN ? ELSE note END WHERE id = ?",
          )
          .run(
            failures,
            disable ? 1 : 0,
            now,
            disable ? 1 : 0,
            "disabled: the webhook kept failing",
            d.watch_id,
          );
        if (disable) log.warn("watch disabled after repeated failures", { id: d.watch_id });
      }
    }
    return { delivered, failed };
  }

  private async send(
    url: string,
    secret: string,
    deliveryId: number,
    watchId: string,
    event: string,
    payload: string,
    now: number,
  ): Promise<{ ok: true; status: number } | { ok: false; status?: number; error: string }> {
    // The host is checked at every delivery: a DNS record can change after the watch was made.
    let host: string;
    try {
      host = new URL(url).hostname;
      const ips = await this.lookup(host);
      if (ips.length === 0) return { ok: false, error: "host does not resolve" };
      if (ips.some((ip) => isPrivateIp(ip.address)))
        return { ok: false, error: "host resolves to a private address" };
    } catch (err) {
      return { ok: false, error: `lookup failed: ${String(err instanceof Error ? err.message : err)}` };
    }
    const body = JSON.stringify({ id: deliveryId, ...(JSON.parse(payload) as Record<string, unknown>) });
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "user-agent": "Assay-Webhook/1 (+https://assayscore.xyz/docs#alerts)",
          "x-assay-event": event,
          "x-assay-delivery": String(deliveryId),
          "x-assay-watch": watchId,
          "x-assay-timestamp": String(now),
          "x-assay-signature": signDelivery(secret, now, body),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      if (res.status >= 300 && res.status < 400)
        return { ok: false, status: res.status, error: "redirects are not followed" };
      return { ok: false, status: res.status, error: `answered ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: String(err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : err),
      };
    }
  }

  /** Drop old deliveries and watches that expired long ago. */
  prune(now = nowSec()): void {
    this.db.prepare("DELETE FROM watch_deliveries WHERE created_at < ?").run(now - 30 * DAY);
    this.db.prepare("DELETE FROM watches WHERE expires_at < ?").run(now - 90 * DAY);
  }

  /** One pass: detect, deliver, prune. Never throws. */
  async tick(now = nowSec()): Promise<void> {
    try {
      const queued = this.detect(now);
      const r = await this.deliverDue(now);
      if (queued || r.delivered || r.failed) log.info("watch tick", { queued, ...r });
      this.prune(now);
    } catch (err) {
      log.warn("watch tick failed", { error: String(err) });
    }
  }

  async run(signal: AbortSignal, everyMs = 120_000): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, everyMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
