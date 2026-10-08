// Contract shape, checked on every exchange/event/stats object the reader returns for every fixture.
import { EXCHANGE_KEYS, HASH_ID, NOW, bySeq, findSource, parseScenario } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, type ScenarioName } from "../fixtures/acceptance/claude/build-fixtures.js";
import type { ChangeKind, ParseResult, Source } from "../../src/types.js";
import { cleanLabel } from "../../src/util.js";
import { claudeReader } from "../../src/readers/claude.js";

const ALL = Object.keys(SCENARIOS) as ScenarioName[]; // resumeA is parsed before resumeB
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MIN = Date.parse("2020-01-01T00:00:00Z");
const MAX = NOW.getTime() + 86_400_000;
const COUNT_FIELDS = [
  "seq", "promptChars", "queuedMidTurn", "steps", "toolCalls", "toolErrors", "rejections", "blocked", "reads", "edits",
  "blindEdits", "outTok", "inTok", "cacheRead", "cacheWrite", "apiErrors", "apiRetries", "compactions", "thinkBlocks",
  "thinkRedacted", "subToolCalls", "subTokens", "subReads", "subEdits", "subBlindEdits", "durationMs",
] as const;
const FLAG_FIELDS = ["humanPrompt", "interrupted", "pushback", "churned"] as const;
const LABEL_FIELDS = ["version", "model", "servedModel", "effort", "mode", "entrypoint"] as const;
const KINDS: ChangeKind[] = ["version", "model", "served-model", "effort", "mode", "entrypoint", "config", "instructions", "mcp", "skills", "plugins", "hooks", "system-prompt"];
const EVENT_KEYS = new Set(["id", "t", "day", "agent", "kind", "side", "from", "to", "evidence", "strength", "provenance", "userInitiated", "note"]);

/** Parse every scenario (the empty session file only if the reader lists it — that is optional). */
async function all(): Promise<Map<ScenarioName, ParseResult>> {
  const sources = claudeReader.list();
  const out = new Map<ScenarioName, ParseResult>();
  for (const n of ALL) {
    if (n === "empty" && !isListed(sources, n)) continue;
    out.set(n, await parseScenario(claudeReader, n));
  }
  return out;
}

function isListed(sources: Source[], n: ScenarioName): boolean {
  try { findSource(sources, n); return true; } catch { return false; }
}

function isLabel(v: unknown): boolean {
  return typeof v === "string" && (v === "unknown" || v === "other" || cleanLabel(v) === v);
}

test("every exchange has exactly the contract's fields with valid types and ranges", async () => {
  for (const [name, r] of await all()) {
    for (const x of r.exchanges) {
      const at = `${name} seq ${x.seq}`;
      assert.deepEqual(Object.keys(x).sort(), [...EXCHANGE_KEYS].sort(), `${at}: field set`);
      assert.equal(x.v, 1, at);
      assert.equal(x.agent, "claude-code", at);
      for (const k of ["id", "session", "project"] as const) assert.match(x[k], HASH_ID, `${at}.${k}`);
      assert.match(x.t, ISO_MS, `${at}.t`);
      const ms = Date.parse(x.t);
      assert.ok(ms >= MIN && ms <= MAX, `${at}.t out of range`);
      assert.equal(x.day, x.t.slice(0, 10), `${at}.day (ctx.timeZone = UTC)`);
      for (const k of LABEL_FIELDS) assert.ok(isLabel(x[k]), `${at}.${k} = ${JSON.stringify(x[k])} is not a clean label`);
      for (const k of COUNT_FIELDS) assert.ok(Number.isInteger(x[k]) && (x[k] ?? -1) >= 0, `${at}.${k} = ${x[k]}`);
      for (const k of FLAG_FIELDS) assert.ok(x[k] === 0 || x[k] === 1, `${at}.${k} = ${x[k]}`);
      assert.equal(typeof x.afterCompaction, "boolean", `${at}.afterCompaction`);
      assert.ok(Number.isFinite(x.thinkSigMedian) && x.thinkSigMedian >= 0, `${at}.thinkSigMedian`);
    }
  }
});

