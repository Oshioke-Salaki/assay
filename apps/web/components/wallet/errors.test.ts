import { describe, expect, it } from "vitest";
import { AssayNotice, walletErrorMessage } from "./useWallet";

describe("walletErrorMessage", () => {
  it("shows Assay's own notices as written", () => {
    expect(walletErrorMessage(new AssayNotice("This wallet cannot cover $0.01."))).toBe(
      "This wallet cannot cover $0.01.",
    );
  });
  it("says cancelled only for a real rejection", () => {
    expect(walletErrorMessage({ code: 4001, message: "User rejected the request." })).toBe(
      "You cancelled it in your wallet.",
    );
  });
  it("attributes anything else to the wallet", () => {
    expect(walletErrorMessage(new Error("execution reverted"))).toBe("Your wallet said: execution reverted");
  });
});
