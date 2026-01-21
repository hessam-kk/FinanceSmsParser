# bank-telegram-bot

Single-user Telegram bot that receives forwarded bank SMS messages, parses the
transaction, asks you for a title, and appends the row to a Google Sheet after
you confirm. Runs entirely on **Cloudflare Workers + D1** — no server, no
Docker, no polling.

```
Telegram webhook ──> Worker ──> parser (bank-specific) ──> D1 (state machine)
                                  │
                                  └──> Google Sheets values.append (on ✅ Save)
```

## Flow

1. You forward (or paste) a bank SMS to the bot.
2. The bot verifies the chat allowlist and the webhook secret token.
3. The SMS is parsed into a normalized transaction and stored in D1 as
   `pending`.
4. The bot shows the parsed transaction and asks: *"What was this payment
   for?"*
5. You reply with a title → status `awaiting_confirmation`, and the bot shows
   `[✅ Save] [❌ Cancel]` inline buttons.
6. **✅ Save** → the row is appended via the Sheets `values.append` API, the
   D1 row is marked `completed`, and you get a success message.
   **❌ Cancel** (or `/cancel`) → the transaction is marked `cancelled`.

If parsing fails or confidence is low, nothing is written anywhere — the bot
asks you to check/resend the message.

## Project layout

```
src/
  index.ts             Worker entrypoint: routing, webhook-secret check, dedup gate
  types.ts             Env / shared types
  telegram/            client, update handlers (state machine), keyboard, types
  parser/              bank parsers: blue.ts (real format), generic.ts, template.ts
  google/              service-account JWT auth + Sheets client
  db/                  transactions + processed-updates (dedup)
  utils/               dates, errors, logging
  parser/blue.ts       Jalali month-name table + Blue normalization rules
migrations/            D1 migrations
test/                  vitest suites (parser, google, telegram workflow) — fully mocked
```

## Prerequisites

- Node.js 18+
- A Cloudflare account (free tier is fine)
- `wrangler` (installed as a dev dependency)

## 1. Telegram bot setup

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow prompts.
2. Copy the bot token.
3. Get your numeric chat ID: message [@userinfobot](https://t.me/userinfobot)
   (or any equivalent) — that number is your `TELEGRAM_ALLOWED_CHAT_ID`.

## 2. Google Cloud project

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com).
2. Enable the **Google Sheets API** (APIs & Services → Library).
3. APIs & Services → Credentials → **Create credentials → Service account**.
   Name it (e.g. `bank-bot`), no roles needed.
4. Open the service account → Keys → **Add key → Create new key → JSON**.
   Download the JSON file. You need two values from it:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

## 3. Google Sheet

1. Create a spreadsheet. Copy its ID from the URL:
   `https://docs.google.com/spreadsheets/d/`**`<GOOGLE_SHEET_ID>`**`/edit`
2. Name the tab used for transactions (default: `Transactions`) — this is
   `GOOGLE_SHEET_NAME`.
3. Put this header row in row 1 (exactly):

   ```
   Amount | Description | Date
   ```

   > Sign convention: deposits (money in) are **negative**, withdrawals/payments
   > (money out) are **positive** — used consistently everywhere (stored amounts,
   > bot messages, and the sheet).

4. **Share** the spreadsheet with the service account email
   (`...@...iam.gserviceaccount.com`) as **Editor**. This is the step people
   forget — without it every append fails with 403.

## 4. Cloudflare + D1

```bash
npm install
npx wrangler login
npx wrangler d1 create bankbot
```

Paste the returned `database_id` into `wrangler.toml` (replacing the zero
placeholder UUID).

Apply migrations (both environments):

```bash
npx wrangler d1 migrations apply bankbot --local    # local dev DB
npx wrangler d1 migrations apply bankbot --remote   # production DB
```

## 5. Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your values
npm run db:migrate:local
npm run dev
```

Then verify:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"service":"bank-telegram-bot"}
```

> **Windows note:** if port 8787 is taken by another dev server, run
> `npx wrangler dev --port 8790` instead.

The Worker routes:

- `GET /health` — health check.
- `POST /telegram/webhook` — Telegram updates. Requires a matching
  `X-Telegram-Bot-Api-Secret-Token` header when `TELEGRAM_WEBHOOK_SECRET` is
  set; anything else gets `401`.

## 6. Secrets

All credentials are Cloudflare secrets — never committed:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_ALLOWED_CHAT_ID
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put GOOGLE_SHEET_ID
npx wrangler secret put GOOGLE_SHEET_NAME
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

