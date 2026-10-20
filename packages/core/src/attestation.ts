import { CELO_CHAIN_ID } from "./constants.js";
import type { Address, Rating } from "./types.js";

/**
 * Signed score format. AssayRegistry (contracts/src/AssayRegistry.sol) verifies the
 * same EIP-712 struct, so any Celo contract can gate on a fresh Assay score.
 */
export const ATTESTATION_TYPES = {
  Score: [
    { name: "subject", type: "address" },
    { name: "score", type: "uint8" },
    { name: "rating", type: "uint8" },
    { name: "organicUsdMicros", type: "uint64" },
    { name: "grossUsdMicros", type: "uint64" },
    { name: "effectivePayersX100", type: "uint32" },
    { name: "asOfBlock", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface ScoreAttestation {
  subject: Address;
  score: number;
  rating: number;
  organicUsdMicros: bigint;
  grossUsdMicros: bigint;
  effectivePayersX100: number;
  asOfBlock: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
}

/** Onchain rating codes: higher is better, 5 (BBB) and up is "investment grade". 0 is not rated. */
export const RATING_CODES: Record<Rating, number> = {
  NR: 0,
  D: 1,
  CCC: 2,
  B: 3,
  BB: 4,
  BBB: 5,
  A: 6,
  AA: 7,
  AAA: 8,
};

export const INVESTMENT_GRADE_CODE = RATING_CODES.BBB;

export function ratingFromCode(code: number): Rating {
  const found = (Object.entries(RATING_CODES) as [Rating, number][]).find(([, c]) => c === code);
  return found ? found[0] : "NR";
}

export function attestationDomain(verifyingContract: Address) {
  return { name: "Assay", version: "1", chainId: CELO_CHAIN_ID, verifyingContract } as const;
}

/** Attestations are valid for 7 days. */
export const ATTESTATION_TTL_SECONDS = 7 * 86_400;

export function toMicros(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  const micros = BigInt(Math.round(usd * 1e6));
  const max = 2n ** 64n - 1n;
  return micros > max ? max : micros;
}
