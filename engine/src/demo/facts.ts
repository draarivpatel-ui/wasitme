/**
 * `wasitme demo`: engine output over ANALYTIC input. design/system/demo-data.v3.json (embedded in data.ts, held equal to
 * the source by engine/test/output/design-sync.test.ts) holds hand-set numbers for five Claude Code findings and a
 * Codex timeline-only agent. This module restates them as `Facts` (what the words layer reads) and runs the engine's own
 * `buildOutputs`, so every word on screen is the engine's (D59), not the design file's prose, and every document
 * validates and lints like real output. Output carries `demo: true`; nothing is read from the user's machine and
 * nothing is written (D21: README and launch images come from here, never mixed with real data).
 *
 * The only things taken from the demo file are numbers, days, event kinds and sides. Provenance, strength, the decision
 * table's trace and the confounders are the stories the file's `_why` fields describe (METHOD.md §11 rows 1, 2, 6, 7,
 * 9 and 13).
 */
import type { TraceCondition, TraceRow } from "../analysis/attribution/types.js";
import { VOTING_FAMILIES, type MetricId } from "../analysis/metrics/defs.js";
import type { Confounder, Health } from "../contract/snapshot.js";
import type { IneligibleReason } from "../contract/vocab.js";
import { contractCalibration, readCalibration, SHIPPED_CALIBRATION } from "../store/calflags.js";
import { SCAN_ERRORS_VOTE } from "../store/settings.js";
import { currentVersions, healthParserVersions } from "../store/versions.js";
import type { AgentId } from "../types.js";
import { buildOutputs, SHOW_DATES, type BuiltOutputs, type CandidateFact, type EventFact, type Facts, type MetricFact } from "../words/index.js";
import { DEMO_JSON } from "./data.js";

export const DEMO_CASES = ["insufficient", "none", "unclear", "you", "agent", "codex"] as const;
export type DemoCase = (typeof DEMO_CASES)[number];

const TODAY = "2026-10-04";
const GENERATED_AT = "2026-10-04T14:14:00Z";

interface DemoMetric {
  id: string; family: string; eligible: boolean; status?: string; ratio?: number; range?: [number, number]; mde?: number;
  recent: { k?: number; n?: number; reads?: number; edits?: number }; baseline: { k?: number; n?: number; reads?: number; edits?: number };
  ineligibleReason?: string;
}
interface DemoEvent { day: string; side: string; kind: string; label: string; routine?: boolean; marker: string; short?: string; strength?: string; candidate?: boolean; shift?: boolean }
interface DemoCaseData {
  agent: string; state: string; reason?: string;
  n: { recent: { exchanges: number; sessions: number; sessionDays: number; activeDays: number }; baseline: { exchanges: number; sessions: number; sessionDays: number; activeDays: number }; total: { sessions: number } };
  metrics?: DemoMetric[];
  timeline: DemoEvent[];
  daily?: { baseline: { d: string; k: number; n: number }[]; recent: { d: string; k: number; n: number }[] };
  progress?: { etaDate?: string; have?: number; need?: number };
}
interface DemoFile { windows: { recent: { from: string; to: string; days: number }; baseline: { from: string; to: string; days: number } }; cases: Record<string, DemoCaseData> }

let parsed: DemoFile | undefined;
function data(): DemoFile {
  parsed ??= JSON.parse(DEMO_JSON) as DemoFile;
  return parsed;
}

// ───────────────────────────── events ─────────────────────────────

function eventFact(e: DemoEvent, i: number, agent: string): EventFact {
  const id = `g-${e.day}-${e.kind}-${i}`;
  const base = { id, t: `${e.day}T14:00:00Z`, day: e.day, derived: false, tripwire: null as EventFact["tripwire"] };
  const arrow = /(\S+) → (\S+)$/.exec(e.label);
  const from = arrow?.[1] ?? "", to = arrow?.[2] ?? "";
  if (e.kind === "version") return { ...base, kind: "version", side: "agent", strength: "routine", provenance: "log_field", from, to };
  if (e.kind === "effort") return { ...base, kind: "effort", side: "you", strength: "strong", provenance: "command", from, to };
  if (e.kind === "mcp") return { ...base, kind: "mcp", side: "you", strength: "strong", provenance: "settings_snapshot", from: "5", to: "6" };
  if (e.kind === "model" && e.side === "agent") {
    return { ...base, kind: "served-model", side: "agent", strength: "strong", provenance: "log_field", from: agent === "codex" ? "gpt-6" : "opus-5-5", to: "h:5e7a91c2", tripwire: "served_model" };
  }
  return { ...base, kind: "model", side: e.side === "you" ? "you" : "unknown", strength: e.side === "you" ? "strong" : "weak", provenance: "settings_snapshot", from, to };
}

