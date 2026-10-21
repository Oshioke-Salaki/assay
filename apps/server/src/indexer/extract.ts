import {
  type Address,
  dayOf,
  type FiatCode,
  type Hash,
  type Settlement,
  TOPICS,
  tokenByAddress,
  topicToAddress,
  unitsToNumber,
  X402_PERMIT2_PROXY,
} from "assayscore-core";
import type { SqdBlock, SqdLog } from "./sqd.js";

/** Fiat units per 1 USD on a UTC day. */
export type FxLookup = (fiat: FiatCode, day: number) => number;

/**
 * Turn one block's matching transactions into settlements.
 *
 * A settlement is a supported-stablecoin Transfer that the payer authorised by
 * signature and someone else submitted:
 *  - EIP-3009: an AuthorizationUsed(authorizer) on the token, paired with a
 *    Transfer from that authorizer in the same transaction;
 *  - x402 Permit2 proxy: a Transfer of a supported token inside a successful call
 *    to the proxy.
 * Self-submitted authorizations (relayer == payer) are not machine payments and are skipped.
 */
export function extractSettlements(block: SqdBlock, fx: FxLookup): Settlement[] {
  const out: Settlement[] = [];
  const logsByTx = new Map<number, SqdLog[]>();
  for (const l of block.logs ?? []) {
    const list = logsByTx.get(l.transactionIndex);
    if (list) list.push(l);
    else logsByTx.set(l.transactionIndex, [l]);
  }
  const seen = new Set<number>();
  const ts = block.header.timestamp;
  const day = dayOf(ts);

  for (const tx of block.transactions ?? []) {
    if (seen.has(tx.transactionIndex)) continue;
    seen.add(tx.transactionIndex);
    if (tx.status !== undefined && tx.status !== 1) continue;
    const relayer = tx.from.toLowerCase() as Address;
    const viaPermit2 = tx.to?.toLowerCase() === X402_PERMIT2_PROXY;
    const logs = (logsByTx.get(tx.transactionIndex) ?? []).slice().sort((a, b) => a.logIndex - b.logIndex);

    const authorizers = new Map<string, Set<Address>>();
    for (const l of logs) {
      if (l.topics[0] !== TOPICS.authorizationUsed || !l.topics[1]) continue;
      const token = l.address.toLowerCase();
      const set = authorizers.get(token) ?? new Set<Address>();
      set.add(topicToAddress(l.topics[1]));
      authorizers.set(token, set);
    }

    for (const l of logs) {
      if (l.topics[0] !== TOPICS.erc20Transfer || l.topics.length < 3) continue;
      const token = tokenByAddress(l.address);
      if (!token) continue;
      const payer = topicToAddress(l.topics[1]!);
      const payee = topicToAddress(l.topics[2]!);
      if (payer === relayer || payer === payee) continue;
      const authorised = viaPermit2 || authorizers.get(token.address)?.has(payer) === true;
      if (!authorised) continue;
      const raw = parseUint(l.data);
      if (raw === null || raw === 0n) continue;
      const units = unitsToNumber(raw, token.decimals);
      const rate = token.fiat === "USD" ? 1 : fx(token.fiat, day);
      const usd = rate > 0 && Number.isFinite(rate) ? units / rate : 0;
      out.push({
        txHash: tx.hash.toLowerCase() as Hash,
        logIndex: l.logIndex,
        block: block.header.number,
        ts,
        relayer,
        token: token.address,
        payer,
        payee,
        amount: raw.toString(),
        usd,
      });
    }
  }
  return out;
}

function parseUint(data: string): bigint | null {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(data)) return null;
  return BigInt(data);
}
