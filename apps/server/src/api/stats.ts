import { type Address, dayOf, TOKENS, tokenByAddress } from "assayscore-core";
import { type PublicClient, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DB } from "../db.js";
import type { Env } from "../env.js";
import { recentProblems } from "../lib/log.js";
import type { Usage } from "../usage.js";
import type { IndexStatus } from "./app.js";

/**
 * Public numbers about Assay itself: how it is used, what it earns (read from the chain at its
 * PayTo address), what it spends on paid services, and how fresh its data is. Counts only, never
 * who called. Anyone can check the money figures against Celo.
 */
export function publicStats(db: DB, env: Env, usage: Usage | null, status: IndexStatus, now = Date.now()) {
  const days = 30;
  const today = dayOf(Math.floor(now / 1000));
  const from = today - days + 1;

  const payTo = env.PAY_TO?.toLowerCase() as Address | undefined;
  const revenue = payTo
    ? {
        payTo,
        ...(db
          .prepare(
            "SELECT COUNT(*) AS payments, COALESCE(SUM(usd), 0) AS usd, COUNT(DISTINCT payer) AS payers FROM settlements WHERE payee = ?",
          )
          .get(payTo) as { payments: number; usd: number; payers: number }),
        byToken: (
          db
            .prepare(
              "SELECT token, COUNT(*) AS payments, SUM(usd) AS usd FROM settlements WHERE payee = ? GROUP BY token ORDER BY usd DESC",
            )
            .all(payTo) as { token: string; payments: number; usd: number }[]
        ).map((r) => ({
          symbol: tokenByAddress(r.token)?.symbol ?? r.token,
          payments: r.payments,
          usd: r.usd,
        })),
        daily: daySeries(
          db
            .prepare(
              "SELECT ts / 86400 AS day, COUNT(*) AS payments, SUM(usd) AS usd FROM settlements WHERE payee = ? AND ts >= ? GROUP BY day",
            )
            .all(payTo, from * 86_400) as { day: number; payments: number; usd: number }[],
          from,
          today,
        ),
        recent: (
          db
            .prepare(
              "SELECT tx_hash AS tx, ts, payer, token, usd FROM settlements WHERE payee = ? ORDER BY block DESC LIMIT 10",
            )
            .all(payTo) as { tx: string; ts: number; payer: string; token: string; usd: number }[]
        ).map((r) => ({ ...r, token: tokenByAddress(r.token)?.symbol ?? r.token })),
      }
    : null;

  const spend = db
    .prepare(
      `SELECT service, COUNT(*) AS calls, COALESCE(SUM(usd), 0) AS usd, MAX(ts) AS lastTs
       FROM paid_calls WHERE tx_hash IS NOT NULL GROUP BY service ORDER BY usd DESC`,
    )
    .all() as { service: string; calls: number; usd: number; lastTs: number }[];

  const x = db
    .prepare(
      `SELECT COUNT(*) AS searched, COALESCE(SUM(mentions > 0), 0) AS mentioned,
              COALESCE(SUM(warnings > 0), 0) AS warned, MAX(checked_at) AS lastAt
       FROM x_mentions WHERE status = 'ok'`,
    )
    .get() as { searched: number; mentioned: number; warned: number; lastAt: number | null };

  const funding = db
    .prepare(
      `WITH parties AS (SELECT payer AS a FROM pair_days UNION SELECT payee FROM pair_days)
       SELECT (SELECT COUNT(*) FROM parties) AS parties,
              (SELECT COUNT(*) FROM funding f JOIN parties p ON p.a = f.address WHERE f.error IS NULL) AS traced`,
    )
    .get() as { parties: number; traced: number };

  return {
    asOf: now,
    usage: usage
      ? {
          days: usage.daily(days, now),
          totals: usage.totals(),
          note: "Requests to api.assayscore.xyz, including the reports the website renders. Callers are counted as salted daily hashes; no address is stored.",
        }
      : null,
    revenue,
    spend: { services: spend, usd: spend.reduce((n, s) => n + s.usd, 0) },
    x: {
      sellersSearched: x.searched,
      withMentions: x.mentioned,
      withWarnings: x.warned,
      lastSearchAt: x.lastAt,
    },
    data: {
      settlementsBlock: status.settlementsBlock,
      finalizedHead: status.finalizedHead,
      lagBlocks:
        status.finalizedHead === null ? null : Math.max(0, status.finalizedHead - status.settlementsBlock),
      lastSettlementTs: status.lastSettlementTs,
      fundingCoverage: funding.parties ? funding.traced / funding.parties : null,
    },
  };
}

function daySeries<T extends { day: number }>(rows: T[], from: number, to: number) {
  const out = [];
  for (let d = from; d <= to; d++) {
    const r = rows.find((x) => x.day === d);
    out.push({
      day: d,
      payments: (r as { payments?: number })?.payments ?? 0,
      usd: (r as { usd?: number })?.usd ?? 0,
    });
  }
  return out;
}

