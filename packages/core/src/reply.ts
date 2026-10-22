import { checkHttpsUrl } from "./claim.js";
import type { Address } from "./types.js";

/**
 * A seller's right of reply. The wallet's owner signs a short response to one finding; it is
 * shown under that finding as the seller's own words, dated, and never changes a score. The same
 * owner can also sign for free alerts on its own address. Messages are built here on both sides.
 */
export const FLAG_CODES = [
  "CIRCULAR_FLOW",
  "CONCENTRATED_REVENUE",
  "DORMANT",
  "ERC8004_AGENT",
  "ESTABLISHED_PAYERS",
  "HUMAN_BACKED",
  "PARTIAL_FUNDING_DATA",
  "SAME_HUMAN_PAYERS",
  "SELLER_FUNDED_PAYERS",
  "SHARED_FUNDER",
  "SINGLE_PURPOSE_PAYERS",
  "THIN_FILE",
] as const;
export type FindingCode = (typeof FLAG_CODES)[number];

export const RESPONSE_LIMITS = { min: 10, max: 500 } as const;

export interface ResponseFields {
  address: Address;
  code: FindingCode;
  action: "respond" | "withdraw";
  text: string;
  issuedAt: number;
  nonce: string;
}

export function responseMessage(f: ResponseFields): string {
  return [
    "Assay finding response",
    `address: ${f.address.toLowerCase()}`,
    `finding: ${f.code}`,
    `action: ${f.action}`,
    `text: ${f.text}`,
    `issued: ${f.issuedAt}`,
    `nonce: ${f.nonce}`,
    "",
    "Signing this proves you control the wallet. It moves no funds.",
  ].join("\n");
}

/** Plain text only: spaces collapsed, line breaks kept, control characters and tags refused. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

export function validateResponse(
  input: Partial<ResponseFields>,
): { ok: true; fields: ResponseFields } | { ok: false; error: string } {
  const address = String(input.address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return { ok: false, error: "Expected a Celo address." };
  const code = String(input.code ?? "");
  if (!(FLAG_CODES as readonly string[]).includes(code)) return { ok: false, error: "Unknown finding." };
  const action = input.action === "withdraw" ? "withdraw" : "respond";
  const text = action === "respond" ? cleanText(String(input.text ?? "")) : "";
  const issuedAt = Number(input.issuedAt);
  const nonce = String(input.nonce ?? "");
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return { ok: false, error: "Missing issue time." };
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) return { ok: false, error: "Missing nonce." };
  if (action === "respond") {
    if (text.length < RESPONSE_LIMITS.min)
      return { ok: false, error: `Say a little more: at least ${RESPONSE_LIMITS.min} characters.` };
    if (text.length > RESPONSE_LIMITS.max)
      return { ok: false, error: `At most ${RESPONSE_LIMITS.max} characters.` };
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return { ok: false, error: "Plain text only." };
    if (/[<>]/.test(text)) return { ok: false, error: "Plain text only, no angle brackets." };
  }
  return {
    ok: true,
    fields: { address: address as Address, code: code as FindingCode, action, text, issuedAt, nonce },
  };
}

export interface OwnWatchFields {
  address: Address;
  url: string;
  issuedAt: number;
  nonce: string;
}

export function ownWatchMessage(f: OwnWatchFields): string {
  return [
    "Assay alerts for my address",
    `address: ${f.address.toLowerCase()}`,
    `url: ${f.url}`,
    `issued: ${f.issuedAt}`,
    `nonce: ${f.nonce}`,
    "",
    "Signing this proves you control the wallet. It moves no funds.",
  ].join("\n");
}

export function validateOwnWatch(
  input: Partial<OwnWatchFields>,
): { ok: true; fields: OwnWatchFields } | { ok: false; error: string } {
  const address = String(input.address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return { ok: false, error: "Expected a Celo address." };
  const url = String(input.url ?? "").trim();
  const bad = checkHttpsUrl(url, 500);
  if (bad) return { ok: false, error: `Webhook URL ${bad}` };
  const issuedAt = Number(input.issuedAt);
  const nonce = String(input.nonce ?? "");
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return { ok: false, error: "Missing issue time." };
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) return { ok: false, error: "Missing nonce." };
  return { ok: true, fields: { address: address as Address, url, issuedAt, nonce } };
}
