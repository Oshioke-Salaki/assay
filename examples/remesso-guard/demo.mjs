// node demo.mjs <ERC-8004 agent id | 0x address> [--quote]
//
// Resolves the recipient the way a Remesso agent would, asks Assay about it and prints the
// decision and the memo a payment would carry. It never pays the recipient.
//   - with ASSAY_PAYER_KEY set (a wallet holding USA₮), the check is the paid one: $0.002 in USA₮
//     over x402, returning a score signed by Assay;
//   - without it, the free check: the same verdict, unsigned;
//   - --quote shows what the paid check costs in USA₮, without paying.
import { createRemesso } from "remesso-sdk";
import { createAssay, preferAssets, CELO_PAY_TOKENS } from "assayscore";
import { privateKeyToAccount } from "viem/accounts";
import { withAssay } from "./guard.mjs";

const [target, flag] = process.argv.slice(2);
if (!target) {
  console.error("usage: node demo.mjs <agent id | 0x address> [--quote]");
  process.exit(1);
}

let payingFetch;
if (process.env.ASSAY_PAYER_KEY) {
  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const account = privateKeyToAccount(process.env.ASSAY_PAYER_KEY);
  const client = new x402Client(preferAssets("USAT")).register("eip155:42220", new ExactEvmScheme(account));
  payingFetch = wrapFetchWithPayment(fetch, client);
}

const remesso = withAssay(createRemesso(), { assay: createAssay({ payingFetch }), paid: Boolean(payingFetch) });

let address = target;
if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
  const agent = await remesso.agents.find(target);
  console.log(`ERC-8004 agent #${target}: wallet ${agent.wallet ?? "none"}${agent.note ? ` (${agent.note})` : ""}`);
  if (!agent.wallet) process.exit(1);
  address = agent.wallet;
}

if (flag === "--quote") {
  const res = await fetch(`https://api.assayscore.xyz/v1/check/${address}`);
  const req = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString());
  const usat = req.accepts.find((a) => a.asset.toLowerCase() === CELO_PAY_TOKENS.USAT);
  console.log(`paid check: HTTP ${res.status}, ${Number(usat.amount) / 1e6} ${usat.extra.name} to ${usat.payTo} on ${usat.network}`);
}

const r = await remesso.assay.check(address);
const ok = remesso.assay.allowed(r);
console.log(`Assay: ${r.verdict}, rated ${r.rating}${r.organicShare == null ? "" : `, ${Math.round(r.organicShare * 100)}% organic`}`);
for (const why of r.reasons) console.log(`  - ${why}`);
console.log(r.attestation ? `signed by ${r.attestation.signer}` : "free check (unsigned); set ASSAY_PAYER_KEY for the signed one");
console.log(ok ? `would pay, with memo "${remesso.assay.memoFor(r)}"` : "would NOT pay: RecipientBlockedError");
