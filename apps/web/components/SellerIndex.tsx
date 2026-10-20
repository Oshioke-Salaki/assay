"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { SellerRow } from "@/lib/api";
import { fineness, int, short, usd } from "@/lib/format";
import { Hallmark } from "./Hallmark";
import styles from "./sellerindex.module.css";

/**
 * Sellers ranked by organic revenue. Pointing at (or tabbing to) a row opens one frame level
 * with it, holding that seller's hallmark and its organic share. On touch screens the hallmark
 * sits inside each row instead.
 */
export function SellerIndex({ rows }: { rows: SellerRow[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  const [active, setActive] = useState<{ row: SellerRow; y: number } | null>(null);

  const open = (row: SellerRow, el: HTMLElement) => {
    const list = listRef.current;
    if (!list) return;
    const y = el.offsetTop + el.offsetHeight / 2;
    setActive({ row, y });
  };

  if (rows.length === 0) {
    return (
      <p className={styles.empty}>
        No seller has organic revenue yet. As soon as one does, it is ranked here.
      </p>
    );
  }

  return (
    <div className={styles.index} onPointerLeave={() => setActive(null)}>
      <ol className={styles.list} ref={listRef} data-has-active={active ? "" : undefined}>
        {rows.map((r, i) => (
          <li key={r.address} data-reveal={String(Math.min(i, 6))}>
            <Link
              href={`/address/${r.address}`}
              className={styles.row}
              data-active={active?.row.address === r.address ? "" : undefined}
              onPointerEnter={(e) => open(r, e.currentTarget)}
              onFocus={(e) => open(r, e.currentTarget)}
              onBlur={() => setActive(null)}
            >
              <span className={styles.name}>
                {r.agentIds[0] ? `Agent #${r.agentIds[0]}` : short(r.address)}
              </span>
              <span className={styles.figure}>{usd(r.organicUsd)}</span>
              <span className={styles.meta}>
                {usd(r.grossUsd)} gross · {int(r.organicPayers)} of {int(r.payers)} payers organic
              </span>
            </Link>
          </li>
        ))}
      </ol>
      <div
        className={styles.frame}
        data-open={active ? "" : undefined}
        style={{ transform: `translateY(${Math.max(0, (active?.y ?? 0) - 130)}px)` }}
        aria-hidden="true"
      >
        {active ? (
          <>
            <Hallmark
              organicUsd={active.row.organicUsd}
              grossUsd={active.row.grossUsd}
              rating={active.row.rating}
              size="lg"
            />
            <p className={styles.frameFig}>
              0.{fineness(active.row.organicUsd, active.row.grossUsd) ?? "000"} fine
            </p>
            <p className={styles.frameLine}>
              {usd(active.row.organicUsd)} of {usd(active.row.grossUsd)} is organic, from{" "}
              {int(active.row.organicPayers)} payer
              {active.row.organicPayers === 1 ? "" : "s"} over {int(active.row.settlements)} settlements.
            </p>
            <p className={styles.frameAddr}>{active.row.address}</p>
          </>
        ) : null}
      </div>
    </div>
  );
}
