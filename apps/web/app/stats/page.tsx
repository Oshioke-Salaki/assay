import type { Metadata } from "next";
import Link from "next/link";
import { AppShell, ErrorState, Panel } from "@/components/AppShell";
import styles from "@/components/app.module.css";
import { Hallmark } from "@/components/Hallmark";
import { UsageChart, usageParts } from "@/components/UsageChart";
import { API_PUBLIC, ApiError, api, type Independent, type Stats, tryApi } from "@/lib/api";
import { addressUrl, ago, int, pct, short, txUrl, usdFine } from "@/lib/format";

export const metadata: Metadata = {
  title: "Assay in numbers",
  description: "How Assay is used, what it earns and spends onchain, and how fresh its data is.",
};
export const revalidate = 30;

const VERDICT_PILL = { pass: styles.pillGood!, caution: styles.pillWarn!, block: styles.pillBad! };

const SERVICES: Record<string, { label: string; what: string }> = {
  "buy-x-search": { label: "X search through buy", what: "What X says about every seller, weekly" },
  "buy-x-search-ondemand": {
    label: "X search bought by a paid check",
    what: "Fresh evidence a buyer paid $0.01 for",
  },
  unmatched: { label: "Payments whose answer was lost", what: "Found onchain by the reconciler" },
};

