/** Index the same recent finalized range from the SQD portal and from Celo RPC, and compare (dev check). */
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
import { openDatabase } from "../db.js";
import { FxRates } from "../enrich/fx.js";
import { type RpcReader, RpcSource } from "../indexer/rpcsource.js";
import { SettlementIndexer } from "../indexer/settlements.js";
import { type BlockSource, SqdClient } from "../indexer/sqd.js";

const sqd = new SqdClient("https://portal.sqd.dev/datasets/celo-mainnet");
const rpc = new RpcSource(
  createPublicClient({ chain: celo, transport: http("https://forno.celo.org") }) as unknown as RpcReader,
  {
    chunkBlocks: 200,
  },
);
const head = (await sqd.finalizedHead()).number;
const from = head - 120;
async function run(source: BlockSource) {
  const db = openDatabase(":memory:");
  await new SettlementIndexer(db, source, new FxRates(db), { fromBlock: from }).step(head);
  return db
    .prepare(
      "SELECT tx_hash, log_index, payer, payee, token, amount, relayer FROM settlements ORDER BY tx_hash, log_index",
    )
    .all();
}
const [a, b] = [await run(sqd), await run(rpc)];
console.log(
  `blocks ${from}..${head}: sqd ${a.length} settlements, rpc ${b.length}, identical: ${JSON.stringify(a) === JSON.stringify(b)}`,
);
