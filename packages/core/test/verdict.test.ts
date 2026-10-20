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

  it("is cautious about a thin file", () => {
    const s = addr("v-thin");
    const v = verdictFor(assess(new Ledger([flow(addr("v-one"), s, 1)]), s, ctx()));
    expect(v.verdict).toBe("caution");
    expect(v.reasons[0]).toMatch(/Thin file/);
  });
});
