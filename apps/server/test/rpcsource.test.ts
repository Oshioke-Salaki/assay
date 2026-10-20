import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  FailoverSource,
  type RpcLog,
  type RpcReader,
  type RpcReceipt,
  RpcSource,
} from "../src/indexer/rpcsource.js";
import { SettlementIndexer } from "../src/indexer/settlements.js";
import type { SqdBlock, SqdClient } from "../src/indexer/sqd.js";
import { FIXTURE_BLOCKS, fakeSqd, fixedFx, memoryDb } from "./helpers.js";

/** A fake JSON-RPC node serving the real mainnet fixture blocks. */
function fakeRpc(blocks: SqdBlock[]): RpcReader & { calls: number } {
  const logs: RpcLog[] = [];
  const receipts = new Map<string, RpcReceipt>();
  for (const b of blocks) {
    for (const t of b.transactions ?? []) {
      const txLogs = (b.logs ?? []).filter((l) => l.transactionIndex === t.transactionIndex);
      const rl: RpcLog[] = txLogs.map((l) => ({
        address: l.address as Hex,
        topics: l.topics as Hex[],
        data: l.data as Hex,
        blockNumber: BigInt(b.header.number),
        transactionHash: t.hash as Hex,
        transactionIndex: t.transactionIndex,
        logIndex: l.logIndex,
      }));
      logs.push(...rl);
      receipts.set(t.hash.toLowerCase(), {
        transactionHash: t.hash as Hex,
        transactionIndex: t.transactionIndex,
        blockNumber: BigInt(b.header.number),
        from: t.from as Hex,
        to: (t.to ?? null) as Hex | null,
        status: t.status === 0 ? "reverted" : "success",
        logs: rl,
      });
    }
  }
  const ts = new Map(blocks.map((b) => [BigInt(b.header.number), b.header.timestamp]));
  const top = blocks.at(-1)!.header.number;
  const node = {
    calls: 0,
    async getBlock(args: { blockTag: "finalized" } | { blockNumber: bigint }) {
      node.calls++;
      const n = "blockTag" in args ? BigInt(top) : args.blockNumber;
      return { number: n, hash: "0xabc" as Hex, timestamp: BigInt(ts.get(n) ?? 1_792_000_000) };
    },
    async getLogs(a: {
      address?: Hex | Hex[];
      fromBlock: bigint;
      toBlock: bigint;
      topics?: (Hex | Hex[] | null)[];
    }) {
      node.calls++;
      const addrs = a.address
        ? (Array.isArray(a.address) ? a.address : [a.address]).map((x) => x.toLowerCase())
        : null;
      const t0 = a.topics?.[0];
      const t0s = t0 ? (Array.isArray(t0) ? t0 : [t0]) : null;
      return logs.filter(
        (l) =>
          l.blockNumber! >= a.fromBlock &&
          l.blockNumber! <= a.toBlock &&
          (!addrs || addrs.includes(l.address.toLowerCase())) &&
          (!t0s || t0s.includes(l.topics[0]!)),
      );
    },
    async getTransactionReceipt({ hash }: { hash: Hex }) {
      node.calls++;
      const r = receipts.get(hash.toLowerCase());
      if (!r) throw new Error("no receipt");
      return r;
    },
  };
  return node;
}

const first = FIXTURE_BLOCKS[0]!.header.number;
const last = FIXTURE_BLOCKS.at(-1)!.header.number;

async function indexWith(source: SqdClient) {
  const db = memoryDb();
  await new SettlementIndexer(db, source, fixedFx(db), { fromBlock: first }).step(last);
  return db
    .prepare(
      "SELECT tx_hash, log_index, payer, payee, token, amount, relayer FROM settlements ORDER BY tx_hash, log_index",
    )
    .all();
}

describe("RpcSource", () => {
  it("extracts exactly the same settlements as the SQD portal from the same blocks", async () => {
    const viaSqd = await indexWith(fakeSqd(FIXTURE_BLOCKS));
    const viaRpc = await indexWith(
      new RpcSource(fakeRpc(FIXTURE_BLOCKS), { chunkBlocks: 3_000 }) as unknown as SqdClient,
    );
    expect(viaSqd).toHaveLength(FIXTURE_BLOCKS.length);
    expect(viaRpc).toEqual(viaSqd);
  });

  it("advances to the end of an empty range", async () => {
    const src = new RpcSource(fakeRpc(FIXTURE_BLOCKS), { chunkBlocks: 100 });
    const got: number[] = [];
    for await (const b of src.stream({ fromBlock: 1, toBlock: 250, logs: [] })) got.push(b.header.number);
    expect(got.at(-1)).toBe(250);
  });
});

describe("FailoverSource", () => {
  it("finishes the range over RPC when the portal dies mid-stream", async () => {
    const half = FIXTURE_BLOCKS[2]!.header.number;
    const dying = {
      async finalizedHead() {
        return { number: last, hash: "0x" };
      },
      async *stream() {
        for (const b of FIXTURE_BLOCKS) {
          if (b.header.number > half) throw new Error("SQD 529 overloaded");
          yield b;
        }
      },
    } as unknown as SqdClient;
    const failover = new FailoverSource(
      dying,
      new RpcSource(fakeRpc(FIXTURE_BLOCKS), { chunkBlocks: 50_000 }),
    );
    expect(await indexWith(failover as unknown as SqdClient)).toEqual(
      await indexWith(fakeSqd(FIXTURE_BLOCKS)),
    );
  });

  it("falls back for the head too", async () => {
    const down = {
      async finalizedHead() {
        throw new Error("down");
      },
    } as unknown as SqdClient;
    const head = await new FailoverSource(down, new RpcSource(fakeRpc(FIXTURE_BLOCKS))).finalizedHead();
    expect(head.number).toBe(last);
  });
});
