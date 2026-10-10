import { test } from "node:test";
import assert from "node:assert/strict";
import { countWindow, D23_GATE, D23_LITERAL, D29_CANDIDATES, evaluateD23Gate, type WindowCounts } from "../../src/analysis/gates/d23.js";
import { d23Call, statusOf } from "../../src/analysis/gates/evaluate.js";
import { metricDef } from "../../src/analysis/metrics/defs.js";
import { logRate } from "../../src/analysis/stats/ratio.js";
import type { Cell } from "../../src/analysis/stats/types.js";

test("D23 constants are the decided numbers (not the stats branch defaults)", () => {
  assert.deepEqual({ ...D23_GATE }, { minEventsPerWindow: 10, minSessionDays: 10, minSessions: 5, maxSessionShareBelow: 0.5 });
  assert.deepEqual({ ...D23_LITERAL }, { id: "d23-literal", clusters: "session-day", twoLevel: false, level: 0.99, smallSample: "count", keepLargerSe: true });
  assert.deepEqual(Object.keys(D29_CANDIDATES), ["d23-literal", "session-day-t99-cr2", "session-t95-cr2", "two-level-t95-cr2"]);
});

test("countWindow counts sessions and session-days only where the metric has a denominator", () => {
  const cells: Cell[] = [
    { session: "a", day: "2026-09-01", num: 3, den: 0 }, // reads but no edits: events count, no session-day
    { session: "a", day: "2026-09-02", num: 2, den: 4 },
    { session: "b", day: "2026-09-02", num: 1, den: 6 },
    { session: "b", day: "2026-09-02", num: 0, den: 2 }, // same session-day twice: counted once
    { session: "c", day: "2026-09-03", num: 5, den: 0 },
  ];
  assert.deepEqual(countWindow(cells), { events: 11, denominator: 12, sessions: 2, sessionDays: 2, maxSessionShare: 8 / 12, topSessionDays: 1 });
  assert.deepEqual(countWindow([]), { events: 0, denominator: 0, sessions: 0, sessionDays: 0, maxSessionShare: 0, topSessionDays: 0 });
  // The largest session's session-days; equal totals break the tie by the smaller session key, in any order.
  const two: Cell[] = [
    { session: "z", day: "2026-09-01", num: 0, den: 5 },
    { session: "z", day: "2026-09-02", num: 0, den: 5 },
    { session: "y", day: "2026-09-01", num: 0, den: 10 },
  ];
  assert.equal(countWindow(two).topSessionDays, 1);
  assert.equal(countWindow([...two].reverse()).topSessionDays, 1);
});

const ok: WindowCounts = { events: 10, denominator: 100, sessions: 5, sessionDays: 10, maxSessionShare: 0.49, topSessionDays: 2 };

test("gate boundaries: 10 events, 10 session-days, 5 sessions pass; 9 / 9 / 4 fail", () => {
  assert.equal(evaluateD23Gate(ok, ok, 0).pass, true);
  const fail = (w: Partial<WindowCounts>) => evaluateD23Gate({ ...ok, ...w }, ok, 0);
  assert.deepEqual(fail({ events: 9 }).blocking.map((c) => [c.id, c.window, c.have, c.need, c.short]), [["events", "recent", 9, 10, 1]]);
  assert.deepEqual(fail({ sessionDays: 9 }).blocking.map((c) => [c.id, c.short]), [["sessionDays", 1]]);
  assert.deepEqual(fail({ sessions: 4 }).blocking.map((c) => [c.id, c.short]), [["sessions", 1]]);
  // The baseline is gated on its own too (per window, not pooled).
  const b = evaluateD23Gate(ok, { ...ok, events: 3, sessions: 2 }, 0);
  assert.deepEqual(b.blocking.map((c) => `${c.id}:${c.window}:${c.short}`), ["sessions:baseline:3", "events:baseline:7"]);
});

