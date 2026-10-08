/**
 * Small, careful file IO for the home folder.
 *
 *  - writeAtomic: a 0600 temp file created with O_EXCL | O_NOFOLLOW next to the target, written, fsync'ed and renamed
 *    over the target. Readers (the app's DirectoryWatcher, the mod, the status line) see the old file or the new one,
 *    never a torn one. The temp name carries the pid and random bytes, so concurrent writers never collide.
 *  - writeIfChanged: skips the write when the bytes on disk are already identical (idempotent scans leave every
 *    unchanged file — and its mtime — alone).
 *  - readOwnFile: reads a file only if lstat says it is a regular file (not a symlink, FIFO or device) owned by us,
 *    bounded in size. Anything else reads as "absent" with a reason.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

export function writeAtomic(path: string, data: string | Buffer, opts: { fsync?: boolean } = {}): void {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    if (opts.fsync !== false) {
      try { fsyncSync(fd); } catch { /* best effort: rename still gives readers an untorn file */ }
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export interface OwnRead {
  buf?: Buffer;
  /** Why there is no buffer: missing, not a regular file, not ours, too large, unreadable. */
  why?: "missing" | "not-file" | "not-owned" | "too-large" | "unreadable";
  mode?: number;
}

/** Read a regular file we own (lstat-checked, opened O_NOFOLLOW, bounded by `max` bytes). */
export function readOwnFile(path: string, max: number): OwnRead {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return { why: code(e) === "ENOENT" || code(e) === "ENOTDIR" ? "missing" : "unreadable" };
  }
  if (!st.isFile()) return { why: "not-file" };
  const me = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (me !== undefined && st.uid !== me) return { why: "not-owned" };
  if (st.size > max) return { why: "too-large" };
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const fst = fstatSync(fd);
    if (!fst.isFile()) return { why: "not-file" };
    if (fst.size > max) return { why: "too-large" };
    const buf = Buffer.allocUnsafe(fst.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: got === buf.length ? buf : buf.subarray(0, got), mode: fst.mode & 0o777 };
  } catch (e) {
    return { why: code(e) === "ENOENT" ? "missing" : "unreadable" };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Write `data` atomically unless the file already holds exactly these bytes. Returns whether it wrote. */
export function writeIfChanged(path: string, data: string | Buffer, max = 64 << 20, opts: { fsync?: boolean } = {}): boolean {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const old = readOwnFile(path, Math.max(max, buf.length));
  if (old.buf && old.buf.equals(buf)) return false;
  writeAtomic(path, buf, opts);
  return true;
}

/** JSON.parse of an own file, or undefined (missing, unreadable, malformed). */
export function readOwnJson(path: string, max: number): unknown {
  const r = readOwnFile(path, max);
  if (!r.buf) return undefined;
  try {
    return JSON.parse(r.buf.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Append to a regular file we own (created 0600 if missing). The path is opened O_NOFOLLOW | O_NONBLOCK and checked with
 * fstat, so a symlink, FIFO or device planted at it, or a file owned by someone else, is never written through.
 * Returns whether it wrote.
 */
export function appendOwnFile(path: string, data: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
    const st = fstatSync(fd);
    const me = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!st.isFile() || (me !== undefined && st.uid !== me)) return false;
    const buf = Buffer.from(data, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function removeQuietly(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}
