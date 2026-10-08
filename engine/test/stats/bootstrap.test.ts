import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapRatio, quantileSorted } from "../../src/analysis/stats/bootstrap.js";
import { Rng } from "../../src/analysis/stats/rng.js";
import type { Cluster } from "../../src/analysis/stats/types.js";

/** k clusters with Poisson events at `rate` per unit, sizes 20..119. */
function clusters(rng: Rng, k: number, rate: number, prefix: string): Cluster[] {
  return Array.from({ length: k }, (_, i) => {
    const den = 20 + rng.int(100);
    return { id: `${prefix}${i}`, num: rng.poisson(den * rate), den };
  });
}

test("deterministic: same data → identical result, regardless of cluster order", () => {
  const rng = new Rng("det");
  const r = clusters(rng, 12, 0.1, "r"), b = clusters(rng, 20, 0.1, "b");
  const a1 = bootstrapRatio(r, b, { resamples: 500 });
  const a2 = bootstrapRatio([...r].reverse(), [...b.slice(5), ...b.slice(0, 5)], { resamples: 500 });
  assert.deepEqual(a1, a2);
  const a3 = bootstrapRatio(r, b, { resamples: 500, seed: "other" });
  assert.notEqual(a3.seBootstrap, a1.seBootstrap);
  assert.ok(Math.abs(a3.seBootstrap / a1.seBootstrap - 1) < 0.15);
});

test("point estimate is the pseudo-counted log ratio of totals", () => {
  const r: Cluster[] = [{ id: "a", num: 10, den: 100 }, { id: "b", num: 30, den: 100 }];
  const b: Cluster[] = [{ id: "c", num: 5, den: 100 }, { id: "d", num: 15, den: 100 }];
  const out = bootstrapRatio(r, b, { resamples: 200 });
  assert.equal(out.recent.rate, 0.2);
  assert.equal(out.baseline.rate, 0.1);
  assert.ok(Math.abs(out.logRatio - (Math.log(40.5 / 200) - Math.log(20.5 / 200))) < 1e-12);
  assert.ok(Math.abs(out.ratio - Math.exp(out.logRatio)) < 1e-12);
});

test("no change → intervals contain 1; a large change → excluded on the right side", () => {
  const rng = new Rng("sig");
  const same = bootstrapRatio(clusters(rng, 30, 0.1, "r"), clusters(rng, 30, 0.1, "b"), { resamples: 1000 });
  assert.ok(same.ok);
  for (const k of ["t95", "t99", "percentile95", "percentile99"] as const) {
    assert.ok(same[k].lo < 1 && same[k].hi > 1, `${k} ${JSON.stringify(same[k])}`);
  }
  const up = bootstrapRatio(clusters(rng, 30, 0.3, "r"), clusters(rng, 30, 0.1, "b"), { resamples: 1000 });
  assert.ok(up.t95.lo > 1 && up.percentile95.lo > 1);
  assert.ok(up.pValue < 0.001);
  const down = bootstrapRatio(clusters(rng, 30, 0.03, "r"), clusters(rng, 30, 0.1, "b"), { resamples: 1000 });
  assert.ok(down.t95.hi < 1);
});

test("99% intervals contain 95% intervals; t interval is symmetric on the log scale", () => {
  const rng = new Rng("nest");
  const out = bootstrapRatio(clusters(rng, 9, 0.2, "r"), clusters(rng, 14, 0.15, "b"), { resamples: 2000 });
  assert.ok(out.t99.lo <= out.t95.lo && out.t99.hi >= out.t95.hi);
  assert.ok(out.percentile99.lo <= out.percentile95.lo && out.percentile99.hi >= out.percentile95.hi);
  const mid = (Math.log(out.t95.lo) + Math.log(out.t95.hi)) / 2;
  assert.ok(Math.abs(mid - out.logRatio) < 1e-9);
});

