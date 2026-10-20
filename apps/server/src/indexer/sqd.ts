import { log } from "../lib/log.js";

/** Shapes returned by the SQD Portal EVM stream for the fields Assay requests. */
export interface SqdLog {
  logIndex: number;
  transactionIndex: number;
  transactionHash: string;
  address: string;
  topics: string[];
  data: string;
}

export interface SqdTransaction {
  transactionIndex: number;
  hash: string;
  from: string;
  to: string | null;
  status?: number;
}

export interface SqdBlock {
  header: { number: number; timestamp: number };
  transactions?: SqdTransaction[];
  logs?: SqdLog[];
}

export type SqdQuery = Record<string, unknown> & { fromBlock: number; toBlock?: number };

export interface SqdHead {
  number: number;
  hash: string;
}

/** Timeouts, rate limits and every 5xx (the portal answers 529 when overloaded) are worth retrying. */
export function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export class SqdClient {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { timeoutMs?: number; maxRetries?: number } = {},
  ) {}

  async finalizedHead(): Promise<SqdHead> {
    const res = await this.request(`${this.baseUrl}/finalized-head`, { method: "GET" });
    const body = (await res.json()) as SqdHead | null;
    if (!body || typeof body.number !== "number") throw new Error("SQD finalized-head returned no block");
    return body;
  }

  /**
   * Stream finalized blocks from query.fromBlock to query.toBlock. The portal ends a
   * response whenever it likes, so this keeps asking from the next block until the
   * range is done. Blocks with no matching items are only sent as headers.
   */
  async *stream(query: SqdQuery): AsyncGenerator<SqdBlock> {
    let from = query.fromBlock;
    const to = query.toBlock;
    while (to === undefined || from <= to) {
      const res = await this.request(`${this.baseUrl}/finalized-stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "accept-encoding": "gzip" },
        body: JSON.stringify({ ...query, fromBlock: from }),
      });
      if (res.status === 204) return; // nothing finalized past `from` yet
      let last = -1;
      for await (const block of parseNdjson<SqdBlock>(res)) {
        last = block.header.number;
        yield block;
      }
      if (last < from) return; // empty body: caught up
      from = last + 1;
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const maxRetries = this.opts.maxRetries ?? 12;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 120_000);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (res.ok || res.status === 204) return res;
        const text = await res.text().catch(() => "");
        if (!isRetryable(res.status) || attempt >= maxRetries) {
          throw new Error(`SQD ${res.status} ${url}: ${text.slice(0, 300)}`);
        }
        const hinted = Number(res.headers.get("retry-after"));
        log.warn("sqd retry", { status: res.status, attempt });
        clearTimeout(timer);
        await sleep(
          Math.min(60_000, Math.max(Number.isFinite(hinted) ? hinted * 1000 : 0, 1_000 * 2 ** attempt)),
        );
        continue;
      } catch (err) {
        if (attempt >= maxRetries || (err instanceof Error && err.message.startsWith("SQD "))) throw err;
        log.warn("sqd retry", { error: String(err), attempt });
      } finally {
        clearTimeout(timer);
      }
      await sleep(Math.min(60_000, 1_000 * 2 ** attempt));
    }
  }
}

async function* parseNdjson<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as T;
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  const rest = buffer.trim();
  if (rest) yield JSON.parse(rest) as T;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
