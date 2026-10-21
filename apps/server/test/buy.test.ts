import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceeded, createPayingFetch, readSettlementTx, reconcilePaidCalls } from "../src/lib/buy.js";
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

  it("caps each paid service on its own spend", async () => {
    const db = memoryDb();
    const now = Math.floor(Date.now() / 1000);
    // Another service spent its whole budget today; this one has spent nothing.
    db.prepare(
      "INSERT INTO paid_calls (ts, service, url, status, usd, tx_hash, payer) VALUES (?, 'other', 'u', 200, 5, ?, 'p')",
    ).run(now, TX);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "buy-x-search",
      pricePerCallUsd: 0.005,
      dailyCapUsd: 0.5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(pay("https://gateway.test/x")).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("reads the settlement transaction only from a well-formed header", () => {
    expect(readSettlementTx(settled())).toBe(TX);
    expect(readSettlementTx(new Response("x"))).toBeNull();
    expect(readSettlementTx(new Response("x", { headers: { "payment-response": "%%%" } }))).toBeNull();
  });
});

describe("paid request queue", () => {
  it("sends paid requests one at a time even when callers fire them together", async () => {
    const db = memoryDb();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async (i: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const paid = new Request(i, init).headers.has("payment-signature");
      if (!paid) return challenge("10000");
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return settled();
    });
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "s",
      pricePerCallUsd: 0.01,
      dailyCapUsd: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => pay("https://gateway.test/x", { method: "POST", body: "{}" })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it("keeps going after a failed paid call", async () => {
    const db = memoryDb();
    let n = 0;
    const fetchImpl = vi.fn(async (i: Parameters<typeof fetch>[0], init?: RequestInit) => {
      n++;
      if (n === 1) throw new Error("network down");
      return new Request(i, init).headers.has("payment-signature") ? settled() : challenge("10000");
    });
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "s",
      pricePerCallUsd: 0.01,
      dailyCapUsd: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(pay("https://gateway.test/x")).rejects.toThrow();
    expect((await pay("https://gateway.test/x", { method: "POST", body: "{}" })).status).toBe(200);
  });
});

describe("reconcilePaidCalls", () => {
  const PAYER = "0x3d5ea1ce6f3fa5fae7a38b77f569570b3ea9a9a4" as const;
  const GATEWAY = "0x20faaca5f980e29639a0fcc6dca6988e18ed333b" as const;
  const USDC = "0xceba9300f2b948710d2653dd7b07f33a8b32118c" as const;
  const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

  /** Transfers at block -> (tx, value); block timestamps are 1_000_000 + block. */
  function chain(head: bigint, transfers: { block: bigint; tx: `0x${string}`; value: bigint }[]) {
    const calls: { fromBlock: bigint; toBlock: bigint }[] = [];
    return {
      calls,
      getBlockNumber: async () => head,
      getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push({ fromBlock: q.fromBlock, toBlock: q.toBlock });
        return transfers
          .filter((t) => t.block >= q.fromBlock && t.block <= q.toBlock)
          .map((t) => ({ transactionHash: t.tx, blockNumber: t.block, args: { value: t.value } }));
      },
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_000_000n + blockNumber }),
    };
  }
  const opts = { payer: PAYER, payTo: GATEWAY, token: USDC, decimals: 6, lookbackBlocks: 5_000 };
  const row = (db: ReturnType<typeof memoryDb>, ts: number, txHash: string | null, note: string | null) =>
    db
      .prepare(
        "INSERT INTO paid_calls (ts, service, url, status, usd, tx_hash, payer, note) VALUES (?, 'buy-x-search', 'u', ?, ?, ?, ?, ?)",
      )
      .run(ts, txHash ? 200 : 0, txHash ? 0.005 : 0, txHash, PAYER, note);

  it("attaches a payment whose answer was lost to the failed call it paid for", async () => {
    const db = memoryDb();
    row(db, 1_008_000, tx(1), null); // a normal paid call, already recorded
    row(db, 1_008_090, null, "fetch failed: ECONNRESET"); // paid at block 8030, answer lost
    const rpc = chain(10_000n, [
      { block: 8_000n, tx: tx(1), value: 5_000n },
      { block: 8_030n, tx: tx(2), value: 5_000n },
    ]);
    expect(await reconcilePaidCalls(db, rpc, opts)).toMatchObject({ matched: 1, unmatched: 0 });
    const lost = db
      .prepare("SELECT usd, tx_hash, note FROM paid_calls WHERE note LIKE 'fetch failed%'")
      .get();
    expect(lost).toEqual({
      usd: 0.005,
      tx_hash: tx(2),
      note: "fetch failed: ECONNRESET (settled onchain; answer lost)",
    });
  });

  it("records a payment with no matching call on its own, and never twice", async () => {
    const db = memoryDb();
    const rpc = chain(10_000n, [{ block: 9_000n, tx: tx(3), value: 10_000n }]);
    expect(await reconcilePaidCalls(db, rpc, opts)).toMatchObject({ matched: 0, unmatched: 1 });
    expect(await reconcilePaidCalls(db, rpc, opts)).toMatchObject({ matched: 0, unmatched: 0 });
    expect(db.prepare("SELECT service, usd, tx_hash FROM paid_calls").all()).toEqual([
      { service: "unmatched", usd: 0.01, tx_hash: tx(3) },
    ]);
  });

  it("does not attach a payment to a failure from long before it", async () => {
    const db = memoryDb();
    row(db, 1_000_100, null, "fetch failed"); // hours before the payment
    const rpc = chain(10_000n, [{ block: 9_000n, tx: tx(4), value: 5_000n }]);
    expect(await reconcilePaidCalls(db, rpc, opts)).toMatchObject({ matched: 0, unmatched: 1 });
  });

  it("resumes from its cursor in chunks the RPC accepts, a few blocks behind the tip", async () => {
    const db = memoryDb();
    const rpc = chain(20_000n, []);
    await reconcilePaidCalls(db, rpc, opts);
    expect(rpc.calls[0]).toEqual({ fromBlock: 14_995n, toBlock: 16_994n });
    expect(rpc.calls.every((c) => c.toBlock - c.fromBlock < 2_000n)).toBe(true);
    expect(rpc.calls.at(-1)?.toBlock).toBe(19_995n);
    const again = chain(20_100n, []);
    await reconcilePaidCalls(db, again, opts);
    expect(again.calls).toEqual([{ fromBlock: 19_996n, toBlock: 20_095n }]);
  });

  it("counts reconciled spend against the daily cap", async () => {
    const db = memoryDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO paid_calls (ts, service, url, status, usd, tx_hash, payer, note) VALUES (?, 'buy-x-search', 'u', 0, 0.5, ?, 'p', 'fetch failed (settled onchain; answer lost)')",
    ).run(now, tx(9));
    const fetchImpl = vi.fn();
    const pay = createPayingFetch({
      db,
      privateKey: KEY,
      service: "buy-x-search",
      pricePerCallUsd: 0.005,
      dailyCapUsd: 0.5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(pay("https://gateway.test/x")).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
