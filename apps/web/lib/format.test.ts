import { describe, expect, it } from "vitest";
import { fineness, finenessWords, pct, short, usd, usdFine } from "./format";
import { labelIndexes, niceTicks } from "./ticks";

describe("format", () => {
  it("reads organic share as hallmark fineness", () => {
    expect(fineness(1, 1)).toBe("999");
    expect(fineness(0.006, 1)).toBe("006");
    expect(fineness(0, 10)).toBe("000");
    expect(fineness(5, 0)).toBeNull();
    expect(finenessWords(744, 1000)).toBe("0.744 fine");
    expect(finenessWords(1, 0)).toBe("not assayed");
  });

  it("formats money and shares honestly", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(0.004)).toBe("<$0.01");
    expect(usd(12.5)).toBe("$12.50");
    expect(usd(55210.77)).toBe("$55,211");
    expect(usd(2_400_000)).toBe("$2.40M");
    expect(usd(null)).toBe("–");
    expect(pct(0.0004)).toBe("<0.1%");
    expect(pct(0.756)).toBe("76%");
    expect(short("0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48")).toBe("0x0d74…fb48");
  });
});

describe("chart ticks", () => {
  it("puts the top tick strictly above the maximum on round steps", () => {
    const t = niceTicks(4_700);
    expect(t[0]).toBe(0);
    expect(t.at(-1)!).toBeGreaterThan(4_700);
    expect(new Set(t.slice(1).map((v, i) => +(v - t[i]!).toFixed(6))).size).toBe(1);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it("labels the last day and stays within 4–7 labels", () => {
    const l = labelIndexes(120);
    expect(l.at(-1)).toBe(119);
    expect(l.length).toBeGreaterThanOrEqual(4);
    expect(l.length).toBeLessThanOrEqual(7);
    expect(labelIndexes(3)).toEqual([0, 1, 2]);
  });
});

describe("usdFine", () => {
  it("shows the sub-cent amounts Assay charges and pays", () => {
    expect(usdFine(0.002)).toBe("$0.002");
    expect(usdFine(0.005)).toBe("$0.005");
    expect(usdFine(0.012)).toBe("$0.012");
    expect(usdFine(0.5)).toBe("$0.50");
    expect(usdFine(0.25)).toBe("$0.25");
  });

  it("handles nothing, zero and whole dollars", () => {
    expect(usdFine(null)).toBe("–");
    expect(usdFine(undefined)).toBe("–");
    expect(usdFine(Number.NaN)).toBe("–");
    expect(usdFine(0)).toBe("$0");
    expect(usdFine(12)).toMatch(/^\$12/);
  });
});
