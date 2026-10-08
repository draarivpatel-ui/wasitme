/**
 * WP-21 attribution: one test per decision-table row (METHOD.md §11), the required fixtures (Desktop picker, /model, a
 * version bump with degradation in ≥ 2 projects, a lone Holm-surviving metric, fragile / low_df, clock-backward
 * timestamps), persistence, tripwires and the pure units. Synthetic numbers and opaque labels only — no text, paths or real data.
 *
 * Integration tests run the whole pipeline on workloads whose shifts are far from every threshold (as 20b's tests
 * do), and assert the hand-checkable parts exactly: the row, the onset peak, the candidates and their classes, the
 * dimensions dropped, the trace shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributeAgent, checkOnsetOptions, classifyEvent, collapseVersionRepeats, dayMajorities, decide, decideTable, dropRepicks, eventDay, labelChangeEvents,
  majorityChanges, mergeEvents, ONSET_DEFAULTS, onsetInterval, PERSISTENCE_DEFAULTS, separated, servedModelTripwire, signalEvents,
  snapshotCandidates, TRIPWIRES_OFF, valueInEffect,
  type Attribution, type AttributeOptions, type AttributionEvent, type DecideInput, type Decision, type Fingerprint,
  type PersistenceData, type Verdict,
} from "../../src/analysis/attribution/index.js";
import { assessConfounders } from "../../src/analysis/confounders/assess.js";
import { D23_LITERAL, D29_CANDIDATES } from "../../src/analysis/gates/d23.js";
import type { MetricExchange } from "../../src/analysis/metrics/defs.js";
import { decisionRow } from "../../src/contract/check.js";
import { BASE, daysBack, NOW, recorded, scenario, TODAY } from "./attribution-fixtures.js";
import { addDays, ex } from "./helpers.js";

const ONSET = 10;
const ONSET_DAY = addDays(TODAY, -ONSET);
/** A clean two-family worsening: tool errors 2 → 6 of 50, blind edits 2 → 4 of 20, from ONSET_DAY on. */
const SHIFT = { onset: ONSET, errors: [2, 6] as [number, number], blind: [2, 4] as [number, number] };

const seen: Verdict[] = [];
function run(xs: readonly MetricExchange[], events: readonly AttributionEvent[] = [], over: Partial<AttributeOptions> = {}): Attribution {
  const a = attributeAgent(xs, events, { ...BASE, calibrated: true, ...over });
  seen.push(a.decision, a.decision.raw);
  return a;
}

function inputOf(a: Attribution, over: Partial<DecideInput> = {}): DecideInput {
  return { evaluation: a.evaluation, confounders: a.confounders, evidence: a.evidence, events: a.events, calibrated: true, previous: null, now: NOW, ...over };
}

function cand(d: Verdict, kind: string) {
  return d.candidates.find((c) => c.kind === kind);
}

/** Trace invariants (CONTRACT: rows in table order, exactly one matched, the last, and it yields the state). */
function assertTrace(v: Verdict): void {
  const rows = v.trace.map((r) => r.row);
  assert.equal(rows[0], 1, "trace starts at row 1");
  assert.ok(rows.every((r, i) => i === 0 || r > rows[i - 1]!), `rows strictly increasing: ${rows.join(",")}`);
  const matched = v.trace.filter((r) => r.matched);
  assert.equal(matched.length, 1, "exactly one matched row");
  assert.equal(v.trace[v.trace.length - 1], matched[0], "the matched row is the last");
  assert.equal(matched[0]!.row, v.row);
  const want = decisionRow(v.state, v.reason);
  assert.ok(want === v.row || (want === 2 && v.row === 14), `row ${v.row} gives ${v.state} (${String(v.reason)})`);
  for (const r of v.trace) {
    if (r.matched) assert.ok(r.conditions.every((c) => c.holds));
    else {
      assert.equal(r.conditions[r.conditions.length - 1]!.holds, false, `row ${r.row} stops at its failing condition`);
      assert.ok(r.conditions.slice(0, -1).every((c) => c.holds));
    }
  }
}

// ────────────────── decision-table rows (METHOD.md §11), one test each ──────────────────

test("row 1: not calibrated → insufficient (calibration_pending); timeline only, nothing else is evaluated", () => {
  const a = run(scenario(SHIFT), [], { calibrated: false });
  const d = a.decision;
  assert.deepEqual([d.state, d.reason, d.row, d.pending, d.persistence.rule], ["insufficient", "calibration_pending", 1, false, "bypass_calibration"]);
  assert.deepEqual(d.trace, [{ row: 1, matched: true, conditions: [{ id: "not_calibrated", holds: true }] }]);
  assert.deepEqual([a.evidence.onset, a.evidence.ruleOut, a.evidence.boundary], [null, [], null]);
  assert.equal(d.onset, null);
  assertTrace(d);
});

test("row 2: some voting family has no eligible voting metric (short history; no edits) → insufficient (needs_data)", () => {
  const short = run(scenario({ ...SHIFT, days: 30 }));
  assert.equal(short.evaluation.selectedTier, null);
  assert.deepEqual([short.decision.state, short.decision.reason, short.decision.row], ["insufficient", "needs_data", 2]);
  const noEdits = run(scenario({ ...SHIFT, label: () => ({ edits: 0, reads: 0, blindEdits: 0 }) }));
  assert.equal(noEdits.decision.row, 2);
  assert.deepEqual(noEdits.decision.trace[1]!.conditions[0]!.detail!.families, ["research"]);
  assertTrace(short.decision);
});

test("row 3: material voting metrics disagree in direction → unclear (mixed)", () => {
  // Tool errors 2 → 6 (worse); blind edits 4 → 2 of 20 (better).
  const a = run(scenario({ onset: ONSET, errors: [2, 6], blind: [4, 2] }));
  assert.deepEqual(a.confounders.changed.worse, ["toolErrorsNonCmd"]);
  assert.deepEqual(a.confounders.changed.better, ["blindEdits"]);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["unclear", "mixed", 3]);
  assert.equal(a.decision.onset, null); // onset is only computed after "changed"
});

test("row 4: changed, but only the project mix moved (Simpson) → unclear (workload)", () => {
  // Baseline days run 3 A + 1 B sessions, recent days 1 A + 3 B; within each project the rates never move
  // (A: 1 error, 1 blind edit; B: 5 and 5). Raw: tool errors 4% → 8%, blind edits 10% → 20%.
  const projects = (after: boolean, i: number) => (after ? ["p-A", "p-B", "p-B", "p-B"] : ["p-A", "p-A", "p-A", "p-B"])[i]!;
  const xs = scenario({
    onset: 14,
    label: (after, i) => {
      const p = projects(after, i);
      const v = p === "p-A" ? 1 : 5;
      return { project: p, toolErrors: v, toolErrorsEdit: v, blindEdits: v };
    },
  });
  const a = run(xs);
  assert.equal(a.confounders.changed.changed, true);
  assert.equal(a.confounders.workload.unclear, true);
  assert.ok(a.confounders.workload.reasons.includes("standardised_lost"));
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["unclear", "workload", 4]);
});

