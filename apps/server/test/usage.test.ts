import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { Analysis } from "../src/analysis.js";
import { createApp } from "../src/api/app.js";
import { classify, Usage } from "../src/usage.js";
import { memoryDb, testEnv } from "./helpers.js";

const SHOP = `0x${"5".repeat(40)}`;
const DAY_MS = 86_400_000;

describe("classify", () => {
  it("names each kind of use and skips what is not usage", () => {
    expect(classify("GET", `/v1/address/${SHOP}`, 200)).toBe("report");
    expect(classify("GET", `/v1/check/${SHOP}`, 200)).toBe("check_paid");
    expect(classify("GET", `/v1/check/${SHOP}`, 402)).toBe("check_quoted");
    expect(classify("GET", `/v1/attest/${SHOP}`, 200)).toBe("attest_paid");
    expect(classify("GET", "/v1/agents/42", 200)).toBe("agents");
    expect(classify("GET", "/v1/economy/daily", 200)).toBe("economy");
    expect(classify("GET", "/v1/sellers", 200)).toBe("economy");
    expect(classify("GET", "/v1/proof/0x1", 200)).toBe("api_other");
    expect(classify("GET", "/v1/economy", 429)).toBe("rate_limited");
    for (const [m, p, s] of [
      ["GET", "/health", 200],
      ["GET", "/v1/status", 200],
      ["GET", "/v1/stats", 200],
      ["GET", "/v1/admin", 200],
      ["OPTIONS", "/v1/economy", 204],
      ["GET", `/v1/address/${SHOP}`, 404],
      ["GET", `/v1/check/${SHOP}`, 503],
    ] as const)
      expect(classify(m, p, s)).toBeNull();
  });
});

describe("Usage", () => {
  it("counts in memory and writes on flush, per day and kind", () => {
    const db = memoryDb();
    const u = new Usage(db, "salt");
    const t = Date.UTC(2026, 9, 21, 12);
    u.record("report", "1.1.1.1", t);
    u.record("report", "1.1.1.1", t);
    u.record("check_paid", "2.2.2.2", t);
    u.record("report", "1.1.1.1", t - DAY_MS);
    expect((db.prepare("SELECT COUNT(*) AS n FROM usage_daily").get() as { n: number }).n).toBe(0);
    const days = u.daily(2, t);
    expect(days.map((d) => d.counts.report)).toEqual([1, 2]);
    expect(days[1]?.counts.check_paid).toBe(1);
    expect(days[1]?.visitors).toBe(2);
    expect(u.totals()).toMatchObject({ report: 3, check_paid: 1, attest_paid: 0 });
  });

  it("adds to counts already written, across flushes", () => {
    const db = memoryDb();
    const u = new Usage(db, "salt");
    const t = Date.UTC(2026, 9, 21, 12);
    u.record("report", null, t);
    u.flush();
    u.record("report", null, t);
    u.flush();
    expect(u.daily(1, t)[0]?.counts.report).toBe(2);
  });

  it("never stores a caller's address, and counts each caller once a day", () => {
    const db = memoryDb();
    const u = new Usage(db, "salt");
    const t = Date.UTC(2026, 9, 21, 12);
    for (let i = 0; i < 5; i++) u.record("report", "203.0.113.7", t);
    u.record("report", "203.0.113.8", t);
    u.flush();
    const hashes = db.prepare("SELECT hash FROM usage_visitors").all() as { hash: string }[];
    expect(hashes).toHaveLength(2);
    expect(JSON.stringify(hashes)).not.toContain("203.0.113");
    // The same caller on another day is a new hash: days cannot be linked.
    u.record("report", "203.0.113.7", t + DAY_MS);
    u.flush();
    const all = (db.prepare("SELECT hash FROM usage_visitors").all() as { hash: string }[]).map(
      (r) => r.hash,
    );
    expect(new Set(all).size).toBe(3);
  });

  it("does not count rate-limited callers as visitors", () => {
    const db = memoryDb();
    const u = new Usage(db, "salt");
    const t = Date.UTC(2026, 9, 21, 12);
    u.record("rate_limited", "9.9.9.9", t);
    expect(u.daily(1, t)[0]).toMatchObject({ visitors: 0, counts: { rate_limited: 1 } });
  });

  it("keeps the counts when a write fails, and writes them next time", () => {
    const db = memoryDb();
    const u = new Usage(db, "salt");
    const t = Date.UTC(2026, 9, 21, 12);
    u.record("report", "1.1.1.1", t);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    u.flush();
    spy.mockRestore();
    expect(u.daily(1, t)[0]).toMatchObject({ visitors: 1, counts: { report: 1 } });
  });

  it("drops caller hashes older than the window it keeps", () => {
    const db = memoryDb();
    const u = new Usage(db, "salt");
    const t = Date.UTC(2026, 9, 21, 12);
    u.record("report", "1.1.1.1", t - 100 * DAY_MS);
    u.record("report", "1.1.1.1", t);
    u.flush();
    u.prune(90, t);
    expect((db.prepare("SELECT COUNT(*) AS n FROM usage_visitors").get() as { n: number }).n).toBe(1);
  });
});

