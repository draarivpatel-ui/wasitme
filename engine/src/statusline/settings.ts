/**
 * Putting wasitme's status line into Claude Code's `settings.json`, and taking it out again EXACTLY (PRIVACY.md
 * "Backups the installer makes"; README "Where you see it"). A plugin cannot install a status line, so this is a
 * user-approved edit of one key:
 *
 *   {"type":"command","command":"<absolute path of packaging/statusline.sh>","padding":0}
 *
 * Rules:
 *  - TARGETED: the file is edited as text. The top-level `statusLine` member (its value, or one new member) is the only
 *    span that changes; every other byte (key order, indentation, comments of the user's own formatting, line endings)
 *    stays. Nothing is re-serialised.
 *  - BACKED UP: before the edit, `<home>/backups/statusline.json` records what was replaced (the old value's exact
 *    source text, or "there was none" with the exact text that was inserted) and what was written. If the old value was
 *    a command, it is also saved verbatim in `<home>/backups/statusline.cmd`, which the status-line script runs and
 *    appends to ("yours is kept and wrapped").
 *  - EXACT RESTORE: uninstall puts the old text back byte for byte (or removes the inserted text byte for byte), but only
 *    if the current `statusLine` is still wasitme's. If the user changed it since, it is left alone.
 *  - SAFE: a file that is not valid JSON, or whose top level is not an object, is never edited. Every edit is verified
 *    by parsing the result (and comparing every other key) before it is written, atomically, keeping the file's mode.
 *
 * The scanner below understands exactly the JSON that Claude Code writes (no comments, no trailing commas).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { readOwnFile, removeQuietly, writeAtomic } from "../store/atomic.js";

export class StatusLineError extends Error {
  constructor(readonly kind: "script_missing" | "settings_unreadable" | "settings_not_object" | "claude_folder_missing" | "edit_failed", message: string) {
    super(message);
  }
}

// ───────────────────────────── a scanner for the top-level members ─────────────────────────────

interface Member { key: string; keyStart: number; valueStart: number; valueEnd: number }
interface Top { open: number; close: number; members: Member[] }

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  return i;
}

function skipString(s: string, i: number): number {
  if (s[i] !== '"') throw new Error("string expected");
  i++;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") i += 2;
    else if (c === '"') return i + 1;
    else i++;
  }
  throw new Error("unterminated string");
}

function skipValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return skipString(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    while (i < s.length) {
      const d = s[i]!;
      if (d === '"') { i = skipString(s, i); continue; }
      if (d === "{" || d === "[") depth++;
      else if (d === "}" || d === "]") { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    throw new Error("unterminated value");
  }
  const start = i;
  while (i < s.length && !",}] \t\r\n".includes(s[i]!)) i++;
  if (i === start) throw new Error("value expected");
  return i;
}

function scanTop(src: string): Top {
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  i = skipWs(src, i);
  if (src[i] !== "{") throw new StatusLineError("settings_not_object", "the settings file's top level is not an object");
  const open = i;
  i = skipWs(src, i + 1);
  const members: Member[] = [];
  if (src[i] === "}") return { open, close: i, members };
  for (;;) {
    const keyStart = i;
    const keyEnd = skipString(src, i);
    const key = JSON.parse(src.slice(keyStart, keyEnd)) as string;
    i = skipWs(src, keyEnd);
    if (src[i] !== ":") throw new Error("colon expected");
    i = skipWs(src, i + 1);
    const valueStart = i;
    const valueEnd = skipValue(src, i);
    members.push({ key, keyStart, valueStart, valueEnd });
    i = skipWs(src, valueEnd);
    if (src[i] === ",") { i = skipWs(src, i + 1); continue; }
    if (src[i] === "}") return { open, close: i, members };
    throw new Error("comma or brace expected");
  }
}

function topOf(src: string): Top {
  try {
    return scanTop(src);
  } catch (e) {
    if (e instanceof StatusLineError) throw e;
    throw new StatusLineError("settings_unreadable", "the settings file is not JSON that wasitme can edit safely");
  }
}

/** The last member with this key (JSON.parse keeps the last duplicate too). */
function lastMember(top: Top, key: string): Member | undefined {
  for (let k = top.members.length - 1; k >= 0; k--) if (top.members[k]!.key === key) return top.members[k];
  return undefined;
}

// ───────────────────────────── what is written, and what is backed up ─────────────────────────────

export interface StatusLineFiles {
  /** Claude Code's user settings file. */
  settings: string;
  /** wasitme's backups folder (`<home>/backups`). */
  backups: string;
}

export function statusLineFiles(claudeDir: string, wasitmeHome: string): StatusLineFiles {
  return { settings: join(claudeDir, "settings.json"), backups: join(wasitmeHome, "backups") };
}

const BACKUP_SCHEMA = "wasitme.statusline-backup/1";