test("row 5 (Desktop picker): effort moved between sessions with no command and no settings diff → unclear (unknown_provenance)", () => {
  // No recorded event at all: the only trace of the switch is the Exchange label, derived as unknown · weak.
  const a = run(scenario({ ...SHIFT, label: (after) => ({ effort: after ? "medium" : "high" }) }));
  const c = cand(a.decision, "effort")!;
  assert.deepEqual([c.side, c.strength, c.class, c.status, c.day], ["unknown", "weak", "unknown", "open", ONSET_DAY]);
  assert.equal(a.events.find((e) => e.kind === "effort")!.derived, true);
  assert.deepEqual(a.evidence.dims, ["project", "model", "entrypoint"]); // unknown events never drop a dimension
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["unclear", "unknown_provenance", 5]);
  assertTrace(a.decision);
});

test("Desktop picker, model: an unrecorded model switch keeps the model stratum → unclear (workload) at row 4", () => {
  const a = run(scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) }));
  const c = cand(a.decision, "model")!;
  assert.deepEqual([c.side, c.class, c.status], ["unknown", "unknown", "open"]);
  assert.deepEqual(a.evidence.dropped, []);
  assert.ok(a.evidence.dims.includes("model"));
  assert.equal(a.decision.state, "unclear");
  assert.deepEqual([a.decision.reason, a.decision.row], ["workload", 4]);
});

test("row 6: a strong change on your side that isn't ruled out AND an admitted agent-strong one → unclear (both_sides)", () => {
  const xs = scenario({ ...SHIFT, label: (after) => (after ? { effort: "medium", servedModel: "m-x", steps: 6 } : { effort: "high" }) });
  const effort = recorded({ id: "e-effort", kind: "effort", side: "you", from: "high", to: "medium", day: ONSET_DAY });
  const a = run(xs, [effort], { decide: { tripwires: { servedModel: true } } });
  const you = cand(a.decision, "effort")!, agent = cand(a.decision, "served-model")!;
  assert.deepEqual([you.event, you.class, you.status], ["e-effort", "you_strong", "open"]);
  const ro = a.evidence.ruleOut.find((r) => r.event === "e-effort")!;
  assert.deepEqual([ro.dimension, ro.held, ro.attempted, ro.ruledOut, ro.reason], ["effort", "high", true, false, "shift_not_shown"]);
  assert.deepEqual([agent.class, agent.tripwire, agent.admitted, agent.status], ["agent_strong", "served_model", true, "open"]);
  // The recorded /effort explains the label change, so no derived `unknown` effort event exists.
  assert.equal(a.events.filter((e) => e.kind === "effort").length, 1);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["unclear", "both_sides", 6]);
  assertTrace(a.decision);
});

test("row 7 (D53): a /model command switch → you, because the model stratum is dropped before the workload test", () => {
  const xs = scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) });
  const cmd = recorded({ id: "e-model", kind: "model", side: "you", from: "m1", to: "m2", day: ONSET_DAY });
  const a = run(xs, [cmd]);
  assert.deepEqual(a.evidence.dropped, [{ dim: "model", events: ["e-model"] }]);
  assert.deepEqual(a.evidence.dims, ["project", "entrypoint"]);
  assert.deepEqual(a.confounders.dims, ["project", "entrypoint"]);
  // Without D53 the standardisation would erase the user's own change (row 4).
  assert.equal(assessConfounders(xs, a.evaluation).workload.unclear, true);
  assert.equal(a.confounders.workload.unclear, false);
  const c = cand(a.decision, "model")!;
  assert.deepEqual([c.event, c.class, c.status, c.test], ["e-model", "you_strong", "open", null]);
  assert.equal(a.events.filter((e) => e.kind === "model").length, 1, "the next sessions on m2 add no derived unknown event");
  assert.equal(a.evidence.onset!.peak, ONSET_DAY);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["you", null, 7]);
  assert.deepEqual(a.decision.onset, { from: addDays(ONSET_DAY, -3), to: addDays(ONSET_DAY, 3) });
  assertTrace(a.decision);
});

test("row 8: an admitted served≠requested tripwire, nothing open on your side → agent (+ blind spot when partially observed)", () => {
  const xs = scenario({ ...SHIFT, label: (after) => (after ? { servedModel: "m-x", steps: 6 } : {}) });
  const partial = run(xs, [], { decide: { tripwires: { servedModel: true } } });
  assert.deepEqual([partial.decision.state, partial.decision.reason, partial.decision.row, partial.decision.blindSpot], ["agent", null, 8, true]);
  const full = run(xs, [], { decide: { tripwires: { servedModel: true } }, fullyObservedDays: daysBack(70) });
  assert.deepEqual([full.decision.row, full.decision.blindSpot], [8, false]);
  assertTrace(partial.decision);
});

test("tripwires are OFF by default: the same served≠requested data is context only → row 11, never agent", () => {
  const xs = scenario({ ...SHIFT, label: (after) => (after ? { servedModel: "m-x", steps: 6 } : {}) });
  const a = run(xs);
  const c = cand(a.decision, "served-model")!;
  assert.deepEqual([c.class, c.tripwire, c.admitted, c.status, c.test], ["context", "served_model", false, "background", null]);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["unclear", "blind_spot", 11]);
});

test("row 9 (D33): a version bump with degradation in ≥ 2 projects on fully observed days → agent (by_elimination)", () => {
  const xs = scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) });
  const a = run(xs, [], { fullyObservedDays: daysBack(70) });
  const b = a.evidence.boundary!;
  assert.deepEqual([b.boundary, b.boundaries, b.observed, b.passes, b.reason], [ONSET_DAY, 1, true, true, "passes"]);
  assert.deepEqual(b.pre, { from: addDays(ONSET_DAY, -7), to: addDays(ONSET_DAY, -1) });
  assert.deepEqual(b.post, { from: ONSET_DAY, to: addDays(ONSET_DAY, 6) });
  assert.deepEqual(b.projects.map((p) => [p.metric, p.qualifying, p.agreeing, p.holds]), [["toolErrorsNonCmd", 2, 2, true], ["blindEdits", 2, 2, true]]);
  const v = cand(a.decision, "version")!;
  assert.deepEqual([v.side, v.strength, v.class, v.status, v.test], ["agent", "routine", "agent_routine", "open", "version_boundary"]);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["agent", "by_elimination", 9]);
  // CONTRACT checkSnapshot: by_elimination needs fully observed days and a version_boundary candidate.
  assert.equal(a.decision.observation.partiallyObservedDays, 0);
  assert.ok(snapshotCandidates(a.decision).some((c) => c.test === "version_boundary"));
  assertTrace(a.decision);
});

test("row 10: only a routine update, fully observed, but the boundary test fails (one project) → unclear (nothing_recorded_on_your_side)", () => {
  const xs = scenario({ ...SHIFT, project: () => "p-A", label: (after) => ({ version: after ? "1.1" : "1.0" }) });
  const a = run(xs, [], { fullyObservedDays: daysBack(70) });
  assert.deepEqual([a.evidence.boundary!.reason, a.evidence.boundary!.projects[0]!.qualifying], ["projects", 1]);
  const v = cand(a.decision, "version")!;
  assert.deepEqual([v.status, v.test], ["background", "routine"]);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["unclear", "nothing_recorded_on_your_side", 10]);
  assertTrace(a.decision);
});

