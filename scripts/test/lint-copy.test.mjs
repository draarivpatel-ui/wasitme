import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classify, isGlanceSurface, lintText, main, RULES } from "../lint-copy.mjs";
import { makeTree, runMain, runNode, SCRIPTS_DIR } from "./helpers.mjs";

const rulesHit = (rel, text, opts) => lintText(rel, text, opts).map((f) => f.rule);

// Banned phrases are assembled from pieces so this file is not itself a hit for any grep of the repository.
const P = {
  pct: "99" + "%",
  nothingChanged: "Nothing changed" + " on your side",
  recorded: "Nothing recorded changed" + " on your side",
  leaves: "Nothing leaves" + " your Mac",
};

test("every rule has a positive and a negative case (table)", () => {
  const cases = [
    // [rule, text that must hit, text that must not hit, scope]
    ["pct99", `Range is ${P.pct} wide`, "Range is 199% or 0.99% or 1,099%", "docs"],
    ["pct99", "a 99 % interval", "the range ×1.4–×3.5", "copy"],
    ["pct99", "99 percent sure", "999 percent sure", "copy"],
    ["pct99", "９９％ in full-width", "9 of 10", "copy"],
    ["nothing-changed-on-your-side", P.nothingChanged + ", but", P.recorded, "copy"],
    ["nothing-changed-on-your-side", "NOTHING   CHANGED\non your side", "Nothing recorded changed on your side", "docs"],
    ["nothing-leaves-your-mac", P.leaves + ".", "No networking code of ours; WebKit navigation is denied.", "docs"],
    ["nothing-leaves-your-mac", "Nothing ever leaves your mac", "Nothing is sent by wasitme's code", "copy"],
    ["quality", "Better answer quality", "These indicators don't measure answer quality. Evidence, not proof.", "copy"],
    ["quality", "Quality dropped", "These indicators don’t measure answer quality.", "copy"],
    ["score", "A quality score", "Scoreboard-free: the scoreless draw", "copy"],
    ["score", "Scored 9", "Highscorer", "copy"],
    ["dumber-smarter", "It got dumber", "It got dumbbell", "copy"],
    ["dumber-smarter", "smarter than before", "smart replies", "copy"],
    ["nerf", "Was it nerfed?", "Nefertiti and the nerfherder", "copy"],
    ["proves", "This proves it", "Evidence, not proof; it improves", "copy"],
    ["caused-by", "Tool errors caused by the update", "Caused? Not by us", "copy"],
    ["looks-like", "It looks like a regression", "He took a look at likelihoods", "copy"],
    ["looks-like", "Looks  like", "lookalike", "copy"],
    ["after-moved", "After the 2.1.281 update your tool errors rose.", "After the update. Errors rose in October.", "copy"],
    ["after-moved", "after a week they fell", "afterwards the rate was flat", "copy"],
    ["no-change", "No change in tool errors", "No detectable change: changes bigger than about ×1.9 would have shown.", "copy"],
    ["no-change", "There was no change", "Nothing recorded changed", "copy"],
  ];
  for (const [rule, bad, good, scope] of cases) {
    assert.ok(rulesHit("engine/src/words/x.ts", JSON.stringify(bad), { scope, glance: false }).includes(rule), `should hit ${rule}: ${bad}`);
    assert.ok(!rulesHit("engine/src/words/x.ts", JSON.stringify(good), { scope, glance: false }).includes(rule), `should not hit ${rule}: ${good}`);
  }
  // Every rule in the table's universe is exercised.
  const covered = new Set(cases.map((c) => c[0]));
  for (const r of RULES.filter((r) => r.scope !== "glance")) assert.ok(covered.has(r.id), `no test case for ${r.id}`);
});

