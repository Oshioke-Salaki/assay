import type { Rating } from "@assay/core";

/** Dollars with sensible precision: cents below $1,000, whole dollars above, compact above $1M. */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (abs === 0) return "$0";
  if (abs < 0.01) return n < 0 ? "−<$0.01" : "<$0.01";
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

export function int(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Organic share as assay fineness, in parts per thousand, three digits like a hallmark:
 * 1.0 → "999" (assayers never strike 1000), 0.006 → "006". Null when there is no revenue.
 */
export function fineness(organic: number, gross: number): string | null {
  if (!(gross > 0)) return null;
  const ppt = Math.min(999, Math.max(0, Math.floor((organic / gross) * 1000)));
  return String(ppt).padStart(3, "0");
}

/** "0.006 fine" style, for prose. */
export function finenessWords(organic: number, gross: number): string {
  const f = fineness(organic, gross);
  return f === null ? "not assayed" : `0.${f} fine`;
}

export function pct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "–";
  const p = x * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p.toFixed(p >= 10 || p === 0 ? 0 : digits)}%`;
}

export function short(a: string | null | undefined): string {
  if (!a) return "–";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function date(ts: number | null | undefined): string {
  if (!ts) return "–";
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function dayLabel(day: number): string {
  const d = new Date(day * 86_400_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function ago(ts: number | null | undefined, now = Date.now() / 1000): string {
  if (!ts) return "–";
  const s = Math.max(0, now - ts);
  if (s < 90) return "just now";
  if (s < 5_400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3_600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

export const RATING_WORDS: Record<Rating, string> = {
  AAA: "Exceptional",
  AA: "Very strong",
  A: "Strong",
  BBB: "Adequate",
  BB: "Speculative",
  B: "Weak",
  CCC: "Very weak",
  D: "Poor",
  NR: "Not rated yet",
};

export const EXPLORER = "https://celoscan.io";
export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
