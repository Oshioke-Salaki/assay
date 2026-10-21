/** Pay one Assay endpoint over x402 from a key and print the outcome (dev check). Costs the price. */
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.PAYER_KEY as `0x${string}`;
const url =
  process.argv[2] ?? "https://api.assayscore.xyz/v1/check/0x5df8ae2b963165b735b18ca86b1ea448d2aa032c";
const account = privateKeyToAccount(key);
const client = new x402Client(
  (_v, reqs) =>
    reqs.find((r) => r.asset.toLowerCase() === "0xcebA9300f2b948710d2653dD7B07f33A8B32118C".toLowerCase()) ??
    reqs[0]!,
).register("eip155:42220", new ExactEvmScheme(account));
const res = await wrapFetchWithPayment(fetch, client)(url);
console.log("payer", account.address, "status", res.status);
const pr = res.headers.get("payment-response") ?? res.headers.get("payment-required");
if (pr) console.log(JSON.stringify(JSON.parse(Buffer.from(pr, "base64").toString("utf8"))).slice(0, 600));
console.log((await res.text()).slice(0, 300));
