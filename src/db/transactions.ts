/**
 * Transaction persistence. Every state transition is an UPDATE scoped by
 * `telegram_chat_id` AND a current-status guard, so a stray message or a
 * forged callback can never mutate an unrelated or completed transaction.
 *
 * State machine (see migration 0001_initial.sql for the meaning of statuses):
 *
 *   (new SMS)             -> pending                 (WAITING_FOR_TITLE)
 *   title saved           -> awaiting_confirmation   (WAITING_FOR_CONFIRMATION)
 *   Save pressed          -> sheet_pending
 *   Google append ok      -> completed
 *   Google append failed  -> error
 *   Cancel pressed        -> cancelled
 */

import type { Transaction } from "../types";
import { nowIso, todayJalali } from "../utils/dates";

export interface NewTransaction {
  telegram_chat_id: string;
  telegram_message_id: number | null;
  raw_sms: string;
  transaction_date: string | null;
  amount: number | null;
  currency: string | null;
  transaction_type: string | null;
  merchant: string | null;
  parser_version: string | null;
  parser_confidence: number | null;
}

export async function createTransaction(
  db: D1Database,
  input: NewTransaction
): Promise<Transaction> {
  const ts = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO transactions (
         telegram_chat_id, telegram_message_id, raw_sms,
         transaction_date, amount, currency, transaction_type, merchant,
         title, status, parser_version, parser_confidence,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?)`
    )
    .bind(
      input.telegram_chat_id,
      input.telegram_message_id,
      input.raw_sms,
      input.transaction_date,
      input.amount,
      input.currency,
      input.transaction_type,
      input.merchant,
      input.parser_version,
      input.parser_confidence,
      ts,
      ts
    )
    .run();
  const id = result.meta.last_row_id;
  const row = await getTransactionById(db, id);
  if (!row) throw new Error("failed to read created transaction");
  return row;
}

export async function getTransactionById(
  db: D1Database,
  id: number
): Promise<Transaction | null> {
  const row = await db
    .prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(id)
    .first();
  return (row as unknown as Transaction | undefined) ?? null;
}

/** Manual-entry state: we asked for the amount, awaiting it. */
export const MANUAL_AMOUNT_STATUS = "manual_amount";

/** The single active (in-progress) transaction for a chat, if any. */
export async function getActiveTransaction(
  db: D1Database,
  chatId: string
): Promise<Transaction | null> {
  const row = await db
    .prepare(
      `SELECT * FROM transactions
       WHERE telegram_chat_id = ? AND status IN ('pending', 'awaiting_confirmation', 'sheet_pending', 'manual_amount')
       ORDER BY id DESC LIMIT 1`
    )
    .bind(chatId)
    .first();
  return (row as unknown as Transaction | undefined) ?? null;
}

/**
 * Create a manual (no forward) pending transaction awaiting its amount.
 * The amount is filled in later; negative = deposit, positive = withdrawal.
 */
export async function createManualTransaction(
  db: D1Database,
  chatId: string
): Promise<Transaction> {
  const ts = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO transactions (
         telegram_chat_id, telegram_message_id, raw_sms, transaction_date, amount,
         currency, transaction_type, merchant, title, status,
         parser_version, parser_confidence, created_at, updated_at
       ) VALUES (?, NULL, 'MANUAL', ?, NULL, 'T', NULL, 'blubank', NULL, 'manual_amount', 'manual', NULL, ?, ?)`
    )
    .bind(chatId, todayJalali(), ts, ts)
    .run();
  const id = result.meta.last_row_id;
  const row = await getTransactionById(db, id);
  if (!row) throw new Error("failed to read manual transaction");
  return row;
}

/** Fill in a manual transaction's amount (only from manual_amount). */
export async function saveManualAmount(
  db: D1Database,
  id: number,
  chatId: string,
  amount: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transactions
       SET amount = ?, transaction_type = ?, status = 'pending', updated_at = ?
       WHERE id = ? AND telegram_chat_id = ? AND status = 'manual_amount'`
    )
    .bind(amount, amount < 0 ? "income" : "withdrawal", nowIso(), id, chatId)
    .run();
  return result.meta.changes > 0;
}

/** Overwrite the transaction date (date ➖/➕ buttons; only while pending). */
export async function updateTransactionDate(
  db: D1Database,
  id: number,
  chatId: string,
  date: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transactions
       SET transaction_date = ?, updated_at = ?
       WHERE id = ? AND telegram_chat_id = ? AND status IN ('pending', 'awaiting_confirmation')`
    )
    .bind(date, nowIso(), id, chatId)
    .run();
  return result.meta.changes > 0;
}

/** Attach the title and move to awaiting_confirmation (only from pending). */
export async function saveTitle(
  db: D1Database,
  id: number,
  chatId: string,
  title: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transactions
       SET title = ?, status = 'awaiting_confirmation', updated_at = ?
       WHERE id = ? AND telegram_chat_id = ? AND status = 'pending'`
    )
    .bind(title, nowIso(), id, chatId)
    .run();
  return result.meta.changes > 0;
}

/** Move an awaiting_confirmation transaction back to pending so the title can
 * be typed again (✏️ Edit button). Status guard keeps it scoped by chat. */
export async function reopenForTitle(
  db: D1Database,
  id: number,
  chatId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transactions
       SET status = 'pending', updated_at = ?
       WHERE id = ? AND telegram_chat_id = ? AND status = 'awaiting_confirmation'`
    )
    .bind(nowIso(), id, chatId)
    .run();
  return result.meta.changes > 0;
}

/** Claim the transaction for Google Sheets append (only from awaiting_confirmation). */
export async function markSheetsPending(
  db: D1Database,
  id: number,
  chatId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transactions
       SET status = 'sheet_pending', updated_at = ?
       WHERE id = ? AND telegram_chat_id = ? AND status = 'awaiting_confirmation'`
    )
    .bind(nowIso(), id, chatId)
    .run();
  return result.meta.changes > 0;
}

/** Record a successful Google Sheets append (only from sheet_pending). */
export async function markCompletedWithGoogle(
  db: D1Database,
  id: number,
  chatId: string,
  row: number,
  updatedRange: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transactions
       SET status = 'completed', google_sheet_row = ?, google_sheet_updated_range = ?, updated_at = ?
       WHERE id = ? AND telegram_chat_id = ? AND status = 'sheet_pending'`
    )
    .bind(row, updatedRange, nowIso(), id, chatId)
    .run();
  return result.meta.changes > 0;
}

/** Cancelled by the user (only from pending / awaiting_confirmation). */
export async function markCancelled(
  db: D1Database,
  id: number,
  chatId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transactions
       SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND telegram_chat_id = ? AND status IN ('pending', 'awaiting_confirmation', 'manual_amount')`
    )
    .bind(nowIso(), id, chatId)
    .run();
  return result.meta.changes > 0;
}

/** Mark failed (Only from the in-progress statuses; never from completed). */
export async function markError(
  db: D1Database,
  id: number,
  chatId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transactions
       SET status = 'error', updated_at = ?
       WHERE id = ? AND telegram_chat_id = ? AND status IN ('pending', 'awaiting_confirmation', 'sheet_pending', 'manual_amount')`
    )
    .bind(nowIso(), id, chatId)
    .run();
  return result.meta.changes > 0;
}