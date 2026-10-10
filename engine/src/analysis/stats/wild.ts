/**
 * Null-imposed, studentized wild cluster bootstrap (WCR) with Webb six-point weights — a calibration candidate
 * (research/08 #1: MacKinnon & Webb 2017/2020; Webb 2023; MacKinnon, Nielsen & Webb 2023). WP-23 runs it against
 * the D29 candidates; nothing in production uses it unless the calibration artifact picks it.
 *
 * The WCR is a test, not an interval. It is made consumable by the engine's range machinery (θ ± q·SE, MDE, Holm,
 * df floor) like this:
 *
 *  1. Statistic. Per window w, the rate R_w = N_w/D_w; the cluster-robust variance of R_w with the CR1 factor
 *     G_w/(G_w − 1) over the window's top-level units g (sessions or session-days; parents when two-level):
 *        V_w = G_w/(G_w − 1) · Σ_g E_g² / D_w²,   E_g = Σ_{k∈g} (n_k − R_w d_k),
 *     floored at the same Poisson/binomial floor as the bootstrap, carried to the rate scale:
 *        V_w ≥ (N_w + c)·(1 − r_w if binomial, never below c/(D_w + c))/D_w².
 *     t = (R_r − R_b)/√(V_r + V_b). This is the log-ratio t linearised at the pooled (null) rate — the canonical
 *     linear-regression setting of the WCR (rates regressed on a window dummy), with no log of a bootstrap total
 *     that could be ≤ 0.
 *  2. Null imposed: R₀ = (N_r + N_b)/(D_r + D_b), restricted residuals ẽ_k = n_k − R₀ d_k.
 *  3. Replicate b: one Webb weight v_g ∈ {±√1.5, ±1, ±√0.5} (each 1/6) per top-level unit, drawn independently
 *     per window (the windows are stratified, like the bootstrap); n*_k = R₀ d_k + v_g ẽ_k; t*_b recomputed exactly
 *     as in step 1 (re-estimated rates and residuals, same floor).
 *  4. The bootstrap critical value c* = the ⌈(1 − α)(B + 1)⌉-th smallest |t*| (α = 1 − level; B = 399 by default so
 *     α(B + 1) is an integer for α = 0.01 and 0.05).
 *  5. Output, in `RatioComparison` form: θ and SE are the analytic sandwich ones (`analyticRatio`, CR1 "count"
 *     factor — the WCR's own studentization), and df is the EFFECTIVE df at which t_{1−α/2}(df) = c*. So the range
 *     θ ± t_{1−α/2}(df)·SE = θ ± c*·SE is a wild-bootstrap-t range, the Holm p-value is twoSidedP(θ/SE, df), and the
 *     MDE uses df. Approximations, stated: the range applies the linear statistic's critical value to the log
 *     ratio's t (identical under the null to first order); p-values away from the α boundary are t-approximate;
 *     heavy tails give a small df (< 4 → the df floor marks the metric `low_df`).
 *
 * Deterministic: the replicate stream is seeded from the windows' totals and sizes.
 */
import { binomialShare, prepare, DEFAULT_RESAMPLES, type BootstrapOptions, type Prepared } from "./bootstrap.js";
import { analyticRatio } from "./analytic.js";
import { normalQuantile, studentTQuantile } from "./distributions.js";
import { PSEUDO_COUNT } from "./ratio.js";
import { Rng } from "./rng.js";
import type { Cluster, RatioComparison } from "./types.js";

/** Default replicates: α(B + 1) is an integer for α = 0.01 and α = 0.05. */
export const WILD_RESAMPLES = 399;

export const WEBB_WEIGHTS: readonly number[] = Object.freeze([
  -Math.sqrt(1.5), -1, -Math.sqrt(0.5), Math.sqrt(0.5), 1, Math.sqrt(1.5),
]);

export interface WildOptions extends BootstrapOptions {
  /** Interval level whose critical value is bootstrapped (0.95 or 0.99). */
  level: number;
}

/** One window collapsed to its top-level units: denominators, raw numerators. */
interface Units {
  d: Float64Array;
  n: Float64Array;
  G: number;
  N: number;
  D: number;
}

function unitsOf(w: Prepared, twoLevel: boolean): Units {
  if (twoLevel) {
    return { d: Float64Array.from(w.parentDen), n: Float64Array.from(w.parentNum), G: w.parents, N: w.totNum, D: w.totDen };
  }
  return { d: Float64Array.from(w.den), n: Float64Array.from(w.num), G: w.clusters, N: w.totNum, D: w.totDen };
}

