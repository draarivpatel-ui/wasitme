import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GATE, evaluateGate, summarizeWindow, type WindowSummary } from "../../src/analysis/stats/gate.js";
import type { Cell } from "../../src/analysis/stats/types.js";

test("summarizeWindow counts events, exposure, clusters, sessions, days and top-session share", () => {
  const cells: Cell[] = [
    { session: "a", day: "2026-09-01", num: 2, den: 30 },
    { session: "a", day: "2026-09-02", num: 1, den: 30 },
    { session: "b", day: "2026-09-02", num: 0, den: 40 },
    { session: "c", day: "2026-09-03", num: 0, den: 0 }, // empty → ignored
    { session: "d", day: "garbage", num: 1, den: 0 }, // counted, but its day is not
  ];
  const bySession = summarizeWindow(cells, "session");
  assert.deepEqual(bySession, { events: 4, denominator: 100, clusters: 3, sessions: 3, days: 2, maxSessionShare: 0.6 });
  assert.equal(summarizeWindow(cells, "session-day").clusters, 4);
  assert.deepEqual(summarizeWindow([], "session"), { events: 0, denominator: 0, clusters: 0, sessions: 0, days: 0, maxSessionShare: 0 });
});

const ample: WindowSummary = { events: 40, denominator: 500, clusters: 12, sessions: 8, days: 10, maxSessionShare: 0.3 };

test("gate passes with ample data in both windows", () => {
  const g = evaluateGate(ample, ample);
  assert.equal(g.pass, true);
  assert.equal(g.progress, 1);
  assert.deepEqual(g.blocking, []);
  assert.ok(g.criteria.every((c) => c.pass));
});

test("gate failure reports progress on the bottleneck, worst first", () => {
  const thin: WindowSummary = { events: 3, denominator: 60, clusters: 2, sessions: 1, days: 2, maxSessionShare: 0.9 };
  const g = evaluateGate(thin, ample);
  assert.equal(g.pass, false);
  const ids = g.blocking.map((c) => `${c.id}:${c.window}`);
  assert.deepEqual(ids.sort(), ["clusters:recent", "days:recent", "sessionShare:recent", "sessions:recent"].sort());
  assert.equal(g.blocking[0]!.id, "sessions"); // 1/3 is the furthest from passing
  assert.ok(Math.abs(g.progress - 1 / 3) < 1e-12);
  const share = g.criteria.find((c) => c.id === "sessionShare" && c.window === "recent")!;
  assert.ok(Math.abs(share.progress - DEFAULT_GATE.maxSessionShare / 0.9) < 1e-12);
  // Events are judged over both windows: 3 + 40 ≥ 20.
  assert.equal(g.criteria.find((c) => c.id === "events")!.pass, true);
});

test("thresholds are configurable; per-window events only checked when asked", () => {
  const g = evaluateGate(ample, { ...ample, events: 0 }, { minEventsPerWindow: 5, minSessions: 9 });
  assert.equal(g.pass, false);
  assert.ok(g.blocking.some((c) => c.id === "eventsPerWindow" && c.window === "baseline" && c.progress === 0));
  assert.ok(g.blocking.some((c) => c.id === "sessions"));
  assert.equal(evaluateGate(ample, ample).criteria.some((c) => c.id === "eventsPerWindow"), false);
  // A zero requirement always passes.
  assert.equal(evaluateGate({ ...ample, days: 0 }, ample, { minDays: 0 }).pass, true);
});
