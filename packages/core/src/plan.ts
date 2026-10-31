import { RATING_FLOORS, ratingFor, scoreFrom, THIN_FILE } from "./assess.js";
import type { Assessment, Rating, ScoreComponents } from "./types.js";

/**
 * What would raise this rating. Every number here comes from running the real score formula
 * on a changed input, so the plan is as right as the score. There is one honest lever,
 * independent customers; the rest (time, activity, identity) are small and say so.
 */
export interface Lever {
  code: "customers" | "time" | "activity" | "identity";
  title: string;
  detail: string;
  scoreAfter: number;
  ratingAfter: Rating;
  gain: number;
}

export interface RatingPlan {
  applicable: boolean;
  reason?: string;
  rating: Rating;
  score: number | null;
  /** The next rating up, how many points away. Null at AAA. */
  next: { rating: Rating; floor: number; pointsAway: number } | null;
  /** What a thin file still needs before any rating is issued. Null when rated. */
  thin: {
    payersNeeded: number;
    settlementsNeeded: number;
    grossNeeded: number;
    ratingWhenRated: Rating;
  } | null;
  /** The customer lever in detail: the size of a typical customer and how many reach each rating. */
  customers: {
    typicalUsd: number;
    forNext: number | null;
    byCount: { count: number; score: number; rating: Rating }[];
  } | null;
  levers: Lever[];
  /** Revenue that is struck out and stays struck out; only new organic revenue dilutes it. */
  struckOut: { fundedUsd: number; loopUsd: number; organicUsd: number; organicNeededForHalf: number } | null;
  /** What would lower the rating from here. */
  keep: string[];
  note: string;
}

const NOTE =
  "Only independent customers count. Payers this wallet funded, or that share its funder, are struck out before anything is scored, so the only way up is real revenue from wallets it does not control.";

