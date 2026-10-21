# Deployment

Two deployables: the **server** (API, indexer, enrichment; needs a persistent disk) and the **web app** (Next.js; any Node host or Vercel).

## Server

Needs Node 22.12+, a persistent volume for the SQLite file, and outbound HTTPS.

```sh
pnpm install --frozen-lockfile
pnpm --filter assayscore-core build && pnpm --filter @assay/server build
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

## Fly.io (current host)

The API runs on Fly as app `assayscore-api` in `iad`, from the same image Railway built, with the SQLite file on the volume `assay_data` at `/data`. `fly.toml` at the repo root holds the config: one machine that never stops (one writer for SQLite), a `/health` check, 2 GB of memory (the server uses about 150 MB; the headroom is for the funding scan). `api.assayscore.xyz` is a CNAME to `assayscore-api.fly.dev`, with a certificate Fly issues.

Deploy a new version by building the image and deploying it, no remote build needed:

```sh
docker buildx build --platform linux/amd64 -t ghcr.io/oshioke-salaki/assay-api:$(git rev-parse --short HEAD) --push .
fly deploy --image ghcr.io/oshioke-salaki/assay-api:$(git rev-parse --short HEAD)
```

Secrets are set with `fly secrets set` (or `fly secrets import < file`); the server needs everything in `apps/server/.env.example` except `OPERATOR_PRIVATE_KEY`, which only the operator CLI uses.

To move the database between hosts, copy it consistently and swap it in while the old file is out of the way:

```sh
sqlite3 assay.db ".backup seed.db" && gzip -1 seed.db
echo "put seed.db.gz /data/seed.db.gz" | fly ssh sftp shell
fly ssh console -C "sh -c 'gunzip -c /data/seed.db.gz > /data/seed.db && mv /data/seed.db /data/assay.db && rm -f /data/assay.db-wal /data/assay.db-shm /data/seed.db.gz'"
fly machine restart <id>
```

The indexer resumes from the copy's cursor and catches up on its own.

**Switching between Fly and Railway.** `api.assayscore.xyz` is the address the site, the SDK and the MCP server use, so whichever host it points at is the one serving Assay. One command moves it:

```sh
node scripts/api-host.mjs status            # where api.assayscore.xyz points, and whether each host is healthy and current
node scripts/api-host.mjs railway --dry-run # print the steps without changing anything
node scripts/api-host.mjs railway           # Fly -> Railway
node scripts/api-host.mjs fly               # Railway -> Fly
```

A switch never points anything at a host that is not answering:

1. Check that the target is healthy and caught up. It also has to run the current version, judged by its 402 offering all six tokens; `--force` overrides that.
2. Move the site to the target's own URL, which already has a certificate, and redeploy the site.
3. Point the `api` CNAME at the target. The new record is added before the old one is removed.
4. Wait for the target to serve `api.assayscore.xyz` over HTTPS.
5. Move the site back to `https://api.assayscore.xyz`.
6. Stop the old host's machine. Fly is stopped, not destroyed, so it keeps its volume and starts in seconds. Railway is stopped in its dashboard.

If the certificate is slow to arrive, the command stops after step 4 with the site still working on the target's own URL. Run it again later to finish.

Both hosts run the same image, each with its own SQLite file. Each indexes Celo on its own, so the one taking over is already current: a stopped Fly machine catches up within a minute of starting, and Railway keeps indexing while it runs. Enrichment data such as funding fills in again on whichever host serves.

The Railway service still runs the version from before the outage. Before switching back, deploy the latest code there with `railway up --service api` from the repo root. The switch refuses an outdated Railway unless forced. Railway's `_railway-verify.api` TXT record is already in DNS, so its certificate can be issued as soon as the CNAME points there. Also set `PUBLIC_URL=https://api.assayscore.xyz` on the Railway service. Its CORS list and `WEB_URL` already name assayscore.xyz; those changes are staged and apply with that deploy.

## Monitoring

`.github/workflows/uptime.yml` runs `scripts/uptime.mjs` every 10 minutes. It checks:

- `/v1/status` answers, the indexer is at most 1,800 blocks (about 30 minutes) behind, and payments are on;
- a free report returns a verdict;
- the paid check still answers 402 with payment options;
- the home, economy and report pages render.

A failure opens one issue labelled `uptime`; GitHub emails everyone watching the repo. Further failures comment on that issue, and the first green run closes it. Run the same check by hand with `node scripts/uptime.mjs`, or from the Actions tab with "Run workflow". To point it at another deployment, set the repository variables `ASSAY_API_URL` and `ASSAY_WEB_URL`; `MAX_LAG_BLOCKS` changes the lag limit when you run it by hand.

## Publishing the packages

`assayscore-core`, `assayscore` (the SDK) and `assayscore-mcp` publish to npm from the monorepo. npm requires two-factor authentication to publish, and only the npm CLI handles its browser approval, so pack with pnpm (which turns `workspace:*` into real versions) and publish the tarballs with npm, core first:

```sh
npm login
for p in core sdk mcp; do (cd packages/$p && pnpm run build && pnpm pack --pack-destination ../../out); done
npx -y npm@11 publish out/assayscore-core-*.tgz --access public --auth-type=web
npx -y npm@11 publish out/assayscore-[0-9]*.tgz --access public --auth-type=web
npx -y npm@11 publish out/assayscore-mcp-*.tgz --access public --auth-type=web
```

Approve the first publish in the browser and tick the option to skip 2FA for a few minutes; the other two then go straight through. Bump the three versions together. Use npm 11 (`npx -y npm@11 publish …`): npm 10 can report success for a publish that npm then holds. npm answers a publish with 202 Accepted and lists the version a few minutes later, after its checks, so wait for `npm view <name> version` to show it before announcing a release.

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
