/**
 * Makes `import { env, SELF } from "cloudflare:test"` type-check and types
 * `env` with our actual bindings. The module is declared by
 * @cloudflare/vitest-pool-workers' types file.
 */
/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_ALLOWED_CHAT_ID: string;
    GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
    GOOGLE_SHEET_ID: string;
    GOOGLE_SHEET_NAME: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    GOOGLE_TOKEN_CACHE_MAX_AGE_SECONDS?: string;
  }
}