`TELEGRAM_WEBHOOK_SECRET` can be any long random string, e.g. from
`openssl rand -hex 32`. In `.dev.vars` (local) the same variables apply.

## 7. Deployment & webhook registration

```bash
npx wrangler deploy
```

Register the webhook (placeholders only — do not commit real values):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<WORKER_DOMAIN>/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Inspect webhook status:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
# look for "last_error_message" and "pending_update_count"
```

`setWebhook` may take a minute to propagate; `getWebhookInfo` shows the URL
Telegram will call.

## 8. Testing

```bash
npm run typecheck
npm test
```

The suites cover: every parser path (payments, income, withdrawals, fees,
transfers, malformed/unsupported SMS, decimal/currency variants, the four real
Blue SMSes), the Google JWT signing + append logic, and the full Telegram
state machine (SMS → pending → title → confirmation → Sheets append, cancel,
duplicate update ignored, unauthorized chat rejected, failed append never
reported as saved). All external APIs are mocked — no real credentials needed.

## Bank SMS parsing

Parsers live in `src/parser/` and are tried in registration order
(`src/parser/index.ts`):

```ts
const parsers: BankParser[] = [
  blueParser,      // real format (see below)
  genericParser,   // labeled-line formats: "Amount:", "Merchant:", dates...
];
```

To add a bank: copy `src/parser/template.ts` → `myBank.ts`, implement
`canParse` + `parse` with the bank's real SMS examples, bump the parser
version string, and register it in `src/parser/index.ts` **before**
`genericParser`. Bank-specific regexes never leak into Telegram or Sheets code.

### Blue (بلو) — implemented

The parser handles deposit (واریز پول), withdrawal (برداشت پول), and
"rounded" withdrawal (برداشت رُند) messages. Normalization:

- **Amounts** are stored in **thousands of Toman** (Rial ÷ 10,000, rounded):
  `750,000 ریال → -75`, `4,500,000 ریال → 450`. Deposits are negative,
  withdrawals positive.
- **Dates** stay **Jalali**, rendered as day + month name with no year:
  `۱۴۰۵.۰۶.۰۵ → 5 شهریور`.
- The `موجودی:` (balance) line is never used as the amount; the `رند شد`
  rounding line is informational and ignored (the main line is the debit —
  balance math confirms it).
- The raw SMS is preserved verbatim in the `raw_sms` column.

## Idempotency & known edge cases

- **Duplicate webhook deliveries** (same Telegram `update_id`) are recorded in
  the `processed_updates` table and ignored on retry.
- **Double Save** is guarded by the status checks: once a transaction is
  `completed` it is never appended again, and a `sheet_pending` claim is taken
  before the first append so concurrent/retried Saves don't both fire.
- **Remaining edge case:** the sheet stores only 3 columns (Amount,
  Description, Date) with no Transaction ID column. If Google *accepts* the
  append but the Worker crashes before receiving the response, the status
  stays `sheet_pending`; pressing Save again will append a **duplicate row**
  that you must delete by hand. True distributed exactly-once is not claimed.
  (Adding a Transaction-ID column back would let the bot detect this and
  recover automatically — `findExistingRow` in the git history shows how.)

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Bot replies nothing | Check `getWebhookInfo`; confirm `TELEGRAM_ALLOWED_CHAT_ID` matches *your* chat ID (unauthorized chats are silently ignored by design). |
| `401` on webhook | `secret_token` in the `setWebhook` URL must equal the `TELEGRAM_WEBHOOK_SECRET` secret. |
| `⚠️ I couldn't reliably parse this bank SMS` | Unsupported format. Paste the SMS into a new parser (see template) or extend `generic.ts`. |
| Save fails with 403 | The sheet isn't shared with the service account email, or the Sheets API isn't enabled. |
| Save fails with 401 | Private key malformed — paste the `private_key` value with real newlines (in `.dev.vars` use `\n` escapes as in the JSON file). |
| Rows appended but missing in the sheet | Check you're looking at the tab named by `GOOGLE_SHEET_NAME` and that row 1 holds the header row (appends start at A2). |
| Migration errors | Run `npx wrangler d1 migrations list bankbot --local/--remote` to see pending state. |

Logs are structured (`console.log` JSON lines in `wrangler tail` / dev output)
and never include the bot token, private key, or access token. Raw SMS bodies
are stored in D1 but not logged.
