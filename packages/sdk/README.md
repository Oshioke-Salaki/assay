# assayscore

Check a Celo x402 seller with [Assay](https://assayscore.xyz) before your agent pays it.

Assay reads every x402 settlement on Celo, nets out payment loops and payers the seller funded itself, and rates what is left. A seller that pays itself in a circle is rated on what it really earns, not on what it moved.

```sh
npm install assayscore
```

## Guard your agent's payments

`assayGuardClient` makes your x402 client check the seller with Assay **at the moment it signs**, against the exact address and network it is about to pay. A seller Assay does not clear is never signed for. Wrap the paying fetch in `withAssayGuard` too, and a blocked seller is refused before any paid request is sent at all.

```ts
import { assayGuardClient, withAssayGuard, isAssayBlocked } from "assayscore";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const opts = { minRating: "BB" } as const;
const client = assayGuardClient(
  new x402Client().register("eip155:42220", new ExactEvmScheme(privateKeyToAccount(KEY))),
  opts,
);
const pay = withAssayGuard(fetch, wrapFetchWithPayment(fetch, client), opts);

try {
  const res = await pay("https://seller.example/api");
} catch (err) {
  if (isAssayBlocked(err)) console.log("not paid:", (err as Error).message);
}
```

Why both. `withAssayGuard` sends the request unpaid first and checks every `payTo` the seller's 402 names. The paying fetch then makes its own request and signs whatever *that* answer asks for, so a seller could show one address to the probe and another to the signer. `assayGuardClient` closes that gap: the check runs inside the client's before-signing hook, on the requirements it will sign. Use `assayGuardClient` alone if you do not want the extra unpaid request.

`withAssayGuard` throws `AssayBlockedError`. @x402/fetch re-wraps errors from the client in a plain `Error`, so test refusals with `isAssayBlocked(err)`.

Options (both functions):
- `minRating`: the lowest rating to pay. Default: only `block` verdicts stop a payment.
- `allowUnrated` (default `true`): pay sellers with too little history to rate. New sellers have to start somewhere.
- `onAssayError` (`"allow"` or `"block"`, default `"allow"`): what to do when Assay cannot give a valid answer. That covers an unreachable Assay, an error, a malformed or unknown verdict, an answer about another address, or a 402 with no readable `payTo`. Use `"block"` for a hard gate.
- `otherNetworks` (`assayGuardClient` only, default `"block"`): payments on networks other than Celo mainnet, which Assay does not rate.
- `cacheMs` (default 10 minutes) and `maxCached` (default 5000).
- `onDecision`: a callback for logs. Errors it throws are ignored.
- `baseUrl` (default: the public Assay API).

The guard uses Assay's free endpoint, so it costs nothing.

## Read reports

```ts
import { createAssay } from "assayscore";

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

// $0.01: the same check plus an X search bought now for you. `x.posts` lists every post
// naming the address; `x.reused` is true when a search from the last 15 minutes served it.
const fresh = await assay.check(seller, { freshX: true });
```

If Assay cannot buy the search (daily budget spent, gateway down), `check` throws an `AssayError` with status 502 or 503 and the x402 payment is not settled.

Assay prices in USD₮ first, then USDC and USA₮, and also accepts Ripio's wARS, wBRL and wCOP at the day's exchange rate, gaslessly through Permit2. x402's default selector takes the server's first option whatever your wallet holds, so tell the client which token to pay in:

```ts
import { preferAssets, CELO_PAY_TOKENS } from "assayscore";

const client = new x402Client(preferAssets("USDC", "USDT")); // pays USDC if offered, else USD₮
```

The client pays only the dollars unless allowed otherwise. To pay in a wFIAT token, allow it too:

```ts
const client = new x402Client(preferAssets("wARS")).register(/* … */);
client.setSpendControls({
  allowedAssets: [{ network: "eip155:42220", asset: CELO_PAY_TOKENS.wARS }],
});
```

## Payer checks, for sellers

```ts
// Free: before a refund, an allowance or credit, is this payer a real wallet or a sock?
const p = await assay.payer(payer, { seller: me }); // p.verdict: established | new | caution | block, p.reasons
```

## Sellers directory and rating plans

```ts
// Free: reliable sellers, searchable; claimed sellers carry their name and what they sell.
const { rows } = await assay.sellers({ q: "weather", minRating: "BB", claimedOnly: true });

// Free: what would raise an address's rating, from the real score formula.
const plan = await assay.plan(seller); // plan.next, plan.customers.forNext, plan.levers, plan.struckOut
```

## Alerts, independent payers and badges

```ts
// $0.05 for thirty days of signed webhooks when the rating or verdict moves. Keep the secret.
const { id, secret } = await assay.watch(seller, "https://your.app/assay-webhook");

// Free: which payers count as independent users by the hackathon's rule, with reasons.
const { totals, rows } = await assay.independent(seller);

assay.badgeUrl(seller); // SVG for a README
```

## Links

- API reference: https://github.com/Oshioke-Salaki/assay/blob/main/docs/API.md
- How scores are made: https://github.com/Oshioke-Salaki/assay/blob/main/docs/METHODOLOGY.md
- MCP server: [`assayscore-mcp`](https://www.npmjs.com/package/assayscore-mcp)

MIT
