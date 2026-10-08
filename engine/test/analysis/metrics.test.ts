import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCells, cellsBetween, dailyTotals, isAutomationEntrypoint } from "../../src/analysis/metrics/cells.js";
import { executedCalls, METRICS, metricDef, roleOf, TOOL_ERROR_VARIANTS, VOTING_FAMILIES } from "../../src/analysis/metrics/defs.js";
import { historyDays, rangeStrings, TIERS, tierWindows, todayFor } from "../../src/analysis/metrics/windows.js";
import { dayIndex } from "../../src/analysis/stats/ratio.js";
import { ex, shuffled } from "./helpers.js";

const TODAY = "2026-10-04";

test("metric table: METHOD.md §3 families, roles and '1 pt' per metric", () => {
  const row = (id: Parameters<typeof metricDef>[0]) => {
    const d = metricDef(id);
    return [d.family, d.role, d.worse, d.point, d.floor, d.minDenominator];
  };
  assert.deepEqual(row("toolErrors"), ["errors", "vote", "up", 0.01, "binomial", 0]);
  assert.deepEqual(row("readsPerEdit"), ["research", "vote", "down", 1, "poisson", 40]);
  assert.deepEqual(row("blindEdits"), ["research", "vote", "up", 0.01, "binomial", 0]);
  assert.deepEqual(row("interrupts"), ["friction", "support", "up", 0.01, "binomial", 0]);
  assert.deepEqual(row("pushback"), ["friction", "support", "up", 0.01, "binomial", 0]);
  assert.deepEqual(row("cmdFailures"), ["errors", "context", "up", 0.01, "binomial", 0]);
  assert.deepEqual(row("churn"), ["context", "context", "up", null, "binomial", 0]);
  assert.deepEqual([...VOTING_FAMILIES], ["errors", "research"]);
  // Friction never votes (D30); context never votes.
  for (const m of METRICS) if (m.family === "friction" || m.family === "context") assert.notEqual(m.role, "vote");
  assert.equal(new Set(METRICS.map((m) => m.id)).size, METRICS.length);
});

test("exactly one tool-error construct votes; the other two are context", () => {
  for (const v of TOOL_ERROR_VARIANTS) {
    const votes = TOOL_ERROR_VARIANTS.filter((id) => roleOf(id, v) === "vote");
    assert.deepEqual(votes, [v]);
    assert.equal(roleOf("readsPerEdit", v), "vote");
    assert.equal(roleOf("interrupts", v), "support");
  }
});

test("tool errors: rejections and blocks leave the denominator (they never ran)", () => {
  const x = ex({ session: "s", day: "2026-10-01", toolCalls: 20, rejections: 3, blocked: 2, toolErrors: 3 });
  assert.equal(executedCalls(x), 15);
  assert.deepEqual(metricDef("toolErrors").extract(x), { num: 3, den: 15 });
  // Garbage counts are treated as 0, never negative.
  assert.equal(executedCalls(ex({ session: "s", day: "2026-10-01", toolCalls: 2, rejections: 5 })), 0);
  assert.equal(executedCalls(ex({ session: "s", day: "2026-10-01", toolCalls: Number.NaN })), 0);
});

test("split variants need their fields; non-command = executed − command calls", () => {
  const x = ex({ session: "s", day: "2026-10-01", toolCalls: 20, rejections: 2, toolErrors: 5, toolErrorsEdit: 2, toolErrorsCmd: 3, cmdCalls: 8 });
  assert.deepEqual(metricDef("toolErrorsNonCmd").extract(x), { num: 2, den: 10 });
  assert.deepEqual(metricDef("cmdFailures").extract(x), { num: 3, den: 8 });
  const b = buildCells([x, ex({ session: "s", day: "2026-10-01", toolCalls: 4, toolErrors: 1 })], { agent: "claude-code", today: TODAY });
  // The second exchange lacks the split fields: counted as missing, contributes nothing.
  assert.deepEqual(b.cells.cmdFailures.map((c) => [c.num, c.den, c.missing, c.exchanges]), [[3, 8, 1, 1]]);
  assert.deepEqual(b.cells.toolErrors.map((c) => [c.num, c.den, c.missing]), [[6, 22, 0]]);
});

