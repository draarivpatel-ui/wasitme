#!/usr/bin/env node
// assemble-changelog.mjs - changelog fragments: one small file per change, folded into CHANGELOG.md at release.
//
// Why fragments: if every pull request edits the top of CHANGELOG.md, every pair of open pull requests conflicts
// there. With one file per change, two pull requests never touch the same line. See changelog.d/README.md.
//
// Usage:
//   node scripts/assemble-changelog.mjs --check                          validate fragments and CHANGELOG.md
//   node scripts/assemble-changelog.mjs --release X.Y.Z [--date D]       fold fragments into a new CHANGELOG.md
//                                       [--dry-run]                      section, delete them; --dry-run prints
//                                                                        the section and changes nothing
//   node scripts/assemble-changelog.mjs --verify-release X.Y.Z           release gate: no fragments left and
//                                                                        CHANGELOG.md has notes for X.Y.Z
//   node scripts/assemble-changelog.mjs --print-release X.Y.Z            print the notes for X.Y.Z (release body)
//   node scripts/assemble-changelog.mjs --self-test                      run this script's own tests
//   --root DIR   repository root (default: the directory above scripts/)
//
// Exit codes: 0 ok, 1 problems found, 2 usage error.
//
// Fragment file: changelog.d/<slug>.<category>.md where category is one of
//   added | changed | deprecated | removed | fixed | security
// and the content is exactly one Markdown bullet (see validateFragment for the rules). CHANGELOG.md lists released
// versions only ("## X.Y.Z - YYYY-MM-DD"); unreleased changes are the files in changelog.d/. The CHANGELOG.md file
// is created on the first release if it does not exist.

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SELF));
const FRAGMENT_DIR = "changelog.d";

/** Keep a Changelog order. */
const CATEGORIES = [
  ["added", "Added"],
  ["changed", "Changed"],
  ["deprecated", "Deprecated"],
  ["removed", "Removed"],
  ["fixed", "Fixed"],
  ["security", "Security"],
];
const FRAGMENT_NAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.(added|changed|deprecated|removed|fixed|security)\.md$/;
const NOT_A_FRAGMENT = new Set(["README.md", ".gitkeep"]);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_HEADING = /^## (\S+) - (\d{4}-\d{2}-\d{2})$/;
// Control characters, zero-width characters and bidi overrides: fragments are published text, so keep them plain.
const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const HEADER = `# Changelog

All notable changes to wasitme are recorded here, newest release first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

Unreleased changes are kept as one small file each in \`changelog.d/\` (see its README) and are folded in here when a
release is cut.
`;

// ---------------------------------------------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------------------------------------------

const normalize = (text) => text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/^\n+|\n+$/g, "");

/** Problems with one fragment's content (empty array when valid). `name` is only used in messages. */
export function validateFragment(name, rawText) {
  const problems = [];
  const bad = (msg) => problems.push(`${FRAGMENT_DIR}/${name}: ${msg}`);
  if (HIDDEN_CHARS.test(rawText)) bad("contains control, zero-width or bidirectional-override characters");
  const text = normalize(rawText);
  if (!text) return [`${FRAGMENT_DIR}/${name}: is empty`];
  const lines = text.split("\n");
  if (!/^- \S/.test(lines[0])) bad('must start with "- " followed by the text, so it reads as one bullet');
  let fence;
  lines.forEach((line, i) => {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
    } else if (fenceMatch) {
      fence = fenceMatch[1];
    }
    if (i === 0 || !line) return;
    if (/^[-*+]\s/.test(line)) bad(`line ${i + 1} starts another top-level bullet; one change per file`);
    else if (!fence && /^#{1,6}(\s|$)/.test(line)) bad(`line ${i + 1} is a heading; a fragment is one bullet and the release adds the headings`);
    else if (!fence && /^(={2,}|-{3,}|\*{3,}|_{3,})$/.test(line)) bad(`line ${i + 1} is a rule or heading underline; not allowed inside a bullet`);
    else if (!/^ {2}/.test(line)) bad(`line ${i + 1} must be indented two spaces to continue the bullet`);
  });
  if (fence) bad("has a code fence that is never closed");
  return problems;
}

