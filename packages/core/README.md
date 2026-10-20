# @assay/core

The scoring engine behind [Assay](https://assay-amber.vercel.app), the credit bureau for x402 payments on Celo: settlement types, payment-loop detection (Tarjan strongly connected components, net of each loop), funding traces, payer diversity, ratings from AAA to D, the pre-payment verdict, and the EIP-712 attestation format that AssayRegistry verifies.

Most agents want [`@assay/sdk`](https://www.npmjs.com/package/@assay/sdk) instead. Use this package to run the same assessment on your own ledger, or to verify an Assay attestation offline.

```ts
import { verdictFor, RATING_CODES, TOKENS } from "@assay/core";
```

Methodology: https://github.com/Oshioke-Salaki/assay/blob/main/docs/METHODOLOGY.md

MIT
