import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import type { Exchange } from "../../src/types.js";
import {
  hash, image, makeRoot, parseSession, projectPath, scanOne, SessionBuilder, text, thinking, toolUseBlock, writeJsonl,
} from "../fixtures/claude/builder.js";

const only = (xs: Exchange[]): Exchange => {
  assert.equal(xs.length, 1);
  return xs[0]!;
};

test("basic session: exchanges, labels, ids, tokens, tool counts", async () => {
  const s = new SessionBuilder("sess-basic", { start: "2026-09-01T10:00:00.000Z", version: "2.1.250" });
  const p1 = s.prompt("please add a function that parses dates");
  s.response([thinking("", "sig-aaaa"), toolUseBlock("t1", "Read", { file_path: "/synthetic/a.ts" })], { outPerLine: [5, 40] });
  s.toolResult("t1");
  s.response([toolUseBlock("t2", "Edit", { file_path: "/synthetic/a.ts" })], { usage: { output_tokens: 30 } });
  s.toolResult("t2", { isError: true, content: "String to replace not found" });
  s.response([text("done")], { usage: { output_tokens: 7 } });
  s.prompt("now also handle time zones please");
  s.response([toolUseBlock("t3", "Bash", { command: "echo synthetic" })], { model: "claude-opus-5" });
  s.toolResult("t3");
  s.response([text("ok")], { model: "claude-opus-5" });

  const r = await parseSession(s, "-synthetic-home-project-alpha");
  assert.equal(r.exchanges.length, 2);
  const [a, b] = r.exchanges as [Exchange, Exchange];

  assert.equal(a.v, 1);
  assert.equal(a.agent, "claude-code");
  assert.equal(a.session, hash("sess-basic", "s-"));
  assert.equal(a.project, hash("-synthetic-home-project-alpha", "p-"));
  assert.equal(a.id, hash(`claude-code|-synthetic-home-project-alpha/sess-basic.jsonl|${p1.uuid as string}`, "x-"));
  assert.notEqual(a.id, b.id);
  assert.equal(a.t, "2026-09-01T10:00:01.000Z");
  assert.equal(a.day, "2026-09-01");
  assert.deepEqual([a.seq, b.seq], [0, 1]);
  assert.deepEqual([a.version, a.model, a.servedModel, a.effort, a.mode, a.entrypoint], ["2.1.250", "claude-sonnet-5", "claude-sonnet-5", "high", "default", "cli"]);
  assert.equal(a.humanPrompt, 1);
  assert.equal(a.promptChars, "please add a function that parses dates".length);
  assert.equal(a.steps, 3);
  assert.equal(a.toolCalls, 2);
  assert.equal(a.reads, 1);
  assert.equal(a.edits, 1);
  assert.equal(a.blindEdits, 0);
  assert.equal(a.toolErrors, 1);
  assert.equal(a.outTok, 40 + 30 + 7, "streamed response keeps the max output_tokens, not the first line");
  assert.equal(a.inTok, 30);
  assert.equal(a.cacheRead, 3000);
  assert.equal(a.cacheWrite, 300);
  assert.equal(a.thinkBlocks, 1);
  assert.equal(a.thinkRedacted, 1);
  assert.equal(a.thinkSigMedian, "sig-aaaa".length);
  assert.equal(a.durationMs, 6000);
  assert.equal(a.afterCompaction, false);
  assert.deepEqual([a.interrupted, a.pushback, a.queuedMidTurn, a.rejections, a.blocked, a.churned], [0, 0, 0, 0, 0, 0]);

  assert.equal(b.model, "claude-opus-5");
  assert.equal(b.steps, 2);
  assert.equal(b.toolCalls, 1);
  assert.equal(b.reads + b.edits, 0);

  assert.equal(r.stats.files, 1);
  assert.equal(r.stats.duplicates, 1, "one extra streaming line");
  assert.deepEqual(r.stats.unknownTypes, {});
});

