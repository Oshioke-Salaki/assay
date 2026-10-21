import { describe, expect, it } from "vitest";
import { assess, ratingFor, scoreFrom, THIN_FILE } from "../src/assess.js";
import { Ledger } from "../src/ledger.js";
import type { Address } from "../src/types.js";
import { addr, ctx, DAY, flow, lastDays, NOW } from "./helpers.js";

function independentPayers(seller: Address, n: number, usdEach: number, days = 20) {
  return Array.from({ length: n }, (_, i) =>
    flow(addr(`indep-${seller}-${i}`), seller, usdEach, {
      days: lastDays(days).filter((_, d) => d % 2 === i % 2),
    }),
  );
}

describe("wash ring", () => {
  // Five wallets each pay the next one the same amount, the shape seen on Celo mainnet.
  const ring = ["r0", "r1", "r2", "r3", "r4"].map(addr);
  const flows = ring.map((a, i) =>
    flow(a, ring[(i + 1) % ring.length]!, 600, { count: 200, days: lastDays(3) }),
  );
  const ledger = new Ledger(flows);

  it("finds the loop", () => {
    expect(ledger.loops()).toHaveLength(1);
    expect(ledger.loops()[0]).toHaveLength(5);
  });

  it("counts none of the revenue as organic", () => {
    const a = assess(ledger, ring[0]!, ctx());
    expect(a.seller.grossUsd).toBe(600);
    expect(a.seller.organicUsd).toBe(0);
    expect(a.seller.loopOffsetUsd).toBe(600);
    expect(a.rating).toBe("NR"); // one payer: thin file even before the loop
    expect(a.score).toBe(0);
    expect(a.flags[0]?.code).toBe("CIRCULAR_FLOW");
    expect(a.flags[0]?.severity).toBe("critical");
    expect(a.loop?.size).toBe(5);
  });

  it("rates a wash ring D once it has enough payers to be rated", () => {
    // Fully connected ring: every member pays every other member.
    const members = ["w0", "w1", "w2", "w3"].map(addr);
    const all = members.flatMap((p) =>
      members.filter((q) => q !== p).map((q) => flow(p, q, 100, { count: 50, days: lastDays(5) })),
    );
    const a = assess(new Ledger(all), members[0]!, ctx());
    expect(a.seller.payers).toBe(3);
    expect(a.seller.organicUsd).toBeCloseTo(0, 9);
    expect(a.rating).toBe("D");
  });
});

describe("healthy seller", () => {
  const seller = addr("healthy");
  const ledger = new Ledger(independentPayers(seller, 25, 4, 30));

  it("earns a top rating", () => {
    const a = assess(ledger, seller, ctx());
    expect(a.seller.organicUsd).toBe(100);
    expect(a.components?.quality).toBe(1);
    expect(a.components?.effectivePayers).toBeCloseTo(25, 5);
    expect(a.score).toBeGreaterThanOrEqual(85);
    expect(["AAA", "AA"]).toContain(a.rating);
    expect(a.flags.find((f) => f.severity === "critical")).toBeUndefined();
  });

  it("gets an identity bonus for ERC-8004 and a fresh Self proof", () => {
    const plain = assess(ledger, seller, ctx());
    const verified = assess(
      ledger,
      seller,
      ctx({
        agentIds: [[seller, ["42"]]],
        humans: [[seller, { agentId: "7", nullifier: "n1", fresh: true }]],
      }),
    );
    expect(verified.score! - plain.score!).toBeLessThanOrEqual(8);
    expect(verified.score).toBeGreaterThanOrEqual(plain.score!);
    expect(verified.flags.map((f) => f.code)).toEqual(
      expect.arrayContaining(["ERC8004_AGENT", "HUMAN_BACKED"]),
    );
  });
});

