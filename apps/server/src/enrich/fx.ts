import { dayOf, type FiatCode } from "@assay/core";
import type { DB } from "../db.js";
import { fetchJson } from "../lib/http.js";
import { log } from "../lib/log.js";

const FIATS: FiatCode[] = ["ARS", "BRL", "COP", "MXN", "PEN", "CLP"];

/**
 * Last-resort rates (fiat per USD, mid-October 2026) so a first boot without
 * network access still prices wFIAT settlements. Replaced by live rates as soon
 * as the FX source answers.
 */
const FALLBACK: Record<Exclude<FiatCode, "USD">, number> = {
  ARS: 1523,
  BRL: 5.05,
  COP: 3174,
  MXN: 18.45,
  PEN: 3.42,
  CLP: 925,
};

/**
 * Daily fiat-per-USD rates. Ripio wFIAT tokens are 1:1 with their fiat, so a
 * wARS amount divided by the ARS rate for that day is its USD value. Days before
 * the first stored rate use the earliest stored rate; that error is bounded by how
 * much the currency moved since, and is noted in the methodology.
 */
export class FxRates {
  private readonly byFiat = new Map<FiatCode, Map<number, number>>();

  constructor(private readonly db: DB) {
    this.reload();
  }

  reload(): void {
    this.byFiat.clear();
    const rows = this.db.prepare("SELECT fiat, day, rate FROM fx").all() as {
      fiat: FiatCode;
      day: number;
      rate: number;
    }[];
    for (const r of rows) this.mapFor(r.fiat).set(r.day, r.rate);
  }

  /** Fetch today's rates once per day. Failures keep the previous rates. */
  async refresh(url: string, now = Date.now()): Promise<boolean> {
    const today = dayOf(Math.floor(now / 1000));
    const have = this.db.prepare("SELECT COUNT(*) AS n FROM fx WHERE day = ?").get(today) as { n: number };
    if (have.n >= FIATS.length) return true;
    try {
      const body = await fetchJson<{ result?: string; rates?: Record<string, number> }>(url, {
        timeoutMs: 10_000,
      });
      if (body.result !== "success" || !body.rates) throw new Error("FX source returned no rates");
      const insert = this.db.prepare("INSERT OR REPLACE INTO fx (fiat, day, rate) VALUES (?, ?, ?)");
      this.db.transaction(() => {
        for (const f of FIATS) {
          const rate = body.rates?.[f];
          if (typeof rate === "number" && rate > 0 && Number.isFinite(rate)) insert.run(f, today, rate);
        }
      })();
      this.reload();
      return true;
    } catch (err) {
      log.warn("fx refresh failed", { error: String(err) });
      return false;
    }
  }

  rate = (fiat: FiatCode, day: number): number => {
    if (fiat === "USD") return 1;
    const days = this.byFiat.get(fiat);
    if (!days || days.size === 0) return FALLBACK[fiat];
    const exact = days.get(day);
    if (exact) return exact;
    // Nearest stored day on or before `day`, else the earliest one.
    let best: number | undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const d of days.keys()) {
      if (d < earliest) earliest = d;
      if (d <= day && (best === undefined || d > best)) best = d;
    }
    return days.get(best ?? earliest) ?? FALLBACK[fiat];
  };

  private mapFor(fiat: FiatCode): Map<number, number> {
    let m = this.byFiat.get(fiat);
    if (!m) {
      m = new Map();
      this.byFiat.set(fiat, m);
    }
    return m;
  }
}
