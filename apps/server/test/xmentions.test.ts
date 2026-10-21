import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  PaymentRefused,
  parseXDate,
  readSearch,
  readXMentions,
  summarize,
  wantXMentions,
  X_REFRESH,
  XMentionsWatcher,
  xReason,
} from "../src/enrich/xmentions.js";
import { BudgetExceeded } from "../src/lib/buy.js";
import { memoryDb } from "./helpers.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

// Real answers from buy's X search (tikhub), bought for these tests. Vitalik's address is the one
// address X certainly talks about; the Celo x402 facilitator is one nobody mentions.
const VITALIK = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const FACILITATOR = "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48";

function post(over: Record<string, unknown> = {}) {
  return {
    type: "tweet",
    tweet_id: "100",
    screen_name: "someone",
    created_at: "Mon Oct 20 10:00:00 +0000 2026",
    text: `paying ${FACILITATOR} for weather data`,
    favorites: 1,
    retweets: 0,
    entities: { urls: [] },
    user_info: {
      screen_name: "someone",
      name: "Some One",
      created_at: "Sat Jan 29 01:21:15 +0000 2022",
      followers_count: 500,
      verified: false,
    },
    ...over,
  };
}

const answer = (timeline: unknown[], tx = `0x${"ab".repeat(32)}`) => ({
  transaction: tx,
  output: { status: "ok", timeline },
});

describe("parseXDate", () => {
  it("reads X's date format, offsets included", () => {
    expect(parseXDate("Sun Dec 03 01:13:25 +0000 2023")).toBe(Date.UTC(2023, 11, 3, 1, 13, 25) / 1000);
    expect(parseXDate("Sun Dec 03 01:13:25 +0530 2023")).toBe(Date.UTC(2023, 11, 2, 19, 43, 25) / 1000);
    expect(parseXDate("Sun Dec 03 01:13:25 -0500 2023")).toBe(Date.UTC(2023, 11, 3, 6, 13, 25) / 1000);
  });
  it("returns null for anything else", () => {
    expect(parseXDate("2023-12-03")).toBeNull();
    expect(parseXDate("Sun Foo 03 01:13:25 +0000 2023")).toBeNull();
    expect(parseXDate(null)).toBeNull();
  });
});

