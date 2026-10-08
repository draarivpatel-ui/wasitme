import { test } from "node:test";
import assert from "node:assert/strict";
import { Rollout, uuid, writeTree } from "../fixtures/codex/build.js";
import { scan } from "../fixtures/codex/harness.js";

test("legacy, response_item-only file: prompts from user messages, tools from calls, tokens from token_count", async () => {
  const id = uuid(11);
  const content = new Rollout("2026-08-01T08:00:00Z")
    .meta({ id, legacy: true, cli: "0.142.0", originator: "codex_cli_rs", source: "cli" })
    .respUser("# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nsynthetic\n</INSTRUCTIONS>")
    .respUser("<environment_context>\n  <cwd>/work</cwd>\n</environment_context>")
    .tick().respUser("fix the failing test")
    .respReasoning(40, "Looking at the tests")
    .fnCall("c1").fnOutput("c1", "Process exited with code 1\nfailed")
    .fnCall("c2", "apply_patch", "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch").fnOutput("c2", "Success.", true)
    .tokenCount({ input: 1000, cached: 200, output: 100 }, { input: 1000, cached: 200, output: 100 })
    .tokenCount({ input: 1000, cached: 200, output: 100 }, { input: 1000, cached: 200, output: 100 })
    .respAssistant()
    .tick(60_000).respUser("thanks, now update the docs")
    .fnCall("c3").fnOutput("c3", "Exit code: 0")
    .tokenCount({ input: 2500, cached: 900, output: 160 })
    .text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges: ex, stats } = await scan(root);
  assert.equal(ex.length, 2);
  const [e0, e1] = ex as [typeof ex[0], typeof ex[0]];
  assert.deepEqual(ex.map((e) => e.humanPrompt), [1, 1]);
  assert.equal(e0.promptChars, "fix the failing test".length);
  assert.equal(e0.toolCalls, 2);
  assert.equal(e0.toolErrors, 1);
  assert.equal(e0.edits, 1);
  assert.equal(e0.blindEdits, 1, "no read of src/a.ts");
  assert.equal(e0.steps, 1, "re-emitted cumulative token_count is skipped");
  assert.equal(e0.inTok, 800);
  assert.equal(e0.cacheRead, 200);
  assert.equal(e0.outTok, 100);
  assert.equal(e0.thinkBlocks, 1);
  assert.equal(e0.thinkRedacted, 0);
  assert.equal(e0.thinkSigMedian, 40);
  assert.equal(e0.model, "unknown");
  assert.equal(e0.version, "0.142.0");
  assert.equal(e0.entrypoint, "cli", "entrypoint is session_meta.source, never the originator");
  assert.equal(e1.toolCalls, 1);
  assert.equal(e1.toolErrors, 0);
  assert.equal(e1.steps, 1);
  assert.equal(e1.inTok, 1500 - 700, "no last_token_usage → delta of cumulative totals");
  assert.equal(e1.cacheRead, 700);
  assert.equal(e1.outTok, 60);
  assert.equal(stats.duplicates, 1);
});

