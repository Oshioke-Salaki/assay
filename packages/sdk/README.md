# @assay/sdk

Check a Celo x402 seller with [Assay](https://assayscore.xyz) before your agent pays it.

Assay reads every x402 settlement on Celo, nets out payment loops and payers the seller funded itself, and rates what is left. A seller that pays itself in a circle is rated on what it really earns, not on what it moved.

```sh
npm install @assay/sdk
```

## Guard your agent's payments

`withAssayGuard` wraps any x402-paying fetch. The first request goes out unpaid; if the seller answers 402, every `payTo` it names is checked with Assay, and only if all pass does the paid request go out. A blocked seller throws `AssayBlockedError` and is never paid.

```ts
import { withAssayGuard, AssayBlockedError } from "@assay/sdk";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client().register("eip155:42220", new ExactEvmScheme(privateKeyToAccount(KEY)));
const pay = withAssayGuard(fetch, wrapFetchWithPayment(fetch, client), { minRating: "BB" });

try {
  const res = await pay("https://seller.example/api");
} catch (err) {
  if (err instanceof AssayBlockedError) console.log(err.result.reasons);
}
```

Options: `minRating` (lowest rating to pay, default: only `block` verdicts stop a payment), `allowUnrated` (default `true`, new sellers have to start somewhere), `onAssayError` (`"allow"` or `"block"` when Assay is unreachable, default `"allow"`), `cacheMs` (default 10 minutes), `onDecision` (a callback for logs), `baseUrl` (default: the public Assay API).

The guard uses Assay's free endpoint, so it costs nothing.

## Read reports

```ts
import { createAssay } from "@assay/sdk";

const assay = createAssay();
const report = await assay.address("0x5df8ae2b963165b735b18ca86b1ea448d2aa032c");
report.check; // { verdict: "pass" | "caution" | "block", rating, organicShare, reasons }
await assay.economy();
await assay.agents({ q: "weather" });
```

## Paid checks with a signed score

`check` ($0.002) and `attest` ($0.01) are paid over x402 and return an EIP-712 score signed by Assay that the onchain AssayRegistry verifies. Give `createAssay` a paying fetch:

```ts
const assay = createAssay({ payingFetch: wrapFetchWithPayment(fetch, client) });
const { verdict, attestation } = await assay.check(seller);
```

Assay prices in USD₮ first, then USDC and USA₮, and also accepts Ripio's wARS, wBRL and wCOP at the day's exchange rate, gaslessly through Permit2. x402's default selector takes the server's first option whatever your wallet holds, so tell the client which token to pay in:

```ts
import { preferAssets, CELO_PAY_TOKENS } from "@assay/sdk";

const client = new x402Client(preferAssets("USDC", "USDT")); // pays USDC if offered, else USD₮
```

The client pays only the dollars unless allowed otherwise. To pay in a wFIAT token, allow it too:

```ts
const client = new x402Client(preferAssets("wARS")).register(/* … */);
client.setSpendControls({
  allowedAssets: [{ network: "eip155:42220", asset: CELO_PAY_TOKENS.wARS }],
});
```

## Links

- API reference: https://github.com/Oshioke-Salaki/assay/blob/main/docs/API.md
- How scores are made: https://github.com/Oshioke-Salaki/assay/blob/main/docs/METHODOLOGY.md
- MCP server: [`@assay/mcp`](https://www.npmjs.com/package/@assay/mcp)

MIT
