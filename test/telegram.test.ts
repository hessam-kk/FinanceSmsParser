/**
 * End-to-end workflow tests through the real Worker (SELF fetch) with D1:
 * SMS → pending → title → confirmation → Google Sheets → completed, plus
 * cancel, duplicate updates, unauthorized access, and failure handling.
 *
 * Telegram and Google calls are mocked via the global fetch stub; D1 is real.
 */
import { beforeEach, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applySchema, resetDb, installFetchMock, telegramRoute, googleTokenRoute, sheetsRoutes, messageUpdate, callbackUpdate, webhookRequest } from "./helpers";

const CHAT_ID = 999999999; // TELEGRAM_ALLOWED_CHAT_ID in vitest.config.ts
const TOKEN = "test-bot-token"; // starts with test- → test-mode API base

const SMS_TEXT = `Purchase: EUR 24.50
Card ending 1234
Merchant: K-Market
27.08.2026 15:42`;

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await resetDb(env.DB);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function installMocks(opts: { existingIds?: number[]; appendBehavior?: "ok" | "http500" | "missingRange" | "authFailFirst" } = {}) {
  const telegram = telegramRoute(TOKEN);
  const token = googleTokenRoute(["token-a", "token-b"]);
  const sheets = sheetsRoutes("test-spreadsheet-id", opts);
  const mocks = installFetchMock([telegram.route, token.route, sheets.appendRoute]);
  vi.stubGlobal("fetch", mocks.fetch);
  return { telegram, sheets };
}

async function postWebhook(update: Parameters<typeof webhookRequest>[0], secret = "test-webhook-secret") {
  return SELF.fetch(webhookRequest(update, secret));
}

async function firstTransaction() {
  return (await env.DB.prepare("SELECT * FROM transactions ORDER BY id ASC LIMIT 1").first()) as Record<string, unknown> | null;
}

describe("health + webhook security", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("bank-telegram-bot");
  });

  it("rejects unknown routes", async () => {
    const res = await SELF.fetch("https://example.com/nope");
    expect(res.status).toBe(404);
  });

  it("rejects webhook POSTs without the secret token header", async () => {
    installMocks();
    const res = await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT), "");
    expect(res.status).toBe(401);
    expect(await firstTransaction()).toBeNull();
  });

  it("rejects malformed JSON with 200 (no retry storm)", async () => {
    installMocks();
    const res = await SELF.fetch(
      new Request("https://example.com/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-webhook-secret" },
        body: "not json {",
      })
    );
    expect(res.status).toBe(200);
  });
});

describe("authorization", () => {
  it("silently ignores messages from unauthorized chats", async () => {
    const { telegram } = installMocks();
    const res = await postWebhook(messageUpdate(1, 12345, SMS_TEXT));
    expect(res.status).toBe(200);
    expect(telegram.sendMessageBodies).toHaveLength(0);
    expect(await firstTransaction()).toBeNull();
  });

  it("silently ignores callbacks from unauthorized chats", async () => {
    const { telegram } = installMocks();
    const res = await postWebhook(callbackUpdate(1, 12345, "save:1"));
    expect(res.status).toBe(200);
    expect(telegram.answerBodies).toHaveLength(0);
  });
});