function app(overrides: Record<string, string> = {}, rpc: Partial<PublicClient> = {}) {
  const env = testEnv({ FREE_RATE_PER_MIN: "1000", PAY_TO: SHOP, ...overrides });
  const db = memoryDb();
  const now = Math.floor(Date.now() / 1000);
  const set = db.prepare(
    "INSERT INTO settlements (tx_hash, log_index, block, ts, relayer, token, payer, payee, amount, usd, scored) VALUES (?, 0, ?, ?, '0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48', ?, ?, ?, '1', ?, 1)",
  );
  set.run(
    `0x${"1".padStart(64, "0")}`,
    1,
    now - 100,
    "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
    `0x${"a".repeat(40)}`,
    SHOP,
    0.002,
  );
  set.run(
    `0x${"2".padStart(64, "0")}`,
    2,
    now - 50,
    "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
    `0x${"b".repeat(40)}`,
    SHOP,
    0.01,
  );
  set.run(
    `0x${"3".padStart(64, "0")}`,
    3,
    now - 10,
    "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
    `0x${"b".repeat(40)}`,
    `0x${"c".repeat(40)}`,
    5,
  );
  db.prepare(
    "INSERT INTO paid_calls (ts, service, url, status, usd, tx_hash, payer) VALUES (?, 'buy-x-search', 'u', 200, 0.005, ?, 'p')",
  ).run(now, `0x${"9".repeat(64)}`);
  const usage = new Usage(db, "salt");
  const a = createApp({
    env,
    db,
    analysis: new Analysis(db, 0),
    fx: {} as never,
    rpc: rpc as PublicClient,
    attester: null,
    status: () => ({
      settlementsBlock: 100,
      registryBlock: 100,
      finalizedHead: 120,
      lastSettlementTs: now - 10,
    }),
    syncFacilitatorOnStart: false,
    usage,
  });
  return { app: a, usage, db };
}

const get = (a: ReturnType<typeof app>["app"], path: string, headers: Record<string, string> = {}) =>
  a.request(path, { headers: { "x-forwarded-for": "198.51.100.4", ...headers } });

