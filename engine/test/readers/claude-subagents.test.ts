import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Exchange } from "../../src/types.js";
import { makeRoot, projectPath, scanOne, SessionBuilder, text, toolUseBlock, writeJsonl, writeSession } from "../fixtures/claude/builder.js";

const P = "-synthetic-proj";
const SESSION = "sess-main";

function subagent(id: string, start: string): SessionBuilder {
  const s = new SessionBuilder(id, { start });
  return s;
}
const sidechain = { isSidechain: true, agentId: "x" };

test("subagent work goes to the spawning exchange (by link, not timestamp) and never creates exchanges", async () => {
  const root = makeRoot();
  const m = new SessionBuilder(SESSION, { start: "2026-09-01T10:00:00.000Z" });
  m.prompt("investigate the flaky test");
  m.response([toolUseBlock("ag1", "Agent", { prompt: "look into it" })]);
  m.toolResult("ag1", { toolUseResult: { agentId: "sub1", status: "completed", totalTokens: 1 } });
  m.response([text("found it")]);
  m.prompt("run the release workflow");
  m.response([toolUseBlock("wf1", "Workflow", {})]);
  m.toolResult("wf1", { toolUseResult: { runId: "run-42", taskId: "task-7", status: "started", transcriptDir: "/synthetic/x/subagents/workflows/run-42" } });
  m.response([text("workflow started")]);
  m.setTime("2026-09-01T11:00:00.000Z");
  m.prompt("and the docs workflow");
  m.response([toolUseBlock("wf2", "Workflow", {})]);
  m.toolResult("wf2", { toolUseResult: { status: "started", transcriptDir: "/synthetic/x/subagents/workflows/run-77/" } });
  m.response([text("started")]);
  writeSession(root, P, m);
  const subDir = join(projectPath(root, P), SESSION, "subagents");

  // sub1: stamped during the THIRD exchange, but linked to the first one by agentId.
  const s1 = subagent("sub1", "2026-09-01T11:30:00.000Z");
  s1.user("look into it", sidechain);
  s1.response([toolUseBlock("s1a", "Read", { file_path: "/synthetic/f.ts" }), toolUseBlock("s1b", "Agent", {})], { outPerLine: [3, 50], extra: sidechain });
  s1.toolResult("s1a", { extra: sidechain });
  s1.toolResult("s1b", { toolUseResult: { agentId: "sub2", status: "completed" }, extra: sidechain });
  s1.response([toolUseBlock("s1c", "Bash", {})], { extra: sidechain });
  writeJsonl(join(subDir, "agent-sub1.jsonl"), s1.records);

  // sub2: spawned by sub1 (nested) → follows sub1 to the first exchange.
  const s2 = subagent("sub2", "2026-09-01T11:31:00.000Z");
  s2.response([toolUseBlock("s2a", "Bash", {})], { extra: sidechain });
  writeJsonl(join(subDir, "agent-sub2.jsonl"), s2.records);

  // Workflow agents: linked through runId and through the transcriptDir basename.
  const w1 = subagent("w1", "2026-09-01T11:40:00.000Z");
  w1.response([toolUseBlock("w1a", "Bash", {}), toolUseBlock("w1b", "Edit", { file_path: "/synthetic/g.ts" })], { extra: sidechain });
  w1.attachment({ type: "queued_command", prompt: "<task-notification>x</task-notification>", commandMode: "task-notification" });
  writeJsonl(join(subDir, "workflows", "run-42", "agent-w1.jsonl"), w1.records);
  writeJsonl(join(subDir, "workflows", "run-42", "journal.jsonl"), [{ type: "started", agentId: "w1" }, { type: "result", agentId: "w1" }]);
  const w2 = subagent("w2", "2026-09-01T09:00:00.000Z"); // clock skew: before every exchange
  w2.response([toolUseBlock("w2a", "Bash", {})], { extra: sidechain });
  writeJsonl(join(subDir, "workflows", "run-77", "agent-w2.jsonl"), w2.records);

  // Orphan: no link anywhere → timestamp fallback (during the second exchange).
  const o = subagent("orphan", "2026-09-01T10:30:00.000Z");
  o.response([toolUseBlock("o1", "Bash", {})], { extra: sidechain });
  o.meta("weird-sub-type");
  writeJsonl(join(subDir, "agent-orphan.jsonl"), o.records);

  const r = await scanOne(root);
  assert.equal(r.exchanges.length, 3, "subagent records never open exchanges");
  const [a, b, c] = r.exchanges as [Exchange, Exchange, Exchange];
  const perResponse = 10 + 20 + 1000 + 100; // builder default usage
  assert.deepEqual([a.subToolCalls, a.subTokens], [3 + 1, (10 + 50 + 1000 + 100) + perResponse + perResponse]);
  assert.deepEqual([b.subToolCalls, b.subTokens], [2 + 1, perResponse + perResponse]);
  assert.deepEqual([c.subToolCalls, c.subTokens], [1, perResponse]);
  // Main-thread counts are untouched by subagent work.
  assert.deepEqual(r.exchanges.map((x) => [x.steps, x.toolCalls, x.reads, x.edits]), [[2, 1, 0, 0], [2, 1, 0, 0], [2, 1, 0, 0]]);
  assert.equal(r.stats.files, 1 + 5);
  assert.equal(r.stats.duplicates, 2, "one streaming split line in sub1 and one in w1");
  assert.deepEqual(r.stats.unknownTypes, { "weird-sub-type": 1 });
});

test("subagents of a session with no exchanges are dropped quietly", async () => {
  const root = makeRoot();
  const m = new SessionBuilder(SESSION);
  m.meta("ai-title", { aiTitle: "empty" });
  writeSession(root, P, m);
  const s = subagent("lonely", "2026-09-01T10:00:00.000Z");
  s.response([toolUseBlock("l1", "Bash", {})], { extra: sidechain });
  writeJsonl(join(projectPath(root, P), SESSION, "subagents", "agent-lonely.jsonl"), s.records);
  const r = await scanOne(root);
  assert.deepEqual(r.exchanges, []);
  assert.equal(r.stats.files, 2);
});
