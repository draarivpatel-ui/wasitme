#!/usr/bin/env node
// check-privacy.mjs - fails if any "canary" string from the hostile test corpus shows up in wasitme output.
//
// Usage:
//   node scripts/check-privacy.mjs [options] <file|dir|-> [more ...]
//
//   <file|dir>            output files to scan (directories are scanned recursively, symlinks are not followed);
//                         "-" reads standard input (pipe a report in)
//   --canaries FILE       canary list (default: testdata/hostile/CANARIES.txt next to this repo's scripts/)
//   --require-canaries    treat a missing default canary file as an error instead of a skip
//   --exclude PATH        do not scan PATH (file or directory); repeatable
//   --self-test           run this script's own tests
//
// Canary file format: one canary per line, UTF-8. Blank lines are ignored, and so are comment lines that start with
// "#" followed by a space (or a lone "#"). A line like "#tag" is a canary. Canaries are synthetic strings planted in
// the hostile corpus (fake prompts, paths, secrets); they are never real data, so a canary hit is reported by its
// number and line in the canary file, never by echoing text, and no surrounding output text is ever printed.
//
// Exit codes: 0 clean (or skipped because the default canary file does not exist yet), 1 canary found,
// 2 usage / IO error (also: explicit canary file missing, empty canary list, no input files).
//
// Each canary is searched case-insensitively in the raw text and in common re-encodings an output format might
// apply: JSON escapes (including \uXXXX and \/), URL encoding, HTML entities, Unicode NFC/NFD. For JSON and JSONL
// files the decoded strings are searched too, and a whitespace-collapsed and a punctuation-stripped view catch
// line-wrapping or reformatting (the latter only for canaries with at least 10 letters/digits). File names are
// checked as well.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SELF));
const DEFAULT_CANARIES = join(REPO_ROOT, "testdata", "hostile", "CANARIES.txt");
const MIN_FUZZY_LENGTH = 10;

// ---------------------------------------------------------------------------------------------------------------
// Canaries
// ---------------------------------------------------------------------------------------------------------------

/** Parse the canary file. Returns [{n, line, value}] with n counting from 1, duplicates removed. */
export function parseCanaries(text) {
  const out = [];
  const seen = new Set();
  text.replace(/^\uFEFF/, "").split("\n").forEach((raw, i) => {
    const value = raw.replace(/\r$/, "").trim();
    if (!value || value === "#" || value.startsWith("# ")) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ n: out.length + 1, line: i + 1, value });
  });
  return out;
}

const asciiEscape = (s) => s.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const htmlEscape = (s, hex) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, hex ? "&#x27;" : "&#39;");
const collapse = (s) => s.replace(/\s+/g, " ").trim();
const strip = (s) => s.replace(/[^\p{L}\p{N}]+/gu, "");

/** All encodings of a canary to look for (lower-cased, de-duplicated). `plain` ones also apply to decoded JSON. */
export function variantsOf(value) {
  const found = new Map();
  const add = (name, v, plain = false) => {
    const needle = v.toLowerCase();
    if (needle && !found.has(needle)) found.set(needle, { name, needle, plain });
  };
  const json = JSON.stringify(value).slice(1, -1);
  const jsonSlash = json.replace(/\//g, "\\/");
  add("raw", value, true);
  add("unicode-nfc", value.normalize("NFC"), true);
  add("unicode-nfd", value.normalize("NFD"), true);
  add("json-escaped", json);
  add("json-slash-escaped", jsonSlash);
  add("json-ascii-escaped", asciiEscape(json));
  add("json-ascii-slash-escaped", asciiEscape(jsonSlash));
  add("url-encoded", encodeURIComponent(value));
  add("url-encoded-plus", encodeURIComponent(value).replace(/%20/g, "+"));
  add("html-escaped", htmlEscape(value, false));
  add("html-escaped-hex", htmlEscape(value, true));
  return [...found.values()];
}

export function prepareCanaries(canaries) {
  return canaries.map((c) => {
    const lower = c.value.toLowerCase();
    const fuzzy = strip(lower);
    return {
      ...c,
      variants: variantsOf(c.value),
      collapsed: collapse(lower),
      fuzzy: fuzzy.length >= MIN_FUZZY_LENGTH ? fuzzy : undefined,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Scanning content
// ---------------------------------------------------------------------------------------------------------------

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le", 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return swapped.swap16().toString("utf16le");
  }
  return buf.toString("utf8");
}

function collectStrings(root, into) {
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") into.push(v);
    else if (Array.isArray(v)) for (const x of v) stack.push(x);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { into.push(k); stack.push(x); }
  }
}

/** Strings decoded from a JSON document, or from each line of a JSONL file; "" if the text is neither. */
function decodedJsonStrings(text) {
  const strings = [];
  const start = text.trimStart()[0];
  if (start !== "{" && start !== "[") return "";
  try {
    collectStrings(JSON.parse(text), strings);
  } catch {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || (t[0] !== "{" && t[0] !== "[")) continue;
      try { collectStrings(JSON.parse(t), strings); } catch { /* not a JSON line */ }
    }
  }
  return strings.join("\n");
}

