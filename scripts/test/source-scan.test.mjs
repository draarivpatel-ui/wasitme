import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  allowWindow, applyAllow, cssContentStrings, decodeEntities, globToRegExp, isPlainSwiftLiteral, jsonStrings, jsStrings,
  lineSegments, listFiles, listFilesDetailed, markdownParagraphs, markupSegments, maskJsComments, matchesGlob,
  normalizeText, paragraphs, parseAllowList, readFileInfo, scanSwift, shebangKind, shellCopy, shellLines, staleEntries,
  swiftCallArguments,
} from "../lib/source-scan.mjs";
import { git, hasGit, makeTree } from "./helpers.mjs";

test("globs: ** crosses directories, * and ? do not, anchored", () => {
  assert.ok(matchesGlob("engine/src/words/a.ts", "engine/src/words/**"));
  assert.ok(matchesGlob("a/b/reference/c.md", "**/reference/**"));
  assert.ok(matchesGlob("reference/c.md", "**/reference/**"));
  assert.ok(!matchesGlob("a/references/c.md", "**/reference/**"));
  assert.ok(matchesGlob("README.md", "*.md"));
  assert.ok(!matchesGlob("docs/README.md", "*.md"));
  assert.ok(matchesGlob("x.test.ts", "**/*.test.*"));
  assert.ok(matchesGlob("a.b", "a?b"));
  assert.ok(!matchesGlob("a/b", "a?b"));
  assert.ok(globToRegExp("a.b+c").test("a.b+c"), "regex metacharacters are literal");
  assert.ok(!globToRegExp("a.b").test("axb"));
});

test("normalizeText: case, curly quotes, NBSP, zero-width characters, full-width digits, whitespace runs", () => {
  assert.equal(normalizeText("Don’t   Measure\n Quality"), "don't measure quality");
  assert.equal(normalizeText("no​thing"), "nothing");
  assert.equal(normalizeText("９９％"), "99%");
});

test("allow-list: parse, errors, matching by rule + glob + needle, use counting, stale entries", () => {
  const { entries, errors } = parseAllowList(
    ["# comment", "", "pct99 | docs/*.md | the interval level | quoted in the method note", "* | README.md | Example Text | any rule"].join("\n"),
    { source: "t.allow", rules: ["pct99", "score"] },
  );
  assert.deepEqual(errors, []);
  assert.equal(entries.length, 2);
  const f = { rule: "pct99", file: "docs/METHOD.md" };
  assert.ok(applyAllow(entries, f, "We use the INTERVAL   level of 99%"), "needle is case- and whitespace-insensitive");
  assert.ok(!applyAllow(entries, { rule: "score", file: "docs/METHOD.md" }, "the interval level"), "rule must match");
  assert.ok(!applyAllow(entries, { rule: "pct99", file: "docs/sub/METHOD.md" }, "the interval level"), "glob must match");
  assert.ok(!applyAllow(entries, f, "something else entirely"), "needle must occur");
  assert.ok(applyAllow(entries, { rule: "score", file: "README.md" }, "see example text here"), '"*" matches any rule');
  assert.deepEqual(staleEntries(entries), []);

  const fresh = parseAllowList("pct99 | a | b | why", { rules: ["pct99"] }).entries;
  assert.equal(staleEntries(fresh).length, 1);

  for (const bad of ["pct99 | a | b", "pct99 | a | b | ", "nope | a | b | why", "pct99 |  | b | why", "only one field"]) {
    assert.equal(parseAllowList(bad, { rules: ["pct99"] }).errors.length, 1, bad);
  }
});