test("exchange invariants: sub-counts never exceed their totals; agent-initiated exchanges have no prompt length", async () => {
  for (const [name, r] of await all()) {
    for (const x of r.exchanges) {
      const at = `${name} seq ${x.seq}`;
      assert.ok(x.reads + x.edits <= x.toolCalls, `${at}: reads+edits > toolCalls`);
      assert.ok(x.blindEdits <= x.edits, `${at}: blindEdits > edits`);
      assert.ok(x.toolErrors + x.rejections + x.blocked <= x.toolCalls, `${at}: outcomes > toolCalls`);
      assert.ok(x.thinkRedacted <= x.thinkBlocks, `${at}: thinkRedacted > thinkBlocks`);
      if (x.thinkBlocks === 0) assert.equal(x.thinkSigMedian, 0, `${at}: thinkSigMedian without thinking`);
      if (x.humanPrompt === 0) assert.equal(x.promptChars, 0, `${at}: promptChars on agent-initiated exchange`);
    }
  }
});

test("seq is 0..n-1 in file order within each session; one session id per source; ids unique", async () => {
  const sessions = new Map<string, ScenarioName>();
  const ids = new Set<string>();
  for (const [name, r] of await all()) {
    const xs = bySeq(r);
    if (name !== "resumeB") assert.deepEqual(xs.map((x) => x.seq), xs.map((_, i) => i), `${name}: seq`);
    else assert.equal(new Set(xs.map((x) => x.seq)).size, xs.length, `${name}: seq unique`);
    for (let i = 1; i < xs.length; i++) {
      if (name !== "clock") assert.ok(xs[i - 1]!.t <= xs[i]!.t, `${name}: seq order should follow file order`);
    }
    const sess = new Set(xs.map((x) => x.session));
    assert.ok(sess.size <= 1, `${name}: one session id per source`);
    for (const s of sess) {
      assert.ok(!sessions.has(s), `${name} and ${sessions.get(s)} share a session id`);
      sessions.set(s, name);
    }
    for (const x of xs) {
      assert.ok(!ids.has(x.id), `${name}: duplicate exchange id`);
      ids.add(x.id);
    }
  }
});

test("project id is shared by sessions in the same project folder and differs across folders", async () => {
  const results = await all();
  const projectOf = (n: ScenarioName) => {
    const xs = results.get(n)?.exchanges ?? [];
    assert.ok(xs.length > 0, `${n} has exchanges`);
    return xs[0]!.project;
  };
  assert.equal(projectOf("basic"), projectOf("filters"));
  assert.equal(projectOf("resumeA"), projectOf("resumeB"));
  assert.equal(projectOf("unicode"), projectOf("clock"));
  assert.equal(projectOf("labels"), projectOf("labelsDirty"));
  const folders: ScenarioName[] = ["basic", "modern", "tools", "usage", "subagents", "resumeA", "unicode", "labels"];
  assert.equal(new Set(folders.map(projectOf)).size, folders.length);
});

test("stats are well-formed: one file count per source file, no failures, non-negative counters", async () => {
  const sources = claudeReader.list();
  for (const [name, r] of await all()) {
    const s = r.stats;
    assert.equal(s.files, findSource(sources, name).files.length, `${name}.stats.files`);
    assert.equal(s.filesFailed, 0, `${name}.stats.filesFailed`);
    for (const k of ["badLines", "truncatedTail", "duplicates", "badTimestamps"] as const) {
      assert.ok(Number.isInteger(s[k]) && s[k] >= 0, `${name}.stats.${k}`);
    }
    for (const [k, v] of Object.entries(s.unknownTypes)) assert.ok(Number.isInteger(v) && v > 0, `${name}.unknownTypes[${k}]`);
  }
});

test("events are well-formed ChangeEvents from logs", async () => {
  for (const [name, r] of await all()) {
    for (const e of r.events) {
      const at = `${name} event ${e.kind}`;
      for (const k of Object.keys(e)) assert.ok(EVENT_KEYS.has(k), `${at}: unexpected field ${k}`);
      assert.match(e.id, HASH_ID, `${at}.id`);
      assert.match(e.t, ISO_MS, `${at}.t`);
      assert.equal(e.day, e.t.slice(0, 10), `${at}.day`);
      assert.equal(e.agent, "claude-code", at);
      assert.ok(KINDS.includes(e.kind), `${at}: kind`);
      assert.ok(["you", "agent", "unknown", "meta"].includes(e.side), `${at}: side`);
      assert.equal(e.evidence, "log", at);
      for (const k of ["from", "to"] as const) {
        assert.ok(isLabel(e[k]) || /^h:[0-9a-f]{8}$/.test(e[k]), `${at}.${k} = ${JSON.stringify(e[k])}`);
      }
      if (e.userInitiated !== undefined) assert.equal(typeof e.userInitiated, "boolean", at);
      if (e.note !== undefined) assert.equal(typeof e.note, "string", at);
    }
  }
});
