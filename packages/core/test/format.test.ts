import { describe, expect, it } from "vitest";
import { RATING_CODES, ratingFromCode, toMicros } from "../src/attestation.js";
import { tokenByAddress } from "../src/constants.js";
import {
  dayOf,
  isAddress,
  isTxHash,
  normalizeAddress,
  topicToAddress,
  unitsToNumber,
} from "../src/format.js";

describe("format", () => {
  it("validates addresses and hashes", () => {
    expect(isAddress("0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48")).toBe(true);
    expect(isAddress("0x0d74")).toBe(false);
    expect(isAddress(42)).toBe(false);
    expect(isTxHash(`0x${"a".repeat(64)}`)).toBe(true);
    expect(isTxHash(`0x${"a".repeat(63)}`)).toBe(false);
    expect(() => normalizeAddress("nope")).toThrow();
    expect(normalizeAddress("0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48")).toBe(
      "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48",
    );
  });

  it("reads an address out of a topic", () => {
    expect(topicToAddress("0x000000000000000000000000486B1F52b092d4cf77f621d5fb63160b18a8715f")).toBe(
      "0x486b1f52b092d4cf77f621d5fb63160b18a8715f",
    );
  });

  it("converts token units exactly", () => {
    expect(unitsToNumber(2_127_679n, 6)).toBeCloseTo(2.127679, 9);
    expect(unitsToNumber(10n ** 30n + 5n * 10n ** 17n, 18)).toBeCloseTo(1e12 + 0.5, 0);
    expect(unitsToNumber(0n, 18)).toBe(0);
    expect(unitsToNumber(7n, 0)).toBe(7);
  });

  it("finds tokens case-insensitively", () => {
    expect(tokenByAddress("0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771")?.symbol).toBe("USAT");
    expect(tokenByAddress("0x0000000000000000000000000000000000000000")).toBeUndefined();
  });

  it("buckets timestamps into UTC days", () => {
    expect(dayOf(0)).toBe(0);
    expect(dayOf(86_399)).toBe(0);
    expect(dayOf(86_400)).toBe(1);
  });

  it("encodes attestation fields safely", () => {
    expect(toMicros(1.5)).toBe(1_500_000n);
    expect(toMicros(-1)).toBe(0n);
    expect(toMicros(Number.NaN)).toBe(0n);
    expect(toMicros(1e30)).toBe(2n ** 64n - 1n);
    for (const [rating, code] of Object.entries(RATING_CODES)) expect(ratingFromCode(code)).toBe(rating);
    expect(ratingFromCode(99)).toBe("NR");
  });
});
