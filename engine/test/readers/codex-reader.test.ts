import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_PARSER_VERSIONS, codexReader, codexRoot } from "../../src/readers/codex.js";
import { entrypointOf } from "../../src/readers/codex/rollout.js";
import { cleanLabel } from "../../src/util.js";
import { Rollout, emptyRoot, testCtx, uuid, writeTree } from "../fixtures/codex/build.js";
import { scan } from "../fixtures/codex/harness.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

test("codexRoot: WASITME_CODEX_DIR, then CODEX_HOME, then ~/.codex (resolved at call time)", () => {
  const a = emptyRoot(), b = emptyRoot();
  withEnv({ WASITME_CODEX_DIR: a, CODEX_HOME: b }, () => { assert.equal(codexRoot(), a); assert.equal(codexReader.root(), a); });
  withEnv({ WASITME_CODEX_DIR: undefined, CODEX_HOME: b }, () => assert.equal(codexRoot(), b));
  // Only the string is checked here — nothing under the real home directory is listed or read.
  withEnv({ WASITME_CODEX_DIR: undefined, CODEX_HOME: undefined }, () => assert.equal(codexRoot(), join(homedir(), ".codex")));
});

test("list: rollout files under sessions/ and archived_sessions/ only, keyed by basename", () => {
  const id = uuid(31);
  const { root, paths } = writeTree([{ id, content: new Rollout("2026-09-01T00:00:00Z").meta({ id }).text() }]);
  mkdirSync(join(root, "sessions", "2026", "09", "02"), { recursive: true });
  writeFileSync(join(root, "sessions", "2026", "09", "02", "notes.jsonl"), "{}\n");
  writeFileSync(join(root, "history.jsonl"), "{}\n");
  writeFileSync(join(root, "rollout-stray.jsonl"), "{}\n");
  withEnv({ WASITME_CODEX_DIR: root }, () => {
    const sources = codexReader.list();
    assert.equal(sources.length, 1);
    const [s] = sources;
    assert.equal(s!.agent, "codex");
    assert.equal(s!.key, `codex:rollout-2026-09-01T10-00-00-${id}.jsonl`);
    assert.equal(s!.files.length, 1);
    assert.equal(s!.files[0]!.path, paths.get(id));
    assert.ok(s!.files[0]!.size > 0);
  });
  withEnv({ WASITME_CODEX_DIR: emptyRoot() }, () => assert.deepEqual(codexReader.list(), []));
  withEnv({ WASITME_CODEX_DIR: join(emptyRoot(), "missing") }, () => assert.deepEqual(codexReader.list(), []));
});

test("parse: a file deleted after listing is a failed file, not a crash", async () => {
  const id = uuid(32);
  const { root, paths } = writeTree([{ id, content: new Rollout("2026-09-01T00:00:00Z").meta({ id }).text() }]);
  let sources: ReturnType<typeof codexReader.list> = [];
  withEnv({ WASITME_CODEX_DIR: root }, () => { sources = codexReader.list(); });
  rmSync(paths.get(id)!);
  const r = await codexReader.parse(sources[0]!, testCtx());
  assert.deepEqual(r.exchanges, []);
  assert.equal(r.stats.files, 1);
  assert.equal(r.stats.filesFailed, 1);
});

test("parse stats: bad lines, truncated tail, bad timestamps and unknown types are surfaced", async () => {
  const id = uuid(33);
  const t = uuid(331);
  const content = new Rollout("2026-09-01T10:00:00Z").meta({ id })
    .started(t).ctx(t).user(t, "do the thing")
    .rawLine("{not json")
    .rec("mystery_record", { x: 1 })
    .event("brand_new_event", {})
    .item(t, { type: "FancyItem" })
    .rec("../etc/passwd x", {})
    .rec("event_msg", { type: "agent_message", message: "hi" }, { timestamp: "2019-01-01T00:00:00Z" })
    .cmd(t).complete(t)
    .text() + '{"timestamp":"2026-09-01T10:00:09Z","type":"event_msg","payload":{"type":"tas';
  const { root } = writeTree([{ id, content }]);
  const { exchanges, stats } = await scan(root);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0]!.toolCalls, 1);
  assert.equal(stats.badLines, 1);
  assert.equal(stats.truncatedTail, 1);
  assert.equal(stats.badTimestamps, 1);
  assert.deepEqual(stats.unknownTypes, {
    "codex:mystery_record": 1, "codex:event_msg:brand_new_event": 1, "codex:item:FancyItem": 1, "codex:unrecognised": 1,
  });
  for (const k of Object.keys(stats.unknownTypes)) assert.equal(cleanLabel(k), k);
});

