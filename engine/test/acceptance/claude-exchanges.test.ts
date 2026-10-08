// Exchange boundaries: which user records are real human prompts (research/05 #7, #8, #9), and the
// per-exchange numbers for the happy-path session. Expected values are derived by hand from build-fixtures.ts.
import { bySeq, expectFields, parseScenario } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROMPTS } from "../fixtures/acceptance/claude/build-fixtures.js";
import { claudeReader } from "../../src/readers/claude.js";

const NOTHING_ELSE = { apiErrors: 0, apiRetries: 0, compactions: 0, thinkBlocks: 0, thinkRedacted: 0, thinkSigMedian: 0, subToolCalls: 0, subTokens: 0, afterCompaction: false };

// ------------------------------------------------------------------ basic (happy path)

test("basic: 4 human prompts → 4 exchanges in file order with prompt timestamps", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "basic"));
  assert.deepEqual(
    xs.map((x) => [x.seq, x.t, x.day, x.humanPrompt]),
    [
      [0, "2026-09-15T10:00:00.000Z", "2026-09-15", 1],
      [1, "2026-09-15T10:05:00.000Z", "2026-09-15", 1],
      [2, "2026-09-15T10:10:00.000Z", "2026-09-15", 1],
      [3, "2026-09-15T10:15:00.000Z", "2026-09-15", 1],
    ],
  );
});

test("basic: steps and token sums per exchange (requestId-deduped, main thread)", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "basic"));
  // E0: 3 responses: out 80+200+60, in 1200+50+20, cacheRead 5000+6200+6400, cacheWrite 300+0+100
  expectFields(xs[0]!, { steps: 3, outTok: 340, inTok: 1270, cacheRead: 17600, cacheWrite: 400 }, "basic E0");
  // E1: 4 responses: out 40+35+150+30, in 30+20+30+10, cacheRead 7000+7200+7300+7500, cacheWrite 200
  expectFields(xs[1]!, { steps: 4, outTok: 255, inTok: 90, cacheRead: 29000, cacheWrite: 200 }, "basic E1");
  // E2: 2 responses: out 90+50, in 40+10, cacheRead 7600+7700
  expectFields(xs[2]!, { steps: 2, outTok: 140, inTok: 50, cacheRead: 15300, cacheWrite: 0 }, "basic E2");
  // E3: 1 response
  expectFields(xs[3]!, { steps: 1, outTok: 70, inTok: 15, cacheRead: 7800, cacheWrite: 0 }, "basic E3");
});

test("basic: tool calls, reads, edits; nothing failed", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "basic"));
  const clean = { toolErrors: 0, rejections: 0, blocked: 0, blindEdits: 0, churned: 0, interrupted: 0, queuedMidTurn: 0 };
  expectFields(xs[0]!, { toolCalls: 2, reads: 1, edits: 1, ...clean }, "basic E0"); // Read F, Edit F
  expectFields(xs[1]!, { toolCalls: 3, reads: 2, edits: 1, ...clean }, "basic E1"); // Grep, Read F, Edit F
  expectFields(xs[2]!, { toolCalls: 1, reads: 0, edits: 0, ...clean }, "basic E2"); // Bash
  expectFields(xs[3]!, { toolCalls: 0, reads: 0, edits: 0, ...clean }, "basic E3");
  for (const [i, x] of xs.entries()) expectFields(x, NOTHING_ELSE, `basic E${i}`);
});

test("basic: durationMs = prompt → last record of the exchange", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "basic"));
  assert.deepEqual(xs.map((x) => x.durationMs), [30_000, 25_000, 26_000, 9_000]);
});

test("basic: promptChars is the prompt's length; pushback = phrase heuristic OR near-duplicate of the previous prompt", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "basic"));
  assert.deepEqual(xs.map((x) => x.promptChars), [PROMPTS.basic0.length, PROMPTS.basic1.length, PROMPTS.basic2.length, PROMPTS.basic3.length]);
  // E1 starts "no, …" (pushback phrase); E3 repeats E2's prompt + " please" (Jaccard 0.85 ≥ 0.6)
  assert.deepEqual(xs.map((x) => x.pushback), [0, 1, 0, 1]);
});

test("basic: labels come from the records (constant here) and Claude logs have no separate served model", async () => {
  for (const x of (await parseScenario(claudeReader, "basic")).exchanges) {
    expectFields(x, { version: "2.1.288", model: "claude-opus-5-5", servedModel: "claude-opus-5-5", effort: "high", mode: "default", entrypoint: "claude-desktop" }, `basic seq ${x.seq}`);
  }
});

test("basic: constant labels produce no change events; stats are clean", async () => {
  const r = await parseScenario(claudeReader, "basic");
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.stats, { files: 1, filesFailed: 0, badLines: 0, truncatedTail: 0, unknownTypes: {}, duplicates: 0, badTimestamps: 0 });
});

// ------------------------------------------------------------------ filters (legacy records, no origin field)

