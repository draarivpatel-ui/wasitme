import { test } from "node:test";
import assert from "node:assert/strict";
import { Rollout, testCtx, uuid, writeTree } from "../fixtures/codex/build.js";
import { scan } from "../fixtures/codex/harness.js";

const MAIN = uuid(1);
const [T1, T2, T3, T4, T5] = [uuid(101), uuid(102), uuid(103), uuid(104), uuid(105)];
const PROMPT = "Add a login form to the settings page";

/** A paginated main-thread session exercising every per-exchange signal. */
function mainSession(): string {
  return new Rollout("2026-09-01T10:00:00Z")
    .meta({ id: MAIN, cwd: "/work/proj", threadSource: "user" })
    .rec("world_state", { full: true, state: {} })
    // T1: human prompt, reads, a failing command, one blind edit, streaming usage snapshots
    .started(T1).ctx(T1, { model: "gpt-6-luna", effort: "high", approval: "never" })
    .respUser("<environment_context>\n<cwd>/work/proj</cwd>\n</environment_context>")
    .tick().user(T1, PROMPT)
    .respReasoning(100).reasoningItem(T1)
    .tick().cmd(T1, { parsed: [{ type: "read", path: "src/app.ts" }] })
    .cmd(T1, { status: "failed", parsed: [{ type: "search", path: "src" }] })
    .fileChange(T1, { "/work/proj/src/app.ts": "update" })
    .fileChange(T1, { "/work/proj/src/other.ts": "update" })
    .mcp(T1)
    .imageView(T1)
    .usage(T1, "resp-1", { input: 1000, cached: 400, output: 50, cacheWrite: 10 })
    .usage(T1, "resp-2", { input: 2000, cached: 1500, output: 80 })
    .usage(T1, "resp-2", { input: 2100, cached: 1500, output: 90 })
    .tokenCount({ input: 3100, cached: 1900, output: 140 }, { input: 2100, cached: 1500, output: 90 })
    .tick(5000).agent(T1).complete(T1)
    // T2: heartbeat wake-up after a prompt → absorbed into the open T1 exchange (not a new one)
    .tick(60_000).started(T2).ctx(T2, { model: "gpt-6-luna", effort: "high", approval: "never" })
    .user(T2, "<heartbeat>\n<id>synthetic</id>\n</heartbeat>")
    .cmd(T2).usage(T2, "resp-3", { input: 500, output: 20 }).complete(T2)
    // T3: model switch, pushback, a prompt typed mid-turn, compaction, churn, user interrupt
    .tick(60_000).started(T3).ctx(T3, { model: "gpt-6.1-sol", effort: "high", approval: "never" })
    .user(T3, "no, that's wrong - keep the old layout")
    .tick().user(T3, "also add tests")
    .compaction(T3)
    .fileChange(T3, { "/work/proj/src/new.ts": "add" })
    .fileChange(T3, { "/work/proj/src/app.ts": "update" })
    .fileChange(T3, { "/work/proj/src/app.ts": "update" })
    .fileChange(T3, { "/work/proj/src/app.ts": "update" })
    .usage(T3, "resp-4", { input: 800, output: 30 })
    .tick().aborted(T3)
    // T4: woken by a subagent notification → continues the T3 exchange
    .tick(10_000).started(T4).ctx(T4, { model: "gpt-6.1-sol", effort: "high", approval: "never" })
    .user(T4, "<subagent_notification>\n{\"agent\":\"x\"}\n</subagent_notification>")
    .cmd(T4).usage(T4, "resp-5", { input: 100, output: 5 }).complete(T4)
    // T5: image-only prompt after compaction; effort + approval change; file ends mid-turn
    .tick(30_000).started(T5).ctx(T5, { model: "gpt-6.1-sol", effort: "medium", approval: { granular: { sandbox: true } } })
    .user(T5, null, { images: 1 })
    .cmd(T5)
    .text();
}

