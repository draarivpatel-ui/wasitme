/**
 * `wasitme hook session-start` (D32, D50; PRIVACY.md "What is read", the project-file read): the in-process project
 * config snapshot. The plugin's hook script runs it as
 *
 *   <node> --permission --allow-fs-read=<~/.wasitme> --allow-fs-read=<cwd> --allow-fs-write=<~/.wasitme> \
 *          <engine>/dist/src/cli/main.js hook session-start          (hook JSON on stdin, or --cwd/--session)
 *
 * and then kicks the scan. This process:
 *  - takes `cwd` and `session_id` from the hook payload (bounded stdin) or from flags, and refuses a cwd that is not
 *    absolute, not strictly below $HOME, $HOME itself or an ancestor, or contains `..`, `*`, a newline or a NUL —
 *    and one whose REAL path (symlinks resolved) is not strictly below $HOME; files are read through the real path;
 *  - looks at FIXED file names only (PROJECT_FILES), each checked with lstat (regular files only: a FIFO would block,
 *    a symlink is not followed, a symlinked `.claude/` folder is not entered), opened O_NOFOLLOW | O_NONBLOCK, at most
 *    1 MiB; a file whose size or mtime moved while it was read, or a JSON file that does not parse, is a torn read →
 *    "unknown" (no keys, so never an event); EACCES / EPERM / a sandbox denial → "not observed";
 *  - HMACs the bytes in-process with the local salt (created O_EXCL if this is the very first run) — the salt never
 *    appears on a command line — and writes one record atomically into `~/.wasitme/state/projsnap/`.
 * It prints nothing (a SessionStart hook's stdout becomes model context) and never fails the session: every problem
 * ends as "no record".
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { shortHash } from "../extract/configsnap/labels.js";
import { writeAtomic } from "../store/atomic.js";
import { projectKeysForCwd } from "../store/exclude.js";
import { ensureDir, historyExists, homePaths, wasitmeHome } from "../store/home.js";
import { PROJECT_FILES, PROJSNAP_SCHEMA, type ProjItems } from "../store/projsnap.js";
import { loadSalt } from "../store/salt.js";
import { makeHash } from "../util.js";

const CAP = 1 << 20;
const STDIN_CAP = 256 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export type FileState = "ok" | "missing" | "symlink" | "not-file" | "too-large" | "torn" | "denied" | "unreadable";

export interface HookInput { cwd?: string; session?: string }

export interface HookResult {
  wrote: boolean;
  /** Why nothing was written (a kind, never a path). */
  skipped?: "no-cwd" | "bad-cwd" | "outside-home" | "home-error";
  states?: Record<string, FileState>;
  observed?: boolean;
}

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

const denied = (c: string | undefined): boolean => c === "EACCES" || c === "EPERM" || c === "ERR_ACCESS_DENIED";

/** cwd and session_id from a Claude Code hook payload (JSON on stdin); anything else is ignored. */
export function parseHookPayload(text: string): HookInput {
  if (text.length > STDIN_CAP) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const o = v as Record<string, unknown>;
    return {
      cwd: typeof o.cwd === "string" ? o.cwd : undefined,
      session: typeof o.session_id === "string" ? o.session_id : undefined,
    };
  } catch {
    return {};
  }
}

/** The cwd rule (PRIVACY.md "What is read": below $HOME, no `..`; plus S-NODEPERM's `*` and $HOME-ancestor guard). */
export function checkCwd(cwd: string | undefined, userHome: string): HookResult["skipped"] | undefined {
  if (cwd === undefined || cwd === "") return "no-cwd";
  if (!isAbsolute(cwd) || /[\n\r\0*]/.test(cwd)) return "bad-cwd";
  if (cwd.split(/[\\/]+/).includes("..")) return "bad-cwd";
  const norm = normalize(cwd).replace(/[\\/]+$/, "");
  const home = normalize(userHome).replace(/[\\/]+$/, "");
  if (!norm.startsWith(home + sep)) return "outside-home"; // also excludes $HOME itself and every ancestor of it
  return undefined;
}

/**
 * The real location of an accepted cwd, or undefined when it is not strictly below the real $HOME (PRIVACY.md
 * "What is read": project files are read only below $HOME). checkCwd judges the text only; a symlinked component of
 * the cwd (or of an ancestor) could still lead outside $HOME or into a macOS-protected folder, and a sandbox grant on a
 * link opens its target (S-NODEPERM §3.6), so the sandbox does not catch it. Under the sandbox $HOME itself may be
 * unreadable: its text is used then (the real path of the cwd is still resolved by the OS, whatever the grants).
 */
export function realCwdBelowHome(cwd: string, userHome: string): string | undefined {
  let real: string;
  try {
    real = realpathSync.native(cwd);
  } catch {
    return undefined;
  }
  let home = normalize(userHome).replace(/[\\/]+$/, "");
  try { home = realpathSync.native(home); } catch { /* hidden by the sandbox: compare with its text */ }
  return real.startsWith(home + sep) && real.length > home.length + 1 ? real : undefined;
}

