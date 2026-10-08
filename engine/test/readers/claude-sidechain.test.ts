import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Exchange } from "../../src/types.js";
import { clearPriorCache } from "../../src/readers/claude/priors.js";
import {
  makeRoot, parseSession, pause, projectPath, replayInto, scan, SessionBuilder, text, thinking, toolUseBlock, writeJsonl, writeSession, type Rec,
} from "../fixtures/claude/builder.js";

/** Records of a /btw side question or other aside, logged in the MAIN transcript (research #5). */
const side = { isSidechain: true };
const PER_RESPONSE = 10 + 20 + 1000 + 100; // builder default usage

test("a subagent spawned from inside an aside is credited to the open exchange", async () => {
  const root = makeRoot();
  const P = "-synthetic-proj";
  const m = new SessionBuilder("sess-side-sub", { start: "2026-09-01T10:00:00.000Z" });
  m.prompt("first task");
  m.response([text("a")]);
  m.prompt("second task");
  m.response([toolUseBlock("ag1", "Agent", {})], { extra: side });
  m.toolResult("ag1", { toolUseResult: { agentId: "aside-sub", status: "completed" }, extra: side });
  m.response([text("b")]);
  writeSession(root, P, m);
  const sub = new SessionBuilder("aside-sub", { start: "2026-09-01T09:00:00.000Z" }); // clock skew: before both prompts
  sub.response([toolUseBlock("x1", "Bash", {}), toolUseBlock("x2", "Bash", {})], { extra: side });
  writeJsonl(join(projectPath(root, P), "sess-side-sub", "subagents", "agent-aside-sub.jsonl"), sub.records);
  const r = (await scan(root)).get(`${P}/sess-side-sub.jsonl`)!.result;
  assert.deepEqual(r.exchanges.map((x) => [x.steps, x.toolCalls, x.subToolCalls, x.subTokens]), [[1, 0, 0, 0], [1, 0, 1 + 2, PER_RESPONSE + PER_RESPONSE]]);
});

