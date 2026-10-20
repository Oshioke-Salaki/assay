import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DB } from "../db.js";
import { log } from "./log.js";

/**
 * Multicall chunking for the paid gateway. viem's `batchSize` counts raw calldata bytes; ABI and hex
 * encoding inflate that about 12x in the JSON body. 4 KB of calldata comes to about 50 KB per request,
 * under the gateway's 128 KiB cap with room to spare (test/buy.test.ts measures it).
 */
export const PAID_MULTICALL_BATCH = 4 * 1024;

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
        .prepare("SELECT COALESCE(SUM(usd), 0) AS s FROM paid_calls WHERE ts >= ? AND tx_hash IS NOT NULL")
        .get(since) as {
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
