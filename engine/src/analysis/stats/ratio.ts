/**
 * Ratio-of-totals building blocks. A window's rate is Σnum / Σden over all its cells (never a mean
 * of per-session rates, which over-weights tiny sessions).
 */
import type { Cell, Cluster, ClusterScheme } from "./types.js";

/** Default pseudo-count added to numerators before taking logs (keeps log(0) finite). */
export const PSEUDO_COUNT = 0.5;

/** Finite, non-negative number or 0. Inputs come from parsed logs; never trust them. */
export function nonNeg(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
}

export interface Totals {
  num: number;
  den: number;
}

export function totals(items: readonly { num: number; den: number }[]): Totals {
  let num = 0, den = 0;
  for (const it of items) {
    num += nonNeg(it.num);
    den += nonNeg(it.den);
  }
  return { num, den };
}

/** Ratio of totals; NaN when there is no denominator. */
export function rateOf(t: Totals): number {
  return t.den > 0 ? t.num / t.den : NaN;
}

/**
 * log((num + c) / den) with the pseudo-count c on the numerator only (so rates far from zero are
 * essentially unbiased). A zero denominator is replaced by c so the value stays finite.
 */
export function logRate(num: number, den: number, pseudo = PSEUDO_COUNT): number {
  return Math.log((num + pseudo) / (den > 0 ? den : pseudo));
}

/** log(rate_recent / rate_baseline) with pseudo-counts. */
export function logRatio(recent: Totals, baseline: Totals, pseudo = PSEUDO_COUNT): number {
  return logRate(recent.num, recent.den, pseudo) - logRate(baseline.num, baseline.den, pseudo);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Memo of `dayIndex` (pure; same answer for the same string). The analysis calls it per cell per window, and the
 * calibration harness (WP-23) per evaluation day, so the regex + Date round trip dominated its profile. Bounded: a
 * flood of distinct strings only resets the memo, it never changes a result.
 */
const DAY_INDEX_MEMO = new Map<string, number | undefined>();
const DAY_INDEX_MEMO_MAX = 20_000;

/** Day number (days since 1970-01-01) of a "YYYY-MM-DD" string, or undefined if invalid. */
export function dayIndex(day: string): number | undefined {
  if (typeof day !== "string") return undefined;
  const hit = DAY_INDEX_MEMO.get(day);
  if (hit !== undefined || DAY_INDEX_MEMO.has(day)) return hit;
  const idx = parseDayIndex(day);
  if (DAY_INDEX_MEMO.size >= DAY_INDEX_MEMO_MAX) DAY_INDEX_MEMO.clear();
  DAY_INDEX_MEMO.set(day, idx);
  return idx;
}

function parseDayIndex(day: string): number | undefined {
  if (!DAY_RE.test(day)) return undefined;
  const ms = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  if (!Number.isFinite(ms)) return undefined;
  const idx = Math.round(ms / 86_400_000);
  // Reject roll-overs like 2026-02-31.
  return dayString(idx) === day ? idx : undefined;
}

export function dayString(index: number): string {
  return new Date(index * 86_400_000).toISOString().slice(0, 10);
}

/** Separator for composite keys; hashed session ids and ISO days never contain it. */
const SEP = "\u001f";

/**
 * Group cells into resampling clusters. "session" → one cluster per session; "session-day" → one
 * per session per day, with `parent` = session so the two-level bootstrap can nest them.
 * Duplicate (session, day) cells are summed. Output is sorted by id (input order never matters).
 */
export function clusterCells(cells: readonly Cell[], scheme: ClusterScheme): Cluster[] {
  const map = new Map<string, Cluster>();
  for (const c of cells) {
    const session = String(c.session);
    const id = scheme === "session" ? session : session + SEP + String(c.day);
    let cl = map.get(id);
    if (!cl) {
      cl = scheme === "session" ? { id, num: 0, den: 0 } : { id, parent: session, num: 0, den: 0 };
      map.set(id, cl);
    }
    cl.num += nonNeg(c.num);
    cl.den += nonNeg(c.den);
  }
  return [...map.values()].sort(byId);
}

export function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Normalise caller-supplied clusters: merge duplicate ids (summing counts, first parent wins),
 * sanitise counts, sort by id. Clusters with neither numerator nor denominator are dropped —
 * they carry no information and would only dilute the small-sample correction.
 */
export function normalizeClusters(clusters: readonly Cluster[]): Cluster[] {
  const map = new Map<string, Cluster>();
  for (const c of clusters) {
    const id = String(c.id);
    let cl = map.get(id);
    if (!cl) {
      cl = c.parent === undefined ? { id, num: 0, den: 0 } : { id, parent: String(c.parent), num: 0, den: 0 };
      map.set(id, cl);
    }
    cl.num += nonNeg(c.num);
    cl.den += nonNeg(c.den);
  }
  return [...map.values()].filter((c) => c.num > 0 || c.den > 0).sort(byId);
}