test("paginated session: one exchange per human prompt, exact per-exchange counts", async () => {
  const { root } = writeTree([{ id: MAIN, content: mainSession() }]);
  const { exchanges: ex, stats } = await scan(root);
  assert.equal(ex.length, 3, "a heartbeat after the first prompt opens no exchange");
  assert.deepEqual(ex.map((e) => e.humanPrompt), [1, 1, 1]);
  assert.deepEqual(ex.map((e) => e.seq), [0, 1, 2]);

  const [e0, e1, e2] = ex as [typeof ex[0], typeof ex[0], typeof ex[0]];
  assert.equal(e0.t, "2026-09-01T10:00:01.000Z");
  assert.equal(e0.day, "2026-09-01");
  assert.equal(e0.promptChars, PROMPT.length);
  assert.equal(e0.steps, 2 + 1, "resp-2 streaming snapshot counted once; T2's response absorbed");
  assert.equal(e0.inTok, 600 + 600 + 500, "input minus cached, last snapshot of resp-2, plus T2");
  assert.equal(e0.cacheRead, 400 + 1500);
  assert.equal(e0.cacheWrite, 10);
  assert.equal(e0.outTok, 50 + 90 + 20);
  assert.equal(e0.toolCalls, 5 + 1, "ImageView is not a tool call; T2's command absorbed");
  assert.equal(e0.toolErrors, 1);
  assert.equal(e0.reads, 2, "read + search commands both only look at files");
  assert.equal(e0.edits, 2);
  assert.equal(e0.blindEdits, 1, "other.ts was never read");
  assert.equal(e0.churned, 0);
  assert.equal(e0.thinkBlocks, 1);
  assert.equal(e0.thinkRedacted, 1);
  assert.equal(e0.thinkSigMedian, 100);
  assert.equal(e0.durationMs, 67_000, "T1 start to the end of the absorbed T2");
  assert.equal(e0.model, "gpt-6-luna");
  assert.equal(e0.servedModel, "gpt-6-luna");
  assert.equal(e0.effort, "high");
  assert.equal(e0.mode, "never");
  assert.equal(e0.version, "0.160.0");
  assert.equal(e0.entrypoint, "vscode", "session_meta.source; the originator (\"Codex Desktop\") is never a label");
  assert.equal(e0.interrupted, 0);
  assert.equal(e0.pushback, 0);
  assert.equal(e0.afterCompaction, false);

  assert.equal(e1.pushback, 1);
  assert.equal(e1.queuedMidTurn, 1);
  assert.equal(e1.compactions, 1, "compacted record + ContextCompaction item are one compaction");
  assert.equal(e1.edits, 4);
  assert.equal(e1.blindEdits, 0, "new file is not blind; app.ts read within the last 10 tool calls");
  assert.equal(e1.churned, 1);
  assert.equal(e1.interrupted, 1);
  assert.equal(e1.toolCalls, 5, "T4 continuation folded in");
  assert.equal(e1.steps, 2);
  assert.equal(e1.model, "gpt-6.1-sol");
  assert.equal(e1.afterCompaction, false);

  assert.equal(e2.promptChars, 0, "image-only prompt");
  assert.equal(e2.afterCompaction, true);
  assert.equal(e2.effort, "medium");
  assert.equal(e2.mode, "granular");
  assert.equal(e2.toolCalls, 1, "rollout ending mid-turn still counts its work");
  assert.equal(e2.steps, 0);

  assert.equal(new Set(ex.map((e) => e.session)).size, 1);
  assert.equal(e0.project, testCtx().hash("/work/proj", "p-"));
  assert.equal(new Set(ex.map((e) => e.id)).size, 3);
  assert.equal(stats.files, 1);
  assert.equal(stats.duplicates, 2, "resp-2 streaming snapshot + T1's token_count (twin of its usage records)");
  assert.deepEqual(stats.unknownTypes, {});
  assert.equal(stats.badLines + stats.truncatedTail + stats.badTimestamps, 0);
});

test("paginated session: setting changes with no settings record are unknown·weak (D33), never inferred as you", async () => {
  const { root } = writeTree([{ id: MAIN, content: mainSession() }]);
  const { events } = await scan(root);
  const view = events.map((e) => [e.kind, e.from, e.to, e.side, e.strength, e.provenance, e.userInitiated]);
  assert.deepEqual(view, [
    ["model", "gpt-6-luna", "gpt-6.1-sol", "unknown", "weak", "log_field", false],
    ["effort", "high", "medium", "unknown", "weak", "log_field", false],
    ["mode", "never", "granular", "unknown", "weak", "log_field", false],
  ]);
  assert.ok(events.every((e) => e.agent === "codex" && e.evidence === "log" && /^e-[0-9a-f]{12}$/.test(e.id)));
});

test("paginated session: the same changes applied through thread_settings_applied are you·strong (command)", async () => {
  const id = uuid(9);
  const [S1, S2] = [uuid(901), uuid(902)];
  const content = new Rollout("2026-09-01T10:00:00Z").meta({ id, threadSource: "user" })
    .started(S1).ctx(S1, { model: "gpt-6-luna", effort: "high", approval: "never" }).user(S1, "first").complete(S1)
    .tick(60_000).settings({ model: "gpt-6.1-sol", reasoning_effort: "medium", approval_policy: "on-request" })
    .started(S2).ctx(S2, { model: "gpt-6.1-sol", effort: "medium", approval: "on-request" }).user(S2, "second").complete(S2)
    .text();
  const { root } = writeTree([{ id, content }]);
  const { events } = await scan(root);
  assert.deepEqual(events.map((e) => [e.kind, e.side, e.strength, e.provenance, e.userInitiated]), [
    ["model", "you", "strong", "command", true],
    ["effort", "you", "strong", "command", true],
    ["mode", "you", "strong", "command", true],
  ]);
});

