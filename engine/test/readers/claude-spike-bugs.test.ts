// Regression fixtures for every Claude reader bug class found by the real-log spike (research/05 "Parser edge cases"
// #1–20) and by the D39 acceptance judges. Each test rebuilds the bug's shape
// from field names only (100% synthetic, fixtures/claude/builder.ts) and pins the fixed behaviour.
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { claudeReader } from "../../src/readers/claude.js";
import {
  image, makeRoot, parseSession, pause, projectPath, replayInto, scan, SessionBuilder, text, toolUseBlock, withRoot,
  writeJsonl, writeSession,
} from "../fixtures/claude/builder.js";

const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

test("spike: raw U+2028/U+2029 inside JSON strings never split a record (Node readline does)", async () => {
  const s = new SessionBuilder("sess-sb-2028");
  const prompt = "first line second line third";
  s.prompt(prompt);
  s.response([text("ok still the same block"), toolUseBlock("u1", "Read", { file_path: "/synthetic/a b.ts" })]);
  s.toolResult("u1", { content: "line line" });
  assert.ok(JSON.stringify(s.records[0]).includes(" "), "fixture holds the raw separator");
  const r = await parseSession(s);
  assert.equal(r.stats.badLines, 0);
  assert.deepEqual(r.exchanges.map((x) => [x.promptChars, x.steps, x.toolCalls, x.reads]), [[prompt.length, 1, 1, 1]]);
});

test("spike: prompts typed mid-turn (queued_command) count once, deduped against their queue-operation twin (~26% were dropped)", async () => {
  const s = new SessionBuilder("sess-sb-queued");
  s.prompt("migrate the loader");
  s.response([toolUseBlock("q1", "Bash", {})]);
  s.queueOp("enqueue", "and add a test");
  s.attachment({ type: "queued_command", prompt: "and add a test", commandMode: "prompt", origin: { kind: "human" } });
  s.queueOp("remove", "and add a test", { reason: "absorbed_mid_turn" });
  s.toolResult("q1");
  s.response([text("done")]);
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => [x.humanPrompt, x.queuedMidTurn]), [[1, 1]]);
});

test("spike: a resumed session's replayed records (same uuids, new file) are counted once, by the earlier session", async () => {
  const root = makeRoot();
  const P = "-synthetic-sb-resume";
  const a = new SessionBuilder("sess-sb-a");
  a.prompt("one"); a.response([text("a")]);
  a.prompt("two"); a.response([text("b")]);
  writeSession(root, P, a);
  await pause();
  const b = new SessionBuilder("sess-sb-b", { start: "2026-09-02T10:00:00.000Z" });
  replayInto(b, a.records);
  b.prompt("three"); b.response([text("c")]);
  writeSession(root, P, b);
  const r = await scan(root);
  const ra = r.get(`${P}/sess-sb-a.jsonl`)!.result;
  const rb = r.get(`${P}/sess-sb-b.jsonl`)!.result;
  assert.equal(ra.exchanges.length, 2);
  assert.equal(rb.exchanges.length, 1);
  assert.equal(rb.stats.duplicates, a.records.length);
  assert.equal([...ra.exchanges, ...rb.exchanges].reduce((n, x) => n + x.steps, 0), 3);
});

test("spike: nested workflow subagents (subagents/workflows/<run>/agent-*.jsonl) are found; the run journal is not a transcript", async () => {
  const root = makeRoot();
  const P = "-synthetic-sb-nested";
  const s = new SessionBuilder("sess-sb-nested");
  s.prompt("run the workflow");
  s.response([toolUseBlock("wf", "Workflow", {})]);
  s.toolResult("wf", { toolUseResult: { runId: "run-7", status: "completed" } });
  writeSession(root, P, s);
  const sub = new SessionBuilder("n1");
  sub.response([toolUseBlock("n1-a", "Read", {}), toolUseBlock("n1-b", "Grep", {})], { usage: { ...zero, output_tokens: 40 } });
  const dir = join(projectPath(root, P), "sess-sb-nested", "subagents", "workflows", "run-7");
  writeJsonl(join(dir, "agent-n1.jsonl"), sub.records);
  writeJsonl(join(dir, "journal.jsonl"), [{ type: "started", usage: { output_tokens: 99_999 } }]);
  const listed = await withRoot(root, () => claudeReader.list());
  assert.deepEqual(listed[0]!.files.map((f) => f.path.endsWith("journal.jsonl")), [false, false]);
  const r = (await scan(root)).get(`${P}/sess-sb-nested.jsonl`)!.result;
  assert.deepEqual(r.exchanges.map((x) => [x.toolCalls, x.subToolCalls, x.subTokens]), [[1, 2, 40]]);
});

