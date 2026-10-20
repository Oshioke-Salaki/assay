import type { Rating } from "@assay/core";
import { fineness } from "@/lib/format";
import styles from "./hallmark.module.css";
import { LogoMark } from "./Logo";

/**
 * A row of hallmark punches, the way an assay office marks silver:
 * the maker's mark (Assay), the fineness (organic share in parts per thousand),
 * the office mark (Celo) and the date letter, which here is the rating.
 */
export function Hallmark({
  organicUsd,
  grossUsd,
  rating,
  size = "md",
  tone = "light",
  label,
}: {
  organicUsd: number;
  grossUsd: number;
  rating: Rating;
  size?: "sm" | "md" | "lg" | "xl" | "fluid";
  tone?: "light" | "dark" | "accent";
  label?: string;
}) {
  const fine = fineness(organicUsd, grossUsd);
  const words = `${label ? `${label}: ` : ""}rated ${rating === "NR" ? "not rated" : rating}, ${
    fine === null ? "no revenue to assay" : `fineness ${fine} parts per thousand organic`
  }, assayed on Celo`;
  return (
    <span className={`${styles.row} ${styles[size]} ${styles[tone]}`} role="img" aria-label={words}>
      <span className={`${styles.punch} ${styles.maker}`}>
        <LogoMark size={14} color="currentColor" />
      </span>
      <span className={`${styles.punch} ${fine !== null && Number(fine) < 500 ? styles.low : ""}`}>
        {fine ?? "—"}
      </span>
      <span className={`${styles.punch} ${styles.oval}`}>Celo</span>
      <span className={`${styles.punch} ${styles.grade}`} data-rating={rating}>
        {rating}
      </span>
    </span>
  );
}
