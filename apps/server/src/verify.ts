import {
  type Address,
  type Assessment,
  ATTESTATION_TYPES,
  assess,
  attestationDomain,
  isAddress,
  Ledger,
  RATING_CODES,
  ratingFromCode,
  toMicros,
} from "assayscore-core";
import { type Hex, recoverTypedDataAddress } from "viem";
import { loadContext, loadFlowsAt } from "./analysis.js";
import { type DB, getCursor } from "./db.js";
import { SETTLEMENT_CURSOR } from "./indexer/settlements.js";

/**
 * Check a signed Assay score without trusting Assay: confirm who signed it, then replay it from
 * your own copy of Celo's data at the block and time it was signed, and compare every field.
 *
 * The replay is exact when your node holds the same data Assay held: the same settlements (these
 * are onchain and identical for everyone) and the same funding, Self and ERC-8004 enrichment.
 * Enrichment is read from public sources too, but a node that traced an address's funding at a
 * different time can differ; the report says which inputs could explain any difference.
 */

/** The nine fields AssayRegistry verifies, as numbers and bigints. */
export interface ScoreFields {
  subject: Address;
  score: number;
  rating: number;
  organicUsdMicros: bigint;
  grossUsdMicros: bigint;
  effectivePayersX100: number;
  asOfBlock: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
}

/** Read a score from the JSON an Assay check or attest call returns, or from the attestation itself. */
export function parseAttestation(input: unknown): {
  fields: ScoreFields;
  signature: Hex | null;
  registry: Address | null;
  claimedSigner: Address | null;
} {
  const root = (input ?? {}) as Record<string, unknown>;
  const att = (root.attestation ?? root) as Record<string, unknown>;
  const m = (att.message ?? att) as Record<string, unknown>;
  const big = (k: string): bigint => {
    const v = m[k];
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
    throw new Error(`The score's ${k} is missing or not a whole number.`);
  };
  const small = (k: string, max: number): number => {
    const n = Number(big(k));
    if (n > max) throw new Error(`The score's ${k} is out of range.`);
    return n;
  };
  const subject = String(m.subject ?? "").toLowerCase();
  if (!isAddress(subject)) throw new Error("The score has no valid subject address.");
  const fields: ScoreFields = {
    subject: subject as Address,
    score: small("score", 100),
    rating: small("rating", 8),
    organicUsdMicros: big("organicUsdMicros"),
    grossUsdMicros: big("grossUsdMicros"),
    effectivePayersX100: small("effectivePayersX100", 2 ** 32 - 1),
    asOfBlock: big("asOfBlock"),
    issuedAt: big("issuedAt"),
    expiresAt: big("expiresAt"),
  };
  const sig =
    typeof att.signature === "string" && /^0x[0-9a-fA-F]+$/.test(att.signature)
      ? (att.signature as Hex)
      : null;
  const domain = (att.domain ?? {}) as Record<string, unknown>;
  const vc = String(domain.verifyingContract ?? "").toLowerCase();
  const signer = String(att.signer ?? "").toLowerCase();
  return {
    fields,
    signature: sig,
    registry: isAddress(vc) ? (vc as Address) : null,
    claimedSigner: isAddress(signer) ? (signer as Address) : null,
  };
}

/** The address that signed this score for this registry, or null when the signature is malformed. */
export async function recoverSigner(
  fields: ScoreFields,
  signature: Hex,
  registry: Address,
): Promise<Address | null> {
  try {
    const a = await recoverTypedDataAddress({
      domain: attestationDomain(registry),
      types: ATTESTATION_TYPES,
      primaryType: "Score",
      message: fields,
      signature,
    });
    return a.toLowerCase() as Address;
  } catch {
    return null;
  }
}

/** The assessment a node with this database would have produced at `block`, at time `now`. */
export function reassess(db: DB, subject: Address, block: number, now: number): Assessment {
  const ledger = new Ledger(loadFlowsAt(db, block));
  return assess(ledger, subject, loadContext(db, now));
}

/** The nine fields as the attester computes them from an assessment (attest.ts does the same). */
export function fieldsFrom(a: Assessment, block: number, now: number): ScoreFields {
  const gross = toMicros(a.seller.grossUsd);
  const organic = toMicros(a.seller.organicUsd);
  return {
    subject: a.address,
    score: a.score ?? 0,
    rating: RATING_CODES[a.rating],
    organicUsdMicros: organic > gross ? gross : organic,
    grossUsdMicros: gross,
    effectivePayersX100: Math.min(2 ** 32 - 1, Math.round((a.components?.effectivePayers ?? 0) * 100)),
    asOfBlock: BigInt(block),
    issuedAt: BigInt(now),
    expiresAt: 0n,
  };
}

export interface FieldCheck {
  field: string;
  signed: string;
  recomputed: string;
  match: boolean;
  note?: string;
}

/** Sums of many float amounts can differ in the last micro-dollar with summation order; allow that. */
const MICRO_TOLERANCE = 1n;

