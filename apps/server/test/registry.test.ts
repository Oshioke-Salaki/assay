import {
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_REPUTATION_REGISTRY,
  identityRegistryAbi,
  reputationRegistryAbi,
} from "@assay/core";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { decodeWalletMetadata, parseInlineFeedback, RegistryIndexer } from "../src/indexer/registry.js";
import type { SqdBlock, SqdLog } from "../src/indexer/sqd.js";
import { fakeSqd, memoryDb } from "./helpers.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const NEW_OWNER = "0x3333333333333333333333333333333333333333";
const CLIENT = "0x4444444444444444444444444444444444444444";
const PROOF = `0x${"ab".repeat(32)}`;

let logIndex = 0;
function log(address: string, topics: Hex[], data: Hex): SqdLog {
  return {
    logIndex: logIndex++,
    transactionIndex: 0,
    transactionHash: `0x${"cd".repeat(32)}`,
    address,
    topics,
    data,
  };
}

const registered = (id: bigint, uri: string) =>
  log(
    ERC8004_IDENTITY_REGISTRY,
    encodeEventTopics({
      abi: identityRegistryAbi,
      eventName: "Registered",
      args: { agentId: id, owner: OWNER },
    }) as Hex[],
    encodeAbiParameters([{ type: "string" }], [uri]),
  );

const walletSet = (id: bigint, value: Hex) =>
  log(
    ERC8004_IDENTITY_REGISTRY,
    encodeEventTopics({
      abi: identityRegistryAbi,
      eventName: "MetadataSet",
      args: { agentId: id, indexedMetadataKey: "agentWallet" },
    }) as Hex[],
    encodeAbiParameters([{ type: "string" }, { type: "bytes" }], ["agentWallet", value]),
  );

const transfer = (id: bigint, from: Hex, to: Hex) =>
  log(
    ERC8004_IDENTITY_REGISTRY,
    encodeEventTopics({
      abi: identityRegistryAbi,
      eventName: "Transfer",
      args: { from, to, tokenId: id },
    }) as Hex[],
    "0x",
  );

const feedback = (id: bigint, idx: bigint, uri: string) =>
  log(
    ERC8004_REPUTATION_REGISTRY,
    encodeEventTopics({
      abi: reputationRegistryAbi,
      eventName: "NewFeedback",
      args: { agentId: id, clientAddress: CLIENT, indexedTag1: "x402" },
    }) as Hex[],
    encodeAbiParameters(
      [
        { type: "uint64" },
        { type: "int128" },
        { type: "uint8" },
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "bytes32" },
      ],
      [idx, 87n, 0, "x402", "assay\u0007", "https://api.example/x", uri, `0x${"00".repeat(32)}`],
    ),
  );

const revoked = (id: bigint, idx: bigint) =>
  log(
    ERC8004_REPUTATION_REGISTRY,
    encodeEventTopics({
      abi: reputationRegistryAbi,
      eventName: "FeedbackRevoked",
      args: { agentId: id, clientAddress: CLIENT, feedbackIndex: idx },
    }) as Hex[],
    "0x",
  );

const inlineUri = (obj: unknown) =>
  `data:application/json;base64,${Buffer.from(JSON.stringify(obj)).toString("base64")}`;

