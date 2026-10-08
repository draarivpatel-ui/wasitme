/**
 * Time inputs of a scan: the time zone (D47e) and the `--until` cutoff.
 *
 * Zone: `--tz`, else WASITME_TZ, else the system zone (Intl), validated as an IANA zone. The scan records it in
 * its history manifest and every shard; when it changes, stored days are recomputed from the stored UTC times.
 *
 * Cutoff: RFC 3339 with an offset (`2026-10-03T23:59:00-05:00`, `…Z`), or a local wall time without an offset
 * (`2026-10-03T23:59`, seconds optional), read in the scan's zone. Exchanges and events after the cutoff are left
 * out at read time, and the evaluation runs as of the cutoff: "today" (always excluded from windows) is the local day
 * that is not complete at the cutoff — a cutoff within the last minute of a day (≥ 23:59) counts that day as complete.
 */
import { checkTimeZone } from "../analysis/metrics/windows.js";
import { cachedFormat, localDay } from "../util.js";

export function resolveTimeZone(flag?: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = flag ?? (env.WASITME_TZ && env.WASITME_TZ.trim() ? env.WASITME_TZ.trim() : undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return checkTimeZone(raw);
}

const OFFSET_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/;

/** Offset of `timeZone` from UTC at instant `ms`, in ms. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = cachedFormat("offset", timeZone, (tz) => new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  })).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function validCalendar(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Parse a cutoff; throws RangeError with a short reason on anything else. */
export function parseUntil(raw: string, timeZone: string): Date {
  const s = raw.trim();
  let m = OFFSET_RE.exec(s);
  if (m) {
    if (!validCalendar(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0))) throw new RangeError("--until is not a real date and time");
    const ms = Date.parse(s.toUpperCase());
    if (!Number.isFinite(ms)) throw new RangeError("--until is not a valid RFC 3339 time");
    return new Date(ms);
  }
  m = LOCAL_RE.exec(s);
  if (!m) throw new RangeError("--until must look like 2026-10-03T23:59:00-05:00 (or a local 2026-10-03T23:59)");
  const [y, mo, d, h, mi, sec] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)];
  if (!validCalendar(y, mo, d, h, mi, sec)) throw new RangeError("--until is not a real date and time");
  const frac = m[7] ? Math.round(Number(m[7]) * 1000) : 0;
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec, frac);
  // Two passes settle the offset around DST changes.
  let guess = wall - zoneOffsetMs(wall, timeZone);
  guess = wall - zoneOffsetMs(guess, timeZone);
  return new Date(guess);
}

/** The evaluation's `now` for a cutoff (see the header): one minute after it. */
export function evaluationNow(now: Date, until: Date | undefined): Date {
  if (!until || until.getTime() >= now.getTime()) return now;
  return new Date(until.getTime() + 60_000);
}

export function dayOf(d: Date, timeZone: string): string {
  return localDay(d.toISOString(), timeZone);
}
