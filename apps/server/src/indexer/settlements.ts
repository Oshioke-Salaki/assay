import {
  dayOf,
  EIP3009_TOKENS,
  INDEX_START_BLOCK,
  type Settlement,
  TOPICS,
  X402_PERMIT2_PROXY,
} from "@assay/core";
import { type DB, getCursor, setCursor } from "../db.js";
import type { FxRates } from "../enrich/fx.js";
import { log } from "../lib/log.js";
import { extractSettlements } from "./extract.js";
import type { SqdClient, SqdQuery } from "./sqd.js";

export const SETTLEMENT_CURSOR = "settlements";

const FIELDS = {
  block: { number: true, timestamp: true },
  transaction: { hash: true, from: true, to: true, status: true, transactionIndex: true },
  log: {
    address: true,
    topics: true,
    data: true,
    logIndex: true,
    transactionIndex: true,
    transactionHash: true,
  },
};

export function settlementQuery(fromBlock: number, toBlock: number): SqdQuery {
  return {
    type: "evm",
    fromBlock,
    toBlock,
    fields: FIELDS,
    logs: [
      {
        address: [...EIP3009_TOKENS],
        topic0: [TOPICS.authorizationUsed],
        transaction: true,
        transactionLogs: true,
      },
    ],
    transactions: [{ to: [X402_PERMIT2_PROXY], logs: true }],
  };
}

export class SettlementIndexer {
  private readonly insert;
  private readonly upsertPairDay;
  private readonly upsertRelayer;

  constructor(
    private readonly db: DB,
    private readonly sqd: SqdClient,
    private readonly fx: FxRates,
    private readonly opts: {
      fromBlock?: number;
      toBlock?: number;
      onIngest?: (rows: Settlement[]) => void;
    } = {},
  ) {
    this.insert = db.prepare(
      `INSERT OR IGNORE INTO settlements (tx_hash, log_index, block, ts, relayer, token, payer, payee, amount, usd, scored)
       VALUES (@txHash, @logIndex, @block, @ts, @relayer, @token, @payer, @payee, @amount, @usd, 1)`,
    );
    this.upsertPairDay = db.prepare(
      `INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx)
       VALUES (@payer, @payee, @day, 1, @usd, @ts, @ts, @txHash)
       ON CONFLICT (payer, payee, day) DO UPDATE SET
         count = count + 1,
         usd = usd + excluded.usd,
         first_ts = MIN(first_ts, excluded.first_ts),
         last_tx = CASE WHEN excluded.last_ts >= last_ts THEN excluded.last_tx ELSE last_tx END,
         last_ts = MAX(last_ts, excluded.last_ts)`,
    );
    this.upsertRelayer = db.prepare(
      `INSERT INTO relayers (address, settlements, usd, first_block, last_block) VALUES (@relayer, 1, @usd, @block, @block)
       ON CONFLICT (address) DO UPDATE SET settlements = settlements + 1, usd = usd + excluded.usd,
         first_block = MIN(first_block, excluded.first_block), last_block = MAX(last_block, excluded.last_block)`,
    );
  }

  get cursor(): number {
    return getCursor(this.db, SETTLEMENT_CURSOR) ?? (this.opts.fromBlock ?? INDEX_START_BLOCK) - 1;
  }

  /** Index from the cursor to the finalized head (or toBlock). Returns settlements added. */
  async step(head: number, signal?: AbortSignal): Promise<number> {
    const from = this.cursor + 1;
    const to = Math.min(head, this.opts.toBlock ?? Number.POSITIVE_INFINITY);
    if (from > to) return 0;

    let pending: Settlement[] = [];
    let lastBlock = from - 1;
    let lastTs: number | null = null;
    let added = 0;
    let lastFlush = Date.now();

    const flush = () => {
      const rows = pending;
      pending = [];
      const fresh: Settlement[] = [];
      this.db.transaction(() => {
        for (const s of rows) {
          if (this.insert.run(s).changes === 0) continue; // already indexed
          this.upsertPairDay.run({ ...s, day: dayOf(s.ts) });
          this.upsertRelayer.run(s);
          fresh.push(s);
        }
        setCursor(this.db, SETTLEMENT_CURSOR, lastBlock, lastTs);
      })();
      added += fresh.length;
      lastFlush = Date.now();
      if (fresh.length > 0) this.opts.onIngest?.(fresh);
    };

    for await (const block of this.sqd.stream(settlementQuery(from, to))) {
      if (signal?.aborted) break;
      pending.push(...extractSettlements(block, this.fx.rate));
      lastBlock = block.header.number;
      lastTs = block.header.timestamp;
      if (pending.length >= 5_000 || Date.now() - lastFlush > 5_000) {
        flush();
        log.info("settlements progress", { block: lastBlock, added, behind: to - lastBlock });
      }
    }
    // The cursor only moves to blocks the portal actually sent, so a stream that ends
    // early (portal head behind ours, abort) never skips a block.
    flush();
    return added;
  }
}
