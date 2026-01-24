/**
 * Telegram update handlers — the conversation state machine.
 *
 * States are persisted in D1 (Workers are stateless):
 *
 *   bank SMS parsed        -> transactions.status = 'pending'
 *                             (WAITING_FOR_TITLE)
 *   title received         -> 'awaiting_confirmation'
 *                             (WAITING_FOR_CONFIRMATION)
 *   ✅ Save pressed        -> 'sheet_pending' -> append to Sheets -> 'completed'
 *   ❌ Cancel pressed      -> 'cancelled'
 *   Google append failed   -> 'error' (retryable)
 *
 * Guarantees:
 *  - Only the allowed chat is processed (unauthorized: silent reject).
 *  - Duplicate updates (same update_id, Telegram retries) are ignored.
 *  - Every state change is scoped by telegram_chat_id + a status guard, so an
 *    arbitrary message can never touch an unrelated/completed transaction.
 *  - Save is idempotent: never two rows for one transaction.
 *  - A failed Sheets append is never reported as "saved".
 */

import type { Transaction } from "../types";
import {
  adjustTransactionDate,
  formatAmount,
  formatDateOnlyForDisplay,
  formatTimestampForDisplay,
  formatTimestampForSheet,
} from "../utils/dates";
import { log, logError } from "../utils/logging";
import { getGoogleAccessToken } from "../google/auth";
import { GoogleSheetsClient } from "../google/sheets";
import * as updatesDb from "../db/updates";
import * as txDb from "../db/transactions";
import { parseSms } from "../parser";
import { TelegramClient } from "./client";
import {
  addAnotherKeyboard,
  confirmWithDateKeyboard,
  confirmationKeyboard,
  dateKeyboard,
  parseCallbackData,
} from "./keyboard";
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./types";

export interface TelegramEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_CHAT_ID: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  GOOGLE_SHEET_ID: string;
  GOOGLE_SHEET_NAME: string;
  GOOGLE_TOKEN_CACHE_MAX_AGE_SECONDS?: string;
}

const MAX_TITLE_LENGTH = 100;
const MAX_INPUT_LENGTH = 4000;

const HELP_TEXT = [
  "🤖 Bank SMS Bot",
  "",
  "Forward me a bank SMS (or paste its text) and I'll parse the transaction, ask you for a title, and append it to your Google Sheet after you confirm.",
  "",
  "To add a transaction without a forwarded SMS, tap \"Add manually\" on the saved confirmation — enter the amount and a title.",
  "",
  "Commands:",
  "/start - show this help",
  "/help - show this help",
  "/cancel - cancel the current pending transaction",
].join("\n");

const PARSER_FAILED_TEXT =
  "⚠️ I couldn't reliably parse this bank SMS.\n\nPlease check the message or send it again.";

function isAuthorizedChat(allowed: string | undefined, chatId: number | undefined): boolean {
  if (!allowed || chatId === undefined) return false;
  return allowed.trim() === String(chatId);
}

// The client switches to the Telegram test API automatically for "test-" tokens.
function makeTelegramClient(env: TelegramEnv): TelegramClient {
  return new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN });
}

function makeSheetsClient(env: TelegramEnv): GoogleSheetsClient {
  return new GoogleSheetsClient({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    sheetName: env.GOOGLE_SHEET_NAME,
    getToken: (force) => getGoogleAccessToken(env, force),
  });
}

/**
 * Entry point for a single Telegram update. Throws on failures that must make
 * the webhook return 500 so Telegram retries; the caller (src/index.ts)
 * decides the HTTP status. Never exposes internals to the user.
 */
export async function processTelegramUpdate(
  env: TelegramEnv,
  update: TelegramUpdate
): Promise<void> {
  if (update.message) {
    await handleMessage(env, update.message, update.update_id);
  } else if (update.callback_query) {
    await handleCallbackQuery(env, update.callback_query, update.update_id);
  } else {
    log("telegram_update_ignored", {
      update_id: update.update_id,
      reason: "neither message nor callback_query",
    });
  }
}

// ---------------------------------------------------------------------------
// Messages (SMS, title, commands)
// ---------------------------------------------------------------------------

