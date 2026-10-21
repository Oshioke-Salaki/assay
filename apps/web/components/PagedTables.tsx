"use client";

import type { CounterpartyLine, PayerLine } from "assayscore-core";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { date, int, short, usd } from "@/lib/format";
import styles from "./app.module.css";
import paged from "./paged.module.css";
import { SkeletonRows } from "./Skeleton";

const PAGE = 20;

type Status<T> =
  | { kind: "loading"; prev?: Page<T> }
  | { kind: "ready"; page: Page<T> }
  | { kind: "error"; message: string };

interface Page<T> {
  total: number;
  rows: T[];
  counts?: Record<string, number>;
}

/** Fetch one page from the site's own list route, dropping answers to queries that were superseded. */
function usePage<T>(
  address: string,
  list: "payers" | "counterparties",
  params: Record<string, string>,
  retry: number,
  initial?: Page<T>,
) {
  // The server-rendered first page shows at once; the fetch behind it only adds the filter counts.
  const [status, setStatus] = useState<Status<T>>(
    initial ? { kind: "ready", page: initial } : { kind: "loading" },
  );
  const key = JSON.stringify(params);
  const last = useRef<Page<T> | undefined>(initial);
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the serialised params
  useEffect(() => {
    const controller = new AbortController();
    if (!(first.current && initial)) setStatus({ kind: "loading", prev: last.current });
    first.current = false;
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ""));
    fetch(`/api/address/${address}/${list}?${qs}`, { signal: controller.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((body as { message?: string }).message ?? `Request failed (${r.status})`);
        return body as Page<T>;
      })
      .then((page) => {
        last.current = page;
        setStatus({ kind: "ready", page });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({ kind: "error", message: e instanceof Error ? e.message : "Could not load this list." });
      });
    return () => controller.abort();
  }, [address, list, key, retry]);
  return status;
}

/** Typing settles for 250 ms before a search goes out. */
function useDebounced(value: string, ms = 250): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Pager({ offset, total, onPage }: { offset: number; total: number; onPage: (o: number) => void }) {
  if (total <= PAGE) return null;
  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.ceil(total / PAGE);
  return (
    <nav className={paged.pager} aria-label="Pages">
      <button
        type="button"
        className="btn btn--quiet"
        disabled={page <= 1}
        onClick={() => onPage(offset - PAGE)}
      >
        Previous
      </button>
      <span className={styles.muted}>
        Page {page} of {pages}
      </span>
      <button
        type="button"
        className="btn btn--quiet"
        disabled={page >= pages}
        onClick={() => onPage(offset + PAGE)}
      >
        Next
      </button>
    </nav>
  );
}

function Range({
  offset,
  shown,
  total,
  noun,
}: {
  offset: number;
  shown: number;
  total: number;
  noun: string;
}) {
  if (total === 0) return null;
  return (
    <span className={styles.muted}>
      {int(offset + 1)}–{int(offset + shown)} of {int(total)} {noun}
    </span>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={`${styles.notice} ${styles.noticeBad} ${paged.error}`} role="alert">
      <span>{message}</span>
      <button type="button" className="btn btn--quiet" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

const CLASSES: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "organic", label: "Organic" },
  { id: "loop", label: "In its loop" },
  { id: "seller-funded", label: "Seller funded it" },
  { id: "shared-funder", label: "Shares its funder" },
];

const CLASS_LABEL: Record<PayerLine["class"], string> = {
  organic: "Organic",
  loop: "In its loop",
  "seller-funded": "Seller funded it",
  "shared-funder": "Shares its funder",
};

