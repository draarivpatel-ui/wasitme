import type { AgentId, ConfigSnapshot, HashFn } from "../../types.js";

export type Items = ConfigSnapshot["items"];

/** Fixed vocabulary of things the collector reads. Never a path. */
export type SourceId =
  | "config-dir"
  | "instructions"
  | "settings"
  | "claude-json"
  | "installed-plugins"
  | "config-toml"
  | "skills";

/**
 * What happened when a source was read:
 *  ok          read and understood
 *  missing     does not exist (definitive: the setting is simply absent)
 *  unreadable  exists but could not be read (permissions, symlink loop, I/O error) → state unknown
 *  protected   would have touched a privacy-protected folder (e.g. ~/Documents) → never read, state unknown
 *  not-file    exists but is not a regular file (directory, FIFO, socket …) → state unknown
 *  capped      larger than the read cap: instructions use the capped prefix; structured files are unknown
 *  malformed   not valid JSON/TOML (or wrong top-level shape) → state unknown
 *  partial     directory listing is incomplete (entry limit hit, or symlinked entries inside a protected folder)
 */
export type FileState = "ok" | "missing" | "unreadable" | "protected" | "not-file" | "capped" | "malformed" | "partial";

export interface Diagnostic {
  agent: AgentId;
  source: SourceId;
  state: FileState;
}

export interface CollectResult {
  snapshot: ConfigSnapshot;
  /** False when the agent's config directory does not exist (or could not be inspected): nothing to snapshot. */
  found: boolean;
  diagnostics: Diagnostic[];
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface CollectOptions {
  /** Salted id factory (makeHash(salt)). Required: every hash in a snapshot is salted. */
  hash: HashFn;
  /** Snapshot timestamp (default: now). */
  now?: Date;
  /** Home directory override (tests). Default: os.homedir(). */
  home?: string;
  /** Environment override (tests). Default: process.env. */
  env?: Env;
  /**
   * Directories that must never be touched, not even to stat — used to keep a background process
   * out of macOS privacy-protected folders. A symlink that resolves into one of them is reported as
   * `protected` instead of being followed. Default: defaultAvoidDirs(home) (macOS only).
   * Pass [] to disable.
   */
  avoid?: readonly string[];
  /** Read cap for CLAUDE.md / AGENTS.md / settings.json / config.toml / installed_plugins.json. Default 1 MiB. */
  capBytes?: number;
  /**
   * Read cap for ~/.claude.json. That file embeds per-project history and is routinely larger than
   * 1 MiB, so it gets its own, larger bound (default 16 MiB). Only the top-level `mcpServers` value is kept.
   */
  claudeJsonCapBytes?: number;
}

/** Lower-cased absolute directory roots that must never be touched (see CollectOptions.avoid). */
export type Guard = readonly string[];

export interface Ctx {
  hash: HashFn;
  home: string;
  env: Env;
  guard: Guard;
  capBytes: number;
  claudeJsonCapBytes: number;
}