const lineOf = (s, index) => {
  let line = 1;
  for (let i = s.indexOf("\n"); i !== -1 && i < index; i = s.indexOf("\n", i + 1)) line++;
  return line;
};

/**
 * Scan one file's bytes. Returns one hit per canary: {n, line, view, variant, at?}.
 * `n`/`line` identify the canary in the canary file; `at` is the line in the scanned file (text view only).
 */
export function scanContent(buf, prepared) {
  const text = decodeText(buf).toLowerCase();
  const decoded = decodedJsonStrings(text).toLowerCase();
  const collapsed = collapse(text);
  const stripped = strip(text);
  const strippedDecoded = decoded ? strip(decoded) : "";
  const hits = [];
  for (const c of prepared) {
    let hit;
    for (const v of c.variants) {
      const idx = text.indexOf(v.needle);
      if (idx !== -1) { hit = { view: "text", variant: v.name, at: lineOf(text, idx) }; break; }
    }
    if (!hit && decoded) {
      const v = c.variants.find((x) => x.plain && decoded.includes(x.needle));
      if (v) hit = { view: "decoded-json", variant: v.name };
    }
    if (!hit && c.collapsed.includes(" ") && collapsed.includes(c.collapsed)) hit = { view: "whitespace-collapsed", variant: "raw" };
    if (!hit && c.fuzzy && (stripped.includes(c.fuzzy) || (strippedDecoded && strippedDecoded.includes(c.fuzzy)))) {
      hit = { view: "punctuation-stripped", variant: "raw" };
    }
    if (hit) hits.push({ n: c.n, line: c.line, ...hit });
  }
  return hits;
}

/** Canary hits in a file name (never its directory part). */
export function scanName(name, prepared) {
  const lower = name.toLowerCase();
  const stripped = strip(lower);
  return prepared
    .filter((c) => c.variants.some((v) => lower.includes(v.needle)) || (c.fuzzy && stripped.includes(c.fuzzy)))
    .map((c) => ({ n: c.n, line: c.line, view: "file-name", variant: "any" }));
}

// ---------------------------------------------------------------------------------------------------------------
// Collecting input files
// ---------------------------------------------------------------------------------------------------------------

