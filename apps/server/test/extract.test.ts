import { TOPICS } from "assayscore-core";
import { describe, expect, it } from "vitest";
import { extractSettlements } from "../src/indexer/extract.js";
import type { SqdBlock } from "../src/indexer/sqd.js";
import { FIXTURE_BLOCKS, pad, word } from "./helpers.js";

const fx = (fiat: string) => ({ ARS: 1500, BRL: 5, COP: 4000 })[fiat] ?? 1;

describe("extractSettlements on real Celo blocks", () => {
  const all = FIXTURE_BLOCKS.flatMap((b) => extractSettlements(b, fx));

  it("finds one settlement per fixture transaction", () => {
    expect(all).toHaveLength(FIXTURE_BLOCKS.length);
  });

  it("reads payer, payee and amount from the EIP-3009 transfer", () => {
    const usdt = all.find((s) => s.token === "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e")!;
    expect(usdt.relayer).toBe("0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48");
    expect(usdt.payer).not.toBe(usdt.payee);
    expect(BigInt(usdt.amount)).toBeGreaterThan(0n);
    expect(usdt.usd).toBeCloseTo(Number(usdt.amount) / 1e6, 9);
  });

  it("prices Permit2 wFIAT settlements through the FX rate", () => {
    const wbrl = all.find((s) => s.token === "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0")!;
    expect(wbrl).toBeDefined();
    expect(wbrl.usd).toBeCloseTo(Number(BigInt(wbrl.amount) / 10n ** 12n) / 1e6 / 5, 6);
  });

  it("keeps settlements from other relayers and labels them", () => {
    expect(all.some((s) => s.relayer === "0xc077c1a915a61021b16d1581067c828b7c76f8e7")).toBe(true);
  });
});

describe("extractSettlements edge cases", () => {
  const base = FIXTURE_BLOCKS[0]!;

  it("skips failed transactions", () => {
    const failed: SqdBlock = { ...base, transactions: base.transactions!.map((t) => ({ ...t, status: 0 })) };
    expect(extractSettlements(failed, fx)).toEqual([]);
  });

  it("skips a transfer that the authorizer did not sign", () => {
    const tx = base.transactions![0]!;
    const stranger = "0x00000000000000000000000000000000000000ab";
    const logs = [
      ...base.logs!,
      {
        logIndex: 999,
        transactionIndex: tx.transactionIndex,
        transactionHash: tx.hash,
        address: base.logs![0]!.address,
        topics: [TOPICS.erc20Transfer, pad(stranger), pad("0x00000000000000000000000000000000000000cd")],
        data: word(5_000_000n),
      },
    ];
    const out = extractSettlements({ ...base, logs }, fx);
    expect(out).toHaveLength(1);
    expect(out.every((s) => s.payer !== stranger)).toBe(true);
  });

  it("skips self-submitted authorizations", () => {
    const payer = extractSettlements(base, fx)[0]!.payer;
    const selfSubmitted: SqdBlock = {
      ...base,
      transactions: base.transactions!.map((t) => ({ ...t, from: payer })),
    };
    expect(extractSettlements(selfSubmitted, fx)).toEqual([]);
  });

  it("ignores unsupported tokens, zero amounts and malformed data", () => {
    const tx = base.transactions![0]!;
    const auth = base.logs!.find((l) => l.topics[0] === TOPICS.authorizationUsed)!;
    const payer = `0x${auth.topics[1]!.slice(-40)}`;
    const mk = (address: string, data: string, logIndex: number) => ({
      logIndex,
      transactionIndex: tx.transactionIndex,
      transactionHash: tx.hash,
      address,
      topics: [TOPICS.erc20Transfer, pad(payer), pad("0x00000000000000000000000000000000000000ef")],
      data,
    });
    const block: SqdBlock = {
      ...base,
      logs: [
        auth,
        mk("0x0000000000000000000000000000000000000001", word(1n), 1),
        mk(auth.address, word(0n), 2),
        mk(auth.address, "0xzz", 3),
      ],
    };
    expect(extractSettlements(block, fx)).toEqual([]);
  });

  it("handles a block with no transactions or logs", () => {
    expect(extractSettlements({ header: { number: 1, timestamp: 1 } }, fx)).toEqual([]);
  });

  it("does not count a duplicated transaction twice", () => {
    const doubled: SqdBlock = { ...base, transactions: [...base.transactions!, ...base.transactions!] };
    expect(extractSettlements(doubled, fx)).toHaveLength(1);
  });

  it("values wFIAT at zero instead of infinity when a rate is missing", () => {
    const p2 = FIXTURE_BLOCKS.find(
      (b) => b.transactions?.[0]?.to === "0x402085c248eea27d92e8b30b2c58ed07f9e20001",
    )!;
    const out = extractSettlements(p2, () => 0);
    expect(out[0]?.usd).toBe(0);
  });
});
