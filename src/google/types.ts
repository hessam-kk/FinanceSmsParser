/** Google API response types — only what is actually used. */

export interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleSheetsAppendResponse {
  spreadsheetId: string;
  tableRange?: string;
  updates?: {
    spreadsheetId: string;
    updatedRange?: string;
    updatedRows?: number;
    updatedColumns?: number;
    updatedCells?: number;
  };
}