test("version-boundary test: two bumps inside I, or unobserved ±7-day windows, fail it → row 10", () => {
  const two = scenario({ ...SHIFT, label: (_after, _i, k) => ({ version: k <= ONSET - 2 ? "1.2" : k <= ONSET ? "1.1" : "1.0" }) });
  const a = run(two, [], { fullyObservedDays: daysBack(70) });
  assert.deepEqual([a.evidence.boundary!.boundaries, a.evidence.boundary!.reason], [2, "several_boundaries"]);
  assert.deepEqual([a.decision.reason, a.decision.row], ["nothing_recorded_on_your_side", 10]);
  // I fully observed, but not the days the ±7-day comparison reads.
  const one = scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) });
  const onlyI = daysBack(ONSET + 3).slice(0, 7); // TODAY − 13 … TODAY − 7 = I
  const b = run(one, [], { fullyObservedDays: onlyI });
  assert.deepEqual(b.decision.onset, { from: onlyI[0], to: onlyI[6] });
  assert.deepEqual([b.decision.observation.partiallyObservedDays, b.evidence.boundary!.reason], [0, "not_observed"]);
  assert.deepEqual([b.decision.reason, b.decision.row], ["nothing_recorded_on_your_side", 10]);
});

test("row 11: the same as row 9 on partially observed days → unclear (blind_spot); Codex is partial by design", () => {
  const xs = scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) });
  const a = run(xs);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row, a.decision.blindSpot], ["unclear", "blind_spot", 11, true]);
  assert.equal(a.evidence.boundary!.reason, "not_observed");
  assert.equal(a.decision.observation.partiallyObservedDays, 7);
  // Codex: no hooks, scans never read project folders — rows 9–10 are unreachable even with every day "observed".
  const cx = scenario({ ...SHIFT, label: (after) => ({ agent: "codex", version: after ? "0.161" : "0.160" }) });
  const c = run(cx, [], { agent: "codex", fullyObservedDays: daysBack(70) });
  assert.equal(c.evidence.partialByDesign, true);
  assert.deepEqual([c.decision.state, c.decision.reason, c.decision.row], ["unclear", "blind_spot", 11]);
  assertTrace(c.decision);
});

test("row 12: one voting metric moved and survives Holm → insufficient (single_indicator), naming it", () => {
  const a = run(scenario({ onset: ONSET, errors: [2, 6] }));
  assert.equal(a.confounders.singleIndicator.kind, "single_indicator");
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["insufficient", "single_indicator", 12]);
  assert.equal(a.decision.singleIndicator!.metric, "toolErrorsNonCmd");
  assert.ok(a.decision.singleIndicator!.ratio > 2);
  assertTrace(a.decision);
});

test("row 13: nothing moved and every voting family has a sensitive, usable voting metric → none", () => {
  const a = run(scenario({}));
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["none", null, 13]);
  assert.equal(a.decision.onset, null);
  assertTrace(a.decision);
});

test("row 14 (fragile): a change resting on one day is not changed → insufficient (needs_data), never none", () => {
  // Tool errors 2 → 6 in every recent session; blind edits move only on yesterday (12 sessions × 8 of 20).
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 60; k++) {
    const day = addDays(TODAY, -k);
    const recent = k <= 14;
    const n = recent ? (k === 1 ? 12 : 3) : 4;
    for (let i = 0; i < n; i++) {
      const e = recent ? 6 : 2;
      xs.push(ex({
        session: `s${i}-${day}`, day, project: i % 2 === 0 ? "p-A" : "p-B", toolCalls: 50, cmdCalls: 0, toolErrors: e, toolErrorsEdit: e,
        toolErrorsCmd: 0, edits: 20, reads: 40, blindEdits: recent && k === 1 ? 8 : 2,
      }));
    }
  }
  const a = run(xs);
  assert.deepEqual([a.confounders.changed.changed, a.confounders.fragility.days.fragile], [true, true]);
  const changedRow = a.decision.trace.find((r) => r.row === 4)!;
  assert.deepEqual([changedRow.conditions[0]!.id, changedRow.conditions[0]!.holds, changedRow.conditions[0]!.detail!.fragileDays], ["changed", false, true]);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["insufficient", "needs_data", 14]);
  assertTrace(a.decision);
});

test("row 14 (low_df): a lone material metric below the df floor is not usable → insufficient (needs_data)", () => {
  // Five very unequal sessions per window under a session-cluster CR2 method (20b's df case) give df < 4.
  const xs: MetricExchange[] = [];
  for (const [w, base, rate] of [["r", 1, 0.12], ["b", 15, 0.04]] as const) {
    [490, 200, 150, 100, 60].forEach((size, i) => {
      for (let d = 0; d < 2; d++) {
        const day = addDays(TODAY, -(base + i * 2 + d));
        const e = Math.round(size * rate);
        xs.push(ex({ session: `${w}${i}`, day, toolCalls: size, cmdCalls: 0, toolErrors: e, toolErrorsEdit: e, toolErrorsCmd: 0, edits: 40, reads: 80, blindEdits: 4 }));
      }
    });
  }
  const a = run(xs, [], { method: D29_CANDIDATES["session-t95-cr2"]!, firstDay: addDays(TODAY, -42) });
  assert.equal(a.confounders.singleIndicator.kind, "low_df");
  assert.deepEqual(a.confounders.df.lowDf, ["toolErrorsNonCmd"]);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["insufficient", "needs_data", 14]);
});

// ───────────────────────────── rule-out, events, D53, determinism ─────────────────────────────

test("rule-out by strata: a you·strong effort change whose shift also shows at the old effort is ruled out → by elimination", () => {
  // Sessions 0–1 switch to medium at the onset, sessions 2–3 stay on high; errors rise in all of them.
  const xs = scenario({ ...SHIFT, label: (after, i) => ({ effort: after && i < 2 ? "medium" : "high", version: after ? "1.1" : "1.0" }) });
  const effort = recorded({ id: "e-effort", kind: "effort", side: "you", from: "high", to: "medium", day: ONSET_DAY });
  const a = run(xs, [effort], { fullyObservedDays: daysBack(70) });
  const ro = a.evidence.ruleOut[0]!;
  assert.deepEqual([ro.event, ro.attempted, ro.ruledOut, ro.reason, ro.changed!.side], ["e-effort", true, true, "ruled_out", "worse"]);
  const c = cand(a.decision, "effort")!;
  assert.deepEqual([c.status, c.test], ["ruled_out", "strata"]);
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["agent", "by_elimination", 9]);
});

test("rule-out never applies to kinds without an Exchange field, nor to an unusable old value", () => {
  const xs = scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) });
  const mcp = recorded({ id: "e-mcp", kind: "mcp", side: "you", from: "5", to: "6", day: ONSET_DAY, provenance: "settings_snapshot" });
  const eff = recorded({ id: "e-eff", kind: "effort", side: "you", from: "unknown", to: "low", day: ONSET_DAY });
  const a = run(xs, [mcp, eff], { fullyObservedDays: daysBack(70) });
  assert.deepEqual(a.evidence.ruleOut.map((r) => [r.event, r.attempted, r.reason]).sort(), [["e-eff", false, "old_value_unknown"], ["e-mcp", false, "not_holdable"]]);
  assert.deepEqual([a.decision.state, a.decision.row], ["you", 7]);
});

