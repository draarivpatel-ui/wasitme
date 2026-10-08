// WP-10Δ reader deltas: tool-error split, per-field label shapes, parser versions, tool-results never listed,
// log-keyed maps safe against prototype-colliding keys. 100% synthetic records (fixtures/claude/builder.ts).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLAUDE_FIELD_FAMILY, CLAUDE_PARSER_VERSIONS, claudeReader } from "../../src/readers/claude.js";
import { effortLabel, entrypointLabel, modelLabel, modeLabel, OTHER, versionLabel } from "../../src/readers/claude/labels.js";
import {
  makeRoot, parseSession, pause, projectPath, scan, SessionBuilder, text, toolUseBlock, withRoot, writeJsonl, writeSession,
} from "../fixtures/claude/builder.js";

const split = (x: { toolCalls: number; toolErrors: number; toolErrorsEdit?: number; toolErrorsCmd?: number; rejections: number; blocked: number; interrupted: number }) => ({
  toolCalls: x.toolCalls, toolErrors: x.toolErrors, toolErrorsEdit: x.toolErrorsEdit, toolErrorsCmd: x.toolErrorsCmd,
  rejections: x.rejections, blocked: x.blocked, interrupted: x.interrupted,
});

test("tool-error split: command failures vs edit/apply and other non-command failures; edit + cmd = toolErrors", async () => {
  const s = new SessionBuilder("sess-split");
  s.prompt("run the tests and fix them");
  const call = (id: string, name: string, result: { isError?: boolean; content?: string; denial?: string }) => {
    s.response([toolUseBlock(id, name, { command: "synthetic" })]);
    s.toolResult(id, result);
  };
  call("b1", "Bash", { isError: true, content: "Exit code 1\nsynthetic failing test" }); // cmd: non-zero exit
  call("b2", "Bash", { isError: true, content: "Command timed out after 2m 0.0s" }); // cmd: it ran, it didn't finish
  call("b3", "Bash", { isError: true, content: "<tool_use_error>InputValidationError: synthetic missing parameter</tool_use_error>" }); // edit: refused before running
  call("p1", "PowerShell", { isError: true, content: "Exit code 2" }); // cmd
  call("e1", "Edit", { isError: true, content: "<tool_use_error>String to replace not found in file.</tool_use_error>" }); // edit
  call("w1", "Write", { isError: true, content: "<tool_use_error>File has not been read yet.</tool_use_error>" }); // edit
  call("m1", "mcp__synthetic__query", { isError: true, content: "synthetic MCP failure" }); // edit: non-command
  call("a1", "Agent", { isError: true, content: "synthetic subagent failure" }); // edit: non-command
  call("ok", "Bash", { content: "synthetic listing" }); // not an error
  // Never tool errors on either side: a user rejection, an auto-mode block, a tool cancelled by an interrupt.
  call("r1", "Bash", { isError: true, denial: "user-rejected", content: "synthetic rejection" });
  call("k1", "Bash", { isError: true, denial: "automode-blocked", content: "synthetic block" });
  call("c1", "Bash", { isError: true, content: "The user doesn't want to take this action right now. STOP what you are doing" });
  // Results whose tool_use was never logged: the text decides.
  s.toolResult("ghost-1", { isError: true, content: "Exit code 127" }); // cmd
  s.toolResult("ghost-2", { isError: true, content: "synthetic failure" }); // edit
  const [x] = (await parseSession(s)).exchanges;
  assert.deepEqual(split(x!), { toolCalls: 12, toolErrors: 10, toolErrorsEdit: 6, toolErrorsCmd: 4, rejections: 1, blocked: 1, interrupted: 1 });
});

test("tool-error split survives resume: a Bash tool_use replayed from the earlier session still splits as a command", async () => {
  const root = makeRoot();
  const P = "-synthetic-split-resume";
  const a = new SessionBuilder("sess-sa");
  a.prompt("build it");
  a.response([toolUseBlock("rb1", "Bash", { command: "make" })]);
  writeSession(root, P, a); // the session ends before the command finishes
  await pause();
  const b = new SessionBuilder("sess-sb", { start: "2026-09-02T10:00:00.000Z" });
  for (const r of a.records) b.push({ ...r, sessionId: b.id });
  b.toolResult("rb1", { isError: true, content: "Command timed out after 10m 0.0s" }); // no "Exit code": only the tool name says cmd
  writeSession(root, P, b);
  const resumed = (await scan(root)).get(`${P}/sess-sb.jsonl`)!.result;
  assert.equal(resumed.exchanges.length, 1);
  assert.deepEqual(split(resumed.exchanges[0]!), { toolCalls: 0, toolErrors: 1, toolErrorsEdit: 0, toolErrorsCmd: 1, rejections: 0, blocked: 0, interrupted: 0 });
});