test("bootstrap SE agrees with the delta-method SE on many iid clusters", () => {
  const rng = new Rng("se");
  const r = clusters(rng, 300, 0.1, "r"), b = clusters(rng, 300, 0.1, "b");
  const out = bootstrapRatio(r, b, { resamples: 2000, floor: "none", smallSample: "count" });
  const deltaVar = (cs: Cluster[]) => {
    const N = cs.reduce((a, c) => a + c.num, 0), D = cs.reduce((a, c) => a + c.den, 0);
    return cs.reduce((a, c) => a + (c.num / N - c.den / D) ** 2, 0);
  };
  const analytic = Math.sqrt(deltaVar(r) + deltaVar(b));
  assert.ok(Math.abs(out.seBootstrap / analytic - 1) < 0.08, `${out.seBootstrap} vs ${analytic}`);
  // With 300 units the small-sample corrections are negligible.
  assert.ok(Math.abs(out.se / out.seBootstrap - 1) < 0.05);
  assert.ok(out.df > 200);
});

test("too few units, or no denominator, gives an uninformative interval instead of a false call", () => {
  const one = bootstrapRatio([{ id: "a", num: 50, den: 100 }], [{ id: "b", num: 5, den: 100 }, { id: "c", num: 6, den: 100 }]);
  assert.equal(one.ok, false);
  assert.match(one.reason!, /fewer than 2/);
  assert.deepEqual(one.t95, { lo: 0, hi: Infinity });
  assert.equal(one.pValue, 1);
  const noDen = bootstrapRatio([{ id: "a", num: 3, den: 0 }, { id: "b", num: 1, den: 0 }], [{ id: "c", num: 1, den: 5 }, { id: "d", num: 1, den: 5 }]);
  assert.equal(noDen.ok, false);
  assert.equal(bootstrapRatio([], []).ok, false);
});

test("zero events in both windows never produces a 'change' (variance floor)", () => {
  // Without a floor the bootstrap sees no noise and log(0.5/200) vs log(0.5/1000) looks like a 5x jump.
  const r = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, num: 0, den: 30 + i * 3 }));
  const b = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, num: 0, den: 90 + i * 4 }));
  for (const floor of ["poisson", "binomial"] as const) {
    const out = bootstrapRatio(r, b, { resamples: 500, floor });
    assert.ok(out.t95.lo < 1 && out.t95.hi > 1, `${floor}: ${JSON.stringify(out.t95)}`);
  }
  const unfloored = bootstrapRatio(r, b, { resamples: 500, floor: "none" });
  assert.ok(unfloored.t95.lo > 1, "documents why the floor exists");
});

test("cr2 reduces to the K/(K−1) correction for equal-size clusters, and widens for unequal ones", () => {
  const eq = (prefix: string, rate: number): Cluster[] =>
    Array.from({ length: 8 }, (_, i) => ({ id: `${prefix}${i}`, num: Math.round(100 * rate * (1 + 0.3 * Math.sin(i))), den: 100 }));
  const a = bootstrapRatio(eq("r", 0.2), eq("b", 0.2), { resamples: 800, smallSample: "count", floor: "none" });
  const c = bootstrapRatio(eq("r", 0.2), eq("b", 0.2), { resamples: 800, smallSample: "cr2", floor: "none" });
  assert.ok(Math.abs(a.se - c.se) < 1e-12 && Math.abs(a.df - c.df) < 1e-9);

  const rng = new Rng("uneq");
  const skewed = (prefix: string): Cluster[] =>
    Array.from({ length: 8 }, (_, i) => {
      const den = i === 0 ? 2000 : 40 + rng.int(40);
      return { id: `${prefix}${i}`, num: rng.poisson(den * 0.2 * Math.exp(0.5 * rng.normal())), den };
    });
  const r = skewed("r"), b = skewed("b");
  const cnt = bootstrapRatio(r, b, { resamples: 800, smallSample: "count" });
  const cr2 = bootstrapRatio(r, b, { resamples: 800, smallSample: "cr2" });
  assert.equal(cnt.seed, cr2.seed);
  assert.equal(cnt.seBootstrap, cr2.seBootstrap, "same replicates, different post-processing");
  assert.ok(cr2.df < cnt.df);
  assert.ok(cr2.t95.hi / cr2.t95.lo > cnt.t95.hi / cnt.t95.lo);
});