test("largest session must be strictly under 50%: exactly 0.5 fails", () => {
  assert.equal(evaluateD23Gate({ ...ok, maxSessionShare: 0.4999 }, ok, 0).pass, true);
  const g = evaluateD23Gate({ ...ok, maxSessionShare: 0.5 }, ok, 0);
  assert.equal(g.pass, false);
  const share = g.blocking[0]!;
  assert.equal(share.id, "sessionShare");
  // top = 50 of 100: others must add more than 0 → 1 unit of denominator.
  assert.equal(share.short, 1);
  // top = 70 of 100: others must add x with 70/(100+x) < 0.5 → x > 40 → 41.
  assert.equal(evaluateD23Gate({ ...ok, maxSessionShare: 0.7 }, ok, 0).blocking[0]!.short, 41);
  // No denominator at all never passes the share criterion.
  assert.equal(evaluateD23Gate({ ...ok, denominator: 0, maxSessionShare: 0 }, ok, 0).pass, false);
});

test("shortfalls are also given in sessions and session-days (METHOD.md §13)", () => {
  const units = (w: Partial<WindowCounts>, minDen = 0) =>
    evaluateD23Gate({ ...ok, ...w }, ok, minDen).blocking.map((c) => [c.id, c.short, c.shortSessions, c.shortSessionDays]);
  // Sessions: each missing session is at least one session-day too. Session-days can come from known sessions.
  assert.deepEqual(units({ sessions: 4 }), [["sessions", 1, 1, 1]]);
  assert.deepEqual(units({ sessionDays: 9 }), [["sessionDays", 1, null, 1]]);
  // Events: 1 more event at 9 events / 5 sessions → 1 session; at 9 / 10 session-days → 2 session-days.
  assert.deepEqual(units({ events: 9 }), [["events", 1, 1, 2]]);
  // Denominator (reads per edit's 40 edits): 1 more edit at 39 / 5 sessions, 39 / 10 session-days.
  assert.deepEqual(units({ denominator: 39 }, 40), [["denominator", 1, 1, 1]]);
  // Share: top 70 of 100 → others must add 41 calls. The other sessions average 30 / 4 = 7.5 calls per session
  // → 6 sessions, and 30 / (10 − 2) = 3.75 per session-day → 11 session-days.
  assert.deepEqual(units({ maxSessionShare: 0.7 }), [["sessionShare", 41, 6, 11]]);
  // Exactly half: one more call → one session, one session-day.
  assert.deepEqual(units({ maxSessionShare: 0.5 }), [["sessionShare", 1, 1, 1]]);
  // One session holding everything: there are no other sessions to average over → not estimable.
  assert.deepEqual(units({ sessions: 1, sessionDays: 10, maxSessionShare: 1, topSessionDays: 10 }).at(-1), ["sessionShare", 101, null, null]);
  // Passing checks carry zeros.
  for (const c of evaluateD23Gate(ok, ok, 0).checks) assert.deepEqual([c.short, c.shortSessions, c.shortSessionDays], [0, 0, 0]);
});

test("reads per edit: 40 edits pass, 39 fail (per window)", () => {
  const minDen = metricDef("readsPerEdit").minDenominator;
  assert.equal(minDen, 40);
  assert.equal(evaluateD23Gate({ ...ok, denominator: 40 }, { ...ok, denominator: 40 }, minDen).pass, true);
  const g = evaluateD23Gate(ok, { ...ok, denominator: 39 }, minDen);
  assert.deepEqual(g.blocking.map((c) => [c.id, c.window, c.short]), [["denominator", "baseline", 1]]);
});

test("blocking order is fixed: sessions, session-days, events, denominator, share; recent first", () => {
  const bad: WindowCounts = { events: 0, denominator: 10, sessions: 1, sessionDays: 1, maxSessionShare: 1, topSessionDays: 1 };
  const g = evaluateD23Gate(bad, bad, 40);
  assert.deepEqual(g.blocking.map((c) => `${c.id}:${c.window}`), [
    "sessions:recent", "sessions:baseline", "sessionDays:recent", "sessionDays:baseline",
    "events:recent", "events:baseline", "denominator:recent", "denominator:baseline",
    "sessionShare:recent", "sessionShare:baseline",
  ]);
});

