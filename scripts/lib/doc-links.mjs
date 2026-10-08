// doc-links.mjs - find broken relative links (files, directories and #heading anchors) in a tree of Markdown files, and
// links from shipped documents into paths that are not shipped. Used by scripts/test/doc-links.test.mjs; no dependencies.
//
// What it understands: inline links [text](target "title"), <target> forms, reference definitions "[label]: target",
// the image sources of HTML <img src> and <source srcset> tags (every srcset candidate), GitHub heading anchors (lower-cased, punctuation dropped, spaces to hyphens, repeated headings numbered -1, -2, ...),
// and explicit <a id="..."> / <a name="..."> anchors. Fenced code blocks and inline code spans are ignored, so an
// example link inside code is not checked. External links (http, https, mailto, ...) are not fetched.
//
// Honest limits: it does not resolve links that GitHub resolves specially (a bare "/path" from the repository root is
// checked against the repository root, as GitHub does), nor HTML <a href> links outside Markdown syntax; an HTML image
// tag is read only when it fits on one line.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

const EXTERNAL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Markdown files of the tree under `root`: what git lists (tracked, plus untracked and not ignored), else a walk. */
export function markdownFiles(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (resolve(top) === resolve(root)) return out.split("\0").filter(Boolean).filter((f) => existsSync(join(root, f))).sort();
  } catch {
    // not a git checkout: fall through to the walk
  }
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".build" || e.name === "dist") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) found.push(relative(root, p).split(sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

/** `text` with fenced code blocks and inline code spans blanked out (line structure kept). */
export function maskCode(text) {
  const lines = text.split("\n");
  let fence = null;
  const out = lines.map((line) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) fence = null;
      return "";
    }
    if (m) { fence = m[1]; return ""; }
    return line.replace(/(`+)(?:(?!\1)[^]|\n)*?\1/g, (s) => " ".repeat(s.length));
  });
  return out.join("\n");
}

/** GitHub's anchor for a heading's text. */
export function slugify(heading) {
  let s = heading.trim();
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"); // [text](url) -> text
  s = s.replace(/<[^>]+>/g, ""); // inline HTML
  s = s.replace(/[`*~]/g, ""); // code, emphasis, strike marks
  s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "");
  return s.replace(/\s/g, "-");
}

