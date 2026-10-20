import type { Address, Assessment, CheckResult, Rating } from "@assay/core";

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

export interface AddressResponse {
  asOf: number;
  assessment: TrimmedAssessment;
  check: CheckResult;
  agents: AgentRow[];
}

export interface AgentResponse {
  agent: AgentRow;
  assessment: TrimmedAssessment;
  check: CheckResult;
  reviews: ReviewRow[];
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
      next: { revalidate },
      headers: { accept: "application/json" },
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
