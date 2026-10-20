/**
 * Dev check, costs nothing: build Assay's 402 for /v1/check, sign a payment in each wFIAT token
 * from a fresh empty wallet, and ask the Celo facilitator to verify it. A well-formed Permit2 +
 * EIP-2612 payment is refused only for the missing balance; any other reason is a format problem.
 */
import { CAIP2_CELO, TOKENS } from "@assay/core";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { Analysis } from "../analysis.js";
import { createApp } from "../api/app.js";
import { openDatabase } from "../db.js";
import { FxRates } from "../enrich/fx.js";
import { loadEnv } from "../env.js";

const env = loadEnv(process.env);
if (!env.X402_API_KEY || !env.PAY_TO) throw new Error("needs X402_API_KEY and PAY_TO");
const db = openDatabase(":memory:");
const pub = createPublicClient({ chain: celo, transport: http(env.RPC_URL) });
const app = createApp({
  env,
  db,
  analysis: new Analysis(db, 0),
  fx: new FxRates(db),
  rpc: pub as never,
  attester: null,
  status: () => ({ settlementsBlock: 0, registryBlock: 0, finalizedHead: 0, lastSettlementTs: null }),
});
const res = await app.request("/v1/check/0x5df8ae2b963165b735b18ca86b1ea448d2aa032c");
const required = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
const account = privateKeyToAccount(generatePrivateKey());
for (const symbol of ["wARS", "wBRL", "wCOP", "USDT"]) {
  const token = TOKENS.find((t) => t.symbol === symbol)!;
  const reqs = required.accepts.find((a: { asset: string }) => a.asset.toLowerCase() === token.address);
  const client = new x402Client(
    (_v, rs) => rs.find((r) => r.asset.toLowerCase() === token.address)!,
  ).register(
    CAIP2_CELO as `${string}:${string}`,
    new ExactEvmScheme({
      address: account.address,
      signTypedData: (m) => account.signTypedData(m as never),
      readContract: (a) => pub.readContract(a as never),
    }),
  );
  // Only USDC, USD₮ and USA₮ are x402 default assets on Celo; wFIAT must be allowed explicitly.
  client.setSpendControls({
    allowedAssets: [
      {
        network: CAIP2_CELO as `${string}:${string}`,
        asset: token.address,
        maxAmountPerPayment: reqs.amount,
      },
    ],
  });
  const payload = await client.createPaymentPayload({ ...required, accepts: [reqs] });
  const v = await fetch(`${env.X402_FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": env.X402_API_KEY },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: reqs }),
  });
  const body = await v.json();
  console.log(
    symbol,
    reqs.amount,
    Object.keys(payload.extensions ?? {}),
    v.status,
    JSON.stringify(body).slice(0, 200),
  );
}
