# Agents on Open Rails: how Assay meets the rules

| Rule | How |
| --- | --- |
| Celo mainnet only | The indexer, API and operator CLI target chain 42220. Rehearsals ran on a local fork of mainnet, never on a testnet. |
| Public repo, code written during the event | This repository, started 20 October 2026. |
| ERC-8021 tag on every transaction | `celo_27fe67eb1be5`, added where each wallet client is built: `apps/web/components/wallet/useWallet.ts` (reviews, hallmark publishing) and `apps/server/src/scripts/ops.ts` (registration, deployment, publishing). The CLI checks every transaction it sends with `verifyTx` and stops if the tag is missing. |
| ERC-8004 identity from the agent wallet | `pnpm ops register-agent`, sent from `0x3d5ea1ce6f3Fa5FAe7A38b77F569570b3ea9a9a4`. |
| x402 PayTo declared | `PAY_TO` is the agent wallet; x402 settlements carry no tag, so they are credited by this address. |
| Sponsored gas | Assay sponsors none. Reviewers and publishers sign and pay their own gas; x402 payers sign EIP-3009 authorisations and the Celo facilitator submits them. |
| Independent users | Assay never funds user wallets. `ops send` checks every destination against the live API and refuses any wallet that has ever paid Assay (`apps/server/src/lib/funding-guard.ts`); people without stablecoins are pointed to the USA₮ faucet instead. Users are agents and builders who check sellers, sellers who publish hallmarks, and buyers who write payment-verified reviews. |

## Tracks

- **USA₮ with x402.** Two flows settle through Celo's facilitator. Agents pay for checks ($0.002, or $0.01 with a fresh X search) in USD₮ by default, with USA₮, USDC and Ripio wARS, wBRL and wCOP accepted. People pay for hallmarks ($0.01) from the browser, where USA₮ is offered first: a seller verifies once with Self, claims free USA₮ from the Google Cloud faucet, and publishes its signed score to AssayRegistry. Scores expire after seven days, so a seller that wants its hallmark readable onchain comes back weekly: that is the repeat flow. USA₮ fits because a credit score on the public record should be paid for in a US-regulated dollar, and because it is the dollar a verified human gets for free. Counterparties are named in the submission from the facilitator's settlements to `PAY_TO`.
- **Build with buy.** Assay consumes buy's X search ($0.005, x402 from the agent wallet) in two ways. Background: every seller worth checking, weekly, busiest and most-asked-about first, under a $0.50 daily cap. On demand: `GET /v1/check/:address/x` buys a search for the agent that paid $0.01 for it, so spend on buy follows real customers, not a schedule. Every payment is in `/v1/paid-calls` with its settlement transaction, reconciled against the chain every five minutes.

## Built for sellers too

Sellers claim their page (name, what they sell, category, website, X), get a badge, read a plan that says exactly what would raise their rating, from the real formula, answer any finding in their own words, get free alerts on their own address, and check a payer (established customer or sock) before a refund, an allowance or credit. The sellers directory at `/sellers` and the MCP tool `assay_find_sellers` send buyers' agents to reliable sellers, which is why a seller would promote its Assay page.

## Built for the organisers too

`GET /v1/independent/:address` applies the hackathon's own independent-user rule to any PayTo address, free, with reasons per payer and volume in the window. Any team can check its numbers before the deadline, and the same query could score the whole event.

## Where users and volume come from

To be filled in before submission, from `/v1/paid-calls`, the facilitator's settlements to `PAY_TO`, and tagged transactions from the agent wallet and from users' wallets.
