/** Convert an SPKI PEM public key to DER (test helper). */
function pemToSpiDer(pem: string): Uint8Array {
  const cleaned = pem
    .replace(/-----(BEGIN|END) [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return base64Decode(cleaned);
}

/**
 * Google integration logic tests: service-account JWT signing/verification,
 * token exchange (with caching), and the Sheets client (append, idempotency
 * lookup, 401 retry). All external calls are mocked — no real credentials.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64Decode, clearTokenCache, getGoogleAccessToken, pemToPkcs8, signJwt } from "../src/google/auth";
import { GoogleSheetsClient, GoogleSheetsError } from "../src/google/sheets";
import { googleTokenRoute, installFetchMock, sheetsRoutes } from "./helpers";

// Private key comes from the test binding (configured in vitest.config.ts);
// the public key is bundled via Vite ?raw. No runtime fs access needed.
const PRIVATE_KEY = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.trim();
import PUBLIC_KEY from "./fixtures/test-service-account-public.pem?raw";
const PUBLIC_KEY_PEM = PUBLIC_KEY.trim();

const AUTH_ENV = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "test-bot@example.com",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: PRIVATE_KEY,
};

beforeEach(() => {
  clearTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(fetchMock: ReturnType<typeof installFetchMock>): void {
  vi.stubGlobal("fetch", fetchMock.fetch);
}

describe("service account JWT", () => {
  it("pemToPkcs8 extracts an importable PKCS#1 key", async () => {
    const der = pemToPkcs8(PRIVATE_KEY);
    // Valid DER SEQUENCE header + a sane RSA key size.
    expect(der[0]).toBe(0x30);
    expect(der.length).toBeGreaterThan(1000);
    await expect(
      crypto.subtle.importKey(
        "pkcs8",
        der,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
      )
    ).resolves.toBeDefined();
  });

  it("signs a JWT with the expected claims, verifiable with the public key", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(
      {
        iss: "test-bot@example.com",
        scope: "https://www.googleapis.com/auth/spreadsheets",
        aud: "https://oauth2.googleapis.com/token",
        iat,
        exp: iat + 3600,
      },
      PRIVATE_KEY
    );

    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    expect(JSON.parse(atob(header!))).toEqual({ alg: "RS256", typ: "JWT" });

    const claims = JSON.parse(atob(payload!)) as Record<string, unknown>;
    expect(claims.iss).toBe("test-bot@example.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/spreadsheets");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.iat).toBe(iat);
    expect(claims.exp).toBe(iat + 3600);

    const publicKey = await crypto.subtle.importKey(
      "spki",
      pemToSpiDer(PUBLIC_KEY_PEM),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64Decode(signature!),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    expect(verified).toBe(true);
  });
});

describe("getGoogleAccessToken", () => {
  it("exchanges a JWT and caches the token", async () => {
    const mocks = installFetchMock([googleTokenRoute().route]);
    stubFetch(mocks);

    const first = await getGoogleAccessToken(AUTH_ENV);
    expect(first).toBe("test-access-token-1");
    const second = await getGoogleAccessToken(AUTH_ENV);
    expect(second).toBe(first);

    // Only one token request thanks to the cache.
    const tokenCalls = mocks.calls.filter((c) => c.url.includes("oauth2.googleapis.com/token"));
    expect(tokenCalls).toHaveLength(1);
    const body = String(tokenCalls[0]!.body);
    expect(body).toContain("grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(body).toContain("assertion=");
  });

  it("force=true requests a fresh token", async () => {
    const tokenMock = googleTokenRoute(["token-1", "token-2"]);
    const mocks = installFetchMock([tokenMock.route]);
    stubFetch(mocks);

    await getGoogleAccessToken(AUTH_ENV);
    const forced = await getGoogleAccessToken(AUTH_ENV, true);
    expect(forced).toBe("token-2");
  });

  it("throws a safe error when the key is invalid", async () => {
    const mocks = installFetchMock([]);
    stubFetch(mocks);
    await expect(
      getGoogleAccessToken({ ...AUTH_ENV, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "not-a-key" })
    ).rejects.toThrow("invalid PKCS#8 private key");
  });

  it("throws when Google rejects the grant", async () => {
    const tokenMock = googleTokenRoute();
    tokenMock.fail();
    const mocks = installFetchMock([tokenMock.route]);
    stubFetch(mocks);
    await expect(getGoogleAccessToken(AUTH_ENV)).rejects.toThrow("Google token request failed");
  });
});

describe("GoogleSheetsClient", () => {
  const SHEETS_ENV = {
    spreadsheetId: "test-spreadsheet-id",
    sheetName: "Transactions",
    getToken: async (force = false) =>
      force ? "refreshed-token" : "cached-token",
  };

  it("appends with USER_ENTERED at A2 and parses the updated range", async () => {
    const { appendRoute, appendMock } = sheetsRoutes("test-spreadsheet-id");
    const mocks = installFetchMock([appendRoute]);
    stubFetch(mocks);

    const client = new GoogleSheetsClient(SHEETS_ENV);
    const result = await client.appendTransaction(["2026-08-27 15:42", -24.5, "EUR", "payment", "K-Market", "Groceries", "raw", 1, 42, "2026-08-27T15:45:00Z"]);

    expect(result).toEqual({ row: 2, updatedRange: "Transactions!A2:J2" });
    expect(appendMock.appended).toHaveLength(1);
    expect(appendMock.appended[0]!.values[1]).toBe(-24.5);

    const call = mocks.calls.find((c) => c.method === "POST");
    expect(call?.url).toContain("values/");
    expect(call?.url).toContain("valueInputOption=USER_ENTERED");
    expect(call?.url).toContain("insertDataOption=INSERT_ROWS");
    expect(call?.url).toContain("'Transactions'!A2"); // URL.href re-decodes %27
    expect(call?.headers["authorization"]).toBe("Bearer cached-token");
  });

  it("throws on HTTP error (caller must not report a save)", async () => {
    const { appendRoute } = sheetsRoutes("test-spreadsheet-id", { appendBehavior: "http500" });
    const mocks = installFetchMock([appendRoute]);
    stubFetch(mocks);
    const client = new GoogleSheetsClient(SHEETS_ENV);
    await expect(client.appendTransaction(["a"])).rejects.toThrow(GoogleSheetsError);
  });

  it("retries once with a fresh token after 401", async () => {
    const { appendRoute, appendMock } = sheetsRoutes("test-spreadsheet-id", {
      appendBehavior: "authFailFirst",
    });
    const mocks = installFetchMock([appendRoute]);
    stubFetch(mocks);

    const client = new GoogleSheetsClient(SHEETS_ENV);
    const result = await client.appendTransaction(["x"]);
    expect(result.row).toBe(2);
    expect(appendMock.appended).toHaveLength(2);
    expect(appendMock.appended[0]!.auth).toContain("cached-token");
    expect(appendMock.appended[1]!.auth).toContain("refreshed-token");
  });

  it("throws when the response has no updatedRange", async () => {
    const { appendRoute } = sheetsRoutes("test-spreadsheet-id", {
      appendBehavior: "missingRange",
    });
    const mocks = installFetchMock([appendRoute]);
    stubFetch(mocks);
    const client = new GoogleSheetsClient(SHEETS_ENV);
    await expect(client.appendTransaction(["x"])).rejects.toThrow("updatedRange");
  });
});