// ───────────────────────────── metrics ─────────────────────────────

const REASON: Readonly<Record<string, IneligibleReason>> = { readsPerEdit: "too_few_edits" };

function metricFact(m: DemoMetric, daily: { d: string; k: number; n: number }[]): MetricFact {
  const reads = m.id === "readsPerEdit";
  const kn = (w: DemoMetric["recent"]) => ({ k: reads ? (w.reads ?? 0) : (w.k ?? 0), n: reads ? (w.edits ?? 0) : (w.n ?? 0), sessions: 0, sessionDays: 0 });
  const eligible = m.eligible;
  const moved = eligible && m.status === "moved";
  const up = (m.ratio ?? 1) > 1;
  const status: MetricFact["status"] = !eligible ? "ineligible" : !moved ? "none" : reads ? (up ? "better" : "worse") : up ? "worse" : "better";
  return {
    id: m.id, family: m.family as MetricFact["family"], role: m.family === "friction" ? "support" : "vote", scale: reads ? 1 : 100, eligible,
    ineligibleReason: eligible ? null : (REASON[m.id] ?? "too_few_events"), fieldsMissing: false, material: moved, sensitive: eligible && (m.mde ?? 99) <= 2,
    usable: eligible, familywise: moved, direction: moved ? (up ? "up" : "down") : null, status,
    ratio: eligible ? (m.ratio ?? null) : null, range: eligible ? (m.range ?? null) : null, mde: eligible ? (m.mde ?? null) : null,
    recent: kn(m.recent), baseline: kn(m.baseline), daily: m.id === "toolErrors" ? daily : [], standardized: null, pace: null, shortfall: null,
  };
}

// ───────────────────────────── the decision table's trace ─────────────────────────────

interface Story {
  row: number;
  counted?: string[];
  onset?: [string, string];
  candidates?: [kind: string, day: string, cls: CandidateFact["class"], status: CandidateFact["status"], test: CandidateFact["test"]][];
  observation?: [number, number];
  boundary?: { kind: string; day: string; projects: number };
  recheck?: Facts["recheck"];
  progress?: boolean;
  /** The outcome to show when it is not the demo file's own (the file predates the shipped calibration). */
  outcome?: [state: Facts["state"], reason: Facts["reason"]];
}

const STORIES: Record<DemoCase, Story> = {
  insufficient: { row: 2, progress: true },
  none: { row: 13 },
  unclear: {
    row: 6, counted: ["toolErrors", "blindEdits"], onset: ["2026-09-19", "2026-09-25"], observation: [14, 0],
    candidates: [["effort", "2026-09-21", "you_strong", "open", null], ["served-model", "2026-09-23", "agent_strong", "open", null]],
    recheck: { kind: "eta", days: 35, sessions: 13, date: "2026-11-08" },
  },
  you: {
    row: 7, counted: ["toolErrors", "readsPerEdit", "blindEdits"], onset: ["2026-09-19", "2026-09-23"], observation: [14, 0],
    candidates: [["effort", "2026-09-21", "you_strong", "open", null]],
    recheck: { kind: "eta", days: 35, sessions: 13, date: "2026-11-08" },
  },
  agent: {
    row: 9, counted: ["toolErrors", "blindEdits"], onset: ["2026-09-21", "2026-09-25"], observation: [5, 0],
    candidates: [["version", "2026-09-23", "agent_routine", "open", "version_boundary"]],
    boundary: { kind: "version", day: "2026-09-23", projects: 2 },
  },
  // Codex is calibrated in the shipped artifact (D69), so its demo is what a light Codex user sees now: too early to
  // tell, with the demo file's own gap (8 of the 10 session-days a comparison needs). Row 1 ("Timeline only") is no
  // longer an outcome of this release, so the demo — the source of launch images (D21) — does not show it.
  codex: { row: 2, progress: true, outcome: ["insufficient", "needs_data"] },
};

