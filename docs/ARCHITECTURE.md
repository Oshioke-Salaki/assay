# Architecture

```
                 Celo mainnet (finalized blocks)
                              │
            SQD Portal stream │   SQD funding scan · Blockscout · Celo RPC · X search via buy (x402)
                              ▼                              │
┌─────────────────────────────────────────────────────────────┴───────────┐
│ apps/server                                                              │
│                                                                          │
│  indexer/settlements ──► settlements, pair_days, relayers   (SQLite)     │
│  indexer/registry    ──► agents, feedback (ERC-8004)                     │
│  enrich/enricher     ──► funding, funder_profiles, humans (Self)         │
│  enrich/agents       ──► agent cards (registration files)               │
│                                                                          │
│  analysis.ts  builds a Ledger (packages/core) from pair_days, rebuilt    │
│               at most every 10 s after new data, plus the economy roll-up │
│                                                                          │
│  api/app.ts   Hono: free routes, rate limited · paid routes behind x402  │
│  attest.ts    EIP-712 score signer                                       │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │ JSON                          │ x402 (USA₮/USDC/USD₮) through the Celo facilitator
                ▼                               ▼
   apps/web (Next.js)                 agents: assayscore guard, assayscore-mcp, any x402 client
                │                               │
                └───── signed score ───► AssayRegistry (contracts) ◄── any Celo contract reads it
```

## Data flow

1. **Settlements.** The indexer asks the SQD Portal for finalized Celo blocks containing an `AuthorizationUsed` event on USDC, USD₮ or USA₮, or a call to the x402 Permit2 proxy. `indexer/extract.ts` turns each matching transaction into settlements: a supported-token `Transfer` that the payer authorised and someone else submitted. Self-submitted authorisations, failed transactions, zero amounts and unauthorised transfers in the same transaction are skipped. Rows are written idempotently (`INSERT OR IGNORE` on transaction hash and log index) together with a per-day roll-up, `pair_days`, and the cursor, in one SQLite transaction per batch. Only blocks the portal actually sent move the cursor, so an early end of stream never skips a block.
2. **ERC-8004.** A second stream reads `Registered`, `URIUpdated`, `MetadataSet(agentWallet)` and `Transfer` from the Identity Registry and `NewFeedback` / `FeedbackRevoked` from the Reputation Registry. Feedback files stored inline as `data:` URIs are parsed for `proofOfPayment`.
3. **Enrichment.** A background worker finds each payer's and seller's first funder (the first inbound CELO, Mento stablecoin or x402 token transfer from someone else). One forward pass over SQD logs settles up to 500 addresses at once: about 24 minutes for all of Celo history, and the filter shrinks as addresses settle. Blockscout looks up, one address at a time, whatever the scan cannot find (funding newer than the portal's finalized head), since its keyless API allows only about ten requests in a 26-minute window, classifies funders as public sources (contracts or very busy wallets, and never an x402 participant), looks up Self Agent IDs and human nullifiers by multicall over Celo RPC, and fetches agent registration files through an SSRF-safe fetcher. Work is ordered by x402 volume so the busiest sellers are finished first.
4. **Public mentions.** `enrich/xmentions.ts` searches X for each seller's exact address through the buy gateway's X search: one $0.005 x402 payment per address, from the agent wallet, under its own daily cap. Addresses agents paid to check go first, then reports people opened, then sellers by revenue. Each address is searched again weekly. A payment whose answer was lost to a dropped connection is found onchain by the reconciler (`reconcilePaidCalls`), which matches every USDC transfer from the agent wallet to the gateway against the ledger. The results are evidence and never enter the score.
5. **Analysis.** `packages/core` builds the payment graph, finds strongly connected components and assesses any address on demand (see [METHODOLOGY.md](METHODOLOGY.md)).
6. **Serving.** Free routes return reports; paid routes sit behind `@x402/hono` and the Celo facilitator; each paid answer carries a signed EIP-712 score.

## Why these choices

| Choice | Why |
| --- | --- |
| Finalized blocks only | No reorg handling to get wrong. The lag is about 17 minutes; the review flow checks fresh payments live over RPC instead (`/v1/proof/:tx`). |
| SQD Portal | One HTTP stream filtered by event and by transaction target, the full history in minutes. Retries every 5xx (the portal answers 529 when overloaded), 408 and 429, honouring `Retry-After`, up to a minute apart. |
| SQLite in WAL mode | One file, transactional, concurrent readers while the indexer writes. The whole Celo x402 history fits in a few hundred MB. |
| Daily roll-up (`pair_days`) | The graph is built from roughly one row per payer, payee and day instead of one per settlement, so rebuilding takes milliseconds to seconds. |
| Pure core | Every scoring rule is unit tested without a database or network. |
| Inline `data:` feedback files | A payment-verified review can be checked from chain data alone, without trusting Assay's servers. |

## Process roles

`ROLE=all` (default) runs API and workers in one process. `ROLE=api` serves only; `ROLE=indexer` only indexes and enriches. Several API processes can read one database file; exactly one indexer should write it.

## Security notes

- Agent registration files are fetched only over https from public addresses (DNS checked, no redirects, 256 KB, 6 s).
- Strings from calldata are stripped of control characters before storage.
- Bad addresses are rejected before the x402 middleware, so nobody pays for a 400.
- The attester key only signs; it never sends transactions and can be rotated in `AssayRegistry` without touching published scores.
- The operator CLI refuses to continue if a transaction it sent does not carry the attribution tag.
- Paid calls Assay makes to other services are capped per day and refuse any challenge priced above the quote.
