/**
 * Parser types. The parser is a pure, deterministic module: it has no
 * knowledge of Telegram, D1 or Google Sheets, so new banks/formats can be
 * added without touching anything else.
 */

export type TransactionType =
  | "payment"
  | "income"
  | "transfer"
  | "withdrawal"
  | "fee"
  | "unknown";

export interface ParsedTransaction {
  /** Money out (payments/withdrawals/fees) positive; money in (income) negative. */
  amount: number;
  /** Normalized 3-letter code, e.g. "EUR". */
  currency: string | null;
  /** UTC-naive local timestamp "YYYY-MM-DDTHH:MM:SS" (bank wall-clock time). */
  date: string | null;
  transactionType: TransactionType;
  merchant: string | null;
  /** 0..1. Below MIN_CONFIDENCE the SMS is rejected. */
  confidence: number;
}

export interface BankParser {
  /** Short unique name used in logs and stored in `parser_version`. */
  name: string;
  /** Cheap deterministic pre-check; `parse` is only called when true. */
  canParse(text: string): boolean;
  /** Returns null when this parser cannot produce a confident result. */
  parse(text: string): ParsedTransaction | null;
}

export interface ParseResult {
  parsed: ParsedTransaction;
  /** Parser name (registry key), e.g. "blue", "generic". */
  parser: string;
  /** Version string stored in `transactions.parser_version`. */
  parserVersion: string;
}