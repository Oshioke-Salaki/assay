// biome-ignore-all lint/suspicious/noExplicitAny: Deliberately malformed boundary fixtures.
// Regression tests for the audit of 7 Nov 2026 (audit/REPORT.txt); the SDK ones are in
// audit/sdk-guard.test.ts. Each test started life as a
// reproduction of a defect and now asserts the repaired behaviour. No external requests or real
// payments. Keys below are public test fixtures.

import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { x402HTTPResourceServer } from "@x402/core/server";
import { claimMessage, isPrivateIp as corePrivate, ownWatchMessage } from "assayscore-core";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Watches } from "../src/alerts.js";
import { Analysis } from "../src/analysis.js";
import { createApp, indexBehind, rateLimit } from "../src/api/app.js";
import { Attester } from "../src/attest.js";
import { applyClaim, readClaim } from "../src/claims.js";
import { openDatabase } from "../src/db.js";
import { BudgetExceeded, createPayingFetch } from "../src/lib/buy.js";
import { fetchUntrusted, fetchWithTimeout, isPrivateIp, pinnedFetch } from "../src/lib/http.js";
import { fieldsFrom, verifyScore } from "../src/verify.js";
import { fixedFx, memoryDb, testEnv } from "./helpers.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
const KEY = `0x${"33".repeat(32)}` as const;
const A = `0x${"11".repeat(20)}` as const;
const B = `0x${"22".repeat(20)}` as const;
const account = privateKeyToAccount(KEY);
const addr = account.address.toLowerCase() as `0x${string}`;

function challenge(to: string = A, network = "eip155:42220") {
  return new Response("{}", {
    status: 402,
    headers: {
      "payment-required": Buffer.from(
        JSON.stringify({
          x402Version: 2,
          resource: { url: "https://seller.test/x", description: "audit", mimeType: "application/json" },
          accepts: [
            {
              scheme: "exact",
              network,
              amount: "5000",
              asset: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
              payTo: to,
              maxTimeoutSeconds: 60,
              extra: { name: "USDC", version: "2" },
            },
          ],
        }),
      ).toString("base64"),
    },
  });
}
const appDeps = (db: ReturnType<typeof memoryDb>, extra: Record<string, unknown> = {}) => ({
  db,
  analysis: new Analysis(db),
  env: testEnv(),
  fx: fixedFx(db),
  rpc: {} as any,
  attester: null,
  syncFacilitatorOnStart: false,
  status: () => ({ settlementsBlock: 0, registryBlock: 0, finalizedHead: 0, lastSettlementTs: null }),
  ...extra,
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("F02: outbound URLs cannot reach private addresses", () => {
  it("classifies private addresses in every IPv6 form, in both classifiers", () => {
    const privates = [
      "::ffff:7f00:1",
      "::ffff:a00:1",
      "::ffff:a9fe:a9fe",
      "::ffff:127.0.0.1",
      "[::ffff:169.254.169.254]",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::1",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "2001:db8::1",
      "127.0.0.1",
      "10.1.2.3",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "not an ip",
      "1.2.3.4.5",
    ];
    for (const ip of privates) {
      expect(isPrivateIp(ip), ip).toBe(true);
      expect(corePrivate(ip), ip).toBe(true);
    }
    for (const ip of [
      "93.184.216.34",
      "8.8.8.8",
      "2606:4700:4700::1111",
      "::ffff:5db8:d822",
      "2002:5db8:d822::1",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("pinnedFetch checks the address inside the connection's own lookup", async () => {
    // A rebinding host: public when someone checks first, private when the socket resolves it.
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }] as any);
    await expect(pinnedFetch("https://rebind.test/card.json", { timeoutMs: 2000 })).rejects.toThrow(
      /private address/,
    );
    await expect(pinnedFetch("https://127.0.0.1/x")).rejects.toThrow(/private address/);
    await expect(pinnedFetch("http://example.com/x")).rejects.toThrow(/only https/);
  });

  it("fetchUntrusted connects through the pinned transport", async () => {
    const transport = vi.fn(async () => new Response('{"ok":true}'));
    expect(await fetchUntrusted("https://agent.test/card.json", { transport })).toBe('{"ok":true}');
    expect(transport).toHaveBeenCalledOnce();
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }] as any);
    await expect(fetchUntrusted("https://metadata.test/latest")).rejects.toThrow(/private address/);
  });
});

it("F03: the timeout keeps running until the body has been read", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_url: string, opts: RequestInit) =>
        new Response(
          new ReadableStream({
            start(ctrl) {
              opts.signal!.addEventListener("abort", () => ctrl.error(opts.signal!.reason));
            },
          }),
        ),
    ),
  );
  const response = await fetchWithTimeout("https://slow.test", {}, 50);
  await expect(response.text()).rejects.toThrow(/timed out/);
});

