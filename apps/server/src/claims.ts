import { type Address, type ClaimFields, claimMessage, validateClaim } from "assayscore-core";
import { type PublicClient, verifyMessage } from "viem";
import type { DB } from "./db.js";

/** How long a signed claim stays valid, so a captured signature cannot be replayed later. */
const CLAIM_TTL = 10 * 60;
const CLOCK_SKEW = 120;

export interface Claim {
  address: Address;
  name: string;
  url: string | null;
  logoUrl: string | null;
  x: string | null;
  updatedAt: number;
}

export function readClaim(db: DB, address: string): Claim | null {
  const r = db
    .prepare("SELECT address, name, url, logo_url, x, updated_at FROM claims WHERE address = ?")
    .get(address.toLowerCase()) as
    | {
        address: Address;
        name: string;
        url: string | null;
        logo_url: string | null;
        x: string | null;
        updated_at: number;
      }
    | undefined;
  return r
    ? { address: r.address, name: r.name, url: r.url, logoUrl: r.logo_url, x: r.x, updatedAt: r.updated_at }
    : null;
}

/** Claimed names for many addresses at once, for lists. */
export function readClaimNames(db: DB): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of db.prepare("SELECT address, name FROM claims").iterate() as IterableIterator<{
    address: string;
    name: string;
  }>)
    out.set(r.address, r.name);
  return out;
}

export type ClaimOutcome =
  | { ok: true; action: "claim"; claim: Claim }
  | { ok: true; action: "release" }
  | { ok: false; status: 400 | 401; error: string };

/**
 * Apply a signed claim. The signature must recover to the claimed address (an EOA), or verify
 * through the chain for a smart wallet (ERC-1271 / 6492) when an RPC client is given.
 */
export async function applyClaim(
  db: DB,
  input: Partial<ClaimFields> & { signature?: string },
  opts: { rpc?: PublicClient | null; now?: number } = {},
): Promise<ClaimOutcome> {
  const v = validateClaim(input);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const f = v.fields;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (f.issuedAt > now + CLOCK_SKEW)
    return { ok: false, status: 400, error: "The claim is dated in the future." };
  if (f.issuedAt < now - CLAIM_TTL)
    return { ok: false, status: 400, error: "The claim is older than ten minutes. Sign it again." };
  const signature = String(input.signature ?? "");
  if (!/^0x[0-9a-f]+$/i.test(signature) || signature.length < 130)
    return { ok: false, status: 400, error: "Missing signature." };
  const message = claimMessage(f);
  let good = false;
  try {
    good = await verifyMessage({ address: f.address, message, signature: signature as `0x${string}` });
  } catch {
    good = false;
  }
  if (!good && opts.rpc?.verifyMessage) {
    try {
      good = await opts.rpc.verifyMessage({
        address: f.address,
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      good = false;
    }
  }
  if (!good) return { ok: false, status: 401, error: "The signature does not match this address." };
  if (f.action === "release") {
    db.prepare("DELETE FROM claims WHERE address = ?").run(f.address);
    return { ok: true, action: "release" };
  }
  db.prepare(
    `INSERT INTO claims (address, name, url, logo_url, x, signature, issued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET name = excluded.name, url = excluded.url, logo_url = excluded.logo_url,
       x = excluded.x, signature = excluded.signature, issued_at = excluded.issued_at, updated_at = excluded.updated_at`,
  ).run(f.address, f.name, f.url || null, f.logoUrl || null, f.x || null, signature, f.issuedAt, now);
  return { ok: true, action: "claim", claim: readClaim(db, f.address)! };
}
