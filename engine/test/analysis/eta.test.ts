/**
 * D64: the ETA product rule (analysis/gates/eta.ts) — the ready hold, the stable-date rule, the largest-session share
 * and Codex's measured anchor — on its own and through evaluateAgent with persisted-style records. Synthetic only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateGate, ETA_HISTORY_KEEP, heldReady, MAX_DATED_SESSION_SHARE, nextHistory, priorRecords, stableDate, stableNotAtPace,
  type EtaRecord,
} from "../../src/analysis/gates/eta.js";
import { evaluateAgent } from "../../src/analysis/gates/evaluate.js";
import type { ProjectedMetric } from "../../src/analysis/gates/progress.js";
import type { MetricExchange } from "../../src/analysis/metrics/defs.js";
import { addDays, close, ex } from "./helpers.js";

const TODAY = "2026-10-04";
const NOW = new Date(`${TODAY}T12:00:00Z`);
const OPTS = { now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 200 } as const;
const rec = (day: string, over: Partial<EtaRecord> = {}): EtaRecord => ({ day, ready: false, tier: 2, eta: "2026-11-07", notAtPace: false, ...over });

test("D64 records: one per earlier day (the latest wins), today's or a later day's record is ignored, 3 kept", () => {
  const h = [rec("2026-10-03"), rec("2026-10-01"), rec("2026-10-03", { ready: true }), rec(TODAY), rec("2026-10-09")];
  assert.deepEqual(priorRecords(h, TODAY), [rec("2026-10-01"), rec("2026-10-03", { ready: true })]);
  assert.deepEqual(priorRecords(null, TODAY), []);
  const today = rec(TODAY, { ready: true });
  assert.deepEqual(nextHistory(h, today), [rec("2026-10-01"), rec("2026-10-03", { ready: true }), today]);
  const long = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"].map((d) => rec(d));
  assert.deepEqual(nextHistory(long, today).map((r) => r.day), ["2026-09-30", "2026-10-01", TODAY]);
  assert.equal(ETA_HISTORY_KEEP, 3);
  // A same-day re-evaluation replaces today's record (so a forced recompute writes the same history).
  assert.deepEqual(nextHistory(nextHistory(long, today), today), nextHistory(long, today));
});

test("D64(a) ready = ready today and on the previous daily evaluation", () => {
  assert.equal(heldReady(true, []), false);
  assert.equal(heldReady(true, [rec("2026-10-03", { ready: true })]), true);
  assert.equal(heldReady(true, [rec("2026-10-02", { ready: true }), rec("2026-10-03")]), false);
  assert.equal(heldReady(false, [rec("2026-10-03", { ready: true })]), false);
  // The previous daily evaluation is the last record of an earlier day, whatever the gap.
  assert.equal(heldReady(true, [rec("2026-09-20", { ready: true })]), true);
});

test("D64(b)1 stable: same tier and target dates within ±20% of today's remaining days on 3 consecutive evaluations", () => {
  const today = rec(TODAY, { eta: "2026-10-14" }); // 10 days → ±2 days
  assert.equal(stableDate(today, [rec("2026-10-02", { eta: "2026-10-16" }), rec("2026-10-03", { eta: "2026-10-12" })], 10), true);
  assert.equal(stableDate(today, [rec("2026-10-02", { eta: "2026-10-17" }), rec("2026-10-03", { eta: "2026-10-14" })], 10), false);
  assert.equal(stableDate(today, [rec("2026-10-03", { eta: "2026-10-14" })], 10), false, "two earlier evaluations needed");
  assert.equal(stableDate(today, [rec("2026-10-02", { eta: "2026-10-14", tier: 1 }), rec("2026-10-03", { eta: "2026-10-14" })], 10), false, "same tier");
  assert.equal(stableDate(today, [rec("2026-10-02", { eta: null, tier: null }), rec("2026-10-03", { eta: "2026-10-14" })], 10), false);
  // Only the two most recent earlier records count.
  assert.equal(stableDate(today, [rec("2026-09-30", { eta: "2026-12-01" }), rec("2026-10-02", { eta: "2026-10-14" }), rec("2026-10-03", { eta: "2026-10-14" })], 10), true);
  // Short ETAs: 4 days → ±0.8 days, so the dates must match; a projection holding still is stable however close.
  const soon = rec(TODAY, { eta: "2026-10-08" });
  assert.equal(stableDate(soon, [rec("2026-10-02", { eta: "2026-10-08" }), rec("2026-10-03", { eta: "2026-10-09" })], 4), false);
  assert.equal(stableDate(soon, [rec("2026-10-02", { eta: "2026-10-08" }), rec("2026-10-03", { eta: "2026-10-08" })], 4), true);
  // Exactly at the edge: 5 days → ±1 day.
  const five = rec(TODAY, { eta: "2026-10-09" });
  assert.equal(stableDate(five, [rec("2026-10-02", { eta: "2026-10-10" }), rec("2026-10-03", { eta: "2026-10-08" })], 5), true);
});

test("not at the current pace is shown only after 3 consecutive evaluations said so", () => {
  const pace = (day: string) => rec(day, { tier: null, eta: null, notAtPace: true });
  assert.equal(stableNotAtPace(pace(TODAY), [pace("2026-10-02"), pace("2026-10-03")]), true);
  assert.equal(stableNotAtPace(pace(TODAY), [rec("2026-10-02"), pace("2026-10-03")]), false);
  assert.equal(stableNotAtPace(pace(TODAY), [pace("2026-10-03")]), false);
  assert.equal(stableNotAtPace(rec(TODAY), [pace("2026-10-02"), pace("2026-10-03")]), false);
});

function pm(id: string, family: string, share: number, sensitive = true, source: "measured" | "probe" | null = "measured"): ProjectedMetric {
  const w = { sessions: 10, sessionDays: 10, events: 50, denominator: 1000, topDenominator: share * 1000, maxSessionShare: share };
  return {
    id, family, tier: 2, recent: w, baseline: { ...w, maxSessionShare: share / 2 }, gatePass: true, se: 0.1, df: 20, scheme: "session",
    calibration: source === null ? null : { tier: 1, scheme: "session", source, varianceRatio: 1, dfRatio: 1 }, mde: 1.5, sensitive,
  };
}
const FAMILIES = ["errors", "research"];

test("D64(b)2–3 date gate: per family a sensitive metric with largest-session share < 0.35; Codex needs it measured", () => {
  assert.deepEqual(dateGate([pm("toolErrors", "errors", 0.2), pm("blindEdits", "research", 0.1)], FAMILIES, "claude-code"), { share: 0.2, withheld: null });
  assert.deepEqual(dateGate([pm("toolErrors", "errors", 0.4), pm("blindEdits", "research", 0.1)], FAMILIES, "claude-code"), { share: 0.4, withheld: "dominant_session" });
  assert.equal(dateGate([pm("toolErrors", "errors", MAX_DATED_SESSION_SHARE), pm("blindEdits", "research", 0.1)], FAMILIES, "claude-code").withheld, "dominant_session");
  // One small-share sensitive metric per family is enough; a non-sensitive one never counts.
  const two = [pm("toolErrors", "errors", 0.4), pm("blindEdits", "research", 0.5), pm("readsPerEdit", "research", 0.3)];
  assert.deepEqual(dateGate(two, FAMILIES, "claude-code"), { share: 0.4, withheld: "dominant_session" });
  assert.deepEqual(dateGate([pm("toolErrors", "errors", 0.3), ...two.slice(1)], FAMILIES, "claude-code"), { share: 0.3, withheld: null });
  assert.equal(dateGate([pm("toolErrors", "errors", 0.3), pm("blindEdits", "research", 0.1, false)], FAMILIES, "claude-code").withheld, "dominant_session");
  // Codex: a probe or no anchor is not a measured anchor; Claude Code does not need one.
  const probe = [pm("toolErrors", "errors", 0.2, true, "probe"), pm("blindEdits", "research", 0.1)];
  assert.equal(dateGate(probe, FAMILIES, "codex").withheld, "no_measured_anchor");
  assert.equal(dateGate([pm("toolErrors", "errors", 0.2, true, null), pm("blindEdits", "research", 0.1)], FAMILIES, "codex").withheld, "no_measured_anchor");
  assert.equal(dateGate(probe, FAMILIES, "claude-code").withheld, null);
  assert.equal(dateGate([pm("toolErrors", "errors", 0.2), pm("blindEdits", "research", 0.1)], FAMILIES, "codex").withheld, null);
  // A dominant session is reported before a missing anchor.
  assert.equal(dateGate([pm("toolErrors", "errors", 0.2, true, "probe"), pm("blindEdits", "research", 0.5)], FAMILIES, "codex").withheld, "dominant_session");
});

/** progress.test.ts's golden: 30 days, two one-day sessions a day; tier 2 projected ready from d = 33 (ETA d = 34). */
function golden(agent: "claude-code" | "codex" = "claude-code"): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 30; k >= 1; k--) {
    const day = addDays(TODAY, -k);
    for (const [s, err, blind] of [["a", 1, 5], ["b", 19, 15]] as const) {
      xs.push(ex({ agent, session: `${s}-${day}`, day, toolCalls: 100, toolErrors: err, edits: 100, reads: 200, blindEdits: blind }));
    }
  }
  return xs;
}