test("materiality (D23): range excludes 1×, ≥25% move, ≥1 pt absolute — hand cases", () => {
  const te = metricDef("toolErrors"), rpe = metricDef("readsPerEdit");
  // ×1.24 with the range above 1: below the 25% relative threshold.
  let c = d23Call(te, { ratio: 1.24, lo: 1.05, hi: 1.46, recentRate: 0.124, baselineRate: 0.1 });
  assert.equal(c.material, false);
  assert.deepEqual(c.reasons, ["below-relative-threshold"]);
  // ×1.4 but only 0.4 points (1.0% → 1.4%): below the 1-point floor.
  c = d23Call(te, { ratio: 1.4, lo: 1.1, hi: 1.8, recentRate: 0.014, baselineRate: 0.01 });
  assert.deepEqual([c.material, c.reasons], [false, ["below-absolute-floor"]]);
  // ×1.4, 5% → 7%: material, up = worse for tool errors.
  c = d23Call(te, { ratio: 1.4, lo: 1.1, hi: 1.8, recentRate: 0.07, baselineRate: 0.05 });
  assert.deepEqual([c.material, c.direction, statusOf(te, c)], [true, "up", "worse"]);
  // Exactly ×1.25 and ×0.75 are material (as a reader sees them: +25%, −25%).
  assert.equal(d23Call(te, { ratio: 1.25, lo: 1.01, hi: 1.6, recentRate: 0.1, baselineRate: 0.08 }).material, true);
  assert.equal(d23Call(te, { ratio: 0.75, lo: 0.6, hi: 0.95, recentRate: 0.06, baselineRate: 0.08 }).material, true);
  assert.equal(d23Call(te, { ratio: 1.24, lo: 1.01, hi: 1.6, recentRate: 0.1, baselineRate: 0.08 }).material, false);
  assert.equal(d23Call(te, { ratio: 0.76, lo: 0.6, hi: 0.95, recentRate: 0.06, baselineRate: 0.08 }).material, false);
  // The same boundaries reached through computed log rates, as measureShift produces them: (11.5/20)/(11.5/25) is
  // exactly ×1.25 but exp(logRate − logRate) comes out 1.2499999999999998; (5.5/16)/(5.5/12) is exactly ×0.75 but
  // computes as 0.7500000000000001. Both are still a 25% move.
  const up = Math.exp(logRate(11, 20) - logRate(11, 25)), down = Math.exp(logRate(5, 16) - logRate(5, 12));
  assert.ok(up < 1.25 && down > 0.75, "the fixture must sit one ULP on the wrong side of the boundary");
  assert.deepEqual(d23Call(te, { ratio: up, lo: 1.01, hi: 1.6, recentRate: 0.55, baselineRate: 0.44 }).reasons, []);
  assert.deepEqual(d23Call(te, { ratio: down, lo: 0.6, hi: 0.95, recentRate: 0.3125, baselineRate: 0.4167 }).reasons, []);
  // Exactly one point is one point, despite floating point (0.04 − 0.03 = 0.00999…).
  assert.equal(d23Call(te, { ratio: 0.75, lo: 0.6, hi: 0.95, recentRate: 0.03, baselineRate: 0.04 }).material, true);
  // Range includes 1 → not material whatever the size.
  c = d23Call(te, { ratio: 3, lo: 0.9, hi: 10, recentRate: 0.3, baselineRate: 0.1 });
  assert.deepEqual([c.material, c.reasons], [false, ["interval-includes-1"]]);
  // Reads per edit: "1 pt" = 1.0 read per edit; down = worse.
  c = d23Call(rpe, { ratio: 0.7, lo: 0.5, hi: 0.9, recentRate: 2.8, baselineRate: 4.0 });
  assert.deepEqual([c.material, c.direction, statusOf(rpe, c)], [true, "down", "worse"]);
  c = d23Call(rpe, { ratio: 0.7, lo: 0.5, hi: 0.9, recentRate: 1.4, baselineRate: 2.0 });
  assert.deepEqual([c.material, c.reasons], [false, ["below-absolute-floor"]]);
  c = d23Call(rpe, { ratio: 1.5, lo: 1.2, hi: 1.9, recentRate: 3, baselineRate: 2 });
  assert.equal(statusOf(rpe, c), "better");
  // A context metric with no worse direction: a material move is "shifted"; no absolute floor applies.
  const steps = metricDef("steps");
  c = d23Call(steps, { ratio: 1.5, lo: 1.2, hi: 1.9, recentRate: 0.15, baselineRate: 0.1 });
  assert.equal(statusOf(steps, c), "shifted");
});
