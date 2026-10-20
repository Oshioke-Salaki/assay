/**
 * Wallet connection in a real browser, against the built app (BASE, default http://localhost:3000).
 * Reproduces a Brave user with MetaMask installed: two wallets announce themselves over EIP-6963 and
 * Brave Wallet also owns window.ethereum. Mock providers answer like the real ones, including a
 * genuine rejection (4001) and an internal error.
 *
 *   node e2e/wallet.e2e.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = `${BASE}/address/0x5df8ae2b963165b735b18ca86b1ea448d2aa032c`;
const ACCOUNT = "0x1111111111111111111111111111111111111111";

/** Injected before the app loads. `mode` decides how MetaMask (mock) answers eth_requestAccounts. */
function walletMocks({ mode, account }) {
  const make = (name, rdns, behaviour) => {
    const listeners = {};
    let connected = false;
    const provider = {
      [`is${name.replace(/\W/g, "")}`]: true,
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0xa4ec";
        if (method === "net_version") return "42220";
        if (method === "eth_accounts") return connected ? [account] : [];
        if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
          if (behaviour === "reject")
            throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          if (behaviour === "error")
            throw Object.assign(new Error("Internal JSON-RPC error."), { code: -32603 });
          connected = true;
          setTimeout(() => listeners.accountsChanged?.forEach((f) => f([account])), 0);
          return method === "eth_requestAccounts"
            ? [account]
            : [
                {
                  parentCapability: "eth_accounts",
                  caveats: [{ type: "restrictReturnedAccounts", value: [account] }],
                },
              ];
        }
        if (method === "wallet_getPermissions")
          return connected
            ? [
                {
                  parentCapability: "eth_accounts",
                  caveats: [{ type: "restrictReturnedAccounts", value: [account] }],
                },
              ]
            : [];
        if (method === "wallet_revokePermissions") {
          connected = false;
          return null;
        }
        throw Object.assign(new Error(`mock: ${method} not supported`), { code: 4200 });
      },
      on: (e, f) => ((listeners[e] ??= []).push(f), provider),
      removeListener: (e, f) => ((listeners[e] = (listeners[e] ?? []).filter((g) => g !== f)), provider),
    };
    const info = {
      uuid: crypto.randomUUID(),
      name,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
      rdns,
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    return provider;
  };
  make("MetaMask", "io.metamask", mode);
  window.ethereum = make("Brave Wallet", "com.brave.wallet", "ok");
}

const results = [];
async function scenario(name, mode, expect) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) =>
    errors.push(
      String(e.stack ?? e)
        .split("\n")
        .slice(0, 8)
        .join(" <- "),
    ),
  );
  page.on("console", (m) => {
    // Vercel serves its analytics script only in production; locally it is a known 404.
    if (m.type() === "error" && !/_vercel\/insights|404 \(Not Found\)/.test(m.text()))
      errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  await page.addInitScript(walletMocks, { mode, account: ACCOUNT });
  await page.goto(PAGE, { waitUntil: "networkidle" });
  const section = page.locator("#publish");
  await section.scrollIntoViewIfNeeded();
  const buttons = await section.locator("button").allInnerTexts();
  let ok = buttons.includes("Connect MetaMask") && buttons.includes("Connect Brave Wallet");
  await section.getByRole("button", { name: "Connect MetaMask" }).click();
  const outcome = expect.text
    ? await section
        .getByText(expect.text)
        .waitFor({ timeout: 8000 })
        .then(
          () => true,
          () => false,
        )
    : await section
        .getByRole("button", { name: expect.button })
        .waitFor({ timeout: 8000 })
        .then(
          () => true,
          () => false,
        );
  ok = ok && outcome && errors.length === 0;
  results.push({ name, ok, buttons, errors });
  await browser.close();
}

await scenario("two wallets offered, MetaMask connects", "ok", { button: "Pay $0.01 and publish" });
await scenario("a real rejection says cancelled", "reject", { text: "You cancelled it in your wallet." });
await scenario("any other error shows the wallet's own words", "error", { text: /Your wallet said:/ });

for (const r of results)
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${r.name}  [${r.buttons.join(" | ")}]${r.errors.length ? ` errors: ${r.errors.join("; ")}` : ""}`,
  );
process.exit(results.every((r) => r.ok) ? 0 : 1);