describe("GET /v1/stats", () => {
  it("shows usage, revenue at the PayTo address, spend and data freshness", async () => {
    const { app: a } = app();
    await get(a, `/v1/address/${SHOP}`);
    await get(a, "/v1/economy");
    const res = await get(a, "/v1/stats");
    expect(res.status).toBe(200);
    const s = (await res.json()) as {
      usage: { totals: Record<string, number>; days: { visitors: number }[] };
      revenue: {
        payments: number;
        usd: number;
        payers: number;
        byToken: { symbol: string }[];
        recent: { tx: string }[];
      };
      spend: { usd: number; services: { service: string; calls: number }[] };
      data: { lagBlocks: number };
    };
    expect(s.usage.totals).toMatchObject({ report: 1, economy: 1 });
    expect(s.usage.days.at(-1)?.visitors).toBe(1);
    // Only payments to Assay's PayTo count as its revenue.
    expect(s.revenue).toMatchObject({ payments: 2, payers: 2 });
    expect(s.revenue.usd).toBeCloseTo(0.012);
    expect(s.revenue.byToken.map((t) => t.symbol).sort()).toEqual(["USDC", "USDT"]);
    expect(s.revenue.recent[0]?.tx).toBe(`0x${"2".padStart(64, "0")}`);
    expect(s.spend).toMatchObject({ services: [{ service: "buy-x-search", calls: 1 }] });
    expect(s.data.lagBlocks).toBe(20);
  });

  it("counts the website's page renders as use but not as callers", async () => {
    const key = "k".repeat(32);
    const { app: a, usage } = app({ INTERNAL_API_KEY: key });
    await get(a, `/v1/address/${SHOP}`, { "x-assay-internal": key });
    await get(a, `/v1/address/${SHOP}`, { "x-assay-internal": key, "x-assay-client-ip": "192.0.2.1" });
    const today = usage.daily(1)[0];
    expect(today?.counts.report).toBe(2);
    expect(today?.visitors).toBe(1);
  });
});

describe("GET /v1/admin", () => {
  const ADMIN = "a".repeat(40);
  const rpc = {
    getBalance: vi.fn(async () => 2n * 10n ** 18n),
    readContract: vi.fn(async () => 1_500_000n),
  } as unknown as Partial<PublicClient>;

  it("treats an empty ADMIN_KEY as unset and refuses a short one", () => {
    expect(testEnv({ ADMIN_KEY: "" }).ADMIN_KEY).toBeUndefined();
    expect(() => testEnv({ ADMIN_KEY: "short" })).toThrow();
  });

  it("does not exist without an admin key configured", async () => {
    const { app: a } = app();
    expect((await get(a, "/v1/admin", { authorization: `Bearer ${ADMIN}` })).status).toBe(404);
  });

  it("refuses a missing or wrong key", async () => {
    const { app: a } = app({ ADMIN_KEY: ADMIN }, rpc);
    expect((await get(a, "/v1/admin")).status).toBe(401);
    expect((await get(a, "/v1/admin", { authorization: `Bearer ${"a".repeat(39)}b` })).status).toBe(401);
    expect((await get(a, "/v1/admin", { authorization: `Bearer ${ADMIN}x` })).status).toBe(401);
  });

  it("shows wallets, today's spend against the cap, the database and the process", async () => {
    const { app: a } = app(
      { ADMIN_KEY: ADMIN, BUY_PAYER_KEY: `0x${"33".repeat(32)}`, X_MENTIONS_DAILY_CAP_USD: "0.5" },
      rpc,
    );
    const res = await get(a, "/v1/admin", { authorization: `Bearer ${ADMIN}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const s = (await res.json()) as {
      wallets: { role: string; celo: number; tokens: { symbol: string; balance: number }[] }[];
      budgets: { service: string; capUsd: number; spentUsd: number }[];
      database: { settlements: number };
      process: { rssMb: number };
    };
    expect(s.wallets).toHaveLength(2);
    expect(s.wallets[0]?.celo).toBe(2);
    expect(s.wallets[0]?.tokens.find((t) => t.symbol === "USDC")?.balance).toBe(1.5);
    expect(s.budgets).toEqual([
      { service: "buy-x-search", capUsd: 0.5, spentUsd: 0.005, calls: 1, failed: 0 },
    ]);
    expect(s.database.settlements).toBe(3);
    expect(s.process.rssMb).toBeGreaterThan(0);
  });

  it("is not counted as usage", async () => {
    const { app: a, usage } = app({ ADMIN_KEY: ADMIN }, rpc);
    await get(a, "/v1/admin", { authorization: `Bearer ${ADMIN}` });
    await get(a, "/v1/stats");
    expect(Object.values(usage.totals()).every((n) => n === 0)).toBe(true);
  });
});
