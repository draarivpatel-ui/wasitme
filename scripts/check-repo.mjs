#!/usr/bin/env node
// check-repo.mjs - repository greps: things that must never reach a public repo or a shipped build.
//
// Usage:
//   node scripts/check-repo.mjs [options]
//
//   --root DIR              repository root (default: the directory above scripts/)
//   --rules a,b             run only these rules (default: all; see --list-rules)
//   --allow FILE            allow-list (default: scripts/check-repo.allow under the root)
//   --strict                pre-publish mode: ignore the allow-list completely (D27), and fail
//                           when a file with a text extension could not be read as text (binary-looking or over 4 MB)
//   --require-email-config  fail (exit 2) instead of skipping when no forbidden email is configured
//   --walk-all              outside a git repository, scan every folder (dist/, node_modules/, .build/ too; only .git
//                           is skipped), and count dist/ as shipped for remote-asset-url: for an unpacked release tree,
//                           where dist/ is the code that ships (scripts/release.sh)
//   --git-identity          instead of scanning files, check every commit's author and committer (all refs, plus
//                           annotated tags' taggers): each email must be a GitHub noreply address, and no name, email
//                           or message may contain a configured forbidden address. Values are never printed.
//   --list-rules
//
// Exit codes: 0 clean, 1 findings (or stale allow-list entries on a full scan), 2 usage/config error.
//
// Files: everything git would list (tracked, plus untracked and not ignored), or a directory walk outside a git repo.
// The path of every file and the target of every symlink are checked too (home-path and email rules), not just file
// contents. Files that cannot be read as text (binary-looking, or over 4 MB) are listed on stderr as NOT SCANNED; the
// email rule still searches their raw bytes (as Latin-1 and as UTF-16LE). UTF-16 files with a byte-order mark (the
// macOS .strings default) are decoded. Findings print as `file:line: [rule] message` (`file: [rule]` for a finding in
// the path itself); the matched text is never echoed for the home-path and email rules, so a CI log does not repeat
// what it is guarding: printed paths have a forbidden address replaced by "[address]" and a real home name by "<name>".
//
// Rules
//   abs-home-path     /Users/<name> or /home/<name> (also under /System/Volumes/Data, /Volumes/<disk>, /mnt/<drive>,
//                     /private), C:\Users\<name> (one or two backslashes, so JSON-escaped paths count), and Claude
//                     Code's project-directory encoding -Users-<name>-... in any text file, path name or symlink
//                     target. A symlink with an absolute target is a finding by itself. Obvious placeholders pass:
//                     <you>, $USER, ${USER}, %USERNAME%, one-letter names (/home/u), globs and regex (/Users/*,
//                     /Users/[a-z]+), x, someone, node, runner, canary..., sentinel..., secret..., synthetic..., syn-...
//                     (the synthetic corpus user syn-user). A real name such as jdoe is still a finding.
//   forbidden-email   a configured address appears in a file, a path, a symlink target or a binary's raw bytes; a
//                     plus-addressed form (local+tag@domain) counts. The addresses are never hardcoded here: put them
//                     in the environment variable WASITME_FORBIDDEN_EMAILS (comma or space separated) or in a
//                     gitignored .ci-local.env next to the repository (see .ci-local.env.example). In a git worktree
//                     the main worktree's .ci-local.env is used when the worktree has none. With nothing configured the
//                     rule is SKIPPED loudly (stderr: "check-repo: SKIPPED forbidden-email ...") and the run still
//                     passes unless --require-email-config is given. A .ci-local.env that git would commit (tracked,
//                     or not ignored) is itself a finding, configured or not.
//   remote-asset-url  shipped HTML/CSS/SVG (and HTML built inside JS/TS/Swift strings, escaped quotes included) that
//                     loads a remote script, stylesheet, font, image, frame or media file: <script src>, <link href>
//                     (a navigation rel such as canonical passes unless the tag also says stylesheet/preload/icon),
//                     <img|iframe|source|video|audio src|srcset|poster> (every srcset candidate), <base href>,
//                     <form action>, <meta http-equiv=refresh>, @import, url(), image-set(), `import ... from "https://"`,
//                     and `.src = "https://..."` / setAttribute("src", ...). Plain <a href> links are fine.
//                     Scope: ui/, engine/src/, plugin*/, macos/, packaging/.
//   string-built-js   Swift: the JavaScript argument of callAsyncJavaScript, evaluateJavaScript, WKUserScript(source:),
//                     JSContext.evaluateScript and the HTML of loadHTMLString must be a constant string literal with no
//                     interpolation (D48: data enters only through callAsyncJavaScript(body, arguments:)). A vetted
//                     constant defined elsewhere needs `// wasitme:allow-string-js -- <reason>` on the line or the line above.
//
// Allow-list: scripts/check-repo.allow, one entry per line: `rule | path glob | needle | reason` (lib/source-scan.mjs).
// The needle must occur within 80 characters of the finding. forbidden-email can never be allow-listed, and "*" (any
// rule) is not accepted here. Needles must not contain the text being guarded (for a home path, use words from
// elsewhere on the same line).
//
// Honest limits: a tripwire. Text split over two lines or encoded (base64, URL-escaped, &#64;, %40) is not seen, and
// the Swift check reads call arguments, it does not follow a variable back to where it was built.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowWindow, applyAllow, extOf, isPlainSwiftLiteral, lineOfIndex, listFilesDetailed, matchesAny, normalizeText,
  parseAllowList, readFileInfo, scanSwift, staleEntries, swiftCallArguments, TEXT_EXTENSIONS,
} from "./lib/source-scan.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SELF));

