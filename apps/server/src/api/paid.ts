import { CAIP2_CELO, TOKENS } from "@assay/core";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env.js";

/** USD prices in micro-dollars. Every accepted token has 6 decimals, so micros are raw units. */
export const PRICES = {
  check: 2_000n, // $0.002
  attest: 10_000n, // $0.01
} as const;

/** EIP-712 domains of the dollar tokens the Celo facilitator settles with EIP-3009. */
const DOMAINS: Record<string, { name: string; version: string }> = {
  USDC: { name: "USDC", version: "2" },
  USDT: { name: "Tether USD", version: "1" },
  USAT: { name: "Tether America USD", version: "1" },
};

const DOLLAR_TOKENS = TOKENS.filter((t) => t.transfer === "eip3009" && t.decimals === 6);

export const PAID_ROUTES = ["/v1/check/:address", "/v1/attest/:address"] as const;

function accepts(payTo: `0x${string}`, micros: bigint) {
  // USA₮ first: it is the token the hackathon's x402 track is about, and the one US-facing agents hold.
  const order = ["USAT", "USDC", "USDT"];
  return [...DOLLAR_TOKENS]
    .sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol))
    .map((t) => ({
      scheme: "exact" as const,
      network: CAIP2_CELO as `${string}:${string}`,
      payTo,
      price: { amount: micros.toString(), asset: t.address, extra: DOMAINS[t.symbol]! },
      maxTimeoutSeconds: 120,
    }));
}

const addressParam = {
  pathParams: { address: "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48" },
  pathParamsSchema: {
    type: "object",
    properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
    required: ["address"],
  },
};

export function routesConfig(payTo: `0x${string}`) {
  return {
    "GET /v1/check/:address": {
      accepts: accepts(payTo, PRICES.check),
      description:
        "Assay pre-payment check for a Celo x402 seller: pass, caution or block, with the rating, organic revenue share and a signed EIP-712 score.",
      mimeType: "application/json",
      extensions: declareDiscoveryExtension({
        ...addressParam,
        output: {
          example: {
            address: "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48",
            verdict: "pass",
            rating: "A",
            score: 74,
            organicShare: 0.93,
            reasons: ["Rated A"],
          },
        },
      }),
    },
    "GET /v1/attest/:address": {
      accepts: accepts(payTo, PRICES.attest),
      description:
        "Full Assay credit report for any Celo address: organic vs circular x402 revenue, payer graph, funding analysis, Self and ERC-8004 identity, plus a signed score that AssayRegistry verifies onchain.",
      mimeType: "application/json",
      extensions: declareDiscoveryExtension({
        ...addressParam,
        output: { example: { rating: "A", score: 74 } },
      }),
    },
  };
}

/**
 * x402 middleware for the paid routes. When selling is not configured, the paid
 * routes answer 503 with a clear reason instead of silently giving data away.
 */
export function paidMiddleware(env: Env, opts: { syncOnStart?: boolean } = {}): MiddlewareHandler {
  if (!env.X402_API_KEY || !env.PAY_TO) {
    return async (c, next) => {
      if (/^\/v1\/(check|attest)\//.test(c.req.path)) {
        return c.json(
          {
            error: "payments_not_configured",
            message: "This Assay instance does not sell paid reports yet.",
          },
          503,
        );
      }
      await next();
    };
  }
  const key = env.X402_API_KEY;
  const facilitator = new HTTPFacilitatorClient({
    url: env.X402_FACILITATOR_URL,
    createAuthHeaders: async () => {
      const h = { "X-API-Key": key };
      return { verify: h, settle: h, supported: h };
    },
  });
  const server = new x402ResourceServer(facilitator)
    .register(CAIP2_CELO as `${string}:${string}`, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  return paymentMiddleware(
    routesConfig(env.PAY_TO) as unknown as RoutesConfig,
    server,
    undefined,
    undefined,
    opts.syncOnStart ?? true,
  );
}