test("sidechain records in the main transcript are context for the open exchange, never main-thread work", async () => {
  const s = new SessionBuilder("sess-side", { start: "2026-09-01T10:00:00.000Z" });
  s.prompt("refactor the parser module");
  s.response([toolUseBlock("m1", "Bash", {})], { model: "claude-opus-5" });
  const mainLine = s.records[s.records.length - 1]!;
  s.toolResult("m1");
  // The aside: its question (even if tagged human) is not a prompt; its response is not a step.
  s.user("btw what does the tokenizer do?", { ...side, origin: { kind: "human" } });
  s.response([thinking("", "sig-aside"), toolUseBlock("b1", "Bash", {})], { model: "claude-haiku-5", effort: "low", outPerLine: [5, 9], extra: side });
  s.toolResult("b1", { isError: true, content: "synthetic failure", extra: side });
  s.response([toolUseBlock("b2", "Edit", { file_path: "/synthetic/x.ts" })], { model: "claude-haiku-5", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, extra: side });
  s.toolResult("b2", { denial: "user_rejected", extra: side });
  s.user("[Request interrupted by user]", side);
  s.apiErrorMessage("API Error: 500 synthetic", side);
  s.system("api_error", { ...side, retryAttempt: 1 });
  s.system("compact_boundary", side);
  s.attachment({ type: "queued_command", prompt: "typed during the aside", commandMode: "prompt", origin: { kind: "human" } }, side);
  // The aside re-logs a main-thread response (same message id + requestId, new uuid): replayed history.
  s.push({ ...mainLine, uuid: "aside-copy-1", isSidechain: true, timestamp: s.tick() });
  s.push({ ...mainLine, uuid: "aside-bad-ts", isSidechain: true, timestamp: "not-a-time", message: { ...(mainLine.message as Rec), id: "msg_other", usage: {} } });
  s.response([text("refactored")], { model: "claude-opus-5" });

  const r = await parseSession(s);
  assert.equal(r.exchanges.length, 1);
  const x = r.exchanges[0] as Exchange;
  assert.deepEqual(
    [x.steps, x.toolCalls, x.toolErrors, x.rejections, x.blocked, x.interrupted, x.queuedMidTurn, x.apiErrors, x.apiRetries, x.compactions, x.thinkBlocks, x.edits],
    [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(x.subToolCalls, 2, "the aside's two tool calls");
  assert.equal(x.subTokens, (10 + 9 + 1000 + 100) + (1 + 2 + 3 + 4), "aside tokens (streamed lines merged by max)");
  assert.equal(x.model, "claude-opus-5");
  assert.equal(x.effort, "high");
  assert.equal(x.afterCompaction, false);
  assert.deepEqual(r.events, [], "an aside on another model is not a model change");
  assert.equal(r.stats.duplicates, 1 + 1, "one streaming split line + one re-logged main response");
  assert.equal(r.stats.badTimestamps, 1);
  assert.deepEqual(r.stats.unknownTypes, {});
});

test("sidechain records never open an exchange or move the clock", async () => {
  const s = new SessionBuilder("sess-side-first", { start: "2026-09-01T10:00:00.000Z" });
  s.response([toolUseBlock("b1", "Bash", {})], { model: "claude-haiku-5", extra: side }); // before any exchange
  s.prompt("now the real work"); // 10:00:02
  s.tick(9); s.response([text("done")], { model: "claude-opus-5" }); // 10:00:12
  s.setTime("2026-09-01T09:00:00.000Z"); // an aside stamped an hour early, then an hour late
  s.response([text("aside")], { model: "claude-haiku-5", extra: side });
  s.setTime("2026-09-01T11:00:00.000Z");
  s.response([text("aside")], { model: "claude-haiku-5", extra: side });
  s.setTime("2026-09-01T10:00:20.000Z");
  s.response([text("more")], { model: "claude-opus-5" }); // 10:00:21
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => [x.humanPrompt, x.steps, x.subToolCalls, x.durationMs]), [[1, 2, 0, 19_000]]);
  assert.deepEqual(r.events, []);
});

test("a resumed session whose replayed history ends inside an aside reports no model flip", async () => {
  clearPriorCache();
  const root = makeRoot();
  const P = "-synthetic-proj";
  const a = new SessionBuilder("sess-sa", { start: "2026-09-01T09:00:00.000Z" });
  a.prompt("first task");
  a.response([text("a")], { model: "claude-opus-5" });
  a.prompt("second task");
  a.response([text("b")], { model: "claude-opus-5" });
  a.user("btw quick question", side);
  a.response([toolUseBlock("aside1", "Bash", {})], { model: "claude-haiku-5", extra: side }); // A ends inside the aside
  writeSession(root, P, a);
  await pause();
  const b = new SessionBuilder("sess-sb", { start: "2026-09-03T09:00:00.000Z" });
  replayInto(b, a.records);
  b.prompt("third task");
  b.response([toolUseBlock("aside1", "Bash", {}), toolUseBlock("b1", "Bash", {})], { model: "claude-opus-5" }); // aside1 already seen
  writeSession(root, P, b);
  writeJsonl(join(projectPath(root, P), "unrelated.txt"), []);

  const all = await scan(root);
  const ra = all.get(`${P}/sess-sa.jsonl`)!.result;
  const rb = all.get(`${P}/sess-sb.jsonl`)!.result;
  assert.deepEqual(ra.events, []);
  assert.deepEqual(ra.exchanges.map((x) => [x.steps, x.subToolCalls]), [[1, 0], [1, 1]]);
  assert.deepEqual(rb.events, [], "the replayed aside's model must not become the session's model");
  assert.deepEqual(rb.exchanges.map((x) => [x.humanPrompt, x.steps, x.toolCalls, x.model]), [[1, 1, 1, "claude-opus-5"]]);
});
