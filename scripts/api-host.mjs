#!/usr/bin/env node
// Which host serves the Assay API, and a one-command switch between Fly.io and Railway.
//
//   node scripts/api-host.mjs status
//   node scripts/api-host.mjs railway [--dry-run] [--force]
//   node scripts/api-host.mjs fly [--dry-run]
//
// Both hosts run the same image, each with its own SQLite file, and each indexes Celo on its own,
// so the one taking over is already current (or catches up within a minute of starting).
//
// Order matters. The site first moves to a URL that already has a working certificate, then the
// api.assayscore.xyz CNAME moves (the new host issues its certificate once DNS points at it), and
// only then is the old host stopped. Nothing is ever pointed at a host that is not answering.
//
// Needs: the Vercel CLI logged in (its token is read from the CLI's auth file), flyctl logged in.
// The Railway server itself needs no CLI: it keeps running until stopped in Railway.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DOMAIN = "assayscore.xyz";
const API_HOST = `api.${DOMAIN}`;
const HOSTS = {
  fly: { cname: "assayscore-api.fly.dev", direct: "https://assayscore-api.fly.dev" },
  railway: { cname: "05lpg5us.up.railway.app", direct: "https://api-production-63cc.up.railway.app" },
};
const FLY_APP = "assayscore-api";
const VERCEL_TEAM = "team_3qSS3R1Qnq6SvNgq6CMjzioV";
const VERCEL_SCOPE = "oshiokesalakis-projects";
const VERCEL_PROJECT = "assay";
const SITE_ENV = "NEXT_PUBLIC_ASSAY_API";

const [cmd, ...flags] = process.argv.slice(2);
const dry = flags.includes("--dry-run");
const force = flags.includes("--force");
const PROBE = "0x5df8ae2b963165b735b18ca86b1ea448d2aa032c";
/** Payment options the current version offers (USD₮, USDC, USA₮, wARS, wBRL, wCOP). */
const CURRENT_OPTIONS = 6;

function vercelToken() {
  const paths = [
    join(homedir(), "Library/Application Support/com.vercel.cli/auth.json"),
    join(homedir(), ".local/share/com.vercel.cli/auth.json"),
  ];
  for (const p of paths) {
    try {
      return JSON.parse(readFileSync(p, "utf8")).token;
    } catch {}
  }
  throw new Error("Vercel CLI is not logged in (run `npx vercel login`).");
}

async function vercel(path, init = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api.vercel.com${path}${sep}teamId=${VERCEL_TEAM}`, {
    ...init,
    headers: {
      authorization: `Bearer ${vercelToken()}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vercel ${path}: ${res.status} ${JSON.stringify(body.error ?? body)}`);
  return body;
}

async function healthy(url) {
  try {
    const res = await fetch(`${url}/v1/status`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, why: `status ${res.status}` };
    const s = await res.json();
    // Which version is running shows in what its 402 offers; an old build offers fewer tokens.
    let options = 0;
    try {
      const paid = await fetch(`${url}/v1/check/${PROBE}`, { signal: AbortSignal.timeout(15_000) });
      const header = paid.headers.get("payment-required");
      if (header) options = JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts?.length ?? 0;
    } catch {}
    const current = options >= CURRENT_OPTIONS;
    return {
      ok: (s.lagBlocks ?? 1e9) < 1800,
      current,
      why: `lag ${s.lagBlocks} blocks, ${options} payment options${current ? "" : " (older version)"}`,
      status: s,
    };
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}

async function apiRecords() {
  const { records } = await vercel(`/v4/domains/${DOMAIN}/records?limit=100`);
  return records.filter((r) => r.name === "api" && r.type === "CNAME");
}

async function siteApi() {
  const { envs } = await vercel(`/v9/projects/${VERCEL_PROJECT}/env?decrypt=true`);
  const env = envs.find((e) => e.key === SITE_ENV);
  return { env, value: env?.value };
}

function sh(cmd, args, opts = {}) {
  if (dry) {
    console.log(`  (dry run) ${cmd} ${args.join(" ")}`);
    return "";
  }
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function flyMachines() {
  const list = JSON.parse(
    execFileSync("fly", ["machine", "list", "--app", FLY_APP, "--json"], { encoding: "utf8" }) || "[]",
  );
  if (list.length === 0) throw new Error(`Fly app ${FLY_APP} has no machine; run \`fly deploy\` first.`);
  return list.map((m) => m.id);
}

function step(text) {
  console.log(`\n→ ${text}`);
}

async function status() {
  const [records, site, fly, railway, domain] = await Promise.all([
    apiRecords(),
    siteApi(),
    healthy(HOSTS.fly.direct),
    healthy(HOSTS.railway.direct),
    healthy(`https://${API_HOST}`),
  ]);
  const target = records.map((r) => r.value.replace(/\.$/, "")).join(", ") || "(none)";
  const serving = Object.entries(HOSTS).find(([, h]) => target === h.cname)?.[0] ?? "unknown";
  console.log(
    `${API_HOST} → ${target}  (${serving})  ${domain.ok ? "answers" : `NOT answering: ${domain.why}`}`,
  );
  console.log(`site uses   ${site.value ?? "(unset)"}`);
  console.log(`fly         ${HOSTS.fly.direct}  ${fly.ok ? "healthy" : "down"}, ${fly.why}`);
  console.log(`railway     ${HOSTS.railway.direct}  ${railway.ok ? "healthy" : "down"}, ${railway.why}`);
  return { serving, records, site };
}

