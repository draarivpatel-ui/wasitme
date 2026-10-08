// Robustness: U+2028 inside strings, damaged/truncated lines, clocks going backward, out-of-range timestamps,
// unknown record types (format drift, research/05 #20), malformed shapes, empty/missing files, determinism.
import { bySeq, expectFields, findSource, makeCtx, oneOf, parseScenario, real } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { KNOWN_IGNORABLE_TYPES, PROMPTS } from "../fixtures/acceptance/claude/build-fixtures.js";
import type { Exchange } from "../../src/types.js";
import { claudeReader } from "../../src/readers/claude.js";

// ------------------------------------------------------------------ U+2028 / U+2029

test("raw U+2028/U+2029 inside JSON strings do not split records (split on \\n only)", async () => {
  const r = await parseScenario(claudeReader, "unicode");
  expectFields(r.stats, { badLines: 0, truncatedTail: 0 }, "unicode stats");
  const xs = bySeq(r);
  assert.equal(xs.length, 2);
  assert.equal(PROMPTS.unicode0.length, 65); // hand-checked: the separators are one UTF-16 unit each
  expectFields(xs[0]!, { promptChars: 65, steps: 2, toolCalls: 1, edits: 1, outTok: 35, inTok: 15 }, "unicode E0");
  expectFields(xs[1]!, { promptChars: PROMPTS.unicode1.length, steps: 1, outTok: 25, t: "2026-10-01T10:01:00.000Z" }, "unicode E1");
});

// ------------------------------------------------------------------ damaged + truncated

test("#13 bad lines are counted, a cut-off final line is a truncated tail (not a bad line), surrounding records survive", async () => {
  const r = await parseScenario(claudeReader, "damaged");
  // bad: "{not json", "[1,2,3]", "\"just a string\"", and a mid-file partial record followed by more lines
  expectFields(r.stats, { files: 1, filesFailed: 0, badLines: 4, truncatedTail: 1 }, "damaged stats");
  const xs = bySeq(r);
  assert.equal(xs.length, 2);
  expectFields(xs[0]!, { steps: 2, toolCalls: 1, outTok: 80, inTok: 50 }, "damaged E0");
  // the truncated final response (out 999) must not be counted
  expectFields(xs[1]!, { steps: 1, toolCalls: 1, edits: 1, outTok: 60, inTok: 20 }, "damaged E1");
});

// ------------------------------------------------------------------ clocks

test("clock reset between exchanges: exchanges stay in FILE order with their own prompt timestamps", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "clock"));
  assert.deepEqual(xs.map((x) => [x.seq, x.t, x.day]), [
    [0, "2026-10-02T15:00:00.000Z", "2026-10-02"],
    [1, "2026-10-02T09:00:00.000Z", "2026-10-02"],
    [2, "2026-10-02T09:10:00.000Z", "2026-10-02"],
  ]);
});

test("durationMs ignores out-of-range timestamps and is never negative when the clock jumps back mid-exchange", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "clock"));
  assert.equal(xs[0]!.durationMs, 300_000); // 15:00:00 → 15:05:00
  assert.equal(xs[1]!.durationMs, 40_000); // 09:00:00 → 09:00:40; the 2019 and 2035 timestamps are ignored
  // E2 records: 09:10:00, 09:10:30, 09:10:31, then 08:55:00, 08:55:01, 08:56:00. Any sane span is in [0, max − min].
  const d = xs[2]!.durationMs;
  assert.ok(Number.isFinite(d) && d >= 0 && d <= 931_000, `clock E2.durationMs = ${d}`);
});

test("records with timestamps outside [2020-01-01, now + 1 day] are counted, and their work still counts", async () => {
  const r = await parseScenario(claudeReader, "clock");
  assert.equal(r.stats.badTimestamps, 2);
  const xs = bySeq(r);
  expectFields(xs[0]!, { steps: 2, toolCalls: 1, reads: 1 }, "clock E0");
  expectFields(xs[1]!, { steps: 3, toolCalls: 2, toolErrors: 0 }, "clock E1");
  expectFields(xs[2]!, { steps: 3, toolCalls: 2 }, "clock E2");
});

// ------------------------------------------------------------------ format drift

// D62b (vocabulary-level, like D52a): `relocated` is now a documented record type (EnterWorktree moved the transcript),
// handled by the reader, so it is no longer format drift.
test("#20 record type 'relocated' (D62b: known) is not reported in unknownTypes", async () => {
  const r = await parseScenario(claudeReader, "drift");
  const keys = Object.keys(r.stats.unknownTypes).filter((k) => k.includes("relocated"));
  assert.deepEqual(keys, [], `no unknownTypes key for 'relocated', got ${JSON.stringify(r.stats.unknownTypes)}`);
});

