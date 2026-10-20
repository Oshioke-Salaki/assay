"use client";

import { useState } from "react";
import type { DailyPoint } from "@/lib/api";
import { dayLabel, usd } from "@/lib/format";
import { labelIndexes, niceTicks } from "@/lib/ticks";
import styles from "./app.module.css";

const W = 1040;
const H = 220;
const PAD = { l: 56, r: 8, t: 8, b: 28 };

/**
 * x402 volume per UTC day. One series at a time, switched with a control, each on its own
 * scale: on one shared scale the organic columns are too small to see, which is the finding,
 * so the switch keeps both honest instead of hiding one.
 */
export function DailyChart({ points }: { points: DailyPoint[] }) {
  const [series, setSeries] = useState<"organicUsd" | "grossUsd">("organicUsd");
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) {
    return <p className={styles.empty}>No settlements indexed yet.</p>;
  }
  const values = points.map((p) => p[series]);
  const ticks = niceTicks(Math.max(...values, 0));
  const top = ticks[ticks.length - 1]!;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = iw / points.length;
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const labels = labelIndexes(points.length);
  const h = hover !== null ? points[hover] : null;

  return (
    <div>
      <div className={styles.panelHead}>
        <div className={styles.legend} aria-live="polite">
          {h ? (
            <span>
              {dayLabel(h.day)}: {usd(h.organicUsd)} organic of {usd(h.grossUsd)} gross,{" "}
              {h.settlements.toLocaleString("en-US")} settlements
            </span>
          ) : (
            <span>
              <span
                className={styles.dot}
                style={{ background: series === "organicUsd" ? "var(--data)" : "#9a9ca2" }}
              />
              {series === "organicUsd" ? "Organic per day" : "Gross per day"}
            </span>
          )}
        </div>
        <fieldset style={{ display: "flex", gap: 4, margin: 0, padding: 0, border: 0 }}>
          <legend className="sr-only">Series</legend>
          {(
            [
              ["organicUsd", "Organic"],
              ["grossUsd", "Gross"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={series === k}
              className={`btn ${series === k ? "btn--ink" : "btn--quiet"}`}
              style={{ minHeight: 30, fontSize: "0.8125rem", padding: "0 12px", ["--cut" as string]: "6px" }}
              onClick={() => setSeries(k)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${series === "organicUsd" ? "Organic" : "Gross"} x402 volume per day, ${dayLabel(points[0]!.day)} to ${dayLabel(points[points.length - 1]!.day)}`}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "#141414" : "#e5e5e5"}
              strokeWidth={t === 0 ? 1.5 : 1}
            />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize="12" fill="#5f6168">
              {usd(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const v = p[series];
          const x = PAD.l + i * bw;
          return (
            <g key={p.day} onPointerEnter={() => setHover(i)}>
              <rect x={x} y={PAD.t} width={bw} height={ih} fill="transparent" />
              <rect
                x={x + bw * 0.15}
                y={y(v)}
                width={Math.max(1, bw * 0.7)}
                height={Math.max(0, PAD.t + ih - y(v))}
                fill={series === "organicUsd" ? "var(--data)" : "#9a9ca2"}
                opacity={hover === null || hover === i ? 1 : 0.45}
              />
            </g>
          );
        })}
        {labels.map((i) => (
          <text
            key={i}
            x={Math.min(W - PAD.r - 20, Math.max(PAD.l + 20, PAD.l + i * bw + bw / 2))}
            y={H - 8}
            textAnchor="middle"
            fontSize="12"
            fill="#5f6168"
          >
            {dayLabel(points[i]!.day)}
          </text>
        ))}
      </svg>
    </div>
  );
}
