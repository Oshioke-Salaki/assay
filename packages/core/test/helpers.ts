import type { Address, AssessmentContext, FundingInfo, Hash, HumanInfo, PairFlow } from "../src/types.js";

export const NOW = 1_792_500_000;
export const DAY = 86_400;

let counter = 0;
/** Deterministic distinct addresses: addr("seller") always returns the same one. */
const named = new Map<string, Address>();
export function addr(name: string): Address {
  let a = named.get(name);
  if (!a) {
    counter++;
    a = `0x${counter.toString(16).padStart(40, "0")}` as Address;
    named.set(name, a);
  }
  return a;
}

export function tx(n: number): Hash {
  return `0x${n.toString(16).padStart(64, "0")}` as Hash;
}

export function flow(
  payer: Address,
  payee: Address,
  usd: number,
  opts: { count?: number; days?: number[]; lastTs?: number } = {},
): PairFlow {
  const days = opts.days ?? [Math.floor((NOW - DAY) / DAY)];
  const firstTs = Math.min(...days) * DAY + 3600;
  const lastTs = opts.lastTs ?? Math.max(...days) * DAY + 3600;
  return {
    payer,
    payee,
    count: opts.count ?? days.length,
    usd,
    firstTs,
    lastTs,
    days,
    sampleTxs: [tx(Number.parseInt(payer.slice(-6), 16) * 1000 + Number.parseInt(payee.slice(-6), 16))],
  };
}

/** Days [today-n+1 .. today]. */
export function lastDays(n: number): number[] {
  const today = Math.floor(NOW / DAY);
  return Array.from({ length: n }, (_, i) => today - n + 1 + i);
}

export function ctx(
  opts: {
    funding?: ReadonlyArray<readonly [Address, Partial<FundingInfo>]>;
    humans?: ReadonlyArray<readonly [Address, HumanInfo]>;
    agentIds?: ReadonlyArray<readonly [Address, string[]]>;
    now?: number;
  } = {},
): AssessmentContext {
  return {
    funding: new Map(
      (opts.funding ?? []).map(([a, f]) => [
        a,
        { funder: null, fundedAt: null, firstSeenAt: null, funderIsPublic: false, ...f },
      ]),
    ),
    humans: new Map(opts.humans ?? []),
    agentIds: new Map(opts.agentIds ?? []),
    now: opts.now ?? NOW,
  };
}
