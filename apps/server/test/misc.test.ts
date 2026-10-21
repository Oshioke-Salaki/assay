import { type Assessment, ATTESTATION_TYPES, assess, Ledger } from "assayscore-core";
import { recoverTypedDataAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scaleValue } from "../src/analysis.js";
import { Attester } from "../src/attest.js";
import { parseRegistration } from "../src/enrich/agents.js";
import { FxRates } from "../src/enrich/fx.js";
import { loadEnv } from "../src/env.js";
import { fetchUntrusted, isPrivateIp } from "../src/lib/http.js";
import { memoryDb } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("isPrivateIp", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true],
    ["2606:4700:4700::1111", false],
  ])("%s → %s", (ip, expected) => expect(isPrivateIp(ip)).toBe(expected));
});

describe("fetchUntrusted", () => {
  it("refuses non-https, credentials and private hosts", async () => {
    await expect(fetchUntrusted("http://example.com")).rejects.toThrow(/https/);
    await expect(fetchUntrusted("https://user:pw@example.com")).rejects.toThrow(/credentials/);
    await expect(fetchUntrusted("https://127.0.0.1/x")).rejects.toThrow(/private/);
    await expect(fetchUntrusted("https://[::1]/x")).rejects.toThrow(/private/);
  });
});

describe("FxRates", () => {
  it("falls back, then uses the nearest earlier stored day", async () => {
    const db = memoryDb();
    const fx = new FxRates(db);
    expect(fx.rate("USD", 1)).toBe(1);
    expect(fx.rate("ARS", 20_000)).toBeGreaterThan(100);
    db.prepare("INSERT INTO fx (fiat, day, rate) VALUES ('ARS', 100, 1000), ('ARS', 110, 1100)").run();
    fx.reload();
    expect(fx.rate("ARS", 100)).toBe(1000);
    expect(fx.rate("ARS", 105)).toBe(1000);
    expect(fx.rate("ARS", 200)).toBe(1100);
    expect(fx.rate("ARS", 50)).toBe(1000);
  });

  it("stores fetched rates and survives a failing source", async () => {
    const db = memoryDb();
    const fx = new FxRates(db);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    expect(await fx.refresh("https://fx.example")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ result: "success", rates: { ARS: 1500, BRL: -1, COP: "x" } })),
      ),
    );
    expect(await fx.refresh("https://fx.example", 86_400_000 * 20_000)).toBe(true);
    expect(fx.rate("ARS", 20_000)).toBe(1500);
    // Invalid rates are ignored, so BRL keeps its fallback.
    expect(fx.rate("BRL", 20_000)).toBeCloseTo(5.05);
  });
});

describe("Attester", () => {
  it("produces a signature that recovers to the attester", async () => {
    const attester = new Attester(`0x${"22".repeat(32)}`, `0x${"9".repeat(40)}`);
    const a: Assessment = assess(new Ledger([]), `0x${"4".repeat(40)}`, {
      funding: new Map(),
      humans: new Map(),
      agentIds: new Map(),
      now: 1,
    });
    const signed = await attester.sign(a, 123, 1_000);
    expect(signed.message.expiresAt).toBe(String(1_000 + 7 * 86_400));
    const recovered = await recoverTypedDataAddress({
      domain: signed.domain,
      types: ATTESTATION_TYPES,
      primaryType: "Score",
      message: {
        ...signed.message,
        organicUsdMicros: BigInt(signed.message.organicUsdMicros!),
        grossUsdMicros: BigInt(signed.message.grossUsdMicros!),
        asOfBlock: BigInt(signed.message.asOfBlock!),
        issuedAt: BigInt(signed.message.issuedAt!),
        expiresAt: BigInt(signed.message.expiresAt!),
      } as never,
      signature: signed.signature,
    });
    expect(recovered.toLowerCase()).toBe(attester.address);
  });
});

describe("parseRegistration", () => {
  it("keeps safe display fields only", () => {
    const card = parseRegistration(
      JSON.stringify({
        name: "Bot\u0000 One",
        description: "x".repeat(2_000),
        image: "javascript:alert(1)",
        x402Support: true,
      }),
    );
    expect(card.name).toBe("Bot  One");
    expect(card.description?.length).toBe(600);
    expect(card.image).toBeNull();
    expect(card.x402).toBe(true);
    expect(() => parseRegistration("not json")).toThrow();
  });
});

describe("scaleValue", () => {
  it("applies fixed-point decimals and guards odd input", () => {
    expect(scaleValue("8750", 2)).toBe(87.5);
    expect(scaleValue("-3", 0)).toBe(-3);
    expect(scaleValue("abc", 0)).toBe(0);
    expect(scaleValue("1", 99)).toBe(1e-18);
  });
});

describe("loadEnv", () => {
  it("normalises addresses and keys, and treats blanks as unset", () => {
    const env = loadEnv({
      PAY_TO: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ATTESTER_PRIVATE_KEY: "11".repeat(32),
      X402_API_KEY: "  ",
    });
    expect(env.PAY_TO).toBe(`0x${"a".repeat(40)}`);
    expect(env.ATTESTER_PRIVATE_KEY).toBe(`0x${"11".repeat(32)}`);
    expect(env.X402_API_KEY).toBeUndefined();
  });

  it("explains every invalid variable", () => {
    expect(() => loadEnv({ PORT: "0", PAY_TO: "nope" })).toThrow(/PORT[\s\S]*PAY_TO/);
  });
});
