import { describe, expect, it } from "vitest";
import { FUNDING_NOTE, fundingRefusal, hasPaid } from "../src/lib/funding-guard.js";

describe("funding guard", () => {
  const payTo = `0x${"A".repeat(40)}`;
  it("knows when a wallet has paid Assay, whatever the case of the address", () => {
    expect(hasPaid([{ payee: `0x${"a".repeat(40)}` }], payTo)).toBe(true);
    expect(hasPaid([{ payee: `0x${"b".repeat(40)}` }], payTo)).toBe(false);
    expect(hasPaid([], payTo)).toBe(false);
  });
  it("says why, and what to do instead", () => {
    expect(fundingRefusal("0xdead")).toMatch(/has paid Assay.*seller-funded.*faucet/);
    expect(FUNDING_NOTE).toMatch(/never count as an independent customer/);
  });
});
