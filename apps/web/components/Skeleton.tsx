import styles from "./skeleton.module.css";

/** A placeholder block shaped like the content it stands in for. */
export function Skeleton({ w = "100%", h = 14, r = 4 }: { w?: number | string; h?: number; r?: number }) {
  return <span className={styles.bone} style={{ width: w, height: h, borderRadius: r }} aria-hidden="true" />;
}

/** Rows shaped like a table body, for lists while a page loads. */
export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className={styles.rows} aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={r} className={styles.row} style={{ gridTemplateColumns: `2fr repeat(${cols - 1}, 1fr)` }}>
          {Array.from({ length: cols }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
            <Skeleton key={c} w={c === 0 ? "70%" : "55%"} h={12} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The shape of an app screen while its data loads: a title, a row of figures, then panels of rows. */
export function ScreenSkeleton({
  label,
  figures = 4,
  panels = [8],
}: {
  label: string;
  figures?: number;
  panels?: number[];
}) {
  return (
    <div className={styles.screen} role="status" aria-label={label}>
      <div className={styles.head}>
        <Skeleton w="38%" h={30} r={6} />
        <Skeleton w="62%" h={14} />
      </div>
      {figures > 0 ? (
        <div className={styles.figures}>
          {Array.from({ length: figures }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder tiles
            <div key={i} className={styles.panel}>
              <Skeleton w="45%" h={11} />
              <Skeleton w="70%" h={26} r={6} />
            </div>
          ))}
        </div>
      ) : null}
      {panels.map((rows, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder panels
        <div key={i} className={styles.panel}>
          <Skeleton w={160} h={16} />
          <SkeletonRows rows={rows} />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