test("only events inside I are candidates; meta is skipped; an undated decisive event counts as unknown", () => {
  const xs = scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) });
  const old = recorded({ id: "e-old", kind: "mcp", side: "you", from: "5", to: "6", day: addDays(TODAY, -40) });
  const meta = recorded({ id: "e-meta", kind: "config", side: "meta", strength: "routine", from: "a", to: "b", day: ONSET_DAY });
  const a = run(xs, [old, meta], { fullyObservedDays: daysBack(70) });
  assert.deepEqual(a.decision.candidates.map((c) => c.kind), ["version"]);
  assert.equal(a.decision.row, 9);
  const undated = recorded({ id: "e-undated", kind: "mcp", side: "you", from: "5", to: "6", day: "not-a-day", t: "not-a-time" });
  const b = run(xs, [undated], { fullyObservedDays: daysBack(70) });
  const u = b.decision.candidates.find((c) => c.event === "e-undated")!;
  assert.deepEqual([u.undated, u.class, u.status, u.day], [true, "unknown", "open", null]);
  assert.deepEqual([b.decision.reason, b.decision.row], ["unknown_provenance", 5]);
  // The boundary test still passes here, but the update did not decide: it stays background.
  assert.equal(b.evidence.boundary!.passes, true);
  assert.deepEqual([cand(b.decision, "version")!.status, cand(b.decision, "version")!.test], ["background", "routine"]);
  assert.ok(!snapshotCandidates(b.decision).some((c) => c.event === "e-undated"));
  // A bad `day` but a valid `t` is dated by `t` in the evaluation's zone.
  const byT = recorded({ id: "e-by-t", kind: "mcp", side: "you", from: "5", to: "6", day: "garbage", t: `${ONSET_DAY}T08:00:00Z` });
  const c = run(xs, [byT], { fullyObservedDays: daysBack(70) });
  assert.deepEqual([cand(c.decision, "mcp")!.day, c.decision.row], [ONSET_DAY, 7]);
});

test("D53 is enforced: decide refuses an assessment that still stratifies on a dimension your /model change requires dropping", () => {
  const xs = scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) });
  const cmd = recorded({ id: "e-model", kind: "model", side: "you", from: "m1", to: "m2", day: ONSET_DAY });
  const a = run(xs, [cmd]);
  assert.throws(() => decide(inputOf(a, { confounders: assessConfounders(xs, a.evaluation) })), /D53/);
});

test("decide is pure: the same input gives the same output, and the pipeline is deterministic", () => {
  const xs = scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) });
  const a = run(xs, [], { fullyObservedDays: daysBack(70) });
  const input = inputOf(a);
  assert.deepEqual(decide(input), decide(input));
  assert.deepEqual(decide(input), a.decision);
  const b = run([...xs].reverse(), [], { fullyObservedDays: [...daysBack(70)].reverse() });
  assert.deepEqual(b.decision, a.decision);
});

test("clock-backward timestamps: exchange and event times running backward change nothing (days decide)", () => {
  const label = (after: boolean) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" });
  const sane = scenario({ ...SHIFT, label });
  const cmd = recorded({ id: "e-model", kind: "model", side: "you", from: "m1", to: "m2", day: ONSET_DAY });
  // Every exchange's `t` now runs backward in time as the days advance, and lies years away from its day.
  const back = sane.map((x, i) => ({ ...x, t: new Date(Date.parse("2030-01-01T00:00:00Z") - i * 3_600_000).toISOString() }));
  const cmdBack = { ...cmd, t: "2019-06-01T00:00:00.000Z" };
  const a = run(sane, [cmd]), b = run(back, [cmdBack]);
  for (const k of ["state", "reason", "row", "onset"] as const) assert.deepEqual(b.decision[k], a.decision[k]);
  assert.deepEqual(b.decision.candidates.map((c) => [c.event, c.class, c.status]), a.decision.candidates.map((c) => [c.event, c.class, c.status]));
  assert.equal(b.evidence.onset!.peak, ONSET_DAY);
  // Persistence with `now` before the anchor re-anchors instead of confirming or throwing.
  const none = run(scenario({}));
  const pending = decide(inputOf(a, { previous: none.decision }));
  const earlier = decide(inputOf(a, { previous: pending, now: new Date(NOW.getTime() - 86_400_000 * 3) }));
  assert.deepEqual([earlier.pending, earlier.state, earlier.persistence.rule], [true, "none", "pending_reanchored"]);
  assert.equal(earlier.persistence.candidate!.since.now, new Date(NOW.getTime() - 86_400_000 * 3).toISOString());
});

// ───────────────────────────── persistence ─────────────────────────────

test("persistence: a new outcome is held (pending) until a second evaluation ≥ 24 h later with enough new data agrees", () => {
  const youRun = run(scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) }),
    [recorded({ id: "e-model", kind: "model", side: "you", from: "m1", to: "m2", day: ONSET_DAY })]);
  const noneRun = run(scenario({}));
  assert.equal(youRun.decision.raw.state, "you");

  // First evaluation with the new outcome: the glance holds `none`.
  const p1 = decide(inputOf(youRun, { previous: noneRun.decision }));
  assert.deepEqual([p1.state, p1.reason, p1.pending, p1.raw.state, p1.persistence.rule], ["none", null, true, "you", "pending"]);
  assert.deepEqual(p1.trace, noneRun.decision.trace, "the held state keeps its own trace (CONTRACT: trace yields the shown state)");
  assertTrace(p1);
  // 12 h later: too soon.
  const p2 = decide(inputOf(youRun, { previous: p1, now: new Date(NOW.getTime() + 12 * 3_600_000) }));
  assert.deepEqual([p2.state, p2.pending, p2.persistence.candidate!.since.now], ["none", true, NOW.toISOString()]);
  // 48 h later but no new data (same recent window): still pending.
  const later = new Date(NOW.getTime() + 48 * 3_600_000);
  const p3 = decide(inputOf(youRun, { previous: p2, now: later }));
  assert.deepEqual([p3.state, p3.pending], ["none", true]);
  // 48 h later with 5 new days (4 sessions each): ≥ 30% new denominator for every voting metric, ≥ 2 session-days.
  const p = youRun.evidence.persistence;
  const shift = (d: string) => addDays(d, 5);
  const fresh = [0, 1, 2, 3, 4].map((k) => ({ d: addDays(TODAY, k), sessionDays: 4, den: { toolErrorsNonCmd: 200, readsPerEdit: 80, blindEdits: 80 } }));
  const evidence2 = { ...youRun.evidence, persistence: { ...p, recent: { from: shift(p.recent.from), to: shift(p.recent.to) }, daily: [...p.daily, ...fresh] } };
  const p4 = decide(inputOf(youRun, { previous: p3, now: later, evidence: evidence2 }));
  assert.deepEqual([p4.state, p4.pending, p4.persistence.rule, p4.row], ["you", false, "confirmed", 7]);
  assertTrace(p4);
  // A third outcome in between resets the wait.
  const other = run(scenario({ ...SHIFT, label: (after) => ({ effort: after ? "medium" : "high" }) }));
  const reset = decide(inputOf(other, { previous: p3, now: later }));
  assert.deepEqual([reset.state, reset.pending, reset.persistence.candidate!.reason, reset.persistence.candidate!.since.now], ["none", true, "unknown_provenance", later.toISOString()]);
  // Getting the displayed outcome again clears the wait.
  const back = decide(inputOf(noneRun, { previous: p3, now: later }));
  assert.deepEqual([back.state, back.pending, back.persistence.candidate, back.persistence.rule], ["none", false, null, "same"]);
});

