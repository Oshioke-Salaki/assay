import { dayOf, tokenByAddress } from "assayscore-core";
import type { PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analysis } from "../src/analysis.js";
import { checkWithX, createApp } from "../src/api/app.js";
import { fiatUnits } from "../src/api/paid.js";
import { Attester } from "../src/attest.js";
import type { DB } from "../src/db.js";
import { PaymentRefused, type XMentions, XMentionsWatcher } from "../src/enrich/xmentions.js";
import { SettlementIndexer } from "../src/indexer/settlements.js";
import { BudgetExceeded } from "../src/lib/buy.js";
import { FIXTURE_BLOCKS, fakeSqd, fixedFx, memoryDb, testEnv } from "./helpers.js";

const RING = [1, 2, 3].map((i) => `0x${String(i).repeat(40)}`);
const SHOP = `0x${"5".repeat(40)}`;
const CUSTOMERS = Array.from({ length: 8 }, (_, i) => `0x${(i + 16).toString(16).padStart(40, "0")}`);
const REGISTRY = `0x${"9".repeat(40)}`;
const ATTESTER_KEY = `0x${"11".repeat(32)}` as const;

function seed(db: DB) {
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(
    "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const set = db.prepare(
    "INSERT INTO settlements (tx_hash, log_index, block, ts, relayer, token, payer, payee, amount, usd, scored) VALUES (?, 0, 1, ?, ?, ?, ?, ?, '1', ?, 1)",
  );
  let n = 0;
  const tx = () => `0x${(++n).toString(16).padStart(64, "0")}`;
  // A wash ring: every member pays the next.
  RING.forEach((p, i) => {
    for (let d = 0; d < 5; d++)
      ins.run(p, RING[(i + 1) % 3], dayOf(now) - d, 40, 200, now - d * 86_400, now - d * 86_400, tx());
  });
  // An honest shop with independent customers over three weeks.
  CUSTOMERS.forEach((c, i) => {
    for (let d = 0; d < 21; d += 2) {
      const h = tx();
      const ts = now - (d + i) * 3_600 - d * 86_400;
      ins.run(c, SHOP, dayOf(ts), 1, 0.5, ts, ts, h);
      set.run(
        h,
        ts,
        "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48",
        "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
        c,
        SHOP,
        0.5,
      );
    }
  });
  db.prepare(
    "INSERT INTO agents (agent_id, owner, wallet, uri, registered_block, registered_ts, name) VALUES ('42', ?, NULL, '', 1, 1, 'Shop Agent')",
  ).run(SHOP);
  const firstCustomerTx = (
    db.prepare("SELECT tx_hash FROM settlements WHERE payer = ? LIMIT 1").get(CUSTOMERS[0]) as {
      tx_hash: string;
    }
  ).tx_hash;
  const fb = db.prepare(
    `INSERT INTO feedback (agent_id, client, idx, value, decimals, tag1, tag2, endpoint, uri, hash, block, ts, tx_hash, proof_tx)
     VALUES ('42', ?, ?, ?, 0, 'x402', 'assay', '', 'data:', '0x', 2, ?, ?, ?)`,
  );
  fb.run(CUSTOMERS[0], 1, "95", now, `0x${"aa".repeat(32)}`, firstCustomerTx); // proven
  fb.run(CUSTOMERS[1], 1, "80", now, `0x${"bb".repeat(32)}`, null); // paid
  fb.run(`0x${"7".repeat(40)}`, 1, "100", now, `0x${"cc".repeat(32)}`, null); // never paid
}

