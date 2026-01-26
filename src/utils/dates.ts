/**
 * Date/time helpers.
 *
 * Rules:
 *  - All *internal* timestamps (created_at, updated_at, processed_at) are UTC
 *    ISO 8601 (`new Date().toISOString()`).
 *  - The bank transaction's own datetime is what the SMS said (wall-clock time
 *    in the bank's local timezone, "Europe/Helsinki" for the example formats).
 *    We preserve it verbatim as a UTC-naive local timestamp
 *    (`YYYY-MM-DDTHH:MM:SS`) and NEVER convert it to UTC: the bank already
 *    gives us local wall-clock time, and converting would shift the displayed
 *    hour. Timezone conversions (if ever needed) use the explicit
 *    `DISPLAY_TIMEZONE` constant.
 *  - We never rely on the Worker's local timezone.
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Current UTC time as ISO 8601 (used for created_at / updated_at). */
export function nowIso(): string {
  return new Date().toISOString();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isValidDateParts(
  day: number,
  month: number,
  year: number,
  hour: number,
  minute: number
): boolean {
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return false;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return false;
  return true;
}

/**
 * Build a UTC-naive local timestamp from day/month/year (+ optional time)
 * parts, e.g. buildLocalTimestamp(27, 8, 2026, 15, 42) ->
 * "2026-08-27T15:42:00". Returns null if the parts are unusable.
 */
export function buildLocalTimestamp(
  day: number,
  month: number,
  year: number,
  hour = 0,
  minute = 0
): string | null {
  if (!isValidDateParts(day, month, year, hour, minute)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00`;
}

/**
 * Format a local timestamp for Telegram display: "27 Aug 2026, 15:42".
 * Returns null for null/undefined input (so callers can render "unknown").
 * Non-timestamp strings (e.g. Blue's Jalali "5 شهریور") pass through as-is.
 */
export function formatTimestampForDisplay(
  ts: string | null | undefined
): string | null {
  if (!ts) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(ts);
  if (!match) return ts;
  const [, year, month, day, hour, minute] = match;
  const monthIndex = Number(month) - 1;
  const monthName = MONTHS[monthIndex] ?? month;
  return `${Number(day)} ${monthName} ${year}, ${hour}:${minute}`;
}

/** "27 Aug 2026" — like formatTimestampForDisplay but without the time. */
export function formatDateOnlyForDisplay(
  ts: string | null | undefined
): string | null {
  const full = formatTimestampForDisplay(ts);
  if (!full) return null;
  return full.split(",")[0] ?? null;
}

/**
 * Format a local timestamp for the Google Sheet: "2026-08-27 15:42".
 * Matches the example rows in the README.
 */
export function formatTimestampForSheet(ts: string | null | undefined): string {
  if (!ts) return "";
  return ts.replace("T", " ").replace(/:\d{2}$/, "");
}

/** "-948 T" display of amount + currency — always whole, no decimals. */
export function formatAmount(
  amount: number | null | undefined,
  currency: string | null | undefined
): string {
  const amountPart =
    amount !== null && amount !== undefined ? String(Math.round(amount)) : "?";
  return `${amountPart} ${currency || ""}`.trim();
}

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const todayFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  day: "numeric",
  month: "long",
  timeZone: "Asia/Tehran",
});

/** Today's date in Iran as Jalali "D month-name" (e.g. "5 شهریور"). */
export function todayJalali(): string {
  const parts = todayFormatter.formatToParts(new Date());
  const day = (parts.find((p) => p.type === "day")?.value ?? "1")
    .split("")
    .map((c) => {
      const i = PERSIAN_DIGITS.indexOf(c);
      return i >= 0 ? String(i) : c;
    })
    .join("");
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${day} ${month}`;
}

// ---------------------------------------------------------------------------
// Jalali dates (Blue bank) — stored as "D month-name" per user preference
// ---------------------------------------------------------------------------

export const JALALI_MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
];

// ponytail: اسفند fixed at 29 days — leap years shift that boundary by one day every ~4 years
const JALALI_MONTH_LENGTHS = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];

function jalaliMonthLength(m: number): number {
  return JALALI_MONTH_LENGTHS[m - 1] ?? 0; // m is always 1–12 at the call sites
}

/**
 * Shift a transaction date by `days` (±1 in practice), returning the same
 * format back. Handles both formats the parsers produce:
 *  - Jalali "D month-name": "31 مرداد" + 1 -> "1 شهریور"
 *  - UTC-naive local timestamps: "2026-08-27T15:42:00" ± days
 * Unknown formats are returned unchanged.
 */
export function adjustTransactionDate(
  date: string | null | undefined,
  days: number
): string | null {
  if (!date) return null;

  const jalali = /^(\d{1,2}) (.+)$/.exec(date.trim());
  if (jalali) {
    const month = JALALI_MONTHS.indexOf(jalali[2] ?? "") + 1;
    let d = Number(jalali[1]);
    if (month === 0 || d < 1 || d > 31) return date;
    let m = month;
    d += days;
    while (d > jalaliMonthLength(m)) {
      d -= jalaliMonthLength(m);
      m = m === 12 ? 1 : m + 1;
    }
    while (d < 1) {
      m = m === 1 ? 12 : m - 1;
      d += jalaliMonthLength(m);
    }
    return `${d} ${JALALI_MONTHS[m - 1]}`;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(date);
  if (iso) {
    const [, y, mo, d, h, mi] = iso;
    const shifted = new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d) + days, Number(h), Number(mi))
    );
    return (
      `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}` +
      `T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:00`
    );
  }

  return date;
}