describe("SMS → pending transaction", () => {
  it("parses the SMS, stores it and asks for a title", async () => {
    const { telegram } = installMocks();
    const res = await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    expect(res.status).toBe(200);

    expect(telegram.sendMessageBodies).toHaveLength(1);
    const sent = telegram.sendMessageBodies[0]!;
    expect(sent.text).toContain("💳 Payment detected");
    expect(sent.text).toContain("25 EUR"); // whole numbers only, no decimals
    expect(sent.text).toContain("K-Market");
    expect(sent.text).toContain("What was this payment for?");

    const tx = await firstTransaction();
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe("pending");
    expect(tx!.amount).toBe(24.5);
    expect(tx!.currency).toBe("EUR");
    expect(tx!.transaction_date).toBe("2026-08-27T15:42:00");
    expect(tx!.transaction_type).toBe("payment");
    expect(tx!.merchant).toBe("K-Market");
    expect(tx!.raw_sms).toBe(SMS_TEXT);
    expect(tx!.parser_version).toBe("generic-1");
    expect(typeof tx!.parser_confidence).toBe("number");
  });

  it("rejects unparseable SMS with the standard message", async () => {
    const { telegram } = installMocks();
    const res = await postWebhook(messageUpdate(1, CHAT_ID, "Your code is 482913"));
    expect(res.status).toBe(200);
    expect(telegram.sendMessageBodies[0]!.text).toContain("couldn't reliably parse");
    expect(await firstTransaction()).toBeNull();
  });
});

describe("duplicate updates", () => {
  it("ignores a repeated webhook delivery with the same update_id", async () => {
    const { telegram } = installMocks();
    const update = messageUpdate(7, CHAT_ID, SMS_TEXT);
    expect((await postWebhook(update)).status).toBe(200);
    expect(telegram.sendMessageBodies).toHaveLength(1);

    expect((await postWebhook(update)).status).toBe(200);
    expect(telegram.sendMessageBodies).toHaveLength(1); // no duplicate reply
    expect(await firstTransaction()).not.toBeNull();
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>();
    expect(countRow?.n ?? 0).toBe(1);
  });
});