export const RULE_IDS = ["abs-home-path", "forbidden-email", "remote-asset-url", "string-built-js"];
const ALLOWABLE_RULES = RULE_IDS.filter((r) => r !== "forbidden-email");

/**
 * The maintainer's private email config. Never read as content (it holds the address). In a git checkout, a listed one
 * would be committed by `git add -A` (tracked, or not ignored): that is a finding. The walk fallback just skips it.
 */
const NEVER_SCAN = [".ci-local.env", "**/.ci-local.env"];

// ---------------------------------------------------------------------------------------------------------------
// abs-home-path
// ---------------------------------------------------------------------------------------------------------------

const PLACEHOLDER_NAMES = new Set([
  "you", "me", "user", "username", "name", "someone", "nobody", "example", "test", "tester", "foo", "bar",
  "baz", "alice", "bob", "shared", "guest", "runner", "admin", "root", "home", "person", "yourname", "your-name",
  "your_name", "myuser", "xxx", "synthetic", "sample", "demo", "project", "node",
]);
// "syn" + separator or end: the synthetic corpus user (syn-user) in testdata/ and engine/src/synth/, also as the
// first dash-separated piece of the -Users-syn-user-... project-directory encoding. "synthia" is NOT a placeholder.
const PLACEHOLDER_PREFIX = /^(?:canary|sentinel|secret|fake|dummy|synthetic|syn(?:-|_|$)|example|sample|placeholder|wasitme-canary)/i;

