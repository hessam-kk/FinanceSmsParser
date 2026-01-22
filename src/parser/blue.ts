/**
 * Blue (بلو) bank — Iranian neobank. Parser for REAL SMS formats:
 *
 *   Deposit (واریز پول):
 *     بلو
 *     واریز پول
 *     حسام عزیز، 750,000 ریال به حساب شما نشست.
 *     موجودی: 38,262,549 ریال
 *     ۱۰:۳۰
 *     ۱۴۰۵.۰۶.۰۵
 *
 *   Withdrawal (برداشت پول):
 *     بلو
 *     برداشت پول
 *     حسام عزیز، 4,500,000 ریال از حساب شما پرید.
 *     موجودی: 25,712,549 ریال
 *     ۱۷:۴۱
 *     ۱۴۰۵.۰۶.۰۴
 *
 *   "Rounded" withdrawal (برداشت رُند): an extra line reports rounding, but the
 *     actual account debit is the main line only (balance math confirms it):
 *     بلو
 *     برداشت رُند
 *     حسام عزیز، 9,479,000 ریال از حساب شما پرید.
 *     و 21,000 ریال هم رند شد.
 *     موجودی: 25,462,549 ریال
 *     ۱۷:۲۲
 *     ۱۴۰۵.۰۵.۳۱
 *
 * Normalization:
 *  - Amounts are stored in **whole thousands of Toman** (Rial ÷ 10,000,
 *    rounded): 750,000 ریال -> -75, 9,479,000 ریال -> 948 (deposits negative,
 *    withdrawals positive, currency label "T").
 *  - Dates stay Jalali as "D month-name" (e.g. "5 شهریور") — no year, no time.
 *  - The موجودی (balance) line must NEVER be used as the transaction amount.
 *  - The "رند شد" rounding line is informational and ignored.
 *  - These SMSes carry no merchant; the bank itself is labeled "blubank".
 *  - The raw SMS is preserved verbatim in D1 (raw_sms).
 */

import { JALALI_MONTHS } from "../utils/dates";
import { MAX_SMS_LENGTH, normalizeText } from "./rules";
import type { BankParser, ParsedTransaction, TransactionType } from "./types";

const AMOUNT_LINE_RE = /([\d,]+)\s*ریال/;
const JALALI_DATE_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/;

export const blueParser: BankParser = {
  name: "blue",

  canParse(text: string): boolean {
    if (!text || text.length > MAX_SMS_LENGTH) return false;
    const firstLine = text.split("\n")[0]?.trim();
    return firstLine === "بلو";
  },

  parse(text: string): ParsedTransaction | null {
    const normalized = normalizeText(text);
    if (!normalized || !this.canParse(normalized)) return null;

    const lines = normalized.split("\n").filter((l) => l.length > 0);

    // ---- transaction type ---------------------------------------------------
    let transactionType: TransactionType | null = null;
    if (/برداشت/.test(normalized)) transactionType = "withdrawal";
    else if (/واریز/.test(normalized)) transactionType = "income";

    // ---- amount: only the deposit/withdrawal line (never the balance) -------
    const amountLine = lines.find((l) => /نشست|پرید/.test(l));
    if (!amountLine) return null;
    const amountMatch = AMOUNT_LINE_RE.exec(amountLine);
    const rawAmount = amountMatch?.[1];
    if (!rawAmount) return null;
    const amount = Number(rawAmount.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const signedAmount = Math.round((transactionType === "income" ? -amount : amount) / 10000);

    // ---- date: last lines are time then Jalali date; keep "D month-name" ----
    let date: string | null = null;
    for (const line of lines) {
      const dm = JALALI_DATE_RE.exec(line);
      const monthName = dm ? JALALI_MONTHS[Number(dm[2]) - 1] : undefined;
      if (dm && monthName && Number(dm[3]) >= 1 && Number(dm[3]) <= 31) {
        date = `${Number(dm[3])} ${monthName}`;
        break;
      }
    }

    let confidence = 0.98;
    if (!date) confidence -= 0.2;

    return {
      amount: signedAmount,
      currency: "T", // thousands of Toman (Rial ÷ 10,000) — the amount line required "ریال"
      date,
      transactionType: transactionType ?? "unknown",
      merchant: "blubank", // no merchant in these SMSes; label the bank itself
      confidence: Math.max(0, Math.min(1, confidence)),
    };
  },
};