test("version events: one per new version (earliest day, then id — the boundary test's pick), `from` chained, ids untouched", () => {
  const v = (id: string, day: string, from: string, to: string, extra: Partial<AttributionEvent> = {}): AttributionEvent =>
    recorded({ id, kind: "version", side: "agent", strength: "routine", provenance: "log_field", from, to, day, ...extra });
  const d = (k: number) => addDays(TODAY, -k);
  const events = [
    v("d-a", d(30), "1.0", "1.1", { derived: true }),
    v("e-b", d(29), "1.0", "1.1"), // a resumed session records the same update a day later
    v("e-c", d(20), "1.1", "1.2"),
    v("e-d", d(20), "1.1", "1.2"), // two sessions, same day: the smaller id wins
    v("e-e", d(15), "1.1", "1.4"), // a session that started on 1.1 records the next update with a stale `from`
    v("e-f", d(12), "1.4", "1.3"), // back to an older version (a parallel install): a new `to`, kept
    recorded({ id: "e-g", kind: "effort", side: "you", from: "high", to: "medium", day: d(14) }),
    v("e-h", "", "9.9", "1.1", { t: "not a time" }), // undated: passes through untouched
  ];
  const merged = mergeEvents("claude-code", "UTC", events);
  const out = collapseVersionRepeats("claude-code", merged, "UTC");
  assert.deepEqual(out.map((e) => [e.id, e.from, e.to]), [
    ["d-a", "1.0", "1.1"], ["e-c", "1.1", "1.2"], ["e-e", "1.2", "1.4"], ["e-g", "high", "medium"], ["e-f", "1.4", "1.3"], ["e-h", "9.9", "1.1"],
  ]);
  assert.equal(events[4]!.from, "1.1", "input events are not mutated");
  // Another agent's or a non-agent-side version event is never touched.
  const codex = { ...events[1]!, agent: "codex" as AttributionEvent["agent"] };
  assert.deepEqual(collapseVersionRepeats("claude-code", [events[0]!, codex], "UTC"), [events[0]!, codex]);
  // Decision-neutral where it matters: the boundary test picks the same event and day with or without the repeats.
  const xs = scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) });
  const once = [v("e-one", ONSET_DAY, "1.0", "1.1")];
  const twice = [...once, v("e-two", addDays(ONSET_DAY, 1), "1.0", "1.1"), v("e-three", addDays(ONSET_DAY, 2), "1.0", "1.1")];
  const a = run(xs, once), b = run(xs, twice);
  assert.deepEqual([b.decision.state, b.decision.reason, b.decision.row], [a.decision.state, a.decision.reason, a.decision.row]);
  assert.deepEqual(b.evidence.boundary, a.evidence.boundary);
  assert.equal(b.events.filter((e) => e.kind === "version" && e.to === "1.1").length, 1, "one 1.1 update in the timeline");
});

test("persistence: an agent that went quiet leaves a held outcome for 'too early to tell' after 24 h, never 'confirming' forever", () => {
  // The same logs evaluated weeks after the last session: every recent window is empty, so the raw outcome is
  // insufficient (needs_data). No new session-day can ever arrive to confirm that move under the data rule.
  const xs = scenario({});
  const held = run(xs);
  assert.equal(held.decision.state, "none");
  const t1 = new Date(NOW.getTime() + 40 * 86_400_000);
  const q1 = run(xs, [], { now: t1, previous: held.decision });
  assert.deepEqual([q1.decision.raw.state, q1.decision.raw.reason], ["insufficient", "needs_data"]);
  assert.deepEqual([q1.decision.state, q1.decision.pending, q1.decision.persistence.rule], ["none", true, "pending"], "the first quiet evaluation anchors the move");
  const q2 = run(xs, [], { now: new Date(t1.getTime() + 12 * 3_600_000), previous: q1.decision });
  assert.deepEqual([q2.decision.state, q2.decision.pending], ["none", true], "12 h later: too soon");
  const q3 = run(xs, [], { now: new Date(t1.getTime() + 25 * 3_600_000), previous: q2.decision });
  assert.deepEqual([q3.decision.state, q3.decision.reason, q3.decision.pending, q3.decision.persistence.rule], ["insufficient", "needs_data", false, "confirmed_quiet"]);
  assertTrace(q3.decision);
  // Only a move TO insufficient (needs_data) is confirmed on time alone: data arriving on even one new day keeps the
  // normal rule (here 1 session-day < 2), and a move to a finding never takes this path (the "you" test above holds
  // at 48 h with no new data).
  const p = q3.evidence.persistence;
  const freshDay = { d: addDays(q2.decision.persistence.candidate!.since.recent.to, 1), sessionDays: 1, den: {} };
  assert.ok(freshDay.d <= p.recent.to, "the new day lies inside the confirming window");
  const busy = decide(inputOf(q3, { previous: q2.decision, now: new Date(t1.getTime() + 25 * 3_600_000), evidence: { ...q3.evidence, persistence: { ...p, daily: [...p.daily, freshDay] } } }));
  assert.deepEqual([busy.state, busy.pending, busy.persistence.rule], ["none", true, "pending"]);
});

test("persistence: row 1 bypasses it both ways; `previous = null` and `persistence: false` show the raw outcome", () => {
  const xs = scenario(SHIFT);
  const quiet = run(scenario({}));
  const off = decide(inputOf(quiet, { calibrated: false, previous: quiet.decision, evidence: { ...quiet.evidence, calibrated: false } }));
  assert.deepEqual([off.state, off.reason, off.pending, off.persistence.rule], ["insufficient", "calibration_pending", false, "bypass_calibration"]);
  const on = decide(inputOf(quiet, { previous: off }));
  assert.deepEqual([on.state, on.pending, on.persistence.rule], ["none", false, "bypass_calibration"]);
  const first = run(xs);
  assert.deepEqual([first.decision.pending, first.decision.persistence.rule], [false, "first"]);
  const live = decide(inputOf(first, { previous: quiet.decision, options: { persistence: false } }));
  assert.deepEqual([live.state, live.pending, live.persistence.rule], [first.decision.state, false, "disabled"]);
});

test("separated(): 24 h in data time, ≥ 2 new session-days and ≥ 30% new denominator for every voting metric", () => {
  const anchor: Fingerprint = { now: "2026-10-01T12:00:00.000Z", today: "2026-10-01", recent: { from: "2026-09-17", to: "2026-09-30" }, den: { toolErrors: 1000, blindEdits: 100 } };
  const cur = (now: string, to: string): Fingerprint => ({ ...anchor, now, recent: { from: "x", to } });
  const data = (rows: [string, number, number, number][]): PersistenceData =>
    ({ recent: { from: "x", to: "y" }, den: {}, daily: rows.map(([d, s, te, be]) => ({ d, sessionDays: s, den: { toolErrors: te, blindEdits: be } })) });
  const p = PERSISTENCE_DEFAULTS;
  const enough = data([["2026-09-30", 9, 999, 99], ["2026-10-01", 1, 150, 15], ["2026-10-02", 1, 150, 15]]);
  assert.deepEqual(separated(anchor, cur("2026-10-03T12:00:00.000Z", "2026-10-02"), enough, p), { ok: true, backward: false });
  assert.deepEqual(separated(anchor, cur("2026-10-02T11:59:59.000Z", "2026-10-02"), enough, p), { ok: false, backward: false }); // < 24 h
  assert.deepEqual(separated(anchor, cur("2026-09-30T12:00:00.000Z", "2026-10-02"), enough, p), { ok: false, backward: true });
  const oneDay = data([["2026-10-01", 1, 400, 40]]);
  assert.equal(separated(anchor, cur("2026-10-03T12:00:00.000Z", "2026-10-02"), oneDay, p).ok, false); // 1 session-day
  const thin = data([["2026-10-01", 2, 400, 29], ["2026-10-02", 1, 0, 0]]);
  assert.equal(separated(anchor, cur("2026-10-03T12:00:00.000Z", "2026-10-02"), thin, p).ok, false); // blind edits 29% < 30%
});

