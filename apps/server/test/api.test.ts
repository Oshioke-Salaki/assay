import { dayOf } from "@assay/core";
import type { PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analysis } from "../src/analysis.js";
import { createApp } from "../src/api/app.js";
import { Attester } from "../src/attest.js";
import type { DB } from "../src/db.js";
import { SettlementIndexer } from "../src/indexer/settlements.js";
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

  it("publishes an ERC-8004 registration file", async () => {
    const reg = (await (await get(app, "/.well-known/agent-registration.json")).json()) as Record<
      string,
      unknown
    >;
    expect(reg.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(reg.x402Support).toBe(true);
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

describe("paid API", () => {
  it("answers 503 when selling is not configured, and 400 before that for bad addresses", async () => {
    const { app } = build();
    expect((await get(app, `/v1/check/${SHOP}`)).status).toBe(503);
    expect((await get(app, "/v1/check/not-an-address")).status).toBe(400);
    expect((await get(app, "/v1/attest/0x00")).status).toBe(400);
  });

  it("challenges unpaid requests with a 402 that prices USA₮ first", async () => {
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
      accepts: { asset: string; amount: string; payTo: string; network: string }[];
    };
    expect(required.accepts[0]?.asset.toLowerCase()).toBe("0xd2ab3c9a02dbbab236bfec45d1d755df4267f771");
    expect(required.accepts[0]?.amount).toBe("2000");
    expect(required.accepts).toHaveLength(3);
    expect(required.accepts.every((a) => a.network === "eip155:42220")).toBe(true);
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
