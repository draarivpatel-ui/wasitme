/**
 * Number, date and length helpers for engine copy. Pure and locale-independent: the same input gives the same bytes
 * on every machine (no Intl, no toLocaleString, no clock reads).
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Length in code points (the contract bounds strings in code points, like JSON Schema). */
export function len(s: string): number {
  return [...s].length;
}

/** 1234567 → "1,234,567". Non-finite or negative values print as "0". */
export function count(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1 session" / "2 sessions" (or an explicit plural). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${Math.round(n) === 1 ? one : many}`;
}

/** The noun alone, by count. */
export function noun(n: number, one: string, many = `${one}s`): string {
  return Math.round(n) === 1 ? one : many;
}

/** "a, b and c". */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-09-21" → "Sep 21"; the year is added when it differs from `today`'s. Unparseable → "". */
export function day(d: string | null | undefined, today?: string): string {
  const m = typeof d === "string" ? DAY.exec(d) : null;
  if (m === null) return "";
  const month = MONTHS[Number(m[2]) - 1];
  if (month === undefined) return "";
  const base = `${month} ${Number(m[3])}`;
  const ty = typeof today === "string" ? DAY.exec(today)?.[1] : undefined;
  return ty !== undefined && ty !== m[1] ? `${base}, ${m[1]}` : base;
}

/** Day string `offset` days from `d` (UTC calendar arithmetic on "YYYY-MM-DD"). */
export function addDays(d: string, offset: number): string {
  const m = DAY.exec(d);
  if (m === null) return d;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + Math.round(offset) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b − a), or null. */
export function daysBetween(a: string, b: string): number | null {
  const ma = DAY.exec(a), mb = DAY.exec(b);
  if (ma === null || mb === null) return null;
  return Math.round((Date.UTC(+mb[1]!, +mb[2]! - 1, +mb[3]!) - Date.UTC(+ma[1]!, +ma[2]! - 1, +ma[3]!)) / 86_400_000);
}

/** A ratio in prose: one decimal from 1 up ("×2.7"), two below 1 ("×0.53"). */
export function ratio(r: number): string {
  if (!Number.isFinite(r) || r <= 0) return "×?";
  return `×${r >= 1 ? r.toFixed(1) : r.toFixed(2)}`;
}

/** An MDE in prose ("about ×2.5"): always one decimal. */
export function mde(m: number): string {
  return Number.isFinite(m) && m > 0 ? `×${m.toFixed(1)}` : "×?";
}

/** A ratio in a ledger row or window line: two decimals ("×0.75"). */
export function ratio2(r: number): string {
  return Number.isFinite(r) && r > 0 ? `×${r.toFixed(2)}` : "×?";
}

/**
 * A range, rounded OUTWARD to two decimals so the printed range is never narrower than the computed one
 * (D31: always "range", never a confidence level).
 */
export function range(lo: number, hi: number, sep = "–"): string {
  const l = Math.floor(lo * 100 + 1e-9) / 100, h = Math.ceil(hi * 100 - 1e-9) / 100;
  return `×${l.toFixed(2)}${sep}×${h.toFixed(2)}`;
}

/** A rate for a ledger row ("3.2"), or "–" without a denominator. */
export function rate(k: number, n: number, scale: number): string {
  if (!(n > 0) || !Number.isFinite(k)) return "–";
  const v = (k / n) * scale;
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/**
 * The first candidate that fits `limit` code points. The last candidate must be a fixed sentence known to fit;
 * if even it does not, it is cut (never silently: the cut ends in "…"). Labels are never truncated mid-way by
 * design: callers drop detail by offering shorter candidates.
 */
export function fit(limit: number, ...candidates: readonly string[]): string {
  for (const c of candidates) if (len(c) <= limit) return c;
  const last = [...(candidates[candidates.length - 1] ?? "")];
  return last.length <= limit ? last.join("") : `${last.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/** Capitalise the first letter. */
export function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