describe("F04: a signed owner message is used once, and never rolls back a newer one", () => {
  it("one signed owner-watch message buys 90 days once", async () => {
    const db = memoryDb();
    try {
      db.prepare(
        "INSERT INTO claims (address, name, signature, issued_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(addr, "Test owner", "fixture", 1, 1);
      const analysis = new Analysis(db);
      const app = createApp({ ...appDeps(db), analysis, watches: new Watches(db, analysis) });
      const f = {
        address: addr,
        url: "https://receiver.test/hook",
        issuedAt: Math.floor(Date.now() / 1000),
        nonce: "a".repeat(32),
      };
      const signature = await account.signMessage({ message: ownWatchMessage(f) });
      const send = () =>
        app.request("/v1/watch/own", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...f, signature }),
        });
      expect((await send()).status).toBe(201);
      const replay = await send();
      expect(replay.status).toBe(409);
      expect(((await replay.json()) as { error: string }).error).toBe("replayed");
    } finally {
      db.close();
    }
  });

  it("an older signed claim cannot overwrite a newer one", async () => {
    const db = memoryDb();
    try {
      const now = Math.floor(Date.now() / 1000);
      const f = {
        address: addr,
        action: "claim" as const,
        name: "Old name",
        url: "",
        x: "",
        logoUrl: "",
        what: "",
        category: "" as const,
        issuedAt: now - 10,
        nonce: "a".repeat(32),
      };
      const old = { ...f, signature: await account.signMessage({ message: claimMessage(f) }) };
      const fresh = { ...f, name: "New name", issuedAt: now, nonce: "b".repeat(32) };
      expect((await applyClaim(db, old, { now })).ok).toBe(true);
      expect(
        (
          await applyClaim(
            db,
            { ...fresh, signature: await account.signMessage({ message: claimMessage(fresh) }) },
            { now },
          )
        ).ok,
      ).toBe(true);
      const rollback = await applyClaim(db, old, { now });
      expect(rollback).toMatchObject({ ok: false, status: 409 });
      expect(readClaim(db, addr)!.name).toBe("New name");
    } finally {
      db.close();
    }
  });
});

it("F05: an authorization without a receipt still counts against the daily cap", async () => {
  const db = memoryDb();
  let signed = 0;
  try {
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "audit",
      pricePerCallUsd: 0.005,
      dailyCapUsd: 0.005,
      fetchImpl: async (input, init) => {
        if (!new Request(input, init).headers.has("payment-signature")) return challenge();
        signed++;
        return new Response("{}"); // the authorization is delivered; the receipt is withheld
      },
    });
    await pay("https://seller.test/x");
    await expect(pay("https://seller.test/x")).rejects.toBeInstanceOf(BudgetExceeded);
    expect(signed).toBe(1);
    expect(db.prepare("SELECT SUM(usd) AS n FROM paid_calls").get()).toEqual({ n: 0.005 });
  } finally {
    db.close();
  }
});

describe("F07: callers cannot invent identities with forwarding headers", () => {
  it("ignores X-Forwarded-For unless told a proxy sets it", async () => {
    const app = new Hono().use("*", rateLimit(1)).get("/", (c) => c.text("ok"));
    expect((await app.request("/", { headers: { "x-forwarded-for": "1.1.1.1" } })).status).toBe(200);
    expect((await app.request("/", { headers: { "x-forwarded-for": "2.2.2.2" } })).status).toBe(429);
  });

  it("on Fly, trusts Fly-Client-IP and nothing a client sends", async () => {
    vi.stubEnv("FLY_APP_NAME", "assayscore-api");
    const app = new Hono().use("*", rateLimit(1)).get("/", (c) => c.text("ok"));
    const as = (ip: string, xff: string) =>
      app.request("/", { headers: { "fly-client-ip": ip, "x-forwarded-for": xff } });
    expect((await as("1.1.1.1", "9.9.9.9")).status).toBe(200);
    expect((await as("1.1.1.1", "8.8.8.8")).status).toBe(429);
    expect((await as("2.2.2.2", "9.9.9.9")).status).toBe(200);
  });
});