describe("RegistryIndexer", () => {
  const blocks: SqdBlock[] = [
    {
      header: { number: 100, timestamp: 1_000 },
      logs: [registered(7n, "ipfs://bafy"), walletSet(7n, WALLET)],
    },
    {
      header: { number: 101, timestamp: 1_100 },
      logs: [
        feedback(7n, 1n, inlineUri({ proofOfPayment: { txHash: PROOF }, comment: "fast and correct" })),
        feedback(7n, 2n, "https://example.com/f.json"),
      ],
    },
    { header: { number: 102, timestamp: 1_200 }, logs: [revoked(7n, 2n)] },
    { header: { number: 103, timestamp: 1_300 }, logs: [registered(8n, ""), transfer(8n, OWNER, NEW_OWNER)] },
    { header: { number: 104, timestamp: 1_400 }, logs: [log(ERC8004_IDENTITY_REGISTRY, ["0xdead"], "0x")] },
  ];

  it("indexes agents, wallets, transfers, feedback and revocations", async () => {
    const db = memoryDb();
    const indexer = new RegistryIndexer(db, fakeSqd(blocks), { fromBlock: 100 });
    const changed = await indexer.step(104);
    expect(changed).toBe(7);
    expect(indexer.cursor).toBe(104);

    const a7 = db.prepare("SELECT * FROM agents WHERE agent_id = '7'").get() as Record<string, unknown>;
    expect(a7.owner).toBe(OWNER);
    expect(a7.wallet).toBe(WALLET);
    const a8 = db.prepare("SELECT * FROM agents WHERE agent_id = '8'").get() as Record<string, unknown>;
    expect(a8.owner).toBe(NEW_OWNER);
    expect(a8.wallet).toBeNull();

    const fb = db.prepare("SELECT * FROM feedback ORDER BY idx").all() as Record<string, unknown>[];
    expect(fb).toHaveLength(2);
    expect(fb[0]!.proof_tx).toBe(PROOF);
    expect(fb[0]!.comment).toBe("fast and correct");
    expect(fb[0]!.tag2).toBe("assay ");
    expect(fb[0]!.value).toBe("87");
    expect(fb[1]!.revoked).toBe(1);
    expect(fb[1]!.proof_tx).toBeNull();
  });

  it("is idempotent when the same range is replayed", async () => {
    const db = memoryDb();
    await new RegistryIndexer(db, fakeSqd(blocks), { fromBlock: 100 }).step(104);
    db.prepare("DELETE FROM cursors").run();
    await new RegistryIndexer(db, fakeSqd(blocks), { fromBlock: 100 }).step(104);
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(2);
  });

  it("does nothing when already at the head", async () => {
    const db = memoryDb();
    const indexer = new RegistryIndexer(db, fakeSqd(blocks), { fromBlock: 200 });
    expect(await indexer.step(150)).toBe(0);
  });
});

describe("parseInlineFeedback", () => {
  it("reads proof and comment from base64 and url-encoded data URIs", () => {
    expect(
      parseInlineFeedback(inlineUri({ proofOfPayment: { txHash: PROOF.toUpperCase().replace("0X", "0x") } })),
    ).toEqual({
      proofTx: PROOF,
      comment: null,
    });
    expect(
      parseInlineFeedback(`data:application/json,${encodeURIComponent(JSON.stringify({ text: "ok" }))}`),
    ).toEqual({
      proofTx: null,
      comment: "ok",
    });
  });

  it("rejects non-data URIs, bad JSON, bad hashes and oversized payloads", () => {
    expect(parseInlineFeedback("https://x")).toBeNull();
    expect(parseInlineFeedback("data:application/json;base64,!!!")).toBeNull();
    expect(parseInlineFeedback("data:nocomma")).toBeNull();
    expect(parseInlineFeedback(inlineUri({ proofOfPayment: { txHash: "0x12" } }))?.proofTx).toBeNull();
    expect(parseInlineFeedback(`data:application/json,${"a".repeat(70_000)}`)).toBeNull();
  });
});

describe("decodeWalletMetadata", () => {
  it("accepts packed and padded addresses and treats empty as unset", () => {
    expect(decodeWalletMetadata(WALLET)).toBe(WALLET);
    expect(decodeWalletMetadata(`0x${"0".repeat(24)}${WALLET.slice(2)}`)).toBe(WALLET);
    expect(decodeWalletMetadata("0x")).toBeNull();
    expect(decodeWalletMetadata(`0x${"0".repeat(64)}`)).toBeNull();
    expect(decodeWalletMetadata("0x1234")).toBeNull();
  });
});
