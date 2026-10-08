import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHex, hashString, Rng } from "../../src/analysis/stats/rng.js";

function moments(xs: number[]): { mean: number; variance: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { mean, variance };
}

function draws(n: number, f: () => number): number[] {
  return Array.from({ length: n }, f);
}

test("same seed → same stream; different seed → different stream", () => {
  const a = new Rng("seed"), b = new Rng("seed"), c = new Rng("seed2");
  const xa = draws(100, () => a.next()), xb = draws(100, () => b.next()), xc = draws(100, () => c.next());
  assert.deepEqual(xa, xb);
  assert.notDeepEqual(xa, xc);
});

test("stream is pinned (reports must stay reproducible across versions)", () => {
  const r = new Rng("wasitme");
  assert.deepEqual([r.next(), r.next(), r.next()], [0.4749315807130188, 0.1491732627619058, 0.5115109968464822]);
  assert.deepEqual(hashString("wasitme"), [546503966, 859594033, 2228804449, 3488958622]);
  assert.match(hashHex("x"), /^[0-9a-f]{32}$/);
});

test("uniform draws are in range and look uniform", () => {
  const r = new Rng("u");
  const xs = draws(50_000, () => r.next());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const { mean, variance } = moments(xs);
  assert.ok(Math.abs(mean - 0.5) < 0.01);
  assert.ok(Math.abs(variance - 1 / 12) < 0.003);
  const ints = draws(20_000, () => r.int(7));
  assert.ok(ints.every((k) => Number.isInteger(k) && k >= 0 && k < 7));
  for (let k = 0; k < 7; k++) {
    const share = ints.filter((x) => x === k).length / ints.length;
    assert.ok(Math.abs(share - 1 / 7) < 0.015, `bucket ${k}: ${share}`);
  }
});

test("normal has mean 0 and variance 1", () => {
  const r = new Rng("n");
  const { mean, variance } = moments(draws(50_000, () => r.normal()));
  assert.ok(Math.abs(mean) < 0.02);
  assert.ok(Math.abs(variance - 1) < 0.03);
});

test("poisson mean and variance match lambda (small and large lambda)", () => {
  const r = new Rng("p");
  for (const lambda of [0.3, 4, 25, 400]) {
    const xs = draws(30_000, () => r.poisson(lambda));
    assert.ok(xs.every((x) => Number.isInteger(x) && x >= 0));
    const { mean, variance } = moments(xs);
    assert.ok(Math.abs(mean / lambda - 1) < 0.03, `lambda ${lambda} mean ${mean}`);
    assert.ok(Math.abs(variance / lambda - 1) < 0.06, `lambda ${lambda} variance ${variance}`);
  }
  assert.equal(r.poisson(0), 0);
  assert.equal(r.poisson(-1), 0);
  assert.equal(r.poisson(NaN), 0);
});

test("binomial mean and variance match n·p and n·p·(1−p)", () => {
  const r = new Rng("b");
  for (const [n, p] of [[10, 0.3], [500, 0.04], [200, 0.9], [1, 0.5]] as const) {
    const xs = draws(30_000, () => r.binomial(n, p));
    assert.ok(xs.every((x) => Number.isInteger(x) && x >= 0 && x <= n));
    const { mean, variance } = moments(xs);
    assert.ok(Math.abs(mean - n * p) < 0.03 * n * p + 0.01, `n ${n} p ${p} mean ${mean}`);
    assert.ok(Math.abs(variance / (n * p * (1 - p)) - 1) < 0.07, `n ${n} p ${p} variance ${variance}`);
  }
  assert.equal(r.binomial(10, 0), 0);
  assert.equal(r.binomial(10, 1), 10);
  assert.equal(r.binomial(0, 0.5), 0);
});

test("gamma and negative binomial moments", () => {
  const r = new Rng("g");
  for (const shape of [0.5, 1.5, 9]) {
    const { mean, variance } = moments(draws(40_000, () => r.gamma(shape)));
    assert.ok(Math.abs(mean / shape - 1) < 0.03, `shape ${shape} mean ${mean}`);
    assert.ok(Math.abs(variance / shape - 1) < 0.08, `shape ${shape} variance ${variance}`);
  }
  const { mean, variance } = moments(draws(40_000, () => r.negBinomial(10, 2)));
  assert.ok(Math.abs(mean / 10 - 1) < 0.03);
  assert.ok(Math.abs(variance / (10 + 100 / 2) - 1) < 0.08, `variance ${variance}`);
  assert.equal(r.negBinomial(0, 2), 0);
});
