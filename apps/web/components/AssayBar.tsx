import { usd } from "@/lib/format";
import styles from "./assaybar.module.css";
import { InView } from "./InView";

/**
 * Gross revenue split into what survives the assay (organic, in assay gold) and what is
 * struck out: money offset by the seller's own loop, and money from wallets it funded.
 * Parts always sum to gross: organic = gross − loop − funded.
 */
export function AssayBar({
  grossUsd,
  organicUsd,
  loopOffsetUsd,
  fundedUsd,
  legend = true,
  refine = false,
}: {
  grossUsd: number;
  organicUsd: number;
  loopOffsetUsd: number;
  fundedUsd: number;
  legend?: boolean;
  /** Play the refining once the bar scrolls into view: raw metal first, then what burns off. */
  refine?: boolean;
}) {
  if (!(grossUsd > 0)) {
    return <p className={styles.empty}>No x402 revenue on record, so there is nothing to assay.</p>;
  }
  const parts = [
    { key: "organic", label: "Organic", value: organicUsd, cls: styles.organic },
    { key: "loop", label: "Netted out of a loop", value: loopOffsetUsd, cls: styles.loop },
    { key: "funded", label: "From wallets it funded", value: fundedUsd, cls: styles.funded },
  ];
  // Rounding can leave a sliver unaccounted for; give it to the largest part so the bar closes.
  const shares = parts.map((p) => Math.max(0, p.value) / grossUsd);
  const total = shares.reduce((a, b) => a + b, 0);
  const scaled = shares.map((s) => (total > 0 ? s / total : 0));
  const body = (
    <>
      <div
        className={styles.bar}
        role="img"
        aria-label={`${parts.map((p) => `${p.label} ${usd(p.value)}`).join(", ")} of ${usd(grossUsd)} gross`}
      >
        {parts.map((p, i) =>
          scaled[i]! > 0 ? <span key={p.key} className={p.cls} style={{ flexGrow: scaled[i] }} /> : null,
        )}
      </div>
      {legend ? (
        <ul className={styles.legend}>
          {parts.map((p) => (
            <li key={p.key}>
              <span className={`${styles.swatch} ${p.cls}`} aria-hidden="true" />
              <span>{p.label}</span>
              <span className={styles.value}>{usd(p.value)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
  return refine ? (
    <InView className={`${styles.wrap} ${styles.refine}`}>{body}</InView>
  ) : (
    <div className={styles.wrap} data-ui>
      {body}
    </div>
  );
}
