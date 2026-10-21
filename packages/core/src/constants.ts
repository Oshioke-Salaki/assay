import type { Address } from "./types.js";

export const CELO_CHAIN_ID = 42220;
export const CAIP2_CELO = "eip155:42220";

/** First block Assay indexes. Precedes the ERC-8004 registries (58,396,724) and every x402 facilitator on Celo. */
export const INDEX_START_BLOCK = 58_000_000;

export type FiatCode = "USD" | "ARS" | "BRL" | "COP" | "MXN" | "PEN" | "CLP";

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  /** Fiat the token is pegged 1:1 to. */
  fiat: FiatCode;
  /** How x402 moves this token on Celo. */
  transfer: "eip3009" | "permit2";
}

/** Every asset the Celo x402 facilitator settles (https://api.x402.celo.org/supported). Lower-cased addresses. */
export const TOKENS: readonly TokenInfo[] = [
  {
    address: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
    symbol: "USDC",
    decimals: 6,
    fiat: "USD",
    transfer: "eip3009",
  },
  {
    address: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
    symbol: "USDT",
    decimals: 6,
    fiat: "USD",
    transfer: "eip3009",
  },
  {
    address: "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
    symbol: "USAT",
    decimals: 6,
    fiat: "USD",
    transfer: "eip3009",
  },
  {
    address: "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d",
    symbol: "wARS",
    decimals: 18,
    fiat: "ARS",
    transfer: "permit2",
  },
  {
    address: "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0",
    symbol: "wBRL",
    decimals: 18,
    fiat: "BRL",
    transfer: "permit2",
  },
  {
    address: "0x8a1d45e102e886510e891d2ec656a708991e2d76",
    symbol: "wCOP",
    decimals: 18,
    fiat: "COP",
    transfer: "permit2",
  },
];

const TOKEN_BY_ADDRESS = new Map(TOKENS.map((t) => [t.address, t]));

export function tokenByAddress(address: string): TokenInfo | undefined {
  return TOKEN_BY_ADDRESS.get(address.toLowerCase() as Address);
}

export const EIP3009_TOKENS = TOKENS.filter((t) => t.transfer === "eip3009").map((t) => t.address);

/** Self's Celo Agent Visa: a soulbound tier per Self agent id (0 none, 1 Tourist, 2 Work, 3 Citizenship). */
export const CELO_AGENT_VISA: Address = "0xca97f7586cf9de62b8ca516d7ee25f6aeae5e109";
export const VISA_TIERS = ["none", "Tourist visa", "Work visa", "Citizenship"] as const;

/** x402's Permit2 proxy. wFIAT settlements are calls to this contract. */
export const X402_PERMIT2_PROXY: Address = "0x402085c248eea27d92e8b30b2c58ed07f9e20001";

export interface Facilitator {
  address: Address;
  name: string;
  url?: string;
}

/** Relayers known to settle x402 payments. EIP-3009 transfers relayed by anyone else are kept but not scored. */
export const KNOWN_FACILITATORS: readonly Facilitator[] = [
  {
    address: "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48",
    name: "Celo x402 facilitator",
    url: "https://x402.celo.org",
  },
];

export const ERC8004_IDENTITY_REGISTRY: Address = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
export const ERC8004_REPUTATION_REGISTRY: Address = "0x8004baa17c55a88189ae136b182e5fda19de9b63";
export const SELF_AGENT_REGISTRY: Address = "0xac3df9abf80d0f5c020c06b04cced27763355944";
export const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";

/** keccak256 topics. */
export const TOPICS = {
  erc20Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  authorizationUsed: "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5",
} as const;

export const EXPLORER = "https://celoscan.io";
