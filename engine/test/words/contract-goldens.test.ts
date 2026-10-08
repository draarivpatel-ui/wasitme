/**
 * Contract-golden diff (WP-22 acceptance, D59): for every valid golden in contract/fixtures the engine could produce
 * (all but `hostile-labels`, whose strings are hostile on purpose), rebuild each agent's words from SYNTHETIC facts
 * that restate the golden's numbers and story (contract/fixtures/generate.mjs: windows, metrics, events, candidates,
 * onset, observation, which events are new), assemble the documents with `buildOutputs`, and diff every engine string
 * with the golden: zero differences are allowed. The engine's words are the source of truth for golden text (D59);
 * generate.mjs holds the same sentences as literals (it has no dependencies), and this test is what keeps the two
 * from drifting. A wording change in engine/src/words means regenerating the goldens in the same commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { TraceCondition, TraceRow } from "../../src/analysis/attribution/types.js";
import { METRICS, VOTING_FAMILIES, type MetricId } from "../../src/analysis/metrics/defs.js";
import { decisionRow } from "../../src/contract/check.js";
import type { GlanceAgent } from "../../src/contract/glance.js";
import type { SnapshotAgent } from "../../src/contract/snapshot.js";
import { buildOutputs, type CandidateFact, type EventFact, type Facts, type MetricFact } from "../../src/words/index.js";
import { assertValidOutputs, ROOT } from "./helpers.js";

const FIXTURES = `${ROOT}contract/fixtures/`;
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const manifest = readJson(`${FIXTURES}manifest.json`) as { fixtures: { file: string; contract: string; valid: boolean; covers: string[] }[] };
const TODAY = "2026-10-04";

// ───────────────────────────── the golden story, restated as facts ─────────────────────────────

/** generate.mjs `E`: the values behind each golden event label (the glance shape carries no from/to). */
const EVENTS: Record<string, Pick<EventFact, "kind" | "side" | "strength" | "provenance" | "from" | "to" | "tripwire">> = {
  "Claude Code 2.1.262 → 2.1.266": { kind: "version", side: "agent", strength: "routine", provenance: "log_field", from: "2.1.262", to: "2.1.266", tripwire: null },
  "Claude Code 2.1.266 → 2.1.270": { kind: "version", side: "agent", strength: "routine", provenance: "log_field", from: "2.1.266", to: "2.1.270", tripwire: null },
  "Claude Code 2.1.270 → 2.1.274": { kind: "version", side: "agent", strength: "routine", provenance: "log_field", from: "2.1.270", to: "2.1.274", tripwire: null },
  "Effort high → medium": { kind: "effort", side: "you", strength: "strong", provenance: "command", from: "high", to: "medium", tripwire: null },
  "Served model differs from the one you picked": { kind: "served-model", side: "agent", strength: "strong", provenance: "log_field", from: "opus-5-5", to: "h:5e7a91c2", tripwire: "served_model" },
  "Model opus-5 → opus-5-5 (no command recorded)": { kind: "model", side: "unknown", strength: "weak", provenance: "log_field", from: "opus-5", to: "opus-5-5", tripwire: null },
  "Claude Code 2.1.274 → 2.1.277": { kind: "version", side: "agent", strength: "routine", provenance: "log_field", from: "2.1.274", to: "2.1.277", tripwire: null },
  "MCP server added": { kind: "mcp", side: "you", strength: "strong", provenance: "settings_snapshot", from: "5", to: "6", tripwire: null },
  "Claude Code 2.1.277 → 2.1.281": { kind: "version", side: "agent", strength: "routine", provenance: "log_field", from: "2.1.277", to: "2.1.281", tripwire: null },
  "Settings changed": { kind: "config", side: "you", strength: "weak", provenance: "settings_snapshot", from: "h:0c1d2e3f", to: "h:4a5b6c7d", tripwire: null },
  "Codex 0.158 → 0.160": { kind: "version", side: "agent", strength: "routine", provenance: "log_field", from: "0.158", to: "0.160", tripwire: null },
  "Model gpt-6 → gpt-6-luna": { kind: "model", side: "you", strength: "strong", provenance: "settings_snapshot", from: "gpt-6", to: "gpt-6-luna", tripwire: null },
  "AGENTS.md changed": { kind: "instructions", side: "you", strength: "strong", provenance: "settings_snapshot", from: "h:1f2e3d4c", to: "h:9a8b7c6d", tripwire: null },
};

