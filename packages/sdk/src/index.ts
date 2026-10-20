import { type Address, type CheckResult, isAddress, RATING_CODES, type Rating } from "@assay/core";

export type { Address, CheckResult, Rating } from "@assay/core";

type Fetch = typeof fetch;
type FetchInput = Parameters<typeof fetch>[0];

export interface AssayOptions {
  /** Assay API origin, e.g. the URL your Assay server is deployed at. */
  baseUrl: string;
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

export interface AddressReport {
  asOf: number;
  check: CheckResult;
  // The full assessment is typed loosely here; see @assay/core's Assessment.
  assessment: Record<string, unknown> & { rating: Rating; score: number | null };
  agents: unknown[];
}

export interface PaidCheck extends CheckResult {
  asOf: number;
  attestation: Attestation | null;
}

export interface Attestation {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  primaryType: "Score";
  message: Record<string, string | number>;
  signature: `0x${string}`;
  signer: Address;
}

export function createAssay(opts: AssayOptions) {
  if (!opts?.baseUrl) throw new AssayError(0, "no_base_url", "createAssay needs a baseUrl");
  const base = opts.baseUrl.replace(/\/+$/, "");
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
    /** Paid ($0.002): verdict plus a signed score. Needs `payingFetch`. */
    check: (a: string) => {
      if (!opts.payingFetch) throw new AssayError(0, "no_paying_fetch", "check() needs an x402 payingFetch");
      return call<PaidCheck>(opts.payingFetch, `/v1/check/${requireAddress(a)}`);
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

export interface GuardOptions {
  /** Assay client used for checks (its free address endpoint). Give this or `baseUrl`. */
  assay?: AssayClient;
  baseUrl?: string;
  /** Lowest acceptable rating. Default: none, only "block" verdicts stop a payment. */
  minRating?: Exclude<Rating, "NR">;
  /** Let unrated (thin file) sellers through. Default true: new sellers have to start somewhere. */
  allowUnrated?: boolean;
  /** What to do if Assay itself is unreachable. Default "allow" (fail open). */
  onAssayError?: "allow" | "block";
  /** Cache verdicts for this long. Default 10 minutes. */
  cacheMs?: number;
  /** Called for every decision, for logs and dashboards. */
  onDecision?: (d: { payTo: Address; allowed: boolean; result: CheckResult | null; error?: unknown }) => void;
}

/**
 * Wrap an x402-paying fetch so it checks the seller with Assay before any money moves.
 *
 *   const guarded = withAssayGuard(fetch, wrapFetchWithPayment(fetch, client), {
 *     baseUrl: "https://your-assay-server",
 *     minRating: "BB",
 *   });
 *   await guarded("https://seller.example/api");   // throws AssayBlockedError for wash sellers
 *
 * The first request goes out unpaid. If the seller answers 402, every `payTo` it
 * offers is checked; only if all pass does the request go through the paying fetch.
 * Non-402 responses are returned untouched and nothing is paid. A 402 that names
 * no payTo cannot be checked and is passed to the paying fetch. Request bodies must
 * be replayable (strings, Blobs, FormData or a Request object), since the request is sent twice.
 */
export function withAssayGuard(plainFetch: Fetch, payingFetch: Fetch, opts: GuardOptions): Fetch {
  const assay = opts.assay ?? createAssay({ baseUrl: opts.baseUrl ?? "", fetch: plainFetch });
  const cacheMs = opts.cacheMs ?? 10 * 60_000;
  const cache = new Map<Address, { at: number; result: CheckResult }>();

  const decide = async (payTo: Address): Promise<CheckResult | null> => {
    const hit = cache.get(payTo);
    if (hit && Date.now() - hit.at < cacheMs) return hit.result;
    const report = await assay.address(payTo);
    cache.set(payTo, { at: Date.now(), result: report.check });
    return report.check;
  };

  const allowed = (r: CheckResult): boolean => {
    if (r.verdict === "block") return false;
    if (r.rating === "NR") return opts.allowUnrated ?? true;
    if (opts.minRating && RATING_CODES[r.rating] < RATING_CODES[opts.minRating]) return false;
    return true;
  };

  const guarded = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const replayable = input instanceof Request ? input.clone() : input;
    const probe = await plainFetch(input, init);
    if (probe.status !== 402) return probe;
    const payTos = await readPayTos(probe);
    for (const payTo of payTos) {
      let result: CheckResult | null = null;
      try {
        result = await decide(payTo);
      } catch (error) {
        const ok = (opts.onAssayError ?? "allow") === "allow";
        opts.onDecision?.({ payTo, allowed: ok, result: null, error });
        if (!ok) throw error;
        continue;
      }
      const ok = result ? allowed(result) : true;
      opts.onDecision?.({ payTo, allowed: ok, result });
      if (!ok && result) throw new AssayBlockedError(payTo, result);
    }
    return payingFetch(replayable, init);
  };
  return guarded as Fetch;
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
