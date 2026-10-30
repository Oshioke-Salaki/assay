# Trust model

What you trust when you use an Assay score, what is enforced onchain, and how to check a score without trusting Assay at all.

## The boundary

| | Where | What it guarantees |
| --- | --- | --- |
| The inputs | Celo mainnet | Every x402 settlement, every funding transfer, every ERC-8004 registration and Self proof Assay reads is public and the same for everyone. |
| The rating | Off-chain, Assay's server | The scoring code (`packages/core/src/assess.ts`, method version 2026.10-1) turns those inputs into a rating. Nothing onchain checks that this computation was done correctly. |
| The signature | Off-chain, Assay's attester key | A paid check or attest returns an EIP-712 `Score` signed by the attester key. Anyone can recover the signer. |
| The registry | Celo mainnet, AssayRegistry `0xf6679308af9ff1ffc11a968dfd1ea5882152e29f` | Stores a score only if the current attester signed it, it is well formed, and it has not expired (7 days). Contracts call `scoreOf(subject)` or `isInvestmentGrade(subject)`. |
| The free report and `withAssayGuard` | Off-chain, over HTTPS | You trust the API's response. Use the paid check when you want a signature you can verify. |

In one line: **the chain proves who issued a score and when, not that it is right. What makes it checkable is that the inputs are public, the code is open, and any signed score can be replayed.**

## Checking a score without trusting Assay

Every signed score records the block it was computed from (`asOfBlock`) and when (`issuedAt`). `verify` checks the signature against the attester AssayRegistry trusts, then rebuilds the score from your own copy of the data at that block and time, and compares all five fields:

```sh
# Run your own node first (README, "Run it"); the backfill indexes Celo from the SQD portal.
pnpm --filter @assay/server verify check.json          # the JSON a paid check or attest returned
pnpm --filter @assay/server verify --onchain 0xSeller   # the score published in AssayRegistry
```

```
VERIFIED: the signature is Assay's and your node computes the same score.
subject 0x5df8…032c · as of block 80608495 · signed 2026-10-30T06:17:20.000Z
signature: recovered 0x8d9a…9a46; registry 0xf667…e29f trusts 0x8d9a…9a46

  ok   score                signed             79   yours             79
  ok   rating               signed              A   yours              A
  ok   grossUsdMicros       signed     3123658757   yours     3123658757
  ok   organicUsdMicros     signed     3123658757   yours     3123658757
  ok   effectivePayersX100  signed            584   yours            584
```

Outcomes: **verified**; **differs** (the signature is valid, your node computes something else; the report says whether the settlements or the enrichment disagree); **signature invalid**; **node behind** (index further, then run it again). The exit code is 0 only when verified.

### Where the data comes from

The replay reads your node's database, not Assay's. That database is built from public sources you choose:

- **Settlements**, which decide gross revenue, come from x402 settlement logs on Celo, read through the SQD portal (`SQD_URL`) with an RPC fallback (`RPC_URL`). Point either at your own Celo archive node if you want no third party in the path. Settlements are onchain facts, so every honest index agrees on them, to the micro-dollar.
- **Enrichment**, which decides what counts as organic, also comes from public data: who first funded each payer (ERC-20 and CELO transfers), Self Agent ID proofs, ERC-8004 registrations. Two honest nodes can differ here if one traced an address before or after the other, or before a registration appeared. When gross revenue matches and organic does not, that is the reason, and `verify` says so.

The replay rebuilds the ledger from raw settlements at exactly `asOfBlock`, so revenue that arrived after the score was signed never leaks in, and uses `issuedAt` as "now" so the dormancy rule sees the same day Assay saw. Scores signed before 30 Oct 2026 recorded the indexer's latest block rather than the analysis snapshot's, and may differ by settlements from the last few seconds; scores signed since replay exactly.

## Why the method is not tilted

- **Open code, versioned method.** Every rule is in the repository and in [METHODOLOGY.md](METHODOLOGY.md); a change to scoring changes the method version.
- **No manual overrides.** There is no code path that sets or adjusts one address's rating.
- **Payment never buys a rating.** Paying for a check or a hallmark buys a signed copy of the score the address already has.
- **Assay rates itself by the same rules,** publicly, at assayscore.xyz/stats. On 30 Oct 2026 it rated itself D, because its first paid checks came from a wallet it funded.
- **Evidence is attached.** Every finding links the transactions behind it.
- **Sellers can answer.** The right of reply puts a seller's own words under any finding, without changing the score.

## What is still trusted

- **The attester key.** Whoever holds it can sign any score. The registry's owner can rotate it (`setAttester`, an onchain event anyone can watch). `verify` exists so a wrong signed score can be caught.
- **The method.** A score is right by Assay's definition of organic revenue. The definition is public and argued in METHODOLOGY.md; you can disagree with it, but you can check it was applied.

Next: letting a contract choose which attesters it accepts, so a second, independent operator can sign scores from the same open code.
