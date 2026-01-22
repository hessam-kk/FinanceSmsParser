/**
 * Generic bank SMS parser.
 *
 * Works on label-driven messages such as:
 *
 *   Purchase: EUR 24.50
 *   Card ending 1234
 *   Merchant: K-Market
 *   27.08.2026 15:42
 *
 * It looks for explicit field labels and known keywords. When a real bank's
 * format is known, add a dedicated parser (see template.ts) BEFORE this one in
 * src/parser/index.ts — the first parser whose `canParse` returns true wins.
 */

import {
  MAX_SMS_LENGTH,
  cleanMerchant,
  detectType,
  extractDate,
  findAmounts,
  normalizeText,
} from "./rules";
import type { BankParser, ParsedTransaction, TransactionType } from "./types";

/**
 * Signals that the message might be a bank SMS. Being strict here is
 * important: an SMS that merely contains a number (promo codes, OTP codes,
 * "free shipping over 50€") must NOT be treated as a transaction.
 */
const SIGNAL_RE =
  /purchase|payment|income|deposit|salary|withdrawal|cash(?!back)|atm|fee|transfer|siirto|tilisiirto|osto|kortti|nosto|maksu|debit|credit|received|credited|palkka|amount|saldo|balance|card/i;

/** Lines that carry an explicit "label: value" field. */
const LABELED_LINES: Array<{ label: "merchant" | "amount" | "type"; re: RegExp }> = [
  { label: "merchant", re: /^(?:merchant|kauppias|store|shop)\s*[:=]?\s*(.+)$/i },
  { label: "amount", re: /^(?:amount|summa)\s*[:=]?\s*(.+)$/i },
  {
    label: "type",
    re: /^(purchase|payment|income|deposit|withdrawal|cash|fee|transfer|osto|nosto|siirto|tilisiirto)\s*[:=]?\s*(.*)$/i,
  },
];

export const genericParser: BankParser = {
  name: "generic",

  canParse(text: string): boolean {
    if (!text || text.length > MAX_SMS_LENGTH) return false;
    if (!SIGNAL_RE.test(text)) return false;
    return findAmounts(text).length > 0;
  },

  parse(text: string): ParsedTransaction | null {
    const normalized = normalizeText(text);
    if (!normalized || !this.canParse(normalized)) return null;

    let labeledMerchant: string | null = null;
    let labeledAmount: number | null = null;
    let labeledType: TransactionType | null = null;

    for (const line of normalized.split("\n")) {
      for (const { label, re } of LABELED_LINES) {
        const m = re.exec(line);
        if (!m) continue;
        const value = m[2]?.trim() ?? m[1]?.trim() ?? "";
        if (label === "merchant" && value && !/\d/.test(value)) {
          labeledMerchant = cleanMerchant(value);
        } else if (label === "amount" && value) {
          const parsed = findAmounts(value)[0];
          if (parsed) labeledAmount = parsed.amount;
        } else if (label === "type") {
          labeledType = detectType(line) ?? null;
          // "Purchase: K-Market" — a non-numeric value is a merchant.
          if (labeledType && value && !/\d/.test(value)) {
            labeledMerchant = cleanMerchant(value);
          }
        }
      }
    }

    const amounts = findAmounts(normalized);
    // Prefer a labeled amount; otherwise an amount carrying a currency
    // (card numbers etc. have none); fail closed when nothing fits.
    const picked =
      labeledAmount !== null
        ? amounts.find((a) => a.amount === labeledAmount) ?? null
        : amounts.find((a) => a.currency !== null) ?? amounts[0] ?? null;
    if (!picked || picked.amount === 0) return null;

    // ---- type -------------------------------------------------------------
    let type: TransactionType = labeledType ?? detectType(normalized) ?? "unknown";
    if (type === "unknown") {
      type = picked.amount < 0 ? "payment" : "income";
    }

    // ---- sign normalization -----------------------------------------------
    // Ledger convention: money out (payments/withdrawals/fees) is positive,
    // money in (income/deposits) is negative.
    let amount = picked.amount;
    if (type === "payment" || type === "withdrawal" || type === "fee") {
      if (amount < 0) amount = -amount;
    } else if (type === "income") {
      if (amount > 0) amount = -amount;
    }

    // ---- confidence -------------------------------------------------------
    let confidence = labeledAmount !== null ? 0.95 : 0.85;
    if (!picked.currency) confidence -= 0.12;
    let date = extractDate(normalized);
    if (!date) confidence -= 0.15;
    if (!labeledMerchant) confidence -= 0.08;
    if (!labeledType && !detectType(normalized)) confidence -= 0.1;

    return {
      amount,
      currency: picked.currency,
      date,
      transactionType: type,
      merchant: labeledMerchant,
      confidence: Math.max(0, Math.min(1, confidence)),
    };
  },
};