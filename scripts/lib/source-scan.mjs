// source-scan.mjs - shared plumbing for the repo checks (lint-copy.mjs, check-repo.mjs, swift-macros.mjs).
//
// Not a CLI. Everything here is a small, dependency-free helper:
//   * listFiles(root)           the files a check should look at: tracked + untracked-but-not-ignored when `root`
//                               is a git repository (so gitignored scratch such as docs/private never gets read),
//                               a plain directory walk otherwise. Symlinks are never followed.
//   * listFilesDetailed(root)   the same, plus the symlinks (as paths, for checks that read their targets) and
//                               whether git produced the list (then a listed file is tracked or not ignored)
//   * readFileInfo / readText   a file's text (UTF-8, or UTF-16 with a byte-order mark), or why it has none
//   * globToRegExp / matchesAny tiny glob support (`*`, `**`, `?`) for allow-lists and scopes
//   * parseAllowList / applyAllow  the shared allow-list format (see below)
//   * normalizeText             lower-case, NFKC, straight quotes, zero-width characters dropped, whitespace collapsed
//   * jsStrings / scanSwift / shellLines / shellCopy / markupSegments / cssContentStrings / jsonStrings /
//     markdownParagraphs / paragraphs / lineSegments    "what text would a user read" per language
//   * swiftCallArguments        split the arguments of a call in masked Swift code
//
// Honest limits: these are tripwires, not parsers. A phrase split over two literals ("a " + "b") or built at
// runtime is not seen. The lexers are good enough for ordinary hand-written source, not for hostile input.

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------

const WALK_SKIP_DIRS = new Set([".git", "node_modules", ".build", "dist", ".claude"]);

/**
 * Files under `root` as repo-relative POSIX paths, sorted. In a git repo this is `git ls-files --cached --others
 * --exclude-standard` (so deleted-but-still-indexed files and symlinks are filtered out below); otherwise a walk.
 */
export const listFiles = (root) => listFilesDetailed(root).files;

/**
 * {files, symlinks, viaGit}: regular files and symlinks under `root` (repo-relative, sorted, never followed), and
 * whether the list came from git. With viaGit, every listed path is tracked or untracked-and-not-ignored, i.e. it
 * would be committed by `git add -A`.
 */
export function listFilesDetailed(root, { walkAll = false } = {}) {
  // walkAll: an unpacked release tree, where dist/ IS the shipped code: walk every folder except .git.
  const skip = walkAll ? new Set([".git"]) : WALK_SKIP_DIRS;
  let rels = null;
  let viaGit = false;
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (realpathSync(top) === realpathSync(root)) {
      const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      rels = out.split("\0").filter(Boolean);
      viaGit = true;
    }
  } catch {
    rels = null; // not a repository (or git is missing): fall through to the walk
  }
  if (rels === null) {
    rels = [];
    const walk = (dir, prefix) => {
      let names;
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const abs = join(dir, name);
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) rels.push(prefix + name);
        else if (st.isDirectory()) {
          if (!skip.has(name)) walk(abs, prefix + name + "/");
        } else if (st.isFile()) rels.push(prefix + name);
      }
    };
    walk(root, "");
  }
  const seen = new Set();
  const files = [];
  const symlinks = [];
  for (const rel of rels) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    try {
      const st = lstatSync(join(root, rel)); // lstat: a symlink is reported as one, never followed
      if (st.isFile()) files.push(rel);
      else if (st.isSymbolicLink()) symlinks.push(rel);
    } catch {
      /* deleted but still in the index */
    }
  }
  return { files: files.sort(), symlinks: symlinks.sort(), viaGit };
}

/** UTF-8 (or BOM-marked UTF-16) text of a file, or null when it looks binary, is unreadable or is over `maxBytes`. */
export const readText = (root, rel, maxBytes) => readFileInfo(root, rel, maxBytes).text;

/** Largest file read at all (for the raw-byte searches some checks do on files that are not text). */
export const MAX_RAW_BYTES = 256 * 1024 * 1024;

/**
 * {text, buf, reason}: `text` is the decoded text or null; `reason` says why it is null ("binary", "oversize",
 * "unreadable", "too large to read"); `buf` holds the raw bytes when they were read (also for binary/oversize files
 * up to MAX_RAW_BYTES), so a caller can still search them.
 * UTF-16 with a byte-order mark (FF FE / FE FF; the macOS default for .strings files) is decoded instead of being
 * mistaken for binary because of its NUL bytes.
 */