/**
 * The re-check estimate a story would show. D66: no projected dates in v1, so it is shown only when the words layer
 * shows dates (SHOW_DATES), exactly as for a real run — the demo must never print an estimate the engine cannot give.
 */
const recheckOf = (s: Story): Facts["recheck"] => (SHOW_DATES ? (s.recheck ?? null) : null);

/** The decision table's trace for a story: rows are checked in order, each stops at its first failing condition. */
function decisionTrace(s: Story, f: { candidates: CandidateFact[]; observation: Facts["observation"]; metrics: MetricFact[]; calibrated: boolean }): TraceRow[] {
  const counted = (s.counted ?? []) as MetricId[];
  const changedHolds = s.row >= 4 && s.row <= 11;
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
  const ids = (cs: CandidateFact[]) => cs.map((c) => c.event);
  const youOpen = f.candidates.filter((c) => c.class === "you_strong" && c.status === "open");
  const agentStrong = f.candidates.filter((c) => c.class === "agent_strong");
  const unknown = f.candidates.filter((c) => c.class === "unknown");
  const background = f.candidates.filter((c) => c.status === "background" || c.status === "ruled_out" || c.class === "agent_routine");
  const fully = f.observation.scope === "onset" && f.observation.partiallyObservedDays === 0;
  const obs = { fullyObservedDays: f.observation.fullyObservedDays, partiallyObservedDays: f.observation.partiallyObservedDays, partialByDesign: f.observation.partialByDesign };
  const changed = (): TraceCondition => ({ id: "changed", holds: changedHolds, metrics: changedHolds ? counted : [], detail: { side: changedHolds ? "worse" : null, fragileDays: false } });
  const done = (): TraceRow[] => trace;

  if (row(1, { id: "not_calibrated", holds: !f.calibrated })) return done();
  const missing = VOTING_FAMILIES.filter((fam) => !f.metrics.some((m) => m.role === "vote" && m.family === fam && m.eligible));
  if (row(2, { id: "family_without_eligible_metric", holds: missing.length > 0, detail: { families: [...missing] } })) return done();
  if (row(3, { id: "mixed", holds: false, metrics: [], detail: { worse: [], better: [] } })) return done();
  if (row(4, changed(), { id: "workload", holds: false, detail: { reasons: [] } })) return done();
  if (row(5, changed(), { id: "unknown_candidate", holds: unknown.length > 0, events: ids(unknown) })) return done();
  const youOpenCond = (): TraceCondition => ({ id: "you_strong_open", holds: youOpen.length > 0, events: ids(youOpen), detail: { ruledOut: [] } });
  if (row(6, changed(), youOpenCond(), { id: "agent_strong", holds: agentStrong.length > 0, events: ids(agentStrong) })) return done();
  if (row(7, changed(), youOpenCond(), { id: "no_agent_strong", holds: agentStrong.length === 0 })) return done();
  if (row(8, changed(), { id: "agent_strong", holds: agentStrong.length > 0, events: ids(agentStrong) }, { id: "no_you_strong_open", holds: youOpen.length === 0, detail: { ruledOut: [] } })) return done();
  const onlyRoutine = (): TraceCondition => ({ id: "only_routine_or_weak", holds: unknown.length === 0 && youOpen.length === 0 && agentStrong.length === 0, events: ids(background) });
  const observed = (): TraceCondition => ({ id: "fully_observed", holds: fully, detail: obs });
  if (row(9, changed(), onlyRoutine(), observed(), { id: "version_boundary", holds: s.row === 9, detail: { reason: s.row === 9 ? null : "projects" } })) return done();
  if (row(10, changed(), onlyRoutine(), observed())) return done();
  if (row(11, changed(), onlyRoutine(), { id: "partially_observed", holds: !fully, detail: obs })) return done();
  const notChanged: TraceCondition = { id: "not_changed", holds: true };
  if (row(12, notChanged, { id: "single_indicator", holds: false, detail: { kind: "none_material" } })) return done();
  if (row(13, notChanged, { id: "no_material", holds: true }, { id: "sensitive_each_family", holds: true })) return done();
  row(14, { id: "otherwise", holds: true });
  return done();
}

