import type { Address } from "assayscore-core";
import { parseAbi } from "viem";
import type { DB } from "../db.js";
import { sleep } from "../indexer/sqd.js";
import { fetchUntrusted } from "../lib/http.js";
import { log } from "../lib/log.js";

export interface AgentCard {
  name: string | null;
  description: string | null;
  image: string | null;
  x402: boolean | null;
  /** Celo addresses the file lists as service endpoints, in CAIP-10 form (eip155:42220:0x…). */
  addresses: Address[];
}

const MAX_TEXT = 600;
const MAX_ADDRESSES = 10;
const CELO_CAIP10 = /^eip155:42220:(0x[0-9a-fA-F]{40})$/;
const DAY = 86_400;
/** A contract's owner can change, so links are re-read daily. */
const LINK_TTL = DAY;
const REFRESH_TTL = DAY;
const OWNER_ABI = parseAbi(["function owner() view returns (address)"]);

/** Reads owner() from a contract; null when the address has no such function. */
export interface OwnerReader {
  readContract(args: { address: Address; abi: typeof OWNER_ABI; functionName: "owner" }): Promise<string>;
}

/** Resolve an agentURI to its JSON text: inline data: URIs locally, ipfs:// through a gateway, https as is. */
export async function loadRegistration(uri: string, ipfsGateway: string): Promise<string> {
  const trimmed = uri.trim();
  if (trimmed.startsWith("data:")) {
    const comma = trimmed.indexOf(",");
    if (comma < 0) throw new Error("malformed data URI");
    const meta = trimmed.slice(5, comma);
    const payload = trimmed.slice(comma + 1);
    return meta.endsWith(";base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
  }
  if (trimmed.startsWith("ipfs://")) {
    const path = trimmed.slice("ipfs://".length).replace(/^ipfs\//, "");
    if (!/^[A-Za-z0-9]+(\/[\w.\-/]*)?$/.test(path)) throw new Error("malformed ipfs URI");
    return fetchUntrusted(`${ipfsGateway.replace(/\/?$/, "/")}${path}`);
  }
  if (trimmed.startsWith("https://")) return fetchUntrusted(trimmed);
  throw new Error("unsupported URI scheme");
}

/** Pull the display fields out of an ERC-8004 registration file, defensively. */
export function parseRegistration(text: string): AgentCard {
  const json = JSON.parse(text) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? clean(v).slice(0, MAX_TEXT) : null);
  const image = str(json.image);
  return {
    name: str(json.name)?.slice(0, 120) ?? null,
    description: str(json.description),
    image: image && /^(https:\/\/|ipfs:\/\/)/.test(image) ? image : null,
    x402:
      typeof json.x402Support === "boolean"
        ? json.x402Support
        : typeof json.x402support === "boolean"
          ? json.x402support
          : null,
    addresses: listedAddresses(json),
  };
}

/**
 * Addresses named as service endpoints in CAIP-10 form on Celo, the form ERC-8004 uses for an
 * agentWallet endpoint. Only `endpoint` values count: other fields (an agentRegistry, say) name
 * contracts that are not the agent's.
 */
function listedAddresses(json: Record<string, unknown>): Address[] {
  const out: Address[] = [];
  for (const key of ["services", "endpoints"]) {
    const list = json[key];
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      const endpoint = (s as Record<string, unknown> | null)?.endpoint;
      const m = typeof endpoint === "string" ? CELO_CAIP10.exec(endpoint.trim()) : null;
      const a = m?.[1]?.toLowerCase() as Address | undefined;
      if (a && !out.includes(a)) out.push(a);
      if (out.length >= MAX_ADDRESSES) return out;
    }
  }
  return out;
}

/** owner() of a contract, lowercased; null for an EOA, a contract without owner(), or the zero address. */
export async function readOwner(rpc: OwnerReader, address: Address): Promise<Address | null> {
  try {
    const o = String(
      await rpc.readContract({ address, abi: OWNER_ABI, functionName: "owner" }),
    ).toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(o) && !/^0x0{40}$/.test(o) ? (o as Address) : null;
  } catch {
    return null;
  }
}