/** The set of anchors a Markdown document offers: heading slugs (with -1, -2 for repeats) and explicit ids. */
export function anchorsOf(text) {
  const masked = maskCode(text);
  const anchors = new Set();
  const seen = new Map();
  const add = (title) => {
    const base = slugify(title);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  };
  const lines = masked.split("\n");
  lines.forEach((line, i) => {
    const atx = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) { add(atx[1]); return; }
    if (i > 0 && /^ {0,3}(=+|-+)[ \t]*$/.test(line) && lines[i - 1].trim() !== "" && !/^ {0,3}(#|>|[-*+] |\d+[.)] )/.test(lines[i - 1])) add(lines[i - 1]);
  });
  for (const m of masked.matchAll(/<a\s[^>]*?\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(m[1]);
  return anchors;
}

/** [{line, target}] for every link in `text` (code ignored). */
export function linksOf(text) {
  const masked = maskCode(text);
  const out = [];
  masked.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      const t = m[1].startsWith("<") ? m[1].slice(1, -1) : m[1];
      if (t) out.push({ line: i + 1, target: t });
    }
    const ref = /^ {0,3}\[[^\]]+\]:[ \t]*(<[^>]*>|\S+)/.exec(line);
    if (ref) out.push({ line: i + 1, target: ref[1].startsWith("<") ? ref[1].slice(1, -1) : ref[1] });
    // HTML image sources (README's hero is a <picture>): <img src="...">, <source srcset="a.png 1x, b.png 2x">
    for (const tag of line.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
      for (const a of tag[0].matchAll(/\s(src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const value = (a[2] ?? a[3]).trim();
        const urls = a[1].toLowerCase() === "src" ? [value] : value.split(",").map((c) => c.trim().split(/\s+/)[0]);
        for (const t of urls) if (t) out.push({ line: i + 1, target: t });
      }
    }
  });
  return out;
}

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Problems in the Markdown files under `root` (paths relative to it, forward slashes).
 * Returns [{file, line, target, problem}]. `files` defaults to every Markdown file of the tree.
 */
export function checkLinks(root, files = markdownFiles(root)) {
  const problems = [];
  const anchorCache = new Map();
  const anchorsFor = (rel) => {
    if (!anchorCache.has(rel)) anchorCache.set(rel, anchorsOf(readFileSync(join(root, rel), "utf8")));
    return anchorCache.get(rel);
  };
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const { line, target } of linksOf(text)) {
      if (EXTERNAL.test(target)) continue;
      const hashAt = target.indexOf("#");
      const rawPath = hashAt === -1 ? target : target.slice(0, hashAt);
      const anchor = hashAt === -1 ? "" : decode(target.slice(hashAt + 1));
      const pathPart = decode(rawPath.split("?")[0]);
      let destRel;
      if (pathPart === "") destRel = file;
      else if (pathPart.startsWith("/")) destRel = normalize(pathPart.slice(1));
      else destRel = normalize(join(dirname(file), pathPart));
      destRel = destRel.split(sep).join("/").replace(/\/$/, "");
      if (destRel === ".." || destRel.startsWith("../")) { problems.push({ file, line, target, problem: "leaves the repository" }); continue; }
      const abs = join(root, destRel);
      if (!existsSync(abs)) { problems.push({ file, line, target, problem: "file or folder does not exist" }); continue; }
      if (anchor !== "" && destRel.endsWith(".md") && statSync(abs).isFile() && !/^L\d+(-L\d+)?$/.test(anchor)) {
        if (!anchorsFor(destRel).has(anchor.toLowerCase()) && !anchorsFor(destRel).has(anchor)) {
          problems.push({ file, line, target, problem: `no heading or anchor "#${anchor}" in ${destRel}` });
        }
      }
    }
  }
  return problems;
}

/**
 * The internal paths named by `export-ignore` lines of .gitattributes (literal paths only), or [] when there is none
 * (the exported tree has no .gitattributes). Throws on a pattern that is not a plain path, since a glob here would
 * silently not be checked.
 */
export function internalPaths(root) {
  const f = join(root, ".gitattributes");
  if (!existsSync(f)) return [];
  const out = [];
  for (const raw of readFileSync(f, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (!attrs.includes("export-ignore")) continue;
    if (/[*?[\]!\\]/.test(pattern)) throw new Error(`.gitattributes: "${pattern}" is not a plain path; doc-links cannot check it`);
    out.push(pattern.replace(/^\//, "").replace(/\/$/, ""));
  }
  return out;
}

const isUnder = (p, dir) => p === dir || p.startsWith(`${dir}/`);

/** Links from documents that ship to files or folders that do not: [{file, line, target, internal}]. */
export function linksIntoInternal(root, files = markdownFiles(root)) {
  const internal = internalPaths(root);
  if (internal.length === 0) return [];
  const out = [];
  for (const file of files) {
    if (internal.some((d) => isUnder(file, d))) continue; // an internal document may link anywhere
    const text = readFileSync(join(root, file), "utf8");
    for (const { line, target } of linksOf(text)) {
      if (EXTERNAL.test(target)) continue;
      const pathPart = decode(target.split("#")[0].split("?")[0]);
      if (pathPart === "") continue;
      const dest = (pathPart.startsWith("/") ? normalize(pathPart.slice(1)) : normalize(join(dirname(file), pathPart))).split(sep).join("/").replace(/\/$/, "");
      const hit = internal.find((d) => isUnder(dest, d));
      if (hit) out.push({ file, line, target, internal: hit });
    }
  }
  return out;
}
