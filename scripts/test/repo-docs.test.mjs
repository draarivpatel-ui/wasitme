// Regression tests for the repository's own documents and metadata: that the public/private split holds, that the claims the
// docs make about calibration, the network, child processes and the CLI match the artifact and the code, and that the npm
// package metadata is complete. Each test pins a mistake an audit found (docs/PREPUBLISH.md, SECURITY.md, README.md).
// Tests that read internal-only files (the pre-publish checklist) skip themselves in the public tree, where those are absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadForbiddenPhrases } from "../check-repo.mjs";
import { internalPaths } from "../lib/doc-links.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const has = (rel) => existsSync(join(ROOT, rel));
const lines = (text) => text.split("\n");

function gitOk(...args) {
  try { execFileSync("git", ["-C", ROOT, ...args], { stdio: "ignore" }); return true; } catch { return false; }
}
const inRepo = gitOk("rev-parse", "--git-dir");

/** Markdown files that ship in the public tree and that this repository's prose rules apply to. */
function shippedDocs() {
  const internal = existsSync(join(ROOT, ".gitattributes")) ? internalPaths(ROOT) : [];
  const out = ["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "THIRD_PARTY_NOTICES.md"].filter(has);
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".md")) out.push(rel);
    }
  };
  walk("docs");
  return out.filter((f) => !internal.some((d) => f === d || f.startsWith(`${d}/`))).sort();
}

// ---- the public / private split ------------------------------------------------------------------------------------

test("AGENTS.md holds the public rules and CLAUDE.md only points at it", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /Rules that never bend/);
  assert.match(agents, /Never read the real agent folders/);
  assert.match(agents, /Do not push, tag, publish/);
  const claude = read("CLAUDE.md");
  assert.ok(lines(claude).length <= 12, "CLAUDE.md must stay minimal");
  assert.match(claude, /^@AGENTS\.md$/m, "CLAUDE.md must import AGENTS.md");
  for (const [name, text] of [["AGENTS.md", agents], ["CLAUDE.md", claude]]) {
    assert.doesNotMatch(text, /\bfounder\b/i, `${name} must not carry personal operating notes`);
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]/, `${name} must not carry a home path`);
  }
});

test("private notes are gitignored and untracked", { skip: inRepo ? false : "not a git checkout" }, () => {
  assert.equal(gitOk("check-ignore", "-q", "CLAUDE.local.md"), true, "CLAUDE.local.md must be gitignored");
  assert.equal(gitOk("check-ignore", "-q", "docs/private/notes.md"), true, "docs/private/ must be gitignored");
  assert.equal(gitOk("ls-files", "--error-unmatch", "CLAUDE.local.md"), false, "CLAUDE.local.md must not be tracked");
  assert.equal(gitOk("check-ignore", "-q", "node_modules"), true, "node_modules must be ignored even as a symlink (a linked worktree install)");
});

test("the shipped prose never says 'founder'", () => {
  assert.deepEqual(shippedDocs().filter((f) => /\bfounder\b/i.test(read(f))), []);
});

// Plan, billing and tooling phrases from private notes are configured, never written in a tracked file (a list here
// would publish what it guards): WASITME_FORBIDDEN_PHRASES or the gitignored .ci-local.env (see .ci-local.env.example),
// as scripts/dev/export-public.sh reads them. Without them this check cannot run, and says so. A hit names the phrase
// by its position in that list, never by its text.
const forbiddenPhrases = (() => { try { return loadForbiddenPhrases(ROOT); } catch (e) { return { phrases: [], error: e.message }; } })();
const phraseSkip = forbiddenPhrases.phrases.length || forbiddenPhrases.error ? false
  : "no forbidden phrase configured (set WASITME_FORBIDDEN_PHRASES or add it to .ci-local.env)";
test("no shipped file contains a configured private phrase", { skip: phraseSkip }, () => {
  assert.equal(forbiddenPhrases.error, undefined, "the forbidden-phrase configuration could not be read");
  const phrases = forbiddenPhrases.phrases.map((p) => p.toLowerCase());
  const bad = [];
  for (const f of shippedTextFiles()) {
    const text = read(f).toLowerCase();
    phrases.forEach((p, i) => { if (text.includes(p)) bad.push(`${f}: forbidden phrase ${i + 1} of ${phrases.length} (in ${forbiddenPhrases.source})`); });
  }
  assert.deepEqual(bad, []);
});

