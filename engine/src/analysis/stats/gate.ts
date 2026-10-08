/**
 * Minimum-data gate: before any comparison is reported, both windows must hold enough independent
 * evidence. Below the gate the honest answer is "not enough data yet" (with progress), not
 * "no detectable change".
 *
 * The gate is about usefulness more than validity: with the CR2 small-sample correction, synthetic
 * no-change users stayed at ≤ ~5% false positives even with only 2 sessions per window, or with one
 * session holding > 60% of a window — but such comparisons can only detect enormous changes. Defaults:
 * ≥ 3 sessions on ≥ 4 days per window, ≥ 20 events overall, no session above 60% of a window.
 */
import { dayIndex, nonNeg } from "./ratio.js";
import type { Cell, ClusterScheme } from "./types.js";

export interface WindowSummary {
  /** Σ numerator (events). */
  events: number;
  /** Σ denominator (exposure). */
  denominator: number;
  /** Non-empty resampling clusters under the chosen scheme. */
  clusters: number;
  /** Distinct sessions with data. */
  sessions: number;
  /** Distinct valid local days with data. */
  days: number;
  /** Largest single session's share of the denominator, 0..1 (0 when there is no denominator). */
  maxSessionShare: number;
}

/** Summarise one window's cells. Cells with no numerator and no denominator are ignored. */
export function summarizeWindow(cells: readonly Cell[], scheme: ClusterScheme): WindowSummary {
  const perSession = new Map<string, number>();
  const clusters = new Set<string>();
  const days = new Set<string>();
  let events = 0, denominator = 0;
  for (const c of cells) {
    const n = nonNeg(c.num), d = nonNeg(c.den);
    if (n === 0 && d === 0) continue;
    events += n;
    denominator += d;
    const s = String(c.session);
    perSession.set(s, (perSession.get(s) ?? 0) + d);
    clusters.add(scheme === "session" ? s : s + "\u001f" + String(c.day));
    if (dayIndex(c.day) !== undefined) days.add(c.day);
  }
  let top = 0;
  for (const v of perSession.values()) if (v > top) top = v;
  return {
    events,
    denominator,
    clusters: clusters.size,
    sessions: perSession.size,
    days: days.size,
    maxSessionShare: denominator > 0 ? top / denominator : 0,
  };
}

export interface GateThresholds {
  /** Events summed over both windows (default 20). */
  minEvents: number;
  /** Events in each window (default 0: a drop to zero must stay detectable). */
  minEventsPerWindow: number;
  /** Denominator in each window, in the metric's own units (default 1). */
  minDenominator: number;
  /**
   * Resampling clusters in each window, counted under the method's scheme (default 3). With session
   * clusters (the recommended method) this coincides with minSessions; raise it to require more
   * session-days under a session-day scheme.
   */
  minClusters: number;
  /** Distinct sessions in each window (default 3). */
  minSessions: number;
  /** Distinct days with data in each window (default 4). */
  minDays: number;
  /** Largest single-session share of a window's denominator (default 0.6). */
  maxSessionShare: number;
}

export const DEFAULT_GATE: Readonly<GateThresholds> = Object.freeze({
  minEvents: 20,
  minEventsPerWindow: 0,
  minDenominator: 1,
  minClusters: 3,
  minSessions: 3,
  minDays: 4,
  maxSessionShare: 0.6,
});

export type GateCriterionId =
  | "events" | "eventsPerWindow" | "denominator" | "clusters" | "sessions" | "days" | "sessionShare";

export interface GateCriterion {
  id: GateCriterionId;
  window: "recent" | "baseline" | "both";
  value: number;
  /** Minimum (or, for sessionShare, maximum) allowed. */
  required: number;
  pass: boolean;
  /** 0..1, how close this criterion is to passing (1 = passes). */
  progress: number;
}

export interface GateResult {
  pass: boolean;
  /** 0..1, the bottleneck criterion's progress. */
  progress: number;
  criteria: GateCriterion[];
  /** Failing criteria only, worst first. */
  blocking: GateCriterion[];
}

function atLeast(id: GateCriterionId, window: GateCriterion["window"], value: number, required: number): GateCriterion {
  const pass = value >= required;
  const progress = pass ? 1 : required > 0 ? Math.max(0, Math.min(1, value / required)) : 1;
  return { id, window, value, required, pass, progress };
}

function atMost(id: GateCriterionId, window: GateCriterion["window"], value: number, max: number): GateCriterion {
  const pass = value <= max;
  const progress = pass ? 1 : value > 0 ? Math.max(0, Math.min(1, max / value)) : 1;
  return { id, window, value, required: max, pass, progress };
}

export function evaluateGate(
  recent: WindowSummary,
  baseline: WindowSummary,
  thresholds: Partial<GateThresholds> = {},
): GateResult {
  const t: GateThresholds = { ...DEFAULT_GATE, ...thresholds };
  const criteria: GateCriterion[] = [atLeast("events", "both", recent.events + baseline.events, t.minEvents)];
  for (const [window, w] of [["recent", recent], ["baseline", baseline]] as const) {
    if (t.minEventsPerWindow > 0) criteria.push(atLeast("eventsPerWindow", window, w.events, t.minEventsPerWindow));
    criteria.push(
      atLeast("denominator", window, w.denominator, t.minDenominator),
      atLeast("clusters", window, w.clusters, t.minClusters),
      atLeast("sessions", window, w.sessions, t.minSessions),
      atLeast("days", window, w.days, t.minDays),
      atMost("sessionShare", window, w.maxSessionShare, t.maxSessionShare),
    );
  }
  const blocking = criteria.filter((c) => !c.pass).sort((a, b) => a.progress - b.progress);
  return {
    pass: blocking.length === 0,
    progress: criteria.reduce((m, c) => Math.min(m, c.progress), 1),
    criteria,
    blocking,
  };
}
