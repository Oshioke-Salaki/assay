import { describe, expect, it } from "vitest";
import {
  cleanText,
  FLAG_CODES,
  ownWatchMessage,
  responseMessage,
  validateOwnWatch,
  validateResponse,
} from "../src/reply.js";

const base = {
  address: `0x${"a".repeat(40)}` as `0x${string}`,
  code: "SELLER_FUNDED_PAYERS" as const,
  action: "respond" as const,
  text: "We sponsored gas for new users in March; those wallets are customers, not ours.",
  issuedAt: 1_800_000_000,
  nonce: "0123456789abcdef",
};

describe("finding responses", () => {
  it("builds one message for both sides and keeps the text in it", () => {
    const m = responseMessage(base);
    expect(m).toContain("Assay finding response");
    expect(m).toContain("finding: SELLER_FUNDED_PAYERS");
    expect(m).toContain(base.text);
    expect(m).toMatch(/moves no funds/);
  });

  it("accepts plain text, cleans whitespace and keeps paragraphs", () => {
    const r = validateResponse({ ...base, text: "  Line one.   \r\n\r\n\r\n\r\nLine   two.  " });
    expect(r).toMatchObject({ ok: true, fields: { text: "Line one.\n\nLine two." } });
    expect(cleanText("a\tb  c")).toBe("a b c");
  });

  it("refuses unknown findings, short or long text, tags and control characters", () => {
    expect(validateResponse({ ...base, code: "NOPE" as never })).toMatchObject({
      ok: false,
      error: /Unknown finding/,
    });
    expect(validateResponse({ ...base, text: "too short" })).toMatchObject({
      ok: false,
      error: /at least 10/,
    });
    expect(validateResponse({ ...base, text: "x".repeat(501) })).toMatchObject({
      ok: false,
      error: /At most 500/,
    });
    expect(validateResponse({ ...base, text: "hello <script>alert(1)</script> there" })).toMatchObject({
      ok: false,
      error: /angle/,
    });
    expect(validateResponse({ ...base, text: "hello\u0007 there friend" })).toMatchObject({
      ok: false,
      error: /Plain text/,
    });
    expect(validateResponse({ ...base, nonce: "zz" })).toMatchObject({ ok: false, error: /nonce/ });
    expect(FLAG_CODES).toContain("CIRCULAR_FLOW");
  });

  it("a withdrawal needs no text", () => {
    expect(validateResponse({ ...base, action: "withdraw", text: "" })).toMatchObject({
      ok: true,
      fields: { action: "withdraw", text: "" },
    });
  });
});

describe("own-address alerts", () => {
  it("signs the address and URL, and refuses private or non-https URLs", () => {
    const f = {
      address: base.address,
      url: "https://hooks.example/assay",
      issuedAt: 1,
      nonce: "0123456789abcdef",
    };
    expect(validateOwnWatch(f)).toMatchObject({ ok: true });
    expect(ownWatchMessage(f)).toContain("url: https://hooks.example/assay");
    expect(validateOwnWatch({ ...f, url: "http://hooks.example" })).toMatchObject({
      ok: false,
      error: /https/,
    });
    expect(validateOwnWatch({ ...f, url: "https://10.0.0.1/x" })).toMatchObject({
      ok: false,
      error: /public/,
    });
    expect(validateOwnWatch({ ...f, address: "0x1" })).toMatchObject({ ok: false, error: /address/ });
  });
});
