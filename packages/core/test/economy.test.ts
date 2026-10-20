import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { summarizeEconomy } from "../src/economy.js";
import { Ledger } from "../src/ledger.js";
import { addr, ctx, flow, lastDays } from "./helpers.js";

describe("summarizeEconomy", () => {
  const ring = ["e0", "e1", "e2"].map(addr);
  const shop = addr("e-shop");
  const flows = [
    ...ring.map((a, i) => flow(a, ring[(i + 1) % 3]!, 100, { count: 30 })),
    ...Array.from({ length: 6 }, (_, i) => flow(addr(`e-cust-${i}`), shop, 5, { days: lastDays(7) })),
  ];
  const ledger = new Ledger(flows);
  const summary = summarizeEconomy(ledger, ctx());

  it("separates organic from circular volume", () => {
    expect(summary.grossUsd).toBe(330);
    expect(summary.organicUsd).toBe(30);
    expect(summary.loopOffsetUsd).toBe(300);
    expect(summary.loops).toBe(1);
    expect(summary.largestLoop).toBe(3);
    expect(summary.sellers).toBe(4);
  });

  it("ranks by organic revenue and agrees with per-address assessments", () => {
    expect(summary.sellersRanked[0]?.address).toBe(shop);
    const direct = assess(ledger, shop, ctx());
    expect(summary.sellersRanked[0]?.organicUsd).toBe(direct.seller.organicUsd);
    const counted = Object.values(summary.ratingCounts).reduce((a, b) => a + b, 0);
    expect(counted).toBe(summary.sellers);
  });

  it("counts payers once even when they pay several sellers", () => {
    const p = addr("multi");
    const s = summarizeEconomy(new Ledger([flow(p, addr("s1"), 1), flow(p, addr("s2"), 1)]), ctx());
    expect(s.payers).toBe(1);
    expect(s.organicPayers).toBe(1);
  });
});