/** Read changelog.d. Returns {fragments: [{name, category, text}], problems}. A missing directory is fine. */
export function readFragments(root) {
  const dir = join(root, FRAGMENT_DIR);
  const fragments = [];
  const problems = [];
  if (!existsSync(dir)) return { fragments, problems };
  for (const name of readdirSync(dir).sort()) {
    if (NOT_A_FRAGMENT.has(name)) continue;
    const path = join(dir, name);
    const st = lstatSync(path);
    const match = FRAGMENT_NAME.exec(name);
    if (!st.isFile()) problems.push(`${FRAGMENT_DIR}/${name}: only plain files are allowed here`);
    else if (!match) problems.push(`${FRAGMENT_DIR}/${name}: name must look like <short-slug>.<category>.md with category one of ${CATEGORIES.map((c) => c[0]).join(", ")}`);
    else {
      const raw = readFileSync(path, "utf8");
      const found = validateFragment(name, raw);
      if (found.length) problems.push(...found);
      else fragments.push({ name, category: match[2], text: normalize(raw) });
    }
  }
  return { fragments, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// CHANGELOG.md
// ---------------------------------------------------------------------------------------------------------------

/** Parse release sections. Returns {releases: [{version, date, body}], problems}. */
export function parseChangelog(text) {
  const releases = [];
  const problems = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let current;
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) {
      const m = RELEASE_HEADING.exec(line);
      if (!m || !VERSION.test(m[1]) || Number.isNaN(Date.parse(m[2])) || new Date(m[2]).toISOString().slice(0, 10) !== m[2]) {
        const unreleased = /^## \[?unreleased\]?\s*$/i.test(line);
        problems.push(`CHANGELOG.md:${i + 1}: ${unreleased ? 'has an "Unreleased" section; keep unreleased changes in changelog.d/ instead' : `release heading must look like "## X.Y.Z - YYYY-MM-DD", got "${line}"`}`);
        current = undefined;
        return;
      }
      if (releases.some((r) => r.version === m[1])) problems.push(`CHANGELOG.md:${i + 1}: version ${m[1]} appears twice`);
      current = { version: m[1], date: m[2], lines: [] };
      releases.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  });
  return { releases: releases.map((r) => ({ version: r.version, date: r.date, body: r.lines.join("\n").replace(/^\n+|\n+$/g, "") })), problems };
}

/** The Markdown for one release, grouped by category. */
export function buildSection(version, date, fragments) {
  const parts = [`## ${version} - ${date}`];
  for (const [key, title] of CATEGORIES) {
    const items = fragments.filter((f) => f.category === key).map((f) => f.text);
    if (items.length) parts.push(`### ${title}\n\n${items.join("\n")}`);
  }
  return parts.join("\n\n") + "\n";
}

/** Put `section` above the newest existing release (or at the end if there is none). */
export function insertSection(changelog, section) {
  const text = changelog.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let fenced = false;
  const at = lines.findIndex((line) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && /^## /.test(line);
  });
  if (at === -1) return text.replace(/\s+$/, "") + "\n\n" + section;
  const before = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  const after = lines.slice(at).join("\n");
  return `${before}\n\n${section}\n${after}`;
}

function readChangelog(root) {
  const path = join(root, "CHANGELOG.md");
  return existsSync(path) ? { path, text: readFileSync(path, "utf8") } : { path, text: undefined };
}

// ---------------------------------------------------------------------------------------------------------------
// Commands (each returns {status, out?, problems?} so they are easy to test)
// ---------------------------------------------------------------------------------------------------------------

