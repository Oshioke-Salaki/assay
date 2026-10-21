import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { type Address, type Hex, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type DB, getCursor, setCursor } from "../db.js";
import { log } from "./log.js";

export class BudgetExceeded extends Error {
  constructor(spent: number, cap: number) {
    super(`Daily budget for paid services reached ($${spent.toFixed(2)} of $${cap.toFixed(2)})`);
  }
}

/**
 * A fetch that pays x402 challenges from Assay's own wallet, refuses to go past a daily
 * dollar cap, and records every settlement (service, price, transaction) in paid_calls.
 * `pricePerCallUsd` is what the service quotes; it is checked against the 402 before paying.
 */
export function createPayingFetch(opts: {
  db: DB;
  privateKey: Hex;
  service: string;
  pricePerCallUsd: number;
  dailyCapUsd: number;
  fetchImpl?: typeof fetch;
}): typeof fetch {
  const account = privateKeyToAccount(opts.privateKey);
  const maxUnits = BigInt(Math.round(opts.pricePerCallUsd * 1e6));
  // Only ever accept a requirement priced at or under the quoted price, in a 6-decimal dollar token.
  // Only ever accept a requirement priced at or under the quoted price. x402 v2 states the price as
  // `amount`; v1 (which the buy gateway speaks) as `maxAmountRequired`.
  const priceOf = (r: unknown): bigint | null => {
    const raw =
      (r as { amount?: unknown; maxAmountRequired?: unknown }).amount ??
      (r as { maxAmountRequired?: unknown }).maxAmountRequired;
    try {
      return typeof raw === "string" || typeof raw === "number" ? BigInt(raw) : null;
    } catch {
      return null;
    }
  };
  const client = new x402Client((_v, reqs) => {
    const ok = reqs.filter((r) => {
      const p = priceOf(r);
      return p !== null && p <= maxUnits;
    });
    if (ok.length === 0) throw new Error(`${opts.service} asked more than $${opts.pricePerCallUsd} per call`);
    return ok[0]!;
  })
    .register("eip155:42220", new ExactEvmScheme(account))
    .registerV1("celo", new ExactEvmSchemeV1(account));
  const base = opts.fetchImpl ?? fetch;
  const paying = wrapFetchWithPayment(base, client);
  const insert = opts.db.prepare(
    "INSERT INTO paid_calls (ts, service, url, status, usd, tx_hash, payer, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const spentToday = () => {
    const since = Math.floor(Date.now() / 86_400_000) * 86_400;
    return (
      opts.db
        .prepare(
          "SELECT COALESCE(SUM(usd), 0) AS s FROM paid_calls WHERE ts >= ? AND tx_hash IS NOT NULL AND service = ?",
        )
        .get(since, opts.service) as {
        s: number;
      }
    ).s;
  };

  // One paid request at a time: each needs its own settlement from this wallet, and the gateway
  // settles them in turn, so parallel requests only queue up behind each other and time out.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    serial(() => payOnce(input, init))) as typeof fetch;

  async function payOnce(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const spent = spentToday();
    if (spent + opts.pricePerCallUsd > opts.dailyCapUsd + 1e-9)
      throw new BudgetExceeded(spent, opts.dailyCapUsd);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let res: Response;
    try {
      res = await paying(input, init);
    } catch (err) {
      // Record the failed attempt too, so the ledger explains every call, not only the paid ones.
      const reason = String(
        err instanceof Error && err.cause ? `${err.message}: ${String(err.cause)}` : err,
      ).slice(0, 300);
      insert.run(
        Math.floor(Date.now() / 1000),
        opts.service,
        url.slice(0, 300),
        0,
        0,
        null,
        account.address.toLowerCase(),
        reason,
      );
      log.warn("paid service call failed", { service: opts.service, reason });
      throw err;
    }
    const tx = readSettlementTx(res);
    insert.run(
      Math.floor(Date.now() / 1000),
      opts.service,
      url.slice(0, 300),
      res.status,
      tx ? opts.pricePerCallUsd : 0,
      tx,
      account.address.toLowerCase(),
      res.ok ? null : `HTTP ${res.status}`,
    );
    if (tx) log.info("paid service call", { service: opts.service, usd: opts.pricePerCallUsd, tx });
    return res;
  }
}

