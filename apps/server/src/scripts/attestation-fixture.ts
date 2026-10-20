/**
 * Writes contracts/test/fixtures/attestation.json: a score signed by the production
 * Attester, which the Foundry suite verifies against AssayRegistry. If the TypeScript
 * and Solidity EIP-712 encodings ever drift apart, `forge test` fails.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Assessment, assess, Ledger } from "@assay/core";
import { Attester } from "../attest.js";

const KEY = `0x${"a1".repeat(32)}` as const;
const REGISTRY = "0x000000000000000000000000000000000000a55a" as const;
const SUBJECT = "0x5555555555555555555555555555555555555555" as const;

const flows = Array.from({ length: 12 }, (_, i) => ({
  payer: `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`,
  payee: SUBJECT,
  count: 6,
  usd: 1.25,
  firstTs: 1_790_000_000 + i * 86_400,
  lastTs: 1_790_000_000 + (i + 6) * 86_400,
  days: [0, 1, 2, 3, 4, 5].map((d) => 20_717 + i + d),
  sampleTxs: [],
}));
const a: Assessment = assess(new Ledger(flows), SUBJECT, {
  funding: new Map(),
  humans: new Map(),
  agentIds: new Map(),
  now: 1_791_500_000,
});
const signed = await new Attester(KEY, REGISTRY).sign(a, 80_000_000, 1_791_500_000);
const out = fileURLToPath(new URL("../../../../contracts/test/fixtures/attestation.json", import.meta.url));
writeFileSync(
  out,
  `${JSON.stringify({ registry: REGISTRY, signer: signed.signer, ...signed.message, signature: signed.signature }, null, 2)}\n`,
);
console.log("wrote", out, signed.message);
