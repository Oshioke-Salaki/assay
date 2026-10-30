import type { Flag, RatingPlan } from "assayscore-core";
import { THIN_FILE, VISA_TIERS, verdictFor } from "assayscore-core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, ErrorState, Panel } from "@/components/AppShell";
import { AssayBar } from "@/components/AssayBar";
import styles from "@/components/app.module.css";
import { ClaimPanel } from "@/components/ClaimPanel";
import { Hallmark } from "@/components/Hallmark";
import { HallmarkKey } from "@/components/HallmarkKey";
import { HashScroll } from "@/components/HashScroll";
import { LoopRingLazy } from "@/components/LoopRingLazy";
import { CounterpartiesTable, PayersTable } from "@/components/PagedTables";
import { PayerCheck } from "@/components/PayerCheck";
import { PlanPanel } from "@/components/PlanPanel";
import { PublishHallmark } from "@/components/wallet/PublishHallmark";
import { XPanel } from "@/components/XPanel";
import { type AddressResponse, API_PUBLIC, ApiError, api, type Independent, tryApi } from "@/lib/api";
import { addressUrl, date, fineness, int, pct, RATING_WORDS, short, txUrl, usd } from "@/lib/format";
import { xReason } from "@/lib/x";

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
  const { assessment: a, agents, x } = data;
  const claim = data.claim ?? null;
  const responses = data.responses ?? {};
  const [independent, plan] = await Promise.all([
    a.seller.payers > 0 ? tryApi<Independent>(`/v1/independent/${address}`) : Promise.resolve(null),
    a.seller.grossUsd > 0 ? tryApi<RatingPlan>(`/v1/address/${address}/plan`) : Promise.resolve(null),
  ]);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://assayscore.xyz";
  // The verdict is recomputed here with the current rule, so the page is right even while the
  // API serves an older build.
  const ledgerCheck = verdictFor(a);
  // What X says is added to the reasons, never to the verdict.
  const xLine = xReason(x);
  const check = xLine ? { ...ledgerCheck, reasons: [...ledgerCheck.reasons, xLine] } : ledgerCheck;
  const s = a.seller;
  const b = a.buyer;
  const fine = fineness(s.organicUsd, s.grossUsd);
  const evidence = a.flags.filter((f) => f.severity !== "positive");
  const positives = a.flags.filter((f) => f.severity === "positive");

  return (
    <AppShell>
      <HashScroll />
      <div className={styles.titleRow}>
        <div style={{ minWidth: 0 }}>
          <p className={styles.crumbs}>
            <Link href="/economy">Economy</Link> / Report
          </p>
          <h1 className={styles.title}>
            {claim?.name ?? agents[0]?.name ?? (agents[0] ? `Agent #${agents[0].agentId}` : short(address))}
          </h1>
          <p className={`${styles.muted} ${styles.addr}`}>
            <a href={addressUrl(address)} className="link">
              {address}
            </a>
          </p>
          {claim ? (
            <p
              className={styles.muted}
              style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "center" }}
            >
              <span className={`${styles.pill} ${styles.pillGood}`}>Claimed by this wallet</span>
              {claim.url ? (
                <a className="link" href={claim.url} target="_blank" rel="noreferrer nofollow">
                  {claim.url.replace(/^https:\/\//, "")}
                </a>
              ) : null}
              {claim.x ? (
                <a
                  className="link"
                  href={`https://x.com/${claim.x}`}
                  target="_blank"
                  rel="noreferrer nofollow"
                >
                  @{claim.x}
                </a>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className={styles.actions}>
          {a.rating !== "NR" ? (
            <a className="btn btn--ink" href="#publish">
              Publish hallmark onchain
            </a>
          ) : null}
          {!claim && a.seller.grossUsd > 0 ? (
            <a className="btn btn--quiet" href="#claim">
              Claim this page
            </a>
          ) : null}
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
          <Hallmark organicUsd={s.organicUsd} grossUsd={s.grossUsd} rating={a.rating} size="lg" strike />
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
        {a.rating === "NR" && a.role !== "none" ? (
          <p className={styles.muted} style={{ maxWidth: "72ch" }}>
            Not rated means a thin file, not a bad one: fewer than {THIN_FILE.minSettlements} settlements or{" "}
            {THIN_FILE.minPayers} payers. The check says caution, never block, until there is history to
            judge.
          </p>
        ) : null}
        {a.role === "none" ? (
          <p className={styles.empty}>
            This address has never sent or received an x402 payment on Celo, so there is nothing to assay yet.
          </p>
        ) : (
          <AssayBar
            refine
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

      {a.loop && a.loop.size > 1 ? (
        <Panel
          title="The loop, drawn"
          span={12}
          id="loop"
          action={<span className={styles.muted}>{int(a.loop.size)} wallets</span>}
        >
          <LoopRingLazy
            loopSize={a.loop.size}
            organicUsd={s.organicUsd}
            grossUsd={s.grossUsd}
            inflows={s.payerLines.map((l) => ({
              address: l.payer,
              usd: l.usd,
              inLoop: l.inLoop || l.class === "loop",
              funded: l.class === "seller-funded" || l.class === "shared-funder",
            }))}
            outflows={b.counterparties.map((c) => ({ address: c.payee, usd: c.usd, inLoop: c.inLoop }))}
          />
        </Panel>
      ) : null}

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
                  <span className={`${styles.pill} ${f.early ? styles.pillWarn : SEVERITY_PILL[f.severity]}`}>
                    {f.early ? "Early" : SEVERITY_WORD[f.severity]}
                  </span>
                </span>
                <span className={styles.flagTitle}>{f.title}</span>
                <span className={styles.flagUsd}>{f.usd !== undefined ? usd(f.usd) : ""}</span>
                <span className={styles.flagDetail}>{f.detail}</span>
                {responses[f.code] ? (
                  <span className={styles.flagDetail} style={{ marginTop: 6 }}>
                    <span className={`${styles.notice}`} style={{ display: "block", whiteSpace: "pre-wrap" }}>
                      <strong>Seller&rsquo;s response</strong>
                      <span className={styles.muted}>
                        {" "}
                        · {date(responses[f.code]!.updatedAt)} · signed by this wallet, not checked by Assay
                      </span>
                      {"\n"}
                      {responses[f.code]!.text}
                    </span>
                  </span>
                ) : null}
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
          {a.identity.human ? (
            <>
              <dt>Celo Agent Visa</dt>
              <dd>
                {a.identity.human.visaTier ? (
                  `${VISA_TIERS[a.identity.human.visaTier] ?? "tier " + a.identity.human.visaTier}`
                ) : (
                  <span className={styles.dash}>none yet</span>
                )}
              </dd>
            </>
          ) : null}
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

      <Panel title="What X says" span={12} id="x">
        <XPanel mentions={x} address={address} isSeller={s.grossUsd > 0} />
      </Panel>

      <Panel
        title="Who paid it"
        span={12}
        action={
          <span className={styles.muted}>
            {int(s.payers)} payer{s.payers === 1 ? "" : "s"}
          </span>
        }
      >
        <PayersTable
          address={address}
          total={s.payers}
          initial={{ total: s.payers, rows: s.payerLines.slice(0, 20) }}
        />
      </Panel>

      {b.counterparties.length > 0 ? (
        <Panel
          title="Who it paid"
          span={12}
          action={<span className={styles.muted}>{int(b.sellers)} sellers</span>}
        >
          <CounterpartiesTable
            address={address}
            total={b.sellers}
            initial={{ total: b.sellers, rows: b.counterparties.slice(0, 20) }}
          />
        </Panel>
      ) : null}

      {independent ? (
        <Panel
          title="Independent payers, by the hackathon's rule"
          span={12}
          id="independent"
          action={
            <a className="link" href={`${API_PUBLIC}/v1/independent/${address}`}>
              Every payer, as JSON
            </a>
          }
        >
          <div className={styles.kpis} style={{ "--n": 3 } as React.CSSProperties}>
            <div className={styles.kpi}>
              <p className={styles.kpiLabel}>Count as independent</p>
              <p className={`${styles.kpiValue} ${styles.kpiData}`}>
                {int(independent.totals.independent)}
                <span className={styles.muted} style={{ fontSize: "1rem" }}>
                  {" "}
                  of {int(independent.totals.payers)}
                </span>
              </p>
              <p className={styles.kpiNote}>
                {independent.totals.unknown > 0
                  ? `${int(independent.totals.unknown)} not traced yet`
                  : "all payers traced"}
              </p>
            </div>
            <div className={styles.kpi}>
              <p className={styles.kpiLabel}>Paid by them in the window</p>
              <p className={styles.kpiValue}>{usd(independent.totals.independentUsdInWindow)}</p>
              <p className={styles.kpiNote}>
                from {int(independent.totals.independentInWindow)} of them, {date(independent.window.from)} to{" "}
                {date(independent.window.to)}
              </p>
            </div>
            <div className={styles.kpi}>
              <p className={styles.kpiLabel}>Do not count</p>
              <p className={styles.kpiValue}>{int(independent.totals.notIndependent)}</p>
              <p className={styles.kpiNote}>funded by the seller, in its loop, or new to Celo</p>
            </div>
          </div>
          <p className={styles.kpiNote} style={{ marginTop: 12, maxWidth: "80ch" }}>
            The Agents on Open Rails hackathon counts a payer only if it is not yours, was not first funded by
            you or your own funder, and was active on Celo before the window started. Assay already traces all
            three, so any team can check its own numbers here. Wallets you created and funded never count.
          </p>
        </Panel>
      ) : null}

      {s.grossUsd > 0 ? (
        <Panel title="Check a payer" span={12} id="payer">
          <PayerCheck seller={address} />
        </Panel>
      ) : null}

      {plan ? (
        <Panel
          title="What would raise this rating"
          span={12}
          id="plan"
          action={
            <a className="link" href={`${API_PUBLIC}/v1/address/${address}/plan`}>
              JSON
            </a>
          }
        >
          <PlanPanel plan={plan} />
        </Panel>
      ) : null}

      <Panel title="Publish this hallmark onchain" span={12} id="publish">
        <PublishHallmark subject={address} rating={a.rating} />
      </Panel>

      <Panel title={claim ? "Your page" : "Claim this page"} span={12} id="claim">
        <ClaimPanel
          subject={address}
          claim={claim}
          siteUrl={siteUrl}
          findings={a.flags
            .filter((f) => f.severity !== "positive")
            .map((f) => ({ code: f.code, title: f.title }))}
          responses={responses}
          alertsOffered
        />
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