export function isPlaceholderName(name) {
  const n = name.toLowerCase();
  // <you>, $USER, ${USER}, %USERNAME%, ~; globs and regex in docs or code: /Users/*/, /Users/[a-z]+, /Users/(.+), .+
  if (/^[<$%{~*[(\\.?^]/.test(name) || /[<>]/.test(name)) return true;
  // One letter (/home/u, /Users/x): a stand-in in examples and tests. A real one-letter account name would pass;
  // accepted, because every real name the repo has carried is longer.
  if (/^[a-z]$/i.test(name)) return true;
  return PLACEHOLDER_NAMES.has(n) || PLACEHOLDER_PREFIX.test(name);
}

const NAME = String.raw`([^\s/"'` + "`" + String.raw`<>)\]},;:\\|]+)`;
const HOME_PATH = [
  // POSIX, optionally behind a mount prefix (the Data volume, another disk, WSL's /mnt/c, /private).
  new RegExp(String.raw`(?<![\w.-])(?:/System/Volumes/Data|/Volumes/[^/\s"'<>]+|/mnt/[a-z]|/private)?/(?:Users|home)/` + NAME, "g"),
  // Windows, with one or two backslashes between segments (JSON and most string literals escape them).
  new RegExp(String.raw`\b[A-Za-z]:\\{1,2}Users\\{1,2}([^\s\\"'` + "`" + String.raw`<>)\]},;:|]+)`, "g"),
  // Claude Code's project-directory encoding of a cwd (every "/" and "." becomes "-"): -Users-<name>-...
  // The name is the first dash-separated piece, so "-Users-syn-user-code" yields "syn".
  /(?<![\w-])-(?:Users|home)-([A-Za-z0-9_.]+)-/g,
];

/** [{line, context, index, length}] for real-looking home paths in `text` (index is within the line). */
export function homePathFindings(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const re of HOME_PATH) {
      for (const m of line.matchAll(re)) {
        if (!isPlaceholderName(m[1])) out.push({ line: i + 1, context: line, index: m.index, length: m[0].length });
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// forbidden-email
// ---------------------------------------------------------------------------------------------------------------

// The .ci-local.env keys this repository's tooling reads; any other WASITME_* key is reported as a likely typo.
const KNOWN_ENV_KEYS = new Set(["WASITME_FORBIDDEN_EMAILS", "WASITME_FORBIDDEN_PHRASES"]);

/** KEY=value lines; `export`, quotes and an inline " # comment" after an unquoted value are handled. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/** The main worktree's root when `root` is a linked worktree (found via git, never a hardcoded path), else null. */
function mainWorktreeRoot(root) {
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const abs = resolve(root, common);
    return basename(abs) === ".git" ? dirname(abs) : null;
  } catch {
    return null;
  }
}

/**
 * {literals:[lowercase], source, warnings} or {literals:[]} when unconfigured. Throws on a malformed entry.
 * `warnings` names WASITME_* keys in .ci-local.env this script does not know (a typo such as WASITME_FORBIDDEN_EMAIL
 * would otherwise be a silent skip); key names only, never values.
 */
export function loadForbiddenEmails(root, env = process.env) {
  let raw = (env.WASITME_FORBIDDEN_EMAILS ?? "").trim();
  let source = "WASITME_FORBIDDEN_EMAILS";
  const warnings = [];
  const candidates = [join(root, ".ci-local.env")];
  const main = mainWorktreeRoot(root);
  if (main && resolve(main) !== resolve(root)) candidates.push(join(main, ".ci-local.env"));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parseEnvFile(readFileSync(file, "utf8"));
    for (const k of Object.keys(parsed)) {
      if (k.startsWith("WASITME_") && !KNOWN_ENV_KEYS.has(k)) warnings.push(`.ci-local.env sets ${k}, which check-repo does not read (did you mean WASITME_FORBIDDEN_EMAILS or WASITME_FORBIDDEN_PHRASES?)`);
    }
    const v = (parsed.WASITME_FORBIDDEN_EMAILS ?? "").trim();
    if (!raw && v) { raw = v; source = ".ci-local.env"; }
    if (raw) break;
  }
  if (!raw) return { literals: [], source: null, warnings };
  const literals = raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const l of literals) {
    if (l.length < 5) throw new Error(`a forbidden-email entry in ${source} is shorter than 5 characters; refusing (it would match almost everything)`);
  }
  return { literals, source, warnings };
}

/**
 * Private phrases (plan, billing or tooling notes) that must never ship, read like the emails and never hardcoded:
 * WASITME_FORBIDDEN_PHRASES in the environment, else the gitignored .ci-local.env (this root's, then the main
 * worktree's). Comma or newline separated, because a phrase may contain spaces; each is trimmed and matched
 * case-insensitively by the callers. {phrases, source}, or {phrases: [], source: null} when unconfigured. Throws on an
 * entry shorter than 5 characters. check-repo itself does not scan for them: scripts/dev/export-public.sh (which reads
 * the same setting in shell) and scripts/test/repo-docs.test.mjs do.
 */
export function loadForbiddenPhrases(root, env = process.env) {
  let raw = (env.WASITME_FORBIDDEN_PHRASES ?? "").trim();
  let source = "WASITME_FORBIDDEN_PHRASES";
  if (!raw) {
    const candidates = [join(root, ".ci-local.env")];
    const main = mainWorktreeRoot(root);
    if (main && resolve(main) !== resolve(root)) candidates.push(join(main, ".ci-local.env"));
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      raw = (parseEnvFile(readFileSync(file, "utf8")).WASITME_FORBIDDEN_PHRASES ?? "").trim();
      if (raw) { source = ".ci-local.env"; break; }
    }
  }
  if (!raw) return { phrases: [], source: null };
  const phrases = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  for (const p of phrases) {
    if (p.length < 5) throw new Error(`a forbidden-phrase entry in ${source} is shorter than 5 characters; refusing (it would match almost everything)`);
  }
  return { phrases, source };
}

const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/** One case-insensitive matcher per literal; local@domain also matches the plus-addressed local+anything@domain. */
export function emailMatchers(literals) {
  return literals.map((lit) => {
    const at = lit.lastIndexOf("@");
    if (at <= 0) return new RegExp(escapeRe(lit), "i");
    return new RegExp(escapeRe(lit.slice(0, at)) + String.raw`(?:\+[^@\s"'<>,;]*)?@` + escapeRe(lit.slice(at + 1)), "i");
  });
}

const asMatchers = (x) => (x.length && typeof x[0] === "string" ? emailMatchers(x) : x);

/** Lines of `text` containing a forbidden address. `matchers` from emailMatchers() (plain literals are accepted too). */
export function emailFindings(text, matchers) {
  const ms = asMatchers(matchers);
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (ms.some((m) => m.test(line))) out.push({ line: i + 1, context: line });
  });
  return out;
}

