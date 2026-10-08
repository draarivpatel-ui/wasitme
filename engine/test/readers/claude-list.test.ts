import assert from "node:assert/strict";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeReader, claudeRoot } from "../../src/readers/claude.js";
import { classify, creationOrder } from "../../src/readers/claude/list.js";
import { projectMains } from "../../src/readers/claude/project.js";
import { makeRoot, pause, projectPath, SessionBuilder, text, withRoot, writeJsonl, writeSession } from "../fixtures/claude/builder.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("root: WASITME_CLAUDE_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude; empty values are unset", () => {
  withEnv({ WASITME_CLAUDE_DIR: "/tmp/wasitme-a", CLAUDE_CONFIG_DIR: "/tmp/wasitme-b" }, () => {
    assert.equal(claudeRoot(), "/tmp/wasitme-a");
    assert.equal(claudeReader.root(), join("/tmp/wasitme-a", "projects"));
  });
  withEnv({ WASITME_CLAUDE_DIR: undefined, CLAUDE_CONFIG_DIR: "/tmp/wasitme-b" }, () => assert.equal(claudeRoot(), "/tmp/wasitme-b"));
  withEnv({ WASITME_CLAUDE_DIR: "", CLAUDE_CONFIG_DIR: "  " }, () => assert.equal(claudeRoot(), join(homedir(), ".claude")));
  assert.equal(claudeReader.agent, "claude-code");
});

test("list: one source per session with its subagent transcripts (incl. workflow runs); journals, meta and other files skipped", async () => {
  const root = makeRoot();
  const proj = projectPath(root, "-synthetic-proj");
  const s = new SessionBuilder("sess-1");
  s.prompt("hi"); s.response([text("hello")]);
  writeSession(root, "-synthetic-proj", s);
  const sub = join(proj, "sess-1", "subagents");
  writeJsonl(join(sub, "agent-b2.jsonl"), [{ type: "user" }]);
  writeJsonl(join(sub, "agent-a1.jsonl"), [{ type: "user" }]);
  writeFileSync(join(sub, "agent-a1.meta.json"), "{}");
  writeJsonl(join(sub, "workflows", "run-9", "agent-w1.jsonl"), [{ type: "user" }]);
  writeJsonl(join(sub, "workflows", "run-9", "journal.jsonl"), [{ type: "started" }]);
  writeFileSync(join(sub, "workflows", "run-9.json"), "{}");
  mkdirSync(join(proj, "sess-1", "tool-results"), { recursive: true });
  writeFileSync(join(proj, "sess-1", "tool-results", "x.txt"), "synthetic");
  writeFileSync(join(proj, "notes.md"), "not a session");
  writeFileSync(join(root, "projects", "stray.jsonl"), "{}\n"); // file directly under projects/: not a project
  // A symlinked project directory is never followed.
  const outside = makeRoot();
  writeSession(outside, "-elsewhere", new SessionBuilder("sess-out"));
  symlinkSync(join(outside, "projects", "-elsewhere"), join(root, "projects", "-linked"));

  const list = await withRoot(root, () => claudeReader.list());
  assert.equal(list.length, 1);
  const src = list[0]!;
  assert.equal(src.agent, "claude-code");
  assert.equal(src.key, "-synthetic-proj/sess-1.jsonl");
  const rel = src.files.map((f) => f.path.slice(proj.length + 1));
  assert.deepEqual(rel, [
    "sess-1.jsonl",
    join("sess-1", "subagents", "agent-a1.jsonl"),
    join("sess-1", "subagents", "agent-b2.jsonl"),
    join("sess-1", "subagents", "workflows", "run-9", "agent-w1.jsonl"),
  ]);
  for (const f of src.files) {
    assert.ok(f.size > 0);
    assert.ok(Number.isInteger(f.mtimeMs));
  }
  const parts = classify(src.files)!;
  assert.equal(parts.main.path, join(proj, "sess-1.jsonl"));
  assert.equal(parts.subagents.length, 3);
});