test("docs scope applies only the three claims; copy scope applies every rule", () => {
  const text = `A quality score that proves it. ${P.pct}. ${P.nothingChanged}. ${P.leaves}.`;
  const docs = rulesHit("docs/METHOD.md", text, { scope: "docs" });
  assert.deepEqual([...new Set(docs)].sort(), ["nothing-changed-on-your-side", "nothing-leaves-your-mac", "pct99"]);
  const copy = new Set(rulesHit("engine/src/words/a.ts", JSON.stringify(text), { scope: "copy", glance: false }));
  for (const r of ["quality", "score", "proves", "pct99", "nothing-changed-on-your-side", "nothing-leaves-your-mac"]) assert.ok(copy.has(r), r);
});

test("code files: only string literals are read (identifiers and comments are not), including template literals", () => {
  const ts = [
    "// it got nerfed, says a comment",
    "const score = 1; const quality = 2;",
    "export const a = `Tool errors ${n} after ${v} rose`;",
    `export const b = "${P.nothingChanged}";`,
  ].join("\n");
  const hits = lintText("engine/src/words/a.ts", ts, { scope: "copy", glance: false });
  assert.deepEqual(hits.map((h) => [h.rule, h.line]).sort(), [["after-moved", 3], ["nothing-changed-on-your-side", 4]]);
});

test("JSX/TSX lines, HTML text, JSON values and CSS content: strings are read", () => {
  assert.deepEqual(rulesHit("plugin/hooks/register.tsx", "<Text>It looks like a regression</Text>", { scope: "copy", glance: false }), ["looks-like"]);
  assert.deepEqual(rulesHit("ui/dist/app.html", "<p>no change</p>", { scope: "copy", glance: false }), ["no-change"]);
  assert.deepEqual(rulesHit("contract/fixtures/g.json", '{"headline": "A score"}', { scope: "copy", glance: false }), ["score"]);
  // CSS selectors and class names are not copy (review finding 11 flipped the old ".score-bar is a hit" expectation);
  // only content: strings are.
  assert.deepEqual(rulesHit("ui/app.css", ".ok {}\n.score-bar { color: red }", { scope: "copy", glance: false }), []);
  const css = lintText("ui/app.css", ".ok {}\n.x::after { content: \"A score\" }", { scope: "copy", glance: false });
  assert.deepEqual(css.map((f) => [f.rule, f.line]), [["score", 2]]);
});

test("Swift: string literals (including multi-line and raw) are read, code and comments are not", () => {
  const swift = [
    "// worse in a comment",
    "let score = 3",
    'Text("A quality score")',
    'let m = """',
    "  It looks like it",
    '  """',
    'let r = #"it "proves" this"#',
  ].join("\n");
  const hits = lintText("macos/Sources/View.swift", swift, { scope: "copy", glance: false });
  assert.deepEqual(hits.map((h) => h.rule).sort(), ["looks-like", "proves", "quality", "score"]);
});

test("shell: comment text is not copy, quoted and heredoc text is", () => {
  const sh = `#!/bin/sh\n# a nerfed comment\necho "It got dumber"\ncat <<EOF\nno change\nEOF\n`;
  assert.deepEqual(rulesHit("packaging/install.sh", sh, { scope: "copy", glance: false }).sort(), ["dumber-smarter", "no-change"]);
});

test("markdown: a phrase wrapped over two lines is still found", () => {
  const hits = lintText("README.md", `Some intro.\n\n${P.nothingChanged.replace(" on", "\non")} and more\n`, { scope: "docs" });
  assert.deepEqual(hits.map((h) => [h.rule, h.line]), [["nothing-changed-on-your-side", 3]]);
});