test("two-level with one day per session equals the single-level bootstrap", () => {
  const rng = new Rng("tl");
  const r = clusters(rng, 10, 0.1, "r").map((c) => ({ ...c, parent: c.id }));
  const b = clusters(rng, 15, 0.1, "b").map((c) => ({ ...c, parent: c.id }));
  const single = bootstrapRatio(r, b, { resamples: 400, seed: "s" });
  const two = bootstrapRatio(r, b, { resamples: 400, seed: "s", twoLevel: true });
  assert.equal(two.seBootstrap, single.seBootstrap);
  assert.equal(two.recent.units, 10);
});

test("two-level keeps between-session variance that flat session-day resampling loses", () => {
  // 6 sessions per window, 8 days each; days of one session share a strong session effect.
  const rng = new Rng("corr");
  const make = (prefix: string): Cluster[] => {
    const out: Cluster[] = [];
    for (let s = 0; s < 6; s++) {
      const effect = Math.exp(0.8 * rng.normal());
      for (let d = 0; d < 8; d++) out.push({ id: `${prefix}${s}|${d}`, parent: `${prefix}${s}`, num: rng.poisson(30 * 0.1 * effect), den: 30 });
    }
    return out;
  };
  const r = make("r"), b = make("b");
  const flat = bootstrapRatio(r, b, { resamples: 1500, seed: "x" });
  const two = bootstrapRatio(r, b, { resamples: 1500, seed: "x", twoLevel: true });
  assert.equal(flat.recent.units, 48);
  assert.equal(two.recent.units, 6);
  assert.ok(two.seBootstrap > 1.5 * flat.seBootstrap, `${two.seBootstrap} vs ${flat.seBootstrap}`);
  assert.ok(two.df < flat.df);
});

test("a single session holding the whole denominator is reported, not estimated", () => {
  const r: Cluster[] = [{ id: "a", num: 10, den: 100 }, { id: "b", num: 3, den: 0 }];
  const b: Cluster[] = [{ id: "c", num: 10, den: 100 }, { id: "d", num: 12, den: 90 }];
  const out = bootstrapRatio(r, b, { resamples: 200 });
  assert.equal(out.ok, false);
  assert.match(out.reason!, /one session/);
});

test("type-7 quantiles", () => {
  const s = [1, 2, 3, 4, 5];
  assert.equal(quantileSorted(s, 0), 1);
  assert.equal(quantileSorted(s, 1), 5);
  assert.equal(quantileSorted(s, 0.5), 3);
  assert.equal(quantileSorted(s, 0.1), 1.4);
  assert.ok(Number.isNaN(quantileSorted([], 0.5)));
});

test("performance: 2000 resamples × 6 metrics × 200 clusters per window ≤ 500 ms", () => {
  const rng = new Rng("perf");
  const metrics = Array.from({ length: 6 }, (_, m) => ({
    r: clusters(rng, 200, 0.05 * (m + 1), `r${m}-`).map((c, i) => ({ ...c, parent: `p${i % 40}` })),
    b: clusters(rng, 200, 0.05 * (m + 1), `b${m}-`).map((c, i) => ({ ...c, parent: `q${i % 40}` })),
  }));
  for (const twoLevel of [false, true]) {
    const t0 = performance.now();
    for (const { r, b } of metrics) bootstrapRatio(r, b, { resamples: 2000, twoLevel });
    const ms = performance.now() - t0;
    assert.ok(ms <= 500, `${twoLevel ? "two-level" : "single-level"} took ${ms.toFixed(0)} ms`);
  }
});

/** Log-scale width of an interval. */
const logWidth = (iv: { lo: number; hi: number }) => Math.log(iv.hi / iv.lo);