type Story = {
  row: number;
  counted?: string[];
  onset?: [string, string];
  /** golden event label → candidate class/status/test. */
  candidates?: [string, CandidateFact["class"], CandidateFact["status"], CandidateFact["test"]][];
  observation?: [number, number];
  blindSpot?: boolean;
  recheck?: Facts["recheck"];
  boundaryProjects?: number;
  single?: [string, number];
  mixed?: { worse: string[]; better: string[] };
  workload?: string[];
  /** Voting metrics the golden's topMetrics leave out (from its progress.unlock). */
  extraIneligible?: { id: string; family: "errors" | "research"; shortSessions: number }[];
};

/** Per (agent|state|reason): the parts of generate.mjs's case that only its `detail` (or its prose) states. */
const STORIES: Record<string, Story> = {
  "claude-code|insufficient|needs_data": {
    row: 2,
    extraIneligible: [{ id: "blindEdits", family: "research", shortSessions: 1 }],
  },
  "claude-code|none|null": { row: 13 },
  "claude-code|unclear|both_sides": {
    row: 6, counted: ["toolErrors", "blindEdits"], onset: ["2026-09-19", "2026-09-25"],
    candidates: [["Effort high → medium", "you_strong", "open", null], ["Served model differs from the one you picked", "agent_strong", "open", null]],
  },
  "claude-code|you|null": {
    row: 7, counted: ["toolErrors", "readsPerEdit", "blindEdits"], onset: ["2026-09-19", "2026-09-23"],
    candidates: [["Effort high → medium", "you_strong", "open", null]],
  },
  "claude-code|agent|null": {
    row: 8, counted: ["toolErrors", "blindEdits"], onset: ["2026-09-28", "2026-10-02"], observation: [9, 5], blindSpot: true,
    candidates: [
      ["Served model differs from the one you picked", "agent_strong", "open", null],
      ["Claude Code 2.1.277 → 2.1.281", "agent_routine", "background", "routine"],
      ["Settings changed", "you_weak", "background", null],
    ],
  },
  "claude-code|insufficient|single_indicator": { row: 12, single: ["toolErrors", 2.29] },
  "claude-code|unclear|mixed": { row: 3, mixed: { worse: ["toolErrors"], better: ["readsPerEdit"] } },
  "claude-code|unclear|workload": { row: 4, counted: ["toolErrors", "blindEdits"], workload: ["projects_differ"] },
  "claude-code|unclear|unknown_provenance": {
    row: 5, counted: ["toolErrors", "blindEdits"], onset: ["2026-09-19", "2026-09-25"],
    candidates: [["Model opus-5 → opus-5-5 (no command recorded)", "unknown", "open", null]],
  },
  "claude-code|unclear|nothing_recorded_on_your_side": {
    row: 10, counted: ["toolErrors", "blindEdits"], onset: ["2026-09-28", "2026-10-03"], observation: [6, 0],
    candidates: [["Claude Code 2.1.277 → 2.1.281", "agent_routine", "background", "routine"]],
  },
  "claude-code|unclear|blind_spot": {
    row: 11, counted: ["toolErrors", "blindEdits"], onset: ["2026-09-16", "2026-09-22"], observation: [0, 7], blindSpot: true,
    candidates: [["Claude Code 2.1.266 → 2.1.270", "agent_routine", "background", "routine"]],
  },
  "claude-code|agent|by_elimination": {
    row: 9, counted: ["toolErrors", "blindEdits"], onset: ["2026-09-29", "2026-10-03"], observation: [5, 0], boundaryProjects: 2,
    candidates: [
      ["Claude Code 2.1.277 → 2.1.281", "agent_routine", "open", "version_boundary"],
      ["Settings changed", "you_weak", "background", null],
    ],
  },
  "codex|insufficient|calibration_pending": { row: 1 },
};