test("day follows the requested time zone", async () => {
  const s = new SessionBuilder("sess-tz", { start: "2026-09-01T03:29:59.000Z" });
  s.prompt("late night question about the build");
  s.response([text("answer")]);
  const r = await parseSession(s);
  const x = only(r.exchanges);
  assert.equal(x.day, "2026-09-01");
  const { claudeReader } = await import("../../src/readers/claude.js");
  const root = makeRoot();
  writeJsonl(join(projectPath(root, "p"), "sess-tz.jsonl"), s.records);
  const prev = process.env.WASITME_CLAUDE_DIR;
  process.env.WASITME_CLAUDE_DIR = root;
  try {
    const src = claudeReader.list()[0]!;
    const chicago = await claudeReader.parse(src, { hash, now: new Date("2026-10-04T12:00:00Z"), timeZone: "America/Chicago" });
    assert.equal(chicago.exchanges[0]!.day, "2026-08-31");
  } finally {
    if (prev === undefined) delete process.env.WASITME_CLAUDE_DIR;
    else process.env.WASITME_CLAUDE_DIR = prev;
  }
});

test("streaming split: merge by message.id+requestId, max of every usage field, interleaved lines", async () => {
  const s = new SessionBuilder("sess-stream");
  s.prompt("run the two checks in parallel");
  // Line 1 (tool_use t1) → tool result → line 2 (tool_use t2) of the SAME response → line 3 text.
  const req = "req_shared";
  const msg = "msg_shared";
  const line = (block: ReturnType<typeof text>, out: number, input: number) =>
    s.push({
      type: "assistant", uuid: s.uuid(), timestamp: s.tick(), sessionId: s.id, version: s.version, requestId: req,
      message: { id: msg, role: "assistant", model: "claude-sonnet-5", content: [block], usage: { input_tokens: input, output_tokens: out, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } },
    });
  line(toolUseBlock("t1", "Bash", {}), 12, 9);
  s.toolResult("t1");
  line(toolUseBlock("t2", "Bash", {}), 55, 11);
  line(text("both done"), 31, 11);
  const r = await parseSession(s);
  const x = only(r.exchanges);
  assert.equal(x.steps, 1);
  assert.equal(x.toolCalls, 2);
  assert.equal(x.outTok, 55, "max output_tokens (not first 12, not last 31, not the sum)");
  assert.equal(x.inTok, 11);
  assert.equal(x.cacheRead, 500);
  assert.equal(r.stats.duplicates, 2);
});

test("missing requestId: same message id + same input usage merges; reused id with different usage does not", async () => {
  const s = new SessionBuilder("sess-noreq");
  s.prompt("summarise the module");
  s.response([text("part 1"), text("part 2")], { requestId: null, msgId: "msg_gw", usage: { input_tokens: 100, output_tokens: 9 }, outPerLine: [3, 9] });
  s.response([text("second answer")], { requestId: null, msgId: "msg_gw", usage: { input_tokens: 250, output_tokens: 4 } });
  const x = only((await parseSession(s)).exchanges);
  assert.equal(x.steps, 2);
  assert.equal(x.outTok, 9 + 4);
  assert.equal(x.inTok, 100 + 250);
});

test("real-prompt filter: origin.kind when present, conservative fallback otherwise ([Image prompts kept)", async () => {
  const s = new SessionBuilder("sess-prompts");
  const reply = () => s.response([text("reply")]);
  s.prompt("fix the failing test"); reply(); // human 1
  s.user("<task-notification>build finished</task-notification>", { origin: { kind: "task-notification" } }); reply();
  s.user("message from a peer session", { origin: { kind: "peer" } }); reply();
  s.user("[Image #1] what is wrong in this screenshot?"); reply(); // human 2 (fallback)
  s.user("<command-name>/compact</command-name>\n<command-message>compact</command-message>"); reply();
  s.user("This session is being continued from a previous conversation that ran out of context.", { isCompactSummary: true }); reply();
  s.user("Caveat: The messages below were generated by the user while running local commands.", { isMeta: true }); reply();
  s.user([image()]); reply(); // human 3 (image only)
  s.user([text("<ide_opened_file>synthetic.ts</ide_opened_file>"), text("explain this file")]); reply(); // human 4
  s.user([text("[Request interrupted by user]")]); reply();
  s.prompt([text("[Image #2] compare with the previous one"), image()]); reply(); // human 5
  s.user("Stop hook feedback: tests failed"); reply();
  s.user([text("[Your previous response had no visible output]")]); reply();

  const r = await parseSession(s);
  const humans = r.exchanges.filter((x) => x.humanPrompt === 1);
  assert.equal(humans.length, 5);
  assert.equal(r.exchanges.length, 5, "non-human user records never open exchanges");
  assert.deepEqual(humans.map((x) => x.promptChars), [
    "fix the failing test".length,
    "[Image #1] what is wrong in this screenshot?".length,
    0,
    "explain this file".length,
    "[Image #2] compare with the previous one".length,
  ]);
  assert.equal(r.exchanges[3]!.interrupted, 1);
  assert.equal(r.exchanges.reduce((n, x) => n + x.steps, 0), 13);
});