test("glance rule: verdict words banned on status-line and menu-bar surfaces only", () => {
  const worse = 'let t = "Claude got worse, or better, or nerfed"';
  for (const rel of ["packaging/statusline.sh", "engine/src/output/status-line.ts", "macos/Sources/MenuBarController.swift", "macos/Sources/StatusItem.swift"]) {
    assert.ok(isGlanceSurface(rel, ""), rel);
  }
  for (const rel of ["macos/Sources/Popover.swift", "macos/Sources/MenuBarPopoverView.swift", "ui/src/report.js", "macos/Sources/ControlCenter.swift"]) {
    assert.ok(!isGlanceSurface(rel, ""), rel);
  }
  assert.deepEqual(rulesHit("macos/Sources/MenuBarController.swift", worse, { scope: "copy" }).sort(), ["glance-verdict-word", "glance-verdict-word", "glance-verdict-word", "nerf"].sort());
  assert.deepEqual(rulesHit("macos/Sources/Popover.swift", 'let t = "It feels worse..."', { scope: "copy" }), [], "the popover footer is allowed");
  // The opt-in marker covers engine code that builds status text in a file with another name.
  const marked = '// wasitme:glance-surface\nexport const s = "It got worse";';
  assert.ok(isGlanceSurface("engine/src/words/glance.ts", marked));
  assert.deepEqual(rulesHit("engine/src/words/glance.ts", marked, { scope: "copy" }), ["glance-verdict-word"]);
  // Docs never get the glance rule.
  assert.deepEqual(rulesHit("docs/GUIDE.md", "It feels worse today", { scope: "docs", glance: true }), []);
});

test("classify: copy, docs, internal documents, tests, reference code", () => {
  assert.equal(classify("engine/src/words/verdict.ts"), "copy");
  assert.equal(classify("plugin/skills/report/SKILL.md"), "copy");
  assert.equal(classify("macos/Sources/App/main.swift"), "copy");
  assert.equal(classify("contract/fixtures/glance-agent.json"), "copy");
  assert.equal(classify("README.md"), "docs");
  assert.equal(classify("docs/METHOD.md"), "docs");
  assert.equal(classify("changelog.d/x.added.md"), "docs");
  assert.equal(classify("docs/PLAN.md"), null);
  assert.equal(classify("docs/research/01-market.md"), null);
  assert.equal(classify("engine/test/words.test.ts"), null);
  assert.equal(classify("macos/Tests/AppTests/X.swift"), null);
  assert.equal(classify("plugin/reference/mod-spike/a.tsx"), null);
  assert.equal(classify("ui/node_modules/p/a.js"), null);
  assert.equal(classify("engine/src/analysis/stats/x.ts"), null, "engine internals are not copy");
  assert.equal(classify("CLAUDE.md"), null);
  assert.equal(classify("design/demo-data.v2.json"), "copy", "the README-screenshot source (D21) is copy");
  assert.equal(classify("design/demo-data.json"), null, "v1 is never rendered (D21)");
});

test("CLI: default scan finds violations in copy and docs, skips tests and internal documents", () => {
  const t = makeTree({
    "engine/src/words/verdict.ts": `export const v = "${P.nothingChanged}";\n`,
    "engine/test/words.test.ts": `export const v = "${P.nothingChanged}";\n`,
    "docs/PLAN.md": `${P.nothingChanged}\n`,
    "docs/METHOD.md": `The interval is ${P.pct}.\n`,
    "README.md": "Fine.\n",
  });
  try {
    const r = runMain(main, ["--root", t.root]);
    assert.equal(r.code, 1);
    assert.match(r.err, /engine\/src\/words\/verdict\.ts:1: \[nothing-changed-on-your-side\]/);
    assert.match(r.err, /docs\/METHOD\.md:1: \[pct99\]/);
    assert.ok(!r.err.includes("words.test.ts") && !r.err.includes("PLAN.md"));
    assert.match(r.out, /3 file\(s\) scanned \[copy=1 \(glance=0\) docs=2\], 2 violation\(s\)/);
  } finally {
    t.cleanup();
  }
});

test("CLI: a clean tree exits 0; a tree with nothing to scan exits 2 (never vacuous)", () => {
  const clean = makeTree({ "README.md": "wasitme tells you which side changed.\n", "engine/src/words/a.ts": 'export const a = "Too early to tell.";\n' });
  const empty = makeTree({ "engine/src/analysis/x.ts": "export {};\n" });
  try {
    assert.equal(runMain(main, ["--root", clean.root]).code, 0);
    const r = runMain(main, ["--root", empty.root]);
    assert.equal(r.code, 2);
    assert.match(r.err, /nothing to scan/);
  } finally {
    clean.cleanup();
    empty.cleanup();
  }
});

