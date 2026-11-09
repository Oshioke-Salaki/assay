# Trust model

What you trust when you use an Assay score, what is enforced onchain, and how to check a score without trusting Assay at all.

## The boundary

| | Where | What it guarantees |
| --- | --- | --- |
| The inputs | Celo mainnet | Every x402 settlement, every funding transfer, every ERC-8004 registration and Self proof Assay reads is public and the same for everyone. |
| The rating | Off-chain, Assay's server | The scoring code (`packages/core/src/assess.ts`, method version 2026.10-4) turns those inputs into a rating. Nothing onchain checks that this computation was done correctly. |
| The signature | Off-chain, Assay's attester key | A paid check or attest returns an EIP-712 `Score` signed by the attester key. Anyone can recover the signer. |
| The registry | Celo mainnet, AssayRegistry `0xf6679308af9ff1ffc11a968dfd1ea5882152e29f` | Stores a score only if the current attester signed it, it is well formed, and it has not expired (7 days). Contracts call `scoreOf(subject)` or `isInvestmentGrade(subject)`. |
| The free report and the SDK guard | Off-chain, over HTTPS | You trust the API's response. Use the paid check when you want a signature you can verify. |

In one line: **the chain proves who issued a score and when, not that it is right. What makes it checkable is that the inputs are public, the code is open, and any signed score can be replayed.**

## Checking a score without trusting Assay

Every signed score records the block it was computed from (`asOfBlock`) and when (`issuedAt`). `verify` checks the signature against the attester that **your** registry trusts, then rebuilds the score from your own copy of the data at that block and time, and compares all five fields.

You choose the registry, not the file you are verifying. `verify` trusts Assay's mainnet AssayRegistry (`0xf667…e29f`) unless you set `REGISTRY_ADDRESS` to another. A file that names any other registry is refused, because anyone can deploy a contract that names their own key as the attester.

```sh
# Run your own node first (README, "Run it"); the backfill indexes Celo from the SQD portal.
pnpm --filter @assay/server verify check.json          # the JSON a paid check or attest returned
pnpm --filter @assay/server verify --onchain 0xSeller   # the score published in AssayRegistry
```

```
VERIFIED: the signature is from the attester your registry trusts, and your node computes the same score.
subject 0x5df8…032c · as of block 80608495 · signed 2026-10-30T06:17:20.000Z
signature: recovered 0x8d9a…9a46; registry 0xf667…e29f trusts 0x8d9a…9a46

  ok   score                signed             79   yours             79
  ok   rating               signed              A   yours              A
  ok   grossUsdMicros       signed     3123658757   yours     3123658757
  ok   organicUsdMicros     signed     3123658757   yours     3123658757
  ok   effectivePayersX100  signed            584   yours            584
```

Outcomes:
- **verified:** a trusted signature checked, and the replay matches.
- **unsigned:** the replay matches, but no trusted signature was checked. This proves the arithmetic, not who issued the score.
- **differs:** the signature is valid, but your node computes something else. The report says whether the settlements or the enrichment disagree.
- **signature invalid.**
- **node behind:** your node hasn't indexed far enough yet. Let it catch up, then run it again.

The exit code is 0 only when the outcome is verified.

### Where the data comes from

The replay reads your node's database, not Assay's. That database is built from public sources you choose:

- **Settlements**, which decide gross revenue, come from x402 settlement logs on Celo. They are event logs, so a full node that serves `eth_getLogs` is enough; no archive state is read. A full backfill streams them from the SQD portal (`SQD_URL`); your RPC (`RPC_URL`) fills short gaps. Settlements are onchain facts, so every honest index agrees on them, to the micro-dollar.
- **Enrichment**, which decides what counts as organic, also comes from public data: who first funded each payer (ERC-20 and CELO transfers, and the sender of the funding transaction when it came out of a contract), Self Agent ID proofs, ERC-8004 registrations, and the `owner()` of contracts a registration file lists. Two honest nodes can differ here if one traced an address before or after the other, or before a registration appeared. When gross revenue matches and organic does not, that is the reason, and `verify` says so.

The replay rebuilds the ledger from raw settlements at exactly `asOfBlock`, so revenue that arrived after the score was signed never leaks in, and uses `issuedAt` as "now" so the dormancy rule sees the same day Assay saw. Scores signed before 30 Oct 2026 recorded the indexer's latest block rather than the analysis snapshot's, and may differ by settlements from the last few seconds; scores signed since replay exactly.

## Why the method is not tilted

- **Open code, versioned method.** Every rule is in the repository and in [METHODOLOGY.md](METHODOLOGY.md); a change to scoring changes the method version.
- **No manual overrides.** There is no code path that sets or adjusts one address's rating.
- **Payment never buys a rating.** Paying for a check or a hallmark buys a signed copy of the score the address already has.
- **Assay rates itself by the same rules,** publicly, at assayscore.xyz/stats. On 30 Oct 2026 it rated itself D, because its first paid checks came from a wallet it funded.
- **Evidence is attached.** Every finding links the transactions behind it.
- **Sellers can answer.** The right of reply puts a seller's own words under any finding, without changing the score.

## If Assay gets it wrong

A score sits in a payment path, so a mistake cuts both ways: an honest seller blocked, or a bad one paid. What limits the damage:

- **The guard is cautious by default.** The SDK stops a payment only on a `block` verdict, which needs most of a seller's revenue to be self-funded or circular. New sellers with no rating go through (`allowUnrated` defaults to true), and if Assay cannot give a valid answer the payment goes through (`onAssayError` defaults to `"allow"`). A buyer who wants stricter checks sets `minRating` or `onAssayError: "block"` and owns that choice. `assayGuardClient` runs the check inside the x402 client's before-signing hook, on the exact address and network it is about to pay, so a seller cannot show one address to the check and pay out to another.
- **Every finding shows its evidence.** Each one names the payers and links the transactions, so a wrong call is visible on Celoscan, not hidden in a number.
- **Sellers can answer.** A seller signs a reply from its own wallet and it appears under the finding, on the page and in the API, for every buyer to read. A reply never changes the score, so it cannot be used to talk a rating up.
- **Anyone can recheck.** `verify` replays any signed score from public data, so a score that does not follow from the chain can be shown not to.
- **Fixes are in the open.** A rule that misjudges a case is fixed in the code, with a test for the case, and the method version changes. There are no one-off overrides for a single address.

Report a wrong rating as a GitHub issue (github.com/Oshioke-Salaki/assay/issues) with the address and what you think is wrong.

Recent rule changes, each with tests and a new method version:

- **2026.10-4 (31 Oct).** Five defects found by an automated audit, fixed and the data they wrote repaired (below). One lowered real ratings: wallets created just before paying a seller now count half, as the method always said; before, the formula cancelled the discount out.
- **2026.10-3 (30 Oct).** A seller paid at a contract it owns can carry its ERC-8004 identity there, by listing the contract in its registration file. A seller pointed out that a contract that cannot sign could never be its `agentWallet`.
- **2026.10-2 (30 Oct).** Funding sent through a batch-send contract is credited to whoever called the contract, so a seller cannot route its payers' funding through one to make them look independent.

## Audits

Both audits so far were automated: AI reviewers working through the code and proving each finding with a test, not a human audit firm. Each finding was reproduced as a failing test in this repository before it was fixed, and the tests stay in the suite.

**30 Oct 2026: Savant.Chat, automated audit of the method.** It covered the funding trace (`apps/server/src/enrich/funding-scan.ts`) and the scoring code (`packages/core/src/assess.ts`), and reported five findings, two high and three medium, each with a proof of concept.
- All five were reproduced as failing tests (`test/audit.test.ts` in `packages/core` and `apps/server`) and fixed in method 2026.10-4.
- The fixes also repair what the defects had already written: migration v11 re-queues the affected funding rows, and a one-off rescan replaces any first funding that was a zero-value transfer.
- METHODOLOGY.md lists each finding and its fix.

Reviewing the same patterns elsewhere turned up three more places where a failed lookup could be read as an answer: the `owner()` read that links a contract to an agent, the Self Agent ID lookup, and the payment proof behind a review. None could be triggered by an attacker; each could have cost an honest seller. All three now retry instead.

**7 Nov 2026: automated security and correctness audit of the whole repository.** It covered the API, the SDK guard, `verify`, webhooks, metadata fetching and the Remesso example. It reported twelve findings, four high and eight medium; the report is `apps/server/audit/REPORT.txt`. Ten are fixed in full and one in part, each with a regression test (`apps/server/test/security.test.ts`, `apps/server/audit/sdk-guard.test.ts`). The twelfth is a limit of Remesso's SDK, documented below.
- **The SDK guard checked one payment challenge but could sign another.** `assayGuardClient` now checks inside the x402 client's before-signing hook. Malformed Assay answers count as Assay being unable to answer, never as a pass.
- **`verify` trusted the registry named in the file it was verifying.** It now trusts only the registry you choose, and reports "unsigned" rather than "verified" when no trusted signature was checked.
- **Outbound requests could be pointed at private addresses.** IPv4-mapped IPv6 and DNS rebinding were both possible. One complete address classifier now applies, and the connection uses exactly the address that was checked. The deadline also covers the whole response body.
- **Spending and paid effects:**
  - Every signed authorization counts against the daily buy budget, receipt or not.
  - A paid watch is taken back if its payment does not settle.
  - Paid answers are refused while the index lags the chain.
  - A cached analysis is rebuilt at least hourly, so a signed score is never already expired.
- **Signed owner messages could be replayed or rolled back.** Each is now used once and can never roll back a newer one. Forwarding headers are trusted only from the proxy Assay runs behind, and browsers may send a watch's secret.

What is not fixed:
- **The fresh-X part of the paid-watch finding.** A fresh-X check buys its search before the buyer's payment settles, because x402 settles after the handler runs. A failed settlement can therefore cost Assay one $0.005 search, bounded by the daily X budget.
- **`requests.pay` in the Remesso example.** Remesso reads the request twice and can't be told which recipient to expect, so the example can't pin it. This is documented in the example's README and needs a change in Remesso's SDK.

What Assay still cannot see is listed under "Known limits" in METHODOLOGY.md, so nobody has to discover it.

## What is still trusted

- **The attester key.** Whoever holds it can sign any score. The registry's owner can rotate it (`setAttester`, an onchain event anyone can watch). `verify` exists so a wrong signed score can be caught.
- **The method.** A score is right by Assay's definition of organic revenue. The definition is public and argued in METHODOLOGY.md; you can disagree with it, but you can check it was applied.

Next: letting a contract choose which attesters it accepts, so a second, independent operator can sign scores from the same open code.