/**
 * UTF-16LE text of the whole 2-byte code units in `b`. A trailing odd byte is left out here, exactly as
 * toString("utf16le") leaves it out, so the text is the same; but Node is never handed an odd-length UTF-16LE view.
 * Node 24.16.0 to 24.21.0 (at least) and 26.1.0 to 26.9.x write one byte past a heap buffer when they decode an
 * odd-length view that starts at an odd address (the subarray(1) view below), and glibc can abort on that with
 * "double free or corruption". Introduced by nodejs/node#62431, fixed by nodejs/node#65905 (in 26.10.0; not yet in 24.x).
 */
const utf16leWholeUnits = (b) => b.subarray(0, b.length & ~1).toString("utf16le");

/**
 * A forbidden address in raw bytes (a binary, or a file too large for the text rules): a Latin-1 view, and UTF-16LE
 * views at both byte alignments.
 */
export function bufferHasEmail(buf, matchers) {
  const ms = asMatchers(matchers);
  const views = [buf.toString("latin1"), utf16leWholeUnits(buf), buf.length > 1 ? utf16leWholeUnits(buf.subarray(1)) : ""];
  return views.some((v) => ms.some((m) => m.test(v)));
}

// ---------------------------------------------------------------------------------------------------------------
// git-identity (pre-publish): commit metadata is the biggest email vector and no file scan sees it
// ---------------------------------------------------------------------------------------------------------------

const GITHUB_NOREPLY = /^(?:\d+\+)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\[bot\])?@users\.noreply\.github\.com$/i;
export const isGithubNoreply = (email) => GITHUB_NOREPLY.test(email) || email.toLowerCase() === "noreply@github.com";

/**
 * Problems in the history reachable from any ref: {commits, notNoreply:[{hash, field}], forbidden:[{hash, field}]}.
 * Hashes and field names only; the values are never returned.
 */
