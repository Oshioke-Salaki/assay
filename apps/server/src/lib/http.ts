import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds from a Retry-After header, when the server sent one. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

function retryAfterSeconds(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : null;
}

export async function fetchJson<T>(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string>; init?: RequestInit } = {},
): Promise<T> {
  const res = await fetchWithTimeout(url, { ...opts.init, headers: opts.headers }, opts.timeoutMs ?? 15_000);
  if (!res.ok)
    throw new HttpError(res.status, `${res.status} from ${new URL(url).host}`, retryAfterSeconds(res));
  return (await res.json()) as T;
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80") ||
    v6.startsWith("ff")
  );
}

/**
 * Fetch a URL taken from onchain data (an agent's registration file). Only
 * public https hosts, no redirects to elsewhere, bounded size and time, so a
 * hostile agentURI cannot point the server at its own network.
 */
export async function fetchUntrusted(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("only https is fetched");
  if (parsed.username || parsed.password) throw new Error("credentials in URL");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error("host resolves to a private address");
  }
  const res = await fetchWithTimeout(
    parsed.toString(),
    { redirect: "manual", headers: { accept: "application/json" } },
    opts.timeoutMs ?? 6_000,
  );
  if (res.status >= 300 && res.status < 400) throw new Error("redirects are not followed");
  if (!res.ok) throw new HttpError(res.status, `${res.status} from ${parsed.host}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error("response too large");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