interface Backup {
  schema: typeof BACKUP_SCHEMA;
  /** The exact text now in settings.json's statusLine value (what uninstall looks for). */
  written: string;
  /** The exact source text of the value that was replaced; null when there was no statusLine. */
  replaced: string | null;
  /** When there was none: the exact text inserted into the file (separator, key and value). */
  inserted: string | null;
  /** Whether the replaced value was a command that the script wraps. */
  wrapped: boolean;
  /** settings.json did not exist and this install created it (uninstall deletes it again when it is back to `{}`). */
  created: boolean;
}

/** The fragment written into settings.json for a script path. */
export function ourFragment(command: string): string {
  return JSON.stringify({ type: "command", command, padding: 0 });
}

function isOurs(valueText: string, command: string): boolean {
  try {
    const v = JSON.parse(valueText) as { type?: unknown; command?: unknown };
    return v !== null && typeof v === "object" && v.type === "command" && v.command === command;
  } catch {
    return false;
  }
}

function fileMode(path: string): number | undefined {
  try { return lstatSync(path).mode & 0o777; } catch { return undefined; }
}

function readSettings(path: string): string | null {
  const r = readOwnFile(path, 4 << 20);
  if (r.buf) return r.buf.toString("utf8");
  if (r.why === "missing") return null;
  throw new StatusLineError("settings_unreadable", "the settings file is not a regular file of yours, or cannot be read");
}

/** The layout of the file around the top-level object: newline style and the indent of its members. */
function layout(src: string, top: Top): { nl: string; indent: string | null } {
  const nl = src.includes("\r\n") ? "\r\n" : "\n";
  const first = top.members[top.members.length - 1];
  if (first === undefined) return { nl, indent: null };
  const lineStart = src.lastIndexOf("\n", first.keyStart) + 1;
  const lead = src.slice(lineStart, first.keyStart);
  return { nl, indent: /^[ \t]*$/.test(lead) && lineStart > top.open ? lead : null };
}

function verify(before: string, after: string, key: string, expect: (v: unknown) => boolean): void {
  let a: Record<string, unknown>, b: Record<string, unknown>;
  try {
    a = JSON.parse(before.replace(/^\ufeff/, "")) as Record<string, unknown>;
    b = JSON.parse(after.replace(/^\ufeff/, "")) as Record<string, unknown>;
  } catch {
    throw new StatusLineError("edit_failed", "the edited settings would not be valid JSON; nothing was changed");
  }
  const ka = Object.keys(a).filter((k) => k !== key), kb = Object.keys(b).filter((k) => k !== key);
  if (JSON.stringify(ka) !== JSON.stringify(kb) || ka.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))) {
    throw new StatusLineError("edit_failed", "the edit would change more than the status line; nothing was changed");
  }
  if (!expect(b[key])) throw new StatusLineError("edit_failed", "the edit did not produce the expected status line; nothing was changed");
}

function writeSettings(path: string, text: string): void {
  const mode = fileMode(path);
  writeAtomic(path, text);
  if (mode !== undefined) {
    try { chmodSync(path, mode); } catch { /* keep the stricter mode */ }
  }
}

// ───────────────────────────── install / uninstall ─────────────────────────────

export type InstallResult = { changed: boolean; wrapped: boolean };
export type UninstallResult = { restored: boolean; why: "restored" | "removed" | "not_ours" | "nothing" };

/**
 * Make `command` (an absolute path to the status-line script) the user's status line. Idempotent: if wasitme's line is
 * already there, nothing changes. A command already configured is kept, saved, and wrapped by the script.
 */
