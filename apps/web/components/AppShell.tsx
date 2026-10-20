import Link from "next/link";
import styles from "./app.module.css";
import { BarSearch } from "./BarSearch";
import { LogoMark } from "./Logo";

const NAV = [
  { href: "/economy", label: "Economy" },
  { href: "/agents", label: "Agents" },
  { href: "/docs", label: "Docs" },
];

/**
 * Ledger shell (no sidebar: four destinations and report-like screens): a 48px bar over a
 * centred column. Grid arithmetic: column max 1120px, 12 tracks with 16px gutters
 * → (1120 − 11 × 16) / 12 = 78.67px per track; every card spans whole tracks so edges land on the column.
 */
export function AppShell({ current, children }: { current?: string; children: React.ReactNode }) {
  return (
    <div className={styles.app}>
      <header className={styles.bar}>
        <div className={styles.barInner}>
          <Link href="/" className={styles.brand}>
            <LogoMark size={22} />
            <span>Assay</span>
            <span className={styles.scope}>Celo mainnet</span>
          </Link>
          <BarSearch />
          <nav aria-label="Main">
            <ul className={styles.nav}>
              {NAV.map((n) => (
                <li key={n.href}>
                  <Link href={n.href} aria-current={current === n.href ? "page" : undefined}>
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main className={styles.canvas}>{children}</main>
      <footer className={styles.foot}>
        <p>
          Assay reads Celo mainnet: x402 settlements, ERC-8004 registries and Self Agent ID.{" "}
          <Link className="link" href="/docs#methodology">
            How scores are made
          </Link>
          .
        </p>
      </footer>
    </div>
  );
}

export function Panel({
  title,
  action,
  children,
  span = 12,
  id,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  span?: 12 | 8 | 6 | 4;
  id?: string;
}) {
  return (
    <section
      className={`${styles.panel} ${styles[`s${span}`]}`}
      id={id}
      aria-label={typeof title === "string" ? title : undefined}
    >
      {title || action ? (
        <div className={styles.panelHead}>
          {title ? <h2 className={styles.panelTitle}>{title}</h2> : null}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function ErrorState({ title, message }: { title: string; message: string }) {
  return (
    <div className={styles.errorState} role="alert">
      <h1 className={styles.title}>{title}</h1>
      <p>{message}</p>
      <p>
        <Link className="link" href="/">
          Back to Assay
        </Link>
      </p>
    </div>
  );
}