describe("title workflow", () => {
  async function pendingSms(updateId = 1): Promise<void> {
    await postWebhook(messageUpdate(updateId, CHAT_ID, SMS_TEXT));
  }

  it("stores the title and shows confirmation with Save/Cancel buttons", async () => {
    const { telegram } = installMocks();
    await pendingSms(1);
    await postWebhook(messageUpdate(2, CHAT_ID, "  Groceries  "));

    const tx = await firstTransaction();
    expect(tx!.status).toBe("awaiting_confirmation");
    expect(tx!.title).toBe("Groceries");

    const sent = telegram.sendMessageBodies[1]!;
    expect(sent.text).toContain("Please confirm:");
    expect(sent.text).toContain("Title: Groceries");
    const keyboard = sent.reply_markup?.inline_keyboard;
    expect(keyboard).toEqual([
      [
        { text: "✅ Save", callback_data: `save:${tx!.id}` },
        { text: "✏️ Edit", callback_data: `edit_title:${tx!.id}` },
        { text: "❌ Cancel", callback_data: `cancel:${tx!.id}` },
      ],
    ]);
  });

  it("rejects whitespace-only and over-long titles", async () => {
    const { telegram } = installMocks();
    await pendingSms(1);

    // Whitespace-only: trimmed to nothing, silently ignored (no state change).
    await postWebhook(messageUpdate(2, CHAT_ID, "   "));
    let tx = await firstTransaction();
    expect(tx!.title).toBeNull();
    expect(tx!.status).toBe("pending");
    expect(telegram.sendMessageBodies).toHaveLength(1); // no reply to whitespace

    // Over-long title: rejected with a hint, still pending.
    await postWebhook(messageUpdate(3, CHAT_ID, "x".repeat(101)));
    tx = await firstTransaction();
    expect(tx!.title).toBeNull();
    expect(tx!.status).toBe("pending");
    expect(telegram.sendMessageBodies[1]!.text).toContain("title");
  });

  it("warns instead of mixing a second SMS while one is pending", async () => {
    const { telegram } = installMocks();
    await pendingSms(1);
    await postWebhook(messageUpdate(2, CHAT_ID, SMS_TEXT)); // new SMS again

    const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>();
    expect(countRow?.n ?? 0).toBe(1);
    expect(telegram.sendMessageBodies[1]!.text).toContain("already have a pending transaction");
  });

  it("allows a new SMS after the previous one was cancelled", async () => {
    const { telegram } = installMocks();
    await pendingSms(1);
    await postWebhook(messageUpdate(2, CHAT_ID, "/cancel"));
    expect(telegram.sendMessageBodies[1]!.text).toContain("❌ Cancelled.");

    await postWebhook(messageUpdate(3, CHAT_ID, SMS_TEXT));
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>();
    expect(countRow?.n ?? 0).toBe(2);
    const latest = await env.DB.prepare("SELECT * FROM transactions ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>();
    expect(latest!.status).toBe("pending");
  });
});

describe("confirmation → Google Sheets", () => {
  it("appends exactly one row and completes the transaction", async () => {
    const { telegram, sheets } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries"));
    const tx = await firstTransaction();

    const res = await postWebhook(callbackUpdate(30, CHAT_ID, `save:${tx!.id}`));
    expect(res.status).toBe(200);

    expect(sheets.appendMock.appended).toHaveLength(1);
    const row = sheets.appendMock.appended[0]!.values;
    expect(row[0]).toBe(24.5); // Amount — payment (money out) positive
    expect(row[1]).toBe("Groceries"); // Description
    expect(row[2]).toBe("2026-08-27 15:42"); // Date

    const completed = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(tx!.id).first<Record<string, unknown>>();
    expect(completed!.status).toBe("completed");
    expect(completed!.google_sheet_row).toBe(2);
    expect(completed!.google_sheet_updated_range).toBe("Transactions!A2:C2");

    // Success message to the user.
    const last = telegram.sendMessageBodies[telegram.sendMessageBodies.length - 1]!;
    expect(last.text).toContain("✅ Saved to Google Sheets");
    expect(last.text).toContain("Groceries");
    // No false success wording anywhere before it.
    expect(telegram.sendMessageBodies.find((m) => m.text.includes("nothing was written"))).toBeUndefined();
    // Callback answered so the Telegram UI does not spin.
    expect(telegram.answerBodies[0]!.callback_query_id).toBe("cb-30");
    expect(telegram.answerBodies[0]!.text).toBe("Saved ✅");
    // The confirmation message is deleted after a successful save.
    expect(telegram.deletedIds).toContain(10); // callbackUpdate default message_id
  });

  it("is idempotent: Telegram webhook retries (same update_id) are deduped", async () => {
    const { telegram, sheets } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries"));
    const tx = await firstTransaction();
    const update = callbackUpdate(40, CHAT_ID, `save:${tx!.id}`);

    expect((await postWebhook(update)).status).toBe(200);
    expect((await postWebhook(update)).status).toBe(200); // Telegram retry, same update_id

    expect(sheets.appendMock.appended).toHaveLength(1); // ONLY one sheet row
    const completed = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
      .bind(tx!.id)
      .first<Record<string, unknown>>();
    expect(completed!.status).toBe("completed");
    expect(completed!.google_sheet_row).toBe(2);
    expect(telegram.answerBodies).toHaveLength(1); // retry fully ignored
  });

  it("is idempotent: a SECOND press of Save (new update) appends nothing again", async () => {
    const { telegram, sheets } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries"));
    const tx = await firstTransaction();

    await postWebhook(callbackUpdate(40, CHAT_ID, `save:${tx!.id}`));
    await postWebhook(callbackUpdate(41, CHAT_ID, `save:${tx!.id}`)); // user presses again

    expect(sheets.appendMock.appended).toHaveLength(1);
    expect(telegram.answerBodies.map((a) => a.text)).toEqual(["Saved ✅", "Already saved ✅"]);
    const completed = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
      .bind(tx!.id)
      .first<Record<string, unknown>>();
    expect(completed!.google_sheet_row).toBe(2);
  });

  it("rejects save callbacks for other chats' transactions", async () => {
    const { sheets } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    const tx = await firstTransaction();

    // Another user pressing Save with OUR transaction id must be ignored.
    const res = await postWebhook(callbackUpdate(50, 555, `save:${tx!.id}`));
    expect(res.status).toBe(200);
    expect(sheets.appendMock.appended).toHaveLength(0);
    const current = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
      .bind(tx!.id)
      .first<Record<string, unknown>>();
    expect(current!.status).toBe("pending"); // untouched
  });

  it("retrying a stuck sheet_pending transaction appends again (no ID column to dedup on)", async () => {
    const { sheets } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries"));
    const tx = await firstTransaction();
    // Simulate: append succeeded but the response was lost — status stuck at
    // sheet_pending. With no Transaction ID column in the sheet this retry
    // WILL append a second row; the user deletes it by hand (see README).
    await env.DB.prepare(
      "UPDATE transactions SET status = 'sheet_pending' WHERE id = ?"
    ).bind(tx!.id).run();

    await postWebhook(callbackUpdate(30, CHAT_ID, `save:${tx!.id}`));
    expect(sheets.appendMock.appended).toHaveLength(1);
    const completed = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
      .bind(tx!.id)
      .first<Record<string, unknown>>();
    expect(completed!.status).toBe("completed");
  });
});

describe("cancel flow", () => {
  it("cancels via the ❌ Cancel button", async () => {
    const { telegram } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries"));
    const tx = await firstTransaction();

    await postWebhook(callbackUpdate(30, CHAT_ID, `cancel:${tx!.id}`));

    const cancelled = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(tx!.id).first<Record<string, unknown>>();
    expect(cancelled!.status).toBe("cancelled");
    expect(cancelled!.google_sheet_row).toBeNull();
    expect(telegram.answerBodies[0]!.text).toBe("Cancelled");
    expect(telegram.sendMessageBodies[telegram.sendMessageBodies.length - 1]!.text).toContain("❌ Cancelled.");
  });

  it("/cancel works while waiting for a title", async () => {
    installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    await postWebhook(messageUpdate(2, CHAT_ID, "/cancel"));
    const tx = await firstTransaction();
    expect(tx!.status).toBe("cancelled");
  });
});

describe("callback data validation", () => {
  it("answers invalid callback data without acting", async () => {
    const { telegram, sheets } = installMocks();
    await postWebhook(callbackUpdate(1, CHAT_ID, "delete:123"));
    expect(telegram.answerBodies[0]!.text).toBe("Invalid action");
    expect(sheets.appendMock.appended).toHaveLength(0);
  });

  it("answers unknown transaction ids with an alert", async () => {
    const { telegram } = installMocks();
    await postWebhook(callbackUpdate(1, CHAT_ID, "save:99999"));
    expect(telegram.answerBodies[0]).toMatchObject({ text: "Transaction not found", show_alert: true });
  });
});

describe("Google Sheets failure handling", () => {
  it("marks the transaction error and never claims a save", async () => {
    const { telegram, sheets } = installMocks({ appendBehavior: "http500" });
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries"));
    const tx = await firstTransaction();

    const res = await postWebhook(callbackUpdate(30, CHAT_ID, `save:${tx!.id}`));
    expect(res.status).toBe(200);

    const failed = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(tx!.id).first<Record<string, unknown>>();
    expect(failed!.status).toBe("error");
    expect(failed!.google_sheet_row).toBeNull();

    const texts = telegram.sendMessageBodies.map((m) => m.text).join("\n");
    expect(texts).not.toContain("Saved to Google Sheets");
    expect(texts).toContain("Couldn't save to Google Sheets");
    expect(telegram.answerBodies[0]).toMatchObject({ text: "Save failed", show_alert: true });
    expect(sheets.appendMock.appended).toHaveLength(1);
  });

  it("does not save when the append response is unusable", async () => {
    const { telegram } = installMocks({ appendBehavior: "missingRange" });
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries"));
    const tx = await firstTransaction();
    await postWebhook(callbackUpdate(30, CHAT_ID, `save:${tx!.id}`));

    const failed = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(tx!.id).first<Record<string, unknown>>();
    expect(failed!.status).toBe("error");
    expect(telegram.sendMessageBodies.some((m) => m.text.includes("Saved to Google Sheets"))).toBe(false);
  });
});

describe("help", () => {
  it("responds to /start and /help", async () => {
    const { telegram } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, "/start"));
    expect(telegram.sendMessageBodies[0]!.text).toContain("Bank SMS Bot");
    await postWebhook(messageUpdate(2, CHAT_ID, "/help"));
    expect(telegram.sendMessageBodies[1]!.text).toContain("/cancel");
  });
});

