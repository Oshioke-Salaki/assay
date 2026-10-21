export type Address = `0x${string}`;
export type Hash = `0x${string}`;

/** One x402 payment, read from a facilitator's settlement transaction. */
export interface Settlement {
  txHash: Hash;
  logIndex: number;
  block: number;
  /** Unix seconds. */
  ts: number;
  relayer: Address;
  token: Address;
  payer: Address;
  payee: Address;
  /** Raw token units, decimal string. */
  amount: string;
  usd: number;
}

/** Everything one payer has paid one payee, aggregated. */
export interface PairFlow {
  payer: Address;
  payee: Address;
  count: number;
  usd: number;
  firstTs: number;
  lastTs: number;
  /** Distinct UTC day numbers (floor(ts / 86400)) with at least one payment. */
  days: number[];
  /** Up to a few settlement tx hashes, newest first, for evidence links. */
  sampleTxs: Hash[];
}

/** Where an address's first money came from. */
export interface FundingInfo {
  /** First address to send this one CELO or a stablecoin. Null when never funded or unknown. */
  funder: Address | null;
  fundedAt: number | null;
  /** First transaction of any kind touching the address. */
  firstSeenAt: number | null;
  /** The funder is an exchange, bridge, faucet or other high-volume source, so sharing it says nothing. */
  funderIsPublic: boolean;
}

/** Self Agent ID binding for an address. */
export interface HumanInfo {
  agentId: string;
  /** Opaque per-human nullifier: equal nullifiers mean the same human. */
  nullifier: string;
  fresh: boolean;
  /** Celo Agent Visa tier: 0 none, 1 Tourist, 2 Work, 3 Citizenship. Shown, never scored. */
  visaTier?: number;
}

export interface AssessmentContext {
  funding: ReadonlyMap<Address, FundingInfo>;
  humans: ReadonlyMap<Address, HumanInfo>;
  /** ERC-8004 agent ids that this address owns or is the wallet of. */
  agentIds: ReadonlyMap<Address, readonly string[]>;
  /** Unix seconds the assessment is made at. */
  now: number;
}

export type Rating = "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "CCC" | "D" | "NR";

export type FlagSeverity = "critical" | "warning" | "info" | "positive";

export type FlagCode =
  | "CIRCULAR_FLOW"
  | "SELLER_FUNDED_PAYERS"
  | "SHARED_FUNDER"
  | "SAME_HUMAN_PAYERS"
  | "CONCENTRATED_REVENUE"
  | "SINGLE_PURPOSE_PAYERS"
  | "DORMANT"
  | "THIN_FILE"
  | "HUMAN_BACKED"
  | "ERC8004_AGENT"
  | "ESTABLISHED_PAYERS"
  | "PARTIAL_FUNDING_DATA";

export interface Flag {
  code: FlagCode;
  severity: FlagSeverity;
  title: string;
  detail: string;
  /** USD affected by this flag, when it has a money effect. */
  usd?: number;
  /** Addresses and transactions a reader can check on an explorer. */
  addresses?: Address[];
  txs?: Hash[];
}

export type PayerClass = "organic" | "loop" | "seller-funded" | "shared-funder";

export interface PayerLine {
  payer: Address;
  usd: number;
  creditedUsd: number;
  count: number;
  firstTs: number;
  lastTs: number;
  class: PayerClass;
  /** Payer is in a payment loop with the seller (same strongly connected component). */
  inLoop: boolean;
  funder: Address | null;
  human: boolean;
  established: boolean;
  /** First transaction of any kind touching the payer, when its funding has been traced. */
  firstSeenAt: number | null;
  /** The funding trace for this payer has run (even if it found no funder). */
  traced: boolean;
  sampleTxs: Hash[];
}

export interface CounterpartyLine {
  payee: Address;
  usd: number;
  count: number;
  lastTs: number;
  inLoop: boolean;
}

export interface ScoreComponents {
  /** Organic revenue / gross revenue, 0..1. */
  quality: number;
  /** Effective number of independent payers (inverse Herfindahl over payer groups). */
  effectivePayers: number;
  diversity: number;
  activeDays: number;
  track: number;
  identityBonus: number;
  dormancyFactor: number;
}

export interface SellerSide {
  grossUsd: number;
  organicUsd: number;
  loopOffsetUsd: number;
  fundedUsd: number;
  settlements: number;
  payers: number;
  organicPayers: number;
  firstTs: number | null;
  lastTs: number | null;
  payerLines: PayerLine[];
}

export interface BuyerSide {
  spentUsd: number;
  loopSpendUsd: number;
  settlements: number;
  sellers: number;
  firstTs: number | null;
  lastTs: number | null;
  counterparties: CounterpartyLine[];
}

export interface Assessment {
  address: Address;
  role: "seller" | "buyer" | "both" | "none";
  score: number | null;
  rating: Rating;
  components: ScoreComponents | null;
  seller: SellerSide;
  buyer: BuyerSide;
  loop: { size: number; members: Address[] } | null;
  flags: Flag[];
  identity: {
    agentIds: string[];
    human: HumanInfo | null;
    funding: FundingInfo | null;
  };
  /** Share of payers whose funding source is known, 0..1. */
  fundingCoverage: number;
  methodologyVersion: string;
}