test("reads per edit and blind edits are ratios of totals over work; prompt metrics count real prompts only", () => {
  const xs = [
    ex({ session: "s", day: "2026-10-01", reads: 6, edits: 2, blindEdits: 1, interrupted: 1, steps: 4 }),
    // Agent-initiated / resumed stretch: its work counts, it is not a prompt.
    ex({ session: "s", day: "2026-10-01", humanPrompt: 0, reads: 3, edits: 1, blindEdits: 1, interrupted: 1, steps: 9, pushback: 1 }),
    ex({ session: "s", day: "2026-10-01", reads: 0, edits: 0, pushback: 1, steps: 2 }),
  ];
  const b = buildCells(xs, { agent: "claude-code", today: TODAY });
  const one = (id: Parameters<typeof metricDef>[0]) => b.cells[id].map((c) => [c.num, c.den]);
  assert.deepEqual(one("readsPerEdit"), [[9, 3]]);
  assert.deepEqual(one("blindEdits"), [[2, 3]]);
  assert.deepEqual(one("interrupts"), [[1, 2]]);
  assert.deepEqual(one("pushback"), [[1, 2]]);
  assert.deepEqual(one("steps"), [[6, 2]]);
  // churn's denominator is prompts with edits.
  assert.deepEqual(one("churn"), [[0, 1]]);
  assert.equal(b.counts.prompts, 2);
});

test("research metrics count the exchange's whole work: main thread + attributed subagents (D62a)", () => {
  // Hand-computed. Main: 6 reads / 2 edits / 1 blind; subagents: 4 reads / 3 edits / 2 blind; a second exchange
  // whose edits all happened in subagents (main 1 read, 0 edits; sub 0 reads, 2 edits, 1 blind); a third parsed
  // before the sub fields existed (absent = 0).
  const xs = [
    ex({ session: "s", day: "2026-10-01", reads: 6, edits: 2, blindEdits: 1, subReads: 4, subEdits: 3, subBlindEdits: 2, churned: 1 }),
    ex({ session: "s", day: "2026-10-01", reads: 1, edits: 0, blindEdits: 0, subReads: 0, subEdits: 2, subBlindEdits: 1 }),
    ex({ session: "s", day: "2026-10-01", reads: 2, edits: 1, blindEdits: 0 }),
  ];
  assert.deepEqual(metricDef("readsPerEdit").extract(xs[0]!), { num: 10, den: 5 });
  assert.deepEqual(metricDef("blindEdits").extract(xs[0]!), { num: 3, den: 5 });
  assert.deepEqual(metricDef("blindEdits").extract(xs[1]!), { num: 1, den: 2 }, "edits made only by subagents still count");
  const b = buildCells(xs, { agent: "claude-code", today: TODAY });
  const one = (id: Parameters<typeof metricDef>[0]) => b.cells[id].map((c) => [c.num, c.den, c.missing]);
  assert.deepEqual(one("readsPerEdit"), [[6 + 4 + 1 + 0 + 2, 2 + 3 + 0 + 2 + 1, 0]]);
  assert.deepEqual(one("blindEdits"), [[1 + 2 + 0 + 1 + 0, 2 + 3 + 0 + 2 + 1, 0]]);
  // Churn stays a main-thread measure: prompts with main-thread edits only.
  assert.deepEqual(one("churn"), [[1, 2, 0]]);
  // Garbage sub counts are 0, never negative; a blind count above the edits is clamped and counted (binomial).
  assert.deepEqual(metricDef("readsPerEdit").extract(ex({ session: "s", day: "2026-10-01", reads: 2, edits: 1, subReads: -5, subEdits: Number.NaN })), { num: 2, den: 1 });
  const c = buildCells([ex({ session: "s", day: "2026-10-01", edits: 1, subEdits: 1, subBlindEdits: 4 })], { agent: "claude-code", today: TODAY });
  assert.deepEqual(c.cells.blindEdits.map((x) => [x.num, x.den, x.clamped]), [[2, 2, 1]]);
});

test("proportions are clamped to num ≤ den and the clamp is counted", () => {
  const b = buildCells([ex({ session: "s", day: "2026-10-01", toolCalls: 2, toolErrors: 5 })], { agent: "claude-code", today: TODAY });
  assert.deepEqual(b.cells.toolErrors.map((c) => [c.num, c.den, c.clamped]), [[2, 2, 1]]);
});

test("today, future-dated and invalid days are excluded and counted; history ignores them", () => {
  const xs = [
    ex({ session: "a", day: "2026-10-03", toolCalls: 1 }),
    ex({ session: "a", day: TODAY, toolCalls: 1 }),
    ex({ session: "a", day: "2026-10-09", toolCalls: 1 }), // clock jumped forward
    ex({ session: "a", day: "2026-02-31", toolCalls: 1 }),
    ex({ session: "b", day: "2026-09-01", toolCalls: 1 }),
    ex({ session: "c", day: "2026-09-02", toolCalls: 1, agent: "codex" }),
  ];
  const b = buildCells(xs, { agent: "claude-code", today: TODAY });
  assert.equal(b.counts.today, 1);
  assert.equal(b.counts.future, 1);
  assert.equal(b.counts.invalidDay, 1);
  assert.equal(b.counts.otherAgent, 1);
  assert.equal(b.counts.used, 2);
  assert.equal(b.firstDay, "2026-09-01");
  assert.equal(b.lastDay, "2026-10-03");
  // Sorted by session, then day.
  assert.deepEqual(b.cells.toolErrors.map((c) => `${c.session}:${c.day}`), ["a:2026-10-03", "b:2026-09-01"]);
});

