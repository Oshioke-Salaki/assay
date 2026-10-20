import { NextResponse } from "next/server";
import { API_INTERNAL } from "@/lib/api";

/** The only free API reads the browser makes, relayed so they work from any domain the site is on. */
const ALLOWED = [/^v1\/proof\/0x[0-9a-fA-F]{64}$/, /^v1\/agents\/\d{1,12}\/payments\/0x[0-9a-fA-F]{40}$/];

/**
 * Relay one allow-listed read to the Assay API. The visitor's own IP goes along in
 * `x-assay-client-ip`, so the API rate-limits each visitor, not the site as a whole.
 */
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!ALLOWED.some((r) => r.test(path))) {
    return NextResponse.json({ error: "not_found", message: "Unknown route." }, { status: 404 });
  }
  const key = process.env.ASSAY_INTERNAL_KEY;
  // On Vercel the first x-forwarded-for entry is the visitor, set by the platform.
  const visitor =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "";
  const headers: Record<string, string> = { accept: "application/json" };
  if (key && visitor) {
    headers["x-assay-internal"] = key;
    headers["x-assay-client-ip"] = visitor;
  }
  try {
    const res = await fetch(`${API_INTERNAL}/${path}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    const out = new NextResponse(body, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
    const retry = res.headers.get("retry-after");
    if (retry) out.headers.set("retry-after", retry);
    return out;
  } catch {
    return NextResponse.json(
      { error: "unreachable", message: "The Assay API did not answer in time." },
      { status: 504 },
    );
  }
}
