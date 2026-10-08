/**
 * WP-20b confounders: hand-computed cases for every rule (synthetic numbers only — no text, paths or real data).
 *
 * Pure-rule tests use small integer data whose expected values are worked out in the comments. Integration tests
 * run `evaluateAgent` + `assessConfounders` on synthetic workloads whose raw shift is far from every threshold, so
 * the bootstrap's randomness cannot change the asserted outcome; the hand-computable parts (totals, weights, exact
 * standardised ratios, project counts, influences) are asserted exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessConfounders, changedOf, checkDims, dayInfluences, DF_FLOOR, dfFloor, familywiseAlpha, fullStratumKey, keepsShift,
  leaveOneSessionOut, projectAgreement, projectRule, promptLengthFlag, regroup, shareMove, singleIndicatorNote, standardise,
  stratumParts, type VotingView,
} from "../../src/analysis/confounders/index.js";
import { D29_CANDIDATES, type GateParams } from "../../src/analysis/gates/d23.js";
import { evaluateAgent, type AgentEvaluation, type EvaluateOptions, type MetricEvaluation } from "../../src/analysis/gates/evaluate.js";
import { buildCells, type StratumCell } from "../../src/analysis/metrics/cells.js";
import { metricDef, type MetricExchange, type MetricId } from "../../src/analysis/metrics/defs.js";
import type { ChangeCall } from "../../src/analysis/stats/material.js";
import { addDays, close, ex } from "./helpers.js";

const TODAY = "2026-10-04";
const NOW = new Date(`${TODAY}T12:00:00Z`);
const OPTS: EvaluateOptions = { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 400 };

const sc = (stratum: string, session: string, day: string, num: number, den: number): StratumCell =>
  ({ stratum, session, day, num, den, exchanges: 1, missing: 0, clamped: 0 });

const tier1 = (ev: AgentEvaluation, id: MetricId): MetricEvaluation => ev.tiers[0]!.metrics.find((m) => m.id === id)!;

// ───────────────────────────── standardised ratio: arithmetic ─────────────────────────────

test("standardise: weights, Kish scale, reweighted baseline and the exact standardised ratio (hand-computed)", () => {
  // Recent: A 10/100, B 40/100, C 5/50 (C only in recent). Baseline: A 30/300, B 20/100.
  // Common strata {A, B}: Σ_S D_r = 200, Σ_S D_b = 400.
  //   w_A = 100/200 = 0.5, w_B = 0.5; baseline shares 300/400 = 0.75, 100/400 = 0.25.
  //   f_A = 0.5/0.75 = 2/3, f_B = 0.5/0.25 = 2.
  //   b_A = 0.1, b_B = 0.2 → B* = 0.5·0.1 + 0.5·0.2 = 0.15; R = (10+40)/200 = 0.25; ratio = 0.25/0.15 = 5/3.
  //   Σ f N_b = (2/3)·30 + 2·20 = 60; Σ f² N_b = (4/9)·30 + 4·20 = 280/3; c = 60 / (280/3) = 9/14.
  //   Reweighted baseline: A num 30·(2/3)·(9/14) = 90/7, den 300·(2/3)·(9/14) = 900/7; B num 20·2·(9/14) = 180/7,
  //   den 100·2·(9/14) = 900/7 → rate (270/7)/(1800/7) = 0.15 = B*.
  //   Coverage: recent 200/250 = 0.8; baseline 400/400 = 1.
  const recent = [sc("A", "r1", "2026-10-01", 10, 100), sc("B", "r2", "2026-10-02", 40, 100), sc("C", "r3", "2026-10-02", 5, 50)];
  const baseline = [sc("A", "b1", "2026-09-01", 30, 300), sc("B", "b2", "2026-09-02", 20, 100)];
  const st = standardise(recent, baseline);
  const w = st.weights!;
  assert.deepEqual(w.common, ["A", "B"]);
  assert.deepEqual([w.recentOnly, w.baselineOnly], [1, 0]);
  assert.ok(close(w.coverage.recent, 0.8) && close(w.coverage.baseline, 1));
  assert.ok(close(w.strata[0]!.factor, 2 / 3) && close(w.strata[1]!.factor, 2));
  assert.ok(close(w.kish, 9 / 14));
  assert.ok(close(w.recentRate, 0.25) && close(w.baselineStandardised, 0.15) && close(w.ratio!, 5 / 3));
  assert.deepEqual(st.recent.map((c) => c.session), ["r1", "r2"]); // C dropped
  assert.ok(close(st.baseline[0]!.num, 90 / 7) && close(st.baseline[0]!.den, 900 / 7));
  assert.ok(close(st.baseline[1]!.num, 180 / 7) && close(st.baseline[1]!.den, 900 / 7));
  // The Kish scale makes the Poisson floor exact: 1/(c·Σ f N) = Σ f² N / (Σ f N)² = (280/3)/3600.
  const weightedEvents = st.baseline.reduce((s, c) => s + c.num, 0);
  assert.ok(close(1 / weightedEvents, 280 / 3 / 3600));
});

test("standardise: no common stratum → no weights; an unchanged mix → factors 1 and Kish 1 (cells unchanged)", () => {
  const none = standardise([sc("A", "r1", "2026-10-01", 1, 10)], [sc("B", "b1", "2026-09-01", 1, 10)]);
  assert.equal(none.weights, null);
  // A stratum with events but no denominator in a window is not "present" there.
  assert.equal(standardise([sc("A", "r1", "2026-10-01", 1, 10)], [sc("A", "b1", "2026-09-01", 3, 0)]).weights, null);
  // Same mix (A:B = 1:3 in both windows) → f = 1, c = 1.
  const same = standardise(
    [sc("A", "r1", "2026-10-01", 2, 50), sc("B", "r2", "2026-10-01", 30, 150)],
    [sc("A", "b1", "2026-09-01", 4, 100), sc("B", "b2", "2026-09-01", 20, 300)],
  );
  assert.deepEqual(same.weights!.strata.map((s) => s.factor), [1, 1]);
  assert.equal(same.weights!.kish, 1);
  assert.deepEqual(same.baseline.map((c) => [c.num, c.den]), [[4, 100], [20, 300]]);
  // Raw ratio (32/200)/(24/400) = 8/3 equals the standardised one when the mix is unchanged.
  assert.ok(close(same.weights!.ratio!, 8 / 3));
});

test("strata keys: full key round-trips; regroup merges by session, day and the kept dimensions", () => {
  const x = ex({ session: "s", day: "2026-10-01", project: "P", model: "M", entrypoint: "cli" });
  assert.deepEqual(stratumParts(fullStratumKey(x)), { project: "P", model: "M", entrypoint: "cli" });
  // servedModel is never a stratum: an agent-side served-model switch must not be standardised away.
  assert.equal(fullStratumKey({ ...x, servedModel: "other" }), fullStratumKey(x));
  const k1 = fullStratumKey(x), k2 = fullStratumKey({ ...x, model: "M2" });
  const merged = regroup([sc(k1, "s", "d", 1, 10), sc(k2, "s", "d", 2, 20)], ["project", "entrypoint"]);
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0]!.num, merged[0]!.den], [3, 30]);
  assert.throws(() => checkDims(["project", "project"]), /duplicate/);
  assert.throws(() => checkDims(["servedModel" as never]), /unknown/);
});

test("buildCells with stratumOf: stratum cells sum to the plain cells; without it nothing changes", () => {
  const xs = [
    ex({ session: "s1", day: "2026-09-01", project: "A", toolCalls: 10, toolErrors: 1 }),
    ex({ session: "s1", day: "2026-09-01", project: "B", toolCalls: 30, toolErrors: 6 }),
    ex({ session: "s2", day: "2026-09-02", project: "A", toolCalls: 5, toolErrors: 0, entrypoint: "exec" }), // automation: excluded
  ];
  const plain = buildCells(xs, { agent: "claude-code", today: TODAY });
  const seen: string[] = [];
  const strat = buildCells(xs, { agent: "claude-code", today: TODAY, stratumOf: fullStratumKey, onExchange: (_x, v) => seen.push(v) });
  assert.equal(plain.strata, undefined);
  assert.deepEqual(strat.cells, plain.cells);
  assert.deepEqual(strat.strata!.toolErrors.map((c) => [stratumParts(c.stratum).project, c.num, c.den]), [["A", 1, 10], ["B", 6, 30]]);
  assert.deepEqual(seen.sort(), ["entrypoint", "interactive", "interactive"]);
});

// ───────────────────────────── shared rules ─────────────────────────────

const call = (over: Partial<ChangeCall>): ChangeCall =>
  ({ direction: "up", significant: true, material: true, relativeChange: 1, absoluteChange: 0.05, reasons: [], ...over });

test("keepsShift: material in the raw direction holds; no interval, a reversal, or not material loses it", () => {
  assert.deepEqual(keepsShift("up", call({})), { holds: true, reason: null });
  assert.deepEqual(keepsShift("up", null), { holds: false, reason: "no_interval" });
  assert.deepEqual(keepsShift("up", call({ direction: "down" })), { holds: false, reason: "direction_flipped" });
  // Range includes 1× with the point estimate just under 1 (e.g. a pseudo-count hair): not material, not a reversal.
  assert.deepEqual(keepsShift("up", call({ direction: "down", significant: false, material: false })), { holds: false, reason: "not_material" });
  assert.deepEqual(keepsShift("up", call({ material: false, reasons: ["below-relative-threshold"] })), { holds: false, reason: "not_material" });
});

/** A voting-metric view for the pure rules (comparison fields are only those the rules read). */
function vv(id: MetricId, over: Partial<VotingView> & { p?: number; df?: number } = {}): VotingView {
  const fam: Record<string, VotingView["family"]> = { toolErrors: "errors", readsPerEdit: "research", blindEdits: "research", interrupts: "friction" };
  const { p = 0.5, df = 30, ...rest } = over;
  return {
    id, family: fam[id] ?? "context", role: id === "interrupts" ? "support" : "vote", eligible: true, material: false, status: "none",
    comparison: { df, pValue: p, ratio: 1, range: { lo: 0.5, hi: 2 } },
    ...rest,
  };
}
const worse = { material: true, status: "worse" as const };
const better = { material: true, status: "better" as const };