/**
 * The decision table's trace for a story, mirroring `decideTable` (attribution/decide.ts): rows are checked in order,
 * each stops at its first failing condition, and the last row is the matched one. The conditions' values come from
 * the story's candidates and observation, so each unmatched row names the condition that really failed for it (a
 * by-elimination case fails rows 6 and 7 at "nothing strong on your side", not at the agent's side). The simulation
 * must land on the golden's row, which also checks the story's candidate classes against the golden's state.
 */
function decisionTrace(story: Story, f: { candidates: CandidateFact[]; observation: Facts["observation"]; metrics: MetricFact[]; calibrated: boolean }): TraceRow[] {
  const counted = (story.counted ?? []) as MetricId[];
  const changedHolds = story.row >= 4 && story.row <= 11;
  const trace: TraceRow[] = [];
  const row = (n: number, ...conds: TraceCondition[]): boolean => {
    const conditions: TraceCondition[] = [];
    for (const c of conds) {
      conditions.push(c);
      if (!c.holds) break;
    }
    const matched = conditions.length === conds.length && conditions.every((c) => c.holds);
    trace.push({ row: n, matched, conditions });
    return matched;
  };
  const done = (n: number): TraceRow[] => {
    assert.equal(n, story.row, "the synthetic decision table lands on the golden's row");
    return trace;
  };
  const ids = (cs: CandidateFact[]) => cs.map((c) => c.event);
  const youOpen = f.candidates.filter((c) => c.class === "you_strong" && c.status === "open");
  const youRuledOut = f.candidates.filter((c) => c.class === "you_strong" && c.status === "ruled_out");
  const agentStrong = f.candidates.filter((c) => c.class === "agent_strong");
  const unknown = f.candidates.filter((c) => c.class === "unknown");
  const background = f.candidates.filter((c) => c.status === "background" || c.status === "ruled_out");
  const fully = f.observation.scope === "onset" && f.observation.partiallyObservedDays === 0;
  const obs = { fullyObservedDays: f.observation.fullyObservedDays, partiallyObservedDays: f.observation.partiallyObservedDays, partialByDesign: f.observation.partialByDesign };
  const changed = (): TraceCondition => ({ id: "changed", holds: changedHolds, metrics: changedHolds ? counted : [], detail: { side: changedHolds ? "worse" : null, fragileDays: false } });

  if (row(1, { id: "not_calibrated", holds: !f.calibrated })) return done(1);
  const missing = VOTING_FAMILIES.filter((fam) => !f.metrics.some((m) => m.role === "vote" && m.family === fam && m.eligible));
  if (row(2, { id: "family_without_eligible_metric", holds: missing.length > 0, detail: { families: [...missing] } })) return done(2);
  const worse = story.mixed?.worse ?? [], better = story.mixed?.better ?? [];
  if (row(3, { id: "mixed", holds: story.mixed !== undefined, metrics: [...worse, ...better] as MetricId[], detail: { worse, better } })) return done(3);
  const reasons = story.workload ?? [];
  if (row(4, changed(), { id: "workload", holds: reasons.length > 0, detail: { reasons } })) return done(4);
  if (row(5, changed(), { id: "unknown_candidate", holds: unknown.length > 0, events: ids(unknown) })) return done(5);
  const youOpenCond = (): TraceCondition => ({ id: "you_strong_open", holds: youOpen.length > 0, events: ids(youOpen), detail: { ruledOut: ids(youRuledOut) } });
  if (row(6, changed(), youOpenCond(), { id: "agent_strong", holds: agentStrong.length > 0, events: ids(agentStrong) })) return done(6);
  if (row(7, changed(), youOpenCond(), { id: "no_agent_strong", holds: agentStrong.length === 0 })) return done(7);
  if (row(8, changed(), { id: "agent_strong", holds: agentStrong.length > 0, events: ids(agentStrong) }, { id: "no_you_strong_open", holds: youOpen.length === 0, detail: { ruledOut: ids(youRuledOut) } })) return done(8);
  const onlyRoutine = (): TraceCondition => ({ id: "only_routine_or_weak", holds: unknown.length === 0 && youOpen.length === 0 && agentStrong.length === 0, events: ids(background) });
  const observed = (): TraceCondition => ({ id: "fully_observed", holds: fully, detail: obs });
  if (row(9, changed(), onlyRoutine(), observed(), { id: "version_boundary", holds: story.row === 9, detail: { reason: story.row === 9 ? null : "projects" } })) return done(9);
  if (row(10, changed(), onlyRoutine(), observed())) return done(10);
  if (row(11, changed(), onlyRoutine(), { id: "partially_observed", holds: !fully, detail: obs })) return done(11);
  assert.ok(!changedHolds, "a changed story matches one of rows 4-11");
  const notChanged: TraceCondition = { id: "not_changed", holds: true };
  if (row(12, notChanged, { id: "single_indicator", holds: story.single !== undefined, detail: { kind: story.single !== undefined ? "single_indicator" : "none_material" } })) return done(12);
  if (row(13, notChanged, { id: "no_material", holds: true }, { id: "sensitive_each_family", holds: true })) return done(13);
  row(14, { id: "otherwise", holds: true });
  return done(14);
}

