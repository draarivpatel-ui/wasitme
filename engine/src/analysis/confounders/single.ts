/**
 * The Holm-gated single-metric note (METHOD.md §7, §11 rows 12 and 14; D33).
 *
 * The rule (METHOD.md §7, and §11 row 14 for the plain case): one material metric never yields `none`. If it survives
 * a Holm correction across the eligible voting metrics, the state is `insufficient (single_indicator)` and the headline
 * names it. If not, the state is plain `insufficient`, and the metric shows only in "Why this finding" and Investigate.
 * Metric rows use neutral ink unless the change is family-wise significant (D53(e)).
 *
 * Implemented as:
 *  - Holm family = the ELIGIBLE voting metrics that have an interval (their two-sided p from the kept comparison),
 *    Holm–Bonferroni step-down (stats `holmAdjust`) at α = 1 − the method's level (0.01 for D23's 99% method,
 *    matching research/08's single-metric critical value t at 1 − 0.01/6 for three metrics).
 *  - kinds, first match wins:
 *      changed              METHOD.md §7 "changed" holds (not a single-metric case);
 *      mixed                material voting metrics on both sides (row 3);
 *      none_material        no material voting metric (rows 13/14 decide);
 *      several_not_changed  ≥ 2 material voting metrics, not changed (e.g. one family) → row 14;
 *      low_df               exactly one, but its df is below the research/08 floor → not usable → row 14;
 *      single_indicator     exactly one, usable, Holm-adjusted p ≤ α → row 12 (the headline names it);
 *      fails_holm           exactly one, usable, adjusted p > α → row 14 (Why / Investigate only).
 *  - `familywiseSignificant`: every Holm-family metric with adjusted p ≤ α — the only rows the words/UI layers may
 *    draw in non-neutral ink.
 *  - `blocksNone`: some voting metric is material — never `none` while an indicator moved (METHOD.md §7).
 */
import type { Family, MetricId } from "../metrics/defs.js";
import { holmAdjust } from "../stats/holm.js";
import { changedOf, DF_FLOOR, usableForVerdict, type VotingView } from "./agreement.js";

export type SingleIndicatorKind =
  | "changed" | "mixed" | "none_material" | "several_not_changed" | "low_df" | "single_indicator" | "fails_holm";

export interface SingleIndicatorMetric {
  id: MetricId;
  family: Family;
  status: VotingView["status"];
  ratio: number;
  range: { lo: number; hi: number };
  pValue: number;
  /** Null when the metric is not in the Holm family. */
  adjustedP: number | null;
  df: number;
}

export interface SingleIndicatorNote {
  kind: SingleIndicatorKind;
  /** Family-wise level α = 1 − the method's level. */
  alpha: number;
  /** The Holm family (eligible voting metrics with an interval), in input order. */
  family: MetricId[];
  adjustedP: Partial<Record<MetricId, number>>;
  familywiseSignificant: MetricId[];
  /** The lone material voting metric (kinds low_df, single_indicator, fails_holm), else null. */
  metric: SingleIndicatorMetric | null;
  /** Material voting metrics (eligible), in input order. */
  material: MetricId[];
  /** Some voting metric is material: `none` is ruled out. */
  blocksNone: boolean;
}

/** α = 1 − level, rounded so 1 − 0.99 is exactly 0.01. */
export function familywiseAlpha(level: number): number {
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be in (0, 1) (got ${String(level)})`);
  return Math.round((1 - level) * 1e12) / 1e12;
}

/** The note for one tier's metrics (voting metrics are picked out by role). Pure. */
export function singleIndicatorNote(metrics: readonly VotingView[], level: number, floor = DF_FLOOR): SingleIndicatorNote {
  const alpha = familywiseAlpha(level);
  const voting = metrics.filter((m) => m.role === "vote");
  const tested = voting.filter((m) => m.eligible && m.comparison !== null && Number.isFinite(m.comparison.pValue));
  const adjusted = holmAdjust(tested.map((m) => m.comparison!.pValue));
  const adjustedP: Partial<Record<MetricId, number>> = {};
  tested.forEach((m, i) => (adjustedP[m.id] = adjusted[i]!));
  const familywiseSignificant = tested.filter((m) => adjustedP[m.id]! <= alpha).map((m) => m.id);
  const material = voting.filter((m) => m.eligible && m.material);
  const base = {
    alpha,
    family: tested.map((m) => m.id),
    adjustedP,
    familywiseSignificant,
    material: material.map((m) => m.id),
    blocksNone: material.length > 0,
  };
  const ch = changedOf(voting, floor);
  if (ch.changed) return { ...base, kind: "changed", metric: null };
  if (ch.mixed) return { ...base, kind: "mixed", metric: null };
  if (material.length === 0) return { ...base, kind: "none_material", metric: null };
  if (material.length > 1) return { ...base, kind: "several_not_changed", metric: null };
  const m = material[0]!;
  const c = m.comparison!;
  const metric: SingleIndicatorMetric = {
    id: m.id, family: m.family, status: m.status, ratio: c.ratio, range: { ...c.range }, pValue: c.pValue,
    adjustedP: adjustedP[m.id] ?? null, df: c.df,
  };
  if (!usableForVerdict(m, floor)) return { ...base, kind: "low_df", metric };
  const survives = metric.adjustedP !== null && metric.adjustedP <= alpha;
  return { ...base, kind: survives ? "single_indicator" : "fails_holm", metric };
}
