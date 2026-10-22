# API

Base URL: `https://api.assayscore.xyz` (or wherever you deploy your own server). All responses are JSON. Errors are `{ "error": "<code>", "message": "<sentence>" }`.

## Paid (x402 on Celo: USD₮ · USDC · USA₮ · wARS · wBRL · wCOP)

| Route | Price | Returns |
| --- | --- | --- |
| `GET /v1/check/:address` | $0.002 | `verdict` (pass · caution · block), `rating`, `score`, `organicShare`, `reasons`, `attestation`, `x` in brief |
| `GET /v1/check/:address/x` | $0.01 | the same check plus an X search bought now for this buyer through the buy gateway: `x` in full (every post naming the address, warnings counted) with `fresh: true` and `reused` (a search from the last 15 minutes served it). If the search cannot be bought or does not answer, 502 or 503 with `retry-after` when the day's budget is spent, and the x402 payment is **not** settled |
| `GET /v1/attest/:address` | $0.01 | the full assessment (payer lines up to 500), `check`, linked `agents`, `attestation` |
| `POST /v1/watch` | $0.05 | thirty days of alerts for one address. Body `{ "address", "url" }` (public https only). Answers 201 `{ id, secret, expiresAt, renewed }`; the secret is shown once. Paying again for the same address and URL extends the watch. 400 cancels the settlement |

An unpaid request answers 402 with a `PAYMENT-REQUIRED` header listing six options in this order: USD₮ (the default), USDC, USA₮, then Ripio's wARS, wBRL and wCOP. The dollars are paid with EIP-3009. The wFIAT tokens are paid through the x402 Permit2 proxy at the day's exchange rate, rounded up to two significant figures (for $0.002: 3.1 wARS, 0.011 wBRL, 6.4 wCOP at mid-October rates). The 402 declares `eip2612GasSponsoring`, so a payer without a Permit2 approval signs an EIP-2612 permit and the facilitator submits it: no payer ever needs CELO for gas.

x402's default selector takes the first option, whatever the wallet holds. An agent that holds USDC should pick it: `new x402Client(preferAssets("USDC"))`, with `preferAssets` from `assayscore`. x402 clients also pay only their default assets (on Celo: USDC, USD₮, USA₮) unless told otherwise. To pay in a wFIAT token, allow it on the client:

```ts
client.setSpendControls({
  allowedAssets: [{ network: "eip155:42220", asset: "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d" }], // wARS
});
```

Token addresses: wARS `0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d`, wBRL `0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0`, wCOP `0x8a1d45e102e886510e891d2ec656a708991e2d76`.

The on-demand search is offered only when the server can buy searches (`BUY_PAYER_KEY` and `X_ONDEMAND_DAILY_CAP_USD` set); `GET /` lists it under `endpoints.paid` when it is. For a payment under a cent, the free report is the right tool: the paid check exists for the signature a contract can verify and for evidence fetched on demand.

Bad addresses answer 400 before any payment is asked for. With no `X402_API_KEY`/`PAY_TO` configured the paid routes answer 503.

`attestation` is `{ domain, types, primaryType: "Score", message, signature, signer }`; integers in `message` are decimal strings. Submit it to `AssayRegistry.publish` or verify it with `AssayRegistry.verify`.

## Free (60 requests a minute per IP, then 429 with `retry-after`)