function clean(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from untrusted text
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/** Fetches registration files, agents with x402 activity or feedback first. */
export class AgentCards {
  constructor(
    private readonly db: DB,
    private readonly ipfsGateway: string,
    private readonly onChange: () => void,
    private readonly rpc?: OwnerReader,
  ) {}

  async batch(limit = 20, now = Math.floor(Date.now() / 1000)): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT a.agent_id, a.uri, 0 AS refresh,
           (SELECT COUNT(*) FROM feedback f WHERE f.agent_id = a.agent_id) +
           (SELECT COUNT(*) FROM pair_days p WHERE p.payee IN (a.owner, a.wallet)) * 10 AS weight
         FROM agents a
         WHERE a.meta_fetched_at IS NULL AND a.uri IS NOT NULL AND a.uri <> ''
         ORDER BY weight DESC, CAST(a.agent_id AS INTEGER) DESC LIMIT ?`,
      )
      .all(limit) as { agent_id: string; uri: string; refresh: number }[];
    // An https file can change without a URIUpdated event, so it is read again daily, oldest first.
    if (rows.length < limit)
      rows.push(
        ...(this.db
          .prepare(
            `SELECT agent_id, uri, 1 AS refresh FROM agents
             WHERE meta_fetched_at < ? AND uri LIKE 'https://%' ORDER BY meta_fetched_at LIMIT ?`,
          )
          .all(now - REFRESH_TTL, limit - rows.length) as {
          agent_id: string;
          uri: string;
          refresh: number;
        }[]),
      );
    const update = this.db.prepare(
      `UPDATE agents SET name = ?, description = ?, image = ?, x402 = ?, meta_fetched_at = ?, meta_error = ? WHERE agent_id = ?`,
    );
    const failedRefresh = this.db.prepare(
      "UPDATE agents SET meta_fetched_at = ?, meta_error = ? WHERE agent_id = ?",
    );
    const listed = this.db.prepare("SELECT address FROM agent_links WHERE agent_id = ?");
    const unlink = this.db.prepare("DELETE FROM agent_links WHERE agent_id = ? AND address = ?");
    const link = this.db.prepare("INSERT OR IGNORE INTO agent_links (agent_id, address) VALUES (?, ?)");
    for (const r of rows) {
      try {
        const card = parseRegistration(await loadRegistration(r.uri, this.ipfsGateway));
        // The file is the agent owner's word on which addresses are its own. Addresses it still
        // lists keep their owner() reading; new ones wait for the next link pass.
        this.db.transaction(() => {
          for (const { address } of listed.all(r.agent_id) as { address: Address }[])
            if (!card.addresses.includes(address)) unlink.run(r.agent_id, address);
          for (const a of card.addresses) link.run(r.agent_id, a);
        })();
        update.run(
          card.name,
          card.description,
          card.image,
          card.x402 === null ? null : card.x402 ? 1 : 0,
          now,
          null,
          r.agent_id,
        );
      } catch (err) {
        // A file that fails to load again keeps what was read before; one never read stays empty.
        if (r.refresh) failedRefresh.run(now, String(err).slice(0, 200), r.agent_id);
        else update.run(null, null, null, null, now, String(err).slice(0, 200), r.agent_id);
      }
    }
    if (rows.length > 0) this.onChange();
    return rows.length;
  }

  /** Read owner() for listed addresses never checked, or not checked for a day. */
  async linkPass(limit = 50, now = Math.floor(Date.now() / 1000)): Promise<number> {
    const rpc = this.rpc;
    if (!rpc) return 0;
    const rows = this.db
      .prepare(
        `SELECT agent_id, address, contract_owner FROM agent_links
         WHERE checked_at IS NULL OR checked_at < ? ORDER BY checked_at IS NOT NULL, checked_at LIMIT ?`,
      )
      .all(now - LINK_TTL, limit) as { agent_id: string; address: Address; contract_owner: string | null }[];
    const update = this.db.prepare(
      "UPDATE agent_links SET contract_owner = ?, checked_at = ? WHERE agent_id = ? AND address = ?",
    );
    let changed = false;
    for (const r of rows) {
      const owner = await readOwner(rpc, r.address);
      if (owner !== r.contract_owner) changed = true;
      update.run(owner, now, r.agent_id, r.address);
    }
    if (changed) this.onChange();
    return rows.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let n = 0;
      try {
        n = await this.batch();
        n += await this.linkPass();
      } catch (err) {
        log.warn("agent cards failed", { error: String(err) });
      }
      await sleep(n > 0 ? 500 : 60_000, signal);
    }
  }
}
