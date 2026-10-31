import type { Ledger } from "./ledger.js";
import type {
  Address,
  Assessment,
  AssessmentContext,
  BuyerSide,
  CounterpartyLine,
  Flag,
  FundingInfo,
  Hash,
  PayerClass,
  PayerLine,
  Rating,
  ScoreComponents,
  SellerSide,
} from "./types.js";

export const METHODOLOGY_VERSION = "2026.10-4";

const DAY = 86_400;

/** "Early" self-funding: a seller under this age, with at most this much self-funded revenue. */
export const EARLY_SELF_FUNDED = { maxAgeDays: 60, maxUsd: 50 } as const;

/** Below these an address is "thin file": numbers are shown, no rating is issued. */
export const THIN_FILE = { minSettlements: 5, minPayers: 2, minGrossUsd: 0.05 } as const;

export const RATING_FLOORS: readonly [Rating, number][] = [
  ["AAA", 90],
  ["AA", 80],
  ["A", 70],
  ["BBB", 60],
  ["BB", 45],
  ["B", 30],
  ["CCC", 15],
  ["D", 0],
];

/** "1 payer", "375 payers". */
function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

export function ratingFor(score: number): Rating {
  for (const [rating, floor] of RATING_FLOORS) if (score >= floor) return rating;
  return "D";
}

/** Diversity saturates around 15 independent payers, track record around 25 active days. */
export function scoreFrom(c: Omit<ScoreComponents, "diversity" | "track">): {
  score: number;
  diversity: number;
  track: number;
} {
  const diversity = 1 - Math.exp(-c.effectivePayers / 6);
  const track = 1 - Math.exp(-c.activeDays / 10);
  const base = 100 * c.quality ** 1.5 * (0.55 * diversity + 0.45 * track) * c.dormancyFactor;
  const score = Math.round(clamp(base + c.identityBonus, 0, 100));
  return { score, diversity, track };
}

/**
 * Assess one address against the x402 payment graph.
 *
 * Revenue is "organic" unless it is
 *  - offset by money the seller sent back into its own payment loop (only net inflow from a loop counts),
 *  - paid by a wallet the seller funded, directly or one hop removed, or
 *  - paid by a wallet funded by the seller's own (non-public) funder or by a member of its loop.
 */
