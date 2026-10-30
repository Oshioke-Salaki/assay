import { randomBytes } from "node:crypto";
import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { Watches } from "./alerts.js";
import { Analysis } from "./analysis.js";
import type { IndexStatus } from "./api/app.js";
import { Attester } from "./attest.js";
import { type DB, getCursor, openDatabase } from "./db.js";
import { AgentCards } from "./enrich/agents.js";
import { Blockscout } from "./enrich/blockscout.js";
import { Enricher } from "./enrich/enricher.js";
import { FxRates } from "./enrich/fx.js";
import { XMentionsWatcher } from "./enrich/xmentions.js";
import type { Env } from "./env.js";
import { REGISTRY_CURSOR, RegistryIndexer } from "./indexer/registry.js";
import { FailoverSource, type RpcReader, RpcSource } from "./indexer/rpcsource.js";
import { SETTLEMENT_CURSOR, SettlementIndexer } from "./indexer/settlements.js";
import { SqdClient, sleep } from "./indexer/sqd.js";
import { createPayingFetch, type ReconcileReader, reconcilePaidCalls, serialLock } from "./lib/buy.js";
import { log } from "./lib/log.js";
import { Usage } from "./usage.js";

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
  usage: Usage;
  xmentions: XMentionsWatcher | null;
  watches: Watches | null;
  close: () => void;
}

const USDC = "0xceba9300f2b948710d2653dd7b07f33a8b32118c" as const;

export function createRuntime(env: Env): Runtime {
  const db = openDatabase(env.DATABASE_PATH);
  const fx = new FxRates(db);
  const rpc = createPublicClient({
    chain: celo,
    // RPC_URL first (Chainstack in production), then Celo's public RPC, then Ankr.
    transport: fallback([
      http(env.RPC_URL, { timeout: 20_000, retryCount: 2 }),
      ...(env.RPC_URL.includes("forno.celo.org")
        ? []
        : [http("https://forno.celo.org", { timeout: 20_000 })]),
      http("https://rpc.ankr.com/celo"),
    ]),
    batch: { multicall: true },
  }) as PublicClient;
  const analysis = new Analysis(db);
  // The salt keeps caller hashes unlinkable to addresses: a long random key that never leaves the server.
  const usage = new Usage(db, env.INTERNAL_API_KEY ?? randomBytes(32).toString("hex"));
  // SQD first; if the portal is down, the same queries are served from Celo RPC for the tail.
  const rawSqd = new SqdClient(env.SQD_URL);
  const sqd = new FailoverSource(rawSqd, new RpcSource(rpc as unknown as RpcReader));
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
  const enricher = new Enricher(
    db,
    new Blockscout(env.BLOCKSCOUT_URL, env.BLOCKSCOUT_RPS),
    rpc,
    invalidate,
    // Full-history funding scans need the portal itself; the RPC failover only serves the tail.
    { source: rawSqd, rpc, head: async () => (await rawSqd.finalizedHead()).number },
  );
  const cards = new AgentCards(db, env.IPFS_GATEWAY, invalidate, rpc);
  const attester =
    env.ATTESTER_PRIVATE_KEY && env.REGISTRY_ADDRESS
      ? new Attester(env.ATTESTER_PRIVATE_KEY, env.REGISTRY_ADDRESS)
      : null;
  if (env.ATTESTER_PRIVATE_KEY && !env.REGISTRY_ADDRESS) {
    log.warn("ATTESTER_PRIVATE_KEY is set without REGISTRY_ADDRESS; attestations are disabled");
  }

  let head: number | null = null;
  // Called on every paid request, so it must be cheap: the newest settlement comes from the block
  // index (not a scan of every row), and the whole status is cached for two seconds.
  const lastTsStmt = db.prepare("SELECT ts FROM settlements ORDER BY block DESC LIMIT 1");
  let cachedStatus: { at: number; value: IndexStatus } | null = null;
  const status = (): IndexStatus => {
    const now = Date.now();
    if (cachedStatus && now - cachedStatus.at < 2_000) return { ...cachedStatus.value, finalizedHead: head };
    const last = lastTsStmt.get() as { ts: number } | undefined;
    const value: IndexStatus = {
      settlementsBlock: getCursor(db, SETTLEMENT_CURSOR) ?? 0,
      registryBlock: getCursor(db, REGISTRY_CURSOR) ?? 0,
      finalizedHead: head,
      lastSettlementTs: last?.ts ?? null,
    };
    cachedStatus = { at: now, value };
    return value;
  };

  const syncOnce = async (signal?: AbortSignal) => {
    await fx.refresh(env.FX_URL);
    head = (await sqd.finalizedHead()).number;
    const s = await settlements.step(head, signal);
    const r = await registry.step(head, signal);
    return { settlements: s, registry: r };
  };

  // What X says about each seller, bought one search at a time through the buy gateway.
  // Both paying fetches draw on the same wallet, so they take turns through one lock.
  const payLock = serialLock();
  const xmentions =
    env.BUY_PAYER_KEY && (env.X_MENTIONS_DAILY_CAP_USD > 0 || env.X_ONDEMAND_DAILY_CAP_USD > 0)
      ? new XMentionsWatcher(db, {
          pay: createPayingFetch({
            db,
            privateKey: env.BUY_PAYER_KEY,
            service: "buy-x-search",
            pricePerCallUsd: 0.005,
            dailyCapUsd: env.X_MENTIONS_DAILY_CAP_USD,
            lock: payLock,
          }),
          payOnDemand:
            env.X_ONDEMAND_DAILY_CAP_USD > 0
              ? createPayingFetch({
                  db,
                  privateKey: env.BUY_PAYER_KEY,
                  service: "buy-x-search-ondemand",
                  pricePerCallUsd: 0.005,
                  dailyCapUsd: env.X_ONDEMAND_DAILY_CAP_USD,
                  lock: payLock,
                })
              : undefined,
          searchUrl: env.BUY_X_SEARCH_URL,
          minGrossUsd: env.X_MENTIONS_MIN_GROSS_USD,
          onChange: invalidate,
        })
      : null;

  // Rating-change alerts, offered wherever payments are (a watch is bought over x402).
  const watches =
    env.X402_API_KEY && env.PAY_TO
      ? new Watches(db, analysis, { publicUrl: env.PUBLIC_URL, webUrl: env.WEB_URL })
      : null;

  // Keeps the paid-call ledger equal to the chain: every payment from Assay's wallet to buy.
  const reconcileLoop = async (signal: AbortSignal) => {
    if (!env.BUY_PAYER_KEY) return;
    const payer = privateKeyToAccount(env.BUY_PAYER_KEY).address;
    while (!signal.aborted) {
      try {
        await reconcilePaidCalls(db, rpc as unknown as ReconcileReader, {
          payer,
          payTo: env.BUY_GATEWAY_PAY_TO,
          token: USDC,
          decimals: 6,
        });
      } catch (err) {
        log.warn("paid call reconcile failed", { error: String(err) });
      }
      await sleep(5 * 60_000, signal);
    }
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
    await Promise.all([
      indexLoop(),
      enricher.run(signal),
      cards.run(signal),
      env.X_MENTIONS_DAILY_CAP_USD > 0
        ? xmentions?.run(signal).catch((err) => log.error("x mentions stopped", { error: String(err) }))
        : undefined,
      watches?.run(signal).catch((err) => log.error("alerts stopped", { error: String(err) })),
      reconcileLoop(signal),
    ]);
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
    usage,
    xmentions,
    watches,
    close: () => {
      usage.flush();
      db.close();
    },
  };
}
