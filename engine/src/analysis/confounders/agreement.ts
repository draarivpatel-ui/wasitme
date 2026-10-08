/**
 * Shared rules for the confounder layer: when does a re-estimated shift still count, which metrics may vote
 * (the research/08 degrees-of-freedom floor), and "changed" per METHOD.md §7 / D23 / D30.
 *
 *  - keepsShift: a re-estimate (standardised, leave-one-out, day dropped) keeps a shift only when its D23 call is
 *    material in the ORIGINAL direction. No interval, a reversal, a range that includes 1×, or a move below
 *    materiality all lose it.
 *  - Degrees-of-freedom floor (research/08 #4, Pustejovsky & Tipton 2018): small-sample t approximations degrade
 *    below ~4 effective df. A voting metric whose kept comparison has df < 4 is NOT USABLE for a verdict (reason
 *    `low_df`). This is a flag only: the metric's `eligible` / `sensitive` / `material` from WP-20a are unchanged,
 *    and the decision layer (WP-21) consumes `usable`.
 *  - changedOf (METHOD.md §7 + D30), on voting metrics only (friction never counts):
 *      material voting metrics are split by their `worse`-oriented status (worse / better), so tool errors ↑ and
 *      reads per edit ↓ agree (both "worse");
 *      MIXED when material voting metrics exist on both sides — usable or not (losing a shift only ever makes a
 *      verdict less specific, so a low-df metric can still block);
 *      CHANGED when not mixed and the side's USABLE material metrics number ≥ 2 and span ≥ 2 voting families.
 */
import type { ComparisonView, MetricEvaluation } from "../gates/evaluate.js";
import { VOTING_FAMILIES, type Direction, type Family, type MetricId } from "../metrics/defs.js";
import type { ChangeCall } from "../stats/material.js";

/** research/08 #4: effective df below this is not usable for a verdict. */
export const DF_FLOOR = 4;

export type LostReason = "no_interval" | "direction_flipped" | "not_material";

/**
 * Whether a re-estimated call keeps a shift in `direction`, and why not. Pure.
 *  - holds: material (D23) in `direction`;
 *  - no_interval: no range could be computed;
 *  - direction_flipped: the range excludes 1× on the OTHER side (a reversal);
 *  - not_material: anything else — the range includes 1× (whichever side the point estimate is on), or the move is
 *    below 25% or below the metric's 1 pt.
 */
export function keepsShift(direction: Direction, call: ChangeCall | null): { holds: boolean; reason: LostReason | null } {
  if (call === null) return { holds: false, reason: "no_interval" };
  if (call.material && call.direction === direction) return { holds: true, reason: null };
  if (call.significant && call.direction !== direction) return { holds: false, reason: "direction_flipped" };
  return { holds: false, reason: "not_material" };
}

/** What the agreement, df and Holm rules need from a metric evaluation (a MetricEvaluation fits). */
export type VotingView = Pick<MetricEvaluation, "id" | "family" | "role" | "eligible" | "material" | "status"> & {
  comparison: Pick<ComparisonView, "df" | "pValue" | "ratio" | "range"> | null;
};

/** Eligible, with an interval whose df is at least the floor. */
export function usableForVerdict(m: VotingView, dfFloor = DF_FLOOR): boolean {
  return m.eligible && m.comparison !== null && Number.isFinite(m.comparison.df) && m.comparison.df >= dfFloor;
}

export interface DfCheck {
  metric: MetricId;
  family: Family;
  /** The kept comparison's effective (Bell–McCaffrey / Welch–Satterthwaite) df; null without a comparison. */
  df: number | null;
  usable: boolean;
  /** "ineligible": not eligible under WP-20a; "low_df": eligible but df < floor. */
  reason: "ineligible" | "low_df" | null;
}

export interface DfFloor {
  floor: number;
  /** One row per voting metric, in input order. */
  metrics: DfCheck[];
  /** Eligible voting metrics set aside by the floor (counted with reason low_df). */
  lowDf: MetricId[];
}

/** The df floor over the voting metrics of one tier. Pure. */
export function dfFloor(metrics: readonly VotingView[], floor = DF_FLOOR): DfFloor {
  const rows: DfCheck[] = [];
  for (const m of metrics) {
    if (m.role !== "vote") continue;
    const df = m.comparison === null ? null : m.comparison.df;
    const usable = usableForVerdict(m, floor);
    rows.push({ metric: m.id, family: m.family, df, usable, reason: usable ? null : m.eligible && m.comparison !== null ? "low_df" : "ineligible" });
  }
  return { floor, metrics: rows, lowDf: rows.filter((r) => r.reason === "low_df").map((r) => r.metric) };
}

export type Side = "worse" | "better";

export interface ChangedCall {
  changed: boolean;
  mixed: boolean;
  /** Side of a changed verdict, else null. */
  side: Side | null;
  /** Material voting metrics by side (usable or not). */
  worse: MetricId[];
  better: MetricId[];
  /** Usable material voting metrics on the deciding side (the ones "changed" counts). */
  counted: MetricId[];
  /** Voting families among `counted`. */
  families: Family[];
  /** Material voting metrics set aside by the df floor. */
  unusableMaterial: MetricId[];
}

/** "Changed" per METHOD.md §7 / D23 / D30 (see the file header). Pure. */
export function changedOf(metrics: readonly VotingView[], floor = DF_FLOOR): ChangedCall {
  const material = metrics.filter((m) => m.role === "vote" && m.eligible && m.material && (m.status === "worse" || m.status === "better"));
  const worse = material.filter((m) => m.status === "worse");
  const better = material.filter((m) => m.status === "better");
  const unusableMaterial = material.filter((m) => !usableForVerdict(m, floor)).map((m) => m.id);
  const ids = (xs: readonly VotingView[]) => xs.map((m) => m.id);
  const mixed = worse.length > 0 && better.length > 0;
  const sideMetrics = mixed ? [] : worse.length > 0 ? worse : better;
  const counted = sideMetrics.filter((m) => usableForVerdict(m, floor));
  const families = VOTING_FAMILIES.filter((f) => counted.some((m) => m.family === f));
  const changed = !mixed && counted.length >= 2 && families.length >= 2;
  return {
    changed,
    mixed,
    side: changed ? (worse.length > 0 ? "worse" : "better") : null,
    worse: ids(worse),
    better: ids(better),
    counted: ids(counted),
    families,
    unusableMaterial,
  };
}
