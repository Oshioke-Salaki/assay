import type { DB } from "../db.js";
import { sleep } from "../indexer/sqd.js";
import { fetchUntrusted } from "../lib/http.js";
import { log } from "../lib/log.js";

export interface AgentCard {
  name: string | null;
  description: string | null;
  image: string | null;
  x402: boolean | null;
}

const MAX_TEXT = 600;

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
  };
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
  ) {}

  async batch(limit = 20): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT a.agent_id, a.uri,
           (SELECT COUNT(*) FROM feedback f WHERE f.agent_id = a.agent_id) +
           (SELECT COUNT(*) FROM pair_days p WHERE p.payee IN (a.owner, a.wallet)) * 10 AS weight
         FROM agents a
         WHERE a.meta_fetched_at IS NULL AND a.uri IS NOT NULL AND a.uri <> ''
         ORDER BY weight DESC, CAST(a.agent_id AS INTEGER) DESC LIMIT ?`,
      )
      .all(limit) as { agent_id: string; uri: string }[];
    const update = this.db.prepare(
      `UPDATE agents SET name = ?, description = ?, image = ?, x402 = ?, meta_fetched_at = ?, meta_error = ? WHERE agent_id = ?`,
    );
    for (const r of rows) {
      const now = Math.floor(Date.now() / 1000);
      try {
        const card = parseRegistration(await loadRegistration(r.uri, this.ipfsGateway));
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
        update.run(null, null, null, null, now, String(err).slice(0, 200), r.agent_id);
      }
    }
    if (rows.length > 0) this.onChange();
    return rows.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let n = 0;
      try {
        n = await this.batch();
      } catch (err) {
        log.warn("agent cards failed", { error: String(err) });
      }
      await sleep(n > 0 ? 500 : 60_000, signal);
    }
  }
}
