/**
 * Onset (METHOD.md §10 steps 1–3), only after "changed".
 *
 *  1. Split score. For each split day d in the tier's span (d = the first day of the "after" segment; before =
 *     [span start, d−1], after = [d, span end]) with at least `minSessionDays` (5) session-days with a denominator
 *     on each side for EVERY counted metric:
 *        Z(d) = Σ_m s_m · θ_m(d) / SE_m(d)
 *     over the counted shifted metrics m (20b `changedOf(...).counted`), s_m = +1 for an upward shift, −1 for a
 *     downward one, θ_m(d) = ln((ΣY_after+0.5)/ΣX_after) − ln((ΣY_before+0.5)/ΣX_before) (METHOD.md §6), and
 *     SE_m(d) the linearised cluster-robust SE: per side Var(ln R) ≈ Σ_k (n_k/N − d_k/D)² × the method's small-sample
 *     factor (CR2 / K/(K−1)), floored at the Poisson/binomial variance of the event count, sides added. Clusters follow
 *     the analysis method (two-level → sessions, the parent level); with `keepLargerSe` and ≥ 5 sessions on both sides
 *     the other scheme's SE is computed too and the larger kept (METHOD.md §6). A side with < 2 clusters (no
 *     between-cluster information) does not qualify.
 *  2. Onset interval. I = hull{d : Z(d) ≥ max Z − Δ} ∪ [d* − 2, d* + 2] (d* = the earliest argmax), widened by a
 *     1-day guard on each side and clipped to the span. Δ is calibrated by WP-23 (G-onset: I covers the true onset
 *     ≥ 80% of the time); `ONSET_DEFAULTS.delta` is a provisional value.
 *  3. If no split day qualifies (should not happen after "changed": the D23 gate already demands ≥ 10 session-days
 *     per window) I is the whole span and `localized` is false — more candidates, never fewer.
 *
 * Only days decide (cells carry the reader's local day); timestamps are never read, so a clock that went backward
 * cannot reorder the profile.
 */
import type { AnalysisMethod } from "../gates/d23.js";
import type { VarianceFloor } from "../stats/bootstrap.js";
import { dayIndex, dayString, PSEUDO_COUNT } from "../stats/ratio.js";
import { countCorrection, cr2Correction } from "../stats/smallsample.js";
import type { Cell, ClusterScheme } from "../stats/types.js";
import type { MetricId } from "../metrics/defs.js";
import type { Onset, OnsetOptions, OnsetPoint } from "./types.js";

export const ONSET_DEFAULTS: Readonly<OnsetOptions> = Object.freeze({ delta: 2, halfWidth: 2, guard: 1, minSessionDays: 5 });

export interface OnsetMetric {
  metric: MetricId;
  /** +1: the shift is upward; −1: downward. */
  sign: 1 | -1;
  floor: VarianceFloor;
  /** The metric's cells (any days; only the span is used). */
  cells: readonly Cell[];
}

export function checkOnsetOptions(o: OnsetOptions): OnsetOptions {
  const ok = (x: number, min: number) => typeof x === "number" && Number.isFinite(x) && x >= min;
  if (!ok(o.delta, 0)) throw new RangeError(`onset.delta must be a finite number ≥ 0 (got ${String(o.delta)})`);
  if (!ok(o.halfWidth, 0) || !Number.isInteger(o.halfWidth)) throw new RangeError(`onset.halfWidth must be an integer ≥ 0 (got ${String(o.halfWidth)})`);
  if (!ok(o.guard, 0) || !Number.isInteger(o.guard)) throw new RangeError(`onset.guard must be an integer ≥ 0 (got ${String(o.guard)})`);
  if (!ok(o.minSessionDays, 1)) throw new RangeError(`onset.minSessionDays must be ≥ 1 (got ${String(o.minSessionDays)})`);
  return o;
}

interface DayAgg {
  /** cluster key → totals, per scheme */
  session: Map<string, { n: number; d: number }>;
  sessionDay: Map<string, { n: number; d: number }>;
  n: number;
  d: number;
  /** session-days with a denominator */
  sessionDays: number;
}

function nn(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
}

/** Canonical cell order, so floating-point sums never depend on the input order. */
function byDaySession(a: Cell, b: Cell): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  const sa = String(a.session), sb = String(b.session);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.num - b.num || a.den - b.den;
}

/** Per-day aggregates of one metric's cells inside [from, to] (day indices). */
function aggregate(cells: readonly Cell[], from: number, to: number): Map<number, DayAgg> {
  const out = new Map<number, DayAgg>();
  for (const c of [...cells].sort(byDaySession)) {
    const i = dayIndex(c.day);
    if (i === undefined || i < from || i > to) continue;
    const n = nn(c.num), d = nn(c.den);
    if (n === 0 && d === 0) continue;
    let a = out.get(i);
    if (!a) out.set(i, (a = { session: new Map(), sessionDay: new Map(), n: 0, d: 0, sessionDays: 0 }));
    a.n += n;
    a.d += d;
    const s = String(c.session);
    const sd = a.sessionDay.get(s);
    if (sd) {
      if (sd.d === 0 && d > 0) a.sessionDays++;
      sd.n += n;
      sd.d += d;
    } else {
      a.sessionDay.set(s, { n, d });
      if (d > 0) a.sessionDays++;
    }
    const ss = a.session.get(s);
    if (ss) {
      ss.n += n;
      ss.d += d;
    } else a.session.set(s, { n, d });
  }
  return out;
}

interface Side {
  n: number;
  d: number;
  sessionDays: number;
  sessions: Map<string, { n: number; d: number }>;
  sessionDayUnits: { n: number; d: number }[];
}

