import { getConnInfo } from "@hono/node-server/conninfo";
import {
  type Address,
  type Assessment,
  ERC8004_IDENTITY_REGISTRY,
  HACKATHON_WINDOW,
  independentPayers,
  isAddress,
  isTxHash,
  KNOWN_FACILITATORS,
  METHODOLOGY_VERSION,
  normalizeAddress,
  ownWatchMessage,
  RATING_FLOORS,
  ratingPlan,
  THIN_FILE,
  TOKENS,
  validateOwnWatch,
  verdictFor,
} from "assayscore-core";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Hash, PublicClient } from "viem";
import { WATCH_DAYS, type Watches } from "../alerts.js";
import type { Analysis } from "../analysis.js";
import type { Attester } from "../attest.js";
import { applyClaim, readClaim, readClaims } from "../claims.js";
import type { DB } from "../db.js";
import type { FxRates } from "../enrich/fx.js";
import {
  PaymentRefused,
  readXMentions,
  wantXMentions,
  X_REFRESH,
  type XMentions,
  type XMentionsWatcher,
  xReason,
} from "../enrich/xmentions.js";
import type { Env } from "../env.js";
import { BudgetExceeded } from "../lib/buy.js";
import { log } from "../lib/log.js";
import { signedShape, verifySigned } from "../lib/signed.js";
import { proveSettlement } from "../proof.js";
import { applyResponse, readResponses } from "../responses.js";
import { classify, type Usage } from "../usage.js";
import { badgeSvg } from "./badge.js";
import { independentReport } from "./independent.js";
import { PRICES, paidMiddleware } from "./paid.js";
import { adminStats, publicStats, selfView } from "./stats.js";

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
  /** What X says, with searches bought on demand for paying buyers when configured. */
  xmentions?: XMentionsWatcher | null;
  /** Rating-change alerts, when configured. */
  watches?: Watches | null;
}

