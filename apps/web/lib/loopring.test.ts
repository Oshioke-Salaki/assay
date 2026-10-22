import { describe, expect, it } from "vitest";
import { beadBudget, beadPoint, layoutRing, MAX_BEADS, MAX_SPOKES, pickSpokes, seeded } from "./loopring";

const a = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

describe("pickSpokes", () => {
  it("merges a wallet that both pays and is paid, keeps the biggest, and counts what it drops", () => {
    const inflows = [
      { address: a(1), usd: 10, inLoop: true },
      { address: a(2), usd: 50, inLoop: false },
    ];
    const outflows = [
      { address: a(1), usd: 5, inLoop: true },
      { address: a(3), usd: 1, inLoop: true },
    ];
    const { kept, dropped } = pickSpokes(inflows, outflows, 2);
    expect(kept.map((s) => s.address)).toEqual([a(2), a(1)]);
    expect(kept[1]).toMatchObject({ usd: 15, inLoop: true, dir: "both" });
    expect(kept[0]?.dir).toBe("in");
    expect(dropped).toBe(1);
  });

  it("never keeps more than the cap", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ address: a(i), usd: i + 1, inLoop: true }));
    const { kept, dropped } = pickSpokes(many, []);
    expect(kept).toHaveLength(MAX_SPOKES);
    expect(dropped).toBe(400 - MAX_SPOKES);
  });
});

describe("layoutRing", () => {
  it("places every spoke on one circle inside the box, loop members first", () => {
    const spokes = [
      { address: a(1), usd: 1, inLoop: false, dir: "in" as const },
      { address: a(2), usd: 9, inLoop: true, dir: "both" as const },
      { address: a(3), usd: 4, inLoop: true, dir: "out" as const },
    ];
    const out = layoutRing(spokes, 600, 300);
    expect(out.map((s) => s.inLoop)).toEqual([true, true, false]);
    const r = Math.min(600, 300) / 2 - 28;
    for (const s of out) {
      expect(Math.hypot(s.x - 300, s.y - 150)).toBeCloseTo(r, 6);
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(600);
      expect(s.r).toBeGreaterThanOrEqual(2.5);
      expect(s.r).toBeLessThanOrEqual(8);
    }
    expect(out[0]?.r).toBe(8); // the biggest flow gets the biggest node
  });

  it("shrinks nodes when the ring is crowded, so they never merge into a band", () => {
    const many = Array.from({ length: 96 }, (_, i) => ({
      address: a(i),
      usd: 100,
      inLoop: true,
      dir: "both" as const,
    }));
    const out = layoutRing(many, 1040, 300);
    const spacing = (2 * Math.PI * (150 - 28)) / 96;
    for (const s of out) expect(s.r * 2).toBeLessThan(spacing);
  });

  it("copes with one spoke and a tiny box", () => {
    const out = layoutRing([{ address: a(1), usd: 0, inLoop: false, dir: "in" as const }], 50, 50);
    expect(out).toHaveLength(1);
    expect(Number.isFinite(out[0]!.x)).toBe(true);
  });
});

describe("beadBudget", () => {
  it("gives every flow at least one bead and never exceeds the budget", () => {
    const spokes = Array.from({ length: 96 }, (_, i) => ({ usd: i === 0 ? 1_000_000 : 1 }));
    const beads = beadBudget(spokes);
    expect(beads.every((b) => b >= 1)).toBe(true);
    expect(beads.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(MAX_BEADS);
    // The giant flow gets more, but not everything.
    expect(beads[0]).toBeGreaterThan(beads[1]!);
    expect(beads[0]).toBeLessThan(MAX_BEADS - 95);
  });

  it("handles no volume and no spokes", () => {
    expect(beadBudget([])).toEqual([]);
    expect(beadBudget([{ usd: 0 }, { usd: 0 }])).toEqual([1, 1]);
  });
});

describe("beadPoint", () => {
  const s = { address: a(1), usd: 1, inLoop: true, dir: "both" as const, angle: 0, x: 100, y: 0, r: 3 };
  it("runs a loop bead in to the centre and back out", () => {
    expect(beadPoint(s, 0, 0, 0)).toMatchObject({ x: 100, y: 0, toward: true });
    expect(beadPoint(s, 0, 0, 0.5).x).toBeCloseTo(0, 6);
    expect(beadPoint(s, 0, 0, 0.75).toward).toBe(false);
    expect(beadPoint(s, 0, 0, 0.999).x).toBeCloseTo(100, 0);
  });
  it("runs an inflow bead one way and an outflow bead the other", () => {
    expect(beadPoint({ ...s, dir: "in" }, 0, 0, 0.999).x).toBeCloseTo(0, 0);
    expect(beadPoint({ ...s, dir: "out" }, 0, 0, 0.001).x).toBeCloseTo(0, 0);
    expect(beadPoint({ ...s, dir: "out" }, 0, 0, 0.999).x).toBeCloseTo(100, 0);
  });
});

describe("seeded", () => {
  it("is stable and in range", () => {
    expect(seeded(7)).toBe(seeded(7));
    for (let i = 0; i < 50; i++) {
      expect(seeded(i)).toBeGreaterThanOrEqual(0);
      expect(seeded(i)).toBeLessThan(1);
    }
  });
});