test("changedOf (METHOD.md §7 + D30): ≥ 2 usable material voting metrics, ≥ 2 families, one side, none opposite", () => {
  // Tool errors ↑ (errors) and blind edits ↑ (research), both "worse" → changed.
  let c = changedOf([vv("toolErrors", worse), vv("blindEdits", worse), vv("readsPerEdit")]);
  assert.deepEqual([c.changed, c.side, c.counted, c.families], [true, "worse", ["toolErrors", "blindEdits"], ["errors", "research"]]);
  // Orientation by "worse": reads per edit falling is "worse", so it agrees with tool errors rising.
  assert.equal(changedOf([vv("toolErrors", worse), vv("readsPerEdit", worse)]).changed, true);
  // Opposite sides → mixed, never changed.
  c = changedOf([vv("toolErrors", worse), vv("blindEdits", better)]);
  assert.deepEqual([c.changed, c.mixed], [false, true]);
  // Two research metrics only: one family → not changed.
  assert.equal(changedOf([vv("blindEdits", worse), vv("readsPerEdit", worse)]).changed, false);
  // Friction never counts (D30).
  assert.equal(changedOf([vv("toolErrors", worse), vv("interrupts", worse)]).changed, false);
  // df floor: blind edits at df 3.9 cannot be counted → not changed, and it is listed.
  c = changedOf([vv("toolErrors", worse), vv("blindEdits", { ...worse, df: 3.9 })]);
  assert.deepEqual([c.changed, c.counted, c.unusableMaterial], [false, ["toolErrors"], ["blindEdits"]]);
  // …but a low-df metric on the other side still blocks (losing a shift only makes a verdict less specific).
  assert.equal(changedOf([vv("toolErrors", worse), vv("readsPerEdit", worse), vv("blindEdits", { ...better, df: 2 })]).mixed, true);
});

