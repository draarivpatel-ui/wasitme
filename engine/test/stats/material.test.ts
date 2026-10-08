import { test } from "node:test";
import assert from "node:assert/strict";
import { agreement, classifyChange, orient } from "../../src/analysis/stats/material.js";

test("material increase: interval above 1, ≥20% move, above the absolute floor", () => {
  const c = classifyChange({ ratio: 1.5, lo: 1.2, hi: 1.9, recentRate: 0.15, baselineRate: 0.1 }, { absoluteFloor: 0.01 });
  assert.equal(c.material, true);
  assert.equal(c.direction, "up");
  assert.equal(c.significant, true);
  assert.ok(Math.abs(c.relativeChange - 0.5) < 1e-12);
  assert.ok(Math.abs(c.absoluteChange! - 0.05) < 1e-12);
  assert.deepEqual(c.reasons, []);
});

test("material decrease", () => {
  const c = classifyChange({ ratio: 0.6, lo: 0.45, hi: 0.8 });
  assert.equal(c.material, true);
  assert.equal(c.direction, "down");
});

test("not material: interval includes 1, too small, or below the absolute floor", () => {
  assert.deepEqual(classifyChange({ ratio: 1.4, lo: 0.9, hi: 2.1 }).reasons, ["interval-includes-1"]);
  const small = classifyChange({ ratio: 1.1, lo: 1.02, hi: 1.2 });
  assert.equal(small.significant, true);
  assert.deepEqual(small.reasons, ["below-relative-threshold"]);
  // −15% does not reach the 20% bar; −20% does.
  assert.equal(classifyChange({ ratio: 0.85, lo: 0.7, hi: 0.95 }).material, false);
  assert.equal(classifyChange({ ratio: 0.8, lo: 0.7, hi: 0.95 }).material, true);
  const tinyRate = classifyChange({ ratio: 2, lo: 1.5, hi: 3, recentRate: 0.002, baselineRate: 0.001 }, { absoluteFloor: 0.005 });
  assert.deepEqual(tinyRate.reasons, ["below-absolute-floor"]);
  // Floor requested but rates unknown → cannot clear it.
  assert.deepEqual(classifyChange({ ratio: 2, lo: 1.5, hi: 3 }, { absoluteFloor: 0.005 }).reasons, ["below-absolute-floor"]);
  assert.equal(classifyChange({ ratio: 1.3, lo: 1.1, hi: 1.5 }, { minRelativeChange: 0.5 }).material, false);
});

test("missing data is never material", () => {
  const c = classifyChange({ ratio: NaN, lo: NaN, hi: NaN });
  assert.equal(c.material, false);
  assert.deepEqual(c.reasons, ["no-data"]);
  assert.equal(classifyChange({ ratio: 3, lo: 0, hi: Infinity }).material, false);
  assert.equal(classifyChange({ ratio: 1, lo: 0.9, hi: 1.1 }).direction, null);
});

test("orient flips direction for higher-is-better metrics", () => {
  assert.equal(orient("up", true), "down");
  assert.equal(orient("down", true), "up");
  assert.equal(orient("up", false), "up");
  assert.equal(orient(null, true), null);
});

test("agreement: changed needs ≥k material the same way and none opposite", () => {
  const m = (metric: string, direction: "up" | "down" | null, material: boolean) => ({ metric, direction, material });
  assert.deepEqual(agreement([m("a", "up", true), m("b", "up", true), m("c", "down", false)]), {
    verdict: "changed", direction: "up", up: ["a", "b"], down: [],
  });
  assert.equal(agreement([m("a", "down", true), m("b", "down", true), m("c", "down", true)]).direction, "down");
  assert.equal(agreement([m("a", "up", true), m("b", "up", true), m("c", "down", true)]).verdict, "mixed");
  assert.equal(agreement([m("a", "up", true), m("b", "up", false)]).verdict, "none");
  assert.equal(agreement([m("a", "up", true)], 1).verdict, "changed");
  assert.equal(agreement([m("a", "up", true)], 0).verdict, "changed", "k is at least 1");
  assert.equal(agreement([]).verdict, "none");
});