async function handleMessage(
  env: TelegramEnv,
  msg: TelegramMessage,
  updateId: number
): Promise<void> {
  const chatId = msg.chat?.id;
  if (chatId === undefined) return;

  // Allowlist: only the configured chat is honored, silently for anyone else.
  if (!isAuthorizedChat(env.TELEGRAM_ALLOWED_CHAT_ID, chatId)) {
    log("unauthorized_chat", { chat_id: chatId });
    return;
  }
  if (msg.chat.type !== "private") {
    log("unauthorized_chat", { chat_id: chatId, reason: "non-private chat" });
    return;
  }
  if (await updatesDb.isUpdateProcessed(env.DB, updateId)) {
    log("duplicate_update", { update_id: updateId });
    return;
  }

  const client = makeTelegramClient(env);
  const text = (msg.text ?? "").trim();

  try {
    if (text.startsWith("/")) {
      await handleCommand(env, client, chatId, text);
    } else if (text === "") {
      // Non-text message (photo, sticker...): ignore silently.
      log("telegram_update_ignored", { update_id: updateId, reason: "non-text message" });
    } else if (text.length > MAX_INPUT_LENGTH) {
      await client.sendMessage(chatId, "⚠️ Message too long. Please send it again.");
    } else {
      await handleText(env, client, chatId, msg, text);
    }
    await updatesDb.markUpdateProcessed(env.DB, updateId);
  } catch (err) {
    logError("telegram_update_failed", err, { chat_id: chatId, update_id: updateId });
    throw err; // -> webhook 500 -> Telegram retries the same update_id
  }
}

async function handleCommand(
  env: TelegramEnv,
  client: TelegramClient,
  chatId: number,
  text: string
): Promise<void> {
  const command = text.split(/\s+/)[0];
  switch (command) {
    case "/start":
    case "/help":
      await client.sendMessage(chatId, HELP_TEXT);
      break;
    case "/cancel":
      await cancelPending(env, client, chatId);
      break;
    default:
      await client.sendMessage(chatId, "Unknown command. Use /help.");
  }
}

async function cancelPending(
  env: TelegramEnv,
  client: TelegramClient,
  chatId: number
): Promise<void> {
  const chatIdStr = String(chatId);
  const active = await txDb.getActiveTransaction(env.DB, chatIdStr);
  if (!active) {
    await client.sendMessage(chatId, "Nothing to cancel.");
    return;
  }
  const changed = await txDb.markCancelled(env.DB, active.id, chatIdStr);
  if (changed) {
    log("transaction_cancelled", { transaction_id: active.id });
  }
  await client.sendMessage(chatId, "❌ Cancelled.");
}

