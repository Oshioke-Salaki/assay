import {
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_REPUTATION_REGISTRY,
  INDEX_START_BLOCK,
  identityRegistryAbi,
  isTxHash,
  reputationRegistryAbi,
} from "@assay/core";
import { decodeEventLog, type Hex, isHex, toEventSelector } from "viem";
import { type DB, getCursor, setCursor } from "../db.js";
import { log } from "../lib/log.js";
import type { SqdBlock, SqdClient, SqdLog, SqdQuery } from "./sqd.js";

export const REGISTRY_CURSOR = "erc8004";

const ZERO = "0x0000000000000000000000000000000000000000";

const sel = (abi: readonly unknown[], name: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: viem's AbiEvent narrowing is not worth the ceremony here
  toEventSelector((abi as any[]).find((x) => x.type === "event" && x.name === name));

export const REGISTRY_TOPICS = {
  registered: sel(identityRegistryAbi, "Registered"),
  uriUpdated: sel(identityRegistryAbi, "URIUpdated"),
  metadataSet: sel(identityRegistryAbi, "MetadataSet"),
  transfer: sel(identityRegistryAbi, "Transfer"),
  newFeedback: sel(reputationRegistryAbi, "NewFeedback"),
  feedbackRevoked: sel(reputationRegistryAbi, "FeedbackRevoked"),
} as const;

export function registryQuery(fromBlock: number, toBlock: number): SqdQuery {
  return {
    type: "evm",
    fromBlock,
    toBlock,
    fields: {
      block: { number: true, timestamp: true },
      log: {
        address: true,
        topics: true,
        data: true,
        logIndex: true,
        transactionIndex: true,
        transactionHash: true,
      },
    },
    logs: [
      {
        address: [ERC8004_IDENTITY_REGISTRY],
        topic0: [
          REGISTRY_TOPICS.registered,
          REGISTRY_TOPICS.uriUpdated,
          REGISTRY_TOPICS.metadataSet,
          REGISTRY_TOPICS.transfer,
        ],
      },
      {
        address: [ERC8004_REPUTATION_REGISTRY],
        topic0: [REGISTRY_TOPICS.newFeedback, REGISTRY_TOPICS.feedbackRevoked],
      },
    ],
  };
}

/** Parsed contents of a feedback file stored inline as a data: URI. */
export interface InlineFeedback {
  proofTx: string | null;
  comment: string | null;
}

/** Read proofOfPayment.txHash and a comment out of an inline data: URI feedback file. */
export function parseInlineFeedback(uri: string): InlineFeedback | null {
  if (!uri.startsWith("data:")) return null;
  const comma = uri.indexOf(",");
  if (comma < 0 || uri.length > 64 * 1024) return null;
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  try {
    const text = meta.endsWith(";base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
    const json = JSON.parse(text) as Record<string, unknown>;
    const proof = json.proofOfPayment as Record<string, unknown> | undefined;
    const txHash =
      typeof proof?.txHash === "string" && isTxHash(proof.txHash) ? proof.txHash.toLowerCase() : null;
    const raw = json.comment ?? json.text;
    const comment = typeof raw === "string" ? raw.slice(0, 1_000) : null;
    return { proofTx: txHash, comment };
  } catch {
    return null;
  }
}

/** agentWallet metadata is the packed 20-byte address (or a 32-byte word); empty means unset. */
export function decodeWalletMetadata(value: Hex): string | null {
  const hex = value.slice(2);
  if (hex.length === 0) return null;
  if (hex.length === 40) return `0x${hex}`.toLowerCase();
  if (hex.length === 64) {
    const addr = `0x${hex.slice(24)}`.toLowerCase();
    return addr === ZERO ? null : addr;
  }
  return null;
}

export class RegistryIndexer {
  constructor(
    private readonly db: DB,
    private readonly sqd: SqdClient,
    private readonly opts: { fromBlock?: number; toBlock?: number; onIngest?: () => void } = {},
  ) {}

  get cursor(): number {
    return getCursor(this.db, REGISTRY_CURSOR) ?? (this.opts.fromBlock ?? INDEX_START_BLOCK) - 1;
  }

  async step(head: number, signal?: AbortSignal): Promise<number> {
    const from = this.cursor + 1;
    const to = Math.min(head, this.opts.toBlock ?? Number.POSITIVE_INFINITY);
    if (from > to) return 0;
    let changed = 0;
    let batch: SqdBlock[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      const blocks = batch;
      batch = [];
      const last = blocks[blocks.length - 1]!.header;
      this.db.transaction(() => {
        for (const b of blocks) for (const l of b.logs ?? []) changed += this.apply(b, l) ? 1 : 0;
        setCursor(this.db, REGISTRY_CURSOR, last.number, last.timestamp);
      })();
    };
    for await (const block of this.sqd.stream(registryQuery(from, to))) {
      if (signal?.aborted) break;
      batch.push(block);
      if (batch.length >= 2_000) flush();
    }
    flush();
    if (changed > 0) {
      log.info("erc8004 indexed", { changed, cursor: this.cursor });
      this.opts.onIngest?.();
    }
    return changed;
  }

  /** Apply one event. Returns false for events that could not be decoded. */
  private apply(block: SqdBlock, l: SqdLog): boolean {
    const isIdentity = l.address.toLowerCase() === ERC8004_IDENTITY_REGISTRY;
    let decoded: { eventName: string; args: Record<string, unknown> };
    try {
      decoded = decodeEventLog({
        abi: isIdentity ? identityRegistryAbi : reputationRegistryAbi,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
        strict: false,
      }) as unknown as { eventName: string; args: Record<string, unknown> };
    } catch (err) {
      log.warn("erc8004 decode failed", { tx: l.transactionHash, error: String(err) });
      return false;
    }
    const a = decoded.args;
    const ts = block.header.timestamp;
    switch (decoded.eventName) {
      case "Registered": {
        this.db
          .prepare(
            `INSERT INTO agents (agent_id, owner, uri, registered_block, registered_ts) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (agent_id) DO UPDATE SET owner = excluded.owner, uri = excluded.uri, meta_fetched_at = NULL`,
          )
          .run(
            String(a.agentId),
            String(a.owner).toLowerCase(),
            String(a.agentURI ?? ""),
            block.header.number,
            ts,
          );
        return true;
      }
      case "URIUpdated": {
        this.db
          .prepare("UPDATE agents SET uri = ?, meta_fetched_at = NULL, meta_error = NULL WHERE agent_id = ?")
          .run(String(a.newURI ?? ""), String(a.agentId));
        return true;
      }
      case "MetadataSet": {
        if (a.metadataKey !== "agentWallet") return true;
        const value = isHex(a.metadataValue) ? decodeWalletMetadata(a.metadataValue) : null;
        this.db.prepare("UPDATE agents SET wallet = ? WHERE agent_id = ?").run(value, String(a.agentId));
        return true;
      }
      case "Transfer": {
        const from = String(a.from).toLowerCase();
        if (from === ZERO) return true; // mint: handled by Registered
        // ERC-8004 v1 clears agentWallet when the identity changes hands.
        this.db
          .prepare("UPDATE agents SET owner = ?, wallet = NULL WHERE agent_id = ?")
          .run(String(a.to).toLowerCase(), String(a.tokenId));
        return true;
      }
      case "NewFeedback": {
        const uri = String(a.feedbackURI ?? "");
        const inline = parseInlineFeedback(uri);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO feedback
             (agent_id, client, idx, value, decimals, tag1, tag2, endpoint, uri, hash, block, ts, tx_hash, proof_tx, comment)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            String(a.agentId),
            String(a.clientAddress).toLowerCase(),
            Number(a.feedbackIndex),
            String(a.value),
            Number(a.valueDecimals),
            safeText(a.tag1),
            safeText(a.tag2),
            safeText(a.endpoint),
            uri.length > 4096 && !uri.startsWith("data:") ? uri.slice(0, 4096) : uri,
            String(a.feedbackHash ?? ""),
            block.header.number,
            ts,
            l.transactionHash.toLowerCase(),
            inline?.proofTx ?? null,
            inline?.comment ?? null,
          );
        return true;
      }
      case "FeedbackRevoked": {
        this.db
          .prepare("UPDATE feedback SET revoked = 1 WHERE agent_id = ? AND client = ? AND idx = ?")
          .run(String(a.agentId), String(a.clientAddress).toLowerCase(), Number(a.feedbackIndex));
        return true;
      }
      default:
        return false;
    }
  }
}

function safeText(v: unknown): string {
  if (typeof v !== "string") return "";
  // Strings are UTF-8 from calldata; strip control characters before they reach a UI.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
}
