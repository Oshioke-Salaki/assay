import {
  type Address,
  CELO_AGENT_VISA,
  celoAgentVisaAbi,
  SELF_AGENT_REGISTRY,
  selfAgentRegistryAbi,
} from "assayscore-core";
import { type Hex, type PublicClient, pad } from "viem";
import type { DB } from "../db.js";
import type { BlockSource } from "../indexer/sqd.js";
import { sleep } from "../indexer/sqd.js";
import { log } from "../lib/log.js";
import type { Blockscout } from "./blockscout.js";
import {
  attributeFunding,
  type FunderClassifier,
  type FunderProfile,
  fundingPass,
  recheckContractFunding,
} from "./funding-scan.js";

const DAY = 86_400;
/** Funding never changes once found; addresses with no funding yet are retried weekly. */
const UNFUNDED_RETRY = 7 * DAY;
const ERROR_RETRY = DAY;
const HUMAN_TTL = DAY;
const FUNDER_PROFILE_TTL = 30 * DAY;

/** Funding from one forward pass over SQD logs, for many addresses at once. */
export interface FundingScan {
  source: BlockSource;
  rpc: FunderClassifier;
  head: () => Promise<number>;
  batch?: number;
}

/**
 * Background enrichment: who funded each payer and seller (an SQD log scan, with Blockscout as
 * the per-address fallback), whether
 * each address is a Self-verified human agent (SelfAgentRegistry), and whether a
 * funder is a public source. Work is ordered so the busiest sellers' payers come first.
 */
export class Enricher {
  private dirty = false;

  constructor(
    private readonly db: DB,
    private readonly blockscout: Blockscout,
    private readonly client: PublicClient,
    private readonly onChange: () => void,
    private readonly scan?: FundingScan,
  ) {}

  /** Addresses that need funding data, highest x402 volume first. */
  fundingQueue(limit: number, now = nowSec()): Address[] {
    return (
      this.db
        .prepare(
          `WITH parties AS (
             SELECT payer AS address, SUM(usd) AS usd FROM pair_days GROUP BY payer
             UNION ALL
             SELECT payee AS address, SUM(usd) AS usd FROM pair_days GROUP BY payee
           ), ranked AS (SELECT address, SUM(usd) AS usd FROM parties GROUP BY address)
           SELECT r.address FROM ranked r LEFT JOIN funding f ON f.address = r.address
           WHERE (f.address IS NULL AND NOT @scanned)
              OR (f.error IS NOT NULL AND f.fetched_at < @errorBefore)
              OR (f.error IS NULL AND f.funder IS NULL AND f.fetched_at < @unfundedBefore)
           ORDER BY r.usd DESC LIMIT @limit`,
        )
        .all({
          limit,
          errorBefore: now - ERROR_RETRY,
          unfundedBefore: now - UNFUNDED_RETRY,
          // Addresses never looked up belong to the scan when there is one.
          scanned: this.scan ? 1 : 0,
        }) as {
        address: Address;
      }[]
    ).map((r) => r.address);
  }

