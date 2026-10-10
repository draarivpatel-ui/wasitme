/**
 * Turning intervals into honest calls.
 *
 * A metric's change is *material* only when all of these hold:
 *  1. its interval excludes 1 (no change);
 *  2. the point estimate moved by at least `minRelativeChange` (as a reader sees it: ×1.2 = +20%,
 *     ×0.8 = −20%);
 *  3. for rates, the absolute difference is at least `absoluteFloor` (so 0.1% → 0.2% is not news).
 *
 * Across metrics, a verdict of "changed" needs at least `minAgree` material metrics moving the same
 * way and none material the opposite way; material moves both ways is "mixed". Never a verdict from
 * one metric by default.
 */
import type { IntervalKind, RatioComparison } from "./types.js";

export type Direction = "up" | "down";

export interface ChangeEvidence {
  /** Point estimate of recent / baseline. */
  ratio: number;
  /** Interval for the ratio. */
  lo: number;
  hi: number;
  /** Raw window rates, needed only for the absolute floor. */
  recentRate?: number;
  baselineRate?: number;
}

export interface MaterialOptions {
  /** Minimum |ratio − 1| (default 0.2). */
  minRelativeChange?: number;
  /** Minimum |recentRate − baselineRate| (default 0 = off). Use for rates, e.g. 0.01 = 1 point. */
  absoluteFloor?: number;
}

export const DEFAULT_MIN_RELATIVE_CHANGE = 0.2;

/** Relative floating-point tolerance on the relative-change threshold (see `classifyChange`). */
const REL_TOLERANCE = 1e-9;

export type NotMaterialReason = "no-data" | "interval-includes-1" | "below-relative-threshold" | "below-absolute-floor";

export interface ChangeCall {
  /** Direction of the evidence: the interval's side when it excludes 1, else the point estimate's. */
  direction: Direction | null;
  /** Interval excludes 1. */
  significant: boolean;
  material: boolean;
  /** ratio − 1. */
  relativeChange: number;
  /** recentRate − baselineRate, when both rates are known. */
  absoluteChange: number | null;
  /** Why the change is not material (empty when material). */
  reasons: NotMaterialReason[];
}

/** Pick one interval out of a bootstrap comparison. */
export function evidenceFrom(cmp: RatioComparison, kind: IntervalKind): ChangeEvidence {
  const iv = cmp[kind];
  return { ratio: cmp.ratio, lo: iv.lo, hi: iv.hi, recentRate: cmp.recent.rate, baselineRate: cmp.baseline.rate };
}

export function classifyChange(ev: ChangeEvidence, opts: MaterialOptions = {}): ChangeCall {
  const minRel = opts.minRelativeChange ?? DEFAULT_MIN_RELATIVE_CHANGE;
  const floor = opts.absoluteFloor ?? 0;
  const { ratio, lo, hi } = ev;
  const absoluteChange =
    Number.isFinite(ev.recentRate) && Number.isFinite(ev.baselineRate) ? ev.recentRate! - ev.baselineRate! : null;
  if (!Number.isFinite(ratio) || Number.isNaN(lo) || Number.isNaN(hi)) {
    return { direction: null, significant: false, material: false, relativeChange: NaN, absoluteChange, reasons: ["no-data"] };
  }
  const relativeChange = ratio - 1;
  const up = lo > 1, down = hi < 1;
  const significant = up || down;
  const direction: Direction | null = up ? "up" : down ? "down" : ratio > 1 ? "up" : ratio < 1 ? "down" : null;

  const reasons: NotMaterialReason[] = [];
  if (!significant) reasons.push("interval-includes-1");
  // Effect size is judged on the point estimate, in the interval's direction. The threshold carries a 1e-9 relative
  // tolerance (like the absolute floor in d23Call): a ratio computed as exp(ln a − ln b) can land one ULP short of an
  // exact ×1.25 or ×0.75 move (1.2499999999999998), which is still a 25% move.
  const bigEnough = direction === "up" ? ratio >= (1 + minRel) * (1 - REL_TOLERANCE)
    : direction === "down" ? ratio <= (1 - minRel) * (1 + REL_TOLERANCE) : false;
  if (!bigEnough) reasons.push("below-relative-threshold");
  if (floor > 0 && (absoluteChange === null || Math.abs(absoluteChange) < floor)) reasons.push("below-absolute-floor");
  return { direction, significant, material: reasons.length === 0, relativeChange, absoluteChange, reasons };
}

/** Flip a direction for metrics where "up" means better, so agreement can be judged as worse/better. */
export function orient(direction: Direction | null, higherIsBetter: boolean): Direction | null {
  if (!higherIsBetter || direction === null) return direction;
  return direction === "up" ? "down" : "up";
}

export interface MetricCall {
  metric: string;
  direction: Direction | null;
  material: boolean;
}

export type AgreementVerdict = "changed" | "mixed" | "none";

export interface Agreement {
  verdict: AgreementVerdict;
  /** Direction of a "changed" verdict, else null. */
  direction: Direction | null;
  /** Metrics with a material increase / decrease. */
  up: string[];
  down: string[];
}

/** ≥ minAgree material in one direction and none opposite → changed; material both ways → mixed; else none. */
export function agreement(calls: readonly MetricCall[], minAgree = 2): Agreement {
  const k = Math.max(1, Math.floor(minAgree));
  const up = calls.filter((c) => c.material && c.direction === "up").map((c) => c.metric);
  const down = calls.filter((c) => c.material && c.direction === "down").map((c) => c.metric);
  if (up.length > 0 && down.length > 0) return { verdict: "mixed", direction: null, up, down };
  if (up.length >= k) return { verdict: "changed", direction: "up", up, down };
  if (down.length >= k) return { verdict: "changed", direction: "down", up, down };
  return { verdict: "none", direction: null, up, down };
}
