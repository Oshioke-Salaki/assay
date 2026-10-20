import { assess } from "./assess.js";
import type { Ledger } from "./ledger.js";
import type { Address, AssessmentContext, Rating } from "./types.js";

export interface SellerSummary {
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

export interface EconomySummary {
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
  sellersRanked: SellerSummary[];
}

const EMPTY_RATINGS = (): Record<Rating, number> => ({
  AAA: 0,
  AA: 0,
  A: 0,
  BBB: 0,
  BB: 0,
  B: 0,
  CCC: 0,
  D: 0,
  NR: 0,
});

/** Assess every seller in the graph and roll the results up. Sellers are ranked by organic revenue. */
export function summarizeEconomy(ledger: Ledger, ctx: AssessmentContext): EconomySummary {
  const sellers: SellerSummary[] = [];
  const organicPayers = new Set<Address>();
  const allPayers = new Set<Address>();
  let grossUsd = 0;
  let organicUsd = 0;
  let loopOffsetUsd = 0;
  let fundedUsd = 0;
  let settlements = 0;
  const ratingCounts = EMPTY_RATINGS();

  for (const address of ledger.incoming.keys()) {
    const a = assess(ledger, address, ctx);
    grossUsd += a.seller.grossUsd;
    organicUsd += a.seller.organicUsd;
    loopOffsetUsd += a.seller.loopOffsetUsd;
    fundedUsd += a.seller.fundedUsd;
    settlements += a.seller.settlements;
    ratingCounts[a.rating]++;
    for (const l of a.seller.payerLines) {
      allPayers.add(l.payer);
      if (l.creditedUsd > 0) organicPayers.add(l.payer);
    }
    sellers.push({
      address,
      grossUsd: a.seller.grossUsd,
      organicUsd: a.seller.organicUsd,
      payers: a.seller.payers,
      organicPayers: a.seller.organicPayers,
      settlements: a.seller.settlements,
      score: a.score,
      rating: a.rating,
      lastTs: a.seller.lastTs,
      agentIds: a.identity.agentIds,
    });
  }

  sellers.sort((x, y) => y.organicUsd - x.organicUsd || y.grossUsd - x.grossUsd);
  const loops = ledger.loops();
  return {
    grossUsd,
    organicUsd,
    loopOffsetUsd,
    fundedUsd,
    settlements,
    sellers: sellers.length,
    payers: allPayers.size,
    organicPayers: organicPayers.size,
    loops: loops.length,
    addressesInLoops: loops.reduce((n, l) => n + l.length, 0),
    largestLoop: loops[0]?.length ?? 0,
    ratingCounts,
    sellersRanked: sellers,
  };
}
