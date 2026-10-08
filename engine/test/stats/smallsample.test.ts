import { test } from "node:test";
import assert from "node:assert/strict";
import { countCorrection, cr2Correction } from "../../src/analysis/stats/smallsample.js";
import { Rng } from "../../src/analysis/stats/rng.js";

/** Brute-force Bell–McCaffrey df: build B = (I − c1ᵀ) A (I − 1cᵀ) explicitly, df = tr(B)² / tr(B²). */
function bruteDf(d: number[]): number {
  const U = d.length;
  const D = d.reduce((a, b) => a + b, 0);
  const c = d.map((x) => x / D);
  const a = c.map((x) => (x * x) / (1 - x));
  const M = (i: number, j: number) => (i === j ? 1 : 0) - c[j]!; // (I − 1cᵀ)[i][j]
  const B: number[][] = [];
  for (let i = 0; i < U; i++) {
    B.push([]);
    for (let j = 0; j < U; j++) {
      let s = 0;
      for (let k = 0; k < U; k++) s += M(k, i) * a[k]! * M(k, j);
      B[i]!.push(s);
    }
  }
  let tr = 0, tr2 = 0;
  for (let i = 0; i < U; i++) {
    tr += B[i]![i]!;
    for (let j = 0; j < U; j++) tr2 += B[i]![j]! * B[j]![i]!;
  }
  return (tr * tr) / tr2;
}

test("count correction", () => {
  assert.deepEqual(countCorrection(5), { factor: 1.25, df: 4 });
  assert.equal(countCorrection(1).factor, Infinity);
});

test("cr2 equals the count correction for equal-size units", () => {
  for (const U of [2, 3, 7, 40]) {
    const c = cr2Correction(Array.from({ length: U }, (_, i) => i % 3), Array.from({ length: U }, () => 50));
    assert.ok(Math.abs(c.factor - U / (U - 1)) < 1e-9, `U=${U} factor ${c.factor}`);
    assert.ok(Math.abs(c.df - (U - 1)) < 1e-9, `U=${U} df ${c.df}`);
  }
});

test("cr2 df matches a brute-force matrix computation for unequal sizes", () => {
  const rng = new Rng("bm");
  for (let rep = 0; rep < 20; rep++) {
    const U = 2 + rng.int(12);
    const d = Array.from({ length: U }, () => 1 + rng.int(300) * (rng.next() < 0.2 ? 10 : 1));
    const n = d.map((x) => rng.poisson(x * 0.1));
    const expected = Math.min(U - 1, Math.max(1, bruteDf(d)));
    const got = cr2Correction(n, d).df;
    assert.ok(Math.abs(got - expected) < 1e-8 * Math.max(1, expected), `U=${U}: ${got} vs ${expected}`);
  }
});

test("cr2 lowers df when one unit dominates, and inflates its residual by 1/(1 − leverage)", () => {
  const even = cr2Correction([10, 12, 9, 11, 10], [100, 100, 100, 100, 100]);
  // The big unit deviates from the others: its residual is shrunk by its own pull on R, so CR2 inflates hard.
  const lop = cr2Correction([100, 3, 2, 4, 1], [800, 25, 25, 25, 25]);
  assert.ok(lop.df < even.df);
  assert.ok(lop.df >= 1);
  assert.ok(lop.factor > 3 * even.factor, String(lop.factor)); // ≈ 4.55 vs 1.25
  // When the big unit sits exactly on the pooled rate, only the small units' (low-leverage) residuals count.
  const onRate = cr2Correction([80, 3, 2, 4, 1], [800, 25, 25, 25, 25]);
  assert.ok(onRate.factor < even.factor && onRate.factor >= 1);
  assert.ok(onRate.df < even.df);
});

test("cr2 edge cases: no residual variation, zero-denominator units, a unit holding everything", () => {
  // Every unit at exactly the pooled rate → design-weighted fallback, still ≥ count factor for unequal sizes.
  const flat = cr2Correction([1, 2, 4], [10, 20, 40]);
  assert.ok(Number.isFinite(flat.factor) && flat.factor >= 1);
  const zeroDen = cr2Correction([1, 2, 3], [0, 50, 50]);
  assert.ok(Number.isFinite(zeroDen.factor));
  assert.equal(cr2Correction([5, 1], [100, 0]).factor, Infinity);
  assert.equal(cr2Correction([5], [100]).factor, Infinity);
  assert.equal(cr2Correction([0, 0], [0, 0]).factor, Infinity);
});
