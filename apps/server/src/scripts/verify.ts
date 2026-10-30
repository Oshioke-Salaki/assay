/**
 * Verify a signed Assay score against your own copy of Celo's data.
 *
 *   pnpm --filter @assay/server verify check.json        # the JSON a paid check or attest returned
 *   pnpm --filter @assay/server verify --onchain 0xAddr   # the score published in AssayRegistry
 *   add --json for machine-readable output
 *
 * It checks the signature against the attester AssayRegistry trusts, then replays the score from
 * this node's database at the block and time it was signed, and compares every field. Run a node
 * first (README, "Run it"): the replay is only as complete as your index.
 *
 * Env: DATABASE_PATH (default ./data/assay.db), RPC_URL (default forno), REGISTRY_ADDRESS (default
 * the registry named in the attestation, else Assay's mainnet registry).
 */
import { readFileSync } from "node:fs";
import { type Address, isAddress, normalizeAddress, ratingFromCode } from "assayscore-core";
import { createPublicClient, http, parseAbi } from "viem";
import { celo } from "viem/chains";
import { openDatabase } from "../db.js";
import { parseAttestation, type ScoreFields, verifyScore } from "../verify.js";

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const MAINNET_REGISTRY: Address = "0xf6679308af9ff1ffc11a968dfd1ea5882152e29f";
const REGISTRY_ABI = parseAbi([
  "function attester() view returns (address)",
  "function scoreOf(address subject) view returns ((address subject,uint8 score,uint8 rating,uint64 organicUsdMicros,uint64 grossUsdMicros,uint32 effectivePayersX100,uint64 asOfBlock,uint64 issuedAt,uint64 expiresAt) score, bool fresh)",
]);

const args = process.argv.slice(2);
const json = args.includes("--json");
const onchainAt = args.indexOf("--onchain");
const positional = args.filter((a, i) => !a.startsWith("--") && !(onchainAt >= 0 && i === onchainAt + 1));

async function main(): Promise<number> {
  const rpc = createPublicClient({
    chain: celo,
    transport: http(process.env.RPC_URL || "https://forno.celo.org"),
  });
  const db = openDatabase(process.env.DATABASE_PATH || "./data/assay.db");
  try {
    let input: Parameters<typeof verifyScore>[1];
    let fromRegistry = false;
    let registry: Address;
    if (onchainAt >= 0) {
      const raw = args[onchainAt + 1];
      if (!raw || !isAddress(raw)) throw new Error("Usage: verify --onchain 0xSubjectAddress");
      registry = (process.env.REGISTRY_ADDRESS?.toLowerCase() as Address) || MAINNET_REGISTRY;
      const [s] = await rpc.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "scoreOf",
        args: [normalizeAddress(raw)],
      });
      if (s.issuedAt === 0n)
        throw new Error(`No score is published for ${raw} in AssayRegistry ${registry}.`);
      const fields: ScoreFields = { ...s, subject: s.subject.toLowerCase() as Address };
      input = { fields, signature: null, registry };
      fromRegistry = true;
    } else {
      const file = positional[0];
      if (!file) throw new Error("Usage: verify <attestation.json> | verify --onchain 0xSubjectAddress");
      const parsed = parseAttestation(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.signature)
        throw new Error("This file has no signature. Pass the JSON a paid check or attest returned.");
      registry =
        (process.env.REGISTRY_ADDRESS?.toLowerCase() as Address) || parsed.registry || MAINNET_REGISTRY;
      input = { fields: parsed.fields, signature: parsed.signature, registry };
    }
    const expected = (
      (await rpc.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "attester" })) as string
    ).toLowerCase() as Address;
    const r = await verifyScore(db, input, { expectedSigner: expected, fromRegistry });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      const head = {
        verified: "VERIFIED: the signature is Assay's and your node computes the same score.",
        differs: "DIFFERS: the signature is valid, but your node computes something else.",
        "signature-invalid":
          "SIGNATURE INVALID: this score was not signed by the attester AssayRegistry trusts.",
        "node-behind": "CANNOT REPLAY YET: your node has not indexed up to the score's block.",
      }[r.outcome];
      console.log(head);
      console.log(
        `subject ${r.subject} · as of block ${r.asOfBlock} · signed ${new Date(r.issuedAt * 1000).toISOString()}${r.expired ? " · expired" : ""}`,
      );
      console.log(
        fromRegistry
          ? `signature: checked by AssayRegistry ${registry} when it was published (attester ${expected})`
          : `signature: recovered ${r.signature.recovered ?? "nothing"}; registry ${registry} trusts ${expected}`,
      );
      if (r.fields.length) {
        console.log("");
        for (const f of r.fields) {
          const show = (v: string) => (f.field === "rating" ? v : v);
          console.log(
            `${f.match ? "  ok  " : "  DIFF"} ${f.field.padEnd(20)} signed ${show(f.signed).padStart(14)}   yours ${show(f.recomputed).padStart(14)}`,
          );
        }
      }
      for (const e of r.explain) console.log(`\n${e}`);
      if (r.outcome === "verified")
        console.log(
          `\nRating ${ratingFromCode(input.fields.rating)}, score ${input.fields.score}: reproduced from your own data.`,
        );
    }
    return r.outcome === "verified" ? 0 : 1;
  } finally {
    db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
