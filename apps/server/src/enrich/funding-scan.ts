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
  /** Set only by a scan asked to count zero-value transfers, to recognise ones it used to count. */
  zeroValue?: boolean;
}

/**
 * First funder of many addresses in one forward pass over Celo history: every inbound transfer of
 * a funding token to any of them, oldest first. An address is settled at its first inbound transfer
 * from someone else and dropped from the filter at the next request, so the pass gets cheaper as it
 * goes. Mints (from the zero address), transfers to oneself and zero-value transfers do not count as
 * funding: anyone can send anyone a zero-value Transfer, so counting one would let a stranger, or
 * the seller, choose who a wallet's first funder appears to be.
 */
export async function scanFirstFunders(
  source: BlockSource,
  addresses: readonly Address[],
  opts: { fromBlock?: number; toBlock: number; signal?: AbortSignal; countZeroValue?: boolean },
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
        const zeroValue = !hasValue(l.data);
        if (zeroValue && !opts.countZeroValue) continue;
        const to = topicToAddress(l.topics[2]);
        const fromAddr = topicToAddress(l.topics[1]);
        if (!pending.has(to) || fromAddr === to || fromAddr === ZERO) continue;
        found.set(to, {
          funder: fromAddr,
          fundedAt: block.header.timestamp,
          block: block.header.number,
          tx: l.transactionHash as Hex,
          ...(opts.countZeroValue ? { zeroValue } : {}),
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

/** True when an ERC-20 Transfer's data word carries a non-zero amount. */
export function hasValue(data: string | undefined): boolean {
  return typeof data === "string" && /^0x[0-9a-fA-F]*[1-9a-fA-F][0-9a-fA-F]*$/.test(data);
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
  // A failed lookup throws: read as "no code, nothing sent" it would make an exchange or a batch
  // sender look like a private wallet, and that answer would be cached for a month.
  const [code, nonce] = await Promise.all([
    rpc.getCode({ address: funder }),
    rpc.getTransactionCount({ address: funder }),
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

/**
 * Funder profiles for one pass: cached for a month, otherwise classified and kept for saving. An
 * x402 participant is never public, so that is checked before the cache, which may predate it.
 */
function profiler(db: DB, rpc: FunderClassifier) {
  const profiles = new Map<Address, FunderProfile>();
  const isParticipant = db.prepare("SELECT 1 FROM pair_days WHERE payer = ? OR payee = ? LIMIT 1");
  const cached = db.prepare(
    "SELECT is_public, reason FROM funder_profiles WHERE address = ? AND fetched_at > ?",
  );
  const monthAgo = Math.floor(Date.now() / 1000) - 30 * 86_400;
  const fresh = new Set<Address>();
  const profileOf = async (a: Address): Promise<FunderProfile> => {
    let p = profiles.get(a);
    if (!p) {
      const hit = cached.get(a, monthAgo) as { is_public: number; reason: string | null } | undefined;
      if (isParticipant.get(a, a)) p = { isPublic: false, reason: "x402 participant" };
      else if (hit) p = { isPublic: hit.is_public === 1, reason: hit.reason ?? "" };
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

/** Bumped when a fix to the scan means rows it wrote before must be checked again. */
export const SCAN_VERSION = 1;
/** The portal serves finalized blocks only, minutes behind; a funding this recent may not be there yet. */
const FINALITY_GRACE = 3_600;

type Credit = { c: Attribution } | { error: string };

/** Attribute one found funding, turning a failed lookup into an error to retry rather than an answer. */
async function credit(
  funded: Address,
  hit: { funder: Address; tx: Hex | null },
  p: ReturnType<typeof profiler>,
): Promise<Credit> {
  try {
    return { c: await attributeFunding(funded, hit, p.profileOf, p.senderOf) };
  } catch (err) {
    return { error: String(err).slice(0, 300) };
  }
}

const UPSERT_FUNDING = `INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error,
     funding_tx, funded_via, attributed, scan_version)
   VALUES (@address, @funder, @fundedAt, @fundedAt, @isPublic, @now, @error, @tx, @via, @attributed, @scanVersion)
   ON CONFLICT (address) DO UPDATE SET funder = excluded.funder, funded_at = excluded.funded_at,
     first_seen_at = excluded.first_seen_at, funder_is_public = excluded.funder_is_public,
     fetched_at = excluded.fetched_at, error = excluded.error, funding_tx = excluded.funding_tx,
     funded_via = excluded.funded_via, attributed = excluded.attributed, scan_version = excluded.scan_version`;

/** The row for a funding found by the log scan and attributed (or not, when a lookup failed). */
function fundingRow(address: Address, hit: FundingFound, r: Credit, now: number) {
  if ("error" in r)
    // Handed to the Blockscout fallback, which retries errors after a day.
    return {
      address,
      funder: null,
      fundedAt: null,
      isPublic: 0,
      now,
      error: `attribution: ${r.error}`,
      tx: null,
      via: null,
      attributed: 1,
      scanVersion: SCAN_VERSION,
    };
  // The transaction is kept even when its sender could not be read, so the recheck can read it
  // later without finding the transfer again.
  return {
    address,
    funder: r.c.funder,
    fundedAt: hit.fundedAt,
    isPublic: r.c.isPublic ? 1 : 0,
    now,
    error: null,
    tx: hit.tx,
    via: r.c.via,
    attributed: r.c.settled ? 1 : 0,
    scanVersion: SCAN_VERSION,
  };
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
  const credited = new Map<Address, Credit>();
  for (const [a, hit] of found) credited.set(a, await credit(a, hit, p));

  const now = Math.floor(Date.now() / 1000);
  const upsert = db.prepare(UPSERT_FUNDING);
  db.transaction(() => {
    p.save(now);
    for (const a of addresses) {
      const hit = found.get(a);
      const r = credited.get(a);
      // The first inbound funding transfer doubles as "first seen": an unfunded wallet cannot act.
      if (hit && r) upsert.run(fundingRow(a, hit, r, now));
      else
        upsert.run({
          address: a,
          funder: null,
          fundedAt: null,
          isPublic: 0,
          now: 0,
          error: null,
          tx: null,
          via: null,
          attributed: 1,
          scanVersion: SCAN_VERSION,
        });
    }
  })();
  log.info("funding pass", {
    addresses: addresses.length,
    funded: found.size,
    viaContract: [...credited.values()].filter((r) => "c" in r && r.c.via).length,
    failed: [...credited.values()].filter((r) => "error" in r).length,
    funders: p.count(),
    ms: Date.now() - t0,
  });
  return addresses.length;
}

/**
 * Fundings whose attribution is not settled: a contract funding whose sender could not be read,
 * or a row the rules changed under. Attribute them again from the stored transaction; when there is
 * none, find it with the log scan. A funding the scan cannot find (a native transfer, or one past
 * the portal's head) goes back to the Blockscout fallback rather than being finalized; one newer
 * than the portal can serve waits. Rows that fail go to the back of the queue.
 */
export async function recheckContractFunding(
  db: DB,
  source: BlockSource,
  rpc: FunderClassifier,
  opts: { batch?: number; toBlock: number; signal?: AbortSignal },
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT address, funder, funded_at, funding_tx FROM funding
       WHERE attributed = 0 AND error IS NULL AND funder IS NOT NULL
       ORDER BY fetched_at LIMIT ?`,
    )
    .all(opts.batch ?? 500) as {
    address: Address;
    funder: Address;
    funded_at: number | null;
    funding_tx: Hex | null;
  }[];
  if (rows.length === 0) return 0;

  const p = profiler(db, rpc);
  const now = Math.floor(Date.now() / 1000);
  type Update =
    | { address: Address; kind: "credit"; c: Attribution; tx: Hex | null }
    | { address: Address; kind: "later" }
    | { address: Address; kind: "blockscout"; why: string };
  const updates: Update[] = [];
  const toScan: typeof rows = [];
  // First with what is stored: most need no scan (a participant funder, or a known transaction).
  for (const r of rows) {
    const got = await credit(r.address, { funder: r.funder, tx: r.funding_tx }, p);
    if ("error" in got) updates.push({ address: r.address, kind: "later" });
    else if (got.c.settled) updates.push({ address: r.address, kind: "credit", c: got.c, tx: r.funding_tx });
    else if (r.funding_tx) updates.push({ address: r.address, kind: "later" });
    else toScan.push(r);
  }
  if (toScan.length > 0) {
    const found = await scanFirstFunders(
      source,
      toScan.map((r) => r.address),
      { toBlock: opts.toBlock, signal: opts.signal },
    );
    if (opts.signal?.aborted) return 0;
    for (const r of toScan) {
      const hit = found.get(r.address);
      if (!hit || hit.funder !== r.funder) {
        const recent = r.funded_at !== null && r.funded_at >= now - FINALITY_GRACE;
        updates.push(
          recent
            ? { address: r.address, kind: "later" }
            : {
                address: r.address,
                kind: "blockscout",
                why: hit
                  ? "the log scan found a different first funder"
                  : "the log scan did not find the transfer",
              },
        );
        continue;
      }
      const got = await credit(r.address, hit, p);
      if ("error" in got || !got.c.settled) updates.push({ address: r.address, kind: "later" });
      else updates.push({ address: r.address, kind: "credit", c: got.c, tx: hit.tx });
    }
  }

  const credited = db.prepare(
    `UPDATE funding SET funder = ?, funder_is_public = ?, funded_via = ?, funding_tx = COALESCE(?, funding_tx),
       attributed = 1, fetched_at = ? WHERE address = ?`,
  );
  // The fallback reads the funding again with its transaction; until then the row is untraced.
  const handOff = db.prepare("UPDATE funding SET error = ?, fetched_at = ? WHERE address = ?");
  const later = db.prepare("UPDATE funding SET fetched_at = ? WHERE address = ?");
  let done = 0;
  db.transaction(() => {
    p.save(now);
    for (const u of updates) {
      if (u.kind === "later") later.run(now, u.address);
      else if (u.kind === "blockscout") {
        handOff.run(`recheck: ${u.why}`, now, u.address);
        done++;
      } else {
        credited.run(u.c.funder, u.c.isPublic ? 1 : 0, u.c.via, u.tx, now, u.address);
        done++;
      }
    }
  })();
  log.info("contract funding recheck", {
    rows: rows.length,
    done,
    viaContract: updates.filter((u) => u.kind === "credit" && u.c.via).length,
  });
  return done;
}

/**
 * Check rows the log scan wrote before zero-value transfers stopped counting as funding. The scan
 * is run both ways: a row is replaced only when its stored funding is exactly the zero-value
 * transfer the old scan would have found first. Any other row stands, including one Blockscout
 * found from a native transfer the log scan cannot see. A replaced row with no real funding in
 * the logs is left unfunded, for the Blockscout fallback.
 */
export async function rescanFunding(
  db: DB,
  source: BlockSource,
  rpc: FunderClassifier,
  opts: { batch?: number; toBlock: number; signal?: AbortSignal },
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT address, funder, funded_via, funded_at FROM funding
       WHERE scan_version < ? AND error IS NULL AND funder IS NOT NULL
       ORDER BY fetched_at LIMIT ?`,
    )
    .all(SCAN_VERSION, opts.batch ?? 500) as {
    address: Address;
    funder: Address;
    funded_via: Address | null;
    funded_at: number | null;
  }[];
  if (rows.length === 0) return 0;
  const addresses = rows.map((r) => r.address);
  const asBefore = await scanFirstFunders(source, addresses, { ...opts, countZeroValue: true });
  if (opts.signal?.aborted) return 0;
  const poisoned = rows.filter((r) => {
    const old = asBefore.get(r.address);
    return (
      old?.zeroValue === true && old.funder === (r.funded_via ?? r.funder) && old.fundedAt === r.funded_at
    );
  });
  const found =
    poisoned.length > 0
      ? await scanFirstFunders(
          source,
          poisoned.map((r) => r.address),
          { toBlock: opts.toBlock, signal: opts.signal },
        )
      : new Map<Address, FundingFound>();
  if (opts.signal?.aborted) return 0;

  const p = profiler(db, rpc);
  const now = Math.floor(Date.now() / 1000);
  const replace: { address: Address; hit: FundingFound | undefined; r: Credit | null }[] = [];
  for (const r of poisoned) {
    const hit = found.get(r.address);
    replace.push({ address: r.address, hit, r: hit ? await credit(r.address, hit, p) : null });
  }
  const upsert = db.prepare(UPSERT_FUNDING);
  const mark = db.prepare("UPDATE funding SET scan_version = ? WHERE address = ?");
  db.transaction(() => {
    p.save(now);
    for (const a of addresses) mark.run(SCAN_VERSION, a);
    for (const x of replace)
      upsert.run(
        x.hit && x.r
          ? fundingRow(x.address, x.hit, x.r, now)
          : {
              address: x.address,
              funder: null,
              fundedAt: null,
              isPublic: 0,
              now: 0,
              error: null,
              tx: null,
              via: null,
              attributed: 1,
              scanVersion: SCAN_VERSION,
            },
      );
  })();
  log.info("funding rescan", { rows: rows.length, replaced: replace.length });
  return rows.length;
}
