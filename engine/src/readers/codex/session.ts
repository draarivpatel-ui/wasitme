/**
 * What a rollout's own `session_meta` says about the session: its entrypoint label, who drives it, and whether it
 * votes (METHOD.md §2 "Only interactive sessions vote"). Used by the full parse (rollout.ts) and by the thread index's
 * leading-line read (threads.ts), so both sides classify a file the same way.
 *
 * Classifier (session level, first match wins), from these fields and nothing else:
 *  1. another agent drives it (`parent_thread_id`, `agent_role`, an object or "subagent" `source`, an automated
 *     `thread_source`) → `scripted`;
 *  2. `source` ∈ {exec, mcp} → `scripted`, unless the originator is a known interactive client (contradiction →
 *     `unknown`);
 *  3. `source` ∈ {cli, vscode} → `interactive`, unless the originator is a known scripted client (contradiction →
 *     `unknown`);
 *  4. no usable `source`: a known interactive / scripted originator decides, else `unknown`.
 * `originator` is read in memory only; it never becomes a label (D39: the entrypoint comes from `source` alone).
 */
import type { InteractiveClass } from "../../types.js";
import { obj } from "../../util.js";
import {
  AUTOMATED_THREAD_SOURCES, ENTRYPOINTS, INTERACTIVE_ORIGINATORS, INTERACTIVE_SOURCES, SCRIPTED_ORIGINATORS, SCRIPTED_SOURCES,
} from "./known.js";

/** `session_meta.source` → the fixed entrypoint enum. Never the originator (an open, client-supplied string). */
export function entrypointOf(source: unknown): string {
  if (source === undefined || source === null || source === "") return "unknown";
  if (typeof source === "string") {
    const s = source.toLowerCase();
    return ENTRYPOINTS.has(s) ? s : "other";
  }
  const o = obj(source);
  return o && Object.hasOwn(o, "subagent") ? "subagent" : "other";
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.length > 0;

/**
 * `session_meta.model_provider` (raw, memory only: callers store it as a salted short hash, D51). A provider
 * id can name a private gateway or proxy, so it is never a label.
 */
export function providerOf(p: Record<string, unknown>): string | undefined {
  const v = p.model_provider;
  return typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined;
}

export interface SessionFlags {
  /** `Exchange.entrypoint`: the fixed enum of `session_meta.source`. */
  entrypoint: string;
  /** Driven by another agent (subagent, agent-created, guardian): never human prompts. */
  automated: boolean;
  /**
   * `codex exec` (by source or by originator): a real prompt, but the script's settings, so no change events.
   * Kept as before WP-11Δ; voting is decided by `interactiveClass`.
   */
  scripted: boolean;
  /** Whether the session votes (METHOD.md §2). */
  interactiveClass: InteractiveClass;
}

/** Classify a session from its own `session_meta` payload. */
export function sessionFlags(p: Record<string, unknown>): SessionFlags {
  const source = p.source;
  const entrypoint = entrypointOf(source);
  const threadSource = typeof p.thread_source === "string" ? p.thread_source : "";
  const automated = nonEmpty(p.parent_thread_id) || Boolean(obj(source)) || entrypoint === "subagent"
    || AUTOMATED_THREAD_SOURCES.has(threadSource) || nonEmpty(p.agent_role);
  const originator = typeof p.originator === "string" ? p.originator : "";
  const scripted = entrypoint === "exec" || originator === "codex_exec";
  return { entrypoint, automated, scripted, interactiveClass: classOf(automated, entrypoint, originator) };
}

function classOf(automated: boolean, entrypoint: string, originator: string): InteractiveClass {
  if (automated) return "scripted";
  const saysInteractive = INTERACTIVE_ORIGINATORS.has(originator);
  const saysScripted = SCRIPTED_ORIGINATORS.has(originator);
  if (SCRIPTED_SOURCES.has(entrypoint)) return saysInteractive ? "unknown" : "scripted";
  if (INTERACTIVE_SOURCES.has(entrypoint)) return saysScripted ? "unknown" : "interactive";
  if (saysInteractive) return "interactive";
  if (saysScripted) return "scripted";
  return "unknown";
}
