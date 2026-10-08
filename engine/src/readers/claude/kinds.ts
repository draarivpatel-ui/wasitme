import type { ParseStats } from "../../types.js";
import { bump, typeKey } from "../../util.js";

/** Record types this reader understands (handled or deliberately ignored). Anything else is format drift. */
export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  // handled
  "user", "assistant", "system", "attachment", "queue-operation", "permission-mode", "relocated",
  // carry nothing measured
  "summary", "agent-name", "agent-setting", "ai-title", "atis-latch", "bridge-session", "cost-state",
  "custom-title", "file-history-delta", "file-history-snapshot", "frame-link", "last-prompt", "mode",
  "pr-link", "started", "tag", "worktree-state",
]);

/** Prefixes of record-type families that carry nothing measured. */
const KNOWN_PREFIXES = ["artifact-"];

export function isKnownType(type: string | undefined): boolean {
  if (type === undefined) return false;
  return KNOWN_TYPES.has(type) || KNOWN_PREFIXES.some((p) => type.startsWith(p));
}

/**
 * Count an unrecognised record type. Type names come from the log, so only an identifier-shaped name is kept as the
 * key (util.ts typeKey: no spaces, no `@`, no paths); anything else is counted as "other".
 */
export function countUnknown(stats: ParseStats, type: string | undefined): void {
  const key = type === undefined ? "untyped" : typeKey(type, "other");
  bump(stats.unknownTypes, key);
}
