/**
 * TEMPLATE — how to add a real bank's SMS format.
 *
 * When you have a real SMS from your bank, copy this file, name it after the
 * bank (e.g. `nordea.ts`), and fill in:
 *   1. `canParse`  — return true when the text matches your bank's pattern(s)
 *                    (be strict, so unrelated messages are never claimed).
 *   2. `parse`     — extract the fields with your bank's regexes and return a
 *                    normalized ParsedTransaction, or null when unsure.
 *
 * Then register it BEFORE the generic fallback in src/parser/index.ts:
 *
 *   const parsers: BankParser[] = [
 *     nordeaParser,
 *     genericParser,
 *   ];
 *
 * Reuse the helpers from `./rules`: normalizeText, splitAmountToken,
 * findAmounts, extractDate, cleanMerchant, detectType, normalizeCurrency.
 * The signature of parse receives ALREADY-normalized text (single spaces per
 * line, unicode dashes unified, whitespace trimmed).
 *
 * The parser must be deterministic. Do not invent a fake bank format here —
 * replace these placeholders only with real SMS examples you have received.
 */

import type { BankParser, ParsedTransaction } from "./types";

export const myBankParser: BankParser = {
  name: "my-bank",

  canParse(_text: string): boolean {
    // TODO(you): e.g. /^OP-pankki|Nordea/.test(text) or a distinctive header
    // line that only your bank's SMS contains. Return false until you add a
    // real pattern.
    return false;
  },

  parse(_text: string): ParsedTransaction | null {
    // NOTE: `_text` arrives already normalized (see ./rules normalizeText).
    // TODO(you): extract real fields here, e.g.:
    //
    //   const amountMatch = /Osto\s+([\d.,]+)\s*([A-Za-z]{3})?/.exec(_text);
    //   const amount = parseNumber(amountMatch[1]);
    //   return {
    //     amount: amount, // positive for money out, negative for money in
    //     currency: normalizeCurrency(amountMatch[2]),
    //     date: extractDate(_text),
    //     transactionType: "payment",
    //     merchant: cleanMerchant("Place Name"),
    //     confidence: 0.98,
    //   };
    //
    // IMPORTANT: never return a made-up amount. When in doubt, return null so
    // the generic parser gets a chance (or the message is rejected as
    // unparseable).
    return null;
  },
};