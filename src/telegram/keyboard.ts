/**
 * Inline keyboard + callback-data validation.
 *
 * Callback data formats:
 *   `save:<tx_id>` / `cancel:<tx_id>` — confirmation buttons
 *   `date_minus:<tx_id>` / `date_plus:<tx_id>` — one-day date adjusters
 * `parseCallbackData` strictly validates the shape; the transaction id alone
 * is NOT enough — the handler always re-checks ownership in D1.
 */

import type { TelegramReplyMarkup } from "./types";

export const CALLBACK_SAVE_PREFIX = "save:";
export const CALLBACK_CANCEL_PREFIX = "cancel:";
export const CALLBACK_DATE_MINUS_PREFIX = "date_minus:";
export const CALLBACK_DATE_PLUS_PREFIX = "date_plus:";
export const CALLBACK_ADD_ANOTHER = "add_another";
export const CALLBACK_EDIT_PREFIX = "edit_title:";

export type CallbackAction =
  | "save"
  | "cancel"
  | "date_minus"
  | "date_plus"
  | "add_another"
  | "edit_title";

export interface ParsedCallback {
  action: CallbackAction;
  /** A valid positive integer, or null for actions without a payload. */
  transactionId: number | null;
}

export function confirmationKeyboard(transactionId: number): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Save", callback_data: `${CALLBACK_SAVE_PREFIX}${transactionId}` },
        { text: "✏️ Edit", callback_data: `${CALLBACK_EDIT_PREFIX}${transactionId}` },
        { text: "❌ Cancel", callback_data: `${CALLBACK_CANCEL_PREFIX}${transactionId}` },
      ],
    ],
  };
}

/** ➖/➕ one-day adjusters + a Cancel button, shown on the "Payment detected" message. */
export function dateKeyboard(transactionId: number): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "➖", callback_data: `${CALLBACK_DATE_MINUS_PREFIX}${transactionId}` },
        { text: "➕", callback_data: `${CALLBACK_DATE_PLUS_PREFIX}${transactionId}` },
      ],
      [{ text: "❌ Cancel", callback_data: `${CALLBACK_CANCEL_PREFIX}${transactionId}` }],
    ],
  };
}

/** Date ➖/➕ on one row, then Save / Edit / Cancel — used on the confirmation. */
export function confirmWithDateKeyboard(transactionId: number): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "➖", callback_data: `${CALLBACK_DATE_MINUS_PREFIX}${transactionId}` },
        { text: "➕", callback_data: `${CALLBACK_DATE_PLUS_PREFIX}${transactionId}` },
      ],
      [
        { text: "✅ Save", callback_data: `${CALLBACK_SAVE_PREFIX}${transactionId}` },
        { text: "✏️ Edit", callback_data: `${CALLBACK_EDIT_PREFIX}${transactionId}` },
        { text: "❌ Cancel", callback_data: `${CALLBACK_CANCEL_PREFIX}${transactionId}` },
      ],
    ],
  };
}

/** "Add another" button on the success message. Has no payload. */
export function addAnotherKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [[{ text: "Add manually ➕", callback_data: CALLBACK_ADD_ANOTHER }]],
  };
}

export function parseCallbackData(
  data: string | undefined
): ParsedCallback | null {
  if (!data) return null;
  // "add_another" carries no payload.
  if (data === CALLBACK_ADD_ANOTHER) {
    return { action: "add_another", transactionId: null };
  }
  const match = /^(save|cancel|date_minus|date_plus|edit_title):(\d{1,18})$/.exec(data);
  if (!match) return null;
  const transactionId = Number(match[2]);
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) return null;
  return { action: match[1] as CallbackAction, transactionId };
}
