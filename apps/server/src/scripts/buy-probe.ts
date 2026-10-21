/**
 * One paid JSON-RPC call to Chainstack through the buy gateway, from BUY_PAYER_KEY, to prove the
 * paid transport works end to end. Costs $0.01. Records the call in the local paid_calls table.
 *
 *   pnpm --filter @assay/server exec tsx src/scripts/buy-probe.ts
 */
import { SELF_AGENT_REGISTRY, selfAgentRegistryAbi } from "assayscore-core";
import { createPublicClient, http, pad } from "viem";
import { celo } from "viem/chains";
import { openDatabase } from "../db.js";
import { loadEnv } from "../env.js";
import { createPayingFetch, PAID_MULTICALL_BATCH } from "../lib/buy.js";

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
if (process.argv.includes("--multicall")) {
  // The production enrichment shape: 300 Self Agent ID lookups, chunked for the gateway.
  const mc = createPublicClient({
    chain: celo,
    transport: http(url, { fetchFn, timeout: 120_000, retryCount: 0 }),
    batch: { multicall: { batchSize: PAID_MULTICALL_BATCH } },
  });
  const addrs = Array.from(
    { length: 300 },
    (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`,
  );
  const res = await mc.multicall({
    allowFailure: true,
    contracts: addrs.map((a) => ({
      address: SELF_AGENT_REGISTRY,
      abi: selfAgentRegistryAbi,
      functionName: "agentKeyToAgentId" as const,
      args: [pad(a, { size: 32 })] as const,
    })),
  });
  const ok = res.filter((r) => r.status === "success").length;
  console.log(
    `multicall: ${res.length} lookups, ${ok} succeeded${ok < res.length ? `, first error: ${String((res.find((r) => r.status === "failure") as { error?: unknown })?.error).slice(0, 300)}` : ""}`,
  );
}
console.log(
  db.prepare("SELECT service, status, usd, tx_hash AS tx FROM paid_calls ORDER BY id DESC LIMIT 6").all(),
);
db.close();