function metricFromGolden(g: any): MetricFact {
  const eligible = g.status !== "ineligible";
  const material = eligible && g.range !== null && (g.range[0] > 1 || g.range[1] < 1) && Math.abs(Math.log(g.ratio)) >= Math.log(1.25);
  return {
    id: g.id, family: g.family ?? "context", role: g.role, scale: g.id === "readsPerEdit" ? 1 : 100,
    eligible, ineligibleReason: eligible ? null : "too_few_events", fieldsMissing: false, material,
    sensitive: eligible && g.mde !== null && g.mde <= 2, usable: eligible, familywise: material, direction: material ? (g.ratio > 1 ? "up" : "down") : null,
    status: g.status, ratio: eligible ? g.ratio : null, range: eligible ? g.range : null, mde: eligible ? g.mde : null,
    recent: { k: g.recent.k, n: g.recent.n, sessions: 0, sessionDays: 0 }, baseline: { k: g.baseline.k, n: g.baseline.n, sessions: 0, sessionDays: 0 },
    daily: [], standardized: null, pace: null, shortfall: null,
  };
}

function eventsFromGolden(a: any): EventFact[] {
  const list: any[] = a.timeline ?? a.events;
  return list.map((e, i) => {
    const v = EVENTS[e.label];
    assert.ok(v !== undefined, `unknown golden event label ${e.label}`);
    return { id: e.id ?? `g-${e.day}-${e.kind}-${i}`, t: e.t ?? `${e.day}T14:00:00Z`, day: e.day, ...v, derived: false };
  }).sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
}