test("spike: a streamed response counts once with the MAX output_tokens of its lines (the first line undercounts)", async () => {
  const s = new SessionBuilder("sess-sb-maxout");
  s.prompt("explain");
  s.response([text("a"), text("b"), text("c")], { usage: { ...zero, output_tokens: 0 }, outPerLine: [12, 500, 480] });
  const [x] = (await parseSession(s)).exchanges;
  assert.deepEqual([x!.steps, x!.outTok], [1, 500]);
});

test("spike: API retries (system api_error) and final failures (isApiErrorMessage stub) are kept apart", async () => {
  const s = new SessionBuilder("sess-sb-retries");
  s.prompt("first");
  s.system("api_error", { retryAttempt: 1, maxRetries: 10 });
  s.system("api_error", { retryAttempt: 2, maxRetries: 10 });
  s.apiErrorMessage("API Error: 529 synthetic overload");
  s.prompt("second");
  s.system("api_error", { retryAttempt: 1, maxRetries: 10 });
  s.response([text("recovered")]);
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => [x.apiRetries, x.apiErrors, x.steps]), [[2, 1, 0], [1, 0, 1]]);
  assert.deepEqual(r.exchanges.map((x) => x.model), ["unknown", "claude-sonnet-5"], "the <synthetic> stub is never a model");
});

test("spike: `relocated` (D62b, EnterWorktree moved the transcript) is a known record type, never format drift", async () => {
  const s = new SessionBuilder("sess-sb-relocated");
  s.meta("relocated", { relocatedCwd: "/synthetic/elsewhere" });
  s.prompt("hello"); s.response([text("hi")]);
  const r = await parseSession(s);
  assert.deepEqual(r.stats.unknownTypes, {});
  assert.equal(r.exchanges.length, 1);
});

test("spike: legacy prompts starting with '[Image #1]' and list-form prompts are human prompts (a '[' / string-only filter drops them)", async () => {
  const s = new SessionBuilder("sess-sb-image");
  s.user([text("[Image #1] why does this layout break?"), image()], { imagePasteIds: [1] });
  s.response([text("because")]);
  s.user([text("ok, fix it then")]);
  s.response([text("fixed")]);
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => x.humanPrompt), [1, 1]);
});

test("spike: a tool_use id logged twice in a subagent file counts once", async () => {
  const root = makeRoot();
  const P = "-synthetic-sb-subdup";
  const s = new SessionBuilder("sess-sb-subdup");
  s.prompt("delegate");
  s.response([toolUseBlock("ag", "Agent", {})]);
  s.toolResult("ag", { toolUseResult: { agentId: "d1", status: "completed" } });
  writeSession(root, P, s);
  const sub = new SessionBuilder("d1");
  sub.response([toolUseBlock("d1-x", "Read", {})], { usage: zero });
  const again = { ...sub.records[0]!, uuid: "d1-relogged" }; // same tool_use block re-logged under a new uuid
  sub.push(again);
  writeJsonl(join(projectPath(root, P), "sess-sb-subdup", "subagents", "agent-d1.jsonl"), sub.records);
  const r = (await scan(root)).get(`${P}/sess-sb-subdup.jsonl`)!.result;
  assert.deepEqual(r.exchanges.map((x) => x.subToolCalls), [1]);
});

