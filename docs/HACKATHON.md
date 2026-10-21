# Agents on Open Rails: how Assay meets the rules

| Rule | How |
| --- | --- |
| Celo mainnet only | The indexer, API and operator CLI target chain 42220. Rehearsals ran on a local fork of mainnet, never on a testnet. |
| Public repo, code written during the event | This repository, started 20 October 2026. |
| ERC-8021 tag on every transaction | `celo_27fe67eb1be5`, added where each wallet client is built: `apps/web/components/wallet/useWallet.ts` (reviews, hallmark publishing) and `apps/server/src/scripts/ops.ts` (registration, deployment, publishing). The CLI checks every transaction it sends with `verifyTx` and stops if the tag is missing. |
| ERC-8004 identity from the agent wallet | `pnpm ops register-agent`, sent from `0x3d5ea1ce6f3Fa5FAe7A38b77F569570b3ea9a9a4`. |
| x402 PayTo declared | `PAY_TO` is the agent wallet; x402 settlements carry no tag, so they are credited by this address. |
| Sponsored gas | Assay sponsors none. Reviewers and publishers sign and pay their own gas; x402 payers sign EIP-3009 authorisations and the Celo facilitator submits them. |
| Independent users | Assay never funds user wallets. Users are agents and builders who check sellers, sellers who publish hallmarks, and buyers who write payment-verified reviews. |

## Tracks

- **USA₮ with x402.** Checks ($0.002) and attestations ($0.01) settle through Celo's facilitator in USD₮ by default, with USA₮, USDC and Ripio wARS, wBRL and wCOP also accepted. Counterparties are other teams' agents and sellers. Checking happens before every payment, so the same counterparty pays again and again. USA₮ fits because the buyers are agents settling dollar-priced machine payments under a US-regulated dollar, gasless through x402.
- **Build with buy.** Assay buys X searches through the buy gateway ($0.005 each, x402 from the agent wallet) to show what the public says about every seller, its own daily cap, busiest and most-asked-about first. Every payment is in `/v1/paid-calls` with its transaction, reconciled against the chain.

## Where users and volume come from

To be filled in before submission, from `/v1/paid-calls`, the facilitator's settlements to `PAY_TO`, and tagged transactions from the agent wallet and from users' wallets.
