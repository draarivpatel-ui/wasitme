/**
 * Clearing the saved history (`wasitme history clear`): what wasitme derived from the logs goes, everything that sets
 * wasitme up stays (PRIVACY.md "How to delete everything").
 *
 *   deleted   glance.json, snapshot.json         the results every surface shows
 *             history/                           index, shards, priors, config and project history
 *             state/decisions.json               each agent's last decision (persistence)
 *             state/projsnap/                    project snapshots the hook left for the next scan
 *   kept      salt                               state/exclude.json matches projects by salted id: a new salt would
 *                                                quietly break every project exclusion
 *             state/exclude.json, engine.json, engine.env, backups/, logs/, the install (versions/, current,
 *             install-manifest) and anything else in the folder
 *
 * The scan lock is held for the whole clear, so a scan can never interleave with it (a busy lock waits briefly, then
 * gives up having deleted nothing). Folders are renamed aside first and deleted after, so an interruption leaves either
 * the old folder or a `.cleared-*` leftover that the next clear removes; never half a store. Nothing is followed: a
 * symlink in the way is removed as a link, and a home folder that is a symlink or someone else's is refused (home.ts).
 * After a clear, the next scan starts from nothing with the same salt: the logs the agents still keep are read again,
 * and history older than those logs is gone for good.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, renameSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDir, HomeError, type HomePaths } from "./home.js";
import { acquireLock, type ScanLock } from "./lock.js";

export interface ClearReport {
  /** The wasitme folder exists (nothing to clear otherwise). */
  existed: boolean;
  /** A scan held the lock for the whole wait: nothing was deleted. */
  busy: boolean;
  /** Regular files removed (what the prompt counts). */
  files: number;
  bytes: number;
}

const LEFTOVER = /^\.cleared-[0-9a-f]{12}$/;

/** What a clear removes, in removal order: the outputs every surface watches first, the history last. */
export function clearTargets(p: HomePaths): string[] {
  return [p.glance, p.snapshot, p.decisions, p.projsnapInbox, p.history];
}

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (e) {
    if (code(e) === "ENOENT" || code(e) === "ENOTDIR") return undefined;
    throw new HomeError("permission_denied", "cannot inspect the wasitme folder");
  }
}

/** Leftovers of an interrupted clear, in the two folders a clear renames into. */
function leftovers(p: HomePaths): string[] {
  const out: string[] = [];
  for (const dir of [p.home, p.state]) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) if (LEFTOVER.test(n)) out.push(join(dir, n));
  }
  return out;
}

/** Files and bytes under the paths (lstat only: links count as one small file and are never followed). */
function measure(paths: readonly string[]): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (path: string): void => {
    const st = lstatOrUndefined(path);
    if (st === undefined) return;
    if (st.isDirectory()) {
      let names: string[] = [];
      try { names = readdirSync(path); } catch { /* unreadable: removed as a whole below */ }
      for (const n of names) walk(join(path, n));
      return;
    }
    files += 1;
    bytes += st.isFile() ? st.size : 0;
  };
  for (const path of paths) walk(path);
  return { files, bytes };
}

/** The wasitme folder must be a real folder of ours, as everywhere else (home.ts ensureDir). */
function checkHome(p: HomePaths): boolean {
  const st = lstatOrUndefined(p.home);
  if (st === undefined) return false;
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HomeError("permission_denied", "the wasitme folder is not a plain directory");
  const me = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (me !== undefined && st.uid !== me) throw new HomeError("permission_denied", "the wasitme folder is owned by another user");
  return true;
}

/** What a clear would delete right now (for the confirmation question), without deleting anything. */
export function clearPreview(p: HomePaths): ClearReport {
  if (!checkHome(p)) return { existed: false, busy: false, files: 0, bytes: 0 };
  return { existed: true, busy: false, ...measure([...clearTargets(p), ...leftovers(p)]) };
}

function removePath(path: string): void {
  const st = lstatOrUndefined(path);
  if (st === undefined) return;
  try {
    if (st.isDirectory()) {
      // Renamed aside first (one atomic step), then deleted: an interruption never leaves half a history folder.
      const aside = join(dirname(path), `.cleared-${randomBytes(6).toString("hex")}`);
      renameSync(path, aside);
      rmSync(aside, { recursive: true, force: true });
    } else {
      rmSync(path, { force: true });
    }
  } catch (e) {
    throw new HomeError(code(e) === "EACCES" || code(e) === "EPERM" || code(e) === "ERR_ACCESS_DENIED" ? "permission_denied" : "write_failed", `could not delete ${basename(path)}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Delete the saved history and results (see the header). Waits up to `waitMs` for a running scan to finish; a lock that
 * stays busy returns `busy` with nothing deleted.
 */
export async function clearHistory(p: HomePaths, opts: { waitMs?: number } = {}): Promise<ClearReport> {
  if (!checkHome(p)) return { existed: false, busy: false, files: 0, bytes: 0 };
  ensureDir(p.state); // the lock lives here; a home that never scanned may not have it yet
  const deadline = Date.now() + Math.max(0, opts.waitMs ?? 5000);
  let lock: ScanLock | undefined;
  for (;;) {
    lock = acquireLock(p.lock);
    if (lock !== undefined || Date.now() >= deadline) break;
    await sleep(250);
  }
  if (lock === undefined) return { existed: true, busy: true, files: 0, bytes: 0 };
  try {
    const targets = [...clearTargets(p), ...leftovers(p)];
    const counted = measure(targets);
    for (const t of targets) removePath(t);
    return { existed: true, busy: false, ...counted };
  } finally {
    lock.release();
  }
}
