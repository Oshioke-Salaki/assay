import type { Rating } from "@assay/core";
import type { Metadata } from "next";
import Link from "next/link";
import { AppShell, ErrorState, Panel } from "@/components/AppShell";
import { AssayBar } from "@/components/AssayBar";
import styles from "@/components/app.module.css";
import { DailyChart } from "@/components/DailyChart";
import { Hallmark } from "@/components/Hallmark";
import { ApiError, api, type DailyPoint, type Economy, type SellerRow, type Status, tryApi } from "@/lib/api";
import { addressUrl, ago, fineness, int, pct, short, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Celo x402 economy" };
export const revalidate = 30;

const RATING_ORDER: Rating[] = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "D", "NR"];

export default async function EconomyPage() {
  let e: Economy;
  try {
    e = await api<Economy>("/v1/economy");
  } catch (err) {
    return (
      <AppShell current="/economy">
        <ErrorState
          title="The economy could not be loaded"
          message={
            err instanceof ApiError ? err.message : "The Assay API did not answer. Try again in a minute."
          }
        />
      </AppShell>
    );
  }
  const [daily, sellers, status] = await Promise.all([
    tryApi<{ points: DailyPoint[] }>("/v1/economy/daily?days=120"),
    tryApi<{ total: number; rows: SellerRow[] }>("/v1/sellers?limit=12&sort=organic"),
    tryApi<Status>("/v1/status", 15),
  ]);
  const fine = fineness(e.organicUsd, e.grossUsd);
  const circularShare = e.grossUsd > 0 ? (e.loopOffsetUsd + e.fundedUsd) / e.grossUsd : 0;
  const rated = RATING_ORDER.map((r) => ({ r, n: e.ratingCounts[r] ?? 0 }));
  const maxRated = Math.max(1, ...rated.map((x) => x.n));

  return (
    <AppShell current="/economy">
      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Celo x402 economy</h1>
          <p className={styles.finding}>
            {e.grossUsd > 0
              ? `${pct(circularShare)} of the ${usd(e.grossUsd)} settled over x402 went round in ${int(e.loops)} payment loop${e.loops === 1 ? "" : "s"} or came from wallets the seller funded. ${usd(e.organicUsd)} is organic.`
              : "No x402 settlements have been indexed yet."}
          </p>
        </div>
        <div className={styles.actions}>
          <Link href="/#assay" className="btn btn--ink">
            Assay an address
          </Link>
          <Link href="/docs#api" className="btn btn--quiet">
            Use the API
          </Link>
        </div>
      </div>

      <div className={styles.kpis} style={{ "--n": 5 } as React.CSSProperties}>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Organic revenue</p>
          <p className={`${styles.kpiValue} ${styles.kpiLead} ${styles.kpiData}`}>{usd(e.organicUsd)}</p>
          <p className={styles.kpiNote}>of {usd(e.grossUsd)} gross</p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Fineness</p>
          <p className={styles.kpiValue}>{fine === null ? "–" : `0.${fine} fine`}</p>
          <p className={styles.kpiNote}>
            {fine === null ? "no revenue yet" : `${Number(fine)} organic dollars in every 1,000`}
          </p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Payment loops</p>
          <p className={styles.kpiValue}>{int(e.loops)}</p>
          <p className={styles.kpiNote}>
            {int(e.addressesInLoops)} wallets, largest {int(e.largestLoop)}
          </p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Organic payers</p>
          <p className={styles.kpiValue}>{int(e.organicPayers)}</p>
          <p className={styles.kpiNote}>of {int(e.payers)} paying wallets</p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Reviews from payers</p>
          <p className={styles.kpiValue}>{int(e.reviews.fromPayers)}</p>
          <p className={styles.kpiNote}>of {int(e.reviews.total)} ERC-8004 reviews</p>
        </div>
      </div>

      <Panel title="Where the volume went" span={12}>
        <AssayBar
          grossUsd={e.grossUsd}
          organicUsd={e.organicUsd}
          loopOffsetUsd={e.loopOffsetUsd}
          fundedUsd={e.fundedUsd}
        />
      </Panel>

      <Panel title="Volume per day, last 120 days" span={12}>
        <DailyChart points={daily?.points ?? []} />
      </Panel>

      <Panel
        title="Sellers by organic revenue"
        span={8}
        action={
          <span className={styles.muted}>
            {int(sellers?.total ?? e.sellers)} sellers · {int(e.settlements)} settlements
          </span>
        }
      >
        {(sellers?.rows ?? []).length === 0 ? (
          <p className={styles.empty}>No sellers yet.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Seller</th>
                  <th className={styles.r}>Organic</th>
                  <th className={`${styles.r} ${styles.hideSm}`}>Gross</th>
                  <th className={`${styles.r} ${styles.hideSm}`}>Payers</th>
                  <th>Hallmark</th>
                </tr>
              </thead>
              <tbody>
                {(sellers?.rows ?? []).map((s) => (
                  <tr key={s.address}>
                    <td>
                      <Link href={`/address/${s.address}`}>
                        {s.agentIds[0] ? `Agent #${s.agentIds[0]}` : short(s.address)}
                      </Link>
                      {s.agentIds[0] ? <div className={styles.muted}>{short(s.address)}</div> : null}
                    </td>
                    <td className={styles.r}>{usd(s.organicUsd)}</td>
                    <td className={`${styles.r} ${styles.hideSm}`}>{usd(s.grossUsd)}</td>
                    <td className={`${styles.r} ${styles.hideSm}`}>
                      {int(s.organicPayers)}
                      <span className={styles.muted}> / {int(s.payers)}</span>
                    </td>
                    <td>
                      <Hallmark organicUsd={s.organicUsd} grossUsd={s.grossUsd} rating={s.rating} size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Ratings issued" span={4}>
        <ul className={styles.flags} aria-label="Sellers per rating">
          {rated.map(({ r, n }) => (
            <li
              key={r}
              style={{
                display: "grid",
                gridTemplateColumns: "36px 1fr 48px",
                alignItems: "center",
                gap: 10,
                padding: "5px 0",
              }}
            >
              <span style={{ fontWeight: 600 }}>{r}</span>
              <span style={{ height: 8, background: "var(--app-control)" }}>
                <span
                  style={{
                    display: "block",
                    height: 8,
                    width: `${(n / maxRated) * 100}%`,
                    background: r === "NR" || r === "D" ? "#9a9ca2" : "var(--data)",
                  }}
                />
              </span>
              <span className={styles.r}>{int(n)}</span>
            </li>
          ))}
        </ul>
        <p className={styles.kpiNote} style={{ marginTop: 12 }}>
          NR is a thin file: fewer than 5 settlements or 2 payers.
        </p>
      </Panel>

      <Panel title="What these words mean" span={12}>
        <dl className={styles.glossary}>
          <div>
            <dt>Organic</dt>
            <dd>
              Revenue paid by wallets that are independent of the seller. This is the money that counts.
            </dd>
          </div>
          <div>
            <dt>Loop</dt>
            <dd>
              A group of wallets that pay each other, so the same dollars go round. Only what a seller keeps
              from it counts.
            </dd>
          </div>
          <div>
            <dt>Self-funded</dt>
            <dd>Payments from wallets the seller itself funded first. They count for nothing.</dd>
          </div>
          <div>
            <dt>Fineness</dt>
            <dd>Organic dollars per 1,000 received, like the 925 stamped on sterling silver.</dd>
          </div>
          <div>
            <dt>Rating</dt>
            <dd>
              AAA (best) to D, from organic share, independent payers and days of history. NR: too little
              history yet.
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Index" span={12}>
        <dl className={styles.facts}>
          <dt>Indexed to block</dt>
          <dd>
            {int(status?.settlementsBlock)}
            {status?.lagBlocks !== null && status?.lagBlocks !== undefined ? (
              <span className={styles.muted}>
                {" "}
                · {int(status.lagBlocks)} blocks behind the finalized head
              </span>
            ) : null}
          </dd>
          <dt>Last settlement</dt>
          <dd>{ago(status?.lastSettlementTs)}</dd>
          <dt>Methodology</dt>
          <dd>
            {e.methodology} ·{" "}
            <Link className="link" href="/docs#methodology">
              how scores are made
            </Link>
          </dd>
          <dt>Attester</dt>
          <dd>
            {status?.attester ? (
              <a className="link" href={addressUrl(status.attester)}>
                {status.attester}
              </a>
            ) : (
              <span className={styles.dash}>–</span>
            )}
          </dd>
        </dl>
      </Panel>
    </AppShell>
  );
}