function build(overrides: Record<string, string> = {}, opts: { attester?: boolean; sync?: boolean } = {}) {
  const env = testEnv({ CORS_ORIGINS: "https://assay.example", FREE_RATE_PER_MIN: "1000", ...overrides });
  const db = memoryDb();
  seed(db);
  const analysis = new Analysis(db, 0);
  const app = createApp({
    env,
    db,
    analysis,
    fx: fixedFx(db),
    rpc: {} as PublicClient,
    attester: opts.attester ? new Attester(ATTESTER_KEY, REGISTRY as `0x${string}`) : null,
    status: () => ({ settlementsBlock: 100, registryBlock: 100, finalizedHead: 120, lastSettlementTs: null }),
    syncFacilitatorOnStart: opts.sync ?? false,
  });
  return { app, db, analysis };
}

const get = (app: ReturnType<typeof build>["app"], path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers });

afterEach(() => vi.unstubAllGlobals());

describe("free API", () => {
  const { app } = build();

  it("reports health and status", async () => {
    expect((await get(app, "/health")).status).toBe(200);
    const s = (await (await get(app, "/v1/status")).json()) as Record<string, unknown>;
    expect(s.lagBlocks).toBe(20);
    expect(s.synced).toBe(true);
    expect(s.payments).toBe(false);
  });

  it("separates organic from circular volume in the economy summary", async () => {
    const e = (await (await get(app, "/v1/economy")).json()) as Record<string, number> & {
      topSellers: { address: string }[];
      reviews: Record<string, number>;
    };
    expect(e.grossUsd).toBeCloseTo(3 * 5 * 200 + 8 * 11 * 0.5, 6);
    expect(e.organicUsd).toBeCloseTo(8 * 11 * 0.5, 6);
    expect(e.loops).toBe(1);
    expect(e.topSellers[0]?.address).toBe(SHOP);
    expect(e.reviews).toEqual({ total: 3, fromPayers: 2, proven: 1 });
  });

  it("serves the daily series in day order", async () => {
    const { points } = (await (await get(app, "/v1/economy/daily?days=30")).json()) as {
      points: { day: number }[];
    };
    expect(points.length).toBeGreaterThan(5);
    expect(points.map((p) => p.day)).toEqual([...points.map((p) => p.day)].sort((a, b) => a - b));
  });

  it("assesses an address, case-insensitively", async () => {
    const res = await get(app, `/v1/address/${SHOP.toUpperCase().replace("0X", "0x")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assessment: { address: string; rating: string };
      check: { verdict: string };
      agents: unknown[];
    };
    expect(body.assessment.address).toBe(SHOP);
    expect(body.check.verdict).not.toBe("block");
    expect(body.agents).toHaveLength(1);
  });

  it("flags a ring member as circular", async () => {
    const body = (await (await get(app, `/v1/address/${RING[0]}`)).json()) as {
      assessment: { flags: { code: string }[]; seller: { organicUsd: number } };
      check: { verdict: string };
    };
    expect(body.assessment.seller.organicUsd).toBe(0);
    expect(body.assessment.flags[0]?.code).toBe("CIRCULAR_FLOW");
  });

  it("rejects bad input with 400s and unknown things with 404s", async () => {
    expect((await get(app, "/v1/address/0x123")).status).toBe(400);
    expect((await get(app, "/v1/agents/abc")).status).toBe(400);
    expect((await get(app, "/v1/agents/999999")).status).toBe(404);
    expect((await get(app, "/v1/proof/0x12")).status).toBe(400);
    expect((await get(app, "/nope")).status).toBe(404);
  });

  it("clamps list parameters", async () => {
    const res = (await (await get(app, "/v1/sellers?limit=99999&offset=-5")).json()) as {
      rows: unknown[];
      total: number;
    };
    expect(res.rows.length).toBeLessThanOrEqual(100);
    expect(res.total).toBe(4);
  });

  it("lists agents and ranks reviews by payment proof", async () => {
    const list = (await (await get(app, "/v1/agents?q=shop")).json()) as {
      total: number;
      rows: { agentId: string; paidReviews: number }[];
    };
    expect(list.total).toBe(1);
    expect(list.rows[0]?.paidReviews).toBe(2);
    const detail = (await (await get(app, "/v1/agents/42")).json()) as { reviews: { tier: string }[] };
    expect(detail.reviews.map((r) => r.tier).sort()).toEqual(["paid", "proven", "unverified"]);
  });

  it("lists a client's payments to an agent, for the review flow", async () => {
    const res = (await (await get(app, `/v1/agents/42/payments/${CUSTOMERS[0]}`)).json()) as {
      isOwner: boolean;
      payments: { txHash: string; usd: number }[];
    };
    expect(res.isOwner).toBe(false);
    expect(res.payments).toHaveLength(11);
    expect(res.payments[0]!.usd).toBe(0.5);
    const owner = (await (await get(app, `/v1/agents/42/payments/${SHOP}`)).json()) as {
      isOwner: boolean;
      payments: unknown[];
    };
    expect(owner.isOwner).toBe(true);
    expect(owner.payments).toEqual([]);
    expect((await get(app, "/v1/agents/42/payments/0x12")).status).toBe(400);
    expect((await get(app, `/v1/agents/777/payments/${SHOP}`)).status).toBe(404);
  });

  it("pages, searches and filters who paid an address", async () => {
    type Page = { total: number; counts: Record<string, number>; rows: { payer: string; class: string }[] };
    const p1 = (await (await get(app, `/v1/address/${SHOP}/payers?limit=3`)).json()) as Page;
    expect(p1.total).toBe(8);
    expect(p1.rows).toHaveLength(3);
    expect(p1.counts.all).toBe(8);
    const p3 = (await (await get(app, `/v1/address/${SHOP}/payers?limit=3&offset=6`)).json()) as Page;
    expect(p3.rows).toHaveLength(2);
    const seen = new Set([...p1.rows, ...p3.rows].map((r) => r.payer));
    expect(seen.size).toBe(5);
    const one = (await (
      await get(app, `/v1/address/${SHOP}/payers?q=${CUSTOMERS[0]!.slice(30)}`)
    ).json()) as Page;
    expect(one.rows.map((r) => r.payer)).toEqual([CUSTOMERS[0]]);
    const loops = (await (await get(app, `/v1/address/${RING[0]}/payers?class=loop`)).json()) as Page;
    expect(loops.rows.every((r) => r.class === "loop")).toBe(true);
    expect((await get(app, "/v1/address/0x12/payers")).status).toBe(400);
    const none = (await (await get(app, `/v1/address/${SHOP}/payers?q=zzzz`)).json()) as Page;
    expect(none.total).toBe(0);
  });

  it("pages who an address paid", async () => {
    const r = (await (await get(app, `/v1/address/${RING[0]}/counterparties?limit=1`)).json()) as {
      total: number;
      rows: unknown[];
    };
    expect(r.total).toBe(1);
    expect(r.rows).toHaveLength(1);
  });

  it("publishes an ERC-8004 registration file", async () => {
    const reg = (await (await get(app, "/.well-known/agent-registration.json")).json()) as Record<
      string,
      unknown
    >;
    expect(reg.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(reg.x402Support).toBe(true);
  });

  it("lets an x402 browser client's paid retry through the CORS preflight", async () => {
    const res = await app.request(`/v1/attest/${SHOP}`, {
      method: "OPTIONS",
      headers: {
        origin: "https://assay.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "payment-signature,access-control-expose-headers",
      },
    });
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("payment-signature");
    expect(allowed).toContain("access-control-expose-headers");
  });

  it("only allows configured CORS origins", async () => {
    const ok = await get(app, "/v1/economy", { origin: "https://assay.example" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://assay.example");
    const no = await get(app, "/v1/economy", { origin: "https://evil.example" });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("rate limiting", () => {
  it("answers 429 with retry-after once the free budget is spent", async () => {
    const { app } = build({ FREE_RATE_PER_MIN: "2" });
    const h = { "x-forwarded-for": "203.0.113.9" };
    expect((await get(app, "/v1/economy", h)).status).toBe(200);
    expect((await get(app, "/v1/economy", h)).status).toBe(200);
    const limited = await get(app, "/v1/economy", h);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await get(app, "/v1/economy", { "x-forwarded-for": "203.0.113.10" })).status).toBe(200);
  });
});

describe("response cache", () => {
  it("serves repeats from memory and drops everything when the snapshot changes", async () => {
    const { app, db, analysis } = build();
    const first = await get(app, `/v1/address/${SHOP}`);
    expect(first.headers.get("x-cache")).toBeNull();
    const second = await get(app, `/v1/address/${SHOP}`);
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(await second.json()).toEqual(await first.json());
    // New data lands: the next answer is computed fresh and reflects it.
    db.prepare(
      "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 1, 1000, 1, 1, '0x1')",
    ).run(`0x${"e".repeat(40)}`, SHOP);
    analysis.invalidate();
    const third = await get(app, `/v1/address/${SHOP}`);
    expect(third.headers.get("x-cache")).toBeNull();
    const t = (await third.json()) as { assessment: { seller: { grossUsd: number } } };
    expect(t.assessment.seller.grossUsd).toBeGreaterThan(1000);
  });

  it("never caches errors", async () => {
    const { app } = build();
    expect((await get(app, "/v1/agents/999999")).status).toBe(404);
    const again = await get(app, "/v1/agents/999999");
    expect(again.status).toBe(404);
    expect(again.headers.get("x-cache")).toBeNull();
  });
});

describe("X mentions", () => {
  it("shows what X says on the report and in the check's reasons, without touching the score", async () => {
    const { app, db, analysis } = build();
    const before = (await (await get(app, `/v1/address/${SHOP}`)).json()) as {
      x: unknown;
      check: { reasons: string[]; rating: string; verdict: string };
      assessment: { score: number | null };
    };
    expect(before.x).toBeNull();
    const timeline = [
      {
        type: "tweet",
        tweet_id: "7",
        screen_name: "watcher",
        created_at: "Mon Oct 20 10:00:00 +0000 2026",
        text: `Careful: ${SHOP} is a scam, it never delivers`,
        entities: { urls: [] },
        user_info: {
          screen_name: "watcher",
          created_at: "Sat Jan 29 01:21:15 +0000 2022",
          followers_count: 4000,
        },
      },
    ];
    await new XMentionsWatcher(db, {
      pay: (async () =>
        new Response(JSON.stringify({ transaction: null, output: { status: "ok", timeline } }), {
          status: 200,
        })) as unknown as typeof fetch,
      onChange: () => analysis.invalidate(),
    }).check(SHOP as `0x${string}`);
    const after = (await (await get(app, `/v1/address/${SHOP}`)).json()) as typeof before & {
      x: { mentions: number; warnings: number; posts: { url: string }[]; searchUrl: string };
    };
    expect(after.x).toMatchObject({ mentions: 1, warnings: 1 });
    expect(after.x.posts[0]?.url).toBe("https://x.com/watcher/status/7");
    expect(after.x.searchUrl).toContain("x.com/search");
    expect(after.check.reasons.at(-1)).toBe(
      "1 post on X names this address next to words like scam or hack; read it before paying",
    );
    // Evidence, not input: the verdict, rating and score are what the ledger says.
    expect(after.check.verdict).toBe(before.check.verdict);
    expect(after.check.rating).toBe(before.check.rating);
    expect(after.assessment.score).toBe(before.assessment.score);
  });
});

describe("internal key", () => {
  it("lets the web app's servers past the per-IP limit, and nobody else", async () => {
    const key = "k".repeat(32);
    const { app } = build({ FREE_RATE_PER_MIN: "1", INTERNAL_API_KEY: key });
    const ip = { "x-forwarded-for": "198.51.100.7" };
    for (let i = 0; i < 5; i++)
      expect((await get(app, "/v1/economy", { ...ip, "x-assay-internal": key })).status).toBe(200);
    expect((await get(app, "/v1/economy", ip)).status).toBe(200);
    expect((await get(app, "/v1/economy", ip)).status).toBe(429);
    expect((await get(app, "/v1/economy", { ...ip, "x-assay-internal": `${key}x` })).status).toBe(429);
    expect((await get(app, "/v1/economy", { ...ip, "x-assay-internal": `${"k".repeat(31)}j` })).status).toBe(
      429,
    );
  });

  it("limits each visitor the web app relays, separately from the relay itself", async () => {
    const key = "k".repeat(32);
    const { app } = build({ FREE_RATE_PER_MIN: "2", INTERNAL_API_KEY: key });
    const relay = { "x-forwarded-for": "203.0.113.9", "x-assay-internal": key };
    const a = { ...relay, "x-assay-client-ip": "198.51.100.1" };
    const b = { ...relay, "x-assay-client-ip": "198.51.100.2" };
    expect((await get(app, "/v1/economy", a)).status).toBe(200);
    expect((await get(app, "/v1/economy", a)).status).toBe(200);
    expect((await get(app, "/v1/economy", a)).status).toBe(429);
    expect((await get(app, "/v1/economy", b)).status).toBe(200);
    // Page renders from the same relay are still not limited.
    for (let i = 0; i < 4; i++) expect((await get(app, "/v1/economy", relay)).status).toBe(200);
    // Without the key, the header is ignored: a client cannot pick its own identity.
    const spoof = { "x-forwarded-for": "198.51.100.3" };
    expect((await get(app, "/v1/economy", { ...spoof, "x-assay-client-ip": "1.1.1.1" })).status).toBe(200);
    expect((await get(app, "/v1/economy", { ...spoof, "x-assay-client-ip": "1.1.1.2" })).status).toBe(200);
    expect((await get(app, "/v1/economy", { ...spoof, "x-assay-client-ip": "1.1.1.3" })).status).toBe(429);
  });
});

describe("wFIAT prices", () => {
  it("rounds up to two significant figures of the fiat, never below the dollar price", () => {
    expect(fiatUnits(2_000n, 1523, 18)).toBe(3_100_000_000_000_000_000n); // 3.046 ARS -> 3.1
    expect(fiatUnits(10_000n, 1523, 18)).toBe(16_000_000_000_000_000_000n); // 15.23 ARS -> 16
    expect(fiatUnits(2_000n, 5.05, 18)).toBe(11_000_000_000_000_000n); // 0.0101 BRL -> 0.011
    expect(fiatUnits(2_000n, 3174, 18)).toBe(6_400_000_000_000_000_000n); // 6.348 COP -> 6.4
    expect(fiatUnits(2_000n, 1500, 18)).toBe(3_000_000_000_000_000_000n); // exact stays exact
    expect(fiatUnits(2_000n, 1523.4, 18)).toBe(fiatUnits(2_000n, 1529, 18)); // small moves keep the price
    expect(() => fiatUnits(2_000n, 0, 18)).toThrow();
  });
});

describe("paid API", () => {
  it("answers 503 when selling is not configured, and 400 before that for bad addresses", async () => {
    const { app } = build();
    expect((await get(app, `/v1/check/${SHOP}`)).status).toBe(503);
    expect((await get(app, `/v1/check/${SHOP}/x`)).status).toBe(503);
    expect((await get(app, "/v1/check/not-an-address")).status).toBe(400);
    expect((await get(app, "/v1/check/not-an-address/x")).status).toBe(400);
    expect((await get(app, "/v1/attest/0x00")).status).toBe(400);
  });

  it("challenges unpaid requests with a 402 that prices USD₮ first, then the other dollars and wFIAT", async () => {
    const supported = {
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:42220" }],
      extensions: [],
      signers: { "eip155:42220": ["0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48"] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/supported")) return new Response(JSON.stringify(supported), { status: 200 });
        return new Response("{}", { status: 404 });
      }),
    );
    const { app } = build({ X402_API_KEY: "test-key-123", PAY_TO: `0x${"a".repeat(40)}` }, { sync: true });
    const res = await get(app, `/v1/check/${SHOP}`);
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const required = JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as {
      accepts: {
        asset: string;
        amount: string;
        payTo: string;
        network: string;
        extra: { name: string; assetTransferMethod?: string };
      }[];
      extensions?: Record<string, unknown>;
    };
    const symbols = required.accepts.map((a) => tokenByAddress(a.asset)?.symbol);
    expect(symbols).toEqual(["USDT", "USDC", "USAT", "wARS", "wBRL", "wCOP"]);
    // $0.002: 2000 micro-units of each dollar; wFIAT at the fixed test rates (ARS 1500, BRL 5, COP 4000).
    expect(required.accepts.map((a) => a.amount)).toEqual([
      "2000",
      "2000",
      "2000",
      "3000000000000000000",
      "10000000000000000",
      "8000000000000000000",
    ]);
    expect(required.accepts.slice(3).every((a) => a.extra.assetTransferMethod === "permit2")).toBe(true);
    expect(required.accepts[3]?.extra.name).toBe("Peso Argentino");
    expect(required.accepts.slice(0, 3).every((a) => a.extra.assetTransferMethod === undefined)).toBe(true);
    expect(required.extensions?.eip2612GasSponsoring).toBeTruthy();
    expect(required.accepts.every((a) => a.network === "eip155:42220")).toBe(true);
    // The 402 carries CORS so a browser can read it.
    const cross = await get(app, `/v1/check/${SHOP}`, { origin: "https://assay.example" });
    expect(cross.headers.get("access-control-allow-origin")).toBe("https://assay.example");
    // Free routes stay free when payments are on.
    expect((await get(app, "/v1/economy")).status).toBe(200);
  });
});

describe("Analysis rebuilds", () => {
  it("serves the old snapshot until invalidated", () => {
    const db = memoryDb();
    const analysis = new Analysis(db, 0);
    expect(analysis.current().summary.sellers).toBe(0);
    seed(db);
    expect(analysis.current().summary.sellers).toBe(0);
    analysis.invalidate();
    expect(analysis.current().summary.sellers).toBe(4);
  });

  it("indexes fixtures end to end into an assessable ledger", async () => {
    const db = memoryDb();
    const first = FIXTURE_BLOCKS[0]!.header.number;
    await new SettlementIndexer(db, fakeSqd(FIXTURE_BLOCKS), fixedFx(db), { fromBlock: first }).step(
      FIXTURE_BLOCKS.at(-1)!.header.number,
    );
    const analysis = new Analysis(db, 0);
    expect(analysis.current().summary.settlements).toBe(FIXTURE_BLOCKS.length);
  });
});

describe("paid check with a fresh X search", () => {
  const supported = {
    kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:42220" }],
    extensions: [],
    signers: { "eip155:42220": ["0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48"] },
  };
  const stubFacilitator = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/supported")) return new Response(JSON.stringify(supported), { status: 200 });
        return new Response("{}", { status: 404 });
      }),
    );
  const xOk = (over: Partial<XMentions> = {}): XMentions => ({
    address: SHOP as `0x${string}`,
    checkedAt: 1_000,
    status: "ok",
    mentions: 1,
    warnings: 0,
    weakWarnings: 0,
    posts: [],
    searchUrl: "https://x.com/search?q=x",
    tx: `0x${"ab".repeat(32)}`,
    ...over,
  });
  const watcher = (fresh: () => Promise<{ x: XMentions; reused: boolean }>) =>
    ({ onDemand: true, fresh }) as unknown as XMentionsWatcher;
  function withWatcher(w: XMentionsWatcher | null, overrides: Record<string, string> = {}) {
    const env = testEnv({ CORS_ORIGINS: "https://assay.example", FREE_RATE_PER_MIN: "1000", ...overrides });
    const db = memoryDb();
    seed(db);
    const analysis = new Analysis(db, 0);
    const deps = {
      env,
      db,
      analysis,
      fx: fixedFx(db),
      rpc: {} as PublicClient,
      attester: null,
      status: () => ({
        settlementsBlock: 100,
        registryBlock: 100,
        finalizedHead: 120,
        lastSettlementTs: null,
      }),
      syncFacilitatorOnStart: true,
      xmentions: w,
    };
    return { app: createApp(deps), deps };
  }

  it("is priced at $0.01 in every token, only when searches can be bought on demand", async () => {
    stubFacilitator();
    const paid = { X402_API_KEY: "test-key-123", PAY_TO: `0x${"a".repeat(40)}` };
    const { app } = withWatcher(
      watcher(async () => ({ x: xOk(), reused: false })),
      paid,
    );
    const res = await get(app, `/v1/check/${SHOP}/x`);
    expect(res.status).toBe(402);
    const required = JSON.parse(
      Buffer.from(res.headers.get("payment-required")!, "base64").toString("utf8"),
    ) as { accepts: { asset: string; amount: string }[] };
    expect(required.accepts).toHaveLength(6);
    expect(required.accepts.slice(0, 3).map((a) => a.amount)).toEqual(["10000", "10000", "10000"]);
    // The plain check still costs $0.002.
    const plain = await get(app, `/v1/check/${SHOP}`);
    const plainReq = JSON.parse(
      Buffer.from(plain.headers.get("payment-required")!, "base64").toString("utf8"),
    ) as { accepts: { amount: string }[] };
    expect(plainReq.accepts[0]?.amount).toBe("2000");
    expect(
      ((await (await get(app, "/")).json()) as { endpoints: { paid: Record<string, string> } }).endpoints
        .paid,
    ).toHaveProperty("/v1/check/:address/x", "$0.010");

    const { app: off } = withWatcher(null, paid);
    const none = await get(off, `/v1/check/${SHOP}/x`);
    expect(none.status).toBe(503);
    expect(((await none.json()) as { error: string }).error).toBe("x_search_not_offered");
    expect(
      ((await (await get(off, "/")).json()) as { endpoints: { paid: Record<string, string> } }).endpoints
        .paid,
    ).not.toHaveProperty("/v1/check/:address/x");
  });

  it("answers the check with the fresh picture, marked fresh and whether it was reused", async () => {
    const { deps } = withWatcher(watcher(async () => ({ x: xOk({ warnings: 1 }), reused: true })));
    const out = await checkWithX(deps, SHOP as `0x${string}`);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      verdict: expect.any(String),
      x: { fresh: true, reused: true, warnings: 1 },
    });
    expect((out.body.reasons as string[]).join(" ")).toMatch(/post on X names this address/);
  });

  it("refuses the sale when the search cannot be bought, so nothing is charged", async () => {
    const budget = await checkWithX(
      withWatcher(
        watcher(async () => {
          throw new BudgetExceeded(2, 2);
        }),
      ).deps,
      SHOP as `0x${string}`,
    );
    expect(budget.status).toBe(503);
    expect(budget.body.error).toBe("x_budget_spent");
    expect(budget.retryAfter).toBeGreaterThan(0);
    expect(budget.retryAfter).toBeLessThanOrEqual(86_400);

    const refused = await checkWithX(
      withWatcher(
        watcher(async () => {
          throw new PaymentRefused("insufficient funds");
        }),
      ).deps,
      SHOP as `0x${string}`,
    );
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe("x_search_unavailable");

    const down = await checkWithX(
      withWatcher(
        watcher(async () => ({ x: xOk({ status: "error", error: "X search answered 503" }), reused: false })),
      ).deps,
      SHOP as `0x${string}`,
    );
    expect(down.status).toBe(502);
    expect(down.body.message).toMatch(/503.*Nothing was charged/);
  });
});
