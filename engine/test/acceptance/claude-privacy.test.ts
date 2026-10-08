// Privacy: nothing from inside a session file except allow-listed labels, counts and timestamps may reach the
// reader's output. Checked on JSON.stringify(ParseResult) for every fixture — exchanges, events AND stats.
import { FIXTURE_DIR, findSource, fixtureRecords, parseScenario } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SCENARIOS, SENTINELS, type ScenarioName } from "../fixtures/acceptance/claude/build-fixtures.js";
import type { ParseResult, Source } from "../../src/types.js";
import { cleanLabel } from "../../src/util.js";
import { claudeReader } from "../../src/readers/claude.js";

/** Keys whose values are enums/labels/timestamps that may legitimately appear in output. */
const LABEL_KEYS = new Set([
  "type", "subtype", "role", "version", "model", "effort", "permissionMode", "entrypoint", "userType", "stop_reason",
  "timestamp", "kind", "promptSource", "toolDenialKind", "level", "operation", "service_tier", "media_type", "name",
  "trigger", "status", "mode",
]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MIN_LEN = 12;

/**
 * Every content-bearing string in the fixture records: prompt/response/thinking text, tool inputs and outputs,
 * paths, titles, summaries, attachment bodies, signatures, and every identifier (uuid, sessionId, requestId,
 * message.id, tool_use ids, agentId, promptId, leafUuid…). Also object keys that are not clean labels (e.g. paths).
 */
function sensitiveStrings(files: string[]): Set<string> {
  const out = new Set<string>();
  const labels = new Set<string>();
  const walk = (v: unknown, key: string | undefined): void => {
    if (typeof v === "string") {
      if (key && LABEL_KEYS.has(key)) { if (cleanLabel(v)) labels.add(v); return; }
      if (v.length >= MIN_LEN && !ISO.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k.length >= MIN_LEN && !cleanLabel(k)) out.add(k);
        walk(x, k);
      }
    }
  };
  for (const f of files) for (const r of fixtureRecords(f)) walk(r, undefined);
  for (const l of labels) out.delete(l); // e.g. a model id that also appears inside an attachment body
  return out;
}

function listed(sources: Source[]): [ScenarioName, Source][] {
  const out: [ScenarioName, Source][] = [];
  for (const n of Object.keys(SCENARIOS) as ScenarioName[]) {
    try { out.push([n, findSource(sources, n)]); } catch { if (n !== "empty") throw new Error(`${n} not listed`); }
  }
  return out;
}

function leaks(json: string, needle: string): boolean {
  return json.includes(needle) || json.includes(JSON.stringify(needle).slice(1, -1));
}

async function each(fn: (name: ScenarioName, json: string, src: Source, r: ParseResult) => void): Promise<void> {
  for (const [name, src] of listed(claudeReader.list())) {
    const r = await parseScenario(claudeReader, name);
    fn(name, JSON.stringify(r), src, r);
  }
}

test("no sentinel (secret key, user path, project name, branch, slug) appears in any output", async () => {
  await each((name, json) => {
    for (const s of SENTINELS) assert.ok(!json.includes(s), `${name}: output contains sentinel ${JSON.stringify(s)}`);
  });
});

test("no prompt/response/thinking text, tool input/output, attachment body or raw identifier from the logs appears in any output", async () => {
  await each((name, json, src) => {
    const found = [...sensitiveStrings(src.files.map((f) => f.path))].filter((s) => leaks(json, s));
    assert.deepEqual(found.map((s) => s.slice(0, 80)), [], `${name}: leaked strings`);
  });
});

test("no file paths, encoded project folder names, control characters or markup reach the output", async () => {
  await each((name, json, _src, r) => {
    for (const bad of [FIXTURE_DIR, "home/projects", "/Users/", "\u001b", "\\u001b", "<b>", "<command-", "m".repeat(61)]) {
      assert.ok(!json.includes(bad), `${name}: output contains ${JSON.stringify(bad)}`);
    }
    for (const k of Object.keys(r.stats.unknownTypes)) {
      assert.ok(!k.includes("/") && k.length <= 60, `${name}: unknownTypes key ${JSON.stringify(k)} is not sanitised`);
    }
  });
});

test("sanity: the sensitive-string collector really covers ids, text and tool payloads", () => {
  const s = sensitiveStrings([join(FIXTURE_DIR, "home", "projects", SCENARIOS.basic.project, `${SCENARIOS.basic.session}.jsonl`)]);
  for (const must of [SCENARIOS.basic.session, "e0000001-0000-4000-8000-000000000001", "req_011CBAS0001", "msg_01BAS0001", "toolu_01BAS0001", "Tests: 12 passed, 12 total", "Now add a unit test for the signup validation"]) {
    assert.ok(s.has(must), `collector misses ${must}`);
  }
  assert.ok(!s.has("claude-opus-5-5") && !s.has("claude-desktop"), "labels must be allowed");
});