export function readFileInfo(root, rel, maxBytes = 4 * 1024 * 1024) {
  let buf;
  try {
    const abs = join(root, rel);
    if (statSync(abs).size > MAX_RAW_BYTES) return { text: null, buf: null, reason: "too large to read" };
    buf = readFileSync(abs);
  } catch {
    return { text: null, buf: null, reason: "unreadable" };
  }
  if (buf.length > maxBytes) return { text: null, buf, reason: "oversize" };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString("utf16le"), buf, reason: null };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString("utf16le"), buf, reason: null };
  }
  if (buf.subarray(0, 8192).includes(0)) return { text: null, buf, reason: "binary" };
  return { text: buf.toString("utf8").replace(/^\uFEFF/, ""), buf, reason: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------------------------------------------

/** `**` crosses directories, `*` and `?` do not. `dir/**` matches everything below dir. Anchored at both ends. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

const globCache = new Map();
export function matchesGlob(rel, glob) {
  let re = globCache.get(glob);
  if (!re) globCache.set(glob, (re = globToRegExp(glob)));
  return re.test(rel);
}
export const matchesAny = (rel, globs) => globs.some((g) => matchesGlob(rel, g));

// ---------------------------------------------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------------------------------------------

/** What the rules match against: case, quote style, zero-width characters and whitespace runs do not matter. */
export function normalizeText(s) {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/\s+/g, " ");
}

export const lineOfIndex = (text, index) => {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
};

// ---------------------------------------------------------------------------------------------------------------
// Allow-lists
// ---------------------------------------------------------------------------------------------------------------
//
// Format, one entry per line, "#" starts a comment:
//     <rule-id> | <path glob> | <needle> | <reason>
// An entry silences a finding when the rule id matches (or is "*", where the caller allows that), the file matches
// the glob, and the needle (compared case-insensitively after normalizeText) occurs NEAR the finding: within
// ALLOW_WINDOW characters of the matched text when the finding says where it matched (finding.window), else anywhere
// in the text the finding came from (the string literal, paragraph or line). The window keeps one entry for a quoted
// example from also hiding a new violation later in the same paragraph. Needles, never line numbers: line numbers go
// stale on every edit. The reason is mandatory. Entries that match nothing are reported as stale (callers do that
// only on a full scan).

/** Characters on each side of a match that an allow-list needle may come from. */
export const ALLOW_WINDOW = 80;

/** The normalized text around a match: what an allow-list needle is compared against. */
export const allowWindow = (normalized, index, length) =>
  normalized.slice(Math.max(0, index - ALLOW_WINDOW), index + length + ALLOW_WINDOW);

export function parseAllowList(text, { source = "allow-list", rules = null, allowWildcard = true } = {}) {
  const entries = [];
  const errors = [];
  text.replace(/^\uFEFF/, "").split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) return;
    const parts = line.split(" | ");
    const where = `${source}:${i + 1}`;
    if (parts.length < 4) return errors.push(`${where}: expected "rule | path glob | needle | reason" (separator is space-pipe-space)`);
    const [rule, glob, needle, ...reasonParts] = parts.map((p) => p.trim());
    const reason = reasonParts.join(" | ");
    if (!rule || !glob || !needle) return errors.push(`${where}: rule, path glob and needle must all be non-empty`);
    if (!reason) return errors.push(`${where}: a reason is required`);
    if (rule === "*" && !allowWildcard) return errors.push(`${where}: "*" is not accepted here; name the rule`);
    if (rules && rule !== "*" && !rules.includes(rule)) return errors.push(`${where}: unknown or non-allow-listable rule "${rule}"`);
    entries.push({ rule, glob, needle: normalizeText(needle), reason, line: i + 1, source, used: 0 });
  });
  return { entries, errors };
}

/**
 * True when an entry silences this finding (and counts the use). `context` is the text the finding came from; when
 * the finding carries `window` (allowWindow() of the normalized text around the match) only that window is searched.
 */
export function applyAllow(entries, finding, context) {
  const hay = finding.window ?? normalizeText(context);
  let allowed = false;
  for (const e of entries) {
    if (e.rule !== "*" && e.rule !== finding.rule) continue;
    if (!matchesGlob(finding.file, e.glob)) continue;
    if (!hay.includes(e.needle)) continue;
    e.used++;
    allowed = true;
  }
  return allowed;
}