describe("funding analysis", () => {
  const seller = addr("funder-seller");
  const sock = Array.from({ length: 4 }, (_, i) => addr(`sock-${i}`));
  const real = Array.from({ length: 4 }, (_, i) => addr(`real-${i}`));
  const flows = [...sock, ...real].map((p) => flow(p, seller, 10, { days: lastDays(10) }));
  const ledger = new Ledger(flows);

  it("zeroes revenue from wallets the seller funded", () => {
    const a = assess(ledger, seller, ctx({ funding: sock.map((s) => [s, { funder: seller }]) }));
    expect(a.seller.grossUsd).toBe(80);
    expect(a.seller.organicUsd).toBe(40);
    expect(a.seller.fundedUsd).toBe(40);
    const flag = a.flags.find((f) => f.code === "SELLER_FUNDED_PAYERS");
    expect(flag?.severity).toBe("critical");
    expect(flag?.addresses).toHaveLength(4);
  });

  it("words the finding for one payer and for many", () => {
    const many = assess(ledger, seller, ctx({ funding: sock.map((s) => [s, { funder: seller }]) }));
    expect(many.flags.find((f) => f.code === "SELLER_FUNDED_PAYERS")?.detail).toMatch(
      /^4 payers, 50% of revenue, were first funded/,
    );
    const one = assess(ledger, seller, ctx({ funding: [[sock[0]!, { funder: seller }]] }));
    expect(one.flags.find((f) => f.code === "SELLER_FUNDED_PAYERS")?.detail).toMatch(
      /^1 payer, .* of revenue, was first funded/,
    );
  });

  it("follows funding one hop back", () => {
    const middle = addr("middleman");
    const a = assess(
      ledger,
      seller,
      ctx({ funding: [[middle, { funder: seller }], ...sock.map((s) => [s, { funder: middle }] as const)] }),
    );
    expect(a.seller.organicUsd).toBe(40);
    expect(a.seller.payerLines.filter((l) => l.class === "seller-funded")).toHaveLength(4);
  });

  it("zeroes payers that share the seller's private funder", () => {
    const boss = addr("boss");
    const a = assess(
      ledger,
      seller,
      ctx({ funding: [[seller, { funder: boss }], ...sock.map((s) => [s, { funder: boss }] as const)] }),
    );
    expect(a.seller.organicUsd).toBe(40);
    expect(a.flags.find((f) => f.code === "SHARED_FUNDER")).toBeDefined();
  });

  it("still catches loop members funding payers even when they look like a busy public source", () => {
    const ring = ["pr0", "pr1"].map(addr);
    const s = ring[0]!;
    const sockPayers = Array.from({ length: 3 }, (_, i) => addr(`pr-sock-${i}`));
    const flows = [
      flow(ring[0]!, ring[1]!, 50, { count: 20 }),
      flow(ring[1]!, ring[0]!, 50, { count: 20 }),
      ...sockPayers.map((p) => flow(p, s, 10, { days: lastDays(5) })),
    ];
    const a = assess(
      new Ledger(flows),
      s,
      ctx({ funding: sockPayers.map((p) => [p, { funder: ring[1]!, funderIsPublic: true }] as const) }),
    );
    expect(a.seller.payerLines.filter((l) => l.class === "shared-funder")).toHaveLength(3);
    expect(a.seller.organicUsd).toBe(0);
  });

  it("ignores a shared public funder such as an exchange", () => {
    const exchange = addr("exchange");
    const a = assess(
      ledger,
      seller,
      ctx({
        funding: [
          [seller, { funder: exchange, funderIsPublic: true }],
          ...[...sock, ...real].map((s) => [s, { funder: exchange, funderIsPublic: true }] as const),
        ],
      }),
    );
    expect(a.seller.organicUsd).toBe(80);
    expect(a.components?.effectivePayers).toBeCloseTo(8, 5);
  });

  it("merges payers with one private funder into one for diversity, without zeroing them", () => {
    const aunt = addr("aunt");
    const a = assess(ledger, seller, ctx({ funding: sock.map((s) => [s, { funder: aunt }]) }));
    expect(a.seller.organicUsd).toBe(80);
    // Four sock wallets count as one group plus four real payers = five groups of unequal weight.
    expect(a.components?.effectivePayers).toBeCloseTo(80 ** 2 / (40 ** 2 + 4 * 10 ** 2), 5);
  });
});

describe("reciprocal trade", () => {
  it("only counts net inflow between two businesses that pay each other", () => {
    const a = addr("biz-a");
    const b = addr("biz-b");
    const extra = Array.from({ length: 5 }, (_, i) => flow(addr(`cust-${i}`), b, 2, { days: lastDays(6) }));
    const ledger = new Ledger([
      flow(a, b, 10, { days: lastDays(6) }),
      flow(b, a, 3, { days: lastDays(6) }),
      ...extra,
    ]);
    const res = assess(ledger, b, ctx());
    expect(res.seller.grossUsd).toBe(20);
    expect(res.seller.loopOffsetUsd).toBe(3);
    expect(res.seller.organicUsd).toBe(17);
    expect(res.flags.find((f) => f.code === "CIRCULAR_FLOW")?.severity).toBe("warning");
  });
});

describe("same human", () => {
  it("collapses payers proven to be one human", () => {
    const seller = addr("human-seller");
    const payers = Array.from({ length: 6 }, (_, i) => addr(`hp-${i}`));
    const ledger = new Ledger(payers.map((p) => flow(p, seller, 5, { days: lastDays(8) })));
    const a = assess(
      ledger,
      seller,
      ctx({
        humans: payers.slice(0, 5).map((p, i) => [p, { agentId: String(i), nullifier: "same", fresh: true }]),
      }),
    );
    expect(a.components?.effectivePayers).toBeCloseTo(30 ** 2 / (25 ** 2 + 5 ** 2), 5);
    expect(a.flags.find((f) => f.code === "SAME_HUMAN_PAYERS")).toBeDefined();
  });
});

