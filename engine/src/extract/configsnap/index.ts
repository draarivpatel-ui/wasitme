import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentId, ConfigSnapshot } from "../../types.js";
import { collectClaude } from "./claude.js";
import { collectCodex } from "./codex.js";
import { defaultAvoidDirs } from "./paths.js";
import { makeGuard } from "./safefs.js";
import type { CollectOptions, CollectResult, Ctx } from "./types.js";

/**
 * Config snapshot collector: a point-in-time fingerprint of the user's GLOBAL Claude Code / Codex
 * configuration, reduced to counts, allow-listed labels and salted hashes. See claude.ts / codex.ts
 * for the item keys, diff.ts for how two snapshots become ChangeEvents.
 *
 * Guarantees: read-only; nothing scanned is ever executed; project folders are never read;
 * no file content, path, command, argument, env value or rule text appears in any output; every file
 * read is bounded; privacy-protected folders (macOS ~/Documents etc.) are never touched, even via symlink.
 */
export type { CollectOptions, CollectResult, Diagnostic, FileState, SourceId } from "./types.js";
export { diffSnapshots, mergeSnapshots } from "./diff.js";
export type { DiffOptions } from "./diff.js";
export { defaultAvoidDirs, resolveClaudePaths, resolveCodexDir } from "./paths.js";

const DEFAULT_CAP = 1 << 20; // 1 MiB
const DEFAULT_CLAUDE_JSON_CAP = 16 << 20; // 16 MiB

const MAX_CAP = 64 << 20; // no caller-supplied cap may turn a hostile file into a huge allocation

function positive(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_CAP) : fallback;
}

/** Snapshot one agent. `found` is false (and items empty) when its config directory does not exist. */
export function collectConfig(agent: AgentId, opts: CollectOptions): CollectResult {
  const home = resolve(opts.home ?? homedir());
  const ctx: Ctx = {
    hash: opts.hash,
    home,
    env: opts.env ?? process.env,
    guard: makeGuard(opts.avoid ?? defaultAvoidDirs(home)),
    capBytes: positive(opts.capBytes, DEFAULT_CAP),
    claudeJsonCapBytes: positive(opts.claudeJsonCapBytes, DEFAULT_CLAUDE_JSON_CAP),
  };
  const r = agent === "claude-code" ? collectClaude(ctx) : collectCodex(ctx);
  const snapshot: ConfigSnapshot = { t: (opts.now ?? new Date()).toISOString(), agent, items: r.found ? r.items : {} };
  return { snapshot, found: r.found, diagnostics: r.diagnostics };
}

/** Snapshots for every agent whose config directory exists. */
export function collectConfigSnapshots(opts: CollectOptions): ConfigSnapshot[] {
  const out: ConfigSnapshot[] = [];
  for (const agent of ["claude-code", "codex"] as const) {
    const r = collectConfig(agent, opts);
    if (r.found) out.push(r.snapshot);
  }
  return out;
}
