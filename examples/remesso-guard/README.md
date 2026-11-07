# Remesso + Assay: check who your agent pays

[Remesso](https://docs.remesso.xyz) lets an agent pay any address within caps a person signs onchain. [Assay](https://assayscore.xyz) checks who is on the other end before the money moves: is this seller's revenue real, or self-funded and going round in loops?

`withAssay` wraps a Remesso client and keeps its API. Every paying call checks the recipient first:

```js
import { createRemesso } from "remesso-sdk";
import { createAssay, preferAssets } from "assayscore";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { withAssay, RecipientBlockedError } from "./guard.mjs";

// Pay Assay in USA₮ over x402: $0.002 a check, with a score signed by Assay.
const x402 = new x402Client(preferAssets("USAT")).register("eip155:42220", new ExactEvmScheme(account));
const assay = createAssay({ payingFetch: wrapFetchWithPayment(fetch, x402) });

const remesso = withAssay(createRemesso({ account }), { assay });

try {
  await remesso.agents.pay(agentId, { funding: "policy", amount: "5", token: "USAT", idempotencyKey });
} catch (err) {
  if (err instanceof RecipientBlockedError) console.log(err.result.reasons); // never paid
}
```

## What it does

- **Guards every path that pays:** `pay`, `remittances.send`, `agents.pay` and `requests.pay`. Everything else on the client is untouched.
- **Pins the wallet it checked.** `agents.pay` resolves the agent's ERC-8004 wallet, checks it, and passes it to Remesso as `expectedWallet`. If the wallet changes between the check and the payment, the payment fails.
- **Links each payment to its check onchain.** When you set no memo, the payment's memo becomes `assay pass A 1f2e3d4c`: the verdict, the rating and a short hash of Assay's EIP-712 signature. Anyone holding the signed score can match it to the payment. A memo you set yourself is kept.
- **Is cheap.** Verdicts are cached for 10 minutes, and concurrent checks of one address share a single call.
- **Sensible defaults.** Only a `block` verdict stops a payment unless you set `minRating` (for example `"BB"`). `allowUnrated` (default `true`) decides whether brand-new addresses can be paid. If Assay can't be reached, nothing is paid unless you set `onAssayError: "allow"`.
- **Has a free mode.** Without a paying fetch it uses Assay's free check: the same verdict, unsigned.

## Try it

```sh
npm install
node demo.mjs 9981            # an ERC-8004 agent id, resolved with Remesso's own agents.find
node demo.mjs 0x5df8ae2b963165b735b18ca86b1ea448d2aa032c --quote   # an address; --quote shows the USA₮ price of the paid check
npm test                      # the wrapper's behaviour, with stand-ins: nothing is paid
```

The demo never pays anyone. Set `ASSAY_PAYER_KEY` (a wallet holding a little USA₮) to make the check the paid, signed one: it costs $0.002.

Real output, 7 Nov 2026. Agent #9981 is Assay's own agent, which Assay rates D by its own rules:

```
ERC-8004 agent #9981: wallet 0x3d5ea1ce6f3Fa5FAe7A38b77F569570b3ea9a9a4
paid check: HTTP 402, 0.002 Tether America USD to 0x3d5e…a9a4 on eip155:42220
Assay: block, rated D, 14% organic
  - Early payments from wallets it funded
  - Only 14% of revenue is organic
would NOT pay: RecipientBlockedError
```

## Where it fits

Assay rates addresses that earn: x402 sellers, ERC-8004 agents and services. That makes it most useful for an agent spending a budget on services, and for agent-to-agent payments. A personal wallet receiving a remittance has no revenue to test, so Assay rates it `NR` (too little history), and `allowUnrated` decides what happens.

Docs: [assayscore.xyz/docs](https://assayscore.xyz/docs) · [API](https://github.com/Oshioke-Salaki/assay/blob/main/docs/API.md) · [how scores are made](https://github.com/Oshioke-Salaki/assay/blob/main/docs/METHODOLOGY.md)