function isInside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Expand inputs into [{path, label, name}] (label is shown to the user; name is checked for canaries). */
export function collectFiles(inputs, { skip = [], excluded = [] } = {}) {
  const files = [];
  const problems = [];
  const skipSet = new Set(skip.map((p) => resolve(p)));
  const isExcluded = (p) => skipSet.has(p) || excluded.some((e) => isInside(p, e));
  const walk = (dir, root) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) { problems.push(`cannot read directory ${dir}: ${err.code ?? err.message}`); return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (isExcluded(p)) continue;
      if (e.isSymbolicLink()) continue; // never follow links out of the scanned tree
      if (e.isDirectory()) walk(p, root);
      else if (e.isFile()) files.push({ path: p, label: relative(process.cwd(), p) || p, name: relative(root, p) });
    }
  };
  for (const input of inputs) {
    if (input === "-") { files.push({ path: "-", label: "<stdin>", name: "" }); continue; }
    const abs = resolve(input);
    let st;
    try { st = statSync(abs); } catch { problems.push(`no such file or directory: ${input}`); continue; }
    if (isExcluded(abs)) continue;
    if (st.isDirectory()) walk(abs, abs);
    else if (st.isFile()) files.push({ path: abs, label: relative(process.cwd(), abs) || abs, name: basename(abs) });
    else problems.push(`not a regular file or directory: ${input}`);
  }
  return { files, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

const USAGE = "usage: check-privacy.mjs [--canaries FILE] [--require-canaries] [--exclude PATH]... <file|dir|-> [...]\n       check-privacy.mjs --self-test";

function parseArgs(argv) {
  const opts = { inputs: [], excluded: [], requireCanaries: false, canaries: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (name) => {
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      const v = argv[++i];
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    if (a === "--self-test") opts.selfTest = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--require-canaries") opts.requireCanaries = true;
    else if (a === "--canaries" || a.startsWith("--canaries=")) opts.canaries = take("--canaries");
    else if (a === "--exclude" || a.startsWith("--exclude=")) opts.excluded.push(resolve(take("--exclude")));
    else if (a === "-") opts.inputs.push("-");
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else opts.inputs.push(a);
  }
  return opts;
}

export function main(argv, io = console, { defaultCanaries = DEFAULT_CANARIES, stdin = () => readFileSync(0) } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) { io.error(`check-privacy: ${err.message}\n${USAGE}`); return 2; }
  if (opts.selfTest) return selfTest();
  if (opts.help) { io.log(USAGE); return 0; }
  if (!opts.inputs.length) { io.error(`check-privacy: no output files given\n${USAGE}`); return 2; }

  const canaryPath = resolve(opts.canaries ?? defaultCanaries);
  const canaryLabel = relative(process.cwd(), canaryPath) || canaryPath;
  const { files, problems } = collectFiles(opts.inputs, { skip: [canaryPath], excluded: opts.excluded });
  if (problems.length) { for (const p of problems) io.error(`check-privacy: ${p}`); return 2; }

  if (!existsSync(canaryPath)) {
    if (opts.canaries || opts.requireCanaries) {
      io.error(`check-privacy: canary file not found: ${canaryLabel}`);
      return 2;
    }
    io.log(`check-privacy: SKIPPED - ${canaryLabel} does not exist yet, so there is nothing to check (use --require-canaries to make this an error)`);
    return 0;
  }
  let canaries;
  try { canaries = parseCanaries(readFileSync(canaryPath, "utf8")); } catch (err) { io.error(`check-privacy: cannot read ${canaryLabel}: ${err.code ?? err.message}`); return 2; }
  if (!canaries.length) { io.error(`check-privacy: ${canaryLabel} lists no canaries - refusing to pass vacuously`); return 2; }
  if (!files.length) { io.error("check-privacy: no files to scan (empty directory or everything excluded) - refusing to pass vacuously"); return 2; }

  const prepared = prepareCanaries(canaries);
  let failures = 0;
  const report = (label, hit) => {
    failures++;
    io.error(`FAIL ${label}: canary #${hit.n} (${canaryLabel} line ${hit.line}) found via ${hit.view}/${hit.variant}${hit.at ? ` at line ${hit.at}` : ""}`);
  };
  for (const f of files) {
    let buf;
    try { buf = f.path === "-" ? Buffer.from(stdin()) : readFileSync(f.path); } catch (err) { io.error(`check-privacy: cannot read ${f.label}: ${err.code ?? err.message}`); return 2; }
    for (const hit of scanName(f.name, prepared)) report(f.label, hit);
    for (const hit of scanContent(buf, prepared)) report(f.label, hit);
  }
  if (failures) {
    io.error(`check-privacy: FAILED - ${failures} canary hit(s) in ${files.length} file(s)`);
    return 1;
  }
  io.log(`check-privacy: OK (${files.length} file(s), ${canaries.length} canaries, 0 hits)`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test (run in CI: node scripts/check-privacy.mjs --self-test)
// ---------------------------------------------------------------------------------------------------------------

function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), "wasitme-priv-"));
  const capture = () => {
    const lines = { out: [], err: [] };
    return { lines, io: { log: (m) => lines.out.push(String(m)), error: (m) => lines.err.push(String(m)) } };
  };
  const write = (rel, content) => {
    const p = join(tmp, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  };
  const run = (argv, opts) => {
    const c = capture();
    const status = main(argv, c.io, opts);
    return { status, out: c.lines.out.join("\n"), err: c.lines.err.join("\n") };
  };
  try {
    const canaryFile = write("canaries.txt", [
      "# synthetic canaries - not real data",
      "",
      "CANARY-PLAIN-7f3a9c1e",
      'say "hi"\\there\u2028now',
      "caf\u00e9-\u{1F98A}-canary",
      "Project Zebra Launch Plan",
      "#tagged-canary-xyz",
      "CANARY-PLAIN-7f3a9c1e",
    ].join("\r\n"));
    const parsed = parseCanaries(readFileSync(canaryFile, "utf8"));
    assert.deepEqual(parsed.map((c) => c.value), ["CANARY-PLAIN-7f3a9c1e", 'say "hi"\\there\u2028now', "caf\u00e9-\u{1F98A}-canary", "Project Zebra Launch Plan", "#tagged-canary-xyz"]);
    assert.equal(parsed[0].line, 3, "line numbers refer to the canary file");
    const prepared = prepareCanaries(parsed);
    const hitsOf = (content) => scanContent(Buffer.from(content), prepared).map((h) => h.n);

    // Clean output.
    assert.deepEqual(hitsOf(JSON.stringify({ verdict: "none", metrics: [{ id: "tool_errors", ratio: 1.02 }], sessions: ["s-0a1b2c3d4e5f"] })), []);
    assert.deepEqual(hitsOf(""), []);

    // Every encoding of every kind of canary is caught.
    assert.deepEqual(hitsOf("report\nline CANARY-PLAIN-7f3a9c1e here"), [1]);
    assert.deepEqual(hitsOf("canary-plain-7F3A9C1E"), [1], "case-insensitive");
    assert.deepEqual(hitsOf(JSON.stringify({ k: parsed[1].value })), [2], "JSON-escaped quotes, backslash and U+2028");
    assert.deepEqual(hitsOf(JSON.stringify({ [parsed[1].value]: 1 })), [2], "canary used as a JSON key");
    assert.deepEqual(hitsOf(asciiEscape(JSON.stringify({ k: parsed[2].value }))), [3], "\\uXXXX escapes incl. surrogate pairs");
    assert.deepEqual(hitsOf(`{"p":"${parsed[2].value.replace(/\u00e9/g, "\\u00E9")}"}`), [3], "decoded JSON view, mixed escapes");
    assert.deepEqual(hitsOf(`{"p":"a\\/b ${"CANARY-PLAIN-7f3a9c1e".replace(/-/g, "\\u002d")}"}`), [1], "decoded view beats escaping of ordinary chars");
    assert.deepEqual(hitsOf(`{"a":1}\n{"b":"${"CANARY-PLAIN-7f3a9c1e".replace("C", "\\u0043")}"}\n`), [1], "JSONL lines are decoded one by one");
    // A short canary skips the punctuation-stripped view, so only the decoded-JSON view can catch odd escaping.
    const short = prepareCanaries(parseCanaries('K9/x"y\n'));
    assert.deepEqual(scanContent(Buffer.from('{"v":"\\u004b9\\/x\\"y"}'), short).map((h) => h.view), ["decoded-json"]);
    assert.deepEqual(scanContent(Buffer.from('{"v":"K9/x"}'), short), []);
    assert.deepEqual(hitsOf(`?q=${encodeURIComponent("Project Zebra Launch Plan")}`), [4], "URL-encoded");
    assert.deepEqual(hitsOf("?q=Project+Zebra+Launch+Plan"), [4], "form-encoded");
    assert.deepEqual(hitsOf("<td>say &quot;hi&quot;</td>"), [], "partial text is not a hit");
    assert.deepEqual(hitsOf(`<td>${htmlEscape(parsed[1].value)}</td>`), [2], "HTML-escaped");
    assert.deepEqual(hitsOf("Project Zebra\n  Launch   Plan"), [4], "wrapped across lines");
    assert.deepEqual(hitsOf("CANARY PLAIN\n7f3a9c1e"), [1], "punctuation and wrapping changed");
    assert.deepEqual(hitsOf(parsed[2].value.normalize("NFD")), [3], "NFD form");
    assert.deepEqual(hitsOf("see #tagged-canary-xyz"), [5], "a '#tag' line is a canary, not a comment");
    assert.deepEqual(hitsOf("Project  Zebra  Launch  Plan CANARY-PLAIN-7f3a9c1e"), [1, 4], "several canaries in one file");
    assert.deepEqual(hitsOf("Project Zebra"), [], "a prefix of a canary is not a hit");
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("x CANARY-PLAIN-7f3a9c1e", "utf16le")]);
    assert.deepEqual(scanContent(utf16, prepared).map((h) => h.n), [1], "UTF-16LE with BOM");
    assert.deepEqual(scanContent(Buffer.from([0xff, 0x00, 0xc3, 0x28, ...Buffer.from("CANARY-PLAIN-7f3a9c1e")]), prepared).map((h) => h.n), [1], "invalid UTF-8 around a canary");
    assert.equal(scanContent(Buffer.from("a\nb\nCANARY-PLAIN-7f3a9c1e"), prepared)[0].at, 3, "reports the line in the scanned file");
    assert.deepEqual(scanName("report-CANARY-PLAIN-7f3a9c1e.md", prepared).map((h) => h.n), [1], "file names are checked");

    // CLI behaviour.
    const clean = write("out/clean.json", JSON.stringify({ verdict: "insufficient" }));
    const dirty = write("out/nested/dirty.md", "leaked: Project Zebra Launch Plan\n");
    let r = run(["--canaries", canaryFile, clean]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /OK \(1 file\(s\), 5 canaries/);
    r = run(["--canaries", canaryFile, join(tmp, "out")]);
    assert.equal(r.status, 1);
    assert.match(r.err, /dirty\.md: canary #4 \(.*canaries\.txt line 6\) found via text\/raw at line 1/);
    assert.ok(!r.err.includes("Zebra"), "the canary text must never be echoed");
    r = run(["--canaries", canaryFile, "--exclude", join(tmp, "out", "nested"), join(tmp, "out")]);
    assert.equal(r.status, 0, "excluded directories are not scanned");
    r = run(["--canaries", canaryFile, dirty, "--exclude", dirty]);
    assert.equal(r.status, 2, "everything excluded is a vacuous scan");
    write("named/Project-Zebra-Launch-Plan.txt", "harmless body");
    r = run(["--canaries", canaryFile, join(tmp, "named")]);
    assert.equal(r.status, 1);
    assert.match(r.err, /file-name/);
    r = run(["--canaries", canaryFile, join(tmp, "canaries.txt")]);
    assert.equal(r.status, 2, "scanning only the canary file itself leaves nothing to scan");
    r = run(["--canaries", canaryFile, join(tmp)]);
    assert.equal(r.status, 1, "the canary file is skipped but other files in the tree are scanned");
    const failedLabels = r.err.split("\n").filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(5, l.indexOf(": canary")));
    assert.ok(failedLabels.length >= 2 && !failedLabels.some((l) => /(^|\/)canaries\.txt$/.test(l)), "canary file never reports on itself");

    // Missing / empty / bad usage.
    const missing = join(tmp, "nope", "CANARIES.txt");
    r = run([clean], { defaultCanaries: missing });
    assert.equal(r.status, 0);
    assert.match(r.out, /SKIPPED/);
    r = run(["--require-canaries", clean], { defaultCanaries: missing });
    assert.equal(r.status, 2);
    r = run(["--canaries", missing, clean]);
    assert.equal(r.status, 2, "an explicit canary file must exist");
    r = run([join(tmp, "no-such-output")], { defaultCanaries: missing });
    assert.equal(r.status, 2, "bad inputs are an error even while skipping");
    r = run([], { defaultCanaries: missing });
    assert.equal(r.status, 2, "no inputs is a usage error");
    r = run(["--bogus", clean]);
    assert.equal(r.status, 2);
    r = run(["--canaries"]);
    assert.equal(r.status, 2);
    const emptyList = write("empty-canaries.txt", "# only comments\n\n");
    r = run(["--canaries", emptyList, clean]);
    assert.equal(r.status, 2, "an empty canary list must not pass");
    const emptyDir = join(tmp, "empty-dir");
    mkdirSync(emptyDir);
    r = run(["--canaries", canaryFile, emptyDir]);
    assert.equal(r.status, 2, "scanning nothing must not pass");

    // Symlinks inside scanned directories are not followed.
    const linkDir = join(tmp, "links");
    mkdirSync(linkDir);
    writeFileSync(join(linkDir, "ok.txt"), "fine");
    symlinkSync(dirty, join(linkDir, "link.md"));
    r = run(["--canaries", canaryFile, linkDir]);
    assert.equal(r.status, 0, "symlinked file was not followed");
    assert.ok(lstatSync(join(linkDir, "link.md")).isSymbolicLink());

    // stdin and the real entry point.
    r = run(["--canaries", canaryFile, "-"], { stdin: () => Buffer.from("piped CANARY-PLAIN-7f3a9c1e") });
    assert.equal(r.status, 1);
    assert.match(r.err, /<stdin>: canary #1/);
    const spawned = spawnSync(process.execPath, [SELF, "--canaries", canaryFile, "-"], { input: "nothing to see", encoding: "utf8" });
    assert.equal(spawned.status, 0, spawned.stderr);
    const spawnedBad = spawnSync(process.execPath, [SELF, "--canaries", canaryFile, "-"], { input: '{"x":"Project Zebra Launch Plan"}', encoding: "utf8" });
    assert.equal(spawnedBad.status, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("check-privacy: self-test passed");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
