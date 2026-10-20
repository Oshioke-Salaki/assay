import type { Settlement } from "@assay/core";
import type { Hash, PublicClient } from "viem";
import type { FxRates } from "./enrich/fx.js";
import { extractSettlements } from "./indexer/extract.js";

export type ProofResult =
  | { ok: true; settlements: Settlement[]; status: "settled" }
  | { ok: false; status: "not_found" | "pending" | "failed" | "not_a_settlement"; settlements: [] };

/**
 * Check a single transaction straight from the chain, without waiting for the
 * finalized index. Used by the review flow so a buyer can review seconds after paying.
 */
export async function proveSettlement(client: PublicClient, fx: FxRates, hash: Hash): Promise<ProofResult> {
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash }).catch(() => null),
    client.getTransactionReceipt({ hash }).catch(() => null),
  ]);
  if (!tx) return { ok: false, status: "not_found", settlements: [] };
  if (!receipt) return { ok: false, status: "pending", settlements: [] };
  if (receipt.status !== "success") return { ok: false, status: "failed", settlements: [] };
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const settlements = extractSettlements(
    {
      header: { number: Number(receipt.blockNumber), timestamp: Number(block.timestamp) },
      transactions: [
        {
          transactionIndex: receipt.transactionIndex,
          hash: receipt.transactionHash,
          from: receipt.from,
          to: receipt.to,
          status: 1,
        },
      ],
      logs: receipt.logs.map((l) => ({
        logIndex: l.logIndex,
        transactionIndex: receipt.transactionIndex,
        transactionHash: receipt.transactionHash,
        address: l.address,
        topics: l.topics,
        data: l.data,
      })),
    },
    fx.rate,
  );
  if (settlements.length === 0) return { ok: false, status: "not_a_settlement", settlements: [] };
  return { ok: true, status: "settled", settlements };
}
