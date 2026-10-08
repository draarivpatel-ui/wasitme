#!/usr/bin/env node
// lint-copy.mjs - the copy lint (DESIGN.md §3, D31): words the product must never say to a user.
//
// Usage:
//   node scripts/lint-copy.mjs [options] [path ...]     scan the default scopes, or just the given files/directories
//   node scripts/lint-copy.mjs --list-rules
//
//   --root DIR       repository root (default: the directory above scripts/)
//   --allow FILE     allow-list (default: scripts/lint-copy.allow under the root)
//   --as SCOPE       classify the given paths as "copy", "docs" or "glance" (default: by path)
//   --require-copy   fail (exit 2) when a full scan finds no file in the copy scope (pre-publish: the copy rules must
//                    have run on something; scripts/ci-local.sh --prepublish passes it)
//
// Exit codes: 0 clean, 1 violations (or stale allow-list entries on a full scan), 2 usage error or nothing to scan.
//
// Scopes (a file is scanned in the first scope that matches; see COPY_GLOBS / DOC_GLOBS below):
//   copy    text a user reads: engine copy (words/, output/, cli/, setup/, hook/, demo/), plugin/, plugin-codex/,
//           macos/, ui/, packaging/, contract/fixtures/, .claude-plugin/ (the marketplace listing) and
//           design/demo-data.v*.json (README-screenshot source, D21; v1 is never rendered). Every rule applies.
//   docs    README.md files anywhere, AGENTS, PRIVACY, METHOD, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG,
//           changelog.d/, .github/, docs/ except the internal planning documents (INTERNAL_DOC_GLOBS: the plan,
//           DECISIONS, the merge, status and pre-publish notes, research/, private/, spikes/, spikes-tracked/), which quote the
//           banned words to define the rules. Only the "all" rules apply: the three claims below.
//   glance  a copy file on a glance surface: its path names the status line, status bar or menu bar (statusline,
//           statusbar, menubar, status-item; a path that also says popover/panel/report/onboarding does not count),
//           engine/src/output/glance* and statusline*, or a file carrying the marker comment "wasitme:glance-surface".
//           Adds the verdict-word rule. Popover, pane and report copy is NOT a glance surface ("It feels worse..." is
//           the user's own phrase and stays allowed there).
//
// What is read, per file type (only the text a user would see; see lib/source-scan.mjs):
//   JS/TS            string and template literals, not module specifiers (import ... from "x", import(), require())
//   JSX/TSX          lines, minus import lines and comment-only lines
//   Swift            string literals                       shell (and extensionless #!/bin/sh)   quoted text, heredocs,
//                                                                                                 echo/printf arguments
//   HTML/SVG/XML/xib element text (inline tags dissolved), visible attributes (alt, title, aria-label, placeholder,
//                    ...), inline <script> strings and <style> content: strings; entities (&nbsp; &rsquo; &#39;) decoded
//   CSS              content: strings only                 JSON/.xcstrings   string values (not keys), escapes decoded
//   Markdown         paragraphs, emphasis/link targets/entities removed     other text   lines
//
// Rules ("all" = copy+docs, "copy" = copy only, "glance" = glance surfaces only):
//   pct99                        all     the literal "99%" (also "99 %", "99 percent"): the UI prints "range" (D31)
//   nothing-changed-on-your-side all     must be "Nothing recorded changed on your side" (DESIGN.md §3)
//   nothing-leaves-your-mac      all     overclaims: the honest line is "no networking code of ours" (D44)
//   quality                      copy    except inside the fixed sentence "These indicators don't measure answer quality."
//   score  dumber-smarter  nerf  proves  caused-by  looks-like  after-moved  no-change   (DESIGN.md §3)
//                                        Error-message idioms are not verdicts and pass: "does not look like a directory",
//                                        "caused by ENOENT", "makes no change to your settings" (RULE exceptions below).
//   glance-verdict-word          glance  "worse" / "better" / "nerf" on the status line and menu bar
//
// Allow-list: scripts/lint-copy.allow, one entry per line:  rule | path glob | needle | reason
// (see lib/source-scan.mjs). Use it only for quoted examples. Matching is by needle, never by line number; the needle
// must occur within 80 characters of the finding (so an entry for a quoted example does not also hide a new violation
// further along the same paragraph), and an entry that matches nothing fails a full scan so the list cannot rot.
//
// Honest limits: a banned phrase split across two string literals or assembled at runtime is not seen, and this is
// a tripwire for wording, not a judge of meaning. Strings in code are read, comments are not.

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowWindow, applyAllow, cssContentStrings, extOf, jsonStrings, jsStrings, lineSegments, listFiles, markdownParagraphs,
  markupSegments, matchesAny, normalizeText, paragraphs, parseAllowList, readText, scanSwift, shebangKind, shellCopy,
  staleEntries, TEXT_EXTENSIONS,
} from "./lib/source-scan.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SELF));

