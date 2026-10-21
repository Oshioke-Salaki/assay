// Compare Celo RPC endpoints on the calls Assay makes: correctness first (same chain, same
// finality, same logs by content hash, same archive state), then latency, range limits, a
// sustained 20 req/s and a burst. Dependency-free, so it runs anywhere Node 22 does, including
// on the Fly machine where production latency is what counts:
//
//   fly ssh console -a assayscore-api -q -C "node --input-type=module -" < scripts/rpc-bench.mjs
//   node scripts/rpc-bench.mjs            # locally, reading apps/server/.chainstack
//
// The private endpoint comes from RPC_URL (set on Fly) or apps/server/.chainstack and is
// never printed: every line passes through red().
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SECRET = (() => {
  if (process.env.RPC_URL && !process.env.RPC_URL.includes("forno.celo.org"))
    return process.env.RPC_URL.trim();
  try {
    return readFileSync(new URL("../apps/server/.chainstack", import.meta.url), "utf8").trim();
  } catch {
    console.error("Set RPC_URL or save the endpoint in apps/server/.chainstack.");
    process.exit(1);
  }
})();
const P = { primary: SECRET, forno: "https://forno.celo.org", ankr: "https://rpc.ankr.com/celo" };
const NAMES = Object.keys(P);
const red = (s) => String(s).split(SECRET).join("<chainstack>");

const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const EIP3009 = [
  "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
  "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
  "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
];
const PROXY = "0x402085c248eea27d92e8b30b2c58ed07f9e20001";
const REGISTRIES = [
  "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
  "0x8004baa17c55a88189ae136b182e5fda19de9b63",
];
const USDC = EIP3009[0];
const hex = (n) => `0x${n.toString(16)}`;

