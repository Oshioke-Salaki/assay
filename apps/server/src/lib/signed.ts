import type { PublicClient } from "viem";
import { verifyMessage } from "viem";
import type { DB } from "../db.js";

/** Ten minutes: long enough to sign, short enough that a captured signature is worthless later. */
export const SIGNED_TTL = 10 * 60;
export const CLOCK_SKEW = 120;

/** Why a signed message cannot be accepted, or null when its time and signature look usable. */
export function signedShape(issuedAt: number, signature: unknown, now: number): string | null {
  if (issuedAt > now + CLOCK_SKEW) return "The message is dated in the future.";
  if (issuedAt < now - SIGNED_TTL) return "The message is older than ten minutes. Sign it again.";
  const s = String(signature ?? "");
  if (!/^0x[0-9a-f]+$/i.test(s) || s.length < 130) return "Missing signature.";
  return null;
}

/**
 * Does this signature come from the address? An EOA is checked offline; a smart wallet through
 * the chain (ERC-1271 / 6492) when an RPC client is available.
 */
export async function verifySigned(
  address: `0x${string}`,
  message: string,
  signature: string,
  rpc?: PublicClient | null,
): Promise<boolean> {
  try {
    if (await verifyMessage({ address, message, signature: signature as `0x${string}` })) return true;
  } catch {
    // fall through to the chain
  }
  if (rpc?.verifyMessage) {
    try {
      return await rpc.verifyMessage({ address, message, signature: signature as `0x${string}` });
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Accept a signed owner action (a claim, a reply, free alerts) only if it is newer than the last
 * one accepted for the same address and kind, and record it. A message replayed as-is (same
 * issuedAt and nonce) or an older one (rolling a newer update back) is refused. Synchronous, so the
 * check and the write cannot be interleaved with another request: call it after the signature
 * has been verified and right before the change it authorises.
 */
export function acceptSigned(
  db: DB,
  a: { address: string; kind: string; issuedAt: number; nonce: string },
  now = Math.floor(Date.now() / 1000),
): boolean {
  const address = a.address.toLowerCase();
  const last = db
    .prepare("SELECT issued_at, nonce FROM signed_actions WHERE address = ? AND kind = ?")
    .get(address, a.kind) as { issued_at: number; nonce: string } | undefined;
  if (last && (a.issuedAt < last.issued_at || (a.issuedAt === last.issued_at && a.nonce === last.nonce)))
    return false;
  db.prepare(
    `INSERT INTO signed_actions (address, kind, issued_at, nonce, accepted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (address, kind) DO UPDATE SET issued_at = excluded.issued_at, nonce = excluded.nonce,
       accepted_at = excluded.accepted_at`,
  ).run(address, a.kind, a.issuedAt, a.nonce, now);
  return true;
}

export const REPLAYED = "This signed message was already used, or a newer one replaced it. Sign a new one.";