export function assess(ledger: Ledger, address: Address, ctx: AssessmentContext): Assessment {
  const seller = sellerSide(ledger, address, ctx);
  const buyer = buyerSide(ledger, address);
  const members = ledger.componentMembers(address);
  const loop = members.length > 1 ? { size: members.length, members: members.slice(0, 50) } : null;

  const role: Assessment["role"] =
    seller.grossUsd > 0 && buyer.spentUsd > 0
      ? "both"
      : seller.grossUsd > 0
        ? "seller"
        : buyer.spentUsd > 0
          ? "buyer"
          : "none";

  const agentIds = [...(ctx.agentIds.get(address) ?? [])];
  const human = ctx.humans.get(address) ?? null;
  const fundingCoverage =
    seller.payers === 0
      ? 1
      : seller.payerLines.filter((l) => ctx.funding.has(l.payer)).length / seller.payers;

  const flags: Flag[] = [];
  let components: ScoreComponents | null = null;
  let score: number | null = null;
  let rating: Rating = "NR";

  if (seller.grossUsd > 0) {
    const credited = seller.payerLines.filter((l) => l.creditedUsd > 0);
    const quality = seller.grossUsd > 0 ? clamp(seller.organicUsd / seller.grossUsd, 0, 1) : 0;
    const { effective: effectivePayers, weightUsd: payerWeightUsd } = effectiveIndependentPayers(
      credited,
      ledger,
      ctx,
    );
    const activeDays = organicActiveDays(ledger, address, credited);
    const lastOrganic = credited.reduce((m, l) => Math.max(m, l.lastTs), 0);
    const idle = lastOrganic === 0 ? Number.POSITIVE_INFINITY : (ctx.now - lastOrganic) / DAY;
    const dormancyFactor = idle > 90 ? 0.6 : idle > 30 ? 0.85 : 1;
    // Identity can lift a clean record, never rescue a dirty one.
    const identityBonus =
      quality >= 0.5 ? (agentIds.length > 0 ? 3 : 0) + (human?.fresh ? 5 : human ? 2 : 0) : 0;
    const {
      score: s,
      diversity,
      track,
    } = scoreFrom({
      quality,
      effectivePayers,
      activeDays,
      identityBonus,
      dormancyFactor,
    });
    components = {
      quality,
      effectivePayers,
      payerWeightUsd,
      diversity,
      activeDays,
      track,
      identityBonus,
      dormancyFactor,
    };

    const thin =
      seller.settlements < THIN_FILE.minSettlements ||
      seller.payers < THIN_FILE.minPayers ||
      seller.grossUsd < THIN_FILE.minGrossUsd;
    score = s;
    rating = thin ? "NR" : ratingFor(s);
    if (thin) {
      flags.push({
        code: "THIN_FILE",
        severity: "info",
        title: "Thin file",
        detail: `Not enough history to rate: ${count(seller.settlements, "settlement")} from ${count(seller.payers, "payer")}. A rating needs at least ${THIN_FILE.minSettlements} settlements from ${THIN_FILE.minPayers} payers.`,
      });
    }
    if (idle > 30 && Number.isFinite(idle)) {
      flags.push({
        code: "DORMANT",
        severity: "info",
        title: "Dormant",
        detail: `No organic revenue in the last ${Math.floor(idle)} days.`,
      });
    }
    flags.push(...sellerFlags(seller, ledger, address, ctx, quality, fundingCoverage));
  }

  // Any address inside a loop also receives from it, so the seller-side CIRCULAR_FLOW flag covers it.

  if (agentIds.length > 0) {
    flags.push({
      code: "ERC8004_AGENT",
      severity: "positive",
      title: "Registered ERC-8004 agent",
      detail: `Linked to agent ${agentIds.map((id) => `#${id}`).join(", ")} in the ERC-8004 Identity Registry.`,
    });
  }
  if (human) {
    flags.push({
      code: "HUMAN_BACKED",
      severity: "positive",
      title: human.fresh ? "Backed by a verified human" : "Human proof expired",
      detail: human.fresh
        ? `Self Agent ID #${human.agentId} binds this key to a unique human with a fresh passport proof.`
        : `Self Agent ID #${human.agentId} exists, but its human proof has expired.`,
    });
  }

  return {
    address,
    role,
    score,
    rating,
    components,
    seller,
    buyer,
    loop,
    flags: sortFlags(flags),
    identity: { agentIds, human, funding: ctx.funding.get(address) ?? null },
    fundingCoverage,
    methodologyVersion: METHODOLOGY_VERSION,
  };
}

function sellerSide(ledger: Ledger, s: Address, ctx: AssessmentContext): SellerSide {
  const flows = ledger.payersOf(s);
  const sellerFunding = ctx.funding.get(s);
  const members = new Set(ledger.componentMembers(s));

  const lines: PayerLine[] = flows.map((f) => {
    const funding = ctx.funding.get(f.payer);
    const cls = classifyPayer(f.payer, s, funding, sellerFunding, members, ledger, ctx);
    const established = funding?.firstSeenAt != null && funding.firstSeenAt <= f.firstTs - 30 * DAY;
    return {
      payer: f.payer,
      usd: f.usd,
      creditedUsd: cls === "seller-funded" || cls === "shared-funder" ? 0 : f.usd,
      count: f.count,
      firstTs: f.firstTs,
      lastTs: f.lastTs,
      class: cls,
      inLoop: members.has(f.payer),
      funder: funding?.funder ?? null,
      human: ctx.humans.has(f.payer),
      established,
      firstSeenAt: funding?.firstSeenAt ?? null,
      traced: funding !== undefined,
      sampleTxs: f.sampleTxs,
    };
  });

  // Net-of-loop: money the seller sends back into its loop offsets what the loop paid it.
  const loopLines = lines.filter((l) => l.class === "loop");
  const loopIn = sum(loopLines.map((l) => l.usd));
  const loopOut = sum(
    ledger
      .payeesOf(s)
      .filter((f) => members.has(f.payee))
      .map((f) => f.usd),
  );
  const offset = Math.min(loopIn, loopOut);
  if (offset > 0 && loopIn > 0) {
    for (const l of loopLines) l.creditedUsd = Math.max(0, l.usd - (offset * l.usd) / loopIn);
  }

  lines.sort((a, b) => b.usd - a.usd);
  const grossUsd = sum(lines.map((l) => l.usd));
  const organicUsd = sum(lines.map((l) => l.creditedUsd));
  const fundedUsd = sum(
    lines.filter((l) => l.class === "seller-funded" || l.class === "shared-funder").map((l) => l.usd),
  );
  return {
    grossUsd,
    organicUsd,
    loopOffsetUsd: offset,
    fundedUsd,
    settlements: sum(lines.map((l) => l.count)),
    payers: lines.length,
    organicPayers: lines.filter((l) => l.creditedUsd > 0).length,
    firstTs: minOf(lines.map((l) => l.firstTs)),
    lastTs: maxOf(lines.map((l) => l.lastTs)),
    payerLines: lines,
  };
}

