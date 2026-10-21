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

## What X says

Onchain data shows how a seller is paid. It cannot show whether people are warning each other about it. So Assay searches X for every seller's exact address and shows what it finds on the report, in the check's reasons, and in the API, SDK and MCP answers.

**Who gets searched.** Each search is one paid call through the buy gateway ($0.005 in USDC from Assay's agent wallet), under a daily budget (default $0.50, about 100 searches). It goes in this order:

1. addresses an agent paid to check;
2. sellers whose report someone opened;
3. every other seller that has taken at least $1, busiest first.

Each address is searched again weekly. A failed search is retried after a day.

**Searches a buyer pays for.** `GET /v1/check/:address/x` ($0.01) buys a search now for the buyer who asked, under its own daily budget, so a paying customer never waits for the background queue. A search from the last fifteen minutes is fresh enough and is reused; two buyers asking at once share one search. If the search cannot be bought (budget spent, empty wallet) or the gateway does not answer, the request fails and the payment is not settled: nobody pays for evidence they did not get.

**How posts are read.**

- Only posts that contain the address, in their text or in a link, count as mentions.
- A post is a **warning** when the address shares its paragraph with a word such as scam, rug, drainer, phishing, hack, exploit, stolen or fraud, within 160 characters of it. A news digest that names the address and, further down, an unrelated exploit does not count.
- Posts from accounts under 30 days old, or with fewer than 25 followers, are shown but counted apart as weak.
- Pasted copies of one text count once. Spam is pasted, not written.

**Not scored, on purpose.** Anyone can post "0x… is a scam" about a competitor, and a victim's plea or a bot's bait names an address next to the same words. A score that a post can move is worth nothing. So posts never change a rating, a score, a verdict or a signed attestation. They add one plain sentence to the check's reasons and are listed with links, so a person or an agent can read them before paying. The wording says what the posts contain ("name this address next to words like scam or hack"), not what the seller did.

## Reviews

Every ERC-8004 review on Celo is tiered: **payment proven** when its feedback file names a settlement Assay finds onchain from the reviewer to the agent's owner or wallet; **paid customer** when the reviewer paid the agent before writing it; **never paid it** otherwise.

## Known limits

- Funding data fills in over time; until a payer is checked it is treated as independent, and each report shows how much of its payer base is checked.
- A loop that never sends money back to the seller directly, but launders it through a non-x402 transfer, is not seen as a loop; the funding trace catches the common case where the payers were funded from the seller's side.
- wFIAT history before the first stored rate is priced at the earliest stored rate.
- X search covers what X's search returns for the address. Posts that write the address differently (shortened, split, in an image) are not found.
- Scores describe x402 revenue only. They say nothing about service quality beyond what payment-verified reviews add.
