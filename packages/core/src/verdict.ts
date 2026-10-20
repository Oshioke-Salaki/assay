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

const PASS_RATINGS: ReadonlySet<Rating> = new Set(["BBB", "A", "AA", "AAA"]);

/**
 * What an agent should do before paying this address.
 *  - block:   most of its revenue is circular or self-funded (organic share under 50% with a
 *             critical finding, or under 20% outright).
 *  - caution: not proven yet. Thin file, a low score from a short or narrow history, or warnings.
 *  - pass:    BBB or better with no critical findings.
 * A low score alone never blocks: an honest seller with three customers is new, not fraudulent.
 * An address with no x402 history at all is "caution": unknown, not bad.
 */
export function verdictFor(a: Assessment): CheckResult {
  const organicShare = a.seller.grossUsd > 0 ? a.seller.organicUsd / a.seller.grossUsd : null;
  const critical = a.flags.filter((f) => f.severity === "critical");
  const warnings = a.flags.filter((f) => f.severity === "warning");
  const reasons: string[] = [];
  let verdict: Verdict;

  const dirty =
    organicShare !== null &&
    ((critical.length > 0 && organicShare < 0.5) || (organicShare < 0.2 && a.seller.settlements >= 5));

  if (dirty) {
    verdict = "block";
    reasons.push(...critical.map((f) => f.title));
    if (organicShare !== null && organicShare < 0.5)
      reasons.push(`Only ${Math.round(organicShare * 100)}% of revenue is organic`);
  } else if (a.rating === "NR" || !PASS_RATINGS.has(a.rating) || critical.length > 0 || warnings.length > 0) {
    verdict = "caution";
    if (a.role === "none" || a.role === "buyer") reasons.push("No x402 revenue on record");
    else if (a.rating === "NR") reasons.push("Thin file: not enough history to rate");
    else if (!PASS_RATINGS.has(a.rating))
      reasons.push(`Rated ${a.rating}: too little independent history yet`);
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
