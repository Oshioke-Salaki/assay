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

## Monitoring

`.github/workflows/uptime.yml` runs `scripts/uptime.mjs` every 10 minutes. It checks:

- `/v1/status` answers, the indexer is at most 1,800 blocks (about 30 minutes) behind, and payments are on;
- a free report returns a verdict;
- the paid check still answers 402 with payment options;
- the home, economy and report pages render.

A failure opens one issue labelled `uptime`; GitHub emails everyone watching the repo. Further failures comment on that issue, and the first green run closes it. Run the same check by hand with `node scripts/uptime.mjs`, or from the Actions tab with "Run workflow". To point it at another deployment, set the repository variables `ASSAY_API_URL` and `ASSAY_WEB_URL`; `MAX_LAG_BLOCKS` changes the lag limit when you run it by hand.

## Publishing the packages

`@assay/core`, `@assay/sdk` and `@assay/mcp` publish to npm from the monorepo. `pnpm publish` turns `workspace:*` into the real version, and `prepublishOnly` builds each package first:

```sh
npm login
pnpm -r --filter "./packages/*" publish --access public
```

Bump the three versions together. Publish `core` first, since `sdk` and `mcp` depend on it; `pnpm -r` already publishes in dependency order.

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