// D72: a shipped file (code, comments, tests, docs, data) cites only what ships. The plan, the status and merge notes,
// the pre-publish checklist and the real-log study (research/06) are export-ignored, and DECISIONS.md withdraws the
// operating rows, so a citation of any of them points nowhere in the public tree; the owner is "the maintainer".

/** Every text file that ships: tracked and untracked-but-not-ignored files minus the export-ignore paths, or a plain
 *  walk when this is not a git checkout (a source tarball). Binary files (a NUL byte in the first 8 KB) are skipped. */
function shippedTextFiles() {
  const internal = existsSync(join(ROOT, ".gitattributes")) ? internalPaths(ROOT) : [];
  let files;
  if (inRepo) {
    files = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
      .split("\0").filter(Boolean);
  } else {
    files = [];
    const walk = (dir) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!/^(\.git|node_modules|dist|\.build|\.swiftpm)$/.test(e.name)) walk(rel); }
        else if (e.isFile()) files.push(rel);
      }
    };
    walk("");
  }
  return [...new Set(files)].filter((f) => has(f) && !internal.some((d) => f === d || f.startsWith(`${d}/`))).sort()
    .filter((f) => { const b = readFileSync(join(ROOT, f)); return !b.subarray(0, 8192).includes(0); });
}

/** Rows DECISIONS.md withdraws from the public record (read from the file, so a later withdrawal is covered too). */
function withdrawnRows() {
  return new Set([...read("docs/DECISIONS.md").matchAll(/^\| (D\d+) \|[^\n]*Withdrawn from the public record/gm)].map((m) => m[1]));
}

// Files that must name the private documents: the export tooling and its tests list what to leave out, lint-copy and
// release.sh exclude them by path, doc-links' test uses one as a fixture, and this file spells every pattern.
const NAMES_PRIVATE_PATHS = new Set([
  "scripts/dev/export-public.sh", "scripts/test/export-public.test.mjs", "scripts/test/repo-docs.test.mjs",
  "scripts/lint-copy.mjs", "scripts/test/lint-copy.test.mjs", "scripts/release.sh", "scripts/test/doc-links.test.mjs",
]);
// Files exempt from every check below: the export tooling spells the private file names in prose, and this file the patterns.
const EXEMPT = new Set(["scripts/dev/export-public.sh", "scripts/test/export-public.test.mjs", "scripts/test/repo-docs.test.mjs"]);
// A private document named by its file name (one match for test() and match(); the /g copy removes every one).
const PRIVATE_PATH = /\b(?:docs\/)?(?:PLAN|STATUS|MERGE|PREPUBLISH|GUARDRAILS|TESTING-FOUNDER)\.md\b|\bresearch\/06\b|06-local-log-structure/;
const PRIVATE_PATHS_G = new RegExp(PRIVATE_PATH.source, "g");

/** The D72 findings for one shipped file's text, as "file:line: what" strings. */
function privateRefs(f, text, withdrawn) {
  if (EXEMPT.has(f)) return [];
  // DECISIONS.md lists the withdrawn rows themselves (the id cell) and D71 names them once; neither is a citation.
  if (f === "docs/DECISIONS.md") text = text.replace(/^\| D\d+ \|/gm, "|").replace(/withdraws the operating rows [^.|]*\./, "withdraws the operating rows.");
  const bad = [];
  lines(text).forEach((line, i) => {
    const at = `${f}:${i + 1}`;
    if (PRIVATE_PATH.test(line) && !NAMES_PRIVATE_PATHS.has(f)) bad.push(`${at}: names a private document (${line.match(PRIVATE_PATH)[0]})`);
    const rest = line.replace(PRIVATE_PATHS_G, "");
    if (/\bfounder\b/i.test(rest)) bad.push(`${at}: says "founder" (use "maintainer")`);
    if (/\bPLAN\b/.test(rest)) bad.push(`${at}: cites the plan, which does not ship (cite METHOD, CONTRACT, PRIVACY, SECURITY, DESIGN or a published D-row, or drop it)`);
    for (const m of rest.matchAll(/\bD(\d+)\b/g)) if (withdrawn.has(`D${m[1]}`)) bad.push(`${at}: cites ${m[0]}, a withdrawn decision row`);
  });
  return bad;
}

