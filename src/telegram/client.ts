/**
 * Thin Telegram Bot API client. Uses plain fetch (Web platform), no SDK.
 *
 * TEST MODE: when the bot token starts with "test-", requests go to the
 * official Telegram test infrastructure
 * (https://core.telegram.org/bots/webapps#testing-local-bots) so the whole
 * flow can be exercised locally without touching the production bot.
 */

import { AppError } from "../utils/errors";
import type {
  TelegramApiResponse,
  TelegramMessage,
  TelegramReplyMarkup,
} from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TEST_API_BASE = "https://cloudflare-workers-test-demo.com";

function isTestMode(token: string): boolean {
  return token.startsWith("test-");
}

/** Thrown when the Bot API answers ok:false (bad token, rate limit, ...). */
export class TelegramApiError extends AppError {
  constructor(
    readonly errorCode: number | undefined,
    readonly apiDescription: string
  ) {
    super(`Telegram API error ${errorCode ?? "?"}: ${apiDescription}`);
    this.name = "TelegramApiError";
  }
}

export interface TelegramClientOptions {
  token: string;
  /** Override for tests. Defaults to the production or test API base. */
  apiBase?: string;
}

export class TelegramClient {
  private readonly token: string;
  private readonly base: string;

  constructor(options: TelegramClientOptions) {
    if (!options.token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    this.token = options.token;
    this.base =
      options.apiBase ??
      (isTestMode(options.token) ? TELEGRAM_TEST_API_BASE : TELEGRAM_API_BASE);
  }

  private url(method: string): string {
    return `${this.base}/bot${this.token}/${method}`;
  }

  private async call<T>(method: string, payload: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new AppError(`Telegram network error for ${method}`);
    }

    let json: TelegramApiResponse<T>;
    try {
      json = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new TelegramApiError(
        response.status,
        "non-JSON response from Telegram API"
      );
    }
    if (!json.ok) {
      throw new TelegramApiError(json.error_code ?? response.status, json.description ?? "unknown error");
    }
    return json.result as T;
  }

  sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramReplyMarkup
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  /** Edit an existing message's text (used by the date ➖/➕ buttons). */
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: TelegramReplyMarkup
  ): Promise<boolean> {
    return this.call<boolean>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  /** Must be called for every callback_query so Telegram stops the spinner. */
  answerCallbackQuery(
    callbackQueryId: string,
    options: { text?: string; showAlert?: boolean } = {}
  ): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(options.text ? { text: options.text } : {}),
      ...(options.showAlert !== undefined ? { show_alert: options.showAlert } : {}),
    });
  }
}