test("legacy file with *_end events: tools from events only (response_item calls ignored), aborts, errors", async () => {
  const id = uuid(12);
  const content = new Rollout("2026-08-05T08:00:00Z")
    .meta({ id, legacy: true, cli: "0.150.0", cwd: "/repo" })
    .started()
    .respUser("<environment_context>\n<cwd>/repo</cwd>\n</environment_context>")
    .respUser("refactor the parser")
    .event("user_message", { message: "refactor the parser", images: [] })
    .ctx(undefined, { model: "gpt-legacy", effort: "medium", approval: "on-request" })
    .event("exec_command_begin", { call_id: "e1", command: ["cat", "src/parser.ts"], parsed_cmd: [{ type: "read", cmd: "cat src/parser.ts", name: "parser.ts", path: "src/parser.ts" }] })
    .fnCall("e1")
    .event("exec_command_end", { call_id: "e1", exit_code: 0, stdout: "synthetic" })
    .event("exec_command_end", { call_id: "e2", exit_code: 2, stdout: "" })
    .event("patch_apply_begin", { call_id: "p1", auto_approved: true, changes: { "/repo/src/parser.ts": { update: { unified_diff: "@@" } } } })
    .event("patch_apply_end", { call_id: "p1", success: true, stdout: "", stderr: "" })
    .event("mcp_tool_call_end", { call_id: "m1", invocation: { server: "s", tool: "t" }, result: { Err: "boom" } })
    .tokenCount({ input: 400, cached: 100, output: 40 }, { input: 400, cached: 100, output: 40 })
    .tick().aborted(undefined)
    .tick(30_000).started()
    .respUser("<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>")
    .respUser("try a smaller change")
    .ctx(undefined, { model: "gpt-legacy", effort: "medium", approval: "on-request" })
    .rec("compacted", { message: "summary" })
    .event("error", { message: "synthetic failure" })
    .event("stream_error", { message: "retrying" })
    .event("exec_command_end", { call_id: "e3", exit_code: 0 })
    .tokenCount({ input: 900, cached: 300, output: 70 }, { input: 500, cached: 200, output: 30 })
    .complete()
    .text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges: ex, events } = await scan(root);
  assert.equal(ex.length, 2);
  const [e0, e1] = ex as [typeof ex[0], typeof ex[0]];
  assert.equal(e0.humanPrompt, 1);
  assert.equal(e0.toolCalls, 4);
  assert.equal(e0.toolErrors, 2);
  assert.equal(e0.reads, 1);
  assert.equal(e0.edits, 1);
  assert.equal(e0.blindEdits, 0, "relative read path matches the absolute edit path");
  assert.equal(e0.interrupted, 1);
  assert.equal(e0.steps, 1);
  assert.equal(e0.model, "gpt-legacy");
  assert.equal(e0.effort, "medium");
  assert.equal(e0.mode, "on-request");
  assert.equal(e1.humanPrompt, 1);
  assert.equal(e1.promptChars, "try a smaller change".length);
  assert.equal(e1.compactions, 1);
  assert.equal(e1.apiErrors, 1);
  assert.equal(e1.apiRetries, 1);
  assert.equal(e1.toolCalls, 1);
  assert.equal(e1.inTok, 300);
  assert.equal(events.length, 0);
});

test("legacy fork without a start ordinal, parent missing: replayed history before the first turn marker is skipped", async () => {
  const id = uuid(13);
  const content = new Rollout("2026-09-12T10:00:00Z")
    .meta({ id, legacy: true, forkedFrom: uuid(77), threadSource: "user" })
    .respUser("old prompt from the parent").fnCall("o1").fnOutput("o1", "ok").respAssistant()
    .tick(20_000).started().respUser("new prompt in the fork").fnCall("n1").fnOutput("n1", "ok")
    .tokenCount({ input: 10, output: 1 })
    .text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges, stats } = await scan(root);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0]!.promptChars, "new prompt in the fork".length);
  assert.equal(exchanges[0]!.toolCalls, 1);
  assert.equal(stats.duplicates, 4);
  assert.deepEqual(stats.unknownTypes, { "codex:fork-unresolved": 1 }, "parent file missing: heuristic used, and visible");
});

test("a cumulative token_count that goes down restarted its counter: the new total is all new usage", async () => {
  const id = uuid(15);
  const content = new Rollout("2026-08-03T08:00:00Z").meta({ id, legacy: true })
    .respUser("first").tokenCount({ input: 1000, output: 100 })
    .tick().respUser("second").tokenCount({ input: 40, output: 4 })
    .text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges } = await scan(root);
  assert.deepEqual(exchanges.map((e) => [e.inTok, e.outTok]), [[1000, 100], [40, 4]]);
});

test("legacy file without turn markers: each typed prompt is its own exchange", async () => {
  const id = uuid(14);
  const content = new Rollout("2026-08-02T08:00:00Z").meta({ id, legacy: true })
    .respUser("first question").respAssistant()
    .tick().respUser("second question").respAssistant()
    .tick().respUser("third question").fnCall("x").fnOutput("x", "ok")
    .text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges } = await scan(root);
  assert.deepEqual(exchanges.map((e) => e.promptChars), ["first question".length, "second question".length, "third question".length]);
  assert.deepEqual(exchanges.map((e) => e.queuedMidTurn), [0, 0, 0]);
});

