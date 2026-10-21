import { describe, expect, it } from "vitest";
import { usageParts } from "./UsageChart";

describe("usageParts", () => {
  it("splits a day into paid, reports and other, leaving out turned-away requests", () => {
    const p = usageParts({
      day: 20_000,
      visitors: 3,
      counts: {
        report: 5,
        check_paid: 2,
        check_quoted: 4,
        attest_paid: 1,
        attest_quoted: 1,
        agents: 2,
        economy: 3,
        api_other: 1,
        rate_limited: 9,
      },
    });
    expect(p).toEqual({ paid: 3, reports: 5, other: 11, total: 19 });
  });
});