const CONFOUNDERS: Confounder[] = [
  { id: "prompt_length", moved: false, value: 0.04 }, { id: "long_context_share", moved: false, value: 0.02 },
  { id: "mode_mix", moved: false, value: 0.03 }, { id: "project_mix", moved: false, value: 0.05 },
];

/** The demo case as the words layer's facts. */
export function demoFacts(name: DemoCase): Facts {
  const file = data();
  const c = file.cases[name];
  if (c === undefined) throw new RangeError("unknown demo case");
  const story = STORIES[name];
  const calibrated = true; // both agents are calibrated in the shipped artifact (D69)
  const events = c.timeline.map((e, i) => eventFact(e, i, c.agent)).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const daily = c.daily === undefined ? [] : [...c.daily.baseline, ...c.daily.recent].map((d) => ({ d: `2026-${d.d}`, k: d.k, n: d.n }));
  const metrics = (c.metrics ?? []).map((m) => metricFact(m, daily));
  const candidates: CandidateFact[] = (story.candidates ?? []).flatMap(([kind, day, cls, status, test]) => {
    const e = events.find((x) => x.kind === kind && x.day === day);
    return e === undefined ? [] : [{ event: e.id, kind: e.kind, side: e.side, class: cls, status, test, day: e.day, undated: false, tripwire: e.tripwire, from: e.from, to: e.to }];
  });
  const observation: Facts["observation"] = story.observation !== undefined
    ? { fullyObservedDays: story.observation[0], partiallyObservedDays: story.observation[1], partialByDesign: false, scope: "onset" }
    : name === "codex"
      ? { fullyObservedDays: 0, partiallyObservedDays: file.windows.recent.days, partialByDesign: true, scope: "window" } // Codex has no hooks: partial by design
      : { fullyObservedDays: 14, partiallyObservedDays: 0, partialByDesign: false, scope: "window" };
  const w = file.windows;
  const n = c.n;
  const boundaryEvent = story.boundary === undefined ? undefined : events.find((e) => e.kind === story.boundary!.kind && e.day === story.boundary!.day);
  const dataOf = c.progress;
  const progress: Facts["progress"] = story.progress === true && dataOf !== undefined ? {
    // D66: no projected dates in v1, so the demo takes the same path as a real run (reason "no_date", nothing to show).
    tier: 1, reason: "no_date", etaDate: null, notAtCurrentPace: false, readyToday: false,
    unlock: name === "codex" ? [
      // The demo file's Codex gap: 8 of the 10 session-days in the baseline, and only that (its "detail" names no other
      // gap), so the event and session gates are shown as met.
      { metric: "toolErrors", family: "errors", state: "ineligible", fieldsMissing: false, have: { events: 10, sessions: n.baseline.sessions, sessionDays: dataOf.have ?? 8 }, need: { events: 10, sessions: 5, sessionDays: dataOf.need ?? 10 }, shortSessions: 0, shortSessionDays: (dataOf.need ?? 10) - (dataOf.have ?? 8), blocking: ["sessionDays"] },
    ] : [
      { metric: "readsPerEdit", family: "research", state: "ineligible", fieldsMissing: false, have: { events: 31, sessions: 4, sessionDays: 9 }, need: { events: 40, sessions: 5, sessionDays: 10 }, shortSessions: 1, shortSessionDays: 1, blocking: ["sessions", "sessionDays"] },
      { metric: "blindEdits", family: "research", state: "ineligible", fieldsMissing: false, have: { events: 7, sessions: 4, sessionDays: 9 }, need: { events: 10, sessions: 5, sessionDays: 10 }, shortSessions: 1, shortSessionDays: 1, blocking: ["sessions", "sessionDays"] },
    ],
  } : null;
  // Blind edits has no row in the demo file's insufficient case; the unlock list above names it, so give it a metric row.
  if (name === "insufficient" && !metrics.some((m) => m.id === "blindEdits")) {
    metrics.push({
      id: "blindEdits", family: "research", role: "vote", scale: 100, eligible: false, ineligibleReason: "too_few_events", fieldsMissing: false, material: false,
      sensitive: false, usable: false, familywise: false, direction: null, status: "ineligible", ratio: null, range: null, mde: null,
      recent: { k: 7, n: 31, sessions: 4, sessionDays: 9 }, baseline: { k: 20, n: 233, sessions: 0, sessionDays: 0 }, daily: [], standardized: null, pace: null, shortfall: null,
    });
    const order = ["toolErrors", "readsPerEdit", "blindEdits", "interrupts", "pushback"];
    metrics.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
  }
  return {
    agent: c.agent, today: TODAY, state: story.outcome?.[0] ?? (c.state as Facts["state"]), reason: story.outcome !== undefined ? story.outcome[1] : ((c.reason ?? null) as Facts["reason"]), row: story.row, pending: false, calibrated,
    tier: calibrated ? 1 : null, history: { days: 60, selection: "ready" },
    windows: {
      recent: { from: w.recent.from, to: w.recent.to, days: w.recent.days, exchanges: n.recent.exchanges, sessions: n.recent.sessions, sessionDays: n.recent.sessionDays, activeDays: n.recent.activeDays },
      baseline: { from: w.baseline.from, to: w.baseline.to, days: w.baseline.days, exchanges: n.baseline.exchanges, sessions: n.baseline.sessions, sessionDays: n.baseline.sessionDays, activeDays: n.baseline.activeDays },
      sessions: n.total.sessions,
    },
    metrics, errorsVote: "toolErrors", counted: story.counted ?? [], side: story.counted !== undefined ? "worse" : null, fragileDays: false,
    mixed: null, workload: [], single: null, holmKind: null, materialVoting: [],
    onset: story.onset !== undefined ? { from: story.onset[0], to: story.onset[1] } : null, peak: story.onset?.[0] ?? null,
    candidates, observation, blindSpot: false,
    boundary: boundaryEvent !== undefined && story.boundary !== undefined ? { event: boundaryEvent.id, projects: story.boundary.projects } : null,
    progress, recheck: recheckOf(story),
    trace: decisionTrace(story, { candidates, observation, metrics, calibrated }),
    events, confounders: calibrated ? CONFOUNDERS : [], gate: { minSessions: 5, minSessionDays: 10, minEvents: 10 },
  };
}

