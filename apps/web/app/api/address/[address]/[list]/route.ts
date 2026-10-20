import { NextResponse } from "next/server";
import { type AddressResponse, API_INTERNAL } from "@/lib/api";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LISTS = new Set(["payers", "counterparties"]);

function headers(): Record<string, string> {
  const key = process.env.ASSAY_INTERNAL_KEY;
  return key ? { accept: "application/json", "x-assay-internal": key } : { accept: "application/json" };
}

function clamp(v: string | null, lo: number, hi: number, d: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

/**
 * One page of "who paid it" or "who it paid", for the table on a report. Uses the API's paged
 * endpoint; against an older API without it, pages through the report the API already returns.
 */
export async function GET(req: Request, ctx: { params: Promise<{ address: string; list: string }> }) {
  const { address, list } = await ctx.params;
  if (!ADDRESS.test(address) || !LISTS.has(list)) {
    return NextResponse.json({ error: "bad_request", message: "Unknown list or address." }, { status: 400 });
  }
  const url = new URL(req.url);
  const limit = clamp(url.searchParams.get("limit"), 1, 50, 20);
  const offset = clamp(url.searchParams.get("offset"), 0, 1_000_000, 0);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 42);
  const cls = url.searchParams.get("class") ?? "all";
  const loop = url.searchParams.get("loop") ?? "";
  const a = address.toLowerCase();

  try {
    const upstream = new URL(`${API_INTERNAL}/v1/address/${a}/${list}`);
    for (const [k, v] of Object.entries({
      limit: String(limit),
      offset: String(offset),
      q,
      class: cls,
      loop,
    })) {
      if (v) upstream.searchParams.set(k, v);
    }
    const res = await fetch(upstream, {
      headers: headers(),
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return NextResponse.json(await res.json());
    if (res.status !== 404) {
      return NextResponse.json(
        { error: "upstream", message: `The Assay API answered ${res.status}.` },
        { status: 502 },
      );
    }
    // Older API: page through the lines included in the full report.
    const full = await fetch(`${API_INTERNAL}/v1/address/${a}`, {
      headers: headers(),
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(10_000),
    });
    if (!full.ok)
      return NextResponse.json(
        { error: "upstream", message: `The Assay API answered ${full.status}.` },
        { status: 502 },
      );
    const body = (await full.json()) as AddressResponse;
    if (list === "payers") {
      const all = body.assessment.seller.payerLines;
      const rows = all.filter(
        (l) =>
          (!q || l.payer.includes(q) || (l.funder ?? "").includes(q)) && (cls === "all" || l.class === cls),
      );
      const counts: Record<string, number> = {
        all: all.length,
        organic: 0,
        loop: 0,
        "seller-funded": 0,
        "shared-funder": 0,
      };
      for (const l of all) counts[l.class] = (counts[l.class] ?? 0) + 1;
      return NextResponse.json({
        total: rows.length,
        counts,
        offset,
        limit,
        rows: rows.slice(offset, offset + limit),
      });
    }
    const all = body.assessment.buyer.counterparties;
    const rows = all.filter((x) => (!q || x.payee.includes(q)) && (loop !== "1" || x.inLoop));
    return NextResponse.json({
      total: rows.length,
      all: all.length,
      offset,
      limit,
      rows: rows.slice(offset, offset + limit),
    });
  } catch {
    return NextResponse.json(
      { error: "unreachable", message: "The Assay API did not answer in time." },
      { status: 504 },
    );
  }
}