test("jsStrings: literals, templates (placeholders joined), comments and regex literals skipped, line numbers", () => {
  const src = [
    'const a = "plain one";',
    "// \"in a comment\"",
    "const re = /\"[a-z]+'/g; const s = 'it\\'s';",
    "const t = `before ${x + \"nested\"} after ${y}`;",
    "/* \"block\" */ const d = 8 / 2; const u = \"\\u2019 smart\";",
    "return `multi",
    "line`;",
  ].join("\n");
  const got = jsStrings(src);
  const texts = got.map((s) => s.text);
  assert.deepEqual(texts, ["plain one", "it's", "nested", "before {} after {}", "’ smart", "multi\nline"]);
  assert.deepEqual(got.map((s) => s.line), [1, 3, 4, 4, 5, 6]);
  assert.ok(!texts.some((t) => t.includes("comment") || t.includes("block")));
});

test("jsStrings: division after ) and a regex after return do not derail the lexer", () => {
  const got = jsStrings('const q = (a + b) / 2; const w = "after"; function f() { return /"/.test(x) ? "yes" : "no"; }');
  assert.deepEqual(got.map((s) => s.text), ["after", "yes", "no"]);
});

test("scanSwift: masks comments, strings, raw and multi-line strings; interpolation marked; strings recorded", () => {
  const src = [
    "import SwiftUI",
    "// @State in a comment",
    "/* @Entry /* nested */ still a comment */",
    "struct A: View {",
    "  @State private var x = 0 // trailing @Preview",
    '  let s = "a \\(x) b @State"',
    '  let r = #"raw "quoted" \\#(x) end"#',
    '  let ml = """',
    "  multi @Entry",
    '  line \\(foo("inner @Preview"))',
    '  """',
    "}",
    "#Preview { A() }",
  ].join("\n");
  const { code, strings, lineOf } = scanSwift(src);
  assert.equal(code.length, src.length, "offsets are preserved");
  assert.equal(code.split("\n").length, src.split("\n").length, "newlines are preserved");
  assert.ok(code.includes("@State private var x = 0"), "real code is kept");
  assert.ok(code.includes("#Preview { A() }"), "#Preview is code, not a string");
  assert.ok(!/@Entry|@Preview|@State in|nested/.test(code.replace("@State private", "")), "comments and strings are masked");
  assert.equal(strings.length, 4);
  const byText = Object.fromEntries(strings.map((s) => [s.text, s]));
  assert.equal(byText["a {} b @State"].interpolated, true);
  assert.equal(byText["inner @Preview"].interpolated, false);
  assert.equal(byText["raw \"quoted\" {} end"].line, 7);
  assert.equal(lineOf(src.indexOf("#Preview")), 13);
});

test("scanSwift: an unterminated string stops at the end of its line and does not swallow the file", () => {
  const { code } = scanSwift('let a = "oops\nlet b = 1 // c\n@State var z = 2\n');
  assert.ok(code.includes("let b = 1"));
  assert.ok(code.includes("@State var z = 2"));
});

test("swiftCallArguments and isPlainSwiftLiteral", () => {
  const { code } = scanSwift('web.callAsyncJavaScript("return 1", arguments: ["k": f(1, 2)], in: nil)\nweb.evaluateJavaScript("a\\(b)")\nweb.evaluateJavaScript(js + "x")');
  const open1 = code.indexOf("(");
  const args = swiftCallArguments(code, open1);
  assert.equal(args.length, 3);
  assert.ok(isPlainSwiftLiteral(args[0].text));
  assert.ok(args[1].text.startsWith("arguments:"));
  const open2 = code.indexOf("evaluateJavaScript") + "evaluateJavaScript".length;
  assert.ok(!isPlainSwiftLiteral(swiftCallArguments(code, open2)[0].text), "interpolation is not plain");
  const open3 = code.lastIndexOf("evaluateJavaScript") + "evaluateJavaScript".length;
  assert.ok(!isPlainSwiftLiteral(swiftCallArguments(code, open3)[0].text), "concatenation is not plain");
  assert.equal(swiftCallArguments("foo(a, (b", 3), null, "unbalanced parentheses");
  assert.ok(isPlainSwiftLiteral('#"___"#'));
  assert.ok(isPlainSwiftLiteral('"""\n___\n"""'));
  assert.ok(!isPlainSwiftLiteral('"___" + x'));
});

