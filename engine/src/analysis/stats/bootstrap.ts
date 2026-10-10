/**
 * Stratified cluster bootstrap of log(rate_recent / rate_baseline).
 *
 * Each window is resampled independently (clusters with replacement). Two flavours:
 *  - single-level: draw K clusters from the window's K clusters;
 *  - two-level: draw P parents (sessions) with replacement, then for each drawn parent draw its c
 *    children (session-days) with replacement from that parent's c children. This keeps the
 *    between-session variability that a flat session-day bootstrap loses when days within a session
 *    are correlated (they share the session's random effect), while still using within-session
 *    day-to-day variability.
 *
 * Intervals returned:
 *  - percentile 95/99: quantiles of the bootstrap distribution (known to be too narrow with few clusters);
 *  - t 95/99: logRatio ± t(df)·se. Each window's bootstrap variance of its log-rate is multiplied by a
 *    small-sample factor computed over its top-level units U (parents when two-level, clusters
 *    otherwise) — "count": U/(U−1) with df U−1; "cr2": Bell–McCaffrey leverage correction and df (see
 *    smallsample.ts) — then floored at the Poisson/binomial variance of the window's event count (the
 *    bootstrap cannot see sampling noise inside clusters with zero events). The two windows' df are
 *    combined Welch–Satterthwaite style.
 *
 * Zero-denominator clusters (events but no exposure — e.g. an interrupt on day 2 of a session whose
 * prompt was on day 1, under session-day clusters): their events still count in the window's totals.
 * A cluster that has a `parent` is merged into a sibling with a denominator (the nearest one before it
 * in id order, else the nearest after), so it is not resampled as an independent unit. Clusters left
 * with no denominator (no such sibling, or no parent) stay; a bootstrap replicate that draws only
 * those has an undefined ratio and is redrawn (the bootstrap is conditional on a positive
 * denominator), so it can never become a huge log((n + c)/c) outlier.
 */
import { hashHex, Rng } from "./rng.js";
import { studentTQuantile, twoSidedP } from "./distributions.js";
import { logRate, normalizeClusters, PSEUDO_COUNT, rateOf, totals } from "./ratio.js";
import { countCorrection, cr2Correction, type Correction, type SmallSampleCorrection } from "./smallsample.js";
import type { Cluster, Interval, RatioComparison, WindowTotals } from "./types.js";

export const DEFAULT_RESAMPLES = 2000;

/** Variance floor for each window's log-rate. "poisson" suits counts, "binomial" suits proportions (num ≤ den). */
export type VarianceFloor = "poisson" | "binomial" | "none";

export interface BootstrapOptions {
  /** Bootstrap resamples (default 2000). */
  resamples?: number;
  /** Seed string; default is derived from the data, so identical input → identical output. */
  seed?: string;
  /** Resample parents then children (clusters must carry `parent`; missing parent = own parent). */
  twoLevel?: boolean;
  /** Numerator pseudo-count for logs (default 0.5). */
  pseudo?: number;
  /** Variance floor (default "poisson"). */
  floor?: VarianceFloor;
  /** Small-sample correction for the t intervals (default "cr2"). */
  smallSample?: SmallSampleCorrection;
}

export const DEFAULT_SMALL_SAMPLE: SmallSampleCorrection = "cr2";

/** A window prepared for fast resampling: clusters grouped by parent, counts in typed arrays. */
export interface Prepared {
  num: Float64Array;
  den: Float64Array;
  /** Parent p owns children [start[p], start[p] + size[p]). */
  start: Int32Array;
  size: Int32Array;
  parents: number;
  clusters: number;
  totNum: number;
  totDen: number;
  /** Per-parent totals (parent = the cluster itself when it has none). */
  parentNum: Float64Array;
  parentDen: Float64Array;
}

/**
 * Within each parent's children (sorted by id), fold every zero-denominator child into the nearest
 * sibling before it that has a denominator, else the nearest after. Totals are unchanged. Children of
 * a parent with no denominator at all are left as they are.
 */
function mergeZeroDenominators(children: Cluster[]): Cluster[] {
  if (children.every((c) => c.den > 0) || !children.some((c) => c.den > 0)) return children;
  const kept: Cluster[] = [];
  let leading = 0; // events of zero-denominator children before the first child with a denominator
  for (const c of children) {
    if (c.den > 0) kept.push({ ...c });
    else if (kept.length > 0) kept[kept.length - 1]!.num += c.num;
    else leading += c.num;
  }
  kept[0]!.num += leading;
  return kept;
}

