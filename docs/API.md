# API

Base URL: `https://api-production-63cc.up.railway.app` (or wherever you deploy your own server). All responses are JSON. Errors are `{ "error": "<code>", "message": "<sentence>" }`.

## Paid (x402 on Celo: USD₮ · USDC · USA₮ · wARS · wBRL · wCOP)

| Route | Price | Returns |
| --- | --- | --- |
| `GET /v1/check/:address` | $0.002 | `verdict` (pass · caution · block), `rating`, `score`, `organicShare`, `reasons`, `attestation` |
| `GET /v1/attest/:address` | $0.01 | the full assessment (payer lines up to 500), `check`, linked `agents`, `attestation` |

An unpaid request answers 402 with a `PAYMENT-REQUIRED` header listing six options in this order: USD₮ (the default), USDC, USA₮, then Ripio's wARS, wBRL and wCOP. The dollars are paid with EIP-3009. The wFIAT tokens are paid through the x402 Permit2 proxy at the day's exchange rate, rounded up to two significant figures (for $0.002: 3.1 wARS, 0.011 wBRL, 6.4 wCOP at mid-October rates). The 402 declares `eip2612GasSponsoring`, so a payer without a Permit2 approval signs an EIP-2612 permit and the facilitator submits it: no payer ever needs CELO for gas.

x402's default selector takes the first option, whatever the wallet holds. An agent that holds USDC should pick it: `new x402Client(preferAssets("USDC"))`, with `preferAssets` from `assayscore`. x402 clients also pay only their default assets (on Celo: USDC, USD₮, USA₮) unless told otherwise. To pay in a wFIAT token, allow it on the client:

```ts
client.setSpendControls({
  allowedAssets: [{ network: "eip155:42220", asset: "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d" }], // wARS
});
```

Token addresses: wARS `0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d`, wBRL `0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0`, wCOP `0x8a1d45e102e886510e891d2ec656a708991e2d76`.

Bad addresses answer 400 before any payment is asked for. With no `X402_API_KEY`/`PAY_TO` configured the paid routes answer 503.

`attestation` is `{ domain, types, primaryType: "Score", message, signature, signer }`; integers in `message` are decimal strings. Submit it to `AssayRegistry.publish` or verify it with `AssayRegistry.verify`.

## Free (60 requests a minute per IP, then 429 with `retry-after`)

| Route | Returns |
| --- | --- |
| `GET /v1/address/:address` | `assessment` (payer lines up to 100), `check`, `agents` |
| `GET /v1/economy` | totals: gross, organic, loop offset, self-funded, settlements, sellers, payers, loops, rating counts, review stats, top sellers |
| `GET /v1/economy/daily?days=120` | `points[]`: day (days since epoch), grossUsd, organicUsd, settlements |
| `GET /v1/sellers?limit=50&offset=0&sort=organic\|gross&rating=A` | every seller with rating and revenue |
| `GET /v1/agents?q=&limit=30&offset=0&paid=1` | ERC-8004 agents ranked by reviews from paying wallets, then revenue |
| `GET /v1/agents/:id` | `agent`, `assessment` of its wallet, `check`, `reviews` with tiers |
| `GET /v1/agents/:id/payments/:client` | a client's settlements to the agent, and whether the client owns it |
| `GET /v1/proof/:tx` | a live check of one transaction: `{ ok, status, settlements }` |
| `GET /v1/status` | indexed blocks, lag, relayers, paid services used, attester, registry |
| `GET /v1/paid-calls` | every call Assay paid another service for, with its settlement transaction |
| `GET /v1/methodology` | version, thin-file thresholds, rating floors, prices |
| `GET /.well-known/agent-registration.json` | Assay's ERC-8004 registration file |
| `GET /health` | `{ ok: true }` |

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
