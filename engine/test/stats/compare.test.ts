import { test } from "node:test";
import assert from "node:assert/strict";
import { compareMetric, RECOMMENDED_METHOD, rollup, type MetricComparison } from "../../src/analysis/stats/compare.js";
import { MANY_SHORT_SESSIONS, simulateWindows, STEPS_PER_PROMPT, TOOL_ERROR_RATE } from "../../src/analysis/stats/calibrate.js";
import { Rng } from "../../src/analysis/stats/rng.js";
import type { Cell } from "../../src/analysis/stats/types.js";

const sim = (seed: string, mult: number, metric = STEPS_PER_PROMPT) => simulateWindows(MANY_SHORT_SESSIONS, metric, mult, new Rng(seed));

test("recommended method is session clusters + t95 with the CR2 correction", () => {
  assert.deepEqual({ ...RECOMMENDED_METHOD }, { clusters: "session", twoLevel: false, interval: "t95", smallSample: "cr2" });
});

test("a tripled rate is a material increase; the result carries gate, interval and MDC", () => {
  const w = sim("cmp-up", 3);
  const r = compareMetric(w.recent, w.baseline, { resamples: 500 });
  assert.equal(r.status, "material-change");
  assert.equal(r.call!.direction, "up");
  assert.equal(r.gate.pass, true);
  assert.ok(r.comparison!.ok && r.comparison!.t95.lo > 1);
  assert.ok(r.mdc!.increase > 0 && r.mdc!.increase < 1);
  assert.equal(r.method.smallSample, "cr2");
});

test("no change → no material change", () => {
  const w = sim("cmp-none", 1);
  const r = compareMetric(w.recent, w.baseline, { resamples: 500 });
  assert.equal(r.status, "no-material-change");
  assert.equal(r.call!.material, false);
});

test("too little data → insufficient-data with gate progress; force still computes", () => {
  const recent: Cell[] = [{ session: "a", day: "2026-10-01", num: 1, den: 10 }, { session: "b", day: "2026-10-02", num: 0, den: 8 }];
  const baseline: Cell[] = [{ session: "c", day: "2026-09-20", num: 2, den: 12 }, { session: "d", day: "2026-09-21", num: 1, den: 9 }];
  const r = compareMetric(recent, baseline);
  assert.equal(r.status, "insufficient-data");
  assert.equal(r.comparison, undefined);
  assert.equal(r.call, null);
  assert.ok(r.gate.progress < 1 && r.gate.blocking.length > 0);
  const forced = compareMetric(recent, baseline, { force: true, resamples: 200 });
  assert.equal(forced.status, "insufficient-data");
  assert.ok(forced.comparison);
});

test("method overrides: two-level implies session-day clusters", () => {
  const w = sim("cmp-two", 1);
  const r = compareMetric(w.recent, w.baseline, { resamples: 300, method: { twoLevel: true, clusters: "session" } });
  assert.equal(r.method.clusters, "session-day");
  assert.equal(r.comparison!.twoLevel, true);
  const p = compareMetric(w.recent, w.baseline, { resamples: 300, method: { interval: "percentile99" } });
  assert.ok(p.comparison && p.call);
});

test("rollup: agreement across metrics, orientation, Holm and insufficient metrics", () => {
  const up = (seed: string, metric = STEPS_PER_PROMPT) => {
    const w = sim(seed, 3, metric);
    return compareMetric(w.recent, w.baseline, { resamples: 400, floor: metric.kind === "proportion" ? "binomial" : "poisson" });
  };
  const a = up("r1"), b = up("r2", TOOL_ERROR_RATE);
  const thin = compareMetric([], []);
  const roll = rollup([{ metric: "steps", result: a }, { metric: "errors", result: b }, { metric: "thin", result: thin }]);
  assert.equal(roll.verdict, "changed");
  assert.equal(roll.direction, "up");
  assert.deepEqual(roll.insufficient, ["thin"]);
  assert.deepEqual(Object.keys(roll.adjustedP).sort(), ["errors", "steps"]);
  // "Cache hit rate" going up is good: oriented, the same two moves now disagree.
  const mixed = rollup([{ metric: "steps", result: a }, { metric: "cache", result: b, higherIsBetter: true }]);
  assert.equal(mixed.verdict, "mixed");
  assert.equal(mixed.oriented, true);

  // Holm: a material call with p just under 0.05 does not survive adjustment across 3 metrics.
  const fake = (p: number): MetricComparison => ({
    ...a,
    comparison: { ...a.comparison!, pValue: p },
    call: { ...a.call!, material: true, direction: "up" },
    status: "material-change",
  });
  const fam = [{ metric: "x", result: fake(0.001) }, { metric: "y", result: fake(0.04) }, { metric: "z", result: fake(0.9) }];
  assert.equal(rollup(fam).verdict, "changed");
  const holm = rollup(fam, { familywise: "holm" });
  assert.equal(holm.verdict, "none");
  assert.deepEqual(holm.up, ["x"]);
});