test("an id-less turn_context before an id-carrying task_started: its settings apply and stay in effect", async () => {
  const id = uuid(16);
  const [t1, t2] = [uuid(161), uuid(162)];
  const content = new Rollout("2026-08-06T08:00:00Z")
    .meta({ id, legacy: true, cli: "0.98.0", originator: "codex_cli_rs", source: "cli" })
    .respUser("<environment_context>\n<cwd>/repo</cwd>\n</environment_context>")
    .ctx(undefined, { model: "gpt-legacy", effort: "medium", approval: "on-request" })
    .started(t1).respUser("first task").event("user_message", { message: "first task", images: [] })
    .event("exec_command_end", { turn_id: t1, call_id: "a1", exit_code: 0 })
    .tokenCount({ input: 100, output: 10 }, { input: 100, output: 10 }).complete(t1)
    .tick(60_000).started(t2).respUser("second task").event("user_message", { message: "second task", images: [] })
    .tokenCount({ input: 300, output: 30 }, { input: 200, output: 20 }).complete(t2)
    .text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges: ex, stats } = await scan(root);
  assert.equal(ex.length, 2);
  assert.deepEqual(ex.map((e) => [e.model, e.effort, e.mode]), [["gpt-legacy", "medium", "on-request"], ["gpt-legacy", "medium", "on-request"]]);
  assert.deepEqual(ex.map((e) => e.entrypoint), ["cli", "cli"]);
  assert.deepEqual(ex.map((e) => e.humanPrompt), [1, 1]);
  assert.deepEqual(ex.map((e) => e.promptChars), ["first task".length, "second task".length]);
  assert.deepEqual(ex.map((e) => e.queuedMidTurn), [0, 0], "a user_message event is the response_item prompt's twin, not a second prompt");
  assert.equal(stats.duplicates, 2, "one user_message twin per turn");
});

test("migrated file: history source chosen per turn; legacy-only, doubled and canonical-only turns each count once", async () => {
  const id = uuid(17);
  const [f1, f2, f3] = [uuid(171), uuid(172), uuid(173)];
  const content = new Rollout("2026-09-20T08:00:00Z").meta({ id, threadSource: "user" })
    // F1: legacy records only, in a file whose later turns have canonical items
    .started(f1).ctx(f1).respUser("explain the cache").event("user_message", { message: "explain the cache" })
    .event("exec_command_end", { turn_id: f1, call_id: "x1", exit_code: 0, parsed_cmd: [{ type: "read", path: "src/cache.ts" }] })
    .tokenCount({ input: 1000, cached: 400, output: 50 }, { input: 1000, cached: 400, output: 50 }).complete(f1)
    // F2: every record twice (canonical item + legacy twin with the same call id / text)
    .tick(60_000).started(f2).ctx(f2).respUser("make the TTL configurable").event("user_message", { message: "make the TTL configurable" })
    .user(f2, "make the TTL configurable")
    .item(f2, { type: "CommandExecution", id: "x2", status: "failed", parsed_cmd: [{ type: "unknown" }] })
    .event("exec_command_end", { turn_id: f2, call_id: "x2", exit_code: 1 })
    .usage(f2, "r2", { input: 2000, cached: 1500, output: 80 })
    .tokenCount({ input: 3000, cached: 1900, output: 130 }, { input: 2000, cached: 1500, output: 80 }).complete(f2)
    // F3: canonical only
    .tick(60_000).started(f3).ctx(f3).user(f3, "thanks, update the docs").cmd(f3).usage(f3, "r3", { input: 500, output: 20 }).complete(f3)
    .text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges: ex, stats } = await scan(root);
  assert.equal(ex.length, 3);
  assert.deepEqual(ex.map((e) => e.humanPrompt), [1, 1, 1], "the legacy-only turn keeps its prompt");
  assert.deepEqual(ex.map((e) => e.promptChars), ["explain the cache".length, "make the TTL configurable".length, "thanks, update the docs".length]);
  assert.deepEqual(ex.map((e) => e.queuedMidTurn), [0, 0, 0]);
  assert.deepEqual(ex.map((e) => e.toolCalls), [1, 1, 1]);
  assert.deepEqual(ex.map((e) => e.toolErrors), [0, 1, 0]);
  assert.deepEqual(ex.map((e) => e.reads), [1, 0, 0]);
  assert.deepEqual(ex.map((e) => e.steps), [1, 1, 1]);
  assert.deepEqual(ex.map((e) => e.inTok), [600, 500, 500]);
  assert.equal(stats.duplicates, 1 + 4, "F1: user_message twin; F2: prompt twins x2, exec_command_end twin, token_count twin");
});
