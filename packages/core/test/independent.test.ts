import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { HACKATHON_WINDOW, independentPayers, judgePayer } from "../src/independent.js";
import { Ledger } from "../src/ledger.js";
import type { PayerLine } from "../src/types.js";
import { addr, ctx, flow, lastDays } from "./helpers.js";

const line = (over: Partial<PayerLine>): PayerLine => ({
  payer: addr("p"),
  usd: 10,
  creditedUsd: 10,
  count: 3,
  firstTs: HACKATHON_WINDOW.start + 1000,
  lastTs: HACKATHON_WINDOW.start + 2000,
  class: "organic",
  inLoop: false,
  funder: null,
  human: false,
  established: true,
  firstSeenAt: HACKATHON_WINDOW.start - 86_400,
  traced: true,
  sampleTxs: [],
  ...over,
});

describe("independent payers, by the hackathon's rule", () => {
  it("counts an organic payer that was on Celo before the window", () => {
    expect(judgePayer(line({}), HACKATHON_WINDOW.start)).toMatchObject({ independent: true, reasons: [] });
  });

  it("refuses payers the seller funded, payers sharing its funder, and loop members", () => {
    expect(judgePayer(line({ class: "seller-funded" }), HACKATHON_WINDOW.start)).toMatchObject({
      independent: false,
      reasons: ["first funded by the seller"],
    });
    expect(judgePayer(line({ class: "shared-funder" }), HACKATHON_WINDOW.start).reasons).toEqual([
      "funded by the seller's own funder",
    ]);
    expect(judgePayer(line({ inLoop: true, class: "loop" }), HACKATHON_WINDOW.start).reasons).toEqual([
      "in the seller's payment loop",
    ]);
  });

  it("refuses a wallet born during the window, even an organic one", () => {
    const r = judgePayer(line({ firstSeenAt: HACKATHON_WINDOW.start + 5 }), HACKATHON_WINDOW.start);
    expect(r).toMatchObject({
      independent: false,
      reasons: ["no activity on Celo before the window started"],
    });
  });

  it("says 'unknown' rather than guessing when funding is not traced yet", () => {
    const r = judgePayer(line({ traced: false, firstSeenAt: null }), HACKATHON_WINDOW.start);
    expect(r).toMatchObject({ independent: null, reasons: ["funding not traced yet"] });
    // A known exclusion still decides, traced or not.
    expect(
      judgePayer(line({ traced: false, class: "seller-funded" }), HACKATHON_WINDOW.start).independent,
    ).toBe(false);
  });

  it("totals a real assessment and puts independent payers first", () => {
    const seller = addr("s");
    const good = addr("good");
    const sock = addr("sock");
    const ledger = new Ledger([
      flow(good, seller, 5, { days: lastDays(3) }),
      flow(sock, seller, 50, { days: lastDays(3) }),
    ]);
    const a = assess(
      ledger,
      seller,
      ctx({
        funding: [
          [sock, { funder: seller }],
          [good, { funder: addr("exchange"), firstSeenAt: HACKATHON_WINDOW.start - 10 * 86_400 }],
        ],
      }),
    );
    const r = independentPayers(a);
    expect(r.totals).toEqual({ payers: 2, independent: 1, notIndependent: 1, unknown: 0, independentUsd: 5 });
    expect(r.rows[0]?.payer).toBe(good);
  });
});