// ───────────────────────────── pure units ─────────────────────────────

const ev = (over: Partial<AttributionEvent>): AttributionEvent =>
  ({ id: "e", t: "2026-09-01T00:00:00Z", day: "2026-09-01", agent: "claude-code", kind: "model", side: "you", from: "a", to: "b", evidence: "log", strength: "strong", provenance: "command", ...over });

test("classifyEvent: the METHOD.md §9 side × strength table, tripwires off by default, prompt hashes as context", () => {
  const on = { servedModel: true, vendorTemplate: true, cacheMiss: true };
  const c = (e: Partial<AttributionEvent>, t = TRIPWIRES_OFF) => classifyEvent(ev(e), t).class;
  assert.equal(c({ side: "meta", strength: "routine" }), "meta");
  assert.equal(c({ side: "you", strength: "strong" }), "you_strong");
  assert.equal(c({ side: "you", strength: "weak" }), "you_weak");
  assert.equal(c({ side: "you", strength: undefined }), "unknown");
  assert.equal(c({ side: "unknown", strength: "weak" }), "unknown");
  assert.equal(c({ side: "bogus" as never }), "unknown");
  assert.equal(c({ kind: "version", side: "agent", strength: "routine" }), "agent_routine");
  assert.equal(c({ kind: "version", side: "agent", strength: "strong" }), "agent_routine");
  assert.equal(c({ kind: "config", side: "agent", strength: "strong" }), "context");
  assert.equal(c({ kind: "system-prompt", side: "unknown", strength: "weak" }), "context");
  assert.equal(c({ kind: "system-prompt", side: "agent", strength: "routine" }), "agent_routine");
  assert.equal(c({ kind: "served-model", side: "agent", strength: "strong" }), "context");
  assert.equal(c({ kind: "served-model", side: "agent", strength: "strong" }, on), "agent_strong");
  assert.equal(c({ kind: "system-prompt", side: "agent", strength: "strong" }), "context");
  assert.equal(c({ kind: "system-prompt", side: "agent", strength: "strong" }, on), "agent_strong");
  assert.equal(c({ kind: "system-prompt", side: "agent", strength: "strong", tripwire: "cache_miss" }, { ...TRIPWIRES_OFF, cacheMiss: true }), "agent_strong");
  assert.equal(c({ kind: "system-prompt", side: "agent", strength: "strong", tripwire: "cache_miss" }, { ...TRIPWIRES_OFF, vendorTemplate: true }), "context");
  assert.equal(c({ kind: "served-model", side: "unknown", strength: "weak" }, on), "context");
});

test("eventDay / mergeEvents: day first, then t, then id; other agents and duplicate ids dropped; order-independent", () => {
  assert.equal(eventDay({ day: "2026-09-01", t: "garbage" }, "UTC"), "2026-09-01");
  assert.equal(eventDay({ day: "2026-02-31", t: "2026-09-02T23:30:00Z" }, "America/Chicago"), "2026-09-02");
  assert.equal(eventDay({ day: "", t: "2026-09-03T03:00:00Z" }, "America/Chicago"), "2026-09-02");
  assert.equal(eventDay({ day: "x", t: "y" }, "UTC"), null);
  const xs = [
    ev({ id: "c", day: "2026-09-02", t: "2026-01-01T00:00:00Z" }),
    ev({ id: "a", day: "2026-09-01", t: "2026-12-01T00:00:00Z" }),
    ev({ id: "b", day: "2026-09-01", t: "2026-11-01T00:00:00Z" }),
    ev({ id: "u", day: "x", t: "y" }),
    ev({ id: "b", day: "2026-09-05" }),
    ev({ id: "o", agent: "codex" }),
  ];
  const ids = mergeEvents("claude-code", "UTC", xs).map((e) => e.id);
  assert.deepEqual(ids, ["b", "a", "c", "u"]);
  assert.deepEqual(mergeEvents("claude-code", "UTC", [...xs].reverse()).map((e) => e.id), ids);
});

test("labelChangeEvents: day-majority switches; a recorded /model explains the next sessions; versions are routine", () => {
  const day = (k: number) => addDays(TODAY, -k);
  const xs: MetricExchange[] = [];
  for (let k = 10; k >= 1; k--) {
    for (let i = 0; i < 3; i++) {
      // Model by day majority: m1 on days −10…−7, m2 on −6 (a picker), m1 again on −5 (2 of 3 exchanges), m2 on −4,
      // m3 from −3 (a recorded /model on −3). Version 1.0 → 1.1 on day −4.
      const model = k >= 7 ? "m1" : k >= 4 ? (k === 5 && i < 2 ? "m1" : "m2") : "m3";
      xs.push(ex({ session: `s${i}-${k}`, day: day(k), model, version: k >= 5 ? "1.0" : "1.1", effort: "high" }));
    }
  }
  assert.deepEqual(majorityChanges(xs, "model").map((c) => [c.day, c.from, c.to]), [
    [day(6), "m1", "m2"], [day(5), "m2", "m1"], [day(4), "m1", "m2"], [day(3), "m2", "m3"],
  ]);
  const cmd = recorded({ id: "e-m3", kind: "model", side: "you", from: "m2", to: "m3", day: day(3) });
  const out = labelChangeEvents("claude-code", xs, [cmd]);
  const models = out.filter((e) => e.kind === "model");
  assert.deepEqual(models.map((e) => [e.day, e.from, e.to, e.side, e.strength, e.provenance]), [
    [day(6), "m1", "m2", "unknown", "weak", "log_field"],
    [day(5), "m2", "m1", "unknown", "weak", "log_field"],
    [day(4), "m1", "m2", "unknown", "weak", "log_field"],
  ]);
  const versions = out.filter((e) => e.kind === "version");
  assert.deepEqual(versions.map((e) => [e.day, e.from, e.to, e.side, e.strength]), [[day(4), "1.0", "1.1", "agent", "routine"]]);
  assert.ok(out.every((e) => e.derived === true && e.id.startsWith("d-")));
  // A recorded version event on or before the derived day supersedes it.
  const rv = recorded({ id: "e-v", kind: "version", side: "agent", strength: "routine", provenance: "log_field", from: "1.0", to: "1.1", day: day(4) });
  assert.equal(labelChangeEvents("claude-code", xs, [rv]).filter((e) => e.kind === "version").length, 0);
  // Timestamps running backward change nothing: days decide.
  const back = xs.map((x, i) => ({ ...x, t: new Date(Date.parse("2031-01-01T00:00:00Z") - i * 60_000).toISOString() }));
  assert.deepEqual(labelChangeEvents("claude-code", back, [cmd]).map((e) => e.id), out.map((e) => e.id));
});

// ───────────────────────────── D65 re-picks ─────────────────────────────

/** The reader's /model or /effort typed as a session's first prompt (or after a resume): you · strong · command,
 *  from "unknown", stamped with the first response's time (`at`, "HH:MM:SS"). */
function firstPromptCommand(id: string, kind: "model" | "effort", to: string, day: string, at: string): AttributionEvent {
  return recorded({ id, kind, side: "you", from: "unknown", to, day, t: `${day}T${at}.000Z` });
}

