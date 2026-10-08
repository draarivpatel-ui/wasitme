// Every indicator the engine can put in front of a user has its words on every surface. The engine's list of indicators
// (engine/src/words/build.ts SNAPSHOT_METRICS, which holds every voting, supporting and tool-error construct the glance can
// carry) is checked against each table that names an indicator, its counts or gate by its id: the Mac app's MetricWords
// and MetricNames, the canvas's KN_WORDS / GATE_NOUN / METRIC_LABEL, the Claude Code pane's metricName / eventNoun /
// stripRows, the terminal's STRIP_LABELS /
// EVENT_NOUN and the engine's own METRIC_WORDS / COUNT_NOUNS. A missing entry falls back to "events" on that surface (the
// app's medium desktop panel called toolErrorsNonCmd's columns "events" per day until it had one). The tables are read as
// source text, so no build is needed; the app and the canvas also have to agree, word for word, as their comments say.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers.mjs";

const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

/** Index just past a string or comment starting at `i` (Swift and TypeScript spell both alike), or `i` when there is none. */
function skip(src, i) {
  const c = src[i];
  if (c === '"' || c === "'" || c === "`") {
    for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    return i + 1;
  }
  if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); return e < 0 ? src.length : e; }
  if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); return e < 0 ? src.length : e + 2; }
  return i;
}

/** The bracketed literal that follows the first match of `start` (its opening bracket included), with its comments
 *  blanked out. */