function side(days: Map<number, DayAgg>, from: number, to: number): Side {
  const sessions = new Map<string, { n: number; d: number }>();
  const sessionDayUnits: { n: number; d: number }[] = [];
  let n = 0, d = 0, sessionDays = 0;
  for (const [i, a] of days) {
    if (i < from || i > to) continue;
    n += a.n;
    d += a.d;
    sessionDays += a.sessionDays;
    for (const [s, v] of a.session) {
      const t = sessions.get(s);
      if (t) {
        t.n += v.n;
        t.d += v.d;
      } else sessions.set(s, { n: v.n, d: v.d });
    }
    for (const v of a.sessionDay.values()) sessionDayUnits.push(v);
  }
  return { n, d, sessionDays, sessions, sessionDayUnits };
}

/** Linearised variance of ln R for one side's units; null without between-unit information. */
function logRateVariance(units: readonly { n: number; d: number }[], N: number, D: number, method: AnalysisMethod, floor: VarianceFloor): number | null {
  const withDen = units.filter((u) => u.d > 0 || u.n > 0);
  if (withDen.length < 2 || !(D > 0)) return null;
  const ns = Float64Array.from(withDen.map((u) => u.n)), ds = Float64Array.from(withDen.map((u) => u.d));
  const corr = method.smallSample === "cr2" ? cr2Correction(ns, ds) : countCorrection(withDen.length);
  if (!Number.isFinite(corr.factor)) return null;
  let s = 0;
  if (N > 0) for (const u of withDen) s += (u.n / N - u.d / D) ** 2;
  const fl = floor === "none" ? 0 : floor === "poisson" ? 1 / (N + PSEUDO_COUNT) : (1 - Math.min(1, N / D)) / (N + PSEUDO_COUNT);
  return Math.max(s * corr.factor, fl);
}

function sideVariance(sd: Side, scheme: ClusterScheme, method: AnalysisMethod, floor: VarianceFloor): number | null {
  const units = scheme === "session" ? [...sd.sessions.values()] : sd.sessionDayUnits;
  return logRateVariance(units, sd.n, sd.d, method, floor);
}

/** z-term of one metric at one split; null when the split does not qualify for it. */
function term(m: OnsetMetric, days: Map<number, DayAgg>, span: { from: number; to: number }, d: number, method: AnalysisMethod, minSessionDays: number): number | null {
  const before = side(days, span.from, d - 1), after = side(days, d, span.to);
  if (before.sessionDays < minSessionDays || after.sessionDays < minSessionDays) return null;
  if (!(before.d > 0) || !(after.d > 0)) return null;
  const primary: ClusterScheme = method.twoLevel ? "session" : method.clusters;
  const se = (scheme: ClusterScheme): number | null => {
    const vb = sideVariance(before, scheme, method, m.floor), va = sideVariance(after, scheme, method, m.floor);
    return vb === null || va === null ? null : Math.sqrt(vb + va);
  };
  let s = se(primary);
  if (method.keepLargerSe && before.sessions.size >= 5 && after.sessions.size >= 5) {
    const other = se(primary === "session" ? "session-day" : "session");
    if (other !== null && (s === null || other > s)) s = other;
  }
  if (s === null || !(s > 0) || !Number.isFinite(s)) return null;
  const theta = Math.log((after.n + PSEUDO_COUNT) / after.d) - Math.log((before.n + PSEUDO_COUNT) / before.d);
  return (m.sign * theta) / s;
}

/**
 * The onset interval over `span` (inclusive "YYYY-MM-DD" days) for the counted shifted metrics. Pure,
 * deterministic, no clock reads.
 */
export function onsetInterval(metrics: readonly OnsetMetric[], span: { from: string; to: string }, method: AnalysisMethod, options: OnsetOptions): Onset {
  const o = checkOnsetOptions(options);
  const from = dayIndex(span.from), to = dayIndex(span.to);
  if (from === undefined || to === undefined || to < from) throw new RangeError(`onset span must be valid days with from ≤ to (got ${span.from}…${span.to})`);
  const aggs = metrics.map((m) => aggregate(m.cells, from, to));
  const profile: OnsetPoint[] = [];
  let maxZ = -Infinity, peak = -1;
  const zs = new Map<number, number>();
  for (let d = from + 1; d <= to; d++) {
    let z: number | null = metrics.length > 0 ? 0 : null;
    for (let k = 0; k < metrics.length && z !== null; k++) {
      const t = term(metrics[k]!, aggs[k]!, { from, to }, d, method, o.minSessionDays);
      z = t === null ? null : z + t;
    }
    profile.push({ d: dayString(d), z });
    if (z !== null) {
      zs.set(d, z);
      if (z > maxZ + 1e-12) {
        maxZ = z;
        peak = d;
      }
    }
  }
  const base = { span: { from: span.from, to: span.to }, delta: o.delta, metrics: metrics.map((m) => ({ metric: m.metric, sign: m.sign })), profile };
  if (peak < 0) {
    return { ...base, localized: false, peak: null, maxZ: null, core: null, interval: { from: span.from, to: span.to } };
  }
  let cLo = peak, cHi = peak;
  for (const [d, z] of zs) {
    if (z >= maxZ - o.delta - 1e-12) {
      if (d < cLo) cLo = d;
      if (d > cHi) cHi = d;
    }
  }
  const lo = Math.max(from, Math.min(cLo, peak - o.halfWidth) - o.guard);
  const hi = Math.min(to, Math.max(cHi, peak + o.halfWidth) + o.guard);
  return {
    ...base,
    localized: true,
    peak: dayString(peak),
    maxZ,
    core: { from: dayString(cLo), to: dayString(cHi) },
    interval: { from: dayString(lo), to: dayString(hi) },
  };
}