describe("readSearch on real answers", () => {
  it("keeps every post that names the address, with its author and link", () => {
    const { posts, tx } = readSearch(fixture("x-search-vitalik.json"), VITALIK);
    expect(tx).toBe("0x718f6a1343f8d97bc8d0a06c9b4c2fcf4c0c8f0f143737bf514da275b8e30d05");
    expect(posts).toHaveLength(16);
    expect(posts.every((p) => p.namesAddress)).toBe(true);
    expect(posts.every((p) => /^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(p.url))).toBe(true);
    expect(posts.every((p) => p.postedAt !== null && p.postedAt > 1.2e9)).toBe(true);
  });

  it("puts posts with warning words first, and counts pasted copies once", () => {
    const { posts } = readSearch(fixture("x-search-vitalik.json"), VITALIK);
    const s = summarize(VITALIK, posts, 1, null);
    // Two copies of one spam text ("I got scammed and drained … 0xd8dA…") from real accounts.
    expect(posts.filter((p) => p.warning)).toHaveLength(2);
    expect(posts[0]?.warning && posts[1]?.warning).toBe(true);
    expect(s.mentions).toBe(16);
    expect(s.warnings).toBe(1);
    // The second copy is labelled as one, and every excerpt shows the address in its context.
    expect(posts.filter((p) => p.warning).map((p) => p.copy)).toEqual([false, true]);
    expect(posts.every((p) => p.excerpt.toLowerCase().includes(VITALIK))).toBe(true);
    const digest = posts.find((p) => p.author === "layerggofficial");
    expect(digest?.excerpt.startsWith("…")).toBe(true);
    expect(digest?.excerpt).not.toContain("exploit");
    // Excerpts are cut between words: the character before the cut is a space in the original.
    const original = new Map<string, string>(
      fixture("x-search-vitalik.json").output.timeline.map((t: { tweet_id: string; text: string }) => [
        t.tweet_id,
        t.text,
      ]),
    );
    for (const p of posts) {
      if (!p.excerpt.startsWith("…")) continue;
      const body = p.excerpt.slice(1).replace(/…$/, "");
      const full = original.get(p.id) ?? "";
      const at = full.indexOf(body);
      expect(at).toBeGreaterThan(0);
      expect(full[at - 1]).toMatch(/\s/);
    }
    expect(xReason(s)).toBe(
      "1 post on X names this address next to words like scam or hack; read it before paying",
    );
  });

  it("an address nobody posts about has no mentions and adds nothing to a check", () => {
    const { posts, tx } = readSearch(fixture("x-search-empty.json"), FACILITATOR);
    const s = summarize(FACILITATOR, posts, 1, tx);
    expect(s).toMatchObject({ status: "ok", mentions: 0, warnings: 0, weakWarnings: 0, posts: [] });
    expect(s.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(xReason(s)).toBeNull();
  });
});

describe("readSearch judging", () => {
  it("drops posts that do not contain the address", () => {
    const { posts } = readSearch(answer([post({ text: "celo x402 is great" })]), FACILITATOR);
    expect(summarize(FACILITATOR, posts, 1, null).mentions).toBe(0);
  });

  it("counts an address that only appears in a link", () => {
    const p = post({
      text: "look at this seller https://t.co/abc",
      entities: { urls: [{ expanded_url: `https://celoscan.io/address/${FACILITATOR}` }] },
    });
    expect(readSearch(answer([p]), FACILITATOR).posts[0]?.namesAddress).toBe(true);
  });

  it("matches the address in any case", () => {
    const p = post({ text: `scam alert ${FACILITATOR.toUpperCase().replace("0X", "0x")}` });
    expect(readSearch(answer([p]), FACILITATOR).posts[0]).toMatchObject({
      namesAddress: true,
      warning: true,
    });
  });

  it("marks posts from new or tiny accounts as weak, and counts them apart", () => {
    const fresh = post({
      tweet_id: "1",
      text: `${FACILITATOR} is a scam`,
      user_info: { ...post().user_info, created_at: "Mon Oct 13 10:00:00 +0000 2026", followers_count: 900 },
    });
    const tiny = post({
      tweet_id: "2",
      text: `${FACILITATOR} rugged me`,
      user_info: { ...post().user_info, followers_count: 3 },
    });
    const real = post({ tweet_id: "3", text: `${FACILITATOR} drained my wallet` });
    const { posts } = readSearch(answer([fresh, tiny, real]), FACILITATOR);
    const s = summarize(FACILITATOR, posts, 1, null);
    expect(s).toMatchObject({ mentions: 3, warnings: 1, weakWarnings: 2 });
    expect(posts[0]?.id).toBe("3");
    expect(xReason({ ...s, warnings: 0 })).toBe(
      "2 posts from new or small X accounts name this address next to words like scam or hack",
    );
  });

  it("ignores warning words far from the address", () => {
    const text = `${FACILITATOR} paid out today.${" Lots of unrelated news.".repeat(10)} Elsewhere, a bridge was hacked.`;
    expect(readSearch(answer([post({ text })]), FACILITATOR).posts[0]?.warning).toBe(false);
    expect(
      readSearch(answer([post({ text: `hacked! ${FACILITATOR}` })]), FACILITATOR).posts[0]?.warning,
    ).toBe(true);
    const digest = `- Big seller update\n${FACILITATOR}\n\n- An exploit hit another project`;
    expect(readSearch(answer([post({ text: digest })]), FACILITATOR).posts[0]?.warning).toBe(false);
  });

  it("does not take ordinary words for warnings", () => {
    for (const text of ["drainage project", "scampi recipe", "the hacky sack", "fakeout candle"]) {
      expect(
        readSearch(answer([post({ text: `${text} ${FACILITATOR}` })]), FACILITATOR).posts[0]?.warning,
      ).toBe(false);
    }
    for (const text of [
      "SCAM",
      "rug pull",
      "rugpulled",
      "drainer",
      "phishing",
      "hacked",
      "stolen",
      "honeypot",
    ]) {
      expect(
        readSearch(answer([post({ text: `${text} ${FACILITATOR}` })]), FACILITATOR).posts[0]?.warning,
      ).toBe(true);
    }
  });

  it("skips malformed and repeated entries instead of failing the whole answer", () => {
    const { posts } = readSearch(
      answer([post(), post(), { type: "tweet", tweet_id: "x" }, { type: "user" }, null]),
      FACILITATOR,
    );
    expect(posts).toHaveLength(1);
  });

  it("rejects an answer that is not a search result", () => {
    expect(() => readSearch({ error: "bad" }, FACILITATOR)).toThrow();
  });
});

function seed(db: ReturnType<typeof memoryDb>) {
  const pd = db.prepare(
    "INSERT INTO pair_days (payer, payee, day, count, usd, first_ts, last_ts, last_tx) VALUES (?, ?, 1, 1, ?, 1, 1, '0x1')",
  );
  pd.run(`0x${"1".repeat(40)}`, `0x${"a".repeat(40)}`, 500); // big seller
  pd.run(`0x${"2".repeat(40)}`, `0x${"b".repeat(40)}`, 50); // smaller seller
  pd.run(`0x${"3".repeat(40)}`, `0x${"c".repeat(40)}`, 0.2); // dust: never worth a paid search
}

const okPay = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("XMentionsWatcher", () => {
  it("checks the busiest sellers first and skips dust", () => {
    const db = memoryDb();
    seed(db);
    const w = new XMentionsWatcher(db, { pay: okPay(answer([])) });
    expect(w.queue(10)).toEqual([`0x${"a".repeat(40)}`, `0x${"b".repeat(40)}`]);
  });

  it("sends a quoted exact-address search and stores the result", async () => {
    const db = memoryDb();
    seed(db);
    const pay = okPay(answer([post({ text: `x402 seller 0x${"a".repeat(40)}` })]));
    const w = new XMentionsWatcher(db, { pay, searchUrl: "https://buy.test/x" });
    const r = await w.check(`0x${"a".repeat(40)}`, 1_000);
    const [url, init] = (pay as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://buy.test/x");
    expect(JSON.parse(String(init.body))).toEqual({ query: `"0x${"a".repeat(40)}"`, type: "top" });
    expect(r).toMatchObject({ status: "ok", mentions: 1, checkedAt: 1_000 });
    expect(readXMentions(db, `0x${"A".repeat(40)}`)).toMatchObject({
      mentions: 1,
      tx: `0x${"ab".repeat(32)}`,
    });
  });

  it("re-checks after a week, and retries errors after a day", async () => {
    const db = memoryDb();
    seed(db);
    const a = `0x${"a".repeat(40)}` as const;
    const b = `0x${"b".repeat(40)}` as const;
    const good = new XMentionsWatcher(db, { pay: okPay(answer([])) });
    await good.check(a, 10_000_000);
    const bad = new XMentionsWatcher(db, {
      pay: vi.fn(async () => new Response("{}", { status: 502 })) as unknown as typeof fetch,
    });
    const failed = await bad.check(b, 10_000_000);
    expect(failed).toMatchObject({ status: "error", error: "X search answered 502" });
    expect(good.queue(10, 10_000_000 + 3600)).toEqual([]);
    expect(good.queue(10, 10_000_000 + 86_400 + 1)).toEqual([b]);
    expect(good.queue(10, 10_000_000 + X_REFRESH + 1)).toEqual([a, b]);
  });

  it("shows the latest outcome, so a failed re-check never leaves a stale warning up", async () => {
    const db = memoryDb();
    seed(db);
    const a = `0x${"a".repeat(40)}` as const;
    await new XMentionsWatcher(db, { pay: okPay(answer([post({ text: `scam ${a}` })])) }).check(a, 1);
    await new XMentionsWatcher(db, {
      pay: vi.fn(async () => {
        throw new Error("gateway down");
      }) as unknown as typeof fetch,
    }).check(a, 2);
    expect(readXMentions(db, a)).toMatchObject({ status: "error", warnings: 0 });
    expect(xReason(readXMentions(db, a))).toBeNull();
  });

  it("an empty wallet pauses the search instead of marking the seller as failed", async () => {
    const db = memoryDb();
    seed(db);
    const w = new XMentionsWatcher(db, {
      pay: vi.fn(
        async () => new Response(JSON.stringify({ error: "insufficient_funds" }), { status: 402 }),
      ) as unknown as typeof fetch,
    });
    await expect(w.check(`0x${"a".repeat(40)}`)).rejects.toBeInstanceOf(PaymentRefused);
    expect(readXMentions(db, `0x${"a".repeat(40)}`)).toBeNull();
    expect(w.queue(1)).toEqual([`0x${"a".repeat(40)}`]);
  });

  it("stops at the daily budget without recording a result", async () => {
    const db = memoryDb();
    seed(db);
    const w = new XMentionsWatcher(db, {
      pay: vi.fn(async () => {
        throw new BudgetExceeded(0.5, 0.5);
      }) as unknown as typeof fetch,
    });
    await expect(w.check(`0x${"a".repeat(40)}`)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(readXMentions(db, `0x${"a".repeat(40)}`)).toBeNull();
  });
});

describe("demand", () => {
  it("searches what people asked about first: paid checks, then views, then sellers by revenue", async () => {
    const db = memoryDb();
    seed(db);
    const w = new XMentionsWatcher(db, { pay: okPay(answer([])) });
    const viewed = `0x${"d".repeat(40)}`;
    const paidFor = `0x${"e".repeat(40)}` as const;
    wantXMentions(db, viewed, false, 100);
    wantXMentions(db, paidFor, true, 200);
    expect(w.queue(10)).toEqual([paidFor, viewed, `0x${"a".repeat(40)}`, `0x${"b".repeat(40)}`]);
    // A later free view never downgrades a paid request.
    wantXMentions(db, paidFor, false, 300);
    expect(w.queue(1)).toEqual([paidFor]);
    // Searching clears the request; a fresh result keeps it out of the queue.
    await w.check(paidFor);
    expect(w.queue(10)).not.toContain(paidFor);
    expect(db.prepare("SELECT COUNT(*) AS n FROM x_wanted WHERE address = ?").get(paidFor)).toEqual({ n: 0 });
  });

  it("a seller checked before goes after sellers never checked, whatever its revenue", async () => {
    const db = memoryDb();
    seed(db);
    const w = new XMentionsWatcher(db, { pay: okPay(answer([])) });
    await w.check(`0x${"a".repeat(40)}`, 1);
    expect(w.queue(10, 1 + X_REFRESH + 1)).toEqual([`0x${"b".repeat(40)}`, `0x${"a".repeat(40)}`]);
  });
});
