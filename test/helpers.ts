/**
 * Shared test helpers. Everything here is plain code (no cloudflare:test
 * imports) so it can be used from any test file.
 *
 * Mocking strategy: the main worker runs in the SAME isolate as the tests
 * (that is what `SELF` does in @cloudflare/vitest-pool-workers), so
 * `vi.stubGlobal("fetch", ...)` reaches the worker's outbound calls too. This
 * keeps Telegram/Google integration tests fully offline and deterministic.
 */

import migrationSql from "../migrations/0001_initial.sql?raw";
import type { TelegramUpdate } from "../src/telegram/types";

// ---------------------------------------------------------------------------
// D1 schema + reset
// ---------------------------------------------------------------------------

/** Create tables (idempotent — the migration uses IF NOT EXISTS). */
export async function applySchema(db: D1Database): Promise<void> {
  // The D1 test API executes one statement at a time, so strip comment lines
  // and split on ";" (the migration contains no "in-string" semicolons).
  const sql = migrationSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const raw of sql.split(";")) {
    const statement = raw.replace(/\s+/g, " ").trim();
    if (statement) await db.exec(statement);
  }
}

/** Wipe data between tests (schema stays). */
export async function resetDb(db: D1Database): Promise<void> {
  await db.exec("DELETE FROM processed_updates; DELETE FROM transactions;");
}

// ---------------------------------------------------------------------------
// Outbound fetch mock (routes by URL)
// ---------------------------------------------------------------------------

export interface MockRoute {
  method: string;
  match: (url: URL) => boolean;
  handler: (req: Request) => Response | Promise<Response>;
}

export interface CapturedCall {
  url: string;
  method: string;
  body: unknown; // parsed JSON when possible
  headers: Record<string, string>;
}

export interface FetchMock {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: CapturedCall[];
}

export function installFetchMock(routes: MockRoute[] = []): FetchMock {
  const calls: CapturedCall[] = [];
  const active: MockRoute[] = [...routes];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
    const method = (init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method) ?? "GET").toUpperCase();
    const rawBody = String(init?.body ?? "");
    let body: unknown = undefined;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    calls.push({ url: url.href, method, body, headers });

    for (const route of active) {
      if (route.method === method && route.match(url)) {
        // Construct the Request without a body for GET (workerd rejects GET
        // requests with a body string).
        const requestInit: RequestInit = { method, headers: headers as Record<string, string> };
        if (method !== "GET") requestInit.body = rawBody;
        return route.handler(new Request(url, requestInit));
      }
    }
    throw new Error(`[test] no mock route for ${method} ${url.href} — did you forget to stub it?`);
  };

  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// Telegram route
// ---------------------------------------------------------------------------

export interface TelegramMock {
  route: MockRoute;
  sendMessageBodies: Array<{ text: string; reply_markup?: { inline_keyboard: unknown[][] } }>;
  answerBodies: Array<{ callback_query_id: string; text?: string; show_alert?: boolean }>;
  editBodies: Array<{ text: string; reply_markup?: { inline_keyboard: unknown[][] } }>;
  deletedIds: number[];
}

const TELEGRAM_HOST = "cloudflare-workers-test-demo.com"; // test-mode base

export function telegramRoute(token: string): TelegramMock {
  const sendMessageBodies: TelegramMock["sendMessageBodies"] = [];
  const answerBodies: TelegramMock["answerBodies"] = [];
  const deletedIds: number[] = [];
  const editBodies: TelegramMock["editBodies"] = [];

  const route: MockRoute = {
    method: "POST",
    match: (url) => url.host === TELEGRAM_HOST && url.pathname.startsWith(`/bot${token}/`),
    handler: async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      const method = req.url.split("/").pop() ?? "";
      if (method === "sendMessage") {
        sendMessageBodies.push({
          text: String(body.text ?? ""),
          reply_markup: body.reply_markup as TelegramMock["sendMessageBodies"][0]["reply_markup"],
        });
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 1,
              date: 1,
              chat: { id: body.chat_id, type: "private" },
              text: body.text,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (method === "deleteMessage") {
        deletedIds.push(Number(body.message_id ?? 0));
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "editMessageText") {
        editBodies.push({
          text: String(body.text ?? ""),
          reply_markup: body.reply_markup as TelegramMock["editBodies"][0]["reply_markup"],
        });
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "answerCallbackQuery") {
        answerBodies.push({
          callback_query_id: String(body.callback_query_id ?? ""),
          text: body.text ? String(body.text) : undefined,
          show_alert: typeof body.show_alert === "boolean" ? body.show_alert : undefined,
        });
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "unsupported" }), {
        status: 400,
      });
    },
  };

  return { route, sendMessageBodies, answerBodies, editBodies, deletedIds };
}