export default async function StatsPage() {
  let s: Stats;
  try {
    s = await api<Stats>("/v1/stats");
  } catch (err) {
    return (
      <AppShell current="/stats">
        <ErrorState
          title="The numbers could not be loaded"
          message={
            err instanceof ApiError ? err.message : "The Assay API did not answer. Try again in a minute."
          }
        />
      </AppShell>
    );
  }

  const days = s.usage?.days ?? [];
  const outside = s.self ? await tryApi<Independent>(`/v1/independent/${s.self.address}`) : null;
  const sum = days.reduce(
    (a, d) => {
      const p = usageParts(d);
      return { total: a.total + p.total, paid: a.paid + p.paid, reports: a.reports + p.reports };
    },
    { total: 0, paid: 0, reports: 0 },
  );
  const peakCallers = Math.max(0, ...days.map((d) => d.visitors));
  const today = days.at(-1);
  const rev = s.revenue;
  const lag = s.data.lagBlocks;

  return (
    <AppShell current="/stats">
      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Assay in numbers</h1>
          <p className={styles.finding}>
            {int(sum.total)} API request{sum.total === 1 ? "" : "s"} in the last 30 days
            {rev
              ? `, ${usdFine(rev.usd)} earned from ${int(rev.payments)} paid answer${rev.payments === 1 ? "" : "s"}`
              : ""}
            , {usdFine(s.spend.usd)} spent on paid data. The money figures are read from Celo, so anyone can
            check them.
          </p>
        </div>
        <div className={styles.actions}>
          <Link href="/docs#api" className="btn btn--ink">
            Use the API
          </Link>
          <Link href="/economy" className="btn btn--quiet">
            The economy
          </Link>
        </div>
      </div>

      <div className={styles.kpis} style={{ "--n": 5 } as React.CSSProperties}>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Requests, 30 days</p>
          <p className={`${styles.kpiValue} ${styles.kpiLead} ${styles.kpiData}`}>{int(sum.total)}</p>
          <p className={styles.kpiNote}>
            {today ? `${int(usageParts(today).total)} today` : "counting"}, {int(sum.reports)} report
            {sum.reports === 1 ? "" : "s"}
          </p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Direct API callers</p>
          <p className={styles.kpiValue}>{int(today?.visitors ?? 0)}</p>
          <p className={styles.kpiNote}>today, busiest day {int(peakCallers)}; site visits not included</p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Paid answers</p>
          <p className={styles.kpiValue}>{int(rev?.payments ?? 0)}</p>
          <p className={styles.kpiNote}>
            {rev
              ? `${usdFine(rev.usd)} from ${int(rev.payers)} payer${rev.payers === 1 ? "" : "s"}`
              : "payments are off"}
          </p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Spent on data</p>
          <p className={styles.kpiValue}>{usdFine(s.spend.usd)}</p>
          <p className={styles.kpiNote}>
            {int(s.spend.services.reduce((n, x) => n + x.calls, 0))} paid calls over x402
          </p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Data freshness</p>
          <p className={styles.kpiValue}>{lag === null ? "–" : lag <= 30 ? "Live" : `${int(lag)} blocks`}</p>
          <p className={styles.kpiNote}>last settlement {ago(s.data.lastSettlementTs)}</p>
        </div>
      </div>

      <Panel title="Requests per day" span={12}>
        <UsageChart days={days} />
        <p className={styles.kpiNote} style={{ marginTop: 12 }}>
          {s.usage?.note ?? "Usage counting is not switched on for this server."}
        </p>
      </Panel>

      <Panel
        title="Payments to Assay"
        span={8}
        action={
          rev ? (
            <a className="link" href={addressUrl(rev.payTo)} target="_blank" rel="noreferrer">
              PayTo on Celoscan
            </a>
          ) : null
        }
      >
        {!rev ? (
          <p className={styles.empty}>This server does not take payments.</p>
        ) : rev.recent.length === 0 ? (
          <p className={styles.empty}>
            No paid checks yet. A check costs $0.002 in USDT, USDC or a local stablecoin;{" "}
            <Link className="link" href="/docs#pricing">
              see how to call one
            </Link>
            .
          </p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Payer</th>
                  <th scope="col">Token</th>
                  <th scope="col" className={styles.r}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {rev.recent.map((p) => (
                  <tr key={p.tx}>
                    <td>
                      <a className="link" href={txUrl(p.tx)} target="_blank" rel="noreferrer">
                        {ago(p.ts)}
                      </a>
                    </td>
                    <td>
                      <Link href={`/address/${p.payer}`}>{short(p.payer)}</Link>
                    </td>
                    <td>{p.token}</td>
                    <td className={styles.r}>{usdFine(p.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Earned by token" span={4}>
        {!rev || rev.byToken.length === 0 ? (
          <p className={styles.empty}>Nothing earned yet.</p>
        ) : (
          <dl className={styles.facts}>
            {rev.byToken.map((t) => (
              <div key={t.symbol} style={{ display: "contents" }}>
                <dt>{t.symbol}</dt>
                <dd>
                  {usdFine(t.usd)}{" "}
                  <span className={styles.muted}>
                    · {int(t.payments)} payment{t.payments === 1 ? "" : "s"}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>

      <Panel
        title="What Assay pays for"
        span={8}
        action={
          <a className="link" href={`${API_PUBLIC}/v1/paid-calls`}>
            Every call, with its transaction
          </a>
        }
      >
        {s.spend.services.length === 0 ? (
          <p className={styles.empty}>No paid calls yet.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col" className={styles.hideSm}>
                    Used for
                  </th>
                  <th scope="col" className={styles.r}>
                    Calls
                  </th>
                  <th scope="col" className={styles.r}>
                    Spent
                  </th>
                  <th scope="col" className={`${styles.r} ${styles.hideSm}`}>
                    Last
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.spend.services.map((x) => (
                  <tr key={x.service}>
                    <td>{SERVICES[x.service]?.label ?? x.service}</td>
                    <td className={styles.hideSm}>{SERVICES[x.service]?.what ?? "–"}</td>
                    <td className={styles.r}>{int(x.calls)}</td>
                    <td className={styles.r}>{usdFine(x.usd)}</td>
                    <td className={`${styles.r} ${styles.hideSm}`}>{ago(x.lastTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="What X says" span={4}>
        <dl className={styles.facts}>
          <dt>Sellers searched</dt>
          <dd>{int(s.x.sellersSearched)}</dd>
          <dt>Named in posts</dt>
          <dd>{int(s.x.withMentions)}</dd>
          <dt>With warnings</dt>
          <dd>{int(s.x.withWarnings)}</dd>
          <dt>Last search</dt>
          <dd>{ago(s.x.lastSearchAt)}</dd>
        </dl>
        <p className={styles.kpiNote} style={{ marginTop: 12 }}>
          Shown as evidence on reports. Never part of a score.
        </p>
      </Panel>

      <Panel title="Assay rated by Assay" span={12} id="self">
        {!s.self ? (
          <p className={styles.empty}>This server does not take payments, so there is nothing to rate.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
              <Hallmark
                organicUsd={s.self.organicUsd}
                grossUsd={s.self.grossUsd}
                rating={s.self.rating}
                size="sm"
              />
              <span className={`${styles.pill} ${VERDICT_PILL[s.self.verdict]}`}>
                Pre-payment check: {s.self.verdict}
              </span>
              <Link className="link" href={`/address/${s.self.address}`}>
                Full report
              </Link>
            </div>
            <dl className={styles.facts}>
              <dt>Organic revenue</dt>
              <dd>
                {usdFine(s.self.organicUsd)}{" "}
                <span className={styles.muted}>of {usdFine(s.self.grossUsd)} received</span>
              </dd>
              <dt>Independent payers</dt>
              <dd>
                {int(s.self.organicPayers)} <span className={styles.muted}>of {int(s.self.payers)}</span>
                {s.self.independent !== undefined ? (
                  <span className={styles.muted}> · {int(s.self.independent)} by the hackathon's rule</span>
                ) : null}
              </dd>
              <dt>Why</dt>
              <dd>{s.self.reasons.join(" · ")}</dd>
            </dl>
            <p className={styles.kpiNote} style={{ maxWidth: "80ch" }}>
              Assay's own PayTo address, scored by the same rules as everyone else. Payments from wallets
              Assay funded are struck out, so this is the honest count of its independent customers. It will
              change only when wallets Assay never funded pay for checks or hallmarks.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="The data underneath" span={12}>
        <dl className={styles.facts}>
          <dt>Indexed to block</dt>
          <dd>
            {int(s.data.settlementsBlock)}
            {s.data.finalizedHead !== null ? (
              <span className={styles.muted}> of {int(s.data.finalizedHead)} finalized</span>
            ) : null}
          </dd>
          <dt>Last settlement</dt>
          <dd>{ago(s.data.lastSettlementTs)}</dd>
          <dt>Funding traced</dt>
          <dd>
            {s.data.fundingCoverage === null ? "–" : pct(s.data.fundingCoverage)}
            <span className={styles.muted}> of wallets in x402 payments</span>
          </dd>
        </dl>
      </Panel>
    </AppShell>
  );
}
