import { describe, expect, it } from "vitest";
import type { XMentions } from "./api";
import { ago, compact, xReason } from "./x";

const base: XMentions = {
  address: "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48",
  checkedAt: 0,
  status: "ok",
  mentions: 0,
  warnings: 0,
  weakWarnings: 0,
  posts: [],
  searchUrl: "https://x.com/search",
  tx: null,
};

describe("xReason", () => {
  // Same sentences as the API's enrich/xmentions.ts, so the page and the paid check agree.
  it("matches the API's wording", () => {
    expect(xReason({ ...base, mentions: 3, warnings: 1 })).toBe(
      "1 post on X names this address next to words like scam or hack; read it before paying",
    );
    expect(xReason({ ...base, mentions: 3, warnings: 2 })).toBe(
      "2 posts on X name this address next to words like scam or hack; read them before paying",
    );
    expect(xReason({ ...base, mentions: 2, weakWarnings: 2 })).toBe(
      "2 posts from new or small X accounts name this address next to words like scam or hack",
    );
  });
  it("adds nothing when X has nothing to add, or the search failed", () => {
    expect(xReason(null)).toBeNull();
    expect(xReason(undefined)).toBeNull();
    expect(xReason({ ...base, mentions: 5 })).toBeNull();
    expect(xReason({ ...base, status: "error", warnings: 3 })).toBeNull();
  });
});

describe("ago and compact", () => {
  it("says how old a search is", () => {
    expect(ago(1_000, 1_000 + 3600)).toBe("today");
    expect(ago(1_000, 1_000 + 86_400)).toBe("yesterday");
    expect(ago(1_000, 1_000 + 5 * 86_400)).toBe("5 days ago");
  });
  it("shortens follower counts", () => {
    expect(compact(null)).toBe("–");
    expect(compact(343)).toBe("343");
    expect(compact(39_257)).toBe("39.3K");
    expect(compact(123_186)).toBe("123K");
    expect(compact(2_400_000)).toBe("2.4M");
  });
});