test("D72: the private-reference check flags what it should and passes what it should", () => {
  const w = new Set(["D41", "D55"]);
  const flagged = (f, line) => privateRefs(f, line, w).length > 0;
  for (const line of [
    "// the founder's Mac", "Founder, 2026-10-04", "(PLAN §5.9 row 3)", "PLAN 5.4: analytic SE", "the PLAN's flags", "see docs/PLAN.md",
    "(MERGE.md freeze item)", "docs/PREPUBLISH.md", "research/06 observed", "per D41", "(D55)", "D40–D41",
  ]) assert.ok(flagged("engine/src/x.ts", line), `not flagged: ${line}`);
  for (const line of [
    "assessConfounders(confounders)", "a plan day", "PLAN_DAYS", "ONSET_PLAN_DAY + 1", "(METHOD.md §11 row 3)", "D39, D410, D4",
    "research/07 and research/08", "CLAUDE.local.md is read", "the maintainer's call (D15)",
  ]) assert.ok(!flagged("engine/src/x.ts", line), `flagged: ${line}`);
  // Tooling that excludes the private files may name their paths, but not cite the plan or say "founder".
  assert.ok(!flagged("scripts/lint-copy.mjs", '"docs/PLAN.md", "docs/STATUS.md",'));
  assert.ok(flagged("scripts/lint-copy.mjs", "// the copy lint from PLAN §5.10"));
  // DECISIONS.md: a withdrawn row's own id cell and D71's list are not citations; a citation in another row is.
  assert.deepEqual(privateRefs("docs/DECISIONS.md", "| D41 | Withdrawn from the public record. |\n| D71 | withdraws the operating rows D41 and D55. |", w), []);
  assert.equal(privateRefs("docs/DECISIONS.md", "| D60 | supersedes D41. |", w).length, 1);
});

test("D72: no shipped file says 'founder', cites the plan or a private document, or cites a withdrawn decision row", () => {
  const withdrawn = withdrawnRows();
  assert.ok(withdrawn.size >= 1, "DECISIONS.md marks no row 'Withdrawn from the public record'; the check below would be empty");
  assert.deepEqual(shippedTextFiles().flatMap((f) => privateRefs(f, read(f), withdrawn)), []);
});

// Work-package ids (WP-12, WP-20b, WP-10Δ ...) are cited all over the shipped code, and the plan that defines them does not
// ship. docs/WORK-PACKAGES.md is the public key, so it must have a row for every id a shipped file cites, and no row that
// nothing cites any more. The "/" shorthand (WP-10/11, WP-20a/20b) names both ids; a Δ suffix names the same id.
const WP_GLOSSARY = "docs/WORK-PACKAGES.md";
const WP_ID = /\bWP-(\d+[a-z]?)(?:\/(\d+[a-z]?))?/g;

/** The WP ids `text` cites, with the "/" shorthand expanded. */
function wpIds(text) {
  const out = new Set();
  for (const m of text.matchAll(WP_ID)) for (const id of [m[1], m[2]]) if (id) out.add(`WP-${id}`);
  return out;
}

/** The ids the glossary has a table row for (first cell), and the ids its prose mentions anywhere. */
function glossaryIds(text) {
  const rows = new Set([...text.matchAll(/^\| (WP-\d+[a-z]?) \|/gm)].map((m) => m[1]));
  return { rows, mentioned: wpIds(text) };
}

test("WP ids: the extractor reads plain, suffixed and slash-joined citations", () => {
  assert.deepEqual([...wpIds("WP-12 review; WP-10Δ; WP-20a/20b; WP-10/11; wp-99 is not an id; WP-7b")].sort(), ["WP-10", "WP-11", "WP-12", "WP-20a", "WP-20b", "WP-7b"]);
  const g = glossaryIds("| Id | What |\n|---|---|\n| WP-01 | scaffolding, `WP-01Δ` its review |\n| WP-30 | the CLI |\nProse about WP-12.\n");
  assert.deepEqual([...g.rows].sort(), ["WP-01", "WP-30"]);
  assert.deepEqual([...g.mentioned].sort(), ["WP-01", "WP-12", "WP-30"]);
});

