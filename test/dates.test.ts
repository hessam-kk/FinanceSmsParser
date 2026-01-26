import { describe, expect, it } from "vitest";
import { adjustTransactionDate } from "../src/utils/dates";

describe("adjustTransactionDate — Jalali 'D month-name'", () => {
  it("rolls forward across a month boundary", () => {
    expect(adjustTransactionDate("31 مرداد", 1)).toBe("1 شهریور");
  });

  it("rolls backward across a month boundary", () => {
    expect(adjustTransactionDate("1 شهریور", -1)).toBe("31 مرداد");
  });

  it("rolls over the year end (اسفند ↔ فروردین)", () => {
    expect(adjustTransactionDate("29 اسفند", 1)).toBe("1 فروردین");
    expect(adjustTransactionDate("1 فروردین", -1)).toBe("29 اسفند");
  });

  it("shifts multiple days in both directions", () => {
    expect(adjustTransactionDate("5 شهریور", -7)).toBe("29 مرداد");
    expect(adjustTransactionDate("29 مرداد", 7)).toBe("5 شهریور");
  });
});

describe("adjustTransactionDate — ISO local timestamps (generic parser)", () => {
  it("shifts within a month", () => {
    expect(adjustTransactionDate("2026-08-27T15:42:00", 1)).toBe("2026-08-28T15:42:00");
  });

  it("rolls across month and year boundaries", () => {
    expect(adjustTransactionDate("2026-08-31T00:00:00", 1)).toBe("2026-09-01T00:00:00");
    expect(adjustTransactionDate("2026-01-01T10:30:00", -1)).toBe("2025-12-31T10:30:00");
  });
});

describe("adjustTransactionDate — fallbacks", () => {
  it("returns null for null", () => {
    expect(adjustTransactionDate(null, 1)).toBeNull();
  });

  it("returns unknown formats unchanged", () => {
    expect(adjustTransactionDate("hello", 1)).toBe("hello");
  });
});
