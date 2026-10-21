"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AdminStats, API_PUBLIC } from "@/lib/api";
import { addressUrl, ago, int, short, txUrl, usd, usdFine } from "@/lib/format";
import { Panel } from "./AppShell";
import styles from "./app.module.css";
import { ScreenSkeleton } from "./Skeleton";
import { useToast } from "./Toaster";

const KEY = "assay-admin-key";
const REFRESH_MS = 30_000;
/** Below this the agent wallet cannot keep paying for X searches for long. */
const LOW_USD = 1;
const LOW_CELO = 0.05;

function readKey(): string {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function writeKey(k: string | null) {
  try {
    if (k) sessionStorage.setItem(KEY, k);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Private windows can refuse storage; the key then lasts until the page is closed.
  }
}

type Load =
  | { state: "signed-out"; error?: string }
  | { state: "loading" }
  | { state: "ready"; data: AdminStats; stale?: string };

/**
 * The operator's screen: wallet balances, today's spend against its cap, the X queue, recent
 * paid calls and warnings, the database and the process. The key stays in this tab's session
 * storage and goes only to the Assay API, as a bearer header.
 */
export function AdminView() {
  const [key, setKey] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const last = useRef<AdminStats | null>(null);

  const fetchStats = useCallback(
    async (k: string, manual = false) => {
      if (manual) setBusy(true);
      try {
        const res = await fetch(`${API_PUBLIC}/v1/admin`, {
          headers: { authorization: `Bearer ${k}` },
          cache: "no-store",
        });
        if (res.status === 401) {
          writeKey(null);
          setKey(null);
          last.current = null;
          setLoad({ state: "signed-out", error: "That key was not accepted." });
          return;
        }
        if (res.status === 404) {
          setLoad({ state: "signed-out", error: "The operator view is not switched on for this API." });
          return;
        }
        if (!res.ok) throw new Error(`The API answered ${res.status}.`);
        const data = (await res.json()) as AdminStats;
        last.current = data;
        setLoad({ state: "ready", data });
        if (manual) toast({ tone: "success", title: "Refreshed" });
      } catch (err) {
        const msg =
          err instanceof Error && err.message.startsWith("The API") ? err.message : "The API did not answer.";
        if (last.current) setLoad({ state: "ready", data: last.current, stale: msg });
        else setLoad({ state: "signed-out", error: msg });
        if (manual) toast({ tone: "error", title: "Could not refresh", detail: msg });
      } finally {
        if (manual) setBusy(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    const k = readKey();
    if (k) {
      setKey(k);
      void fetchStats(k);
    } else setLoad({ state: "signed-out" });
  }, [fetchStats]);

  // Refresh while the tab is visible; a hidden tab waits and refreshes when it comes back.
  useEffect(() => {
    if (!key) return;
    const tick = () => {
      if (document.visibilityState === "visible") void fetchStats(key);
    };
    const id = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [key, fetchStats]);

  const signIn = (e: React.FormEvent) => {
    e.preventDefault();
    const k = draft.trim();
    if (!k) return;
    writeKey(k);
    setKey(k);
    setDraft("");
    setLoad({ state: "loading" });
    void fetchStats(k);
  };

  const signOut = () => {
    writeKey(null);
    setKey(null);
    last.current = null;
    setLoad({ state: "signed-out" });
  };

  if (load.state === "loading")
    return <ScreenSkeleton label="Loading the operator view" figures={4} panels={[8, 4]} />;

  if (load.state === "signed-out") {
    return (
      <div className={styles.errorState}>
        <h1 className={styles.title}>Operator</h1>
        <p>
          Wallets, budgets, warnings and the process behind Assay. The public numbers are on{" "}
          <Link className="link" href="/stats">
            Stats
          </Link>
          .
        </p>
        <form className={styles.form} onSubmit={signIn} style={{ maxWidth: 420 }}>
          <label>
            Admin key
            <input
              type="password"
              autoComplete="current-password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              required
              minLength={24}
            />
          </label>
          {load.error ? (
            <p className={`${styles.notice} ${styles.noticeBad}`} role="alert">
              {load.error}
            </p>
          ) : null}
          <div>
            <button type="submit" className="btn btn--ink">
              Open
            </button>
          </div>
        </form>
      </div>
    );
  }

  const d = load.data;
  const agent = d.wallets[0];
  const low = d.wallets.filter(
    (w) =>
      w.role.startsWith("Agent") &&
      ((w.celo !== null && w.celo < LOW_CELO) ||
        w.tokens.every((t) => t.balance === null || t.balance < LOW_USD)),
  );
  const errors = d.problems.filter((p) => p.level === "error").length;

  return (
    <>
      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Operator</h1>
          <p className={styles.finding}>
            {low.length > 0
              ? "The agent wallet is low. Top it up or X searches will stop."
              : errors > 0
                ? `${int(errors)} error${errors === 1 ? "" : "s"} logged since the last restart.`
                : "Everything is running."}{" "}
            Updated {ago(Math.floor(d.asOf / 1000))}, refreshes every 30 seconds.
          </p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className="btn btn--ink"
            disabled={busy}
            onClick={() => key && void fetchStats(key, true)}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="btn btn--quiet" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      {load.stale ? (
        <p className={`${styles.notice} ${styles.noticeBad}`} role="alert" style={{ gridColumn: "1 / -1" }}>
          {load.stale} Showing the last answer.
        </p>
      ) : null}

      <div className={styles.kpis} style={{ "--n": 4 } as React.CSSProperties}>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Agent wallet USD</p>
          <p className={`${styles.kpiValue} ${styles.kpiLead} ${styles.kpiData}`}>
            {agent ? usd(agent.tokens.reduce((n, t) => n + (t.balance ?? 0), 0)) : "–"}
          </p>
          <p className={styles.kpiNote}>
            {agent
              ? agent.celo === null
                ? "CELO balance did not load"
                : `${agent.celo.toFixed(3)} CELO for gas`
              : "no agent key set"}
          </p>
        </div>
        {d.budgets.map((b) => (
          <div className={styles.kpi} key={b.service}>
            <p className={styles.kpiLabel}>Spent today</p>
            <p className={styles.kpiValue}>{usdFine(b.spentUsd)}</p>
            <p className={styles.kpiNote}>
              of {usdFine(b.capUsd)} cap, {int(b.calls)} calls{b.failed ? `, ${int(b.failed)} unpaid` : ""}
            </p>
          </div>
        ))}
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>X queue</p>
          <p className={styles.kpiValue}>{int(d.x.wanted)}</p>
          <p className={styles.kpiNote}>
            asked for, {int(d.x.neverSearched)} sellers never searched
            {d.x.errorsToday ? `, ${int(d.x.errorsToday)} errors today` : ""}
          </p>
        </div>
        <div className={styles.kpi}>
          <p className={styles.kpiLabel}>Process</p>
          <p className={styles.kpiValue}>{int(d.process.rssMb)} MB</p>
          <p className={styles.kpiNote}>
            up{" "}
            {d.process.uptimeMin < 120
              ? `${int(d.process.uptimeMin)} min`
              : `${int(d.process.uptimeMin / 60)} h`}
            {d.process.region ? `, ${d.process.region}` : ""}
          </p>
        </div>
      </div>

      <Panel title="Wallets" span={12}>
        {d.wallets.length === 0 ? (
          <p className={styles.empty}>No wallets configured.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Wallet</th>
                  <th scope="col" className={styles.r}>
                    CELO
                  </th>
                  {d.wallets[0]!.tokens.map((t) => (
                    <th scope="col" className={styles.r} key={t.symbol}>
                      {t.symbol}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.wallets.map((w) => (
                  <tr key={w.address}>
                    <td>
                      <a className="link" href={addressUrl(w.address)} target="_blank" rel="noreferrer">
                        {short(w.address)}
                      </a>
                      <div>{w.role.split(":")[0]}</div>
                      <div className={`${styles.muted} ${styles.hideSm}`}>
                        {w.role.split(":").slice(1).join(":").trim()}
                      </div>
                    </td>
                    <td className={styles.r}>{w.celo === null ? "–" : w.celo.toFixed(3)}</td>
                    {w.tokens.map((t) => (
                      <td className={styles.r} key={t.symbol}>
                        {t.balance === null ? "–" : t.balance.toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Recent paid calls" span={8}>
        {d.recentPaidCalls.length === 0 ? (
          <p className={styles.empty}>No paid calls yet.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Service</th>
                  <th scope="col">Result</th>
                  <th scope="col" className={styles.r}>
                    Paid
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.recentPaidCalls.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.txHash ? (
                        <a className="link" href={txUrl(c.txHash)} target="_blank" rel="noreferrer">
                          {ago(c.ts)}
                        </a>
                      ) : (
                        ago(c.ts)
                      )}
                    </td>
                    <td>{c.service}</td>
                    <td>
                      <span
                        className={`${styles.pill} ${c.status === 200 && c.txHash ? styles.pillGood : c.txHash ? styles.pillWarn : styles.pillBad}`}
                      >
                        {c.status || "no answer"}
                      </span>
                      {c.note ? <div className={styles.muted}>{c.note}</div> : null}
                    </td>
                    <td className={styles.r}>{c.txHash ? usdFine(c.usd) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Database and process" span={4}>
        <dl className={styles.facts}>
          <dt>Database</dt>
          <dd>{d.database.sizeMb.toLocaleString("en-US")} MB</dd>
          <dt>Settlements</dt>
          <dd>{int(d.database.settlements)}</dd>
          <dt>Agents</dt>
          <dd>{int(d.database.agents)}</dd>
          <dt>Heap</dt>
          <dd>{int(d.process.heapMb)} MB</dd>
          <dt>Node</dt>
          <dd>{d.process.node}</dd>
          <dt>Role</dt>
          <dd>{d.process.role}</dd>
          <dt>Image</dt>
          <dd className={styles.addr}>{d.process.image ?? "–"}</dd>
        </dl>
      </Panel>

      <Panel title="Warnings and errors since restart" span={12}>
        {d.problems.length === 0 ? (
          <p className={styles.empty}>Nothing logged.</p>
        ) : (
          <ul className={styles.flags}>
            {d.problems.map((p) => (
              <li key={p.id} className={styles.flag}>
                <span className={`${styles.pill} ${p.level === "error" ? styles.pillBad : styles.pillWarn}`}>
                  {p.level}
                </span>
                <span className={styles.flagTitle}>{p.msg}</span>
                <span className={styles.muted}>{ago(Math.floor(Date.parse(p.t) / 1000))}</span>
                {p.fields && Object.keys(p.fields).length > 0 ? (
                  <code className={`${styles.flagDetail} ${styles.addr}`} style={{ fontSize: "0.8125rem" }}>
                    {JSON.stringify(p.fields)}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
