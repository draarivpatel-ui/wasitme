/**
 * Directly standardised ratio (METHOD.md §8).
 *
 * For one metric, over the strata S present in BOTH windows (a stratum is present when it has a denominator in
 * that window), with recent totals N_rs / D_rs and baseline totals N_bs / D_bs:
 *
 *   w_s  = D_rs / Σ_S D_r          the recent window's mix (the standard population)
 *   b_s  = N_bs / D_bs             the baseline's rate in stratum s
 *   recent rate     R = Σ_S N_r / Σ_S D_r                 (= Σ w_s r_s)
 *   standardised baseline rate   B* = Σ_S w_s b_s
 *   standardised ratio           R / B*
 *
 * i.e. the baseline is reweighted to the recent window's project × model × entrypoint mix. Strata present in only
 * one window are left out (their share is reported as coverage).
 *
 * The RANGE uses the same estimator as the raw comparison (`measureShift`: the method's cluster bootstrap, the
 * keep-the-larger-SE rule, the small-sample factor, the Poisson/binomial floor, the t range, D23 materiality). It is
 * fed the recent cells of S unchanged and the baseline cells of S with every count in stratum s multiplied by
 * c·f_s, where
 *
 *   f_s = (D_rs / Σ_S D_r) / (D_bs / Σ_S D_b)   so that  Σ f N_b / Σ f D_b = B*  and  Σ f D_b = Σ_S D_b,
 *   c   = Σ f N_b / Σ f² N_b                     (Kish: the weighted event count becomes an effective count).
 *
 * Reweighting is the usual fixed-weight convention (the standard mix is not resampled). The common scale c leaves
 * the rate, the bootstrap, the CR2 leverages and the binomial share unchanged (all are scale-free); it only makes
 * the variance floor and the 0.5 pseudo-count act on the effective number of events: with c, the floor
 * 1/(c·Σ f N_b) equals the Poisson variance Σ f² N_b / (Σ f N_b)² of the weighted log-total. Without it, unequal
 * weights would make the floor too tight. With an unchanged mix every f_s = 1 and c = 1, so the standardised
 * comparison is the raw one exactly. When the baseline has no events in S, c = 1.
 *
 * Workload condition (METHOD.md §8): a shifted metric's shift HOLDS only when its standardised range still excludes 1×
 * and is still material (D23) in the raw direction. Otherwise — no common strata ("your projects differ too much
 * to compare"), no interval, a flipped direction, or below materiality — the result is `unclear (workload)`.
 */
import { measureShift, type ComparisonView, type MeasureContext, type MetricEvaluation } from "../gates/evaluate.js";
import type { StratumCell } from "../metrics/cells.js";
import type { Direction, Family, MetricDef, MetricId, Role } from "../metrics/defs.js";
import type { ChangeCall } from "../stats/material.js";
import type { Cell } from "../stats/types.js";
import { keepsShift, type LostReason } from "./agreement.js";
import { totalsByStratum } from "./strata.js";

export interface StandardisedWeights {
  /** Strata with a denominator in both windows (sorted). */
  common: string[];
  /** Strata with a denominator in only one window. */
  recentOnly: number;
  baselineOnly: number;
  /** Share of each window's denominator that lies in the common strata (0..1). */
  coverage: { recent: number; baseline: number };
  /** Per common stratum: recent share w_s, baseline share, f_s (before the Kish scale). Sorted by stratum. */
  strata: { stratum: string; recentShare: number; baselineShare: number; factor: number }[];
  /** The Kish scale c (1 when the baseline has no events in the common strata). */
  kish: number;
  /** R = Σ_S N_r / Σ_S D_r. */
  recentRate: number;
  /** B* = Σ_S w_s · b_s. */
  baselineStandardised: number;
  /** R / B* without pseudo-counts; null when B* is 0. */
  ratio: number | null;
}

export interface Standardisation {
  /** Null when no stratum has a denominator in both windows. */
  weights: StandardisedWeights | null;
  /** Recent cells of the common strata (unchanged). */
  recent: Cell[];
  /** Baseline cells of the common strata, every count multiplied by c·f_s. */
  baseline: Cell[];
}

