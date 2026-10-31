import type { Address, Assessment, PayerLine } from "./types.js";

/**
 * A payer check, for sellers: before a refund, an allowance or credit, is this wallet a real,
 * established customer or a sock? Built from the payer's own record (age, funding, how many
 * sellers it pays, loop share, identity) and, when a seller is named, from how it stands to
 * that seller. Plain words, four verdicts.
 */
export type PayerVerdict = "established" | "new" | "caution" | "block";

export interface PayerCheck {
  address: Address;
  verdict: PayerVerdict;
  reasons: string[];
  /** Days since the wallet's first transaction on Celo; null when its funding is not traced yet. */
  ageDays: number | null;
  firstSeenAt: number | null;
  funder: { address: Address; public: boolean } | null;
  spentUsd: number;
  settlements: number;
  sellers: number;
  firstTs: number | null;
  lastTs: number | null;
  /** Share of its spending that goes round a payment loop, 0..1. */
  loopShare: number;
  identity: { agentIds: string[]; human: boolean; humanFresh: boolean };
  /** How it stands to the seller that asked, when one was named. */
  withSeller: null | {
    seller: Address;
    paidUsd: number;
    count: number;
    firstTs: number | null;
    lastTs: number | null;
    class: PayerLine["class"] | "none";
  };
}

const DAY = 86_400;

export function payerCheck(
  a: Assessment,
  opts: { now?: number; seller?: Address; sellerLine?: PayerLine | null } = {},
): PayerCheck {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const b = a.buyer;
  const f = a.identity.funding;
  const firstSeenAt = f?.firstSeenAt ?? null;
  const ageDays = firstSeenAt === null ? null : Math.max(0, Math.floor((now - firstSeenAt) / DAY));
  const loopShare = b.spentUsd > 0 ? Math.min(1, b.loopSpendUsd / b.spentUsd) : 0;
  const human = a.identity.human;
  const reasons: string[] = [];
  let block = false;
  let caution = false;

  // How it stands to the seller asking.
  const line = opts.sellerLine ?? null;
  const withSeller =
    opts.seller !== undefined
      ? {
          seller: opts.seller,
          paidUsd: line?.usd ?? 0,
          count: line?.count ?? 0,
          firstTs: line?.firstTs ?? null,
          lastTs: line?.lastTs ?? null,
          class: line ? line.class : ("none" as const),
        }
      : null;
  if (line) {
    if (line.class === "seller-funded") {
      block = true;
      reasons.push(
        "First funded by you, so its payments to you count as self-funded and are struck out of your rating.",
      );
    } else if (line.class === "shared-funder") {
      caution = true;
      reasons.push(
        "Funded by the same private wallet as you, so its payments to you are struck out of your rating.",
      );
    } else if (line.class === "loop" || line.inLoop) {
      block = true;
      reasons.push("In a payment loop with you: money it pays you comes back round.");
    } else {
      reasons.push(
        `Has paid you ${line.count === 1 ? "once" : `${line.count.toLocaleString("en-US")} times`}, and those payments count as organic.`,
      );
    }
  } else if (opts.seller !== undefined) reasons.push("Has never paid you.");

  // Its own record.
  if (b.spentUsd <= 0) reasons.push("No x402 payments on record anywhere on Celo.");
  else {
    if (loopShare >= 0.5) {
      block = true;
      reasons.push(`${Math.round(loopShare * 100)}% of what it spends goes round a payment loop.`);
    } else if (loopShare > 0) {
      caution = true;
      reasons.push(`${Math.round(loopShare * 100)}% of what it spends goes round a payment loop.`);
    }
    reasons.push(
      `Has paid ${b.sellers === 1 ? "one seller" : `${b.sellers.toLocaleString("en-US")} sellers`} over x402, ${b.settlements.toLocaleString("en-US")} payment${b.settlements === 1 ? "" : "s"} in all.`,
    );
  }
  // A seller it pays is an x402 participant, so however its profile reads it is not a public source.
  if (f?.funder && b.counterparties.some((c) => c.payee === f.funder)) {
    caution = true;
    reasons.push("Was first funded by a seller it pays, which is how sock wallets are made.");
  }
  if (ageDays === null) reasons.push("Its funding has not been traced yet, so its age on Celo is unknown.");
  else if (ageDays < 7)
    reasons.push(
      `First seen on Celo ${ageDays === 0 ? "today" : `${ageDays} day${ageDays === 1 ? "" : "s"} ago`}.`,
    );
  else reasons.push(`On Celo for ${ageDays.toLocaleString("en-US")} days.`);
  if (human?.fresh) reasons.push("Backed by a verified human (Self Agent ID).");
  if (a.identity.agentIds.length > 0) reasons.push(`Registered ERC-8004 agent #${a.identity.agentIds[0]}.`);

  const established =
    !block &&
    !caution &&
    ageDays !== null &&
    ageDays >= 30 &&
    (b.sellers >= 3 || b.settlements >= 10 || human?.fresh === true);
  const verdict: PayerVerdict = block ? "block" : caution ? "caution" : established ? "established" : "new";

  return {
    address: a.address,
    verdict,
    reasons,
    ageDays,
    firstSeenAt,
    funder: f?.funder ? { address: f.funder, public: f.funderIsPublic } : null,
    spentUsd: b.spentUsd,
    settlements: b.settlements,
    sellers: b.sellers,
    firstTs: b.firstTs,
    lastTs: b.lastTs,
    loopShare,
    identity: { agentIds: a.identity.agentIds, human: human !== null, humanFresh: human?.fresh === true },
    withSeller,
  };
}
