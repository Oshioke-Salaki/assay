import type { Address } from "assayscore-core";
import { z } from "zod";
import type { DB } from "../db.js";
import { sleep } from "../indexer/sqd.js";
import { BudgetExceeded } from "../lib/buy.js";
import { log } from "../lib/log.js";

/**
 * What the public says about a seller on X: every post that names its address, bought one search
 * at a time through the buy gateway. It is evidence for a person to read, never an input to the
 * score: anyone can post "0x… is a scam" about a competitor, and a score that a post can move is
 * not a score. So reports show the posts, the paid check names them in its reasons, and the
 * rating stays what the ledger says.
 */

const DAY = 86_400;
/** Posts change slowly for most addresses; a week keeps the picture fresh at a known cost. */
export const X_REFRESH = 7 * DAY;
const ERROR_RETRY = DAY;
/** Accounts younger than this when they posted, or with fewer followers, are weak evidence. */
const NEW_ACCOUNT = 30 * DAY;
const FEW_FOLLOWERS = 25;
const MAX_POSTS = 16;

/** Words that, next to the address itself, mean someone is warning others about it. */
const WARNING =
  /\b(scam(?:s|mer|mers|med|ming)?|rug(?:ged|s|pull|pulled|pulls)?|rug[\s-]pull(?:ed|s)?|drain(?:er|ers|ed|ing)?|phish(?:ing|er|ers|ed)?|hack(?:ed|er|ers)?|exploit(?:ed|er|ers)?|stole|stolen|theft|fraud(?:s|ster|sters|ulent)?|ponzi|honeypot|impersonat(?:or|ors|ing|ion|ed)|fake)\b/i;
/** How far from the address a warning word may sit. A digest that names it and, paragraphs later, an unrelated hack is not a warning about it. */
const NEAR = 160;

const userInfo = z
  .object({
    screen_name: z.string(),
    name: z.string().nullish(),
    created_at: z.string().nullish(),
    followers_count: z.number().nullish(),
    verified: z.boolean().nullish(),
  })
  .passthrough();

const tweet = z
  .object({
    type: z.string(),
    tweet_id: z.string().regex(/^\d{1,25}$/),
    screen_name: z.string(),
    created_at: z.string(),
    text: z.string(),
    favorites: z.number().nullish(),
    retweets: z.number().nullish(),
    views: z.union([z.string(), z.number()]).nullish(),
    entities: z
      .object({ urls: z.array(z.object({ expanded_url: z.string().nullish() }).passthrough()).nullish() })
      .passthrough()
      .nullish(),
    user_info: userInfo.nullish(),
  })
  .passthrough();

const searchAnswer = z
  .object({
    transaction: z.string().nullish(),
    output: z.object({ status: z.string().nullish(), timeline: z.array(z.unknown()) }).passthrough(),
  })
  .passthrough();

export interface XPost {
  id: string;
  url: string;
  author: string;
  authorName: string | null;
  followers: number | null;
  verified: boolean;
  /** Unix seconds; null when X's date could not be read. */
  postedAt: number | null;
  text: string;
  /** The part of the post around the address, so a reader sees its context without opening X. */
  excerpt: string;
  likes: number;
  reposts: number;
  /** The post contains the address itself (text or a link), not just a near match. */
  namesAddress: boolean;
  /** Names the address and uses a warning word: scam, rug, drainer, phishing, hack, stolen… */
  warning: boolean;
  /** Posted by an account under 30 days old or with under 25 followers. */
  weak: boolean;
  /** The same text as a post listed above it: pasted spam, counted once. */
  copy: boolean;
}

export interface XMentions {
  address: Address;
  checkedAt: number;
  status: "ok" | "error";
  /** Posts that name the address. */
  mentions: number;
  /**
   * Distinct posts from established accounts that name the address next to a warning word (scam,
   * rug, drainer, phishing, hack, stolen…). Copies of the same text count once. This says what
   * the posts contain, not that the address did anything: a victim's plea and spam both qualify.
   */
  warnings: number;
  /** The same, from accounts under 30 days old or with under 25 followers. */
  weakWarnings: number;
  posts: XPost[];
  /** The same search on X, for a person to read further. */
  searchUrl: string;
  /** Settlement of the buy payment that paid for this search. */
  tx: string | null;
  error?: string;
}