// ---------------------------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------------------------

export const COPY_GLOBS = [
  "engine/src/words/**", "engine/src/output/**", "engine/src/cli/**", "engine/src/setup/**", "engine/src/hook/**",
  "engine/src/demo/**", "plugin/**", "plugin-codex/**", "macos/**", "ui/**", "packaging/**", "contract/fixtures/**",
  ".claude-plugin/**",
  // The README-screenshot source (D21) until WP-02 moves the demo data into the engine. demo-data.v2+, not v1:
  // D21 makes v1 non-shippable (never rendered), and it keeps the old wording on purpose as the "before".
  "design/demo-data.v*.json",
];
export const DOC_GLOBS = [
  "README.md", "**/README.md", "AGENTS.md", "PRIVACY.md", "METHOD.md", "CONTRIBUTING.md", "SECURITY.md",
  "CODE_OF_CONDUCT.md", "CHANGELOG.md", "changelog.d/**", "docs/**", ".github/**",
];
export const INTERNAL_DOC_GLOBS = [
  "docs/PLAN.md", "docs/DECISIONS.md", "docs/MERGE.md", "docs/STATUS.md", "docs/PREPUBLISH.md",
  "docs/research/**", "docs/private/**", "docs/spikes/**", "spikes-tracked/**",
];
/** Never scanned: dependencies, build output, spike/reference code, and tests (which quote banned words on purpose). */
export const EXCLUDE_GLOBS = [
  "**/node_modules/**", "**/.build/**", "**/.swiftpm/**", "**/dist/**",
  "engine/reference/**", "macos/reference/**", "plugin/reference/**", "plugin-codex/reference/**", "ui/reference/**",
  "**/test/**", "**/tests/**", "**/Tests/**", "**/__tests__/**", "**/testdata/**", "**/*.test.*", "**/*Tests.swift",
];
const GLANCE_PATH_YES = /statusline|statusbar|menubar|statusitem/;
const GLANCE_PATH_NO = /popover|panel|controlcenter|onboarding|report/; // a menu-bar popover is not the glance string itself
const GLANCE_GLOBS = ["engine/src/output/glance*", "engine/src/output/statusline*", "engine/src/output/status-line*"];
const GLANCE_MARKER = /wasitme:glance-surface\b/;