function factsFor(a: any): Facts {
  const key = `${a.agent}|${a.state}|${a.reason}`;
  const story = STORIES[key];
  assert.ok(story !== undefined, `no story for ${key}`);
  const events = eventsFromGolden(a);
  const byLabel = (label: string) => events.find((e) => (EVENTS[label]!.kind === e.kind && EVENTS[label]!.from === e.from && EVENTS[label]!.to === e.to))!;
  // The snapshot lists every indicator; the glance only its top three. The engine keeps metrics in display order.
  const metrics = ((a.metrics ?? a.topMetrics) as any[]).map(metricFromGolden);
  for (const x of story.extraIneligible ?? []) {
    const shortfall: MetricFact["shortfall"] = { window: "recent", checks: [{ id: "sessions", have: 4, need: 5, shortSessions: x.shortSessions, shortSessionDays: 1 }] };
    const have = metrics.find((m) => m.id === x.id);
    if (have) have.shortfall = shortfall;
    else metrics.push({ ...metricFromGolden({ id: x.id, family: x.family, role: "vote", status: "ineligible", ratio: null, range: null, mde: null, recent: { k: 0, n: 0 }, baseline: { k: 0, n: 0 } }), shortfall });
  }
  const order = (id: string) => METRICS.findIndex((m) => m.id === id);
  metrics.sort((x, y) => order(x.id) - order(y.id));
  const p = a.progress;
  const n = a.n;
  const candidates: CandidateFact[] = (story.candidates ?? []).map(([label, cls, status, testName]) => {
    const e = byLabel(label);
    return { event: e.id, kind: e.kind, side: e.side, class: cls, status, test: testName, day: e.day, undated: false, tripwire: e.tripwire, from: e.from, to: e.to };
  });
  const observation: Facts["observation"] = story.observation
    ? { fullyObservedDays: story.observation[0], partiallyObservedDays: story.observation[1], partialByDesign: false, scope: "onset" }
    : { fullyObservedDays: a.calibrated ? 14 : 0, partiallyObservedDays: a.calibrated ? 0 : 9, partialByDesign: a.agent === "codex", scope: "window" };
  return {
    agent: a.agent, today: TODAY, state: a.state, reason: a.reason, row: story.row, pending: a.pending, calibrated: a.calibrated,
    tier: a.calibrated ? 1 : null, history: { days: 60, selection: "ready" },
    windows: {
      recent: { from: "2026-09-20", to: "2026-10-03", days: 14, exchanges: n.exchanges, sessions: n.sessions, sessionDays: n.sessionDays, activeDays: n.days },
      baseline: { from: "2026-08-23", to: "2026-09-19", days: 28, exchanges: 0, sessions: 0, sessionDays: 0, activeDays: 0 },
      sessions: n.sessions,
    },
    metrics, errorsVote: "toolErrors",
    counted: story.counted ?? [], side: story.counted ? "worse" : null, fragileDays: false,
    mixed: story.mixed ?? null, workload: story.workload ?? [],
    single: story.single ? { metric: story.single[0], ratio: story.single[1] } : null,
    holmKind: story.row === 12 ? "single_indicator" : null, materialVoting: story.single ? [story.single[0]] : [],
    onset: story.onset ? { from: story.onset[0], to: story.onset[1] } : null, peak: story.onset ? story.onset[0] : null,
    candidates,
    observation,
    blindSpot: story.blindSpot === true,
    boundary: story.row === 9 ? { event: byLabel("Claude Code 2.1.277 → 2.1.281").id, projects: story.boundaryProjects ?? null } : null,
    progress: p === null ? null : {
      // D66: with SHOW_DATES off, factsOf turns every "eta" and "not_at_current_pace" projection into "no_date" (no date,
      // no not-at-pace claim), so the goldens' facts carry exactly that.
      // The golden's own etaDate / notAtCurrentPace are NOT restated: the built progress must come out equal to the golden's.
      tier: p.tier, reason: "no_date", etaDate: null, notAtCurrentPace: false, readyToday: false,
      unlock: (p.unlock as any[]).map((u) => ({ metric: u.metric, family: u.family, state: "ineligible" as const, fieldsMissing: false, have: u.have, need: u.need, shortSessions: u.need.sessions - u.have.sessions, shortSessionDays: u.need.sessionDays - u.have.sessionDays, blocking: ["sessions", "sessionDays"] })),
    },
    recheck: story.recheck ?? null,
    trace: decisionTrace(story, { candidates, observation, metrics, calibrated: a.calibrated }),
    events,
    confounders: [],
    gate: { minSessions: 5, minSessionDays: 10, minEvents: 10 },
  };
}

/** Events the golden marks `new: true` are the ones missing from `knownEventIds` (that is what "+n" counts). */
function knownEventIdsFor(a: any, facts: Facts): string[] {
  const list: any[] = a.timeline ?? a.events;
  const fresh = new Set(facts.events.filter((e) => list.some((g) => g.new === true && g.day === e.day && g.kind === e.kind)).map((e) => e.id));
  return facts.events.map((e) => e.id).filter((id) => !fresh.has(id));
}

// ───────────────────────────── the diff ─────────────────────────────