test("df floor (research/08): df < 4 → low_df (counted), df = 4 → usable; ineligible and friction rows", () => {
  assert.equal(DF_FLOOR, 4);
  const f = dfFloor([
    vv("toolErrors", { df: 3.99 }),
    vv("readsPerEdit", { df: 4 }),
    vv("blindEdits", { eligible: false, comparison: null }),
    vv("interrupts", { df: 1 }), // friction: not a voting metric, no row
  ]);
  assert.deepEqual(f.metrics.map((m) => [m.metric, m.df, m.usable, m.reason]), [
    ["toolErrors", 3.99, false, "low_df"],
    ["readsPerEdit", 4, true, null],
    ["blindEdits", null, false, "ineligible"],
  ]);
  assert.deepEqual(f.lowDf, ["toolErrors"]);
});

// ───────────────────────────── Holm-gated single-metric note ─────────────────────────────

test("single-metric note: Holm across the eligible voting metrics at α = 1 − level (hand-computed)", () => {
  assert.equal(familywiseAlpha(0.99), 0.01);
  assert.equal(familywiseAlpha(0.95), 0.05);
  // p = 0.003, 0.2, 0.6 (three eligible): Holm 3·0.003 = 0.009, max(0.009, 2·0.2) = 0.4, max(0.4, 0.6) = 0.6.
  let n = singleIndicatorNote([vv("toolErrors", { ...worse, p: 0.003 }), vv("readsPerEdit", { p: 0.2 }), vv("blindEdits", { p: 0.6 })], 0.99);
  assert.equal(n.kind, "single_indicator");
  assert.ok(close(n.adjustedP.toolErrors!, 0.009) && close(n.adjustedP.readsPerEdit!, 0.4) && close(n.adjustedP.blindEdits!, 0.6));
  assert.deepEqual([n.metric!.id, n.familywiseSignificant, n.blocksNone], ["toolErrors", ["toolErrors"], true]);
  // p = 0.004 → 3·0.004 = 0.012 > 0.01 → plain insufficient (Why / Investigate only), still never `none`.
  n = singleIndicatorNote([vv("toolErrors", { ...worse, p: 0.004 }), vv("readsPerEdit", { p: 0.2 }), vv("blindEdits", { p: 0.6 })], 0.99);
  assert.deepEqual([n.kind, n.familywiseSignificant, n.blocksNone], ["fails_holm", [], true]);
  assert.ok(close(n.metric!.adjustedP!, 0.012));
  // The family is the ELIGIBLE voting metrics: with blind edits ineligible, 2·0.004 = 0.008 ≤ 0.01 → survives.
  n = singleIndicatorNote([vv("toolErrors", { ...worse, p: 0.004 }), vv("readsPerEdit", { p: 0.2 }), vv("blindEdits", { eligible: false, comparison: null })], 0.99);
  assert.deepEqual([n.kind, n.family], ["single_indicator", ["toolErrors", "readsPerEdit"]]);
  assert.ok(close(n.adjustedP.toolErrors!, 0.008));
  // At a 95% method α = 0.05: 3·0.012 = 0.036 ≤ 0.05 → survives.
  assert.equal(singleIndicatorNote([vv("toolErrors", { ...worse, p: 0.012 }), vv("readsPerEdit"), vv("blindEdits")], 0.95).kind, "single_indicator");
  // A lone material metric below the df floor is not usable → plain insufficient.
  assert.equal(singleIndicatorNote([vv("toolErrors", { ...worse, p: 1e-9, df: 2.5 }), vv("readsPerEdit"), vv("blindEdits")], 0.99).kind, "low_df");
  // Other cases.
  assert.equal(singleIndicatorNote([vv("toolErrors", { ...worse, p: 1e-6 }), vv("blindEdits", { ...worse, p: 1e-6 })], 0.99).kind, "changed");
  assert.equal(singleIndicatorNote([vv("toolErrors", { ...worse, p: 1e-6 }), vv("blindEdits", { ...better, p: 1e-6 })], 0.99).kind, "mixed");
  assert.equal(singleIndicatorNote([vv("readsPerEdit", { ...worse, p: 1e-6 }), vv("blindEdits", { ...worse, p: 1e-6 })], 0.99).kind, "several_not_changed");
  n = singleIndicatorNote([vv("toolErrors"), vv("readsPerEdit"), vv("blindEdits")], 0.99);
  assert.deepEqual([n.kind, n.blocksNone, n.metric], ["none_material", false, null]);
  // Friction never enters the Holm family or the note.
  n = singleIndicatorNote([vv("interrupts", { ...worse, p: 1e-9 }), vv("toolErrors"), vv("blindEdits")], 0.99);
  assert.deepEqual([n.kind, n.family], ["none_material", ["toolErrors", "blindEdits"]]);
});

// ───────────────────────────── projects rule ─────────────────────────────

test("projects rule: applies with ≥ 2 qualifying projects; holds when 3·agree ≥ 2·qualifying (boundaries)", () => {
  assert.deepEqual(projectAgreement(0, 0), { applies: false, holds: true });
  assert.deepEqual(projectAgreement(1, 0), { applies: false, holds: true });
  assert.deepEqual(projectAgreement(2, 1), { applies: true, holds: false }); // 3 < 4
  assert.deepEqual(projectAgreement(2, 2), { applies: true, holds: true });
  assert.deepEqual(projectAgreement(3, 2), { applies: true, holds: true }); // 6 ≥ 6: exactly ⅔
  assert.deepEqual(projectAgreement(4, 2), { applies: true, holds: false }); // 6 < 8
  assert.deepEqual(projectAgreement(5, 4), { applies: true, holds: true }); // 12 ≥ 10
  assert.deepEqual(projectAgreement(6, 3), { applies: true, holds: false }); // 9 < 12
});