describe("F08: paid answers are never signed from stale data", () => {
  it("rebuilds an old snapshot, so a new signature is never already expired", async () => {
    const db = memoryDb();
    vi.useFakeTimers();
    try {
      const analysis = new Analysis(db);
      const signer = new Attester(KEY, B);
      analysis.current();
      vi.setSystemTime(Date.now() + 8 * 86400 * 1000);
      const { assessment, block, now } = analysis.scored(A);
      const signed = await signer.sign(assessment, block, now);
      expect(Number(signed.message.expiresAt)).toBeGreaterThan(Date.now() / 1000);
    } finally {
      db.close();
    }
  });

  it("refuses paid answers while the index lags the chain", () => {
    const status = (settlementsBlock: number) => () => ({
      settlementsBlock,
      registryBlock: 0,
      finalizedHead: 100_000,
      lastSettlementTs: null,
    });
    expect(indexBehind(status(99_000))).toBeNull();
    expect(indexBehind(status(90_000))).toMatch(/10000 blocks behind/);
  });
});

describe("F06: verify trusts only the registry you choose", () => {
  it("matching numbers without a trusted signature are 'unsigned', not 'verified'", async () => {
    const db = memoryDb();
    try {
      const { assessment, block, now } = new Analysis(db).scored(A);
      const r = await verifyScore(db, {
        fields: fieldsFrom(assessment, block, now),
        signature: null,
        registry: null,
      });
      expect(r.outcome).toBe("unsigned");
      expect(r.signature.checked).toBe(false);
    } finally {
      db.close();
    }
  });

  it("the CLI refuses a file that names another registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-audit-"));
    const database = join(dir, "audit.db");
    const db = openDatabase(database);
    try {
      const { assessment, block, now } = new Analysis(db).scored(A);
      const attestation = await new Attester(KEY, B).sign(assessment, block, now);
      const input = join(dir, "forged.json");
      writeFileSync(input, JSON.stringify({ attestation }));
      const preload = join(dir, "no-rpc.mjs");
      writeFileSync(
        preload,
        "globalThis.fetch = async () => { throw new Error('no RPC should be called'); };",
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_PATH: database,
        RPC_URL: "https://mock.test",
      };
      delete env.REGISTRY_ADDRESS;
      const cli = fileURLToPath(new URL("../dist/scripts/verify.js", import.meta.url));
      let failed: { status: number; stderr: string } | null = null;
      try {
        execFileSync(process.execPath, ["--import", preload, cli, input], {
          cwd: dir,
          env,
          encoding: "utf8",
          timeout: 10000,
        });
      } catch (err) {
        failed = err as any;
      }
      expect(failed?.status).toBe(2);
      expect(String(failed?.stderr)).toContain(`names registry ${B}`);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F11: alerts are kept only for payments that settled", () => {
  function settleFails() {
    vi.spyOn(x402HTTPResourceServer.prototype, "processHTTPRequest").mockResolvedValue({
      type: "payment-verified",
      paymentPayload: {},
      paymentRequirements: {},
      cancellationDispatcher: { cancel: async () => undefined },
    } as any);
    vi.spyOn(x402HTTPResourceServer.prototype, "processSettlement").mockResolvedValue({
      success: false,
      response: { status: 402, headers: {}, body: { error: "settlement_failed" } },
    } as any);
  }
  const post = (app: ReturnType<typeof createApp>) =>
    app.request("/v1/watch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: B, url: "https://receiver.test/hook" }),
    });

  it("a new watch whose payment fails is removed with its deliveries", async () => {
    settleFails();
    const db = memoryDb();
    try {
      const analysis = new Analysis(db);
      const app = createApp({
        ...appDeps(db, { env: testEnv({ X402_API_KEY: "test-only-key", PAY_TO: A }) }),
        analysis,
        watches: new Watches(db, analysis),
      });
      expect((await post(app)).status).toBe(402);
      expect(db.prepare("SELECT COUNT(*) AS n FROM watches").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM watch_deliveries").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("a renewal whose payment fails keeps its old expiry", async () => {
    settleFails();
    const db = memoryDb();
    try {
      const analysis = new Analysis(db);
      const watches = new Watches(db, analysis);
      const first = watches.create(B, "https://receiver.test/hook");
      if (!first.ok) throw new Error(first.error);
      const app = createApp({
        ...appDeps(db, { env: testEnv({ X402_API_KEY: "test-only-key", PAY_TO: A }) }),
        analysis,
        watches,
      });
      expect((await post(app)).status).toBe(402);
      expect(db.prepare("SELECT expires_at AS e FROM watches WHERE id = ?").get(first.id)).toEqual({
        e: first.expiresAt,
      });
    } finally {
      db.close();
    }
  });
});

it("F12: browsers may send the watch secret", async () => {
  const db = memoryDb();
  try {
    const app = createApp(appDeps(db));
    const res = await app.request("/v1/watch/w_test", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "x-assay-watch-secret",
      },
    });
    expect(res.headers.get("access-control-allow-headers")).toContain("x-assay-watch-secret");
  } finally {
    db.close();
  }
});