export const staleEntries = (entries) => entries.filter((e) => e.used === 0);

// ---------------------------------------------------------------------------------------------------------------
// Segments: [{text, line}] of the text a reader would see
// ---------------------------------------------------------------------------------------------------------------

/** Blank-line separated paragraphs (so a phrase wrapped over two lines is still one string). Line = first line. */
export function paragraphs(text) {
  const out = [];
  let cur = [];
  let start = 1;
  const flush = () => {
    if (cur.length) out.push({ text: cur.join("\n"), line: start });
    cur = [];
  };
  text.split("\n").forEach((l, i) => {
    if (!l.trim()) return flush();
    if (!cur.length) start = i + 1;
    cur.push(l);
  });
  flush();
  return out;
}

export const lineSegments = (text) =>
  text.split("\n").map((t, i) => ({ text: t, line: i + 1 })).filter((s) => s.text.trim());

const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
function unescape(raw) {
  return raw.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\}|\r\n|[\s\S])/g, (_m, e) => {
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "u" && e.length > 1) {
      const cp = parseInt(e[1] === "{" ? e.slice(2, -1) : e.slice(1), 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    if (e === "\n" || e === "\r\n") return "";
    return SIMPLE_ESCAPES[e] ?? e;
  });
}

// --- JavaScript / TypeScript: string literals and the literal text of template literals ------------------------

const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * Text of every string literal and template literal in JS/TS source (comments, regex literals and code are skipped).
 * The pieces of a template literal around `${...}` are joined with "{}" so a phrase around a placeholder stays whole.
 * Module specifiers (`from "x"`, `import "x"`, `import("x")`, `require("x")`) are marked `specifier: true`: they are
 * file names, not text a user reads. JSX text is not a string literal: scan .jsx/.tsx files as plain lines instead.
 */
export function jsStrings(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let valueEnded = false; // did the last significant token end an expression? decides "/" = division or regex
  let prev1 = ""; // the last two significant tokens ("id:from", "p:("), to recognise module specifiers
  let prev2 = "";
  const sig = (tok) => { prev2 = prev1; prev1 = tok; };
  const isSpecifierPosition = () =>
    prev1 === "id:from" || prev1 === "id:import" || (prev1 === "p:(" && (prev2 === "id:import" || prev2 === "id:require"));

  const lexCode = (untilCloseBrace) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "\n") { line++; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        line += (src.slice(i, stop).match(/\n/g) ?? []).length;
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") {
        const startLine = line;
        const specifier = isSpecifierPosition();
        let raw = "";
        i++;
        while (i < n && src[i] !== c && src[i] !== "\n") {
          if (src[i] === "\\") { raw += src.slice(i, i + 2); if (src[i + 1] === "\n") line++; i += 2; continue; }
          raw += src[i++];
        }
        i++;
        out.push(specifier ? { text: unescape(raw), line: startLine, specifier: true } : { text: unescape(raw), line: startLine });
        valueEnded = true;
        sig("str");
        continue;
      }
      if (c === "`") {
        const startLine = line;
        const specifier = isSpecifierPosition();
        const parts = [];
        let raw = "";
        i++;
        while (i < n && src[i] !== "`") {
          if (src[i] === "\\") { raw += src.slice(i, i + 2); if (src[i + 1] === "\n") line++; i += 2; continue; }
          if (src[i] === "$" && src[i + 1] === "{") {
            parts.push(unescape(raw));
            raw = "";
            i += 2;
            lexCode(true);
            continue;
          }
          if (src[i] === "\n") line++;
          raw += src[i++];
        }
        i++;
        parts.push(unescape(raw));
        out.push(specifier ? { text: parts.join("{}"), line: startLine, specifier: true } : { text: parts.join("{}"), line: startLine });
        valueEnded = true;
        sig("str");
        continue;
      }
      if (c === "/" && !valueEnded) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (inClass) { if (src[j] === "]") inClass = false; }
          else if (src[j] === "[") inClass = true;
          else if (src[j] === "/") break;
          j++;
        }
        if (src[j] === "/") {
          j++;
          while (j < n && /[A-Za-z]/.test(src[j])) j++;
          i = j;
          valueEnded = true;
          sig("regex");
          continue;
        }
      }
      if (/[A-Za-z_$\u0080-\uffff]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$\u0080-\uffff]/.test(src[j])) j++;
        const word = src.slice(i, j);
        valueEnded = !REGEX_AFTER_WORD.has(word);
        sig("id:" + word);
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w.]/.test(src[j])) j++;
        i = j;
        valueEnded = true;
        sig("num");
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (untilCloseBrace && depth === 0) { i++; valueEnded = false; return; }
        depth--;
      }
      valueEnded = c === ")" || c === "]" || c === "}";
      sig("p:" + c);
      i++;
    }
  };

  lexCode(false);
  return out;
}