export function PayersTable({
  address,
  total,
  initial,
}: {
  address: string;
  total: number;
  initial?: Page<PayerLine>;
}) {
  const [q, setQ] = useState("");
  const [cls, setCls] = useState("all");
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const query = useDebounced(q.trim().toLowerCase());
  // A new search or filter always starts at the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query and filter change
  useEffect(() => setOffset(0), [query, cls]);
  const status = usePage<PayerLine>(
    address,
    "payers",
    { limit: String(PAGE), offset: String(offset), q: query, class: cls },
    retry,
    initial,
  );
  const page = status.kind === "ready" ? status.page : status.kind === "loading" ? status.prev : undefined;
  const counts = page?.counts;

  if (total === 0) return <p className={styles.empty}>Nobody has paid this address over x402.</p>;

  return (
    <div className={paged.wrap}>
      <div className={paged.tools}>
        <label className="sr-only" htmlFor={`payer-q-${address}`}>
          Search payers by address
        </label>
        <input
          id={`payer-q-${address}`}
          className={paged.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a payer or funder address"
          spellCheck={false}
          autoComplete="off"
        />
        <fieldset className={paged.chips}>
          <legend className="sr-only">Show payers</legend>
          {CLASSES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={paged.chip}
              aria-pressed={cls === c.id}
              onClick={() => setCls(c.id)}
              disabled={counts !== undefined && c.id !== "all" && !counts[c.id]}
            >
              {c.label}
              {counts ? <span className={paged.count}>{int(counts[c.id] ?? 0)}</span> : null}
            </button>
          ))}
        </fieldset>
      </div>

      {status.kind === "error" ? (
        <ErrorRow message={status.message} onRetry={() => setRetry((n) => n + 1)} />
      ) : status.kind === "loading" && !status.prev ? (
        <SkeletonRows rows={8} cols={6} />
      ) : page && page.rows.length === 0 ? (
        <p className={styles.empty}>{query ? `No payer matches “${query}”.` : "No payer in this group."}</p>
      ) : page ? (
        <div
          className={`${styles.scroll} ${status.kind === "loading" ? paged.stale : ""}`}
          aria-busy={status.kind === "loading"}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Payer</th>
                <th>Counted as</th>
                <th className={styles.r}>Paid</th>
                <th className={styles.r}>Counted</th>
                <th className={`${styles.r} ${styles.hideSm}`}>Payments</th>
                <th className={styles.hideSm}>Funded by</th>
                <th className={`${styles.r} ${styles.hideSm}`}>Last</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((l) => (
                <tr key={l.payer}>
                  <td className={paged.who}>
                    <Link href={`/address/${l.payer}`}>{short(l.payer)}</Link>
                    {l.human ? <span className={styles.muted}> · human</span> : null}
                  </td>
                  <td>
                    <span
                      className={`${styles.pill} ${l.class === "organic" ? styles.pillGood : l.class === "loop" ? styles.pillWarn : styles.pillBad}`}
                    >
                      {l.class === "organic" && l.established ? "Organic, established" : CLASS_LABEL[l.class]}
                    </span>
                  </td>
                  <td className={styles.r}>{usd(l.usd)}</td>
                  <td className={styles.r} style={{ color: l.creditedUsd > 0 ? "var(--data)" : undefined }}>
                    {usd(l.creditedUsd)}
                  </td>
                  <td className={`${styles.r} ${styles.hideSm}`}>{int(l.count)}</td>
                  <td className={styles.hideSm}>
                    {l.funder ? (
                      <Link href={`/address/${l.funder}`}>{short(l.funder)}</Link>
                    ) : (
                      <span className={styles.dash}>–</span>
                    )}
                  </td>
                  <td className={`${styles.r} ${styles.hideSm}`}>{date(l.lastTs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {page && page.total > 0 ? (
        <div className={paged.foot}>
          <Range offset={offset} shown={page.rows.length} total={page.total} noun="payers" />
          <Pager offset={offset} total={page.total} onPage={setOffset} />
        </div>
      ) : null}
    </div>
  );
}

export function CounterpartiesTable({
  address,
  total,
  initial,
}: {
  address: string;
  total: number;
  initial?: Page<CounterpartyLine>;
}) {
  const [q, setQ] = useState("");
  const [loopOnly, setLoopOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const query = useDebounced(q.trim().toLowerCase());
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query and filter change
  useEffect(() => setOffset(0), [query, loopOnly]);
  const status = usePage<CounterpartyLine>(
    address,
    "counterparties",
    { limit: String(PAGE), offset: String(offset), q: query, loop: loopOnly ? "1" : "" },
    retry,
    initial,
  );
  const page = status.kind === "ready" ? status.page : status.kind === "loading" ? status.prev : undefined;

  if (total === 0) return null;

  return (
    <div className={paged.wrap}>
      <div className={paged.tools}>
        <label className="sr-only" htmlFor={`cp-q-${address}`}>
          Search sellers by address
        </label>
        <input
          id={`cp-q-${address}`}
          className={paged.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a seller address"
          spellCheck={false}
          autoComplete="off"
        />
        <fieldset className={paged.chips}>
          <legend className="sr-only">Show sellers</legend>
          <button
            type="button"
            className={paged.chip}
            aria-pressed={!loopOnly}
            onClick={() => setLoopOnly(false)}
          >
            All
          </button>
          <button
            type="button"
            className={paged.chip}
            aria-pressed={loopOnly}
            onClick={() => setLoopOnly(true)}
          >
            Pays it back
          </button>
        </fieldset>
      </div>
      {status.kind === "error" ? (
        <ErrorRow message={status.message} onRetry={() => setRetry((n) => n + 1)} />
      ) : status.kind === "loading" && !status.prev ? (
        <SkeletonRows rows={6} cols={5} />
      ) : page && page.rows.length === 0 ? (
        <p className={styles.empty}>{query ? `No seller matches “${query}”.` : "No seller in this group."}</p>
      ) : page ? (
        <div
          className={`${styles.scroll} ${status.kind === "loading" ? paged.stale : ""}`}
          aria-busy={status.kind === "loading"}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Seller</th>
                <th className={styles.r}>Paid</th>
                <th className={`${styles.r} ${styles.hideSm}`}>Payments</th>
                <th>Relationship</th>
                <th className={`${styles.r} ${styles.hideSm}`}>Last</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((x) => (
                <tr key={x.payee}>
                  <td className={paged.who}>
                    <Link href={`/address/${x.payee}`}>{short(x.payee)}</Link>
                  </td>
                  <td className={styles.r}>{usd(x.usd)}</td>
                  <td className={`${styles.r} ${styles.hideSm}`}>{int(x.count)}</td>
                  <td>
                    {x.inLoop ? (
                      <span className={`${styles.pill} ${styles.pillWarn}`}>Pays it back</span>
                    ) : (
                      <span className={styles.muted}>Arm&rsquo;s length</span>
                    )}
                  </td>
                  <td className={`${styles.r} ${styles.hideSm}`}>{date(x.lastTs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {page && page.total > 0 ? (
        <div className={paged.foot}>
          <Range offset={offset} shown={page.rows.length} total={page.total} noun="sellers" />
          <Pager offset={offset} total={page.total} onPage={setOffset} />
        </div>
      ) : null}
    </div>
  );
}
