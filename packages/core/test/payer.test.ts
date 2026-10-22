import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { Ledger } from "../src/ledger.js";
import { payerCheck } from "../src/payer.js";
import { addr, ctx, flow, lastDays, NOW } from "./helpers.js";

const DAY = 86_400;

describe("payerCheck", () => {
  it("calls a long-standing wallet that pays several sellers established", () => {
    const buyer = addr("buyer");
    const flows = [addr("s1"), addr("s2"), addr("s3")].map((s) =>
      flow(buyer, s, 10, { count: 4, days: lastDays(20) }),
    );
    const a = assess(
      new Ledger(flows),
      buyer,
      ctx({
        funding: [[buyer, { funder: addr("exchange"), funderIsPublic: true, firstSeenAt: NOW - 200 * DAY }]],
      }),
    );
    const c = payerCheck(a, { now: NOW });
    expect(c.verdict).toBe("established");
    expect(c.sellers).toBe(3);
    expect(c.ageDays).toBe(200);
    expect(c.reasons.join(" ")).toMatch(/3 sellers/);
    expect(c.funder).toEqual({ address: addr("exchange"), public: true });
  });

  it("calls a wallet with no history new, and says the age is unknown when not traced", () => {
    const buyer = addr("fresh");
    const a = assess(new Ledger([flow(buyer, addr("s1"), 1, { days: lastDays(1) })]), buyer, ctx());
    const c = payerCheck(a, { now: NOW });
    expect(c.verdict).toBe("new");
    expect(c.ageDays).toBeNull();
    expect(c.reasons.join(" ")).toMatch(/not been traced yet/);
  });

  it("blocks a wallet whose spending mostly goes round a loop", () => {
    const ring = ["r0", "r1", "r2"].map(addr);
    const flows = ring.map((x, i) => flow(x, ring[(i + 1) % 3]!, 50, { count: 20, days: lastDays(5) }));
    const a = assess(new Ledger(flows), ring[0]!, ctx());
    const c = payerCheck(a, { now: NOW });
    expect(c.verdict).toBe("block");
    expect(c.loopShare).toBe(1);
    expect(c.reasons[0]).toMatch(/100% of what it spends goes round/);
  });

  it("tells the seller when the payer is its own sock, shares its funder, or is a real customer", () => {
    const seller = addr("seller");
    const sock = addr("sock");
    const real = addr("real");
    const flows = [
      flow(sock, seller, 20, { count: 5, days: lastDays(10) }),
      flow(real, seller, 20, { count: 5, days: lastDays(10) }),
    ];
    const ledger = new Ledger(flows);
    const c = ctx({
      funding: [
        [sock, { funder: seller, firstSeenAt: NOW - 100 * DAY }],
        [real, { funder: addr("exchange"), funderIsPublic: true, firstSeenAt: NOW - 100 * DAY }],
      ],
    });
    const sellerLines = assess(ledger, seller, c).seller.payerLines;
    const sockCheck = payerCheck(assess(ledger, sock, c), {
      now: NOW,
      seller,
      sellerLine: sellerLines.find((l) => l.payer === sock),
    });
    expect(sockCheck.verdict).toBe("block");
    expect(sockCheck.reasons[0]).toMatch(/First funded by you/);
    expect(sockCheck.withSeller).toMatchObject({ seller, count: 5, class: "seller-funded" });
    const realCheck = payerCheck(assess(ledger, real, c), {
      now: NOW,
      seller,
      sellerLine: sellerLines.find((l) => l.payer === real),
    });
    expect(realCheck.verdict).toBe("new"); // one seller, not yet established
    expect(realCheck.reasons[0]).toMatch(/Has paid you 5 times, and those payments count as organic/);
    const stranger = payerCheck(assess(ledger, real, c), { now: NOW, seller: addr("other") });
    expect(stranger.withSeller).toMatchObject({ class: "none", count: 0 });
    expect(stranger.reasons[0]).toBe("Has never paid you.");
  });

  it("warns when a wallet was funded by a seller it pays", () => {
    const buyer = addr("made");
    const maker = addr("maker");
    const a = assess(
      new Ledger([
        flow(buyer, maker, 5, { count: 3, days: lastDays(3) }),
        flow(buyer, addr("s2"), 5, { count: 3, days: lastDays(3) }),
      ]),
      buyer,
      ctx({ funding: [[buyer, { funder: maker, firstSeenAt: NOW - 60 * DAY }]] }),
    );
    const c = payerCheck(a, { now: NOW });
    expect(c.verdict).toBe("caution");
    expect(c.reasons.join(" ")).toMatch(/funded by a seller it pays/);
  });
});
