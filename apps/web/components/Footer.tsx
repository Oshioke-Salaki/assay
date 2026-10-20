import Link from "next/link";
import credits from "@/lib/credits.json";
import styles from "./footer.module.css";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/economy", label: "Economy" },
      { href: "/agents", label: "Agents" },
      { href: "/#assay", label: "Assay an address" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/docs", label: "Docs" },
      { href: "/docs#api", label: "API" },
      { href: "/docs#guard", label: "SDK guard" },
      { href: "/docs#mcp", label: "MCP server" },
    ],
  },
  {
    title: "Onchain",
    links: [
      { href: "/docs#registry", label: "AssayRegistry" },
      { href: "/docs#methodology", label: "Methodology" },
      { href: "https://github.com/Oshioke-Salaki/assay", label: "GitHub" },
    ],
  },
];

const LETTERS: { ch: string; h: number; bg: string; fg: string }[] = [
  { ch: "A", h: 100, bg: "var(--accent)", fg: "var(--accent-ink)" },
  { ch: "S", h: 78, bg: "var(--silver)", fg: "var(--ink)" },
  { ch: "S", h: 88, bg: "var(--gold)", fg: "var(--ink)" },
  { ch: "A", h: 66, bg: "var(--ash)", fg: "var(--ink)" },
  { ch: "Y", h: 94, bg: "var(--slate)", fg: "var(--ink-on-dark)" },
];

interface Credit {
  title: string;
  creator?: string | null;
  license?: string;
  page?: string;
  sourcePage?: string;
}

/** The close: the name built from punch blocks, then plain links and the picture credits. */
export function Footer() {
  const list = (
    Array.isArray(credits) ? credits : Object.values(credits as Record<string, Credit>)
  ) as Credit[];
  return (
    <footer className={styles.footer}>
      <div className={styles.word} aria-label="Assay" role="img">
        {LETTERS.map((l, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: letters repeat; position is the identity
            key={i}
            className={styles.block}
            style={{ height: `${l.h}%`, background: l.bg, color: l.fg }}
            aria-hidden="true"
            data-reveal={String(i)}
          >
            {l.ch}
          </span>
        ))}
      </div>
      <div className={styles.cols}>
        {COLUMNS.map((c) => (
          <div key={c.title}>
            <h2 className={styles.colTitle}>{c.title}</h2>
            <ul>
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href}>{l.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className={styles.contact}>
          <h2 className={styles.colTitle}>Network</h2>
          <p>Celo mainnet, chain 42220. Reads x402 settlements, ERC-8004 registries and Self Agent ID.</p>
        </div>
      </div>
      <p className={styles.credits}>
        Pictures:{" "}
        {list.map((c, i) => (
          <span key={c.title}>
            <a href={c.page ?? c.sourcePage} className="link">
              {c.title}
            </a>
            {c.creator ? ` by ${c.creator}` : ""}, {c.license}
            {i < list.length - 1 ? "; " : "."}
          </span>
        ))}
      </p>
      <div className={styles.last}>
        <p>© 2026 Assay. Open source under MIT.</p>
        <Link href="/#assay" className="btn">
          Assay an address
        </Link>
      </div>
    </footer>
  );
}
