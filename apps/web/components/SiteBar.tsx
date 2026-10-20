import Link from "next/link";
import { LogoMark } from "./Logo";
import styles from "./sitebar.module.css";

const LINKS = [
  { href: "/economy", label: "Economy" },
  { href: "/agents", label: "Agents" },
  { href: "/docs", label: "Docs" },
];

/** One plain bar: mark and name, three links, one action. `tone` follows the ground it sits on. */
export function SiteBar({ tone = "dark", current }: { tone?: "dark" | "light"; current?: string }) {
  return (
    <header className={`${styles.bar} ${styles[tone]}`}>
      <Link href="/" className={styles.brand} aria-label="Assay home">
        <LogoMark size={28} />
        <span>Assay</span>
      </Link>
      <nav aria-label="Main">
        <ul className={styles.links}>
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} aria-current={current === l.href ? "page" : undefined}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Link href="/#assay" className={`btn ${styles.cta}`}>
        Assay an address
      </Link>
    </header>
  );
}