/** X's dates look like "Sun Dec 03 01:13:25 +0000 2023". */
export function parseXDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^\w{3} (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/.exec(s.trim());
  if (!m) return null;
  const months = "JanFebMarAprMayJunJulAugSepOctNovDec";
  const month = months.indexOf(m[1]!) / 3;
  if (month < 0 || !Number.isInteger(month)) return null;
  const offset = Number(m[6]!.slice(0, 3)) * 3600 + Math.sign(Number(m[6])) * Number(m[6]!.slice(3)) * 60;
  const utc = Date.UTC(Number(m[7]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000;
  return Number.isFinite(utc) ? utc - offset : null;
}

/** Turn one search answer into the posts Assay keeps, judged against the address searched for. */
export function readSearch(body: unknown, address: Address): { posts: XPost[]; tx: string | null } {
  const parsed = searchAnswer.parse(body);
  const a = address.toLowerCase();
  const posts: XPost[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.output.timeline) {
    const t = tweet.safeParse(raw);
    if (!t.success || t.data.type !== "tweet" || seen.has(t.data.tweet_id)) continue;
    seen.add(t.data.tweet_id);
    const p = t.data;
    const links = (p.entities?.urls ?? []).map((u) => (u.expanded_url ?? "").toLowerCase());
    const text = p.text.toLowerCase();
    const inText = text.includes(a);
    const namesAddress = inText || links.some((l) => l.includes(a));
    const postedAt = parseXDate(p.created_at);
    const joined = parseXDate(p.user_info?.created_at);
    const followers = p.user_info?.followers_count ?? null;
    const weak =
      (followers !== null && followers < FEW_FOLLOWERS) ||
      (postedAt !== null && joined !== null && postedAt - joined < NEW_ACCOUNT);
    posts.push({
      id: p.tweet_id,
      url: `https://x.com/${encodeURIComponent(p.screen_name)}/status/${p.tweet_id}`,
      author: p.screen_name,
      authorName: p.user_info?.name ?? null,
      followers,
      verified: p.user_info?.verified === true,
      postedAt,
      text: p.text.slice(0, 600),
      excerpt: excerptAround(p.text, a, inText),
      likes: p.favorites ?? 0,
      reposts: p.retweets ?? 0,
      namesAddress,
      warning: namesAddress && warnsNear(p.text, a, inText),
      weak,
      copy: false,
    });
  }
  // Warnings first, then the posts most people saw.
  posts.sort(
    (x, y) =>
      Number(y.warning && !y.weak) - Number(x.warning && !x.weak) ||
      Number(y.warning) - Number(x.warning) ||
      (y.followers ?? 0) - (x.followers ?? 0),
  );
  const seenText = new Set<string>();
  for (const p of posts) {
    const key = normalized(p.text);
    p.copy = seenText.has(key);
    seenText.add(key);
  }
  const tx = parsed.transaction && /^0x[0-9a-fA-F]{64}$/.test(parsed.transaction) ? parsed.transaction : null;
  return { posts: posts.slice(0, MAX_POSTS), tx: tx?.toLowerCase() ?? null };
}

/** A warning word in the address's paragraph, within NEAR characters of it (anywhere, when only a link carries it). */
function warnsNear(text: string, address: string, inText: boolean): boolean {
  if (!inText) return WARNING.test(text);
  const lower = text.toLowerCase();
  for (let i = lower.indexOf(address); i !== -1; i = lower.indexOf(address, i + 1)) {
    // Stay inside the paragraph: digests list unrelated items one blank line apart.
    const start = Math.max(0, i - NEAR, lower.lastIndexOf("\n\n", i) + 1);
    const nextBreak = lower.indexOf("\n\n", i + address.length);
    const end = Math.min(i + address.length + NEAR, nextBreak === -1 ? lower.length : nextBreak);
    if (WARNING.test(text.slice(start, end))) return true;
  }
  return false;
}

export function summarize(address: Address, posts: XPost[], checkedAt: number, tx: string | null): XMentions {
  const named = posts.filter((p) => p.namesAddress);
  return {
    address,
    checkedAt,
    status: "ok",
    mentions: named.length,
    warnings: distinctTexts(named.filter((p) => p.warning && !p.weak)),
    weakWarnings: distinctTexts(named.filter((p) => p.warning && p.weak)),
    // Posts the search matched without the address in them are not about this address.
    posts: named,
    searchUrl: xSearchUrl(address),
    tx,
  };
}

/** Spam is pasted, not written: posts whose text matches once case and spacing are ignored count once. */
function distinctTexts(posts: XPost[]): number {
  return new Set(posts.map((p) => normalized(p.text))).size;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Up to NEAR characters either side of the address, inside its paragraph, with ellipses where cut. */
function excerptAround(text: string, address: string, inText: boolean): string {
  const lower = text.toLowerCase();
  const i = inText ? lower.indexOf(address) : -1;
  if (i === -1) return text.length > 2 * NEAR ? `${text.slice(0, 2 * NEAR).trimEnd()}…` : text;
  let start = Math.max(0, i - NEAR, lower.lastIndexOf("\n\n", i) + 1);
  const nextBreak = lower.indexOf("\n\n", i + address.length);
  let end = Math.min(text.length, i + address.length + NEAR, nextBreak === -1 ? text.length : nextBreak);
  // Cut at word boundaries, never through a word or the address.
  if (start > 0 && /\S/.test(text[start - 1] ?? "")) {
    const space = text.slice(start, i).search(/\s/);
    if (space !== -1) start += space + 1;
  }
  if (end < text.length && /\S/.test(text[end] ?? "")) {
    const space = text.slice(i + address.length, end).search(/\s\S*$/);
    if (space !== -1) end = i + address.length + space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export function xSearchUrl(address: string): string {
  return `https://x.com/search?q=${encodeURIComponent(`"${address}"`)}&f=live`;
}

/** One sentence for a pre-payment check, or nothing when X has nothing to add. */
export function xReason(m: XMentions | null): string | null {
  if (m?.status !== "ok") return null;
  if (m.warnings > 0)
    return `${m.warnings === 1 ? "1 post on X names" : `${m.warnings} posts on X name`} this address next to words like scam or hack; read ${m.warnings === 1 ? "it" : "them"} before paying`;
  if (m.weakWarnings > 0)
    return `${m.weakWarnings === 1 ? "1 post from a new or small X account names" : `${m.weakWarnings} posts from new or small X accounts name`} this address next to words like scam or hack`;
  return null;
}

/** The search service would not take Assay's payment. */
export class PaymentRefused extends Error {
  constructor(detail: string) {
    super(`payment refused${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    this.name = "PaymentRefused";
  }
}

export interface XMentionsOptions {
  /** Paying fetch for the buy gateway's X search. */
  pay: typeof fetch;
  searchUrl?: string;
  /** Only sellers that took at least this much are worth a paid search. */
  minGrossUsd?: number;
  /** Pause between searches, to spread the day's budget. */
  paceMs?: number;
  onChange?: () => void;
}

/**
 * Keeps X mentions fresh for every seller worth checking, busiest first, one paid search at a
 * time. Stops for the day when its budget is spent and resumes after midnight UTC.
 */
export class XMentionsWatcher {
  private readonly searchUrl: string;

  constructor(
    private readonly db: DB,
    private readonly opts: XMentionsOptions,
  ) {
    this.searchUrl = opts.searchUrl ?? "https://gateway.usebuy.ai/v1/social/x/posts/search";
  }

  /**
   * Addresses due a search. First what people asked about (paid checks before free views), then
   * sellers by revenue: never checked, a week old, or an error from a day ago.
   */
  queue(limit: number, now = nowSec()): Address[] {
    return (
      this.db
        .prepare(
          `WITH sellers AS (SELECT payee AS address, SUM(usd) AS usd FROM pair_days GROUP BY payee HAVING SUM(usd) >= @min),
                due AS (
                  SELECT w.address, 0 AS tier, -w.paid AS sub, w.wanted_at AS ord FROM x_wanted w
                  UNION ALL
                  SELECT s.address, 1, (x.address IS NOT NULL), -s.usd FROM sellers s
                  LEFT JOIN x_mentions x ON x.address = s.address
                )
           SELECT d.address FROM due d LEFT JOIN x_mentions x ON x.address = d.address
           WHERE x.address IS NULL
              OR (x.status = 'ok' AND x.checked_at < @fresh)
              OR (x.status = 'error' AND x.checked_at < @retry)
           GROUP BY d.address
           ORDER BY MIN(d.tier), MIN(d.sub), MIN(d.ord) LIMIT @limit`,
        )
        .all({
          min: this.opts.minGrossUsd ?? 1,
          fresh: now - X_REFRESH,
          retry: now - ERROR_RETRY,
          limit,
        }) as {
        address: Address;
      }[]
    ).map((r) => r.address);
  }

  get(address: Address): XMentions | null {
    return readXMentions(this.db, address);
  }

  /** One paid search for one address, stored whatever the outcome. */
  async check(address: Address, now = nowSec()): Promise<XMentions> {
    const a = address.toLowerCase() as Address;
    let result: XMentions;
    try {
      const res = await this.opts.pay(this.searchUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Quoted, so X matches the whole address and not its pieces.
        body: JSON.stringify({ query: `"${a}"`, type: "top" }),
        signal: AbortSignal.timeout(120_000),
      });
      // Still 402 after paying means the payment itself was refused (an empty wallet, an expired
      // authorisation). That says nothing about the address, so nothing is stored for it.
      if (res.status === 402) throw new PaymentRefused(await res.text().catch(() => ""));
      if (!res.ok) throw new Error(`X search answered ${res.status}`);
      const { posts, tx } = readSearch(await res.json(), a);
      result = summarize(a, posts, now, tx);
    } catch (err) {
      if (err instanceof BudgetExceeded || err instanceof PaymentRefused) throw err;
      result = {
        address: a,
        checkedAt: now,
        status: "error",
        mentions: 0,
        warnings: 0,
        weakWarnings: 0,
        posts: [],
        searchUrl: xSearchUrl(a),
        tx: null,
        error: String(err instanceof Error ? err.message : err).slice(0, 200),
      };
    }
    this.db
      .prepare(
        `INSERT INTO x_mentions (address, checked_at, status, mentions, warnings, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET checked_at = excluded.checked_at, status = excluded.status,
           mentions = excluded.mentions, warnings = excluded.warnings, data = excluded.data`,
      )
      .run(a, result.checkedAt, result.status, result.mentions, result.warnings, JSON.stringify(result));
    this.db.prepare("DELETE FROM x_wanted WHERE address = ?").run(a);
    // Even "nobody mentions it" is news for the report, so every stored result refreshes it.
    this.opts.onChange?.();
    return result;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const next = this.queue(1)[0];
      if (!next) {
        await sleep(30 * 60_000, signal);
        continue;
      }
      try {
        const r = await this.check(next);
        if (r.status === "ok") {
          log.info("x mentions", { address: next, mentions: r.mentions, warnings: r.warnings, tx: r.tx });
        } else log.warn("x mentions failed", { address: next, error: r.error });
        await sleep(r.status === "ok" ? (this.opts.paceMs ?? 20_000) : 60_000, signal);
      } catch (err) {
        if (err instanceof PaymentRefused) {
          log.error("x mentions paused: payment refused; top up the agent wallet with USDC", {
            reason: err.message,
          });
          await sleep(60 * 60_000, signal);
          continue;
        }
        if (!(err instanceof BudgetExceeded)) throw err;
        const untilMidnight = (DAY - (nowSec() % DAY) + 60) * 1000;
        log.info("x mentions budget spent for today", { resumeInMin: Math.round(untilMidnight / 60_000) });
        await sleep(untilMidnight, signal);
      }
    }
  }
}

/**
 * Ask for an address to be searched on X soon. Someone paying for a check on it outranks someone
 * reading its report; either way it costs nothing until the watcher gets to it within its budget.
 */
export function wantXMentions(db: DB, address: string, paid: boolean, now = nowSec()): void {
  db.prepare(
    `INSERT INTO x_wanted (address, wanted_at, paid) VALUES (?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET paid = MAX(paid, excluded.paid)`,
  ).run(address.toLowerCase(), now, paid ? 1 : 0);
}

/** The stored X picture for one address, or null when it has not been searched yet. */
export function readXMentions(db: DB, address: string): XMentions | null {
  const row = db.prepare("SELECT data FROM x_mentions WHERE address = ?").get(address.toLowerCase()) as
    | { data: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as XMentions;
  } catch {
    return null;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
