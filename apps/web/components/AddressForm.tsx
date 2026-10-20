"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import styles from "./addressform.module.css";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Paste an address, go to its report. Validates before navigating and says what is wrong. */
export function AddressForm({
  tone = "light",
  label = "Paste a Celo address",
  button = "Assay it",
}: {
  tone?: "light" | "dark" | "accent";
  label?: string;
  button?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!ADDRESS.test(v)) {
      setError(
        v.length === 0
          ? "Paste an address first."
          : v.startsWith("0x") && v.length !== 42
            ? `That is ${v.length} characters; an address is 42 (0x and 40 hex digits).`
            : "That is not a Celo address. It should start with 0x and have 40 hex digits.",
      );
      return;
    }
    setError(null);
    setBusy(true);
    router.push(`/address/${v.toLowerCase()}`);
  }

  return (
    <form className={`${styles.form} ${styles[tone]}`} onSubmit={submit} noValidate action="/address">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className={styles.field}>
        <input
          id={id}
          name="a"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder={label}
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Assaying…" : button}
        </button>
      </div>
      <p id={`${id}-err`} className={styles.error} role="alert">
        {error ?? ""}
      </p>
    </form>
  );
}
