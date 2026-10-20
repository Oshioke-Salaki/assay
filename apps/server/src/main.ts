import { serve } from "@hono/node-server";
import { createApp } from "./api/app.js";
import { loadEnv } from "./env.js";
import { log } from "./lib/log.js";
import { createRuntime } from "./runtime.js";

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const env = loadEnv();
const runtime = createRuntime(env);
const controller = new AbortController();

let server: ReturnType<typeof serve> | null = null;
if (env.ROLE !== "indexer") {
  const app = createApp({ ...runtime });
  server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    log.info("assay api listening", { port: info.port, payments: Boolean(env.X402_API_KEY && env.PAY_TO) });
  });
}

const workers = env.ROLE !== "api" ? runtime.runWorkers(controller.signal) : Promise.resolve();

// An API-only process shares the database with a separate indexer process, so it cannot be told
// when new blocks land. It watches the cursors instead and refreshes its snapshot when they move.
let watcher: NodeJS.Timeout | null = null;
if (env.ROLE === "api") {
  let last = "";
  watcher = setInterval(() => {
    const s = runtime.status();
    const mark = `${s.settlementsBlock}:${s.registryBlock}`;
    if (mark !== last) {
      if (last) runtime.analysis.invalidate();
      last = mark;
    }
  }, 10_000);
  watcher.unref();
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  controller.abort();
  if (watcher) clearInterval(watcher);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await workers.catch(() => {});
  runtime.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { reason: String(reason) }));
