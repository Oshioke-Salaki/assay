# Assay server: API + indexer + enrichment. The SQLite file lives on a volume at /data.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @assay/server... --filter assayscore-core
COPY packages/core packages/core
COPY apps/server apps/server
RUN pnpm --filter assayscore-core build && pnpm --filter @assay/server build
RUN pnpm --filter @assay/server deploy --prod --legacy /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATABASE_PATH=/data/assay.db PORT=8787
WORKDIR /app
COPY --from=build /out .
EXPOSE 8787
CMD ["node", "dist/main.js"]
