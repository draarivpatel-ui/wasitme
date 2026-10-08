/**
 * Analytic (linearised) equivalent of `bootstrapRatio`, its closed-form stand-in (METHOD.md §6): the calibration harness
 * (WP-23) evaluates hundreds of thousands of windows, where a B = 2,000 bootstrap per comparison is too slow.
 * Production keeps the bootstrap; the harness checks this module against it (median |log SE ratio| ≤ 5% on
 * ≥ 200 evaluations, `calibration/secheck.ts`).
 *
 * Same inputs, same preparation (clusters merged by id, zero-denominator children folded into a sibling), same
 * small-sample factor ("count" or "cr2" over the same units), same Poisson/binomial floor, same Welch–
 * Satterthwaite df and the same point estimate. Only the window variance differs: instead of the variance of B
 * bootstrap replicates of log((n* + c)/d*), it is that variance's first-order (delta-method) value.
 *
 *   per cluster k:  a_k = n_k/(N + c) − d_k/D           (gradient of log((n + c)/d) at the window totals)
 *   single level:   V = Σ_k (a_k − ā)²                    (resampling K clusters with replacement)
 *   two levels:     V = Σ_p (A_p − Ā)² + Σ_p Σ_{j∈p} (a_pj − ā_p)²
 *                   (draw P parents, then each drawn parent's c_p children; A_p = Σ_j a_pj, ā_p = A_p/c_p)
 *
 * What it cannot see: the bootstrap's redraw of all-zero-denominator replicates and the curvature of log(·) when a
 * window has few events (the sparse-failure profile is where the two differ most; the SE check reports it).
 */
import { correctionFor, DEFAULT_RESAMPLES, DEFAULT_SMALL_SAMPLE, floorVariance, prepare, windowTotals, type BootstrapOptions, type Prepared } from "./bootstrap.js";
import { normalQuantile, studentTQuantile, twoSidedP } from "./distributions.js";
import { logRate, PSEUDO_COUNT } from "./ratio.js";
import type { Cluster, Interval, RatioComparison } from "./types.js";

const UNINFORMATIVE: Interval = { lo: 0, hi: Infinity };

/** Linearised bootstrap variance of one window's log((n + c)/d) (see the file header). */
export function linearisedVariance(w: Prepared, twoLevel: boolean, pseudo: number): number {
  const N = w.totNum, D = w.totDen;
  if (!(D > 0)) return 0;
  const gn = 1 / (N + pseudo), gd = 1 / D;
  const { num, den, start, size } = w;
  if (!twoLevel || w.parents === w.clusters) {
    const K = w.clusters;
    let s = 0, s2 = 0;
    for (let k = 0; k < K; k++) {
      const a = num[k]! * gn - den[k]! * gd;
      s += a;
      s2 += a * a;
    }
    return Math.max(0, s2 - (s * s) / K);
  }
  const P = w.parents;
  let sA = 0, sA2 = 0, within = 0;
  for (let p = 0; p < P; p++) {
    const s0 = start[p]!, c = size[p]!;
    let t = 0, t2 = 0;
    for (let j = 0; j < c; j++) {
      const a = num[s0 + j]! * gn - den[s0 + j]! * gd;
      t += a;
      t2 += a * a;
    }
    sA += t;
    sA2 += t * t;
    within += Math.max(0, t2 - (t * t) / c);
  }
  return Math.max(0, sA2 - (sA * sA) / P) + within;
}

/**
 * Drop-in replacement for `bootstrapRatio` (same options, same output shape) with the linearised window
 * variance. `resamples` is reported back (callers validate it) but unused; `seBootstrap` is the uncorrected
 * linearised SE; the percentile intervals are its normal approximation (nothing in the engine reads them).
 */
export function analyticRatio(
  recentClusters: readonly Cluster[],
  baselineClusters: readonly Cluster[],
  opts: BootstrapOptions = {},
): RatioComparison {
  const B = Math.max(2, Math.floor(opts.resamples ?? DEFAULT_RESAMPLES));
  const twoLevel = opts.twoLevel === true;
  const pseudo = opts.pseudo ?? PSEUDO_COUNT;
  const floorKind = opts.floor ?? "poisson";
  const smallSample = opts.smallSample ?? DEFAULT_SMALL_SAMPLE;
  const seed = opts.seed ?? "analytic";

  const R = prepare(recentClusters);
  const Bw = prepare(baselineClusters);
  const recent = windowTotals(R, twoLevel);
  const baseline = windowTotals(Bw, twoLevel);
  const point = logRate(R.totNum, R.totDen, pseudo) - logRate(Bw.totNum, Bw.totDen, pseudo);
  const base = { recent, baseline, logRatio: point, ratio: Math.exp(point), resamples: B, twoLevel, smallSample, seed };
  const fail = (reason: string, seBootstrap = NaN): RatioComparison => ({
    ...base, seBootstrap, se: Infinity, df: 0,
    percentile95: UNINFORMATIVE, percentile99: UNINFORMATIVE, t95: UNINFORMATIVE, t99: UNINFORMATIVE,
    pValue: 1, ok: false, reason,
  });
  if (!(R.totDen > 0) || !(Bw.totDen > 0)) return fail("a window has no denominator");
  if (recent.units < 2 || baseline.units < 2) return fail(`fewer than 2 ${twoLevel ? "sessions" : "clusters"} in a window`);

  const varR = linearisedVariance(R, twoLevel, pseudo);
  const varB = linearisedVariance(Bw, twoLevel, pseudo);
  const seBootstrap = Math.sqrt(varR + varB);
  const cR = correctionFor(R, twoLevel, smallSample);
  const cB = correctionFor(Bw, twoLevel, smallSample);
  if (!Number.isFinite(cR.factor) || !Number.isFinite(cB.factor)) return fail("one session holds essentially all of a window's data", seBootstrap);
  const vR = Math.max(varR * cR.factor, floorVariance(floorKind, R.totNum, R.totDen, pseudo));
  const vB = Math.max(varB * cB.factor, floorVariance(floorKind, Bw.totNum, Bw.totDen, pseudo));
  const v = vR + vB;
  if (!(v > 0)) return fail("no variability in either window", seBootstrap);
  const se = Math.sqrt(v);
  const df = (v * v) / ((vR * vR) / cR.df + (vB * vB) / cB.df);
  const z = (a: number): Interval => {
    const q = normalQuantile(1 - a / 2);
    return { lo: Math.exp(point - q * seBootstrap), hi: Math.exp(point + q * seBootstrap) };
  };
  const tInt = (a: number): Interval => {
    const q = studentTQuantile(1 - a / 2, df);
    return { lo: Math.exp(point - q * se), hi: Math.exp(point + q * se) };
  };
  const out = {
    ...base, seBootstrap, se, df,
    percentile95: z(0.05), percentile99: z(0.01),
    pValue: twoSidedP(point / se, df), ok: true,
  } as Omit<RatioComparison, "t95" | "t99"> as RatioComparison;
  // The t intervals cost two t-quantile inversions and the engine reads its own range (measureShift), so they are
  // computed on first read (enumerable, so the object still serialises like the bootstrap's).
  lazy(out, "t95", () => tInt(0.05));
  lazy(out, "t99", () => tInt(0.01));
  return out;
}

function lazy<T extends object, K extends keyof T>(o: T, key: K, make: () => T[K]): void {
  let v: T[K] | undefined;
  Object.defineProperty(o, key, { enumerable: true, configurable: true, get: () => (v ??= make()) });
}