test("every WP id a shipped file cites has a row in docs/WORK-PACKAGES.md, and every row is still cited", () => {
  assert.ok(has(WP_GLOSSARY), `${WP_GLOSSARY} is missing`);
  const { rows } = glossaryIds(read(WP_GLOSSARY));
  assert.ok(rows.size >= 10, `${WP_GLOSSARY} has only ${rows.size} rows; is the table intact?`);
  const citedBy = new Map(); // id -> first file that cites it
  for (const f of shippedTextFiles()) {
    if (f === WP_GLOSSARY || f === "scripts/test/repo-docs.test.mjs") continue; // this file spells sample ids above

    for (const id of wpIds(read(f))) if (!citedBy.has(id)) citedBy.set(id, f);
  }
  assert.ok(citedBy.size >= 10, `only ${citedBy.size} WP ids found in shipped files; is the scan right?`);
  const sortIds = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const missing = [...citedBy].filter(([id]) => !rows.has(id)).map(([id, f]) => `${id} (cited in ${f})`).sort(sortIds);
  assert.deepEqual(missing, [], `WP ids cited in shipped files with no row in ${WP_GLOSSARY}`);
  const stale = [...rows].filter((id) => !citedBy.has(id)).sort(sortIds);
  assert.deepEqual(stale, [], `rows in ${WP_GLOSSARY} that no shipped file cites any more`);
});

test("check-repo.allow tolerates nothing: every entry would be a pre-publish blocker", () => {
  const entries = lines(read("scripts/check-repo.allow")).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  assert.deepEqual(entries, []);
});

// ---- claims that must match the calibration artifact -----------------------------------------------------------------

const artifact = JSON.parse(read("docs/calibration/2026-10-05.json"));
const pct = (x) => `${(Math.ceil(x * 10000) / 100).toFixed(2).replace(/0$/, "")}%`;

test("README and METHOD state the calibration the shipped artifact records, and no stale 'pending' claim", () => {
  const rows = artifact.gNullSeq;
  const total = rows.reduce((n, r) => n + r.sequences, 0);
  assert.equal(total, 7000);
  assert.ok(rows.every((r) => r.falseChanged.k === 0 && r.falseAgent.k === 0), "the claim 'no false alarms' needs 0 in every profile");
  const upper = Math.max(...rows.flatMap((r) => [r.falseChanged.hi, r.falseAgent.hi]));
  assert.equal(pct(upper), "0.37%");
  assert.deepEqual(Object.keys(artifact.calibrated).sort(), ["claude-code", "codex"]);
  assert.ok(Object.values(artifact.calibrated).every((a) => a.calibrated === true));

  const readme = read("README.md");
  assert.match(readme, /7,000/);
  assert.match(readme, /0\.37%/);
  assert.match(read("docs/METHOD.md"), /0\.37%/);
  // Power: "k of 40" for every profile is in METHOD, and README's range is the min and max of them.
  const method = read("docs/METHOD.md");
  for (const p of artifact.power) assert.ok(method.includes(`${p.detected.k} of ${p.detected.n}`), `METHOD.md misses ${p.profile}: ${p.detected.k} of ${p.detected.n}`);
  const weak = artifact.power.filter((p) => ["few-long", "few-long-hd", "sparse-failures", "codex"].includes(p.profile)).map((p) => p.detected.k);
  const strong = artifact.power.filter((p) => ["many-short", "single-project", "multi-project"].includes(p.profile)).map((p) => p.detected.k);
  assert.match(readme, new RegExp(`${Math.min(...strong)} to ${Math.max(...strong)} of 40`));
  assert.match(readme, new RegExp(`${Math.min(...weak)} to ${Math.max(...weak)} of 40`));

  for (const f of ["README.md", "docs/METHOD.md", "docs/FORMATS.md", "docs/CONTRACT.md", "SECURITY.md", "CONTRIBUTING.md"]) {
    const text = read(f);
    for (const stale of [/No agent is calibrated yet/, /no agent had passed/i, /\*\*pending calibration\*\*/i, /Pending calibration/, /chosen: null/, /Codex is timeline only/i, /until its own calibration passes, and/i]) {
      assert.doesNotMatch(text, stale, `${f} still says ${stale}`);
    }
  }
  for (const f of ["design/system/DESIGN.md"].filter(has)) {
    // DESIGN.md belongs to the design owner; only reported here, not failed.
    if (/calibration pending/i.test(read(f))) process.stderr.write(`note: ${f} still says "calibration pending" (design owner)\n`);
  }
  // The changelog describes 0.1.0 as it is: no projected dates, no "timeline-only until" promise.
  for (const f of readdirSync(join(ROOT, "changelog.d")).filter((n) => n.endsWith(".md") && n !== "README.md")) {
    const text = read(`changelog.d/${f}`);
    assert.doesNotMatch(text, /roughly when|at the current pace|timeline-only until|stays timeline-only|it still shows "Timeline only"/i, f);
    assert.doesNotMatch(text, /(^|\s)Before, /, `${f} describes a change against an unreleased state`);
    // Until a version is released there is nothing to fix, change or remove: every fragment describes what 0.1.0 has.
    if (!has("CHANGELOG.md") || !/^## \d+\.\d+\.\d+/m.test(read("CHANGELOG.md"))) {
      assert.match(f, /\.added\.md$/, `${f}: before the first release every fragment is 'added' (nothing released can be fixed or changed)`);
    }
  }
});

