# Assay

**The credit bureau for agent payments on Celo.**

Assay reads every x402 settlement on Celo mainnet and tests each seller's revenue for what is real. Money that goes round in payment loops, and money paid by wallets the seller funded, is struck out. What is left is the seller's *organic* revenue, read as fineness in parts per thousand, the way an assay office marks silver. Every address gets a rating from AAA to D, a report with the evidence behind each finding, and a signed EIP-712 score that any Celo contract can verify through `AssayRegistry`.

Across all 858,007 x402 settlements on Celo mainnet ($192,170), Assay finds that **only 21% is organic**. $123,578 was paid by wallets the sellers funded themselves, and $28,870 went round in 9 payment loops, the largest 378 wallets paying each other. Of 660 sellers, 138 are rated D.

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

You need Node 22.12 or later, pnpm 10 (`corepack enable` gives you the pinned version), and, for the contracts, [Foundry](https://getfoundry.sh) 1.0 or later. Nothing below needs a wallet, an API key or funds.

```sh
git clone --recurse-submodules https://github.com/Oshioke-Salaki/assay
cd assay
pnpm install
pnpm -r --filter "./packages/**" build             # core, SDK and MCP, used by the server and the web app
cp apps/server/.env.example apps/server/.env      # every value is optional for a read-only node
pnpm --filter @assay/server backfill               # index Celo history from the SQD portal (resumable)
pnpm --filter @assay/server start                  # API + indexer on :8787
NEXT_PUBLIC_ASSAY_API=http://localhost:8787 pnpm --filter @assay/web dev
```

Paid routes, signed scores and X searches switch on only when their keys are set (`X402_API_KEY` and `PAY_TO`, `ATTESTER_PRIVATE_KEY`, `BUY_PAYER_KEY`); without them the API answers 503 on those routes and everything else works. To use the hosted API instead, point the web app at `https://api.assayscore.xyz`.

## Check it

```sh
pnpm check                          # Biome lint, typecheck every package, all TypeScript tests
cd contracts && forge build && forge test
                                    # AssayRegistry with solc 0.8.28 (pinned in foundry.toml; Foundry
                                    # downloads it once), including a signature made by the TypeScript attester
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.28.0 \
  detect -s /repo --config /repo/.gitleaks.toml --redact
                                    # secret scan of the full history; .gitleaks.toml lists the public
                                    # values (addresses, an event topic) it would otherwise flag
```

If you cloned without `--recurse-submodules`, run `git submodule update --init --recursive` before `forge build`. The same three checks run on every push and pull request in `.github/workflows/ci.yml`.

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