test("interrupts in string and list form, tool-use cancels, and aborted requests", async () => {
  const s = new SessionBuilder("sess-int");
  s.prompt("first task"); s.response([text("working")]);
  s.user("[Request interrupted by user]"); // string form
  s.prompt("second task"); s.response([toolUseBlock("t1", "Bash", {})]);
  s.toolResult("t1", { isError: true, content: "The user doesn't want to take this action right now. STOP what you are doing." });
  s.user([text("[Request interrupted by user for tool use]")]); // list form
  s.prompt("third task"); s.response([text("thinking about it")]);
  s.apiErrorMessage("API Error: Request was aborted.");
  s.prompt("fourth task"); s.response([text("all good")]);
  s.user("I quoted [Request interrupted by user] in the middle of a sentence", { origin: { kind: "human" } });
  s.response([text("noted")]);
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => x.interrupted), [1, 1, 1, 0, 0]);
  assert.equal(r.exchanges[1]!.toolErrors, 0, "a cancelled tool is an interrupt, not a tool failure");
  assert.equal(r.exchanges[2]!.apiErrors, 0, "an aborted request is an interrupt, not an API error");
});

test("tool denials: rejections vs blocked vs genuine tool errors", async () => {
  const s = new SessionBuilder("sess-deny");
  s.prompt("do the risky refactor");
  const ids = ["r1", "b1", "b2", "b3", "legacy", "e1", "ok1", "ok2"];
  s.response(ids.map((id) => toolUseBlock(id, "Bash", {})));
  s.toolResult("r1", { isError: true, denial: "user-rejected", content: "The user doesn't want to proceed with this tool use." });
  s.toolResult("b1", { isError: true, denial: "automode-blocked", content: "Blocked by auto mode" });
  s.toolResult("b2", { isError: true, denial: "permission-rule", content: "Denied by rule" });
  s.toolResult("b3", { isError: true, denial: "automode-unavailable", content: "Unavailable" });
  s.toolResult("legacy", { isError: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." });
  s.toolResult("e1", { isError: true, content: "Exit code 1" });
  s.toolResult("ok1");
  s.toolResult("ok2", { isError: false, content: "The user doesn't want to proceed with this tool use (quoted in a file)" });
  s.toolResult("e1", { isError: true, content: "Exit code 1" }); // duplicate result id
  const r = await parseSession(s);
  const x = only(r.exchanges);
  assert.equal(x.toolCalls, 8);
  assert.equal(x.rejections, 2);
  assert.equal(x.blocked, 3);
  assert.equal(x.toolErrors, 1);
  assert.equal(r.stats.duplicates, 7 + 1, "7 extra streaming lines + 1 repeated tool result");
});

test("API errors vs retries, synthetic messages are not steps", async () => {
  const s = new SessionBuilder("sess-api");
  s.prompt("deploy the preview build");
  s.system("api_error", { error: { status: 529 }, retryAttempt: 1, maxRetries: 10, retryInMs: 500 });
  s.system("api_error", { error: { status: 529 }, retryAttempt: 2, maxRetries: 10, retryInMs: 1000 });
  s.response([text("deployed")]);
  s.apiErrorMessage("API Error: 401 authentication failed", { requestId: "req_x" });
  s.push({ type: "assistant", uuid: s.uuid(), timestamp: s.tick(), message: { id: "m_syn", model: "<synthetic>", role: "assistant", content: [text("No response requested.")], usage: { input_tokens: 0, output_tokens: 0 } } });
  const x = only((await parseSession(s)).exchanges);
  assert.equal(x.apiRetries, 2);
  assert.equal(x.apiErrors, 1);
  assert.equal(x.steps, 1);
  assert.equal(x.model, "claude-sonnet-5");
});

test("compaction counts and afterCompaction for later exchanges", async () => {
  const s = new SessionBuilder("sess-compact");
  s.prompt("long task part one"); s.response([text("a")]);
  s.system("compact_boundary", { compactMetadata: { trigger: "auto", preTokens: 150000 } });
  s.user("This session is being continued from a previous conversation.", { isCompactSummary: true });
  s.response([text("b")]);
  s.prompt("long task part two"); s.response([text("c")]);
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => [x.compactions, x.afterCompaction]), [[1, false], [0, true]]);
});