test("spike: subagent work never adds to main-thread steps, tool calls, reads/edits, tool errors or tokens", async () => {
  const root = makeRoot();
  const P = "-synthetic-sb-subleak";
  const s = new SessionBuilder("sess-sb-subleak");
  s.prompt("delegate the edit");
  s.response([toolUseBlock("ag", "Agent", {})], { usage: { ...zero, output_tokens: 10 } });
  s.toolResult("ag", { toolUseResult: { agentId: "e1", status: "completed" } });
  writeSession(root, P, s);
  const sub = new SessionBuilder("e1");
  sub.response([toolUseBlock("e1-r", "Read", { file_path: "/synthetic/x.ts" }), toolUseBlock("e1-e", "Edit", { file_path: "/synthetic/x.ts" })], { usage: { ...zero, output_tokens: 300 } });
  sub.toolResult("e1-e", { isError: true, content: "Exit code 1" });
  writeJsonl(join(projectPath(root, P), "sess-sb-subleak", "subagents", "agent-e1.jsonl"), sub.records);
  const [x] = (await scan(root)).get(`${P}/sess-sb-subleak.jsonl`)!.result.exchanges;
  assert.deepEqual(
    [x!.steps, x!.toolCalls, x!.reads, x!.edits, x!.toolErrors, x!.toolErrorsCmd, x!.outTok, x!.subToolCalls, x!.subTokens],
    [1, 1, 0, 0, 0, 0, 10, 2, 300],
  );
});

test("spike: an interrupt record carrying origin.kind human is an interrupt, not a prompt (list and string form)", async () => {
  const s = new SessionBuilder("sess-sb-interrupt");
  s.prompt("start");
  s.response([toolUseBlock("i1", "Bash", {})]);
  s.user([text("[Request interrupted by user for tool use]")], { origin: { kind: "human" } });
  s.prompt("next");
  s.user("[Request interrupted by user]", { origin: { kind: "human" } });
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => [x.humanPrompt, x.interrupted]), [[1, 1], [1, 1]]);
});

test("spike: denials are not tool failures — user-rejected → rejections; automode-blocked / permission-rule → blocked", async () => {
  const s = new SessionBuilder("sess-sb-denials");
  s.prompt("clean up");
  for (const [id, denial] of [["d1", "user-rejected"], ["d2", "automode-blocked"], ["d3", "permission-rule"]] as const) {
    s.response([toolUseBlock(id, "Bash", {})]);
    s.toolResult(id, { isError: true, denial, content: "synthetic denial" });
  }
  const [x] = (await parseSession(s)).exchanges;
  assert.deepEqual([x!.toolErrors, x!.toolErrorsEdit, x!.toolErrorsCmd, x!.rejections, x!.blocked], [0, 0, 0, 1, 2]);
});

test("D39: Source.files holds only the session's own transcripts, each stamped from its own file (no directory stamp)", async () => {
  const root = makeRoot();
  const P = "-synthetic-sb-stamps";
  for (const id of ["sess-sb-s1", "sess-sb-s2"]) {
    const s = new SessionBuilder(id);
    s.prompt(`prompt in ${id}`); s.response([text("ok")]);
    writeSession(root, P, s);
    await pause();
  }
  const sources = await withRoot(root, () => claudeReader.list());
  assert.equal(sources.length, 2);
  for (const src of sources) {
    assert.equal(src.files.length, 1, src.key);
    const f = src.files[0]!;
    assert.ok(f.path.endsWith(src.key.slice(P.length + 1)), "the file is the source's own transcript");
    const st = statSync(f.path);
    assert.ok(st.isFile());
    assert.deepEqual([f.size, f.mtimeMs], [st.size, Math.round(st.mtimeMs)]);
  }
});

test("D39: the 'started' record type is documented metadata, not format drift", async () => {
  const s = new SessionBuilder("sess-sb-started");
  s.meta("started", { startedAt: "2026-09-01T10:00:00.000Z" });
  s.prompt("hello"); s.response([text("hi")]);
  assert.deepEqual((await parseSession(s)).stats.unknownTypes, {});
});

test("D39: an agent-initiated stretch starts at its first main-thread record (the notification), not its first response", async () => {
  const s = new SessionBuilder("sess-sb-stretch");
  const note = s.user("<task-notification>synthetic job finished</task-notification>", { origin: { kind: "task-notification" } });
  s.tick(30);
  s.response([text("the job finished")]);
  const [x] = (await parseSession(s)).exchanges;
  assert.deepEqual([x!.humanPrompt, x!.t, x!.durationMs], [0, note.timestamp, 31_000]);
});