test("imported history turns (counter ids, no context/usage/tools) are not exchanges", async () => {
  const id = uuid(2);
  const r = new Rollout("2026-09-02T09:00:00Z").meta({ id, threadSource: "user" });
  for (let i = 1; i <= 3; i++) r.started(`external-import-turn-${i}`).user(`external-import-turn-${i}`, `imported prompt ${i}`);
  r.tick(60_000).started(uuid(201)).ctx(uuid(201)).user(uuid(201), "real prompt").cmd(uuid(201))
    .usage(uuid(201), "x1", { input: 10, output: 1 }).complete(uuid(201));
  const { root } = writeTree([{ id, content: r.text() }]);
  const { exchanges, stats } = await scan(root);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0]!.humanPrompt, 1);
  assert.equal(exchanges[0]!.promptChars, "real prompt".length);
  assert.equal(stats.duplicates, 6, "3 imported turns x (task_started + UserMessage)");
});

test("an interrupted turn that never reached the model still counts (it has turn_context)", async () => {
  const id = uuid(3);
  const t = uuid(301);
  const content = new Rollout("2026-09-03T09:00:00Z").meta({ id }).started(t).ctx(t).user(t, "start the build").tick().aborted(t).text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges } = await scan(root);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0]!.interrupted, 1);
  assert.equal(exchanges[0]!.steps, 0);
});

test("re-emitted prompt right after an interrupt is a duplicate; a later re-send is pushback", async () => {
  const id = uuid(4);
  const [a1, a2, a3] = [uuid(401), uuid(402), uuid(403)];
  const ask = "rename the helper function";
  const content = new Rollout("2026-09-04T09:00:00Z").meta({ id })
    .started(a1).ctx(a1).user(a1, ask).cmd(a1).usage(a1, "a", { input: 10, output: 1 }).tick().aborted(a1)
    .tick().started(a2).ctx(a2).user(a2, ask).cmd(a2).usage(a2, "b", { input: 10, output: 1 }).complete(a2)
    .tick(30_000).started(a3).ctx(a3).user(a3, ask).cmd(a3).complete(a3)
    .text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges, stats } = await scan(root);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0]!.toolCalls, 2);
  assert.equal(exchanges[0]!.interrupted, 1);
  assert.equal(exchanges[1]!.pushback, 1, "near-duplicate of the previous prompt");
  assert.equal(stats.duplicates, 1);
});

test("turn_started / turn_complete aliases, usage without response_id, failed MCP/collab/extension", async () => {
  const id = uuid(5);
  const t = uuid(501);
  const content = new Rollout("2026-09-05T09:00:00Z").meta({ id })
    .started(t, true).ctx(t).user(t, "search the web for the changelog")
    .mcp(t, "failed").collab(t, "failed").extension(t, "web.search").extension(t, "image_gen.generation", "failed")
    .usage(t, undefined, { input: 10, output: 1 }).usage(t, undefined, { input: 20, output: 2 })
    .complete(t, { error: { message: "stream disconnected", codex_error_info: "x" } }, true)
    .text();
  const { root } = writeTree([{ id, content }]);
  const [e] = (await scan(root)).exchanges;
  assert.ok(e);
  assert.equal(e.toolCalls, 4);
  assert.equal(e.toolErrors, 3);
  assert.equal(e.steps, 2);
  assert.equal(e.inTok, 30);
  assert.equal(e.apiErrors, 1);
});

test("clock going backward: file order kept, durations never negative", async () => {
  const id = uuid(6);
  const [b1, b2] = [uuid(601), uuid(602)];
  const content = new Rollout("2026-09-20T10:00:00Z").meta({ id })
    .started(b1).ctx(b1).user(b1, "first")
    .at("2026-09-20T09:00:00Z").cmd(b1).usage(b1, "r1", { input: 1, output: 1 })
    .at("2026-09-20T09:00:05Z").complete(b1)
    .at("2026-09-20T08:00:00Z").started(b2).ctx(b2).user(b2, "second").cmd(b2).complete(b2)
    .text();
  const { root } = writeTree([{ id, content }]);
  const { exchanges } = await scan(root);
  assert.deepEqual(exchanges.map((e) => e.t), ["2026-09-20T10:00:00.000Z", "2026-09-20T08:00:00.000Z"]);
  assert.deepEqual(exchanges.map((e) => e.seq), [0, 1]);
  assert.ok(exchanges.every((e) => e.durationMs >= 0));
  assert.equal(exchanges[0]!.durationMs, 3_600_000);
});