test("thinking blocks: redacted = empty text, signature-length median", async () => {
  const s = new SessionBuilder("sess-think");
  s.prompt("think hard about the race condition");
  s.response([
    thinking("visible reasoning", "s".repeat(100)),
    thinking("", "s".repeat(300)),
    { type: "redacted_thinking", data: "opaque" },
    thinking("", "s".repeat(200)),
    text("answer"),
  ]);
  const x = only((await parseSession(s)).exchanges);
  assert.equal(x.thinkBlocks, 4);
  assert.equal(x.thinkRedacted, 3);
  assert.equal(x.thinkSigMedian, 200);
});

test("reads, edits, blind edits (window spans exchanges) and churn", async () => {
  const s = new SessionBuilder("sess-edits");
  const call = (id: string, name: string, input: Record<string, unknown>) => s.response([toolUseBlock(id, name, input)]);
  s.prompt("refactor a, b and c");
  call("1", "Read", { file_path: "/synthetic/a.ts" });
  call("2", "Edit", { file_path: "/synthetic/a.ts" }); // read first → fine
  call("3", "Edit", { file_path: "/synthetic/b.ts" }); // never read → blind
  call("4", "Write", { file_path: "/synthetic/c.ts" });
  call("5", "Edit", { file_path: "/synthetic/c.ts" }); // just written → content known
  call("6", "Grep", { pattern: "x" });
  call("7", "Edit", { file_path: "/synthetic/a.ts" });
  call("8", "Edit", { file_path: "/synthetic/a.ts" }); // a edited 3x → churn
  s.prompt("now tidy c");
  call("9", "Edit", { file_path: "/synthetic/c.ts" }); // Write of c is within the previous 10 tool calls
  for (let i = 0; i < 10; i++) call(`bash${i}`, "Bash", {});
  s.prompt("one more change to a");
  call("20", "Edit", { file_path: "/synthetic/a.ts" }); // last read of a is > 10 tool calls ago → blind
  call("21", "MultiEdit", { __unparsedToolInput: "???" }); // no path: counted as an edit, never judged blind
  call("22", "NotebookRead", { notebook_path: "/synthetic/n.ipynb" });
  call("23", "NotebookEdit", { notebook_path: "/synthetic/n.ipynb" });

  const r = await parseSession(s);
  const [a, b, c] = r.exchanges as [Exchange, Exchange, Exchange];
  assert.deepEqual([a.toolCalls, a.reads, a.edits, a.blindEdits, a.churned], [8, 2, 6, 1, 1]);
  assert.deepEqual([b.toolCalls, b.reads, b.edits, b.blindEdits, b.churned], [11, 0, 1, 0, 0]);
  assert.deepEqual([c.toolCalls, c.reads, c.edits, c.blindEdits, c.churned], [4, 1, 3, 1, 0]);
});

test("queued prompts typed mid-turn: counted once, task notifications excluded, legacy queue-ops deduped", async () => {
  const s = new SessionBuilder("sess-queue");
  s.prompt("migrate the config loader");
  s.response([toolUseBlock("t1", "Bash", {})]);
  s.queueOp("enqueue", "also add tests");
  s.queueOp("remove", "also add tests", { reason: "absorbed_mid_turn" }); // remove BEFORE the attachment
  s.attachment({ type: "queued_command", prompt: "also add tests", commandMode: "prompt", origin: { kind: "human" } });
  s.toolResult("t1");
  s.queueOp("enqueue", "no, use the other file");
  s.attachment({ type: "queued_command", prompt: [text("no, use the other file")], commandMode: "prompt", origin: { kind: "human" } });
  s.queueOp("remove", "no, use the other file", { reason: "absorbed_mid_turn" }); // remove AFTER the attachment
  s.attachment({ type: "queued_command", prompt: "<task-notification>done</task-notification>", commandMode: "task-notification", origin: { kind: "task-notification" } });
  s.attachment({ type: "queued_command", prompt: "<task-notification>done</task-notification>", commandMode: "task-notification" });
  s.attachment({ type: "queued_command", prompt: "and update the docs", commandMode: "prompt" }); // pre-origin shape
  s.attachment({ type: "queued_command", prompt: "meta prompt", commandMode: "prompt" }, { isMeta: true });
  s.queueOp("remove", "legacy typed prompt"); // older logs: no attachment at all
  s.queueOp("remove", "<task-notification>x</task-notification>", { reason: "absorbed_mid_turn" });
  s.queueOp("remove", "pulled back to edit", { reason: "user_edit" });
  s.queueOp("remove");
  s.queueOp("dequeue", "sent as a normal prompt later");
  s.response([text("done")]);
  const x = only((await parseSession(s)).exchanges);
  assert.equal(x.queuedMidTurn, 4);
  assert.equal(x.pushback, 1, "a queued 'no, …' is mid-turn pushback");
  assert.equal(x.humanPrompt, 1);
});

