import styles from "./app.module.css";

/** Plain-language key for the four punches of a hallmark. */
export function HallmarkKey() {
  return (
    <details className={styles.key}>
      <summary>How to read a hallmark</summary>
      <dl className={styles.facts}>
        <dt>First punch</dt>
        <dd>Assay&rsquo;s mark: this address was tested by Assay.</dd>
        <dt>Number</dt>
        <dd>
          Fineness: how many of every 1,000 dollars it received are organic. 999 means almost all of it came
          from independent payers; 000 means none did.
        </dd>
        <dt>Celo</dt>
        <dd>Where it was tested: Celo mainnet.</dd>
        <dt>Last punch</dt>
        <dd>The rating, AAA (best) to D. NR means there is not enough history yet.</dd>
      </dl>
    </details>
  );
}