test("per-field label shapes: version, model, effort, mode, entrypoint; anything else is 'other'", () => {
  assert.equal(versionLabel("2.1.289"), "2.1.289");
  assert.equal(versionLabel("2.1.290-beta.1"), "2.1.290-beta.1");
  assert.equal(versionLabel(" 2.1.289 "), "2.1.289");
  for (const bad of ["2.1", "v2.1.289", "2.1.289 (desktop)", "2.1.289\u001b[0m", "<b>2.1.289</b>"]) assert.equal(versionLabel(bad), OTHER, bad);
  assert.equal(versionLabel(undefined), undefined);
  assert.equal(versionLabel(""), undefined);

  assert.equal(modelLabel("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(modelLabel("claude-opus-5[1m]"), "claude-opus-5", "context-size suffix dropped");
  assert.equal(modelLabel("us.anthropic.claude-opus-5-5-v1:0"), "us.anthropic.claude-opus-5-5-v1:0");
  assert.equal(modelLabel("claude-opus-5-5@20260101"), "claude-opus-5-5@20260101", "Vertex-style id kept (D52)");
  for (const bad of ["claude-opus-5-5@", "claude@a@b", "Claude-Opus@20260101", "/synthetic/models/m", "~/m", "Claude-Opus", "claude opus", "a".repeat(65), "<synthetic>", "[1m]"]) {
    assert.equal(modelLabel(bad), OTHER, bad);
  }

  for (const ok of ["low", "medium", "high", "max"]) assert.equal(effortLabel(ok), ok);
  for (const bad of ["ultra", "high<b>", "HIGH", "constructor"]) assert.equal(effortLabel(bad), OTHER, bad);
  for (const ok of ["default", "acceptEdits", "plan", "bypassPermissions", "auto"]) assert.equal(modeLabel(ok), ok);
  for (const bad of ["__proto__", "toString", "yolo"]) assert.equal(modeLabel(bad), OTHER, bad);
  for (const ok of ["cli", "claude-desktop", "claude-vscode", "sdk-cli", "sdk-ts", "sdk-py"]) assert.equal(entrypointLabel(ok), ok);
  for (const bad of ["claude-future", "constructor", "/usr/local/bin/claude", "sdk-"]) assert.equal(entrypointLabel(bad), OTHER, bad);
});

test("labels outside their shape are reported as 'other' and never become change events", async () => {
  const s = new SessionBuilder("sess-shapes", { entrypoint: "claude-future" });
  s.prompt("one", { permissionMode: "yolo" });
  s.response([text("a")], { model: "Claude Opus 5.5", effort: "ultra" }); // display name, unknown effort
  s.prompt("two", { permissionMode: "yolo" });
  s.response([text("b")], { model: "claude-opus-5-5", effort: "high" });
  s.prompt("three", { permissionMode: "yolo" });
  s.response([text("c")], { model: "Claude Opus 5.5", effort: "ultra" });
  const r = await parseSession(s);
  assert.deepEqual(r.exchanges.map((x) => [x.model, x.effort, x.mode, x.entrypoint]), [
    [OTHER, OTHER, OTHER, OTHER],
    ["claude-opus-5-5", "high", OTHER, OTHER],
    [OTHER, OTHER, OTHER, OTHER],
  ]);
  assert.deepEqual(r.events, [], "an unrecognisable value is not a named setup change");
});

test("parser versions: per-family integers under snapshot-schema keys; every Exchange field belongs to exactly one family", async () => {
  const families = Object.keys(CLAUDE_PARSER_VERSIONS);
  assert.ok(Object.isFrozen(CLAUDE_PARSER_VERSIONS));
  assert.ok(families.length <= 24, "health.parserVersions holds at most 24 keys");
  for (const [k, v] of Object.entries(CLAUDE_PARSER_VERSIONS)) {
    assert.match(k, /^[A-Za-z][A-Za-z0-9]{0,31}$/);
    assert.ok(Number.isInteger(v) && v >= 1, k);
  }
  for (const k of ["toolErrors", "research", "friction", "events"]) assert.ok(families.includes(k), `golden family ${k}`);
  const s = new SessionBuilder("sess-pv");
  s.prompt("hello"); s.response([text("hi")]);
  const [x] = (await parseSession(s)).exchanges;
  // D51's `provider` is filled only when a Claude log names a backend, and no record does today (WP-12): it is mapped
  // but not emitted. `cmdCalls` and `promptEnglish` are filled since WP-12.
  const pendingD51 = new Set(["provider"]);
  const emitted = Object.keys(x!).sort();
  for (const k of emitted) assert.ok(k in CLAUDE_FIELD_FAMILY, `emitted field ${k} has a family`);
  assert.deepEqual(Object.keys(CLAUDE_FIELD_FAMILY).filter((k) => !emitted.includes(k)).sort(),
    [...pendingD51].filter((k) => !emitted.includes(k)).sort(), "only the pending D51 fields are mapped but not emitted");
  for (const [field, fam] of Object.entries(CLAUDE_FIELD_FAMILY)) assert.ok(families.includes(fam), `${field} → ${fam}`);
});

test("tool-results/ is never listed or read, wherever it sits (session folder, under subagents/, inside a workflow run)", async () => {
  const root = makeRoot();
  const P = "-synthetic-tool-results";
  const proj = projectPath(root, P);
  const s = new SessionBuilder("sess-tr");
  s.prompt("spawn one");
  s.response([toolUseBlock("ag", "Agent", {})]);
  s.toolResult("ag", { toolUseResult: { agentId: "real", status: "completed" } });
  writeSession(root, P, s);
  const sub = new SessionBuilder("real");
  sub.response([text("sub")], { usage: { input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  writeJsonl(join(proj, "sess-tr", "subagents", "agent-real.jsonl"), sub.records);
  const decoy = new SessionBuilder("decoy");
  decoy.response([toolUseBlock("d1", "Bash", {})], { usage: { input_tokens: 0, output_tokens: 99_999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  writeJsonl(join(proj, "sess-tr", "tool-results", "agent-x.jsonl"), decoy.records);
  writeFileSync(join(proj, "sess-tr", "tool-results", "toolu_synthetic.txt"), "synthetic spilled tool output");
  writeJsonl(join(proj, "sess-tr", "subagents", "tool-results", "agent-y.jsonl"), decoy.records);
  writeJsonl(join(proj, "sess-tr", "subagents", "workflows", "run-1", "tool-results", "agent-z.jsonl"), decoy.records);

  const list = await withRoot(root, () => claudeReader.list());
  assert.equal(list.length, 1);
  assert.deepEqual(list[0]!.files.map((f) => f.path.slice(proj.length + 1)), ["sess-tr.jsonl", join("sess-tr", "subagents", "agent-real.jsonl")]);
  const r = (await scan(root)).get(`${P}/sess-tr.jsonl`)!.result;
  assert.equal(r.stats.files, 2);
  assert.deepEqual(r.exchanges.map((x) => [x.subToolCalls, x.subTokens]), [[0, 5]]);
});

test("log-keyed maps: prototype-colliding types, ids, labels and an own __proto__ key are plain data", async () => {
  const root = makeRoot();
  const P = "-synthetic-hostile-keys";
  const T = (sec: number) => `2026-09-01T10:00:${String(sec).padStart(2, "0")}.000Z`;
  const env = `"entrypoint":"cli","version":"2.1.250","sessionId":"sess-hostile"`;
  // Raw JSON lines: a JS object literal with "__proto__" would set a prototype instead of writing the key.
  writeJsonl(join(projectPath(root, P), "sess-hostile.jsonl"), [
    `{"type":"__proto__","uuid":"h-01","timestamp":"${T(1)}"}`,
    `{"type":"constructor","timestamp":"${T(2)}"}`,
    `{"type":"toString"}`,
    `{"type":"hasOwnProperty"}`,
    // A real prompt carrying an own "__proto__" key: still a main-thread prompt, never a sidechain or meta record.
    `{"type":"user","uuid":"__proto__","timestamp":"${T(3)}",${env},"permissionMode":"__proto__","promptSource":"typed","origin":{"kind":"human"},"message":{"role":"user","content":"synthetic hello"},"__proto__":{"isSidechain":true,"isMeta":true,"type":"assistant"}}`,
    `{"type":"assistant","uuid":"constructor","timestamp":"${T(4)}",${env},"requestId":"__proto__","effort":"__proto__","message":{"id":"toString","role":"assistant","model":"constructor","content":[{"type":"tool_use","id":"__proto__","name":"toString","input":{"file_path":"__proto__"}}],"usage":{"input_tokens":1,"output_tokens":2}}}`,
    `{"type":"user","uuid":"valueOf","timestamp":"${T(5)}",${env},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"__proto__","is_error":true,"content":"synthetic failure"}]},"toolUseResult":{"agentId":"__proto__","runId":"constructor"}}`,
    `{"type":"user","uuid":"hasOwnProperty","timestamp":"${T(6)}",${env},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"__proto__","is_error":true,"content":"synthetic repeat"}]}}`,
  ]);
  const sub = new SessionBuilder("__proto__", { start: "2026-09-01T10:00:04.500Z" });
  sub.response([toolUseBlock("constructor", "Read", {})], { usage: { input_tokens: 0, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  writeJsonl(join(projectPath(root, P), "sess-hostile", "subagents", "agent-__proto__.jsonl"), sub.records);

  const r = (await scan(root)).get(`${P}/sess-hostile.jsonl`)!.result;
  assert.equal(Object.getPrototypeOf(r.stats.unknownTypes), Object.prototype);
  for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.ok(Object.hasOwn(r.stats.unknownTypes, k), `unknownTypes.${k} is an own count`);
    assert.equal(r.stats.unknownTypes[k], 1, k);
  }
  assert.equal(({} as Record<string, unknown>).isSidechain, undefined, "no prototype pollution");
  assert.equal(r.stats.duplicates, 1, "the repeated tool_result id is a duplicate");
  assert.equal(r.exchanges.length, 1);
  const x = r.exchanges[0]!;
  assert.deepEqual(
    [x.humanPrompt, x.steps, x.toolCalls, x.toolErrors, x.toolErrorsEdit, x.toolErrorsCmd, x.model, x.effort, x.mode, x.entrypoint, x.interactiveClass, x.subToolCalls, x.subTokens],
    [1, 1, 1, 1, 1, 0, "constructor", OTHER, OTHER, "cli", "interactive", 1, 7],
  );
});
