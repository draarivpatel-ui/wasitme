// root() / list(): which files form a Source. Black-box against engine/src/types.ts (Reader, Source, FileStamp).
import { CLAUDE_HOME, PROJECTS_DIR, findSource, mainPath, real } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIRECT, AGENT_NESTED, SCENARIOS, type ScenarioName } from "../fixtures/acceptance/claude/build-fixtures.js";
import { claudeReader } from "../../src/readers/claude.js";

const ALL = Object.keys(SCENARIOS) as ScenarioName[];
const NON_EMPTY = ALL.filter((n) => n !== "empty");
const subDir = join(PROJECTS_DIR, SCENARIOS.subagents.project, SCENARIOS.subagents.session, "subagents");

test("reader identifies as claude-code and root() is $WASITME_CLAUDE_DIR/projects", () => {
  assert.equal(claudeReader.agent, "claude-code");
  // If this fails, every other acceptance test will see 0 sources: the env var points at the ~/.claude equivalent.
  assert.equal(real(claudeReader.root()), real(PROJECTS_DIR));
});

test("list() returns every non-empty session file as its own claude-code source, with unique keys", () => {
  const sources = claudeReader.list();
  for (const s of sources) assert.equal(s.agent, "claude-code");
  for (const n of NON_EMPTY) findSource(sources, n); // asserts exactly one source per main file
  assert.equal(new Set(sources.map((s) => s.key)).size, sources.length, "source keys must be unique");
});

test("list() returns nothing beyond the 15 main session files (empty file optional)", () => {
  const sources = claudeReader.list();
  const mains = new Set(ALL.map((n) => real(mainPath(n))));
  for (const s of sources) {
    assert.ok(s.files.some((f) => mains.has(real(f.path))), `unexpected source ${s.key}: ${s.files.map((f) => f.path).join(", ")}`);
  }
  assert.ok(sources.length === 14 || sources.length === 15, `expected 14 or 15 sources, got ${sources.length}`);
});

test("#14 subagent transcripts (direct and nested workflows/*/agent-*.jsonl) belong to their session's source; decoys do not", () => {
  const src = findSource(claudeReader.list(), "subagents");
  const got = src.files.map((f) => real(f.path)).sort();
  const want = [
    mainPath("subagents"),
    join(subDir, `agent-${AGENT_DIRECT}.jsonl`),
    join(subDir, "workflows", "wf-7", `agent-${AGENT_NESTED}.jsonl`),
  ].map(real).sort();
  // journal.jsonl (workflow journal), notes.txt and tool-results/*.txt are not transcripts.
  assert.deepEqual(got, want);
});

test("sources without subagents contain exactly their main file", () => {
  const sources = claudeReader.list();
  for (const n of NON_EMPTY.filter((x) => x !== "subagents")) {
    const s = findSource(sources, n);
    assert.deepEqual(s.files.map((f) => real(f.path)), [real(mainPath(n))], n);
  }
});

test("files outside projects/<project>/ (e.g. ~/.claude/history.jsonl) are never listed", () => {
  const history = real(join(CLAUDE_HOME, "history.jsonl"));
  const sources = claudeReader.list();
  assert.ok(sources.length > 0, "nothing listed");
  for (const s of sources) assert.ok(!s.files.some((f) => real(f.path) === history));
});

test("FileStamps match the files on disk", () => {
  const sources = claudeReader.list();
  assert.ok(sources.length > 0, "nothing listed");
  for (const s of sources) {
    for (const f of s.files) {
      const st = statSync(f.path);
      assert.equal(f.size, st.size, f.path);
      assert.ok(Number.isFinite(f.mtimeMs) && Math.abs(f.mtimeMs - st.mtimeMs) < 1000, f.path);
    }
  }
});
