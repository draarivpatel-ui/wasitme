/**
 * Read-time filters (METHOD.md §2, Exclusions): the exclude list and the `--until` cutoff. Both apply to the merged
 * exchanges after the cache, never at parse time, so changing either never re-parses anything and history keeps
 * every exchange.
 *
 * `~/.wasitme/state/exclude.json` (local only, never committed):
 *   {
 *     "dates":       [{ "from": "2026-09-01", "to": "2026-09-03" }],   inclusive local days
 *     "projects":    ["p-0123456789ab"],                              Exchange.project ids (salted HMACs)
 *     "entrypoints": ["sdk-cli", "sdk-*", "exec"]                      Exchange.entrypoint labels; a trailing * is a prefix
 *   }
 * Unknown keys are ignored. A file that exists but cannot be read or parsed excludes NOTHING and is reported
 * (`ExcludeList.error`), so a typo never silently hides data — and never silently drops an intended exclusion either:
 * the CLI prints the error kind.
 * Change events are not filtered by the exclude list (they are facts about the setup, not workload); `--until`
 * applies to both.
 */
import { createHash } from "node:crypto";
import type { ChangeEvent, Exchange, HashFn } from "../types.js";
import { readOwnFile } from "./atomic.js";

export interface ExcludeList {
  dates: { from: string; to: string }[];
  projects: Set<string>;
  entrypoints: string[];
  error: "unreadable" | "malformed" | null;
  /** Digest of the effective list (part of the analysis inputs). */
  digest: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROJECT_RE = /^p-[0-9a-f]{12}$/;
const ENTRY_RE = /^[A-Za-z0-9._:-]{1,40}\*?$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function digestOf(dates: ExcludeList["dates"], projects: Set<string>, entrypoints: string[]): string {
  return createHash("sha256").update(JSON.stringify({ dates, projects: [...projects].sort(), entrypoints })).digest("hex").slice(0, 32);
}

export function noExclusions(error: ExcludeList["error"] = null): ExcludeList {
  return { dates: [], projects: new Set(), entrypoints: [], error, digest: digestOf([], new Set(), []) };
}

export function parseExclude(v: unknown): ExcludeList {
  if (!isObj(v)) return noExclusions("malformed");
  const dates: ExcludeList["dates"] = [];
  if (Array.isArray(v.dates)) {
    for (const d of v.dates) {
      if (isObj(d) && typeof d.from === "string" && typeof d.to === "string" && DAY_RE.test(d.from) && DAY_RE.test(d.to)) {
        dates.push(d.from <= d.to ? { from: d.from, to: d.to } : { from: d.to, to: d.from });
      } else return noExclusions("malformed");
    }
  }
  const projects = new Set<string>();
  if (Array.isArray(v.projects)) {
    for (const p of v.projects) {
      if (typeof p === "string" && PROJECT_RE.test(p)) projects.add(p);
      else return noExclusions("malformed");
    }
  }
  const entrypoints: string[] = [];
  if (Array.isArray(v.entrypoints)) {
    for (const e of v.entrypoints) {
      if (typeof e === "string" && ENTRY_RE.test(e)) entrypoints.push(e);
      else return noExclusions("malformed");
    }
  }
  dates.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1));
  entrypoints.sort();
  return { dates, projects, entrypoints, error: null, digest: digestOf(dates, projects, entrypoints) };
}

export function loadExclude(path: string): ExcludeList {
  const r = readOwnFile(path, 1 << 20);
  if (!r.buf) return r.why === "missing" ? noExclusions() : noExclusions("unreadable");
  try {
    return parseExclude(JSON.parse(r.buf.toString("utf8")) as unknown);
  } catch {
    return noExclusions("malformed");
  }
}

function entryMatches(pattern: string, value: string): boolean {
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

export function isExcluded(x: Exchange, ex: ExcludeList): boolean {
  if (ex.projects.has(x.project)) return true;
  for (const d of ex.dates) if (x.day >= d.from && x.day <= d.to) return true;
  for (const p of ex.entrypoints) if (entryMatches(p, x.entrypoint)) return true;
  return false;
}

/** Keep exchanges at or before the cutoff and not excluded. */
export function filterExchanges(xs: readonly Exchange[], ex: ExcludeList, until: Date | undefined): { kept: Exchange[]; excluded: number; afterCutoff: number } {
  const cut = until?.getTime();
  const kept: Exchange[] = [];
  let excluded = 0, afterCutoff = 0;
  for (const x of xs) {
    if (cut !== undefined && !(Date.parse(x.t) <= cut)) { afterCutoff++; continue; }
    if (isExcluded(x, ex)) { excluded++; continue; }
    kept.push(x);
  }
  return { kept, excluded, afterCutoff };
}

export function filterEvents(es: readonly ChangeEvent[], until: Date | undefined): ChangeEvent[] {
  const cut = until?.getTime();
  return cut === undefined ? [...es] : es.filter((e) => Date.parse(e.t) <= cut);
}

/**
 * The project ids a cwd can have in Exchange.project, for `wasitme exclude <dir>` (WP-30) and the SessionStart hook:
 * Claude hashes its encoded project folder name (both encodings seen: `/` and `.` → `-`, and every
 * non-alphanumeric → `-`), Codex hashes the cwd itself.
 */
export function projectKeysForCwd(hash: HashFn, cwd: string): string[] {
  const out = new Set<string>([
    hash(cwd.replace(/[/.]/g, "-"), "p-"),
    hash(cwd.replace(/[^A-Za-z0-9]/g, "-"), "p-"),
    hash(cwd, "p-"),
  ]);
  return [...out];
}
