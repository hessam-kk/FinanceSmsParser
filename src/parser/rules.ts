/**
 * Shared, bank-agnostic normalization rules used by every parser.
 *
 * Everything here is deterministic string/number handling:
 *  - whitespace / unicode cleanup
 *  - decimal separator normalization ("," vs "." vs thousands separators)
 *  - currency alias normalization
 *  - date extraction (EU "27.08.2026 15:42" and ISO "2026-08-27T15:42")
 *  - amount token splitting ("EUR 24,50", "24,50 EUR", "€ 24.50", ...)
 *  - transaction-type keyword detection
 */

import { buildLocalTimestamp } from "../utils/dates";
import type { TransactionType } from "./types";

export const MAX_SMS_LENGTH = 4000;
export const MAX_AMOUNT = 1_000_000_000;

/** Canonical 3-letter codes and common aliases. */
const CURRENCY_ALIASES: Record<string, string> = {
  EUR: "EUR",
  USD: "USD",
  GBP: "GBP",
  SEK: "SEK",
  NOK: "NOK",
  DKK: "DKK",
  CHF: "CHF",
  PLN: "PLN",
  CZK: "CZK",
  HUF: "HUF",
  RON: "RON",
  RUB: "RUB",
  JPY: "JPY",
  CAD: "CAD",
  AUD: "AUD",
  NZD: "NZD",
  CNY: "CNY",
  ISK: "ISK",
  TRY: "TRY",
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₽": "RUB",
  "$": "USD",
};

/** Persian/Arabic-Indic digits → ASCII (Blue bank uses Persian digits). */
const DIGIT_MAP: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

function normalizeDigits(raw: string): string {
  return raw.replace(/[۰-۹٠-٩]/g, (ch) => DIGIT_MAP[ch] ?? ch);
}

/** Normalize an SMS: trim lines, collapse inner whitespace, unify dashes and digits. */
export function normalizeText(raw: string): string {
  return raw
    .normalize("NFKC") // full-width digits/letters → ASCII
    .replace(/\u2013|\u2014|\u2015/g, "-") // en/em dash → hyphen
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/،/g, ",") // Persian comma → ASCII comma
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .join("\n")
    .split("")
    .map(normalizeDigits)
    .join("")
    .trim();
}

/** Normalize a currency token to a canonical 3-letter code, or null. */
export function normalizeCurrency(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  const upper = t.toUpperCase();
  if (CURRENCY_ALIASES[upper]) return CURRENCY_ALIASES[upper];
  if (CURRENCY_SYMBOLS[t]) return CURRENCY_SYMBOLS[t];
  return null;
}

/**
 * Parse a numeric token with European decimal separators:
 *  "24,50" -> 24.5, "1.234,56" -> 1234.56, "1,234.56" -> 1234.56,
 *  "-24.50" -> -24.5, "+1 234,56" -> 1234.56.
 * Returns null when the token is not a plain number (e.g. a date "27.08.2026").
 */
export function parseNumber(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;

  let sign = 1;
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Both present: the LAST separator is the decimal one.
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    s = s.replace(",", ".");
  }

  s = s.replace(/\s/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const n = Number(s) * sign;
  if (!Number.isFinite(n) || Math.abs(n) > MAX_AMOUNT) return null;
  return n;
}

/**
 * Split a single token (or "code amount" pair) into amount + currency.
 * Handles "24,50", "-24,50", "EUR 24,50", "24,50 EUR", "€ 24.50", "24,50€".
 */
export function splitAmountToken(
  token: string
): { amount: number; currency: string | null } | null {
  let t = token.trim();
  if (!t || !/\d/.test(t)) return null;

  let currency: string | null = null;

  const symbolMatch = t.match(/[€£¥₽$]/);
  if (symbolMatch) {
    currency = normalizeCurrency(symbolMatch[0]);
    t = t.replace(/[€£¥₽$]/g, " ");
  }

  // Only treat a 3-letter token as a currency when it is a KNOWN code, so
  // merchant words ("K-Market") are never mistaken for currencies.
  const codeMatch = t.match(/\b([A-Za-z]{3})\b/);
  if (codeMatch && codeMatch[1]) {
    const norm = normalizeCurrency(codeMatch[1]);
    if (norm) {
      currency = norm;
      t = t.replace(codeMatch[1], " ");
    }
  }

  const amount = extractAmount(t);
  if (amount === null) return null;
  return { amount, currency };
}

