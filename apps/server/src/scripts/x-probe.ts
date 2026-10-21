/**
 * Dev check: one paid X search through the buy gateway from BUY_PAYER_KEY ($0.005), printing the
 * raw answer so its shape can be inspected. Records the call in the local paid_calls table.
 *
 *   pnpm --filter @assay/server exec tsx src/scripts/x-probe.ts "<query>" [top|latest] [outFile]
 */
import { writeFileSync } from "node:fs";
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
const [query, type = "latest", out] = process.argv.slice(2);
if (!query) throw new Error('Usage: x-probe.ts "<query>" [top|latest] [outFile]');
const pay = createPayingFetch({
  db: openDatabase(env.DATABASE_PATH),
  privateKey: env.BUY_PAYER_KEY,
  service: "buy-x-search",
  pricePerCallUsd: 0.005,
  dailyCapUsd: env.X_MENTIONS_DAILY_CAP_USD,
});
const t0 = Date.now();
const res = await pay("https://gateway.usebuy.ai/v1/social/x/posts/search", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query, type }),
});
const text = await res.text();
console.log(
  res.status,
  `${Date.now() - t0} ms`,
  res.headers.get("payment-response") ? "paid" : "no payment-response header",
);
if (out) writeFileSync(out, text);
console.log(text.slice(0, 1500));
