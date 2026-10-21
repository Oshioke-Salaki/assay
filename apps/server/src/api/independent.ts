import {
  type Assessment,
  dayOf,
  HACKATHON_WINDOW,
  INDEPENDENCE_RULE,
  independentPayers,
} from "assayscore-core";
import type { DB } from "../db.js";

/**
 * Which of a seller's payers count as independent users by the hackathon's published rule,
 * with each payer's volume inside the window. Free, so any team can check its own numbers.
 */
export function independentReport(
  db: DB,
  a: Assessment,
  opts: { from?: number; to?: number; limit?: number } = {},
) {
  const from = opts.from ?? HACKATHON_WINDOW.start;
  const to = opts.to ?? HACKATHON_WINDOW.end;
  const { rows, totals } = independentPayers(a, from);
  const inWindow = new Map<string, { usd: number; count: number }>();
  for (const r of db
    .prepare(
      "SELECT payer, SUM(usd) AS usd, SUM(count) AS count FROM pair_days WHERE payee = ? AND day BETWEEN ? AND ? GROUP BY payer",
    )
    .iterate(a.address, dayOf(from), dayOf(to)) as IterableIterator<{
    payer: string;
    usd: number;
    count: number;
  }>)
    inWindow.set(r.payer, { usd: r.usd, count: r.count });
  const withWindow = rows.map((r) => ({
    ...r,
    inWindow: inWindow.get(r.payer) ?? { usd: 0, count: 0 },
  }));
  const independentInWindow = withWindow.filter((r) => r.independent === true && r.inWindow.count > 0);
  return {
    address: a.address,
    rule: INDEPENDENCE_RULE,
    window: { from, to },
    totals: {
      ...totals,
      independentInWindow: independentInWindow.length,
      independentUsdInWindow: independentInWindow.reduce((n, r) => n + r.inWindow.usd, 0),
      usdInWindow: withWindow.reduce((n, r) => n + r.inWindow.usd, 0),
    },
    rows: withWindow.slice(0, opts.limit ?? 200),
  };
}
