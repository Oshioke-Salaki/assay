# Audit of guard.mjs

`guard.mjs` was audited against remesso-sdk 0.3.1's source (`dist/*.js`) on 7 Nov 2026. The audit followed the method in [pashov/skills](https://github.com/pashov/skills):
- **Six lenses**, each run as an independent reviewer: execution trace, flow gaps, trust gaps, boundaries and invariants, first principles and cost, plus a second pass on the fixed code.
- **Strict judging.** A finding needed a concrete input and the SDK line that made it fail, and was proven with a script against stand-ins or the real SDK. Anything else was recorded as a lead.

Nothing was paid or sent during the audit. The first rows below are the review from Remesso's own developers.

## Findings and fixes

| # | Found by | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | Remesso | A wallet-funded `remittances.send` always failed: the wrapper added a memo, and Remesso refuses a memo there (remittances.js:44) | The memo was removed entirely (see 4) | real SDK: wallet payment reaches Remesso unchanged |
| 2 | Remesso | A payment answering a request always failed, for the same reason (remittances.js:49) | Same | passing recipient is paid with its input unchanged |
| 3 | Remesso | A retry could be refused as `conflict`: the memo held a signature hash that changes with every check (payments.js:287) | Same | — |
| 4 | Audit | Turning a memo on while keyless payments are in flight changes Remesso's repeat detection, which could pay twice (payments.js:203, 326) | No memo option | — |
| 5 | Remesso | `invoices.pay` and `schedules.create` weren't guarded | Guarded | blocked recipient never paid, on any path |
| 6 | Remesso | `schedules.create({ request })` without `to` crashed | The request's `requested.to` is checked and pinned as `to` | schedule answering a request |
| 7 | Remesso | `agents.pay` overwrote the caller's `expectedWallet` | A mismatch throws `conflict`; the checked wallet is always pinned | agents.pay pins and refuses |
| 8 | Self | `requests.pay` read `request.to`, which doesn't exist, so every call crashed | Reads `requested.to`; tests use the SDK's real shapes | requests use real shapes |
| 9 | Audit | Per-key retry memory let a key whose first attempt was refused before signing skip the check later, even for a larger amount or a blocked address | No per-key state; every call is checked | every call is checked, retries included |
| 10 | Audit | The suggested `started()` lookup read the policy store, so a wallet-funded payment with the same key skipped the check | Removed with 9 | — |
| 11 | Audit | An invoice issuer could re-sign with the same order id and a higher amount and skip the check (key left out the amount) | Removed with 9 | — |
| 12 | Audit | A hung Assay hung the payment forever | Timeout (15 s), code `timeout` | a hung Assay times out |
| 13 | Audit | Unknown verdicts (`"BLOCK"`, `"bogus"`) were treated as pass | Only `pass` and `caution` clear | unknown verdicts are refused |
| 14 | Audit | Missing `reasons` crashed the error | Handled | same test |
| 15 | Audit | Unbounded cache; a clock stepping back extended a verdict; `cacheMs: Infinity` accepted | LRU (5000), monotonic clock, options validated | cache bounded; bad options refused |
| 16 | Audit | Paid mode fell back silently to the unsigned free check | Throws unless `paid: false` | paid mode refuses loudly |
| 17 | Audit | A throwing `onDecision` could block a payment | Its errors are ignored | throwing onDecision decides nothing |
| 18 | Audit | Errors weren't `RemessoError`, so `createAgentTools` reported a block as "side effects unknown" | `RecipientBlockedError` is a `RemessoError`, code `refused` | RemessoError with code refused |
| 19 | Audit | A paid check was bought for payments Remesso refuses anyway (forged invoice, paid request, agent with no profile) | Remesso verifies first; read-based refusals are thrown first | Remesso refuses first, no check bought |
| 20 | Self, re-running audit proofs | A failed lookup (`agents.find`, `requests.get`, `invoices.verify`) handed the call to Remesso unchecked, so a network blip could let it pay | A failed read is thrown, never passed on | a failed lookup is thrown |
| 21 | Second pass | **`expectedWallet: null`, `""`, `0` or `false` skipped the check**, and Remesso paid (agents.js:53 reads it only when truthy) | Addresses are read as Remesso reads them; the checked wallet is always pinned | pass 2, F1 |
| 22 | Second pass | **An address passed as a `String` object skipped the check**; viem's `getAddress`, which Remesso uses, accepts it | The wrapper parses addresses with the same `getAddress` | pass 2, F2 |
| 23 | Second pass | A timeout threw away a paid check, and each retry bought another | The call keeps running and fills the cache; retries share it | pass 2, F4 |
| 24 | Second pass | A schedule with `to: ""` and a request wasn't pinned | Always pinned; a different `to` is refused as Remesso does | pass 2, L1 |
| 25 | Second pass | Paid checks spent on sends with no funding or key, or to an agent that requires a reference | Remesso's own input tests run first | remittances.send refused on its input |

Each case where Remesso refuses a call on its input alone was checked against the SDK source. Those calls go to Remesso unchecked, because Remesso refuses them before reading anything and no money can move.

## Known limits

These are listed in the README:
- `requests.pay` reads the request twice.
- Some refusals come after the check, so that check is still paid for.
- Schedule runs, `setActive`, `setTrigger` and `reconcile` aren't checked.
- The score's signature isn't verified locally.