// ---- claims that must match the code ---------------------------------------------------------------------------------

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|mjs|js)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test("SECURITY.md describes exactly the program launches the engine has", () => {
  const marked = sourceFiles("engine/src").filter((f) => /wasitme:allow-child_process/.test(read(f)));
  assert.deepEqual(marked, ["engine/src/cli/commands/doctor.ts", "engine/src/store/permission.ts"]);
  const security = read("SECURITY.md");
  assert.match(security, /exactly two places/);
  assert.match(security, /`xcode-select -p` and\s+`swift --version`/);
  assert.match(security, /<this node> --permission -e 0/);
  assert.doesNotMatch(security, /contains no code that opens a\s+connection, starts another program/);
  assert.doesNotMatch(security, /Symbolic links to \*files\* inside the agent log directories are followed/);
  assert.match(security, /SessionStart hook reads six fixed\s+names/);
  // The six names are the engine's own list.
  const projsnap = read("engine/src/store/projsnap.ts");
  for (const name of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json", ".mcp.json"]) {
    assert.ok(security.includes(`\`${name}\``), `SECURITY.md misses ${name}`);
  }
  assert.equal((projsnap.match(/^\s*\{ id: "/gm) ?? []).length, 6, "engine/src/store/projsnap.ts no longer lists six project files; update SECURITY.md and PRIVACY.md");
  assert.match(read("CONTRIBUTING.md"), /two marked spawns/);
});

test("no document names a wasitme command that does not exist, and `wasitme update` downloads nothing", () => {
  const main = read("engine/src/cli/main.ts");
  // The commands the CLI dispatches. Every surface's "Update needed" line names `wasitme update`, so it must be one of them.
  const commands = new Set([...main.matchAll(/cmd === "([a-z][a-z-]*)"/g)].map((m) => m[1]));
  assert.ok(commands.has("update"), "the CLI has no `update` command, but every 'Update needed' line names it");
  // `update` only says how to update: the engine has no network code (check-no-network enforces it), so no document
  // may describe it as the one networked command.
  assert.doesNotMatch(main.slice(main.indexOf("function update(")), /^import|fetch\(|node:https?|node:net/m);
  const named = (text) => {
    const out = [];
    for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
      const m = /^(?:~\/\.local\/bin\/)?wasitme ([a-z][a-z-]*)/.exec(span);
      if (m) out.push(m[1]);
    }
    for (const [, block] of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      for (const m of block.matchAll(/^\s*(?:\$\s*)?(?:~\/\.local\/bin\/)?wasitme ([a-z][a-z-]*)/gm)) out.push(m[1]);
    }
    return out;
  };
  // Dated research and spike notes discuss proposed commands (`wasitme ingest`, `wasitme uninstall`); they are not instructions.
  const docs = [...shippedDocs().filter((f) => !/^docs\/(research|spikes)\//.test(f)), ...["engine/README.md", "plugin/README.md", "macos/README.md"].filter(has)];
  const unknown = docs.flatMap((f) => named(read(f)).filter((c) => !commands.has(c)).map((c) => `${f}: wasitme ${c}`));
  assert.deepEqual(unknown, []);
  const bad = docs.filter((f) => /`update`, which runs only|network code except/i.test(read(f)));
  assert.deepEqual(bad, []);
  // The app's and canvas's privacy line comes from the design tokens; it must say what README and PRIVACY say.
  if (has("design/system/tokens.json")) {
    assert.equal(JSON.parse(read("design/system/tokens.json")).copy.privacyLine, "No network code. Only the installer downloads, and only when you run it.");
  }
  assert.match(read("README.md"), /No network code\. Only the installer downloads, and only when you run it\./);
  assert.match(read("docs/PRIVACY.md"), /No network code\. Only the installer downloads, and only when you run it\./);
});

test("the docs call the interface term 'finding', and report --format json is marked as not share-safe", () => {
  for (const f of ["SECURITY.md", "CONTRIBUTING.md", "README.md"]) assert.doesNotMatch(read(f), /\bverdicts?\b/i, `${f} says verdict`);
  const readme = read("README.md");
  assert.match(readme, /report --format json/);
  assert.match(readme, /\*\*not\*\* safe to share/);
  assert.doesNotMatch(readme, /`--md`, `--html` or\s+`--format json`/);
});

test("the read-only limit is documented where users look: README and the plugin docs", () => {
  assert.match(read("README.md"), /Plugin-only and `--until` reports leave out your configuration history/);
  assert.match(read("plugin/README.md"), /configuration history/);
  // The claim it rests on is in the code: the config and project snapshots are loaded only when the scan is not read-only.
  const scan = read("engine/src/store/scan.ts");
  assert.match(scan, /if \(!ro\) \{\s*cfg = loadConfigHistory/);
  assert.match(read("engine/src/cli/source.ts"), /o\.readOnly \|\| o\.until !== undefined/);
});

test("the bug report form asks for `wasitme doctor --redacted`, which exists", () => {
  assert.match(read(".github/ISSUE_TEMPLATE/bug_report.yml"), /wasitme doctor --redacted/);
  assert.match(read("engine/src/cli/commands/doctor.ts"), /--redacted/);
});

// ---- package metadata -------------------------------------------------------------------------------------------------

test("engine/package.json can be published with provenance: repository, homepage, bugs, a README, a current lockfile", () => {
  const pkg = JSON.parse(read("engine/package.json"));
  assert.equal(pkg.repository?.type, "git");
  assert.match(pkg.repository?.url ?? "", /^git\+https:\/\/github\.com\/[^/]+\/wasitme\.git$/);
  assert.equal(pkg.repository?.directory, "engine");
  assert.match(pkg.homepage ?? "", /^https:\/\/github\.com\/[^/]+\/wasitme#readme$/);
  assert.match(pkg.bugs?.url ?? "", /^https:\/\/github\.com\/[^/]+\/wasitme\/issues$/);
  // Every file the package lists exists, except the built output and the LICENSE that release.yml copies in.
  for (const f of pkg.files.filter((x) => !x.startsWith("dist/") && !x.startsWith("!") && x !== "LICENSE")) assert.ok(has(`engine/${f}`), `engine/${f} is listed in "files" but missing`);
  assert.ok(pkg.files.includes("LICENSE"));
  if (has(".github/workflows/release.yml")) assert.match(read(".github/workflows/release.yml"), /cp LICENSE engine\/LICENSE/);
  // The lockfile's workspace entry agrees with package.json.
  const lock = JSON.parse(read("package-lock.json"));
  assert.deepEqual(lock.packages.engine.engines, pkg.engines);
  assert.deepEqual(lock.packages.engine.devDependencies, pkg.devDependencies);
  assert.equal(lock.packages.engine.version, pkg.version);
});

// ---- the pre-publish checklist (private tree only) -----------------------------------------------------------------------

const prepublish = has("docs/PREPUBLISH.md");
test("PREPUBLISH.md lists every launch placeholder, every GitHub setting and the export path", { skip: prepublish ? false : "internal file, absent from the public tree" }, () => {
  const text = read("docs/PREPUBLISH.md");
  assert.match(text, /export-public\.sh/);
  for (const needle of [
    "private vulnerability reporting", "environment named `release`", "WASITME_FORBIDDEN_EMAILS", "CI passed", "new-agent",
    "two-factor", "shellcheck", "CODE_OF_CONDUCT.md", "noreply",
  ]) assert.ok(text.includes(needle), `PREPUBLISH.md does not mention ${needle}`);
  assert.doesNotMatch(text, /\/Users\//, "the checklist must not spell out a home path");
  // Every file that still carries the OWNER placeholder is named in the checklist.
  if (inRepo) {
    const files = execFileSync("git", ["-C", ROOT, "grep", "-l", "-I", "OWNER" + "/wasitme", "--", ".", ":!docs/PREPUBLISH.md", ":!docs/STATUS.md", ":!docs/PLAN.md", ":!docs/research", ":!docs/spikes", ":!scripts/test", ":!scripts/dev/export-public.sh"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const unlisted = files.filter((f) => !text.includes(f));
    assert.deepEqual(unlisted, [], "files with the OWNER placeholder that PREPUBLISH.md does not name");
  }
});
