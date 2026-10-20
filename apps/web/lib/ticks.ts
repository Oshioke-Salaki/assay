/** Round, even axis steps with the top tick strictly above the maximum (1, 2, 2.5 or 5 × 10^n). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * count > max) ?? 10 * mag) as number;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-12; v += step) ticks.push(+v.toPrecision(12));
  ticks.push(+(ticks[ticks.length - 1]! + step).toPrecision(12));
  return ticks;
}

/** Evenly spaced label indexes (4–7 labels), always including the last. */
export function labelIndexes(n: number, target = 6): number[] {
  if (n <= target) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (target - 1));
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}