async function handleText(
  env: TelegramEnv,
  client: TelegramClient,
  chatId: number,
  msg: TelegramMessage,
  text: string
): Promise<void> {
  const chatIdStr = String(chatId);

  // 1) No active transaction: the message may be a new bank SMS.
  const active = await txDb.getActiveTransaction(env.DB, chatIdStr);
  if (!active) {
    const result = parseSms(text);
    if (!result) {
      await client.sendMessage(chatId, PARSER_FAILED_TEXT);
      log("parser_failed", { chat_id: chatIdStr, message_id: msg.message_id });
      return;
    }
    const tx = await txDb.createTransaction(env.DB, {
      telegram_chat_id: chatIdStr,
      telegram_message_id: msg.message_id,
      raw_sms: text,
      transaction_date: result.parsed.date,
      amount: result.parsed.amount,
      currency: result.parsed.currency,
      transaction_type: result.parsed.transactionType,
      merchant: result.parsed.merchant,
      parser_version: result.parserVersion,
      parser_confidence: result.parsed.confidence,
    });
    log("transaction_parsed", {
      transaction_id: tx.id,
      chat_id: chatIdStr,
      parser: result.parser,
      confidence: result.parsed.confidence,
      type: result.parsed.transactionType,
    });
    await client.sendMessage(chatId, paymentDetectedText(tx), dateKeyboard(tx.id));
    return;
  }

  // 2a) Manual entry: awaiting the amount.
  if (active.status === "manual_amount") {
    const amount = parseManualAmount(text);
    if (amount === null) {
      await client.sendMessage(
        chatId,
        "⚠️ Send a whole number in thousand Toman, e.g. `-75` (deposit) or `948` (withdrawal), or /cancel."
      );
      return;
    }
    if (!(await txDb.saveManualAmount(env.DB, active.id, chatIdStr, amount))) {
      await client.sendMessage(chatId, PARSER_FAILED_TEXT);
      return;
    }
    log("manual_amount_set", { transaction_id: active.id, amount });
    const updated = await txDb.getTransactionById(env.DB, active.id);
    await client.sendMessage(
      chatId,
      `Amount: ${formatAmount(updated?.amount, "T")}\n\nWhat was this for?`
    );
    return;
  }

  // 2) Active transaction exists — the message is a title, unless it clearly
  //    is a NEW bank SMS (high confidence + a date), in which case warn
  //    instead of silently mixing two transactions.
  if (active.status === "pending") {
    const looksLikeSms = parseSms(text);
    if (looksLikeSms && looksLikeSms.parsed.confidence >= 0.7 && looksLikeSms.parsed.date !== null) {
      await client.sendMessage(
        chatId,
        "⚠️ You already have a pending transaction. Finish or cancel it first, then send the new SMS."
      );
      return;
    }
    const title = validateTitle(text);
    if (!title) {
      await client.sendMessage(
        chatId,
        "⚠️ Please send a short title for this payment (1–100 characters), or /cancel."
      );
      return;
    }
    const changed = await txDb.saveTitle(env.DB, active.id, chatIdStr, title);
    if (!changed) {
      // The transaction moved on under us (impossible in single-user flow,
      // but never write to an unrelated transaction).
      await client.sendMessage(
        chatId,
        "⚠️ Your transaction is no longer pending. Please send the SMS again."
      );
      return;
    }
    const updated = await txDb.getTransactionById(env.DB, active.id);
    log("title_received", { transaction_id: active.id });
    // Manual entries (no SMS) default the date to today — run it through the
    // same Save/Edit/Cancel confirmation, plus ➖/➕ so the date is adjustable.
    const isManual = updated?.parser_version === "manual";
    await client.sendMessage(
      chatId,
      confirmationText(updated),
      isManual ? confirmWithDateKeyboard(active.id) : confirmationKeyboard(active.id)
    );
    return;
  }

  // 3) awaiting_confirmation or sheet_pending
  await client.sendMessage(
    chatId,
    "⚠️ You have a transaction waiting for confirmation. Use ✅ Save or ❌ Cancel (or /cancel)."
  );
}

// ---------------------------------------------------------------------------
// Callback queries (✅ Save / ❌ Cancel buttons)
// ---------------------------------------------------------------------------

async function handleCallbackQuery(
  env: TelegramEnv,
  callback: TelegramCallbackQuery,
  updateId: number
): Promise<void> {
  const chatId = callback.message?.chat?.id;
  if (chatId === undefined) {
    await makeTelegramClient(env).answerCallbackQuery(callback.id, { text: "Invalid message" });
    return;
  }
  if (!isAuthorizedChat(env.TELEGRAM_ALLOWED_CHAT_ID, chatId)) {
    log("unauthorized_chat", { chat_id: chatId, kind: "callback" });
    return;
  }
  if (await updatesDb.isUpdateProcessed(env.DB, updateId)) {
    log("duplicate_update", { update_id: updateId, kind: "callback" });
    return;
  }

  const client = makeTelegramClient(env);
  const parsed = parseCallbackData(callback.data);
  if (!parsed) {
    log("invalid_callback", { chat_id: chatId, reason: "bad data" });
    await client.answerCallbackQuery(callback.id, { text: "Invalid action" });
    return;
  }

  // "Add another" has no payload — start a manual entry (no forwarded SMS).
  if (parsed.action === "add_another") {
    await client.answerCallbackQuery(callback.id, { text: "Manual entry started" });
    await txDb.createManualTransaction(env.DB, String(chatId));
    await client.sendMessage(
      chatId,
      "🧾 New manual entry.\n\nSend the amount in thousand Toman — use a minus sign for a deposit and a plain number for a withdrawal.\n\nExamples: `-75` (deposit 75,000 T) · `948` (withdrawal 948,000 T)"
    );
    await updatesDb.markUpdateProcessed(env.DB, updateId);
    return;
  }

  const tx = await txDb.getTransactionById(env.DB, parsed.transactionId ?? -1);
  if (!tx || tx.telegram_chat_id !== String(chatId)) {
    log("invalid_callback", {
      chat_id: chatId,
      transaction_id: parsed.transactionId,
      reason: "transaction not found or not owned by chat",
    });
    await client.answerCallbackQuery(callback.id, { text: "Transaction not found", showAlert: true });
    return;
  }

  try {
    if (parsed.action === "cancel") {
      const changed = await txDb.markCancelled(env.DB, tx.id, String(chatId));
      if (changed) log("transaction_cancelled", { transaction_id: tx.id });
      await client.answerCallbackQuery(callback.id, { text: "Cancelled" });
      await client.sendMessage(chatId, "❌ Cancelled.");
    } else if (parsed.action === "date_minus" || parsed.action === "date_plus") {
      await adjustDateCallback(
        env,
        client,
        callback,
        tx,
        chatId,
        parsed.action === "date_plus" ? 1 : -1
      );
    } else if (parsed.action === "edit_title") {
      const reopened = await txDb.reopenForTitle(env.DB, tx.id, String(chatId));
      if (!reopened) {
        await client.answerCallbackQuery(callback.id, { text: "Too late — /cancel and resend" });
      } else {
        await client.answerCallbackQuery(callback.id, { text: "Send the new title" });
        await client.sendMessage(
          chatId,
          `What should the title be? (current: ${tx.title ?? "—"})`
        );
      }
    } else {
      await confirmAndSave(env, client, tx, chatId, callback.id, callback.message?.message_id);
    }
    await updatesDb.markUpdateProcessed(env.DB, updateId);
  } catch (err) {
    logError("callback_update_failed", err, {
      chat_id: chatId,
      transaction_id: tx.id,
    });
    throw err; // -> retry by Telegram; idempotency guards prevent duplicates
  }
}

