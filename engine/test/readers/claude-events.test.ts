import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeEvent } from "../../src/types.js";
import { hash, parseSession, SessionBuilder, text } from "../fixtures/claude/builder.js";

const brief = (e: ChangeEvent) => [e.kind, e.from, e.to, e.side, e.userInitiated ?? false];
/** Side · strength · provenance (METHOD.md §9 table). */
const attribution = (e: ChangeEvent) => [e.kind, e.side, e.strength, e.provenance];

test("version, model, effort and permission-mode changes, with /model and /effort attribution", async () => {
  const s = new SessionBuilder("sess-ev", { version: "2.1.250" });
  s.prompt("start the task");
  s.response([text("a")], { model: "claude-sonnet-5", effort: "high" });
  s.version = "2.1.251";
  const versionPrompt = s.prompt("continue with the next step");
  s.response([text("b")], { model: "claude-sonnet-5", effort: "high" });
  s.user("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>");
  s.user("<local-command-stdout>Set model to Opus</local-command-stdout>");
  s.attachment({ type: "model", identity: { modelId: "claude-opus-5[1m]", marketingName: "Opus", knowledgeCutoff: "2026" }, text: "model identity" });
  s.prompt("now with the bigger model");
  s.response([text("c")], { model: "claude-opus-5", effort: "high" }); // same model as the identity (suffix ignored)
  s.response([text("d")], { model: "claude-sonnet-5-5", effort: "high" }); // no command → unknown
  s.system("local_command", { content: "<command-name>/effort</command-name>\n<command-args>max</command-args>" });
  s.response([text("e")], { model: "claude-sonnet-5-5", effort: "max" });
  s.response([text("f")], { model: "claude-sonnet-5-5", effort: "medium" });
  s.prompt("switch modes", { permissionMode: "auto" });
  s.response([text("g")], { model: "claude-sonnet-5-5", effort: "medium" });
  s.meta("permission-mode", { permissionMode: "bypassPermissions" });
  s.user("<command-name>/model</command-name>");
  s.response([text("h")], { model: "claude-sonnet-5-5", effort: "medium" }); // /model picked the same model
  s.response([text("i")], { model: "claude-opus-5-5", effort: "medium" }); // later change is not explained by it

  const r = await parseSession(s);
  assert.deepEqual(r.events.map(brief), [
    ["version", "2.1.250", "2.1.251", "agent", false],
    ["model", "claude-sonnet-5", "claude-opus-5", "you", true],
    ["model", "claude-opus-5", "claude-sonnet-5-5", "unknown", false],
    ["effort", "high", "max", "you", true],
    ["effort", "max", "medium", "unknown", false],
    ["mode", "default", "auto", "you", false],
    ["mode", "auto", "bypassPermissions", "you", false],
    ["model", "claude-sonnet-5-5", "claude-opus-5-5", "unknown", false],
  ]);
  assert.deepEqual(r.events.map(attribution), [
    ["version", "agent", "routine", "log_field"],
    ["model", "you", "strong", "command"], // the identity attachment after /model: the command explains it
    ["model", "unknown", "weak", "log_field"],
    ["effort", "you", "strong", "command"],
    ["effort", "unknown", "weak", "log_field"],
    ["mode", "you", "strong", "log_field"],
    ["mode", "you", "strong", "log_field"],
    ["model", "unknown", "weak", "log_field"],
  ]);
  const v = r.events[0]!;
  assert.equal(v.t, versionPrompt.timestamp);
  assert.equal(v.day, (versionPrompt.timestamp as string).slice(0, 10));
  assert.equal(v.agent, "claude-code");
  assert.equal(v.evidence, "log");
  assert.equal(v.id, hash(`claude-code|version|2.1.250|2.1.251|${v.t}`, "e-"));
  assert.equal(new Set(r.events.map((e) => e.id)).size, r.events.length);
  // Exchange labels are majority values inside each exchange.
  assert.deepEqual(r.exchanges.map((x) => [x.version, x.model, x.effort, x.mode]), [
    ["2.1.250", "claude-sonnet-5", "high", "default"],
    ["2.1.251", "claude-sonnet-5", "high", "default"],
    ["2.1.251", "claude-sonnet-5-5", "high", "default"],
    ["2.1.251", "claude-sonnet-5-5", "medium", "bypassPermissions"],
  ]);
});

