import { test } from "node:test";
import assert from "node:assert/strict";
import {
  incompleteBeta, logGamma, normalCdf, normalQuantile, studentTCdf, studentTQuantile, twoSidedP,
} from "../../src/analysis/stats/distributions.js";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

test("normal quantile and CDF match reference values", () => {
  close(normalQuantile(0.975), 1.959963984540054, 1e-12);
  close(normalQuantile(0.995), 2.5758293035489, 1e-10);
  close(normalQuantile(0.8), 0.8416212335729143, 1e-12);
  close(normalQuantile(1e-10), -6.361340902404056, 1e-8);
  assert.equal(normalQuantile(0.5), 0);
  assert.equal(normalQuantile(0), -Infinity);
  assert.equal(normalQuantile(1), Infinity);
  assert.ok(Number.isNaN(normalQuantile(1.5)));
  close(normalCdf(1.959963984540054), 0.975, 1e-12);
  close(normalCdf(-1), 0.15865525393145707, 1e-12);
  assert.equal(normalCdf(0), 0.5);
  assert.equal(normalCdf(-40), 0);
  assert.equal(normalCdf(40), 1);
  for (const p of [0.001, 0.02, 0.3, 0.6, 0.99]) close(normalCdf(normalQuantile(p)), p, 1e-12, `p=${p}`);
});

test("log-gamma and incomplete beta", () => {
  close(logGamma(5), Math.log(24), 1e-12);
  close(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12);
  close(logGamma(100), 359.13420536957540, 1e-9);
  close(incompleteBeta(0.3, 1, 1), 0.3, 1e-12);
  close(incompleteBeta(0.5, 4.5, 4.5), 0.5, 1e-12);
  close(incompleteBeta(0.2, 2, 3), 0.1808, 1e-12);
  assert.equal(incompleteBeta(0, 2, 3), 0);
  assert.equal(incompleteBeta(1, 2, 3), 1);
});

test("Student-t quantiles match reference tables", () => {
  const table: [number, number, number][] = [
    [0.975, 1, 12.706204736174698], [0.975, 2, 4.302652729749464], [0.975, 3, 3.182446305284263],
    [0.975, 5, 2.570581835636314], [0.975, 10, 2.228138851986274], [0.975, 30, 2.042272456301238],
    [0.975, 120, 1.979930405082423], [0.995, 3, 5.840909309733350], [0.995, 10, 3.169272672616966],
    [0.8, 4, 0.940964577713], [0.9995, 1, 636.6192487687196],
  ];
  for (const [p, df, q] of table) close(studentTQuantile(p, df), q, 1e-6 * Math.max(1, q), `t(${p}, ${df})`);
  close(studentTQuantile(0.975, 1e9), 1.959963984540054, 1e-9);
  close(studentTQuantile(0.025, 7), -studentTQuantile(0.975, 7), 1e-12);
  assert.equal(studentTQuantile(0.5, 3.3), 0);
});

test("fractional df (Welch) interpolate monotonically and round-trip through the CDF", () => {
  let prev = Infinity;
  for (let df = 1; df <= 40; df += 0.37) {
    const q = studentTQuantile(0.975, df);
    assert.ok(q < prev, `quantile must fall as df grows (df=${df})`);
    prev = q;
    close(studentTCdf(q, df), 0.975, 1e-9, `df=${df}`);
  }
  close(studentTCdf(0, 4.2), 0.5, 1e-15);
  close(studentTCdf(-2, 6) + studentTCdf(2, 6), 1, 1e-12);
});

test("two-sided p-values", () => {
  close(twoSidedP(2.228138851986274, 10), 0.05, 1e-9);
  close(twoSidedP(-2.228138851986274, 10), 0.05, 1e-9);
  close(twoSidedP(1.959963984540054, 1e9), 0.05, 1e-9);
  close(twoSidedP(0, 5), 1, 1e-12);
  // No 1 − CDF cancellation in the far tail.
  const tiny = twoSidedP(40, 30);
  assert.ok(tiny > 0 && tiny < 1e-25, String(tiny));
  assert.equal(twoSidedP(Infinity, 3), 0);
  assert.ok(Number.isNaN(twoSidedP(NaN, 3)));
});
