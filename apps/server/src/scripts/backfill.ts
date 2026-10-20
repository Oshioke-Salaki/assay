/**
 * Index Celo mainnet into the local database until caught up with the finalized
 * head, enrich, print a summary and exit. Safe to stop and re-run: every write is idempotent.
 *
 *   pnpm --filter @assay/server backfill            # settlements + ERC-8004 + enrichment pass
 *   ENRICH_PASSES=0 pnpm --filter @assay/server backfill
 */

import { AgentCards } from "../enrich/agents.js";
import { Blockscout } from "../enrich/blockscout.js";
import { Enricher } from "../enrich/enricher.js";
import { loadEnv } from "../env.js";
import { createRuntime } from "../runtime.js";

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const env = loadEnv();
const rt = createRuntime(env);
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

const t0 = Date.now();
const { settlements, registry } = await rt.syncOnce(controller.signal);
console.log(
  `indexed ${settlements} settlements, ${registry} registry events in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);

const passes = Number(process.env.ENRICH_PASSES ?? "1");
if (passes > 0) {
  const enricher = new Enricher(rt.db, new Blockscout(env.BLOCKSCOUT_URL, env.BLOCKSCOUT_RPS), rt.rpc, () =>
    rt.analysis.invalidate(),
  );
  const cards = new AgentCards(rt.db, env.IPFS_GATEWAY, () => rt.analysis.invalidate());
  for (let i = 0; i < passes && !controller.signal.aborted; i++) {
    const humans = await enricher.humansBatch(1_000);
    const funded = await enricher.fundingBatch(Number(process.env.FUNDING_BATCH ?? "60"), controller.signal);
    const agentCards = await cards.batch(50);
    console.log(
      `enrichment pass ${i + 1}: ${humans} self lookups, ${funded} funding lookups, ${agentCards} agent cards`,
    );
  }
}

const s = rt.analysis.current().summary;
console.log(
  JSON.stringify(
    {
      status: rt.status(),
      grossUsd: Math.round(s.grossUsd),
      organicUsd: Math.round(s.organicUsd),
      organicShare: s.grossUsd ? +(s.organicUsd / s.grossUsd).toFixed(4) : null,
      settlements: s.settlements,
      sellers: s.sellers,
      payers: s.payers,
      loops: s.loops,
      largestLoop: s.largestLoop,
      ratings: s.ratingCounts,
      reviews: rt.analysis.current().reviews,
      top: s.sellersRanked.slice(0, 8).map((x) => ({
        address: x.address,
        organic: +x.organicUsd.toFixed(2),
        gross: +x.grossUsd.toFixed(2),
        payers: x.payers,
        rating: x.rating,
      })),
    },
    null,
    2,
  ),
);
rt.close();