test("pushback: phrase heuristic or near-duplicate of the previous prompt", async () => {
  const s = new SessionBuilder("sess-push");
  const turn = (p: string) => { s.prompt(p); s.response([text("ok")]); };
  turn("please refactor the parser module into two files");
  turn("please refactor the parser module into two separate files");
  turn("great, now write the changelog entry");
  turn("No, the changelog goes in docs");
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => x.pushback), [0, 1, 0, 1]);
});

test("unknown record types are surfaced; known metadata (incl. relocated, D62b) is not", async () => {
  const s = new SessionBuilder("sess-types");
  s.meta("ai-title", { aiTitle: "synthetic" });
  s.meta("mode", { mode: "normal" });
  s.meta("artifact-comment-monitor", { artifacts: [] });
  s.meta("last-prompt", { leafUuid: "x" });
  s.meta("relocated", { relocatedCwd: "/synthetic/elsewhere" });
  s.meta("relocated", { relocatedCwd: "/synthetic/elsewhere" });
  s.meta("future-record-kind");
  s.meta("<b>weird</b>");
  s.push({ sessionId: s.id, note: "no type at all" });
  s.prompt("hello there"); s.response([text("hi")]);
  const r = await parseSession(s);
  assert.deepEqual(r.stats.unknownTypes, { "future-record-kind": 1, other: 1, untyped: 1 });
  assert.equal(r.exchanges.length, 1);
});

test("bad lines, truncated tail and out-of-range timestamps are counted, not fatal", async () => {
  const s = new SessionBuilder("sess-bad");
  s.prompt("check the logs");
  s.response([text("fine")]);
  const root = makeRoot();
  const lines: (Record<string, unknown> | string)[] = [
    ...s.records,
    "{not json",
    "[1,2,3]",
    { type: "system", subtype: "informational", uuid: "bad-ts-1", timestamp: "2019-01-01T00:00:00Z" },
    { type: "system", subtype: "informational", uuid: "bad-ts-2", timestamp: "not a date" },
    '{"type":"assistant","uuid":"cut',
  ];
  writeJsonl(join(projectPath(root, "p"), "sess-bad.jsonl"), lines, false);
  const r = await scanOne(root);
  assert.equal(r.stats.badLines, 2);
  assert.equal(r.stats.truncatedTail, 1);
  assert.equal(r.stats.badTimestamps, 2);
  assert.equal(r.exchanges.length, 1);
});