test("list: missing root or projects dir yields no sources (no throw)", async () => {
  const root = makeRoot();
  assert.deepEqual(await withRoot(join(root, "does-not-exist"), () => claudeReader.list()), []);
  assert.deepEqual(await withRoot(root, () => claudeReader.list()), []);
});

test("sibling sessions: each source holds only its own transcript, stamped from the file on disk", async () => {
  const root = makeRoot();
  const dir = projectPath(root, "-p");
  for (const id of ["sess-c", "sess-a", "sess-b"]) {
    const s = new SessionBuilder(id);
    s.prompt(`prompt in ${id}`);
    if (id === "sess-a") s.response([text("a longer session, so sizes differ")]);
    writeSession(root, "-p", s);
    await pause();
  }
  // Creation order still feeds resume dedupe inside parse(); it is not part of any Source.
  assert.deepEqual(projectMains(dir).map((m) => m.name), ["sess-c.jsonl", "sess-a.jsonl", "sess-b.jsonl"], "creation order");
  const list = await withRoot(root, () => claudeReader.list());
  assert.deepEqual(list.map((s) => s.key), ["-p/sess-a.jsonl", "-p/sess-b.jsonl", "-p/sess-c.jsonl"], "sources sorted by name");
  for (const s of list) {
    const name = s.key.slice("-p/".length);
    const st = statSync(join(dir, name));
    assert.deepEqual(s.files, [{ path: join(dir, name), mtimeMs: Math.round(st.mtimeMs), size: st.size }], s.key);
  }
});

test("creationOrder: by birth time, ties broken by name", () => {
  const order = creationOrder([
    { name: "b", born: 5 }, { name: "a", born: 5 }, { name: "z", born: 1 },
  ]);
  assert.deepEqual(order.map((f) => f.name), ["z", "a", "b"]);
});

test("classify: roles come from path structure only", () => {
  const p = "/r/projects/-p";
  const files = [
    { path: `${p}/s1.jsonl`, mtimeMs: 1, size: 1 },
    { path: `${p}/s1/subagents/agent-x.jsonl`, mtimeMs: 1, size: 1 },
    { path: `${p}/s1/subagents/workflows/w/agent-y.jsonl`, mtimeMs: 1, size: 1 },
    { path: p, mtimeMs: 7, size: 9 }, // a directory (not a role this reader lists): ignored
    { path: `${p}/s0.jsonl`, mtimeMs: 1, size: 1 }, // a sibling transcript stamp: ignored
    { path: `${p}/s0/subagents/agent-z.jsonl`, mtimeMs: 1, size: 1 }, // another session's subagent: ignored
    { path: `/r/projects/-q/s9.jsonl`, mtimeMs: 1, size: 1 }, // another project: ignored
  ];
  const c = classify(files)!;
  assert.deepEqual(Object.keys(c).sort(), ["main", "subagents"]);
  assert.equal(c.main.path, `${p}/s1.jsonl`);
  assert.deepEqual(c.subagents.map((f) => f.path), [`${p}/s1/subagents/agent-x.jsonl`, `${p}/s1/subagents/workflows/w/agent-y.jsonl`]);
  assert.deepEqual(classify(files.slice(0, 3)), c);
  assert.equal(classify([]), undefined);
});

test("parse of a source whose main file vanished reports filesFailed instead of throwing", async () => {
  const root = makeRoot();
  const r = await claudeReader.parse(
    { agent: "claude-code", key: "-p/gone.jsonl", files: [{ path: join(root, "projects", "-p", "gone.jsonl"), mtimeMs: 1, size: 1 }] },
    { hash: (v, p) => p + v.length, now: new Date("2026-10-04T00:00:00Z"), timeZone: "UTC" },
  );
  assert.deepEqual(r.exchanges, []);
  assert.equal(r.stats.files, 1);
  assert.equal(r.stats.filesFailed, 1);
});
