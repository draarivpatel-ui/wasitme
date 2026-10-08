/**
 * The local salt (PRIVACY.md "What is stored"): 32 random bytes, stored as 64 lowercase hex characters plus a newline,
 * mode 0600. Creation never exposes a partial file: the salt is written and fsync'ed to a private temp file (O_EXCL |
 * O_NOFOLLOW, 0600) which is then link(2)ed to `salt`. link fails with EEXIST when another process got there first,
 * so concurrent creators (two hooks and the LaunchAgent starting together is routine) cannot both win: exactly one
 * salt is ever in place, complete from its first byte, and every other process reads the winner's salt. (An earlier
 * O_EXCL-create-then-write scheme let a creator stalled between open and write lose its empty file to a waiting
 * process and return a salt nobody else used.)
 *
 * A missing salt is only created when the store holds no history (`refuseIf`): every stored id was made with the old
 * salt, so a new one would silently double every exchange, session and event. That case is an error for doctor.
 *
 * The salt never leaves this folder: it is never printed, logged, put on a command line or exported.
 * `--read-only` scans never touch it: they use an ephemeral random salt (ids cannot be linked across runs).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, linkSync, openSync, writeSync } from "node:fs";
import { readOwnFile, removeQuietly } from "./atomic.js";
import { HomeError } from "./home.js";

const SALT_RE = /^([0-9a-f]{64})\n?$/;

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

/** Synchronous sleep (no timers: the scan is a short-lived CLI and this only runs in a creation race). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A fresh salt for `--read-only` runs (never written anywhere). */
export function ephemeralSalt(): string {
  return randomBytes(32).toString("hex");
}

function readSalt(path: string): { salt?: string; why?: string; mode?: number } {
  const r = readOwnFile(path, 256);
  if (!r.buf) return { why: r.why };
  const m = SALT_RE.exec(r.buf.toString("latin1"));
  return m ? { salt: m[1]!, mode: r.mode } : { why: r.buf.length < 64 ? "short" : "malformed", mode: r.mode };
}

/**
 * The salt at `path`, created when missing and `create` is set — unless `refuseIf()` says history already exists (then
 * HomeError "internal": restoring the salt, or resetting history together with it, is the user's call). Throws
 * HomeError when the file exists but is not a usable salt (not ours, not a regular file, malformed): a different salt
 * would silently unlink every stored id from its history, so that is never "fixed" by overwriting.
 */
export function loadSalt(path: string, opts: { create: boolean; refuseIf?: () => boolean }): string {
  let shortSeen = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    const r = readSalt(path);
    if (r.salt) {
      if (r.mode !== undefined && (r.mode & 0o077) !== 0) {
        // Ours but readable by others (an old install, a restore): tighten it rather than refuse to run.
        try { chmodSync(path, 0o600); } catch { /* reported by doctor */ }
      }
      return r.salt;
    }
    if (r.why === "short") {
      // Never written by this code (a salt is linked into place complete); a leftover of an older writer or a damaged
      // disk. Wait briefly in case an older writer is mid-write, then remove it only if no history depends on it.
      if (++shortSeen >= 50 && opts.create && readOwnFile(path, 256).buf?.length === 0 && !opts.refuseIf?.()) { removeQuietly(path); continue; }
      sleepMs(10);
      continue;
    }
    if (r.why !== "missing") throw new HomeError("permission_denied", `the salt file is not usable (${r.why ?? "unknown"})`);
    if (!opts.create) throw new HomeError("internal", "the salt file is missing");
    if (opts.refuseIf?.()) throw new HomeError("internal", "the salt file is missing but history exists (a new salt would duplicate it)");
    const salt = randomBytes(32).toString("hex");
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      const buf = Buffer.from(`${salt}\n`, "latin1");
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      try { fsyncSync(fd); } catch { /* best effort */ }
      closeSync(fd);
      fd = undefined;
      linkSync(tmp, path);
      return salt;
    } catch (e) {
      if (code(e) === "EEXIST") continue; // another process won the race: read its salt
      throw new HomeError(code(e) === "EACCES" || code(e) === "ERR_ACCESS_DENIED" ? "permission_denied" : "write_failed", "cannot create the salt file");
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
      removeQuietly(tmp);
    }
  }
  throw new HomeError("internal", "the salt file stayed incomplete");
}