test("a session-day with events but no denominator is folded into its session, not resampled alone", () => {
  // e.g. an interrupt on day 2 of a session whose only prompt was on day 1.
  const rest: Cluster[] = [
    { id: "s2|d1", parent: "s2", num: 2, den: 25 }, { id: "s2|d2", parent: "s2", num: 4, den: 30 },
    { id: "s3|d1", parent: "s3", num: 1, den: 15 }, { id: "s4|d3", parent: "s4", num: 5, den: 40 },
  ];
  const baseline: Cluster[] = [
    { id: "t1|d1", parent: "t1", num: 3, den: 30 }, { id: "t2|d1", parent: "t2", num: 2, den: 25 },
    { id: "t3|d2", parent: "t3", num: 4, den: 35 }, { id: "t4|d2", parent: "t4", num: 2, den: 20 },
  ];
  // Zero-denominator days after (d2) and before (d0) the session's only day with prompts.
  const withZero: Cluster[] = [
    { id: "s1|d0", parent: "s1", num: 1, den: 0 }, { id: "s1|d1", parent: "s1", num: 3, den: 20 },
    { id: "s1|d2", parent: "s1", num: 2, den: 0 }, ...rest,
  ];
  const moved: Cluster[] = [{ id: "s1|d1", parent: "s1", num: 6, den: 20 }, ...rest];
  const without: Cluster[] = [{ id: "s1|d1", parent: "s1", num: 3, den: 20 }, ...rest];
  for (const twoLevel of [false, true]) {
    const opts = { resamples: 1000, seed: "zero-den", twoLevel };
    const z = bootstrapRatio(withZero, baseline, opts);
    // Identical to attributing the events to the session's day with prompts.
    assert.deepEqual(z, bootstrapRatio(moved, baseline, opts));
    assert.equal(z.recent.num, 18);
    assert.equal(z.recent.clusters, 5);
    const w = bootstrapRatio(without, baseline, opts);
    assert.ok(z.ok && Number.isFinite(z.t95.hi) && z.t95.lo > 0);
    // Comparable to the data without those events. (Percentile intervals legitimately widen more: the
    // extra events make s1 the most extreme session; the t interval is what verdicts use.)
    const ratio = logWidth(z.t95) / logWidth(w.t95);
    assert.ok(ratio > 0.5 && ratio < 2, `${twoLevel}: t95 width ratio ${ratio}`);
  }
});

test("clusters with events but no denominator and no sibling never produce runaway replicates", () => {
  const baseline: Cluster[] = [{ id: "x", num: 10, den: 100 }, { id: "y", num: 13, den: 100 }, { id: "z", num: 11, den: 100 }];
  const recent: Cluster[] = [{ id: "a", num: 5, den: 0 }, { id: "b", num: 10, den: 100 }, { id: "c", num: 12, den: 100 }];
  const out = bootstrapRatio(recent, baseline, { seed: "orphan" });
  // The orphan's events still count in the window rate.
  assert.equal(out.recent.num, 27);
  assert.equal(out.recent.rate, 0.135);
  assert.equal(out.recent.clusters, 3);
  assert.ok(out.ok);
  // Before the fix: seBootstrap ≈ 1, t95 ≈ (3e-6, 1.5e6), percentile99 up to ≈ 300 (all-orphan replicates
  // computed log((n + 0.5) / 0.5)). Now every replicate has a real denominator.
  assert.ok(out.seBootstrap < 0.5, `seBootstrap ${out.seBootstrap}`);
  assert.ok(out.percentile99.hi < 5, `percentile99 ${JSON.stringify(out.percentile99)}`);
  assert.ok(out.t95.lo > 0.05 && out.t95.hi < 20, `t95 ${JSON.stringify(out.t95)}`);
  const without = bootstrapRatio(recent.slice(1), baseline, { seed: "orphan" });
  const ratio = logWidth(out.t95) / logWidth(without.t95);
  assert.ok(ratio > 0.5 && ratio < 2, `width ratio ${ratio}`);

  // Two-level: a session whose every day lacks a denominator behaves the same way.
  const nested: Cluster[] = [
    { id: "a|1", parent: "a", num: 3, den: 0 }, { id: "a|2", parent: "a", num: 2, den: 0 },
    { id: "b|1", parent: "b", num: 6, den: 60 }, { id: "b|2", parent: "b", num: 4, den: 40 },
    { id: "c|1", parent: "c", num: 12, den: 100 },
  ];
  const two = bootstrapRatio(nested, baseline, { seed: "orphan", twoLevel: true });
  assert.ok(two.ok && two.seBootstrap < 0.5 && two.percentile99.hi < 5, JSON.stringify(two));
  assert.equal(two.recent.clusters, 5);
});