/**
 * Parse an amount from the remainder of a token, tolerating leftover words:
 * "24,50", "1 234,56", "24,50 K-Market" (amount first) all work, while
 * "14:35" or "27.08.2026" (date/time) correctly fail.
 */
function extractAmount(t: string): number | null {
  const direct = parseNumber(t);
  if (direct !== null) return direct;
  const words = t.trim().split(/\s+/);
  // Drop trailing purely-letter words one at a time and retry ("24,50 K-Market").
  for (let i = words.length - 1; i > 0; i--) {
    if (!/[A-Za-z]/.test(words[i] ?? "")) break;
    const partial = parseNumber(words.slice(0, i).join(" "));
    if (partial !== null) return partial;
  }
  return null;
}

export interface AmountMatch {
  amount: number;
  currency: string | null;
  raw: string;
}

/**
 * Find all amount candidates in normalized text. For each numeric token we try
 * "previous+current", "current", "current+next" and push EVERY success
 * (order matters: general parsers prefer the first candidate that carries a
 * currency, which the "EUR 24,50" / "24,50 EUR" pair candidates provide).
 */
export function findAmounts(text: string): AmountMatch[] {
  const tokens = text.split(/\s+/);
  const out: AmountMatch[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i];
    if (!current || !/\d/.test(current)) continue;
    const candidates: string[] = [];
    if (i > 0 && tokens[i - 1]) candidates.push(`${tokens[i - 1]} ${current}`);
    candidates.push(current);
    if (i < tokens.length - 1 && tokens[i + 1]) candidates.push(`${current} ${tokens[i + 1]}`);
    for (const candidate of candidates) {
      const parsed = splitAmountToken(candidate);
      if (parsed) out.push({ ...parsed, raw: candidate });
    }
  }
  return out;
}

/** Clean a merchant name: trim, collapse spaces, strip trailing punctuation. */
export function cleanMerchant(raw: string | null | undefined, maxLen = 80): string | null {
  if (!raw) return null;
  const m = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/, "")
    .trim();
  if (!m) return null;
  return m.length > maxLen ? `${m.slice(0, maxLen - 1)}…` : m;
}

/** Detect transaction type from keywords (Finnish + English + generic). */
const TYPE_KEYWORDS: Array<[RegExp, TransactionType]> = [
  [/purchase|payment|osto|kortti|debit|paid/i, "payment"],
  [/income|deposit|salary|palkka|received|credited|saapuu|credit/i, "income"],
  [/withdrawal|cash|atm|nosto/i, "withdrawal"],
  [/fee|maksu|service fee|commission|palvelu/i, "fee"],
  [/transfer|siirto|tilisiirto/i, "transfer"],
];

export function detectType(text: string): TransactionType | null {
  for (const [re, type] of TYPE_KEYWORDS) {
    if (re.test(text)) return type;
  }
  return null;
}

const DATE_DMY_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[T ](\d{1,2})[:.](\d{2}))?/;
const DATE_ISO_RE = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/;

/**
 * Extract the first date from text. Prefers European "27.08.2026 15:42",
 * falls back to ISO "2026-08-27T15:42". Returns a UTC-naive local timestamp
 * or null.
 */
export function extractDate(text: string): string | null {
  const dmy = DATE_DMY_RE.exec(text);
  if (dmy) {
    const [, day, month, year, hour, minute] = dmy;
    return buildLocalTimestamp(
      Number(day),
      Number(month),
      Number(year),
      hour ? Number(hour) : 0,
      minute ? Number(minute) : 0
    );
  }
  const iso = DATE_ISO_RE.exec(text);
  if (iso) {
    const [, year, month, day, hour, minute] = iso;
    return buildLocalTimestamp(
      Number(day),
      Number(month),
      Number(year),
      hour ? Number(hour) : 0,
      minute ? Number(minute) : 0
    );
  }
  return null;
}