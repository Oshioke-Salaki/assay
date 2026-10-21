# Assay

**The credit bureau for agent payments on Celo.**

Assay reads every x402 settlement on Celo mainnet and tests each seller's revenue for what is real. Money that goes round in payment loops, and money paid by wallets the seller funded, is struck out. What is left is the seller's *organic* revenue, read as fineness in parts per thousand, the way an assay office marks silver. Every address gets a rating from AAA to D, a report with the evidence behind each finding, and a signed EIP-712 score that any Celo contract can verify through `AssayRegistry`.

On the first full pass of Celo mainnet history, Assay found 6 payment loops (the largest 378 wallets paying each other about $10 back and forth across 159,190 settlements) and netted out over $14,000 of circular volume.

- **People** read reports in the browser for free.
- **Agents** pay $0.002 per check over x402 in USD₮ (or USDC, USA₮, wARS, wBRL, wCOP), or put `withAssayGuard` (`npm install assayscore`) in front of their own x402 client so a blocked seller is never paid.
- **Contracts** gate on `AssayRegistry.isInvestmentGrade(seller)`.

Alongside the ledger, Assay searches X for every seller's exact address, paid per search through buy, and shows the posts that name it, warnings first. The posts are evidence for the reader and never move a score, because anyone can post about anyone.

## What is in this repo

| Path | What it is |
| --- | --- |
| `packages/core` | The scoring engine: payment graph, loop detection (Tarjan SCC), funding trace, ratings, verdicts, attestation format. Pure TypeScript, no I/O. |
| `apps/server` | Indexer (SQD Portal, finalized blocks), enrichment (first funders from an SQD log scan, Self Agent ID, ERC-8004 cards), the HTTP API with paid x402 routes, and the operator CLI. SQLite. |
| `apps/web` | The site: landing, economy, address reports, agents directory, payment-verified reviews, docs. Next.js 16. |
| `packages/sdk` | `createAssay` client and `withAssayGuard`, a drop-in guard for any x402 fetch. |
| `packages/mcp` | MCP server with four read-only tools for any agent. |
| `contracts` | `AssayRegistry.sol`: verifies and stores signed scores onchain. Foundry. |
| `docs` | Architecture, methodology, API, business model and scaling, deployment, hackathon notes. |

## Run it

```sh
pnpm install
pnpm build
cp apps/server/.env.example apps/server/.env      # fill in what you need; everything is optional for a read-only node
pnpm --filter @assay/server backfill               # index Celo history (resumable)
pnpm --filter @assay/server start                  # API + indexer on :8787
NEXT_PUBLIC_ASSAY_API=http://localhost:8787 pnpm --filter @assay/web start
```

## Check it

```sh
pnpm check                     # biome lint, typecheck every package, all TypeScript tests
cd contracts && forge test     # AssayRegistry, including a signature made by the TypeScript attester
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Methodology](docs/METHODOLOGY.md)
- [API](docs/API.md)
- [Business model and scaling](docs/BUSINESS.md)
- [Deployment](docs/DEPLOY.md)
- [Hackathon notes](docs/HACKATHON.md)

## Onchain

| | Address |
| --- | --- |
| Agent wallet (ERC-8004 identity, sender of every tagged transaction, x402 PayTo) | `0x3d5ea1ce6f3Fa5FAe7A38b77F569570b3ea9a9a4` |
| Attester (signs scores, sends nothing) | `0x8d9Ad56256a142f63a7e1C4aFCbcC17312939a46` |
| AssayRegistry ([Sourcify, exact match](https://sourcify.dev/server/repo-ui/42220/0xf6679308af9ff1ffc11a968dfd1ea5882152e29f)) | `0xf6679308af9ff1ffc11a968dfd1ea5882152e29f` |
| ERC-8004 agent | [#9981](https://8004scan.io/agents/celo/9981) |
| API | https://api.assayscore.xyz |
| Web | https://assayscore.xyz |
| ERC-8021 attribution tag | `celo_27fe67eb1be5` |

MIT licensed.
