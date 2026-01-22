/**
 * Parser registry. The FIRST parser whose `canParse` returns true handles the
 * message. Add real bank parsers (see template.ts) before the generic one —
 * most specific first.
 */

import { MAX_SMS_LENGTH, normalizeText } from "./rules";
import { genericParser } from "./generic";
import { blueParser } from "./blue";
import type { BankParser, ParseResult } from "./types";

/** Per-parser version, stored in `parser_version` for each transaction. */
const PARSER_VERSIONS: Record<string, string> = {
  generic: "generic-1",
  blue: "blue-1",
};

/** Below this, a parsing result is considered unreliable and rejected. */
export const MIN_CONFIDENCE = 0.5;

const parsers: BankParser[] = [
  // Most specific first. Each parser owns its regexes + normalization.
  blueParser, // Blue (بلو) — Iranian neobank, real formats
  //   nordeaParser,   <- add your bank here (see template.ts)
  genericParser, // label-driven fallback (Purchase: EUR 24.50 ...)
];

/**
 * Parse a raw SMS into a normalized transaction. Returns null when nothing
 * parses confidently. Deterministic — no LLM, no network calls.
 */
export function parseSms(rawText: string): ParseResult | null {
  const text = normalizeText(rawText);
  if (!text || text.length > MAX_SMS_LENGTH) return null;
  for (const parser of parsers) {
    if (!parser.canParse(text)) continue;
    const parsed = parser.parse(text);
    if (parsed && parsed.confidence >= MIN_CONFIDENCE) {
      return {
        parsed,
        parser: parser.name,
        parserVersion: PARSER_VERSIONS[parser.name] ?? `${parser.name}-1`,
      };
    }
  }
  return null;
}