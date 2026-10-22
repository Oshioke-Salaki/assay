import type { Address, Assessment, CheckResult, Rating } from "assayscore-core";

/** Server-side base URL (can be a private address) and the public one the browser uses. */
export const API_INTERNAL =
  process.env.ASSAY_API_INTERNAL ?? process.env.NEXT_PUBLIC_ASSAY_API ?? "http://localhost:8787";
export const API_PUBLIC = process.env.NEXT_PUBLIC_ASSAY_API ?? "http://localhost:8787";

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
  /** What the wallet's owner put on its page, when it has claimed it. */
  name?: string;
  what?: string | null;
  category?: string | null;
  url?: string | null;
}

/** What a wallet's owner put on its page by signing a claim. */
export interface ClaimInfo {
  address: Address;
  name: string;
  url: string | null;
  logoUrl: string | null;
  x: string | null;
  what: string | null;
  category: string | null;
  updatedAt: number;
}

/** Which payers count as independent users, by the hackathon's published rule. */
export interface Independent {
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
    firstPaymentTs: number;
    firstSeenAt: number | null;
    class: string;
    funder: Address | null;
    inWindow: { usd: number; count: number };
  }[];
}

export interface Economy {
  asOf: number;
  methodology: string;
  grossUsd: number;
  organicUsd: number;
  loopOffsetUsd: number;
  fundedUsd: number;
  settlements: number;
  sellers: number;
  payers: number;
  organicPayers: number;
  loops: number;
  addressesInLoops: number;
  largestLoop: number;
  ratingCounts: Record<Rating, number>;
  reviews: { total: number; fromPayers: number; proven: number };
  topSellers: SellerRow[];
}

export interface DailyPoint {
  day: number;
  grossUsd: number;
  organicUsd: number;
  settlements: number;
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

export interface ReviewRow {
  agentId: string;
  client: Address;
  index: number;
  value: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  ts: number;
  txHash: `0x${string}`;
  revoked: boolean;
  proofTx: `0x${string}` | null;
  comment: string | null;
  tier: "proven" | "paid" | "unverified";
  clientPaidUsd: number;
}

export type TrimmedAssessment = Assessment & {
  seller: Assessment["seller"] & { payerLinesTruncated: boolean };
  buyer: Assessment["buyer"] & { counterpartiesTruncated: boolean };
};

export interface XPost {
  id: string;
  url: string;
  author: string;
  authorName: string | null;
  followers: number | null;
  verified: boolean;
  postedAt: number | null;
  text: string;
  /** The part around the address; absent on results stored before excerpts existed. */
  excerpt?: string;
  likes: number;
  reposts: number;
  namesAddress: boolean;
  warning: boolean;
  weak: boolean;
  /** Same text as a post above it (pasted spam), counted once. */
  copy?: boolean;
}

/** What X says about an address, from Assay's paid searches through buy. Evidence, never scored. */
export interface XMentions {
  address: Address;
  checkedAt: number;
  status: "ok" | "error";
  mentions: number;
  warnings: number;
  weakWarnings: number;
  posts: XPost[];
  searchUrl: string;
  tx: string | null;
  error?: string;
}

export interface AddressResponse {
  asOf: number;
  assessment: TrimmedAssessment;
  check: CheckResult;
  agents: AgentRow[];
  /** Absent on servers older than the X search; null when not searched yet. */
  x?: XMentions | null;
  claim?: ClaimInfo | null;
  /** The seller's own words under a finding, by finding code. Never part of a score. */
  responses?: Record<string, { text: string; updatedAt: number }>;
}

export interface AgentResponse {
  agent: AgentRow;
  assessment: TrimmedAssessment;
  check: CheckResult;
  reviews: ReviewRow[];
  x?: XMentions | null;
}

export interface Status {
  settlementsBlock: number;
  registryBlock: number;
  finalizedHead: number | null;
  lastSettlementTs: number | null;
  lagBlocks: number | null;
  synced: boolean;
  attester: Address | null;
  registry: Address | null;
  payments: boolean;
}

/** Server-only: lets this app's servers past the API's per-IP limit. Never sent from a browser. */
function internalHeader(): Record<string, string> {
  if (typeof window !== "undefined") return {};
  const key = process.env.ASSAY_INTERNAL_KEY;
  return key ? { "x-assay-internal": key } : {};
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Server-side fetch with a short revalidation window. Errors surface as ApiError so pages can show an honest state. */
export async function api<T>(path: string, revalidate = 30): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_INTERNAL}${path}`, {
      // Cached and shared across visitors for `revalidate` seconds, so a crowd on one report costs one call.
      next: { revalidate },
      headers: { accept: "application/json", ...internalHeader() },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(0, "The Assay API is not reachable right now.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, body?.message ?? `The Assay API answered ${res.status}.`);
  }
  return (await res.json()) as T;
}

/** Same as api() but returns null instead of throwing, for blocks that degrade gracefully. */
export async function tryApi<T>(path: string, revalidate = 30): Promise<T | null> {
  try {
    return await api<T>(path, revalidate);
  } catch {
    return null;
  }
}

export type UsageKind =
  | "report"
  | "check_paid"
  | "check_quoted"
  | "attest_paid"
  | "attest_quoted"
  | "agents"
  | "economy"
  | "api_other"
  | "rate_limited";

/** Public numbers about Assay itself, from GET /v1/stats. */
export interface Stats {
  asOf: number;
  usage: {
    days: { day: number; visitors: number; counts: Record<UsageKind, number> }[];
    totals: Record<UsageKind, number>;
    note: string;
  } | null;
  revenue: {
    payTo: Address;
    payments: number;
    usd: number;
    payers: number;
    byToken: { symbol: string; payments: number; usd: number }[];
    daily: { day: number; payments: number; usd: number }[];
    recent: { tx: string; ts: number; payer: Address; token: string; usd: number }[];
  } | null;
  spend: { services: { service: string; calls: number; usd: number; lastTs: number }[]; usd: number };
  x: { sellersSearched: number; withMentions: number; withWarnings: number; lastSearchAt: number | null };
  data: {
    settlementsBlock: number;
    finalizedHead: number | null;
    lagBlocks: number | null;
    lastSettlementTs: number | null;
    fundingCoverage: number | null;
  };
  /** Assay's own PayTo address, rated by Assay's rules. */
  self: {
    address: Address;
    rating: Rating;
    verdict: "pass" | "caution" | "block";
    reasons: string[];
    grossUsd: number;
    organicUsd: number;
    fundedUsd: number;
    payers: number;
    organicPayers: number;
    /** Independent payers by the hackathon's rule. */
    independent?: number;
  } | null;
}

/** Operator view, from GET /v1/admin with the admin key. */
export interface AdminStats {
  asOf: number;
  wallets: {
    role: string;
    address: Address;
    celo: number | null;
    tokens: { symbol: string; balance: number | null }[];
  }[];
  budgets: { service: string; capUsd: number; spentUsd: number; calls: number; failed: number }[];
  x: { wanted: number; neverSearched: number; errorsToday: number };
  recentPaidCalls: {
    id: number;
    ts: number;
    service: string;
    status: number;
    usd: number;
    txHash: string | null;
    note: string | null;
  }[];
  problems: {
    id: number;
    t: string;
    level: "warn" | "error";
    msg: string;
    fields?: Record<string, unknown>;
  }[];
  database: { sizeMb: number; settlements: number; agents: number };
  process: {
    uptimeMin: number;
    rssMb: number;
    heapMb: number;
    node: string;
    region: string | null;
    image: string | null;
    role: string;
  };
}