test("projects rule on cells: qualify by the gate in both windows; agree by the sign of the rate move", () => {
  // A lenient gate so tiny hand data qualifies: ≥ 1 event, 1 session-day, 1 session, any share.
  // (GateParams is the literal type of the frozen D23 numbers, hence the cast.)
  const gate = { minEventsPerWindow: 1, minSessionDays: 1, minSessions: 1, maxSessionShareBelow: 1.01 } as unknown as GateParams;
  const k = (p: string) => fullStratumKey(ex({ session: "s", day: "2026-10-01", project: p }));
  const recent = [
    sc(k("P1"), "a", "2026-10-01", 4, 100), // P1: 4% vs 2% → up (agrees)
    sc(k("P2"), "b", "2026-10-01", 1, 100), // P2: 1% vs 3% → down (disagrees)
    sc(k("P3"), "c", "2026-10-01", 9, 100), // P3: no baseline → does not qualify
    sc(k("P4"), "d", "2026-10-01", 2, 100), // P4: 2% vs 2% → equal rates do not agree
  ];
  const baseline = [sc(k("P1"), "e", "2026-09-01", 2, 100), sc(k("P2"), "f", "2026-09-01", 3, 100), sc(k("P4"), "g", "2026-09-01", 2, 100)];
  const r = projectRule(metricDef("toolErrors"), recent, baseline, "up", gate);
  assert.deepEqual([r.projects, r.qualifying, r.agreeing, r.applies, r.holds], [4, 3, 1, true, false]); // 3·1 < 2·3
  assert.deepEqual(r.rows.map((x) => [x.project, x.qualifies, x.agrees]), [["P1", true, true], ["P2", true, false], ["P3", false, null], ["P4", true, false]]);
  // Downward shift: P2 now agrees and P1 does not; P4 still not → 1 of 3 → fails.
  assert.equal(projectRule(metricDef("toolErrors"), recent, baseline, "down", gate).agreeing, 1);
  // The metric's own denominator floor is part of qualifying (reads per edit: ≥ 40 edits in each window).
  const rpe = projectRule(metricDef("readsPerEdit"), [sc(k("P1"), "a", "2026-10-01", 50, 39)], [sc(k("P1"), "e", "2026-09-01", 50, 40)], "down", gate);
  assert.equal(rpe.qualifying, 0);
});

// ───────────────────────────── fragility: pure ─────────────────────────────

test("leave one session out: θ₋ₖ, influence = s·(θ − θ₋ₖ), shares, most influential first (hand-computed)", () => {
  // Recent: s1 10/100, s2 10/100, s3 40/100; baseline: s4 10/100, s5 10/100; s1 also has a baseline cell 0/100.
  //   θ = ln(60.5/300) − ln(20.5/300)                       (baseline 20 events of 300 calls incl. s1's)
  //   without s3: ln(20.5/200) − ln(20.5/300)               → influence = θ − that = ln(60.5/300) − ln(20.5/200)
  //   without s1 (both windows): ln(50.5/200) − ln(20.5/200)
  //   without s4: ln(60.5/300) − ln(10.5/200)               → influence = ln(10.5/200) − ln(20.5/300) < 0
  const rc = [{ session: "s1", day: "d1", num: 10, den: 100 }, { session: "s2", day: "d1", num: 10, den: 100 }, { session: "s3", day: "d2", num: 40, den: 100 }];
  const bc = [{ session: "s1", day: "d0", num: 0, den: 100 }, { session: "s4", day: "d0", num: 10, den: 100 }, { session: "s5", day: "d0", num: 10, den: 100 }];
  const loo = leaveOneSessionOut(rc, bc, 1);
  const theta = Math.log(60.5 / 300) - Math.log(20.5 / 300);
  assert.ok(close(loo.logRatio!, theta));
  const by = Object.fromEntries(loo.sessions.map((s) => [s.session, s]));
  assert.ok(close(by.s3!.logRatioWithout!, Math.log(20.5 / 200) - Math.log(20.5 / 300)));
  assert.ok(close(by.s3!.influence, Math.log(60.5 / 300) - Math.log(20.5 / 200)));
  assert.ok(close(by.s1!.logRatioWithout!, Math.log(50.5 / 200) - Math.log(20.5 / 200)));
  assert.ok(close(by.s4!.influence, Math.log(10.5 / 200) - Math.log(20.5 / 300)) && by.s4!.influence < 0);
  assert.ok(close(by.s3!.recentShare, 1 / 3) && close(by.s1!.baselineShare, 1 / 3) && by.s3!.baselineShare === 0);
  assert.equal(loo.sessions[0]!.session, "s3");
  // For a downward shift (s = −1) the ranking reverses: removing s4 now weakens the shift most… but s1/s2/s3 removals
  // raise or lower θ; s3's removal lowers θ, which STRENGTHENS a downward shift.
  assert.ok(leaveOneSessionOut(rc, bc, -1).sessions.find((s) => s.session === "s3")!.influence < 0);
  // A removal that empties a window has infinite influence.
  const one = leaveOneSessionOut([{ session: "only", day: "d1", num: 5, den: 10 }], [{ session: "b", day: "d0", num: 1, den: 10 }], 1);
  assert.deepEqual([one.sessions[0]!.session, one.sessions[0]!.influence, one.sessions[0]!.logRatioWithout], ["b", Infinity, null]);
});