| Route | Returns |
| --- | --- |
| `GET /v1/address/:address` | `assessment` (payer lines up to 100), `check`, `agents`, `x` (what X says, or `null` before the first search), `claim` (the name, website and X handle the wallet's owner signed, or `null`), `responses` (the seller's signed words under each finding, by code) |
| `GET /v1/independent/:address?from=&to=&limit=200` | which payers count as independent users by the hackathon's rule (not the seller or its loop, not funded by the seller or its funder, active on Celo before the window), each with reasons and volume inside the window; `totals` and the `rule` in words. Default window: the hackathon's |
| `GET /v1/badge/:address.svg` | an SVG badge with the rating and fineness in the verdict's colour; `cache-control: public, max-age=300` |
| `POST /v1/claim` | a signed claim: `{ address, action: "claim" \| "release", name, url, x, logoUrl, what, category, issuedAt, nonce, signature }` (`what` up to 80 characters, `category` one of data, ai, payments, compute, social, commerce, finance, identity, other) where `signature` is the wallet's EIP-191 signature of `claimMessage(fields)` from `assayscore-core`. Valid for ten minutes; 401 when the signature does not recover to the address; 400 with a plain reason for bad names (reserved words, length, characters) or links (https and public hosts only) |
| `POST /v1/respond` | the seller's right of reply: `{ address, code, action: "respond" \| "withdraw", text, issuedAt, nonce, signature }`, where `signature` is the wallet's EIP-191 signature of `responseMessage(fields)` from `assayscore-core`. `code` is one of the finding codes; `text` is 10 to 500 characters of plain text. Shown under that finding on the report as the seller's own words, dated; never part of a score |
| `POST /v1/watch/own` | free alerts for a claimed page's owner: `{ address, url, issuedAt, nonce, signature }` signing `ownWatchMessage(fields)`. Ninety days per signature, up to three URLs per address, 403 until the page is claimed. Same deliveries and secret as a paid watch |
| `GET /v1/watch/:id` · `DELETE /v1/watch/:id` | status (with the last ten deliveries) and cancellation of a watch; the secret goes in `x-assay-watch-secret` |
| `GET /v1/address/:address/payers?limit=20&offset=0&q=&class=` | one page of who paid it, searchable, filterable by class, with counts |
| `GET /v1/address/:address/counterparties?limit=20&offset=0&q=&loop=1` | one page of who it paid |
| `GET /v1/economy` | totals: gross, organic, loop offset, self-funded, settlements, sellers, payers, loops, rating counts, review stats, top sellers |
| `GET /v1/economy/daily?days=120` | `points[]`: day (days since epoch), grossUsd, organicUsd, settlements |
| `GET /v1/sellers?limit=50&offset=0&sort=organic\|gross&rating=A&minRating=BB&category=data&claimed=1&q=` | every seller with rating and revenue, searchable by claimed name, what they sell, category, agent id or address fragment; `minRating` keeps that rating or better; `claimed=1` keeps claimed pages. Claimed rows carry `name`, `what`, `category`, `url` |
| `GET /v1/payer/:address?seller=0x…` | a payer check, for sellers: `verdict` (established · new · caution · block), `reasons` in plain words, age on Celo, funder and whether it is public, spending breadth, loop share, identity, and with `seller` how it stands to that seller (`withSeller.class`: organic, seller-funded, shared-funder, loop or none) |
| `GET /v1/address/:address/plan` | what would raise the rating: `next` (rating, floor, points away), `thin` (what a thin file still needs), `customers` (typical customer size, how many reach the next rating, score by count), `levers` (customers, time, activity, identity, each with the score after), `struckOut`, `keep` (what would lower it). Every number comes from the real score formula |
| `GET /v1/agents?q=&limit=30&offset=0&paid=1` | ERC-8004 agents ranked by reviews from paying wallets, then revenue |
| `GET /v1/agents/:id` | `agent`, `assessment` of its wallet, `check`, `reviews` with tiers, `x` for its wallet |
| `GET /v1/agents/:id/payments/:client` | a client's settlements to the agent, and whether the client owns it |
| `GET /v1/proof/:tx` | a live check of one transaction: `{ ok, status, settlements }` |
| `GET /v1/status` | indexed blocks, lag, relayers, paid services used, attester, registry |
| `GET /v1/paid-calls` | every call Assay paid another service for, with its settlement transaction. Reconciled against the chain every five minutes, so a payment whose answer was lost still appears |
| `GET /v1/methodology` | version, thin-file thresholds, rating floors, prices |
| `GET /.well-known/agent-registration.json` | Assay's ERC-8004 registration file |
| `GET /health` | `{ ok: true }` |
| `GET /v1/stats` | Assay's own numbers, shown at [assayscore.xyz/stats](https://assayscore.xyz/stats): `usage` (requests per UTC day and kind for 30 days, distinct callers per day), `revenue` (settlements to Assay's PayTo: total, payers, by token, per day, the last 10 with transactions), `spend` (paid services by total), `x` (sellers searched, with mentions, with warnings) and `data` (indexed block, lag, funding coverage). Cached for 30 seconds |

`/v1/stats` counts callers as salted hashes of their IP, one per day, so days cannot be linked and no address is kept; the hashes are deleted after 90 days. Health, status, stats, preflight and operator requests are not counted.

### Operator

`GET /v1/admin` with `Authorization: Bearer <ADMIN_KEY>` returns the agent wallet's and PayTo's balances (CELO, USDC, USD₮, USA₮), today's spend against each daily cap, the X queue, the last 20 paid calls including failures, the last 50 warnings and errors since restart, and the database and process. It answers 404 when `ADMIN_KEY` is not set, 401 for a missing or wrong key, and 429 for 15 minutes after five wrong keys from one IP. It is never cached, and every URL in the log lines it returns is cut to its origin so an RPC key in a path never reaches the browser. The page at [assayscore.xyz/admin](https://assayscore.xyz/admin) asks for the key, keeps it in that tab's session storage only, and refreshes every 30 seconds.

## Alerts (webhooks)