function identityBonusFor(a: Assessment, quality: number): number {
  if (quality < 0.5) return 0;
  const human = a.identity.human;
  return (a.identity.agentIds.length > 0 ? 3 : 0) + (human?.fresh ? 5 : human ? 2 : 0);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const usd = (n: number) =>
  n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;

/**
 * The payer index after k new independent customers paying `typical` each, added to the same
 * weights the score used: (W + k·t)² / (D + k·t²), where W is the discounted organic dollars and
 * D = W² / E is recovered from the current index. An assessment from before 2026.10-4 has no W;
 * its undiscounted organic revenue stands in.
 */
export function effectivePayersWith(c: ScoreComponents, k: number, typical: number, organicUsd = 0): number {
  const E = c.effectivePayers;
  const W = c.payerWeightUsd ?? organicUsd;
  if (!(W > 0 && E > 0)) return k;
  return (W + k * typical) ** 2 / (W ** 2 / E + k * typical ** 2);
}

export function ratingPlan(a: Assessment): RatingPlan {
  const c = a.components;
  const s = a.seller;
  if (!c || !(s.grossUsd > 0) || a.score === null) {
    return {
      applicable: false,
      reason:
        "This address has no x402 revenue yet, so there is no rating to raise. Its first paid settlement starts the file.",
      rating: a.rating,
      score: null,
      next: null,
      thin: null,
      customers: null,
      levers: [],
      struckOut: null,
      keep: [],
      note: NOTE,
    };
  }
  const score = a.score;
  const base = {
    quality: c.quality,
    effectivePayers: c.effectivePayers,
    activeDays: c.activeDays,
    identityBonus: c.identityBonus,
    dormancyFactor: c.dormancyFactor,
  };
  const nextFloor = [...RATING_FLOORS].reverse().find(([, floor]) => floor > score) ?? null;
  const next = nextFloor
    ? { rating: nextFloor[0], floor: nextFloor[1], pointsAway: nextFloor[1] - score }
    : null;

  const thin =
    a.rating === "NR"
      ? {
          payersNeeded: Math.max(0, THIN_FILE.minPayers - s.payers),
          settlementsNeeded: Math.max(0, THIN_FILE.minSettlements - s.settlements),
          grossNeeded: Math.max(0, THIN_FILE.minGrossUsd - s.grossUsd),
          ratingWhenRated: ratingFor(score),
        }
      : null;

  const levers: Lever[] = [];
  const lever = (code: Lever["code"], title: string, detail: string, r: { score: number }) => {
    const ratingAfter = ratingFor(r.score);
    levers.push({ code, title, detail, scoreAfter: r.score, ratingAfter, gain: r.score - score });
  };

  // Customers: each new one pays what a typical organic customer pays today.
  const credited = s.payerLines.filter((l) => l.creditedUsd > 0).map((l) => l.creditedUsd);
  const typical = Math.max(0.01, median(credited.length > 0 ? credited : s.payerLines.map((l) => l.usd)));
  const T = s.organicUsd;
  const simulate = (k: number) => {
    const added = k * typical;
    const organic = T + added;
    const gross = s.grossUsd + added;
    const quality = Math.min(1, organic / gross);
    const effectivePayers = effectivePayersWith(c, k, typical, T);
    return scoreFrom({
      quality,
      effectivePayers,
      activeDays: c.activeDays,
      identityBonus: identityBonusFor(a, quality),
      // A customer paying now ends any dormancy.
      dormancyFactor: 1,
    });
  };
  const byCount: { count: number; score: number; rating: Rating }[] = [];
  let forNext: number | null = null;
  for (let k = 1; k <= 100; k++) {
    const r = simulate(k);
    const rating = ratingFor(r.score);
    if ([1, 3, 5, 10, 25, 50, 100].includes(k)) byCount.push({ count: k, score: r.score, rating });
    if (forNext === null && next && r.score >= next.floor) forNext = k;
  }
  const customers = { typicalUsd: typical, forNext, byCount };
  if (next) {
    const k = forNext ?? 100;
    const r = simulate(k);
    lever(
      "customers",
      forNext === null
        ? "More than 100 new customers"
        : `${forNext} more independent customer${forNext === 1 ? "" : "s"}`,
      forNext === null
        ? `Even 100 new customers at ${usd(typical)} each would not reach ${next.rating} from here; the struck-out revenue below is why.`
        : `New wallets you do not control, each paying about ${usd(typical)} (what a typical customer pays you now). This is the lever that moves the rating.`,
      r,
    );
  }

  // Time: more days with organic payments.
  if (c.track < 0.95) {
    for (const days of [10, 30]) {
      const r = scoreFrom({ ...base, activeDays: c.activeDays + days, dormancyFactor: 1 });
      if (r.score > score)
        lever(
          "time",
          `${days} more days with a paid, independent customer`,
          `Track record saturates around 25 active days; you have ${c.activeDays}. Days only count when an independent customer pays on them.`,
          r,
        );
    }
  }

  // Activity: dormancy.
  if (c.dormancyFactor < 1) {
    const r = scoreFrom({ ...base, dormancyFactor: 1 });
    lever(
      "activity",
      "One organic payment this week",
      `No independent customer has paid in over ${c.dormancyFactor === 0.6 ? "90" : "30"} days, which cuts the score by ${c.dormancyFactor === 0.6 ? "40" : "15"}%. One payment from a wallet you do not control removes that.`,
      r,
    );
  }

  // Identity: only on a clean record.
  if (c.quality >= 0.5) {
    const human = a.identity.human;
    if (a.identity.agentIds.length === 0 && !human)
      lever(
        "identity",
        "Register an ERC-8004 identity and add a Self proof",
        "Together worth 8 points on a record that is at least half organic: 3 for the registration, 5 for a fresh passport proof.",
        scoreFrom({ ...base, identityBonus: c.identityBonus + 8 }),
      );
    if (a.identity.agentIds.length === 0)
      lever(
        "identity",
        "Register an ERC-8004 identity from this wallet",
        "Worth 3 points on a record that is at least half organic. If this address is a contract, list it in your agent's registration file instead (a service whose endpoint is eip155:42220:<this address>); it counts when the contract's owner() is the agent's owner or wallet.",
        scoreFrom({ ...base, identityBonus: c.identityBonus + 3 }),
      );
    if (!human)
      lever(
        "identity",
        "Add a Self Agent ID human proof",
        "A fresh passport proof is worth 5 points. It also collapses sock wallets that share one human, so it is the identity check Assay trusts most.",
        scoreFrom({ ...base, identityBonus: c.identityBonus + 5 }),
      );
    else if (!human.fresh)
      lever(
        "identity",
        "Refresh the Self proof",
        "An expired proof is worth 2 points; a fresh one is worth 5.",
        scoreFrom({ ...base, identityBonus: c.identityBonus + 3 }),
      );
  }

  const struck = s.fundedUsd + s.loopOffsetUsd;
  const struckOut =
    struck > 0
      ? {
          fundedUsd: s.fundedUsd,
          loopUsd: s.loopOffsetUsd,
          organicUsd: s.organicUsd,
          organicNeededForHalf: Math.max(0, struck - s.organicUsd),
        }
      : null;

  const keep: string[] = [];
  const topShare = T > 0 ? Math.max(0, ...s.payerLines.map((l) => l.creditedUsd)) / T : 0;
  if (topShare > 0.5)
    keep.push(
      `${Math.round(topShare * 100)}% of organic revenue comes from one customer. If it leaves, independent payers fall with it.`,
    );
  if (c.dormancyFactor === 1)
    keep.push("No organic payment for 30 days cuts the score by 15%; for 90 days, by 40%.");
  if (c.quality >= 0.5 && c.quality < 0.6)
    keep.push("Organic share is just over half. Any struck-out revenue would take the identity bonus away.");

  // The customer lever leads, because it is the one that moves ratings; the rest by gain.
  levers.sort((x, y) => Number(y.code === "customers") - Number(x.code === "customers") || y.gain - x.gain);
  // Only levers that change something are worth showing.
  const shown = levers.filter((l) => l.gain > 0 || l.code === "customers");

  return {
    applicable: true,
    rating: a.rating,
    score,
    next,
    thin,
    customers,
    levers: shown,
    struckOut,
    keep,
    note: NOTE,
  };
}