async function setSiteApi(url) {
  const { env, value } = await siteApi();
  if (value === url) {
    console.log(`  site already uses ${url}`);
    return false;
  }
  if (dry) {
    console.log(`  (dry run) set ${SITE_ENV} ${value} → ${url} and redeploy the site`);
    return true;
  }
  await vercel(`/v9/projects/${VERCEL_PROJECT}/env/${env.id}`, {
    method: "PATCH",
    body: JSON.stringify({ value: url }),
  });
  // NEXT_PUBLIC_ values are built into the site, so the change needs a production build.
  console.log("  redeploying the site (about two minutes)…");
  sh("npx", ["vercel", "deploy", "--prod", "--yes", "--scope", VERCEL_SCOPE], {
    cwd: new URL("..", import.meta.url),
  });
  return true;
}

async function pointCname(to) {
  const records = await apiRecords();
  if (records.length === 1 && records[0].value.replace(/\.$/, "") === to) {
    console.log(`  ${API_HOST} already points at ${to}`);
    return;
  }
  if (dry) {
    console.log(`  (dry run) ${API_HOST}: ${records.map((r) => r.value).join(", ") || "(none)"} → ${to}`);
    return;
  }
  // Add the new record before removing the old one, so the name never stops resolving.
  await vercel(`/v2/domains/${DOMAIN}/records`, {
    method: "POST",
    body: JSON.stringify({ name: "api", type: "CNAME", value: to, ttl: 60 }),
  });
  for (const r of records) await vercel(`/v2/domains/${DOMAIN}/records/${r.id}`, { method: "DELETE" });
}

async function waitFor(what, check, minutes) {
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    const r = await check();
    if (r.ok) return r;
    process.stdout.write(`  waiting for ${what}: ${r.why}\r`);
    await new Promise((res) => setTimeout(res, 15_000));
  }
  return { ok: false, why: `still not ready after ${minutes} minutes` };
}

async function toRailway() {
  step("Checking Railway's own URL answers and is caught up");
  const rw = await healthy(HOSTS.railway.direct);
  console.log(`  ${rw.ok ? "healthy" : "NOT healthy"}: ${rw.why}`);
  if (!rw.ok && !dry) throw new Error("Railway is not healthy; nothing was changed.");
  if (!rw.current && !force && !dry)
    throw new Error(
      "Railway runs an older version of the server. Deploy the latest code there first (`railway up --service api` from the repo root), or pass --force to switch anyway. Nothing was changed.",
    );

  step("Moving the site to Railway's own URL (it already has a certificate)");
  await setSiteApi(HOSTS.railway.direct);

  step(`Pointing ${API_HOST} at Railway, for SDK and MCP users`);
  await pointCname(HOSTS.railway.cname);
  if (!dry) {
    const ok = await waitFor(
      `${API_HOST} on Railway`,
      async () => {
        const r = await healthy(`https://${API_HOST}`);
        return r.ok ? r : { ok: false, why: r.why };
      },
      30,
    );
    console.log(
      ok.ok
        ? `\n  ${API_HOST} answers from Railway`
        : `\n  ${ok.why}; the site is unaffected (it uses Railway's own URL)`,
    );
    if (!ok.ok) {
      console.log(
        "  Fly keeps running so nothing is lost. Re-run this command once Railway has issued the certificate.",
      );
      return;
    }
  }

  step("Moving the site back to the domain");
  await setSiteApi(`https://${API_HOST}`);

  step("Stopping Fly so only one server enriches from the agent wallet");
  // Stop, not destroy: the machine keeps its volume and starts again in seconds.
  for (const id of flyMachines()) sh("fly", ["machine", "stop", id, "--app", FLY_APP]);
  console.log("\nDone: Railway serves the API. `node scripts/api-host.mjs fly` switches back.");
}

async function toFly() {
  step("Starting Fly");
  for (const id of flyMachines()) sh("fly", ["machine", "start", id, "--app", FLY_APP]);
  if (!dry) {
    const ok = await waitFor("Fly to catch up", () => healthy(HOSTS.fly.direct), 15);
    if (!ok.ok) throw new Error(`Fly did not become healthy: ${ok.why}. Nothing else was changed.`);
  }

  step("Moving the site to Fly's own URL (it already has a certificate)");
  await setSiteApi(HOSTS.fly.direct);

  step(`Pointing ${API_HOST} at Fly`);
  await pointCname(HOSTS.fly.cname);
  if (!dry) {
    sh("fly", ["certs", "add", API_HOST, "--app", FLY_APP], { stdio: "ignore" });
    const ok = await waitFor(`${API_HOST} on Fly`, () => healthy(`https://${API_HOST}`), 30);
    if (!ok.ok) {
      console.log(
        `\n  ${ok.why}; the site is unaffected (it uses Fly's own URL). Re-run once the certificate is issued.`,
      );
      return;
    }
  }

  step("Moving the site back to the domain");
  await setSiteApi(`https://${API_HOST}`);
  console.log(
    "\nDone: Fly serves the API. Stop the Railway service in its dashboard if it should not keep enriching from the agent wallet.",
  );
}

try {
  if (cmd === "status") await status();
  else if (cmd === "railway") await toRailway();
  else if (cmd === "fly") await toFly();
  else {
    console.log("usage: node scripts/api-host.mjs status | railway [--dry-run] | fly [--dry-run]");
    process.exit(2);
  }
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