async function confirmAndSave(
  env: TelegramEnv,
  client: TelegramClient,
  tx: Transaction,
  chatId: number,
  callbackId: string,
  messageId?: number
): Promise<void> {
  const chatIdStr = String(chatId);

  // Idempotency: never append twice for one transaction.
  if (tx.status === "completed") {
    await client.answerCallbackQuery(callbackId, { text: "Already saved ✅" });
    return;
  }

  if (tx.status !== "sheet_pending") {
    // Claim the transaction BEFORE appending so a crash leaves it retryable.
    const claimed = await txDb.markSheetsPending(env.DB, tx.id, chatIdStr);
    if (!claimed) {
      const current = await txDb.getTransactionById(env.DB, tx.id);
      if (current?.status === "completed") {
        await client.answerCallbackQuery(callbackId, { text: "Already saved ✅" });
      } else {
        await client.answerCallbackQuery(callbackId, { text: "Could not save", showAlert: true });
      }
      return;
    }
  }

  const sheets = makeSheetsClient(env);

  try {
    const result = await sheets.appendTransaction(buildSheetRow(tx));
    log("google_sheet_append_success", {
      transaction_id: tx.id,
      row: result.row,
      range: result.updatedRange,
    });
    const marked = await txDb.markCompletedWithGoogle(
      env.DB,
      tx.id,
      chatIdStr,
      result.row,
      result.updatedRange
    );
    if (!marked) {
      // A concurrent retry completed it already — nothing further to do.
      await client.answerCallbackQuery(callbackId, { text: "Already saved ✅" });
      return;
    }
    await client.answerCallbackQuery(callbackId, { text: "Saved ✅" });
    // Remove the confirmation message — the transaction is done.
    if (messageId !== undefined) {
      await client.deleteMessage(chatId, messageId);
    }
    await client.sendMessage(chatId, successText(tx), addAnotherKeyboard());
    log("transaction_confirmed", { transaction_id: tx.id });
  } catch (err) {
    logError("google_sheet_append_failed", err, { transaction_id: tx.id });
    // Keep the transaction retryable; NEVER claim a save that failed.
    try {
      await txDb.markError(env.DB, tx.id, chatIdStr);
    } catch (markErr) {
      logError("mark_error_failed", markErr, { transaction_id: tx.id });
    }
    await client.answerCallbackQuery(callbackId, { text: "Save failed", showAlert: true });
    const reason = err instanceof Error ? err.message : "unknown error";
    await client.sendMessage(
      chatId,
      `⚠️ Couldn't save to Google Sheets — nothing was written.\n\nReason: ${reason}\n\nFix the cause, then press ✅ Save again.`
    );
  }
}

