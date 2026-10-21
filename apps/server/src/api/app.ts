import { getConnInfo } from "@hono/node-server/conninfo";
import {
  type Address,
  type Assessment,
  ERC8004_IDENTITY_REGISTRY,
  isAddress,
  isTxHash,
  KNOWN_FACILITATORS,
  METHODOLOGY_VERSION,
  normalizeAddress,
  RATING_FLOORS,
  THIN_FILE,
  TOKENS,
  verdictFor,
} from "assayscore-core";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Hash, PublicClient } from "viem";
import type { Analysis } from "../analysis.js";
import type { Attester } from "../attest.js";
import type { DB } from "../db.js";
import type { FxRates } from "../enrich/fx.js";
import { readXMentions, wantXMentions, X_REFRESH, type XMentions, xReason } from "../enrich/xmentions.js";
import type { Env } from "../env.js";
import { log } from "../lib/log.js";
import { proveSettlement } from "../proof.js";
import { classify, type Usage } from "../usage.js";
import { PRICES, paidMiddleware } from "./paid.js";
import { adminStats, publicStats } from "./stats.js";

export interface IndexStatus {
  settlementsBlock: number;
  registryBlock: number;
  finalizedHead: number | null;
  lastSettlementTs: number | null;
}

export interface AppDeps {
  env: Env;
  db: DB;
  analysis: Analysis;
  fx: FxRates;
  rpc: PublicClient;
  attester: Attester | null;
  status: () => IndexStatus;
  /** Tests pass false so the x402 middleware does not call the facilitator at startup. */
  syncFacilitatorOnStart?: boolean;
  /** Counts what the API is used for; absent in tests that do not care. */
  usage?: Usage | null;
}

const LIST_LIMIT = 100;