// ---------------------------------------------------------------------------
// Google routes
// ---------------------------------------------------------------------------

export interface GoogleTokenMock {
  route: MockRoute;
  /** Fail the token exchange: responses with error when true. */
  fail: () => void;
}

export function googleTokenRoute(tokens: string[] = ["test-access-token-1"]): GoogleTokenMock {
  let count = 0;
  let shouldFail = false;
  const route: MockRoute = {
    method: "POST",
    match: (url) => url.host === "oauth2.googleapis.com" && url.pathname === "/token",
    handler: async () => {
      count += 1;
      if (shouldFail) {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "bad key" }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          access_token: tokens[Math.min(count - 1, tokens.length - 1)] ?? "test-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  };
  return { route, fail: () => (shouldFail = true) };
}

export interface SheetsAppendMock {
  route: MockRoute;
  appended: Array<{ values: unknown[]; auth: string }>;
  /** 401 once, then OK (exercises token refresh retry). */
  authFailFirst: boolean;
  /** Always respond 500. */
  httpError: boolean;
  /** Respond 200 but without updatedRange. */
  missingRange: boolean;
}

export function sheetsRoutes(
  spreadsheetId: string,
  opts: {
    appendBehavior?: "ok" | "http500" | "missingRange" | "authFailFirst";
  } = {}
): { appendRoute: MockRoute; appendMock: SheetsAppendMock } {
  const flags = {
    authFailFirst: opts.appendBehavior === "authFailFirst",
    httpError: opts.appendBehavior === "http500",
    missingRange: opts.appendBehavior === "missingRange",
  };
  const appended: SheetsAppendMock["appended"] = [];
  let nextRow = 2;

  const appendRoute: MockRoute = {
    method: "POST",
    match: (url) => url.host === "sheets.googleapis.com" && url.pathname.endsWith(":append"),
    handler: async (req) => {
      const auth = req.headers.get("authorization") ?? "";
      const payload = (await req.json()) as { values: unknown[][] };
      appended.push({ values: payload.values[0] ?? [], auth });
      if (flags.httpError) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (flags.authFailFirst && appended.length === 1) {
        return new Response(JSON.stringify({ error: { message: "invalid token" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (flags.missingRange) {
        return new Response(
          JSON.stringify({ spreadsheetId, updates: { updatedRows: 1, updatedCells: 10 } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      const row = nextRow++;
      const col = String.fromCharCode(64 + Math.min(payload.values[0]?.length ?? 10, 26));
      return new Response(
        JSON.stringify({
          spreadsheetId,
          tableRange: "Transactions!A1:J1",
          updates: {
            spreadsheetId,
            updatedRange: `Transactions!A${row}:${col}${row}`,
            updatedRows: 1,
            updatedColumns: payload.values[0]?.length ?? 10,
            updatedCells: (payload.values[0]?.length ?? 10) * 1,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  };

  return {
    appendRoute,
    appendMock: { route: appendRoute, appended, ...flags },
  };
}

// ---------------------------------------------------------------------------
// Telegram update builders
// ---------------------------------------------------------------------------

export function messageUpdate(
  updateId: number,
  chatId: number,
  text: string,
  messageId = 1
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: chatId, is_bot: false, first_name: "Tester" },
      chat: { id: chatId, type: "private" },
      date: 1_700_000_000,
      text,
    },
  };
}

export function callbackUpdate(
  updateId: number,
  chatId: number,
  data: string,
  messageId = 10
): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: chatId, is_bot: false, first_name: "Tester" },
      message: {
        message_id: messageId,
        chat: { id: chatId, type: "private" },
        date: 1_700_000_000,
        text: "Please confirm:",
      },
      data,
    },
  };
}

export function webhookRequest(update: TelegramUpdate, secret = "test-webhook-secret"): Request {
  return new Request("https://example.com/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    body: JSON.stringify(update),
  });
}