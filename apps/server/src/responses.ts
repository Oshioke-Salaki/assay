import { type ResponseFields, responseMessage, validateResponse } from "assayscore-core";
import type { PublicClient } from "viem";
import type { DB } from "./db.js";
import { signedShape, verifySigned } from "./lib/signed.js";

/** The seller's own words under one finding, dated. Never part of a score. */
export interface FindingResponse {
  text: string;
  updatedAt: number;
}

export function readResponses(db: DB, address: string): Record<string, FindingResponse> {
  const out: Record<string, FindingResponse> = {};
  for (const r of db
    .prepare("SELECT code, text, updated_at FROM flag_responses WHERE address = ?")
    .iterate(address.toLowerCase()) as IterableIterator<{ code: string; text: string; updated_at: number }>)
    out[r.code] = { text: r.text, updatedAt: r.updated_at };
  return out;
}

export type ResponseOutcome =
  | { ok: true; action: "respond"; code: string; response: FindingResponse }
  | { ok: true; action: "withdraw"; code: string }
  | { ok: false; status: 400 | 401; error: string };

export async function applyResponse(
  db: DB,
  input: Partial<ResponseFields> & { signature?: string },
  opts: { rpc?: PublicClient | null; now?: number } = {},
): Promise<ResponseOutcome> {
  const v = validateResponse(input);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const f = v.fields;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const shape = signedShape(f.issuedAt, input.signature, now);
  if (shape) return { ok: false, status: 400, error: shape };
  const signature = String(input.signature);
  if (!(await verifySigned(f.address, responseMessage(f), signature, opts.rpc)))
    return { ok: false, status: 401, error: "The signature does not match this address." };
  if (f.action === "withdraw") {
    db.prepare("DELETE FROM flag_responses WHERE address = ? AND code = ?").run(f.address, f.code);
    return { ok: true, action: "withdraw", code: f.code };
  }
  db.prepare(
    `INSERT INTO flag_responses (address, code, text, signature, issued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (address, code) DO UPDATE SET text = excluded.text, signature = excluded.signature,
       issued_at = excluded.issued_at, updated_at = excluded.updated_at`,
  ).run(f.address, f.code, f.text, signature, f.issuedAt, now);
  return { ok: true, action: "respond", code: f.code, response: { text: f.text, updatedAt: now } };
}
