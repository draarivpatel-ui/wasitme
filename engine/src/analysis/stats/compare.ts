/**
 * One-call comparison of a metric between a recent window and a baseline window, using the
 * calibrated default method, plus the multi-metric roll-up. This is the entry point the verdict
 * layer should use; the lower-level pieces stay available for experiments.
 *
 * Typical use:
 *   const r = compareMetric(recentCells, baselineCells, { floor: "binomial" });   // per metric
 *   const verdict = rollup([{ metric: "tool-error", result: r }, …]);            // across metrics
 *
 * Default method: session clusters, small-sample t 95% interval with the Bell–McCaffrey (CR2)
 * correction. Why — false-positive rates at a nominal 5% from calibrate.ts (WASITME_CALIBRATION=full,
 * 2000 synthetic no-change users per cell, 3 user shapes × 3 metrics, B = 1000):
 *  - session/t95:cr2 (recommended): 0.7–4.8%. Few long sessions ≈ 0.7–1.5% (conservative: sessions
 *    spanning both windows are resampled as if independent), medium 2.1–4.6%, many short 3.5–4.8%.
 *  - session/t95 with U/(U−1) + Welch df (the spike's rule): 2.1–7.9% — too high once session sizes
 *    are unequal (medium shape).
 *  - session-day/t99 (the spike's other rule): up to 11.1% (7.8% with CR2) — days of one session are
 *    correlated, so session-day intervals are too narrow.
 *  - percentile bootstrap: up to 24.1% on session-days, up to 8.9% on sessions.
 *  - two-level/t95:cr2: 0.1–4.3%, valid but less power than session clusters in every cell.
 *  - session permutation test: 2.1–5.8% (p-value only, no interval).
 * The default test suite re-checks the ≤ 6% bar on both key shapes (test/stats/calibrate.test.ts).
 */
import { bootstrapRatio, DEFAULT_RESAMPLES, type VarianceFloor } from "./bootstrap.js";
import { evaluateGate, summarizeWindow, type GateResult, type GateThresholds, type WindowSummary } from "./gate.js";
import { holmAdjust } from "./holm.js";
import { agreement, classifyChange, evidenceFrom, orient, type Agreement, type ChangeCall, type Direction, type MaterialOptions } from "./material.js";
import { minimumDetectableChange, type Mdc, type MdcOptions } from "./mdc.js";
import { clusterCells } from "./ratio.js";
import type { Cell, Method, RatioComparison } from "./types.js";

export const RECOMMENDED_METHOD: Readonly<Method> = Object.freeze({
  clusters: "session",
  twoLevel: false,
  interval: "t95",
  smallSample: "cr2",
});

export interface CompareOptions {
  /** Override parts of the method (default RECOMMENDED_METHOD). twoLevel forces session-day clusters. */
  method?: Partial<Method>;
  gate?: Partial<GateThresholds>;
  material?: MaterialOptions;
  resamples?: number;
  seed?: string;
  /** "binomial" for proportions (num ≤ den), "poisson" for counts per unit (default). */
  floor?: VarianceFloor;
  mdc?: MdcOptions;
  /** Run the bootstrap even when the gate fails (the call is still reported as insufficient data). */
  force?: boolean;
}

export type MetricStatus = "insufficient-data" | "material-change" | "no-material-change";

export interface MetricComparison {
  status: MetricStatus;
  method: Method;
  gate: GateResult;
  recent: WindowSummary;
  baseline: WindowSummary;
  /** Bootstrap result; absent when the gate failed and `force` was not set. */
  comparison?: RatioComparison;
  /** Materiality call; null when the gate failed or the interval could not be computed. */
  call: ChangeCall | null;
  /** Smallest change this data could detect (80% power at the method's level). */
  mdc?: Mdc;
}

function resolveMethod(m: Partial<Method> | undefined): Method {
  const method: Method = { ...RECOMMENDED_METHOD, ...(m ?? {}) };
  if (method.twoLevel) method.clusters = "session-day";
  return method;
}

export function compareMetric(recentCells: readonly Cell[], baselineCells: readonly Cell[], opts: CompareOptions = {}): MetricComparison {
  const method = resolveMethod(opts.method);
  // The gate always counts sessions and days; clusters are counted under the method's scheme.
  const recent = summarizeWindow(recentCells, method.clusters);
  const baseline = summarizeWindow(baselineCells, method.clusters);
  const gate = evaluateGate(recent, baseline, opts.gate);
  const base = { method, gate, recent, baseline };
  if (!gate.pass && !opts.force) return { ...base, status: "insufficient-data", call: null };

  const comparison = bootstrapRatio(clusterCells(recentCells, method.clusters), clusterCells(baselineCells, method.clusters), {
    resamples: opts.resamples ?? DEFAULT_RESAMPLES,
    twoLevel: method.twoLevel,
    smallSample: method.smallSample,
    floor: opts.floor ?? "poisson",
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  });
  if (!gate.pass || !comparison.ok) return { ...base, status: "insufficient-data", comparison, call: null };

  const level = method.interval.endsWith("99") ? 0.99 : 0.95;
  const usesT = method.interval.startsWith("t");
  const mdc = minimumDetectableChange(usesT ? comparison.se : comparison.seBootstrap, {
    alpha: 1 - level,
    ...(usesT ? { df: comparison.df } : {}),
    ...(opts.mdc ?? {}),
  });
  const call = classifyChange(evidenceFrom(comparison, method.interval), opts.material);
  return { ...base, status: call.material ? "material-change" : "no-material-change", comparison, call, mdc };
}

export interface MetricInput {
  metric: string;
  result: MetricComparison;
  /** True when a higher value is better (e.g. cache hit rate); agreement is then judged on worse/better. */
  higherIsBetter?: boolean;
}

export interface RollupOptions {
  /** Material metrics needed in one direction for "changed" (default 2). */
  minAgree?: number;
  /** "holm": a metric only counts as material if its Holm-adjusted p ≤ alpha as well (default "none"). */
  familywise?: "holm" | "none";
  alpha?: number;
}

export interface Rollup extends Agreement {
  /** Direction convention: when any input sets higherIsBetter, "up" means "worse". */
  oriented: boolean;
  /** Holm-adjusted p-values by metric (only metrics with a comparison). */
  adjustedP: Record<string, number>;
  /** Metrics excluded for insufficient data. */
  insufficient: string[];
}

/** Combine per-metric results into one verdict: changed / mixed / none. */
export function rollup(inputs: readonly MetricInput[], opts: RollupOptions = {}): Rollup {
  const alpha = opts.alpha ?? 0.05;
  const oriented = inputs.some((i) => i.higherIsBetter === true);
  const tested = inputs.filter((i) => i.result.status !== "insufficient-data" && i.result.comparison?.ok);
  const adjusted = holmAdjust(tested.map((i) => i.result.comparison!.pValue));
  const adjustedP: Record<string, number> = {};
  tested.forEach((i, k) => (adjustedP[i.metric] = adjusted[k]!));
  const calls = tested.map((i) => {
    const call = i.result.call!;
    const passesFamily = opts.familywise !== "holm" || adjustedP[i.metric]! <= alpha;
    const direction: Direction | null = orient(call.direction, i.higherIsBetter === true);
    return { metric: i.metric, direction, material: call.material && passesFamily };
  });
  return {
    ...agreement(calls, opts.minAgree ?? 2),
    oriented,
    adjustedP,
    insufficient: inputs.filter((i) => !tested.includes(i)).map((i) => i.metric),
  };
}
