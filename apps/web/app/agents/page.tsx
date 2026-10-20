import type { Metadata } from "next";
import Link from "next/link";
import { AppShell, ErrorState, Panel } from "@/components/AppShell";
import styles from "@/components/app.module.css";
import { type AgentRow, ApiError, api, type Economy, tryApi } from "@/lib/api";
import { date, int, pct, short, usd } from "@/lib/format";

export const metadata: Metadata = { title: "ERC-8004 agents on Celo" };
export const revalidate = 30;

const PAGE = 30;

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; all?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 80);
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const onlyPaid = sp.all !== "1";
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String((page - 1) * PAGE) });
  if (q) qs.set("q", q);
  if (onlyPaid && !q) qs.set("paid", "1");

  let list: { total: number; rows: AgentRow[] };
  try {
    list = await api(`/v1/agents?${qs}`);
  } catch (err) {
    return (
      <AppShell current="/agents">
        <ErrorState
          title="Agents could not be loaded"
          message={err instanceof ApiError ? err.message : "Try again in a minute."}
        />
      </AppShell>
    );
  }
  const e = await tryApi<Economy>("/v1/economy");
  const pages = Math.max(1, Math.ceil(list.total / PAGE));
  const link = (p: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: q || undefined, all: onlyPaid ? undefined : "1", ...p }))
      if (v) u.set(k, v);
    const s = u.toString();
    return `/agents${s ? `?${s}` : ""}`;
  };

  return (
    <AppShell current="/agents">
      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>ERC-8004 agents on Celo</h1>
          <p className={styles.finding}>
            {e && e.reviews.total > 0
              ? `${pct(e.reviews.fromPayers / e.reviews.total)} of the ${int(e.reviews.total)} reviews in the Reputation Registry come from a wallet that ever paid the agent it reviews. Agents are ranked by those reviews, then by x402 revenue.`
              : "Agents are ranked by reviews from wallets that paid them, then by x402 revenue."}
          </p>
        </div>
        <form className={styles.actions} action="/agents" method="get">
          <label className="sr-only" htmlFor="agent-q">
            Search agents
          </label>
          <input
            id="agent-q"
            name="q"
            defaultValue={q}
            placeholder="Name, #id or address"
            style={{
              minHeight: 36,
              padding: "0 12px",
              border: "1px solid #cfd1d5",
              borderRadius: 6,
              background: "#fff",
              minWidth: 220,
            }}
          />
          <button type="submit" className="btn btn--ink">
            Search
          </button>
        </form>
      </div>

      <Panel
        title={q ? `Results for “${q}”` : onlyPaid ? "Agents with paying customers" : "All agents"}
        action={
          <span className={styles.muted}>
            {int(list.total)} agent{list.total === 1 ? "" : "s"} ·{" "}
            {q ? (
              <Link className="link" href="/agents">
                clear search
              </Link>
            ) : onlyPaid ? (
              <Link className="link" href={link({ all: "1" })}>
                show all
              </Link>
            ) : (
              <Link className="link" href="/agents">
                only paid
              </Link>
            )}
          </span>
        }
      >
        {list.rows.length === 0 ? (
          <p className={styles.empty}>
            {q
              ? "No agent matches that."
              : onlyPaid
                ? "No ERC-8004 agent on Celo has received an x402 payment or a review from a paying wallet yet."
                : "No agents indexed yet."}
          </p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className={styles.r}>Reviews from payers</th>
                  <th className={`${styles.r} ${styles.hideSm}`}>All reviews</th>
                  <th className={styles.r}>x402 revenue</th>
                  <th className={styles.hideSm}>Wallet</th>
                  <th className={`${styles.r} ${styles.hideSm}`}>Registered</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((a) => (
                  <tr key={a.agentId}>
                    <td>
                      <Link href={`/agents/${a.agentId}`}>{a.name ?? `Agent #${a.agentId}`}</Link>
                      {a.name ? <span className={styles.muted}> #{a.agentId}</span> : null}
                    </td>
                    <td className={styles.r}>
                      {a.paidReviews > 0 ? int(a.paidReviews) : <span className={styles.dash}>0</span>}
                    </td>
                    <td className={`${styles.r} ${styles.hideSm}`}>{int(a.reviews)}</td>
                    <td className={styles.r}>
                      {a.revenueUsd > 0 ? usd(a.revenueUsd) : <span className={styles.dash}>$0</span>}
                    </td>
                    <td className={styles.hideSm}>{short(a.wallet ?? a.owner)}</td>
                    <td className={`${styles.r} ${styles.hideSm}`}>{date(a.registeredTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 ? (
          <nav
            aria-label="Pages"
            className={styles.actions}
            style={{ marginTop: 16, justifyContent: "space-between" }}
          >
            {page > 1 ? (
              <Link className="btn btn--quiet" href={link({ page: String(page - 1) })}>
                Previous
              </Link>
            ) : (
              <span />
            )}
            <span className={styles.muted} style={{ alignSelf: "center" }}>
              Page {page} of {pages}
            </span>
            {page < pages ? (
              <Link className="btn btn--quiet" href={link({ page: String(page + 1) })}>
                Next
              </Link>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </Panel>
    </AppShell>
  );
}
