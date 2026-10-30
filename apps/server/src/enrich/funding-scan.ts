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
  /** The transaction that carried the transfer. */
  tx: Hex;
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
        found.set(to, {
          funder: fromAddr,
          fundedAt: block.header.timestamp,
          block: block.header.number,
          tx: l.transactionHash as Hex,
        });
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
  getTransaction(args: { hash: Hex }): Promise<{ from: Address }>;
}

export interface FunderProfile {
  isPublic: boolean;
  /** Starts with "contract" for a contract; the Blockscout profile may add its name. */
  reason: string;
}

export async function classifyFunder(db: DB, rpc: FunderClassifier, funder: Address): Promise<FunderProfile> {
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

/** Whom a first funding is credited to, and whether sharing that funder says anything. */
export interface Attribution {
  funder: Address;
  isPublic: boolean;
  /** The contract the funding passed through, when `funder` is whoever called it. */
  via: Address | null;
  /** False when the transaction's sender could not be read: the contract stands for now. */
  settled: boolean;
}

/**
 * A contract that hands out tokens (a batch sender, a router, a faucet) is not who decided to fund
 * a wallet; whoever sent the transaction is. So when the first funding came out of a public
 * contract, the transaction's sender takes its place, unless the sender is the funded wallet itself
 * (it swapped or claimed for itself) or is public too (a relayer, bundler or exchange acting for
 * many people). Without this, a seller could fund its own payers through a batch-send contract and
 * have them counted as organic.
 */
export async function attributeFunding(
  funded: Address,
  hit: { funder: Address; tx: Hex | null },
  profileOf: (a: Address) => Promise<FunderProfile>,
  senderOf: (tx: Hex) => Promise<Address>,
): Promise<Attribution> {
  const profile = await profileOf(hit.funder);
  const asFound = { funder: hit.funder, isPublic: profile.isPublic, via: null };
  if (!profile.isPublic || !profile.reason.startsWith("contract")) return { ...asFound, settled: true };
  if (!hit.tx) return { ...asFound, settled: false };
  let sender: Address;
  try {
    sender = (await senderOf(hit.tx)).toLowerCase() as Address;
  } catch {
    return { ...asFound, settled: false };
  }
  if (sender === funded || sender === hit.funder) return { ...asFound, settled: true };
  if ((await profileOf(sender)).isPublic) return { ...asFound, settled: true };
  return { funder: sender, isPublic: false, via: hit.funder, settled: true };
}

/** Funder profiles for one pass: cached for a month, otherwise classified and kept for saving. */
function profiler(db: DB, rpc: FunderClassifier) {
  const profiles = new Map<Address, FunderProfile>();
  const cached = db.prepare(
    "SELECT is_public, reason FROM funder_profiles WHERE address = ? AND fetched_at > ?",
  );
  const monthAgo = Math.floor(Date.now() / 1000) - 30 * 86_400;
  const fresh = new Set<Address>();
  const profileOf = async (a: Address): Promise<FunderProfile> => {
    let p = profiles.get(a);
    if (!p) {
      const hit = cached.get(a, monthAgo) as { is_public: number; reason: string | null } | undefined;
      if (hit) p = { isPublic: hit.is_public === 1, reason: hit.reason ?? "" };
      else {
        p = await classifyFunder(db, rpc, a);
        fresh.add(a);
      }
      profiles.set(a, p);
    }
    return p;
  };
  const save = (now: number) => {
    const upsert = db.prepare(
      `INSERT INTO funder_profiles (address, is_public, reason, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET is_public = excluded.is_public, reason = excluded.reason, fetched_at = excluded.fetched_at`,
    );
    for (const a of fresh) {
      const p = profiles.get(a)!;
      upsert.run(a, p.isPublic ? 1 : 0, p.reason, now);
    }
  };
  const senderOf = async (hash: Hex): Promise<Address> => (await rpc.getTransaction({ hash })).from;
  return { profileOf, senderOf, save, count: () => profiles.size };
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

  const p = profiler(db, rpc);
  const credited = new Map<Address, Attribution>();
  for (const [a, hit] of found) credited.set(a, await attributeFunding(a, hit, p.profileOf, p.senderOf));

  const now = Math.floor(Date.now() / 1000);
  const upsert = db.prepare(
    `INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error, funding_tx, funded_via)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT (address) DO UPDATE SET funder = excluded.funder, funded_at = excluded.funded_at,
       first_seen_at = excluded.first_seen_at, funder_is_public = excluded.funder_is_public,
       fetched_at = excluded.fetched_at, error = NULL, funding_tx = excluded.funding_tx,
       funded_via = excluded.funded_via`,
  );
  db.transaction(() => {
    p.save(now);
    for (const a of addresses) {
      const hit = found.get(a);
      const c = credited.get(a);
      // The first inbound funding transfer doubles as "first seen": an unfunded wallet cannot act.
      // A contract funding whose sender could not be read keeps no transaction, so it is retried.
      if (hit && c)
        upsert.run(
          a,
          c.funder,
          hit.fundedAt,
          hit.fundedAt,
          c.isPublic ? 1 : 0,
          now,
          c.settled ? hit.tx : null,
          c.via,
        );
      else upsert.run(a, null, null, null, 0, 0, null, null);
    }
  })();
  log.info("funding pass", {
    addresses: addresses.length,
    funded: found.size,
    viaContract: [...credited.values()].filter((c) => c.via).length,
    funders: p.count(),
    ms: Date.now() - t0,
  });
  return addresses.length;
}

/**
 * Funding through a contract that was recorded without its transaction (found before funders were
 * credited past contracts, or whose sender could not be read then): find the transaction again and
 * credit whoever called the contract. A row is done once it carries its transaction, or "" when the
 * scan cannot find the transfer at all. Rows that fail go to the back of the queue.
 */
export async function recheckContractFunding(
  db: DB,
  source: BlockSource,
  rpc: FunderClassifier,
  opts: { batch?: number; toBlock: number; signal?: AbortSignal },
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT f.address, f.funder FROM funding f JOIN funder_profiles p ON p.address = f.funder
       WHERE f.funding_tx IS NULL AND f.funded_via IS NULL AND f.funder_is_public = 1
         AND f.error IS NULL AND p.reason LIKE 'contract%'
       ORDER BY f.fetched_at LIMIT ?`,
    )
    .all(opts.batch ?? 500) as { address: Address; funder: Address }[];
  if (rows.length === 0) return 0;
  const found = await scanFirstFunders(
    source,
    rows.map((r) => r.address),
    { toBlock: opts.toBlock, signal: opts.signal },
  );
  if (opts.signal?.aborted) return 0;

  const p = profiler(db, rpc);
  const now = Math.floor(Date.now() / 1000);
  const updates: { address: Address; c: Attribution | null; tx: Hex | null }[] = [];
  for (const r of rows) {
    const hit = found.get(r.address);
    // The scan should find the same first transfer; if it names someone else, leave the row be.
    if (!hit || hit.funder !== r.funder) updates.push({ address: r.address, c: null, tx: null });
    else
      updates.push({
        address: r.address,
        c: await attributeFunding(r.address, hit, p.profileOf, p.senderOf),
        tx: hit.tx,
      });
  }
  const credit = db.prepare(
    `UPDATE funding SET funder = ?, funder_is_public = ?, funded_via = ?, funding_tx = ?, fetched_at = ?
     WHERE address = ?`,
  );
  const giveUp = db.prepare("UPDATE funding SET funding_tx = '', fetched_at = ? WHERE address = ?");
  const later = db.prepare("UPDATE funding SET fetched_at = ? WHERE address = ?");
  // Rows finished this pass: credited, or given up on.
  let done = 0;
  db.transaction(() => {
    p.save(now);
    for (const u of updates) {
      if (!u.c) {
        giveUp.run(now, u.address);
        done++;
      } else if (!u.c.settled) later.run(now, u.address);
      else {
        credit.run(u.c.funder, u.c.isPublic ? 1 : 0, u.c.via, u.tx, now, u.address);
        done++;
      }
    }
  })();
  log.info("contract funding recheck", {
    rows: rows.length,
    done,
    viaContract: updates.filter((u) => u.c?.via).length,
  });
  return done;
}