let id = 0;
async function rpc(name, method, params, timeout = 30_000) {
  const t = performance.now();
  try {
    const res = await fetch(P[name], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    const ms = performance.now() - t;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, ms, err: `HTTP ${res.status} non-JSON` };
    }
    if (body.error)
      return { ok: false, ms, err: red(body.error.message ?? JSON.stringify(body.error)).slice(0, 48) };
    if (!res.ok) return { ok: false, ms, err: `HTTP ${res.status}` };
    return { ok: true, ms, v: body.result };
  } catch (e) {
    return {
      ok: false,
      ms: performance.now() - t,
      err: red(e.name === "TimeoutError" ? "timeout" : (e.cause?.code ?? e.message)).slice(0, 48),
    };
  }
}

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)}ms` : "–");
const row = (label, cells) =>
  console.log(`${label.padEnd(36)}${NAMES.map((n) => String(cells[n] ?? "").padEnd(30)).join("")}`);
const digest = (logs) =>
  createHash("sha256")
    .update(
      logs
        .map((l) => `${l.transactionHash}:${l.logIndex}:${l.data}:${l.topics.join(",")}`)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 8);

console.log(
  `Run from ${process.env.FLY_REGION ? `Fly ${process.env.FLY_REGION}` : "local"} at ${new Date().toISOString()}`,
);
row("", Object.fromEntries(NAMES.map((n) => [n, n.toUpperCase()])));

// 1. Chain and heads, three interleaved rounds.
const heads = {};
const chain = {};
for (let r = 0; r < 3; r++)
  for (const n of NAMES) {
    const c = await rpc(n, "eth_chainId", []);
    if (c.ok) chain[n] = Number.parseInt(c.v, 16);
    const h = await rpc(n, "eth_blockNumber", []);
    if (h.ok) {
      heads[n] = heads[n] ?? [];
      heads[n].push(Number.parseInt(h.v, 16));
    }
  }
row("chain id (want 42220)", Object.fromEntries(NAMES.map((n) => [n, chain[n] ?? "FAILED"])));
const best = Math.max(...Object.values(heads).flat());

// 2. Latest, safe and finalized: the indexer only reads up to "finalized".
const tags = {};
for (const n of NAMES) {
  const parts = [];
  for (const tag of ["latest", "safe", "finalized"]) {
    const b = await rpc(n, "eth_getBlockByNumber", [tag, false]);
    parts.push(b.ok ? Number.parseInt(b.v.number, 16) : null);
  }
  tags[n] = parts;
}
row(
  "latest behind best (blocks)",
  Object.fromEntries(NAMES.map((n) => [n, tags[n][0] === null ? "–" : best - tags[n][0]])),
);
row(
  "safe: blocks behind its latest",
  Object.fromEntries(NAMES.map((n) => [n, tags[n][1] === null ? "FAILED" : tags[n][0] - tags[n][1]])),
);
row(
  "finalized: blocks behind its latest",
  Object.fromEntries(NAMES.map((n) => [n, tags[n][2] === null ? "FAILED" : tags[n][0] - tags[n][2]])),
);

// 3. Latency: eth_blockNumber, 3 rounds × 15, interleaved.
const lat = Object.fromEntries(NAMES.map((n) => [n, []]));
const latErr = Object.fromEntries(NAMES.map((n) => [n, 0]));
for (let r = 0; r < 3; r++)
  for (const n of NAMES)
    for (let i = 0; i < 15; i++) {
      const x = await rpc(n, "eth_blockNumber", []);
      if (x.ok) lat[n].push(x.ms);
      else latErr[n]++;
    }
row(
  "blockNumber ×45  p50 / p95",
  Object.fromEntries(
    NAMES.map((n) => [
      n,
      `${ms(q(lat[n], 0.5))} / ${ms(q(lat[n], 0.95))}${latErr[n] ? ` ${latErr[n]}err` : ""}`,
    ]),
  ),
);

// 4. Assay's real log queries in 2,000-block chunks at four ages; contents compared by hash.
const fin = Math.min(...NAMES.map((n) => tags[n][2]).filter((x) => x !== null));
const ages = [
  ["recent", fin - 2_100],
  ["1 month back", fin - 2_600_000],
  ["6 months back", fin - 15_600_000],
  ["12 months back", fin - 31_000_000],
];
const sampleTx = [];
for (const [filterName, filter] of [
  ["x402 AuthorizationUsed", { address: EIP3009, topics: [[AUTH_USED]] }],
  ["Permit2 proxy logs", { address: [PROXY] }],
  ["ERC-8004 registry logs", { address: REGISTRIES }],
]) {
  for (const [age, from] of ages) {
    const cells = {};
    const sums = {};
    for (const n of NAMES) {
      const x = await rpc(n, "eth_getLogs", [
        { ...filter, fromBlock: hex(from), toBlock: hex(from + 1_999) },
      ]);
      if (x.ok) {
        sums[n] = digest(x.v);
        cells[n] = `${x.v.length} logs ${ms(x.ms)}`;
        if (n === "forno" || !sampleTx.length)
          for (const l of x.v.slice(0, 5)) sampleTx.push(l.transactionHash);
      } else cells[n] = `ERR ${x.err}`;
    }
    const same = new Set(Object.values(sums)).size <= 1;
    row(`${filterName}, ${age}${same ? "" : " ≠ MISMATCH"}`, cells);
  }
}

// 5. How large a range one call can take (settlement filter).
for (const span of [5_000, 10_000, 50_000]) {
  const cells = {};
  for (const n of NAMES) {
    const x = await rpc(n, "eth_getLogs", [
      { address: EIP3009, topics: [[AUTH_USED]], fromBlock: hex(fin - span), toBlock: hex(fin - 1) },
    ]);
    cells[n] = x.ok ? `${x.v.length} logs ${ms(x.ms)}` : `ERR ${x.err}`;
  }
  row(`settlement logs, ${span / 1000}k-block range`, cells);
}

// 6. Block timestamps (the RPC fallback reads one per block with logs): 20 sequential, old blocks.
{
  const cells = {};
  for (const n of NAMES) {
    const t = [];
    let e = 0;
    for (let i = 0; i < 20; i++) {
      const x = await rpc(n, "eth_getBlockByNumber", [hex(fin - 15_600_000 + i * 997), false]);
      if (x.ok && x.v) t.push(x.ms);
      else e++;
    }
    cells[n] = `p50 ${ms(q(t, 0.5))} p95 ${ms(q(t, 0.95))}${e ? ` ${e}err` : ""}`;
  }
  row("old block headers ×20", cells);
}

// 7. Receipts (proof checks), 10 real settlement transactions.
{
  const txs = [...new Set(sampleTx)].slice(0, 10);
  const cells = {};
  for (const n of NAMES) {
    const t = [];
    let e = 0;
    for (const h of txs) {
      const x = await rpc(n, "eth_getTransactionReceipt", [h]);
      if (x.ok && x.v?.status === "0x1") t.push(x.ms);
      else e++;
    }
    cells[n] = `${t.length}/${txs.length} p50 ${ms(q(t, 0.5))}${e ? ` ${e}err` : ""}`;
  }
  row("receipts of settlements", cells);
}

// 8. Archive state 12 months back must agree.
{
  const cells = {};
  const vals = {};
  for (const n of NAMES) {
    const x = await rpc(n, "eth_call", [{ to: USDC, data: "0x18160ddd" }, hex(fin - 31_000_000)]);
    if (x.ok) vals[n] = x.v;
    cells[n] = x.ok ? `ok ${ms(x.ms)}` : `ERR ${x.err}`;
  }
  row(`archive eth_call, 12 months${new Set(Object.values(vals)).size <= 1 ? "" : " ≠ MISMATCH"}`, cells);
}

// 9. Sustained load like a busy hour: 20 requests a second for 10 seconds, mixed calls.
for (const n of NAMES) {
  const res = [];
  const start = performance.now();
  const jobs = [];
  for (let i = 0; i < 200; i++) {
    const at = start + i * 50;
    jobs.push(
      (async () => {
        await new Promise((r) => setTimeout(r, Math.max(0, at - performance.now())));
        const m = i % 3;
        res.push(
          m === 0
            ? await rpc(n, "eth_blockNumber", [])
            : m === 1
              ? await rpc(n, "eth_getBalance", [EIP3009[1], "latest"])
              : await rpc(n, "eth_getTransactionCount", [PROXY, "latest"]),
        );
      })(),
    );
  }
  await Promise.all(jobs);
  const ok = res.filter((r) => r.ok);
  const err = res.find((r) => !r.ok);
  row(n === NAMES[0] ? "sustained 20 req/s ×10s" : "", {
    [n]: `${ok.length}/200 p95 ${ms(
      q(
        ok.map((r) => r.ms),
        0.95,
      ),
    )}${err ? ` (${err.err.slice(0, 14)})` : ""}`,
  });
}

// 10. A burst of 100 at once (a cold cache refill).
{
  const cells = {};
  for (const n of NAMES) {
    const t = performance.now();
    const rs = await Promise.all(
      Array.from({ length: 100 }, () => rpc(n, "eth_getBalance", [USDC, "latest"])),
    );
    const bad = rs.filter((r) => !r.ok);
    cells[n] =
      `${100 - bad.length}/100 in ${ms(performance.now() - t)}${bad[0] ? ` (${bad[0].err.slice(0, 12)})` : ""}`;
  }
  row("burst 100 at once", cells);
}
