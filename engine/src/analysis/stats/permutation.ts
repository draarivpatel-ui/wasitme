/**
 * Cluster permutation test of "same rate in both windows".
 *
 * Under the null, cluster labels (recent vs baseline) are exchangeable: pool all clusters, reassign
 * KR of them to "recent" at random, recompute the log ratio. Two-sided p-value = share of
 * relabellings at least as extreme as the observed one. Exact enumeration when the number of
 * relabellings is small, Monte Carlo otherwise (p = (1 + hits) / (1 + B), never 0).
 *
 * Valid only when clusters are independent — use session clusters, not session-days, whenever days
 * within a session are correlated. Gives a p-value, not an interval.
 */
import { Rng } from "./rng.js";
import { dataSeed, DEFAULT_RESAMPLES } from "./bootstrap.js";
import { logRate, normalizeClusters, PSEUDO_COUNT } from "./ratio.js";
import type { Cluster } from "./types.js";

export interface PermutationOptions {
  /** Monte Carlo relabellings (default 2000). */
  resamples?: number;
  seed?: string;
  pseudo?: number;
  /** Enumerate exactly when the number of relabellings is at most this (default = resamples). */
  exactLimit?: number;
}

export interface PermutationResult {
  /** Observed log ratio (recent vs baseline, pseudo-counted). */
  statistic: number;
  pValue: number;
  /** True when every relabelling was enumerated. */
  exact: boolean;
  /** Relabellings evaluated. */
  resamples: number;
  ok: boolean;
  reason?: string;
  seed: string;
}

/** n choose k as a float, saturating at Infinity. */
export function binomialCoefficient(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let c = 1;
  for (let i = 1; i <= k; i++) {
    c = (c * (n - k + i)) / i;
    if (!Number.isFinite(c)) return Infinity;
  }
  return Math.round(c);
}

export function permutationTest(
  recentClusters: readonly Cluster[],
  baselineClusters: readonly Cluster[],
  opts: PermutationOptions = {},
): PermutationResult {
  const B = Math.max(1, Math.floor(opts.resamples ?? DEFAULT_RESAMPLES));
  const pseudo = opts.pseudo ?? PSEUDO_COUNT;
  const exactLimit = opts.exactLimit ?? B;
  const seed = opts.seed ?? dataSeed(recentClusters, baselineClusters, `perm|${B}|${pseudo}`);
  const R = normalizeClusters(recentClusters);
  const Bc = normalizeClusters(baselineClusters);
  const KR = R.length, KB = Bc.length, K = KR + KB;
  const pool = [...R, ...Bc];
  const num = Float64Array.from(pool, (c) => c.num);
  const den = Float64Array.from(pool, (c) => c.den);
  let N = 0, D = 0;
  for (let i = 0; i < K; i++) {
    N += num[i]!;
    D += den[i]!;
  }
  let nR = 0, dR = 0;
  for (let i = 0; i < KR; i++) {
    nR += num[i]!;
    dR += den[i]!;
  }
  const stat = (n: number, d: number) => logRate(n, d, pseudo) - logRate(N - n, D - d, pseudo);
  const observed = stat(nR, dR);
  const base = { statistic: observed, seed };
  if (KR < 1 || KB < 1 || !(dR > 0) || !(D - dR > 0)) {
    return { ...base, pValue: 1, exact: false, resamples: 0, ok: false, reason: "a window has no data" };
  }
  const thr = Math.abs(observed) - 1e-9 * Math.max(1, Math.abs(observed));

  const combos = binomialCoefficient(K, KR);
  if (combos <= exactLimit) {
    let hits = 0, total = 0;
    const idx = new Int32Array(KR);
    for (let i = 0; i < KR; i++) idx[i] = i;
    for (;;) {
      let n = 0, d = 0;
      for (let i = 0; i < KR; i++) {
        n += num[idx[i]!]!;
        d += den[idx[i]!]!;
      }
      total++;
      if (Math.abs(stat(n, d)) >= thr) hits++;
      // Next combination in lexicographic order.
      let i = KR - 1;
      while (i >= 0 && idx[i] === K - KR + i) i--;
      if (i < 0) break;
      idx[i] = idx[i]! + 1;
      for (let j = i + 1; j < KR; j++) idx[j] = idx[j - 1]! + 1;
    }
    return { ...base, pValue: hits / total, exact: true, resamples: total, ok: true };
  }

  const rng = new Rng(seed);
  const order = new Int32Array(K);
  for (let i = 0; i < K; i++) order[i] = i;
  // Draw the smaller side for speed; the statistic only needs one side's totals.
  const take = Math.min(KR, KB);
  const takingRecent = take === KR;
  let hits = 0;
  for (let it = 0; it < B; it++) {
    let n = 0, d = 0;
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(rng.next() * (K - i));
      const t = order[i]!;
      order[i] = order[j]!;
      order[j] = t;
      n += num[order[i]!]!;
      d += den[order[i]!]!;
    }
    const s = takingRecent ? stat(n, d) : stat(N - n, D - d);
    if (Math.abs(s) >= thr) hits++;
  }
  return { ...base, pValue: (1 + hits) / (1 + B), exact: false, resamples: B, ok: true };
}