/** Engine output (glance, snapshot, words) for one demo case, or `all` the Claude Code cases plus Codex. */
export function demoOutputs(name: DemoCase, opts: { lead?: "timeline" | "verdict"; engine: string }): BuiltOutputs {
  const facts = demoFacts(name);
  const agent = facts.agent as AgentId;
  const c = data().cases[name]!;
  const w = data().windows;
  // What a real scan reports beside the findings, so every surface that shows it (doctor, the canvas's source and
  // calibration panels) has real-looking rows: the shipped calibration, and one source row for the demo's agent.
  const health: Health = {
    sources: [{
      agent, found: true, files: c.n.total.sessions, badLines: 0, truncatedTail: 0, duplicates: 0, unknownTypes: {},
      firstDay: w.baseline.from, lastDay: w.recent.to, error: null,
    }],
    parserVersions: healthParserVersions(new Map([[agent, currentVersions(agent)]])),
    sandbox: true,
    paused: [],
  };
  return buildOutputs({
    engine: opts.engine, generatedAt: GENERATED_AT, scanOk: true, demo: true, lead: opts.lead ?? "timeline",
    agents: [{ facts, setup: { agentVersion: "2.1.281", mcpServers: 6, skills: 14, hooks: 2 }, knownEventIds: facts.events.map((e) => e.id) }],
    health,
    calibration: contractCalibration(readCalibration(SHIPPED_CALIBRATION, SCAN_ERRORS_VOTE), [agent]),
  });
}
