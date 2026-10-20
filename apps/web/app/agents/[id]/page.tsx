import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, ErrorState, Panel } from "@/components/AppShell";
import { AssayBar } from "@/components/AssayBar";
import styles from "@/components/app.module.css";
import { Hallmark } from "@/components/Hallmark";
import { ReviewForm } from "@/components/wallet/ReviewForm";
import { type AgentResponse, ApiError, api } from "@/lib/api";
import { addressUrl, date, int, short, txUrl, usd } from "@/lib/format";

export const revalidate = 30;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Agent #${id}` };
}

const TIER = {
  proven: { label: "Payment proven", cls: styles.pillGood! },
  paid: { label: "Paid customer", cls: styles.pillGood! },
  unverified: { label: "Never paid it", cls: styles.pillWarn! },
};

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,30}$/.test(id)) notFound();
  let d: AgentResponse;
  try {
    d = await api<AgentResponse>(`/v1/agents/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <AppShell current="/agents">
        <ErrorState
          title={`Agent #${id} could not be loaded`}
          message={err instanceof ApiError ? err.message : "Try again in a minute."}
        />
      </AppShell>
    );
  }
  const { agent, assessment: a, check, reviews } = d;
  const live = reviews.filter((r) => !r.revoked);
  const paid = live.filter((r) => r.tier !== "unverified");
  const avg = (rs: typeof live) => (rs.length ? rs.reduce((n, r) => n + r.value, 0) / rs.length : null);
  const paidAvg = avg(paid);
  const allAvg = avg(live);
  const wallet = agent.wallet ?? agent.owner;

  return (
    <AppShell current="/agents">
      <div className={styles.titleRow}>
        <div style={{ minWidth: 0 }}>
          <p className={styles.crumbs}>
            <Link href="/agents">Agents</Link> / #{agent.agentId}
          </p>
          <h1 className={styles.title}>{agent.name ?? `Agent #${agent.agentId}`}</h1>
          <p className={styles.finding}>
            {live.length === 0
              ? "No reviews yet."
              : `${int(paid.length)} of ${int(live.length)} reviews come from wallets that paid this agent${
                  paidAvg !== null
                    ? `, averaging ${paidAvg.toFixed(0)} against ${allAvg?.toFixed(0)} for all reviews`
                    : ""
                }.`}
          </p>
        </div>
        <div className={styles.actions}>
          <a className="btn btn--ink" href="#review">
            Write a review
          </a>
          <Link className="btn btn--quiet" href={`/address/${wallet}`}>
            Full report
          </Link>
        </div>
      </div>

      <Panel title="Revenue" span={8}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, marginBottom: 16 }}>
          <Hallmark
            organicUsd={a.seller.organicUsd}
            grossUsd={a.seller.grossUsd}
            rating={a.rating}
            size="md"
          />
          <span className={styles.muted}>
            Pre-payment check: <strong style={{ color: "var(--ink)" }}>{check.verdict}</strong> ·{" "}
            {check.reasons.join(" · ")}
          </span>
        </div>
        <AssayBar
          grossUsd={a.seller.grossUsd}
          organicUsd={a.seller.organicUsd}
          loopOffsetUsd={a.seller.loopOffsetUsd}
          fundedUsd={a.seller.fundedUsd}
        />
      </Panel>

      <Panel title="Registration" span={4}>
        <dl className={styles.facts}>
          <dt>Owner</dt>
          <dd>
            <a className="link" href={addressUrl(agent.owner)}>
              {short(agent.owner)}
            </a>
          </dd>
          <dt>Wallet</dt>
          <dd>{agent.wallet ? short(agent.wallet) : <span className={styles.dash}>owner</span>}</dd>
          <dt>Registered</dt>
          <dd>{date(agent.registeredTs)}</dd>
          <dt>x402</dt>
          <dd>
            {agent.x402 === null ? (
              <span className={styles.dash}>not declared</span>
            ) : agent.x402 ? (
              "supported"
            ) : (
              "no"
            )}
          </dd>
          <dt>Self</dt>
          <dd>
            {a.identity.human ? (
              `human-backed${a.identity.human.fresh ? "" : ", expired"}`
            ) : (
              <span className={styles.dash}>no proof</span>
            )}
          </dd>
        </dl>
        {agent.description ? (
          <p className={styles.muted} style={{ marginTop: 12 }}>
            {agent.description}
          </p>
        ) : null}
      </Panel>

      <Panel title="Reviews" span={12} action={<span className={styles.muted}>{int(live.length)} live</span>}>
        {reviews.length === 0 ? (
          <p className={styles.empty}>
            Nobody has reviewed this agent in the ERC-8004 Reputation Registry yet.
          </p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Reviewer</th>
                  <th>Verification</th>
                  <th className={styles.r}>Score</th>
                  <th className={`${styles.r} ${styles.hideSm}`}>They paid</th>
                  <th className={styles.hideSm}>Comment</th>
                  <th className={styles.r}>When</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={`${r.client}-${r.index}`} style={r.revoked ? { opacity: 0.55 } : undefined}>
                    <td>
                      <Link href={`/address/${r.client}`}>{short(r.client)}</Link>
                    </td>
                    <td>
                      <span className={`${styles.pill} ${TIER[r.tier].cls}`}>
                        {r.revoked ? "Revoked" : TIER[r.tier].label}
                      </span>
                    </td>
                    <td className={styles.r}>{Number.isInteger(r.value) ? r.value : r.value.toFixed(2)}</td>
                    <td className={`${styles.r} ${styles.hideSm}`}>
                      {r.clientPaidUsd > 0 ? usd(r.clientPaidUsd) : <span className={styles.dash}>$0</span>}
                    </td>
                    <td className={styles.hideSm} style={{ maxWidth: 360 }}>
                      {r.comment ?? <span className={styles.dash}>–</span>}
                    </td>
                    <td className={styles.r}>
                      <a className="link" href={txUrl(r.txHash)}>
                        {date(r.ts)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Write a payment-verified review" span={12} id="review">
        <ReviewForm agentId={agent.agentId} />
      </Panel>
    </AppShell>
  );
}
