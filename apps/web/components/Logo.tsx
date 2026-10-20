/**
 * The Assay mark: a hallmark punch (a block with its top corners clipped, the same cut as every
 * folder and button on the site) with an A struck out of it. The legs are a notch punched from the
 * base and the counter is a small triangle, so the letter is negative space in solid metal, the way
 * a maker's mark is struck into silver. Drawn on a 100 × 100 grid, even-odd fill.
 */
export const MARK_PATH =
  "M38 0H62L100 38V100H66L50 64L34 100H0V38Z" + // the punch, its shoulders cut deep, legs notched from the base
  "M50 22L59 48H41Z"; // the counter

export function LogoMark({
  size = 28,
  color = "var(--accent)",
  title,
}: {
  size?: number;
  color?: string;
  title?: string;
}) {
  const style = { flex: "none", display: "block" } as const;
  if (!title) {
    // Decorative: the name is always set beside it.
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={style}>
        <path d={MARK_PATH} fill={color} fillRule="evenodd" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" style={style}>
      <title>{title}</title>
      <path d={MARK_PATH} fill={color} fillRule="evenodd" />
    </svg>
  );
}

/** Mark and name together, the name set in the display weight with the mark's height as cap height. */
export function Logo({ size = 26, color = "var(--accent)" }: { size?: number; color?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: size * 0.36 }}>
      <LogoMark size={size} color={color} />
      <span style={{ fontWeight: 800, fontSize: size * 0.82, letterSpacing: "-0.045em", lineHeight: 1 }}>
        Assay
      </span>
    </span>
  );
}