test("#7 legacy non-prompt user records never start an exchange (meta, caveats, command output, continuation summary, task notifications, stop-hook feedback, system reminders, IDE tags, tool-result carriers, interrupts)", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "filters"));
  assert.deepEqual(xs.map((x) => [x.t, x.humanPrompt]), [
    ["2026-09-18T09:01:00.000Z", 1],
    ["2026-09-18T09:03:00.000Z", 1],
    ["2026-09-18T09:04:00.000Z", 1],
  ]);
});

test("#7 a legacy prompt starting with \"[Image #1]\" (text + image block, no origin) is a human prompt", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "filters"));
  expectFields(xs[0]!, { humanPrompt: 1, promptChars: PROMPTS.image1.length, pushback: 0, toolCalls: 1, reads: 1 }, "filters E0");
});

test("#6 a <synthetic> stub that is not an API error ('No response requested.') is not a step and not an API error", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "filters"));
  // E0 has one real response (Read) plus the synthetic stub after the interrupt
  expectFields(xs[0]!, { steps: 1, outTok: 60, inTok: 900, cacheWrite: 4_000, apiErrors: 0, apiRetries: 0, model: "claude-sonnet-5" }, "filters E0");
});

test("#9 interrupts: list-form, string-form and '… for tool use' all set interrupted; two in one exchange still = 1", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "filters"));
  assert.deepEqual(xs.map((x) => x.interrupted), [1, 1, 1]);
});

test("#10 legacy rejection (no toolDenialKind, 'doesn't want to proceed' text) is a rejection, not a tool error", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "filters"));
  expectFields(xs[1]!, { toolCalls: 1, edits: 1, rejections: 1, toolErrors: 0, blocked: 0, steps: 1, pushback: 0 }, "filters E1");
});

test("filters E2: phrase pushback ('Why did you …'); LS is a read; the string-content tool-result carrier is not a prompt", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "filters"));
  expectFields(xs[2]!, { pushback: 1, steps: 2, toolCalls: 1, reads: 1, toolErrors: 0, rejections: 0 }, "filters E2");
});

test("legacy logs without an effort field → effort 'unknown'; other labels from the records", async () => {
  for (const x of (await parseScenario(claudeReader, "filters")).exchanges) {
    expectFields(x, { version: "2.1.205", model: "claude-sonnet-5", servedModel: "claude-sonnet-5", effort: "unknown", mode: "default", entrypoint: "cli" }, `filters seq ${x.seq}`);
  }
});

// ------------------------------------------------------------------ modern (origin.kind)

test("modern: agent-initiated work before the first human prompt is its own exchange with humanPrompt 0", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "modern"));
  assert.equal(xs.length, 4);
  // t = first record of the stretch (the task-notification record), per the contract's "or first record if agent-initiated"
  expectFields(xs[0]!, { seq: 0, humanPrompt: 0, promptChars: 0, pushback: 0, t: "2026-09-20T08:00:00.000Z", steps: 1, outTok: 50, inTok: 100, cacheRead: 2000 }, "modern X0");
  assert.deepEqual(xs.slice(1).map((x) => [x.t, x.humanPrompt]), [
    ["2026-09-20T08:10:00.000Z", 1],
    ["2026-09-20T08:20:00.000Z", 1],
    ["2026-09-20T08:21:00.000Z", 1],
  ]);
});

test("#8 queued_command attachments (string and block prompts) count as queuedMidTurn once each — queue-operation twins, isMeta and peer entries are not counted, and none opens an exchange", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "modern"));
  assert.deepEqual(xs.map((x) => x.queuedMidTurn), [0, 2, 0, 0]);
});

test("modern E1: a peer message (origin.kind peer) is not a prompt — its reply stays in the same exchange", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "modern"));
  // 3 responses: out 100+80+20, in 200+50+30, cacheRead 3000+3200+3300, cacheWrite 100
  expectFields(xs[1]!, { promptChars: PROMPTS.modern1.length, steps: 3, toolCalls: 1, outTok: 200, inTok: 280, cacheRead: 9500, cacheWrite: 100, interrupted: 0, pushback: 0 }, "modern E1");
});

test("#7/#9 modern: '[Image #2]' prompt with origin human is a prompt; an interrupt carrying origin.kind human is not", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "modern"));
  expectFields(xs[2]!, { humanPrompt: 1, promptChars: PROMPTS.image2.length, interrupted: 1, steps: 1, outTok: 45, cacheWrite: 1500, pushback: 0 }, "modern E2");
  expectFields(xs[3]!, { humanPrompt: 1, interrupted: 0, pushback: 0, steps: 1, outTok: 25 }, "modern E3");
});

test("modern: labels, and queue-operation records are known (not format drift)", async () => {
  const r = await parseScenario(claudeReader, "modern");
  for (const x of bySeq(r).slice(1)) {
    expectFields(x, { version: "2.1.289", model: "claude-opus-5-5", effort: "medium", mode: "auto", entrypoint: "claude-desktop" }, `modern seq ${x.seq}`);
  }
  assert.deepEqual(r.stats.unknownTypes, {});
  assert.equal(r.stats.badLines, 0);
});