const LIST_LIMIT = 100;
/** Free alerts for a claimed page's owner last this long per signature. */
const OWNER_WATCH_DAYS = 90;

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
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
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
  const xOnDemand = Boolean(deps.xmentions?.onDemand);
  const watchOffered = Boolean(deps.watches);
  app.use(
    "*",
    paidMiddleware(env, {
      syncOnStart: deps.syncFacilitatorOnStart ?? true,
      fx: deps.fx,
      xOnDemand,
      watch: watchOffered,
    }),
  );

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
  // Cached answers change with the analysis snapshot, and with every claim (names on reports).
  let claimsVersion = 0;
  const cached = snapshotCache(() => analysis.current().builtAt + claimsVersion, 4_000);

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
        paid: {
          "/v1/check/:address": usd(PRICES.check),
          ...(xOnDemand ? { "/v1/check/:address/x": usd(PRICES.checkX) } : {}),
          "/v1/attest/:address": usd(PRICES.attest),
          ...(watchOffered ? { "POST /v1/watch": `${usd(PRICES.watch)} for ${WATCH_DAYS} days` } : {}),
        },
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
    const minRating = c.req.query("minRating");
    const category = (c.req.query("category") ?? "").trim().toLowerCase();
    const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 80);
    const claimedOnly = c.req.query("claimed") === "1";
    const sort = c.req.query("sort") === "gross" ? "gross" : "organic";
    const claims = readClaims(deps.db);
    let rows = analysis.current().summary.sellersRanked.map((r) => {
      const cl = claims.get(r.address);
      return cl ? { ...r, name: cl.name, what: cl.what, category: cl.category, url: cl.url } : r;
    });
    if (rating) rows = rows.filter((r) => r.rating === rating);
    if (minRating) {
      const order = RATING_FLOORS.map(([x]) => x as string);
      const at = order.indexOf(minRating);
      if (at >= 0) rows = rows.filter((r) => order.indexOf(r.rating) >= 0 && order.indexOf(r.rating) <= at);
    }
    if (category) rows = rows.filter((r) => "category" in r && r.category === category);
    if (claimedOnly) rows = rows.filter((r) => "name" in r);
    if (q)
      rows = rows.filter(
        (r) =>
          r.address.includes(q) ||
          ("name" in r && (r.name ?? "").toLowerCase().includes(q)) ||
          ("what" in r && (r.what ?? "").toLowerCase().includes(q)) ||
          ("category" in r && (r.category ?? "").toLowerCase() === q) ||
          r.agentIds.some((id) => id === q || `#${id}` === q),
      );
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
      claim: readClaim(deps.db, address),
      responses: readResponses(deps.db, address),
    });
  });

  /** The seller's right of reply: a signed response under one finding, its own words, never scored. */
  app.post("/v1/respond", free, async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "bad_request", message: "Send the response as JSON." }, 400);
    }
    const out = await applyResponse(deps.db, body, { rpc: deps.rpc });
    if (!out.ok)
      return c.json(
        { error: out.status === 401 ? "bad_signature" : "bad_request", message: out.error },
        out.status,
      );
    claimsVersion++;
    return c.json(
      out.action === "withdraw" ? { withdrawn: out.code } : { code: out.code, response: out.response },
    );
  });

  /**
   * Free alerts for a claimed page's owner: sign once, get ninety days of webhooks on your own
   * address. Up to three URLs per address.
   */
  app.post("/v1/watch/own", free, async (c) => {
    if (!deps.watches) return c.json({ error: "not_offered", message: "Alerts are not offered here." }, 503);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        { error: "bad_request", message: "Send JSON with address, url, issuedAt, nonce and signature." },
        400,
      );
    }
    const v = validateOwnWatch(body);
    if (!v.ok) return c.json({ error: "bad_request", message: v.error }, 400);
    const now = Math.floor(Date.now() / 1000);
    const shape = signedShape(v.fields.issuedAt, body.signature, now);
    if (shape) return c.json({ error: "bad_request", message: shape }, 400);
    if (!(await verifySigned(v.fields.address, ownWatchMessage(v.fields), String(body.signature), deps.rpc)))
      return c.json({ error: "bad_signature", message: "The signature does not match this address." }, 401);
    if (!readClaim(deps.db, v.fields.address))
      return c.json(
        { error: "not_claimed", message: "Claim this page first; free alerts come with a claimed page." },
        403,
      );
    const out = deps.watches.create(v.fields.address, v.fields.url, now, {
      days: OWNER_WATCH_DAYS,
      note: "owner",
      maxForAddress: 3,
    });
    if (!out.ok) return c.json({ error: "bad_request", message: out.error }, out.status);
    return c.json(
      {
        id: out.id,
        secret: out.secret,
        address: v.fields.address,
        url: v.fields.url,
        expiresAt: out.expiresAt,
        renewed: out.renewed,
        note: out.renewed
          ? `Extended by ${OWNER_WATCH_DAYS} days. The secret was shown when the alerts were first set up.`
          : "Keep the secret: deliveries are signed with it, and it manages the alerts. A first delivery, watch.started, is on its way.",
      },
      201,
    );
  });

  /** What would raise this address's rating, from the real score formula. Free. */
  app.get("/v1/address/:address/plan", free, cached, (c) => {
    const raw = c.req.param("address");
    if (!isAddress(raw)) return badAddress(c);
    return c.json(ratingPlan(analysis.assess(normalizeAddress(raw))));
  });

  /**
   * Which of a seller's payers count as independent users by the hackathon's published rule,
   * with their volume inside the window. Free, so any team can check its own numbers.
   */
  app.get("/v1/independent/:address", free, cached, (c) => {
    const raw = c.req.param("address");
    if (!isAddress(raw)) return badAddress(c);
    const from = clampInt(c.req.query("from"), 1_600_000_000, 4_000_000_000, HACKATHON_WINDOW.start);
    const to = clampInt(c.req.query("to"), from, 4_000_000_000, HACKATHON_WINDOW.end);
    const limit = clampInt(c.req.query("limit"), 1, 500, 200);
    return c.json(independentReport(deps.db, analysis.assess(normalizeAddress(raw)), { from, to, limit }));
  });

  /** A badge for READMEs: the rating and fineness in the verdict's colour. */
  app.get("/v1/badge/:address", free, (c) => {
    const raw = c.req.param("address").replace(/\.svg$/i, "");
    if (!isAddress(raw)) return badAddress(c);
    c.header("content-type", "image/svg+xml; charset=utf-8");
    c.header("cache-control", "public, max-age=300");
    return c.body(badgeSvg(analysis.assess(normalizeAddress(raw))));
  });

  /**
   * A seller claims its page by signing a message from its wallet: a name, a website, an X
   * handle and a logo. The same message signed with action "release" removes the claim.
   */
  app.post("/v1/claim", free, async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "bad_request", message: "Send the claim as JSON." }, 400);
    }
    const out = await applyClaim(deps.db, body, { rpc: deps.rpc });
    if (!out.ok)
      return c.json(
        { error: out.status === 401 ? "bad_signature" : "bad_request", message: out.error },
        out.status,
      );
    claimsVersion++;
    return c.json(out.action === "release" ? { released: true } : { claim: out.claim });
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

  /**
   * A check plus an X search bought now for this buyer ($0.01; the search costs Assay $0.005).
   * A search from the last fifteen minutes is fresh enough and is reused. When the search cannot
   * be bought or does not answer, the response is an error status, which cancels the x402
   * settlement: nobody pays for evidence they did not get.
   */
  app.get("/v1/check/:address/x", async (c) => {
    const out = await checkWithX(deps, normalizeAddress(c.req.param("address")));
    if (out.retryAfter) c.header("retry-after", String(out.retryAfter));
    return c.json(out.body, out.status);
  });

  /**
   * Thirty days of alerts for one address, paid once. Validation failures answer 400, which
   * cancels the x402 settlement.
   */
  app.post("/v1/watch", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await c.req.text()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "bad_request", message: "Send JSON with address and url." }, 400);
    }
    const out = createWatch(deps, body);
    return c.json(out.body, out.status);
  });

  app.get("/v1/watch/:id", free, (c) => {
    if (!deps.watches) return c.json({ error: "not_offered", message: "Alerts are not offered here." }, 503);
    const s = deps.watches.status(c.req.param("id"), c.req.header("x-assay-watch-secret"));
    if (s.kind === "missing") return c.json({ error: "not_found", message: "No such watch." }, 404);
    if (s.kind === "forbidden")
      return c.json({ error: "forbidden", message: "Send the watch secret in x-assay-watch-secret." }, 401);
    c.header("cache-control", "no-store");
    return c.json({ watch: s.watch, deliveries: s.deliveries });
  });

  app.delete("/v1/watch/:id", free, (c) => {
    if (!deps.watches) return c.json({ error: "not_offered", message: "Alerts are not offered here." }, 503);
    const r = deps.watches.cancel(c.req.param("id"), c.req.header("x-assay-watch-secret"));
    if (r === "missing") return c.json({ error: "not_found", message: "No such watch." }, 404);
    if (r === "forbidden")
      return c.json({ error: "forbidden", message: "Send the watch secret in x-assay-watch-secret." }, 401);
    return c.body(null, 204);
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
  /** Assay's own address by its own rules, plus its independent payers by the hackathon's rule. */
  const selfOf = (payTo: Address) => {
    const a = analysis.assess(payTo);
    return { ...selfView(a), independent: independentPayers(a).totals.independent };
  };
  let statsCache: { at: number; body: unknown } | null = null;
  app.get("/v1/stats", free, (c) => {
    const now = Date.now();
    if (!statsCache || now - statsCache.at > 30_000)
      statsCache = {
        at: now,
        body: {
          ...publicStats(deps.db, env, deps.usage ?? null, deps.status(), now),
          // Assay rated by its own rules: the honest count of its independent customers.
          self: env.PAY_TO ? selfOf(env.PAY_TO.toLowerCase() as Address) : null,
        },
      };
    c.header("cache-control", "public, max-age=30");
    return c.json(statsCache.body as Record<string, unknown>);
  });

  /** Operator view behind ADMIN_KEY. Without the key set, the route does not exist. */
  let adminCache: { at: number; body: unknown } | null = null;
  // Wrong keys per IP: after ADMIN_MAX_FAILS in ADMIN_LOCK_MS, that IP gets 429 until the window ends.
  const adminFails = new Map<string, { n: number; until: number }>();
  app.get("/v1/admin", free, async (c) => {
    if (!env.ADMIN_KEY) return c.json({ error: "not_found", message: "Not found." }, 404);
    c.header("cache-control", "no-store");
    const now = Date.now();
    const ip = clientIp(c);
    const fails = adminFails.get(ip);
    if (fails && fails.until <= now) adminFails.delete(ip);
    else if (fails && fails.n >= ADMIN_MAX_FAILS) {
      c.header("retry-after", String(Math.ceil((fails.until - now) / 1000)));
      return c.json({ error: "locked", message: "Too many wrong keys. Try again later." }, 429);
    }
    const given = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!sameSecret(given, env.ADMIN_KEY)) {
      if (given) {
        const f = adminFails.get(ip) ?? { n: 0, until: now + ADMIN_LOCK_MS };
        f.n++;
        adminFails.set(ip, f);
        if (adminFails.size > 10_000) adminFails.delete(adminFails.keys().next().value as string);
        log.warn("admin key refused", { failures: f.n });
      }
      return c.json({ error: "unauthorized", message: "A valid admin key is required." }, 401);
    }
    adminFails.delete(ip);
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
      prices: {
        check: usd(PRICES.check),
        ...(xOnDemand ? { checkX: usd(PRICES.checkX) } : {}),
        attest: usd(PRICES.attest),
        ...(watchOffered ? { watch: usd(PRICES.watch) } : {}),
      },
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
  // /v1/check/:address and /v1/check/:address/x: the address is the third segment either way.
  const subject = c.req.path.split("/")[3] ?? "";
  if (!isAddress(subject)) return badAddress(c);
  await next();
};

/** The answer to a paid request to watch an address. Anything but 201 cancels the settlement. */
export function createWatch(
  deps: Pick<AppDeps, "watches">,
  body: Record<string, unknown>,
): { status: 201 | 400 | 429 | 503; body: Record<string, unknown> } {
  if (!deps.watches)
    return {
      status: 503,
      body: { error: "not_offered", message: "This Assay instance does not offer alerts." },
    };
  const address = String(body.address ?? "");
  if (!isAddress(address))
    return {
      status: 400,
      body: { error: "bad_address", message: "Expected a 0x-prefixed 20-byte address." },
    };
  const url = String(body.url ?? "").trim();
  const out = deps.watches.create(normalizeAddress(address), url);
  if (!out.ok) return { status: out.status, body: { error: "bad_request", message: out.error } };
  return {
    status: 201,
    body: {
      id: out.id,
      secret: out.secret,
      address: normalizeAddress(address),
      url,
      expiresAt: out.expiresAt,
      renewed: out.renewed,
      note: out.renewed
        ? `Extended by ${WATCH_DAYS} days. The secret was shown when the watch was created.`
        : "Keep the secret: deliveries are signed with it (x-assay-signature), and it manages the watch. A first delivery, watch.started, is on its way.",
    },
  };
}

/**
 * The answer to a paid check with a fresh X search. Any status other than 200 cancels the x402
 * settlement, so a buyer is never charged for a search that was not delivered.
 */
export async function checkWithX(
  deps: Pick<AppDeps, "xmentions" | "analysis" | "attester" | "status">,
  address: Address,
): Promise<{ status: 200 | 502 | 503; body: Record<string, unknown>; retryAfter?: number }> {
  const w = deps.xmentions;
  if (!w?.onDemand)
    return {
      status: 503,
      body: { error: "x_search_not_offered", message: "This Assay instance does not sell X searches." },
    };
  let got: { x: XMentions; reused: boolean };
  try {
    got = await w.fresh(address);
  } catch (err) {
    if (err instanceof BudgetExceeded)
      return {
        status: 503,
        retryAfter: secondsToMidnight(),
        body: {
          error: "x_budget_spent",
          message:
            "Assay's daily budget for X searches is spent; nothing was charged. Try again after 00:00 UTC, or use /v1/check without the search.",
        },
      };
    if (err instanceof PaymentRefused)
      log.error("on-demand x search: payment refused; top up the agent wallet", { reason: err.message });
    else log.warn("on-demand x search failed", { address, error: String(err) });
    return {
      status: 503,
      body: {
        error: "x_search_unavailable",
        message: "The X search could not be bought right now. Nothing was charged.",
      },
    };
  }
  if (got.x.status !== "ok")
    return {
      status: 502,
      body: {
        error: "x_search_failed",
        message: `The X search did not answer (${got.x.error ?? "unknown error"}). Nothing was charged.`,
      },
    };
  const a = deps.analysis.assess(address);
  const attestation = deps.attester ? await deps.attester.sign(a, deps.status().settlementsBlock) : null;
  return {
    status: 200,
    body: {
      ...withX(verdictFor(a), got.x),
      x: { ...got.x, fresh: true, reused: got.reused },
      asOf: deps.analysis.current().builtAt,
      attestation,
    },
  };
}

function secondsToMidnight(now = Date.now()): number {
  const day = 86_400;
  return day - (Math.floor(now / 1000) % day);
}

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
const ADMIN_MAX_FAILS = 5;
const ADMIN_LOCK_MS = 15 * 60_000;

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