/** "copy" | "docs" | null (not scanned). */
export function classify(rel) {
  if (matchesAny(rel, EXCLUDE_GLOBS)) return null;
  if (matchesAny(rel, COPY_GLOBS)) return "copy";
  if (matchesAny(rel, DOC_GLOBS) && !matchesAny(rel, INTERNAL_DOC_GLOBS)) return "docs";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Rules. Regexes run on normalizeText() output: lower case, straight quotes, whitespace collapsed.
// ---------------------------------------------------------------------------------------------------------------

const DISCLAIMER = /these indicators don't measure answer quality\./g;

// "Sep. 30" or "e.g. a restart" is not the end of a sentence; after-moved must keep reading past it. The dot is replaced
// by a same-length character so match offsets stay valid.
const ABBREVIATION_DOT = /\b(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|vs|approx|cf|e\.g|i\.e)\./g;
const keepSentence = (s) => s.replace(ABBREVIATION_DOT, (m) => m.slice(0, -1) + "·");

// Error-message idioms (CLI, installer, hooks): factual statements about files and errors, not verdicts.
const NOT_A_GUESS = /\b(?:does ?n[o']?t|did ?n[o']?t|do ?n[o']?t|does not|did not|do not) look like (?:a |an |the )?(?:valid )?(?:directory|folder|file|path|url|number|date|time|version|json|jsonl|session log|log file|git repo(?:sitory)?|plist|config(?:uration)?(?: file)?|integer|duration)\b/g;
const ERRNO_CAUSE = /\bcaused by:? (?:enoent|eacces|eperm|eexist|enotdir|eisdir|ebusy|emfile|enfile|eagain|econnrefused|econnreset|epipe|eio|enospc|erofs|etimedout|enotempty|exdev|eloop|enametoolong|sigterm|sigkill|sigint|sighup|sigpipe)\b/g;
const NO_CHANGE_TO_FILES = /\b(?:makes?|made|making|will make|with|and) no changes? to (?:your |the |any )?(?:settings|configuration|config|files?|system|disk|machine|mac|keychain|shell|profile|path)\b/g;

export const RULES = [
  { id: "pct99", scope: "all", re: /(?<![0-9.,])99 ?(?:%|percent\b|per cent\b)/g,
    message: 'never print "99%": the interface says "range" and METHOD.md states the measured coverage (D31)' },
  { id: "nothing-changed-on-your-side", scope: "all", re: /nothing changed on your side/g,
    message: 'say "Nothing recorded changed on your side": wasitme only sees what the logs recorded (DESIGN.md §3)' },
  { id: "nothing-leaves-your-mac", scope: "all", re: /nothing (?:ever )?leaves your mac/g,
    message: 'overclaim: the update command and WebKit helper processes exist; use the honest line "no networking code of ours" (D44)' },
  { id: "quality", scope: "copy", re: /\bquality\b/g, pre: (s) => s.replace(DISCLAIMER, (m) => " ".repeat(m.length)),
    message: 'counts are indicators, not quality; only the fixed disclaimer sentence may use the word (DESIGN.md §3)' },
  { id: "score", scope: "copy", re: /\bscor(?:e|es|ed|ing)\b/g, message: "never a score: counts are indicators (DESIGN.md §3)" },
  { id: "dumber-smarter", scope: "copy", re: /\b(?:dumber|smarter)\b/g, message: "banned comparison word (DESIGN.md §3)" },
  { id: "nerf", scope: "copy", re: /\bnerf(?:ed|s|ing)?\b/g, message: "banned verdict word (DESIGN.md §3)" },
  { id: "proves", scope: "copy", re: /\bproves\b/g, message: 'evidence, not proof: never "proves" (DESIGN.md §3)' },
  { id: "caused-by", scope: "copy", re: /\bcaused by\b/g, except: ERRNO_CAUSE, message: "no causal claims without evidence (DESIGN.md §3)" },
  { id: "looks-like", scope: "copy", re: /\blooks? like\b/g, except: NOT_A_GUESS, message: 'hedged guessing: state what was measured instead of "looks like" (DESIGN.md §3)' },
  // The span between "after" and the verb is bounded (300 characters, one sentence): unbounded, one long line of
  // repeated "after" took minutes (quadratic backtracking).
  { id: "after-moved", scope: "copy", re: /\bafter\b(?:(?![.!?](?:\s|$)).){0,300}?\b(?:doubled|rose|fell)\b/g, pre: keepSentence,
    message: '"after X ... rose/fell/doubled" implies causation; give the time and the numbers (DESIGN.md §3)' },
  { id: "no-change", scope: "copy", re: /\bno change\b/g, except: NO_CHANGE_TO_FILES, message: 'a bare "no change" overclaims; say "No detectable change" with what would have shown (DESIGN.md §3)' },
  { id: "glance-verdict-word", scope: "glance", re: /\b(?:worse(?:n(?:s|ed|ing)?)?|better|nerf(?:ed|s|ing)?)\b/g,
    message: "the status line and menu bar show a state, never a verdict word" },
];

const appliesTo = (rule, scope, glance) =>
  rule.scope === "all" || (scope === "copy" && (rule.scope === "copy" || (rule.scope === "glance" && glance)));

// ---------------------------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------------------------

/** JSX/TSX: lines, without import/export-from lines and comment-only lines (JSX text is not a string literal). */
function jsxLines(text) {
  return lineSegments(text).filter((s) => !/^\s*(?:import\b|export\b[^"'`]*\bfrom\s*["'`]|\/\/|\/\*|\*)/.test(s.text));
}

/** The strings a user would read in this file, as [{text, line}]. `lang` defaults to the extension. */
export function segmentsFor(rel, text, lang = extOf(rel)) {
  switch (lang) {
    case "js": case "mjs": case "cjs": case "ts": case "mts": case "cts":
      return jsStrings(text).filter((s) => !s.specifier);
    case "jsx": case "tsx":
      return jsxLines(text);
    case "swift":
      return scanSwift(text).strings.map((s) => ({ text: s.text, line: s.line }));
    case "sh": case "bash": case "zsh":
      return shellCopy(text);
    case "md": case "markdown": case "mdx":
      return markdownParagraphs(text);
    case "txt":
      return paragraphs(text);
    case "html": case "htm": case "xhtml": case "svg": case "xml": case "xib": case "storyboard": case "stringsdict": case "plist":
      return markupSegments(text);
    case "css":
      return cssContentStrings(text);
    case "json": case "xcstrings":
      return jsonStrings(text);
    default:
      return lineSegments(text);
  }
}

export function isGlanceSurface(rel, text) {
  if (GLANCE_MARKER.test(text)) return true;
  if (matchesAny(rel, GLANCE_GLOBS)) return true;
  const flat = rel.toLowerCase().replace(/[-_ ]/g, "");
  return GLANCE_PATH_YES.test(flat) && !GLANCE_PATH_NO.test(flat);
}

/** Findings for one file: [{file, line, rule, match, message, context, window}]. `scope` is "copy" or "docs". */
export function lintText(rel, text, { scope = "copy", glance = isGlanceSurface(rel, text), lang } = {}) {
  const findings = [];
  for (const seg of segmentsFor(rel, text, lang)) {
    const norm = normalizeText(seg.text);
    for (const rule of RULES) {
      if (!appliesTo(rule, scope, glance)) continue;
      const hay = rule.pre ? rule.pre(norm) : norm;
      const excepted = rule.except ? [...hay.matchAll(rule.except)].map((m) => [m.index, m.index + m[0].length]) : [];
      for (const m of hay.matchAll(rule.re)) {
        if (excepted.some(([a, b]) => m.index >= a && m.index < b)) continue;
        findings.push({
          file: rel, line: seg.line, rule: rule.id, match: m[0], message: rule.message, context: seg.text,
          window: allowWindow(hay, m.index, m[0].length),
        });
      }
    }
  }
  return findings;
}

function expandPaths(root, paths) {
  const out = [];
  const walk = (abs) => {
    let st;
    try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) if (name !== ".git" && name !== "node_modules") walk(join(abs, name));
    } else if (st.isFile()) out.push(relative(root, abs).split("\\").join("/"));
  };
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    if (!existsSync(abs)) throw new Error(`no such path: ${p}`);
    walk(abs);
  }
  return out;
}

export function main(argv, io = { out: (m) => process.stdout.write(m + "\n"), err: (m) => process.stderr.write(m + "\n") }) {
  let root = REPO_ROOT;
  let allowPath = null;
  let forcedScope = null;
  let requireCopy = false;
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list-rules") {
      for (const r of RULES) io.out(`${r.id.padEnd(30)} ${r.scope.padEnd(7)} ${r.message}`);
      return 0;
    }
    if (a === "--root" || a === "--allow" || a === "--as") {
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("--")) { io.err(`lint-copy: ${a} needs a value`); return 2; }
      if (a === "--root") root = resolve(v);
      else if (a === "--allow") allowPath = resolve(v);
      else forcedScope = v;
    } else if (a === "--require-copy") requireCopy = true;
    else if (a === "-h" || a === "--help") { io.out("usage: lint-copy.mjs [--root DIR] [--allow FILE] [--as copy|docs|glance] [--require-copy] [path ...] | --list-rules"); return 0; }
    else if (a.startsWith("--")) { io.err(`lint-copy: unknown option ${a}`); return 2; }
    else paths.push(a);
  }
  if (forcedScope && !["copy", "docs", "glance"].includes(forcedScope)) { io.err("lint-copy: --as takes copy, docs or glance"); return 2; }

  const fullScan = paths.length === 0;
  allowPath ??= join(root, "scripts", "lint-copy.allow");
  let allow = { entries: [], errors: [] };
  if (existsSync(allowPath)) {
    allow = parseAllowList(readFileSync(allowPath, "utf8"), { source: relative(root, allowPath) || allowPath, rules: RULES.map((r) => r.id) });
    if (allow.errors.length) { for (const e of allow.errors) io.err(`lint-copy: ${e}`); return 2; }
  }

  let files;
  try {
    files = fullScan ? listFiles(root) : expandPaths(root, paths);
  } catch (e) {
    io.err(`lint-copy: ${e.message}`);
    return 2;
  }

  let scanned = 0;
  const perScope = { copy: 0, docs: 0, glance: 0 };
  const violations = [];
  for (const rel of files) {
    const ext = extOf(rel);
    if (ext && !TEXT_EXTENSIONS.has(ext)) continue;
    let scope = forcedScope ? (forcedScope === "docs" ? "docs" : "copy") : classify(rel);
    if (!scope && !fullScan) scope = "copy"; // an explicitly named file outside the scopes is still linted as copy
    if (!scope) continue;
    const text = readText(root, rel);
    if (text === null) continue;
    let lang = ext;
    if (!ext) {
      // Extensionless: a script is read by its shebang (plugin/statusline, bin/wasitme); anything else is not copy.
      lang = shebangKind(text);
      if (!lang) continue;
    }
    scanned++;
    const glance = forcedScope === "glance" ? true : forcedScope ? false : isGlanceSurface(rel, text);
    perScope[scope]++;
    if (scope === "copy" && glance) perScope.glance++;
    for (const f of lintText(rel, text, { scope, glance, lang })) {
      if (!applyAllow(allow.entries, f, f.context)) violations.push(f);
    }
  }

  if (scanned === 0) {
    io.err("lint-copy: nothing to scan (no files in the copy or docs scopes); refusing to pass vacuously");
    return 2;
  }
  for (const v of violations) io.err(`${v.file}:${v.line}: [${v.rule}] "${v.match}" - ${v.message}`);
  let stale = [];
  if (fullScan) {
    stale = staleEntries(allow.entries);
    for (const e of stale) io.err(`${e.source}:${e.line}: [stale-allow] "${e.rule} | ${e.glob}" matches nothing; remove it`);
  }
  const counts = `copy=${perScope.copy} (glance=${perScope.glance}) docs=${perScope.docs}`;
  io.out(`lint-copy: ${scanned} file(s) scanned [${counts}], ${violations.length} violation(s)${stale.length ? `, ${stale.length} stale allow-list entr${stale.length === 1 ? "y" : "ies"}` : ""}`);
  if (requireCopy && fullScan && perScope.copy === 0) {
    io.err("lint-copy: --require-copy: no file in the copy scope was scanned, so the copy rules ran on nothing");
    return 2;
  }
  return violations.length || stale.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