function classifyPayer(
  payer: Address,
  seller: Address,
  funding: FundingInfo | undefined,
  sellerFunding: FundingInfo | undefined,
  loopMembers: Set<Address>,
  ledger: Ledger,
  ctx: AssessmentContext,
): PayerClass {
  const funder = funding?.funder ?? null;
  // Being funded by the seller, or by a member of its loop, counts however busy the
  // funder is: a high-volume wash wallet must not pass as an exchange.
  if (funder === seller) return "seller-funded";
  if (funder && funder !== payer && loopMembers.has(funder)) return "shared-funder";
  if (funder && !funderIsPublic(funding, ledger)) {
    // One hop removed: the seller funded the wallet that funded the payer.
    if (ctx.funding.get(funder)?.funder === seller) return "seller-funded";
    if (sellerFunding?.funder && !funderIsPublic(sellerFunding, ledger) && funder === sellerFunding.funder) {
      return "shared-funder";
    }
  }
  if (loopMembers.has(payer)) return "loop";
  return "organic";
}

/**
 * Whether sharing this funder says nothing about who controls the wallets: an exchange, a contract.
 * An address that buys or sells over x402 itself is a participant, never a neutral source, however
 * it was profiled; the ledger decides that at the block being scored, so a replay agrees.
 */
function funderIsPublic(f: FundingInfo | undefined, ledger: Ledger): boolean {
  if (!f?.funder || !f.funderIsPublic) return false;
  return ledger.payersOf(f.funder).length === 0 && ledger.payeesOf(f.funder).length === 0;
}

/**
 * Inverse Herfindahl over groups of payers that are probably one actor: same
 * non-public funder or same Self human. Wallets created only to pay this seller
 * count half.
 *
 * The plain index (Σu)² / Σu² is scale-free, so halving a group's dollars changes nothing when
 * every group is halved. Each group therefore carries its discounted dollars w and its raw dollars
 * u, and the index is (Σw)² / Σ(w·u): n equal groups count n, and n equal disposable ones count n/2.
 * `weightUsd` is Σw, which the plan needs to add customers to the same index.
 */
function effectiveIndependentPayers(
  lines: PayerLine[],
  ledger: Ledger,
  ctx: AssessmentContext,
): { effective: number; weightUsd: number } {
  if (lines.length === 0) return { effective: 0, weightUsd: 0 };
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[i] !== r) {
      const next = parent[i]!;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const byKey = new Map<string, number>();
  lines.forEach((l, i) => {
    const f = ctx.funding.get(l.payer);
    const keys: string[] = [];
    if (f?.funder && !funderIsPublic(f, ledger)) keys.push(`f:${f.funder}`);
    const h = ctx.humans.get(l.payer);
    if (h) keys.push(`h:${h.nullifier}`);
    for (const k of keys) {
      const seen = byKey.get(k);
      if (seen === undefined) byKey.set(k, i);
      else union(seen, i);
    }
  });
  const groups = new Map<number, { w: number; u: number }>();
  lines.forEach((l, i) => {
    const g = groups.get(find(i)) ?? { w: 0, u: 0 };
    g.w += l.creditedUsd * (isSinglePurpose(l, ledger, ctx) ? 0.5 : 1);
    g.u += l.creditedUsd;
    groups.set(find(i), g);
  });
  const gs = [...groups.values()].filter((g) => g.w > 0);
  const weightUsd = sum(gs.map((g) => g.w));
  const denom = sum(gs.map((g) => g.w * g.u));
  if (weightUsd === 0 || denom === 0) return { effective: 0, weightUsd: 0 };
  return { effective: weightUsd ** 2 / denom, weightUsd };
}

