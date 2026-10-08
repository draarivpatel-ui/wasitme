import { isAbsolute, join, normalize, resolve } from "node:path";
import type { Env } from "./types.js";

/** First non-empty environment variable among `names`, with the name that supplied it. */
function pick(env: Env, names: readonly string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const v = env[name];
    if (typeof v === "string" && v.trim()) return { name, value: v.trim() };
  }
  return undefined;
}

/** `~`, `~/x`, absolute and relative overrides. Relative paths resolve against home, never the cwd (cwd may be a project folder). */
function expand(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return isAbsolute(value) ? normalize(value) : resolve(home, value);
}

export interface ClaudePaths {
  /** Claude Code config directory (CLAUDE.md, settings.json, skills/, plugins/). */
  dir: string;
  /**
   * Where Claude Code's global state file (the one holding top-level `mcpServers`) may live, in the
   * order to try. The first candidate that exists wins, as in Claude Code: even if it is unreadable
   * or malformed, a later candidate is NOT consulted (that would be a different, stale file).
   */
  jsonCandidates: string[];
}

/**
 * Filename suffix Claude Code puts on its global state file. VERIFIED against the Claude Code 2.1.289
 * binary (kV): `-custom-oauth` whenever CLAUDE_CODE_CUSTOM_OAUTH_URL is set (any non-empty value, no
 * trimming), otherwise none. The same function also knows `-local-oauth` / `-staging-oauth`, but in
 * that build the selector it switches on is the constant "prod", so they cannot occur.
 */
function stateFileName(env: Env): string {
  const custom = env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
  return typeof custom === "string" && custom !== "" ? ".claude-custom-oauth.json" : ".claude.json";
}

/**
 * WASITME_CLAUDE_DIR > CLAUDE_CONFIG_DIR > ~/.claude (same order as the log reader).
 *
 * Global state file placement — VERIFIED against the Claude Code 2.1.289 binary (functions To/Dlr/we):
 *   1. `<config dir>/.config.json` if it exists (legacy name; the config dir is CLAUDE_CONFIG_DIR, else ~/.claude);
 *   2. else `<CLAUDE_CONFIG_DIR, else the home directory>/.claude[-custom-oauth].json`.
 * So with CLAUDE_CONFIG_DIR set the file lives inside that directory (profiles do not share one) and
 * with nothing set it is ~/.claude.json. With WASITME_CLAUDE_DIR (wasitme's own override, e.g. a
 * copied/fixture tree) the directory is tried first, then ~/.claude.json, which is where a copied
 * default-layout config keeps it.
 *
 * Not followed: a variable that Claude Code only gets from the `env` block of settings.json (say
 * CLAUDE_CODE_CUSTOM_OAUTH_URL set there); a background process cannot see it. That is the one way
 * this can still look at the wrong file, and it then reports the usual `missing`/stale result.
 */
export function resolveClaudePaths(env: Env, home: string): ClaudePaths {
  const file = stateFileName(env);
  const o = pick(env, ["WASITME_CLAUDE_DIR", "CLAUDE_CONFIG_DIR"]);
  if (!o) {
    const dir = join(home, ".claude");
    return { dir, jsonCandidates: [join(dir, ".config.json"), join(home, file)] };
  }
  const dir = expand(o.value, home);
  const legacy = join(dir, ".config.json");
  const inside = join(dir, file);
  return {
    dir,
    jsonCandidates: o.name === "CLAUDE_CONFIG_DIR" ? [legacy, inside] : [legacy, inside, join(home, file)],
  };
}

/** WASITME_CODEX_DIR > CODEX_HOME > ~/.codex. */
export function resolveCodexDir(env: Env, home: string): string {
  const o = pick(env, ["WASITME_CODEX_DIR", "CODEX_HOME"]);
  return o ? expand(o.value, home) : join(home, ".codex");
}

/**
 * Folders a background process must not touch: on macOS, reading them can pop a privacy (TCC) prompt
 * on the user's screen. Empty elsewhere.
 */
export function defaultAvoidDirs(home: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin") return [];
  return [
    "Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures",
    join("Library", "Mobile Documents"), join("Library", "CloudStorage"),
  ].map((d) => join(home, d));
}