/** Standardisation arithmetic for one metric's stratum cells, already cut to the two windows. Pure. */
export function standardise(recent: readonly StratumCell[], baseline: readonly StratumCell[]): Standardisation {
  const rT = totalsByStratum(recent), bT = totalsByStratum(baseline);
  const common = [...rT.keys()].filter((s) => rT.get(s)!.den > 0 && (bT.get(s)?.den ?? 0) > 0).sort();
  const recentOnly = [...rT.keys()].filter((s) => rT.get(s)!.den > 0 && !((bT.get(s)?.den ?? 0) > 0)).length;
  const baselineOnly = [...bT.keys()].filter((s) => bT.get(s)!.den > 0 && !((rT.get(s)?.den ?? 0) > 0)).length;
  if (common.length === 0) return { weights: null, recent: [], baseline: [] };

  let rDenAll = 0, bDenAll = 0, rNum = 0, rDen = 0, bDen = 0;
  for (const t of rT.values()) rDenAll += t.den;
  for (const t of bT.values()) bDenAll += t.den;
  for (const s of common) {
    rNum += rT.get(s)!.num;
    rDen += rT.get(s)!.den;
    bDen += bT.get(s)!.den;
  }
  const factor = new Map<string, number>();
  const strata: StandardisedWeights["strata"] = [];
  let baselineStandardised = 0, sumFN = 0, sumF2N = 0;
  for (const s of common) {
    const r = rT.get(s)!, b = bT.get(s)!;
    const recentShare = r.den / rDen, baselineShare = b.den / bDen;
    const f = recentShare / baselineShare;
    factor.set(s, f);
    strata.push({ stratum: s, recentShare, baselineShare, factor: f });
    baselineStandardised += recentShare * (b.num / b.den);
    sumFN += f * b.num;
    sumF2N += f * f * b.num;
  }
  const kish = sumFN > 0 && sumF2N > 0 ? sumFN / sumF2N : 1;
  const inCommon = new Set(common);
  const rc: Cell[] = [], bc: Cell[] = [];
  for (const c of recent) if (inCommon.has(c.stratum)) rc.push({ session: c.session, day: c.day, num: c.num, den: c.den });
  for (const c of baseline) {
    const f = factor.get(c.stratum);
    if (f === undefined) continue;
    bc.push({ session: c.session, day: c.day, num: c.num * f * kish, den: c.den * f * kish });
  }
  const recentRate = rNum / rDen;
  return {
    weights: {
      common,
      recentOnly,
      baselineOnly,
      coverage: { recent: rDen / rDenAll, baseline: bDen / bDenAll },
      strata,
      kish,
      recentRate,
      baselineStandardised,
      ratio: baselineStandardised > 0 ? recentRate / baselineStandardised : null,
    },
    recent: rc,
    baseline: bc,
  };
}

export type StandardisedReason = "no_overlap" | LostReason;

export interface StandardisedShift {
  metric: MetricId;
  family: Family;
  role: Role;
  /** The raw comparison it stands next to. */
  raw: { ratio: number; range: { lo: number; hi: number }; direction: Direction };
  /** False → "your projects differ too much to compare". */
  overlap: boolean;
  weights: StandardisedWeights | null;
  /** Same estimator as the raw range, on the standardised data; null with no overlap or no interval. */
  comparison: ComparisonView | null;
  call: ChangeCall | null;
  /** The shift survives standardisation: material (D23) in the raw direction. */
  holds: boolean;
  /** Why it does not hold (null when it holds). */
  reason: StandardisedReason | null;
}

/**
 * The standardised ratio of one shifted metric. `ev` is the metric's raw evaluation (must be material); the stratum
 * cells are already cut to the evaluation's windows.
 */
export function standardisedShift(
  def: MetricDef,
  ev: MetricEvaluation,
  recent: readonly StratumCell[],
  baseline: readonly StratumCell[],
  ctx: MeasureContext,
): StandardisedShift {
  if (!ev.material || ev.direction === null || ev.comparison === null) {
    throw new RangeError(`standardisedShift needs a shifted metric (${ev.id} is not material)`);
  }
  const raw = { ratio: ev.comparison.ratio, range: { ...ev.comparison.range }, direction: ev.direction };
  const base = { metric: ev.id, family: ev.family, role: ev.role, raw };
  const st = standardise(recent, baseline);
  if (st.weights === null) {
    return { ...base, overlap: false, weights: null, comparison: null, call: null, holds: false, reason: "no_overlap" };
  }
  const m = measureShift(def, st.recent, st.baseline, ctx);
  const verdict = keepsShift(ev.direction, m === null ? null : m.call);
  return { ...base, overlap: true, weights: st.weights, comparison: m?.comparison ?? null, call: m?.call ?? null, ...verdict };
}
