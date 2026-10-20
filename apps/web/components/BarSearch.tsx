"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./app.module.css";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AGENT = /^#?\d{1,12}$/;

/** One box in the app bar: paste an address for its report, or type an agent id like #1853. */
export function BarSearch() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <search className={styles.search}>
      <form
        action="/address"
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          if (ADDRESS.test(v)) router.push(`/address/${v.toLowerCase()}`);
          else if (AGENT.test(v)) router.push(`/agents/${v.replace("#", "")}`);
          else if (v) router.push(`/agents?q=${encodeURIComponent(v)}`);
          else setBad(true);
        }}
      >
        <label htmlFor="bar-search" className="sr-only">
          Search an address, agent id or agent name
        </label>
        <input
          id="bar-search"
          name="a"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setBad(false);
          }}
          placeholder="Address, agent #id or name"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={bad || undefined}
        />
      </form>
    </search>
  );
}
