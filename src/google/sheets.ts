/**
 * Google Sheets client — uses the official Sheets API `values.append` so rows
 * are always appended after existing data and never overwritten.
 *
 * Idempotency: the caller guards status transitions (completed check +
 * sheet_pending claim) so normal Telegram retries never append twice. The
 * sheet uses a simple 3-column layout (Amount, Description, Date) with no
 * Transaction ID column, so the rare lost-response-after-append case cannot
 * be detected and could produce a duplicate row — see README "Idempotency &
 * known edge cases".
 */

import { AppError } from "../utils/errors";
import { log } from "../utils/logging";
import type { GoogleSheetsAppendResponse } from "./types";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export interface AppendResult {
  /** 1-based spreadsheet row the new data landed in. */
  row: number;
  /** e.g. "Transactions!A42:J42". */
  updatedRange: string;
}

export class GoogleSheetsError extends AppError {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "GoogleSheetsError";
  }
}

export interface GoogleSheetsClientDeps {
  /** Returns a fresh OAuth2 access token. `force` skips the cache. */
  getToken(force?: boolean): Promise<string>;
  spreadsheetId: string;
  /** Sheet (tab) name, e.g. "Transactions". */
  sheetName: string;
}

export class GoogleSheetsClient {
  readonly deps: GoogleSheetsClientDeps;

  constructor(deps: GoogleSheetsClientDeps) {
    if (!deps.spreadsheetId || !deps.sheetName) {
      throw new AppError("Google Sheets config missing");
    }
    this.deps = deps;
  }

  /** Range where appends start: first row after the header. */
  private appendRange(): string {
    return `'${this.deps.sheetName.replace(/'/g, "''")}'!A2`;
  }

  private valuesUrl(range: string): string {
    const encoded = encodeURIComponent(range);
    return `${SHEETS_API}/${encodeURIComponent(this.deps.spreadsheetId)}/values/${encoded}`;
  }

  private appendUrl(): string {
    return `${this.valuesUrl(this.appendRange())}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  }

  /**
   * Append one transaction row. Throws GoogleSheetsError on failure — the
   * caller keeps the transaction in a retryable state and MUST NOT report a
   * save it did not confirm.
   */
  async appendTransaction(values: Array<string | number>): Promise<AppendResult> {
    const payload = { values: [values] };
    return this.withAuthRetry(async (token) => {
      let response: Response;
      try {
        response = await fetch(this.appendUrl(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch {
        throw new GoogleSheetsError("Sheets API unreachable", null);
      }
      if (!response.ok) {
        throw new GoogleSheetsError(
          `append failed (HTTP ${response.status}): ${await describeGoogleError(response)}`,
          response.status
        );
      }
      const body = (await response.json()) as GoogleSheetsAppendResponse;
      const updatedRange = body.updates?.updatedRange;
      if (!updatedRange) {
        throw new GoogleSheetsError("append response missing updatedRange", response.status);
      }
      const row = parseRowFromRange(updatedRange);
      if (!row) {
        throw new GoogleSheetsError(`cannot parse updatedRange ${updatedRange}`, response.status);
      }
      log("google_sheet_append_received", { row });
      return { row, updatedRange };
    });
  }

  /**
   * Runs `action`; if the first attempt fails with 401/403 (expired or
   * rejected token), refreshes the token once and retries.
   */
  private async withAuthRetry<T>(action: (token: string) => Promise<T>): Promise<T> {
    let token = await this.deps.getToken();
    try {
      return await action(token);
    } catch (err) {
      if (err instanceof GoogleSheetsError && (err.status === 401 || err.status === 403)) {
        log("google_sheets_token_refresh", {});
        token = await this.deps.getToken(true);
        return await action(token);
      }
      throw err;
    }
  }
}

function parseRowFromRange(range: string): number | null {
  const match = /!A(\d+)/.exec(range);
  if (!match) return null;
  const row = Number(match[1]);
  return Number.isInteger(row) && row > 0 ? row : null;
}

/**
 * Extract Google's error explanation (e.g. "PERMISSION_DENIED — The caller
 * does not have permission") so failures are diagnosable from logs/Telegram.
 * Contains no secrets — it is Google's own error message.
 */
async function describeGoogleError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { status?: string; message?: string } };
    const parts = [body.error?.status, body.error?.message].filter(Boolean);
    return parts.length > 0 ? parts.join(" — ") : "no detail in Google error body";
  } catch {
    return `unreadable error body (HTTP ${response.status})`;
  }
}