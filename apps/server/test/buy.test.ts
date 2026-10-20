import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceeded, createPayingFetch, readSettlementTx } from "../src/lib/buy.js";
import { memoryDb } from "./helpers.js";

const KEY = `0x${"33".repeat(32)}` as const;
const TX = `0x${"ab".repeat(32)}`;

function challenge(amount: string) {
  const body = {
    x402Version: 2,
    error: "payment required",
    resource: {
      url: "https://gateway.test/chainstack/celo",
      description: "rpc",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:42220",
        amount,
        asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        payTo: "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(body)).toString("base64") },
  });
}

const settled = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
    status: 200,
    headers: {
      "payment-response": Buffer.from(
        JSON.stringify({ success: true, transaction: TX, network: "eip155:42220" }),
      ).toString("base64"),
    },
  });

afterEach(() => vi.restoreAllMocks());

function challengeV1(maxAmountRequired: string) {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "celo",
          maxAmountRequired,
          resource: "https://gateway.test/chainstack/celo",
          description: "rpc",
          mimeType: "application/json",
          payTo: "0x20faAca5F980E29639A0FCC6dcA6988E18ed333B",
          maxTimeoutSeconds: 60,
          asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
          extra: { name: "USDC", version: "2" },
        },
      ],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

const settledV1 = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
    status: 200,
    headers: {
      "x-payment-response": Buffer.from(
        JSON.stringify({ success: true, transaction: TX, network: "celo" }),
      ).toString("base64"),
    },
  });

describe("createPayingFetch", () => {
  it("pays an x402 v1 challenge (the buy gateway's dialect) and records it", async () => {
    const db = memoryDb();
    const fetchImpl = vi.fn(async (i: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const h = new Request(i, init).headers;
      return h.has("x-payment") ? settledV1() : challengeV1("10000");
    });
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "chainstack",
      pricePerCallUsd: 0.01,
      dailyCapUsd: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await pay("https://gateway.test/chainstack/celo", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT tx_hash FROM paid_calls").all()).toEqual([{ tx_hash: TX }]);
  });

  it("refuses a v1 challenge priced above the quote", async () => {
    const db = memoryDb();
    const fetchImpl = vi.fn(async () => challengeV1("50000"));
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "chainstack",
      pricePerCallUsd: 0.01,
      dailyCapUsd: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(pay("https://gateway.test/x")).rejects.toThrow();
  });

  it("pays a quoted challenge, then records the settlement as proof", async () => {
    const db = memoryDb();
    const fetchImpl = vi.fn(async (i: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const h = new Request(i, init).headers;
      return h.has("payment-signature") || h.has("x-payment") ? settled() : challenge("10000");
    });
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "chainstack",
      pricePerCallUsd: 0.01,
      dailyCapUsd: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await pay("https://gateway.test/chainstack/celo", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const rows = db.prepare("SELECT service, usd, tx_hash FROM paid_calls").all() as {
      usd: number;
      tx_hash: string;
    }[];
    expect(rows).toEqual([{ service: "chainstack", usd: 0.01, tx_hash: TX }]);
  });

  it("refuses a challenge priced above the quote", async () => {
    const db = memoryDb();
    const fetchImpl = vi.fn(async () => challenge("50000"));
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "chainstack",
      pricePerCallUsd: 0.01,
      dailyCapUsd: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(pay("https://gateway.test/x")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops at the daily cap before any request goes out", async () => {
    const db = memoryDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO paid_calls (ts, service, url, status, usd, tx_hash, payer) VALUES (?, 's', 'u', 200, 0.995, ?, 'p')",
    ).run(now, TX);
    const fetchImpl = vi.fn();
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "s",
      pricePerCallUsd: 0.01,
      dailyCapUsd: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(pay("https://gateway.test/x")).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the settlement transaction only from a well-formed header", () => {
    expect(readSettlementTx(settled())).toBe(TX);
    expect(readSettlementTx(new Response("x"))).toBeNull();
    expect(readSettlementTx(new Response("x", { headers: { "payment-response": "%%%" } }))).toBeNull();
  });
});
