/**
 * Writing a generated corpus to disk, safely and deterministically.
 *
 * Safety: refuses roots, and anything inside a real agent directory (a `.claude` or `.codex` folder at any
 * depth, after resolving symlinks, so a typo like --out ~/.codex/sessions/x or a link into one is caught),
 * refuses any non-empty directory that this generator did not create (marker file), and only ever removes
 * entries it listed in its own marker when asked to --replace. It never reads the machine's real agent
 * logs and never needs to.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { OutFile } from "./emit.js";

export interface OutLink {
  /** Path of the link, relative to the output root. */
  path: string;
  /** Link target as stored (relative targets keep the corpus relocatable). */
  target: string;
  type: "dir" | "file";
}

export const MARKER = ".wasitme-synth";
const MARKER_MTIME_MS = Date.UTC(2026, 0, 1);

const AGENT_DIR_NAMES = new Set([".claude", ".codex"]);

/** Whether a link or file exists at `p` itself (a dangling symlink counts; existsSync would say no). */
function somethingAt(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/**
 * `abs` with every symlink in its existing part resolved (to the on-disk spelling) and the part that does
 * not exist yet kept as written. A link that exists but cannot be followed (dangling, a loop) is refused:
 * creating directories through it would land somewhere nobody looked at.
 */
function resolveThroughSymlinks(abs: string): string {
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest);
    } catch {
      if (somethingAt(cur)) throw new Error(`refusing to write into ${abs}: ${cur} is a symlink that cannot be resolved`);
      const up = dirname(cur);
      if (up === cur) return join(cur, ...rest);
      rest.unshift(basename(cur));
      cur = up;
    }
  }
}

/**
 * The first path part that makes `parts` a real agent directory. Names are compared case-insensitively
 * (macOS volumes usually are). The one exception: `.claude/worktrees/<name>` is where Claude Code keeps
 * git checkouts of a project, not session logs, so a repository worktree may hold generated fixtures.
 */
function agentDirPart(parts: string[]): string | undefined {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!AGENT_DIR_NAMES.has(part.toLowerCase())) continue;
    if (part === ".claude" && parts[i + 1] === "worktrees" && parts.length > i + 2) {
      i++;
      continue;
    }
    return part;
  }
  return undefined;
}

export function assertSafeOut(out: string): string {
  const abs = resolve(out);
  const parts = abs.split(sep).filter(Boolean);
  if (parts.length < 2) throw new Error(`refusing to write into ${abs}: too close to the filesystem root`);
  const real = resolveThroughSymlinks(abs);
  const bad = agentDirPart(parts) ?? agentDirPart(real.split(sep).filter(Boolean));
  if (bad !== undefined) {
    const via = real === abs ? "" : ` (resolves to ${real})`;
    throw new Error(`refusing to write into ${abs}${via}: it is inside "${bad}", a real agent directory`);
  }
  return abs;
}

function isEmptyDir(dir: string): boolean {
  try { return readdirSync(dir).length === 0; } catch { return true; }
}

export function writeTree(out: string, files: OutFile[], links: OutLink[] = [], opts: { replace?: boolean } = {}): void {
  const root = assertSafeOut(out);
  if (existsSync(root)) {
    const st = lstatSync(root);
    if (!st.isDirectory()) throw new Error(`${root} exists and is not a directory`);
    if (!isEmptyDir(root)) {
      const marker = join(root, MARKER);
      if (!existsSync(marker)) throw new Error(`${root} is not empty and was not created by this generator; choose an empty or new directory`);
      if (!opts.replace) throw new Error(`${root} already holds generated output; pass --replace to regenerate it`);
      const listed = JSON.parse(readFileSync(marker, "utf8")) as { entries?: string[] };
      const owned = new Set((listed.entries ?? []).filter((e) => !e.includes("..") && !e.includes("/")));
      // Check first, delete second: a directory with anything we did not create is left exactly as it was.
      const foreign = readdirSync(root).filter((e) => e !== MARKER && !owned.has(e));
      if (foreign.length) throw new Error(`${root} still has files this generator did not create (${foreign.join(", ")}); remove them first`);
      for (const entry of owned) rmSync(join(root, entry), { recursive: true, force: true });
      rmSync(marker, { force: true });
    }
  }
  mkdirSync(root, { recursive: true });
  const top = new Set<string>();
  for (const f of files) top.add(f.path.split("/")[0]!);
  for (const l of links) top.add(l.path.split("/")[0]!);
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    const p = join(root, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.data);
    if (f.mtimeMs !== undefined && Number.isFinite(f.mtimeMs)) utimesSync(p, f.mtimeMs / 1000, f.mtimeMs / 1000);
  }
  for (const l of links) {
    const p = join(root, l.path);
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(l.target, p, l.type);
  }
  const marker = join(root, MARKER);
  writeFileSync(marker, JSON.stringify({ generator: "wasitme-synth", entries: [...top].sort() }, null, 2) + "\n");
  utimesSync(marker, MARKER_MTIME_MS / 1000, MARKER_MTIME_MS / 1000); // a fixed stamp, so whole trees compare equal
}

/** SHA-256 over every file's path, mtime and bytes (sorted by path) plus links: the determinism fingerprint. */
export function digestFiles(files: OutFile[], links: OutLink[] = []): { files: number; bytes: number; sha256: string } {
  const h = createHash("sha256");
  let bytes = 0;
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    const data = typeof f.data === "string" ? Buffer.from(f.data) : f.data;
    h.update(`${f.path}\0${f.mtimeMs ?? ""}\0${data.length}\0`);
    h.update(data);
    bytes += data.length;
  }
  for (const l of [...links].sort((a, b) => (a.path < b.path ? -1 : 1))) h.update(`link\0${l.path}\0${l.target}\0${l.type}\0`);
  return { files: files.length, bytes, sha256: h.digest("hex") };
}
