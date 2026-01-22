/**
 * Shared types + the Worker `Env` binding type.
 */

export type TransactionStatus =
  | "pending" // WAITING_FOR_TITLE
  | "awaiting_confirmation" // WAITING_FOR_CONFIRMATION (title set)
  | "sheet_pending" // Save pressed; Google Sheets append in flight / retryable
  | "completed" // appended to Google Sheets
  | "cancelled" // user cancelled
  | "manual_amount" // manual entry: awaiting the typed amount
  | "error"; // processing failed (never falsely reported as saved)

export interface Transaction {
  id: number;
  telegram_chat_id: string;
  telegram_message_id: number | null;
  raw_sms: string;
  transaction_date: string | null;
  amount: number | null;
  currency: string | null;
  transaction_type: string | null;
  merchant: string | null;
  title: string | null;
  status: TransactionStatus;
  parser_version: string | null;
  parser_confidence: number | null;
  google_sheet_row: number | null;
  google_sheet_updated_range: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Worker bindings. Secrets come from production Cloudflare secrets or the
 * local `.dev.vars` file; non-secret values from `wrangler.toml` `[vars]`.
 */
export interface Env {
  DB: D1Database;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_CHAT_ID: string;

  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;

  GOOGLE_SHEET_ID: string;
  GOOGLE_SHEET_NAME: string;

  /** Optional webhook verification token (X-Telegram-Bot-Api-Secret-Token). */
  TELEGRAM_WEBHOOK_SECRET?: string;

  /**
   * Hard limit for how long (seconds) a cached Google access token is reused
   * (defaults to the 1h token lifetime). Mostly useful in tests.
   */
  GOOGLE_TOKEN_CACHE_MAX_AGE_SECONDS?: string;
}

export const SERVICE_NAME = "bank-telegram-bot";