interface Read { state: FileState; buf?: Buffer; size?: number }

/** One fixed-name project file, read the careful way (see the header). */
export function readProjectFile(cwd: string, rel: readonly string[]): Read {
  let dir = cwd;
  for (const part of rel.slice(0, -1)) {
    dir = join(dir, part);
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink()) return { state: "symlink" };
      if (!st.isDirectory()) return { state: "missing" }; // no such folder: the file cannot exist
    } catch (e) {
      const c = code(e);
      return { state: c === "ENOENT" || c === "ENOTDIR" ? "missing" : denied(c) ? "denied" : "unreadable" };
    }
  }
  const path = join(dir, rel[rel.length - 1]!);
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    const c = code(e);
    return { state: c === "ENOENT" || c === "ENOTDIR" ? "missing" : denied(c) ? "denied" : "unreadable" };
  }
  if (st.isSymbolicLink()) return { state: "symlink" };
  if (!st.isFile()) return { state: "not-file" };
  if (st.size > CAP) return { state: "too-large", size: st.size };
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) return { state: "not-file" };
    if (before.size > CAP) return { state: "too-large", size: before.size };
    const buf = Buffer.allocUnsafe(before.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    const after = fstatSync(fd);
    if (got !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { state: "torn" };
    return { state: "ok", buf, size: before.size };
  } catch (e) {
    const c = code(e);
    return { state: c === "ENOENT" ? "missing" : denied(c) ? "denied" : "unreadable" };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

function parsesAsJson(buf: Buffer): boolean {
  const s = buf.toString("utf8").replace(/^﻿/, "");
  if (s.trim() === "") return true; // an empty settings file is a definite state, not a torn one
  try { JSON.parse(s); return true; } catch { return false; }
}

export interface HookOptions extends HookInput {
  /** wasitme home (default: WASITME_HOME or ~/.wasitme). */
  home?: string;
  /** The user's home directory (default: os.homedir()). */
  userHome?: string;
  now?: Date;
}

export function sessionStartHook(opts: HookOptions): HookResult {
  const userHome = opts.userHome ?? homedir();
  const skipped = checkCwd(opts.cwd, userHome);
  if (skipped) return { wrote: false, skipped };
  const cwd = normalize(opts.cwd!).replace(/[\\/]+$/, "");
  // Files are read through the real path (nothing a symlink points at outside $HOME); project keys use the text,
  // which is what Claude Code encodes into its project folder names.
  const real = realCwdBelowHome(cwd, userHome);
  if (real === undefined) return { wrote: false, skipped: "bad-cwd" };
  const now = opts.now ?? new Date();

  let salt: string;
  const p = homePaths(opts.home ?? wasitmeHome());
  try {
    ensureDir(p.home);
    ensureDir(p.state);
    ensureDir(p.projsnapInbox);
    salt = loadSalt(p.salt, { create: true, refuseIf: () => historyExists(p) });
  } catch {
    return { wrote: false, skipped: "home-error" };
  }
  const hash = makeHash(salt);

  const items: ProjItems = {};
  const states: Record<string, FileState> = {};
  let observed = false;
  for (const f of PROJECT_FILES) {
    const r = readProjectFile(real, f.rel);
    let state = r.state;
    if (state === "ok" && f.json && r.buf && !parsesAsJson(r.buf)) state = "torn"; // half-written JSON looks malformed
    states[f.id] = state;
    if (state === "missing") {
      items[`${f.id}.present`] = false;
      observed = true;
    } else if (state === "ok" && r.buf) {
      items[`${f.id}.present`] = true;
      // latin1 maps bytes 1:1 to code points: every distinct byte sequence hashes differently.
      items[`${f.id}.hash`] = shortHash(hash, r.buf.toString("latin1"));
      items[`${f.id}.bytes`] = r.buf.length;
      items[`${f.id}.lines`] = countLines(r.buf);
      observed = true;
    } else if (state === "too-large" && r.size !== undefined) {
      items[`${f.id}.present`] = true;
      items[`${f.id}.bytes`] = r.size;
      observed = true;
    }
    // symlink / not-file / torn / denied / unreadable: unknown, no keys.
  }
  const session = opts.session !== undefined && SESSION_ID_RE.test(opts.session) ? hash(opts.session, "s-") : null;
  const t = now.toISOString();
  const record = { schema: PROJSNAP_SCHEMA, t, session, projects: projectKeysForCwd(hash, cwd), observed, items };
  const name = `${t.replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}.json`;
  try {
    writeAtomic(join(p.projsnapInbox, name), `${JSON.stringify(record)}\n`);
  } catch {
    return { wrote: false, skipped: "home-error", states, observed };
  }
  return { wrote: true, states, observed };
}
