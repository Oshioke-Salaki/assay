import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DB } from "../db.js";
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
  const client = new x402Client((_v, reqs) => {
    const ok = reqs.filter((r) => {
      try {
        return BigInt(r.amount) <= maxUnits;
      } catch {
        return false;
      }
    });
    if (ok.length === 0) throw new Error(`${opts.service} asked more than $${opts.pricePerCallUsd} per call`);
    return ok[0]!;
  }).register("eip155:42220", new ExactEvmScheme(account));
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

  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const spent = spentToday();
    if (spent + opts.pricePerCallUsd > opts.dailyCapUsd + 1e-9)
      throw new BudgetExceeded(spent, opts.dailyCapUsd);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await paying(input, init);
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
  }) as typeof fetch;
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
