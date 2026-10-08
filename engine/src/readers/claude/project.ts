/**
 * The main session transcripts of one project folder (<root>/projects/<encoded-cwd>/*.jsonl),
 * in creation order. Stat only, no file reads.
 */
import { statSync } from "node:fs";
import type { FileStamp } from "../../types.js";
import { bornMs, entries } from "../fs.js";

export interface MainFile { name: string; stamp: FileStamp; born: number }

export const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Creation order: birth time where the filesystem records it, else mtime; the mtime too for a copy (fs.ts bornMs); ties by name. */
export function creationOrder<T extends { name: string; born: number }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => a.born - b.born || byName(a, b));
}

/** Stat a regular file (symlinks followed) with its creation time. */
export function statFile(path: string): { stamp: FileStamp; born: number } | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    const mtimeMs = Math.round(st.mtimeMs);
    return { stamp: { path, mtimeMs, size: st.size }, born: bornMs(st) };
  } catch {
    return undefined;
  }
}

/** Claude Code's project folder name for a working directory: every character outside [A-Za-z0-9] becomes "-". */
export function folderFor(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The project folder a moved session started in (D62b), or undefined to keep `current`. EnterWorktree / ExitWorktree
 * move the whole transcript (same session id) into the new working directory's folder and append a `relocated` record,
 * so the file's first record carries the working directory the session started in (`first`). That is turned into a
 * folder name only when the same encoding reproduces the folder the file is in now from a later working directory
 * (`checks`: the latest record's, the relocation target's) — otherwise (a long path Claude Code shortened, an encoding
 * this version doesn't know) the folder it is in is kept, as before D62. Working directories stay in memory.
 */
export function originalFolder(current: string, first: string | undefined, checks: readonly (string | undefined)[]): string | undefined {
  if (!first) return undefined;
  if (!checks.some((c) => c !== undefined && c !== "" && folderFor(c) === current)) return undefined;
  const origin = folderFor(first);
  return origin !== current ? origin : undefined;
}

/** Session transcripts directly inside `projectDir`, oldest first. */
export function projectMains(projectDir: string): MainFile[] {
  const mains: MainFile[] = [];
  for (const f of entries(projectDir)) {
    if (!f.isFile || !f.name.endsWith(".jsonl")) continue;
    const st = statFile(f.path);
    if (st) mains.push({ name: f.name, ...st });
  }
  return creationOrder(mains);
}