export function prepare(raw: readonly Cluster[]): Prepared {
  const normalized = normalizeClusters(raw);
  const groups = new Map<string, Cluster[]>();
  for (const c of normalized) {
    const p = c.parent ?? c.id;
    const g = groups.get(p);
    if (g) g.push(c);
    else groups.set(p, [c]);
  }
  const keys = [...groups.keys()].sort();
  for (const k of keys) groups.set(k, mergeZeroDenominators(groups.get(k)!));
  const clusters = keys.flatMap((k) => groups.get(k)!);
  const K = clusters.length;
  const num = new Float64Array(K), den = new Float64Array(K);
  const start = new Int32Array(keys.length), size = new Int32Array(keys.length);
  const parentNum = new Float64Array(keys.length), parentDen = new Float64Array(keys.length);
  let i = 0;
  keys.forEach((k, p) => {
    const g = groups.get(k)!;
    start[p] = i;
    size[p] = g.length;
    for (const c of g) {
      num[i] = c.num;
      den[i] = c.den;
      parentNum[p] = parentNum[p]! + c.num;
      parentDen[p] = parentDen[p]! + c.den;
      i++;
    }
  });
  const t = totals(normalized); // merging never changes totals; sum in the canonical (id) order
  return { num, den, start, size, parents: keys.length, clusters: K, totNum: t.num, totDen: t.den, parentNum, parentDen };
}

export function correctionFor(w: Prepared, twoLevel: boolean, kind: SmallSampleCorrection): Correction {
  const units = twoLevel ? w.parents : w.clusters;
  if (kind === "count") return countCorrection(units);
  return twoLevel ? cr2Correction(w.parentNum, w.parentDen) : cr2Correction(w.num, w.den);
}

export function windowTotals(w: Prepared, twoLevel: boolean): WindowTotals {
  return {
    num: w.totNum,
    den: w.totDen,
    rate: rateOf({ num: w.totNum, den: w.totDen }),
    clusters: w.clusters,
    units: twoLevel ? w.parents : w.clusters,
  };
}

/**
 * Redraws allowed for a replicate whose denominator came out 0. Only clusters with no denominator can
 * cause that, and at least one unit has a denominator (checked before resampling), so each draw is
 * all-zero with probability ≤ ((U−1)/U)^U < 1/e: 64 failures in a row (< e^−64) never happen in
 * practice. The pooled window rate is the fallback anyway, so the result stays finite.
 */
const MAX_REDRAWS = 64;

/** Fill `out` with bootstrap log-rates of one window (replicates conditional on a positive denominator). */
function resampleWindow(w: Prepared, twoLevel: boolean, rng: Rng, out: Float64Array, pseudo: number): void {
  const { num, den } = w;
  const B = out.length;
  const pooled = logRate(w.totNum, w.totDen, pseudo);
  if (!twoLevel || w.parents === w.clusters) {
    const K = w.clusters;
    for (let it = 0; it < B; it++) {
      let n = 0, d = 0, tries = 0;
      do {
        n = 0;
        d = 0;
        for (let j = 0; j < K; j++) {
          const x = Math.floor(rng.next() * K);
          n += num[x]!;
          d += den[x]!;
        }
      } while (d === 0 && ++tries < MAX_REDRAWS);
      out[it] = d > 0 ? Math.log((n + pseudo) / d) : pooled;
    }
    return;
  }
  const { start, size } = w;
  const P = w.parents;
  for (let it = 0; it < B; it++) {
    let n = 0, d = 0, tries = 0;
    do {
      n = 0;
      d = 0;
      for (let i = 0; i < P; i++) {
        const p = Math.floor(rng.next() * P);
        const s = start[p]!, c = size[p]!;
        if (c === 1) {
          n += num[s]!;
          d += den[s]!;
          continue;
        }
        for (let j = 0; j < c; j++) {
          const x = s + Math.floor(rng.next() * c);
          n += num[x]!;
          d += den[x]!;
        }
      }
    } while (d === 0 && ++tries < MAX_REDRAWS);
    out[it] = d > 0 ? Math.log((n + pseudo) / d) : pooled;
  }
}

function variance(a: Float64Array): number {
  const n = a.length;
  if (n < 2) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += a[i]!;
  m /= n;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i]! - m;
    s += d * d;
  }
  return s / (n - 1);
}

/** Type-7 (linear interpolation) quantile of a sorted array. */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/**
 * Variance floor of a window's log rate (METHOD.md §6): Poisson 1/(num + pseudo); binomial (1 − r)/(num + pseudo).
 * The binomial share of non-events never drops below pseudo/(den + pseudo): at r = 1 (every unit at 100%) the
 * bootstrap sees no noise, just as with zero events, so the same pseudo-count keeps the floor open. For integer counts
 * that bound only binds when num = den.
 */
export function floorVariance(kind: VarianceFloor, num: number, den: number, pseudo: number): number {
  if (kind === "none") return 0;
  const base = 1 / (num + pseudo);
  if (kind === "poisson") return base;
  return binomialShare(num, den, pseudo) * base;
}

