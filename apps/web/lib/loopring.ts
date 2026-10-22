/**
 * Geometry and budgets for the loop drawing: a seller in the middle, the wallets it trades with
 * around it, and beads of money moving along the spokes. Pure functions, so the canvas code
 * stays thin and this part is tested.
 */
export interface Flow {
  address: string;
  usd: number;
  /** The wallet is in the seller's payment loop. */
  inLoop: boolean;
}

export interface Spoke {
  address: string;
  usd: number;
  inLoop: boolean;
  /** "in": pays the seller; "out": is paid by the seller; "both": does both. */
  dir: "in" | "out" | "both";
  angle: number;
  x: number;
  y: number;
  /** Node radius in px, by volume. */
  r: number;
}

export const MAX_SPOKES = 96;
export const MAX_BEADS = 140;

/** Merge inflows and outflows by wallet, biggest first, and keep what fits on the ring. */
export function pickSpokes(
  inflows: Flow[],
  outflows: Flow[],
  max = MAX_SPOKES,
): { kept: Omit<Spoke, "angle" | "x" | "y" | "r">[]; dropped: number } {
  const byAddress = new Map<string, { usd: number; inLoop: boolean; in: boolean; out: boolean }>();
  for (const f of inflows) {
    const cur = byAddress.get(f.address) ?? { usd: 0, inLoop: false, in: false, out: false };
    byAddress.set(f.address, {
      usd: cur.usd + f.usd,
      inLoop: cur.inLoop || f.inLoop,
      in: true,
      out: cur.out,
    });
  }
  for (const f of outflows) {
    const cur = byAddress.get(f.address) ?? { usd: 0, inLoop: false, in: false, out: false };
    byAddress.set(f.address, { usd: cur.usd + f.usd, inLoop: cur.inLoop || f.inLoop, in: cur.in, out: true });
  }
  const all = [...byAddress.entries()]
    .map(([address, v]) => ({
      address,
      usd: v.usd,
      inLoop: v.inLoop,
      dir: v.in && v.out ? ("both" as const) : v.in ? ("in" as const) : ("out" as const),
    }))
    .sort((a, b) => b.usd - a.usd);
  return { kept: all.slice(0, max), dropped: Math.max(0, all.length - max) };
}

/** Place spokes evenly round a circle that fits the box, loop members grouped together. */
export function layoutRing(
  spokes: Omit<Spoke, "angle" | "x" | "y" | "r">[],
  width: number,
  height: number,
): Spoke[] {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(40, Math.min(width, height) / 2 - 28);
  const maxUsd = Math.max(1e-9, ...spokes.map((s) => s.usd));
  // Loop members first, then the rest, so the ring reads as two arcs.
  const ordered = [...spokes].sort((a, b) => Number(b.inLoop) - Number(a.inLoop) || b.usd - a.usd);
  const n = ordered.length;
  // Nodes shrink as the ring fills, so a crowded ring stays a ring of dots, not a solid band.
  const spacing = (2 * Math.PI * radius) / Math.max(1, n);
  const maxR = Math.max(1.6, Math.min(8, spacing / 2.6));
  const minR = Math.min(2.5, maxR);
  return ordered.map((s, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2;
    return {
      ...s,
      angle,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      r: minR + (maxR - minR) * Math.sqrt(s.usd / maxUsd),
    };
  });
}

/** How many beads a flow gets: at least one, more for bigger flows, within the overall budget. */
export function beadBudget(spokes: { usd: number }[], max = MAX_BEADS): number[] {
  if (spokes.length === 0) return [];
  const total = spokes.reduce((n, s) => n + s.usd, 0);
  if (!(total > 0)) return spokes.map(() => 1);
  const base = spokes.map(() => 1);
  let left = Math.max(0, max - spokes.length);
  // Share the rest by the square root of volume, so one giant flow does not take every bead.
  const weights = spokes.map((s) => Math.sqrt(s.usd));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const extra = weights.map((w) => Math.floor((w / wsum) * left));
  for (let i = 0; i < extra.length; i++) {
    base[i]! += extra[i]!;
    left -= extra[i]!;
  }
  return base;
}

/** A bead's position along a spoke at phase t in [0,1): loop beads go in then back out. */
export function beadPoint(
  s: Spoke,
  cx: number,
  cy: number,
  t: number,
): { x: number; y: number; toward: boolean } {
  let u: number;
  let toward: boolean;
  if (s.dir === "both") {
    // Half the cycle inward, half outward: the dollar comes in and leaves again.
    toward = t < 0.5;
    u = toward ? t * 2 : 1 - (t - 0.5) * 2;
  } else if (s.dir === "in") {
    toward = true;
    u = t;
  } else {
    toward = false;
    u = 1 - t;
  }
  // Ease so beads slow near the nodes, like something settling.
  const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
  return { x: s.x + (cx - s.x) * e, y: s.y + (cy - s.y) * e, toward };
}

/** A fixed pseudo-random in [0,1) so the drawing is the same on every visit. */
export function seeded(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
