import { RATING_FLOORS, SELLER_CATEGORIES } from "assayscore-core";
import type { Metadata } from "next";
import Link from "next/link";
import { AppShell, Panel } from "@/components/AppShell";
import styles from "@/components/app.module.css";
import { ClaimLookup } from "@/components/ClaimLookup";
import { Hallmark } from "@/components/Hallmark";
import { type SellerRow, tryApi } from "@/lib/api";
import { ago, int, short, usd } from "@/lib/format";

export const metadata: Metadata = {
  title: "Sellers on Celo",
  description: "Every x402 seller on Celo, ranked by revenue from customers it does not control.",
};
export const revalidate = 30;

const PAGE = 50;
const FLOORS = ["BBB", "BB", "B"] as const;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

export default async function SellersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = one(sp.q).slice(0, 80);
  const minRating = (FLOORS as readonly string[]).includes(one(sp.min)) ? one(sp.min) : "";
  const category = (SELLER_CATEGORIES as readonly string[]).includes(one(sp.category))
    ? one(sp.category)
    : "";
  const claimed = one(sp.claimed) === "1";
  const offset = Math.max(0, Math.min(100_000, Number.parseInt(one(sp.offset), 10) || 0));
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort: "organic" });
  if (q) params.set("q", q);
  if (minRating) params.set("minRating", minRating);
  if (category) params.set("category", category);
  if (claimed) params.set("claimed", "1");
  const data = await tryApi<{ total: number; rows: SellerRow[] }>(`/v1/sellers?${params}`);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const filtering = Boolean(q || minRating || category || claimed);
  const pageLink = (o: number) => {
    const p = new URLSearchParams(params);
    p.delete("limit");
    p.delete("sort");
    p.set("offset", String(o));
    return `/sellers?${p}`;
  };

  return (
    <AppShell current="/sellers">
      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Sellers on Celo</h1>
          <p className={styles.finding}>
            Every seller paid over x402, ranked by what it earned from customers it does not control. Sellers
            who claimed their page show their name and what they sell. Agents can search the same list with{" "}
            <code>assay_find_sellers</code>.
          </p>
        </div>
        <ClaimLookup />
      </div>

      <Panel span={12}>
        <form
          method="get"
          action="/sellers"
          className={styles.form}
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", alignItems: "end" }}
        >
          <label>
            Search
            <input name="q" defaultValue={q} maxLength={80} placeholder="name, what they sell, or 0x…" />
          </label>
          <label>
            Rating at least
            <select name="min" defaultValue={minRating}>
              <option value="">Any</option>
              {FLOORS.map((r) => (
                <option key={r} value={r}>
                  {r} or better
                </option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select name="category" defaultValue={category}>
              <option value="">Any</option>
              {SELLER_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 40 }}>
            <input
              type="checkbox"
              name="claimed"
              value="1"
              defaultChecked={claimed}
              style={{ width: "auto", minHeight: 0 }}
            />
            Claimed pages only
          </label>
          <div className={styles.actions}>
            <button type="submit" className="btn btn--ink">
              Show
            </button>
            {filtering ? (
              <Link href="/sellers" className="btn btn--quiet">
                Clear
              </Link>
            ) : null}
          </div>
        </form>
      </Panel>

      <Panel
        title={filtering ? `${int(total)} match${total === 1 ? "" : "es"}` : `${int(total)} sellers`}
        span={12}
        action={
          <span className={styles.muted}>
            {total > 0 ? `${int(offset + 1)} to ${int(Math.min(total, offset + PAGE))}` : ""}
          </span>
        }
      >
        {!data ? (
          <p className={styles.empty}>The Assay API did not answer. Try again in a minute.</p>
        ) : rows.length === 0 ? (
          <p className={styles.empty}>
            {filtering
              ? "No seller matches that. Try fewer filters."
              : "No seller has been paid over x402 yet."}
          </p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Seller</th>
                  <th scope="col">Rating</th>
                  <th scope="col" className={styles.r}>
                    Organic
                  </th>
                  <th scope="col" className={`${styles.r} ${styles.hideSm}`}>
                    Payers
                  </th>
                  <th scope="col" className={`${styles.r} ${styles.hideSm}`}>
                    Last paid
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.address}>
                    <td>
                      <Link href={`/address/${s.address}`}>
                        {s.name ?? (s.agentIds[0] ? `Agent #${s.agentIds[0]}` : short(s.address))}
                      </Link>
                      {s.what ? <div className={styles.muted}>{s.what}</div> : null}
                      {s.name || s.agentIds[0] ? (
                        <div className={styles.muted}>
                          {short(s.address)}
                          {s.category ? ` · ${s.category}` : ""}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <Hallmark organicUsd={s.organicUsd} grossUsd={s.grossUsd} rating={s.rating} size="sm" />
                    </td>
                    <td className={styles.r}>
                      {usd(s.organicUsd)}
                      <div className={styles.muted}>of {usd(s.grossUsd)}</div>
                    </td>
                    <td className={`${styles.r} ${styles.hideSm}`}>
                      {int(s.organicPayers)}
                      <span className={styles.muted}> / {int(s.payers)}</span>
                    </td>
                    <td className={`${styles.r} ${styles.hideSm}`}>{ago(s.lastTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE ? (
          <div className={styles.actions} style={{ marginTop: 16 }}>
            {offset > 0 ? (
              <Link className="btn btn--quiet" href={pageLink(Math.max(0, offset - PAGE))}>
                Previous
              </Link>
            ) : null}
            {offset + PAGE < total ? (
              <Link className="btn btn--quiet" href={pageLink(offset + PAGE)}>
                Next
              </Link>
            ) : null}
          </div>
        ) : null}
        <p className={styles.kpiNote} style={{ marginTop: 12 }}>
          Organic means paid by wallets the seller does not control. Ratings run AAA to D; NR is a thin file
          (fewer than 5 settlements or 2 payers). Floors:{" "}
          {RATING_FLOORS.map(([r, f]) => `${r} ${f}`).join(", ")}.
        </p>
      </Panel>
    </AppShell>
  );
}
