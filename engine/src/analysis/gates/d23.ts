/**
 * D23 parameters and the per-metric, per-window eligibility gate (METHOD.md §5, §6; D23, D29, D31).
 *
 * The merged stats module still carries its branch defaults (≥20 events pooled, ≥3 sessions, ≥4 days,
 * session share ≤ 0.6, 95% intervals, minRelativeChange 0.2). This layer never relies on those defaults:
 * every D23 number is set here and passed explicitly.
 *
 * Gate (METHOD.md §5), in EACH window:
 *   events ≥ 10, session-days ≥ 10, sessions ≥ 5, largest session's share of the denominator < 50%
 *   (strictly), and the metric's own denominator floor (reads per edit: ≥ 40 edits).
 * Sessions and session-days are counted only where the metric has a denominator (> 0): a session-day with
 * reads but no edits is not a session-day of evidence for reads per edit.
 */
import type { ClusterScheme, SmallSampleCorrection } from "../stats/types.js";
import type { Cell } from "../stats/types.js";

export const D23_GATE = Object.freeze({
  minEventsPerWindow: 10,
  minSessionDays: 10,
  minSessions: 5,
  /** Largest session's share of a window's denominator must be strictly below this. */
  maxSessionShareBelow: 0.5,
});

export type GateParams = typeof D23_GATE;

/** Materiality (D23): range excludes 1×, point estimate moved ≥ 25%, absolute move ≥ 1 pt (per metric). */
export const D23_MIN_RELATIVE_CHANGE = 0.25;

/** Sensitive (METHOD.md §5): eligible with MDE ≤ 2×. */
export const SENSITIVE_MAX_MDE = 2;

/** MDE power (D23: t.80). */
export const MDE_POWER = 0.8;

/**
 * An interval method. `level` sets both the range (θ ± t(level, df)·SE) and the MDE's α = 1 − level.
 * `keepLargerSe` (METHOD.md §6): when both windows have ≥ 5 sessions, also compute the other cluster scheme's SE
 * and keep the larger, with the smaller of the two schemes' df (D81).
 */
export interface AnalysisMethod {
  id: string;
  clusters: ClusterScheme;
  twoLevel: boolean;
  level: 0.95 | 0.99;
  smallSample: SmallSampleCorrection;
  keepLargerSe: boolean;
  /**
   * Range estimator (WP-23; optional, serializable). Absent or "bootstrap": the stratified cluster bootstrap
   * (`bootstrapRatio`) — what the product runs. "analytic": the linearised sandwich equivalent of that bootstrap
   * (`stats/analytic.ts`), the calibration harness's fast stand-in for it (METHOD.md §6). "wild": the
   * null-imposed studentized wild cluster bootstrap with Webb six-point weights (`stats/wild.ts`, research/08 #1).
   */
  estimator?: EstimatorId;
  /** Numerator pseudo-count of θ (default 0.5, METHOD.md §6). The calibration's pseudo-count sensitivity run varies it. */
  pseudo?: number;
  /**
   * Two-sided α of the MDE's critical value (default 1 − level). research/08 #5: the Holm-adjusted single-metric
   * critical value across 3 voting metrics is α = (1 − level)/3; calibration decides whether the ETA uses it.
   */
  mdeAlpha?: number;
}

/** See `AnalysisMethod.estimator`. */
export type EstimatorId = "bootstrap" | "analytic" | "wild";

/** D23's literal method: session-day clusters, 99% small-sample t, K/(K−1) inflation. D29's first candidate. */
export const D23_LITERAL: Readonly<AnalysisMethod> = Object.freeze({
  id: "d23-literal",
  clusters: "session-day",
  twoLevel: false,
  level: 0.99,
  smallSample: "count",
  keepLargerSe: true,
});