  async fundingBatch(limit = 40, signal?: AbortSignal): Promise<number> {
    const queue = this.fundingQueue(limit);
    const upsert = this.db.prepare(
      `INSERT INTO funding (address, funder, funded_at, first_seen_at, funder_is_public, fetched_at, error, funding_tx, funded_via)
       VALUES (@address, @funder, @fundedAt, @firstSeenAt, @isPublic, @now, @error, @tx, @via)
       ON CONFLICT (address) DO UPDATE SET funder = excluded.funder, funded_at = excluded.funded_at,
         first_seen_at = excluded.first_seen_at, funder_is_public = excluded.funder_is_public,
         fetched_at = excluded.fetched_at, error = excluded.error, funding_tx = excluded.funding_tx,
         funded_via = excluded.funded_via`,
    );
    const senderOf = async (hash: Hex): Promise<Address> => (await this.client.getTransaction({ hash })).from;
    let done = 0;
    for (const address of queue) {
      if (signal?.aborted) break;
      try {
        const f = await this.blockscout.funding(address);
        const c = f.funder
          ? await attributeFunding(
              address,
              { funder: f.funder, tx: f.tx },
              (a) => this.funderProfile(a),
              senderOf,
            )
          : null;
        upsert.run({
          address,
          funder: c?.funder ?? null,
          fundedAt: f.fundedAt,
          firstSeenAt: f.firstSeenAt,
          isPublic: c?.isPublic ? 1 : 0,
          now: nowSec(),
          error: null,
          // Without its transaction, a contract funding is picked up again by the recheck.
          tx: c?.settled ? f.tx : null,
          via: c?.via ?? null,
        });
      } catch (err) {
        upsert.run({
          address,
          funder: null,
          fundedAt: null,
          firstSeenAt: null,
          isPublic: 0,
          now: nowSec(),
          error: String(err).slice(0, 300),
          tx: null,
          via: null,
        });
      }
      done++;
    }
    if (done > 0) this.markDirty();
    return done;
  }

  private async funderProfile(funder: Address): Promise<FunderProfile> {
    // An address that buys or sells over x402 itself is a participant, never a neutral
    // source like an exchange, however many transactions it has.
    const participant = this.db
      .prepare("SELECT 1 FROM pair_days WHERE payer = ? OR payee = ? LIMIT 1")
      .get(funder, funder);
    if (participant) return { isPublic: false, reason: "x402 participant" };
    const cached = this.db
      .prepare("SELECT is_public, reason, fetched_at FROM funder_profiles WHERE address = ?")
      .get(funder) as { is_public: number; reason: string | null; fetched_at: number } | undefined;
    if (cached && cached.fetched_at > nowSec() - FUNDER_PROFILE_TTL)
      return { isPublic: cached.is_public === 1, reason: cached.reason ?? "" };
    const profile = await this.blockscout.funderProfile(funder);
    this.db
      .prepare(
        `INSERT INTO funder_profiles (address, is_public, reason, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET is_public = excluded.is_public, reason = excluded.reason, fetched_at = excluded.fetched_at`,
      )
      .run(funder, profile.isPublic ? 1 : 0, profile.reason, nowSec());
    return profile;
  }

