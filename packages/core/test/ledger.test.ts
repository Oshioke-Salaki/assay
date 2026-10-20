import { describe, expect, it } from "vitest";
import { Ledger, mergeFlows } from "../src/ledger.js";
import type { Address } from "../src/types.js";
import { addr, flow } from "./helpers.js";

describe("Ledger", () => {
  it("separates a loop from a tail hanging off it", () => {
    const [a, b, c, d] = ["la", "lb", "lc", "ld"].map(addr) as [Address, Address, Address, Address];
    const ledger = new Ledger([flow(a, b, 1), flow(b, c, 1), flow(c, a, 1), flow(c, d, 1)]);
    expect(ledger.sameComponent(a, c)).toBe(true);
    expect(ledger.sameComponent(a, d)).toBe(false);
    expect(ledger.componentMembers(d)).toEqual([d]);
    expect(ledger.loops()).toHaveLength(1);
  });

  it("finds two separate loops, largest first", () => {
    const x = ["x0", "x1"].map(addr);
    const y = ["y0", "y1", "y2"].map(addr);
    const ledger = new Ledger([
      flow(x[0]!, x[1]!, 1),
      flow(x[1]!, x[0]!, 1),
      ...y.map((p, i) => flow(p, y[(i + 1) % 3]!, 1)),
    ]);
    const loops = ledger.loops();
    expect(loops.map((l) => l.length)).toEqual([3, 2]);
  });

  it("handles a 100k-long payment chain without overflowing the stack", () => {
    const n = 100_000;
    const nodes = Array.from(
      { length: n },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
    );
    const flows = nodes.slice(1).map((p, i) => flow(nodes[i]!, p, 1));
    flows.push(flow(nodes[n - 1]!, nodes[0]!, 1)); // close the chain into one giant loop
    const ledger = new Ledger(flows);
    expect(ledger.componentMembers(nodes[0]!)).toHaveLength(n);
  });

  it("merges duplicate pair flows instead of overwriting them", () => {
    const p = addr("dup-p");
    const q = addr("dup-q");
    const ledger = new Ledger([flow(p, q, 2, { days: [10, 11] }), flow(p, q, 3, { days: [11, 12] })]);
    const merged = ledger.payersOf(q)[0]!;
    expect(merged.usd).toBe(5);
    expect(merged.days).toEqual([10, 11, 12]);
    expect(merged.count).toBe(4);
  });

  it("mergeFlows keeps the earliest first and latest last timestamp", () => {
    const p = addr("m-p");
    const q = addr("m-q");
    const m = mergeFlows(flow(p, q, 1, { days: [5] }), flow(p, q, 1, { days: [3] }));
    expect(m.firstTs).toBeLessThan(m.lastTs);
    expect(m.days).toEqual([3, 5]);
  });
});