test("day influence: Σ s·(θ − θ₋d)/SE over shifted metrics; ties → earlier day (hand-computed)", () => {
  // One metric, s = +1, SE = 0.5. Recent: d1 10/100, d2 30/100; baseline: d3 10/100, d4 10/100.
  //   θ = ln(40.5/200) − ln(20.5/200).
  //   drop d2: ln(10.5/100) − ln(20.5/200) → influence (θ − ·)/0.5 = (ln(40.5/200) − ln(10.5/100))/0.5 > 0 (largest)
  //   drop d3 or d4 (identical): (ln(10.5/100) − ln(20.5/200))/0.5 ≈ 0.048 → tie, d3 first
  //   drop d1: (ln(40.5/200) − ln(30.5/100))/0.5 < 0 (removing it strengthens the shift)
  const rc = [{ session: "a", day: "2026-10-01", num: 10, den: 100 }, { session: "b", day: "2026-10-02", num: 30, den: 100 }];
  const bc = [{ session: "c", day: "2026-09-01", num: 10, den: 100 }, { session: "d", day: "2026-09-02", num: 10, den: 100 }];
  const days = dayInfluences([{ rc, bc, sign: 1, se: 0.5 }]);
  assert.deepEqual(days.map((d) => [d.day, d.window]), [["2026-10-02", "recent"], ["2026-09-01", "baseline"], ["2026-09-02", "baseline"], ["2026-10-01", "recent"]]);
  assert.ok(close(days[0]!.influence, (Math.log(40.5 / 200) - Math.log(10.5 / 100)) / 0.5));
  assert.ok(close(days[1]!.influence, (Math.log(10.5 / 100) - Math.log(20.5 / 200)) / 0.5));
  assert.ok(close(days[3]!.influence, (Math.log(40.5 / 200) - Math.log(30.5 / 100)) / 0.5) && days[3]!.influence < 0);
});

// ───────────────────────────── mix flags: pure ─────────────────────────────

test("mix flags: 20 pp share moves and the [0.67, 1.5] prompt-length band (boundaries)", () => {
  assert.equal(shareMove({ a: 0.5, b: 0.5 }, { a: 0.7, b: 0.3 }).flagged, true); // exactly 20 pp
  const m = shareMove({ a: 0.6, b: 0.4 }, { a: 0.75, b: 0.25 });
  assert.ok(close(m.move!, 0.15) && !m.flagged);
  assert.ok(close(shareMove({ cli: 1 }, { desktop: 1 }).move!, 1)); // a label missing on one side counts as 0
  assert.equal(shareMove(null, { a: 1 }).move, null);
  assert.equal(promptLengthFlag(67, 100).flagged, false);
  assert.equal(promptLengthFlag(66, 100).flagged, true);
  assert.equal(promptLengthFlag(150, 100).flagged, false);
  assert.equal(promptLengthFlag(151, 100).flagged, true);
  assert.equal(promptLengthFlag(null, 100).ratio, null);
});

// ───────────────────────────── integration: workload ─────────────────────────────

/**
 * Tool errors only (no edits), 42 days, one-day sessions of 50 tool calls. Project A errs `a` times per session,
 * B `b` times; recent days have 1 A + 3 B sessions, baseline days 3 A + 1 B (the mix moved toward B).
 */
function mixShift(recentErrs: { A: number; B: number }, baselineErrs = { A: 1, B: 5 }): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 42; k++) {
    const day = addDays(TODAY, -k);
    const recent = k <= 14;
    const projects = recent ? ["A", "B", "B", "B"] : ["A", "A", "A", "B"];
    projects.forEach((p, i) => {
      const errs = (recent ? recentErrs : baselineErrs)[p as "A" | "B"];
      xs.push(ex({ session: `s${i}-${day}`, day, project: p, toolCalls: 50, toolErrors: errs }));
    });
  }
  return xs;
}

test("Simpson's paradox: a raw doubling that is only the project mix → standardised ×1, workload unclear", () => {
  const xs = mixShift({ A: 1, B: 5 });
  const ev = evaluateAgent(xs, OPTS);
  const te = tier1(ev, "toolErrors");
  // Raw: recent 14·(1 + 3·5) = 224 errors of 14·200 = 2,800 calls (8%); baseline 28·(3 + 5) = 224 of 5,600 (4%).
  assert.deepEqual([te.recent.events, te.recent.denominator, te.baseline.events, te.baseline.denominator], [224, 2800, 224, 5600]);
  assert.deepEqual([te.material, te.status], [true, "worse"]);
  assert.ok(te.comparison!.range.lo > 1.3); // ×2.0, far from 1
  const a = assessConfounders(xs, ev);
  const st = a.standardised.find((s) => s.metric === "toolErrors")!;
  // Recent mix: A 700 / B 2,100 calls (w = ¼, ¾); baseline rates b_A = 84/4,200 = 2%, b_B = 140/1,400 = 10%.
  //   B* = ¼·2% + ¾·10% = 8% = the recent rate → standardised ratio exactly 1.
  //   f_A = (¼)/(¾) = ⅓, f_B = (¾)/(¼) = 3; Σ f N = 84/3 + 3·140 = 448; Σ f² N = 84/9 + 9·140 = 3808/3; c = 448·3/3808 = 6/17.
  assert.ok(close(st.weights!.ratio!, 1, 1e-12));
  assert.ok(close(st.weights!.kish, 6 / 17));
  assert.deepEqual(st.weights!.strata.map((s) => stratumParts(s.stratum).project), ["A", "B"]);
  assert.ok(close(st.weights!.strata[0]!.factor, 1 / 3) && close(st.weights!.strata[1]!.factor, 3));
  // With the 0.5 pseudo-count on the effective count: θ* = ln(224.5/2800) − ln((448·6/17 + 0.5)/(5600·6/17)).
  assert.ok(close(st.comparison!.logRatio, Math.log(224.5 / 2800) - Math.log((448 * 6 / 17 + 0.5) / (5600 * 6 / 17)), 1e-9));
  assert.ok(st.comparison!.range.lo < 1 && st.comparison!.range.hi > 1);
  assert.deepEqual([st.overlap, st.holds, st.reason], [true, false, "not_material"]);
  // Projects: A (14 sessions, 14 errors recent; 84 sessions, 84 errors baseline) and B qualify; both rates are
  // unchanged (2% → 2%, 10% → 10%), so neither agrees → 0 of 2 → fails.
  const pr = a.projects.find((p) => p.metric === "toolErrors")!;
  assert.deepEqual([pr.qualifying, pr.agreeing, pr.applies, pr.holds], [2, 0, true, false]);
  assert.deepEqual(a.workload, { unclear: true, reasons: ["standardised_lost", "projects_disagree"], metrics: [{ metric: "toolErrors", reasons: ["standardised_lost", "projects_disagree"] }] });
});

