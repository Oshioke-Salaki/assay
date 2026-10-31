import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { Ledger } from "../src/ledger.js";
import { effectivePayersWith } from "../src/plan.js";
import { addr, ctx, flow, lastDays } from "./helpers.js";

// Findings from the Savant.Chat audit of 30 Oct 2026, reproduced before they were fixed.

describe("single-purpose payers count half (audit 3.5)", () => {
  function sellerWith(singles: number, established: number, usd: { single?: number; est?: number } = {}) {
    const seller = addr(`hhi-seller-${singles}-${established}-${usd.single ?? 10}-${usd.est ?? 10}`);
    const flows = [
      ...Array.from({ length: singles }, (_, i) =>
        flow(addr(`hhi-s-${seller}-${i}`), seller, usd.single ?? 10, { days: lastDays(20) }),
      ),
      ...Array.from({ length: established }, (_, i) =>
        flow(addr(`hhi-e-${seller}-${i}`), seller, usd.est ?? 10, { days: lastDays(20) }),
      ),
    ];
    const firstPay = flows[0]!.firstTs;
    const funding = flows.slice(0, singles).map((f) => [f.payer, { firstSeenAt: firstPay - 600 }] as const);
    return { seller, a: assess(new Ledger(flows), seller, ctx({ funding })) };
  }

  it("counts n equal disposable wallets as n/2 payers, not n", () => {
    expect(sellerWith(12, 0).a.components?.effectivePayers).toBeCloseTo(6, 5);
    expect(sellerWith(1, 0).a.components?.effectivePayers).toBeCloseTo(0.5, 5);
  });

  it("never lets a disposable wallet that outspends a real customer raise diversity", () => {
    const both = sellerWith(1, 1, { single: 20, est: 10 }).a.components!.effectivePayers;
    // Without the discount this pair is (10+20)²/(10²+20²) = 1.8.
    expect(both).toBeLessThan(1.8);
    expect(both).toBeCloseTo((10 + 10) ** 2 / (10 * 10 + 10 * 20), 5);
  });

  it("leaves a seller with only established payers unchanged", () => {
    expect(sellerWith(0, 12).a.components?.effectivePayers).toBeCloseTo(12, 5);
  });

  it("plans new customers from the same weights the score used", () => {
    const { a } = sellerWith(6, 6);
    // W = 6·5 + 6·10 = 90 discounted dollars; D = Σ discounted × raw = 6·5·10 + 6·10·10 = 900.
    expect(a.components?.effectivePayers).toBeCloseTo(90 ** 2 / 900, 5);
    // One new $10 customer: (90 + 10)² / (900 + 10·10) = 10 effective payers.
    expect(effectivePayersWith(a.components!, 1, 10)).toBeCloseTo(10, 5);
    expect(effectivePayersWith(a.components!, 0, 10)).toBeCloseTo(9, 5);
  });
});

describe("an x402 participant is never a neutral public funder (audit 3.1)", () => {
  it("groups payers funded by a busy wallet that itself trades over x402", () => {
    const seller = addr("part-seller");
    const sidekick = addr("part-sidekick");
    const elsewhere = addr("part-elsewhere");
    const payers = Array.from({ length: 6 }, (_, i) => addr(`part-p-${i}`));
    const flows = [
      ...payers.map((p) => flow(p, seller, 10, { days: lastDays(20) })),
      // The funder buys something over x402 itself, so it is a participant, not an exchange.
      flow(sidekick, elsewhere, 1, { days: lastDays(2) }),
    ];
    const a = assess(
      new Ledger(flows),
      seller,
      ctx({ funding: payers.map((p) => [p, { funder: sidekick, funderIsPublic: true }] as const) }),
    );
    // Six wallets with one private funder are one actor.
    expect(a.components?.effectivePayers).toBeCloseTo(1, 5);
  });
});
