/**
 * Minimal structured logging: every event is a single JSON line.
 *
 * Secret policy:
 *  - NEVER log: bot token, Google private key, Google access token, webhook
 *    secret, or any full credential.
 *  - Be conservative with raw SMS text: prefer transaction IDs and parser
 *    diagnostics. Raw SMS is stored in D1 (required for history/debugging)
 *    but is not printed to logs.
 *  - Log the chat ID (it is not a secret) so debugging is possible.
 */

export type LogField = string | number | boolean | null | undefined;

export function log(event: string, fields: Record<string, LogField> = {}): void {
  console.log(
    JSON.stringify({
      event,
      service: "bank-telegram-bot",
      ts: new Date().toISOString(),
      ...fields,
    })
  );
}

/** Log an error without the stack or any sensitive payloads. */
export function logError(
  event: string,
  err: unknown,
  fields: Record<string, LogField> = {}
): void {
  const message = err instanceof Error ? err.message : String(err);
  log(event, { ...fields, error: message });
}