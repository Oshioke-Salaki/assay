import { isAddress } from "assayscore-core";
import { z } from "zod";

const address = z
  .string()
  .refine((v) => isAddress(v), "must be a 0x address")
  .transform((v) => v.toLowerCase() as `0x${string}`);

const privateKey = z
  .string()
  .transform((v) => (v.startsWith("0x") ? v : `0x${v}`))
  .refine((v) => /^0x[0-9a-fA-F]{64}$/.test(v), "must be a 32-byte hex private key")
  .transform((v) => v as `0x${string}`);

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  /** "all" runs the API and the indexer in one process. */
  ROLE: z.enum(["all", "api", "indexer"]).default("all"),
  DATABASE_PATH: z.string().default("./data/assay.db"),
  PUBLIC_URL: z.string().url().default("http://localhost:8787"),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  SQD_URL: z.string().url().default("https://portal.sqd.dev/datasets/celo-mainnet"),
  RPC_URL: z.string().url().default("https://forno.celo.org"),
  BLOCKSCOUT_URL: z.string().url().default("https://celo.blockscout.com"),
  BLOCKSCOUT_RPS: z.coerce.number().positive().max(50).default(2),
  FX_URL: z.string().url().default("https://open.er-api.com/v6/latest/USD"),
  IPFS_GATEWAY: z.string().url().default("https://ipfs.io/ipfs/"),
  /** Start a fresh database at this block instead of the beginning of x402 on Celo. Ignored once a cursor exists. */
  INDEX_FROM_BLOCK: optional(z.coerce.number().int().positive()),
  /** Stop backfilling at this block (tests and dry runs). */
  INDEX_TO_BLOCK: optional(z.coerce.number().int().positive()),
  INDEX_POLL_MS: z.coerce.number().int().min(1_000).default(15_000),

  /** x402 selling. Paid routes answer 503 until both are set. */
  X402_API_KEY: optional(z.string().min(8)),
  X402_FACILITATOR_URL: z.string().url().default("https://api.x402.celo.org"),
  PAY_TO: optional(address),

  /** Signs score attestations. Leave unset to serve unsigned reports. */
  ATTESTER_PRIVATE_KEY: optional(privateKey),
  /** AssayRegistry address, the EIP-712 verifying contract. */
  REGISTRY_ADDRESS: optional(address),

  /**
   * Pay for Chainstack's Celo RPC through the buy gateway (x402, $0.01 per batch of up to
   * 2000 calls) for the enrichment reads that the free public RPC throttles. Unset: forno.
   */
  BUY_PAYER_KEY: optional(privateKey),
  BUY_DAILY_CAP_USD: z.coerce.number().min(0).max(100).default(1),
  /** X searches through buy: what the public says about each seller. Off when 0. */
  X_MENTIONS_DAILY_CAP_USD: z.coerce.number().min(0).max(100).default(0.5),
  X_MENTIONS_MIN_GROSS_USD: z.coerce.number().min(0).default(1),
  BUY_X_SEARCH_URL: z.string().url().default("https://gateway.usebuy.ai/v1/social/x/posts/search"),
  /** Where the buy gateway is paid; the ledger is reconciled against transfers to it. */
  BUY_GATEWAY_PAY_TO: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((s) => s.toLowerCase() as `0x${string}`)
    .default("0x20faaca5f980e29639a0fcc6dca6988e18ed333b"),

  /** Assay's own ERC-8004 agent id, once registered. */
  AGENT_ID: optional(z.string().regex(/^\d+$/)),
  FREE_RATE_PER_MIN: z.coerce.number().int().positive().default(60),
  /**
   * Shared secret the web app sends from its servers. All of its traffic leaves from a few
   * Vercel IPs, so without this the per-IP limit would throttle every visitor at once.
   */
  INTERNAL_API_KEY: optional(z.string().min(24)),
  /** Opens GET /v1/admin to whoever sends it as a bearer token. Unset: the admin view does not exist. */
  ADMIN_KEY: optional(z.string().min(24)),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