/** Rate-scale variance floor (see the file header, step 1). */
function rateFloor(binomial: boolean, N: number, D: number, pseudo: number): number {
  const n = Math.max(0, N);
  return ((n + pseudo) * (binomial ? binomialShare(n, D, pseudo) : 1)) / (D * D);
}

/** CR1 variance of a window's rate for unit numerators `n` (the rate re-estimated from them), floored. */
function windowVariance(u: Units, n: ArrayLike<number>, binomial: boolean, pseudo: number, floorOn: boolean): { rate: number; v: number } {
  let N = 0;
  for (let g = 0; g < u.G; g++) N += n[g]!;
  const rate = N / u.D;
  let s = 0;
  for (let g = 0; g < u.G; g++) {
    const e = n[g]! - rate * u.d[g]!;
    s += e * e;
  }
  let v = (u.G / (u.G - 1)) * s / (u.D * u.D);
  if (floorOn) v = Math.max(v, rateFloor(binomial, N, u.D, pseudo));
  return { rate, v };
}

/** Grid of df → t_{1−α/2}(df), used to invert the bootstrap critical value into an effective df. */
const DF_GRID: readonly number[] = (() => {
  const out: number[] = [];
  for (let x = Math.log(0.5); x <= Math.log(5000); x += 0.02) out.push(Math.exp(x));
  return out;
})();
const Q_TABLES = new Map<number, Float64Array>();

function qTable(alpha: number): Float64Array {
  let t = Q_TABLES.get(alpha);
  if (!t) {
    t = Float64Array.from(DF_GRID.map((df) => studentTQuantile(1 - alpha / 2, df)));
    Q_TABLES.set(alpha, t);
  }
  return t;
}

/**
 * Effective df whose two-sided t critical value equals `crit` (log-linear interpolation on a grid of 0.5…5,000 df;
 * t quantiles fall monotonically in df). A critical value at or below the normal one maps to 5,000 df (≈ normal);
 * one above t at 0.5 df maps to 0.5 df.
 */
export function effectiveDf(crit: number, alpha: number): number {
  const q = qTable(alpha);
  if (!(crit > normalQuantile(1 - alpha / 2))) return DF_GRID[DF_GRID.length - 1]!;
  if (crit >= q[0]!) return DF_GRID[0]!;
  let lo = 0, hi = q.length - 1; // q[lo] > crit ≥ q[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (q[mid]! > crit) lo = mid;
    else hi = mid;
  }
  const f = (q[lo]! - crit) / (q[lo]! - q[hi]!);
  return Math.exp(Math.log(DF_GRID[lo]!) + f * (Math.log(DF_GRID[hi]!) - Math.log(DF_GRID[lo]!)));
}

export interface WildTest {
  /** Linear (rate-difference) t statistic on the data. */
  t: number;
  /** Bootstrap p-value: share of replicates with |t*| ≥ |t|. */
  pBoot: number;
  /** Bootstrap critical value of |t| at level α. */
  crit: number;
  resamples: number;
}

