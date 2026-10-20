/**
 * One paid JSON-RPC call to Chainstack through the buy gateway, from BUY_PAYER_KEY, to prove the
 * paid transport works end to end. Costs $0.01. Records the call in the local paid_calls table.
 *
 *   pnpm --filter @assay/server exec tsx src/scripts/buy-probe.ts
 */
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
import { openDatabase } from "../db.js";
import { loadEnv } from "../env.js";
import { createPayingFetch } from "../lib/buy.js";

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}
const env = loadEnv();
if (!env.BUY_PAYER_KEY) throw new Error("Set BUY_PAYER_KEY");
const db = openDatabase(env.DATABASE_PATH);
const url = env.BUY_CHAINSTACK_URL;

const probe = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
});
console.log(
  "unpaid probe:",
  probe.status,
  probe.headers.get("payment-required") ? "PAYMENT-REQUIRED header present" : "no payment header",
);

const fetchFn = createPayingFetch({
  db,
  privateKey: env.BUY_PAYER_KEY,
  service: "chainstack-celo-rpc",
  pricePerCallUsd: 0.01,
  dailyCapUsd: env.BUY_DAILY_CAP_USD,
});
const client = createPublicClient({
  chain: celo,
  transport: http(url, { fetchFn, timeout: 60_000, retryCount: 0 }),
});
const t0 = Date.now();
try {
  console.log("block via paid Chainstack:", await client.getBlockNumber(), `${Date.now() - t0} ms`);
} catch (e) {
  console.log("FAILED:", String(e).slice(0, 800));
}
console.log(
  db
    .prepare("SELECT service, status, usd, tx_hash AS tx, note FROM paid_calls ORDER BY id DESC LIMIT 3")
    .all(),
);
db.close();
