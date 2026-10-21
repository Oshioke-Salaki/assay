import { type Address, TOKENS } from "assayscore-core";
import { fetchJson, HttpError } from "../lib/http.js";

/** Tokens whose arrival counts as "funding". Arbitrary airdropped tokens do not. */
const FUNDING_TOKENS = new Set<string>([
  ...TOKENS.map((t) => t.address),
  "0x471ece3750da237f93b8e339c536989b8978a438", // CELO (ERC-20 view of the native token)
  "0x765de816845861e75a25fca122bb6898b8b1282a", // USDm (formerly cUSD)
  "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73", // EURm
  "0xe8537a3d056da446677b9e9d6c5db704eaab4787", // BRLm
]);

interface TxListItem {
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  isError?: string;
}

interface TokenTxItem extends TxListItem {
  contractAddress: string;
}

interface ApiList<T> {
  status: string;
  message: string;
  result: T[] | string;
}

export interface FundingResult {
  funder: Address | null;
  fundedAt: number | null;
  firstSeenAt: number | null;
}

export interface FunderProfile {
  isPublic: boolean;
  reason: string;
}

/** A token bucket shared by every Blockscout call so the public API is never flooded. */
class RateLimiter {
  private next = 0;
  constructor(private readonly perSecond: number) {}
  /** Push every caller back after a 429 so the whole client slows down, not just one request. */
  pause(ms: number): void {
    this.next = Math.max(this.next, Date.now() + ms);
  }

  async take(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + 1000 / this.perSecond;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }
}

export class Blockscout {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly baseUrl: string,
    rps: number,
  ) {
    this.limiter = new RateLimiter(rps);
  }

  /** Earliest inbound CELO or stablecoin transfer, and the first activity of any kind. */
  async funding(address: Address): Promise<FundingResult> {
    const [txs, tokenTxs] = await Promise.all([
      this.list<TxListItem>({
        module: "account",
        action: "txlist",
        address,
        sort: "asc",
        page: "1",
        offset: "50",
      }),
      this.list<TokenTxItem>({
        module: "account",
        action: "tokentx",
        address,
        sort: "asc",
        page: "1",
        offset: "100",
      }),
    ]);
    const candidates: { from: string; ts: number }[] = [];
    for (const t of txs) {
      if (t.to?.toLowerCase() === address && t.isError !== "1" && t.value !== "0" && t.from) {
        candidates.push({ from: t.from.toLowerCase(), ts: Number(t.timeStamp) });
      }
    }
    for (const t of tokenTxs) {
      if (
        t.to?.toLowerCase() === address &&
        t.value !== "0" &&
        FUNDING_TOKENS.has(t.contractAddress?.toLowerCase()) &&
        t.from
      ) {
        candidates.push({ from: t.from.toLowerCase(), ts: Number(t.timeStamp) });
      }
    }
    const firsts = [txs[0], tokenTxs[0]]
      .filter((t): t is TxListItem => !!t)
      .map((t) => Number(t.timeStamp))
      .filter((n) => Number.isFinite(n) && n > 0);
    candidates.sort((a, b) => a.ts - b.ts);
    const first = candidates.find(
      (c) => c.from !== address && c.from !== "0x0000000000000000000000000000000000000000",
    );
    return {
      funder: (first?.from as Address | undefined) ?? null,
      fundedAt: first?.ts ?? null,
      firstSeenAt: firsts.length ? Math.min(...firsts) : null,
    };
  }

  /** Contracts (bridges, faucets, smart-wallet factories) and very busy wallets fund many unrelated people. */
  async funderProfile(address: Address): Promise<FunderProfile> {
    const info = await this.v2<{
      is_contract?: boolean;
      name?: string | null;
      metadata?: { tags?: unknown[] };
    }>(`/api/v2/addresses/${address}`);
    if (info.is_contract) return { isPublic: true, reason: `contract${info.name ? ` ${info.name}` : ""}` };
    if ((info.metadata?.tags?.length ?? 0) > 0) return { isPublic: true, reason: "tagged on Blockscout" };
    const counters = await this.v2<{ transactions_count?: string; token_transfers_count?: string }>(
      `/api/v2/addresses/${address}/counters`,
    );
    const txs = Number(counters.transactions_count ?? 0);
    const transfers = Number(counters.token_transfers_count ?? 0);
    if (txs >= 5_000 || transfers >= 20_000) return { isPublic: true, reason: `${txs} transactions` };
    return { isPublic: false, reason: `${txs} transactions` };
  }

  private async list<T>(params: Record<string, string>): Promise<T[]> {
    const qs = new URLSearchParams(params).toString();
    const body = await this.get<ApiList<T>>(`/api?${qs}`);
    if (Array.isArray(body.result)) return body.result;
    // "No transactions found" is a normal empty answer; anything else is an error.
    if (body.status === "0" && /no (token )?transfers|no transactions/i.test(body.message)) return [];
    throw new Error(
      `Blockscout: ${body.message} ${typeof body.result === "string" ? body.result : ""}`.trim(),
    );
  }

  private v2<T>(path: string): Promise<T> {
    return this.get<T>(path);
  }

  private async get<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.take();
      try {
        return await fetchJson<T>(`${this.baseUrl}${path}`, { timeoutMs: 20_000 });
      } catch (err) {
        const retryable = !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
        if (!retryable || attempt >= 6) throw err;
        const hinted = err instanceof HttpError && err.retryAfter !== null ? err.retryAfter * 1000 : 0;
        const wait = Math.min(60_000, Math.max(hinted, 1_500 * 2 ** attempt));
        this.limiter.pause(wait);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
}
