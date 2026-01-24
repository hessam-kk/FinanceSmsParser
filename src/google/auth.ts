/**
 * Google service-account authentication implemented purely with Web Crypto
 * (crypto.subtle) — no Node dependencies, works in Cloudflare Workers.
 *
 * Flow:
 *   1. Build a JWT: { iss: <service account email>, scope: spreadsheets,
 *      aud: https://oauth2.googleapis.com/token, iat, exp = iat + 1h }
 *   2. Sign it with RS256 using the service account private key (PKCS#8 PEM).
 *   3. Exchange it at https://oauth2.googleapis.com/token for an access token.
 *   4. Cache the access token for ~1h (best-effort, in-isolate cache).
 *
 * Important: Google's private key PEMs are PKCS#8, but Web Crypto
 * `crypto.subtle.importKey("pkcs8", ...)` expects the raw RSAPrivateKey DER.
 * `pemToPkcs8` strips the PKCS#8 wrapper (SEQUENCE { version,
 * AlgorithmIdentifier, OCTET STRING { RSAPrivateKey } }).
 */

import { AppError } from "../utils/errors";
import { log } from "../utils/logging";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWT_AUD = "https://oauth2.googleapis.com/token";
const JWT_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_MAX_AGE_SECONDS = 3599; // Google tokens live for 1h

export interface GoogleAuthEnv {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  GOOGLE_TOKEN_CACHE_MAX_AGE_SECONDS?: string;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number; // unix seconds
}

/**
 * Best-effort module-level cache. Cloudflare may keep an isolate around for a
 * while, so this usually avoids a token request per message — but correctness
 * never depends on it (a fresh token is fetched whenever needed).
 */
const tokenCache = new Map<string, TokenCacheEntry>();

/** Clear the cache (used by tests; harmless in production between deploys). */
export function clearTokenCache(): void {
  tokenCache.clear();
}

// ---------------------------------------------------------------------------
// Base64 helpers (atob/btoa are available in Workers and Node 18+).
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64Decode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const rem = normalized.length % 4;
  if (rem === 1) throw new Error("invalid base64-encoded data");
  const padded = normalized + (rem === 0 ? "" : rem === 2 ? "==" : "=");
  const s = atob(padded);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// PKCS#8 → raw RSAPrivateKey DER
// ---------------------------------------------------------------------------

function derLength(data: Uint8Array, offset: number): { length: number; headerLength: number } {
  const first = data[offset] ?? 0;
  if ((first & 0x80) === 0) return { length: first, headerLength: 1 };
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = length * 256 + (data[offset + 1 + i] ?? 0);
  }
  return { length, headerLength: 1 + numBytes };
}

function skipTlv(data: Uint8Array, offset: number): number {
  const l = derLength(data, offset + 1);
  return offset + 1 + l.headerLength + l.length;
}

/** Convert a PKCS#8 PEM private key to the raw PKCS#1 RSAPrivateKey DER. */
export function pemToPkcs8(pem: string): Uint8Array {
  let der: Uint8Array;
  try {
    const cleaned = pem
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "")
      .replace(/-----END [A-Z ]*PRIVATE KEY-----/g, "")
      .replace(/\\n/g, "\n") // JSON-escaped newlines from the service-account key file
      .replace(/\s+/g, "");
    der = base64Decode(cleaned);
  } catch {
    throw new AppError("invalid PKCS#8 private key");
  }

  // PKCS#8 layout: SEQUENCE { INTEGER version, SEQUENCE algid,
  // OCTET STRING { RSAPrivateKey } }. The outer SEQUENCE encloses everything;
  // content starts right after its tag+length, so only its HEADER is skipped,
  // then each inner element is skipped as a whole TLV.
  if (der[0] !== 0x30) throw new AppError("invalid PKCS#8 private key");
  const outerHeader = derLength(der, 1);
  let off = 1 + outerHeader.headerLength; // past outer SEQUENCE tag+len
  if (der[off] !== 0x02) throw new AppError("invalid PKCS#8 private key");
  off = skipTlv(der, off); // INTEGER version
  if (der[off] !== 0x30) throw new AppError("invalid PKCS#8 private key");
  off = skipTlv(der, off); // AlgorithmIdentifier SEQUENCE (params included)
  if (der[off] !== 0x04) throw new AppError("invalid PKCS#8 private key");
  const l = derLength(der, off + 1);
  const start = off + 1 + l.headerLength;
  return der.slice(start, start + l.length);
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

/** Build + RS256-sign a JWT. Exported for tests (and future token needs). */
export function signJwt(claims: Record<string, unknown>, privateKeyPem: string): Promise<string> {
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  );
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );
  const signingInput = `${header}.${payload}`;

  return crypto.subtle
    .importKey(
      "pkcs8",
      pemToPkcs8(privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    )
    .then((key) => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)))
    .then((signature) => `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`);
}

// ---------------------------------------------------------------------------
// Token exchange + cache
// ---------------------------------------------------------------------------

/**
 * Get a Google OAuth2 access token for the service account.
 * `force` bypasses the cache (used to retry once after a 401/403).
 */
export async function getGoogleAccessToken(
  env: GoogleAuthEnv,
  force = false
): Promise<string> {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const key = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim();
  if (!email || !key) {
    throw new AppError("Google service account credentials are not configured");
  }

  const configuredMaxAge =
    Number(env.GOOGLE_TOKEN_CACHE_MAX_AGE_SECONDS) || DEFAULT_MAX_AGE_SECONDS;
  const maxAge = Math.max(60, Math.min(configuredMaxAge, 3599));

  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(email);
  if (!force && cached && cached.expiresAt - now > 60) {
    return cached.token;
  }

  const iat = now;
  const jwt = await signJwt(
    { iss: email, scope: JWT_SCOPE, aud: JWT_AUD, iat, exp: iat + 3600 },
    key
  );

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
    });
  } catch {
    throw new AppError("Google token endpoint unreachable");
  }

  let body: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new AppError(`Google token endpoint returned non-JSON (HTTP ${response.status})`);
  }

  if (!response.ok || !body.access_token) {
    // Log only the HTTP status + google error, never the JWT or creds.
    log("google_auth_failed", {
      status: response.status,
      google_error: body.error ?? null,
      google_error_description: body.error_description ?? null,
    });
    throw new AppError(
      `Google token request failed (HTTP ${response.status}): ${body.error ?? "unknown error"} — ${body.error_description ?? "no detail"}`
    );
  }

  const expiresIn = Number(body.expires_in) || 3600;
  tokenCache.set(email, {
    token: body.access_token,
    expiresAt: now + Math.min(expiresIn, maxAge),
  });
  return body.access_token;
}