/** The other D29 candidates (METHOD.md §6 "The candidates"). The calibration artifact picks the shipped one. */
export const D29_CANDIDATES: Readonly<Record<string, Readonly<AnalysisMethod>>> = Object.freeze({
  "d23-literal": D23_LITERAL,
  "session-day-t99-cr2": Object.freeze({ id: "session-day-t99-cr2", clusters: "session-day", twoLevel: false, level: 0.99, smallSample: "cr2", keepLargerSe: true }),
  "session-t95-cr2": Object.freeze({ id: "session-t95-cr2", clusters: "session", twoLevel: false, level: 0.95, smallSample: "cr2", keepLargerSe: true }),
  "two-level-t95-cr2": Object.freeze({ id: "two-level-t95-cr2", clusters: "session-day", twoLevel: true, level: 0.95, smallSample: "cr2", keepLargerSe: true }),
} as Record<string, Readonly<AnalysisMethod>>);

/** One window's evidence for one metric, counted the D23 way. */
export interface WindowCounts {
  /** Σ numerator. */
  events: number;
  /** Σ denominator. */
  denominator: number;
  /** Distinct sessions with a denominator. */
  sessions: number;
  /** Distinct (session, day) pairs with a denominator. */
  sessionDays: number;
  /** Largest session's share of the denominator (0 with no denominator). */
  maxSessionShare: number;
  /** Session-days (with a denominator) of that largest session (0 with no denominator). */
  topSessionDays: number;
}

export function countWindow(cells: readonly Cell[]): WindowCounts {
  const perSession = new Map<string, number>();
  const daysOf = new Map<string, Set<string>>();
  let events = 0, denominator = 0;
  for (const c of cells) {
    const n = c.num > 0 && Number.isFinite(c.num) ? c.num : 0;
    const d = c.den > 0 && Number.isFinite(c.den) ? c.den : 0;
    events += n;
    if (d <= 0) continue;
    denominator += d;
    perSession.set(c.session, (perSession.get(c.session) ?? 0) + d);
    let days = daysOf.get(c.session);
    if (!days) daysOf.set(c.session, (days = new Set()));
    days.add(c.day);
  }
  // Largest session; ties broken by the smaller session key so the result never depends on input order.
  let top = 0, topKey: string | undefined;
  for (const [k, v] of perSession) if (v > top || (v === top && topKey !== undefined && k < topKey)) [top, topKey] = [v, k];
  let sessionDays = 0;
  for (const days of daysOf.values()) sessionDays += days.size;
  return {
    events,
    denominator,
    sessions: perSession.size,
    sessionDays,
    maxSessionShare: denominator > 0 ? top / denominator : 0,
    topSessionDays: topKey === undefined ? 0 : daysOf.get(topKey)!.size,
  };
}

/**
 * Distinct sessions with a denominator across several windows' cells (the same rule as `countWindow`'s `sessions`):
 * a session active on both sides of a window boundary counts once, which the sum of per-window counts cannot say.
 */
export function distinctSessions(...windows: readonly (readonly Cell[])[]): number {
  const seen = new Set<string>();
  for (const cells of windows) {
    for (const c of cells) if (c.den > 0 && Number.isFinite(c.den)) seen.add(c.session);
  }
  return seen.size;
}

export type GateCheckId = "events" | "sessions" | "sessionDays" | "denominator" | "sessionShare";
export type WindowName = "recent" | "baseline";

/**
 * One gate criterion in one window. `have`/`need` are in the criterion's unit (sessions, session-days,
 * events, the metric's denominator; for sessionShare, a fraction with `need` the exclusive maximum).
 * `short` is how many more units are needed, in that same unit (0 when passing; for sessionShare, the
 * denominator — tool calls, edits, … — that other sessions would have to add to bring the top session under
 * the limit).
 *
 * The surfaces show shortfalls in sessions and session-days (METHOD.md §13), so every failing check also carries an
 * estimate in those units (0 when passing; null when the unit does not apply or cannot be estimated from this window):
 *  - sessions: `short` sessions, and at least as many session-days (each new session adds one);
 *  - session-days: `short` session-days; sessions null (sessions already counted can supply them);
 *  - events / denominator: ⌈short ÷ the window's mean per session⌉ sessions and ⌈short ÷ its mean per
 *    session-day⌉ session-days;
 *  - sessionShare: the same, using the means of the OTHER sessions (only they dilute the top one); null
 *    when there are no other sessions.
 * The estimates assume new work looks like the window's existing work; they are indicators, not promises.
 */