test("#20 every unknown type is counted (3 records), and documented record types are not reported as unknown", async () => {
  const r = await parseScenario(claudeReader, "drift");
  const counts = Object.values(r.stats.unknownTypes).reduce((a, b) => a + b, 0);
  assert.equal(counts, 1, `one path-shaped type (relocated ×2 is known since D62b); got ${JSON.stringify(r.stats.unknownTypes)}`);
  for (const k of Object.keys(r.stats.unknownTypes)) {
    for (const known of [...KNOWN_IGNORABLE_TYPES, "user", "assistant", "system", "attachment"]) {
      assert.ok(!(k === known || k.endsWith(`:${known}`)), `documented type '${known}' reported as unknown (${k})`);
    }
  }
});

test("non-message records (cost-state totals, attachments, system subtypes) never add tokens or steps", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "drift"));
  assert.equal(xs.length, 2);
  expectFields(xs[0]!, { humanPrompt: 1, steps: 1, toolCalls: 0, outTok: 20, inTok: 10, cacheRead: 0, cacheWrite: 0, apiErrors: 0, apiRetries: 0, compactions: 0 }, "drift E0");
});

test("malformed shapes (message as string, string content, non-numeric/negative usage, content 42, message null) do not crash or go negative", async () => {
  const r = await parseScenario(claudeReader, "drift");
  assert.equal(r.stats.badLines, 0, "they are valid JSON objects");
  const e1 = bySeq(r)[1]!;
  expectFields(e1, { humanPrompt: 1, t: "2026-10-03T13:05:00.000Z", outTok: 15, cacheRead: 0, cacheWrite: 0 }, "drift E1");
  oneOf(e1.inTok, [5, 1005], "drift E1.inTok (\"1000\" string may be ignored or coerced)");
});

// ------------------------------------------------------------------ empty / missing files

test("an empty session file (if listed) parses to nothing", async () => {
  const sources = claudeReader.list();
  assert.ok(sources.length > 0, "nothing listed");
  const src = (() => { try { return findSource(sources, "empty"); } catch { return undefined; } })();
  if (!src) return; // listing empty files is optional
  const r = await claudeReader.parse(src, makeCtx());
  assert.deepEqual(r.exchanges, []);
  assert.deepEqual(r.events, []);
  expectFields(r.stats, { files: 1, filesFailed: 0, badLines: 0, truncatedTail: 0, unknownTypes: {}, duplicates: 0, badTimestamps: 0 }, "empty stats");
});

test("a file deleted between list() and parse() is reported in filesFailed, not thrown", async () => {
  const src = findSource(claudeReader.list(), "basic");
  const gone = join(dirname(real(src.files[0]!.path)), "c1a0de00-dead-4000-8000-000000000000.jsonl");
  const r = await claudeReader.parse({ ...src, files: src.files.map((f) => ({ ...f, path: gone })) }, makeCtx());
  assert.deepEqual(r.exchanges, []);
  assert.equal(r.stats.filesFailed, 1);
});

// ------------------------------------------------------------------ determinism

const IDS = new Set(["id", "session", "project"]);
const metrics = (x: Exchange) => Object.fromEntries(Object.entries(x).filter(([k]) => !IDS.has(k)));

test("parsing the same source again gives an identical result (rescans are stable)", async () => {
  const before = await parseScenario(claudeReader, "basic");
  const again = await claudeReader.parse(findSource(claudeReader.list(), "basic"), makeCtx());
  assert.deepEqual(again, before);
});

test("ids depend on the salt (ctx.hash); metrics do not", async () => {
  const a = bySeq(await parseScenario(claudeReader, "basic"));
  const b = bySeq(await claudeReader.parse(findSource(claudeReader.list(), "basic"), makeCtx({ salt: "another-salt" })));
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) {
    for (const k of IDS) assert.notEqual(b[i]![k as keyof Exchange], a[i]![k as keyof Exchange], `seq ${i}.${k} must change with the salt`);
    assert.deepEqual(metrics(b[i]!), metrics(a[i]!));
  }
});

test("day is computed in ctx.timeZone; t stays UTC", async () => {
  const xs = bySeq(await claudeReader.parse(findSource(claudeReader.list(), "basic"), makeCtx({ timeZone: "Pacific/Kiritimati" })));
  // UTC+14: 2026-09-15T10:00Z → 2026-09-16 00:00 local
  assert.deepEqual(xs.map((x) => x.day), ["2026-09-16", "2026-09-16", "2026-09-16", "2026-09-16"]);
  assert.equal(xs[0]!.t, "2026-09-15T10:00:00.000Z");
});
