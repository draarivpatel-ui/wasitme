import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clusterCells, dayIndex, dayString, logRate, logRatio, normalizeClusters, rateOf, totals,
} from "../../src/analysis/stats/ratio.js";
import type { Cell } from "../../src/analysis/stats/types.js";

test("totals ignore negative, NaN and non-number counts", () => {
  const t = totals([
    { num: 2, den: 10 },
    { num: -5, den: 3 },
    { num: NaN, den: Infinity },
    { num: "7" as unknown as number, den: 4 },
  ]);
  assert.deepEqual(t, { num: 2, den: 17 });
  assert.equal(rateOf(t), 2 / 17);
  assert.ok(Number.isNaN(rateOf({ num: 3, den: 0 })));
});

test("log rate uses a numerator pseudo-count and survives zero denominators", () => {
  assert.equal(logRate(0, 100), Math.log(0.5 / 100));
  assert.equal(logRate(9, 10, 1), Math.log(1));
  assert.ok(Number.isFinite(logRate(3, 0)));
  assert.equal(logRatio({ num: 10, den: 100 }, { num: 10, den: 100 }), 0);
  assert.ok(Math.abs(logRatio({ num: 199.5, den: 100 }, { num: 99.5, den: 100 }) - Math.log(2)) < 1e-12);
});

test("dayIndex validates calendar days and round-trips", () => {
  assert.equal(dayIndex("1970-01-02"), 1);
  assert.equal(dayString(dayIndex("2026-10-04")!), "2026-10-04");
  assert.equal(dayIndex("2026-02-31"), undefined);
  assert.equal(dayIndex("2026-1-4"), undefined);
  assert.equal(dayIndex("not a day"), undefined);
  assert.equal(dayIndex(undefined as unknown as string), undefined);
});

const cells: Cell[] = [
  { session: "b", day: "2026-10-02", num: 1, den: 5 },
  { session: "a", day: "2026-10-01", num: 2, den: 10 },
  { session: "a", day: "2026-10-02", num: 0, den: 4 },
  { session: "a", day: "2026-10-01", num: 1, den: 1 },
];

test("clusterCells groups by session or session-day, sums duplicates, sorts by id", () => {
  const bySession = clusterCells(cells, "session");
  assert.deepEqual(bySession.map((c) => [c.id, c.num, c.den]), [["a", 3, 15], ["b", 1, 5]]);
  assert.equal(bySession[0]!.parent, undefined);
  const byDay = clusterCells(cells, "session-day");
  assert.equal(byDay.length, 3);
  assert.deepEqual(byDay.map((c) => [c.parent, c.num, c.den]), [["a", 3, 11], ["a", 0, 4], ["b", 1, 5]]);
  // Input order never matters.
  assert.deepEqual(clusterCells([...cells].reverse(), "session-day"), byDay);
});

test("normalizeClusters merges ids, keeps the first parent, drops empty clusters", () => {
  const out = normalizeClusters([
    { id: "x", parent: "p", num: 1, den: 2 },
    { id: "y", num: 0, den: 0 },
    { id: "x", parent: "q", num: 3, den: 4 },
    { id: "w", num: -1, den: 5 },
  ]);
  assert.deepEqual(out, [
    { id: "w", num: 0, den: 5 },
    { id: "x", parent: "p", num: 4, den: 6 },
  ]);
});
