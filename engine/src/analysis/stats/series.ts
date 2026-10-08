/**
 * Per-point series with noise bands: for each calendar day, the ratio of totals over a rolling window
 * of the preceding `window` days (inclusive), with a cluster-robust band and an `enough` flag.
 *
 * Bands are analytic (no bootstrap, so a year of points is instant): delta-method variance of the
 * log ratio-of-totals with clusters as independent units, with the same small-sample correction as
 * comparisons (CR2 factor and Bell–McCaffrey df by default; "count" = K/(K−1) and t(K−1)), floored
 * at the Poisson/binomial variance of the event count. A window with zero
 * events gets the exact Poisson upper limit −ln(α/2)/den (clustering is invisible with no events).
 *
 * Days are calendar strings: input order is irrelevant and a clock that jumped backward simply
 * places cells on earlier days — nothing here assumes time moves forward.
 *
 * Range: the series runs from `from` to `to` (defaults: the first / last day with data), capped at the
 * newest MAX_SERIES_POINTS days ending at `to`, so a stray far-past day (e.g. 1970-01-01 after a clock
 * reset) cannot crowd out recent points. A stray far-FUTURE day still moves the default `to`, so the
 * verdict layer should always pass explicit `from`/`to` derived from its window bounds.
 *
 * Cost per point is (days with data inside the window) × clusters, independent of `window` itself.
 */
import { DEFAULT_SMALL_SAMPLE, type VarianceFloor } from "./bootstrap.js";
import { studentTQuantile } from "./distributions.js";
import { dayIndex, dayString, nonNeg, PSEUDO_COUNT } from "./ratio.js";
import { countCorrection, cr2Correction } from "./smallsample.js";
import type { Cell, ClusterScheme, SmallSampleCorrection } from "./types.js";

export interface SeriesOptions {
  /** Rolling window length in days, including the point's own day (default 7; finite, ≥ 1, floored). */
  window?: number;
  /** Band coverage (default 0.95). */
  level?: number;
  /** Independent units for the band (default "session"). */
  scheme?: ClusterScheme;
  /** `enough` requires at least this many events in the window (default 5). */
  minEvents?: number;
  /** …and at least this denominator (default 1). */
  minDenominator?: number;
  /** …and at least this many clusters (default 3). */
  minClusters?: number;
  /**
   * First / last point (default: first / last day with data). Pass both explicitly from the analysis
   * window: a stray far-future day would otherwise become the default `to`.
   */
  from?: string;
  to?: string;
  pseudo?: number;
  floor?: VarianceFloor;
  /** Small-sample correction for the band (default "cr2", as for comparisons). */
  smallSample?: SmallSampleCorrection;
}

export interface SeriesPoint {
  day: string;
  /** Ratio of totals over the window; NaN when the window has no denominator. */
  rate: number;
  /** Band bounds; NaN with no denominator, (0, ∞) with fewer than 2 clusters. */
  lo: number;
  hi: number;
  num: number;
  den: number;
  clusters: number;
  /** Days inside the window that have any data. */
  activeDays: number;
  enough: boolean;
}

/**
 * Hard cap on points (≈ 55 years of days), so a stray far-past day cannot make a runaway series. When
 * the range is longer, the newest points (ending at `to`) are kept.
 */
export const MAX_SERIES_POINTS = 20_000;