function isSinglePurpose(line: PayerLine, ledger: Ledger, ctx: AssessmentContext): boolean {
  const f = ctx.funding.get(line.payer);
  if (f?.firstSeenAt == null) return false;
  return ledger.payeesOf(line.payer).length === 1 && line.firstTs - f.firstSeenAt < DAY;
}

function organicActiveDays(ledger: Ledger, seller: Address, credited: PayerLine[]): number {
  const days = new Set<number>();
  const flows = ledger.incoming.get(seller);
  for (const l of credited) for (const d of flows?.get(l.payer)?.days ?? []) days.add(d);
  return days.size;
}

function sellerFlags(
  seller: SellerSide,
  ledger: Ledger,
  address: Address,
  ctx: AssessmentContext,
  quality: number,
  fundingCoverage: number,
): Flag[] {
  const flags: Flag[] = [];
  const gross = seller.grossUsd;
  const loopLines = seller.payerLines.filter((l) => l.class === "loop");
  if (seller.loopOffsetUsd > 0) {
    const share = seller.loopOffsetUsd / gross;
    flags.push({
      code: "CIRCULAR_FLOW",
      severity: share >= 0.5 ? "critical" : share >= 0.1 ? "warning" : "info",
      title: "Circular revenue",
      detail: `${pct(share)} of revenue comes back from a loop of ${ledger.componentMembers(address).length} addresses that this address also pays. Only the net inflow from the loop is counted.`,
      usd: seller.loopOffsetUsd,
      addresses: loopLines.map((l) => l.payer).slice(0, 10),
      txs: takeTxs(loopLines),
    });
  }
  const funded = seller.payerLines.filter((l) => l.class === "seller-funded");
  if (funded.length > 0) {
    const usd = sum(funded.map((l) => l.usd));
    // Funding sent through a contract this address called (a batch sender, say) is still its own.
    const viaContract = funded.filter((l) => {
      const f = ctx.funding.get(l.payer);
      return f?.funder === address && f.fundedVia;
    }).length;
    const via =
      viaContract === 0
        ? ""
        : viaContract === funded.length
          ? ` ${funded.length === 1 ? "It was" : "All of them were"} funded through a contract this address called, which counts the same as a direct transfer.`
          : ` ${viaContract} of them ${viaContract === 1 ? "was" : "were"} funded through a contract this address called, which counts the same as a direct transfer.`;
    const facts = `${count(funded.length, "payer")}, ${pct(usd / gross)} of revenue, ${funded.length === 1 ? "was" : "were"} first funded by this address.${via} That revenue is not counted.`;
    // A new seller testing with a few wallets it funded is not the same story as a ring: say so,
    // and leave the arithmetic exactly as it is.
    const early =
      seller.firstTs !== null &&
      ctx.now - seller.firstTs <= EARLY_SELF_FUNDED.maxAgeDays * DAY &&
      usd <= EARLY_SELF_FUNDED.maxUsd;
    flags.push({
      code: "SELLER_FUNDED_PAYERS",
      severity: usd / gross >= 0.2 ? "critical" : "warning",
      title: early ? "Early payments from wallets it funded" : "Pays itself through wallets it funded",
      detail: early
        ? `${facts} New sellers often test with wallets they fund themselves; this weighs less as independent customers arrive, and the seller can explain it in a reply.`
        : facts,
      usd,
      addresses: funded.map((l) => l.payer).slice(0, 10),
      txs: takeTxs(funded),
      ...(early ? { early: true } : {}),
    });
  }
  const shared = seller.payerLines.filter((l) => l.class === "shared-funder");
  if (shared.length > 0) {
    const usd = sum(shared.map((l) => l.usd));
    flags.push({
      code: "SHARED_FUNDER",
      severity: usd / gross >= 0.2 ? "critical" : "warning",
      title: "Payers share the seller's funding source",
      detail: `${count(shared.length, "payer")}, ${pct(usd / gross)} of revenue, ${shared.length === 1 ? "was" : "were"} funded by the same private wallet as this address or by a member of its loop. That revenue is not counted.`,
      usd,
      addresses: shared.map((l) => l.payer).slice(0, 10),
      txs: takeTxs(shared),
    });
  }
  const byHuman = new Map<string, PayerLine[]>();
  for (const l of seller.payerLines) {
    const h = ctx.humans.get(l.payer);
    if (h) byHuman.set(h.nullifier, [...(byHuman.get(h.nullifier) ?? []), l]);
  }
  const dupes = [...byHuman.values()].filter((g) => g.length > 1);
  if (dupes.length > 0) {
    const ls = dupes.flat();
    flags.push({
      code: "SAME_HUMAN_PAYERS",
      severity: "warning",
      title: "Several payers are one human",
      detail: `${ls.length} payers resolve to ${count(dupes.length, "human")} through Self Agent ID. They count once toward payer diversity.`,
      addresses: ls.map((l) => l.payer).slice(0, 10),
    });
  }
  const credited = seller.payerLines.filter((l) => l.creditedUsd > 0);
  const top = credited.reduce((m, l) => Math.max(m, l.creditedUsd), 0);
  if (seller.organicUsd > 0 && credited.length >= 1 && top / seller.organicUsd >= 0.75 && seller.payers > 1) {
    flags.push({
      code: "CONCENTRATED_REVENUE",
      severity: "warning",
      title: "One customer dominates",
      detail: `The largest organic payer accounts for ${pct(top / seller.organicUsd)} of organic revenue.`,
    });
  }
  const single = credited.filter((l) => isSinglePurpose(l, ledger, ctx));
  if (single.length >= 2) {
    flags.push({
      code: "SINGLE_PURPOSE_PAYERS",
      severity: "info",
      title: "Wallets created just to pay",
      detail: `${single.length} payers were first seen less than a day before paying and never paid anyone else. They count half toward payer diversity.`,
      addresses: single.map((l) => l.payer).slice(0, 10),
    });
  }
  const established = credited.filter((l) => l.established);
  if (established.length > 0 && quality >= 0.5) {
    const usd = sum(established.map((l) => l.creditedUsd));
    flags.push({
      code: "ESTABLISHED_PAYERS",
      severity: "positive",
      title: "Paid by established wallets",
      detail: `${count(established.length, "organic payer")}, ${pct(usd / Math.max(seller.organicUsd, 1e-9))} of organic revenue, had Celo activity at least 30 days before their first payment.`,
      usd,
    });
  }
  if (fundingCoverage < 0.9) {
    flags.push({
      code: "PARTIAL_FUNDING_DATA",
      severity: "info",
      title: "Funding analysis in progress",
      detail: `Funding sources are known for ${pct(fundingCoverage)} of payers. The rest are treated as independent until checked.`,
    });
  }
  return flags;
}

