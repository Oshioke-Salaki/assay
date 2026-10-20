import type { CheckResult } from "@assay/core";
import { describe, expect, it, vi } from "vitest";

type FetchInput = Parameters<typeof fetch>[0];

import { AssayBlockedError, AssayError, createAssay, readPayTos, withAssayGuard } from "../src/index.js";

const BASE = "https://assay.test";
const SELLER = "0x5555555555555555555555555555555555555555";
const WASH = "0x1111111111111111111111111111111111111111";

function paymentRequired(payTo: string[]): Response {
  const body = {
    x402Version: 2,
    accepts: payTo.map((p) => ({ scheme: "exact", network: "eip155:42220", payTo: p })),
  };
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(body)).toString("base64") },
  });
}

function check(address: string, verdict: CheckResult["verdict"], rating: CheckResult["rating"]): CheckResult {
  return {
    address: address as `0x${string}`,
    verdict,
    rating,
    score: 50,
    organicShare: 1,
    reasons: [`Rated ${rating}`],
  };
}

/** A fake world: the seller always asks for payment, Assay answers from a table. */
function world(verdicts: Record<string, CheckResult | "down">, sellerPayTo = [SELLER]) {
  const assayCalls: string[] = [];
  const plain = vi.fn(async (input: FetchInput) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(BASE)) {
      const addr = url.split("/").pop()!;
      assayCalls.push(addr);
      const v = verdicts[addr];
      if (v === "down") return new Response("upstream", { status: 503 });
      if (!v) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      return new Response(JSON.stringify({ asOf: 1, check: v, assessment: {}, agents: [] }));
    }
    if (url.includes("/free")) return new Response("free content");
    return paymentRequired(sellerPayTo);
  });
  const paying = vi.fn(async () => new Response("paid content"));
  return { plain, paying, assayCalls };
}

describe("withAssayGuard", () => {
  it("pays sellers that pass", async () => {
    const w = world({ [SELLER]: check(SELLER, "pass", "A") });
    const res = await withAssayGuard(w.plain, w.paying, { baseUrl: BASE })("https://seller.test/api");
    expect(await res.text()).toBe("paid content");
    expect(w.paying).toHaveBeenCalledOnce();
  });

  it("refuses to pay a blocked seller", async () => {
    const w = world({ [WASH]: check(WASH, "block", "D") }, [WASH]);
    const guarded = withAssayGuard(w.plain, w.paying, { baseUrl: BASE });
    await expect(guarded("https://seller.test/api")).rejects.toBeInstanceOf(AssayBlockedError);
    expect(w.paying).not.toHaveBeenCalled();
  });

  it("blocks when any one of several payTo options is blocked", async () => {
    const w = world({ [SELLER]: check(SELLER, "pass", "AA"), [WASH]: check(WASH, "block", "D") }, [
      SELLER,
      WASH,
    ]);
    await expect(withAssayGuard(w.plain, w.paying, { baseUrl: BASE })("https://seller.test")).rejects.toThrow(
      /blocked/,
    );
  });

  it("enforces a minimum rating", async () => {
    const w = world({ [SELLER]: check(SELLER, "caution", "BB") });
    const guarded = withAssayGuard(w.plain, w.paying, { baseUrl: BASE, minRating: "BBB" });
    await expect(guarded("https://seller.test")).rejects.toBeInstanceOf(AssayBlockedError);
    const lenient = withAssayGuard(w.plain, w.paying, { baseUrl: BASE, minRating: "BB" });
    expect((await lenient("https://seller.test")).status).toBe(200);
  });

  it("lets unrated sellers through unless told not to", async () => {
    const w = world({ [SELLER]: check(SELLER, "caution", "NR") });
    expect((await withAssayGuard(w.plain, w.paying, { baseUrl: BASE })("https://seller.test")).status).toBe(
      200,
    );
    await expect(
      withAssayGuard(w.plain, w.paying, { baseUrl: BASE, allowUnrated: false })("https://seller.test"),
    ).rejects.toBeInstanceOf(AssayBlockedError);
  });

  it("fails open by default and closed on request when Assay is down", async () => {
    const decisions: boolean[] = [];
    const w = world({ [SELLER]: "down" });
    const open = withAssayGuard(w.plain, w.paying, {
      baseUrl: BASE,
      onDecision: (d) => decisions.push(d.allowed),
    });
    expect((await open("https://seller.test")).status).toBe(200);
    expect(decisions).toEqual([true]);
    const closed = withAssayGuard(w.plain, w.paying, { baseUrl: BASE, onAssayError: "block" });
    await expect(closed("https://seller.test")).rejects.toBeInstanceOf(AssayError);
  });

  it("never pays or checks when the seller does not ask for payment", async () => {
    const w = world({});
    const res = await withAssayGuard(w.plain, w.paying, { baseUrl: BASE })("https://seller.test/free");
    expect(await res.text()).toBe("free content");
    expect(w.paying).not.toHaveBeenCalled();
    expect(w.assayCalls).toEqual([]);
  });

  it("caches verdicts", async () => {
    const w = world({ [SELLER]: check(SELLER, "pass", "A") });
    const guarded = withAssayGuard(w.plain, w.paying, { baseUrl: BASE });
    await guarded("https://seller.test");
    await guarded("https://seller.test");
    expect(w.assayCalls).toHaveLength(1);
  });

  it("replays Request objects with their body", async () => {
    const w = world({ [SELLER]: check(SELLER, "pass", "A") });
    let seenBody = "";
    const paying = vi.fn(async (input: FetchInput) => {
      seenBody = await (input as Request).text();
      return new Response("ok");
    });
    await withAssayGuard(w.plain, paying, { baseUrl: BASE })(
      new Request("https://seller.test/api", { method: "POST", body: "payload" }),
    );
    expect(seenBody).toBe("payload");
  });
});

describe("readPayTos", () => {
  it("reads v2 headers and v1 bodies, and ignores junk", async () => {
    expect(await readPayTos(paymentRequired([SELLER.toUpperCase().replace("0X", "0x")]))).toEqual([SELLER]);
    const v1 = new Response(JSON.stringify({ accepts: [{ payTo: WASH }, { payTo: "nope" }] }), {
      status: 402,
    });
    expect(await readPayTos(v1)).toEqual([WASH]);
    const junk = new Response("not json", { status: 402, headers: { "payment-required": "%%%" } });
    expect(await readPayTos(junk)).toEqual([]);
  });
});

describe("createAssay", () => {
  it("requires a base URL and validates addresses", () => {
    expect(() => createAssay({ baseUrl: "" })).toThrow(/baseUrl/);
    const a = createAssay({ baseUrl: BASE, fetch: vi.fn() });
    expect(() => a.address("0x12")).toThrow(/Not an address/);
    expect(() => a.check(SELLER)).toThrow(/payingFetch/);
  });

  it("surfaces API errors with their code", async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rate_limited", message: "slow down" }), { status: 429 }),
    );
    await expect(createAssay({ baseUrl: BASE, fetch: f }).economy()).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    const html = vi.fn(async () => new Response("<html>", { status: 502 }));
    await expect(createAssay({ baseUrl: BASE, fetch: html }).economy()).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});
