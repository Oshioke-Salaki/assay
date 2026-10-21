import type { Stats } from "@/lib/api";
import { dayLabel, int } from "@/lib/format";
import { labelIndexes, niceTicks } from "@/lib/ticks";
import styles from "./app.module.css";

const W = 1040;
const H = 200;
const PAD = { l: 48, r: 8, t: 8, b: 28 };

type Day = NonNullable<Stats["usage"]>["days"][number];

/** The three parts of a day's use, bottom to top: paid answers, free reports, everything else. */
export function usageParts(d: Day) {
  const c = d.counts;
  const paid = c.check_paid + c.attest_paid;
  const reports = c.report;
  const other = c.check_quoted + c.attest_quoted + c.agents + c.economy + c.api_other;
  return { paid, reports, other, total: paid + reports + other };
}

const SERIES = [
  { key: "paid", label: "Paid checks and scores", color: "var(--ink)" },
  { key: "reports", label: "Address reports", color: "var(--data)" },
  { key: "other", label: "Other reads and price quotes", color: "#9a9ca2" },
] as const;

/**
 * API requests per UTC day, stacked. Server-drawn: each column carries a native tooltip, so the
 * chart needs no script. Turned-away requests are left out; they are not use.
 */
export function UsageChart({ days }: { days: Day[] }) {
  const parts = days.map(usageParts);
  if (parts.every((p) => p.total === 0)) {
    return <p className={styles.empty}>No requests counted yet. Counting started with this release.</p>;
  }
  const ticks = niceTicks(Math.max(4, ...parts.map((p) => p.total)));
  const top = ticks[ticks.length - 1]!;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = iw / days.length;
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const labels = labelIndexes(days.length);

  return (
    <div>
      <div className={styles.legend} style={{ flexWrap: "wrap", marginBottom: 8 }}>
        {SERIES.map((s) => (
          <span key={s.key}>
            <span className={styles.dot} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`API requests per day, ${dayLabel(days[0]!.day)} to ${dayLabel(days[days.length - 1]!.day)}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--app-rule)" />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--app-muted)">
              {int(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const p = parts[i]!;
          const x = PAD.l + i * bw + bw * 0.15;
          let base = 0;
          return (
            <g key={d.day}>
              <title>
                {`${dayLabel(d.day)}: ${int(p.total)} requests (${int(p.paid)} paid, ${int(p.reports)} reports, ${int(p.other)} other) from ${int(d.visitors)} caller${d.visitors === 1 ? "" : "s"}`}
              </title>
              <rect x={PAD.l + i * bw} y={PAD.t} width={bw} height={ih} fill="transparent" />
              {SERIES.map((s) => {
                const v = p[s.key];
                if (v === 0) return null;
                const y0 = y(base);
                base += v;
                return (
                  <rect key={s.key} x={x} y={y(base)} width={bw * 0.7} height={y0 - y(base)} fill={s.color} />
                );
              })}
            </g>
          );
        })}
        {labels.map((i) => (
          <text
            key={i}
            x={PAD.l + i * bw + bw / 2}
            y={H - 8}
            textAnchor="middle"
            fontSize="11"
            fill="var(--app-muted)"
          >
            {dayLabel(days[i]!.day)}
          </text>
        ))}
      </svg>
    </div>
  );
}