test("evaluateAgent: the date shows on the third daily evaluation that agrees, never on the first", () => {
  const first = evaluateAgent(golden(), { ...OPTS, agent: "claude-code" }).progress;
  assert.deepEqual([first.reason, first.etaDate, first.dateWithheld, first.projection?.etaDate], ["no_date", null, "unstable", "2026-11-07"]);
  const agree = [rec("2026-10-02", { eta: "2026-11-07" }), rec("2026-10-03", { eta: "2026-11-07" })];
  const shown = evaluateAgent(golden(), { ...OPTS, agent: "claude-code", progressHistory: agree }).progress;
  assert.deepEqual([shown.reason, shown.etaDate, shown.etaDays, shown.etaTier, shown.dateWithheld], ["eta", "2026-11-07", 34, 2, null]);
  assert.ok(close(shown.projection!.maxSessionShare!, 100 / 4200));
  // ±20% of 34 days = 6.8 days: a target 6 days off still agrees, 7 days off does not; another tier never does.
  const off = (eta: string, tier: 1 | 2 | 3 = 2) => evaluateAgent(golden(), { ...OPTS, agent: "claude-code", progressHistory: [agree[0]!, rec("2026-10-03", { eta, tier })] }).progress;
  assert.equal(off("2026-11-13").reason, "eta");
  assert.deepEqual([off("2026-11-14").reason, off("2026-11-14").dateWithheld], ["no_date", "unstable"]);
  assert.equal(off("2026-11-07", 3).reason, "no_date");
  // Records dated today or later (a clock that went backward) are not earlier evaluations.
  const future = evaluateAgent(golden(), { ...OPTS, agent: "claude-code", progressHistory: [rec(TODAY), rec("2026-10-05")] }).progress;
  assert.equal(future.reason, "no_date");
});

