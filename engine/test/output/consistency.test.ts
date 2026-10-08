/**
 * One reading on every surface (DESIGN §1 "learn it once, read every surface"): a change keeps one marker in the
 * terminal at any width and in the Markdown and HTML reports; the ledger keeps the evidence tag when a label is long;
 * context rows never claim to have "moved"; ASCII mode never prints ">" for an arrow; the HTML report's tables keep
 * numbers whole and scroll at phone width. Engine output over the demo and the shared synthetic cases only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { demoOutputs } from "../../src/demo/facts.js";
import { coerceDoc } from "../../src/output/doc.js";
import { renderHtml, renderMarkdown } from "../../src/output/report.js";
import { renderTerminal, type TerminalOptions } from "../../src/output/terminal.js";
import { CASES, docOf } from "./cases.js";

const opts = (over: Partial<TerminalOptions> = {}): TerminalOptions => ({ mode: "none", ascii: false, columns: 100, timeZone: "UTC", platform: "darwin", ...over });
const demo = (name: "unclear" | "you") => coerceDoc(demoOutputs(name, { engine: "0.1.0" }).snapshot, Date.parse("2026-10-04T14:24:00Z"));

/** Ledger rows: "Sep 23 Served model" → its marker. */
function ledger(text: string): Map<string, string> {
  return new Map([...text.matchAll(/^ {16}\[([0-9A-Z]+)\] (\w+ \d+) +([^\s…]+)/gm)].map((m) => [`${m[2]} ${m[3]}`, m[1]!]));
}

test("markers: one change has one marker at every width and in the Markdown report (assigned over the whole timeline)", () => {
  for (const name of ["unclear", "you"] as const) {
    const doc = demo(name);
    const wide = ledger(renderTerminal(doc, opts()));
    const narrow = ledger(renderTerminal(doc, opts({ columns: 80 })));
    assert.ok(wide.size >= 5, `${name}: ledger rows parsed`);
    assert.ok(narrow.size >= 3);
    for (const [row, m] of narrow) assert.equal(wide.get(row), m, `${name} ${row}: same marker at 80 and 100 columns`);
    const md = renderMarkdown(doc);
    let matched = 0;
    for (const m of md.matchAll(/^- (\w+ \d+) +[■▲]([0-9A-Z]+) +([^\s…]+)/gm)) {
      const key = `${m[1]} ${m[3]}`;
      if (!wide.has(key)) continue;
      matched++;
      assert.equal(m[2], wide.get(key), `${name} ${key}: the Markdown timeline uses the terminal's marker`);
    }
    assert.ok(matched >= 3, `${name}: rows compared`);
    // The Markdown strip shows the same markers (never renumbered inside its 14 days).
    const strip = /```text\n([\s\S]*?)```/.exec(md)![1]!;
    const all = new Set([...wide.values(), ...narrow.values()]);
    for (const m of strip.matchAll(/[■▲]([0-9A-Z]+)/g)) assert.ok(all.has(m[1]!), `${name}: strip marker ${m[1]} is a timeline marker`);
  }
});

test("ledger: the evidence tag survives a long label (the label is cut instead); the routine-updates note only follows a row that says it", () => {
  const doc = demo("unclear");
  // At 64 columns the tag itself is wider than the room left, so the side alone is shown there (still within the width).
  for (const line of renderTerminal(doc, opts({ columns: 64 })).split("\n")) assert.ok([...line].length <= 64);
  for (const columns of [100, 80]) {
    const text = renderTerminal(doc, opts({ columns }));
    assert.match(text, /Served model.*agent side · lines up with the shift$/m, `${columns}: the served-model row keeps its evidence tag`);
    assert.match(text, /Effort high.*your side · lines up with the shift$/m, `${columns}`);
    const routineRows = (text.match(/routine update$/gm) ?? []).length;
    assert.equal(/Routine updates alone aren't evidence\./.test(text), routineRows > 0, `${columns}: the note follows a visible "routine update" tag`);
    for (const line of text.split("\n")) assert.ok([...line].length <= columns, `${columns}: fits`);
  }
});

test("context rows (friction, the all-tool-errors row) say 'context' and keep the open dot; they never say 'moved'", () => {
  let checked = 0;
  for (const c of CASES) {
    const doc = docOf(c.name);
    const lines = renderTerminal(doc, opts()).split("\n");
    for (const a of doc.agents) {
      for (const m of a.metrics.filter((x) => x.role !== "vote" && x.eligible && x.ratio !== null)) {
        const line = lines.find((l) => l.includes(`×${m.ratio!.toFixed(2)}`) && l.trimEnd().endsWith("context"));
        assert.ok(line !== undefined, `${c.name}/${m.id}: shown as context`);
        assert.ok(!line!.includes("●"), `${c.name}/${m.id}: no filled dot`);
        checked++;
      }
    }
    assert.doesNotMatch(renderMarkdown(doc), /\(context\) \|[^\n]*\| moved, (more|fewer) \|/, `${c.name}: no context row says moved`);
  }
  assert.ok(checked > 0, "some eligible context rows were checked");
});

test("ASCII: arrows print as '->', never '>' (it read as greater-than), and the widths still hold", () => {
  for (const name of ["unclear", "you"] as const) {
    const text = renderTerminal(demo(name), opts({ ascii: true }));
    assert.match(text, /Claude Code 2\.1\.\d+ -> 2\.1\.\d+/);
    assert.doesNotMatch(text, /\d > \d|\w > \w/);
    for (const line of text.split("\n")) assert.ok(line.length <= 100);
  }
});

test("HTML report: number cells never wrap and tables scroll inside the page at phone width", () => {
  const html = renderHtml(docOf("you"));
  assert.match(html, /<div class="tw"><table>/);
  assert.match(html, /<td class="r nw">[\d,]+ \/ [\d,]+<\/td>/);
  assert.match(html, /<td class="l nw">×[\d.]+–×[\d.]+<\/td>/);
  assert.match(html, /\.tw \{ overflow-x: auto; max-width: 100%;/);
  assert.match(html, /td\.nw, th\.nw \{ white-space: nowrap; \}/);
  assert.match(html, /@media \(max-width: 600px\)/);
});
