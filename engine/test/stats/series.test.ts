import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SERIES_POINTS, rollingSeries } from "../../src/analysis/stats/series.js";
import { dayIndex, dayString } from "../../src/analysis/stats/ratio.js";
import { Rng } from "../../src/analysis/stats/rng.js";
import type { Cell } from "../../src/analysis/stats/types.js";

test("rolling ratio of totals over calendar days, gaps filled, input order irrelevant", () => {
  const cells: Cell[] = [
    { session: "a", day: "2026-09-01", num: 1, den: 10 },
    { session: "b", day: "2026-09-01", num: 1, den: 10 },
    { session: "a", day: "2026-09-04", num: 4, den: 20 },
  ];
  const s = rollingSeries(cells, { window: 3 });
  assert.deepEqual(s.map((p) => p.day), ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  assert.deepEqual(s.map((p) => [p.num, p.den, p.clusters, p.activeDays]), [[2, 20, 2, 1], [2, 20, 2, 1], [2, 20, 2, 1], [4, 20, 1, 1]]);
  assert.equal(s[0]!.rate, 0.1);
  assert.equal(s[3]!.rate, 0.2);
  // One cluster → no between-cluster information → uninformative band.
  assert.deepEqual([s[3]!.lo, s[3]!.hi], [0, Infinity]);
  // A clock that jumped backward just reorders cells: same answer.
  assert.deepEqual(rollingSeries([...cells].reverse(), { window: 3 }), s);
});

test("bands contain the rate, shrink with more data, and `enough` follows the thresholds", () => {
  const rng = new Rng("series");
  const cells: Cell[] = [];
  for (let d = 1; d <= 28; d++) {
    const day = `2026-09-${String(d).padStart(2, "0")}`;
    const sessions = d <= 14 ? 1 : 6;
    for (let s = 0; s < sessions; s++) {
      const den = 20 + rng.int(20);
      cells.push({ session: `s${d}-${s}`, day, num: rng.binomial(den, 0.1), den });
    }
  }
  const pts = rollingSeries(cells, { window: 7, minEvents: 5, minClusters: 3 });
  assert.equal(pts.length, 28);
  for (const p of pts) {
    assert.ok(p.lo <= p.rate && p.rate <= p.hi, JSON.stringify(p));
    assert.equal(p.enough, p.num >= 5 && p.clusters >= 3 && p.den >= 1);
  }
  const early = pts[13]!, late = pts[27]!;
  assert.ok(late.hi / late.lo < early.hi / early.lo);
  assert.equal(late.enough, true);
});

test("bands use the CR2 correction by default: a dominant, deviating session widens the band", () => {
  const cells: Cell[] = [
    { session: "big", day: "2026-09-01", num: 60, den: 400 },
    { session: "a", day: "2026-09-01", num: 3, den: 30 },
    { session: "b", day: "2026-09-02", num: 2, den: 30 },
    { session: "c", day: "2026-09-02", num: 4, den: 30 },
  ];
  const [cr2] = rollingSeries(cells, { from: "2026-09-02", to: "2026-09-02" });
  const [count] = rollingSeries(cells, { from: "2026-09-02", to: "2026-09-02", smallSample: "count" });
  assert.equal(cr2!.clusters, 4);
  assert.equal(cr2!.rate, count!.rate);
  assert.ok(cr2!.hi / cr2!.lo > count!.hi / count!.lo, `${cr2!.hi / cr2!.lo} vs ${count!.hi / count!.lo}`);
});

test("zero events use the exact Poisson upper limit", () => {
  const cells: Cell[] = [
    { session: "a", day: "2026-09-01", num: 0, den: 100 },
    { session: "b", day: "2026-09-01", num: 0, den: 100 },
  ];
  const [p] = rollingSeries(cells);
  assert.equal(p!.rate, 0);
  assert.equal(p!.lo, 0);
  assert.ok(Math.abs(p!.hi - -Math.log(0.025) / 200) < 1e-12);
  assert.equal(p!.enough, false);
});

test("from/to, invalid days and empty input", () => {
  const cells: Cell[] = [
    { session: "a", day: "2026-09-05", num: 1, den: 10 },
    { session: "a", day: "not-a-day", num: 100, den: 100 },
  ];
  const s = rollingSeries(cells, { from: "2026-09-04", to: "2026-09-06", window: 1 });
  assert.deepEqual(s.map((p) => [p.day, p.num, p.den]), [["2026-09-04", 0, 0], ["2026-09-05", 1, 10], ["2026-09-06", 0, 0]]);
  assert.ok(Number.isNaN(s[0]!.rate) && Number.isNaN(s[0]!.lo));
  assert.deepEqual(rollingSeries([]), []);
  assert.deepEqual(rollingSeries(cells, { from: "2026-09-06", to: "2026-09-04" }), []);
});

/** Four sessions a day over `days` consecutive days starting at `start` (synthetic). */
function month(start: string, days: number): Cell[] {
  const s0 = dayIndex(start)!;
  const cells: Cell[] = [];
  for (let i = 0; i < days; i++) {
    for (let k = 0; k < 4; k++) cells.push({ session: `m${i}-${k}`, day: dayString(s0 + i), num: 1 + ((i + k) % 3), den: 10 });
  }
  return cells;
}

test("a stray far-past day (clock reset to the epoch) never crowds out the recent points", () => {
  const recent = month("2026-09-01", 20);
  const stray: Cell = { session: "x", day: "1970-01-01", num: 1, den: 10 };
  const s = rollingSeries([stray, ...recent]);
  assert.equal(s.length, MAX_SERIES_POINTS);
  assert.equal(s[s.length - 1]!.day, "2026-09-20");
  // The recent points are exactly what the series gives without the stray day.
  const clean = rollingSeries(recent);
  assert.equal(clean.length, 20);
  assert.deepEqual(s.slice(-20), clean);
  // Explicit bounds are the robust way to call it, stray or not.
  assert.deepEqual(rollingSeries([stray, ...recent], { from: "2026-09-01", to: "2026-09-20" }), clean);
});

test("a stray far-future day is ignored when the caller passes explicit `to` (as the verdict layer must)", () => {
  const recent = month("2026-09-05", 30);
  const stray: Cell = { session: "y", day: "2099-12-31", num: 50, den: 50 };
  const s = rollingSeries([...recent, stray], { from: "2026-09-05", to: "2026-10-04" });
  assert.equal(s.length, 30);
  const today = s[s.length - 1]!;
  assert.equal(today.day, "2026-10-04");
  assert.equal(today.clusters, 28);
  assert.equal(today.enough, true);
  // Without explicit bounds the cap is anchored on the (future) last day: the newest MAX_SERIES_POINTS
  // days ending in 2099 — which is why callers must pass `to`.
  const loose = rollingSeries([...recent, stray]);
  assert.equal(loose.length, MAX_SERIES_POINTS);
  assert.equal(loose[loose.length - 1]!.day, "2099-12-31");
});

test("window must be finite and ≥ 1; a huge window costs no more than one spanning the data", () => {
  const cells = month("2026-09-01", 30);
  for (const bad of [NaN, Infinity, -Infinity, 0, 0.5, -3]) {
    assert.throws(() => rollingSeries(cells, { window: bad }), RangeError, String(bad));
  }
  // Fractional windows are floored.
  assert.deepEqual(rollingSeries(cells, { window: 3.9 }), rollingSeries(cells, { window: 3 }));
  const t0 = performance.now();
  const huge = rollingSeries(cells, { window: 1e7 });
  const ms = performance.now() - t0;
  assert.deepEqual(huge, rollingSeries(cells, { window: 30 }));
  assert.ok(ms < 250, `window 1e7 took ${ms} ms`);
  // Even across a 20,000-day range (stray epoch-zero day), a huge window stays fast and correct.
  const stray: Cell = { session: "x", day: "1970-01-01", num: 1, den: 10 };
  const t1 = performance.now();
  const wide = rollingSeries([stray, ...cells], { window: 1e7 });
  const ms2 = performance.now() - t1;
  assert.equal(wide.length, MAX_SERIES_POINTS);
  // The window reaches back to 1970, so the last point includes the stray day's event.
  assert.equal(wide[wide.length - 1]!.num, huge[huge.length - 1]!.num + 1);
  assert.ok(ms2 < 2000, `wide range took ${ms2} ms`);
});