test("a real change inside every project survives standardisation and the projects rule", () => {
  // Rates double in both projects (A 2% → 4%, B 10% → 20%) while the mix also moves.
  //   R = (14·2 + 42·10)/2,800 = 16%; B* = ¼·2% + ¾·10% = 8% → standardised ratio exactly 2 (raw ≈ 4).
  const xs = mixShift({ A: 2, B: 10 });
  const ev = evaluateAgent(xs, OPTS);
  const a = assessConfounders(xs, ev);
  const st = a.standardised.find((s) => s.metric === "toolErrors")!;
  assert.ok(close(st.weights!.ratio!, 2, 1e-12));
  assert.ok(st.comparison!.range.lo > 1.3);
  assert.deepEqual([st.holds, st.reason], [true, null]);
  const pr = a.projects.find((p) => p.metric === "toolErrors")!;
  assert.deepEqual([pr.qualifying, pr.agreeing, pr.holds], [2, 2, true]);
  assert.deepEqual(a.workload.reasons, []);
  assert.equal(a.workload.unclear, false);
});

test("an unchanged mix: the standardised comparison IS the raw comparison (same estimator, same numbers)", () => {
  // Both windows: 2 A + 2 B sessions a day; errors rise in both projects.
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 42; k++) {
    const day = addDays(TODAY, -k);
    ["A", "A", "B", "B"].forEach((p, i) => {
      const errs = k <= 14 ? (p === "A" ? 4 : 8) : p === "A" ? 1 : 3;
      xs.push(ex({ session: `s${i}-${day}`, day, project: p, toolCalls: 50, toolErrors: errs }));
    });
  }
  const ev = evaluateAgent(xs, OPTS);
  const a = assessConfounders(xs, ev);
  const st = a.standardised.find((s) => s.metric === "toolErrors")!;
  assert.deepEqual([st.weights!.kish, st.weights!.strata.map((s) => s.factor)], [1, [1, 1]]);
  assert.deepEqual(st.comparison, tier1(ev, "toolErrors").comparison);
  assert.equal(st.holds, true);
});

test("no common stratum → 'projects differ too much' → workload unclear; the projects rule does not apply", () => {
  // Baseline all project A at 2%; recent all project B at 10%.
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 42; k++) {
    const day = addDays(TODAY, -k);
    for (let i = 0; i < 4; i++) {
      xs.push(ex({ session: `s${i}-${day}`, day, project: k <= 14 ? "B" : "A", toolCalls: 50, toolErrors: k <= 14 ? 5 : 1 }));
    }
  }
  const ev = evaluateAgent(xs, OPTS);
  assert.equal(tier1(ev, "toolErrors").material, true);
  const a = assessConfounders(xs, ev);
  const st = a.standardised.find((s) => s.metric === "toolErrors")!;
  assert.deepEqual([st.overlap, st.weights, st.comparison, st.holds, st.reason], [false, null, null, false, "no_overlap"]);
  const pr = a.projects.find((p) => p.metric === "toolErrors")!;
  assert.deepEqual([pr.projects, pr.qualifying, pr.applies, pr.holds], [2, 0, false, true]);
  assert.deepEqual(a.workload.reasons, ["projects_differ"]);
});

test("strata include the requested model: a model switch alone leaves no overlap unless the dims drop it", () => {
  // One project; baseline on model m1, recent on m2, errors 2% → 6%. Under the default project × model × entrypoint the
  // windows share no stratum → projects_differ (WP-21: this fires at row 4 before a recorded /model change can make
  // the verdict `you`). With dims [project, entrypoint] the strata overlap and the shift holds.
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 42; k++) {
    const day = addDays(TODAY, -k);
    for (let i = 0; i < 4; i++) {
      xs.push(ex({ session: `s${i}-${day}`, day, model: k <= 14 ? "m2" : "m1", toolCalls: 50, toolErrors: k <= 14 ? 3 : 1 }));
    }
  }
  const ev = evaluateAgent(xs, OPTS);
  assert.deepEqual(assessConfounders(xs, ev).workload.reasons, ["projects_differ"]);
  const noModel = assessConfounders(xs, ev, { dims: ["project", "entrypoint"] });
  assert.deepEqual([noModel.dims, noModel.workload.unclear, noModel.standardised[0]!.holds], [["project", "entrypoint"], false, true]);
  assert.ok(close(noModel.standardised[0]!.weights!.ratio!, 3));
});

test("assessConfounders refuses exchanges that are not the evaluation's", () => {
  const xs = mixShift({ A: 2, B: 10 });
  const ev = evaluateAgent(xs, OPTS);
  assert.throws(() => assessConfounders(xs.slice(1), ev), /do not match the evaluation/);
  // Another tier can be asked for: tier 2's history is not met, so nothing is material there.
  const t2 = assessConfounders(xs, ev, { tier: 2 });
  assert.deepEqual([t2.tier, t2.standardised, t2.changed.changed, t2.singleIndicator.kind], [2, [], false, "none_material"]);
});