export interface GateCheck {
  id: GateCheckId;
  window: WindowName;
  have: number;
  need: number;
  pass: boolean;
  short: number;
  shortSessions: number | null;
  shortSessionDays: number | null;
}

export interface GateOutcome {
  pass: boolean;
  checks: GateCheck[];
  /** Failing checks only, in a fixed order: sessions, sessionDays, events, denominator, sessionShare; recent first. */
  blocking: GateCheck[];
}

/** ⌈short ÷ (total ÷ units)⌉, or null when the per-unit mean is not positive. */
function inUnits(short: number, total: number, units: number): number | null {
  if (!(total > 0) || !(units > 0)) return null;
  return Math.max(1, Math.ceil(short / (total / units) - 1e-9));
}

function atLeast(id: GateCheckId, window: WindowName, have: number, need: number, w: WindowCounts): GateCheck {
  const pass = have >= need;
  const short = pass ? 0 : need - have;
  let shortSessions: number | null = 0, shortSessionDays: number | null = 0;
  if (!pass) {
    if (id === "sessions") [shortSessions, shortSessionDays] = [short, short];
    else if (id === "sessionDays") [shortSessions, shortSessionDays] = [null, short];
    else {
      const total = id === "events" ? w.events : w.denominator;
      shortSessions = inUnits(short, total, w.sessions);
      shortSessionDays = inUnits(short, total, w.sessionDays);
    }
  }
  return { id, window, have, need, pass, short, shortSessions, shortSessionDays };
}

/** Top session's denominator T out of D: others must add x with T/(D + x) < limit → x > T/limit − D. */
function shareCheck(window: WindowName, w: WindowCounts, limit: number): GateCheck {
  const pass = w.denominator > 0 && w.maxSessionShare < limit;
  let short = 0;
  let shortSessions: number | null = 0, shortSessionDays: number | null = 0;
  if (!pass) {
    shortSessions = null;
    shortSessionDays = null;
    if (w.denominator > 0) {
      const top = w.maxSessionShare * w.denominator;
      short = Math.max(0, Math.floor(top / limit - w.denominator) + 1);
      const others = w.denominator - top;
      shortSessions = inUnits(short, others, w.sessions - 1);
      shortSessionDays = inUnits(short, others, w.sessionDays - w.topSessionDays);
    }
  }
  return { id: "sessionShare", window, have: w.maxSessionShare, need: limit, pass, short, shortSessions, shortSessionDays };
}

const ORDER: readonly GateCheckId[] = ["sessions", "sessionDays", "events", "denominator", "sessionShare"];

/** D23 gate for one metric over both windows. `minDenominator` is the metric's own floor (0 = none). */
export function evaluateD23Gate(
  recent: WindowCounts,
  baseline: WindowCounts,
  minDenominator: number,
  params: GateParams = D23_GATE,
): GateOutcome {
  const checks: GateCheck[] = [];
  for (const [name, w] of [["recent", recent], ["baseline", baseline]] as const) {
    checks.push(
      atLeast("sessions", name, w.sessions, params.minSessions, w),
      atLeast("sessionDays", name, w.sessionDays, params.minSessionDays, w),
      atLeast("events", name, w.events, params.minEventsPerWindow, w),
    );
    if (minDenominator > 0) checks.push(atLeast("denominator", name, w.denominator, minDenominator, w));
    checks.push(shareCheck(name, w, params.maxSessionShareBelow));
  }
  const blocking = checks
    .filter((c) => !c.pass)
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id) || (a.window === b.window ? 0 : a.window === "recent" ? -1 : 1));
  return { pass: blocking.length === 0, checks, blocking };
}
