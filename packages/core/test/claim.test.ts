import { describe, expect, it } from "vitest";
import { checkHttpsUrl, claimMessage, isPrivateHost, isPrivateIp, validateClaim } from "../src/claim.js";

const base = {
  address: `0x${"a".repeat(40)}` as `0x${string}`,
  action: "claim" as const,
  name: "Cyanos Translate",
  url: "https://cyanos.example",
  x: "cyanos",
  logoUrl: "https://cyanos.example/logo.png",
  what: "Real-time translation API",
  category: "ai" as const,
  issuedAt: 1_800_000_000,
  nonce: "0123456789abcdef",
};

describe("claim message", () => {
  it("is the same text on both sides and says it moves no funds", () => {
    const m = claimMessage(base);
    expect(m).toContain("Assay page claim");
    expect(m).toContain(`address: 0x${"a".repeat(40)}`);
    expect(m).toContain("name: Cyanos Translate");
    expect(m).toMatch(/moves no funds/);
    expect(claimMessage({ ...base, address: `0x${"A".repeat(40)}` as never })).toBe(m);
  });
});

describe("validateClaim", () => {
  it("accepts a sensible claim, trims and drops the @", () => {
    const r = validateClaim({ ...base, name: "  Cyanos   Translate ", x: "@cyanos" });
    expect(r).toMatchObject({ ok: true, fields: { name: "Cyanos Translate", x: "cyanos" } });
  });

  it("refuses names that would read as someone else's", () => {
    for (const name of ["Celo Foundation", "Assay Official", "USDC Treasury", "tether"]) {
      const r = validateClaim({ ...base, name });
      expect(r.ok, name).toBe(false);
    }
  });

  it("refuses bad names, links and handles with a reason a person can act on", () => {
    expect(validateClaim({ ...base, name: "A" })).toMatchObject({ ok: false, error: /2 to 40/ });
    expect(validateClaim({ ...base, name: "x".repeat(41) })).toMatchObject({ ok: false });
    expect(validateClaim({ ...base, name: "<script>" })).toMatchObject({
      ok: false,
      error: /letters, numbers/,
    });
    expect(validateClaim({ ...base, url: "http://cyanos.example" })).toMatchObject({
      ok: false,
      error: /https/,
    });
    expect(validateClaim({ ...base, url: "https://localhost:3000" })).toMatchObject({
      ok: false,
      error: /public/,
    });
    expect(validateClaim({ ...base, url: "https://user:pw@cyanos.example" })).toMatchObject({
      ok: false,
      error: /password/,
    });
    expect(validateClaim({ ...base, logoUrl: "https://cyanos.example/logo.exe" })).toMatchObject({
      ok: false,
      error: /PNG/,
    });
    expect(validateClaim({ ...base, x: "has space" })).toMatchObject({ ok: false, error: /X handle/ });
    expect(validateClaim({ ...base, nonce: "short" })).toMatchObject({ ok: false, error: /nonce/ });
    expect(validateClaim({ ...base, address: "0x12" })).toMatchObject({ ok: false, error: /address/ });
  });

  it("checks what you sell and the category", () => {
    expect(validateClaim({ ...base, what: "x".repeat(81) })).toMatchObject({ ok: false, error: /80/ });
    expect(validateClaim({ ...base, what: "<b>hi</b>" })).toMatchObject({ ok: false, error: /angle/ });
    expect(validateClaim({ ...base, category: "weapons" as never })).toMatchObject({
      ok: false,
      error: /Category/,
    });
    expect(validateClaim({ ...base, category: "AI" as never })).toMatchObject({
      ok: true,
      fields: { category: "ai" },
    });
    expect(validateClaim({ ...base, what: "", category: "" }).ok).toBe(true);
    expect(claimMessage(base)).toContain("what: Real-time translation API");
  });

  it("a release needs no name", () => {
    const r = validateClaim({ ...base, action: "release", name: "" });
    expect(r).toMatchObject({
      ok: true,
      fields: { action: "release", name: "", url: "", x: "", logoUrl: "" },
    });
  });
});

describe("private hosts", () => {
  it("knows the inside of a network from the public internet", () => {
    for (const h of [
      "localhost",
      "db.internal",
      "printer.local",
      "10.0.0.5",
      "172.20.1.1",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "[::1]",
      "0.0.0.0",
      "intranet",
    ])
      expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["assayscore.xyz", "8.8.8.8", "api.example.org"]) expect(isPrivateHost(h), h).toBe(false);
    expect(isPrivateIp("::ffff:10.1.2.3")).toBe(true);
    expect(isPrivateIp("fd12::1")).toBe(true);
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
    expect(checkHttpsUrl("https://assayscore.xyz/hook", 200)).toBeNull();
    expect(checkHttpsUrl(`https://a.example/${"x".repeat(300)}`, 200)).toMatch(/at most/);
  });
});
