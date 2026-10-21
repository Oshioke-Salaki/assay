import type { XMentions } from "./api";

/**
 * The line a check adds when X has something to say. Same wording as the API's, so a reader sees
 * one sentence wherever they look. It never changes the verdict: anyone can post about anyone.
 */
export function xReason(m: XMentions | null | undefined): string | null {
  if (m?.status !== "ok") return null;
  if (m.warnings > 0)
    return `${m.warnings === 1 ? "1 post on X names" : `${m.warnings} posts on X name`} this address next to words like scam or hack; read ${m.warnings === 1 ? "it" : "them"} before paying`;
  if (m.weakWarnings > 0)
    return `${m.weakWarnings === 1 ? "1 post from a new or small X account names" : `${m.weakWarnings} posts from new or small X accounts name`} this address next to words like scam or hack`;
  return null;
}

/** "3 days ago", "today": how old the last search is, in words. */
export function ago(unix: number, now = Date.now() / 1000): string {
  const days = Math.floor((now - unix) / 86_400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** 1,234 · 12.3K · 1.2M */
export function compact(n: number | null): string {
  if (n === null) return "–";
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