export function gitIdentityFindings(root, matchers = []) {
  const ms = asMatchers(matchers);
  const RS = "\x1e";
  const US = "\x1f";
  const log = execFileSync("git", ["-C", root, "log", "--all", `--format=%H${US}%an${US}%ae${US}%cn${US}%ce${US}%B${RS}`], {
    encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { commits: 0, notNoreply: [], forbidden: [] };
  for (const rec of log.split(RS)) {
    const parts = rec.replace(/^\n/, "").split(US);
    if (parts.length < 6) continue;
    const [hash, an, ae, cn, ce, ...body] = parts;
    out.commits++;
    const fields = { "author name": an, "author email": ae, "committer name": cn, "committer email": ce, message: body.join(US) };
    if (!isGithubNoreply(ae)) out.notNoreply.push({ hash, field: "author email" });
    if (!isGithubNoreply(ce)) out.notNoreply.push({ hash, field: "committer email" });
    for (const [field, value] of Object.entries(fields)) if (ms.some((m) => m.test(value))) out.forbidden.push({ hash, field });
  }
  const tags = execFileSync("git", ["-C", root, "for-each-ref", "refs/tags", `--format=%(objectname)${US}%(taggername)${US}%(taggeremail)${US}%(contents)${RS}`], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const rec of tags.split(RS)) {
    const [hash, tn, teRaw, ...body] = rec.replace(/^\n/, "").split(US);
    if (!hash || !teRaw) continue; // a lightweight tag has no tagger
    const te = teRaw.replace(/^<|>$/g, "");
    if (!isGithubNoreply(te)) out.notNoreply.push({ hash, field: "tagger email" });
    for (const [field, value] of Object.entries({ "tagger name": tn, "tagger email": te, "tag message": body.join(US) })) {
      if (ms.some((m) => m.test(value))) out.forbidden.push({ hash, field });
    }
  }
  return out;
}

/**
 * A path as it may be printed: a forbidden address becomes "[address]" and a real-looking home-directory name
 * "<name>", so a finding about a path (or any finding inside such a path) never echoes what is being guarded.
 */
export function redactPath(rel, matchers = []) {
  let out = rel;
  for (const m of asMatchers(matchers)) out = out.replace(new RegExp(m.source, "gi"), "[address]");
  for (const re of HOME_PATH) {
    out = out.replace(new RegExp(re.source, re.flags), (whole, name) => (isPlaceholderName(name) ? whole : whole.replace(name, "<name>")));
  }
  return out;
}

function runGitIdentity(root, emails, io) {
  let r;
  try {
    r = gitIdentityFindings(root, emails.literals.length ? emailMatchers(emails.literals) : []);
  } catch (e) {
    io.err(`check-repo: --git-identity needs a git repository with history (${String(e.message).split("\n")[0]})`);
    return 2;
  }
  const summarize = (list) => {
    const byField = {};
    for (const x of list) byField[x.field] = (byField[x.field] ?? 0) + 1;
    const commits = new Set(list.map((x) => x.hash)).size;
    return `${commits} commit(s)/tag(s); ${Object.entries(byField).map(([f, n]) => `${f} x${n}`).join(", ")}; first: ${list[0].hash.slice(0, 10)}`;
  };
  if (r.forbidden.length) io.err(`check-repo: [git-identity] a configured forbidden address appears in history metadata (${summarize(r.forbidden)}); value not shown`);
  if (r.notNoreply.length) io.err(`check-repo: [git-identity] author/committer emails that are not a GitHub noreply address (${summarize(r.notNoreply)}); values not shown. Rewriting history is the maintainer's decision (D27)`);
  io.out(`check-repo: git-identity checked ${r.commits} commit(s) on all refs, ${r.forbidden.length + r.notNoreply.length} problem(s)${emails.literals.length ? "" : " (forbidden-email part SKIPPED: not configured)"}`);
  return r.forbidden.length || r.notNoreply.length ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// remote-asset-url
// ---------------------------------------------------------------------------------------------------------------

const REMOTE = String.raw`["']?\s*(?:https?:)?\/\/[^\s"'>)]*`;
const NAV_REL = /\brel\s*=\s*["']?\s*(?:canonical|alternate|author|license|help|me|next|prev|bookmark|search)\b/i;
// A rel that loads something even when it also says "alternate" (rel="alternate stylesheet").
const LOADING_REL = /\brel\s*=\s*["']?[^"'>]*\b(?:stylesheet|preload|prefetch|modulepreload|icon|manifest|apple-touch-icon|mask-icon|dns-prefetch|preconnect)\b/i;
const ASSET_PATTERNS = [
  { what: "<script src>", re: new RegExp(String.raw`<script\b[^>]*?\bsrc\s*=\s*${REMOTE}`, "gi") },
  { what: "<link href>", re: /<link\b[^>]*>/gi, accept: (tag) => new RegExp(String.raw`\bhref\s*=\s*${REMOTE}`, "i").test(tag) && (!NAV_REL.test(tag) || LOADING_REL.test(tag)) },
  { what: "remote media/frame src", re: new RegExp(String.raw`<(?:img|iframe|frame|source|video|audio|embed|track|input)\b[^>]*?\b(?:src|poster)\s*=\s*${REMOTE}`, "gi") },
  // every srcset candidate, not only the first: srcset="a.png 1x, https://cdn/b.png 2x"
  { what: "remote srcset candidate", re: /\bsrcset\s*=\s*(["'])(?:(?!\1)[^>])*?(?:https?:)?\/\/[^\s"'>]/gi },
  { what: "<object data>", re: new RegExp(String.raw`<object\b[^>]*?\bdata\s*=\s*${REMOTE}`, "gi") },
  { what: "remote SVG reference", re: /<(?:use|image|feimage)\b[^>]*?\b(?:xlink:)?href\s*=\s*["']?\s*https?:\/\/[^\s"'>]*/gi },
  { what: "<base href>", re: new RegExp(String.raw`<base\b[^>]*?\bhref\s*=\s*${REMOTE}`, "gi") },
  { what: "<form action>", re: new RegExp(String.raw`<form\b[^>]*?\baction\s*=\s*${REMOTE}`, "gi") },
  { what: "<meta refresh>", re: /<meta\b[^>]*?http-equiv\s*=\s*["']?refresh[^>]*?url\s*=\s*['"]?\s*(?:https?:)?\/\//gi },
  { what: "CSS @import", re: new RegExp(String.raw`@import\s+(?:url\(\s*)?${REMOTE}`, "gi") },
  { what: "CSS url()", re: new RegExp(String.raw`\burl\(\s*${REMOTE}`, "gi") },
  { what: "CSS image-set()", re: /\bimage-set\(\s*[^)]*?["']\s*(?:https?:)?\/\/[^\s"')]/gi },
  { what: "module import of a URL", re: /\bimport\s*(?:\(\s*|[^;'"`()]*?\bfrom\s*)?["'`]\s*(?:https?:)?\/\/[^"'`\s]*/g },
  { what: "script-set remote src", re: /\.(?:src|srcset)\s*=\s*["'`]\s*(?:https?:)?\/\//g },
  { what: "setAttribute remote src", re: /\bsetAttribute\(\s*["'](?:src|srcset|href|data)["']\s*,\s*["'`]\s*(?:https?:)?\/\//g },
];
const ASSET_ROOTS = ["ui/**", "engine/src/**", "plugin/**", "plugin-codex/**", "macos/**", "packaging/**"];
const ASSET_EXT = new Set(["html", "htm", "xhtml", "css", "svg", "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx", "swift"]);
const NOT_SHIPPED = ["**/node_modules/**", "**/.build/**", "**/dist/**", "**/reference/**", "**/test/**", "**/tests/**", "**/Tests/**", "**/__tests__/**", "**/testdata/**", "**/*.test.*", "**/*Tests.swift"];

// In an unpacked release tree (--walk-all) the built output IS what ships: ui/dist and engine/dist are in scope there.
const NOT_SHIPPED_RELEASE = NOT_SHIPPED.filter((g) => g !== "**/dist/**");
const ASSET_ROOTS_RELEASE = [...ASSET_ROOTS, "engine/dist/**"];
export const isAssetScope = (rel, { releaseTree = false } = {}) =>
  ASSET_EXT.has(extOf(rel)) && matchesAny(rel, releaseTree ? ASSET_ROOTS_RELEASE : ASSET_ROOTS) &&
  !matchesAny(rel, releaseTree ? NOT_SHIPPED_RELEASE : NOT_SHIPPED);

/**
 * One finding per line (an `@import url(...)` would otherwise match two patterns), in line order. HTML inside a Swift,
 * JS or JSON string has its quotes escaped (`src=\"https://...\"`, `https:\/\/`): those escapes are undone first
 * (newlines are kept, so line numbers hold).
 */
export function assetFindings(source) {
  const text = source.replace(/\\(["'\/])/g, "$1");
  const byLine = new Map();
  for (const p of ASSET_PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      if (p.accept && !p.accept(m[0])) continue;
      const line = lineOfIndex(text, m.index);
      if (!byLine.has(line)) byLine.set(line, { line, context: m[0], what: p.what });
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------------------------------------------
// string-built-js
// ---------------------------------------------------------------------------------------------------------------

const JS_SINKS = [
  { name: "callAsyncJavaScript", label: null },
  { name: "evaluateJavaScript", label: null },
  { name: "WKUserScript", label: "source" },
  { name: "evaluateScript", label: null }, // JavaScriptCore: JSContext.evaluateScript(_:)
  { name: "loadHTMLString", label: null }, // WKWebView.loadHTMLString(_:baseURL:): an HTML <script> runs too
];
const ALLOW_JS_MARKER = /wasitme:allow-string-js\b(\s*--\s*\S)?/;

const SWIFT_EXCLUDE = ["**/.build/**", "**/.swiftpm/**", "**/reference/**"]; // Tests/ is deliberately included
export const isSwiftScope = (rel) => extOf(rel) === "swift" && matchesAny(rel, ["macos/**"]) && !matchesAny(rel, SWIFT_EXCLUDE);

export function stringBuiltJsFindings(text) {
  const { code, lineOf } = scanSwift(text);
  const rawLines = text.split("\n");
  const out = [];
  for (const sink of JS_SINKS) {
    const re = new RegExp(String.raw`\b${sink.name}\s*\(`, "g");
    for (const m of code.matchAll(re)) {
      if (/\bfunc\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue; // a declaration, not a call
      const line = lineOf(m.index);
      const open = m.index + m[0].length - 1;
      const args = swiftCallArguments(code, open);
      let problem = null;
      if (!args) problem = "the call's parentheses never close, so its argument cannot be checked";
      else {
        const arg = sink.label ? args.find((a) => new RegExp(String.raw`^${sink.label}\s*:`).test(a.text)) : args[0];
        if (!arg) problem = `no ${sink.label ? `"${sink.label}:" ` : ""}argument found`;
        else {
          const expr = arg.text.replace(/^[A-Za-z_]\w*\s*:\s*/, "");
          if (!isPlainSwiftLiteral(expr)) problem = "its JavaScript is not a constant string literal (interpolation, concatenation or a variable)";
        }
      }
      if (!problem) continue;
      const marker = [rawLines[line - 1] ?? "", rawLines[line - 2] ?? ""].map((l) => ALLOW_JS_MARKER.exec(l)).find(Boolean);
      if (marker && marker[1]) continue;
      out.push({
        line,
        context: rawLines[line - 1] ?? "",
        what: sink.name,
        problem: marker ? `${problem}; the allow marker needs a reason ("-- why")` : problem,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------------------------

export function main(argv, io = { out: (m) => process.stdout.write(m + "\n"), err: (m) => process.stderr.write(m + "\n") }, env = process.env) {
  let root = REPO_ROOT;
  let allowPath = null;
  let strict = false;
  let requireEmail = false;
  let gitIdentity = false;
  let rules = RULE_IDS;
  let subset = false;
  let walkAll = false;
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--list-rules") { for (const r of RULE_IDS) io.out(r); return 0; }
      if (a === "--root") root = resolve(value(++i, a));
      else if (a === "--allow") allowPath = resolve(value(++i, a));
      else if (a === "--strict") strict = true;
      else if (a === "--require-email-config") requireEmail = true;
      else if (a === "--git-identity") gitIdentity = true;
      else if (a === "--walk-all") walkAll = true;
      else if (a === "--rules") {
        rules = value(++i, a).split(",").filter(Boolean);
        subset = true;
        const bad = rules.filter((r) => !RULE_IDS.includes(r));
        if (bad.length || !rules.length) { io.err(`check-repo: unknown rule(s): ${bad.join(", ") || "(none given)"}`); return 2; }
      } else if (a === "-h" || a === "--help") { io.out("usage: check-repo.mjs [--root DIR] [--rules a,b] [--allow FILE] [--strict] [--require-email-config] [--walk-all] [--git-identity] | --list-rules"); return 0; }
      else { io.err(`check-repo: unknown option ${a}`); return 2; }
    }
  } catch (e) {
    io.err(`check-repo: ${e.message}`);
    return 2;
  }

  allowPath ??= join(root, "scripts", "check-repo.allow");
  let allow = { entries: [], errors: [] };
  if (!strict && !gitIdentity && existsSync(allowPath)) {
    allow = parseAllowList(readFileSync(allowPath, "utf8"), { source: relative(root, allowPath) || allowPath, rules: ALLOWABLE_RULES, allowWildcard: false });
    if (allow.errors.length) { for (const e of allow.errors) io.err(`check-repo: ${e}`); return 2; }
  }

  let emails = { literals: [], warnings: [] };
  if (rules.includes("forbidden-email") || gitIdentity) {
    try {
      emails = loadForbiddenEmails(root, env);
    } catch (e) {
      io.err(`check-repo: ${e.message}`);
      return 2;
    }
    for (const w of emails.warnings) io.err(`check-repo: warning: ${w}`);
    if (!emails.literals.length) {
      if (requireEmail) {
        io.err("check-repo: no forbidden email configured (set WASITME_FORBIDDEN_EMAILS or create .ci-local.env); --require-email-config makes that an error");
        return 2;
      }
      io.err("check-repo: SKIPPED forbidden-email (set WASITME_FORBIDDEN_EMAILS or create a gitignored .ci-local.env; see .ci-local.env.example)");
    }
  }
  if (gitIdentity) return runGitIdentity(root, emails, io);
  const matchers = emailMatchers(emails.literals);

  const findings = [];
  const notScanned = [];
  let scanned = 0;
  const { files, symlinks, viaGit } = listFilesDetailed(root, { walkAll });
  const add = (rel, rule, f, message) => {
    const window = f.index === undefined ? undefined : allowWindow(normalizeText(f.context), f.index, f.length);
    findings.push({ file: rel, line: f.line, rule, message, context: f.context, window });
  };
  // A path, or a symlink's target: one "line" of text checked with the home-path and email rules.
  const checkName = (rel, name, what) => {
    if (rules.includes("abs-home-path")) {
      for (const f of homePathFindings(name)) add(rel, "abs-home-path", { ...f, line: 0 }, `absolute home path in the ${what}; use a placeholder`);
    }
    if (matchers.length && emailFindings(name, matchers).length) add(rel, "forbidden-email", { line: 0, context: name }, `a configured forbidden address appears in the ${what} (value not shown)`);
  };

  for (const rel of files) {
    if (matchesAny(rel, NEVER_SCAN)) {
      if (viaGit && rules.includes("forbidden-email")) {
        add(rel, "forbidden-email", { line: 0, context: "" }, "the private forbidden-email config would be committed (tracked, or not ignored): git rm --cached it and keep .ci-local.env in .gitignore");
      }
      continue;
    }
    checkName(rel, rel, "path");
    const wantsAsset = rules.includes("remote-asset-url") && isAssetScope(rel, { releaseTree: walkAll });
    const wantsJs = rules.includes("string-built-js") && isSwiftScope(rel);
    const info = readFileInfo(root, rel);
    if (info.text === null) {
      notScanned.push({ rel, reason: info.reason });
      if (matchers.length && info.buf && bufferHasEmail(info.buf, matchers)) {
        add(rel, "forbidden-email", { line: 0, context: "" }, `a configured forbidden address appears in this file's raw bytes (${info.reason} file; value not shown)`);
      }
      continue;
    }
    const text = info.text;
    scanned++;
    if (rules.includes("abs-home-path")) {
      for (const f of homePathFindings(text)) add(rel, "abs-home-path", f, "absolute home path (/Users/<name> or /home/<name>) in a tracked file; use a placeholder");
    }
    if (matchers.length) {
      for (const f of emailFindings(text, matchers)) add(rel, "forbidden-email", f, "a configured forbidden address appears here (value not shown)");
    }
    if (wantsAsset) for (const f of assetFindings(text)) add(rel, "remote-asset-url", f, `${f.what} loads a remote file; shipped pages must be self-contained (no fonts or scripts from the network)`);
    if (wantsJs) {
      for (const f of stringBuiltJsFindings(text)) {
        add(rel, "string-built-js", f, `${f.what}: ${f.problem}. Data enters only through callAsyncJavaScript(body, arguments:); a vetted constant elsewhere needs "// wasitme:allow-string-js -- reason"`);
      }
    }
  }
  for (const rel of symlinks) {
    checkName(rel, rel, "path");
    let target;
    try {
      target = readlinkSync(join(root, rel));
    } catch {
      continue;
    }
    if (rules.includes("abs-home-path") && isAbsolute(target)) {
      add(rel, "abs-home-path", { line: 0, context: "" }, "symlink with an absolute target (it names a place on one machine; use a relative target)");
    }
    checkName(rel, target, "symlink target");
  }
  if (scanned === 0) { io.err("check-repo: no files to scan; refusing to pass vacuously"); return 2; }

  let strictUnreadable = [];
  if (notScanned.length) {
    const shown = notScanned.slice(0, 20).map((n) => `${redactPath(n.rel, matchers)} (${n.reason})`).join(", ");
    io.err(`check-repo: NOT SCANNED by the text rules: ${notScanned.length} file(s): ${shown}${notScanned.length > 20 ? ", ..." : ""}${matchers.length ? " (the email rule searched their raw bytes)" : ""}`);
    strictUnreadable = strict ? notScanned.filter((n) => TEXT_EXTENSIONS.has(extOf(n.rel))) : [];
    for (const n of strictUnreadable) io.err(`${redactPath(n.rel, matchers)}: [not-scanned] has a text extension but could not be read as text (${n.reason}); --strict requires every text file to be scanned`);
  }

  // forbidden-email is never allow-listable, whatever an entry says.
  const kept = findings.filter((f) => f.rule === "forbidden-email" || !applyAllow(allow.entries, f, f.context));
  for (const f of kept) io.err(`${redactPath(f.file, matchers)}${f.line ? `:${f.line}` : ""}: [${f.rule}] ${f.message}`);
  let stale = [];
  if (!subset && !strict) {
    stale = staleEntries(allow.entries);
    for (const e of stale) io.err(`${e.source}:${e.line}: [stale-allow] "${e.rule} | ${e.glob}" matches nothing; remove it`);
  }
  io.out(`check-repo: ${scanned} file(s) scanned${notScanned.length ? ` (${notScanned.length} not scanned as text)` : ""}, ${symlinks.length} symlink(s), ${kept.length} finding(s)${strict ? " (strict: allow-list ignored)" : ""}${stale.length ? `, ${stale.length} stale allow-list entr${stale.length === 1 ? "y" : "ies"}` : ""}`);
  return kept.length || stale.length || strictUnreadable.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
