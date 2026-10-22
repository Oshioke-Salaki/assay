"use client";

import { isAddress } from "assayscore-core";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "@/components/app.module.css";

/** "Which address is yours?" then straight to that report's claim section. */
export function ClaimLookup() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <form
      className={styles.actions}
      style={{ alignItems: "end", gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        const a = value.trim();
        if (!isAddress(a)) {
          setBad(true);
          return;
        }
        router.push(`/address/${a.toLowerCase()}#claim`);
      }}
    >
      <label style={{ display: "grid", gap: 4, fontSize: "0.8125rem", fontWeight: 600 }}>
        Your seller address
        <input
          className={bad ? styles.inputBad : undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setBad(false);
          }}
          placeholder="0x…"
          inputMode="text"
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
          aria-invalid={bad}
          aria-describedby={bad ? "claim-lookup-error" : undefined}
        />
      </label>
      <button type="submit" className="btn btn--ink">
        Claim your page
      </button>
      {bad ? (
        <span id="claim-lookup-error" className={styles.muted} role="alert" style={{ alignSelf: "center" }}>
          That is not a Celo address.
        </span>
      ) : null}
    </form>
  );
}
