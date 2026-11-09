import type { PayerCheck, RatingPlan } from "assayscore-core";
import { type Address, type CheckResult, isAddress, RATING_CODES, type Rating } from "assayscore-core";

export type { Address, CheckResult, PayerCheck, Rating, RatingPlan } from "assayscore-core";

type Fetch = typeof fetch;
type FetchInput = Parameters<typeof fetch>[0];

/** The public Assay API on Celo mainnet. Pass `baseUrl` to use your own deployment instead. */
export const DEFAULT_BASE_URL = "https://api.assayscore.xyz";

export interface AssayOptions {
  /** Assay API origin. Default: the public Assay API, {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Plain fetch used for free endpoints. */
  fetch?: Fetch;
  /**
   * An x402-paying fetch (for example `wrapFetchWithPayment(fetch, client)` from
   * @x402/fetch). Needed only for `check` and `attest`, the paid endpoints.
   */
  payingFetch?: Fetch;
}

export class AssayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AssayError";
  }
}

export interface XPost {
  id: string;
  url: string;
  author: string;
  followers: number | null;
  verified: boolean;
  postedAt: number | null;
  text: string;
  excerpt: string;
  /** Names the address next to a word like scam, rug, drainer, phishing, hack or stolen. */
  warning: boolean;
  /** From an account under 30 days old or with under 25 followers. */
  weak: boolean;
  /** Same text as a post above it. */
  copy: boolean;
}

/**
 * What X says about an address, from Assay's weekly paid searches. Evidence for a reader, never
 * part of the score: anyone can post about any address.
 */
export interface XMentions {
  checkedAt: number;
  status: "ok" | "error";
  mentions: number;
  /** Distinct posts from established accounts naming the address next to warning words. */
  warnings: number;
  weakWarnings: number;
  posts: XPost[];
  searchUrl: string;
  /** Settlement of the payment for this search. */
  tx: string | null;
}

export interface FindingResponse {
  text: string;
  updatedAt: number;
}

export interface AddressReport {
  asOf: number;
  check: CheckResult;
  // The full assessment is typed loosely here; see assayscore-core's Assessment.
  assessment: Record<string, unknown> & {
    rating: Rating;
    score: number | null;
    /** The seller's own words under a finding, by finding code. Never part of a score. */
    responses?: Record<string, FindingResponse>;
  };
  agents: unknown[];
  /** Null until Assay has searched X for this address. */
  x?: XMentions | null;
}

export interface CheckOptions {
  /**
   * Buy an X search for the address now ($0.01 instead of $0.002): every post naming it, with
   * warnings counted, fresh or at most fifteen minutes old. If Assay cannot buy the search it
   * answers 502/503 and the x402 payment is not settled.
   */
  freshX?: boolean;
}

export interface PaidCheck extends CheckResult {
  asOf: number;
  attestation: Attestation | null;
  /**
   * What X says, in brief; a paid check on an address not yet searched queues one. With
   * `freshX`, the full picture with its posts, `fresh: true`, and `reused` when a search from
   * the last fifteen minutes served the request.
   */
  x?:
    | (Pick<XMentions, "checkedAt" | "mentions" | "warnings" | "weakWarnings" | "searchUrl"> &
        Partial<XMentions> & { fresh?: boolean; reused?: boolean })
    | null;
}

export interface IndependentReport {
  address: Address;
  rule: string;
  window: { from: number; to: number };
  totals: {
    payers: number;
    independent: number;
    notIndependent: number;
    unknown: number;
    independentUsd: number;
    independentInWindow: number;
    independentUsdInWindow: number;
    usdInWindow: number;
  };
  rows: {
    payer: Address;
    independent: boolean | null;
    reasons: string[];
    usd: number;
    count: number;
    inWindow: { usd: number; count: number };
  }[];
}

export interface SellerRow {
  address: Address;
  grossUsd: number;
  organicUsd: number;
  payers: number;
  organicPayers: number;
  settlements: number;
  score: number | null;
  rating: Rating;
  lastTs: number | null;
  agentIds: string[];
  /** Present when the wallet's owner has claimed its page. */
  name?: string;
  what?: string | null;
  category?: string | null;
  url?: string | null;
}