test("shellLines: comments removed, # inside quotes and $# kept, shebang dropped", () => {
  const got = shellLines('#!/bin/sh\n# whole line\necho "a # b" # trailing\nn=$#\necho \'x # y\'\n');
  assert.deepEqual(got.map((l) => l.text.trim()), ['echo "a # b"', "n=$#", "echo 'x # y'"]);
  assert.deepEqual(got.map((l) => l.line), [3, 4, 5]);
});

test("paragraphs join wrapped lines; lineSegments keeps one line each", () => {
  const p = paragraphs("one\ntwo\n\n\nthree\n");
  assert.deepEqual(p, [{ text: "one\ntwo", line: 1 }, { text: "three", line: 5 }]);
  assert.deepEqual(lineSegments("a\n\nb"), [{ text: "a", line: 1 }, { text: "b", line: 3 }]);
});

test("listFiles (plain directory): walks, skips node_modules/.git/.build/dist and symlinks", () => {
  const t = makeTree({ "a.txt": "x", "d/b.txt": "x", "node_modules/p/c.txt": "x", ".build/z.txt": "x", "dist/q.txt": "x" });
  try {
    symlinkSync(t.root, join(t.root, "d", "loop"));
    assert.deepEqual(listFiles(t.root), ["a.txt", "d/b.txt"]);
  } finally {
    t.cleanup();
  }
});

test("listFiles (git): tracked and untracked files, not ignored ones; deleted files dropped", { skip: !hasGit }, () => {
  const t = makeTree({ ".gitignore": "private/\n", "tracked.txt": "x", "gone.txt": "x" });
  try {
    git(t.root, "init", "-q");
    git(t.root, "add", ".gitignore", "tracked.txt", "gone.txt");
    mkdirSync(join(t.root, "private"));
    writeFileSync(join(t.root, "private", "secret.txt"), "x");
    writeFileSync(join(t.root, "untracked.txt"), "x");
    rmSync(join(t.root, "gone.txt")); // still in the index, no longer on disk
    assert.deepEqual(listFiles(t.root), [".gitignore", "tracked.txt", "untracked.txt"]);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Review fixes (WP-01Δ)
// ---------------------------------------------------------------------------------------------------------------

test("readFileInfo: UTF-16 with a byte-order mark decodes; binary and oversize say why and keep the bytes", () => {
  const t = makeTree({});
  try {
    writeFileSync(join(t.root, "le.strings"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('"k" = "v";', "utf16le")]));
    writeFileSync(join(t.root, "be.strings"), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('"k" = "v";', "utf16le").swap16()]));
    writeFileSync(join(t.root, "odd.strings"), Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00])); // odd length: no throw
    writeFileSync(join(t.root, "bin.dat"), Buffer.from([1, 0, 2]));
    writeFileSync(join(t.root, "big.txt"), "x".repeat(20));
    assert.equal(readFileInfo(t.root, "le.strings").text, '"k" = "v";');
    assert.equal(readFileInfo(t.root, "be.strings").text, '"k" = "v";');
    assert.equal(readFileInfo(t.root, "odd.strings").text, "A");
    const bin = readFileInfo(t.root, "bin.dat");
    assert.deepEqual([bin.text, bin.reason, bin.buf.length], [null, "binary", 3]);
    const big = readFileInfo(t.root, "big.txt", 10);
    assert.deepEqual([big.text, big.reason, big.buf.length], [null, "oversize", 20]);
    assert.equal(readFileInfo(t.root, "missing").reason, "unreadable");
  } finally {
    t.cleanup();
  }
});

test("listFilesDetailed: symlinks are listed separately (never followed); viaGit says where the list came from", () => {
  const t = makeTree({ "a.txt": "x" });
  try {
    symlinkSync("a.txt", join(t.root, "link"));
    assert.deepEqual(listFilesDetailed(t.root), { files: ["a.txt"], symlinks: ["link"], viaGit: false });
    if (hasGit) {
      git(t.root, "init", "-q");
      assert.deepEqual(listFilesDetailed(t.root), { files: ["a.txt"], symlinks: ["link"], viaGit: true });
    }
  } finally {
    t.cleanup();
  }
});