describe("add-another button", () => {
  it("shows 'Add another' on the success message and answers its callback", async () => {
    const { telegram } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries"));
    const tx = await firstTransaction();
    await postWebhook(callbackUpdate(30, CHAT_ID, `save:${tx!.id}`));

    const saved = telegram.sendMessageBodies.find((m) => m.text.includes("Saved to Google Sheets"));
    expect(saved?.reply_markup?.inline_keyboard[0]?.[0]).toMatchObject({ text: "Add manually ➕" });

    const lengthBefore = telegram.sendMessageBodies.length;
    const res = await postWebhook(callbackUpdate(31, CHAT_ID, "add_another"));
    expect(res.status).toBe(200);
    expect(telegram.answerBodies.at(-1)!.text).toBe("Manual entry started");
    expect(telegram.sendMessageBodies.length).toBe(lengthBefore + 1);
    const manual = await env.DB.prepare("SELECT * FROM transactions WHERE status = 'manual_amount'")
      .first<Record<string, unknown>>();
    expect(manual).not.toBeNull();
  });
});

describe("date ➖/➕ buttons", () => {
  it("edits the message and updates the stored date while pending", async () => {
    const { telegram } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    const tx = await firstTransaction();

    const res = await postWebhook(callbackUpdate(10, CHAT_ID, `date_plus:${tx!.id}`));
    expect(res.status).toBe(200);
    expect(telegram.editBodies).toHaveLength(1);
    expect(telegram.editBodies[0]!.text).toContain("28 Aug 2026, 15:42");
    expect(telegram.answerBodies[0]!.text).toBe("28 Aug 2026, 15:42");

    const after = await firstTransaction();
    expect(after!.transaction_date).toBe("2026-08-28T15:42:00");
  });

  it("still adjusts the date at confirmation stage (awaiting_confirmation)", async () => {
    const { telegram } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    const tx = await firstTransaction();
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries")); // -> awaiting_confirmation

    await postWebhook(callbackUpdate(10, CHAT_ID, `date_minus:${tx!.id}`));
    expect(telegram.editBodies).toHaveLength(1);
    expect(telegram.editBodies[0]!.text).toContain("Please confirm:");

    const after = await firstTransaction();
    expect(after!.transaction_date).toBe("2026-08-26T15:42:00");
  });
});

describe("edit title ✏️ button", () => {
  it("reopens the transaction and lets the user retype the title", async () => {
    const { telegram } = installMocks();
    await postWebhook(messageUpdate(1, CHAT_ID, SMS_TEXT));
    const tx = await firstTransaction();
    await postWebhook(messageUpdate(2, CHAT_ID, "Groceries"));

    await postWebhook(callbackUpdate(10, CHAT_ID, `edit_title:${tx!.id}`));
    const reopened = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
      .bind(tx!.id)
      .first<Record<string, unknown>>();
    expect(reopened!.status).toBe("pending");
    expect(telegram.sendMessageBodies[2]!.text).toContain("What should the title be?");

    // Re-enter a title → confirmation again.
    await postWebhook(messageUpdate(3, CHAT_ID, "Food"));
    const updated = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
      .bind(tx!.id)
      .first<Record<string, unknown>>();
    expect(updated!.title).toBe("Food");
    expect(updated!.status).toBe("awaiting_confirmation");
  });
});