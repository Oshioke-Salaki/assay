import type { Hex } from "viem";
import { log } from "../lib/log.js";
import type { SqdBlock, SqdClient, SqdHead, SqdLog, SqdQuery, SqdTransaction } from "./sqd.js";

/** The slice of a viem PublicClient this source uses, so tests can pass a fake. */
export interface RpcReader {
  getBlock(
    args: { blockTag: "finalized" } | { blockNumber: bigint },
  ): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
  getLogs(args: {
    address?: Hex | Hex[];
    fromBlock: bigint;
    toBlock: bigint;
    topics?: (Hex | Hex[] | null)[];
  }): Promise<RpcLog[]>;
  getTransactionReceipt(args: { hash: Hex }): Promise<RpcReceipt>;
}

export interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  transactionIndex: number | null;
  logIndex: number | null;
}

export interface RpcReceipt {
  transactionHash: Hex;
  transactionIndex: number;
  blockNumber: bigint;
  from: Hex;
  to: Hex | null;
  status: "success" | "reverted";
  logs: RpcLog[];
}

interface LogFilter {
  address?: string[];
  topic0?: string[];
  transaction?: boolean;
  transactionLogs?: boolean;
}

interface TxFilter {
  to?: string[];
  logs?: boolean;
}

/**
 * Serves the SQD portal queries this indexer makes from plain JSON-RPC, for when the portal is
 * down. Log filters map to eth_getLogs; a transaction filter on `to` (the x402 Permit2 proxy) maps
 * to the logs that contract emits on every settle. Receipts supply sender, status and all logs.
 * Output is shaped exactly like the portal's, so the same extraction code runs on it.
 */
export class RpcSource {
  private readonly blockTs = new Map<bigint, number>();

  constructor(
    private readonly rpc: RpcReader,
    private readonly opts: { chunkBlocks?: number } = {},
  ) {}

  async finalizedHead(): Promise<SqdHead> {
    const b = await this.rpc.getBlock({ blockTag: "finalized" });
    if (b.number === null) throw new Error("RPC returned no finalized block");
    return { number: Number(b.number), hash: b.hash ?? "0x" };
  }

  async *stream(query: SqdQuery): AsyncGenerator<SqdBlock> {
    const chunk = this.opts.chunkBlocks ?? 2_000;
    const to = query.toBlock ?? (await this.finalizedHead()).number;
    for (let from = query.fromBlock; from <= to; from += chunk) {
      const end = Math.min(to, from + chunk - 1);
      for (const block of await this.range(query, from, end)) yield block;
      // An empty range still advances the caller's cursor, as the portal's headers do.
      if (end === to) yield await this.header(end);
    }
  }

  private async range(query: SqdQuery, from: number, to: number): Promise<SqdBlock[]> {
    const fromBlock = BigInt(from);
    const toBlock = BigInt(to);
    const logFilters = (query.logs as LogFilter[] | undefined) ?? [];
    const txFilters = (query.transactions as TxFilter[] | undefined) ?? [];
    const matched: RpcLog[] = [];
    const wantReceipt = new Set<Hex>();

    for (const f of logFilters) {
      const logs = await this.rpc.getLogs({
        address: f.address as Hex[] | undefined,
        fromBlock,
        toBlock,
        topics: f.topic0 ? [f.topic0 as Hex[]] : undefined,
      });
      for (const l of logs) {
        matched.push(l);
        if ((f.transaction || f.transactionLogs) && l.transactionHash) wantReceipt.add(l.transactionHash);
      }
    }
    for (const f of txFilters) {
      if (!f.to?.length) continue;
      const logs = await this.rpc.getLogs({ address: f.to as Hex[], fromBlock, toBlock });
      for (const l of logs) if (l.transactionHash) wantReceipt.add(l.transactionHash);
    }

    const byBlock = new Map<number, SqdBlock>();
    const blockFor = async (n: bigint): Promise<SqdBlock> => {
      const key = Number(n);
      let b = byBlock.get(key);
      if (!b) {
        b = { header: { number: key, timestamp: await this.timestamp(n) }, transactions: [], logs: [] };
        byBlock.set(key, b);
      }
      return b;
    };

    const withReceipt = new Set<string>();
    for (const hash of wantReceipt) {
      const r = await this.rpc.getTransactionReceipt({ hash });
      const b = await blockFor(r.blockNumber);
      const tx: SqdTransaction = {
        transactionIndex: r.transactionIndex,
        hash: r.transactionHash,
        from: r.from,
        to: r.to,
        status: r.status === "success" ? 1 : 0,
      };
      b.transactions!.push(tx);
      for (const l of r.logs) b.logs!.push(toSqdLog(l, r.transactionIndex));
      withReceipt.add(r.transactionHash.toLowerCase());
    }
    // Logs whose filter asked for no transaction (the ERC-8004 registries) are passed through as is.
    for (const l of matched) {
      if (l.blockNumber === null || (l.transactionHash && withReceipt.has(l.transactionHash.toLowerCase())))
        continue;
      (await blockFor(l.blockNumber)).logs!.push(toSqdLog(l, l.transactionIndex ?? 0));
    }
    for (const b of byBlock.values()) b.logs!.sort((x, y) => x.logIndex - y.logIndex);
    return [...byBlock.values()].sort((a, b) => a.header.number - b.header.number);
  }

  private async header(n: number): Promise<SqdBlock> {
    return { header: { number: n, timestamp: await this.timestamp(BigInt(n)) } };
  }

  private async timestamp(n: bigint): Promise<number> {
    const hit = this.blockTs.get(n);
    if (hit !== undefined) return hit;
    const b = await this.rpc.getBlock({ blockNumber: n });
    const ts = Number(b.timestamp);
    if (this.blockTs.size > 10_000) this.blockTs.clear();
    this.blockTs.set(n, ts);
    return ts;
  }
}

function toSqdLog(l: RpcLog, transactionIndex: number): SqdLog {
  return {
    logIndex: l.logIndex ?? 0,
    transactionIndex,
    transactionHash: (l.transactionHash ?? "0x").toLowerCase(),
    address: l.address.toLowerCase(),
    topics: l.topics,
    data: l.data,
  };
}

/**
 * The portal first; if it fails after its own retries, the RPC source for that step. Large gaps
 * (a cold backfill) are not worth replaying over RPC, so the fallback only covers ranges up to
 * `maxFallbackBlocks` from the start of the request.
 */
export class FailoverSource {
  constructor(
    private readonly primary: SqdClient,
    private readonly fallback: RpcSource,
    private readonly opts: { maxFallbackBlocks?: number } = {},
  ) {}

  async finalizedHead(): Promise<SqdHead> {
    try {
      return await this.primary.finalizedHead();
    } catch (err) {
      log.warn("sqd head failed, using rpc", { error: String(err).slice(0, 200) });
      return this.fallback.finalizedHead();
    }
  }

  async *stream(query: SqdQuery): AsyncGenerator<SqdBlock> {
    let last = query.fromBlock - 1;
    try {
      for await (const b of this.primary.stream(query)) {
        last = b.header.number;
        yield b;
      }
      return;
    } catch (err) {
      const to = Math.min(
        query.toBlock ?? Number.POSITIVE_INFINITY,
        last + (this.opts.maxFallbackBlocks ?? 20_000),
      );
      log.warn("sqd stream failed, continuing over rpc", {
        from: last + 1,
        to,
        error: String(err).slice(0, 200),
      });
      for await (const b of this.fallback.stream({
        ...query,
        fromBlock: last + 1,
        toBlock: Number.isFinite(to) ? to : undefined,
      })) {
        yield b;
      }
    }
  }
}