/** 1 − r for the binomial floor, never below pseudo/(den + pseudo) (see `floorVariance`); 1 with no denominator. */
export function binomialShare(num: number, den: number, pseudo: number): number {
  if (!(den > 0)) return 1;
  return Math.max(1 - Math.min(1, num / den), pseudo / (den + pseudo));
}

const UNINFORMATIVE: Interval = { lo: 0, hi: Infinity };

/** Deterministic default seed: a digest of the method settings and every cluster (sorted). */
export function dataSeed(recent: readonly Cluster[], baseline: readonly Cluster[], tag: string): string {
  const enc = (cs: readonly Cluster[]) =>
    normalizeClusters(cs).map((c) => `${c.id}\u001e${c.parent ?? ""}\u001e${c.num}\u001e${c.den}`).join("\u001d");
  return "d:" + hashHex(`${tag}\u001c${enc(recent)}\u001c${enc(baseline)}`);
}

/**
 * Cluster bootstrap comparison of two windows. Pure and deterministic for a given seed.
 * Clusters are abstract: the caller decides whether a cluster is a session or a session-day.
 */
export function bootstrapRatio(
  recentClusters: readonly Cluster[],
  baselineClusters: readonly Cluster[],
  opts: BootstrapOptions = {},
): RatioComparison {
  const B = Math.max(2, Math.floor(opts.resamples ?? DEFAULT_RESAMPLES));
  const twoLevel = opts.twoLevel === true;
  const pseudo = opts.pseudo ?? PSEUDO_COUNT;
  const floorKind = opts.floor ?? "poisson";
  const smallSample = opts.smallSample ?? DEFAULT_SMALL_SAMPLE;
  const seed = opts.seed ?? dataSeed(recentClusters, baselineClusters, `boot|${B}|${twoLevel}|${pseudo}`);

  const R = prepare(recentClusters);
  const Bw = prepare(baselineClusters);
  const recent = windowTotals(R, twoLevel);
  const baseline = windowTotals(Bw, twoLevel);
  const point = logRate(R.totNum, R.totDen, pseudo) - logRate(Bw.totNum, Bw.totDen, pseudo);

  const base = {
    recent,
    baseline,
    logRatio: point,
    ratio: Math.exp(point),
    resamples: B,
    twoLevel,
    smallSample,
    seed,
  };
  const fail = (reason: string): RatioComparison => ({
    ...base,
    seBootstrap: NaN,
    se: Infinity,
    df: 0,
    percentile95: UNINFORMATIVE,
    percentile99: UNINFORMATIVE,
    t95: UNINFORMATIVE,
    t99: UNINFORMATIVE,
    pValue: 1,
    ok: false,
    reason,
  });

  if (!(R.totDen > 0) || !(Bw.totDen > 0)) return fail("a window has no denominator");
  if (recent.units < 2 || baseline.units < 2) {
    return fail(`fewer than 2 ${twoLevel ? "sessions" : "clusters"} in a window`);
  }

  const rng = new Rng(seed);
  const lr = new Float64Array(B), lb = new Float64Array(B);
  resampleWindow(R, twoLevel, rng, lr, pseudo);
  resampleWindow(Bw, twoLevel, rng, lb, pseudo);
  const diff = new Float64Array(B);
  for (let i = 0; i < B; i++) diff[i] = lr[i]! - lb[i]!;
  const seBootstrap = Math.sqrt(variance(diff));

  const cR = correctionFor(R, twoLevel, smallSample);
  const cB = correctionFor(Bw, twoLevel, smallSample);
  if (!Number.isFinite(cR.factor) || !Number.isFinite(cB.factor)) {
    return { ...fail("one session holds essentially all of a window's data"), seBootstrap };
  }
  const vR = Math.max(variance(lr) * cR.factor, floorVariance(floorKind, R.totNum, R.totDen, pseudo));
  const vB = Math.max(variance(lb) * cB.factor, floorVariance(floorKind, Bw.totNum, Bw.totDen, pseudo));
  const v = vR + vB;
  if (!(v > 0)) return { ...fail("no variability in either window"), seBootstrap };
  const se = Math.sqrt(v);
  const df = (v * v) / ((vR * vR) / cR.df + (vB * vB) / cB.df);

  diff.sort();
  const pct = (a: number): Interval => ({
    lo: Math.exp(quantileSorted(diff, a / 2)),
    hi: Math.exp(quantileSorted(diff, 1 - a / 2)),
  });
  const tInt = (a: number): Interval => {
    const q = studentTQuantile(1 - a / 2, df);
    return { lo: Math.exp(point - q * se), hi: Math.exp(point + q * se) };
  };
  return {
    ...base,
    seBootstrap,
    se,
    df,
    percentile95: pct(0.05),
    percentile99: pct(0.01),
    t95: tInt(0.05),
    t99: tInt(0.01),
    pValue: twoSidedP(point / se, df),
    ok: true,
  };
}
