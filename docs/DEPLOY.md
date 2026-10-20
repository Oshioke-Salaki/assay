# Deployment

Two deployables: the **server** (API, indexer, enrichment; needs a persistent disk) and the **web app** (Next.js; any Node host or Vercel).

## Server

Needs Node 22.12+, a persistent volume for the SQLite file, and outbound HTTPS.

```sh
pnpm install --frozen-lockfile
pnpm --filter @assay/core build && pnpm --filter @assay/server build
DATABASE_PATH=/data/assay.db pnpm --filter @assay/server backfill   # once; resumable
DATABASE_PATH=/data/assay.db pnpm --filter @assay/server start
```

Environment: see `apps/server/.env.example`. For a public node set at least `PUBLIC_URL`, `WEB_URL`, `CORS_ORIGINS` and `DATABASE_PATH`. To sell checks set `X402_API_KEY` (from x402.celo.org) and `PAY_TO`. To sign scores set `ATTESTER_PRIVATE_KEY` and `REGISTRY_ADDRESS`.

Railway, Fly.io or any VPS works: one service, one volume mounted where `DATABASE_PATH` points, health check on `/health`. Run one process with `ROLE=all`, or one `ROLE=indexer` plus any number of `ROLE=api` on the same volume.

## Web

```sh
NEXT_PUBLIC_ASSAY_API=https://<server> NEXT_PUBLIC_SITE_URL=https://<site> pnpm --filter @assay/web build
pnpm --filter @assay/web start
```

On Vercel set the project root to `apps/web`; the install runs at the monorepo root through pnpm workspaces. Environment: `NEXT_PUBLIC_ASSAY_API`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_REGISTRY_ADDRESS`, `NEXT_PUBLIC_ATTRIBUTION_TAG`.

## Onchain setup (once)

All from the agent wallet, every transaction tagged and verified by the CLI:

```sh
cd apps/server
pnpm ops register-agent        # ERC-8004 identity; prints AGENT_ID
pnpm ops deploy-registry       # AssayRegistry; prints REGISTRY_ADDRESS
pnpm ops publish 0xSubject     # sign and publish one score
pnpm ops verify-tag 0xTxHash   # check any transaction's attribution tag
```

Rehearse on a local fork first: `anvil --fork-url https://forno.celo.org` keeps chain id 42220, so signatures and the real ERC-8004 registry behave exactly as on mainnet.