export interface SellersQuery {
  /** Name, what they sell, category, agent id or address fragment. */
  q?: string;
  /** Only sellers rated this or better: "BBB", "BB", "B", … */
  minRating?: Rating;
  category?: string;
  claimedOnly?: boolean;
  sort?: "organic" | "gross";
  limit?: number;
  offset?: number;
}

export interface Watch {
  id: string;
  /** Shown once, on creation; null when an existing watch was extended. */
  secret: string | null;
  address: Address;
  url: string;
  expiresAt: number;
  renewed: boolean;
  note: string;
}

export interface Attestation {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  primaryType: "Score";
  message: Record<string, string | number>;
  signature: `0x${string}`;
  signer: Address;
}

export function createAssay(opts: AssayOptions = {}) {
  const base = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const plain = opts.fetch ?? globalThis.fetch.bind(globalThis);

  async function call<T>(f: Fetch, path: string): Promise<T> {
    const res = await f(`${base}${path}`, { headers: { accept: "application/json" } });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new AssayError(res.status, "bad_response", `Assay returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: string; message?: string };
      throw new AssayError(res.status, b.error ?? "http_error", b.message ?? `Assay returned ${res.status}`);
    }
    return body as T;
  }

  const requireAddress = (a: string): Address => {
    if (!isAddress(a)) throw new AssayError(400, "bad_address", `Not an address: ${a}`);
    return a.toLowerCase() as Address;
  };

  return {
    /** Free: totals for the whole Celo x402 economy. */
    economy: () => call<Record<string, unknown>>(plain, "/v1/economy"),
    /** Free, rate limited: the full report for one address. */
    address: (a: string) => call<AddressReport>(plain, `/v1/address/${requireAddress(a)}`),
    /** Free: ERC-8004 agents on Celo with payment-verified review counts. */
    agents: (q?: { q?: string; limit?: number; offset?: number }) => {
      const p = new URLSearchParams();
      if (q?.q) p.set("q", q.q);
      if (q?.limit) p.set("limit", String(q.limit));
      if (q?.offset) p.set("offset", String(q.offset));
      const qs = p.toString();
      return call<{ total: number; rows: unknown[] }>(plain, `/v1/agents${qs ? `?${qs}` : ""}`);
    },
    /** Free: sellers on Celo ranked by organic revenue, searchable and filterable; claimed sellers carry their name. */
    sellers: (q: SellersQuery = {}) => {
      const p = new URLSearchParams();
      if (q.q) p.set("q", q.q);
      if (q.minRating) p.set("minRating", q.minRating);
      if (q.category) p.set("category", q.category);
      if (q.claimedOnly) p.set("claimed", "1");
      if (q.sort) p.set("sort", q.sort);
      if (q.limit) p.set("limit", String(q.limit));
      if (q.offset) p.set("offset", String(q.offset));
      const qs = p.toString();
      return call<{ total: number; rows: SellerRow[] }>(plain, `/v1/sellers${qs ? `?${qs}` : ""}`);
    },
    /** Free, for sellers: is this payer an established customer or a sock, and how does it stand to `seller`? */
    payer: (a: string, q: { seller?: string } = {}) =>
      call<PayerCheck>(
        plain,
        `/v1/payer/${requireAddress(a)}${q.seller ? `?seller=${requireAddress(q.seller)}` : ""}`,
      ),
    /** Free: what would raise an address's rating, from the real score formula. */
    plan: (a: string) => call<RatingPlan>(plain, `/v1/address/${requireAddress(a)}/plan`),
    /** Free: which of a seller's payers count as independent users by the hackathon's rule, with reasons. */
    independent: (a: string, q?: { from?: number; to?: number; limit?: number }) => {
      const p = new URLSearchParams();
      if (q?.from) p.set("from", String(q.from));
      if (q?.to) p.set("to", String(q.to));
      if (q?.limit) p.set("limit", String(q.limit));
      const qs = p.toString();
      return call<IndependentReport>(plain, `/v1/independent/${requireAddress(a)}${qs ? `?${qs}` : ""}`);
    },
    /** The SVG badge URL for an address, for READMEs. */
    badgeUrl: (a: string) => `${base}/v1/badge/${requireAddress(a)}.svg`,
    /**
     * Paid ($0.05 for thirty days): alerts to `url` when the address's rating or verdict changes, a
     * critical finding appears, or warning posts show up on X. Keep the returned secret: deliveries
     * are signed with it. Needs `payingFetch`.
     */
    watch: async (a: string, url: string) => {
      if (!opts.payingFetch) throw new AssayError(0, "no_paying_fetch", "watch() needs an x402 payingFetch");
      const res = await opts.payingFetch(`${base}/v1/watch`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ address: requireAddress(a), url }),
      });
      const body = (await res.json().catch(() => null)) as
        | Watch
        | { error?: string; message?: string }
        | null;
      if (!res.ok) {
        const b = (body ?? {}) as { error?: string; message?: string };
        throw new AssayError(
          res.status,
          b.error ?? "http_error",
          b.message ?? `Assay returned ${res.status}`,
        );
      }
      return body as Watch;
    },
    /** Paid ($0.002, or $0.01 with `freshX`): verdict plus a signed score. Needs `payingFetch`. */
    check: (a: string, options: CheckOptions = {}) => {
      if (!opts.payingFetch) throw new AssayError(0, "no_paying_fetch", "check() needs an x402 payingFetch");
      return call<PaidCheck>(opts.payingFetch, `/v1/check/${requireAddress(a)}${options.freshX ? "/x" : ""}`);
    },
    /** Paid ($0.01): full report plus a signed score that AssayRegistry verifies. Needs `payingFetch`. */
    attest: (a: string) => {
      if (!opts.payingFetch) throw new AssayError(0, "no_paying_fetch", "attest() needs an x402 payingFetch");
      return call<AddressReport & { attestation: Attestation | null }>(
        opts.payingFetch,
        `/v1/attest/${requireAddress(a)}`,
      );
    },
  };
}

export type AssayClient = ReturnType<typeof createAssay>;

export class AssayBlockedError extends Error {
  constructor(
    readonly payTo: Address,
    readonly result: CheckResult,
  ) {
    super(`Assay blocked payment to ${payTo}: ${result.reasons.join("; ") || result.verdict}`);
    this.name = "AssayBlockedError";
  }
}

/**
 * True when `err` is Assay refusing a seller: an AssayBlockedError, or the same refusal re-wrapped
 * by @x402/fetch ("Failed to create payment payload: Assay blocked payment to 0x...").
 */
export function isAssayBlocked(err: unknown): boolean {
  if (err instanceof AssayBlockedError) return true;
  return err instanceof Error && /Assay blocked payment to 0x[0-9a-fA-F]{40}/.test(err.message);
}

export interface GuardOptions {
  /** Assay client used for checks (its free address endpoint). Default: one for `baseUrl`. */
  assay?: AssayClient;
  /** Default: the public Assay API. */
  baseUrl?: string;
  /** Lowest acceptable rating. Default: none, only "block" verdicts stop a payment. */
  minRating?: Exclude<Rating, "NR">;
  /** Let unrated (thin file) sellers through. Default true: new sellers have to start somewhere. */
  allowUnrated?: boolean;
  /**
   * What to do when Assay cannot give a valid answer: unreachable, an error, or a malformed or
   * unknown verdict. Default "allow" (fail open); use "block" for a hard gate.
   */
  onAssayError?: "allow" | "block";
  /** Cache verdicts for this long. Default 10 minutes. */
  cacheMs?: number;
  /** Addresses kept in the verdict cache. Default 5000. */
  maxCached?: number;
  /**
   * assayGuardClient only: payments on networks other than Celo mainnet, which Assay does not
   * rate. Default "block".
   */
  otherNetworks?: "allow" | "block";
  /** Called for every decision, for logs and dashboards. Errors thrown here are ignored. */
  onDecision?: (d: { payTo: Address; allowed: boolean; result: CheckResult | null; error?: unknown }) => void;
}

const CELO_NETWORK = "eip155:42220";
const VERDICTS = new Set(["pass", "caution", "block"]);
const monotonic = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Assay's answer for `payTo`, or an AssayError when it is missing, malformed or about another address. */
function validCheck(report: unknown, payTo: Address): CheckResult {
  const r = (report as { check?: unknown } | null)?.check as Partial<CheckResult> | null | undefined;
  if (
    !r ||
    typeof r !== "object" ||
    typeof r.verdict !== "string" ||
    !VERDICTS.has(r.verdict) ||
    typeof r.rating !== "string" ||
    !(r.rating in RATING_CODES) ||
    (r.address !== undefined && String(r.address).toLowerCase() !== payTo)
  ) {
    throw new AssayError(0, "bad_response", `Assay returned no valid verdict for ${payTo}`);
  }
  return { ...r, reasons: Array.isArray(r.reasons) ? r.reasons : [] } as CheckResult;
}

/**
 * The shared decision: resolves when `payTo` may be paid, throws AssayBlockedError when Assay does
 * not clear it, and applies `onAssayError` when Assay cannot answer validly.
 */
function makeGuard(opts: GuardOptions, plainFetch?: Fetch) {
  const assay = opts.assay ?? createAssay({ baseUrl: opts.baseUrl, fetch: plainFetch });
  const cacheMs = opts.cacheMs ?? 10 * 60_000;
  const maxCached = opts.maxCached ?? 5000;
  const cache = new Map<Address, { at: number; result: CheckResult }>();
  const report = (d: Parameters<NonNullable<GuardOptions["onDecision"]>>[0]) => {
    try {
      opts.onDecision?.(d);
    } catch {
      // a logging callback must not decide a payment
    }
  };

  const verdict = async (payTo: Address): Promise<CheckResult> => {
    const hit = cache.get(payTo);
    if (hit) {
      const age = monotonic() - hit.at;
      if (age >= 0 && age < cacheMs) return hit.result;
      cache.delete(payTo);
    }
    const result = validCheck(await assay.address(payTo), payTo);
    if (cacheMs > 0 && maxCached > 0) {
      cache.set(payTo, { at: monotonic(), result });
      while (cache.size > maxCached) cache.delete(cache.keys().next().value as Address);
    }
    return result;
  };

  const allowed = (r: CheckResult): boolean => {
    if (r.verdict !== "pass" && r.verdict !== "caution") return false;
    if (r.rating === "NR") return opts.allowUnrated ?? true;
    if (opts.minRating && !(RATING_CODES[r.rating] >= RATING_CODES[opts.minRating])) return false;
    return true;
  };

  /** Throws unless `payTo` may be paid. */
  const check = async (payTo: Address): Promise<void> => {
    let result: CheckResult;
    try {
      result = await verdict(payTo);
    } catch (error) {
      const ok = (opts.onAssayError ?? "allow") === "allow";
      report({ payTo, allowed: ok, result: null, error });
      if (!ok) throw error;
      return;
    }
    const ok = allowed(result);
    report({ payTo, allowed: ok, result });
    if (!ok) throw new AssayBlockedError(payTo, result);
  };

  /** No payTo could be read from a payment challenge: treated as Assay being unable to answer. */
  const unreadable = (where: string): void => {
    const error = new AssayError(0, "no_pay_to", `${where} names no payTo address Assay can check`);
    const ok = (opts.onAssayError ?? "allow") === "allow";
    report({ payTo: "0x0000000000000000000000000000000000000000", allowed: ok, result: null, error });
    if (!ok) throw error;
  };

  return { check, unreadable };
}

/** The part of an x402 client this needs: its before-signing hook (x402Client from @x402/core or @x402/fetch). */
interface HookableClient {
  onBeforePaymentCreation(
    hook: (context: {
      selectedRequirements: { network: string; payTo: string };
      // biome-ignore lint/suspicious/noConfusingVoidType: mirrors x402's own BeforePaymentCreationHook type
    }) => Promise<void | { abort: true; reason: string }>,
  ): unknown;
}

/**
 * Make an x402 client check every seller with Assay at the moment it signs a payment, against the
 * exact requirements it is about to sign. This binds the check to the payment: a seller cannot
 * show one address to the check and another to the signer.
 *
 *   const client = assayGuardClient(new x402Client().register(...), { minRating: "BB" });
 *   const pay = wrapFetchWithPayment(fetch, client);   // refuses before signing
 *
 * @x402/fetch re-wraps errors from the client in a plain Error, so test a refusal with
 * {@link isAssayBlocked} rather than `instanceof AssayBlockedError`.
 * Payments on other networks are refused unless `otherNetworks: "allow"`; Assay rates Celo.
 */
export function assayGuardClient<C extends HookableClient>(client: C, opts: GuardOptions = {}): C {
  const guard = makeGuard(opts);
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (r.network !== CELO_NETWORK) {
      if ((opts.otherNetworks ?? "block") === "allow") return;
      throw new AssayError(0, "unsupported_network", `Assay rates Celo mainnet only, not ${r.network}`);
    }
    if (typeof r.payTo !== "string" || !isAddress(r.payTo)) {
      guard.unreadable("The payment requirements");
      return;
    }
    await guard.check(r.payTo.toLowerCase() as Address);
  });
  return client;
}

/**
 * Wrap an x402-paying fetch so it checks the seller with Assay before any money moves.
 *
 *   const client = assayGuardClient(new x402Client().register(...));
 *   const guarded = withAssayGuard(fetch, wrapFetchWithPayment(fetch, client), { minRating: "BB" });
 *   await guarded("https://seller.example/api");   // throws AssayBlockedError for wash sellers
 *
 * The first request goes out unpaid. If the seller answers 402, every `payTo` it offers is checked;
 * only if all pass does the request go through the paying fetch. The paying fetch makes its own
 * request and signs whatever that answer asks for, so on its own this probe cannot stop a seller
 * that shows a different address the second time: build the paying fetch from
 * {@link assayGuardClient}, as above, and the signer checks the address it actually pays.
 * Non-402 responses are returned untouched and nothing is paid. A 402 that names no readable payTo
 * is treated as Assay being unable to answer (see `onAssayError`). Request bodies must be
 * replayable (strings, Blobs, FormData or a Request object), since the request is sent twice.
 */
export function withAssayGuard(plainFetch: Fetch, payingFetch: Fetch, opts: GuardOptions = {}): Fetch {
  const guard = makeGuard(opts, plainFetch);
  const guarded = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const replayable = input instanceof Request ? input.clone() : input;
    const probe = await plainFetch(input, init);
    if (probe.status !== 402) return probe;
    const payTos = await readPayTos(probe);
    if (payTos.length === 0) guard.unreadable("The 402 response");
    for (const payTo of payTos) await guard.check(payTo);
    return payingFetch(replayable, init);
  };
  return guarded as Fetch;
}

/** Token symbols Assay accepts, mapped to their Celo addresses. */
export const CELO_PAY_TOKENS = {
  USDT: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
  USDC: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
  USAT: "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
  wARS: "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d",
  wBRL: "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0",
  wCOP: "0x8a1d45e102e886510e891d2ec656a708991e2d76",
} as const satisfies Record<string, Address>;

export type CeloPayToken = keyof typeof CELO_PAY_TOKENS;

/**
 * A payment-requirements selector for `new x402Client(selector)`: pay in the first of `tokens`
 * the server accepts. x402's default takes the server's first option whatever the wallet holds,
 * so an agent that only holds USDC should say so:
 *
 *   const client = new x402Client(preferAssets("USDC", "USDT"));
 */
export function preferAssets(...tokens: (CeloPayToken | Address)[]) {
  const wanted = tokens.map((t) =>
    t in CELO_PAY_TOKENS ? CELO_PAY_TOKENS[t as CeloPayToken] : t.toLowerCase(),
  );
  return <R extends { asset: string }>(_version: number, reqs: R[]): R => {
    for (const w of wanted) {
      const hit = reqs.find((r) => r.asset.toLowerCase() === w);
      if (hit) return hit;
    }
    if (!reqs[0]) throw new AssayError(0, "no_requirements", "The server offered no way to pay");
    return reqs[0];
  };
}

/** Pull payTo addresses out of an x402 v2 PAYMENT-REQUIRED header, or a v1 JSON body. */
export async function readPayTos(res: Response): Promise<Address[]> {
  const found = new Set<Address>();
  const add = (accepts: unknown) => {
    if (!Array.isArray(accepts)) return;
    for (const a of accepts) {
      const payTo = (a as { payTo?: unknown })?.payTo;
      if (typeof payTo === "string" && isAddress(payTo)) found.add(payTo.toLowerCase() as Address);
    }
  };
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      add((JSON.parse(decodeBase64(header)) as { accepts?: unknown }).accepts);
    } catch {
      // fall through to the body
    }
  }
  if (found.size === 0) {
    try {
      add(((await res.clone().json()) as { accepts?: unknown }).accepts);
    } catch {
      // not JSON
    }
  }
  return [...found];
}

function decodeBase64(s: string): string {
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
