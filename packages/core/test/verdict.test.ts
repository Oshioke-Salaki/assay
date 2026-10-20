import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { Ledger } from "../src/ledger.js";
import { verdictFor } from "../src/verdict.js";
import { addr, ctx, flow, lastDays } from "./helpers.js";

describe("verdictFor", () => {
  it("blocks a wash ring", () => {
    const m = ["v0", "v1", "v2", "v3"].map(addr);
    const flows = m.flatMap((p) =>
      m.filter((q) => q !== p).map((q) => flow(p, q, 100, { count: 50, days: lastDays(5) })),
    );
    const v = verdictFor(assess(new Ledger(flows), m[0]!, ctx()));
    expect(v.verdict).toBe("block");
    expect(v.organicShare).toBeCloseTo(0, 9);
    expect(v.reasons).toContain("Circular revenue");
  });

  it("passes a healthy seller", () => {
    const s = addr("v-healthy");
    const flows = Array.from({ length: 20 }, (_, i) => flow(addr(`v-c-${i}`), s, 3, { days: lastDays(25) }));
    const v = verdictFor(assess(new Ledger(flows), s, ctx()));
    expect(v.verdict).toBe("pass");
  });

  it("is cautious about an address it has never seen", () => {
    const v = verdictFor(assess(new Ledger([]), addr("v-unknown"), ctx()));
    expect(v.verdict).toBe("caution");
    expect(v.organicShare).toBeNull();
    expect(v.reasons).toEqual(["No x402 revenue on record"]);
  });

  it("never blocks an honest seller just because its history is short", () => {
    // Organic revenue from three unrelated payers over two days: a low score, but nothing wrong.
    const s = addr("v-new-honest");
    const flows = [0, 1, 2].map((i) => flow(addr(`v-new-c-${i}`), s, 0.3, { count: 2, days: lastDays(2) }));
    const a = assess(new Ledger(flows), s, ctx());
    expect(["D", "CCC", "B"]).toContain(a.rating);
    const v = verdictFor(a);
    expect(v.verdict).toBe("caution");
    expect(v.reasons[0]).toMatch(/too little independent history/);
  });

  it("blocks revenue that is mostly circular even without a rating", () => {
    const m = ["vb0", "vb1"].map(addr);
    const flows = [flow(m[0]!, m[1]!, 50, { count: 20 }), flow(m[1]!, m[0]!, 50, { count: 20 })];
    const v = verdictFor(assess(new Ledger(flows), m[0]!, ctx()));
    expect(v.verdict).toBe("block");
    expect(v.reasons).toContain("Only 0% of revenue is organic");
  });

  it("is cautious about a thin file", () => {
    const s = addr("v-thin");
    const v = verdictFor(assess(new Ledger([flow(addr("v-one"), s, 1)]), s, ctx()));
    expect(v.verdict).toBe("caution");
    expect(v.reasons[0]).toMatch(/Thin file/);
  });
});