test("evaluateAgent: Codex shows no date without a measured anchor, however stable", () => {
  const agree = [rec("2026-10-02", { eta: "2026-11-07" }), rec("2026-10-03", { eta: "2026-11-07" })];
  const p = evaluateAgent(golden("codex"), { ...OPTS, agent: "codex", progressHistory: agree }).progress;
  // 30 days of history: no tier is met, so the only anchors are tier 1's probes.
  assert.ok(Object.values(p.anchors).flat().every((a) => a.source === "probe"));
  assert.deepEqual([p.reason, p.etaDate, p.dateWithheld, p.projection?.etaDate], ["no_date", null, "no_measured_anchor", "2026-11-07"]);
});

/** progress.test.ts's marathon (6,000 calls at T−5): tier 2 projected ready from d = 17 with a 0.488 baseline share. */
function marathon(): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 60; k++) {
    const day = addDays(TODAY, -k);
    for (let i = 0; i < 3; i++) xs.push(ex({ session: `s${i}-${day}`, day, toolCalls: 50, toolErrors: 5, edits: 20, reads: 60, blindEdits: i + 1 }));
  }
  xs.push(ex({ session: "marathon", day: addDays(TODAY, -5), toolCalls: 6000, toolErrors: 600 }));
  return xs;
}

test("evaluateAgent: a stable date whose window one session dominates (share ≥ 0.35) is not shown", () => {
  const agree = [rec("2026-10-02", { eta: "2026-10-22" }), rec("2026-10-03", { eta: "2026-10-22" })];
  const p = evaluateAgent(marathon(), { ...OPTS, agent: "claude-code", progressHistory: agree }).progress;
  assert.deepEqual([p.reason, p.etaDate, p.dateWithheld, p.projection?.etaDate, p.projection?.etaTier], ["no_date", null, "dominant_session", "2026-10-22", 2]);
  assert.ok(close(p.projection!.maxSessionShare!, 6000 / 12300));
});
