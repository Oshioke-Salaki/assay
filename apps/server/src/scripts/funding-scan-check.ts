/** Live check of the SQD first-funder scan on known wallets (dev). */
import { scanFirstFunders } from "../enrich/funding-scan.js";
import { SqdClient } from "../indexer/sqd.js";

const sqd = new SqdClient("https://portal.sqd.dev/datasets/celo-mainnet");
const head = (await sqd.finalizedHead()).number;
const addrs = process.argv.slice(2) as `0x${string}`[];
const t0 = Date.now();
const found = await scanFirstFunders(sqd, addrs, { fromBlock: Number(process.env.FROM ?? 0), toBlock: head });
for (const a of addrs) {
  const f = found.get(a.toLowerCase() as `0x${string}`);
  console.log(a, f ? `funded by ${f.funder} at block ${f.block}` : "no funding transfer found");
}
console.log(`${Date.now() - t0} ms`);