test("allow-list: silences quoted examples by needle; a stale entry or a malformed file fails", () => {
  const t = makeTree({
    "docs/METHOD.md": `We never print ${P.pct} because the range is calibrated.\n\nSeparately ${P.pct} appears here too.\n`,
    "scripts/lint-copy.allow": "pct99 | docs/METHOD.md | never print | quoting the banned literal as the example\n",
  });
  try {
    const r = runMain(main, ["--root", t.root]);
    assert.equal(r.code, 1, "only the line the needle names is silenced");
    assert.match(r.err, /docs\/METHOD\.md:3: \[pct99\]/);
    assert.ok(!r.err.includes("METHOD.md:1:"));

    // fix the second line: now clean, and the entry is used
    writeFile(t.root, "docs/METHOD.md", `We never print ${P.pct} because the range is calibrated.\n`);
    assert.equal(runMain(main, ["--root", t.root]).code, 0);

    // an entry that matches nothing fails the full scan
    writeFile(t.root, "scripts/lint-copy.allow", "pct99 | docs/METHOD.md | never print | ok\npct99 | docs/METHOD.md | words that are not there | stale\n");
    const stale = runMain(main, ["--root", t.root]);
    assert.equal(stale.code, 1);
    assert.match(stale.err, /\[stale-allow\].*matches nothing/);

    // but staleness is not judged when only some paths are scanned
    assert.equal(runMain(main, ["--root", t.root, join(t.root, "docs/METHOD.md")]).code, 0);

    // malformed allow-list: usage error
    writeFile(t.root, "scripts/lint-copy.allow", "pct99 | docs/METHOD.md | needle but no reason\n");
    const bad = runMain(main, ["--root", t.root]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /lint-copy\.allow:1:/);
    writeFile(t.root, "scripts/lint-copy.allow", "not-a-rule | a | b | c\n");
    assert.equal(runMain(main, ["--root", t.root]).code, 2);
  } finally {
    t.cleanup();
  }
});

test("CLI: explicit paths and --as; unknown options and paths are usage errors", () => {
  const t = makeTree({ "notes/draft.md": "It proves nothing.\n\n99% sure.\n" });
  try {
    const file = join(t.root, "notes", "draft.md");
    const asDocs = runMain(main, ["--root", t.root, "--as", "docs", file]);
    assert.equal(asDocs.code, 1);
    assert.match(asDocs.err, /\[pct99\]/);
    assert.ok(!asDocs.err.includes("[proves]"), "docs scope has no wording rules");
    const asCopy = runMain(main, ["--root", t.root, "--as", "copy", file]);
    assert.match(asCopy.err, /\[proves\]/);
    assert.equal(runMain(main, ["--root", t.root, join(t.root, "missing.md")]).code, 2);
    assert.equal(runMain(main, ["--bogus"]).code, 2);
    assert.equal(runMain(main, ["--as", "nope", file]).code, 2);
    assert.equal(runMain(main, ["--list-rules"]).code, 0);
  } finally {
    t.cleanup();
  }
});

test("CLI process: exit codes and stderr format", () => {
  const t = makeTree({ "ui/app.html": "<p>Nothing leaves your Mac</p>\n" });
  try {
    const r = runNode(join(SCRIPTS_DIR, "lint-copy.mjs"), ["--root", t.root]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ui\/app\.html:1: \[nothing-leaves-your-mac\] "nothing leaves your mac"/);
  } finally {
    t.cleanup();
  }
});