test("re-pick (D65), first prompt: a /model that re-selects the model already in effect is not a change", () => {
  // Every day on m1 (the previous day's majority); session s0 on ONSET_DAY opens with "/model m1" (its exchange is at
  // 10:00, the first response 30 s later). The shift itself is real and the same as row 7's.
  const xs = scenario({ ...SHIFT, label: () => ({ model: "m1", servedModel: "m1" }) });
  const repick = firstPromptCommand("e-repick", "model", "m1", ONSET_DAY, "10:00:30");
  const a = run(xs, [repick], { fullyObservedDays: daysBack(70) });
  assert.deepEqual(a.repicks, ["e-repick"]);
  assert.equal(a.events.some((e) => e.id === "e-repick"), false, "the re-pick is not in the timeline");
  assert.equal(cand(a.decision, "model"), undefined, "nor a candidate");
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["unclear", "nothing_recorded_on_your_side", 10]);
  assertTrace(a.decision);
  // Kept, the same command would have decided: as a switch from another model it is row 7 (you).
  const kept = run(xs, [{ ...repick, from: "m0" }], { fullyObservedDays: daysBack(70) });
  assert.deepEqual([kept.repicks, kept.decision.state, kept.decision.row], [[], "you", 7]);
  // The same command is a re-pick of effort too: /effort high while every exchange runs at high.
  const eff = run(xs, [firstPromptCommand("e-effort", "effort", "high", ONSET_DAY, "10:00:30")], { fullyObservedDays: daysBack(70) });
  assert.deepEqual(eff.repicks, ["e-effort"]);
});

test("re-pick (D65), resume: the session's own earlier exchanges say what was in effect, before the previous day's majority", () => {
  const D = ONSET_DAY, prev = addDays(ONSET_DAY, -1);
  // The other sessions run m1 every day, so the previous day's majority is m1. Session s-r ran on m2 the day before
  // (seq 0, 1) and is resumed on D (seq 2), where the user types "/model m2" again before its first response.
  const xs = scenario({ ...SHIFT, label: () => ({ model: "m1", servedModel: "m1" }) });
  const long = [
    ex({ session: "s-r", day: prev, t: `${prev}T20:00:00.000Z`, seq: 0, model: "m2", servedModel: "m2", toolCalls: 50, edits: 20, reads: 40, blindEdits: 2, toolErrors: 2, toolErrorsEdit: 2, cmdCalls: 0, toolErrorsCmd: 0, steps: 4 }),
    ex({ session: "s-r", day: prev, t: `${prev}T21:00:00.000Z`, seq: 1, model: "m2", servedModel: "m2", toolCalls: 50, edits: 20, reads: 40, blindEdits: 2, toolErrors: 2, toolErrorsEdit: 2, cmdCalls: 0, toolErrorsCmd: 0, steps: 4 }),
    ex({ session: "s-r", day: D, t: `${D}T08:00:00.000Z`, seq: 2, model: "m2", servedModel: "m2", toolCalls: 50, edits: 20, reads: 40, blindEdits: 4, toolErrors: 6, toolErrorsEdit: 6, cmdCalls: 0, toolErrorsCmd: 0, steps: 4 }),
  ];
  const resumed = firstPromptCommand("e-resume", "model", "m2", D, "08:00:20");
  const a = run([...xs, ...long], [resumed], { fullyObservedDays: daysBack(70) });
  assert.deepEqual(a.repicks, ["e-resume"]);
  assert.equal(a.events.some((e) => e.id === "e-resume"), false);
  assert.notEqual(a.decision.state, "you");
  assertTrace(a.decision);

  // The rule's steps by hand: the session decides when it has earlier exchanges …
  const days = dayMajorities([...xs, ...long], "model");
  assert.equal(days.find((d) => d.day === prev)!.label, "m1");
  assert.equal(valueInEffect(resumed, "model", [...xs, ...long], days, "UTC"), "m2");
  // … else the previous day's majority (a resumed file is a new session: its replayed history belongs to the old one) …
  const fresh = [...xs, ex({ ...long[2]!, session: "s-new", seq: 0 })];
  assert.equal(valueInEffect(resumed, "model", fresh, dayMajorities(fresh, "model"), "UTC"), "m1");
  assert.deepEqual(dropRepicks("claude-code", fresh, [resumed], "UTC").dropped, [], "m1 was in effect: /model m2 is a real switch");
  // … a known `from` (an in-session switch) is the answer whatever the exchanges say, so inference can never drop it …
  const inSession = recorded({ id: "e-in", kind: "model", side: "you", from: "m1", to: "m2", day: D, t: `${D}T08:00:20.000Z` });
  assert.equal(valueInEffect(inSession, "model", [...xs, ...long], days, "UTC"), "m1");
  assert.deepEqual(dropRepicks("claude-code", [...xs, ...long], [inSession], "UTC").dropped, []);
  // … and with nothing before it there is nothing to re-pick.
  const first = xs.filter((x) => x.day === D);
  assert.equal(valueInEffect(firstPromptCommand("e-0", "model", "m1", D, "10:00:30"), "model", first, dayMajorities(first, "model"), "UTC"), null);
  // Only recorded you · strong model / effort events are ever dropped.
  const weak = recorded({ id: "e-w", kind: "model", side: "unknown", strength: "weak", provenance: "log_field", from: "unknown", to: "m1", day: D });
  const mode = recorded({ id: "e-mode", kind: "mode", side: "you", from: "unknown", to: "default", day: D });
  assert.deepEqual(dropRepicks("claude-code", xs, [weak, mode], "UTC").kept.map((e) => e.id), ["e-w", "e-mode"]);
});

test("re-pick (D65), a real switch still counts: a first-prompt /model to a model not in effect → you (row 7)", () => {
  // m1 before ONSET_DAY, m2 from it; session s0 on ONSET_DAY opens with "/model m2" (from "unknown": first prompt).
  const xs = scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) });
  const cmd = firstPromptCommand("e-switch", "model", "m2", ONSET_DAY, "10:00:30");
  const a = run(xs, [cmd]);
  assert.deepEqual(a.repicks, []);
  const c = cand(a.decision, "model")!;
  assert.deepEqual([c.event, c.class, c.status], ["e-switch", "you_strong", "open"]);
  assert.equal(a.events.filter((e) => e.kind === "model").length, 1, "the command explains the day-majority move (no derived unknown)");
  assert.deepEqual([a.decision.state, a.decision.reason, a.decision.row], ["you", null, 7]);
  assertTrace(a.decision);
});

test("dayMajorities / majorityChanges: the refactor keeps the day-majority changes exactly", () => {
  const day = (k: number) => addDays(TODAY, -k);
  const xs: MetricExchange[] = [];
  for (let k = 6; k >= 1; k--) for (let i = 0; i < 3; i++) xs.push(ex({ session: `s${i}-${k}`, day: day(k), model: k >= 4 ? "m1" : i === 0 ? "m1" : "m2" }));
  assert.deepEqual(dayMajorities(xs, "model").map((d) => [d.day, d.label]), [6, 5, 4, 3, 2, 1].map((k) => [day(k), k >= 4 ? "m1" : "m2"]));
  assert.deepEqual(majorityChanges(xs, "model").map((c) => [c.day, c.from, c.to]), [[day(3), "m1", "m2"]]);
});

