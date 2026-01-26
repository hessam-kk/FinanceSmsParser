/**
 * Error helpers. The guiding rule: never expose stack traces, secrets or
 * internal paths to the Telegram user or in webhook responses.
 */

export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}