function buyerSide(ledger: Ledger, b: Address): BuyerSide {
  const flows = ledger.payeesOf(b);
  const counterparties: CounterpartyLine[] = flows
    .map((f) => ({
      payee: f.payee,
      usd: f.usd,
      count: f.count,
      lastTs: f.lastTs,
      inLoop: ledger.sameComponent(b, f.payee),
    }))
    .sort((x, y) => y.usd - x.usd);
  return {
    spentUsd: sum(counterparties.map((c) => c.usd)),
    loopSpendUsd: sum(counterparties.filter((c) => c.inLoop).map((c) => c.usd)),
    settlements: sum(counterparties.map((c) => c.count)),
    sellers: counterparties.length,
    firstTs: minOf(flows.map((f) => f.firstTs)),
    lastTs: maxOf(flows.map((f) => f.lastTs)),
    counterparties,
  };
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2, positive: 3 } as const;

function sortFlags(flags: Flag[]): Flag[] {
  return flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function takeTxs(lines: PayerLine[]): Hash[] {
  return lines.flatMap((l) => l.sampleTxs.slice(0, 1)).slice(0, 5);
}

function sum(xs: number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}

function minOf(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((m, x) => (x < m ? x : m), Number.POSITIVE_INFINITY);
}

function maxOf(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((m, x) => (x > m ? x : m), Number.NEGATIVE_INFINITY);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function pct(x: number): string {
  if (!Number.isFinite(x)) return "0%";
  const p = x * 100;
  return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
}
