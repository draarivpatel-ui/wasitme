/**
 * Regression fixtures, one per bug class the D39 acceptance judges found in the Codex reader and per spike bug /
 * WP-11Δ reconcile item (research/05 "Parser edge cases" #1–20, and every spike bug). 100% synthetic: every record is
 * built here; nothing is copied or derived from a real session log. Several overlap older reader tests on purpose —
 * the point is one named, self-contained fixture per bug class.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../../src/readers/codex/text.js";
import { fromResponseCall } from "../../src/readers/codex/tools.js";
import type { Exchange } from "../../src/types.js";
import { Rollout, testCtx, uuid, writeTree } from "../fixtures/codex/build.js";
import { scan, sum } from "../fixtures/codex/harness.js";

const text = (t: string) => [{ type: "text", text: t }];
const SUBAGENT = (parent: string) => ({ subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } });

/** The tool-error split must add up on every exchange (types.ts: toolErrorsEdit + toolErrorsCmd = toolErrors). */
function splitAddsUp(xs: Exchange[]): void {
  for (const e of xs) {
    assert.equal(typeof e.toolErrorsCmd, "number", "toolErrorsCmd populated");
    assert.equal(typeof e.toolErrorsEdit, "number", "toolErrorsEdit populated");
    assert.equal(e.toolErrorsCmd! + e.toolErrorsEdit!, e.toolErrors, "split adds up to toolErrors");
    assert.ok(e.toolErrorsCmd! >= 0 && e.toolErrorsEdit! >= 0);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// D39 bug classes
// ---------------------------------------------------------------------------------------------------------------

test("D39 entrypoint: the label is session_meta.source's fixed enum, never the originator", async () => {
  const cases = [
    { id: uuid(1001), source: "cli", originator: "Codex Desktop", want: "cli" },
    { id: uuid(1002), source: "VSCode", originator: "codex_exec", want: "vscode" },
    { id: uuid(1003), source: "desktop-preview", originator: "codex-tui", want: "other" },
    { id: uuid(1004), originator: "codex-tui", omit: ["source"], want: "unknown" },
  ];
  const files = cases.map((c, i) => {
    const t = uuid(10010 + i);
    const content = new Rollout(`2026-09-20T1${i}:00:00Z`).meta({ id: c.id, source: c.source, originator: c.originator, omit: c.omit })
      .started(t).ctx(t).user(t, "synthetic prompt").complete(t).text();
    return { id: c.id, content, stamp: `2026-09-20T1${i}-00-00` };
  });
  const s = await scan(writeTree(files).root, cases.map((c) => c.id));
  for (const c of cases) assert.equal(s.byThread.get(c.id)!.exchanges[0]!.entrypoint, c.want, `${c.source ?? "(none)"} / ${c.originator}`);
  const out = JSON.stringify(s.exchanges);
  for (const o of ["Codex Desktop", "codex_exec", "codex-tui", "desktop-preview"]) assert.ok(!out.includes(o), `${o} became a label`);
});

test("D39 id-less turn_context: settings logged before an id-carrying task_started apply and carry forward", async () => {
  const id = uuid(1010);
  const [A, B] = [uuid(10101), uuid(10102)];
  const content = new Rollout("2026-08-05T08:00:00Z").meta({ id, legacy: true, source: "cli" })
    .ctx(undefined, { model: "gpt-legacy", effort: "low", approval: "on-request" })
    .started(A).event("user_message", { message: "first legacy prompt" }).event("exec_command_end", { call_id: "x1", exit_code: 0 })
    .tokenCount({ input: 100, output: 10 }, { input: 100, output: 10 }).complete(A)
    .tick(60_000).started(B).event("user_message", { message: "second legacy prompt" })
    .tokenCount({ input: 300, output: 30 }, { input: 200, output: 20 }).complete(B)
    .text();
  const s = await scan(writeTree([{ id, content }]).root);
  assert.equal(s.exchanges.length, 2);
  for (const e of s.exchanges) assert.deepEqual([e.model, e.effort, e.mode], ["gpt-legacy", "low", "on-request"]);
});

test("D39 per-turn history mode: a legacy-only turn and a canonical turn in one migrated file each count once", async () => {
  const id = uuid(1020);
  const [L, C] = [uuid(10201), uuid(10202)];
  const content = new Rollout("2026-09-29T16:00:00Z").meta({ id })
    // legacy-only turn: user_message event + response_item twin, exec_command_end, token_count
    .started(L).ctx(L).respUser("explain the cache layer").event("user_message", { message: "explain the cache layer" })
    .fnCall("l1").event("exec_command_end", { call_id: "l1", turn_id: L, exit_code: 0, parsed_cmd: [{ type: "read", path: "src/cache.ts" }] })
    .tokenCount({ input: 1000, output: 50 }, { input: 1000, output: 50 }).complete(L)
    // canonical-only turn
    .tick(60_000).started(C).ctx(C).user(C, "now make the TTL configurable").fileChange(C, { "/synthetic/project/src/cache.ts": "update" })
    .usage(C, "c1", { input: 500, output: 20 }).complete(C)
    .text();
  const s = await scan(writeTree([{ id, content }]).root);
  assert.deepEqual(s.exchanges.map((e) => [e.humanPrompt, e.toolCalls, e.reads, e.edits, e.steps]), [[1, 1, 1, 0, 1], [1, 1, 0, 1, 1]]);
  assert.equal(s.stats.duplicates, 1, "the response_item twin of the legacy prompt");
});

test("D39 dropped twins: legacy copies of a canonical turn's prompt and command are counted as duplicates", async () => {
  const id = uuid(1030);
  const T = uuid(10301);
  const content = new Rollout("2026-09-29T17:00:00Z").meta({ id })
    .started(T).ctx(T).respUser("rename the helper").event("user_message", { message: "rename the helper" }).user(T, "rename the helper")
    .item(T, { type: "CommandExecution", id: "call-twin-1", status: "completed", exit_code: 0, parsed_cmd: [{ type: "unknown" }] })
    .event("exec_command_end", { call_id: "call-twin-1", turn_id: T, exit_code: 0 })
    .usage(T, "t1", { input: 10, output: 1 }).complete(T)
    .text();
  const s = await scan(writeTree([{ id, content }]).root);
  assert.equal(s.exchanges.length, 1);
  assert.equal(s.exchanges[0]!.toolCalls, 1);
  assert.equal(s.exchanges[0]!.queuedMidTurn, 0, "a twin never hides as a queued prompt");
  assert.equal(s.stats.duplicates, 3, "response_item prompt + user_message prompt + exec_command_end");
});

test("D39 heartbeat / scheduled-task turns: absorbed into an open exchange, agent-initiated only before any prompt", async () => {
  const id = uuid(1040);
  const [H, P, X, Y] = [uuid(10401), uuid(10402), uuid(10403), uuid(10404)];
  const content = new Rollout("2026-10-03T07:00:00Z").meta({ id })
    .started(H).ctx(H).user(H, "<heartbeat>\n<id>wake</id>\n</heartbeat>").cmd(H).usage(H, "h", { input: 1, output: 1 }).complete(H)
    .tick(60_000).started(P).ctx(P).user(P, "fix the failing lint job").cmd(P).usage(P, "p", { input: 1, output: 1 }).complete(P)
    .tick(60_000).started(X).ctx(X).user(X, "<scheduled-task name=\"nightly\">run</scheduled-task>").cmd(X).complete(X)
    .tick(60_000).started(Y).ctx(Y).user(Y, "<heartbeat>\n<id>again</id>\n</heartbeat>").cmd(Y).complete(Y)
    .text();
  const s = await scan(writeTree([{ id, content }]).root);
  assert.deepEqual(s.exchanges.map((e) => [e.humanPrompt, e.toolCalls, e.queuedMidTurn]), [[0, 1, 0], [1, 3, 0]]);
});

test("D39 evidence-only subagent attribution: a child with no root turn, no spawn item and no running exchange is nobody's", async () => {
  const [P, C] = [uuid(1050), uuid(1051)];
  const [PT, CT] = [uuid(10501), uuid(10511)];
  const parent = new Rollout("2026-09-10T10:00:00Z").meta({ id: P })
    .started(PT).ctx(PT).user(PT, "plan it").cmd(PT).usage(PT, "p", { input: 10, output: 1 }).at("2026-09-10T10:00:50Z").complete(PT).text();
  const child = new Rollout("2026-09-10T10:10:00Z").meta({ id: C, parent: P, source: SUBAGENT(P), threadSource: "subagent" })
    .started(CT).ctx(CT).user(CT, "subtask").cmd(CT).cmd(CT).usage(CT, "c", { input: 5, output: 1 }).complete(CT).text();
  const s = await scan(writeTree([{ id: P, stamp: "2026-09-10T10-00-00", content: parent }, { id: C, stamp: "2026-09-10T10-10-00", content: child }]).root, [P, C]);
  assert.equal(s.byThread.get(C)!.exchanges.length, 0, "a linked child never reports exchanges of its own");
  assert.equal(sum(s.exchanges, "subToolCalls"), 0, "the last exchange to start does not receive it by default");
});

test("D39 unknownTypes keys are namespaced by family (codex:<envelope>, codex:event_msg:<sub>, codex:item:<type>)", async () => {
  const id = uuid(1060);
  const T = uuid(10601);
  const content = new Rollout("2026-09-21T10:00:00Z").meta({ id })
    .rec("future_envelope", { x: 1 })
    .started(T).ctx(T).user(T, "prompt").event("future_event").item(T, { type: "FutureItem", id: "f1" })
    .rec("response_item", { type: "future_resp" }).complete(T)
    .text();
  const s = await scan(writeTree([{ id, content }]).root);
  assert.deepEqual(s.stats.unknownTypes, {
    "codex:future_envelope": 1, "codex:event_msg:future_event": 1, "codex:item:FutureItem": 1, "codex:response_item:future_resp": 1,
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Spike bugs and WP-11Δ reconcile items
// ---------------------------------------------------------------------------------------------------------------

test("counter-ID imports: an external-import-turn-N turn is excluded even with turn_context, usage and tool work", async () => {
  const id = uuid(1100);
  const I = "external-import-turn-7";
  const R = uuid(11001);
  const content = new Rollout("2026-10-01T08:00:00Z").meta({ id })
    .started(I).ctx(I).user(I, "imported prompt").cmd(I).usage(I, "imp", { input: 999, output: 99 }).complete(I)
    .tick(60_000).started(R).ctx(R).user(R, "real prompt").cmd(R).usage(R, "real", { input: 10, output: 1 }).complete(R)
    .text();
  const s = await scan(writeTree([{ id, content }]).root);
  assert.equal(s.exchanges.length, 1);
  assert.deepEqual([s.exchanges[0]!.promptChars, s.exchanges[0]!.steps, s.exchanges[0]!.inTok, s.exchanges[0]!.toolCalls], ["real prompt".length, 1, 10, 1]);
  assert.equal(s.stats.duplicates, 6, "every record of the imported turn: started, ctx, user, cmd, usage, complete");
  assert.equal(s.events.length, 0, "an imported turn_context is not a settings change");
  assert.ok(!JSON.stringify(s).includes("import"), "the counter id never reaches the result");
});

test("injected app tags: a message that starts with one is never a prompt, closed or not, whatever follows", () => {
  const continuation = [
    "<task-notification>\n<task-id>1</task-id>\nRead the output file to retrieve the result",
    "<task-notification><status>done</status></task-notification>\nRead the output file to retrieve the result",
    "<local-command-stdout>Set model to synthetic",
    "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the auth module</command-args>",
    "<command-message>compact</command-message>",
    "<environment_context>\n<cwd>/x</cwd>\n</environment_context>\n<task-notification>\n<status>completed</status>",
  ];
  for (const t of continuation) assert.equal(classify(text(t)).trigger, "continuation", JSON.stringify(t.slice(0, 40)));
  assert.equal(classify(text("<heartbeat>\nwake up and check the queue")).trigger, "automation", "unclosed heartbeat");
  assert.equal(classify(text("<scheduled-task name=\"nightly\">run the report")).trigger, "automation", "unclosed scheduled-task");
  assert.equal(classify(text("<heartbeat><id>1</id></heartbeat>\nthen also do this")).trigger, "automation", "trailing text stays injected");
  assert.equal(classify([...text("<task-notification><status>done</status></task-notification>"), { type: "local_image", path: "/x.png" }]).trigger,
    "continuation", "an image inside an app message does not make it a prompt");
  assert.deepEqual(classify(text("why does <task-notification> parsing fail?")), { trigger: "human", text: "why does <task-notification> parsing fail?", images: false },
    "a tag that is not leading is typed text");
});

test("injected app tags through the reader: notification and command turns continue the open exchange", async () => {
  const id = uuid(1110);
  const [A, B, C] = [uuid(11101), uuid(11102), uuid(11103)];
  const content = new Rollout("2026-10-03T09:00:00Z").meta({ id })
    .started(A).ctx(A).user(A, "build the release").cmd(A).complete(A)
    .tick(30_000).started(B).ctx(B).user(B, "<task-notification>\n<task-id>7</task-id>\nRead the output file to retrieve the result").cmd(B).complete(B)
    .tick(30_000).started(C).ctx(C).user(C, "<local-command-stdout>Set effort to high").cmd(C).complete(C)
    .text();
  const s = await scan(writeTree([{ id, content }]).root);
  assert.deepEqual(s.exchanges.map((e) => [e.humanPrompt, e.toolCalls, e.queuedMidTurn, e.pushback]), [[1, 3, 0, 0]]);
});

test("legacy response_item branch only without item_completed: in a paginated file, response_item prompts and calls never count", async () => {
  const build = (paginated: boolean) => {
    const id = uuid(paginated ? 1120 : 1121);
    const [A, B] = [uuid(11201), uuid(11202)];
    const r = new Rollout("2026-09-25T10:00:00Z").meta({ id, legacy: !paginated });
    if (paginated) r.started(A).ctx(A).user(A, "the real prompt").cmd(A).usage(A, "a", { input: 10, output: 1 }).complete(A);
    // a turn with no canonical items: response_item records only (replayed transcript in a paginated file)
    r.tick(60_000).started(B).ctx(B).respUser("replayed or legacy prompt").fnCall("r1").fnOutput("r1", "Process exited with code 1")
      .tokenCount({ input: 50, output: 5 }, { input: 50, output: 5 }).complete(B);
    return { id, content: r.text() };
  };
  const p = build(true);
  const sp = await scan(writeTree([p]).root);
  assert.equal(sp.exchanges.length, 1, "the response_item prompt opens no exchange in a paginated file");
  assert.deepEqual([sp.exchanges[0]!.toolCalls, sp.exchanges[0]!.toolErrors], [1, 0], "its response_item call is not a tool call");
  const l = build(false);
  const sl = await scan(writeTree([l]).root);
  assert.equal(sl.exchanges.length, 1, "a legacy file without items: the response_item branch runs");
  assert.deepEqual([sl.exchanges[0]!.humanPrompt, sl.exchanges[0]!.toolCalls, sl.exchanges[0]!.toolErrors, sl.exchanges[0]!.toolErrorsCmd], [1, 1, 1, 1]);
});

test("tool-error split: command exits vs FileChange / MCP / other failures, in all three history shapes", async () => {
  // paginated
  const pid = uuid(1130);
  const T = uuid(11301);
  const paginated = new Rollout("2026-09-26T10:00:00Z").meta({ id: pid })
    .started(T).ctx(T).user(T, "ship it")
    .cmd(T, { status: "failed", exit: 2 })
    .cmd(T, { exit: 1 }) // status completed, non-zero exit: still a command failure
    .cmd(T)
    .cmd(T, { status: "declined" }) // the user declined: a rejection, never an error
    .fileChange(T, { "/synthetic/project/a.ts": "update" }, "failed")
    .mcp(T, "failed")
    .extension(T, "web.search", "failed")
    .usage(T, "u", { input: 1, output: 1 }).complete(T)
    .text();
  // legacy *_end events
  const lid = uuid(1131);
  const legacy = new Rollout("2026-08-10T10:00:00Z").meta({ id: lid, legacy: true, source: "cli" })
    .started().respUser("legacy prompt").event("user_message", { message: "legacy prompt" })
    .event("exec_command_end", { call_id: "e1", exit_code: 1 })
    .event("exec_command_end", { call_id: "e2", exit_code: 0 })
    .event("patch_apply_end", { call_id: "p1", success: false, changes: { "/r/a.ts": { update: {} } } })
    .event("mcp_tool_call_end", { call_id: "m1", result: { Err: "synthetic" } })
    .tokenCount({ input: 5, output: 1 }, { input: 5, output: 1 }).complete()
    .text();
  // oldest: response_item calls only
  const rid = uuid(1132);
  const respOnly = new Rollout("2026-07-10T10:00:00Z").meta({ id: rid, legacy: true, source: "cli" })
    .respUser("oldest prompt")
    .fnCall("s1").fnOutput("s1", "Process exited with code 1")
    .fnCall("a1", "apply_patch", "*** Begin Patch\n*** Update File: a.ts\n*** End Patch").fnOutput("a1", "Script failed", true)
    .fnCall("s2").fnOutput("s2", "Exit code: 0")
    .tokenCount({ input: 5, output: 1 }, { input: 5, output: 1 })
    .text();
  const s = await scan(writeTree([{ id: pid, content: paginated }, { id: lid, content: legacy }, { id: rid, content: respOnly }]).root, [pid, lid, rid]);
  const view = (k: string) => s.byThread.get(k)!.exchanges.map((e) => [e.toolCalls, e.toolErrors, e.toolErrorsCmd, e.toolErrorsEdit, e.rejections]);
  assert.deepEqual(view(pid), [[7, 5, 2, 3, 1]]);
  assert.deepEqual(view(lid), [[4, 3, 1, 2, 0]]);
  assert.deepEqual(view(rid), [[3, 2, 1, 1, 0]]);
  splitAddsUp(s.exchanges);
  assert.equal(fromResponseCall({ type: "local_shell_call", call_id: "l" }).kind, "cmd");
  assert.equal(fromResponseCall({ type: "function_call", name: "exec_command" }).kind, "cmd");
  assert.equal(fromResponseCall({ type: "function_call", name: "docs__search" }).kind, "other");
});

test("subagent interrupts are kept as context (scripted class), never zeroed; a linked child's abort never marks the parent", async () => {
  const [P, C] = [uuid(1140), uuid(1141)];
  const [PT, CT] = [uuid(11401), uuid(11411)];
  const child = new Rollout("2026-09-12T10:00:20Z").meta({ id: C, parent: P, source: SUBAGENT(P), threadSource: "subagent" })
    .started(CT).ctx(CT, { root: PT }).user(CT, "subtask").cmd(CT).usage(CT, "c", { input: 5, output: 1 }, PT).tick().aborted(CT).text();
  // parent missing: the child is an orphan and reports its own (scripted) exchange
  const orphan = await scan(writeTree([{ id: C, content: child }]).root);
  assert.deepEqual(orphan.exchanges.map((e) => [e.humanPrompt, e.interrupted, e.interactiveClass]), [[0, 1, "scripted"]]);
  // parent present: the child's work folds into the parent; the parent's own interrupt flag is its own
  const parent = new Rollout("2026-09-12T10:00:00Z").meta({ id: P })
    .started(PT).ctx(PT).user(PT, "use a worker").collab(PT).usage(PT, "p", { input: 10, output: 1 }).at("2026-09-12T10:01:00Z").complete(PT).text();
  const linked = await scan(writeTree([{ id: P, stamp: "2026-09-12T10-00-00", content: parent }, { id: C, stamp: "2026-09-12T10-00-20", content: child }]).root);
  assert.deepEqual(linked.exchanges.map((e) => [e.interrupted, e.subToolCalls, e.interactiveClass]), [[0, 1, "interactive"]]);
});

test("model_provider: a switch between interactive sessions is one you·strong event (hashed); exec, subagents and other surfaces never pair up", async () => {
  const mk = (n: number, at: string, o: { source?: string; originator?: string; provider?: string | null; parent?: string }) => {
    const id = uuid(1150 + n);
    const t = uuid(11500 + n);
    const r = new Rollout(at).meta({ id, source: o.parent ? SUBAGENT(o.parent) : o.source, originator: o.originator, provider: o.provider, parent: o.parent, threadSource: o.parent ? "subagent" : undefined })
      .started(t).ctx(t).user(t, "synthetic").usage(t, `u${n}`, { input: 1, output: 1 }).complete(t);
    return { id, stamp: at.replace(/:/g, "-").slice(0, 19), date: at.slice(0, 10).replace(/-/g, "/"), content: r.text() };
  };
  const files = [
    mk(1, "2026-09-20T10:00:00Z", { source: "vscode", originator: "Codex Desktop", provider: "openai" }),
    mk(2, "2026-09-20T11:00:00Z", { source: "cli", originator: "codex-tui", provider: "synthetic-local" }),
    mk(3, "2026-09-20T12:00:00Z", { source: "vscode", originator: "Codex Desktop", provider: null }),
    mk(4, "2026-09-21T10:00:00Z", { source: "vscode", originator: "Codex Desktop", provider: "synthetic-gateway" }),
    mk(5, "2026-09-21T11:00:00Z", { source: "exec", originator: "codex_exec", provider: "synthetic-batch" }),
    mk(6, "2026-09-22T10:00:00Z", { source: "vscode", originator: "Codex Desktop", provider: "synthetic-gateway" }),
    mk(7, "2026-09-22T11:00:00Z", { source: "cli", originator: "codex-tui", provider: "synthetic-local" }),
    mk(8, "2026-09-22T10:00:30Z", { provider: "synthetic-other", parent: uuid(1156) }),
  ];
  const { root } = writeTree(files);
  const a = await scan(root, files.map((f) => f.id));
  const prov = a.events.filter((e) => e.note === "model_provider changed");
  assert.equal(prov.length, 1, "only the Desktop chain switched (openai → gateway); the gap without a provider is bridged");
  const ev = prov[0]!;
  assert.deepEqual([ev.kind, ev.side, ev.strength, ev.provenance, ev.t], ["config", "you", "strong", "log_field", "2026-09-21T10:00:00.000Z"]);
  const h = (v: string) => testCtx().hash(v, "h:").slice(0, 10);
  assert.deepEqual([ev.from, ev.to], [h("openai"), h("synthetic-gateway")]);
  assert.ok(a.byThread.get(files[3]!.id)!.events.includes(ev), "emitted once, on the later session");
  assert.ok(!JSON.stringify(a.events).includes("synthetic-"), "provider names never leave the reader");
  const b = await scan(root, files.map((f) => f.id));
  assert.deepEqual(b.events.map((e) => e.id), a.events.map((e) => e.id), "stable across rescans");
});

test("null-prototype safety: log keys like __proto__, constructor and toString are plain data everywhere", async () => {
  const id = "hasOwnProperty";
  const lines = [
    { timestamp: "2026-09-23T10:00:00.000Z", ordinal: 0, type: "session_meta", payload: { id, cwd: "/synthetic/project", cli_version: "0.160.0", source: "vscode", model_provider: "__proto__", history_mode: "paginated", base_instructions: { text: "x" } } },
    { timestamp: "2026-09-23T10:00:01.000Z", ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: "__proto__" } },
    { timestamp: "2026-09-23T10:00:01.000Z", ordinal: 2, type: "turn_context", payload: { turn_id: "__proto__", model: "toString", effort: "constructor", approval_policy: { __proto__x: {} } } },
    { timestamp: "2026-09-23T10:00:02.000Z", ordinal: 3, type: "event_msg", payload: { type: "item_completed", turn_id: "__proto__", item: { type: "UserMessage", id: "constructor", content: [{ type: "text", text: "prompt" }] } } },
    { timestamp: "2026-09-23T10:00:03.000Z", ordinal: 4, type: "event_msg", payload: { type: "item_completed", turn_id: "__proto__", item: { type: "CommandExecution", id: "__proto__", status: "failed", exit_code: 1, parsed_cmd: [{ type: "read", path: "__proto__" }] } } },
    { timestamp: "2026-09-23T10:00:04.000Z", ordinal: 5, type: "event_msg", payload: { type: "item_completed", turn_id: "__proto__", item: { type: "toString", id: "valueOf" } } },
    { timestamp: "2026-09-23T10:00:05.000Z", ordinal: 6, type: "constructor", payload: {} },
    { timestamp: "2026-09-23T10:00:05.000Z", ordinal: 7, type: "event_msg", payload: { type: "__proto__" } },
    { timestamp: "2026-09-23T10:00:06.000Z", ordinal: 8, type: "token_usage_record", payload: { turn_id: "__proto__", response_id: "constructor", usage: { input_tokens: 7, output_tokens: 1 } } },
    { timestamp: "2026-09-23T10:00:07.000Z", ordinal: 9, type: "event_msg", payload: { type: "exec_command_end", call_id: "toString", turn_id: "constructor", exit_code: 3 } },
    { timestamp: "2026-09-23T10:00:08.000Z", ordinal: 10, type: "event_msg", payload: { type: "task_complete", turn_id: "__proto__" } },
  ].map((l) => JSON.stringify(l));
  // JSON.stringify drops a literal `__proto__` key, so the FileChange with `__proto__` / `constructor` paths is raw text.
  lines.splice(5, 0, '{"timestamp":"2026-09-23T10:00:03.500Z","ordinal":40,"type":"event_msg","payload":{"type":"item_completed","turn_id":"__proto__","item":{"type":"FileChange","id":"f","status":"failed","changes":{"__proto__":{"type":"update"},"constructor":{"type":"add"}}}}}');
  const s = await scan(writeTree([{ id: uuid(1160), content: lines.join("\n") + "\n" }]).root);
  assert.equal(s.exchanges.length, 1, "the stray end event's own turn (id `constructor`) has no prompt: it continues the exchange");
  const [e] = s.exchanges;
  assert.deepEqual([e!.humanPrompt, e!.toolCalls, e!.toolErrors, e!.toolErrorsCmd, e!.toolErrorsEdit, e!.edits, e!.blindEdits, e!.steps, e!.inTok],
    [1, 3, 3, 2, 1, 2, 0, 1, 7]);
  // Plain strings, never prototype members; an effort outside the effort enum is "other" (WP-12 review: field shapes).
  assert.deepEqual([e!.model, e!.effort], ["toString", "other"], "labels are plain strings");
  assert.equal(Object.getPrototypeOf(s.stats.unknownTypes), Object.prototype);
  assert.deepEqual({ ...s.stats.unknownTypes }, { "codex:item:toString": 1, "codex:constructor": 1, "codex:event_msg:__proto__": 1 });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(typeof ({} as Record<string, unknown>).toString, "function", "Object.prototype untouched");
  splitAddsUp(s.exchanges);
});