describe("edge cases", () => {
  it("returns an empty assessment for an unknown address", () => {
    const a = assess(new Ledger([]), addr("nobody"), ctx());
    expect(a.role).toBe("none");
    expect(a.score).toBeNull();
    expect(a.rating).toBe("NR");
    expect(a.flags).toEqual([]);
    expect(a.seller.firstTs).toBeNull();
    expect(a.fundingCoverage).toBe(1);
  });

  it("describes a pure buyer without rating it", () => {
    const buyer = addr("buyer");
    const a = assess(new Ledger([flow(buyer, addr("shop"), 1)]), buyer, ctx());
    expect(a.role).toBe("buyer");
    expect(a.rating).toBe("NR");
    expect(a.buyer.spentUsd).toBe(1);
    expect(a.buyer.sellers).toBe(1);
  });

  it("marks a thin file NR but still reports numbers", () => {
    const seller = addr("thin");
    const a = assess(
      new Ledger([flow(addr("one"), seller, 3, { count: THIN_FILE.minSettlements })]),
      seller,
      ctx(),
    );
    expect(a.rating).toBe("NR");
    expect(a.score).not.toBeNull();
    expect(a.flags.map((f) => f.code)).toContain("THIN_FILE");
    expect(a.flags.find((f) => f.code === "THIN_FILE")?.detail).toContain("from 1 payer.");
    expect(a.flags.find((f) => f.code === "THIN_FILE")?.detail).not.toContain("(s)");
  });

  it("ignores self-payments", () => {
    const s = addr("selfpay");
    const ledger = new Ledger([flow(s, s, 100)]);
    expect(ledger.nodes).toHaveLength(0);
    expect(assess(ledger, s, ctx()).role).toBe("none");
  });

  it("penalises dormant sellers", () => {
    const seller = addr("dormant");
    const old = Math.floor((NOW - 120 * DAY) / DAY);
    const flows = Array.from({ length: 10 }, (_, i) =>
      flow(addr(`old-${i}`), seller, 5, { days: [old - i], count: 1 }),
    );
    const a = assess(new Ledger(flows), seller, ctx());
    expect(a.components?.dormancyFactor).toBe(0.6);
    expect(a.flags.map((f) => f.code)).toContain("DORMANT");
  });

  it("never lets identity rescue a dirty record", () => {
    const members = ["d0", "d1", "d2"].map(addr);
    const all = members.flatMap((p) =>
      members.filter((q) => q !== p).map((q) => flow(p, q, 50, { count: 10 })),
    );
    const a = assess(new Ledger(all), members[0]!, ctx({ agentIds: [[members[0]!, ["1"]]] }));
    expect(a.components?.identityBonus).toBe(0);
  });

  it("halves the weight of wallets created just to pay", () => {
    const seller = addr("sp-seller");
    const payers = Array.from({ length: 4 }, (_, i) => addr(`sp-${i}`));
    const flows = payers.map((p) => flow(p, seller, 10, { days: lastDays(4) }));
    const firstPay = flows[0]!.firstTs;
    const a = assess(
      new Ledger(flows),
      seller,
      ctx({ funding: payers.slice(0, 2).map((p) => [p, { firstSeenAt: firstPay - 600 }]) }),
    );
    expect(a.flags.map((f) => f.code)).toContain("SINGLE_PURPOSE_PAYERS");
    expect(a.components?.effectivePayers).toBeCloseTo(30 ** 2 / (2 * 5 ** 2 + 2 * 10 ** 2), 5);
  });

  it("credits established payers", () => {
    const seller = addr("est-seller");
    const payers = Array.from({ length: 3 }, (_, i) => addr(`est-${i}`));
    const flows = payers.map((p) => flow(p, seller, 10, { days: lastDays(4) }));
    const a = assess(
      new Ledger(flows),
      seller,
      ctx({
        funding: payers.map((p) => [
          p,
          { firstSeenAt: NOW - 90 * DAY, funder: addr("cex"), funderIsPublic: true },
        ]),
      }),
    );
    expect(a.seller.payerLines.every((l) => l.established)).toBe(true);
    expect(a.flags.map((f) => f.code)).toContain("ESTABLISHED_PAYERS");
    expect(a.fundingCoverage).toBe(1);
  });
});

describe("rating bands", () => {
  it("maps scores to bands at the boundaries", () => {
    expect(ratingFor(100)).toBe("AAA");
    expect(ratingFor(90)).toBe("AAA");
    expect(ratingFor(89)).toBe("AA");
    expect(ratingFor(60)).toBe("BBB");
    expect(ratingFor(59)).toBe("BB");
    expect(ratingFor(15)).toBe("CCC");
    expect(ratingFor(14)).toBe("D");
    expect(ratingFor(0)).toBe("D");
  });

  it("keeps the score within 0..100", () => {
    const max = scoreFrom({
      quality: 1,
      effectivePayers: 1e9,
      activeDays: 1e9,
      identityBonus: 8,
      dormancyFactor: 1,
    });
    expect(max.score).toBe(100);
    const min = scoreFrom({
      quality: 0,
      effectivePayers: 0,
      activeDays: 0,
      identityBonus: 0,
      dormancyFactor: 1,
    });
    expect(min.score).toBe(0);
  });
});
