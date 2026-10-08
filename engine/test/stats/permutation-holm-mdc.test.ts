import { test } from "node:test";
import assert from "node:assert/strict";
import { binomialCoefficient, permutationTest } from "../../src/analysis/stats/permutation.js";
import { holmAdjust, holmReject } from "../../src/analysis/stats/holm.js";
import { minimumDetectableChange } from "../../src/analysis/stats/mdc.js";
import type { Cluster } from "../../src/analysis/stats/types.js";

const cl = (id: string, num: number, den: number): Cluster => ({ id, num, den });

test("binomial coefficients", () => {
  assert.equal(binomialCoefficient(6, 3), 20);
  assert.equal(binomialCoefficient(10, 0), 1);
  assert.equal(binomialCoefficient(52, 5), 2598960);
  assert.equal(binomialCoefficient(3, 5), 0);
  assert.equal(binomialCoefficient(2000, 1000), Infinity);
});

test("exact permutation: fully separated 3 vs 3 clusters → p = 2/20", () => {
  const r = [cl("a", 30, 100), cl("b", 32, 100), cl("c", 31, 100)];
  const b = [cl("d", 5, 100), cl("e", 6, 100), cl("f", 4, 100)];
  const out = permutationTest(r, b);
  assert.equal(out.exact, true);
  assert.equal(out.resamples, 20);
  assert.ok(Math.abs(out.pValue - 0.1) < 1e-12);
  assert.ok(out.statistic > 0);
});

test("identical clusters → p = 1", () => {
  const r = [cl("a", 10, 100), cl("b", 10, 100)];
  const b = [cl("c", 10, 100), cl("d", 10, 100), cl("e", 10, 100)];
  assert.equal(permutationTest(r, b).pValue, 1);
});

test("Monte Carlo permutation is deterministic, never returns 0, and finds a strong change", () => {
  const r = Array.from({ length: 25 }, (_, i) => cl(`r${i}`, 30 + (i % 5), 100));
  const b = Array.from({ length: 25 }, (_, i) => cl(`b${i}`, 10 + (i % 5), 100));
  const one = permutationTest(r, b, { resamples: 999 });
  const two = permutationTest([...r].reverse(), b, { resamples: 999 });
  assert.equal(one.exact, false);
  assert.deepEqual(one, two);
  assert.equal(one.pValue, 1 / 1000);
  const none = permutationTest(
    Array.from({ length: 25 }, (_, i) => cl(`r${i}`, 10 + (i % 7), 100)),
    Array.from({ length: 25 }, (_, i) => cl(`b${i}`, 10 + ((i + 3) % 7), 100)),
    { resamples: 999 },
  );
  assert.ok(none.pValue > 0.2, String(none.pValue));
});

test("permutation with an empty window is not ok", () => {
  const out = permutationTest([], [cl("a", 1, 10)]);
  assert.equal(out.ok, false);
  assert.equal(out.pValue, 1);
});

test("Holm adjustment matches a worked example and keeps input order", () => {
  const adj = holmAdjust([0.01, 0.04, 0.03, 0.005]);
  const expected = [0.03, 0.06, 0.06, 0.02];
  adj.forEach((p, i) => assert.ok(Math.abs(p - expected[i]!) < 1e-12, `${i}: ${p}`));
  assert.deepEqual(holmReject([0.01, 0.04, 0.03, 0.005]), [true, false, false, true]);
  assert.deepEqual(holmAdjust([]), []);
  assert.deepEqual(holmAdjust([NaN, 0.5]), [1, 1]);
  assert.deepEqual(holmAdjust([0.04, 0.03]), [0.06, 0.06], "step-down keeps adjusted p monotone");
  assert.deepEqual(holmAdjust([0.9, 0.8]), [1, 1], "capped at 1");
});

test("MDC: (z_{.975} + z_{.80}) · SE with a 10% optimism correction", () => {
  const plain = minimumDetectableChange(0.2, { optimism: 0 });
  assert.ok(Math.abs(plain.zSum - 2.8015852) < 1e-6);
  assert.ok(Math.abs(plain.logDelta - 0.56031704) < 1e-6);
  assert.ok(Math.abs(plain.increase - Math.expm1(0.56031704)) < 1e-6);
  assert.ok(Math.abs(plain.decrease - -Math.expm1(-0.56031704)) < 1e-6);
  const corrected = minimumDetectableChange(0.2);
  assert.ok(Math.abs(corrected.logDelta - 1.1 * plain.logDelta) < 1e-12);
  // Small df → t quantiles → bigger detectable change.
  assert.ok(minimumDetectableChange(0.2, { df: 4 }).increase > corrected.increase);
  assert.ok(Math.abs(minimumDetectableChange(0.2, { zSum: 3, optimism: 0 }).logDelta - 0.6) < 1e-12);
  assert.equal(minimumDetectableChange(Infinity).increase, Infinity);
  assert.equal(minimumDetectableChange(NaN).decrease, 1);
});