test("MCP servers: the first exchange is the baseline; later a never-seen server is a change; churn is not", async () => {
  const s = new SessionBuilder("sess-mcp");
  s.prompt("use the tools");
  s.attachment({
    type: "deferred_tools_delta", addedNames: ["WebFetch", "mcp__alpha__search"], removedNames: [], readdedNames: [],
    pendingMcpServers: ["beta server", "slow"], needsAuthMcpServers: ["claude.ai Gmail"], failedMcpServers: [{ name: "delta", error: "spawn failed" }],
  });
  s.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__beta_server__query"], removedNames: [], readdedNames: [], pendingMcpServers: [] });
  s.attachment({ type: "mcp_instructions_delta", addedNames: ["alpha"], removedNames: [], addedBlocks: [] });
  s.response([text("a")]);
  s.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__late__run"], removedNames: [], readdedNames: [] }); // still first exchange
  s.prompt("keep going");
  s.attachment({ type: "deferred_tools_delta", addedNames: [], removedNames: ["mcp__alpha__search"], readdedNames: [] }); // disconnect
  s.attachment({ type: "mcp_instructions_delta", addedNames: [], removedNames: ["alpha"], addedBlocks: [] });
  s.attachment({ type: "deferred_tools_delta", addedNames: [], removedNames: [], readdedNames: ["mcp__alpha__search"] }); // reconnect
  s.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__slow__q"], removedNames: [], readdedNames: [], pendingMcpServers: [] }); // was pending since startup
  s.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__gamma__run"], removedNames: [], readdedNames: [] }); // genuinely new
  s.response([text("b")]);
  const r = await parseSession(s);
  const mcp = r.events.filter((e) => e.kind === "mcp");
  assert.deepEqual(mcp.map((e) => [e.side, e.note]), [["you", "+1 (6->7 servers)"]]);
  assert.deepEqual(mcp.map(attribution), [["mcp", "you", "strong", "attachment"]]);
  assert.match(mcp[0]!.from, /^h:[0-9a-f]{8}$/);
  assert.match(mcp[0]!.to, /^h:[0-9a-f]{8}$/);
  assert.notEqual(mcp[0]!.from, mcp[0]!.to);
});

test("skills: first exchange is the baseline; never-seen skills later are a change; re-listings are not", async () => {
  const s = new SessionBuilder("sess-skills");
  s.prompt("hello");
  s.attachment({ type: "skill_listing", isInitial: true, skillCount: 5, names: ["a", "b", "c", "d", "e"], content: "x" });
  s.response([text("a")]);
  s.attachment({ type: "skill_listing", isInitial: false, skillCount: 1, names: ["late"], content: "x" }); // still first exchange
  s.prompt("again");
  s.attachment({ type: "skill_listing", isInitial: false, skillCount: 2, names: ["f", "g"], content: "x" });
  s.attachment({ type: "skill_listing", isInitial: true, skillCount: 8, names: ["a", "b", "c", "d", "e", "f", "g", "late"], content: "x" });
  s.attachment({ type: "skill_listing", isInitial: true, skillCount: 3, names: ["a", "b", "c"], content: "x" }); // budgeted re-listing
  s.response([text("b")]);
  const r = await parseSession(s);
  assert.deepEqual(r.events.filter((e) => e.kind === "skills").map(brief), [["skills", "6", "8", "unknown", false]]);
  assert.deepEqual(r.events.filter((e) => e.kind === "skills").map(attribution), [["skills", "unknown", "weak", "attachment"]]);
});

test("permission mode label falls back to the mode at the prompt when no response was logged", async () => {
  const s = new SessionBuilder("sess-mode");
  s.prompt("do it", { permissionMode: "plan" });
  s.user("[Request interrupted by user]");
  s.prompt("ok now", { permissionMode: "plan" });
  s.response([text("done")]);
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => [x.mode, x.model, x.steps, x.interrupted]), [["plan", "unknown", 0, 1], ["plan", "claude-sonnet-5", 1, 0]]);
});

test("system prompt: hashed; cwd/date-only differences ignored; side depends on a version change", async () => {
  const s = new SessionBuilder("sess-sp", { version: "2.1.250" });
  const snap = (lines: string[]) => s.attachment({ type: "prompt_snapshot", systemPrompt: lines, tools: [] });
  s.prompt("hello");
  snap(["You are a synthetic assistant.", `Working directory: ${s.cwd}`, "Today's date is 2026-09-01."]);
  s.response([text("a")]);
  s.cwd = "/synthetic/home/other-project";
  snap(["You are a synthetic assistant.", `Working directory: ${s.cwd}`, "Today's date is 2026-09-02."]);
  snap(["You are a synthetic assistant, v2.", `Working directory: ${s.cwd}`, "Today's date is 2026-09-02."]);
  s.version = "2.1.251";
  s.prompt("again");
  snap(["You are a synthetic assistant, v3.", `Working directory: ${s.cwd}`, "Today's date is 2026-09-02."]);
  s.response([text("b")]);
  const r = await parseSession(s);
  const sp = r.events.filter((e) => e.kind === "system-prompt");
  assert.deepEqual(sp.map((e) => e.side), ["unknown", "agent"]);
  // At the bump it is routine context, never a deciding agent event (METHOD.md §9); otherwise unknown · weak.
  assert.deepEqual(sp.map(attribution), [["system-prompt", "unknown", "weak", "attachment"], ["system-prompt", "agent", "routine", "attachment"]]);
  for (const e of sp) assert.match(e.to, /^h:[0-9a-f]{8}$/);
  assert.equal(sp[1]!.from, sp[0]!.to);
});

