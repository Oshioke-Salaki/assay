# Business model and scaling

## The problem, in Celo's own numbers

Celo pays builders on activity it can measure: hackathon leaderboards run on onchain queries, Prezenti's Anchor grants start at 5,000 transactions a day, ecosystem dashboards count settlements. Every one of those numbers can be inflated by wallets paying each other. On the first full pass of Celo's x402 history Assay found six payment loops, the largest 378 wallets moving about $10 back and forth across 159,190 settlements. Nobody in that loop bought anything.

Agents have the same problem one level down. An agent choosing which seller to pay, or a lender deciding whether an agent's revenue is real, has no way to tell a busy seller from a busy loop.

## Who pays, and for what

| Customer | What they buy | How they pay |
| --- | --- | --- |
| Agents paying x402 sellers | A check before each payment: pass, caution or block | $0.002 per check over x402. Repeat by nature: every payment an agent makes is a reason to check. |
| Sellers with good revenue | A signed hallmark they publish to `AssayRegistry`, readable by any contract, renewed every 7 days | $0.01 per attestation, plus their own gas |
| Contracts and protocols (lenders, escrows, marketplaces, insurance) | `isInvestmentGrade(seller)` and the underlying score, onchain | Indirectly: their users or the protocol buys fresh attestations |
| Grant programmes and hackathon organisers | Cohort audits: organic volume and loops for a list of wallets | Per audit or a monthly plan (planned) |
| Wallets and agent platforms | Bulk checks and webhooks when a counterparty's rating changes | Volume pricing (planned) |

People reading reports in the browser pay nothing. That is the top of the funnel and the public good.

## Unit economics

A check costs Assay a database read and one signature. The Celo facilitator charges sellers gas at cost plus 0.3% after 20 free settlements, so a $0.002 check keeps most of its price. Assay's own costs are hosting (one small server) and the paid data it buys: Chainstack RPC through buy at $0.01 per batch of up to 2,000 calls, capped per day.

## Scaling

| Pressure | Now | Next |
| --- | --- | --- |
| Settlements | SQLite with a per-day roll-up; the full Celo x402 history is a few hundred MB | Postgres behind the same `pair_days` contract once a single file is not enough; the ledger build already streams |
| Reads | Several API processes can share one database file (WAL) | Read replicas or a cache in front of `/v1/address`; reports change at most once per finalized batch |
| Graph size | Tarjan SCC is linear in edges; one rebuild covers the whole economy | Incremental components when the graph reaches millions of edges |
| Enrichment | One SQD log scan finds the first funder of 500 addresses per pass; Blockscout covers what it misses | Paid RPC and indexer queries (already wired through buy) for the long tail |
| Chains | Celo | The extractor is chain-agnostic (EIP-3009 and the x402 Permit2 proxy); a chain is a dataset name, a token list and a facilitator address |

## Why this is infrastructure

Assay is not an app people visit every day. It is a primitive other builders call: an HTTP endpoint, an SDK guard, an MCP tool and a contract. Its value grows with the number of agents that check before paying and the number of contracts that read the registry.

## Roadmap

1. Webhooks when a watched seller's rating changes.
2. Cohort audits for grant programmes and hackathons (a list of wallets in, organic volume and loops out).
3. Escrowed x402 payments that release only to sellers above a chosen rating.
4. Undercollateralised credit lines for agents with long, organic revenue histories, priced from the score.
5. More chains, starting where x402 already settles.
