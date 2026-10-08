/**
 * The scan lock (D60): one writer at a time over the home folder. Hooks, the 15-minute LaunchAgent,
 * the app's "Scan now" and the CLI all start scans, so contention is normal and a busy lock just means "skip".
 *
 * Protocol:
 *  - Acquire: write {pid, token, uptime} to a private temp file (O_EXCL | O_NOFOLLOW, 0600) and link(2) it to
 *    `state/scan.lock`. link fails with EEXIST when a lock exists, so exactly one process gets it, and the lock file
 *    is complete from the moment it exists: there is no "created but still empty" state for a waiting process to
 *    misjudge as dead. (An earlier O_EXCL-create-then-write scheme let a holder stalled between open and write lose
 *    its empty lock to a waiter and carry on believing it held it.) After linking, the holder re-reads the lock
 *    (`held()`) before returning it.
 *  - A lock is STALE when its holder is gone — `process.kill(pid, 0)` says ESRCH (EPERM means alive, someone else's
 *    process) — or the machine rebooted since it was written (our uptime is below the recorded uptime), or it is more
 *    than an hour old by UPTIME (a pid reused by a long-lived process after a crash must not wedge every later scan).
 *    Uptime is monotonic within a boot, so none of this moves when the wall clock is set backward or forward: the
 *    people reset their clocks, and wall-clock age is never used. An hour is far beyond any scan (cold budget 30 s);
 *    a scan that sleeps with the machine for longer may lose its lock, which `held()` makes harmless.
 *    Some sandboxes (Codex's macOS workspace-write sandbox) refuse to report uptime. Then the lock records uptime -1
 *    ("unknown"), and a lock is judged by its holder's pid alone: never by wall-clock time, and never fail the scan.
 *    An empty or unparseable lock file is never written by this protocol; it is a leftover and is taken over.
 *  - Steal: rename the stale file to a unique name, re-read it, and only delete it if it is still the token we judged
 *    stale. If we moved a fresh lock aside instead (another process stole and re-acquired in between), it is linked
 *    back (link(2) fails rather than overwrite a third lock) and we report "busy".
 *  - The holder re-checks ownership (`held()`) right before committing outputs, and a scan that finds its lock taken
 *    over writes nothing more (not even its failure glance), so a holder whose lock was stolen (only possible if it
 *    was wrongly judged dead) never overwrites the thief's work.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, linkSync, openSync, renameSync, writeSync } from "node:fs";
import { uptime } from "node:os";
import { readOwnFile, removeQuietly } from "./atomic.js";

export interface ScanLock {
  readonly token: string;
  /** Still ours (the file exists and carries our token). */
  held(): boolean;
  release(): void;
}

interface LockInfo { pid: number; token: string; uptime: number }

/** Tokens this process holds (a second acquire in the same process is "busy", never a steal). */
const heldHere = new Set<string>();

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

type Seen = LockInfo | "empty" | "foreign" | "missing";

function readInfo(path: string): Seen {
  const r = readOwnFile(path, 4096);
  if (!r.buf) return r.why === "missing" ? "missing" : "foreign";
  if (r.buf.length === 0) return "empty";
  try {
    const v = JSON.parse(r.buf.toString("utf8")) as Partial<LockInfo>;
    if (Number.isSafeInteger(v.pid) && (v.pid as number) > 0 && typeof v.token === "string" && typeof v.uptime === "number") {
      return { pid: v.pid as number, token: v.token, uptime: v.uptime };
    }
  } catch { /* fall through */ }
  return "empty"; // unparseable: treated like a lock whose holder died mid-write
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return code(e) === "EPERM";
  }
}

/** Uptime age (seconds) past which a lock is stale whatever its pid says. */
export const LOCK_MAX_AGE_S = 3600;

let readUptime: () => number = uptime;

/** Seconds since boot, or -1 when the system refuses to say (a sandbox can block it). */
function safeUptime(): number {
  try {
    const up = readUptime();
    return Number.isFinite(up) && up >= 0 ? up : -1;
  } catch {
    return -1;
  }
}

/** Tests only: replace the uptime source (restore with `undefined`). */
export function setUptimeSourceForTests(fn: (() => number) | undefined): void {
  readUptime = fn ?? uptime;
}

function isStale(info: LockInfo): boolean {
  if (heldHere.has(info.token)) return false;
  const up = safeUptime();
  if (up >= 0 && info.uptime >= 0) {
    if (up + 1 < info.uptime) return true; // rebooted since it was written
    if (up - info.uptime > LOCK_MAX_AGE_S) return true; // older than any scan: its pid may belong to someone else now
  }
  if (info.pid === process.pid) return true; // our pid, not our token: an earlier process that had this pid
  return !alive(info.pid);
}

/** Move a stale lock aside and delete it only if it is still the one judged stale. */
function steal(path: string, token: string | undefined): boolean {
  const aside = `${path}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch {
    return true; // already gone: just retry the create
  }
  const got = readInfo(aside);
  const same = token === undefined ? got === "empty" : typeof got === "object" && got.token === token;
  if (same) {
    removeQuietly(aside);
    return true;
  }
  try { linkSync(aside, path); } catch { /* a third lock exists; the moved lock's holder will find it lost */ }
  removeQuietly(aside);
  return false;
}

/** Write `body` to a new private file (O_EXCL | O_NOFOLLOW, 0600). */
function writeNew(path: string, body: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    let off = 0;
    while (off < body.length) off += writeSync(fd, body, off, body.length - off);
  } finally {
    closeSync(fd);
  }
}

/** Take the scan lock, or undefined when another live scan holds it. */
export function acquireLock(path: string): ScanLock | undefined {
  const me: LockInfo = { pid: process.pid, token: randomBytes(12).toString("hex"), uptime: safeUptime() };
  const body = Buffer.from(`${JSON.stringify(me)}\n`, "utf8");
  for (let attempt = 0; attempt < 6; attempt++) {
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let linked = false;
    try {
      writeNew(tmp, body);
      linkSync(tmp, path);
      linked = true;
    } catch (e) {
      if (code(e) !== "EEXIST") throw e;
    } finally {
      removeQuietly(tmp);
    }
    if (linked) {
      heldHere.add(me.token);
      const lock = makeLock(path, me.token);
      if (lock.held()) return lock;
      heldHere.delete(me.token); // replaced already (only a wrong steal can do that): someone else holds it now
      return undefined;
    }
    const seen = readInfo(path);
    if (seen === "missing") continue;
    if (seen === "foreign") return undefined;
    if (seen === "empty") {
      // Never written by this protocol (the lock is linked into place complete): a leftover. Take it over.
      if (!steal(path, undefined)) return undefined;
      continue;
    }
    if (!isStale(seen)) return undefined;
    if (!steal(path, seen.token)) return undefined;
  }
  return undefined;
}

function makeLock(path: string, token: string): ScanLock {
  return {
    token,
    held(): boolean {
      const s = readInfo(path);
      return typeof s === "object" && s.token === token;
    },
    release(): void {
      if (this.held()) removeQuietly(path);
      heldHere.delete(token);
    },
  };
}