test("older /model command layout (command-message first) still marks the change user-initiated; prose does not", async () => {
  const s = new SessionBuilder("sess-oldcmd");
  s.prompt("hello"); s.response([text("a")], { model: "claude-sonnet-5" });
  s.user("<command-message>model is running…</command-message>\n<command-name>/model</command-name>\n<command-args>opus</command-args>");
  s.prompt("go"); s.response([text("b")], { model: "claude-opus-5" });
  s.prompt("what does <command-name>/model</command-name> do in the logs?"); // a human prompt quoting it
  s.response([text("c")], { model: "claude-sonnet-5" });
  const r = await parseSession(s);
  assert.deepEqual(r.events.map(brief), [
    ["model", "claude-sonnet-5", "claude-opus-5", "you", true],
    ["model", "claude-opus-5", "claude-sonnet-5", "unknown", false],
  ]);
});

test("events are deterministic across parses", async () => {
  const build = () => {
    const s = new SessionBuilder("sess-det", { version: "2.1.250" });
    s.prompt("one"); s.response([text("a")]);
    s.version = "2.1.252";
    s.prompt("two"); s.response([text("b")], { model: "claude-opus-5" });
    return s;
  };
  const a = await parseSession(build());
  const b = await parseSession(build());
  assert.deepEqual(a.events, b.events);
  assert.equal(a.events.length, 2);
});

test("system prompt at a version bump is agent · routine whichever is logged first; a same-version change stays unknown", async () => {
  const s = new SessionBuilder("sess-sp-order", { version: "2.1.250" });
  const snap = (body: string) => s.attachment({ type: "prompt_snapshot", systemPrompt: [body], tools: [] });
  s.prompt("hello");
  snap("synthetic system prompt A");
  s.response([text("a")]);
  // The resumed CLI writes its prompt snapshot before any user/assistant record of the new version.
  s.version = "2.1.251";
  snap("synthetic system prompt B");
  s.prompt("next");
  s.response([text("b")]);
  // Same version, new prompt (output style, server-side template, ...): the logs can't say who.
  snap("synthetic system prompt C");
  s.prompt("again");
  s.response([text("c")]);
  const r = await parseSession(s);
  assert.deepEqual(r.events.map(attribution), [
    ["system-prompt", "agent", "routine", "attachment"],
    ["version", "agent", "routine", "log_field"],
    ["system-prompt", "unknown", "weak", "attachment"],
  ]);
  for (const e of r.events) assert.notEqual(e.strength, "strong", "nothing in this session can decide");
});

test("a model identity attachment without a /model command is unknown · weak, from an attachment", async () => {
  const s = new SessionBuilder("sess-identity");
  s.prompt("hello");
  s.attachment({ type: "model", identity: { modelId: "claude-sonnet-5", marketingName: "Sonnet", knowledgeCutoff: "2026" } });
  s.response([text("a")], { model: "claude-sonnet-5" });
  s.prompt("next");
  s.attachment({ type: "model", identity: { modelId: "claude-opus-5[1m]", marketingName: "Opus", knowledgeCutoff: "2026" } }); // Desktop picker
  s.response([text("b")], { model: "claude-opus-5" });
  const r = await parseSession(s);
  assert.deepEqual(r.events.map((e) => [...attribution(e), e.from, e.to]), [["model", "unknown", "weak", "attachment", "claude-sonnet-5", "claude-opus-5"]]);
});

test("every event carries strength and provenance; unknown is always weak, agent never strong (Claude logs)", async () => {
  const s = new SessionBuilder("sess-all-kinds", { version: "2.1.250" });
  s.prompt("one"); s.response([text("a")], { model: "claude-sonnet-5", effort: "low" });
  s.version = "2.1.251";
  s.prompt("two", { permissionMode: "plan" }); s.response([text("b")], { model: "claude-opus-5", effort: "high" });
  const r = await parseSession(s);
  assert.deepEqual(r.events.map((e) => e.kind).sort(), ["effort", "mode", "model", "version"]);
  for (const e of r.events) {
    assert.ok(e.strength && e.provenance, `${e.kind}: strength/provenance missing`);
    if (e.side === "unknown") assert.equal(e.strength, "weak", e.kind);
    if (e.side === "agent") assert.equal(e.strength, "routine", e.kind);
    if (e.side === "you") assert.equal(e.strength, "strong", e.kind);
  }
});