function literal(src, start, where) {
  const m = start.exec(src);
  assert.ok(m, `${where}: ${start} not found`);
  const open = { "[": "]", "{": "}", "(": ")" };
  let i = m.index + m[0].length;
  while (i < src.length && !(src[i] in open)) i++;
  const stack = [];
  let out = "";
  while (i < src.length) {
    const j = skip(src, i);
    if (j !== i) { out += src[i] === "/" ? " " : src.slice(i, j); i = j; continue; }
    const c = src[i];
    out += c;
    if (c in open) stack.push(open[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (stack.length === 0) return out; }
    i++;
  }
  assert.fail(`${where}: ${start} has no closing bracket`);
}

/** The top-level entries of an object / dictionary literal (comments already blanked): key → value text. */
function entries(body) {
  const inner = body.slice(1, -1), parts = [];
  let depth = 0, from = 0;
  for (let i = 0; i < inner.length;) {
    const j = skip(inner, i);
    if (j !== i) { i = j; continue; }
    const c = inner[i];
    if ("[{(".includes(c)) depth++;
    else if ("]})".includes(c)) depth--;
    else if (c === "," && depth === 0) { parts.push(inner.slice(from, i)); from = i + 1; }
    i++;
  }
  parts.push(inner.slice(from));
  const out = new Map();
  for (const p of parts) {
    const m = /^\s*["']?(\w+)["']?\s*:\s*([\s\S]*?)\s*$/.exec(p);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const strings = (text) => [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);

// The engine's indicators.
const build = read("engine/src/words/build.ts");
const SNAPSHOT = strings(literal(build, /export const SNAPSHOT_METRICS\b[^=]*=/, "build.ts SNAPSHOT_METRICS"));
const defs = read("engine/src/analysis/metrics/defs.ts");
const ROWS = [...defs.matchAll(/\bid: "(\w+)", family: "(\w+)", role: "(\w+)"/g)].map((m) => ({ id: m[1], family: m[2], role: m[3] }));
const VARIANTS = strings(literal(defs, /export const TOOL_ERROR_VARIANTS\b[^=]*=\s*Object\.freeze\(/, "defs.ts TOOL_ERROR_VARIANTS"));
/** What can carry an unlock gate (D47(d): any tool-error construct can be the one that votes). */
const VOTE_CAPABLE = [...new Set([...ROWS.filter((r) => r.role === "vote").map((r) => r.id), ...VARIANTS])];

test("the engine's lists are read: 17 metrics, 8 in the snapshot, three tool-error constructs", () => {
  assert.equal(ROWS.length, 17, ROWS.map((r) => r.id).join(" "));
  assert.deepEqual(SNAPSHOT, ["toolErrors", "toolErrorsNonCmd", "cmdFailures", "readsPerEdit", "blindEdits", "interrupts", "pushback", "churn"]);
  assert.deepEqual(VARIANTS, ["toolErrors", "toolErrorsNonCmd", "cmdFailures"]);
});

test("the snapshot's list holds every indicator a glance can carry: every voting and supporting metric, every tool-error construct", () => {
  for (const id of [...VOTE_CAPABLE, ...ROWS.filter((r) => r.role === "support").map((r) => r.id)]) {
    assert.ok(SNAPSHOT.includes(id), `${id} can reach a surface but is not in SNAPSHOT_METRICS`);
  }
});

/** [surface, file, start of the table, ids it must cover]. */
const TABLES = [
  ["Mac app counted words", "macos/Sources/WasitmeUI/Views/Components.swift", /static let kn: [^=]*=/, SNAPSHOT],
  ["Mac app gate nouns", "macos/Sources/WasitmeUI/Views/Components.swift", /static let gate: [^=]*=/, SNAPSHOT],
  ["canvas counted words", "ui/src/derive.ts", /const KN_WORDS\b[^=]*=/, SNAPSHOT],
  ["canvas gate nouns", "ui/src/derive.ts", /const GATE_NOUN\b[^=]*=/, SNAPSHOT],
  ["canvas labels", "ui/src/derive.ts", /const METRIC_LABEL\b[^=]*=/, SNAPSHOT],
  ["Mac app labels", "macos/Sources/WasitmeCore/Display/MetricNames.swift", /static let label: [^=]*=/, SNAPSHOT],
  ["Claude Code pane names", "plugin/mod/theme.ts", /\bmetricName:/, SNAPSHOT],
  ["Claude Code pane event nouns", "plugin/mod/theme.ts", /\beventNoun:/, SNAPSHOT],
  ["Claude Code pane strip rows", "plugin/mod/theme.ts", /\bstripRows:/, SNAPSHOT],
  ["terminal strip labels", "engine/src/output/terminal.ts", /export const STRIP_LABELS\b[^=]*=/, SNAPSHOT],
  ["terminal event nouns", "engine/src/output/terminal.ts", /const EVENT_NOUN\b[^=]*=/, SNAPSHOT],
  ["engine names", "engine/src/words/names.ts", /const METRIC_WORDS\b[^=]*=/, ROWS.map((r) => r.id)],
  ["engine gate count nouns", "engine/src/words/names.ts", /const COUNT_NOUNS\b[^=]*=/, VOTE_CAPABLE],
];

for (const [surface, file, start, ids] of TABLES) {
  test(`${surface} (${file}) name every indicator they can be asked for`, () => {
    const keys = entries(literal(read(file), start, `${file} ${surface}`));
    assert.ok(keys.size >= 3, `${file}: ${surface} read as ${[...keys.keys()].join(", ")}`);
    const missing = ids.filter((id) => !keys.has(id));
    assert.deepEqual(missing, [], `${file}: ${surface} has no words for ${missing.join(", ")}`);
  });
}

test("the Mac app and the canvas call every indicator's counts and gate the same", () => {
  const swift = read("macos/Sources/WasitmeUI/Views/Components.swift"), canvas = read("ui/src/derive.ts");
  const pairs = [
    [entries(literal(swift, /static let kn: [^=]*=/, "kn")), entries(literal(canvas, /const KN_WORDS\b[^=]*=/, "KN_WORDS"))],
    [entries(literal(swift, /static let gate: [^=]*=/, "gate")), entries(literal(canvas, /const GATE_NOUN\b[^=]*=/, "GATE_NOUN"))],
  ];
  for (const [app, ui] of pairs) {
    for (const id of SNAPSHOT) assert.deepEqual(strings(app.get(id) ?? ""), strings(ui.get(id) ?? ""), `${id}: the app and the canvas disagree`);
  }
});

test("every surface that names an indicator without the document's label uses the engine's label, word for word", () => {
  // The Codex demo's Finding page printed "toolErrors": its unlock item had no labelled row, and the canvas fell back to
  // the id. The fallback tables now name it; they must say what the engine says (one name per indicator, D59).
  const engine = entries(literal(read("engine/src/words/names.ts"), /const METRIC_WORDS\b[^=]*=/, "METRIC_WORDS"));
  const surfaces = [
    ["canvas", entries(literal(read("ui/src/derive.ts"), /const METRIC_LABEL\b[^=]*=/, "METRIC_LABEL"))],
    ["Mac app", entries(literal(read("macos/Sources/WasitmeCore/Display/MetricNames.swift"), /static let label: [^=]*=/, "label"))],
    ["Claude Code pane", entries(literal(read("plugin/mod/theme.ts"), /\bmetricName:/, "metricName"))],
  ];
  for (const id of SNAPSHOT) {
    const label = strings(engine.get(id) ?? "")[0];
    assert.ok(label, `${id}: the engine has a label`);
    for (const [surface, table] of surfaces) assert.equal(strings(table.get(id) ?? "")[0], label, `${id}: the ${surface} disagrees with the engine`);
  }
});

test("the reader of these tables sees a missing entry (self-test on a made-up table)", () => {
  const keys = entries(literal('let t = {\n  a: ["x", "y"], // note\n  "b": "z",\n  c: { d: 1 },\n};', /let t =/, "self-test"));
  assert.deepEqual([...keys.keys()], ["a", "b", "c"]);
  const swiftDict = entries(literal('static let kn: [String: (k: String, n: String)] = [\n  "p": ("x, y", "z"), "q": ("r", "s"),\n]', /static let kn: [^=]*=/, "self-test"));
  assert.deepEqual([...swiftDict.keys()], ["p", "q"]);
  assert.deepEqual(strings(swiftDict.get("p")), ["x, y", "z"]);
});
