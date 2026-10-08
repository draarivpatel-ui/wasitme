/**
 * Windows and tiers (METHOD.md §4): recent / baseline windows of complete local days, today excluded (METHOD.md §2).
 *
 * Everything is day arithmetic on "YYYY-MM-DD" strings (day indices since 1970-01-01). The only clock read
 * is the supplied `now`, turned into a local day with the supplied (required) time zone; nothing assumes timestamps
 * move forward — an exchange's window is decided by its day alone.
 *
 *   recent   = [today − R, today − 1]
 *   baseline = [today − R − B, today − R − 1]
 *   a tier's history requirement (R + B days) is met when the first day with data is on or before the
 *   baseline's first day, i.e. historyDays = today − firstDay ≥ R + B.
 */
import { localDay } from "../../util.js";
import { dayIndex, dayString } from "../stats/ratio.js";

export type TierId = 1 | 2 | 3;

export interface Tier {
  tier: TierId;
  recentDays: number;
  baselineDays: number;
  /** recentDays + baselineDays. */
  historyDays: number;
}

export const TIERS: readonly Tier[] = Object.freeze([
  Object.freeze({ tier: 1 as const, recentDays: 14, baselineDays: 28, historyDays: 42 }),
  Object.freeze({ tier: 2 as const, recentDays: 21, baselineDays: 42, historyDays: 63 }),
  Object.freeze({ tier: 3 as const, recentDays: 28, baselineDays: 56, historyDays: 84 }),
]);

/** The largest span any tier looks at (days before today). */
export const MAX_SPAN_DAYS = Math.max(...TIERS.map((t) => t.historyDays));

export interface DayRange {
  /** Inclusive day indices. */
  from: number;
  to: number;
}

export interface TierWindows {
  recent: DayRange;
  baseline: DayRange;
}

export interface DayRangeStrings {
  from: string;
  to: string;
}

/**
 * Local calendar day of `now` in `timeZone`. The zone is required and must be a valid IANA zone (or "UTC"):
 * falling back to the machine's zone would let the same input give a different `today` on another machine,
 * and could silently differ from the zone the reader used for `Exchange.day`. Throws on an invalid date or zone.
 */
export function todayFor(now: Date, timeZone: string): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("now must be a valid Date");
  return localDay(now.toISOString(), checkTimeZone(timeZone));
}

/** Returns `timeZone` when it is a non-empty, valid IANA zone; throws a RangeError otherwise. */
export function checkTimeZone(timeZone: unknown): string {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new RangeError("timeZone is required (an IANA zone such as \"America/Chicago\"); the system zone is never assumed");
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    throw new RangeError(`timeZone must be a valid IANA zone (got ${JSON.stringify(timeZone)})`);
  }
  return timeZone;
}

/** Day index of a valid "YYYY-MM-DD" string; throws otherwise. */
export function mustDay(day: string, what = "day"): number {
  const i = dayIndex(day);
  if (i === undefined) throw new RangeError(`${what} must be a valid YYYY-MM-DD day (got ${String(day)})`);
  return i;
}

/** The tier's windows for an evaluation on day `todayIdx` (windows end the day before). */
export function tierWindows(todayIdx: number, tier: Tier): TierWindows {
  const recentFrom = todayIdx - tier.recentDays;
  return {
    recent: { from: recentFrom, to: todayIdx - 1 },
    baseline: { from: recentFrom - tier.baselineDays, to: recentFrom - 1 },
  };
}

export function rangeStrings(r: DayRange): DayRangeStrings {
  return { from: dayString(r.from), to: dayString(r.to) };
}

/** Complete days of history before `todayIdx` (0 when there is no data). */
export function historyDays(todayIdx: number, firstDayIdx: number | undefined): number {
  return firstDayIdx === undefined ? 0 : Math.max(0, todayIdx - firstDayIdx);
}

/** First day on which the tier's history requirement is met (an evaluation on that day can use it). */
export function historyMetOn(firstDayIdx: number, tier: Tier): number {
  return firstDayIdx + tier.historyDays;
}
