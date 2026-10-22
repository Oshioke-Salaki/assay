import type { PublicClient } from "viem";
import { verifyMessage } from "viem";

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