  /** Look up Self Agent IDs for parties with stale or missing entries, in multicall batches. */
  async humansBatch(limit = 300): Promise<number> {
    const rows = this.db
      .prepare(
        `WITH parties AS (SELECT payer AS address FROM pair_days UNION SELECT payee FROM pair_days
                          UNION SELECT owner FROM agents UNION SELECT wallet FROM agents WHERE wallet IS NOT NULL)
         SELECT p.address FROM parties p LEFT JOIN humans h ON h.address = p.address
         WHERE h.address IS NULL OR h.fetched_at < ? LIMIT ?`,
      )
      .all(nowSec() - HUMAN_TTL, limit) as { address: Address }[];
    if (rows.length === 0) return 0;
    const addresses = rows.map((r) => r.address);
    const ids = await this.client.multicall({
      allowFailure: true,
      contracts: addresses.map((a) => ({
        address: SELF_AGENT_REGISTRY,
        abi: selfAgentRegistryAbi,
        functionName: "agentKeyToAgentId" as const,
        args: [pad(a, { size: 32 })] as const,
      })),
    });
    // allowFailure turns a transport error into per-call failures; if every lookup failed, say why
    // instead of silently recording "no human" for the whole batch.
    if (ids.length > 0 && ids.every((r) => r.status === "failure")) {
      const reason = ids[0]?.status === "failure" ? String(ids[0].error).slice(0, 300) : "unknown";
      log.warn("self lookup batch failed", { addresses: addresses.length, reason });
      return 0;
    }
    const found = addresses
      .map((a, i) => ({ address: a, id: ids[i]?.status === "success" ? (ids[i]!.result as bigint) : 0n }))
      .filter((x) => x.id > 0n);
    const details = found.length
      ? await this.client.multicall({
          allowFailure: true,
          contracts: found.flatMap((f) => [
            {
              address: SELF_AGENT_REGISTRY,
              abi: selfAgentRegistryAbi,
              functionName: "hasHumanProof" as const,
              args: [f.id] as const,
            },
            {
              address: SELF_AGENT_REGISTRY,
              abi: selfAgentRegistryAbi,
              functionName: "isProofFresh" as const,
              args: [f.id] as const,
            },
            {
              address: SELF_AGENT_REGISTRY,
              abi: selfAgentRegistryAbi,
              functionName: "getHumanNullifier" as const,
              args: [f.id] as const,
            },
            // The Celo Agent Visa is keyed by the same Self agent id. Shown on pages, never scored.
            {
              address: CELO_AGENT_VISA,
              abi: celoAgentVisaAbi,
              functionName: "getTier" as const,
              args: [f.id] as const,
            },
          ]),
        })
      : [];
    const PER = 4;
    const byAddress = new Map<
      string,
      { agentId: string; nullifier: string; fresh: boolean; visaTier: number }
    >();
    found.forEach((f, i) => {
      const has = details[i * PER];
      const fresh = details[i * PER + 1];
      const nullifier = details[i * PER + 2];
      const tier = details[i * PER + 3];
      if (has?.status === "success" && has.result === true && nullifier?.status === "success") {
        byAddress.set(f.address, {
          agentId: f.id.toString(),
          nullifier: (nullifier.result as bigint).toString(),
          fresh: fresh?.status === "success" && fresh.result === true,
          visaTier: tier?.status === "success" ? Math.min(3, Math.max(0, Number(tier.result))) : 0,
        });
      }
    });
    const upsert = this.db.prepare(
      `INSERT INTO humans (address, agent_id, nullifier, fresh, visa_tier, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET agent_id = excluded.agent_id, nullifier = excluded.nullifier,
         fresh = excluded.fresh, visa_tier = excluded.visa_tier, fetched_at = excluded.fetched_at`,
    );
    this.db.transaction(() => {
      for (const a of addresses) {
        const h = byAddress.get(a);
        upsert.run(a, h?.agentId ?? null, h?.nullifier ?? null, h?.fresh ? 1 : 0, h?.visaTier ?? 0, nowSec());
      }
    })();
    if (byAddress.size > 0) this.markDirty();
    return addresses.length;
  }

  /** Runs until aborted. Each pass does a bounded amount of work, then yields. */
  async run(signal: AbortSignal): Promise<void> {
    await Promise.all([this.lookups(signal), this.scanLoop(signal)]);
  }

  /** One scan covers a whole batch of addresses; when nothing is new it waits ten minutes. */
  private async scanLoop(signal: AbortSignal): Promise<void> {
    const scan = this.scan;
    if (!scan) return;
    while (!signal.aborted) {
      let done = 0;
      try {
        const toBlock = await scan.head();
        done = await fundingPass(this.db, scan.source, scan.rpc, {
          batch: scan.batch ?? 500,
          toBlock,
          signal,
        });
        done += await recheckContractFunding(this.db, scan.source, scan.rpc, {
          batch: scan.batch ?? 500,
          toBlock,
          signal,
        });
        if (done > 0) this.markDirty();
      } catch (err) {
        log.warn("funding scan failed", { error: String(err) });
      }
      this.flush();
      await sleep(done > 0 ? 1_000 : 10 * 60_000, signal);
    }
  }

  private async lookups(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let worked = 0;
      try {
        worked += await this.humansBatch();
      } catch (err) {
        log.warn("self lookup failed", { error: String(err) });
      }
      try {
        worked += await this.fundingBatch(40, signal);
      } catch (err) {
        log.warn("funding batch failed", { error: String(err) });
      }
      this.flush();
      await sleep(worked > 0 ? 250 : 30_000, signal);
    }
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private flush(): void {
    if (this.dirty) {
      this.dirty = false;
      this.onChange();
    }
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
