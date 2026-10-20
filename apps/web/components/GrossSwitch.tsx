"use client";

import { useState } from "react";
import { usd } from "@/lib/format";
import styles from "./grossswitch.module.css";

/**
 * The showcase's one control at poster size: a two-way switch between gross and organic
 * x402 volume. Flipping it swaps the field colour and one word of the heading. Without
 * script it shows both figures as plain text.
 */
export function GrossSwitch({
  grossUsd,
  organicUsd,
  settlements,
}: {
  grossUsd: number;
  organicUsd: number;
  settlements: number;
}) {
  const [mode, setMode] = useState<"gross" | "organic">("gross");
  const value = mode === "gross" ? grossUsd : organicUsd;
  return (
    <section
      className={`${styles.field} ${mode === "organic" ? styles.organicField : ""}`}
      id="gross"
      aria-labelledby="gross-h"
    >
      <div className={styles.copy}>
        <h2 id="gross-h" className={styles.head} data-reveal="0">
          Celo x402, <span aria-live="polite">{mode}</span>
        </h2>
        <p className={styles.sentence} data-reveal="1">
          Flip it. Every x402 payment settled on Celo, {settlements.toLocaleString("en-US")} of them, before
          and after the assay.
        </p>
      </div>
      <fieldset className={styles.control} data-ui>
        <legend className="sr-only">Volume shown</legend>
        <div className={styles.track}>
          <button
            type="button"
            aria-pressed={mode === "gross"}
            className={styles.seg}
            onClick={() => setMode("gross")}
          >
            Gross
          </button>
          <button
            type="button"
            aria-pressed={mode === "organic"}
            className={styles.seg}
            onClick={() => setMode("organic")}
          >
            Organic
          </button>
        </div>
        <p className={styles.value}>{usd(value)}</p>
      </fieldset>
      <noscript>
        <p className={styles.fallback}>
          Gross {usd(grossUsd)} · organic {usd(organicUsd)}
        </p>
      </noscript>
    </section>
  );
}
