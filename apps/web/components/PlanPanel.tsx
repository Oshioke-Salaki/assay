import type { RatingPlan } from "assayscore-core";
import { int, usd } from "@/lib/format";
import styles from "./app.module.css";

/** What would raise this rating, in plain words, from the real score formula. */
export function PlanPanel({ plan }: { plan: RatingPlan }) {
  if (!plan.applicable) return <p className={styles.empty}>{plan.reason}</p>;
  const score = plan.score ?? 0;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ maxWidth: "72ch" }}>
        {plan.thin ? (
          <>
            <strong>Not rated yet.</strong> It needs{" "}
            {[
              plan.thin.payersNeeded > 0
                ? `${int(plan.thin.payersNeeded)} more payer${plan.thin.payersNeeded === 1 ? "" : "s"}`
                : null,
              plan.thin.settlementsNeeded > 0
                ? `${int(plan.thin.settlementsNeeded)} more settlement${plan.thin.settlementsNeeded === 1 ? "" : "s"}`
                : null,
              plan.thin.grossNeeded > 0 ? `${usd(plan.thin.grossNeeded)} more in revenue` : null,
            ]
              .filter(Boolean)
              .join(" and ")}{" "}
            before a rating is issued. On today's numbers it would rate{" "}
            <strong>{plan.thin.ratingWhenRated}</strong>.
          </>
        ) : plan.next ? (
          <>
            <strong>
              Rated {plan.rating}, {int(score)} of 100.
            </strong>{" "}
            {plan.next.rating} starts at {plan.next.floor}: {int(plan.next.pointsAway)} point
            {plan.next.pointsAway === 1 ? "" : "s"} away.
          </>
        ) : (
          <>
            <strong>Rated {plan.rating}, the top.</strong> Nothing to raise; below is what would lower it.
          </>
        )}
      </p>

      {plan.levers.length > 0 ? (
        <ul className={styles.flags}>
          {plan.levers.map((l) => (
            <li key={`${l.code}-${l.title}`} className={styles.flag}>
              <span>
                <span className={`${styles.pill} ${l.gain > 0 ? styles.pillGood : ""}`}>
                  {l.gain > 0 ? `+${int(l.gain)}` : "0"}
                </span>
              </span>
              <span className={styles.flagTitle}>{l.title}</span>
              <span className={styles.flagUsd}>
                {int(l.scoreAfter)} · {l.ratingAfter}
              </span>
              <span className={styles.flagDetail}>{l.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {plan.customers && plan.customers.byCount.length > 0 ? (
        <p className={styles.kpiNote} style={{ maxWidth: "80ch" }}>
          With new independent customers at about {usd(plan.customers.typicalUsd)} each:{" "}
          {plan.customers.byCount
            .filter((b) => [1, 5, 25].includes(b.count))
            .map((b) => `${b.count} → ${b.rating} (${b.score})`)
            .join(" · ")}
          .
        </p>
      ) : null}

      {plan.struckOut ? (
        <p className={`${styles.notice}`} style={{ maxWidth: "80ch" }}>
          {usd(plan.struckOut.fundedUsd + plan.struckOut.loopUsd)} of this address's revenue is struck out
          {plan.struckOut.fundedUsd > 0 && plan.struckOut.loopUsd > 0
            ? ` (${usd(plan.struckOut.fundedUsd)} from wallets it funded, ${usd(plan.struckOut.loopUsd)} netted out of a loop)`
            : plan.struckOut.fundedUsd > 0
              ? " (from wallets it funded)"
              : " (netted out of a loop)"}
          . It stays on the record.
          {plan.struckOut.organicNeededForHalf > 0
            ? ` Organic revenue has to grow by ${usd(plan.struckOut.organicNeededForHalf)} before it outweighs what was struck out.`
            : " Organic revenue already outweighs it."}
        </p>
      ) : null}

      {plan.keep.length > 0 ? (
        <div>
          <p style={{ fontWeight: 600, marginBottom: 6 }}>What would lower it</p>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            {plan.keep.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className={styles.kpiNote} style={{ maxWidth: "80ch" }}>
        {plan.note}
      </p>
    </div>
  );
}