function diffAgent(golden: any, built: GlanceAgent | SnapshotAgent, snapshot: boolean): Map<string, { golden: string; engine: string }> {
  const out = new Map<string, { golden: string; engine: string }>();
  const cmp = (field: string, g: unknown, e: unknown) => {
    if (g !== e) out.set(field, { golden: String(g), engine: String(e) });
  };
  for (const f of ["label", "headline", "because", "tryThis", "confidence", "band", "statusLine"] as const) cmp(f, golden[f], built[f]);
  // Progress as the engine writes it (D66/D72: no etaDate, never "not at your current pace" in v1).
  cmp("progress", JSON.stringify(golden.progress), JSON.stringify(built.progress));
  // The counts behind the confidence line: sessions are distinct across both windows (D59), the rest add up.
  for (const k of ["exchanges", "sessions", "sessionDays", "days"] as const) cmp(`n.${k}`, golden.n[k], built.n[k]);
  const key = (e: any) => `${e.day} ${e.kind}`;
  for (const ge of golden.events) {
    cmp(`events[${key(ge)}]`, ge.label, built.events.find((x) => key(x) === key(ge))?.label);
    cmp(`events[${key(ge)}].new`, ge.new, built.events.find((x) => key(x) === key(ge))?.new);
  }
  for (const gm of golden.topMetrics) {
    const bm = built.topMetrics.find((x) => x.id === gm.id);
    if (bm === undefined) continue; // which three metrics lead is a layout choice, not copy
    cmp(`topMetrics.${gm.id}.label`, gm.label, bm.label);
    cmp(`topMetrics.${gm.id}.unit`, gm.unit, bm.unit);
  }
  if (snapshot) {
    const s = built as SnapshotAgent;
    cmp("disclaimer", golden.disclaimer, s.disclaimer);
    cmp("observation.note", golden.observation.note, s.observation.note);
    for (const ge of golden.timeline) cmp(`timeline[${key(ge)}]`, ge.label, s.timeline.find((x) => key(x) === key(ge))?.label);
    for (const gm of golden.metrics) {
      const bm = s.metrics.find((x) => x.id === gm.id);
      if (bm === undefined) continue;
      cmp(`metrics.${gm.id}.label`, gm.label, bm.label);
      cmp(`metrics.${gm.id}.unit`, gm.unit, bm.unit);
    }
    cmp("trace.rows", JSON.stringify(golden.trace.map((t: any) => [t.row, t.matched])), JSON.stringify(s.trace.map((t) => [t.row, t.matched])));
    for (const gt of golden.trace) cmp(`trace[row ${gt.row}].text`, gt.text, s.trace.find((x) => x.row === gt.row)?.text);
    for (const ge of golden.timeline) cmp(`timeline[${key(ge)}].new`, ge.new, s.timeline.find((x) => key(x) === key(ge))?.new);
  }
  return out;
}

const candidates = manifest.fixtures.filter((f) => f.valid && !f.covers.includes("hostile") && (f.contract === "glance" || f.contract === "snapshot"));

for (const fx of candidates) {
  test(`contract golden ${fx.file}: the engine's words equal the golden's text`, () => {
    const doc = readJson(FIXTURES + fx.file);
    if (doc.agents.length === 0) return;
    const snapshot = fx.contract === "snapshot";
    const facts = doc.agents.map((a: any) => factsFor(a));
    const out = buildOutputs({
      engine: doc.engine, generatedAt: doc.generatedAt, staleAfterSec: doc.staleAfterSec, scanOk: doc.scanOk, scanError: doc.scanError,
      demo: doc.demo, lead: doc.lead,
      agents: facts.map((f: Facts, i: number) => ({ facts: f, setup: snapshot ? doc.agents[i].setup : {}, knownEventIds: knownEventIdsFor(doc.agents[i], f) })),
      ...(snapshot ? { health: doc.health, calibration: doc.calibration } : {}),
    });
    assertValidOutputs(out, fx.file);
    doc.agents.forEach((g: any) => {
      const built = (snapshot ? out.snapshot.agents : out.glance.agents).find((x) => x.agent === g.agent)!;
      assert.equal(decisionRow(built.state, built.reason), decisionRow(g.state, g.reason));
      const diffs = [...diffAgent(g, built, snapshot)].map(([field, d]) => `${field}\n    golden: ${d.golden}\n    engine: ${d.engine}`);
      assert.deepEqual(diffs, [], `${fx.file} ${g.agent}|${g.state}|${g.reason}: golden text differs from the engine's (regenerate: node contract/fixtures/generate.mjs)`);
    });
  });
}
