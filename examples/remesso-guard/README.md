# Remesso + Assay: check who your agent pays

[Remesso](https://docs.remesso.xyz) lets an agent pay any address within caps a person signs onchain. [Assay](https://assayscore.xyz) checks who is on the other end before the money moves: is this seller's revenue real, or self-funded and going round in loops?

`withAssay` wraps a Remesso client (remesso-sdk 0.3.1) and keeps its API. Each new payment checks its recipient first, and a recipient Assay does not clear is never paid.

Copy [`guard.mjs`](guard.mjs) into your project (it is not published on npm), then:

```js
import { createRemesso } from "remesso-sdk";
import { safeFetchText } from "remesso-sdk/node";
import { createAssay, preferAssets } from "assayscore";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { withAssay, RecipientBlockedError } from "./guard.mjs";

const account = privateKeyToAccount(process.env.AGENT_KEY);

// Pay Assay in USA₮ over x402: $0.002 a check, with a score signed by Assay.
const x402 = new x402Client(preferAssets("USAT")).register("eip155:42220", new ExactEvmScheme(account));
const assay = createAssay({ payingFetch: wrapFetchWithPayment(fetch, x402) });

const remesso = withAssay(createRemesso({ account, fetchText: safeFetchText }), { assay });

try {
  await remesso.agents.pay(agentId, { funding: "policy", amount: "5", token: "USAT", idempotencyKey: "order-42" });
} catch (err) {
  if (err instanceof RecipientBlockedError) console.log(err.result.reasons); // not paid
}
```

## What is checked

| Call | Address checked |
|---|---|
| `pay`, `remittances.send` | `to` |
| `agents.pay` | the agent's registered wallet, passed to Remesso as `expectedWallet` |
| `requests.pay` | the request's `requested.to` |
| `invoices.pay` | the invoice's recipient, after Remesso verifies the invoice |
| `schedules.create` | `to`, or the answered request's `requested.to`, passed to Remesso as `to` |

**Not checked:** later runs of a schedule (checked once, when it is created), `schedules.setActive` and `setTrigger`, `remittances.reconcile` and `recoverPending`, and payments made by other clients or agents, for example through a policy you create. These finish or repeat payments to a recipient that was fixed earlier. Tools from `createAgentTools` are guarded only if you build them from the wrapped client.

## Guarantees

- **It checks the address Remesso will actually pay.** It reads addresses exactly as Remesso does: with viem's `getAddress`, a peer dependency the two share. So input such as `expectedWallet: null` or an address passed as a `String` object can't slip past the check.
- **It sends nothing Remesso wouldn't send unwrapped.** It changes no payment term. It only pins the address it checked: `expectedWallet` on `agents.pay`, and `to` on a schedule that answers a request. Remesso then refuses the payment if that address changes after the check.
- **It fails closed.** If Assay can't answer, or a lookup it needs fails, nothing is paid. Nothing goes to Remesso unchecked because something failed. Set `onAssayError: "allow"` to pay when Assay is down.
- **It uses Remesso's errors.** `RecipientBlockedError` is a `RemessoError` with code `refused`. An Assay failure is code `http`, and a slow Assay is code `timeout` (15 s by default).
- **It avoids paying for checks Remesso would refuse anyway.** Input Remesso refuses on its face (no funding, no key, an invalid address, an invalid or long-expired invoice) goes straight to Remesso. The common refusals that depend on what Remesso reads (no wallet, no payment profile, a required reference, a request that can't be paid) are thrown first, with Remesso's own code. A slow check keeps running after a payment stops waiting, so a retry reuses its answer rather than buying a second one.
- **It checks every call, retries included.** It keeps no state per idempotency key. To resume a payment that already started, use the unwrapped client, for example `remittances.reconcile`: it can only finish a payment that was checked when it began. A refusal here never means an earlier attempt was unpaid.
- **It doesn't change behavior by accident.** It has no memo option, because adding a memo would change Remesso's repeat detection for payments sent without a key. `onDecision` is for logs, and an error it throws is ignored.

## Options

| Option | Default | |
|---|---|---|
| `paid` | `true` | The paid check: a score signed by Assay, $0.002 per uncached address. It needs `createAssay({ payingFetch })` and throws without one. `false` uses the free check: the same verdict, unsigned. |
| `minRating` | none | The lowest rating to pay, for example `"BB"`. Without it, only a `block` verdict stops a payment. |
| `allowUnrated` | `true`, or `false` with `minRating` | Whether to pay an address too new to rate (`NR`). |
| `cacheMs` / `maxCached` | 10 min / 5000 | Reuse a verdict per address. Concurrent checks of one address share one call. |
| `timeoutMs` | 15000 | Give up on Assay after this long. |
| `onAssayError` | `"block"` | What to do when Assay can't answer. |
| `onDecision` | none | Called with every decision and Assay's result (with `attestation` in paid mode). |

## Known limits

- **`requests.pay` reads the request twice.** The guard reads it, then Remesso reads it again, and Remesso can't be told which address to expect. If Remesso's backend changed a request's `requested.to` between those two reads, the new address would be paid unchecked.
- **Some refusals come after the check.** Remesso refuses some payments only after the check has run: no account, over the policy's caps, or not enough balance. The $0.002 check is still spent on those.
- **The signed score isn't verified locally.** The guard doesn't check the signature on the score Assay returns. Verify it with the AssayRegistry contract, or Assay's `verify` command, if you store it as proof.

## Where it fits

Assay rates addresses that earn: x402 sellers, ERC-8004 agents and services. That makes the guard useful for an agent spending a budget on services, and for paying other agents. **A personal wallet with no x402 revenue is always rated `NR`, so with the defaults the guard never stops a remittance to a person.** If you set `minRating` or `allowUnrated: false`, the guard refuses them instead.

## Try it

```sh
npm install
node demo.mjs 9981                                            # an ERC-8004 agent id, resolved with Remesso's agents.find
node demo.mjs 0x5df8ae2b963165b735b18ca86b1ea448d2aa032c --quote   # --quote shows the USA₮ price of the paid check
npm test                                                      # 28 tests, some against the real remesso-sdk; nothing is paid
```

Without `ASSAY_PAYER_KEY` the demo uses the free check and pays nothing. With it (a wallet holding a little USA₮), each check pays Assay $0.002. The demo never pays the recipient.

Output on 7 Nov 2026. Agent #9981 is Assay's own agent, which Assay rates D by its own rules:

```
ERC-8004 agent #9981: wallet 0x3d5ea1ce6f3Fa5FAe7A38b77F569570b3ea9a9a4 (its registration file is remote: pass fetchText (safeFetchText from remesso-sdk/node) to read it)
Assay: block, rated D, 14% organic
  - Early payments from wallets it funded
  - Only 14% of revenue is organic
free check (unsigned); set ASSAY_PAYER_KEY for the signed one
would NOT pay: RecipientBlockedError
```

Requires Node 20 or later. MIT, like Assay and remesso-sdk.

Docs: [assayscore.xyz/docs](https://assayscore.xyz/docs) · [API](https://github.com/Oshioke-Salaki/assay/blob/main/docs/API.md) · [how scores are made](https://github.com/Oshioke-Salaki/assay/blob/main/docs/METHODOLOGY.md)
