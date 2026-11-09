import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPrivateIp } from "assayscore-core";

// One classifier for every outbound check, shared with the claim validator in assayscore-core.
export { isPrivateIp };

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

/**
 * fetch with a deadline that covers the whole response, body included: the timer keeps running
 * until the body has been read, so a server that sends headers quickly and then drips the body
 * cannot hold the caller past `timeoutMs`. A caller's own signal still aborts it.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  const caller = init.signal ?? undefined;
  const onCallerAbort = () => controller.abort(caller?.reason);
  caller?.addEventListener("abort", onCallerAbort, { once: true });
  const done = () => {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  };
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    done();
    throw err;
  }
  if (!res.body) {
    done();
    return res;
  }
  // The clock stops once the body has been read to the end; until then a timeout aborts it.
  const body = res.body.pipeThrough(new TransformStream({ flush: done }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * fetch for URLs that come from outside (agent registration files, webhook receivers), with the
 * address checked on the connection itself. DNS is resolved inside the socket's own lookup, every
 * answer must be public, and the socket connects to the address that was checked, so a host whose
 * DNS answers change between a check and a connection (DNS rebinding) cannot reach a private
 * address. https only; redirects are returned, never followed; TLS still verifies the hostname.
 * The deadline covers the whole response, body included.
 */
export function pinnedFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<Response> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.reject(new Error("not a URL"));
  }
  if (u.protocol !== "https:") return Promise.reject(new Error("only https is fetched"));
  if (u.username || u.password) return Promise.reject(new Error("credentials in URL"));
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isPrivateIp(literal))
    return Promise.reject(new Error("host resolves to a private address"));
  const timeoutMs = init.timeoutMs ?? 10_000;
  return new Promise<Response>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const req = httpsRequest(
      u,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        // Resolve, refuse any private answer, and hand the socket exactly the address that was checked.
        lookup: (hostname, opts, cb) => {
          lookup(hostname, { all: true }).then(
            (addrs) => {
              if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
                cb(new Error("host resolves to a private address"), "", 4);
                return;
              }
              const first = addrs[0]!;
              if ((opts as { all?: boolean }).all)
                (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [first]);
              else cb(null, first.address, first.family);
            },
            (err: Error) => cb(err, "", 4),
          );
        },
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
        }
        const stop = () => clearTimeout(timer);
        res.on("end", stop);
        res.on("close", stop);
        const status = res.statusCode ?? 502;
        const noBody = status === 204 || status === 304;
        if (noBody) res.resume();
        resolve(
          new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream), {
            status: status < 200 || status > 599 ? 502 : status,
            statusText: res.statusMessage,
            headers,
          }),
        );
      },
    );
    timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * Fetch a URL taken from onchain data (an agent's registration file). Only public https hosts,
 * checked on the connection itself (see pinnedFetch), no redirects, bounded size and time, so a
 * hostile agentURI cannot point the server at its own network or hold it with a slow body.
 */
export async function fetchUntrusted(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number; transport?: typeof pinnedFetch } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("only https is fetched");
  if (parsed.username || parsed.password) throw new Error("credentials in URL");
  const res = await (opts.transport ?? pinnedFetch)(parsed.toString(), {
    headers: { accept: "application/json" },
    timeoutMs: opts.timeoutMs ?? 6_000,
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error("redirects are not followed");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(res.status, `${res.status} from ${parsed.host}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new Error("response too large");
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("response too large");
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks).toString("utf8");
}
