import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileStamp, Source } from "../types.js";

/** Cache key for a Source: changes whenever any of its files changes. */
export function fingerprint(s: Source): string {
  return s.files.map((f) => `${f.mtimeMs}:${f.size}`).join("|");
}

/**
 * When a file was created, as far as stat(2) can tell (ms). Used for the resume-dedupe creation order and the shards'
 * `born`.
 *  - No birth time recorded (0): the mtime.
 *  - Born after its last modification, with the inode changed after that birth: the mtime was set back once the file
 *    existed — a copy or a restore that keeps modification times. Linux then keeps the copy's own birth time (in
 *    whatever order the copy walked the folders), while APFS moves the birth time back to the old mtime by itself. The
 *    mtime is the better bound, and both systems agree.
 *  - Otherwise the birth time, even past the mtime: then the clock went backward since the file was created (its later
 *    changes carry the earlier clock), and no stat field says which order is right, so nothing changes.
 */
export function bornMs(st: { birthtimeMs: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint }): number {
  const born = Number(st.birthtimeMs);
  const mtime = Number(st.mtimeMs);
  if (!(born > 0)) return mtime;
  if (born > mtime && Number(st.ctimeMs) >= born) return mtime;
  return born;
}

/** Stat a regular file (symlinks to files are followed; anything else → undefined). */
export function stamp(path: string): FileStamp | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    return { path, mtimeMs: Math.round(st.mtimeMs), size: st.size };
  } catch {
    return undefined;
  }
}

/**
 * Strong identity of a file for dependency fingerprints: device, inode, size, mtime and ctime in nanoseconds (a file
 * replaced by rename, or rewritten in place with its mtime restored, still moves inode or ctime). Undefined if gone.
 */
export function identity(path: string): string | undefined {
  try {
    const st = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!st || !st.isFile()) return undefined;
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return undefined;
  }
}

export interface Entry { name: string; path: string; isDir: boolean; isFile: boolean }

/**
 * Directory entries, or [] if unreadable. Symlinks are never followed (SECURITY.md "Hostile input handling"; D52f): a
 * symlinked directory is neither a directory nor a file, and a symlinked FILE is not a file either — under
 * `node --permission` a link inside an allowed root still opens its target outside it (S-NODEPERM §3.6), and a link
 * into a macOS-protected folder would raise a privacy prompt. Only the type readdir reports is used: no stat.
 */
export function entries(dir: string): Entry[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      path: join(dir, e.name),
      isDir: e.isDirectory(),
      isFile: e.isFile(),
    }));
  } catch {
    return [];
  }
}

export function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

/** Recursively collect files matching `match`, bounded depth, never following directory symlinks. */
export function walkFiles(dir: string, match: (name: string, path: string) => boolean, depth = 8): string[] {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const e of entries(dir)) {
    if (e.isDir) out.push(...walkFiles(e.path, match, depth - 1));
    else if (e.isFile && match(e.name, e.path)) out.push(e.path);
  }
  return out;
}