test("servedModelTripwire: ≥ 5 consecutive mismatched requests in ≥ 2 sessions; routing, stubs and short runs excluded", () => {
  const mk = (session: string, seq: number, served: string, steps: number, model = "m", day = "2026-09-20") =>
    ex({ session, seq, day, model, servedModel: served, steps, t: `2026-01-0${(seq % 9) + 1}T00:00:00Z` });
  const two = [mk("s1", 0, "x", 3), mk("s1", 1, "x", 2), mk("s2", 0, "x", 5)];
  const out = servedModelTripwire("claude-code", two);
  assert.deepEqual(out.map((e) => [e.kind, e.side, e.strength, e.from, e.to, e.tripwire, e.day]), [["served-model", "agent", "strong", "m", "x", "served_model", "2026-09-20"]]);
  assert.equal(servedModelTripwire("claude-code", [mk("s1", 0, "x", 6)]).length, 0, "one session is not enough");
  assert.equal(servedModelTripwire("claude-code", [mk("s1", 0, "x", 4), mk("s2", 0, "x", 4)]).length, 0, "runs of 4 requests");
  // A matching exchange in between breaks the run (seq order, whatever the timestamps say).
  assert.equal(servedModelTripwire("claude-code", [mk("s1", 0, "x", 3), mk("s1", 1, "m", 3), mk("s1", 2, "x", 3), mk("s2", 0, "x", 5)]).length, 0);
  assert.equal(servedModelTripwire("claude-code", [mk("s1", 0, "x", 9, "opusplan"), mk("s2", 0, "x", 9, "opusplan")]).length, 0);
  assert.equal(servedModelTripwire("claude-code", [mk("s1", 0, "<synthetic>", 9), mk("s2", 0, "<synthetic>", 9)]).length, 0);
});

test("signalEvents: vendor-template / cache_miss signals need ≥ 2 sessions and ≥ 5 requests; your own tools change explains a cache miss", () => {
  const s = { day: "2026-09-20", t: "2026-09-20T10:00:00Z", sessions: 2, requests: 5, from: "h:aaaa", to: "h:bbbb" };
  const ok = signalEvents("claude-code", [{ tripwire: "vendor_template", ...s }, { tripwire: "cache_miss", ...s }], []);
  assert.deepEqual(ok.map((e) => [e.kind, e.side, e.strength, e.tripwire]), [["system-prompt", "agent", "strong", "vendor_template"], ["system-prompt", "agent", "strong", "cache_miss"]]);
  assert.equal(signalEvents("claude-code", [{ tripwire: "vendor_template", ...s, sessions: 1 }], []).length, 0);
  assert.equal(signalEvents("claude-code", [{ tripwire: "cache_miss", ...s, requests: 4 }], []).length, 0);
  const mcp = recorded({ id: "e-mcp", kind: "mcp", side: "you", from: "1", to: "2", day: "2026-09-20" });
  assert.equal(signalEvents("claude-code", [{ tripwire: "cache_miss", ...s }], [mcp]).length, 0);
});

test("onsetInterval: Z by hand for one split; peak, core and I with ±2 and the guard; fallback when nothing qualifies", () => {
  // Two days, two session-day clusters each, K/(K−1) inflation, Poisson floor, split d = day 2:
  //   before: (1/10, 3/10) → N 4, D 20; Σu² = (1/4 − ½)² + (3/4 − ½)² = 0.125; ×2 = 0.25 > floor 1/4.5 → 0.25
  //   after:  (5/10, 7/10) → N 12, D 20; Σu² = 2/144; ×2 = 1/36 < floor 1/12.5 = 0.08 → 0.08
  //   θ = ln(12.5/20) − ln(4.5/20) = ln(12.5/4.5); Z = θ / √0.33.
  const method = { ...D23_LITERAL, keepLargerSe: false };
  const cells = [
    { session: "a", day: "2026-09-01", num: 1, den: 10 }, { session: "b", day: "2026-09-01", num: 3, den: 10 },
    { session: "c", day: "2026-09-02", num: 5, den: 10 }, { session: "e", day: "2026-09-02", num: 7, den: 10 },
  ];
  const o = onsetInterval([{ metric: "toolErrors", sign: 1, floor: "poisson", cells }], { from: "2026-09-01", to: "2026-09-02" }, method, { ...ONSET_DEFAULTS, minSessionDays: 2 });
  assert.equal(o.profile.length, 1);
  assert.ok(Math.abs(o.profile[0]!.z! - Math.log(12.5 / 4.5) / Math.sqrt(0.33)) < 1e-12);
  assert.deepEqual([o.localized, o.peak, o.interval], [true, "2026-09-02", { from: "2026-09-01", to: "2026-09-02" }]);
  // A 30-day step at day 20 (4 sessions a day): the peak is the step; I = core ∪ peak ± 2, then the 1-day guard.
  const step: { session: string; day: string; num: number; den: number }[] = [];
  for (let k = 0; k < 30; k++) {
    const day = addDays("2026-08-01", k);
    for (let i = 0; i < 4; i++) step.push({ session: `s${i}-${k}`, day, num: (k >= 20 ? 6 : 2) + [-1, 1, 0, 0][i]!, den: 50 });
  }
  const s = onsetInterval([{ metric: "toolErrors", sign: 1, floor: "binomial", cells: step }], { from: "2026-08-01", to: "2026-08-30" }, D23_LITERAL, ONSET_DEFAULTS);
  assert.equal(s.peak, "2026-08-21");
  const lo = [s.core!.from, addDays(s.peak!, -2)].sort()[0]!, hi = [s.core!.to, addDays(s.peak!, 2)].sort()[1]!;
  assert.deepEqual(s.interval, { from: addDays(lo, -1), to: addDays(hi, 1) });
  // Clock-backward-proof: shuffling cells changes nothing.
  assert.deepEqual(onsetInterval([{ metric: "toolErrors", sign: 1, floor: "binomial", cells: [...step].reverse() }], { from: "2026-08-01", to: "2026-08-30" }, D23_LITERAL, ONSET_DEFAULTS), s);
  // Too few session-days on every split → not localized; I is the whole span.
  const thin = onsetInterval([{ metric: "toolErrors", sign: 1, floor: "binomial", cells: cells.slice(0, 2) }], { from: "2026-09-01", to: "2026-09-10" }, D23_LITERAL, ONSET_DEFAULTS);
  assert.deepEqual([thin.localized, thin.peak, thin.interval], [false, null, { from: "2026-09-01", to: "2026-09-10" }]);
  assert.throws(() => checkOnsetOptions({ ...ONSET_DEFAULTS, halfWidth: 1.5 }), /halfWidth/);
  assert.throws(() => checkOnsetOptions({ ...ONSET_DEFAULTS, delta: -1 }), /delta/);
});

test("decideTable rejects mismatched inputs instead of guessing", () => {
  const a = run(scenario({}));
  assert.throws(() => decideTable(inputOf(a, { now: new Date(Number.NaN) })), /now/);
  assert.throws(() => decideTable(inputOf(a, { evidence: { ...a.evidence, today: "2026-10-03" } })), /today/);
  assert.throws(() => decideTable(inputOf(a, { evidence: { ...a.evidence, agent: "codex" } })), /agent/);
  assert.throws(() => decideTable(inputOf(a, { evidence: { ...a.evidence, calibrated: false } })), /uncalibrated/);
});

test("every decision produced above satisfies the CONTRACT trace rules", () => {
  assert.ok(seen.length > 20);
  for (const v of seen) assertTrace(v);
  const rows = new Set(seen.map((v) => v.row));
  for (let r = 1; r <= 14; r++) assert.ok(rows.has(r), `row ${r} was reached by some fixture`);
});

/** A typed no-op so the Decision type stays exercised by the compiler. */
export const _decisionShape: (d: Decision) => boolean = (d) => typeof d.pending === "boolean";
