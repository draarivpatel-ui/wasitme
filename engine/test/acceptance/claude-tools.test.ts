// Tool outcomes and edit-quality indicators (research/05 #10; contract fields toolErrors, rejections, blocked,
// reads, edits, blindEdits, churned). Fixture: build-fixtures.ts → tools(); call numbers below refer to its comments.
import { bySeq, expectFields, parseScenario } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeReader } from "../../src/readers/claude.js";

test("tools: two exchanges", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "tools"));
  assert.deepEqual(xs.map((x) => x.t), ["2026-09-22T14:00:00.000Z", "2026-09-22T14:30:00.000Z"]);
});

test("#10 toolDenialKind splits outcomes: user-rejected → rejections; automode-blocked + permission-rule → blocked; plain is_error → toolErrors", async () => {
  const [e0, e1] = bySeq(await parseScenario(claudeReader, "tools"));
  // #4 Bash failed; #8 Edit user-rejected; #9 automode-blocked; #10 permission-rule
  expectFields(e0!, { toolErrors: 1, rejections: 1, blocked: 2 }, "tools E0");
  expectFields(e1!, { toolErrors: 0, rejections: 0, blocked: 0 }, "tools E1");
});

test("tool calls and read/edit classification (Read/Grep/Glob/LS = read; Edit/Write/MultiEdit/NotebookEdit = edit)", async () => {
  const [e0, e1] = bySeq(await parseScenario(claudeReader, "tools"));
  // E0: 15 tool_use blocks. reads: #1 Read a, #7 Read c, #11 Glob, #12 Grep, #15 Read f = 5.
  //     edits: #2 #3 #5 #6 #8 #14 Edit + #13 MultiEdit = 7. (#4 #9 Bash, #10 WebFetch are neither.)
  expectFields(e0!, { toolCalls: 15, reads: 5, edits: 7 }, "tools E0");
  // E1: Edit f, Edit a, Read g, Edit g
  expectFields(e1!, { toolCalls: 4, reads: 1, edits: 3 }, "tools E1");
});

test("#1 one response streamed as two lines with two tool_use blocks: 1 step, 2 tool calls, usage counted once", async () => {
  const [e0, e1] = bySeq(await parseScenario(claudeReader, "tools"));
  // E0: 14 single-line responses + 1 two-line response = 15 steps; every line carries usage {in 10, out 20, cacheRead 1000}
  expectFields(e0!, { steps: 15, outTok: 300, inTok: 150, cacheRead: 15_000, cacheWrite: 0 }, "tools E0");
  expectFields(e1!, { steps: 5, outTok: 100, inTok: 50, cacheRead: 5_000, cacheWrite: 0 }, "tools E1");
});

test("blindEdits: edit with no read of that file earlier in the exchange or in the previous 10 tool calls", async () => {
  const [e0, e1] = bySeq(await parseScenario(claudeReader, "tools"));
  // E0: #3 Edit b (never read) and #14 Edit e (never read) are blind; edits of a (read #1) and c (read #7) are not.
  expectFields(e0!, { blindEdits: 2 }, "tools E0");
  // E1: Edit f — f was read by the immediately preceding tool call (#15, previous exchange) → not blind.
  //     Edit a — a's only read was 15 tool calls earlier, in the previous exchange → blind.
  //     Edit g — read just before → not blind.
  expectFields(e1!, { blindEdits: 1 }, "tools E1");
});

test("churned: 1 when a single file is edited 3+ times within the exchange", async () => {
  const [e0, e1] = bySeq(await parseScenario(claudeReader, "tools"));
  // E0: a.ts edited by #2, #5, #6 (3×). c.ts at most 2× (#8 rejected, #13). E1: every file once.
  assert.equal(e0!.churned, 1);
  assert.equal(e1!.churned, 0);
});

test("tools: labels and clean stats", async () => {
  const r = await parseScenario(claudeReader, "tools");
  for (const x of r.exchanges) expectFields(x, { version: "2.1.289", model: "claude-opus-5-5", effort: "high", mode: "auto", humanPrompt: 1, interrupted: 0 }, `tools seq ${x.seq}`);
  expectFields(r.stats, { files: 1, filesFailed: 0, badLines: 0, truncatedTail: 0, unknownTypes: {}, badTimestamps: 0 }, "tools stats");
});
