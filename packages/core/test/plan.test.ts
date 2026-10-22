import { describe, expect, it } from "vitest";
import { assess, THIN_FILE } from "../src/assess.js";
import { Ledger } from "../src/ledger.js";
import { ratingPlan } from "../src/plan.js";
import { addr, ctx, flow, lastDays } from "./helpers.js";

function payers(seller: `0x${string}`, n: number, usdEach: number, days = 20) {
  return Array.from({ length: n }, (_, i) =>
    flow(addr(`p-${seller}-${i}`), seller, usdEach, {
      days: lastDays(days).filter((_, d) => d % 2 === i % 2),
    }),
  );
}

describe("ratingPlan", () => {
  it("says there is nothing to raise for an address with no revenue", () => {
    const seller = addr("nobody");
    const p = ratingPlan(
      assess(new Ledger([flow(seller, addr("x"), 3, { days: lastDays(2) })]), seller, ctx()),
    );
    expect(p.applicable).toBe(false);
    expect(p.reason).toMatch(/no x402 revenue/);
    expect(p.levers).toEqual([]);
  });

  it("tells a thin file exactly what it still needs, and what it would rate once rated", () => {
    const seller = addr("thin");
    const a = assess(
      new Ledger([flow(addr("one"), seller, 3, { count: 2, days: lastDays(2) })]),
      seller,
      ctx(),
    );
    const p = ratingPlan(a);
    expect(a.rating).toBe("NR");
    expect(p.thin).toEqual({
      payersNeeded: THIN_FILE.minPayers - 1,
      settlementsNeeded: THIN_FILE.minSettlements - 2,
      grossNeeded: 0,
      ratingWhenRated: expect.any(String),
    });
  });

  it("puts independent customers first and finds how many reach the next rating", () => {
    const seller = addr("small");
    const a = assess(new Ledger(payers(seller, 3, 5, 12)), seller, ctx());
    const p = ratingPlan(a);
    expect(p.applicable).toBe(true);
    expect(p.next).not.toBeNull();
    expect(p.customers?.typicalUsd).toBe(5);
    expect(p.customers?.forNext).toBeGreaterThan(0);
    // Each count scores at least as well as the last: more customers never hurt.
    const scores = p.customers!.byCount.map((b) => b.score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]!);
    expect(p.levers[0]?.code).toBe("customers");
    expect(p.levers[0]?.ratingAfter).toBe(p.next?.rating);
    expect(p.levers[0]?.scoreAfter).toBeGreaterThanOrEqual(p.next!.floor);
    expect(p.note).toMatch(/Only independent customers count/);
  });

  it("offers identity points only on a record that is at least half organic", () => {
    const clean = addr("clean");
    const pc = ratingPlan(assess(new Ledger(payers(clean, 8, 4, 30)), clean, ctx()));
    expect(pc.levers.some((l) => l.code === "identity" && /ERC-8004/.test(l.title))).toBe(true);
    expect(pc.levers.some((l) => l.code === "identity" && /Self/.test(l.title))).toBe(true);

    const dirty = addr("dirty");
    const socks = Array.from({ length: 6 }, (_, i) => addr(`sock-${i}`));
    const flows = [
      ...socks.map((s) => flow(s, dirty, 20, { days: lastDays(10) })),
      ...payers(dirty, 2, 2, 10),
    ];
    const a = assess(new Ledger(flows), dirty, ctx({ funding: socks.map((s) => [s, { funder: dirty }]) }));
    const pd = ratingPlan(a);
    expect(a.components!.quality).toBeLessThan(0.5);
    expect(pd.levers.some((l) => l.code === "identity")).toBe(false);
    expect(pd.struckOut).toMatchObject({ fundedUsd: 120, organicUsd: 4 });
    expect(pd.struckOut?.organicNeededForHalf).toBe(116);
  });

  it("names dormancy as a lever when the last organic payment is old", () => {
    const seller = addr("dormant");
    const old = Array.from({ length: 4 }, (_, i) =>
      flow(addr(`old-${i}`), seller, 5, { count: 3, days: lastDays(200).slice(0, 20) }),
    );
    const a = assess(new Ledger(old), seller, ctx());
    expect(a.components!.dormancyFactor).toBeLessThan(1);
    const p = ratingPlan(a);
    const lever = p.levers.find((l) => l.code === "activity");
    expect(lever).toBeDefined();
    expect(lever!.gain).toBeGreaterThan(0);
  });

  it("at the top, says what would lower it instead of what would raise it", () => {
    const seller = addr("top");
    const a = assess(new Ledger(payers(seller, 30, 4, 40)), seller, ctx());
    const p = ratingPlan(a);
    if (a.rating === "AAA") {
      expect(p.next).toBeNull();
      expect(p.levers.some((l) => l.code === "customers")).toBe(false);
    }
    expect(p.keep.some((k) => /30 days/.test(k))).toBe(true);
  });
});
