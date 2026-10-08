/**
 * Holm–Bonferroni step-down adjustment: controls the family-wise error rate across metrics without
 * assuming independence. Adjusted p_(i) = max_{j ≤ i} min(1, (m − j + 1) · p_(j)) in ascending order.
 * Non-finite p-values are treated as 1 (no evidence). Output is in input order.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const clean = pValues.map((p) => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1));
  const order = clean.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const out = new Array<number>(m);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  });
  return out;
}

/** Which hypotheses Holm rejects at family-wise level alpha (input order). */
export function holmReject(pValues: readonly number[], alpha = 0.05): boolean[] {
  return holmAdjust(pValues).map((p) => p <= alpha);
}
