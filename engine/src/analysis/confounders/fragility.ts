/**
 * Fragility (METHOD.md §7; research/08 #3 "dominant-cluster guard", on top of D23's largest-session-under-50% gate).
 *
 * 1. Per voting metric — leave one SESSION out. Sessions are the independent unit (days of one session are
 *    correlated, so dropping one session-day would understate the fragility; days get their own rule below).
 *      θ = ln((ΣY_r+0.5)/ΣX_r) − ln((ΣY_b+0.5)/ΣX_b)  (METHOD.md §6), and θ₋ₖ the same with session k removed from BOTH
 *      windows (a session is one unit even when it spans the two windows).
 *      influence(k) = s · (θ − θ₋ₖ), s = +1 for an upward shift, −1 for a downward one (for a metric that is not
 *      material, the sign of θ). Positive = removing k weakens the shift. A removal that empties a window's
 *      denominator has influence +∞.
 *      The MOST INFLUENTIAL session is the one with the largest influence (ties → smaller session key). Each
 *      session's share of each window's denominator is reported too.
 *    RULE: a material voting metric is FRAGILE when, re-estimated without its most influential session by the SAME
 *    estimator as the raw range (`measureShift`; no gate re-applied), its D23 call flips direction, loses
 *    materiality, or has no interval (`keepsShift`).
 *
 * 2. Verdict level — METHOD.md §7, condition 5: "dropping any one of the 3 most influential days does not remove the
 *    change". Applies only when the full data is "changed" (`changedOf`).
 *      influence(d) = Σ over the counted shifted metrics m of s_m · (θ_m − θ_m₋d) / SE_m  (SE_m = the raw kept SE),
 *      +∞ when dropping d empties a window's denominator for some m. The 3 most influential days (ties → earlier
 *      day) are dropped one at a time; every ELIGIBLE voting metric is re-estimated without that day (same
 *      estimator, no gate re-applied; a metric left without an interval is not material) and `changedOf` is
 *      recomputed with the df floor. "Changed" SURVIVES a drop only when it is still changed on the same side.
 *    RULE: fragile = some drop does not survive → the verdict layer treats the data as NOT changed.
 */
import { measureShift, statusOf, type ComparisonView, type MeasureContext, type MetricEvaluation } from "../gates/evaluate.js";
import type { Direction, Family, MetricDef, MetricId } from "../metrics/defs.js";
import type { ChangeCall } from "../stats/material.js";
import { logRatio, PSEUDO_COUNT, totals } from "../stats/ratio.js";
import type { Cell } from "../stats/types.js";
import { changedOf, DF_FLOOR, keepsShift, usableForVerdict, type LostReason, type Side, type VotingView } from "./agreement.js";

/** METHOD.md §7: the 3 most influential days. */
export const FRAGILE_DAYS = 3;

export interface SessionInfluence {
  session: string;
  /** Share of each window's denominator (0 when the window has none). */
  recentShare: number;
  baselineShare: number;
  /** θ without this session; null when that empties a window's denominator. */
  logRatioWithout: number | null;
  influence: number;
}

function sign(direction: Direction | null, theta: number): 1 | -1 {
  if (direction !== null) return direction === "up" ? 1 : -1;
  return theta >= 0 ? 1 : -1;
}

function minus(t: { num: number; den: number }, u: { num: number; den: number } | undefined): { num: number; den: number } {
  return u === undefined ? t : { num: t.num - u.num, den: t.den - u.den };
}

function groupTotals(cells: readonly Cell[], key: (c: Cell) => string): Map<string, { num: number; den: number }> {
  const out = new Map<string, { num: number; den: number }>();
  for (const c of cells) {
    const k = key(c);
    const t = out.get(k) ?? { num: 0, den: 0 };
    const one = totals([c]);
    t.num += one.num;
    t.den += one.den;
    out.set(k, t);
  }
  return out;
}

