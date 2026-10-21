import type { Address, Assessment, PayerLine } from "./types.js";

/**
 * The Agents on Open Rails hackathon's own definition of an independent user: a wallet that is
 * not the project's, was not first funded by the project or the project's own funder, and had
 * its own activity on Celo before the hackathon started. Assay already traces all three, so any
 * seller can see which of its payers count, by the rule the organisers published.
 */
export const HACKATHON_WINDOW = {
  /** 6 Oct 2026, 12:00 UTC */
  start: Date.UTC(2026, 9, 6, 12) / 1000,
  /** 9 Nov 2026, 09:00 UTC */
  end: Date.UTC(2026, 10, 9, 9) / 1000,
} as const;

export const INDEPENDENCE_RULE =
  "A payer counts as independent when it is not the seller or a member of the seller's payment loop, was not first funded by the seller or by the seller's own funder, and had activity on Celo before the window started.";

export interface IndependenceRow {
  payer: Address;
  /** true: counts; false: does not; null: its funding has not been traced yet, so Assay cannot say. */
  independent: boolean | null;
  reasons: string[];
  usd: number;
  count: number;
  firstPaymentTs: number;
  firstSeenAt: number | null;
  class: PayerLine["class"];
  funder: Address | null;
}

export function judgePayer(line: PayerLine, windowStart: number): IndependenceRow {
  const reasons: string[] = [];
  if (line.inLoop || line.class === "loop") reasons.push("in the seller's payment loop");
  if (line.class === "seller-funded") reasons.push("first funded by the seller");
  if (line.class === "shared-funder") reasons.push("funded by the seller's own funder");
  let independent: boolean | null;
  if (!line.traced) {
    independent = reasons.length > 0 ? false : null;
    if (reasons.length === 0) reasons.push("funding not traced yet");
  } else if (line.firstSeenAt === null || line.firstSeenAt >= windowStart) {
    reasons.push("no activity on Celo before the window started");
    independent = false;
  } else independent = reasons.length === 0;
  return {
    payer: line.payer,
    independent,
    reasons,
    usd: line.usd,
    count: line.count,
    firstPaymentTs: line.firstTs,
    firstSeenAt: line.firstSeenAt,
    class: line.class,
    funder: line.funder,
  };
}

export function independentPayers(a: Assessment, windowStart = HACKATHON_WINDOW.start) {
  const rows = a.seller.payerLines.map((l) => judgePayer(l, windowStart));
  rows.sort((x, y) => Number(y.independent === true) - Number(x.independent === true) || y.usd - x.usd);
  return {
    rows,
    totals: {
      payers: rows.length,
      independent: rows.filter((r) => r.independent === true).length,
      notIndependent: rows.filter((r) => r.independent === false).length,
      unknown: rows.filter((r) => r.independent === null).length,
      independentUsd: rows.filter((r) => r.independent === true).reduce((n, r) => n + r.usd, 0),
    },
  };
}
