/**
 * Parser unit tests — pure and deterministic, no external services.
 * Covers the formats from the README example plus the edge cases listed in
 * the project requirements.
 */

import { describe, expect, it } from "vitest";
import { parseSms } from "../src/parser";
import {
  cleanMerchant,
  detectType,
  extractDate,
  findAmounts,
  normalizeCurrency,
  parseNumber,
  splitAmountToken,
} from "../src/parser/rules";

const EXAMPLE_SMS = `Purchase: EUR 24.50
Card ending 1234
Merchant: K-Market
27.08.2026 15:42`;

describe("rules (normalization helpers)", () => {
  it("parses European decimal numbers", () => {
    expect(parseNumber("24,50")).toBe(24.5);
    expect(parseNumber("-24,50")).toBe(-24.5);
    expect(parseNumber("+500,00")).toBe(500);
    expect(parseNumber("1.234,56")).toBe(1234.56);
    expect(parseNumber("1,234.56")).toBe(1234.56);
    expect(parseNumber("12 345,67")).toBe(12345.67);
    expect(parseNumber("1234.56")).toBe(1234.56);
  });

  it("rejects non-numbers (dates, times, words)", () => {
    expect(parseNumber("27.08.2026")).toBeNull();
    expect(parseNumber("15:42")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("1.000.000.000.000")).toBeNull(); // exceeds MAX_AMOUNT
  });

  it("splits amount tokens with currency before/after/symbol", () => {
    expect(splitAmountToken("EUR 24,50")).toEqual({ amount: 24.5, currency: "EUR" });
    expect(splitAmountToken("24,50 EUR")).toEqual({ amount: 24.5, currency: "EUR" });
    expect(splitAmountToken("€ 24.50")).toEqual({ amount: 24.5, currency: "EUR" });
    expect(splitAmountToken("-24,50€")).toEqual({ amount: -24.5, currency: "EUR" });
    expect(splitAmountToken("$100.00")).toEqual({ amount: 100, currency: "USD" });
    expect(splitAmountToken("24,50")).toEqual({ amount: 24.5, currency: null });
    // Merchant words must not be mistaken for currencies.
    expect(splitAmountToken("24,50 K-Market")).toEqual({ amount: 24.5, currency: null });
  });

  it("normalizes currencies", () => {
    expect(normalizeCurrency("EUR")).toBe("EUR");
    expect(normalizeCurrency("eur")).toBe("EUR");
    expect(normalizeCurrency("€")).toBe("EUR");
    expect(normalizeCurrency("$")).toBe("USD");
    expect(normalizeCurrency("SEK")).toBe("SEK");
    expect(normalizeCurrency("XYZ")).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
  });

  it("finds amounts in text (currency pair first, card numbers too)", () => {
    const amounts = findAmounts("Purchase: EUR 24,50\nCard ending 1234");
    // The currency-carrying candidate comes first; the card number is found
    // as a secondary candidate.
    expect(amounts[0]).toMatchObject({ amount: 24.5, currency: "EUR" });
    expect(amounts.some((a) => a.amount === 24.5)).toBe(true);
    expect(amounts.some((a) => a.amount === 1234 && a.currency === null)).toBe(true);
  });

  it("extracts EU and ISO dates", () => {
    expect(extractDate("27.08.2026 15:42")).toBe("2026-08-27T15:42:00");
    expect(extractDate("27.08.2026")).toBe("2026-08-27T00:00:00");
    expect(extractDate("2026-08-27T15:42")).toBe("2026-08-27T15:42:00");
    expect(extractDate("no date here")).toBeNull();
    expect(extractDate("32.13.2026")).toBeNull(); // invalid parts
  });

  it("cleans merchants", () => {
    expect(cleanMerchant("  K-Market, ")).toBe("K-Market");
    expect(cleanMerchant("  ")).toBeNull();
    expect(cleanMerchant("A very long merchant name ".repeat(10))).toHaveLength(80);
  });

  it("detects transaction types", () => {
    expect(detectType("Purchase: 10 EUR")).toBe("payment");
    expect(detectType("Income: 10 EUR")).toBe("income");
    expect(detectType("Withdrawal: 10 EUR")).toBe("withdrawal");
    expect(detectType("Fee: 10 EUR")).toBe("fee");
    expect(detectType("Transfer: 10 EUR")).toBe("transfer");
    expect(detectType("hello world")).toBeNull();
  });
});