test("allow-list: allowWildcard:false rejects '*'; a finding's window limits where the needle may come from", () => {
  assert.equal(parseAllowList("* | a | b | why", { allowWildcard: false }).errors.length, 1);
  assert.equal(parseAllowList("* | a | b | why").errors.length, 0, "allowed by default (lint-copy)");
  const { entries } = parseAllowList("pct99 | a.md | quoted example | why");
  const text = normalizeText(`quoted example 99% ${"z".repeat(200)} 99% again`);
  const near = { rule: "pct99", file: "a.md", window: allowWindow(text, text.indexOf("99%"), 3) };
  const far = { rule: "pct99", file: "a.md", window: allowWindow(text, text.lastIndexOf("99%"), 3) };
  assert.ok(applyAllow(entries, near, "unused"));
  assert.ok(!applyAllow(entries, far, "unused"));
});

test("jsStrings marks module specifiers; maskJsComments keeps strings and regexes", () => {
  const got = jsStrings('import a from "./x.js";\nexport * from "y";\nconst m = import("z"), r = require("w");\nconst s = "copy"; Array.from("k");');
  assert.deepEqual(got.filter((x) => x.specifier).map((x) => x.text), ["./x.js", "y", "z", "w"]);
  assert.deepEqual(got.filter((x) => !x.specifier).map((x) => x.text), ["copy", "k"]);
  const masked = maskJsComments('const u = "https://a//b"; // $.fs here\n/* $.env */ const r = /\\/\\/x/; $.fs.read(p)');
  assert.ok(masked.includes('"https://a//b"') && masked.includes("/\\/\\/x/") && masked.includes("$.fs.read"));
  assert.ok(!masked.includes("$.fs here") && !masked.includes("$.env"));
  assert.equal(masked.length, 'const u = "https://a//b"; // $.fs here\n/* $.env */ const r = /\\/\\/x/; $.fs.read(p)'.length);
});

test("shellCopy: quoted text, heredocs and echo/printf words; never code", () => {
  const got = shellCopy('#!/bin/sh\n# comment\ncase $x in worse) better=1 ;; esac\necho "quoted words"\necho plain words $v\ncat <<-\'EOF\'\n\tbody line\n\tEOF\nrm -rf "$d"\n');
  assert.deepEqual(got.map((s) => [s.text.trim(), s.line]), [["quoted words", 4], ["plain words", 5], ["body line", 7]]);
});

test("markup, CSS, JSON and markdown segmenters; entities; shebangs", () => {
  assert.equal(decodeEntities("don&rsquo;t &amp; &#39;x&#x27; &nbsp;&unknown;"), "don’t & 'x'  &unknown;".replace(" ", " "));
  assert.deepEqual(markupSegments('<p class="score">a <b>b</b>\nc</p><p title="T x">d</p><!-- e --><style>.q{}</style>').map((s) => s.text), ["a b\nc", "T x", "d"]);
  assert.deepEqual(cssContentStrings('.a { content: "x" } /* content: "no" */ .b{width:99%}').map((s) => s.text), ["x"]);
  assert.deepEqual(jsonStrings('{"k": "v",\n "list": ["a", {"inner": "b"}]}').map((s) => [s.text, s.line]), [["v", 1], ["a", 2], ["b", 2]]);
  assert.deepEqual(markdownParagraphs("a **b** [c](d.md) `e`").map((s) => s.text), ["a b [c] e"]);
  assert.equal(shebangKind("#!/bin/sh\n"), "sh");
  assert.equal(shebangKind("#!/usr/bin/env bash\n"), "sh");
  assert.equal(shebangKind("#!/usr/bin/env node\n"), "js");
  assert.equal(shebangKind("#!/usr/bin/env python3\n"), null);
  assert.equal(shebangKind("no shebang"), null);
});