// ───────────────────────────── integration: fragility ─────────────────────────────

/**
 * Tool errors only: one-day sessions of 1,000 calls. Baseline 28 days × 4 sessions × 40 errors (4%); recent
 * 14 days × 3 sessions × `others` errors, except one session (day −7, s0) with `outlier` errors.
 */
function oneSession(others: number, outlier: number): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 42; k++) {
    const day = addDays(TODAY, -k);
    const recent = k <= 14;
    for (let i = 0; i < (recent ? 3 : 4); i++) {
      const errs = recent ? (k === 7 && i === 0 ? outlier : others) : 40;
      xs.push(ex({ session: `s${i}-${day}`, day, toolCalls: 1000, toolErrors: errs }));
    }
  }
  return xs;
}

test("leave one session out: a shift resting on one session is fragile (loses materiality without it)", () => {
  // Recent: 41 sessions × 49 + 1 × 120 = 2,129 errors of 42,000 (5.069%); baseline 4,480 of 112,000 (4%).
  //   Raw ×1.267 (+26.7%, +1.07 pt): material. Without the outlier: 2,009 / 41,000 = 4.9% → ×1.225 (+22.5%, +0.9 pt):
  //   below both the 25% and the 1 pt floors → fragile, reason not_material.
  const xs = oneSession(49, 120);
  const ev = evaluateAgent(xs, OPTS);
  const te = tier1(ev, "toolErrors");
  assert.equal(te.material, true);
  assert.ok(te.comparison!.range.lo > 1.1);
  const a = assessConfounders(xs, ev);
  const f = a.fragility.sessions.find((s) => s.metric === "toolErrors")!;
  const outlier = `s0-${addDays(TODAY, -7)}`;
  assert.equal(f.mostInfluential, outlier);
  assert.equal(f.sessions, 154);
  assert.ok(close(f.maxShare.recent, 1 / 42) && close(f.maxShare.baseline, 1 / 112));
  const theta = Math.log(2129.5 / 42000) - Math.log(4480.5 / 112000);
  const without = Math.log(2009.5 / 41000) - Math.log(4480.5 / 112000);
  assert.ok(close(f.influences[0]!.influence, theta - without));
  assert.ok(close(f.without!.comparison!.ratio, Math.exp(without)));
  assert.deepEqual(f.without!.call!.reasons, ["below-relative-threshold", "below-absolute-floor"]);
  assert.deepEqual([f.fragile, f.reason, a.fragility.fragileMetrics], [true, "not_material", ["toolErrors"]]);
});

test("leave one session out: a broad shift is not fragile", () => {
  // Every recent session at 6% (×1.5); dropping any one session leaves 6%.
  const xs = oneSession(60, 60);
  const ev = evaluateAgent(xs, OPTS);
  const a = assessConfounders(xs, ev);
  const f = a.fragility.sessions.find((s) => s.metric === "toolErrors")!;
  assert.deepEqual([f.material, f.fragile, f.reason], [true, false, null]);
  assert.equal(f.without!.call!.material, true);
});

/**
 * Two voting families: every session 50 tool calls, 20 edits, 40 reads. Tool errors 2 → 6 per session in every
 * recent session (×3). Blind edits: busy=true → the shift sits on ONE day (yesterday: 12 sessions × 8 of 20,
 * every other recent day 3 sessions × 2 of 20 as in the baseline); busy=false → every recent session 4 of 20 (×2).
 */
function twoFamilies(busy: boolean): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 42; k++) {
    const day = addDays(TODAY, -k);
    const recent = k <= 14;
    const n = recent ? (busy && k === 1 ? 12 : 3) : 4;
    for (let i = 0; i < n; i++) {
      const blind = recent ? (busy ? (k === 1 ? 8 : 2) : 4) : 2;
      xs.push(ex({ session: `s${i}-${day}`, day, toolCalls: 50, toolErrors: recent ? 6 : 2, edits: 20, reads: 40, blindEdits: blind }));
    }
  }
  return xs;
}

test("3 most influential days: a change that rests on one day is fragile → not changed", () => {
  // Blind edits recent: 39 sessions × 2 + 12 × 8 = 174 of 1,020 edits (17.1%) vs 224 of 2,240 (10%) → ×1.71, material.
  // Dropping yesterday leaves 78 of 780 = 10% → ×1.0 → blind edits no longer material → only one family → not changed.
  const xs = twoFamilies(true);
  const ev = evaluateAgent(xs, OPTS);
  const be = tier1(ev, "blindEdits");
  assert.deepEqual([be.recent.events, be.recent.denominator, be.baseline.events, be.baseline.denominator], [174, 1020, 224, 2240]);
  assert.equal(be.material, true);
  assert.ok(be.comparison!.range.lo > 1.1);
  const a = assessConfounders(xs, ev);
  assert.deepEqual([a.changed.changed, a.changed.counted], [true, ["toolErrors", "blindEdits"]]);
  const d = a.fragility.days;
  assert.equal(d.applicable, true);
  assert.equal(d.drops.length, 3);
  assert.deepEqual([d.drops[0]!.day, d.drops[0]!.window], [addDays(TODAY, -1), "recent"]);
  assert.deepEqual(d.drops[0]!.metrics.map((m) => [m.metric, m.material]), [["toolErrors", true], ["readsPerEdit", false], ["blindEdits", false]]);
  assert.deepEqual([d.drops[0]!.changed, d.drops[0]!.survives], [false, false]);
  assert.equal(d.fragile, true);
  // Per-metric leave-one-SESSION-out does not catch it (12 sessions carry the day): only the day rule does.
  assert.deepEqual(a.fragility.fragileMetrics, []);
});

