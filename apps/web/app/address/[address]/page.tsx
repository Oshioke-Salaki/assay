import type { Flag } from "@assay/core";
import { verdictFor } from "@assay/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, ErrorState, Panel } from "@/components/AppShell";
import { AssayBar } from "@/components/AssayBar";
import styles from "@/components/app.module.css";
import { Hallmark } from "@/components/Hallmark";
import { HallmarkKey } from "@/components/HallmarkKey";
import { PublishHallmark } from "@/components/wallet/PublishHallmark";
import { type AddressResponse, API_PUBLIC, ApiError, api } from "@/lib/api";
import { addressUrl, date, fineness, int, pct, RATING_WORDS, short, txUrl, usd } from "@/lib/format";

export const revalidate = 30;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  return { title: ADDRESS.test(address) ? `Report for ${short(address)}` : "Report" };
}

const SEVERITY_PILL: Record<Flag["severity"], string> = {
  critical: styles.pillBad!,
  warning: styles.pillWarn!,
  info: "",
  positive: styles.pillGood!,
};

const SEVERITY_WORD: Record<Flag["severity"], string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Note",
  positive: "Good",
};

const VERDICT_PILL = { pass: styles.pillGood!, caution: styles.pillWarn!, block: styles.pillBad! };

export default async function AddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: raw } = await params;
  if (!ADDRESS.test(raw)) notFound();
  const address = raw.toLowerCase() as `0x${string}`;

  let data: AddressResponse;
  try {
    data = await api<AddressResponse>(`/v1/address/${address}`);
  } catch (err) {
    return (
      <AppShell>
        <ErrorState
          title="This report could not be made"
          message={
            err instanceof ApiError ? err.message : "The Assay API did not answer. Try again in a minute."
          }
        />
      </AppShell>
    );
  }
  const { assessment: a, agents } = data;
  // The verdict is recomputed here with the current rule, so the page is right even while the
  // API serves an older build.
  const check = verdictFor(a);
  const s = a.seller;
  const b = a.buyer;
  const fine = fineness(s.organicUsd, s.grossUsd);
  const evidence = a.flags.filter((f) => f.severity !== "positive");
  const positives = a.flags.filter((f) => f.severity === "positive");

  return (
    <AppShell>
      <div className={styles.titleRow}>
        <div style={{ minWidth: 0 }}>
          <p className={styles.crumbs}>
            <Link href="/economy">Economy</Link> / Report
          </p>
          <h1 className={styles.title}>
            {agents[0]?.name ?? (agents[0] ? `Agent #${agents[0].agentId}` : short(address))}
          </h1>
          <p className={`${styles.muted} ${styles.addr}`}>
            <a href={addressUrl(address)} className="link">
              {address}
            </a>
          </p>
        </div>
        <div className={styles.actions}>
          <a className="btn btn--quiet" href={`${API_PUBLIC}/v1/address/${address}`}>
            JSON
          </a>
        </div>
      </div>

      <section
        className={styles.panel}
        style={{ gridColumn: "1 / -1", display: "grid", gap: 20 }}
        aria-label="Verdict"
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 20 }}>
          <Hallmark organicUsd={s.organicUsd} grossUsd={s.grossUsd} rating={a.rating} size="lg" />
          <div>
            <p style={{ fontSize: "2rem", fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
              {a.rating === "NR" ? "Not rated" : `${a.rating}, ${a.score ?? 0} of 100`}
            </p>
            <p className={styles.muted}>
              {RATING_WORDS[a.rating]}
              {fine !== null ? ` · 0.${fine} fine` : ""}
            </p>
          </div>
          <div style={{ marginLeft: "auto", display: "grid", gap: 6, justifyItems: "end" }}>
            <span className={`${styles.pill} ${VERDICT_PILL[check.verdict]}`}>
              Pre-payment check: {check.verdict}
            </span>
            <span className={styles.muted} style={{ fontSize: "0.8125rem", textAlign: "right" }}>
              {check.reasons.join(" · ")}
            </span>
          </div>
        </div>
        <HallmarkKey />
        {a.role === "none" ? (
          <p className={styles.empty}>
            This address has never sent or received an x402 payment on Celo, so there is nothing to assay yet.
          </p>
        ) : (
          <AssayBar
            grossUsd={s.grossUsd}
            organicUsd={s.organicUsd}
            loopOffsetUsd={s.loopOffsetUsd}
            fundedUsd={s.fundedUsd}
          />
        )}
      </section>

      <div className={styles.kpis} style={{ "--n": 4 } as React.CSSProperties}>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Organic revenue</p>
          <p className={`${styles.kpiValue} ${styles.kpiData}`}>{usd(s.organicUsd)}</p>
          <p className={styles.kpiNote}>of {usd(s.grossUsd)} received</p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Independent payers</p>
          <p className={styles.kpiValue}>
            {a.components ? a.components.effectivePayers.toFixed(1) : <span className={styles.dash}>–</span>}
          </p>
          <p className={styles.kpiNote}>
            effective, from {int(s.organicPayers)} of {int(s.payers)} payers
          </p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Active days</p>
          <p className={styles.kpiValue}>
            {a.components ? int(a.components.activeDays) : <span className={styles.dash}>–</span>}
          </p>
          <p className={styles.kpiNote}>
            {s.firstTs ? `${date(s.firstTs)} to ${date(s.lastTs)}` : "no revenue yet"}
          </p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Spent over x402</p>
          <p className={styles.kpiValue}>{usd(b.spentUsd)}</p>
          <p className={styles.kpiNote}>
            to {int(b.sellers)} seller{b.sellers === 1 ? "" : "s"}
            {b.loopSpendUsd > 0
              ? `, ${pct(b.loopSpendUsd / Math.max(b.spentUsd, 1e-9))} inside its loop`
              : ""}
          </p>
        </div>
      </div>

      <Panel
        title="Findings"
        span={8}
        action={<span className={styles.muted}>{evidence.length === 0 ? "none" : `${evidence.length}`}</span>}
      >
        {evidence.length === 0 ? (
          <p className={styles.empty}>
            {a.role === "none"
              ? "No findings: there is no x402 history."
              : "Nothing found against this address."}
          </p>
        ) : (
          <ul className={styles.flags}>
            {evidence.map((f) => (
              <li key={f.code} className={styles.flag}>
                <span>
                  <span className={`${styles.pill} ${SEVERITY_PILL[f.severity]}`}>
                    {SEVERITY_WORD[f.severity]}
                  </span>
                </span>
                <span className={styles.flagTitle}>{f.title}</span>
                <span className={styles.flagUsd}>{f.usd !== undefined ? usd(f.usd) : ""}</span>
                <span className={styles.flagDetail}>{f.detail}</span>
                {(f.txs?.length ?? 0) + (f.addresses?.length ?? 0) > 0 ? (
                  <span className={styles.flagEvidence}>
                    {f.txs?.map((t) => (
                      <a key={t} href={txUrl(t)} className="link">
                        tx {short(t)}
                      </a>
                    ))}
                    {f.addresses?.slice(0, 6).map((x) => (
                      <Link key={x} href={`/address/${x}`} className="link">
                        {short(x)}
                      </Link>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Identity" span={4}>
        <dl className={styles.facts}>
          <dt>ERC-8004</dt>
          <dd>
            {agents.length === 0 ? (
              <span className={styles.dash}>not registered</span>
            ) : (
              agents.map((ag) => (
                <div key={ag.agentId}>
                  <Link className="link" href={`/agents/${ag.agentId}`}>
                    Agent #{ag.agentId}
                  </Link>
                  {ag.name ? ` · ${ag.name}` : ""}
                </div>
              ))
            )}
          </dd>
          <dt>Self</dt>
          <dd>
            {a.identity.human ? (
              `Agent ID #${a.identity.human.agentId}${a.identity.human.fresh ? ", proof fresh" : ", proof expired"}`
            ) : (
              <span className={styles.dash}>no human proof</span>
            )}
          </dd>
          <dt>First funded by</dt>
          <dd>
            {a.identity.funding?.funder ? (
              <Link className="link" href={`/address/${a.identity.funding.funder}`}>
                {short(a.identity.funding.funder)}
              </Link>
            ) : (
              <span className={styles.dash}>{a.identity.funding ? "never funded" : "not checked yet"}</span>
            )}
            {a.identity.funding?.fundedAt ? (
              <span className={styles.muted}> · {date(a.identity.funding.fundedAt)}</span>
            ) : null}
          </dd>
          <dt>Loop</dt>
          <dd>
            {a.loop ? `${a.loop.size} wallets pay each other` : <span className={styles.dash}>none</span>}
          </dd>
        </dl>
        {positives.length > 0 ? (
          <ul className={styles.flags} style={{ marginTop: 12 }}>
            {positives.map((f) => (
              <li key={f.code} style={{ padding: "6px 0" }}>
                <span className={`${styles.pill} ${styles.pillGood}`}>{f.title}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel
        title="Who paid it"
        span={12}
        action={
          <span className={styles.muted}>
            {int(s.payers)} payer{s.payers === 1 ? "" : "s"}
            {s.payerLinesTruncated ? ", top 100 shown" : ""}
          </span>
        }
      >
        {s.payerLines.length === 0 ? (
          <p className={styles.empty}>Nobody has paid this address over x402.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Payer</th>
                  <th>Counted as</th>
                  <th className={styles.r}>Paid</th>
                  <th className={styles.r}>Counted</th>
                  <th className={`${styles.r} ${styles.hideSm}`}>Payments</th>
                  <th className={styles.hideSm}>Funded by</th>
                  <th className={`${styles.r} ${styles.hideSm}`}>Last</th>
                </tr>
              </thead>
              <tbody>
                {s.payerLines.map((l) => (
                  <tr key={l.payer}>
                    <td>
                      <Link href={`/address/${l.payer}`}>{short(l.payer)}</Link>
                      {l.human ? <span className={styles.muted}> · human</span> : null}
                    </td>
                    <td>
                      <span
                        className={`${styles.pill} ${l.class === "organic" ? styles.pillGood : l.class === "loop" ? styles.pillWarn : styles.pillBad}`}
                      >
                        {l.class === "organic"
                          ? l.established
                            ? "Organic, established"
                            : "Organic"
                          : l.class === "loop"
                            ? "In its loop"
                            : l.class === "seller-funded"
                              ? "Seller funded it"
                              : "Shares its funder"}
                      </span>
                    </td>
                    <td className={styles.r}>{usd(l.usd)}</td>
                    <td className={styles.r} style={{ color: l.creditedUsd > 0 ? "var(--data)" : undefined }}>
                      {usd(l.creditedUsd)}
                    </td>
                    <td className={`${styles.r} ${styles.hideSm}`}>{int(l.count)}</td>
                    <td className={styles.hideSm}>
                      {l.funder ? (
                        <Link href={`/address/${l.funder}`}>{short(l.funder)}</Link>
                      ) : (
                        <span className={styles.dash}>–</span>
                      )}
                    </td>
                    <td className={`${styles.r} ${styles.hideSm}`}>{date(l.lastTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {b.counterparties.length > 0 ? (
        <Panel
          title="Who it paid"
          span={12}
          action={<span className={styles.muted}>{int(b.sellers)} sellers</span>}
        >
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Seller</th>
                  <th className={styles.r}>Paid</th>
                  <th className={`${styles.r} ${styles.hideSm}`}>Payments</th>
                  <th>Relationship</th>
                  <th className={`${styles.r} ${styles.hideSm}`}>Last</th>
                </tr>
              </thead>
              <tbody>
                {b.counterparties.map((c) => (
                  <tr key={c.payee}>
                    <td>
                      <Link href={`/address/${c.payee}`}>{short(c.payee)}</Link>
                    </td>
                    <td className={styles.r}>{usd(c.usd)}</td>
                    <td className={`${styles.r} ${styles.hideSm}`}>{int(c.count)}</td>
                    <td>
                      {c.inLoop ? (
                        <span className={`${styles.pill} ${styles.pillWarn}`}>Pays it back</span>
                      ) : (
                        <span className={styles.muted}>Arm's length</span>
                      )}
                    </td>
                    <td className={`${styles.r} ${styles.hideSm}`}>{date(c.lastTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title="Publish this hallmark onchain" span={12} id="publish">
        <PublishHallmark subject={address} rating={a.rating} />
      </Panel>

      {a.components ? (
        <Panel title="How the score was made" span={12}>
          <dl className={styles.facts}>
            <dt>Quality</dt>
            <dd>
              {pct(a.components.quality)} of revenue is organic, raised to the power 1.5:{" "}
              {(a.components.quality ** 1.5).toFixed(3)}
            </dd>
            <dt>Diversity</dt>
            <dd>
              {a.components.effectivePayers.toFixed(2)} independent payers →{" "}
              {a.components.diversity.toFixed(3)} (weight 0.55)
            </dd>
            <dt>Track record</dt>
            <dd>
              {int(a.components.activeDays)} active days → {a.components.track.toFixed(3)} (weight 0.45)
            </dd>
            <dt>Dormancy</dt>
            <dd>×{a.components.dormancyFactor}</dd>
            <dt>Identity</dt>
            <dd>+{a.components.identityBonus}</dd>
            <dt>Methodology</dt>
            <dd>
              {a.methodologyVersion} ·{" "}
              <Link className="link" href="/docs#methodology">
                read it
              </Link>
            </dd>
          </dl>
        </Panel>
      ) : null}
    </AppShell>
  );
}
