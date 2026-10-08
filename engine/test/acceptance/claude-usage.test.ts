// Responses, tokens, API errors, thinking, compaction (research/05 #1, #3, #4, #6, #11). Fixture: usageScenario().
import { bySeq, expectFields, oneOf, parseScenario } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeReader } from "../../src/readers/claude.js";

const xsOf = async () => bySeq(await parseScenario(claudeReader, "usage"));

test("usage: 6 human prompts → 6 exchanges (the compaction summary is not a prompt)", async () => {
  const xs = await xsOf();
  assert.deepEqual(xs.map((x) => [x.t, x.humanPrompt]), [
    ["2026-09-25T09:00:00.000Z", 1],
    ["2026-09-25T09:05:00.000Z", 1],
    ["2026-09-25T09:10:00.000Z", 1],
    ["2026-09-25T09:15:00.000Z", 1],
    ["2026-09-25T09:20:00.000Z", 1],
    ["2026-09-25T09:30:00.000Z", 1],
  ]);
});

test("#1 streaming split: lines sharing requestId+message.id are ONE step; usage counted once with the MAX output_tokens", async () => {
  const [e0] = await xsOf();
  // response 1: 3 lines, out 12/12/310 → 310 (keeping the first line would give 12)
  // response 2: 3 lines, out 25/520/515 → 520 (MAX, not last)
  // response 3: 1 line, out 90
  // input/cache fields repeat on every line and must not be multiplied.
  expectFields(e0!, { steps: 3, outTok: 920, inTok: 3050, cacheRead: 24_500, cacheWrite: 9_000 }, "usage E0");
});

test("#1 content blocks from every streamed line still count (tool_use on the last line of a split response)", async () => {
  const [e0] = await xsOf();
  expectFields(e0!, { toolCalls: 1, reads: 1 }, "usage E0");
});

test("#11 thinking: block count, redacted (empty-text) count, median signature length", async () => {
  const xs = await xsOf();
  // signatures 400 (empty text), 1000 (non-empty), 600 (empty text) → median 600
  expectFields(xs[0]!, { thinkBlocks: 3, thinkRedacted: 2, thinkSigMedian: 600 }, "usage E0");
  for (const x of xs.slice(1)) expectFields(x, { thinkBlocks: 0, thinkRedacted: 0, thinkSigMedian: 0 }, `usage seq ${x.seq}`);
});

test("#6 three api_error retries then a <synthetic> isApiErrorMessage stub: apiRetries 3, apiErrors 1, no step, no tokens", async () => {
  const xs = await xsOf();
  expectFields(xs[1]!, { apiRetries: 3, apiErrors: 1, steps: 0, outTok: 0, inTok: 0, cacheRead: 0, cacheWrite: 0 }, "usage E1");
});

test("#6 the <synthetic> model is never reported as the exchange's model", async () => {
  const xs = await xsOf();
  oneOf(xs[1]!.model, ["unknown", "other"], "usage E1.model");
  oneOf(xs[1]!.servedModel, ["unknown", "other"], "usage E1.servedModel");
});

test("#6 retries that then succeed are retries, not errors", async () => {
  const xs = await xsOf();
  expectFields(xs[2]!, { apiRetries: 2, apiErrors: 0, steps: 1, outTok: 60, inTok: 20, cacheRead: 13_000, model: "claude-opus-5-5" }, "usage E2");
});

test("#3 no requestId: two different responses sharing one message.id (different timestamps) are 2 steps, not 1", async () => {
  const xs = await xsOf();
  // three responses: (msg RELAY, 09:15:05, out 30, in 100), (msg RELAY, 09:15:20, out 45, in 110), (msg 5, 09:15:30, out 50, in 120)
  expectFields(xs[3]!, { steps: 3, outTok: 125, inTok: 330, toolCalls: 2, apiErrors: 0, apiRetries: 0 }, "usage E3");
});

test("#4 compaction: compact_boundary counted; records re-logged after it with new uuids are not double-counted", async () => {
  const xs = await xsOf();
  // steps: response 6 (Read) + response 7; the replayed copy of response 6 (same requestId, tool_use id) adds nothing
  expectFields(xs[4]!, { compactions: 1, steps: 2, toolCalls: 1, reads: 1, outTok: 160, inTok: 8_030, cacheRead: 14_000, cacheWrite: 7_000, toolErrors: 0 }, "usage E4");
});

test("#4 afterCompaction: false before the compaction, true for exchanges that start after it", async () => {
  const xs = await xsOf();
  assert.deepEqual(xs.slice(0, 4).map((x) => x.afterCompaction), [false, false, false, false]);
  expectFields(xs[5]!, { afterCompaction: true, compactions: 0, steps: 1, outTok: 35, inTok: 15, cacheRead: 8_000 }, "usage E5");
});

test("usage: only E4 has a compaction; no API trouble outside E1/E2", async () => {
  const xs = await xsOf();
  assert.deepEqual(xs.map((x) => x.compactions), [0, 0, 0, 0, 1, 0]);
  assert.deepEqual(xs.map((x) => x.apiErrors), [0, 1, 0, 0, 0, 0]);
  assert.deepEqual(xs.map((x) => x.apiRetries), [0, 3, 2, 0, 0, 0]);
});