export function createApp(deps: AppDeps): Hono {
  const { env, analysis } = deps;
  const app = new Hono();
  const origins = env.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Outermost: the x402 middleware builds a fresh Response when settlement fails, which drops the
  // CORS headers. Re-apply them so a browser shows the real reason instead of "Failed to fetch".
  app.use("*", async (c, next) => {
    await next();
    const origin = c.req.header("origin");
    if (!origin || c.res.headers.get("access-control-allow-origin")) return;
    if (!(origins.includes("*") || origins.includes(origin))) return;
    c.res.headers.set("access-control-allow-origin", origin);
    c.res.headers.set(
      "access-control-expose-headers",
      "payment-required,payment-response,x-payment-response",
    );
    c.res.headers.append("vary", "Origin");
  });
  // Count each finished request by kind. The site's own page renders carry the internal key and
  // name no visitor, so they count as use but not as a caller.
  app.use("*", async (c, next) => {
    await next();
    const usage = deps.usage;
    if (!usage) return;
    const kind = classify(c.req.method, c.req.path, c.res.status);
    if (!kind) return;
    const internal = sameSecret(c.req.header("x-assay-internal"), env.INTERNAL_API_KEY);
    usage.record(kind, internal ? (c.req.header("x-assay-client-ip")?.trim() ?? null) : clientIp(c));
  });
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "cross-origin" }));
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.includes("*") || origins.includes(origin) ? origin : null),
      allowMethods: ["GET", "OPTIONS"],
      // x402 browser clients send access-control-expose-headers on their paid retry; refusing it
      // fails the preflight and the payment looks like a network error.
      allowHeaders: [
        "content-type",
        "payment-signature",
        "x-payment",
        "access-control-expose-headers",
        "authorization",
      ],
      exposeHeaders: ["payment-required", "payment-response", "x-payment-response"],
      maxAge: 600,
    }),
  );
  app.use("*", bodyLimit({ maxSize: 16 * 1024 }));
  app.use("/v1/check/*", validateAddressParam);
  app.use("/v1/attest/*", validateAddressParam);
  app.use("*", paidMiddleware(env, { syncOnStart: deps.syncFacilitatorOnStart ?? true, fx: deps.fx }));

  const free = rateLimit(env.FREE_RATE_PER_MIN, env.INTERNAL_API_KEY);

  /**
   * Queue an X search for an address someone asked about, when it has none or a stale one. A paid
   * check always counts; a free view counts only for a real seller, so looking up random
   * addresses cannot spend the X budget. Never fails the request it rides on.
   */
  const askX = (x: XMentions | null, address: string, grossUsd: number, paid: boolean) => {
    if (!env.BUY_PAYER_KEY || env.X_MENTIONS_DAILY_CAP_USD <= 0) return;
    if (x && Math.floor(Date.now() / 1000) - x.checkedAt < X_REFRESH) return;
    if (!paid && grossUsd < env.X_MENTIONS_MIN_GROSS_USD) return;
    try {
      wantXMentions(deps.db, address, paid);
    } catch (err) {
      log.warn("x mentions queue failed", { address, error: String(err) });
    }
  };
  const cached = snapshotCache(() => analysis.current().builtAt, 4_000);

  app.get("/", (c) =>
    c.json({
      name: "Assay",
      description:
        "Credit bureau for the agent economy on Celo. Organic x402 revenue, payment loops and ratings.",
      web: env.WEB_URL,
      docs: `${env.WEB_URL}/docs`,
      methodology: METHODOLOGY_VERSION,
      endpoints: {
        free: [
          "/v1/economy",
          "/v1/economy/daily",
          "/v1/sellers",
          "/v1/address/:address",
          "/v1/agents",
          "/v1/agents/:id",
          "/v1/proof/:tx",
          "/v1/status",
        ],
        paid: { "/v1/check/:address": usd(PRICES.check), "/v1/attest/:address": usd(PRICES.attest) },
      },
    }),
  );

  app.get("/health", (c) => {
    deps.db.prepare("SELECT 1").get();
    return c.json({ ok: true });
  });

  app.get("/v1/status", (c) => {
    const s = deps.status();
    const lag = s.finalizedHead === null ? null : Math.max(0, s.finalizedHead - s.settlementsBlock);
    return c.json({
      ...s,
      lagBlocks: lag,
      // Celo produces a block every second.
      synced: lag !== null && lag < 600,
      relayers: deps.db
        .prepare(
          "SELECT address, settlements, usd, first_block AS firstBlock, last_block AS lastBlock FROM relayers ORDER BY settlements DESC LIMIT 20",
        )
        .all()
        .map((r) => ({
          ...(r as object),
          name:
            KNOWN_FACILITATORS.find((f) => f.address === (r as { address: string }).address)?.name ?? null,
        })),
      paidServices: deps.db
        .prepare(
          "SELECT service, COUNT(*) AS calls, COALESCE(SUM(usd), 0) AS usd, MAX(ts) AS lastTs FROM paid_calls WHERE tx_hash IS NOT NULL GROUP BY service",
        )
        .all(),
      attester: deps.attester?.address ?? null,
      registry: env.REGISTRY_ADDRESS ?? null,
      payments: Boolean(env.X402_API_KEY && env.PAY_TO),
    });
  });

  app.get("/v1/economy", free, (c) => {
    const snap = analysis.current();
    const s = snap.summary;
    c.header("cache-control", "public, max-age=15");
    return c.json({
      asOf: snap.builtAt,
      methodology: METHODOLOGY_VERSION,
      grossUsd: s.grossUsd,
      organicUsd: s.organicUsd,
      loopOffsetUsd: s.loopOffsetUsd,
      fundedUsd: s.fundedUsd,
      settlements: s.settlements,
      sellers: s.sellers,
      payers: s.payers,
      organicPayers: s.organicPayers,
      loops: s.loops,
      addressesInLoops: s.addressesInLoops,
      largestLoop: s.largestLoop,
      ratingCounts: s.ratingCounts,
      reviews: snap.reviews,
      topSellers: s.sellersRanked.filter((x) => x.organicUsd > 0).slice(0, 12),
      tokens: TOKENS.map((t) => ({ symbol: t.symbol, address: t.address })),
    });
  });

  app.get("/v1/economy/daily", free, cached, (c) => {
    const days = clampInt(c.req.query("days"), 1, 3650, 120);
    const daily = analysis.current().daily;
    c.header("cache-control", "public, max-age=60");
    return c.json({ points: daily.slice(-days) });
  });

  app.get("/v1/sellers", free, cached, (c) => {
    const limit = clampInt(c.req.query("limit"), 1, LIST_LIMIT, 50);
    const offset = clampInt(c.req.query("offset"), 0, 1_000_000, 0);
    const rating = c.req.query("rating");
    const sort = c.req.query("sort") === "gross" ? "gross" : "organic";
    let rows = analysis.current().summary.sellersRanked;
    if (rating) rows = rows.filter((r) => r.rating === rating);
    if (sort === "gross") rows = [...rows].sort((a, b) => b.grossUsd - a.grossUsd);
    return c.json({ total: rows.length, rows: rows.slice(offset, offset + limit) });
  });

  app.get("/v1/address/:address", free, cached, (c) => {
    const raw = c.req.param("address");
    if (!isAddress(raw)) return badAddress(c);
    const address = normalizeAddress(raw);
    const a = analysis.assess(address);
    const x = readXMentions(deps.db, address);
    askX(x, address, a.seller.grossUsd, false);
    return c.json({
      asOf: analysis.current().builtAt,
      assessment: trimAssessment(a),
      check: withX(verdictFor(a), x),
      agents: analysis.agentsFor(address),
      x,
    });
  });

  /** One page of who paid an address, searchable by address and filterable by class. */
  app.get("/v1/address/:address/payers", free, cached, (c) => {
    const raw = c.req.param("address");
    if (!isAddress(raw)) return badAddress(c);
    const limit = clampInt(c.req.query("limit"), 1, LIST_LIMIT, 20);
    const offset = clampInt(c.req.query("offset"), 0, 1_000_000, 0);
    const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 42);
    const cls = c.req.query("class");
    const all = analysis.assess(normalizeAddress(raw)).seller.payerLines;
    const rows = all.filter(
      (l) =>
        (!q || l.payer.includes(q) || (l.funder ?? "").includes(q)) &&
        (!cls || cls === "all" || l.class === cls),
    );
    const counts = { all: all.length, organic: 0, loop: 0, "seller-funded": 0, "shared-funder": 0 } as Record<
      string,
      number
    >;
    for (const l of all) counts[l.class] = (counts[l.class] ?? 0) + 1;
    return c.json({ total: rows.length, counts, offset, limit, rows: rows.slice(offset, offset + limit) });
  });

  /** One page of who an address paid, searchable by address. */
  app.get("/v1/address/:address/counterparties", free, cached, (c) => {
    const raw = c.req.param("address");
    if (!isAddress(raw)) return badAddress(c);
    const limit = clampInt(c.req.query("limit"), 1, LIST_LIMIT, 20);
    const offset = clampInt(c.req.query("offset"), 0, 1_000_000, 0);
    const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 42);
    const loop = c.req.query("loop");
    const all = analysis.assess(normalizeAddress(raw)).buyer.counterparties;
    const rows = all.filter((x) => (!q || x.payee.includes(q)) && (loop !== "1" || x.inLoop));
    return c.json({
      total: rows.length,
      all: all.length,
      offset,
      limit,
      rows: rows.slice(offset, offset + limit),
    });
  });

  app.get("/v1/agents", free, cached, (c) => {
    const limit = clampInt(c.req.query("limit"), 1, LIST_LIMIT, 30);
    const offset = clampInt(c.req.query("offset"), 0, 1_000_000, 0);
    const q = (c.req.query("q") ?? "").slice(0, 80) || undefined;
    return c.json(analysis.agents({ limit, offset, q, onlyPaid: c.req.query("paid") === "1" }));
  });

  app.get("/v1/agents/:id", free, cached, (c) => {
    const id = c.req.param("id");
    if (!/^\d{1,30}$/.test(id))
      return c.json({ error: "bad_agent_id", message: "Agent ids are integers." }, 400);
    const agent = analysis.agent(id);
    if (!agent) return c.json({ error: "not_found", message: `No ERC-8004 agent #${id} on Celo.` }, 404);
    const wallet = (agent.wallet ?? agent.owner) as Address;
    const a = analysis.assess(wallet);
    const x = readXMentions(deps.db, wallet);
    askX(x, wallet, a.seller.grossUsd, false);
    return c.json({
      agent,
      assessment: trimAssessment(a),
      check: withX(verdictFor(a), x),
      reviews: analysis.reviews(id),
      x,
    });
  });

  app.get("/v1/agents/:id/payments/:client", free, (c) => {
    const id = c.req.param("id");
    const client = c.req.param("client");
    if (!/^\d{1,30}$/.test(id))
      return c.json({ error: "bad_agent_id", message: "Agent ids are integers." }, 400);
    if (!isAddress(client)) return badAddress(c);
    const agent = analysis.agent(id);
    if (!agent) return c.json({ error: "not_found", message: `No ERC-8004 agent #${id} on Celo.` }, 404);
    const c2 = normalizeAddress(client);
    return c.json({
      agent: { agentId: agent.agentId, owner: agent.owner, wallet: agent.wallet },
      isOwner: c2 === agent.owner || c2 === agent.wallet,
      payments: analysis.payments(id, c2),
    });
  });

  /** Live check of one transaction, for the review flow. Not limited to the finalized index. */
  app.get("/v1/proof/:tx", free, async (c) => {
    const tx = c.req.param("tx");
    if (!isTxHash(tx))
      return c.json({ error: "bad_tx", message: "Expected a 32-byte transaction hash." }, 400);
    try {
      const result = await proveSettlement(deps.rpc, deps.fx, tx.toLowerCase() as Hash);
      return c.json(result);
    } catch (err) {
      log.warn("proof lookup failed", { tx, error: String(err) });
      return c.json({ error: "rpc_unavailable", message: "Could not reach Celo RPC. Try again." }, 502);
    }
  });

  app.get("/v1/check/:address", async (c) => {
    const address = normalizeAddress(c.req.param("address"));
    const a = analysis.assess(address);
    const attestation = deps.attester ? await deps.attester.sign(a, deps.status().settlementsBlock) : null;
    const x = readXMentions(deps.db, address);
    askX(x, address, a.seller.grossUsd, true);
    return c.json({
      ...withX(verdictFor(a), x),
      x: x && {
        checkedAt: x.checkedAt,
        mentions: x.mentions,
        warnings: x.warnings,
        weakWarnings: x.weakWarnings,
        searchUrl: x.searchUrl,
      },
      asOf: analysis.current().builtAt,
      attestation,
    });
  });

  app.get("/v1/attest/:address", async (c) => {
    const address = normalizeAddress(c.req.param("address"));
    const a = analysis.assess(address);
    const attestation = deps.attester ? await deps.attester.sign(a, deps.status().settlementsBlock) : null;
    const x = readXMentions(deps.db, address);
    askX(x, address, a.seller.grossUsd, true);
    return c.json({
      asOf: analysis.current().builtAt,
      assessment: trimAssessment(a, 500),
      check: withX(verdictFor(a), x),
      agents: analysis.agentsFor(address),
      x,
      attestation,
    });
  });

  /** Proof of payment for every call Assay paid a service it does not own (buy track). */
  /** Public numbers about Assay itself: usage, revenue at its PayTo, spend, data freshness. */
  let statsCache: { at: number; body: unknown } | null = null;
  app.get("/v1/stats", free, (c) => {
    const now = Date.now();
    if (!statsCache || now - statsCache.at > 30_000)
      statsCache = { at: now, body: publicStats(deps.db, env, deps.usage ?? null, deps.status(), now) };
    c.header("cache-control", "public, max-age=30");
    return c.json(statsCache.body as Record<string, unknown>);
  });

  /** Operator view behind ADMIN_KEY. Without the key set, the route does not exist. */
  let adminCache: { at: number; body: unknown } | null = null;
  app.get("/v1/admin", free, async (c) => {
    if (!env.ADMIN_KEY) return c.json({ error: "not_found", message: "Not found." }, 404);
    const given = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    c.header("cache-control", "no-store");
    if (!sameSecret(given, env.ADMIN_KEY))
      return c.json({ error: "unauthorized", message: "A valid admin key is required." }, 401);
    const now = Date.now();
    if (!adminCache || now - adminCache.at > 15_000)
      adminCache = { at: now, body: await adminStats(deps.db, env, deps.rpc, now) };
    return c.json(adminCache.body as Record<string, unknown>);
  });

  app.get("/v1/paid-calls", free, (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 500, 100);
    return c.json({
      rows: deps.db
        .prepare(
          "SELECT ts, service, status, usd, tx_hash AS txHash, payer FROM paid_calls WHERE tx_hash IS NOT NULL ORDER BY id DESC LIMIT ?",
        )
        .all(limit),
    });
  });

  app.get("/v1/methodology", (c) =>
    c.json({
      version: METHODOLOGY_VERSION,
      thinFile: THIN_FILE,
      ratingFloors: Object.fromEntries(RATING_FLOORS),
      prices: { check: usd(PRICES.check), attest: usd(PRICES.attest) },
    }),
  );

  app.get("/.well-known/agent-registration.json", (c) =>
    c.json({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Assay",
      description:
        "Credit bureau for the agent economy on Celo. Scores every x402 seller by organic revenue, detects payment loops and self-funded payers, and signs EIP-712 scores that contracts can verify.",
      image: `${env.WEB_URL}/apple-icon`,
      services: [
        { name: "web", endpoint: env.WEB_URL },
        { name: "x402-check", endpoint: `${env.PUBLIC_URL}/v1/check/{address}`, version: "1" },
        { name: "x402-attest", endpoint: `${env.PUBLIC_URL}/v1/attest/{address}`, version: "1" },
        {
          name: "MCP",
          endpoint: "https://www.npmjs.com/package/assayscore-mcp",
          version: "1",
        },
      ],
      x402Support: true,
      active: true,
      registrations: env.AGENT_ID
        ? [{ agentId: Number(env.AGENT_ID), agentRegistry: `eip155:42220:${ERC8004_IDENTITY_REGISTRY}` }]
        : [],
      supportedTrust: ["reputation"],
    }),
  );

  app.notFound((c) => c.json({ error: "not_found", message: "No such endpoint." }, 404));
  app.onError((err, c) => {
    log.error("request failed", { path: c.req.path, error: String(err), stack: err.stack });
    return c.json({ error: "internal", message: "Something went wrong on our side." }, 500);
  });
  return app;
}

