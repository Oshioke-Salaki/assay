# Methodology (version 2026.10-1)

## What counts as a settlement

A transfer of a supported token that the payer authorised by signature and someone else submitted:

- **EIP-3009** (USDC, USD₮, USA₮): an `AuthorizationUsed(authorizer)` event on the token, paired with a `Transfer` from that authorizer in the same transaction.
- **x402 Permit2 proxy** (wARS, wBRL, wCOP): a supported-token `Transfer` inside a successful call to `0x402085c2…20001`.

The submitter is recorded as the relayer. The Celo x402 facilitator (`0x0d74…FB48`) submits about 99% of them; self-hosted facilitators submit the rest. wFIAT amounts are converted to dollars at that day's rate (fiat per USD); days before Assay's first stored rate use the earliest stored rate.

## Organic revenue

For a seller *S*, each payer *P* is classified, first match wins:

| Class | Rule | Counted |
| --- | --- | --- |
| seller-funded | *P*'s first funder is *S*, or *P*'s funder's first funder is *S* | nothing |
| shared-funder | *P*'s first funder is a member of *S*'s loop (however busy it is), or is *S*'s own first funder when that funder is private | nothing |
| loop | *P* is in *S*'s strongly connected component of the payment graph | net of what *S* paid back into the loop |
| organic | anything else | in full |

**Loops.** Money that can travel from *S* back to *S* through payments forms a strongly connected component (iterative Tarjan, no recursion limit). Within it, only net inflow counts: *offset = min(paid to S by the loop, paid by S to the loop)*, allocated across loop payers in proportion to what each paid. Two businesses that really trade with each other keep the difference; a ring that passes the same dollars round keeps nothing.

**Public funders.** A funder is public when it is a contract or has sent at least 5,000 transactions (the Blockscout fallback also counts a Blockscout tag or 20,000 token transfers), unless it buys or sells over x402 itself. Sharing a public funder (an exchange, a bridge) says nothing about two wallets.

## The score

```
score = 100 × quality^1.5 × (0.55 × diversity + 0.45 × track) × dormancy + identity
```

| Term | Definition |
| --- | --- |
| quality | organic ÷ gross |
| diversity | 1 − e^(−payers/6), where *payers* is the inverse Herfindahl index of organic revenue over payer groups. Payers with one private funder, or one Self human (same nullifier), form one group. Wallets first seen less than a day before paying, that never paid anyone else, weigh half. |
| track | 1 − e^(−days/10) over distinct UTC days with organic revenue |
| dormancy | 1, then 0.85 after 30 idle days, 0.6 after 90 |
| identity | +3 for an ERC-8004 identity, +5 for a fresh Self proof (+2 if expired), only when quality ≥ 0.5 |

The result is clamped to 0–100 and rounded.

| Rating | AAA | AA | A | BBB | BB | B | CCC | D |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Score from | 90 | 80 | 70 | 60 | 45 | 30 | 15 | 0 |

**Thin file.** Fewer than 5 settlements, fewer than 2 payers, or under $0.05 of revenue: the numbers are shown and the rating is NR.

## The check

| Verdict | When |
| --- | --- |
| block | most revenue is not organic: under 50% organic with a critical finding (a loop, self-funded payers), or under 20% organic outright |
| caution | not proven yet: NR (thin file or no revenue), a score below BBB from a short or narrow history, or any warning |
| pass | BBB or better, no critical finding |

A low score alone never blocks. An honest seller with three customers is new, not fraudulent.

## Reviews

Every ERC-8004 review on Celo is tiered: **payment proven** when its feedback file names a settlement Assay finds onchain from the reviewer to the agent's owner or wallet; **paid customer** when the reviewer paid the agent before writing it; **never paid it** otherwise.

## Known limits

- Funding data fills in over time; until a payer is checked it is treated as independent, and each report shows how much of its payer base is checked.
- A loop that never sends money back to the seller directly, but launders it through a non-x402 transfer, is not seen as a loop; the funding trace catches the common case where the payers were funded from the seller's side.
- wFIAT history before the first stored rate is priced at the earliest stored rate.
- Scores describe x402 revenue only. They say nothing about service quality beyond what payment-verified reviews add.
