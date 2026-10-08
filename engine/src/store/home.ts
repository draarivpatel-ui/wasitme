/**
 * The wasitme home folder (PRIVACY.md "What is stored"): `~/.wasitme`, or `WASITME_HOME` when set (absolute paths only).
 *
 *   salt                       32 random bytes as 64 hex characters, 0600, created with O_EXCL (salt.ts)
 *   engine.json                written by setup; the scan records the permission-flag feature test in it (permission.ts)
 *   glance.json snapshot.json  atomic writes (contract/glance.v1, snapshot.v1)
 *   history/index.json         the store's manifest: one entry per source ever seen (by salted id), the time zone,
 *                              parser versions, the inputs digest of the last analysis (manifest.ts)
 *   history/shards/<sid>.json  one per source: its derived exchanges/events/stats — history that survives the
 *                              deletion of the source log (shard.ts)
 *   history/priors/<sid>.json  salted record ids of a listed Claude session, for the resume dedupe of later sessions
 *                              in a fresh process (priorcache.ts); pruned once the session's log is gone
 *   history/config.json        global config snapshots (last known state per agent) and the change events between them
 *   history/projsnap.json      consolidated project snapshots from the SessionStart hook
 *   state/scan.lock            single-writer lock (lock.ts)
 *   state/exclude.json         exclusions (exclude.ts), local only
 *   state/decisions.json       each agent's last attribution decision, for persistence (decisions.ts)
 *   state/projsnap/            one file per SessionStart hook run, consolidated by the next scan
 *   logs/                      error kinds only (never paths, never text)
 *
 * Folders are 0700 and files 0600. Every folder is checked with lstat: a symlink or a folder owned by someone else
 * is refused (HomeError "permission_denied"), never followed.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface HomePaths {
  home: string;
  salt: string;
  engineJson: string;
  glance: string;
  snapshot: string;
  history: string;
  shards: string;
  /** Record ids of listed Claude sessions for the resume dedupe (priorcache.ts); not history. */
  priors: string;
  index: string;
  config: string;
  projsnapHistory: string;
  state: string;
  lock: string;
  exclude: string;
  /** Each agent's last decision (persistence, decisions.ts). */
  decisions: string;
  projsnapInbox: string;
  logs: string;
}

export class HomeError extends Error {
  constructor(readonly kind: "permission_denied" | "write_failed" | "internal", message: string) {
    super(message);
  }
}

/** WASITME_HOME (absolute, non-empty) or ~/.wasitme. A relative WASITME_HOME is a configuration error. */
export function wasitmeHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const v = env.WASITME_HOME;
  if (v !== undefined && v.trim() !== "") {
    if (!isAbsolute(v)) throw new HomeError("internal", "WASITME_HOME must be an absolute path");
    return v;
  }
  return join(homedir(), ".wasitme");
}

export function homePaths(home: string): HomePaths {
  const history = join(home, "history");
  const state = join(home, "state");
  return {
    home,
    salt: join(home, "salt"),
    engineJson: join(home, "engine.json"),
    glance: join(home, "glance.json"),
    snapshot: join(home, "snapshot.json"),
    history,
    shards: join(history, "shards"),
    priors: join(history, "priors"),
    index: join(history, "index.json"),
    config: join(history, "config.json"),
    projsnapHistory: join(history, "projsnap.json"),
    state,
    lock: join(state, "scan.lock"),
    exclude: join(state, "exclude.json"),
    decisions: join(state, "decisions.json"),
    projsnapInbox: join(state, "projsnap"),
    logs: join(home, "logs"),
  };
}

function uid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

/** Make sure `dir` is a real directory we own, mode 0700 (creating it, and missing parents, if needed). */
export function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    if (code(e) !== "EEXIST") throw new HomeError(code(e) === "EACCES" || code(e) === "EPERM" || code(e) === "ERR_ACCESS_DENIED" ? "permission_denied" : "write_failed", `cannot create a wasitme folder (${code(e) ?? "unknown"})`);
  }
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new HomeError("permission_denied", "cannot inspect a wasitme folder");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HomeError("permission_denied", "a wasitme folder is not a plain directory");
  const me = uid();
  if (me !== undefined && st.uid !== me) throw new HomeError("permission_denied", "a wasitme folder is owned by another user");
  if ((st.mode & 0o777) !== 0o700) {
    try { chmodSync(dir, 0o700); } catch { /* best effort: a stricter mode is not required to proceed */ }
  }
}

/** Create every folder the scan writes into. */
export function ensureHome(p: HomePaths): void {
  for (const d of [p.home, p.history, p.shards, p.state, p.projsnapInbox]) ensureDir(d);
}

/**
 * Whether the store already holds history (a manifest or any shard). Ids in it were made with the existing salt, so a
 * missing salt must never be replaced by a new one while this is true (salt.ts `refuseIf`): every source would get a
 * new id, and the old shards would stay as history-only twins that the cross-file dedupe can no longer match.
 */
export function historyExists(p: HomePaths): boolean {
  if (existsSync(p.index)) return true;
  try {
    return readdirSync(p.shards).some((n) => /^src-[0-9a-f]{24}\.json$/.test(n));
  } catch {
    return false;
  }
}