/** The settlement transaction from an x402 v2 PAYMENT-RESPONSE (or v1 X-PAYMENT-RESPONSE) header. */
export function readSettlementTx(res: Response): string | null {
  const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { transaction?: unknown };
    return typeof parsed.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(parsed.transaction)
      ? parsed.transaction.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export interface ReconcileReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: Address;
    event: typeof TRANSFER_EVENT;
    args: { from: Address; to: Address };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<{ transactionHash: Hex | null; blockNumber: bigint | null; args: { value?: bigint } }[]>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const RECONCILE_CURSOR = "paid_calls_reconcile";

/**
 * Makes the ledger match the chain. A paid call can settle and still lose its answer (the gateway
 * resets the connection after taking payment), which leaves a row with no transaction and a spend
 * the daily cap never saw. This reads every token transfer from Assay's wallet to the gateway and
 * attaches each one to the call it paid for, or records it on its own when no call matches.
 */
export async function reconcilePaidCalls(
  db: DB,
  rpc: ReconcileReader,
  opts: { payer: Address; payTo: Address; token: Address; decimals: number; lookbackBlocks?: number },
): Promise<{ matched: number; unmatched: number; scannedTo: bigint }> {
  // A few blocks behind the tip, so a transfer is seen once and not reorged away.
  const tip = (await rpc.getBlockNumber()) - 5n;
  const cursor = getCursor(db, RECONCILE_CURSOR);
  let from = cursor === null ? tip - BigInt(opts.lookbackBlocks ?? 7_200) : BigInt(cursor) + 1n;
  let matched = 0;
  let unmatched = 0;
  const known = db.prepare("SELECT 1 FROM paid_calls WHERE tx_hash = ?");
  // The failed call that a payment belongs to was recorded at most ten minutes after it settled.
  const candidate = db.prepare(
    `SELECT id FROM paid_calls WHERE tx_hash IS NULL AND payer = ? AND ts BETWEEN ? AND ?
     ORDER BY ABS(ts - ?) LIMIT 1`,
  );
  const attach = db.prepare(
    "UPDATE paid_calls SET tx_hash = ?, usd = ?, note = COALESCE(note, '') || ' (settled onchain; answer lost)' WHERE id = ?",
  );
  const orphan = db.prepare(
    "INSERT INTO paid_calls (ts, service, url, status, usd, tx_hash, payer, note) VALUES (?, 'unmatched', '', 0, ?, ?, ?, 'payment found onchain with no recorded call')",
  );
  while (from <= tip) {
    const to = from + 1_999n < tip ? from + 1_999n : tip;
    const logs = await rpc.getLogs({
      address: opts.token,
      event: TRANSFER_EVENT,
      args: { from: opts.payer, to: opts.payTo },
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) {
      if (!l.transactionHash || l.blockNumber === null) continue;
      const tx = l.transactionHash.toLowerCase();
      if (known.get(tx)) continue;
      const ts = Number((await rpc.getBlock({ blockNumber: l.blockNumber })).timestamp);
      const usd = Number(l.args.value ?? 0n) / 10 ** opts.decimals;
      const row = candidate.get(opts.payer.toLowerCase(), ts - 60, ts + 600, ts) as
        | { id: number }
        | undefined;
      if (row) {
        attach.run(tx, usd, row.id);
        matched++;
      } else {
        orphan.run(ts, usd, tx, opts.payer.toLowerCase());
        unmatched++;
      }
    }
    setCursor(db, RECONCILE_CURSOR, Number(to), null);
    from = to + 1n;
  }
  if (matched + unmatched > 0) log.warn("paid calls reconciled", { matched, unmatched });
  return { matched, unmatched, scannedTo: tip };
}
