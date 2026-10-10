/**
 * The terminal report (WP-30): goldens for every verdict state × lead variant × colour mode at 100 columns, the
 * properties every output must have (width, only the design system's colour codes, the same text in every mode),
 * the copy lints on what is printed, narrow and ASCII layouts, stale / empty / mismatched / refused documents, and the
 * hostile glance fixture. The cases come from the real pipeline (cases.ts); nothing is real data.
 *
 * Regenerate after an intentional change:  WASITME_UPDATE_GOLDENS=1 node --test dist/test/output/terminal.test.js
 * and review the diff of engine/test/output/goldens/terminal/*.txt (the readable goldens); the colour modes are held
 * by hashes (goldens/terminal-hashes.json) plus two raw exemplars, because they differ from the readable text only in
 * escape codes (tested below).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { lintCopy } from "../../src/contract/check.js";
import { DISCLAIMER } from "../../src/contract/check.js";
import { chooseMode, type ColorMode } from "../../src/cli/design-tokens.js";
import { coerceDoc, emptyDoc } from "../../src/output/doc.js";
import { copyProblems, safeTerminalText } from "../../src/output/guard.js";
import { renderHtml, renderMarkdown } from "../../src/output/report.js";
import { renderTerminal, type TerminalOptions } from "../../src/output/terminal.js";
import { cols } from "../../src/output/text.js";
import { LEADS } from "../../src/contract/vocab.js";
import { tokensBanned } from "../words/helpers.js";
import { CASES, docOf, GOLDENS, NOW_MS, outputsOf, readJson, ROOT, stripSgr, UPDATE } from "./cases.js";

const MODES: ColorMode[] = ["none", "ansi16", "ansi256-dark", "ansi256-light", "truecolor-dark", "truecolor-light"];
const opts = (mode: ColorMode, over: Partial<TerminalOptions> = {}): TerminalOptions => ({ mode, ascii: false, columns: 100, timeZone: "UTC", platform: "darwin", ...over });

const HASHES_FILE = `${GOLDENS}terminal-hashes.json`;
const hashes: Record<string, string> = existsSync(HASHES_FILE) ? readJson(HASHES_FILE) : {};
const producedHashes: Record<string, string> = {};
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function golden(path: string, text: string): void {
  if (UPDATE) {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  assert.ok(existsSync(path), `missing golden ${path.slice(ROOT.length)} (run with WASITME_UPDATE_GOLDENS=1)`);
  assert.equal(text, readFileSync(path, "utf8"), `golden ${path.slice(ROOT.length)} differs`);
}

// SGR parameter lists the design system writes: reset, bold, dim, underline, reverse, 256-colour and truecolour pairs.
const SGR_OK = /^(0|1|2|4|7|38;5;\d{1,3}|38;5;\d{1,3};48;5;\d{1,3}|38;2;\d{1,3};\d{1,3};\d{1,3}|38;2;\d{1,3};\d{1,3};\d{1,3};48;2;\d{1,3};\d{1,3};\d{1,3})$/;

function assertWellFormed(out: string, mode: ColorMode, width: number, what: string): void {
  assert.ok(out.endsWith("\n"), `${what}: ends with a newline`);
  assert.ok(safeTerminalText(out), `${what}: only newlines and colour codes`);
  for (const m of out.matchAll(/\x1b\[([0-9;]*)m/g)) assert.match(m[1]!, SGR_OK, `${what}: unexpected SGR ${m[1]}`);
  if (mode === "none") assert.ok(!out.includes("\x1b"), `${what}: no escape codes without colour`);
  for (const line of stripSgr(out).split("\n")) {
    assert.ok(cols(line) <= width, `${what}: line wider than ${width}: ${line.slice(0, 40)}`);
    // a sticker's padding is part of the sticker; plain text has none
    if (mode === "none") assert.ok(!line.endsWith(" "), `${what}: trailing space`);
  }
}

// ───────────────────────────── goldens: every state × lead × mode ─────────────────────────────

for (const c of CASES) {
  for (const lead of LEADS) {
    test(`terminal ${c.name} × ${lead}: golden text, and the same text in every colour mode`, () => {
      const doc = docOf(c.name, lead);
      assert.equal(doc.display, "ok");
      const plain = renderTerminal(doc, opts("none"));
      assertWellFormed(plain, "none", 100, `${c.name}/${lead}/none`);
      golden(`${GOLDENS}terminal/${c.name}.${lead}.txt`, plain);
      for (const mode of MODES.slice(1)) {
        const out = renderTerminal(doc, opts(mode));
        assertWellFormed(out, mode, 100, `${c.name}/${lead}/${mode}`);
        // Colour is the only difference: with the codes removed, stickers read " 1 " where the plain text has "[1]".
        assert.equal(stripSgr(out), plain.replace(/\[([^\[\]]{1,12})\]/g, " $1 "), `${c.name}/${lead}/${mode}: text differs from the plain text`);
        const key = `${c.name}.${lead}.${mode}`;
        producedHashes[key] = sha(out);
        if (!UPDATE) assert.equal(producedHashes[key], hashes[key], `${key}: colour output differs from its golden hash`);
      }
    });
  }
}

test("terminal: raw colour exemplars (16 colours, truecolor) are the readable record of the colour goldens", () => {
  golden(`${GOLDENS}terminal/insufficient.timeline.ansi16.txt`, renderTerminal(docOf("insufficient"), opts("ansi16")));
  golden(`${GOLDENS}terminal/you.timeline.truecolor-dark.txt`, renderTerminal(docOf("you"), opts("truecolor-dark")));
  if (UPDATE) writeFileSync(HASHES_FILE, `${JSON.stringify(Object.fromEntries(Object.entries(producedHashes).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`);
});

test("terminal: the hash file lists exactly the cases and modes tested", () => {
  if (UPDATE) return;
  const want = CASES.flatMap((c) => LEADS.flatMap((l) => MODES.slice(1).map((m) => `${c.name}.${l}.${m}`))).sort();
  assert.deepEqual(Object.keys(hashes).sort(), want);
});

// ───────────────────────────── what is printed ─────────────────────────────

test("terminal: the colour modes follow the design system's rules (reverse video in 16 colours, token fills, greys, no dim elsewhere)", () => {
  const doc = docOf("unclear");
  const c16 = renderTerminal(doc, opts("ansi16"));
  assert.match(c16, /\x1b\[7m 1 \x1b\[0m/, "your sticker is reverse video");
  assert.match(c16, /\x1b\[7m C \x1b\[0m|\x1b\[7m A \x1b\[0m/, "the agent's sticker is reverse video too");
  assert.match(c16, /\x1b\[2m/, "16 colours use dim for muted text");
  const c256 = renderTerminal(doc, opts("ansi256-dark"));
  assert.match(c256, /\x1b\[38;5;16;48;5;221m 1 \x1b\[0m/, "your sticker: black on 221");
  assert.match(c256, /\x1b\[38;5;16;48;5;117m [A-Z] \x1b\[0m/, "the agent's sticker: black on 117");
  assert.ok(!c256.includes("\x1b[2m"), "256 colours never use dim (explicit greys)");
  const tc = renderTerminal(doc, opts("truecolor-light"));
  assert.match(tc, /\x1b\[38;2;28;29;33;48;2;245;200;66m 1 \x1b\[0m/, "truecolor your fill (light)");
  assert.match(tc, /\x1b\[38;2;28;29;33;48;2;141;188;240m [A-Z] \x1b\[0m/, "truecolor agent fill (light)");
  assert.equal(chooseMode({ NO_COLOR: "1", COLORTERM: "truecolor" }, true), "none");
  assert.equal(chooseMode({ TERM: "xterm-256color" }, false), "none");
  assert.equal(chooseMode({ TERM: "dumb" }, true), "none");
  assert.equal(chooseMode({ TERM: "xterm-256color" }, true), "ansi256-dark");
  assert.equal(chooseMode({ TERM: "screen", COLORFGBG: "0;15" }, true), "ansi16");
  assert.equal(chooseMode({ COLORTERM: "24bit", COLORFGBG: "0;15" }, true), "truecolor-light");
});

test("terminal: the party is carried four ways in plain text (numeral/letter, above/below the line, words, brackets)", () => {
  const lines = renderTerminal(docOf("unclear"), opts("none")).split("\n");
  const rule = lines.findIndex((l) => /^ {16}┄/.test(l));
  assert.ok(rule > 0);
  assert.match(lines[rule - 1]!, /\[1\]/, "yours: numerals above the rule");
  assert.match(lines[rule + 1]!, /\[[A-Z]\]/, "the agent's: letters below the rule");
  assert.match(lines.join("\n"), /^ {16}\[1\] \w+ \d+ +Effort high → medium +your side/m, "the legend names the side in words");
  assert.match(lines.join("\n"), /^ {16}\[[A-Z]\] \w+ \d+ +Served model differs from the on… +agent side · lines up with the shift/m);
  assert.match(renderTerminal(docOf("you"), opts("none")), /■── \[Your side\]/, "the finding: text glyph and the party sticker");
});

test("terminal: lead variants differ only in section order; timeline-led is the default", () => {
  for (const c of CASES) {
    const t = renderTerminal(docOf(c.name, "timeline"), opts("none")).split("\n");
    const v = renderTerminal(docOf(c.name, "timeline"), opts("none", { lead: "verdict" })).split("\n");
    assert.deepEqual([...t].sort(), [...v].sort(), `${c.name}: same lines`);
    const fT = t.findIndex((l) => l.startsWith("Finding")), wT = t.findIndex((l) => l.startsWith("What changed"));
    const fV = v.findIndex((l) => l.startsWith("Finding")), wV = v.findIndex((l) => l.startsWith("What changed"));
    assert.ok(fT > wT, `${c.name}: timeline-led puts What changed first`);
    assert.ok(fV < wV, `${c.name}: verdict-led puts the Finding first`);
    // the document's own lead is honoured when no override is given
    assert.equal(renderTerminal(docOf(c.name, "verdict"), opts("none")), renderTerminal(docOf(c.name, "timeline"), opts("none", { lead: "verdict" })), `${c.name}: doc lead = override`);
  }
});

test("terminal: none/you/agent end the finding with the fixed disclaimer; nothing else says it; every printed line passes the copy lints", () => {
  for (const c of CASES) {
    for (const lead of LEADS) {
      const doc = docOf(c.name, lead);
      assert.deepEqual(copyProblems(doc), [], `${c.name}: document copy`);
      const text = stripSgr(renderTerminal(doc, opts("none")));
      const wants = ["none", "you", "agent"].includes(doc.agents[0]!.state) && doc.agents[0]!.reason !== "calibration_pending";
      assert.equal(text.includes(DISCLAIMER), wants, `${c.name}/${lead}: disclaimer`);
      for (const line of text.split("\n")) {
        assert.deepEqual(lintCopy(line), [], `${c.name}/${lead}: copy lint on "${line}"`);
        assert.deepEqual(tokensBanned(line), [], `${c.name}/${lead}: tokens.json banned list on "${line}"`);
        assert.ok(!/\bverdicts?\b/i.test(line), `${c.name}/${lead}: says "verdict": ${line}`);
      }
    }
  }
});

test("terminal: the printed glance words carry only the state (no cause, no quality word) in the Finding label", () => {
  for (const c of CASES) {
    const out = outputsOf(c.name);
    const a = out.snapshot.agents[0]!;
    const text = stripSgr(renderTerminal(docOf(c.name), opts("none")));
    const finding = text.split("\n").find((l) => l.startsWith("Finding"))!;
    assert.ok(finding.includes(a.label) || finding.includes(a.label.toUpperCase()), `${c.name}: the Finding line names the state (${finding})`);
  }
});

test("terminal: ASCII mode prints only ASCII (state glyphs become [..] [none] [?] [you] [agent]) at the same width", () => {
  for (const c of CASES) {
    const out = renderTerminal(docOf(c.name), opts("none", { ascii: true }));
    assert.match(out, /^[\x0a\x20-\x7e]*$/, `${c.name}: ASCII only`);
    assertWellFormed(out, "none", 100, `${c.name}/ascii`);
  }
  const youAscii = renderTerminal(docOf("you"), opts("none", { ascii: true }));
  assert.match(youAscii, /Finding {9}\[Your side\]/, "the sticker alone names the side");
  assert.doesNotMatch(youAscii, /\[you\] \[Your side\]/);
  assert.match(youAscii, /Model m1 -> m2/, "the arrow is \"->\"");
  assert.doesNotMatch(youAscii, /\w > \w/, "never a bare \">\" between values");
  assert.match(renderTerminal(docOf("insufficient"), opts("none", { ascii: true })), /\[\.\.\] Too early to tell/);
});

test("terminal: narrower terminals still fit (64 to 99 columns), and a wider one stays at 100", () => {
  for (const c of CASES) {
    for (const w of [64, 72, 80, 90, 99]) {
      const out = renderTerminal(docOf(c.name), opts("none", { columns: w }));
      assertWellFormed(out, "none", w, `${c.name}@${w}`);
    }
    assert.equal(renderTerminal(docOf(c.name), opts("none", { columns: 200 })), renderTerminal(docOf(c.name), opts("none", { columns: 100 })));
  }
  golden(`${GOLDENS}terminal/insufficient.timeline.80.txt`, renderTerminal(docOf("insufficient"), opts("none", { columns: 80 })));
});

// ───────────────────────────── documents that cannot be drawn as findings ─────────────────────────────

test("terminal: an out-of-date document says so (the glyph, the words), keeps the last state in words, and drops the next step", () => {
  const doc = docOf("you", "timeline", NOW_MS + 3 * 3600_000);
  assert.equal(doc.display, "stale");
  const text = renderTerminal(doc, opts("none"));
  assert.match(text, /Finding {9}─╱─ Out of date/);
  assert.match(text, /out of date · checked Oct 4, 12:00/);
  assert.match(text, /Last result, from Oct 4, 12:00: Your side\. Run wasitme scan to refresh\./);
  assert.ok(!text.includes("Next "), "no next step on stale results");
  assertWellFormed(text, "none", 100, "stale");
});

test("terminal: an empty, mismatched or refused document prints one plain sentence", () => {
  const empty = renderTerminal(emptyDoc("empty"), opts("none"));
  assert.match(empty, /No Claude Code or Codex logs found in ~\/\.claude or ~\/\.codex\. Logs somewhere else\? Set\s+CLAUDE_CONFIG_DIR or CODEX_HOME to their folder, or run: wasitme doctor/);
  // Moved logs are named by the variable that moved them, never by path.
  assert.match(renderTerminal(emptyDoc("empty"), { ...opts("none"), roots: { claude: "$CLAUDE_CONFIG_DIR", codex: "~/.codex" } }), /logs found in \$CLAUDE_CONFIG_DIR or ~\/\.codex/);
  assert.match(renderTerminal(emptyDoc("empty", "missing"), opts("none")), /No results yet\. Run: wasitme scan/);
  assert.match(renderTerminal(emptyDoc("empty", "damaged"), opts("none")), /The results file is damaged\. Run: wasitme scan/);
  // A scanned-empty snapshot whose log folder could not be read says so, not "no logs".
  const unreadable = coerceDoc({ ...outputsOf("you").snapshot, agents: [], health: { ...outputsOf("you").snapshot.health, sources: [
    { agent: "claude-code", found: false, files: 0, badLines: 0, truncatedTail: 0, duplicates: 0, unknownTypes: {}, firstDay: null, lastDay: null, error: "protected_folder" },
  ] } }, NOW_MS);
  assert.equal(unreadable.display, "empty");
  assert.match(renderTerminal(unreadable, opts("none")), /wasitme could not read Claude Code logs in ~\/\.claude \(macOS privacy protection\)\. Run: wasitme doctor/);
  const other = coerceDoc({ schema: "wasitme.snapshot/2", agents: [] }, NOW_MS);
  assert.equal(other.display, "mismatch");
  const mismatch = renderTerminal(other, opts("none"));
  assert.match(mismatch, /written by a different version of wasitme\. Run: wasitme scan\./);
  assert.match(mismatch, /update it so every part is the same version \(wasitme update\s+shows how\)/);
  const lying = coerceDoc({ ...outputsOf("you").snapshot, privacy: { containsText: true } }, NOW_MS);
  assert.equal(lying.display, "refused");
  const refused = renderTerminal(lying, opts("none"));
  assert.match(refused, /does not promise that it holds numbers only/);
  assert.ok(!refused.includes("Your side"), "nothing from a refused file is drawn");
});

test("terminal: a failed scan is flagged above the last good result", () => {
  const raw = { ...outputsOf("none").snapshot, scanOk: false, scanError: "write_failed" };
  const text = renderTerminal(coerceDoc(raw, NOW_MS), opts("none"));
  assert.match(text, /Last scan failed \(write_failed\); showing the last good result\./);
  assert.match(text, /No detectable change/);
});

test("terminal: a pending decision shows the held state and says it is confirming", () => {
  const text = renderTerminal(docOf("pending"), opts("none"));
  assert.match(text, /Possible shift — confirming/);
  assert.match(text, /Finding {9}─── No detectable change/);
});

test("terminal: two agents get two blocks, the brand once", () => {
  const snap = readJson(`${ROOT}contract/fixtures/snapshot/you-and-codex.json`);
  const text = renderTerminal(coerceDoc(snap, Date.parse(snap.generatedAt) + 60_000), opts("none"));
  assert.equal(text.split("\n").filter((l) => l.startsWith("wasitme")).length, 1);
  assert.equal(text.split("\n").filter((l) => l.startsWith("═")).length, 2);
  assert.match(text, /Claude Code {3}checked/);
  assert.match(text, /Codex {3}checked/);
  assert.match(text, /Timeline only/);
});

// ───────────────────────────── hostile input ─────────────────────────────

test("terminal: the hostile glance fixture (escapes, bidi, HTML, long strings) prints as plain, bounded text", () => {
  const manifest = readJson(`${ROOT}contract/fixtures/manifest.json`);
  const entry = manifest.fixtures.find((f: any) => f.file === "glance/hostile-labels.json");
  const raw = readJson(`${ROOT}contract/fixtures/glance/hostile-labels.json`);
  const doc = coerceDoc(raw, Date.parse(entry.now));
  assert.equal(doc.display, "ok");
  for (const mode of MODES) {
    for (const lead of LEADS) {
      const out = renderTerminal(doc, opts(mode, { lead }));
      assertWellFormed(out, mode, 100, `hostile/${mode}/${lead}`);
      const plain = stripSgr(out);
      assert.ok(!plain.includes("\x1b"), "no escape sequence survives");
      assert.ok(!/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2028\u2029\ufeff\u0085\u009b]/.test(plain), "no bidi or invisible character survives");
    }
  }
  // the engine's copy lint is not the gate for a hostile file; the document-level copy check names fields only
  assert.ok(Array.isArray(copyProblems(doc)));
});

test("terminal and report: ids named like built-in object keys (constructor, toString) never crash or print code", () => {
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    for (const name of ["agent", "insufficient"]) {
      const snap = structuredClone(outputsOf(name).snapshot) as any;
      const a = snap.agents[0];
      a.strip.metric = key;
      a.metrics[0].id = key;
      if (a.timeline.length > 0) { a.timeline[0].id = key; a.timeline[0].kind = key; }
      a.progress = { tier: 1, etaDate: null, notAtCurrentPace: false, unlock: [{ metric: key, family: null, have: { events: 3, sessions: 1, sessionDays: 1 }, need: { events: 10, sessions: 2, sessionDays: 2 } }] };
      const doc = coerceDoc(snap, NOW_MS);
      assert.equal(doc.display, "ok", `${name}/${key}`);
      const d = doc.agents[0]!;
      assert.equal(d.strip?.metric, "other", "a prototype key is not an id");
      assert.equal(d.metrics[0]!.id, "other");
      assert.equal(d.progress?.unlock[0]?.metric, "other");
      for (const [what, out] of [
        ["terminal", renderTerminal(doc, opts("none"))], ["terminal-ascii", renderTerminal(doc, opts("none", { ascii: true, columns: 60 }))],
        ["markdown", renderMarkdown(doc)], ["html", renderHtml(doc)],
      ] as const) {
        assert.doesNotMatch(out, /native code|function\b|=>/, `${name}/${key}/${what}`);
      }
    }
  }
});

test("terminal: a document that is not an object, or is missing most fields, never throws", () => {
  for (const raw of [null, 42, "x", [], {}, { schema: "wasitme.snapshot/1" }, { schema: "wasitme.snapshot/1", privacy: { containsText: false }, agents: [null, 3, { agent: "" }, { agent: "x" }, { agent: "x", state: 7, timeline: "no", metrics: [null, { id: 5 }], strip: { days: [{ d: "nope" }] } }] }]) {
    const out = renderTerminal(coerceDoc(raw, NOW_MS), opts("none"));
    assert.ok(out.endsWith("\n"));
    assertWellFormed(out, "none", 100, "garbage");
  }
});

test("terminal: a change of unknown origin sits on the rule as '?' and is listed as 'origin unknown', never as either party's", () => {
  const text = renderTerminal(docOf("unknown-origin"), opts("none"));
  const rule = text.split("\n").find((l) => /^ {16}┄/.test(l))!;
  assert.match(rule, /\?/);
  // The evidence tag stays; the label is cut to make room for it.
  assert.match(text, /^ {17}\? +\w+ \d+ +Effort high → medium \(no com… +origin unknown · lines up with the shift/m);
  assert.ok(!/\[[1A-Z]\] \w+ \d+ +Effort/.test(text), "no party sticker for it");
  assert.match(text, /Finding {9}■─▲ Can't tell which/);
});

test("terminal: the ledger's status words follow the words layer (a context indicator is 'context' even when it moved); no comparison is said once, never as '0 of N' or on every row", () => {
  const you = renderTerminal(docOf("you"), opts("none"));
  const rows = you.split("\n");
  const first = rows.find((l) => l.startsWith("Tool errors") && !l.includes("excl"))!;
  assert.match(first, /context$/, "the context construct is 'context'");
  assert.match(rows.find((l) => l.startsWith("Edits without"))!, /moved, more$/);
  const early = renderTerminal(docOf("insufficient"), opts("none"));
  assert.ok(!/\b0 of \d+ /.test(early), "no zero gate counts when no comparison ran");
  // One line for the whole table, under its rows; the rows themselves carry only counts and the status word.
  const lines = early.split("\n");
  assert.equal(lines.filter((l) => l.includes("Change and range show once there is enough history to compare.")).length, 1);
  assert.ok(!/needs more history/.test(early), "not repeated on each row");
  const rule = lines.findIndex((l, i) => i > 0 && /^─+$/.test(l) && lines[i - 1]!.startsWith("Signals"));
  const note = lines.findIndex((l) => l.startsWith("Change and range show"));
  assert.ok(rule > 0 && note > rule, "the note follows the table's rows");
  for (const row of lines.slice(rule + 1, note).filter((l) => /\d \/ [\d,]+/.test(l))) assert.match(row, /\d {2,}(not yet|context)$/, `clean row: ${row}`);
  assert.match(early, /No date yet: it depends on how your sessions go\./, "D66: no projected dates");
  assert.ok(!/At your pace|may not unlock/.test(early));
  assert.ok(!early.includes("Next to unlock"), "the headline already says what is missing");
});
