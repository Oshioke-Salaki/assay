import type { Assessment, Rating } from "./types.js";

export type Verdict = "pass" | "caution" | "block";

export interface CheckResult {
  address: Assessment["address"];
  verdict: Verdict;
  rating: Rating;
  score: number | null;
  organicShare: number | null;
  reasons: string[];
}

const BLOCK_RATINGS: ReadonlySet<Rating> = new Set(["D", "CCC"]);
const CAUTION_RATINGS: ReadonlySet<Rating> = new Set(["B", "BB", "NR"]);

/**
 * What an agent should do before paying this address.
 *  - block:   rated D/CCC, or most revenue is circular or self-funded.
 *  - caution: not rated yet (thin file), rated B/BB, or carries warnings.
 *  - pass:    BBB or better with no critical findings.
 * An address with no x402 history at all is "caution": unknown, not bad.
 */
export function verdictFor(a: Assessment): CheckResult {
  const organicShare = a.seller.grossUsd > 0 ? a.seller.organicUsd / a.seller.grossUsd : null;
  const critical = a.flags.filter((f) => f.severity === "critical");
  const warnings = a.flags.filter((f) => f.severity === "warning");
  const reasons: string[] = [];
  let verdict: Verdict;

  if (BLOCK_RATINGS.has(a.rating) || (critical.length > 0 && (organicShare ?? 1) < 0.5)) {
    verdict = "block";
    reasons.push(...critical.map((f) => f.title));
    if (BLOCK_RATINGS.has(a.rating)) reasons.push(`Rated ${a.rating}`);
  } else if (CAUTION_RATINGS.has(a.rating) || critical.length > 0 || warnings.length > 0) {
    verdict = "caution";
    if (a.role === "none" || a.role === "buyer") reasons.push("No x402 revenue on record");
    else if (a.rating === "NR") reasons.push("Thin file: not enough history to rate");
    else if (CAUTION_RATINGS.has(a.rating)) reasons.push(`Rated ${a.rating}`);
    reasons.push(...critical.map((f) => f.title), ...warnings.map((f) => f.title));
  } else {
    verdict = "pass";
    reasons.push(`Rated ${a.rating}`);
  }
  return {
    address: a.address,
    verdict,
    rating: a.rating,
    score: a.score,
    organicShare,
    reasons: [...new Set(reasons)],
  };
}
