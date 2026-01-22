-- 0001_initial.sql
-- Initial schema for the bank-telegram-bot.
-- Applied with: npx wrangler d1 migrations apply bankbot --local / --remote

-- Transaction state machine (conceptual states in parentheses):
--   pending                 (WAITING_FOR_TITLE)       SMS parsed, awaiting title
--   awaiting_confirmation   (WAITING_FOR_CONFIRMATION) title saved, awaiting Save/Cancel
--   sheet_pending           (saving to Google Sheets) Save pressed, append in flight / retryable
--   completed               (COMPLETED)               appended to Google Sheets
--   cancelled               (CANCELLED)               user cancelled
--   error                   (error)                   failed during processing (retryable by user)
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_chat_id TEXT NOT NULL,
    telegram_message_id INTEGER,
    raw_sms TEXT NOT NULL,

    transaction_date TEXT,
    amount REAL,
    currency TEXT,
    transaction_type TEXT,
    merchant TEXT,

    title TEXT,

    status TEXT NOT NULL DEFAULT 'pending',

    parser_version TEXT,
    parser_confidence REAL,

    google_sheet_row INTEGER,
    google_sheet_updated_range TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_chat_status
ON transactions(telegram_chat_id, status);

CREATE INDEX IF NOT EXISTS idx_transactions_created_at
ON transactions(created_at);

-- Deduplication: every Telegram webhook delivery carries a unique update_id.
-- We record which update_ids have already been processed so Telegram retries of
-- the same webhook request are ignored instead of being processed twice.
CREATE TABLE IF NOT EXISTS processed_updates (
    update_id INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL
);