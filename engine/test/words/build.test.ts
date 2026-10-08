/**
 * buildOutputs (the WP-12 bridge) and the words' safety rules: the timeline built from Attribution.events (derived
 * `d-…` and tripwire `t-…` ids), labels only from allow-listed values, project names never printed, "+n" and new
 * marks from knownEventIds, pending held words, engine order, problems, and the small pure helpers (format,
 * re-check estimate). Synthetic data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { attributeAgent, type Attribution, type AttributeOptions, type AttributionEvent } from "../../src/analysis/attribution/index.js";
import type { MetricExchange } from "../../src/analysis/metrics/defs.js";
import {
  buildOutputs, count, countNoun, day, eventLabel, explain, factsOf, fit, lintStatusLine, metricRecheck, metricWords, PENDING_LINE,
  range, recheckEstimate, SNAPSHOT_METRICS, undoPhrase, wordsFor, youPhrase,
} from "../../src/words/index.js";
import { BASE, daysBack, recorded, scenario, TODAY } from "../analysis/attribution-fixtures.js";
import { addDays } from "../analysis/helpers.js";
import { assertValidOutputs } from "./helpers.js";

const ONSET = 10;
const ONSET_DAY = addDays(TODAY, -ONSET);
const SHIFT = { onset: ONSET, errors: [2, 6] as [number, number], blind: [2, 4] as [number, number] };
const AT = `${TODAY}T12:00:00Z`;

function run(xs: readonly MetricExchange[], events: readonly AttributionEvent[] = [], over: Partial<AttributeOptions> = {}): Attribution {
  return attributeAgent(xs, events, { ...BASE, calibrated: true, ...over });
}

const byElimination = run(scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) }), [], { fullyObservedDays: daysBack(70) });
const agentTripwire = run(scenario({ ...SHIFT, label: (after) => (after ? { servedModel: "m-x", steps: 6 } : {}) }), [], { decide: { tripwires: { servedModel: true } } });

/** Every string value anywhere in a document. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}

test("the snapshot timeline is built from Attribution.events, incl. derived d-… and tripwire t-… ids; candidates point at it", () => {
  const a = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: byElimination }] });
  assertValidOutputs(a, "by_elimination");
  const s = a.snapshot.agents[0]!;
  assert.equal(s.reason, "by_elimination");
  assert.ok(s.timeline.some((e) => e.id.startsWith("d-") && e.kind === "version"), "the derived version bump is on the timeline");
  const vb = s.candidates.find((c) => c.test === "version_boundary")!;
  assert.ok(vb.event.startsWith("d-"));
  assert.equal(s.timeline.find((e) => e.id === vb.event)!.label, "Claude Code 1.0 → 1.1");
  assert.equal(s.timeline.length, byElimination.events.length);

  const b = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: agentTripwire }] });
  assertValidOutputs(b, "agent tripwire");
  const t = b.snapshot.agents[0]!;
  const tw = t.timeline.find((e) => e.id.startsWith("t-"))!;
  assert.deepEqual([tw.kind, tw.side, tw.strength, tw.label], ["served-model", "agent", "strong", "Served model differs from the one you picked"]);
  assert.ok(t.candidates.some((c) => c.event === tw.id && c.status === "open"));
  assert.equal(b.glance.agents[0]!.headline, "Nothing recorded changed on your side; Claude Code served another model.");
  assert.match(b.glance.agents[0]!.confidence, /Some days weren't fully observed\.$/);
});

test("project names never reach any output; the onset observation scope is used for a changed outcome (D56 R11)", () => {
  const out = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: byElimination }] });
  const all = [...strings(out.glance), ...strings(out.snapshot), ...out.words.flatMap((w) => [...w.body.timeline, ...w.body.verdict, ...w.candidateLines.map((c) => c.text)])];
  for (const p of ["p-A", "p-B"]) assert.ok(!all.some((s) => s.includes(p)), `project id ${p} printed`);
  const s = out.snapshot.agents[0]!;
  assert.deepEqual([s.observation.fullyObservedDays, s.observation.partiallyObservedDays], [byElimination.decision.observation.fullyObservedDays, 0]);
  assert.match(out.glance.agents[0]!.because, /^The shift shows in 2 projects from /);
});

test("sessions are counted DISTINCT across both windows: a session on both sides of the boundary counts once (D59)", () => {
  // Tier 1: recent = the 14 days before today, baseline = the 28 days before that. Four sessions run across the
  // boundary (day −15 into day −14); every other session lives on one day.
  const straddling = run(scenario({ ...SHIFT, label: (_after, i, k) => (k === 14 || k === 15 ? { session: `long-${i}` } : {}) }), [], { fullyObservedDays: daysBack(70) });
  const out = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: straddling }] });
  assertValidOutputs(out, "straddling sessions");
  const s = out.snapshot.agents[0]!;
  const w = s.windows!;
  assert.deepEqual([w.recent.to, w.baseline.to], [addDays(TODAY, -1), addDays(TODAY, -15)]);
  const perWindow = w.recent.sessions + w.baseline.sessions;
  assert.equal(perWindow, 56 + 112, "the per-window counts each include the four long sessions");
  assert.equal(s.n.sessions, perWindow - 4, "n.sessions counts them once");
  assert.match(s.confidence, new RegExp(`\\(${perWindow - 4} sessions\\)`), "so does the confidence line");
  assert.equal(out.glance.agents[0]!.n.sessions, s.n.sessions);
  // Exchanges and session-days add up exactly (each belongs to one window); only sessions are not additive.
  assert.equal(s.n.exchanges, w.recent.exchanges + w.baseline.exchanges);
  assert.equal(s.n.sessionDays, w.recent.sessionDays + w.baseline.sessionDays);
  // Without a straddling session the distinct count is the plain sum.
  const plain = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: byElimination }] }).snapshot.agents[0]!;
  assert.equal(plain.n.sessions, plain.windows!.recent.sessions + plain.windows!.baseline.sessions);
});

test("labels come only from allow-listed values: hostile from/to and agent ids never echo", () => {
  const ESC = "\u001b";
  const hostile: AttributionEvent[] = [
    recorded({ id: "e-h1", kind: "model", side: "you", from: `${ESC}[31m/Users/x/secret`, to: "<script>alert(1)</script>", day: addDays(TODAY, -40) }),
    recorded({ id: "e-h2", kind: "effort", side: "unknown", from: "high", to: "‮evil", day: addDays(TODAY, -39), provenance: "log_field" }),
    recorded({ id: "e-h3", kind: "version", side: "agent", from: "1.0", to: "$(rm -rf ~)", day: addDays(TODAY, -38), strength: "routine" }),
  ];
  const a = run(scenario({}), hostile);
  const out = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: a }] });
  assertValidOutputs(out, "hostile labels");
  const tl = out.snapshot.agents[0]!.timeline;
  assert.equal(tl.find((e) => e.id === "e-h1")!.label, "Model changed");
  assert.deepEqual([tl.find((e) => e.id === "e-h1")!.from, tl.find((e) => e.id === "e-h1")!.to], ["other", "other"]);
  assert.equal(tl.find((e) => e.id === "e-h2")!.label, "Effort changed (no command recorded)");
  assert.equal(tl.find((e) => e.id === "e-h3")!.label, "Claude Code updated");
  const all = [...strings(out.glance), ...strings(out.snapshot)];
  for (const bad of [ESC, "/Users/", "<script", "‮", "rm -rf"]) assert.ok(!all.some((s) => s.includes(bad)), `${JSON.stringify(bad)} echoed`);
  // An agent id that is not a clean label is never printed; bare numbers are counts, not versions.
  assert.equal(eventLabel({ kind: "version", side: "agent", from: "1", to: "2" }, `evil${ESC}[2J`), "this agent updated");
  assert.equal(eventLabel({ kind: "version", side: "agent", from: "1.0", to: "1.1" }, "future-agent"), "future-agent 1.0 → 1.1");
});

test("project-scoped setup events keep their scope in the label; global ones don't (allow-listed words only)", () => {
  const project = { side: "you", provenance: "project_snapshot" } as const;
  const label = (e: { kind: string; from: string; to: string; provenance?: string; side?: string }) => eventLabel({ side: "you", ...e }, "claude-code");
  assert.equal(label({ ...project, kind: "config", from: "h:0c1d2e3f", to: "h:4a5b6c7d" }), "Project settings changed");
  assert.equal(label({ kind: "config", from: "h:0c1d2e3f", to: "h:4a5b6c7d", provenance: "settings_snapshot" }), "Settings changed");
  assert.equal(label({ ...project, kind: "instructions", from: "h:0c1d2e3f", to: "h:4a5b6c7d" }), "Project CLAUDE.md changed");
  assert.equal(label({ ...project, kind: "instructions", from: "absent", to: "h:4a5b6c7d" }), "Project CLAUDE.md added");
  assert.equal(label({ ...project, kind: "instructions", from: "h:0c1d2e3f", to: "absent" }), "Project CLAUDE.md removed");
  assert.equal(label({ kind: "instructions", from: "h:0c1d2e3f", to: "h:4a5b6c7d", provenance: "settings_snapshot" }), "CLAUDE.md changed");
  assert.equal(label({ ...project, kind: "mcp", from: "h:0c1d2e3f", to: "h:4a5b6c7d" }), "Project MCP servers changed");
  assert.equal(label({ ...project, kind: "mcp", from: "absent", to: "h:4a5b6c7d" }), "Project MCP servers added");
  assert.equal(label({ kind: "mcp", from: "3", to: "4", provenance: "settings_snapshot" }), "MCP server added");
  // Log-derived values never reach a project label.
  assert.equal(label({ ...project, kind: "config", from: "/Users/x/secret", to: "<script>" }), "Project settings changed");
  assert.equal(youPhrase({ kind: "config", from: "h:0c1d2e3f", to: "h:4a5b6c7d", provenance: "project_snapshot" }, "claude-code", true), "your project settings change");
  assert.equal(youPhrase({ kind: "config", from: "h:0c1d2e3f", to: "h:4a5b6c7d" }, "claude-code", true), "your settings change");
  assert.equal(undoPhrase({ kind: "instructions", from: "h:0c1d2e3f", provenance: "project_snapshot" }, "claude-code"), "undo your project CLAUDE.md edit");

  // Through the whole pipeline: the snapshot timeline carries the scoped label, and the outputs stay valid.
  const events = [
    recorded({ id: "e-proj", kind: "config", side: "you", strength: "weak", provenance: "project_snapshot", evidence: "snapshot", from: "h:0c1d2e3f", to: "h:4a5b6c7d", day: addDays(TODAY, -3) }),
    recorded({ id: "e-glob", kind: "config", side: "you", strength: "weak", provenance: "settings_snapshot", evidence: "snapshot", from: "h:1c1d2e3f", to: "h:5a5b6c7d", day: addDays(TODAY, -2) }),
  ];
  const out = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: run(scenario({}), events) }] });
  assertValidOutputs(out, "project-scoped labels");
  const tl = out.snapshot.agents[0]!.timeline;
  assert.equal(tl.find((e) => e.id === "e-proj")!.label, "Project settings changed");
  assert.equal(tl.find((e) => e.id === "e-glob")!.label, "Settings changed");
});

test("+n and `new`: only events missing from knownEventIds; none on a first scan (no knownEventIds)", () => {
  const first = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: byElimination }] });
  assert.equal(first.glance.agents[0]!.statusLine, "wasitme: agent side");
  assert.ok(first.snapshot.agents[0]!.timeline.every((e) => !e.new));
  const ids = byElimination.events.map((e) => String(e.id));
  const newest = first.glance.agents[0]!.events[0]!;
  const newestId = first.snapshot.agents[0]!.timeline.find((e) => e.day === newest.day && e.kind === newest.kind)!.id;
  const next = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: byElimination, knownEventIds: ids.filter((id) => id !== newestId) }] });
  assertValidOutputs(next, "+1");
  assert.equal(next.glance.agents[0]!.statusLine, "wasitme: agent side +1");
  assert.equal(next.glance.agents[0]!.events[0]!.new, true);
  assert.equal(next.snapshot.agents[0]!.timeline.filter((e) => e.new).length, 1);
  assert.deepEqual(lintStatusLine("wasitme: agent side +1"), []);
  assert.equal(lintStatusLine("wasitme: your side (effort, Sep 21)").length, 1);
  assert.equal(lintStatusLine("wasitme: worse +2").length, 1);
});

test("pending: the glance holds the previous state's words; \"Possible shift — confirming\" is a separate line, never a contract string", () => {
  const prev = run(scenario({}));
  const xs = scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) });
  const a = run(xs, [recorded({ id: "e-model", kind: "model", side: "you", from: "m1", to: "m2", day: ONSET_DAY })], { previous: prev.decision });
  assert.deepEqual([a.decision.pending, a.decision.state, a.decision.raw.state], [true, "none", "you"]);
  const out = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: a }] });
  assertValidOutputs(out, "pending");
  const g = out.glance.agents[0]!;
  assert.deepEqual([g.state, g.pending, g.label], ["none", true, "No detectable change"]);
  assert.equal(out.words[0]!.pendingLine, PENDING_LINE);
  assert.ok(!strings(out.glance).some((s) => s.includes("confirming")));
  assert.ok(!strings(out.snapshot).some((s) => s.includes("confirming")));
  assert.ok(out.words[0]!.body.timeline.includes(PENDING_LINE) && out.words[0]!.body.verdict.includes(PENDING_LINE));
});

test("engine order: calibrated agents first (single-glyph surfaces speak for agents[0]); timeline-only agents carry no numbers", () => {
  const codex = run(scenario({ ...SHIFT, label: () => ({ agent: "codex" }) }), [], { agent: "codex", calibrated: false });
  const out = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: codex }, { attribution: byElimination }] });
  assertValidOutputs(out, "two agents");
  assert.deepEqual(out.glance.agents.map((a) => a.agent), ["claude-code", "codex"]);
  const cx = out.snapshot.agents[1]!;
  assert.deepEqual([cx.state, cx.reason, cx.calibrated, cx.label], ["insufficient", "calibration_pending", false, "Timeline only"]);
  assert.equal(cx.headline, "Findings for Codex are off until wasitme's tests pass for Codex logs.");
  assert.deepEqual([cx.topMetrics, cx.metrics, cx.strip, cx.progress, cx.windows, cx.tier, cx.confounders], [[], [], null, null, null, null, []]);
  assert.deepEqual(out.snapshot.calibration.agents.map((c) => [c.agent, c.calibrated]), [["claude-code", true], ["codex", false]]);
});

test("problems: a bad generatedAt or a calibration table that disagrees is reported, never written silently", () => {
  const bad = buildOutputs({ engine: "0.1.0", generatedAt: "2026-10-04 12:00", scanOk: true, agents: [{ attribution: byElimination }] });
  assert.ok(bad.problems.some((p) => p.includes("generatedAt")));
  const cal = buildOutputs({
    engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: byElimination }],
    calibration: { artifactDate: null, methodId: null, agents: [{ agent: "claude-code", calibrated: false, sequences: 0, falseChanged: null, falseAgent: null }] },
  });
  assert.ok(cal.problems.some((p) => p.includes("calibration.agents disagrees")));
  const failed = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: false, agents: [{ attribution: byElimination }] });
  assert.equal(failed.glance.scanError, "internal");
  assert.deepEqual(failed.problems, []);
  const evil = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ facts: { ...factsOf(byElimination), agent: "evil\u001b[2J" } }] });
  assert.ok(evil.problems.some((p) => p.includes("not a clean id")));
});

test("health from the scan is bounded: log-derived unknownTypes keys pass only in the cleanLabel shape", () => {
  const out = buildOutputs({
    engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: byElimination }],
    health: {
      sources: [{ agent: "claude-code", found: true, files: 3, badLines: 0, truncatedTail: 0, duplicates: 0, unknownTypes: { "future_kind": 2, "\u001b[31m/Users/x": 1, "<script>": 4 }, firstDay: "2026-08-01", lastDay: "2026-10-03", error: null }],
      parserVersions: { toolErrors: 1, "bad key": 2 }, sandbox: true, paused: [],
    },
  });
  assertValidOutputs(out, "health");
  assert.deepEqual(out.snapshot.health.sources[0]!.unknownTypes, { future_kind: 2 });
  assert.deepEqual(out.snapshot.health.parserVersions, { toolErrors: 1 });
});

test("setup is sanitised: schema keys only, clean labels, ≤ 40 keys", () => {
  const setup: Record<string, unknown> = { model: "opus-5-5", effort: "high", mcpServers: 6, sandbox: true, "bad key": "x", path: "/Users/x/proj", note: "a b\u001b[2J" };
  for (let i = 0; i < 50; i++) setup[`k${i}`] = i;
  const out = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: byElimination, setup }] });
  assertValidOutputs(out, "setup");
  const s = out.snapshot.agents[0]!.setup;
  assert.deepEqual([s.model, s.effort, s.mcpServers, s.sandbox], ["opus-5-5", "high", 6, true]);
  assert.ok(!("path" in s) && !("note" in s) && !("bad key" in s));
  assert.ok(Object.keys(s).length <= 40);
});

test("explain(attribution) equals wordsFor(factsOf(attribution)) and is deterministic", () => {
  const w1 = explain(agentTripwire);
  const w2 = wordsFor(factsOf(agentTripwire));
  const { facts, ...rest } = w1;
  assert.deepEqual(rest, w2);
  assert.deepEqual(explain(agentTripwire), w1);
  assert.equal(facts.row, 8);
});

test("re-check estimate: hand-computed (ratio ×2, MDE ×1.5, 10 | 20 session-days, 1 session-day and 0.5 new sessions a day)", () => {
  // q = (ln 2 / ln 1.5)² = 2.92243; A = q·(1/10 + 1/20) − 1/10 = 0.33836 → K' = ⌈2.955⌉ = 3 → raised to the 10-session-day floor;
  // days = max(10 / 1, 5 / 0.5) = 10; sessions = max(5, ⌈10 · 0.5⌉) = 5.
  const gate = { minSessions: 5, minSessionDays: 10 };
  const m = { family: "errors", ratio: 2, mde: 1.5, recentSessionDays: 10, baselineSessionDays: 20, pace: { sessionDays: 1, newSessions: 0.5 } };
  assert.deepEqual(metricRecheck(m, gate), { days: 10, sessions: 5 });
  // A small move against a coarse MDE can never show by waiting: q·0.15 < 0.1.
  assert.equal(metricRecheck({ ...m, ratio: 1.2, mde: 2.5 }, gate), null);
  // A larger K': ratio ×1.5, MDE ×1.4, 40 | 80: q = (0.405465/0.336472)² = 1.45212; A = 1.45212·0.0375 − 0.025 = 0.029455 → K' = 34;
  // days = max(34 / 2, 5 / 1) = 17; sessions = max(5, 17).
  assert.deepEqual(metricRecheck({ ...m, ratio: 1.5, mde: 1.4, recentSessionDays: 40, baselineSessionDays: 80, pace: { sessionDays: 2, newSessions: 1 } }, gate), { days: 17, sessions: 17 });
  assert.deepEqual(recheckEstimate([m], gate, "2026-10-04"), { kind: "eta", days: 10, sessions: 5, date: "2026-10-14" });
  assert.deepEqual(recheckEstimate([m, { ...m, family: "research", ratio: 1.2, mde: 2.5 }], gate, "2026-10-04"), { kind: "not_at_pace" });
  assert.deepEqual(recheckEstimate([{ ...m, pace: { sessionDays: 0.1, newSessions: 0.1 } }], gate, "2026-10-04"), { kind: "not_at_pace" }); // 100 days > 84
  assert.equal(recheckEstimate([], gate, "2026-10-04"), null);
});

test("format helpers: locale-free counts, dates with the year only when it differs, outward ranges, fit", () => {
  assert.equal(count(1234567), "1,234,567");
  assert.equal(count(-3), "0");
  assert.equal(day("2026-09-21", "2026-10-04"), "Sep 21");
  assert.equal(day("2025-12-30", "2026-10-04"), "Dec 30, 2025");
  assert.equal(day("not a day"), "");
  assert.equal(range(1.404, 3.501), "×1.40–×3.51");
  assert.equal(range(0.4, 1.41, " to "), "×0.40 to ×1.41");
  assert.equal(fit(10, "far too long here", "short"), "short");
  assert.equal(fit(5, "abcdefgh", "ijklmnop"), "ijkl…");
  assert.ok(!range(1.004, 2).includes("99"));
});

test("one name per indicator: a sentence names each snapshot indicator by its ledger label", () => {
  for (const id of SNAPSHOT_METRICS) {
    const w = metricWords(id);
    // Only the tool-error constructs drop their qualifier in a sentence ("tool errors"); D59 keeps the label as is.
    const label = w.label.replace(/ \(excl\. commands\)$/, "");
    assert.equal(w.name, label.charAt(0).toLowerCase() + label.slice(1), `${id}: "${w.label}" vs "${w.name}"`);
  }
  assert.equal(metricWords("blindEdits").name, "edits without reading first");
  assert.deepEqual(countNoun("blindEdits", "events"), ["edit without reading first", "edits without reading first"]);
});
