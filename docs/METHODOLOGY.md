# Methodology (version 2026.10-3)

## What counts as a settlement

A transfer of a supported token that the payer authorised by signature and someone else submitted:

- **EIP-3009** (USDC, USD₮, USA₮): an `AuthorizationUsed(authorizer)` event on the token, paired with a `Transfer` from that authorizer in the same transaction.
- **x402 Permit2 proxy** (wARS, wBRL, wCOP): a supported-token `Transfer` inside a successful call to `0x402085c2…20001`.

The submitter is recorded as the relayer. The Celo x402 facilitator (`0x0d74…FB48`) submits about 99% of them; self-hosted facilitators submit the rest. wFIAT amounts are converted to dollars at that day's rate (fiat per USD); days before Assay's first stored rate use the earliest stored rate.

## Organic revenue

For a seller *S*, each payer *P* is classified, first match wins:

| Class | Rule | Counted |
| --- | --- | --- |
| seller-funded | *P*'s first funder is *S*, or *P*'s funder's first funder is *S* (funding through a contract is credited to whoever called it; see below) | nothing |
| shared-funder | *P*'s first funder is a member of *S*'s loop (however busy it is), or is *S*'s own first funder when that funder is private | nothing |
| loop | *P* is in *S*'s strongly connected component of the payment graph | net of what *S* paid back into the loop |
| organic | anything else | in full |

**Loops.** Money that can travel from *S* back to *S* through payments forms a strongly connected component (iterative Tarjan, no recursion limit). Within it, only net inflow counts: *offset = min(paid to S by the loop, paid by S to the loop)*, allocated across loop payers in proportion to what each paid. Two businesses that really trade with each other keep the difference; a ring that passes the same dollars round keeps nothing.

**Public funders.** A funder is public when it is a contract or has sent at least 5,000 transactions (the Blockscout fallback also counts a Blockscout tag or 20,000 token transfers), unless it buys or sells over x402 itself. Sharing a public funder (an exchange, a bridge) says nothing about two wallets.

**Funding through a contract.** A contract that hands out tokens (a batch sender, a router, a faucet) did not decide to fund anyone; whoever sent the transaction did. So when a wallet's first funding came out of a public contract, Assay reads that transaction's sender and credits the funding to it, unless the sender is the funded wallet itself (it swapped, bridged or claimed for itself) or is public too (a relayer, bundler or exchange acting for many people). A seller that funds its payers through a batch-send contract is therefore treated exactly as one that sent them money directly, and the finding says the funding went through a contract. Reports show the contract under "First funded by". Since version 2026.10-2.

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
| identity | +3 for an ERC-8004 identity (see below for contracts), +5 for a fresh Self proof (+2 if expired), only when quality ≥ 0.5 |

The result is clamped to 0–100 and rounded.

**Which addresses an ERC-8004 identity covers.** A registration counts for its owner and for its verified `agentWallet`. Many sellers are paid at a contract instead (a payment splitter or a custom receiver), and a contract that cannot sign (no ERC-1271) cannot be set as `agentWallet`. Such a contract counts too when two things agree: the agent's registration file lists it as a service endpoint in CAIP-10 form (`{"name": "agentWallet", "endpoint": "eip155:42220:0x…"}`), and the contract's `owner()` is the agent's owner or `agentWallet`. Both are needed. Any contract can return any address from `owner()`, so that alone would let a stranger borrow a reputable agent's identity; the registration file can only be changed by the agent's owner, so listing the contract there is the owner's own claim. Assay reads `owner()` again daily, and https registration files daily too, since they can change without an onchain event. A payment to a linked contract also counts as paying the agent, for revenue on the agents page and for review tiers. Since version 2026.10-3.

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

## Early self-funded payments

A seller's own test payments are struck out like any other self-funded revenue: if the founder sent a wallet ten dollars and that wallet paid it back, the business earned nothing. Friends and family paying from their own money are not self-funded and count in full. When a seller is younger than 60 days and its self-funded revenue is $50 or less, the finding is worded as "Early payments from wallets it funded" and shown as early rather than critical, with a note that new sellers often test this way. The arithmetic, the score and the verdict are unchanged; only the words and the way it is shown differ.

## Payer checks, for sellers

The mirror of the pre-payment check. A payer is **blocked** when most of its spending goes round a payment loop, or, for the seller asking, when the seller funded it or shares a loop with it; **caution** when part of its spending is circular, it was first funded by a seller it pays, or it shares the seller's private funder; **established** when it has been on Celo for thirty days and pays several sellers, has ten or more payments, or carries a fresh Self proof; otherwise **new**. Nothing here is a score; it is the record, in words a seller can act on before a refund, an allowance or credit.

## The seller's right of reply

A wallet's owner can sign a short response to any finding on its report. It appears under that finding as the seller's own words, dated, and it never changes a score, a verdict or an attestation: the finding stays, the response sits beside it, and the reader weighs both. Responses are plain text, ten to five hundred characters, one per finding, and the same owner can withdraw them.

## What would raise a rating

Every report with revenue carries a plan, computed by running the score formula above on a changed input: how many more independent customers (each paying what a typical current customer pays) reach the next rating floor; what 10 or 30 more active days add; what one organic payment does to a dormant record; what an ERC-8004 registration or a Self proof is worth, and only when the record is at least half organic. New customers are added to the inverse-Herfindahl exactly, from the current totals. The plan also states what is struck out and how much organic revenue it would take to outweigh it, and, for high ratings, what would lower them. It cannot be gamed: funded and looped payers are struck out before scoring, so the only lever that moves a rating is real revenue from wallets the seller does not control.

## Independent payers, by the hackathon's rule

The Agents on Open Rails hackathon defines an independent user as a wallet that is not the project's, was not first funded by the project or the project's own funder, and had its own activity on Celo before the window started (6 Oct 2026, 12:00 UTC). Assay maps that onto what it already knows: a payer counts when it is not in the seller's payment loop, is not classed seller-funded or shared-funder, and its first transaction on Celo (from the funding trace) is older than the window. A payer whose funding has not been traced yet is reported as unknown, never guessed. `GET /v1/independent/:address` gives the list with reasons and each payer's volume inside the window; the same numbers appear on every report. Assay applies the rule to its own PayTo address on `/stats`.

## Reviews

Every ERC-8004 review on Celo is tiered: **payment proven** when its feedback file names a settlement Assay finds onchain from the reviewer to the agent's owner, wallet or a linked contract; **paid customer** when the reviewer paid the agent before writing it; **never paid it** otherwise.

## Known limits

- A contract that has no `owner()` function (a multisig, a contract with role-based access) cannot be linked to an agent this way yet. Setting it as `agentWallet`, where it supports ERC-1271, still works.
- Funding data fills in over time; until a payer is checked it is treated as independent, and each report shows how much of its payer base is checked.
- Funding through a contract is credited to the transaction's sender. If that sender is itself public (an ERC-4337 bundler relaying for a seller's smart wallet, say), the contract stays a public source. A seller's smart wallet that buys or sells over x402 is never public, so this only matters for a smart wallet that funds payers and never trades itself.
- A loop that never sends money back to the seller directly, but launders it through a non-x402 transfer, is not seen as a loop; the funding trace catches the common case where the payers were funded from the seller's side.
- wFIAT history before the first stored rate is priced at the earliest stored rate.
- X search covers what X's search returns for the address. Posts that write the address differently (shortened, split, in an image) are not found.
- Scores describe x402 revenue only. They say nothing about service quality beyond what payment-verified reviews add.
