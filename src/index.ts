/**
 * Cloudflare Worker entrypoint.
 *
 * Routes:
 *   GET  /health            -> {"ok": true, "service": "bank-telegram-bot"}
 *   POST /telegram/webhook  -> Telegram webhook (secret-token verified)
 *
 * Webhook security: only POSTs carrying the `X-Telegram-Bot-Api-Secret-Token`
 * header equal to TELEGRAM_WEBHOOK_SECRET are accepted. Payload size is
 * capped and the JSON body is validated before any processing.
 */

import { SERVICE_NAME, type Env } from "./types";
import { log, logError } from "./utils/logging";
import { processTelegramUpdate, type TelegramEnv } from "./telegram/handlers";
import type { TelegramUpdate } from "./telegram/types";

/** Telegram payloads are small; anything bigger is rejected wholesale. */
const MAX_WEBHOOK_BODY_BYTES = 32_768;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: SERVICE_NAME, time: new Date().toISOString() });
      }
      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
        return await handleWebhook(request, env);
      }
      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      logError("worker_unhandled_error", err);
      // Never expose stack traces or internals to the caller.
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_WEBHOOK_BODY_BYTES) {
    log("webhook_too_large", { content_length: contentLength });
    return json({ ok: true }); // drop the payload; don't ask Telegram to retry
  }

  // Secret-token verification: Telegram sends this exact header when the
  // webhook was registered with secret_token.
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = request.headers.get("x-telegram-bot-api-secret-token");
    if (!header || !constantTimeEqual(header, secret)) {
      log("webhook_secret_mismatch", {});
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  }

  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BODY_BYTES) {
    log("webhook_too_large", { bytes: raw.length });
    return json({ ok: true });
  }

  let update: TelegramUpdate;
  try {
    update = JSON.parse(raw) as TelegramUpdate;
  } catch {
    log("webhook_invalid_json", {});
    return json({ ok: true, ignored: "invalid_json" });
  }

  if (!isTelegramUpdate(update)) {
    log("webhook_invalid_payload", {});
    return json({ ok: true, ignored: "invalid_payload" });
  }

  try {
    await processTelegramUpdate(env as unknown as TelegramEnv, update);
    return json({ ok: true });
  } catch (err) {
    logError("webhook_processing_failed", err);
    // 500 -> Telegram retries the same update_id; dedup + idempotency guards
    // make retries safe (no duplicated transactions or sheet rows).
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.update_id !== "number" || !Number.isInteger(v.update_id)) return false;
  return Boolean(v.message || v.callback_query);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}