export function rollingSeries(cells: readonly Cell[], opts: SeriesOptions = {}): SeriesPoint[] {
  const rawWindow = opts.window ?? 7;
  if (typeof rawWindow !== "number" || !Number.isFinite(rawWindow) || rawWindow < 1) {
    throw new RangeError(`window must be a finite number ≥ 1 (got ${String(rawWindow)})`);
  }
  const W = Math.floor(rawWindow);
  const level = opts.level ?? 0.95;
  const alpha = 1 - level;
  const scheme = opts.scheme ?? "session";
  const minEvents = opts.minEvents ?? 5;
  const minDen = opts.minDenominator ?? 1;
  const minClusters = opts.minClusters ?? 3;
  const pseudo = opts.pseudo ?? PSEUDO_COUNT;
  const floorKind = opts.floor ?? "poisson";
  const smallSample = opts.smallSample ?? DEFAULT_SMALL_SAMPLE;

  // day index → cluster key → totals
  const byDay = new Map<number, Map<string, { n: number; d: number }>>();
  let first = Infinity, last = -Infinity;
  for (const c of cells) {
    const di = dayIndex(c.day);
    if (di === undefined) continue;
    const n = nonNeg(c.num), d = nonNeg(c.den);
    if (n === 0 && d === 0) continue;
    const key = scheme === "session" ? String(c.session) : String(c.session) + "\u001f" + c.day;
    let m = byDay.get(di);
    if (!m) byDay.set(di, (m = new Map()));
    const t = m.get(key);
    if (t) {
      t.n += n;
      t.d += d;
    } else m.set(key, { n, d });
    if (di < first) first = di;
    if (di > last) last = di;
  }
  const from = opts.from !== undefined ? dayIndex(opts.from) : first;
  const to = opts.to !== undefined ? dayIndex(opts.to) : last;
  if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  // Keep the newest points: anchor the cap on `to`, never on `from`.
  const start = Math.max(from, to - MAX_SERIES_POINTS + 1);

  // Sliding window over the days that have data (ascending), so the work per point never depends on W.
  const active = [...byDay.keys()].sort((a, b) => a - b);
  let lo = 0, hi = 0; // window = active[lo .. hi)

  const out: SeriesPoint[] = [];
  for (let t = start; t <= to; t++) {
    while (hi < active.length && active[hi]! <= t) hi++;
    while (lo < hi && active[lo]! < t - W + 1) lo++;
    const acc = new Map<string, { n: number; d: number }>();
    const activeDays = hi - lo;
    for (let i = lo; i < hi; i++) {
      const m = byDay.get(active[i]!)!;
      for (const [k, v] of m) {
        const a = acc.get(k);
        if (a) {
          a.n += v.n;
          a.d += v.d;
        } else acc.set(k, { n: v.n, d: v.d });
      }
    }
    let N = 0, D = 0;
    for (const v of acc.values()) {
      N += v.n;
      D += v.d;
    }
    const K = acc.size;
    const point: SeriesPoint = {
      day: dayString(t),
      rate: D > 0 ? N / D : NaN,
      lo: NaN,
      hi: NaN,
      num: N,
      den: D,
      clusters: K,
      activeDays,
      enough: N >= minEvents && D >= minDen && D > 0 && K >= minClusters,
    };
    if (D > 0) {
      if (K < 2) {
        point.lo = 0;
        point.hi = Infinity;
      } else if (N === 0) {
        point.lo = 0;
        point.hi = -Math.log(alpha / 2) / D;
      } else {
        const ns = new Float64Array(K), ds = new Float64Array(K);
        let s = 0, k = 0;
        for (const v of acc.values()) {
          const u = v.n / N - v.d / D;
          s += u * u;
          ns[k] = v.n;
          ds[k++] = v.d;
        }
        const corr = smallSample === "cr2" ? cr2Correction(ns, ds) : countCorrection(K);
        if (!Number.isFinite(corr.factor)) {
          point.lo = 0;
          point.hi = Infinity;
        } else {
          const L = Math.log((N + pseudo) / D);
          const floor = floorKind === "none" ? 0 : floorKind === "poisson" ? 1 / (N + pseudo) : (1 - Math.min(1, N / D)) / (N + pseudo);
          const se = Math.sqrt(Math.max(s * corr.factor, floor));
          const q = studentTQuantile(1 - alpha / 2, corr.df);
          point.lo = Math.min(point.rate, Math.exp(L - q * se));
          point.hi = Math.max(point.rate, Math.exp(L + q * se));
        }
      }
    }
    out.push(point);
  }
  return out;
}
