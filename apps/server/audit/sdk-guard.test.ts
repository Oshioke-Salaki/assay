// biome-ignore-all lint/suspicious/noExplicitAny: Deliberately malformed boundary fixtures.
// Regression tests for the SDK findings of the audit of 7 Nov 2026 (REPORT.txt, F01 and F10), with
// the real x402 client and real local EIP-3009 signing. Kept outside test/ because they import the
// SDK's source, which the server's typecheck does not cover. Nothing is settled or sent.

import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { assayGuardClient, isAssayBlocked, withAssayGuard } from "../../../packages/sdk/src/index.js";

const KEY = `0x${"33".repeat(32)}` as const;
const A = `0x${"11".repeat(20)}` as const;
const B = `0x${"22".repeat(20)}` as const;
const account = privateKeyToAccount(KEY);
const clean = { address: A, verdict: "pass", rating: "A", score: 70, reasons: [] };
const blocked = { ...clean, address: B, verdict: "block", rating: "D" };

function challenge(to: string = A, network = "eip155:42220") {
  return new Response("{}", {
    status: 402,
    headers: {
      "payment-required": Buffer.from(
        JSON.stringify({
          x402Version: 2,
          resource: { url: "https://seller.test/x", description: "audit", mimeType: "application/json" },
          accepts: [
            {
              scheme: "exact",
              network,
              amount: "5000",
              asset: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
              payTo: to,
              maxTimeoutSeconds: 60,
              extra: { name: "USDC", version: "2" },
            },
          ],
        }),
      ).toString("base64"),
    },
  });
}

const assayStub = (checked: string[] = []) =>
  ({
    address: async (a: string) => {
      checked.push(a);
      return { check: a === A ? clean : blocked };
    },
  }) as any;

describe("F01: the SDK checks the address the signer actually pays", () => {
  it("assayGuardClient refuses to sign for B even when the probe showed A", async () => {
    let probes = 0;
    let signed = 0;
    const checked: string[] = [];
    const transport = async (input: any, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.headers.get("payment-signature")) {
        signed++;
        return new Response("{}");
      }
      return challenge(++probes === 1 ? A : B);
    };
    const payer = assayGuardClient(new x402Client().register("eip155:42220", new ExactEvmScheme(account)), {
      assay: assayStub(checked),
    });
    const guard = withAssayGuard(transport, wrapFetchWithPayment(transport, payer), {
      assay: assayStub(checked),
    });
    const err = await guard("https://seller.test/x").catch((e) => e);
    expect(isAssayBlocked(err)).toBe(true);
    expect(String(err.message)).toContain(`Assay blocked payment to ${B}`);
    expect(checked).toEqual([A, B]); // the probe saw A; the signer checked B, the address it would pay
    expect(signed).toBe(0);
  });

  it("assayGuardClient signs for an address Assay clears", async () => {
    let signedTo = "";
    const transport = async (input: any, init?: RequestInit) => {
      const sig = new Request(input, init).headers.get("payment-signature");
      if (sig) {
        signedTo = JSON.parse(Buffer.from(sig, "base64").toString()).accepted.payTo;
        return new Response("{}");
      }
      return challenge(A);
    };
    const payer = assayGuardClient(new x402Client().register("eip155:42220", new ExactEvmScheme(account)), {
      assay: assayStub(),
    });
    await wrapFetchWithPayment(transport, payer)("https://seller.test/x");
    expect(signedTo.toLowerCase()).toBe(A);
  });

  it("refuses networks Assay does not rate, unless allowed", async () => {
    const hooked = (opts: Record<string, unknown>) => {
      let hook: any;
      assayGuardClient({ onBeforePaymentCreation: (h: any) => (hook = h) }, { assay: assayStub(), ...opts });
      return (network: string, payTo: string) => hook({ selectedRequirements: { network, payTo } });
    };
    await expect(hooked({})("eip155:8453", A)).rejects.toThrow(/Celo mainnet only/);
    await expect(hooked({ otherNetworks: "allow" })("eip155:8453", A)).resolves.toBeUndefined();
    await expect(hooked({ onAssayError: "block" })("eip155:42220", "not-an-address")).rejects.toThrow(
      /no payTo/,
    );
  });
});

describe("F10: malformed Assay answers never count as a pass", () => {
  for (const check of [
    { verdict: "BLOCK", rating: "bogus", reasons: [] },
    null,
    { verdict: "pass", rating: "A", address: B },
  ]) {
    it(`blocks on ${JSON.stringify(check)} when told to fail closed`, async () => {
      let paid = false;
      const guarded = withAssayGuard(
        async () => challenge(A),
        async () => {
          paid = true;
          return new Response("{}");
        },
        { minRating: "BBB", onAssayError: "block", assay: { address: async () => ({ check }) } as any },
      );
      await expect(guarded("https://seller.test/x")).rejects.toThrow(/no valid verdict/);
      expect(paid).toBe(false);
    });
  }

  it("a 402 with no readable payTo is not paid when told to fail closed", async () => {
    let paid = false;
    const guarded = withAssayGuard(
      async () => new Response("{}", { status: 402 }),
      async () => {
        paid = true;
        return new Response("{}");
      },
      { onAssayError: "block", assay: assayStub() },
    );
    await expect(guarded("https://seller.test/x")).rejects.toThrow(/no payTo/);
    expect(paid).toBe(false);
  });
});
