import { CAIP2_CELO, dayOf, type FiatCode, TOKENS, type TokenInfo } from "@assay/core";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import type { FxRates } from "../enrich/fx.js";
import type { Env } from "../env.js";

/** USD prices in micro-dollars: raw units for the 6-decimal dollar tokens, converted for wFIAT. */
export const PRICES = {
  check: 2_000n, // $0.002
  attest: 10_000n, // $0.01
} as const;

/**
 * EIP-712 domains of every token the Celo facilitator settles. The dollars use EIP-3009; Ripio's
 * wFIAT tokens go through the x402 Permit2 proxy, and their EIP-2612 permit lets the facilitator
 * sponsor the Permit2 approval, so a payer never needs gas.
 */
const DOMAINS: Record<string, { name: string; version: string }> = {
  USDT: { name: "Tether USD", version: "1" },
  USDC: { name: "USDC", version: "2" },
  USAT: { name: "Tether America USD", version: "1" },
  wARS: { name: "Peso Argentino", version: "1" },
  wBRL: { name: "Real Brasileño", version: "1" },
  wCOP: { name: "Peso Colombiano", version: "1" },
};

/** The order of the 402's options. USD₮ is the default: the dollar most Celo agents already hold. */
export const PAY_ORDER = ["USDT", "USDC", "USAT", "wARS", "wBRL", "wCOP"] as const;

const PAY_TOKENS = PAY_ORDER.map((s) => TOKENS.find((t) => t.symbol === s)).filter(
  (t): t is TokenInfo => t !== undefined,
);

export const PAID_ROUTES = ["/v1/check/:address", "/v1/attest/:address"] as const;

/**
 * A dollar price in a wFIAT token's raw units, rounded up to two significant figures of the fiat
 * (3.046 ARS becomes 3.1). Rounding keeps the price the same between the 402 and the paid retry
 * even as the rate moves a little, and the payer never pays less than the dollar price.
 */
export function fiatUnits(micros: bigint, fiatPerUsd: number, decimals: number): bigint {
  const fiat = (Number(micros) / 1e6) * fiatPerUsd;
  if (!(fiat > 0) || !Number.isFinite(fiat)) throw new Error(`no usable rate (${fiatPerUsd})`);
  const exp = Math.floor(Math.log10(fiat)) - 1;
  const mantissa = BigInt(Math.ceil(fiat / 10 ** exp - 1e-9));
  const shift = exp + decimals;
  return shift >= 0 ? mantissa * 10n ** BigInt(shift) : mantissa / 10n ** BigInt(-shift);
}

function accepts(payTo: `0x${string}`, micros: bigint, fx?: FxRates) {
  // Without FX rates there is no honest wFIAT price, so only the dollars are offered.
  const tokens = PAY_TOKENS.filter((t) => t.fiat === "USD" || fx);
  return tokens.map((t) => {
    const extra =
      t.transfer === "permit2"
        ? { ...DOMAINS[t.symbol]!, assetTransferMethod: "permit2" }
        : DOMAINS[t.symbol]!;
    const price =
      t.fiat === "USD"
        ? { amount: micros.toString(), asset: t.address, extra }
        : () => ({
            amount: fiatUnits(
              micros,
              fx!.rate(t.fiat as FiatCode, dayOf(Math.floor(Date.now() / 1000))),
              t.decimals,
            ).toString(),
            asset: t.address,
            extra,
          });
    return {
      scheme: "exact" as const,
      network: CAIP2_CELO as `${string}:${string}`,
      payTo,
      price,
      maxTimeoutSeconds: 120,
    };
  });
}

const addressParam = {
  pathParams: { address: "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48" },
  pathParamsSchema: {
    type: "object",
    properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
    required: ["address"],
  },
};

export function routesConfig(payTo: `0x${string}`, fx?: FxRates) {
  return {
    "GET /v1/check/:address": {
      accepts: accepts(payTo, PRICES.check, fx),
      description:
        "Assay pre-payment check for a Celo x402 seller: pass, caution or block, with the rating, organic revenue share and a signed EIP-712 score.",
      mimeType: "application/json",
      extensions: {
        ...declareEip2612GasSponsoringExtension(),
        ...declareDiscoveryExtension({
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
    },
    "GET /v1/attest/:address": {
      accepts: accepts(payTo, PRICES.attest, fx),
      description:
        "Full Assay credit report for any Celo address: organic vs circular x402 revenue, payer graph, funding analysis, Self and ERC-8004 identity, plus a signed score that AssayRegistry verifies onchain.",
      mimeType: "application/json",
      extensions: {
        ...declareEip2612GasSponsoringExtension(),
        ...declareDiscoveryExtension({ ...addressParam, output: { example: { rating: "A", score: 74 } } }),
      },
    },
  };
}

/**
 * x402 middleware for the paid routes. When selling is not configured, the paid
 * routes answer 503 with a clear reason instead of silently giving data away.
 */
export function paidMiddleware(
  env: Env,
  opts: { syncOnStart?: boolean; fx?: FxRates } = {},
): MiddlewareHandler {
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
    routesConfig(env.PAY_TO, opts.fx) as unknown as RoutesConfig,
    server,
    undefined,
    undefined,
    opts.syncOnStart ?? true,
  );
}
