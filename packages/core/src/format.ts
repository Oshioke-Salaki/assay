import type { Address } from "./types.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

export function isTxHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && HASH_RE.test(value);
}

/** Lower-case canonical form used for every map key and database row. */
export function normalizeAddress(value: string): Address {
  if (!isAddress(value)) throw new Error(`Not an address: ${value}`);
  return value.toLowerCase() as Address;
}

/** 32-byte topic → address. */
export function topicToAddress(topic: string): Address {
  return `0x${topic.slice(-40)}`.toLowerCase() as Address;
}

/** Exact decimal conversion of raw token units, without float drift for large 18-decimal amounts. */
export function unitsToNumber(raw: bigint, decimals: number): number {
  if (decimals === 0) return Number(raw);
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  return Number(whole) + Number(frac) / Number(base);
}

export function dayOf(ts: number): number {
  return Math.floor(ts / 86_400);
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
