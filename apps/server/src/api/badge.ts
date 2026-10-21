import type { Assessment, Rating } from "assayscore-core";
import { verdictFor } from "assayscore-core";

const COLOUR = { pass: "#1f7a3a", caution: "#7a5a00", block: "#b42318", none: "#5d6068" } as const;

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * A small badge for READMEs and docs: "Assay | A · 0.925 fine" in the verdict's colour. Built
 * from text we wrote ourselves, escaped anyway. Width grows with the text so nothing is cut.
 */
export function badgeSvg(a: Assessment): string {
  const check = verdictFor(a);
  const rating: Rating = a.rating;
  const gross = a.seller.grossUsd;
  const fine = gross > 0 ? Math.min(999, Math.floor((a.seller.organicUsd / gross) * 1000)) : null;
  const right =
    a.role === "none" || a.role === "buyer"
      ? "no x402 revenue"
      : rating === "NR"
        ? "not rated yet"
        : `${rating} · 0.${String(fine ?? 0).padStart(3, "0")} fine`;
  const colour = a.role === "none" || a.role === "buyer" ? COLOUR.none : COLOUR[check.verdict];
  const left = "Assay";
  const lw = 48;
  const rw = Math.round(right.length * 6.6) + 16;
  const w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(`${left}: ${right}`)}">
<title>${esc(`${left}: ${right}`)}</title>
<rect width="${lw}" height="20" fill="#141414"/>
<rect x="${lw}" width="${rw}" height="20" fill="${colour}"/>
<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
<text x="${lw / 2}" y="14">${esc(left)}</text>
<text x="${lw + rw / 2}" y="14">${esc(right)}</text>
</g>
</svg>`;
}
