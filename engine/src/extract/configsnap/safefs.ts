import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { Guard } from "./types.js";

/**
 * Guarded filesystem access for the config collector.
 *
 * Two promises:
 *  1. Nothing inside an "avoid" directory (macOS privacy-protected folders such as ~/Documents) is
 *     ever stat'ed, listed or opened — not even through a symlink. Symlinks are resolved one hop at a
 *     time with lstat/readlink, and every step is checked against the avoid list BEFORE it is touched.
 *  2. Reads are bounded and only ever open regular files (a FIFO or /dev/zero symlinked in as CLAUDE.md
 *     cannot hang or exhaust memory).
 */

export type Access = "ok" | "missing" | "unreadable" | "protected" | "not-file";

const MAX_HOPS = 40;
export const MAX_DIR_ENTRIES = 2000;

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function accessOfError(e: unknown): "missing" | "unreadable" {
  const c = code(e);
  return c === "ENOENT" || c === "ENOTDIR" ? "missing" : "unreadable";
}

/**
 * Normalise avoid-roots: absolute and lower-cased (macOS/Windows are case-insensitive). Because
 * resolveSafe walks real (symlink-free) paths, each root is also added in its resolved spelling —
 * computed from the root's PARENT only, so the protected folder itself is never touched.
 */
export function makeGuard(avoid: readonly string[]): Guard {
  const roots = new Set<string>();
  for (const a of avoid) {
    if (!a) continue;
    const abs = stripSep(resolve(a));
    roots.add(abs.toLowerCase());
    const parent = resolveSafe(dirname(abs), []);
    if (parent.status === "ok") roots.add(join(parent.path, basename(abs)).toLowerCase());
  }
  return [...roots];
}

function stripSep(p: string): string {
  const root = parse(p).root;
  return p.length > root.length && p.endsWith(sep) ? p.slice(0, -1) : p;
}

export function isProtected(path: string, guard: Guard): boolean {
  if (guard.length === 0) return false;
  const lc = path.toLowerCase();
  for (const r of guard) if (lc === r || lc.startsWith(r.endsWith(sep) ? r : r + sep)) return true;
  return false;
}

export type Resolved = { status: "ok"; path: string } | { status: "missing" | "unreadable" | "protected" };

/**
 * Component-wise realpath that refuses to touch avoided directories. Returns the final path with no
 * symlink components, or why it could not be resolved.
 *
 * Under `node --permission` (S-NODEPERM §3.3/§3.5, D49) the ancestors of the granted roots (`/`, `/Users`, the
 * home directory itself) cannot be lstat'ed: the sandbox answers ERR_ACCESS_DENIED. Such an ANCESTOR (a component
 * with more components still to walk) is treated as a plain directory and the walk goes on; the leaf is always
 * checked, and every component inside the granted roots is still walked hop by hop and checked against the avoid
 * list. What this gives up: an ancestor the sandbox hides is not followed if it is itself a symlink (the OS still
 * follows it when the file is opened), and none of those ancestors can be on the avoid list (they are parents of
 * the granted roots, not protected folders).
 */
export function resolveSafe(input: string, guard: Guard): Resolved {
  const abs = resolve(input);
  const root = parse(abs).root;
  const stack = splitParts(abs.slice(root.length)).reverse();
  let cur = root;
  let hops = 0;
  while (stack.length) {
    const part = stack.pop()!;
    if (part === "" || part === ".") continue;
    if (part === "..") { cur = dirname(cur); continue; }
    const next = join(cur, part);
    if (isProtected(next, guard)) return { status: "protected" };
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch (e) {
      if (code(e) === "ERR_ACCESS_DENIED" && stack.length > 0) { cur = next; continue; }
      return { status: accessOfError(e) };
    }
    if (!isLink) { cur = next; continue; }
    if (++hops > MAX_HOPS) return { status: "unreadable" };
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return { status: "unreadable" };
    }
    if (isAbsolute(target)) {
      cur = parse(target).root;
      stack.push(...splitParts(target.slice(cur.length)).reverse());
    } else {
      stack.push(...splitParts(target).reverse());
    }
  }
  return { status: "ok", path: cur };
}

function splitParts(rel: string): string[] {
  return rel.split(/[\\/]+/).filter((s) => s.length > 0);
}

export interface ReadOutcome {
  access: Access;
  /** The bytes read (at most `cap`). Undefined unless access === "ok". */
  buf?: Buffer;
  /** Real size on disk (from fstat), which may exceed buf.length. */
  size: number;
  /** True when the file is larger than the cap and `buf` is only a prefix. */
  capped: boolean;
}

/** Bounded read of a regular file. One open + fstat + a fixed-size buffer: no stat/read race, no unbounded memory. */
export function readCapped(path: string, cap: number, guard: Guard): ReadOutcome {
  const r = resolveSafe(path, guard);
  if (r.status !== "ok") return { access: r.status, size: 0, capped: false };
  let fd: number | undefined;
  try {
    fd = openSync(r.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return { access: "not-file", size: 0, capped: false };
    const want = Math.max(0, Math.min(st.size, cap));
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { access: "ok", buf: got === want ? buf : buf.subarray(0, got), size: st.size, capped: st.size > cap };
  } catch (e) {
    return { access: accessOfError(e), size: 0, capped: false };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* nothing useful to do */ }
    }
  }
}

export function isFileSafe(path: string, guard: Guard): boolean {
  const r = resolveSafe(path, guard);
  if (r.status !== "ok") return false;
  try { return statSync(r.path).isFile(); } catch { return false; }
}

export function isDirSafe(path: string, guard: Guard): Access {
  const r = resolveSafe(path, guard);
  if (r.status !== "ok") return r.status;
  try { return statSync(r.path).isDirectory() ? "ok" : "not-file"; } catch (e) { return accessOfError(e); }
}

export interface ChildListing {
  access: Access;
  /** Names of child directories that contain `marker` (e.g. SKILL.md), sorted. Dot-directories are ignored. */
  names: string[];
  /** True when the listing may be incomplete (entry limit reached, or symlinked entries pointing into an avoided folder). */
  partial: boolean;
}

/**
 * Child directories of `dir` that contain a `marker` file. Symlinked directories are counted (dotfile
 * managers link skills in) — but a link that points into an avoided folder is counted by name only,
 * unverified, and flagged `partial`: its target is never touched.
 */
export function listMarkedChildren(dir: string, marker: string, guard: Guard, limit = MAX_DIR_ENTRIES): ChildListing {
  const r = resolveSafe(dir, guard);
  if (r.status !== "ok") return { access: r.status, names: [], partial: false };
  let ents: Dirent[];
  try {
    ents = readdirSync(r.path, { withFileTypes: true });
  } catch (e) {
    return { access: accessOfError(e), names: [], partial: false };
  }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names: string[] = [];
  let partial = ents.length > limit;
  for (const ent of ents.slice(0, limit)) {
    if (ent.name.startsWith(".")) continue;
    const p = join(r.path, ent.name);
    if (ent.isDirectory()) {
      if (isFileSafe(join(p, marker), guard)) names.push(ent.name);
    } else if (ent.isSymbolicLink()) {
      const t = resolveSafe(p, guard);
      if (t.status === "protected") {
        names.push(ent.name);
        partial = true;
      } else if (t.status === "ok" && isDirSafe(t.path, guard) === "ok" && isFileSafe(join(t.path, marker), guard)) {
        names.push(ent.name);
      }
    }
  }
  return { access: "ok", names, partial };
}