export function check(root) {
  const { fragments, problems } = readFragments(root);
  const cl = readChangelog(root);
  if (cl.text !== undefined) problems.push(...parseChangelog(cl.text).problems);
  return { status: problems.length ? 1 : 0, problems, summary: `${fragments.length} fragment(s)${cl.text === undefined ? ", no CHANGELOG.md yet" : ", CHANGELOG.md well-formed"}` };
}

export function release(root, version, date, { dryRun = false } = {}) {
  if (!VERSION.test(version)) return { status: 2, problems: [`"${version}" is not a version like 0.1.0 (no leading "v")`] };
  if (Number.isNaN(Date.parse(date)) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
    return { status: 2, problems: [`"${date}" is not a calendar date like 2026-10-05`] };
  }
  const { fragments, problems } = readFragments(root);
  const cl = readChangelog(root);
  const existing = cl.text ?? HEADER;
  const parsed = parseChangelog(existing);
  problems.push(...parsed.problems);
  if (parsed.releases.some((r) => r.version === version)) problems.push(`CHANGELOG.md already has a section for ${version}`);
  if (!fragments.length && !problems.length) problems.push(`no fragments in ${FRAGMENT_DIR}/ - nothing to release`);
  if (problems.length) return { status: 1, problems };
  const section = buildSection(version, date, fragments);
  const next = insertSection(existing, section);
  if (!dryRun) {
    const tmp = `${cl.path}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, next);
      renameSync(tmp, cl.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    for (const f of fragments) rmSync(join(root, FRAGMENT_DIR, f.name));
  }
  return { status: 0, section, folded: fragments.map((f) => f.name), dryRun };
}

export function verifyRelease(root, version) {
  if (!VERSION.test(version)) return { status: 2, problems: [`"${version}" is not a version like 0.1.0 (no leading "v")`] };
  const { fragments, problems } = readFragments(root);
  for (const f of fragments) problems.push(`${FRAGMENT_DIR}/${f.name}: unreleased fragment still present; run --release ${version} before tagging`);
  const cl = readChangelog(root);
  if (cl.text === undefined) problems.push("CHANGELOG.md does not exist");
  else {
    const parsed = parseChangelog(cl.text);
    problems.push(...parsed.problems);
    const entry = parsed.releases.find((r) => r.version === version);
    if (!entry) problems.push(`CHANGELOG.md has no "## ${version} - <date>" section`);
    else if (!/^- /m.test(entry.body)) problems.push(`CHANGELOG.md section ${version} has no entries`);
  }
  return { status: problems.length ? 1 : 0, problems };
}

export function printRelease(root, version) {
  if (!VERSION.test(version)) return { status: 2, problems: [`"${version}" is not a version like 0.1.0 (no leading "v")`] };
  const cl = readChangelog(root);
  if (cl.text === undefined) return { status: 1, problems: ["CHANGELOG.md does not exist"] };
  const entry = parseChangelog(cl.text).releases.find((r) => r.version === version);
  if (!entry) return { status: 1, problems: [`CHANGELOG.md has no section for ${version}`] };
  return { status: 0, out: entry.body + "\n" };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

const USAGE = `usage: assemble-changelog.mjs --check
       assemble-changelog.mjs --release X.Y.Z [--date YYYY-MM-DD] [--dry-run]
       assemble-changelog.mjs --verify-release X.Y.Z
       assemble-changelog.mjs --print-release X.Y.Z
       assemble-changelog.mjs --self-test
options: --root DIR (default: repository root)`;

function parseArgs(argv) {
  const o = { modes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--check") o.modes.push("check");
    else if (a === "--self-test") o.modes.push("self-test");
    else if (a === "--release") { o.modes.push("release"); o.version = value(); }
    else if (a === "--verify-release") { o.modes.push("verify"); o.version = value(); }
    else if (a === "--print-release") { o.modes.push("print"); o.version = value(); }
    else if (a === "--date") o.date = value();
    else if (a === "--root") o.root = resolve(value());
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export function main(argv, io = { log: (m) => process.stdout.write(m + "\n"), write: (m) => process.stdout.write(m), error: console.error }) {
  let o;
  try { o = parseArgs(argv); } catch (err) { io.error(`assemble-changelog: ${err.message}\n${USAGE}`); return 2; }
  if (o.help) { io.log(USAGE); return 0; }
  if (o.modes.length !== 1) { io.error(`assemble-changelog: choose exactly one mode\n${USAGE}`); return 2; }
  if ((o.dryRun || o.date) && o.modes[0] !== "release") { io.error("assemble-changelog: --dry-run and --date only apply to --release"); return 2; }
  const mode = o.modes[0];
  if (mode === "self-test") return selfTest();
  const root = o.root ?? REPO_ROOT;
  try {
    return dispatch(mode, o, root, io);
  } catch (err) {
    io.error(`assemble-changelog: failed: ${err.code ? err.code + " " : ""}${err.message}`);
    return 1;
  }
}

function dispatch(mode, o, root, io) {
  const fail = (r) => { for (const p of r.problems) io.error(`assemble-changelog: ${p}`); return r.status; };

  if (mode === "check") {
    const r = check(root);
    if (r.status) { fail(r); io.error(`assemble-changelog: FAILED (${r.problems.length} problem(s))`); return r.status; }
    io.log(`assemble-changelog: OK (${r.summary})`);
    return 0;
  }
  if (mode === "release") {
    const date = o.date ?? new Date().toISOString().slice(0, 10);
    const r = release(root, o.version, date, { dryRun: o.dryRun });
    if (r.status) return fail(r);
    io.write(r.section);
    io.error(`assemble-changelog: ${r.dryRun ? "dry run, nothing changed; would fold" : "folded"} ${r.folded.length} fragment(s) into CHANGELOG.md as ${o.version}`);
    for (const name of r.folded) io.error(`  ${r.dryRun ? "would remove" : "removed"} ${FRAGMENT_DIR}/${name}`);
    return 0;
  }
  if (mode === "verify") {
    const r = verifyRelease(root, o.version);
    if (r.status) return fail(r);
    io.log(`assemble-changelog: release ${o.version} is ready (no fragments left, CHANGELOG.md has its notes)`);
    return 0;
  }
  const r = printRelease(root, o.version);
  if (r.status) return fail(r);
  io.write(r.out);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test (run in CI: node scripts/assemble-changelog.mjs --self-test)
// ---------------------------------------------------------------------------------------------------------------

function selfTest() {
  const roots = [];
  const makeRoot = (files = {}) => {
    const root = mkdtempSync(join(tmpdir(), "wasitme-changelog-"));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return root;
  };
  const probs = (name, text) => validateFragment(name, text);
  try {
    // Valid fragments.
    assert.deepEqual(probs("a.added.md", "- **One change.** More detail.\n"), []);
    assert.deepEqual(probs("a.added.md", "- First line\n  continues here\n\n  and a second paragraph.\n"), []);
    assert.deepEqual(probs("a.added.md", "- Run:\n\n  ```sh\n  # a comment, not a heading\n  npm test\n  ```\n"), []);
    assert.deepEqual(probs("a.added.md", "- CRLF line endings  \r\n  are fine\r\n"), []);

    // Invalid fragments: each rule on its own.
    const has = (text, re) => assert.ok(probs("x.fixed.md", text).some((p) => re.test(p)), `expected ${re} for ${JSON.stringify(text)}, got ${JSON.stringify(probs("x.fixed.md", text))}`);
    has("", /is empty/);
    has("  \n\n", /is empty/);
    has("Not a bullet\n", /must start with "- "/);
    has("* star bullet\n", /must start with "- "/);
    has("-\n", /must start with "- "/);
    has("# Heading\n- a\n", /must start with "- "/);
    has("- a\n## Heading\n", /heading/);
    has("- a\n  ## indented is just text\n- b\n", /another top-level bullet/);
    has("- a\n- b\n", /another top-level bullet/);
    has("- a\n* b\n", /another top-level bullet/);
    has("- a\n\n- b\n", /another top-level bullet/);
    has("- a\nlazy continuation\n", /indented two spaces/);
    has("- a\n---\n", /rule/);
    has("- a\n  ```sh\n  never closed\n", /never closed/);
    has("- a\u202egnirts\n", /bidirectional/);
    has("- a\u200bb\n", /zero-width/);
    has("- a\u0007b\n", /control/);
    assert.deepEqual(probs("x.fixed.md", "- a\n  ```\n# not a heading\n  ```\n").filter((p) => /heading/.test(p)), [], "headings inside fences are ignored by the heading rule");

    // Fragment directory: names, categories, non-files.
    let root = makeRoot({
      "changelog.d/README.md": "# docs, not a fragment\n",
      "changelog.d/.gitkeep": "",
      "changelog.d/zeta-fix.fixed.md": "- Fixed Z.\n",
      "changelog.d/alpha.added.md": "- Added A.\n",
      "changelog.d/beta.added.md": "- Added B.\n  with detail.\n",
      "changelog.d/sec-hole.security.md": "- Closed a hole.\n",
    });
    let r = readFragments(root);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.fragments.map((f) => f.name), ["alpha.added.md", "beta.added.md", "sec-hole.security.md", "zeta-fix.fixed.md"], "sorted by file name");
    assert.equal(check(root).status, 0);
    for (const bad of ["no-category.md", "Upper.added.md", "typo.fixd.md", "two..added.md", "a b.added.md", "x.added.md.txt", "x.added"]) {
      writeFileSync(join(root, "changelog.d", bad), "- x\n");
      assert.ok(readFragments(root).problems.some((p) => p.includes(bad)), `${bad} should be rejected`);
      rmSync(join(root, "changelog.d", bad));
    }
    mkdirSync(join(root, "changelog.d", "sub.added.md"));
    assert.ok(readFragments(root).problems.some((p) => /plain files/.test(p)), "a directory named like a fragment is rejected");
    rmSync(join(root, "changelog.d", "sub.added.md"), { recursive: true });
    assert.equal(readFragments(makeRoot()).problems.length, 0, "no changelog.d at all is fine");

    // Section building and insertion.
    const frags = readFragments(root).fragments;
    const section = buildSection("0.1.0", "2026-10-05", frags);
    assert.equal(section, "## 0.1.0 - 2026-10-05\n\n### Added\n\n- Added A.\n- Added B.\n  with detail.\n\n### Fixed\n\n- Fixed Z.\n\n### Security\n\n- Closed a hole.\n");
    assert.equal(insertSection("# Changelog\n\nintro\n", "## 1.0.0 - 2026-01-01\n\n- x\n"), "# Changelog\n\nintro\n\n## 1.0.0 - 2026-01-01\n\n- x\n");
    const two = insertSection("# Changelog\n\nintro\n\n## 1.0.0 - 2026-01-01\n\n- old\n", "## 1.1.0 - 2026-02-01\n\n- new\n");
    assert.equal(two, "# Changelog\n\nintro\n\n## 1.1.0 - 2026-02-01\n\n- new\n\n## 1.0.0 - 2026-01-01\n\n- old\n");
    assert.equal(insertSection("intro\n\n```md\n## not a release\n```\n", "## 1.0.0 - 2026-01-01\n\n- x\n"), "intro\n\n```md\n## not a release\n```\n\n## 1.0.0 - 2026-01-01\n\n- x\n", "headings inside code fences are not releases");

    // CHANGELOG.md parsing.
    const parsed = parseChangelog("# Changelog\n\n## 1.1.0 - 2026-02-01\n\n### Added\n\n- new\n\n## 1.0.0-rc.1 - 2026-01-01\n\n- old\n");
    assert.deepEqual(parsed.releases.map((x) => [x.version, x.date]), [["1.1.0", "2026-02-01"], ["1.0.0-rc.1", "2026-01-01"]]);
    assert.equal(parsed.releases[0].body, "### Added\n\n- new");
    assert.deepEqual(parsed.problems, []);
    assert.match(parseChangelog("## Unreleased\n- x\n").problems[0], /Unreleased/);
    assert.match(parseChangelog("## [Unreleased]\n").problems[0], /Unreleased/);
    assert.match(parseChangelog("## v1.0.0 - 2026-01-01\n").problems[0], /release heading/);
    assert.match(parseChangelog("## 1.0.0 - 2026-13-45\n").problems[0], /release heading/);
    assert.match(parseChangelog("## 1.0.0 - 2026-02-30\n").problems[0], /release heading/, "impossible dates are rejected");
    assert.match(parseChangelog("## 1.0.0 - 2026-01-01\n\n## 1.0.0 - 2026-01-02\n").problems[0], /twice/);

    // --release end to end (including a first release with no CHANGELOG.md), dry run first.
    const dry = release(root, "0.1.0", "2026-10-05", { dryRun: true });
    assert.equal(dry.status, 0);
    assert.equal(existsSync(join(root, "CHANGELOG.md")), false, "dry run writes nothing");
    assert.equal(readFragments(root).fragments.length, 4, "dry run deletes nothing");
    const rel1 = release(root, "0.1.0", "2026-10-05");
    assert.equal(rel1.status, 0);
    assert.deepEqual(readFragments(root).fragments, [], "fragments are deleted after folding");
    assert.ok(existsSync(join(root, "changelog.d", "README.md")), "README is never deleted");
    const written = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.ok(written.startsWith("# Changelog\n"));
    assert.ok(written.includes("## 0.1.0 - 2026-10-05\n\n### Added\n\n- Added A."));
    assert.equal(parseChangelog(written).problems.length, 0);
    assert.deepEqual(readdirSync(root).filter((n) => n.includes(".tmp-")), [], "no temp file left behind");

    // Second release goes above the first; versions can't repeat; clocks may go backward.
    writeFileSync(join(root, "changelog.d", "next.changed.md"), "- Changed N.\n");
    assert.equal(release(root, "0.1.0", "2026-10-06").status, 1, "already-released version is refused");
    assert.equal(readFragments(root).fragments.length, 1, "a refused release keeps its fragments");
    assert.equal(release(root, "0.2.0", "2026-09-01").status, 0, "an earlier date is allowed (clock went backward)");
    const both = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
    assert.deepEqual(both.releases.map((x) => x.version), ["0.2.0", "0.1.0"]);

    // Release refusals.
    assert.equal(release(root, "v0.3.0", "2026-10-06").status, 2);
    assert.equal(release(root, "0.3", "2026-10-06").status, 2);
    assert.equal(release(root, "0.3.0", "yesterday").status, 2);
    assert.equal(release(root, "0.3.0", "2026-02-30").status, 2);
    assert.equal(release(root, "0.3.0", "2026-10-06").status, 1, "no fragments: nothing to release");
    writeFileSync(join(root, "changelog.d", "bad.changed.md"), "no bullet\n");
    writeFileSync(join(root, "changelog.d", "good.changed.md"), "- good\n");
    const refused = release(root, "0.3.0", "2026-10-06");
    assert.equal(refused.status, 1);
    assert.equal(readFragments(root).fragments.length, 1, "an invalid fragment blocks the whole release, nothing is deleted");
    assert.ok(readFileSync(join(root, "CHANGELOG.md"), "utf8").includes("## 0.2.0"));
    rmSync(join(root, "changelog.d", "bad.changed.md"));
    rmSync(join(root, "changelog.d", "good.changed.md"));

    // --verify-release / --print-release.
    assert.equal(verifyRelease(root, "0.2.0").status, 0);
    assert.equal(verifyRelease(root, "0.9.9").status, 1, "no section for that version");
    writeFileSync(join(root, "changelog.d", "late.fixed.md"), "- late\n");
    assert.ok(verifyRelease(root, "0.2.0").problems.some((p) => /unreleased fragment/.test(p)), "leftover fragments block a release");
    rmSync(join(root, "changelog.d", "late.fixed.md"));
    assert.equal(verifyRelease(makeRoot(), "0.1.0").status, 1, "no CHANGELOG.md");
    assert.equal(verifyRelease(root, "v0.2.0").status, 2);
    const notes = printRelease(root, "0.1.0");
    assert.equal(notes.status, 0);
    assert.ok(notes.out.startsWith("### Added\n\n- Added A.") && !notes.out.includes("## 0.2.0") && !notes.out.includes("Changed N"));
    assert.equal(printRelease(root, "9.9.9").status, 1);

    // --check also catches a hand-edited CHANGELOG.md (Unreleased sections defeat the purpose of fragments).
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- hand edited\n");
    assert.equal(check(root).status, 1);
    const empty = makeRoot({ "changelog.d/README.md": "docs\n" });
    assert.equal(check(empty).status, 0, "no CHANGELOG.md yet, no fragments: fine");

    // CLI exit codes through the real entry point.
    const cli = (...args) => spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8" });
    const good = makeRoot({ "changelog.d/one.added.md": "- one\n" });
    // A failed write must leave every fragment in place: they are deleted only after CHANGELOG.md is written.
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const locked = makeRoot({ "changelog.d/keep.added.md": "- keep me\n" });
      chmodSync(locked, 0o555);
      try {
        assert.throws(() => release(locked, "1.0.0", "2026-10-05"));
        const failed = cli("--release", "1.0.0", "--date", "2026-10-05", "--root", locked);
        assert.equal(failed.status, 1, "an IO error exits 1");
        assert.match(failed.stderr, /assemble-changelog: failed: /);
        assert.ok(!/\n\s+at /.test(failed.stderr), "with a message, not a stack trace");
      } finally {
        chmodSync(locked, 0o755);
      }
      assert.deepEqual(readFragments(locked).fragments.map((f) => f.name), ["keep.added.md"], "a failed write keeps every fragment");
      assert.deepEqual(readdirSync(locked).filter((n) => n.includes(".tmp-")), [], "and leaves no temp file");
    }
    assert.equal(cli("--check", "--root", good).status, 0);
    assert.equal(cli("--release", "1.0.0", "--date", "2026-10-05", "--dry-run", "--root", good).status, 0);
    assert.ok(existsSync(join(good, "changelog.d", "one.added.md")), "CLI dry run keeps fragments");
    const dryRun = cli("--release", "1.0.0", "--date", "2026-10-05", "--dry-run", "--root", good);
    assert.equal(dryRun.stdout, "## 1.0.0 - 2026-10-05\n\n### Added\n\n- one\n", "dry run prints only the section on stdout");
    assert.equal(cli("--release", "1.0.0", "--date", "2026-10-05", "--root", good).status, 0);
    assert.equal(cli("--verify-release", "1.0.0", "--root", good).status, 0);
    assert.equal(cli("--print-release", "1.0.0", "--root", good).stdout, "### Added\n\n- one\n");
    writeFileSync(join(good, "changelog.d", "bad.fixed.md"), "# heading\n");
    assert.equal(cli("--check", "--root", good).status, 1);
    assert.equal(cli("--root", good).status, 2, "no mode");
    assert.equal(cli("--check", "--release", "1.0.0").status, 2, "two modes");
    assert.equal(cli("--check", "--dry-run").status, 2, "--dry-run only applies to --release");
    assert.equal(cli("--release").status, 2, "missing value");
    assert.equal(cli("--bogus").status, 2);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  console.log("assemble-changelog: self-test passed");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
