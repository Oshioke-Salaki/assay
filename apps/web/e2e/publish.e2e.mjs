/**
 * The real "Pay $0.01 and publish" flow in Chrome against a live deployment, with the wallet's
 * signing and sending done by a real key in Node (E2E_PRIVATE_KEY). Every failed request and
 * console error is reported, so a "Failed to fetch" names the request that failed.
 *
 *   E2E_PRIVATE_KEY=0x… BASE=https://assayscore.xyz node e2e/publish.e2e.mjs
 */
import { chromium } from "playwright-core";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";

const BASE = process.env.BASE ?? "https://assayscore.xyz";
const SUBJECT = process.env.SUBJECT ?? "0x5df8ae2b963165b735b18ca86b1ea448d2aa032c";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const key = process.env.E2E_PRIVATE_KEY;
if (!key) throw new Error("Set E2E_PRIVATE_KEY");
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: celo, transport: http("https://forno.celo.org") }).extend(
  publicActions,
);

/** Everything the page's wallet asks for, answered by the real key or forwarded to Celo RPC. */
async function handle({ method, params }) {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [account.address];
    case "eth_chainId":
      return "0xa4ec";
    case "wallet_requestPermissions":
    case "wallet_getPermissions":
      return [
        {
          parentCapability: "eth_accounts",
          caveats: [{ type: "restrictReturnedAccounts", value: [account.address] }],
        },
      ];
    case "wallet_switchEthereumChain":
      return null;
    case "eth_signTypedData_v4": {
      const typed = JSON.parse(params[1]);
      const { EIP712Domain: _drop, ...types } = typed.types;
      return account.signTypedData({
        domain: typed.domain,
        types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
    }
    case "eth_sendTransaction": {
      const tx = params[0];
      return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n });
    }
    default: {
      const res = await fetch("https://forno.celo.org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
      });
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
      return body.result;
    }
  }
}

function injected() {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    request: async (args) => {
      const r = await window.__wallet(JSON.stringify(args));
      const parsed = JSON.parse(r);
      if (parsed.error) throw Object.assign(new Error(parsed.error.message), { code: parsed.error.code });
      return parsed.result;
    },
    on: (e, f) => {
      listeners[e] = [...(listeners[e] ?? []), f];
      return provider;
    },
    removeListener: (e, f) => {
      listeners[e] = (listeners[e] ?? []).filter((g) => g !== f);
      return provider;
    },
  };
  const info = {
    uuid: crypto.randomUUID(),
    name: "MetaMask",
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    rdns: "io.metamask",
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  window.ethereum = provider;
}

// A local build talks to the production API, whose CORS list does not include localhost. LOCAL=1
// turns off the browser's same-origin checks for that run only; against the live site leave it unset.
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: process.env.LOCAL === "1" ? ["--disable-web-security"] : [],
});
const page = await browser.newPage();
const problems = [];
page.on("requestfailed", (r) =>
  problems.push(`request failed: ${r.method()} ${r.url().slice(0, 120)} (${r.failure()?.errorText})`),
);
page.on("console", (m) => {
  if (m.type() === "error" && !/_vercel\/insights/.test(m.text()))
    problems.push(`console: ${m.text().slice(0, 400)}`);
});
page.on("pageerror", (e) => problems.push(`page error: ${String(e).slice(0, 400)}`));
await page.exposeFunction("__wallet", async (raw) => {
  const args = JSON.parse(raw);
  try {
    return JSON.stringify({ result: await handle(args) });
  } catch (e) {
    problems.push(`wallet ${args.method}: ${String(e).slice(0, 200)}`);
    return JSON.stringify({ error: { message: String(e?.message ?? e), code: e?.code ?? -32603 } });
  }
});
await page.addInitScript(injected);
await page.goto(`${BASE}/address/${SUBJECT}`, { waitUntil: "networkidle" });
const section = page.locator("#publish");
await section.scrollIntoViewIfNeeded();
const pay = section.getByRole("button", { name: "Pay $0.01 and publish" });
const connectBtn = section.getByRole("button", { name: /Connect MetaMask/ });
// A wallet that already authorised the site reconnects on load; otherwise connect first.
await Promise.race([pay.waitFor({ timeout: 15000 }), connectBtn.waitFor({ timeout: 15000 })]);
if (await connectBtn.isVisible()) await connectBtn.click();
await pay.click();
const status = section.locator('[role="status"]');
let last = "";
for (let i = 0; i < 90; i++) {
  last = (await status.innerText()).trim();
  if (/Published|cancelled|said|not |Only|Nothing|reverted|cannot|holds less/i.test(last)) break;
  await page.waitForTimeout(1000);
}
console.log(`status: ${last}`);
for (const p of problems) console.log(p);
await browser.close();
process.exit(/Published/.test(last) ? 0 : 1);