test("interactive classifier: non-interactive sessions excluded when classified; unclassified counted", () => {
  const xs = [
    ex({ session: "a", day: "2026-10-01", toolCalls: 3, interactiveClass: "interactive" }),
    ex({ session: "b", day: "2026-10-01", toolCalls: 4, interactiveClass: "scripted" }),
    ex({ session: "c", day: "2026-10-01", toolCalls: 5 }),
  ];
  const b = buildCells(xs, { agent: "claude-code", today: TODAY });
  assert.equal(b.counts.classified, 2);
  assert.equal(b.counts.nonInteractive, 1);
  assert.equal(b.counts.nonInteractiveReader, 1);
  assert.deepEqual(b.cells.toolErrors.map((c) => c.session), ["a", "c"]);
});

test("interim interactive classifier (METHOD.md §2, D47(a)): automation work never reaches the cells or the history", () => {
  const codex = (over: Parameters<typeof ex>[0]) => ex({ agent: "codex", ...over });
  const xs = [
    // A person's session: 10 calls, 1 error, plus an agent-initiated stretch later that day (its work counts).
    codex({ session: "human", day: "2026-10-01", toolCalls: 10, toolErrors: 1, entrypoint: "cli" }),
    codex({ session: "human", day: "2026-10-01", humanPrompt: 0, toolCalls: 2, entrypoint: "cli" }),
    // `codex exec` (pre-D39 label from the originator): no human prompt, 100 calls, 40 errors.
    codex({ session: "exec-old", day: "2026-10-01", humanPrompt: 0, toolCalls: 100, toolErrors: 40, entrypoint: "codex_exec" }),
    // `codex exec` after D39: the prompt is real, but the entrypoint is "exec" → automation, decided here.
    codex({ session: "exec-new", day: "2026-10-01", toolCalls: 50, toolErrors: 20, entrypoint: "exec" }),
    // A spawned / agent-created thread from an interactive client: no human prompt in the whole session.
    codex({ session: "spawned", day: "2026-08-01", humanPrompt: 0, toolCalls: 30, toolErrors: 9, entrypoint: "vscode" }),
    codex({ session: "spawned", day: "2026-10-02", humanPrompt: 0, toolCalls: 30, toolErrors: 9, entrypoint: "vscode" }),
    // A session whose only human prompt is today: today never decides, so its past work is not interactive.
    codex({ session: "late", day: "2026-10-02", humanPrompt: 0, toolCalls: 7, entrypoint: "cli" }),
    codex({ session: "late", day: TODAY, toolCalls: 1, entrypoint: "cli" }),
    // The reader's classification wins over the interim rules, both ways.
    codex({ session: "reader-yes", day: "2026-10-01", humanPrompt: 0, toolCalls: 4, entrypoint: "exec", interactiveClass: "interactive" }),
    codex({ session: "reader-no", day: "2026-10-01", toolCalls: 4, entrypoint: "cli", interactiveClass: "scripted" }),
    // "unknown" from the reader (fields missing or contradictory) falls through to the interim rules: kept here.
    codex({ session: "reader-unknown", day: "2026-10-01", toolCalls: 3, entrypoint: "cli", interactiveClass: "unknown" }),
  ];
  const b = buildCells(xs, { agent: "codex", today: TODAY });
  assert.deepEqual(b.cells.toolErrors.map((c) => [c.session, c.num, c.den]), [["human", 1, 12], ["reader-unknown", 0, 3], ["reader-yes", 0, 4]]);
  assert.deepEqual(
    [b.counts.nonInteractive, b.counts.nonInteractiveEntrypoint, b.counts.nonInteractiveNoPrompt, b.counts.nonInteractiveReader, b.counts.today],
    [6, 2, 3, 1, 1],
  );
  assert.equal(b.counts.used, 4);
  // History starts at the first interactive day, not at the spawned thread's 2026-08-01.
  assert.deepEqual([b.firstDay, b.lastDay], ["2026-10-01", "2026-10-01"]);
  // Claude: print mode and the Agent SDK are automation; Desktop, CLI and IDE clients are not.
  for (const e of ["sdk-cli", "sdk-ts", "SDK-py", "sdk", "mcp", "exec", "codex_exec", "subagent"]) assert.equal(isAutomationEntrypoint(e), true, e);
  for (const e of ["cli", "claude-desktop", "claude-vscode", "vscode", "Codex Desktop", "codex-tui", "unknown", "other", undefined]) {
    assert.equal(isAutomationEntrypoint(e), false, String(e));
  }
});