const validateAddressParam: MiddlewareHandler = async (c, next) => {
  const last = c.req.path.split("/").pop() ?? "";
  if (!isAddress(last)) return badAddress(c);
  await next();
};

function badAddress(c: Context) {
  return c.json({ error: "bad_address", message: "Expected a 0x-prefixed 20-byte address." }, 400);
}

/** Cap list sizes so one popular address cannot produce a multi-megabyte response. */
function trimAssessment(a: Assessment, max = LIST_LIMIT) {
  return {
    ...a,
    seller: {
      ...a.seller,
      payerLines: a.seller.payerLines.slice(0, max),
      payerLinesTruncated: a.seller.payerLines.length > max,
    },
    buyer: {
      ...a.buyer,
      counterparties: a.buyer.counterparties.slice(0, max),
      counterpartiesTruncated: a.buyer.counterparties.length > max,
    },
  };
}

function clampInt(v: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function usd(micros: bigint): string {
  return `$${(Number(micros) / 1e6).toFixed(3)}`;
}

/**
 * Response cache for read-only routes, keyed by URL and tied to the analysis snapshot: when new
 * blocks rebuild the snapshot every entry is dropped, so nothing stale is ever served. Bounded,
 * oldest entries evicted first. Only 200 answers are kept.
 */
/**
 * Add what X says to a check's reasons. The verdict and rating stay the ledger's: a post cannot
 * move a score, but a reader deciding whether to pay should know people are warning about it.
 */
function withX<T extends { reasons: string[] }>(check: T, x: XMentions | null): T {
  const line = xReason(x);
  return line ? { ...check, reasons: [...check.reasons, line] } : check;
}

export function snapshotCache(version: () => number, maxEntries: number): MiddlewareHandler {
  const store = new Map<string, { body: string; type: string }>();
  let current = -1;
  return async (c, next) => {
    const v = version();
    if (v !== current) {
      store.clear();
      current = v;
    }
    const key = c.req.url.slice(c.req.url.indexOf("/", 8));
    const hit = store.get(key);
    if (hit) {
      c.header("x-cache", "hit");
      return c.body(hit.body, 200, { "content-type": hit.type });
    }
    await next();
    if (c.res.status !== 200) return;
    const type = c.res.headers.get("content-type") ?? "application/json";
    const body = await c.res.clone().text();
    if (store.size >= maxEntries) store.delete(store.keys().next().value as string);
    store.set(key, { body, type });
  };
}

/**
 * Fixed-window limiter per client IP. Memory is swept every window. Assay's own web server sends
 * the internal key: its page renders are not limited, but when it relays a visitor's request it
 * names the visitor in `x-assay-client-ip`, and that visitor is limited like any other.
 */
export function rateLimit(perMinute: number, internalKey?: string): MiddlewareHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  const trusted = (c: Context) => sameSecret(c.req.header("x-assay-internal"), internalKey);
  let sweep = Date.now() + 60_000;
  return async (c, next) => {
    const relayed = trusted(c) ? c.req.header("x-assay-client-ip")?.trim() : undefined;
    if (trusted(c) && !relayed) return next();
    const now = Date.now();
    if (now > sweep) {
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
      sweep = now + 60_000;
    }
    const ip = relayed ? `relayed:${relayed.slice(0, 64)}` : clientIp(c);
    const entry = hits.get(ip);
    if (!entry || entry.reset <= now) {
      hits.set(ip, { n: 1, reset: now + 60_000 });
    } else if (++entry.n > perMinute) {
      c.header("retry-after", String(Math.ceil((entry.reset - now) / 1000)));
      return c.json(
        {
          error: "rate_limited",
          message: "Too many requests. Agents can use the paid endpoints without limits.",
        },
        429,
      );
    }
    await next();
  };
}

/** Constant-time comparison, so a key cannot be guessed byte by byte from response times. */
export function sameSecret(given: string | undefined, secret: string | undefined): boolean {
  if (!secret || !given || given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

function clientIp(c: Context): string {
  // The last hop is the one our own proxy appended; earlier entries are client-supplied.
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
