import { type Address, TOKENS, TOPICS, topicToAddress } from "assayscore-core";
import { type Hex, pad } from "viem";
import type { DB } from "../db.js";
import type { BlockSource } from "../indexer/sqd.js";
import { log } from "../lib/log.js";

/** Tokens whose arrival counts as funding: CELO (its ERC-20 events), the Mento dollars, and the x402 assets. */
export const FUNDING_TOKENS: readonly Address[] = [
  "0x471ece3750da237f93b8e339c536989b8978a438", // CELO
  "0x765de816845861e75a25fca122bb6898b8b1282a", // USDm
  "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73", // EURm
  "0xe8537a3d056da446677b9e9d6c5db704eaab4787", // BRLm
  ...TOKENS.map((t) => t.address),
];

const ZERO = "0x0000000000000000000000000000000000000000";

export interface FundingFound {
  funder: Address;
  fundedAt: number;
  block: number;
}

/**
 * First funder of many addresses in one forward pass over Celo history: every inbound transfer of
 * a funding token to any of them, oldest first. An address is settled at its first inbound transfer
 * from someone else and dropped from the filter at the next request, so the pass gets cheaper as it
 * goes. Mints (from the zero address) and transfers to oneself do not count as funding.
 */
export async function scanFirstFunders(
  source: BlockSource,
  addresses: readonly Address[],
  opts: { fromBlock?: number; toBlock: number; signal?: AbortSignal },
): Promise<Map<Address, FundingFound>> {
  const pending = new Set(addresses.map((a) => a.toLowerCase() as Address));
  const found = new Map<Address, FundingFound>();
  let from = opts.fromBlock ?? 0;
  while (pending.size > 0 && from <= opts.toBlock && !opts.signal?.aborted) {
    const filterSize = pending.size;
    const query = {
      type: "evm",
      fromBlock: from,
      toBlock: opts.toBlock,
      fields: {
        block: { number: true, timestamp: true },
        log: {
          address: true,
          topics: true,
          transactionHash: true,
          logIndex: true,
          transactionIndex: true,
          data: true,
        },
      },
      logs: [
        {
          address: [...FUNDING_TOKENS],
          topic0: [TOPICS.erc20Transfer],
          topic2: [...pending].map((a) => pad(a as Hex, { size: 32 })),
        },
      ],
    };
    let last = from - 1;
    let restart = false;
    for await (const block of source.stream(query)) {
      if (opts.signal?.aborted) break;
      last = block.header.number;
      const logs = [...(block.logs ?? [])].sort((a, b) => a.logIndex - b.logIndex);
      for (const l of logs) {
        if (!l.topics[1] || !l.topics[2]) continue;
        const to = topicToAddress(l.topics[2]);
        const fromAddr = topicToAddress(l.topics[1]);
        if (!pending.has(to) || fromAddr === to || fromAddr === ZERO) continue;
        found.set(to, { funder: fromAddr, fundedAt: block.header.timestamp, block: block.header.number });
        pending.delete(to);
      }
      // Re-issue with the smaller filter once a fifth of it is settled.
      if (pending.size <= filterSize * 0.8 && pending.size > 0) {
        restart = true;
        break;
      }
    }
    if (!restart) break;
    from = last + 1;
  }
  return found;
}

/** Contracts and very busy wallets fund many unrelated people; sharing one says nothing. */
export interface FunderClassifier {
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  getTransactionCount(args: { address: Address }): Promise<number>;
}

export async function classifyFunder(
  db: DB,
  rpc: FunderClassifier,
  funder: Address,
): Promise<{ isPublic: boolean; reason: string }> {
  const participant = db
    .prepare("SELECT 1 FROM pair_days WHERE payer = ? OR payee = ? LIMIT 1")
    .get(funder, funder);
  if (participant) return { isPublic: false, reason: "x402 participant" };
  const [code, nonce] = await Promise.all([
    rpc.getCode({ address: funder }).catch(() => undefined),
    rpc.getTransactionCount({ address: funder }).catch(() => 0),
  ]);
  if (code && code !== "0x") return { isPublic: true, reason: "contract" };
  if (nonce >= 5_000) return { isPublic: true, reason: `${nonce} transactions sent` };
  return { isPublic: false, reason: `${nonce} transactions sent` };
}

/**
 * Fill the funding table for x402 payers and sellers that have never been looked up, up to `batch`
 * addresses per pass, busiest first. An address the scan finds no funding for (funded natively,
 * or after the portal's finalized head) is stored with no funder and an old fetch time, so the
 * Blockscout fallback looks at it next.
 */
export async function fundingPass(
  db: DB,
  source: BlockSource,
  rpc: FunderClassifier,
  opts: { batch?: number; toBlock: number; signal?: AbortSignal },
): Promise<number> {
  const rows = db
    .prepare(
      `WITH parties AS (SELECT payer AS address, SUM(usd) AS usd FROM pair_days GROUP BY payer
                        UNION ALL SELECT payee, SUM(usd) FROM pair_days GROUP BY payee),
            ranked AS (SELECT address, SUM(usd) AS usd FROM parties GROUP BY address)
       SELECT r.address FROM ranked r LEFT JOIN funding f ON f.address = r.address
       WHERE f.address IS NULL
       ORDER BY r.usd DESC LIMIT ?`,
    )
    .all(opts.batch ?? 1_000) as { address: Address }[];
  if (rows.length === 0) return 0;
  const addresses = rows.map((r) => r.address);
  const t0 = Date.now();
  const found = await scanFirstFunders(source, addresses, { toBlock: opts.toBlock, signal: opts.signal });
  if (opts.signal?.aborted) return 0;

  const profiles = new Map<Address, { isPublic: boolean; reason: string }>();
  const cached = db.prepare(
    "SELECT is_public, reason FROM funder_profiles WHERE address = ? AND fetched_at > ?",
  );
  const monthAgo = Math.floor(Date.now() / 1000) - 30 * 86_400;
  for (const f of new Set([...found.values()].map((v) => v.funder))) {
    const hit = cached.get(f, monthAgo) as { is_public: number; reason: string } | undefined;
    profiles.set(
      f,
      hit ? { isPublic: hit.is_public === 1, reason: hit.reason } : await classifyFunder(db, rpc, f),
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const upsert = db.prepare(
    `INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (address) DO UPDATE SET funder = excluded.funder, funded_at = excluded.funded_at,
       first_seen_at = excluded.first_seen_at, funder_is_public = excluded.funder_is_public,
       fetched_at = excluded.fetched_at, error = NULL`,
  );
  const profile = db.prepare(
    `INSERT INTO funder_profiles (address, is_public, reason, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET is_public = excluded.is_public, reason = excluded.reason, fetched_at = excluded.fetched_at`,
  );
  db.transaction(() => {
    for (const [f, p] of profiles) profile.run(f, p.isPublic ? 1 : 0, p.reason, now);
    for (const a of addresses) {
      const hit = found.get(a);
      // The first inbound funding transfer doubles as "first seen": an unfunded wallet cannot act.
      if (hit)
        upsert.run(
          a,
          hit.funder,
          hit.fundedAt,
          hit.fundedAt,
          profiles.get(hit.funder)?.isPublic ? 1 : 0,
          now,
        );
      else upsert.run(a, null, null, null, 0, 0);
    }
  })();
  log.info("funding pass", {
    addresses: addresses.length,
    funded: found.size,
    funders: profiles.size,
    ms: Date.now() - t0,
  });
  return addresses.length;
}
