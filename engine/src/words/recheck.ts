/**
 * "At your pace a re-check needs about N sessions (date)" (next steps: durations are always
 * engine-computed). One small pure estimate, deliberately simple and stated as "about":
 *
 * After the user undoes a change, a new window of K' session-days is compared with the current (shifted) recent
 * window. With per-cluster variance v the same in every window, SE² ∝ 1/K_a + 1/K_b, and the MDE scales with SE
 * (ln MDE = c·SE). Today: ln MDE_now ∝ √(1/SD_r + 1/SD_b). The shift is visible again when the new comparison's MDE
 * is at most the observed ratio r:
 *
 *     1/K' + 1/SD_r ≤ q · (1/SD_r + 1/SD_b),   q = (ln r / ln MDE_now)²
 *     ⇒ K' ≥ 1/A,  A = q·(1/SD_r + 1/SD_b) − 1/SD_r      (A ≤ 0: not reachable by waiting)
 *
 * K' is raised to the gate's session-day floor, converted to days with the metric's pace (session-days and new
 * sessions per day, progress.ts), and the day count is raised so the gate's session floor is met too. A family is
 * ready when its best metric is; the re-check is the slowest family. More than `maxDays` (84, the longest tier
 * history) or no pace → "can't confirm a change this size at your pace". The t-quantiles' change with df is ignored
 * (hence "about").
 */
import { addDays } from "./format.js";

export interface RecheckMetric {
  family: string;
  /** The observed ratio (≠ 1). */
  ratio: number;
  /** Today's MDE (> 1). */
  mde: number;
  recentSessionDays: number;
  baselineSessionDays: number;
  /** Per calendar day (progress pace, progress.ts). */
  pace: { sessionDays: number; newSessions: number } | null;
}

export type Recheck =
  | { kind: "eta"; days: number; sessions: number; date: string }
  | { kind: "not_at_pace" };

export interface RecheckGate {
  minSessions: number;
  minSessionDays: number;
}

export const RECHECK_MAX_DAYS = 84;

/** Days (and sessions) one metric needs, or null when waiting cannot get there. */
export function metricRecheck(m: RecheckMetric, gate: RecheckGate): { days: number; sessions: number } | null {
  const lr = Math.abs(Math.log(m.ratio)), lm = Math.log(m.mde);
  if (!(lr > 0) || !(lm > 0) || !(m.recentSessionDays > 0) || !(m.baselineSessionDays > 0)) return null;
  const p = m.pace;
  if (p === null || !(p.sessionDays > 0) || !(p.newSessions > 0)) return null;
  const q = (lr / lm) ** 2;
  const a = q * (1 / m.recentSessionDays + 1 / m.baselineSessionDays) - 1 / m.recentSessionDays;
  if (!(a > 0)) return null;
  const k = Math.max(Math.ceil(1 / a - 1e-9), gate.minSessionDays);
  const days = Math.ceil(Math.max(k / p.sessionDays, gate.minSessions / p.newSessions) - 1e-9);
  const sessions = Math.max(gate.minSessions, Math.ceil(days * p.newSessions - 1e-9));
  return { days, sessions };
}

/** The re-check estimate over the metrics that counted for "changed"; null when there are none. */
export function recheckEstimate(metrics: readonly RecheckMetric[], gate: RecheckGate, today: string, maxDays = RECHECK_MAX_DAYS): Recheck | null {
  if (metrics.length === 0) return null;
  const families = [...new Set(metrics.map((m) => m.family))];
  let worst: { days: number; sessions: number } | null = null;
  for (const f of families) {
    let best: { days: number; sessions: number } | null = null;
    for (const m of metrics.filter((x) => x.family === f)) {
      const r = metricRecheck(m, gate);
      if (r !== null && (best === null || r.days < best.days)) best = r;
    }
    if (best === null) return { kind: "not_at_pace" };
    if (worst === null || best.days > worst.days) worst = best;
  }
  if (worst === null || worst.days > maxDays) return { kind: "not_at_pace" };
  return { kind: "eta", days: worst.days, sessions: worst.sessions, date: addDays(today, worst.days) };
}