test("3 most influential days: a broad change survives every drop", () => {
  const xs = twoFamilies(false);
  const ev = evaluateAgent(xs, OPTS);
  const a = assessConfounders(xs, ev);
  assert.equal(a.changed.changed, true);
  assert.equal(a.fragility.days.drops.length, 3);
  assert.ok(a.fragility.days.drops.every((x) => x.survives));
  assert.equal(a.fragility.days.fragile, false);
  assert.equal(a.singleIndicator.kind, "changed");
});

test("not changed → the day rule does not apply; a lone Holm-surviving metric → single_indicator", () => {
  const xs = mixShift({ A: 2, B: 10 }); // tool errors only: one family can never be "changed"
  const ev = evaluateAgent(xs, OPTS);
  const a = assessConfounders(xs, ev);
  assert.deepEqual([a.changed.changed, a.fragility.days.applicable, a.fragility.days.drops], [false, false, []]);
  const n = a.singleIndicator;
  assert.deepEqual([n.kind, n.metric!.id, n.metric!.status, n.alpha, n.blocksNone], ["single_indicator", "toolErrors", "worse", 0.01, true]);
  assert.ok(n.adjustedP.toolErrors! <= 0.01);
});

// ───────────────────────────── integration: df floor ─────────────────────────────

test("df floor under a CR2 method: five very unequal sessions pass the gate but give df < 4 → low_df, counted", () => {
  // Each window: 5 sessions of 490, 200, 150, 100, 60 tool calls per day over two days (largest share 49% < 50%),
  // errors 12% recent vs 4% baseline. With session clusters + CR2 the Bell–McCaffrey df is ≈ 2.5.
  const xs: MetricExchange[] = [];
  for (const [w, base, rate] of [["r", 1, 0.12], ["b", 15, 0.04]] as const) {
    [490, 200, 150, 100, 60].forEach((size, i) => {
      for (let d = 0; d < 2; d++) {
        const day = addDays(TODAY, -(base + i * 2 + d));
        xs.push(ex({ session: `${w}${i}`, day, toolCalls: size, toolErrors: Math.round(size * rate) }));
      }
    });
  }
  const opts = { ...OPTS, method: D29_CANDIDATES["session-t95-cr2"]!, firstDay: addDays(TODAY, -42) };
  const ev = evaluateAgent(xs, opts);
  const te = tier1(ev, "toolErrors");
  assert.deepEqual([te.eligible, te.material], [true, true]); // WP-20a semantics unchanged
  const a = assessConfounders(xs, ev);
  const row = a.df.metrics.find((m) => m.metric === "toolErrors")!;
  assert.ok(row.df !== null && row.df < 4 && row.df === te.comparison!.df);
  assert.deepEqual([row.usable, row.reason, a.df.lowDf], [false, "low_df", ["toolErrors"]]);
  assert.equal(a.singleIndicator.kind, "low_df");
  // The workload check only looks at metrics "changed" can count.
  assert.deepEqual(a.workload.metrics, []);
});

// ───────────────────────────── integration: mix flags ─────────────────────────────

test("mix flags are informational: an entrypoint move of ≥ 20 pp is flagged without touching the workload rule", () => {
  // Baseline: all cli; recent: 2 of 4 sessions a day from claude-desktop (50 pp move). Prompt length 100 → 200 chars.
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 42; k++) {
    const day = addDays(TODAY, -k);
    for (let i = 0; i < 4; i++) {
      const recent = k <= 14;
      xs.push(ex({
        session: `s${i}-${day}`, day, entrypoint: recent && i < 2 ? "claude-desktop" : "cli", promptChars: recent ? 200 : 100,
        toolCalls: 50, toolErrors: recent ? 3 : 1,
      }));
    }
  }
  const ev = evaluateAgent(xs, OPTS);
  const a = assessConfounders(xs, ev);
  const mix = a.mix!;
  assert.ok(close(mix.entrypoint.move!, 0.5) && mix.entrypoint.flagged);
  assert.deepEqual([mix.promptLength.ratio, mix.promptLength.flagged], [2, true]);
  assert.deepEqual([mix.mode.move, mix.mode.flagged, mix.subagent.flagged, mix.interactive], [0, false, false, null]);
  assert.equal(mix.contextStarts.available, false);
  assert.equal(mix.anyFlagged, true);
  // The entrypoint is a stratum, so the standardisation runs over cli (the only common stratum), where the shift holds.
  assert.equal(a.workload.unclear, false);
});

test("subagent work mix (D62a): a 20 pp move of the edits from the main thread into subagents is flagged on its own", () => {
  // Every exchange spawns subagent work in both windows (the exchange share never moves). Baseline: 8 main + 2 subagent
  // edits per exchange (20% delegated); recent: 3 main + 7 subagent (70%). Hand-computed move: 0.5.
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 42; k++) {
    const day = addDays(TODAY, -k);
    const recent = k <= 14;
    for (let i = 0; i < 4; i++) {
      xs.push(ex({
        session: `s${i}-${day}`, day, toolCalls: 50, toolErrors: 1, subToolCalls: 5,
        edits: recent ? 3 : 8, subEdits: recent ? 7 : 2, reads: 10, subReads: 2,
      }));
    }
  }
  const mix = assessConfounders(xs, evaluateAgent(xs, OPTS)).mix!;
  assert.deepEqual([mix.subagent.move, mix.subagent.flagged], [0, false], "every exchange delegates in both windows");
  assert.ok(close(mix.subagentWork.move!, 0.5) && mix.subagentWork.flagged);
  assert.ok(close(mix.subagentWork.recent!.subagent!, 0.7) && close(mix.subagentWork.baseline!.main!, 0.8));
  assert.equal(mix.anyFlagged, true);
  // Without edits in a window there is no share and no flag.
  const flat = xs.map((x) => ({ ...x, edits: 0, subEdits: 0 }));
  const none = assessConfounders(flat, evaluateAgent(flat, OPTS)).mix!;
  assert.deepEqual([none.subagentWork.move, none.subagentWork.flagged], [null, false]);
});