function writeFile(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

// ---------------------------------------------------------------------------------------------------------------
// Review fixes (WP-01Δ)
// ---------------------------------------------------------------------------------------------------------------

const copy = (rel, text) => rulesHit(rel, text, { scope: "copy", glance: false });

test("review #11: CSS and SVG markup, class names, import specifiers and error idioms are not copy", () => {
  assert.deepEqual(copy("ui/app.css", ".bar { width: 99%; }\n@keyframes pulse { 99% { opacity: 1 } }\n/* looks like a card */\n.score-badge, .quality { color: red }"), []);
  assert.deepEqual(copy("ui/chart.svg", '<svg><linearGradient><stop offset="99%"/></linearGradient><g class="score-badge"/></svg>'), []);
  assert.deepEqual(copy("ui/chart.svg", "<svg><text>A score</text></svg>"), ["score"], "SVG text nodes are copy");
  assert.deepEqual(copy("engine/src/output/report.ts", 'import { q } from "../analysis/quality.js";\nimport "./score.js";\nconst m = await import("./score.js");'), []);
  assert.deepEqual(copy("engine/src/cli/main.ts", [
    '"does not look like a directory"', '"caused by ENOENT"', '"makes no change to your settings"', '"doesn\'t look like a session log"',
  ].join(";\n")), []);
  // the idioms are narrow: the verdict forms still hit
  assert.deepEqual(copy("engine/src/cli/main.ts", '"It looks like a regression"; "caused by the update"; "no change in tool errors"').sort(), ["caused-by", "looks-like", "no-change"]);
});

test("review #11: the disclaimer and banned phrases are found through HTML entities, JSON escapes and markup", () => {
  for (const apos of ["&rsquo;", "&#39;", "&apos;", "&#x27;"]) {
    assert.deepEqual(copy("ui/report.html", `<p>These indicators don${apos}t measure answer quality.</p>`), [], apos);
  }
  assert.deepEqual(copy("contract/fixtures/x.json", '{"note": "These indicators don\\u2019t measure answer quality."}'), []);
  assert.deepEqual(copy("ui/report.html", "<p>It looks&nbsp;like a regression; no&nbsp;change.</p>").sort(), ["looks-like", "no-change"]);
  assert.deepEqual(copy("contract/fixtures/x.json", '{"headline": "\\u0073core 9"}'), ["score"], "JSON unicode escapes decode");
  assert.deepEqual(copy("contract/fixtures/x.json", '{"score": 1, "quality": "high", "label": "best quality"}'), ["quality"], "keys are names, values are copy");
  assert.deepEqual(copy("ui/report.html", "<p>It looks\n  like a regression</p>"), ["looks-like"], "wrapped over two lines");
  assert.deepEqual(copy("ui/report.html", "<p>It <b>looks</b> <em>like</em> it</p>"), ["looks-like"], "inline tags dissolve");
  assert.deepEqual(copy("ui/report.html", "<li>It looks</li><li>like new</li>"), [], "block tags separate");
  assert.deepEqual(copy("plugin/skills/report/SKILL.md", "It looks **like** a regression."), ["looks-like"], "markdown emphasis");
  assert.deepEqual(copy("plugin/skills/report/SKILL.md", "See [the notes](docs/quality-score.md)."), [], "a link target is not copy");
  assert.deepEqual(copy("ui/report.html", '<img alt="A score card" src="a.png">'), ["score"], "visible attributes are copy");
});

test("review #11: after-moved reads past abbreviations (Sep., e.g., vs.) but stops at a real sentence end", () => {
  assert.deepEqual(copy("engine/src/words/a.ts", '"after the Sep. 30 update, tool errors doubled"'), ["after-moved"]);
  assert.deepEqual(copy("engine/src/words/a.ts", '"after e.g. a restart, errors fell"'), ["after-moved"]);
  assert.deepEqual(copy("engine/src/words/a.ts", '"After the update. Errors rose in October."'), []);
});

test("review #16: after-moved is linear on long one-line JSON (was quadratic)", () => {
  const big = JSON.stringify({ s: "after ".repeat(40_000) }); // 240 KB on one line: 5 s before the fix
  const t0 = Date.now();
  assert.deepEqual(copy("contract/fixtures/big.json", big), []);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test("review #12: scope holes closed (README anywhere, .github, .claude-plugin, demo data v2, docs/reference)", () => {
  assert.equal(classify("engine/README.md"), "docs");
  assert.equal(classify(".github/ISSUE_TEMPLATE/bug.yml"), "docs");
  assert.equal(classify("AGENTS.md"), "docs");
  assert.equal(classify("PRIVACY.md"), "docs");
  assert.equal(classify("METHOD.md"), "docs");
  assert.equal(classify(".claude-plugin/marketplace.json"), "copy");
  assert.equal(classify("docs/reference/cli.md"), "docs", "only code reference/ trees are excluded");
  assert.equal(classify("engine/reference/draft/x.ts"), null);
  assert.equal(classify("spikes-tracked/web/README.md"), null, "spike evidence is internal");
});

test("review #12: new text formats and extensionless scripts are scanned; per-scope counts; --require-copy", () => {
  const t = makeTree({
    "macos/Resources/Localizable.xcstrings": '{"strings": {"k": {"localizations": {"en": {"stringUnit": {"value": "A score"}}}}}}\n',
    "plugin/statusline": '#!/bin/sh\necho "It got dumber"\n',
    "plugin/LICENSE": "no shebang, not copy: score\n",
    "docs/reference/cli.md": `Nothing leaves your Mac.\n`,
    "README.md": "fine\n",
  });
  try {
    const r = runMain(main, ["--root", t.root]);
    assert.equal(r.code, 1);
    assert.match(r.err, /Localizable\.xcstrings:1: \[score\]/);
    assert.match(r.err, /plugin\/statusline:2: \[dumber-smarter\]/);
    assert.match(r.err, /docs\/reference\/cli\.md:1: \[nothing-leaves-your-mac\]/);
    assert.ok(!r.err.includes("LICENSE"));
    assert.match(r.out, /4 file\(s\) scanned \[copy=2 \(glance=1\) docs=2\]/);
  } finally {
    t.cleanup();
  }
  const docsOnly = makeTree({ "README.md": "fine\n" });
  try {
    assert.equal(runMain(main, ["--root", docsOnly.root]).code, 0);
    const req = runMain(main, ["--root", docsOnly.root, "--require-copy"]);
    assert.equal(req.code, 2);
    assert.match(req.err, /no file in the copy scope/);
    for (const bad of [["--root"], ["--allow"], ["--as"]]) assert.equal(runMain(main, bad).code, 2, bad.join(" "));
  } finally {
    docsOnly.cleanup();
  }
});

test("review #13: an allow-list entry covers its quoted example, not a later violation in the same paragraph", () => {
  const para = `We never print ${P.pct} as a label; ${"padding words ".repeat(12)}and the interval has ${P.pct} coverage.\n`;
  const t = makeTree({ "docs/METHOD.md": para, "scripts/lint-copy.allow": "pct99 | docs/METHOD.md | never print | quoted as the example of what not to write\n" });
  try {
    const r = runMain(main, ["--root", t.root]);
    assert.equal(r.code, 1);
    assert.equal((r.err.match(/\[pct99\]/g) ?? []).length, 1, "only the far one remains");
  } finally {
    t.cleanup();
  }
});

test("review #17: status bar paths and engine glance/statusline output are glance surfaces; shell code is not copy", () => {
  assert.ok(isGlanceSurface("macos/Sources/StatusBarController.swift", ""));
  assert.ok(isGlanceSurface("engine/src/output/glance.ts", ""));
  assert.ok(isGlanceSurface("engine/src/output/statusline.ts", ""));
  const sh = '#!/bin/sh\ncase "$s" in\n  worse) better=1 ;;\nesac\necho "state: $s"\n';
  assert.deepEqual(rulesHit("packaging/statusline.sh", sh, { scope: "copy" }), [], "a case arm and a variable are code");
  assert.deepEqual(rulesHit("packaging/statusline.sh", '#!/bin/sh\necho "It got worse"\nprintf \'%s\\n\' better\n', { scope: "copy" }), ["glance-verdict-word", "glance-verdict-word"]);
});