/** The WCR test itself (steps 1–4 of the file header). Null when a window has < 2 units or no denominator. */
export function wildTest(r: Prepared, b: Prepared, opts: WildOptions): WildTest | null {
  const B = Math.max(19, Math.floor(opts.resamples ?? WILD_RESAMPLES));
  const twoLevel = opts.twoLevel === true;
  const pseudo = opts.pseudo ?? PSEUDO_COUNT;
  const floorKind = opts.floor ?? "poisson";
  const binomial = floorKind === "binomial";
  const floorOn = floorKind !== "none";
  const alpha = Math.round((1 - opts.level) * 1e12) / 1e12;
  const ur = unitsOf(r, twoLevel), ub = unitsOf(b, twoLevel);
  if (ur.G < 2 || ub.G < 2 || !(ur.D > 0) || !(ub.D > 0)) return null;

  const t = (() => {
    const a = windowVariance(ur, ur.n, binomial, pseudo, floorOn);
    const c = windowVariance(ub, ub.n, binomial, pseudo, floorOn);
    const v = a.v + c.v;
    return v > 0 ? (a.rate - c.rate) / Math.sqrt(v) : 0;
  })();
  // Replicates in closed form. With n*_g = R₀ d_g + v_g ẽ_g: N* = R₀ D + S1, R* = R₀ + δ (δ = S1/D) and
  // Σ_g e*_g² = Σ_g (v_g ẽ_g − δ d_g)² = S2 − 2δ S3 + δ² Σ_g d_g², with S1 = Σ v ẽ, S2 = Σ v² ẽ², S3 = Σ v ẽ d.
  const R0 = (ur.N + ub.N) / (ur.D + ub.D);
  const prep = (u: Units) => {
    const e = Float64Array.from(u.n, (n, g) => n - R0 * u.d[g]!);
    let dd = 0;
    for (let g = 0; g < u.G; g++) dd += u.d[g]! * u.d[g]!;
    return { e, dd, f: u.G / (u.G - 1) };
  };
  const pr = prep(ur), pb = prep(ub);
  const seed = `wild|${B}|${twoLevel}|${pseudo}|${floorKind}|${ur.G}|${ur.N}|${ur.D}|${ub.G}|${ub.N}|${ub.D}`;
  const rng = new Rng(seed);
  // Webb indices: 8 base-6 digits per 32-bit draw (6^8 = 1,679,616 ≪ 2^32, so the digits are uniform to < 0.1%).
  const W = Float64Array.from(WEBB_WEIGHTS);
  let pool = 0, left = 0;
  const abs = new Float64Array(B);
  let exceed = 0;
  const at = Math.abs(t);
  const rates = new Float64Array(2), vars = new Float64Array(2);
  const windows = [{ u: ur, p: pr }, { u: ub, p: pb }] as const;
  for (let i = 0; i < B; i++) {
    for (let w = 0; w < 2; w++) {
      const { u, p } = windows[w]!;
      const e = p.e, d = u.d, G = u.G;
      let s1 = 0, s2 = 0, s3 = 0;
      for (let g = 0; g < G; g++) {
        if (left === 0) {
          pool = Math.floor(rng.next() * 1_679_616);
          left = 8;
        }
        const k = pool % 6;
        pool = (pool - k) / 6;
        left--;
        const ve = W[k]! * e[g]!;
        s1 += ve;
        s2 += ve * ve;
        s3 += ve * d[g]!;
      }
      const delta = s1 / u.D;
      const rate = R0 + delta;
      const ss = s2 - 2 * delta * s3 + delta * delta * p.dd;
      let v = (p.f * (ss > 0 ? ss : 0)) / (u.D * u.D);
      if (floorOn) v = Math.max(v, rateFloor(binomial, rate * u.D, u.D, pseudo));
      rates[w] = rate;
      vars[w] = v;
    }
    const v = vars[0]! + vars[1]!;
    const ts = v > 0 ? Math.abs((rates[0]! - rates[1]!) / Math.sqrt(v)) : 0;
    abs[i] = ts;
    if (ts >= at - 1e-12) exceed++;
  }
  abs.sort();
  const rank = Math.min(B, Math.max(1, Math.ceil((1 - alpha) * (B + 1) - 1e-9)));
  return { t, pBoot: exceed / B, crit: abs[rank - 1]!, resamples: B };
}

/**
 * Drop-in for `bootstrapRatio` (see the file header, step 5). `smallSample` is ignored: the WCR studentizes with
 * CR1 and the reported SE is the CR1 ("count") analytic sandwich.
 */
export function wildRatio(recentClusters: readonly Cluster[], baselineClusters: readonly Cluster[], opts: WildOptions): RatioComparison {
  const B = Math.max(19, Math.floor(opts.resamples ?? WILD_RESAMPLES));
  const base = analyticRatio(recentClusters, baselineClusters, { ...opts, smallSample: "count", resamples: Math.max(B, 2) });
  if (!base.ok) return { ...base, resamples: B };
  const twoLevel = opts.twoLevel === true;
  const test = wildTest(prepare(recentClusters), prepare(baselineClusters), { ...opts, resamples: B });
  if (test === null) return { ...base, ok: false, se: Infinity, df: 0, pValue: 1, reason: `fewer than 2 ${twoLevel ? "sessions" : "clusters"} in a window`, resamples: B };
  const alpha = Math.round((1 - opts.level) * 1e12) / 1e12;
  const df = effectiveDf(test.crit, alpha);
  const point = base.logRatio, se = base.se;
  const tInt = (a: number) => {
    const q = studentTQuantile(1 - a / 2, df);
    return { lo: Math.exp(point - q * se), hi: Math.exp(point + q * se) };
  };
  return {
    ...base,
    df,
    t95: tInt(0.05),
    t99: tInt(0.01),
    pValue: test.pBoot,
    resamples: B,
    seed: `wild:${test.crit.toFixed(6)}`,
  };
}

/** Default B for callers that pass the bootstrap default through. */
export function wildResamples(requested: number | undefined, level = 0.99): number {
  if (requested !== undefined && requested !== DEFAULT_RESAMPLES) return requested;
  // α(B + 1) must be an integer: 399 for α = 0.01 (4 replicates beyond c*), 199 for α = 0.05 (10 beyond).
  return level >= 0.99 ? WILD_RESAMPLES : 199;
}
