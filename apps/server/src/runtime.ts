import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { celo } from "viem/chains";
import { Analysis } from "./analysis.js";
import type { IndexStatus } from "./api/app.js";
import { Attester } from "./attest.js";
import { type DB, getCursor, openDatabase } from "./db.js";
import { AgentCards } from "./enrich/agents.js";
import { Blockscout } from "./enrich/blockscout.js";
import { Enricher } from "./enrich/enricher.js";
import { FxRates } from "./enrich/fx.js";
import type { Env } from "./env.js";
import { REGISTRY_CURSOR, RegistryIndexer } from "./indexer/registry.js";
import { SETTLEMENT_CURSOR, SettlementIndexer } from "./indexer/settlements.js";
import { SqdClient, sleep } from "./indexer/sqd.js";
import { createPayingFetch } from "./lib/buy.js";
import { log } from "./lib/log.js";

export interface Runtime {
  env: Env;
  db: DB;
  fx: FxRates;
  rpc: PublicClient;
  analysis: Analysis;
  attester: Attester | null;
  status: () => IndexStatus;
  /** Index until caught up with the finalized head once, then return. */
  syncOnce: (signal?: AbortSignal) => Promise<{ settlements: number; registry: number }>;
  /** Run indexer and enrichment loops until the signal aborts. */
  runWorkers: (signal: AbortSignal) => Promise<void>;
  close: () => void;
}

export function createRuntime(env: Env): Runtime {
  const db = openDatabase(env.DATABASE_PATH);
  const fx = new FxRates(db);
  const rpc = createPublicClient({
    chain: celo,
    transport: fallback([
      http(env.RPC_URL, { timeout: 20_000, retryCount: 2 }),
      http("https://rpc.ankr.com/celo"),
    ]),
    batch: { multicall: true },
  }) as PublicClient;
  const analysis = new Analysis(db);
  const sqd = new SqdClient(env.SQD_URL);
  const invalidate = () => analysis.invalidate();
  const settlements = new SettlementIndexer(db, sqd, fx, {
    fromBlock: env.INDEX_FROM_BLOCK,
    toBlock: env.INDEX_TO_BLOCK,
    onIngest: invalidate,
  });
  const registry = new RegistryIndexer(db, sqd, {
    fromBlock: env.INDEX_FROM_BLOCK,
    toBlock: env.INDEX_TO_BLOCK,
    onIngest: invalidate,
  });
  // Enrichment sends large multicalls. With a buy payer key they go to Chainstack through the
  // buy gateway, one paid JSON-RPC batch per round, under a daily cap; otherwise to the free RPC.
  const enrichRpc = env.BUY_PAYER_KEY
    ? (createPublicClient({
        chain: celo,
        transport: http(env.BUY_CHAINSTACK_URL, {
          timeout: 30_000,
          retryCount: 0,
          batch: { batchSize: 2000, wait: 50 },
          fetchFn: createPayingFetch({
            db,
            privateKey: env.BUY_PAYER_KEY,
            service: "chainstack-celo-rpc",
            pricePerCallUsd: 0.01,
            dailyCapUsd: env.BUY_DAILY_CAP_USD,
          }),
        }),
        batch: { multicall: { batchSize: 1024 * 64 } },
      }) as PublicClient)
    : rpc;
  const enricher = new Enricher(
    db,
    new Blockscout(env.BLOCKSCOUT_URL, env.BLOCKSCOUT_RPS),
    enrichRpc,
    invalidate,
  );
  const cards = new AgentCards(db, env.IPFS_GATEWAY, invalidate);
  const attester =
    env.ATTESTER_PRIVATE_KEY && env.REGISTRY_ADDRESS
      ? new Attester(env.ATTESTER_PRIVATE_KEY, env.REGISTRY_ADDRESS)
      : null;
  if (env.ATTESTER_PRIVATE_KEY && !env.REGISTRY_ADDRESS) {
    log.warn("ATTESTER_PRIVATE_KEY is set without REGISTRY_ADDRESS; attestations are disabled");
  }

  let head: number | null = null;
  const status = (): IndexStatus => {
    const last = db.prepare("SELECT MAX(ts) AS ts FROM settlements").get() as { ts: number | null };
    return {
      settlementsBlock: getCursor(db, SETTLEMENT_CURSOR) ?? 0,
      registryBlock: getCursor(db, REGISTRY_CURSOR) ?? 0,
      finalizedHead: head,
      lastSettlementTs: last.ts,
    };
  };

  const syncOnce = async (signal?: AbortSignal) => {
    await fx.refresh(env.FX_URL);
    head = (await sqd.finalizedHead()).number;
    const s = await settlements.step(head, signal);
    const r = await registry.step(head, signal);
    return { settlements: s, registry: r };
  };

  const runWorkers = async (signal: AbortSignal) => {
    const indexLoop = async () => {
      while (!signal.aborted) {
        try {
          const { settlements: added } = await syncOnce(signal);
          if (added > 0) log.info("indexed", { added, cursor: status().settlementsBlock, head });
        } catch (err) {
          log.error("index loop failed", { error: String(err) });
        }
        await sleep(env.INDEX_POLL_MS, signal);
      }
    };
    await Promise.all([indexLoop(), enricher.run(signal), cards.run(signal)]);
  };

  return {
    env,
    db,
    fx,
    rpc,
    analysis,
    attester,
    status,
    syncOnce,
    runWorkers,
    close: () => db.close(),
  };
}