test("durationMs survives reordered writes, clock resets, stray early/late timestamps and clock excursions (never negative)", async () => {
  // (a) a record written slightly out of order does not inflate the span
  const a = new SessionBuilder("sess-dur-a", { start: "2026-09-02T10:00:00.000Z" });
  a.prompt("task a"); a.tick(9); a.response([toolUseBlock("t1", "Bash", {})]); // 10:00:11
  a.tick(-4); a.toolResult("t1"); // 10:00:08 (reordered)
  a.tick(11); a.response([text("done")]); // 10:00:20
  assert.equal(only((await parseSession(a)).exchanges).durationMs, 19_000);

  // (b) the clock is reset two hours back mid-exchange and keeps running from there
  const b = new SessionBuilder("sess-dur-b", { start: "2026-09-02T10:00:00.000Z" });
  b.prompt("task b"); // 10:00:01
  b.tick(59); b.response([toolUseBlock("t1", "Bash", {})]); // 10:01:01
  b.setTime("2026-09-02T08:00:30.000Z"); b.toolResult("t1"); // 08:00:31
  b.setTime("2026-09-02T08:01:00.000Z"); b.response([text("x")]); // 08:01:01
  b.setTime("2026-09-02T08:02:00.000Z"); b.response([text("y")]); // 08:02:01
  assert.equal(only((await parseSession(b)).exchanges).durationMs, 60_000 + 30_000 + 60_000);

  // (c) one stray record stamped an hour early is ignored
  const c = new SessionBuilder("sess-dur-c", { start: "2026-09-02T10:00:00.000Z" });
  c.prompt("task c"); // 10:00:01
  c.tick(59); c.response([toolUseBlock("t1", "Bash", {})]); // 10:01:01
  c.setTime("2026-09-02T08:59:59.000Z"); c.toolResult("t1"); // 09:00:00
  c.setTime("2026-09-02T10:02:00.000Z"); c.response([text("z")]); // 10:02:01
  assert.equal(only((await parseSession(c)).exchanges).durationMs, 120_000);

  // (d) the whole exchange runs backward: zero, not negative
  const d = new SessionBuilder("sess-dur-d", { start: "2026-09-02T10:00:00.000Z" });
  d.prompt("task d");
  d.tick(-30); d.response([text("x")]);
  d.tick(-30); d.response([text("y")]);
  const xd = only((await parseSession(d)).exchanges);
  assert.ok(xd.durationMs >= 0);
  assert.equal(xd.durationMs, 0);

  // (e) one stray record stamped an hour LATE is refunded once the clock is seen to continue below it
  const e = new SessionBuilder("sess-dur-e", { start: "2026-09-02T10:00:00.000Z" });
  e.prompt("task e"); // 10:00:01
  e.tick(29); e.response([toolUseBlock("t1", "Bash", {})]); // 10:00:31
  e.setTime("2026-09-02T10:59:59.000Z"); e.toolResult("t1"); // 11:00:00 (stray)
  e.setTime("2026-09-02T10:00:59.000Z"); e.response([text("x")]); // 10:01:00
  e.tick(29); e.response([text("y")]); // 10:01:30
  assert.equal(only((await parseSession(e)).exchanges).durationMs, 89_000, "10:00:01 → 10:01:30");

  // (f) the clock runs 3h ahead for two records, then is corrected
  const f = new SessionBuilder("sess-dur-f", { start: "2026-09-02T10:00:00.000Z" });
  f.prompt("task f"); // 10:00:01
  f.tick(59); f.response([toolUseBlock("t1", "Bash", {})]); // 10:01:01
  f.setTime("2026-09-02T13:01:30.000Z"); f.toolResult("t1"); // 13:01:31
  f.tick(29); f.response([text("x")]); // 13:02:01
  f.setTime("2026-09-02T10:02:00.000Z"); f.response([text("y")]); // 10:02:01
  f.tick(59); f.response([text("z")]); // 10:03:01
  assert.equal(only((await parseSession(f)).exchanges).durationMs, 180_000, "10:00:01 → 10:03:01");
});

test("agent-initiated stretch at file start; metadata alone opens nothing; empty stretches dropped", async () => {
  const s = new SessionBuilder("sess-agent");
  s.meta("custom-title", { customTitle: "synthetic" });
  s.attachment({ type: "date", date: "2026-09-01" });
  const note = s.user("<task-notification>background job finished</task-notification>", { origin: { kind: "task-notification" } });
  s.tick(4);
  s.response([text("the background job finished fine")]);
  s.prompt("thanks, now ship it");
  s.response([text("shipped")]);
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => [x.humanPrompt, x.steps, x.seq]), [[0, 1, 0], [1, 1, 1]]);
  // The stretch starts at its first main-thread record (the notification), not at the first response.
  const x0 = r.exchanges[0]!;
  assert.equal(x0.t, note.timestamp);
  assert.equal(x0.id, hash(`claude-code|-synthetic-home-project-alpha/sess-agent.jsonl|${note.uuid as string}`, "x-"));
  assert.equal(x0.durationMs, 5000, "clock runs from the notification to the response");

  // A lone non-prompt record with nothing after it opens nothing; one followed by a human prompt is dropped.
  const lone = new SessionBuilder("sess-lone-note");
  lone.user("<task-notification>done</task-notification>", { origin: { kind: "task-notification" } });
  assert.deepEqual((await parseSession(lone)).exchanges, []);
  const before = new SessionBuilder("sess-note-then-prompt");
  before.user("<task-notification>done</task-notification>", { origin: { kind: "task-notification" } });
  const p = before.prompt("now do the next thing");
  before.response([text("ok")]);
  const xs = (await parseSession(before)).exchanges;
  assert.deepEqual(xs.map((x) => [x.humanPrompt, x.t]), [[1, p.timestamp]]);

  const e = new SessionBuilder("sess-meta-only");
  e.meta("ai-title", { aiTitle: "x" });
  e.attachment({ type: "date", date: "2026-09-01" });
  e.prompt("first real prompt");
  e.response([text("ok")]);
  assert.deepEqual((await parseSession(e)).exchanges.map((x) => x.humanPrompt), [1]);
});

