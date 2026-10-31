import { TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";
import { Enricher } from "../src/enrich/enricher.js";
import { FxRates } from "../src/enrich/fx.js";
import { proveSettlement } from "../src/proof.js";
import { memoryDb } from "./helpers.js";

// A lookup that fails is not an answer. These cover the lookups outside the funding trace.

const HASH = `0x${"ab".repeat(32)}` as const;
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";

describe("payment proof for reviews", () => {
  it("reports a transaction the chain does not have as not found", async () => {
    const client = {
      getTransaction: async () => {
        throw new TransactionNotFoundError({ hash: HASH });
      },
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: HASH });
      },
    };
    const r = await proveSettlement(client as never, new FxRates(memoryDb()), HASH);
    expect(r.status).toBe("not_found");
  });

  it("throws when the RPC fails, so the buyer is told to try again, not that the payment does not exist", async () => {
    const client = {
      getTransaction: async () => {
        throw new Error("fetch failed");
      },
      getTransactionReceipt: async () => {
        throw new Error("fetch failed");
      },
    };
    await expect(proveSettlement(client as never, new FxRates(memoryDb()), HASH)).rejects.toThrow(
      /fetch failed/,
    );
  });
});

describe("Self lookups", () => {
  it("records addresses whose lookup answered, and leaves a failed one to be asked again", async () => {
    const db = memoryDb();
    db.prepare(
      "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 1, 10, 1, 1, '0x1')",
    ).run(A, B);
    // B was a verified human before; this time its call fails.
    db.prepare(
      "INSERT INTO humans (address, agent_id, nullifier, fresh, visa_tier, fetched_at) VALUES (?, '7', '99', 1, 0, 0)",
    ).run(B);
    const client = {
      multicall: async ({ contracts }: { contracts: { args: readonly [string] }[] }) =>
        contracts.map((c) =>
          c.args[0].toLowerCase().endsWith(B.slice(2))
            ? { status: "failure", error: new Error("timeout") }
            : { status: "success", result: 0n },
        ),
    };
    const enricher = new Enricher(db, {} as never, client as never, () => {});
    expect(await enricher.humansBatch(10)).toBe(1);
    const rows = db.prepare("SELECT address, agent_id, fetched_at FROM humans ORDER BY address").all();
    expect(rows).toEqual([
      { address: A, agent_id: null, fetched_at: expect.any(Number) },
      // Unchanged: still human-backed, still due for a lookup.
      { address: B, agent_id: "7", fetched_at: 0 },
    ]);
  });
});