async function adjustDateCallback(
  env: TelegramEnv,
  client: TelegramClient,
  callback: TelegramCallbackQuery,
  tx: Transaction,
  chatId: number,
  days: number
): Promise<void> {
  const messageId = callback.message?.message_id;
  if (messageId === undefined) {
    await client.answerCallbackQuery(callback.id, { text: "Invalid message" });
    return;
  }
  if (tx.status !== "pending" && tx.status !== "awaiting_confirmation") {
    await client.answerCallbackQuery(callback.id, { text: "Too late — /cancel and resend" });
    return;
  }
  const adjusted = adjustTransactionDate(tx.transaction_date, days);
  if (!adjusted || adjusted === tx.transaction_date) {
    await client.answerCallbackQuery(callback.id, { text: "Date cannot be adjusted" });
    return;
  }
  const changed = await txDb.updateTransactionDate(env.DB, tx.id, String(chatId), adjusted);
  if (!changed) {
    await client.answerCallbackQuery(callback.id, { text: "Too late — /cancel and resend" });
    return;
  }
  log("transaction_date_adjusted", { transaction_id: tx.id, date: adjusted });
  const updated = await txDb.getTransactionById(env.DB, tx.id);
  const isManual = updated?.parser_version === "manual";
  const text =
    updated && tx.status === "awaiting_confirmation"
      ? confirmationText(updated)
      : paymentDetectedText({ ...tx, transaction_date: adjusted });
  await client.editMessageText(
    chatId,
    messageId,
    text,
    isManual ? confirmWithDateKeyboard(tx.id) : dateKeyboard(tx.id)
  );
  await client.answerCallbackQuery(callback.id, {
    text: formatTimestampForDisplay(adjusted) ?? adjusted,
  });
}

// ---------------------------------------------------------------------------
// Validation & message formatting
// ---------------------------------------------------------------------------

function validateTitle(raw: string): string | null {
  const title = raw.trim().replace(/\s+/g, " ");
  if (!title || title.length > MAX_TITLE_LENGTH) return null;
  return title;
}

/**
 * Parse the amount the user types for a manual entry: a whole number in
 * thousand Toman, optional leading minus for a deposit. Returns null on
 * anything non-numeric or with decimals.
 */
function parseManualAmount(raw: string): number | null {
  const trimmed = raw.trim().replace(/[,\s]/g, "");
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value === 0) return null;
  return value;
}

function paymentDetectedText(tx: Transaction): string {
  const date = formatTimestampForDisplay(tx.transaction_date) ?? "unknown";
  const merchant = tx.merchant ?? "unknown";
  return [
    "💳 Payment detected",
    "",
    `Amount: ${formatAmount(tx.amount, tx.currency)}`,
    `Date: ${date}`,
    `Merchant: ${merchant}`,
    "",
    "What was this payment for?",
  ].join("\n");
}

function confirmationText(tx: Transaction | null): string {
  if (!tx) return "⚠️ Transaction not found.";
  const date = formatTimestampForDisplay(tx.transaction_date) ?? "unknown";
  const merchant = tx.merchant ?? "unknown";
  return [
    "Please confirm:",
    "",
    `Date: ${date}`,
    `Amount: ${formatAmount(tx.amount, tx.currency)}`,
    `Merchant: ${merchant}`,
    `Title: ${tx.title ?? "—"}`,
  ].join("\n");
}

function successText(tx: Transaction): string {
  const date = formatDateOnlyForDisplay(tx.transaction_date) ?? "unknown";
  return [
    "✅ Saved to Google Sheets",
    "",
    formatAmount(tx.amount, tx.currency),
    tx.title ?? "",
    date,
  ].join("\n");
}

/**
 * Sheet row: A = Amount, B = Description (title), C = Date — nothing else.
 * Deposits are negative, withdrawals/payments positive — same convention as
 * the stored amount, so it is written as-is. See README.
 */
function buildSheetRow(tx: Transaction): Array<string | number> {
  return [
    tx.amount === null || tx.amount === undefined ? "" : tx.amount, // Amount
    tx.title ?? "", // Description
    formatTimestampForSheet(tx.transaction_date), // Date
  ];
}