A watch delivers a JSON POST for `watch.started` (right away, so the receiver can confirm the pipe), `rating.changed`, `verdict.changed`, `finding.critical` (a new critical finding code) and `x.warnings` (posts with warning words appeared on X). The body is `{ id, event, watch, address, at, detail, previous, current, report, api }`, where `previous` and `current` are `{ rating, score, verdict, critical[], xWarnings }`. Headers: `x-assay-event`, `x-assay-delivery`, `x-assay-watch`, `x-assay-timestamp`, and `x-assay-signature: sha256=<hex HMAC-SHA256 over "<timestamp>.<body>" with the watch secret>`. Verify the signature and ignore anything older than a few minutes.

Delivery: 10-second timeout, redirects not followed, retried after 1, 5, 30, 120 and 720 minutes, then given up. A watch whose deliveries keep failing is disabled after twenty. The receiving host is resolved at every delivery and must be public: private and loopback addresses are refused, which also covers DNS rebinding. Watches are checked every two minutes.

## What X says (`x`)

```json
{
  "checkedAt": 1792602807,
  "status": "ok",
  "mentions": 16,
  "warnings": 1,
  "weakWarnings": 0,
  "posts": [
    {
      "url": "https://x.com/…/status/…",
      "author": "…",
      "followers": 343,
      "verified": true,
      "postedAt": 1701566005,
      "excerpt": "…got scammed and drained … 0xd8dA…",
      "warning": true,
      "weak": false,
      "copy": false
    }
  ],
  "searchUrl": "https://x.com/search?q=…",
  "tx": "0x…"
}
```

- `warnings` counts distinct posts from established accounts that name the address next to a warning word. `weakWarnings` counts the same from new or small accounts.
- `tx` is the buy payment that paid for this search.
- `x` never changes `assessment`, `score`, `rating` or `verdict`. When there are warnings, the check's `reasons` gain one sentence. See [METHODOLOGY.md](METHODOLOGY.md#what-x-says).
- A paid `/v1/check` returns a brief `x` (counts and `searchUrl`). On an address not yet searched, it queues a search.

## Assessment shape (abridged)

```json
{
  "address": "0x…",
  "role": "seller | buyer | both | none",
  "score": 74,
  "rating": "A",
  "components": { "quality": 0.93, "effectivePayers": 11.2, "diversity": 0.84, "activeDays": 19, "track": 0.85, "identityBonus": 3, "dormancyFactor": 1 },
  "seller": { "grossUsd": 120.5, "organicUsd": 112.1, "loopOffsetUsd": 8.4, "fundedUsd": 0, "settlements": 410, "payers": 14, "organicPayers": 13, "payerLines": [] },
  "buyer": { "spentUsd": 3.1, "loopSpendUsd": 0, "sellers": 2, "counterparties": [] },
  "loop": { "size": 2, "members": ["0x…", "0x…"] },
  "flags": [{ "code": "CIRCULAR_FLOW", "severity": "warning", "title": "Circular revenue", "detail": "…", "usd": 8.4, "addresses": [], "txs": [] }],
  "identity": { "agentIds": ["1853"], "human": { "agentId": "12", "nullifier": "…", "fresh": true }, "funding": { "funder": "0x…", "fundedAt": 1790000000, "firstSeenAt": 1789000000, "funderIsPublic": true } },
  "fundingCoverage": 1,
  "methodologyVersion": "2026.10-1"
}
```

Flag codes: `CIRCULAR_FLOW`, `SELLER_FUNDED_PAYERS`, `SHARED_FUNDER`, `SAME_HUMAN_PAYERS`, `CONCENTRATED_REVENUE`, `SINGLE_PURPOSE_PAYERS`, `DORMANT`, `THIN_FILE`, `HUMAN_BACKED`, `ERC8004_AGENT`, `ESTABLISHED_PAYERS`, `PARTIAL_FUNDING_DATA`.

## SDK

```sh
npm install assayscore
```

```ts
import { createAssay, withAssayGuard } from "assayscore";

const assay = createAssay(); // the public API; pass { baseUrl } for your own server
const { check } = await assay.address("0xSeller");

const guarded = withAssayGuard(fetch, payingFetch, { minRating: "BB" });
```

The package README has the full guard options: [packages/sdk/README.md](../packages/sdk/README.md).

## MCP

```sh
claude mcp add assay -- npx -y assayscore-mcp
```

Any other MCP client: `{ "command": "npx", "args": ["-y", "assayscore-mcp"] }`. Set `ASSAY_URL` to use your own server.

Tools: `assay_check_seller`, `assay_report`, `assay_find_agents`, `assay_economy`.

## Contract

```solidity
function isInvestmentGrade(address subject) external view returns (bool);              // fresh, BBB or better
function scoreOf(address subject) external view returns (Score memory, bool fresh);
function verify(Score calldata s, bytes calldata signature) external view returns (bool);
function publish(Score calldata s, bytes calldata signature) external;                 // anyone; newer replaces older
```

EIP-712 domain `{ name: "Assay", version: "1", chainId: 42220, verifyingContract: <registry> }`.
