# Demo video: script and shot list

Target: 2 minutes 40 seconds. One take per shot, screen recording at 1280×800, cursor visible, no music under the voice. Record the voice separately if that is easier; the shots below are timed to it.

Before recording: open every URL in its own tab, in this order, and reload each so nothing is loading on camera. Close other tabs. Hide bookmarks. Use a wired or Wi-Fi connection, not the hotspot.

Tabs:
1. https://assayscore.xyz
2. https://assayscore.xyz/economy
3. https://assayscore.xyz/address/0x53aa8c3ed977f5540b070703785726e5fcadc461 (the ring)
4. https://assayscore.xyz/address/0x5df8ae2b963165b735b18ca86b1ea448d2aa032c (AbaPay, rated A)
5. https://assayscore.xyz/sellers
6. A terminal with `npx -y assayscore-mcp` ready, or Claude Code with the MCP added
7. https://assayscore.xyz/stats

---

## 0:00–0:15 · The problem (tab 1, landing page, slow scroll)

> Agents on Celo pay each other over x402. Eight hundred and sixty thousand payments so far. But a payment proves nothing about who is on the other side, because volume is almost free to fake.

Shot: landing hero; the hallmark strikes in as the page loads. Let it play, then scroll one screen.

## 0:15–0:35 · The finding (tab 2, economy)

> Assay reads every x402 settlement on Celo and asks one question of each seller: how much of this money came from buyers it doesn't control?

Shot: the KPI row. Pause on "Organic revenue" and the gross figure.

> Across the whole economy the answer is about twenty percent. The rest went round in payment loops or came from wallets the seller funded itself.

Shot: the daily chart; switch Organic → Gross with the toggle so the gap is visible.

## 0:35–1:05 · The ring (tab 3)

> Here is one seller. One thousand two hundred dollars of revenue from three hundred and seventy-five paying wallets. Every one of them was funded by the seller.

Shot: top of the report. Hallmark, "Rated D", "Pre-payment check: block".

> Assay draws it.

Shot: scroll to "The loop, drawn". Hold five seconds on the wheel; the beads go in and straight back out.

> Grey beads are dollars going round the circle. Gold would be money from outside. There is none.

Shot: scroll to Findings; hover the first finding's transaction links.

> Every finding links the transactions, so anyone can check it on Celoscan.

## 1:05–1:35 · A real seller (tab 4)

> And here is a real one. AbaPay pays utility bills for people in Nigeria, in stablecoins.

Shot: top of AbaPay's report: Rated A, 74, pass. Scroll to the KPIs: 177 payers, all organic.

> Rated A. A hundred and seventy-seven payers, all independent. Assay tells the seller what would raise it:

Shot: "What would raise this rating". Hold on the identity lever.

> register an ERC-8004 identity, add a Self proof, and it's AA, with no new customers at all. The plan runs the real formula; it can't be gamed, because funded and looped payers are struck out before anything is scored.

Shot: scroll past "Check a payer" and "Claim this page" slowly, no narration needed, 3 seconds.

## 1:35–2:00 · For the agent (tab 6)

> For an agent, this is one call.

Shot: terminal. Run (pre-typed):

```
curl -s https://api.assayscore.xyz/v1/address/0x53aa8c3ed977f5540b070703785726e5fcadc461 | jq .check
```

> Pass, caution or block, with the reasons. The paid version costs a fifth of a cent over x402 and comes back signed, so a smart contract can verify it without trusting our servers.

Shot: switch to Claude Code (or any MCP client) and ask: "Should I pay 0x53aa… for weather data?" Let the `assay_check_seller` tool answer. If this is awkward on camera, show the SDK snippet instead:

```ts
const pay = withAssayGuard(fetch, payingFetch, { minRating: "BB" });
```

> With the SDK, a blocked seller is never paid.

## 2:00–2:25 · Sellers and the directory (tab 5)

> Sellers aren't just rated. They can claim their page, answer any finding in their own words, check a payer before a refund, and get alerts. Buyers' agents find them here.

Shot: the directory. Set "Rating at least BBB", press Show. Four rows.

## 2:25–2:40 · Honest numbers (tab 7)

> And Assay is rated by Assay. Its own revenue, spend and independent customers are public, read from Celo.

Shot: /stats, scroll to "Assay rated by Assay". Hold.

> Whatever it says there is true. assayscore.xyz.

End on the stats page. Cut.

---

## Checklist before upload

- Numbers in the voice match the screen on the day (the economy totals move; re-read them from /economy before recording).
- No wallet addresses other than the two above are on screen; the ring seller is shown by address only, never named.
- The loop drawing had five uninterrupted seconds.
- Captions on: the voice mentions figures that viewers will want to read.
- Title: "Assay: the credit bureau for agent payments on Celo (2 min demo)". Description: the one-paragraph "What it found" from docs/SUBMISSION.md plus the link.
