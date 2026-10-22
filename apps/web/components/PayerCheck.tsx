"use client";

import { isAddress, type PayerCheck as PayerCheckResult } from "assayscore-core";
import Link from "next/link";
import { useState } from "react";
import styles from "@/components/app.module.css";
import { API_PUBLIC } from "@/lib/api";
import { date, short, usd } from "@/lib/format";

const PILL: Record<PayerCheckResult["verdict"], string> = {
  established: styles.pillGood!,
  new: styles.pill!,
  caution: styles.pillWarn!,
  block: styles.pillBad!,
};
const WORD: Record<PayerCheckResult["verdict"], string> = {
  established: "Established customer",
  new: "New wallet",
  caution: "Caution",
  block: "Do not treat as a customer",
};

/**
 * For sellers: before a refund, an allowance or credit, is this payer a real wallet or a sock?
 * Asks the API with this report's address as the seller, so the answer includes how the payer
 * stands to it.
 */
export function PayerCheck({ seller }: { seller: `0x${string}` }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PayerCheckResult | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    const a = value.trim();
    if (!isAddress(a)) {
      setError("That is not a Celo address.");
      return;
    }
    try {
      setBusy(true);
      const res = await fetch(`${API_PUBLIC}/v1/payer/${a.toLowerCase()}?seller=${seller}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Assay answered ${res.status}.`);
      setResult((await res.json()) as PayerCheckResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The API did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ maxWidth: "72ch" }}>
        Before a refund, an allowance or credit: is this payer a real wallet or a sock? Paste its address. The
        answer uses its whole record on Celo and how it stands to this address.
      </p>
      <form className={styles.actions} style={{ alignItems: "end", gap: 8 }} onSubmit={run}>
        <label style={{ display: "grid", gap: 4, fontSize: "0.8125rem", fontWeight: 600 }}>
          Payer address
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            style={{
              minWidth: 260,
              minHeight: 40,
              padding: "8px 12px",
              border: "1px solid #cfd1d5",
              borderRadius: 6,
              fontWeight: 400,
            }}
          />
        </label>
        <button type="submit" className="btn btn--ink" disabled={busy}>
          {busy ? "Checking…" : "Check payer"}
        </button>
      </form>
      {error ? (
        <p role="alert" className={`${styles.notice} ${styles.noticeBad}`}>
          {error}
        </p>
      ) : null}
      {result ? (
        <div role="status" aria-live="polite" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <span className={`${styles.pill} ${PILL[result.verdict]}`}>{WORD[result.verdict]}</span>
            <Link className="link" href={`/address/${result.address}`}>
              {short(result.address)}
            </Link>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            {result.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <dl className={styles.facts}>
            <dt>Spent over x402</dt>
            <dd>
              {usd(result.spentUsd)}{" "}
              <span className={styles.muted}>
                to {result.sellers} seller{result.sellers === 1 ? "" : "s"}
              </span>
            </dd>
            {result.withSeller && result.withSeller.count > 0 ? (
              <>
                <dt>Paid this address</dt>
                <dd>
                  {usd(result.withSeller.paidUsd)}{" "}
                  <span className={styles.muted}>
                    in {result.withSeller.count} payment{result.withSeller.count === 1 ? "" : "s"}, last{" "}
                    {date(result.withSeller.lastTs)}
                  </span>
                </dd>
              </>
            ) : null}
            <dt>First seen on Celo</dt>
            <dd>
              {result.firstSeenAt ? (
                date(result.firstSeenAt)
              ) : (
                <span className={styles.dash}>not traced yet</span>
              )}
            </dd>
            <dt>First funded by</dt>
            <dd>
              {result.funder ? (
                <>
                  <Link className="link" href={`/address/${result.funder.address}`}>
                    {short(result.funder.address)}
                  </Link>
                  <span className={styles.muted}>
                    {result.funder.public ? " · a public source" : " · a private wallet"}
                  </span>
                </>
              ) : (
                <span className={styles.dash}>unknown</span>
              )}
            </dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