export function installStatusLine(f: StatusLineFiles, command: string): InstallResult {
  if (!isAbsolute(command)) throw new StatusLineError("script_missing", "the status-line script path must be absolute");
  const st = (() => { try { return lstatSync(command); } catch { return undefined; } })();
  if (st === undefined || !st.isFile() || (st.mode & 0o111) === 0) throw new StatusLineError("script_missing", "the status-line script is missing or not executable");
  const existing = readSettings(f.settings);
  if (existing === null && !existsSync(dirname(f.settings))) throw new StatusLineError("claude_folder_missing", "the Claude Code settings folder does not exist");
  const src = existing ?? "{}\n";
  const top = topOf(src);
  const ours = ourFragment(command);
  const cur = lastMember(top, "statusLine");
  if (cur !== undefined && isOurs(src.slice(cur.valueStart, cur.valueEnd), command)) return { changed: false, wrapped: existsSync(join(f.backups, "statusline.cmd")) };

  let next: string;
  let backup: Backup;
  let wrappedCommand: string | null = null;
  if (cur !== undefined) {
    const old = src.slice(cur.valueStart, cur.valueEnd);
    try {
      const v = JSON.parse(old) as { type?: unknown; command?: unknown };
      if (v !== null && typeof v === "object" && v.type === "command" && typeof v.command === "string" && v.command !== "") wrappedCommand = v.command;
    } catch { /* not JSON we can read: replaced as is, restored as is */ }
    next = src.slice(0, cur.valueStart) + ours + src.slice(cur.valueEnd);
    backup = { schema: BACKUP_SCHEMA, written: ours, replaced: old, inserted: null, wrapped: wrappedCommand !== null, created: false };
  } else {
    const { nl, indent } = layout(src, top);
    const last = top.members[top.members.length - 1];
    let inserted: string;
    let at: number;
    if (last === undefined) {
      // an empty object: {} → {<nl>  "statusLine": …<nl>}
      inserted = `${nl}  "statusLine": ${ours}${nl}`;
      at = top.open + 1;
    } else {
      at = last.valueEnd;
      inserted = indent !== null ? `,${nl}${indent}"statusLine": ${ours}` : `, "statusLine": ${ours}`;
    }
    next = src.slice(0, at) + inserted + src.slice(at);
    backup = { schema: BACKUP_SCHEMA, written: ours, replaced: null, inserted, wrapped: false, created: existing === null };
  }
  verify(src, next, "statusLine", (v) => isOurs(JSON.stringify(v), command));

  mkdirSync(f.backups, { recursive: true, mode: 0o700 });
  writeAtomic(join(f.backups, "statusline.json"), `${JSON.stringify(backup, null, 2)}\n`);
  if (wrappedCommand !== null) writeAtomic(join(f.backups, "statusline.cmd"), `${wrappedCommand}\n`);
  else removeQuietly(join(f.backups, "statusline.cmd"));
  writeSettings(f.settings, next);
  return { changed: true, wrapped: wrappedCommand !== null };
}

function readBackup(f: StatusLineFiles): Backup | null {
  const r = readOwnFile(join(f.backups, "statusline.json"), 1 << 20);
  if (!r.buf) return null;
  try {
    const v = JSON.parse(r.buf.toString("utf8")) as Partial<Backup>;
    if (v.schema === BACKUP_SCHEMA && typeof v.written === "string" && (v.replaced === null || typeof v.replaced === "string") && (v.inserted === null || typeof v.inserted === "string")) return { created: false, wrapped: false, ...v } as Backup;
  } catch { /* fall through */ }
  return null;
}

function dropBackups(f: StatusLineFiles): void {
  removeQuietly(join(f.backups, "statusline.json"));
  removeQuietly(join(f.backups, "statusline.cmd"));
}

/**
 * Take wasitme's status line out. If it is still wasitme's, put back exactly what was there (or remove exactly what was
 * added); if the user has changed it since, leave it alone. The backups are removed either way.
 */
export function uninstallStatusLine(f: StatusLineFiles, command: string): UninstallResult {
  const src = readSettings(f.settings);
  if (src === null) { dropBackups(f); return { restored: false, why: "nothing" }; }
  const top = topOf(src);
  const cur = lastMember(top, "statusLine");
  if (cur === undefined || !isOurs(src.slice(cur.valueStart, cur.valueEnd), command)) {
    dropBackups(f);
    return { restored: false, why: cur === undefined ? "nothing" : "not_ours" };
  }
  const b = readBackup(f);
  let next: string;
  let why: UninstallResult["why"];
  if (b !== null && b.replaced !== null) {
    next = src.slice(0, cur.valueStart) + b.replaced + src.slice(cur.valueEnd);
    why = "restored";
  } else if (b !== null && b.inserted !== null && src.includes(b.inserted)) {
    const at = src.lastIndexOf(b.inserted);
    next = src.slice(0, at) + src.slice(at + b.inserted.length);
    why = "removed";
  } else {
    // No usable backup (it was deleted): remove wasitme's member and its separator.
    const idx = top.members.indexOf(cur);
    if (idx > 0) {
      const prev = top.members[idx - 1]!;
      next = src.slice(0, prev.valueEnd) + src.slice(cur.valueEnd);
    } else if (top.members.length > 1) {
      const nextMember = top.members[idx + 1]!;
      next = src.slice(0, cur.keyStart) + src.slice(nextMember.keyStart);
    } else {
      next = src.slice(0, top.open + 1) + src.slice(top.close);
    }
    why = "removed";
  }
  verify(src, next, "statusLine", (v) => (why === "removed" ? v === undefined : true));
  if (b?.created === true && next.trim() === "{}") removeQuietly(f.settings);
  else writeSettings(f.settings, next);
  dropBackups(f);
  return { restored: true, why };
}

export type StatusLineState = "none" | "ours" | "other" | "unreadable";

/** Whose status line is configured. */
export function statusLineState(f: StatusLineFiles, command: string): StatusLineState {
  try {
    const src = readSettings(f.settings);
    if (src === null) return "none";
    const cur = lastMember(topOf(src), "statusLine");
    if (cur === undefined) return "none";
    return isOurs(src.slice(cur.valueStart, cur.valueEnd), command) ? "ours" : "other";
  } catch {
    return "unreadable";
  }
}