test("privacy: no prompt, output, path, cwd, instruction or id text reaches the result", async () => {
  const id = uuid(34);
  const t = uuid(341);
  const S = ["SENTINEL_PROMPT", "SENTINEL_CWD", "SENTINEL_STDOUT", "SENTINEL_CMD", "SENTINEL_FILE", "SENTINEL_BASE", "SENTINEL_TOOL", "SENTINEL_TYPE", "SENTINEL_MODEL", "SENTINEL_ORIG", "SENTINEL_SRC"];
  const content = new Rollout("2026-09-01T10:00:00Z")
    .meta({ id, cwd: "/Users/SENTINEL_CWD/private", baseInstructions: "SENTINEL_BASE instructions", dynamicTools: [{ name: "SENTINEL_TOOL" }], originator: "Codex\u001b[31m SENTINEL_ORIG", source: "vscode\u001b[31m SENTINEL_SRC" })
    .started(t).ctx(t, { model: "gpt <b>SENTINEL_MODEL</b>" })
    .user(t, "SENTINEL_PROMPT please fix /Users/SENTINEL_FILE/a.ts")
    .cmd(t, { command: "cat SENTINEL_CMD", stdout: "SENTINEL_STDOUT", parsed: [{ type: "read", path: "/Users/SENTINEL_FILE/a.ts" }] })
    .fileChange(t, { "/Users/SENTINEL_FILE/a.ts": "update" })
    .rec("/Users/SENTINEL_TYPE/x", {})
    .usage(t, "r", { input: 1, output: 1 }).complete(t)
    .text();
  const { root } = writeTree([{ id, content }]);
  let sources: ReturnType<typeof codexReader.list> = [];
  withEnv({ WASITME_CODEX_DIR: root }, () => { sources = codexReader.list(); });
  const r = await codexReader.parse(sources[0]!, testCtx());
  const out = JSON.stringify(r);
  for (const s of S) assert.ok(!out.includes(s), `${s} leaked`);
  assert.ok(!out.includes(id), "raw thread id leaked");
  assert.ok(!out.includes(t), "raw turn id leaked");
  assert.ok(!out.includes("/Users"), "path leaked");
  assert.equal(r.exchanges.length, 1);
  assert.equal(r.exchanges[0]!.model, "other");
  assert.equal(r.exchanges[0]!.entrypoint, "other", "a source outside the fixed enum is \"other\"");
  for (const k of Object.keys(r.stats.unknownTypes)) assert.equal(cleanLabel(k), k);
});

test("entrypoint: session_meta.source mapped to a fixed enum; the originator never becomes one", () => {
  for (const v of ["cli", "vscode", "exec", "mcp"]) assert.equal(entrypointOf(v), v);
  assert.equal(entrypointOf("VSCode"), "vscode");
  assert.equal(entrypointOf({ subagent: { thread_spawn: { parent_thread_id: "x", depth: 1 } } }), "subagent");
  assert.equal(entrypointOf({ something_new: {} }), "other");
  for (const v of [undefined, null, ""]) assert.equal(entrypointOf(v), "unknown");
  assert.equal(entrypointOf("unknown"), "unknown");
  for (const v of ["Codex Desktop", "codex_exec", "codex-tui", "/Users/x/bin"]) assert.equal(entrypointOf(v), "other");
});

test("per-family parser versions are exported for re-derivation, in the snapshot's parserVersions shape", () => {
  const keys = Object.keys(CODEX_PARSER_VERSIONS);
  // Aligned with the Claude reader's family names at WP-12 (one health.parserVersions map speaks for both).
  assert.deepEqual(keys, ["exchanges", "toolErrors", "research", "friction", "context", "labels", "interactive", "events"]);
  for (const k of keys) assert.match(k, /^[A-Za-z][A-Za-z0-9]{0,31}$/);
  for (const v of Object.values(CODEX_PARSER_VERSIONS)) assert.ok(Number.isInteger(v) && v >= 1);
  assert.ok(Object.isFrozen(CODEX_PARSER_VERSIONS));
});