export function compare(signed: ScoreFields, again: ScoreFields): FieldCheck[] {
  const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= MICRO_TOLERANCE;
  return [
    {
      field: "score",
      signed: String(signed.score),
      recomputed: String(again.score),
      match: signed.score === again.score,
    },
    {
      field: "rating",
      signed: ratingFromCode(signed.rating),
      recomputed: ratingFromCode(again.rating),
      match: signed.rating === again.rating,
    },
    {
      field: "grossUsdMicros",
      signed: signed.grossUsdMicros.toString(),
      recomputed: again.grossUsdMicros.toString(),
      match: near(signed.grossUsdMicros, again.grossUsdMicros),
      note: "gross x402 revenue in millionths of a dollar",
    },
    {
      field: "organicUsdMicros",
      signed: signed.organicUsdMicros.toString(),
      recomputed: again.organicUsdMicros.toString(),
      match: near(signed.organicUsdMicros, again.organicUsdMicros),
      note: "organic revenue in millionths of a dollar",
    },
    {
      field: "effectivePayersX100",
      signed: String(signed.effectivePayersX100),
      recomputed: String(again.effectivePayersX100),
      match: Math.abs(signed.effectivePayersX100 - again.effectivePayersX100) <= 1,
      note: "independent payers × 100",
    },
  ];
}

export type VerifyOutcome = "verified" | "differs" | "signature-invalid" | "node-behind";

export interface VerifyReport {
  outcome: VerifyOutcome;
  subject: Address;
  asOfBlock: number;
  issuedAt: number;
  expiresAt: number;
  expired: boolean;
  signature: {
    checked: boolean;
    recovered: Address | null;
    /** The attester the registry trusts, when the caller could read it from the chain. */
    expected: Address | null;
    valid: boolean | null;
  };
  node: { indexedTo: number };
  fields: FieldCheck[];
  /** Inputs that could explain a difference, in plain words. Empty when everything matched. */
  explain: string[];
}

/**
 * Verify one score. `expectedSigner` is the attester the registry trusts (read it from
 * AssayRegistry.attester()); without it, the recovered signer is reported but not judged. Scores
 * read from the registry carry no signature: the registry already checked it on publish.
 */
export async function verifyScore(
  db: DB,
  input: { fields: ScoreFields; signature: Hex | null; registry: Address | null },
  opts: { expectedSigner?: Address | null; now?: number; fromRegistry?: boolean } = {},
): Promise<VerifyReport> {
  const f = input.fields;
  const block = Number(f.asOfBlock);
  const issuedAt = Number(f.issuedAt);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const indexedTo = getCursor(db, SETTLEMENT_CURSOR) ?? 0;
  const expected = opts.expectedSigner?.toLowerCase() as Address | undefined;

  let recovered: Address | null = null;
  let valid: boolean | null = null;
  let checked = false;
  if (opts.fromRegistry) {
    // AssayRegistry only stores a score after checking the attester's signature.
    checked = true;
    valid = true;
  } else if (input.signature && input.registry) {
    checked = true;
    recovered = await recoverSigner(f, input.signature, input.registry);
    valid = recovered !== null && (expected ? recovered === expected : null);
    if (recovered === null) valid = false;
  }
  const base = {
    subject: f.subject,
    asOfBlock: block,
    issuedAt,
    expiresAt: Number(f.expiresAt),
    expired: Number(f.expiresAt) <= now,
    signature: { checked, recovered, expected: expected ?? null, valid },
    node: { indexedTo },
  };
  if (valid === false)
    return {
      ...base,
      outcome: "signature-invalid",
      fields: [],
      explain: [
        recovered
          ? `Signed by ${recovered}, not by the attester the registry trusts (${expected}).`
          : "The signature does not recover to any address for this registry.",
      ],
    };
  if (indexedTo < block)
    return {
      ...base,
      outcome: "node-behind",
      fields: [],
      explain: [
        `This node has indexed settlements to block ${indexedTo}; the score is as of block ${block}. Let the indexer catch up (pnpm --filter @assay/server backfill), then verify again.`,
      ],
    };

  const again = fieldsFrom(reassess(db, f.subject, block, issuedAt), block, issuedAt);
  const fields = compare(f, again);
  const ok = fields.every((x) => x.match);
  const explain: string[] = [];
  if (!ok) {
    const grossOff = !fields.find((x) => x.field === "grossUsdMicros")!.match;
    if (grossOff)
      explain.push(
        "Gross revenue differs, which comes straight from onchain settlements: either this node's settlement index is incomplete, or the score was signed from different data. Re-run the backfill over that range and compare again.",
      );
    else
      explain.push(
        "Gross revenue matches, so the settlements agree. The difference comes from enrichment: who funded each payer (traced from public transfers), Self proofs or ERC-8004 registrations. A node that traced an address at a different time, or before a registration, can differ here.",
      );
  }
  return { ...base, outcome: ok ? "verified" : "differs", fields, explain };
}
