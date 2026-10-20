#!/usr/bin/env node
// Uptime check for a deployed Assay: the API answers, the indexer keeps up, paid routes still ask
// for payment, and the site renders. Exits 1 with a report on stdout when anything is wrong.
//   API_URL=https://… WEB_URL=https://… node scripts/uptime.mjs

const API = (process.env.API_URL ?? "https://api-production-63cc.up.railway.app").replace(/\/+$/, "");
const WEB = (process.env.WEB_URL ?? "https://assay-amber.vercel.app").replace(/\/+$/, "");
// Celo makes a block a second; half an hour behind means the indexer is stuck, not just busy.
const MAX_LAG_BLOCKS = Number(process.env.MAX_LAG_BLOCKS ?? 1800);
const PROBE = "0x5df8ae2b963165b735b18ca86b1ea448d2aa032c";

async function get(url, init) {
  // One retry: a single dropped connection is not an outage.
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      return { res, ms: Date.now() - started };
    } catch (err) {
      if (attempt >= 1) throw err;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

const checks = [
  [
    "API status and indexer lag",
    async () => {
      const { res, ms } = await get(`${API}/v1/status`);
      if (res.status !== 200) throw new Error(`answered ${res.status}`);
      const s = await res.json();
      const lag = s.lagBlocks ?? (s.finalizedHead ?? 0) - (s.settlementsBlock ?? 0);
      if (!(lag <= MAX_LAG_BLOCKS))
        throw new Error(`indexer is ${lag} blocks behind (limit ${MAX_LAG_BLOCKS})`);
      if (s.payments !== true) throw new Error("payments are switched off");
      return `lag ${lag} blocks, ${ms} ms`;
    },
  ],
  [
    "Free report",
    async () => {
      const { res, ms } = await get(`${API}/v1/address/${PROBE}`);
      if (res.status !== 200) throw new Error(`answered ${res.status}`);
      const body = await res.json();
      if (!body.check?.verdict) throw new Error("no verdict in the report");
      return `${body.check.verdict} ${body.check.rating}, ${ms} ms`;
    },
  ],
  [
    "Paid check asks for payment",
    async () => {
      const { res } = await get(`${API}/v1/check/${PROBE}`);
      if (res.status !== 402) throw new Error(`answered ${res.status}, expected 402`);
      const header = res.headers.get("payment-required");
      if (!header) throw new Error("no PAYMENT-REQUIRED header");
      const accepts = JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts ?? [];
      if (accepts.length === 0) throw new Error("402 offers no way to pay");
      return `${accepts.length} payment options`;
    },
  ],
  [
    "Site renders",
    async () => {
      for (const path of ["/", "/economy", `/address/${PROBE}`]) {
        const { res } = await get(`${WEB}${path}`);
        if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
        const html = await res.text();
        if (!html.includes("Assay")) throw new Error(`${path} rendered without the Assay name`);
      }
      return "3 pages";
    },
  ],
];

let failed = 0;
const lines = [];
for (const [name, run] of checks) {
  try {
    lines.push(`- [x] ${name}: ${await run()}`);
  } catch (err) {
    failed++;
    lines.push(`- [ ] **${name}: ${err instanceof Error ? err.message : String(err)}**`);
  }
}
console.log(lines.join("\n"));
process.exit(failed > 0 ? 1 : 0);
