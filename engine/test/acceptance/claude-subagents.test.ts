// Subagent and sidechain attribution (research/05 #5, #14; contract: subagent work is attributed to the exchange
// that spawned it, never creates an exchange, and only appears in subToolCalls/subTokens — "context only, never votes").
// Fixture: subagents(). Subagent usage is output-only so subTokens is the same under any token definition.
import { bySeq, expectFields, oneOf, parseScenario } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeReader } from "../../src/readers/claude.js";

const xsOf = async () => bySeq(await parseScenario(claudeReader, "subagents"));

test("#14 subagent and sidechain prompts never open an exchange: 4 human prompts → 4 exchanges", async () => {
  const xs = await xsOf();
  assert.deepEqual(xs.map((x) => [x.t, x.humanPrompt]), [
    ["2026-09-28T11:00:00.000Z", 1],
    ["2026-09-28T11:05:00.000Z", 1],
    ["2026-09-28T11:10:00.000Z", 1],
    ["2026-09-28T11:15:00.000Z", 1],
  ]);
});

test("#14 direct subagent work is attributed to the spawning exchange as subToolCalls/subTokens", async () => {
  const xs = await xsOf();
  // agent file: Glob (response split over 2 lines, out 100/260 → 260), Read (80), Grep (70), final text (150)
  expectFields(xs[1]!, { subToolCalls: 3, subTokens: 560 }, "subagents E1");
});

test("#14 nested workflow subagent (subagents/workflows/<wf>/agent-*.jsonl) is attributed too; journal.jsonl is ignored", async () => {
  const xs = await xsOf();
  // nested agent file: Edit (200), Bash (90), final (110). journal.jsonl would add 1 call / 99,999 tokens.
  expectFields(xs[2]!, { subToolCalls: 2, subTokens: 400 }, "subagents E2");
});

test("subagent work does not leak into main-thread steps, tool calls, reads/edits or tokens", async () => {
  const xs = await xsOf();
  // E1 main: Task tool_use + final reply. E2 main: Task tool_use + final reply (the subagent's Edit is not a main edit).
  expectFields(xs[1]!, { steps: 2, toolCalls: 1, reads: 0, edits: 0, outTok: 210, inTok: 90, cacheRead: 3_200, cacheWrite: 0 }, "subagents E1");
  expectFields(xs[2]!, { steps: 2, toolCalls: 1, reads: 0, edits: 0, blindEdits: 0, outTok: 120, inTok: 60, cacheRead: 3_700, cacheWrite: 0 }, "subagents E2");
  expectFields(xs[0]!, { steps: 1, toolCalls: 0, outTok: 40, subToolCalls: 0, subTokens: 0 }, "subagents E0");
});

test("subagent model/effort (claude-sonnet-5 / low) never vote on the exchange's labels or create change events", async () => {
  const r = await parseScenario(claudeReader, "subagents");
  for (const x of r.exchanges) expectFields(x, { model: "claude-opus-5-5", effort: "high" }, `subagents seq ${x.seq}`);
  assert.deepEqual(r.events.filter((e) => e.kind === "model" || e.kind === "effort"), []);
});

test("#5 inline /btw sidechain: re-logged parent history is not re-counted; the aside is never a main-thread step", async () => {
  const xs = await xsOf();
  const e3 = xs[3]!;
  expectFields(e3, { steps: 1, toolCalls: 0, subToolCalls: 0, humanPrompt: 1 }, "subagents E3");
  // Main reply out 45. The aside's own reply (out 35) may be reported as main or as sidechain activity — but
  // never both, and the replayed copy of E0's response (out 40) must not be counted again anywhere.
  oneOf(e3.outTok, [45, 80], "subagents E3.outTok");
  oneOf(e3.subTokens, [0, 35], "subagents E3.subTokens");
  oneOf(e3.outTok + e3.subTokens, [45, 80], "subagents E3.outTok + subTokens");
});

test("subagents source parses 3 files with no format drift", async () => {
  const r = await parseScenario(claudeReader, "subagents");
  expectFields(r.stats, { files: 3, filesFailed: 0, badLines: 0, truncatedTail: 0, unknownTypes: {}, badTimestamps: 0 }, "subagents stats");
});