describe("parseSms — the README example", () => {
  it("parses the exact example SMS", () => {
    const result = parseSms(EXAMPLE_SMS);
    expect(result).not.toBeNull();
    expect(result!.parser).toBe("generic");
    expect(result!.parsed).toMatchObject({
      amount: 24.5, // money out (payments) is positive
      currency: "EUR",
      date: "2026-08-27T15:42:00",
      transactionType: "payment",
      merchant: "K-Market",
    });
    expect(result!.parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe("parseSms — transaction types", () => {
  it("parses income as negative", () => {
    const result = parseSms("Income: +500,00 EUR\nSalary\n01.08.2026 09:00");
    expect(result!.parsed.amount).toBe(-500);
    expect(result!.parsed.transactionType).toBe("income");
    expect(result!.parsed.currency).toBe("EUR");
  });

  it("parses transfers", () => {
    const result = parseSms("Transfer: EUR 100.00\nTo account FI12 3456\n02.08.2026");
    expect(result!.parsed.transactionType).toBe("transfer");
    expect(result!.parsed.amount).toBe(100);
  });

  it("parses withdrawals as positive", () => {
    const result = parseSms("Withdrawal: EUR 50.00\nATM\n03.08.2026");
    expect(result!.parsed.transactionType).toBe("withdrawal");
    expect(result!.parsed.amount).toBe(50);
  });

  it("parses fees as positive", () => {
    const result = parseSms("Fee: EUR 2,50\nMonthly account fee\n04.08.2026");
    expect(result!.parsed.transactionType).toBe("fee");
    expect(result!.parsed.amount).toBe(2.5);
  });
});

describe("parseSms — decimal and currency formats", () => {
  it("handles German-style thousands + decimal", () => {
    const result = parseSms("Purchase: EUR 1.234,56\nCard ending 1234\n27.08.2026");
    expect(result!.parsed.amount).toBe(1234.56);
  });

  it("handles US-style thousands + decimal", () => {
    const result = parseSms("Purchase: EUR 1,234.56\nCard ending 1234\n27.08.2026");
    expect(result!.parsed.amount).toBe(1234.56);
  });

  it("handles currency symbols", () => {
    expect(parseSms("Purchase: € 24.50\n27.08.2026")!.parsed.currency).toBe("EUR");
    expect(parseSms("Purchase: $100.00\n27.08.2026")!.parsed.currency).toBe("USD");
  });

  it("handles lowercase currency codes", () => {
    expect(parseSms("Purchase: usd 12.00\n27.08.2026")!.parsed.currency).toBe("USD");
  });
});

describe("parseSms — sign normalization", () => {
  it("makes unsigned payments positive", () => {
    expect(parseSms("Purchase: EUR 24.50\n27.08.2026")!.parsed.amount).toBe(24.5);
  });

  it("makes explicitly-negative payments positive", () => {
    expect(parseSms("Purchase: EUR -24.50\n27.08.2026")!.parsed.amount).toBe(24.5);
  });

  it("makes unsigned deposits negative", () => {
    expect(parseSms("Deposit: EUR 50.00\n27.08.2026")!.parsed.amount).toBe(-50);
  });
});

describe("parseSms — missing fields", () => {
  it("parses without a merchant", () => {
    const result = parseSms("Purchase: EUR 24.50\n27.08.2026 15:42");
    expect(result!.parsed.merchant).toBeNull();
    expect(result!.parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("parses without a date", () => {
    const result = parseSms("Purchase: EUR 24.50\nCard ending 1234\nMerchant: K-Market");
    expect(result!.parsed.date).toBeNull();
    expect(result!.parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe("parseSms — must NOT parse", () => {
  it("rejects OTP / verification codes", () => {
    expect(parseSms("Your verification code is 123456")).toBeNull();
  });

  it("rejects marketing messages with numbers", () => {
    expect(parseSms("Free shipping on orders over 50€")).toBeNull();
  });

  it("rejects bare numbers", () => {
    expect(parseSms("100 200 300")).toBeNull();
  });

  it("rejects a bare card-number line (no transaction)", () => {
    expect(parseSms("Card ending 1234")).toBeNull();
  });

  it("rejects empty and oversized input", () => {
    expect(parseSms("")).toBeNull();
    expect(parseSms("   \n  ")).toBeNull();
    expect(parseSms("Purchase: EUR 24.50\n" + "x".repeat(5000))).toBeNull();
  });

  it("rejects malformed SMS (amount but nothing else)", () => {
    expect(parseSms("Purchase")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Blue (بلو) bank — REAL SMS formats provided by the user
// ---------------------------------------------------------------------------

const BLUE_DEPOSIT_1 = `بلو
واریز پول
حسام عزیز، 750,000 ریال به حساب شما نشست.
موجودی: 38,262,549 ریال
۱۰:۳۰
۱۴۰۵.۰۶.۰۵`;

const BLUE_DEPOSIT_2 = `بلو
واریز پول
حسام عزیز، 3,900,000 ریال به حساب شما نشست.
موجودی: 37,512,549 ریال
۱۷:۴۱
۱۴۰۵.۰۶.۰۴`;

const BLUE_WITHDRAWAL_1 = `بلو
برداشت پول
حسام عزیز، 4,500,000 ریال از حساب شما پرید.
موجودی: 25,712,549 ریال
۱۲:۱۱
۱۴۰۵.۰۶.۰۳`;

const BLUE_WITHDRAWAL_ROUND = `بلو
برداشت رُند
حسام عزیز، 9,479,000 ریال از حساب شما پرید.
و 21,000 ریال هم رند شد.
موجودی: 25,462,549 ریال
۱۷:۲۲
۱۴۰۵.۰۵.۳۱`;

describe("parseSms — Blue (بلو) bank", () => {
  it("parses deposit #1: 750,000 IRR -> 75 thousand Toman, Jalali date kept as '5 شهریور'", () => {
    const result = parseSms(BLUE_DEPOSIT_1);
    expect(result).not.toBeNull();
    expect(result!.parser).toBe("blue");
    expect(result!.parserVersion).toBe("blue-1");
    expect(result!.parsed).toMatchObject({
      amount: -75, // income negative, thousands of Toman (Rial ÷ 10,000)
      currency: "T",
      date: "5 شهریور", // ۱۴۰۵.۰۶.۰۵, no year
      transactionType: "income",
      merchant: "blubank", // no merchant in these SMSes; the bank itself
    });
    expect(result!.parsed.confidence).toBeGreaterThan(0.8);
  });

  it("parses deposit #2 (3,900,000 IRR -> -390)", () => {
    const result = parseSms(BLUE_DEPOSIT_2);
    expect(result!.parsed.amount).toBe(-390);
    expect(result!.parsed.transactionType).toBe("income");
    expect(result!.parsed.date).toBe("4 شهریور"); // ۱۴۰۵.۰۶.۰۴
  });

  it("parses withdrawal #1 as positive (4,500,000 IRR -> 450)", () => {
    const result = parseSms(BLUE_WITHDRAWAL_1);
    expect(result!.parsed.amount).toBe(450);
    expect(result!.parsed.transactionType).toBe("withdrawal");
    expect(result!.parsed.date).toBe("3 شهریور"); // ۱۴۰۵.۰۶.۰۳
  });

  it("parses the rounded withdrawal using the main line only", () => {
    const result = parseSms(BLUE_WITHDRAWAL_ROUND);
    // Balance math: 34,941,549 − 9,479,000 = 25,462,549 ✓ (21,000 rounding is informational)
    // 9,479,000 Rial = 947,900 Toman = 947.9 thousand Toman → rounded to 948.
    expect(result!.parsed.amount).toBe(948);
    expect(result!.parsed.currency).toBe("T");
    expect(result!.parsed.transactionType).toBe("withdrawal");
    expect(result!.parsed.date).toBe("31 مرداد"); // ۱۴۰۵.۰۵.۳۱ (month 5 = مرداد)
  });

  it("never uses the موجودی (balance) line as the amount", () => {
    const result = parseSms(BLUE_DEPOSIT_1);
    expect(result!.parsed.amount).not.toBe(3826); // balance would be round(38,262,549/10,000)
  });

  it("falls through to generic for non-Blue messages", () => {
    const result = parseSms(EXAMPLE_SMS);
    expect(result!.parser).toBe("generic");
  });
});

describe("parseSms — determinism", () => {
  it("returns identical output on repeated calls", () => {
    const a = parseSms(EXAMPLE_SMS);
    const b = parseSms(EXAMPLE_SMS);
    expect(a).toEqual(b);
  });
});