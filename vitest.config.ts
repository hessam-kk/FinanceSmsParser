import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Throwaway test-only RSA key, generated locally and committed purely so the
// tests can exercise the Google JWT/RS256 path without real credentials.
const testPrivateKey = readFileSync(
  new URL("./test/fixtures/test-service-account-key.pem", import.meta.url),
  "utf8"
).trim();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TELEGRAM_BOT_TOKEN: "test-bot-token",
          TELEGRAM_ALLOWED_CHAT_ID: "999999999",
          GOOGLE_SERVICE_ACCOUNT_EMAIL: "test-bot@example.com",
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: testPrivateKey,
          GOOGLE_SHEET_ID: "test-spreadsheet-id",
          GOOGLE_SHEET_NAME: "Transactions",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});