/**
 * JS/TS source with every comment replaced by spaces (newlines kept, so offsets and line numbers hold). Strings,
 * template literals and regex literals are kept as they are, so a "//" inside a URL string is not a comment.
 */
export function maskJsComments(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let valueEnded = false;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  const skipString = (q) => {
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === "\\") { i += 2; continue; }
      if (q !== "`" && src[i] === "\n") break;
      if (q === "`" && src[i] === "$" && src[i + 1] === "{") { i += 2; code(true); continue; }
      i++;
    }
    i++;
    valueEnded = true;
  };
  const code = (untilBrace) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { const s0 = i; while (i < n && src[i] !== "\n") i++; blank(s0, i); continue; }
      if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); const stop = end === -1 ? n : end + 2; blank(i, stop); i = stop; continue; }
      if (c === '"' || c === "'" || c === "`") { skipString(c); continue; }
      if (c === "/" && !valueEnded) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (inClass) { if (src[j] === "]") inClass = false; } else if (src[j] === "[") inClass = true; else if (src[j] === "/") break;
          j++;
        }
        if (src[j] === "/") { i = j + 1; while (i < n && /[A-Za-z]/.test(src[i])) i++; valueEnded = true; continue; }
      }
      if (/\s/.test(c)) { i++; continue; }
      if (/[A-Za-z_$\u0080-￿]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$\u0080-￿]/.test(src[j])) j++;
        valueEnded = !REGEX_AFTER_WORD.has(src.slice(i, j));
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) { while (i < n && /[\w.]/.test(src[i])) i++; valueEnded = true; continue; }
      if (c === "{") depth++;
      if (c === "}") { if (untilBrace && depth === 0) { i++; valueEnded = false; return; } depth--; }
      valueEnded = c === ")" || c === "]" || c === "}";
      i++;
    }
  };
  code(false);
  return out.join("");
}

// --- Shell ----------------------------------------------------------------------------------------------------

/** Lines of a shell script with `#` comments removed (quote state is tracked across lines). Heredocs stay in. */
export function shellLines(src) {
  const out = [];
  let quote = null;
  src.split("\n").forEach((l, idx) => {
    let kept = "";
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (quote === "'") { kept += c; if (c === "'") quote = null; continue; }
      if (quote === '"') {
        kept += c;
        if (c === "\\") { kept += l[++i] ?? ""; continue; }
        if (c === '"') quote = null;
        continue;
      }
      if (c === "\\") { kept += c + (l[++i] ?? ""); continue; }
      if (c === "'" || c === '"') { quote = c; kept += c; continue; }
      if (c === "#" && (i === 0 || /[\s;&|(]/.test(l[i - 1]))) break;
      kept += c;
    }
    if (kept.trim() && !(idx === 0 && kept.startsWith("#!"))) out.push({ text: kept, line: idx + 1 });
  });
  return out;
}

/**
 * The text a shell script shows a user, as [{text, line}]: the contents of quoted strings, heredoc bodies, and the
 * unquoted arguments of echo/printf. Code (case arms such as `worse)`, assignments such as `better=1`, command names)
 * and comments are not copy. A quoted string that spans lines is one segment (its first line).
 */