test("language cells: every prompt counts, unknown language as not English", () => {
  const xs = [
    ex({ session: "a", day: "2026-10-01", promptEnglish: 1 }),
    ex({ session: "a", day: "2026-10-01" }), // language unknown
    ex({ session: "a", day: "2026-10-01", promptEnglish: 0 }),
    ex({ session: "a", day: "2026-10-01", humanPrompt: 0, promptEnglish: 1 }), // not a prompt
    ex({ session: "b", day: "2026-10-02", promptEnglish: 1 }),
  ];
  const b = buildCells(xs, { agent: "claude-code", today: TODAY });
  assert.deepEqual(b.language.map((c) => [c.session, c.day, c.num, c.den]), [["a", "2026-10-01", 1, 3], ["b", "2026-10-02", 1, 1]]);
  assert.deepEqual([b.counts.prompts, b.counts.languageKnown, b.counts.english], [4, 3, 2]);
});

test("duplicates by id: one copy kept by a canonical rule; output independent of input order", () => {
  const a = ex({ session: "s", day: "2026-10-01", toolCalls: 5, toolErrors: 1 });
  const later = { ...a, t: "2026-10-01T13:00:00.000Z", toolErrors: 4 };
  const twin = { ...a, toolErrors: 2 }; // same id and t: canonical JSON decides
  const xs = [later, a, twin, ex({ session: "z", day: "2026-09-30", toolCalls: 7, toolErrors: 2 })];
  const ref = buildCells(xs, { agent: "claude-code", today: TODAY });
  assert.equal(ref.counts.duplicates, 2);
  for (let seed = 1; seed <= 5; seed++) assert.deepEqual(buildCells(shuffled(xs, seed), { agent: "claude-code", today: TODAY }), ref);
  // The earlier t wins over the later copy; between same-t twins the canonical-JSON minimum wins.
  assert.equal(ref.cells.toolErrors.find((c) => c.session === "s")!.num, 1);
});

test("windows: today from now + zone; tier windows end yesterday; history 41 vs 42", () => {
  assert.equal(todayFor(new Date("2026-10-04T03:00:00Z"), "America/Chicago"), "2026-10-03");
  assert.equal(todayFor(new Date("2026-10-04T03:00:00Z"), "UTC"), "2026-10-04");
  assert.throws(() => todayFor(new Date("nope"), "UTC"));
  // The zone is required and must be real: never the machine's zone.
  assert.throws(() => todayFor(new Date("2026-10-04T03:00:00Z"), undefined as unknown as string), /timeZone is required/);
  assert.throws(() => todayFor(new Date("2026-10-04T03:00:00Z"), ""), /timeZone is required/);
  assert.throws(() => todayFor(new Date("2026-10-04T03:00:00Z"), "Mars/Olympus_Mons"), /valid IANA zone/);
  const t = dayIndex(TODAY)!;
  const w1 = tierWindows(t, TIERS[0]!);
  assert.deepEqual(rangeStrings(w1.recent), { from: "2026-09-20", to: "2026-10-03" });
  assert.deepEqual(rangeStrings(w1.baseline), { from: "2026-08-23", to: "2026-09-19" });
  const w3 = tierWindows(t, TIERS[2]!);
  assert.deepEqual(rangeStrings(w3.recent), { from: "2026-09-06", to: "2026-10-03" });
  assert.deepEqual(rangeStrings(w3.baseline), { from: "2026-07-12", to: "2026-09-05" });
  assert.equal(historyDays(t, t - 42), 42);
  assert.equal(historyDays(t, t - 41) >= TIERS[0]!.historyDays, false);
  assert.equal(historyDays(t, t - 42) >= TIERS[0]!.historyDays, true);
  assert.equal(historyDays(t, undefined), 0);
  assert.deepEqual(TIERS.map((x) => [x.recentDays, x.baselineDays, x.historyDays]), [[14, 28, 42], [21, 42, 63], [28, 56, 84]]);
});

test("cellsBetween and dailyTotals: inclusive bounds, zero days filled", () => {
  const b = buildCells([
    ex({ session: "a", day: "2026-09-19", toolCalls: 4, toolErrors: 1 }),
    ex({ session: "a", day: "2026-09-21", toolCalls: 6, toolErrors: 2 }),
    ex({ session: "b", day: "2026-09-21", toolCalls: 2 }),
  ], { agent: "claude-code", today: TODAY });
  const from = dayIndex("2026-09-20")!, to = dayIndex("2026-09-21")!;
  assert.deepEqual(cellsBetween(b.cells.toolErrors, from, to).map((c) => c.session), ["a", "b"]);
  assert.deepEqual(dailyTotals(b.cells.toolErrors, dayIndex("2026-09-19")!, to), [
    { d: "2026-09-19", k: 1, n: 4 },
    { d: "2026-09-20", k: 0, n: 0 },
    { d: "2026-09-21", k: 2, n: 8 },
  ]);
});