/**
 * RPC and gateway URLs can carry an API key in their path or query (Chainstack does). The
 * operator view shows log lines in a browser, so every URL is cut to its origin.
 */
export function redactUrls(text: string): string {
  return text.replace(
    /\b(https?|wss?):\/\/([^/\s"'?#]+)[^\s"']*/gi,
    (_, scheme, host) => `${scheme}://${host}/…`,
  );
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(redactUrls(JSON.stringify(fields))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const WATCHED = TOKENS.filter((t) => t.fiat === "USD");

async function balances(rpc: PublicClient, owner: Address) {
  const read = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try {
      return await Promise.race([f(), new Promise<null>((r) => setTimeout(() => r(null), 8_000))]);
    } catch {
      return null;
    }
  };
  const celo = await read(() => rpc.getBalance({ address: owner }));
  const tokens = await Promise.all(
    WATCHED.map(async (t) => {
      const raw = await read(() =>
        rpc.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [owner] }),
      );
      return { symbol: t.symbol, balance: raw === null ? null : Number(raw) / 10 ** t.decimals };
    }),
  );
  return { address: owner, celo: celo === null ? null : Number(celo) / 1e18, tokens };
}

/**
 * Operator view: wallet balances, today's spend against each cap, the X queue, recent warnings,
 * the database and the process. Behind ADMIN_KEY; never cached publicly.
 */
export async function adminStats(db: DB, env: Env, rpc: PublicClient, now = Date.now()) {
  const agent = env.BUY_PAYER_KEY
    ? (privateKeyToAccount(env.BUY_PAYER_KEY).address.toLowerCase() as Address)
    : null;
  const payTo = env.PAY_TO?.toLowerCase() as Address | undefined;
  const wallets = await Promise.all(
    [
      agent
        ? {
            role:
              payTo === agent
                ? "Agent wallet: pays for X searches, sends Assay's transactions and receives payments for checks"
                : "Agent wallet: pays for X searches and sends Assay's transactions",
            address: agent,
          }
        : null,
      payTo && payTo !== agent ? { role: "PayTo: receives payments for checks", address: payTo } : null,
    ]
      .filter((w): w is { role: string; address: Address } => w !== null)
      .map(async (w) => ({ role: w.role, ...(await balances(rpc, w.address)) })),
  );

  const dayStart = Math.floor(now / 86_400_000) * 86_400;
  const caps: Record<string, number> = { "buy-x-search": env.X_MENTIONS_DAILY_CAP_USD };
  const today = db
    .prepare(
      "SELECT service, COUNT(*) AS calls, COALESCE(SUM(usd), 0) AS usd, SUM(tx_hash IS NULL) AS failed FROM paid_calls WHERE ts >= ? GROUP BY service",
    )
    .all(dayStart) as { service: string; calls: number; usd: number; failed: number }[];
  const budgets = Object.entries(caps).map(([service, cap]) => {
    const t = today.find((r) => r.service === service);
    return { service, capUsd: cap, spentUsd: t?.usd ?? 0, calls: t?.calls ?? 0, failed: t?.failed ?? 0 };
  });

  const nowSec = Math.floor(now / 1000);
  const xQueue = db
    .prepare(
      `WITH sellers AS (SELECT payee AS address FROM pair_days GROUP BY payee HAVING SUM(usd) >= ?)
       SELECT (SELECT COUNT(*) FROM x_wanted) AS wanted,
              (SELECT COUNT(*) FROM sellers s LEFT JOIN x_mentions x ON x.address = s.address WHERE x.address IS NULL) AS neverSearched,
              (SELECT COUNT(*) FROM x_mentions WHERE status = 'error' AND checked_at > ?) AS errorsToday`,
    )
    .get(env.X_MENTIONS_MIN_GROSS_USD, nowSec - 86_400) as {
    wanted: number;
    neverSearched: number;
    errorsToday: number;
  };

  const pages = db.pragma("page_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const mem = process.memoryUsage();

  return {
    asOf: now,
    wallets,
    budgets,
    x: xQueue,
    recentPaidCalls: db
      .prepare(
        "SELECT id, ts, service, status, usd, tx_hash AS txHash, note FROM paid_calls ORDER BY id DESC LIMIT 20",
      )
      .all(),
    problems: [...recentProblems()]
      .reverse()
      .slice(0, 50)
      .map((p) => ({ ...p, msg: redactUrls(p.msg), fields: p.fields && redactFields(p.fields) })),
    database: {
      sizeMb: Math.round((pages * pageSize) / 1e5) / 10,
      settlements: (db.prepare("SELECT COUNT(*) AS n FROM settlements").get() as { n: number }).n,
      agents: (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n,
    },
    process: {
      uptimeMin: Math.round(process.uptime() / 60),
      rssMb: Math.round(mem.rss / 1e6),
      heapMb: Math.round(mem.heapUsed / 1e6),
      node: process.version,
      region: process.env.FLY_REGION ?? null,
      image: process.env.FLY_IMAGE_REF ?? null,
      role: env.ROLE,
    },
  };
}