export function shellCopy(src) {
  const out = [];
  const lines = src.split("\n");
  let quote = null;
  let qText = "";
  let qLine = 0;
  let heredoc = null; // {word, strip}
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx];
    if (heredoc) {
      const cand = heredoc.strip ? l.replace(/^\t+/, "") : l;
      if (cand === heredoc.word) heredoc = null;
      else if (l.trim()) out.push({ text: l, line: idx + 1 });
      continue;
    }
    if (idx === 0 && l.startsWith("#!")) continue;
    let code = ""; // the line with quoted text replaced by a placeholder and comments removed
    const lineQuoted = [];
    let lastQuoted = null; // the last quoted string on this line, kept or not (a quoted heredoc word)
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (quote) {
        if (quote === '"' && c === "\\") { qText += l[i + 1] ?? ""; i++; continue; }
        if (c === quote) {
          // "$d" or "${HOME}/x" is a value, not words: only quoted text with letters outside expansions is copy.
          lastQuoted = { text: qText, line: qLine };
          if (/[A-Za-z]{2}/.test(qText.replace(/\$\{[^}]*\}|\$[\w#?@*!$-]+/g, ""))) lineQuoted.push(lastQuoted);
          quote = null;
          qText = "";
          code += "Q";
          continue;
        }
        qText += c;
        continue;
      }
      if (c === "\\") { code += c + (l[i + 1] ?? ""); i++; continue; }
      if (c === "'" || c === '"') { quote = c; qText = ""; qLine = idx + 1; continue; }
      if (c === "#" && (i === 0 || /[\s;&|(]/.test(l[i - 1]))) break;
      code += c;
    }
    if (quote) qText += "\n";

    const echo = /(?:^|[;&|(`]|\b(?:then|do|else|elif))\s*(?:command\s+)?(?:echo|printf)\b((?:\s+-[a-zA-Z]+)*)\s+([^;&|<>`]*)/g;
    for (const m of code.matchAll(echo)) {
      const words = m[2].replace(/\bQ\b/g, " ").replace(/\$\{?[\w#?@*!$-]+\}?/g, " ").trim();
      if (/[A-Za-z]{2}/.test(words)) out.push({ text: words, line: idx + 1 });
    }
    const hd = /<<(-?)\s*(?:Q|\\?([A-Za-z_][\w]*))/.exec(code);
    if (hd) {
      // Heredoc word: unquoted (EOF), or quoted ('EOF' / "EOF"; then it is the last quoted string, which is not copy).
      const word = hd[2] ?? lastQuoted?.text;
      if (hd[2] === undefined && lastQuoted) {
        const k = lineQuoted.indexOf(lastQuoted);
        if (k !== -1) lineQuoted.splice(k, 1);
      }
      if (word) heredoc = { word, strip: hd[1] === "-" };
    }
    out.push(...lineQuoted);
  }
  return out.sort((a, b) => a.line - b.line);
}

// --- HTML / XML / SVG ------------------------------------------------------------------------------------------

const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d",
  ldquo: "\u201c", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", times: "\u00d7", shy: "\u00ad", thinsp: " ",
  ensp: " ", emsp: " ", zwj: "", zwnj: "", percnt: "%", num: "#", colon: ":", period: ".",
};

/** Decode HTML/XML character references (&nbsp; &rsquo; &#39; &#x27; ...). Unknown names are left as they are. */
export function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/g, (m, dec, hex, name) => {
    if (dec || hex) {
      const cp = parseInt(dec ?? hex, dec ? 10 : 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED_ENTITIES[name.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "font", "i", "kbd", "label", "mark", "q", "s",
  "samp", "small", "span", "strong", "sub", "sup", "time", "tspan", "u", "var", "wbr",
]);
// Attributes whose value is shown to a user (HTML, SVG, and Interface Builder .xib/.storyboard XML).
const VISIBLE_ATTRIBUTES = /(?:^|\s)(alt|title|aria-label|aria-description|placeholder|label|content|value|text|tooltip|placeholderstring|stringvalue|headertitle)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * The text a reader sees in HTML/XML/SVG, as [{text, line}]: element text with inline tags (b, em, span, a, ...)
 * dissolved so a phrase across them stays whole, split at block tags; user-visible attribute values (alt, title,
 * aria-label, placeholder, ...) as their own segments; string literals of inline <script>; CSS `content:` strings of
 * inline <style>. Comments, tag names, class names and other attributes are not read. Entities are decoded.
 */
export function markupSegments(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let cur = "";
  let curLine = 0;
  const flush = () => {
    if (cur.trim()) out.push({ text: decodeEntities(cur), line: curLine });
    cur = "";
    curLine = 0;
  };
  const countLines = (from, to) => {
    for (let k = from; k < to; k++) if (src[k] === "\n") line++;
  };
  while (i < n) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      countLines(i, stop);
      i = stop;
      continue;
    }
    if (src[i] === "<" && /[A-Za-z!?/]/.test(src[i + 1] ?? "")) {
      // a tag: find its end, respecting quoted attribute values
      let j = i + 1;
      let q = null;
      while (j < n && (q || src[j] !== ">")) {
        if (q) { if (src[j] === q) q = null; }
        else if (src[j] === '"' || src[j] === "'") q = src[j];
        j++;
      }
      const tag = src.slice(i, Math.min(j + 1, n));
      const tagLine = line;
      countLines(i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      const name = (/^<\/?\s*([A-Za-z][\w:-]*)/.exec(tag)?.[1] ?? "").toLowerCase();
      const closing = /^<\s*\//.test(tag);
      if (!INLINE_TAGS.has(name)) flush();
      if (!closing) {
        for (const a of tag.matchAll(VISIBLE_ATTRIBUTES)) {
          const v = a[2] ?? a[3] ?? "";
          if (/[A-Za-z]/.test(v)) out.push({ text: decodeEntities(v), line: tagLine });
        }
      }
      if (!closing && (name === "script" || name === "style") && !/\/\s*>$/.test(tag)) {
        const close = src.toLowerCase().indexOf(`</${name}`, i);
        const stop = close === -1 ? n : close;
        const body = src.slice(i, stop);
        const offset = line - 1;
        const inner = name === "script" ? jsStrings(body).filter((s) => !s.specifier) : cssContentStrings(body);
        for (const s of inner) out.push({ text: s.text, line: s.line + offset });
        countLines(i, stop);
        i = stop;
      }
      continue;
    }
    const c = src[i];
    if (c === "\n") line++;
    if (!cur.trim() && /\S/.test(c)) curLine = line;
    cur += c;
    i++;
  }
  flush();
  return out.sort((a, b) => a.line - b.line);
}

/** CSS: only the strings of `content:` declarations are text a user reads (selectors, class names and values are not). */
export function cssContentStrings(src) {
  const out = [];
  const masked = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  for (const m of masked.matchAll(/\bcontent\s*:\s*((?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\s|[\w()-])+)/g)) {
    const strings = [...m[1].matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)].map((s) => (s[1] ?? s[2]).replace(/\\(.)/g, "$1"));
    const text = strings.join("");
    if (text.trim()) out.push({ text, line: lineOfIndex(src, m.index) });
  }
  return out;
}

/**
 * JSON (and .xcstrings): the decoded string VALUES, as [{text, line}]. Keys are names, not copy, so `{"score": 1}` is
 * not a hit while `{"headline": "A score"}` is; `\u0073core` decodes to "score". A value is one string even when the
 * file wraps it, so a phrase over two source lines inside one value is still found.
 */
export function jsonStrings(src) {
  const out = [];
  const re = /"(?:[^"\\\n]|\\.)*"/g;
  let line = 1;
  let last = 0;
  for (const m of src.matchAll(re)) {
    for (let k = last; k < m.index; k++) if (src[k] === "\n") line++;
    last = m.index;
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 64);
    if (/^\s*:/.test(after)) continue; // an object key
    let text;
    try {
      text = JSON.parse(m[0]);
    } catch {
      text = m[0].slice(1, -1);
    }
    if (text.trim()) out.push({ text, line });
  }
  return out;
}

/** Markdown paragraphs with emphasis markers, link targets and entities removed, so `looks **like**` reads as words. */
export function markdownParagraphs(src) {
  return paragraphs(src).map((p) => ({
    line: p.line,
    text: decodeEntities(
      p.text
        .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "]") // [text](target) -> [text]
        .replace(/<(?:https?:|mailto:)[^>\s]*>/g, " ") // <https://...> autolinks
        .replace(/(\*{1,3}|_{1,3}|~~|`+)/g, ""),
    ),
  }));
}

/** "sh" | "js" | null: the language an extensionless script's shebang names. */
export function shebangKind(text) {
  const first = /^#![^\n]*/.exec(text)?.[0] ?? "";
  if (/\b(?:ba|z|da|k)?sh\b/.test(first)) return "sh";
  if (/\b(?:node|deno|bun)\b/.test(first)) return "js";
  return null;
}

// --- Swift ----------------------------------------------------------------------------------------------------

/**
 * Mask a Swift source: comments become spaces, string literal contents become "_" (interpolated code becomes "$"),
 * newlines are kept, so offsets and line numbers match the original. String delimiters are kept.
 * Returns {code, strings:[{text, line, interpolated, start, end}], lineOf(index)}.
 * `text` of a string is its literal pieces joined with "{}" (escapes are not decoded: fine for phrase matching).
 */
export function scanSwift(src) {
  const n = src.length;
  const out = src.split("");
  const strings = [];
  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const blank = (from, to, ch) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = ch;
  };

  // Scans code from i. With stopAtParen, returns the index of the ")" that closes an interpolation.
  const scanCode = (start, stopAtParen) => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        let j = i;
        while (j < n && src[j] !== "\n") j++;
        blank(i, j, " ");
        i = j;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        let j = i + 2;
        let nest = 1;
        while (j < n && nest > 0) {
          if (src[j] === "/" && src[j + 1] === "*") { nest++; j += 2; }
          else if (src[j] === "*" && src[j + 1] === "/") { nest--; j += 2; }
          else j++;
        }
        blank(i, j, " ");
        i = j;
        continue;
      }
      if (c === '"' || (c === "#" && /^#+"/.test(src.slice(i, i + 64)))) {
        i = scanString(i);
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") {
        if (stopAtParen && depth === 0) return i;
        depth--;
      }
      i++;
    }
    return i;
  };

  // i is at the first "#" of a raw string or at the opening quote. Returns the index after the literal.
  const scanString = (i) => {
    const litStart = i;
    let hashes = 0;
    while (src[i] === "#") { hashes++; i++; }
    const multi = src.startsWith('"""', i);
    const q = multi ? '"""' : '"';
    i += q.length;
    const bodyStart = i;
    const close = q + "#".repeat(hashes);
    const esc = "\\" + "#".repeat(hashes);
    const pieces = [];
    let pieceStart = i;
    let interpolated = false;
    let terminated = false;
    while (i < n) {
      if (src.startsWith(esc + "(", i)) {
        pieces.push(src.slice(pieceStart, i));
        interpolated = true;
        const interpStart = i;
        const end = scanCode(i + esc.length + 1, true);
        blank(interpStart, Math.min(end + 1, n), "$");
        i = end + 1;
        pieceStart = i;
        continue;
      }
      if (src.startsWith(esc, i) && i + esc.length < n) { i += esc.length + 1; continue; }
      if (src.startsWith(close, i)) { terminated = true; break; }
      if (!multi && src[i] === "\n") break; // unterminated single-line string
      i++;
    }
    pieces.push(src.slice(pieceStart, i));
    for (let k = bodyStart; k < i; k++) if (out[k] !== "\n" && out[k] !== "$") out[k] = "_"; // "$" marks interpolations
    const end = terminated ? i + close.length : i;
    strings.push({ text: pieces.join("{}"), line: lineOf(litStart), interpolated, start: litStart, end });
    return end;
  };

  scanCode(0, false);
  return { code: out.join(""), strings, lineOf };
}

/**
 * Arguments of the call whose "(" is at `open` in masked code: [{start, end, text}] (text trimmed), top-level commas
 * only. Returns null when the parentheses never close.
 */
export function swiftCallArguments(code, open) {
  const args = [];
  let depth = 0;
  let argStart = open + 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        const text = code.slice(argStart, i);
        if (text.trim() || args.length) args.push({ start: argStart, end: i, text: text.trim() });
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push({ start: argStart, end: i, text: code.slice(argStart, i).trim() });
      argStart = i + 1;
    }
  }
  return null;
}

/** A masked Swift expression that is exactly one string literal with no interpolation. */
export const isPlainSwiftLiteral = (maskedExpr) => /^#*(?:"""|")[_\n ]*(?:"""|")#*$/.test(maskedExpr.trim());

// ---------------------------------------------------------------------------------------------------------------
// Extension helpers
// ---------------------------------------------------------------------------------------------------------------

export const extOf = (rel) => {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
};

export const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "json", "html", "htm", "xhtml", "css", "svg", "xml", "plist", "yml", "yaml", "toml",
  "strings", "xcstrings", "stringsdict", "xib", "storyboard", "rtf", "csv",
  "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx", "swift", "sh", "bash", "zsh",
]);