/** θ (with the METHOD.md §6 pseudo-count), or null when a window has no denominator (left by a removal). */
function theta(r: { num: number; den: number }, b: { num: number; den: number }): number | null {
  // Removals subtract sums of the same cells: clamp float dust so an emptied window reads as empty.
  const rd = r.den > 1e-9 ? r.den : 0, bd = b.den > 1e-9 ? b.den : 0;
  if (!(rd > 0) || !(bd > 0)) return null;
  return logRatio({ num: Math.max(0, r.num), den: rd }, { num: Math.max(0, b.num), den: bd }, PSEUDO_COUNT);
}

/** Leave-one-session-out θ and influences (sorted: most influential first). Pure. */
export function leaveOneSessionOut(rc: readonly Cell[], bc: readonly Cell[], s: 1 | -1): { logRatio: number | null; sessions: SessionInfluence[] } {
  const R = totals(rc), B = totals(bc);
  const full = theta(R, B);
  const rS = groupTotals(rc, (c) => c.session), bS = groupTotals(bc, (c) => c.session);
  const ids = [...new Set([...rS.keys(), ...bS.keys()])].sort();
  const out: SessionInfluence[] = [];
  for (const k of ids) {
    const without = theta(minus(R, rS.get(k)), minus(B, bS.get(k)));
    const influence = full === null ? 0 : without === null ? Infinity : s * (full - without);
    out.push({
      session: k,
      recentShare: R.den > 0 ? (rS.get(k)?.den ?? 0) / R.den : 0,
      baselineShare: B.den > 0 ? (bS.get(k)?.den ?? 0) / B.den : 0,
      logRatioWithout: without,
      influence,
    });
  }
  out.sort((a, b) => b.influence - a.influence || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
  return { logRatio: full, sessions: out };
}

export interface ClusterFragility {
  metric: MetricId;
  family: Family;
  /** The raw call: material, and its direction (null when not material). */
  material: boolean;
  direction: Direction | null;
  logRatio: number | null;
  /** Sessions with data in either window. */
  sessions: number;
  /** Largest single session's share of each window's denominator. */
  maxShare: { recent: number; baseline: number };
  /** Every session, most influential first. */
  influences: SessionInfluence[];
  mostInfluential: string | null;
  /** Material metrics only: the full re-estimate without the most influential session. */
  without: { session: string; comparison: ComparisonView | null; call: ChangeCall | null } | null;
  fragile: boolean;
  reason: LostReason | null;
}

/** Rule 1 for one eligible voting metric (cells already cut to the windows). */
export function clusterFragility(def: MetricDef, ev: MetricEvaluation, rc: readonly Cell[], bc: readonly Cell[], ctx: MeasureContext): ClusterFragility {
  const material = ev.material && ev.direction !== null;
  const loo = leaveOneSessionOut(rc, bc, sign(ev.direction, ev.comparison?.logRatio ?? 0));
  const top = loo.sessions[0];
  const maxShare = {
    recent: loo.sessions.reduce((m, x) => Math.max(m, x.recentShare), 0),
    baseline: loo.sessions.reduce((m, x) => Math.max(m, x.baselineShare), 0),
  };
  const base = {
    metric: ev.id, family: ev.family, material, direction: ev.direction, logRatio: loo.logRatio,
    sessions: loo.sessions.length, maxShare, influences: loo.sessions, mostInfluential: top?.session ?? null,
  };
  if (!material || top === undefined) return { ...base, without: null, fragile: false, reason: null };
  const keep = (c: Cell) => c.session !== top.session;
  const m = measureShift(def, rc.filter(keep), bc.filter(keep), ctx);
  const verdict = keepsShift(ev.direction!, m?.call ?? null);
  return {
    ...base,
    without: { session: top.session, comparison: m?.comparison ?? null, call: m?.call ?? null },
    fragile: !verdict.holds,
    reason: verdict.reason,
  };
}

export interface DayInfluence {
  day: string;
  window: "recent" | "baseline";
  influence: number;
}

/** One shifted metric's input to the day influence: its windowed cells, shift sign and raw SE. */
export interface DayInfluenceInput {
  rc: readonly Cell[];
  bc: readonly Cell[];
  sign: 1 | -1;
  se: number;
}

/** Day influences summed over the shifted metrics (sorted: most influential first, ties → earlier day). Pure. */
export function dayInfluences(inputs: readonly DayInfluenceInput[]): DayInfluence[] {
  const window = new Map<string, "recent" | "baseline">();
  for (const m of inputs) {
    for (const c of m.rc) window.set(c.day, "recent");
    for (const c of m.bc) if (!window.has(c.day)) window.set(c.day, "baseline");
  }
  const prepared = inputs.map((m) => {
    const R = totals(m.rc), B = totals(m.bc);
    return { m, R, B, full: theta(R, B), rD: groupTotals(m.rc, (c) => c.day), bD: groupTotals(m.bc, (c) => c.day) };
  });
  const out: DayInfluence[] = [];
  for (const [day, w] of window) {
    let influence = 0;
    for (const { m, R, B, full, rD, bD } of prepared) {
      if (full === null || !(m.se > 0)) continue;
      const without = theta(minus(R, rD.get(day)), minus(B, bD.get(day)));
      influence += without === null ? Infinity : (m.sign * (full - without)) / m.se;
    }
    out.push({ day, window: w, influence });
  }
  out.sort((a, b) => b.influence - a.influence || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return out;
}

export interface DayDropMetric {
  metric: MetricId;
  /** Null when the metric has no interval without the day. */
  comparison: ComparisonView | null;
  material: boolean;
  status: MetricEvaluation["status"];
  usable: boolean;
}

export interface DayDrop extends DayInfluence {
  metrics: DayDropMetric[];
  changed: boolean;
  side: Side | null;
  /** Still changed, on the same side. */
  survives: boolean;
}

export interface DayFragility {
  /** The full data is "changed" (otherwise nothing to test). */
  applicable: boolean;
  /** The days dropped (at most 3), most influential first. */
  drops: DayDrop[];
  /** Some drop removes "changed" → treat as not changed. */
  fragile: boolean;
}

/** One voting metric's data for the day rule. */
export interface DayRuleMetric {
  def: MetricDef;
  ev: MetricEvaluation;
  rc: readonly Cell[];
  bc: readonly Cell[];
}

/** Rule 2 over one tier's voting metrics (all of them, eligible or not; cells already cut to the windows). */
export function dayFragility(metrics: readonly DayRuleMetric[], ctx: MeasureContext, floor = DF_FLOOR): DayFragility {
  const voting = metrics.filter((m) => m.ev.role === "vote");
  const full = changedOf(voting.map((m) => m.ev), floor);
  if (!full.changed) return { applicable: false, drops: [], fragile: false };
  const counted = voting.filter((m) => full.counted.includes(m.ev.id));
  const days = dayInfluences(counted.map((m) => ({ rc: m.rc, bc: m.bc, sign: m.ev.direction === "down" ? -1 : 1, se: m.ev.comparison!.se })))
    .slice(0, FRAGILE_DAYS);
  const drops: DayDrop[] = days.map((d) => {
    const keep = (c: Cell) => c.day !== d.day;
    const views: VotingView[] = [];
    const rows: DayDropMetric[] = [];
    for (const m of voting) {
      if (!m.ev.eligible) {
        views.push(m.ev);
        continue;
      }
      const r = measureShift(m.def, m.rc.filter(keep), m.bc.filter(keep), ctx);
      const view: VotingView = r === null
        ? { id: m.ev.id, family: m.ev.family, role: m.ev.role, eligible: true, material: false, status: "none", comparison: null }
        : { id: m.ev.id, family: m.ev.family, role: m.ev.role, eligible: true, material: r.call.material, status: statusOf(m.def, r.call), comparison: r.comparison };
      views.push(view);
      rows.push({ metric: m.ev.id, comparison: r?.comparison ?? null, material: view.material, status: view.status, usable: usableForVerdict(view, floor) });
    }
    const after = changedOf(views, floor);
    return { ...d, metrics: rows, changed: after.changed, side: after.side, survives: after.changed && after.side === full.side };
  });
  return { applicable: true, drops, fragile: drops.some((d) => !d.survives) };
}