test("records repeated inside one file (same uuid) are skipped and counted", async () => {
  const s = new SessionBuilder("sess-dupe");
  s.prompt("first");
  s.response([text("one"), text("two")]);
  const firstPart = [...s.records];
  for (const r of firstPart) s.push({ ...r });
  s.prompt("second");
  s.response([text("three")]);
  const r = await parseSession(s);
  assert.equal(r.exchanges.length, 2);
  assert.deepEqual(r.exchanges.map((x) => x.steps), [1, 1]);
  assert.equal(r.stats.duplicates, 1 + firstPart.length);
});

test("privacy: no prompt text, paths, cwd, project or session names reach the output", async () => {
  const secretProject = "-Users-SECRETPERSON-clients-AcmeCorp";
  const s = new SessionBuilder("SECRETSESSION-1234", { cwd: "/Users/SECRETPERSON/clients/AcmeCorp" });
  s.prompt("my password is hunter2 and key sk-ant-FAKEFAKEFAKE, please fix /Users/SECRETPERSON/clients/AcmeCorp/app.ts");
  s.response([thinking("internal reasoning about hunter2", "sig-SECRET"), toolUseBlock("t1", "Read", { file_path: "/Users/SECRETPERSON/clients/AcmeCorp/app.ts" })], { model: "claude-sonnet-5" });
  s.toolResult("t1", { content: "const apiKey = 'sk-ant-FAKEFAKEFAKE'" });
  s.response([toolUseBlock("t2", "Edit", { file_path: "/Users/SECRETPERSON/clients/AcmeCorp/app.ts", old_string: "hunter2", new_string: "x" })], { model: "<b>evil</b> model" });
  s.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__AcmeCorpCRM__lookup"], removedNames: [], readdedNames: [] });
  s.attachment({ type: "skill_listing", isInitial: true, skillCount: 1, names: ["acmecorp-secret-skill"], content: "x" });
  s.prompt("SECRETPERSON follow-up about AcmeCorp");
  s.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__SECRETPERSONmail__send"], removedNames: [], readdedNames: [] });
  s.attachment({ type: "skill_listing", isInitial: false, skillCount: 1, names: ["SECRETPERSON-skill"], content: "x" });
  s.attachment({ type: "prompt_snapshot", systemPrompt: ["You are helping SECRETPERSON at AcmeCorp"] });
  s.attachment({ type: "prompt_snapshot", systemPrompt: ["You are helping SECRETPERSON at AcmeCorp with hunter2"] });
  s.attachment({ type: "queued_command", prompt: "also rotate hunter2", commandMode: "prompt", origin: { kind: "human" } });
  s.meta("relocated", { relocatedCwd: "/Users/SECRETPERSON/clients/AcmeCorp" });
  const r = await parseSession(s, secretProject);
  assert.deepEqual(r.events.map((e) => e.kind).sort(), ["mcp", "skills", "system-prompt"], "setup changes are reported, as hashes/counts");
  const out = JSON.stringify(r);
  for (const needle of ["SECRETPERSON", "AcmeCorp", "acmecorp", "hunter2", "sk-ant", "SECRETSESSION", "app.ts", "/Users", "evil", "mcp__", "reasoning", "skill-"]) {
    assert.ok(!out.includes(needle), `output leaked "${needle}"`);
  }
});
