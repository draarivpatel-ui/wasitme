/**
 * Names the engine prints: agents, indicators, change events, and the phrases the templates build from them.
 *
 * Label rule (SECURITY.md "Hostile input handling", "Hashes and labels"): nothing log-derived is echoed unless it
 * passes `cleanLabel()` (the reader allow-list: a short [A-Za-z0-9._-[]:+@ ] token) and is not a salted hash ("h:…"),
 * which is never shown as prose.
 * Model, version, effort and mode values reach copy only that way. Project names never reach copy at all: copy
 * speaks of "2 projects" (a count); a surface that must name one uses `projectLabel()` (an alias the user set, or
 * the hashed id).
 */
import type { MetricId } from "../analysis/metrics/defs.js";
import type { Tripwire } from "../analysis/attribution/types.js";
import { cleanLabel } from "../util.js";
import { fit, len } from "./format.js";

const HASH = /^h:[0-9a-f]{4,64}$/i;
const COUNT = /^\d{1,9}$/;

/** A log-derived value that may appear in prose, or null. Hashes, counts and present/absent flags are not prose. */
export function prose(v: unknown): string | null {
  const s = cleanLabel(v);
  if (s === undefined || HASH.test(s) || COUNT.test(s)) return null;
  if (["unknown", "other", "unset", "present", "absent", "on", "off", "<synthetic>"].includes(s.toLowerCase())) return null;
  return s;
}

/** A value for the snapshot's `from`/`to` fields: a clean label, a short hash or a count; otherwise "other". */
export function fieldValue(v: unknown): string {
  const s = cleanLabel(v);
  return s === undefined ? "other" : s;
}

const AGENT_NAMES: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex" };

/** "Claude Code", "Codex", or a clean form of a future agent id. */
export function agentName(agent: string): string {
  if (Object.hasOwn(AGENT_NAMES, agent)) return AGENT_NAMES[agent]!;
  const s = cleanLabel(agent);
  return s !== undefined && len(s) <= 24 ? s : "this agent";
}

/** The agent's global instruction file, for "CLAUDE.md changed". */
export function instructionsFile(agent: string): string {
  return agent === "codex" ? "AGENTS.md" : agent === "claude-code" ? "CLAUDE.md" : "Instructions file";
}

/** A project as a surface may name it: the user's alias when it is a clean label, else the hashed id. */
export function projectLabel(hashedId: string, aliases: Readonly<Record<string, string>> = {}): string {
  const alias = Object.hasOwn(aliases, hashedId) ? cleanLabel(aliases[hashedId]) : undefined;
  if (alias !== undefined) return alias;
  return cleanLabel(hashedId) ?? "project";
}

// ───────────────────────────── indicators ─────────────────────────────

export interface MetricWords {
  /** Ledger label (≤ 40). */
  label: string;
  /** Unit (≤ 24). */
  unit: string;
  /** Name inside a sentence (always a plural noun phrase: "tool errors have…"). The same name as the label, lower-cased
   *  (one name per indicator on every surface); only the tool-error constructs drop their qualifier in a sentence. */
  name: string;
}

const METRIC_WORDS: Readonly<Record<MetricId, MetricWords>> = {
  toolErrors: { label: "Tool errors", unit: "per 100 tool calls", name: "tool errors" },
  toolErrorsNonCmd: { label: "Tool errors (excl. commands)", unit: "per 100 tool calls", name: "tool errors" },
  cmdFailures: { label: "Command failures", unit: "per 100 commands", name: "command failures" },
  readsPerEdit: { label: "Reads per edit", unit: "reads per edit", name: "reads per edit" },
  blindEdits: { label: "Edits without reading first", unit: "per 100 edits", name: "edits without reading first" },
  interrupts: { label: "Interruptions", unit: "per 100 exchanges", name: "interruptions" },
  pushback: { label: "Pushback prompts", unit: "per 100 prompts", name: "pushback prompts" },
  churn: { label: "Files edited 3+ times", unit: "per 100 edit exchanges", name: "files edited 3+ times" },
  steps: { label: "Model responses", unit: "per exchange", name: "model responses" },
  outTokPerStep: { label: "Output tokens", unit: "per response", name: "output tokens" },
  cacheHit: { label: "Cache hits", unit: "per 100 input tokens", name: "cache hits" },
  apiRetries: { label: "API retries", unit: "per 100 exchanges", name: "API retries" },
  apiErrors: { label: "API failures", unit: "per 100 exchanges", name: "API failures" },
  compactions: { label: "Compactions", unit: "per 100 exchanges", name: "compactions" },
  thinkRedacted: { label: "Redacted thinking", unit: "per 100 thinking blocks", name: "redacted thinking blocks" },
  promptChars: { label: "Prompt length", unit: "characters per prompt", name: "prompt lengths" },
  durationMs: { label: "Exchange duration", unit: "ms per exchange", name: "exchange durations" },
};

export function metricWords(id: string): MetricWords {
  if (Object.hasOwn(METRIC_WORDS, id)) return METRIC_WORDS[id as MetricId];
  const s = cleanLabel(id);
  const label = s !== undefined && len(s) <= 40 ? s : "Indicator";
  return { label, unit: "", name: label.toLowerCase() };
}

/** What one counted unit of an indicator's gate is called, one / many ("31 of 40 edits"): its events, its denominator. */
const COUNT_NOUNS: Readonly<Record<string, { events: [string, string]; denominator: [string, string] }>> = {
  toolErrors: { events: ["tool error", "tool errors"], denominator: ["tool call", "tool calls"] },
  toolErrorsNonCmd: { events: ["tool error", "tool errors"], denominator: ["tool call", "tool calls"] },
  cmdFailures: { events: ["command failure", "command failures"], denominator: ["command", "commands"] },
  readsPerEdit: { events: ["read", "reads"], denominator: ["edit", "edits"] },
  blindEdits: { events: ["edit without reading first", "edits without reading first"], denominator: ["edit", "edits"] },
  interrupts: { events: ["interruption", "interruptions"], denominator: ["exchange", "exchanges"] },
  pushback: { events: ["pushback prompt", "pushback prompts"], denominator: ["prompt", "prompts"] },
};

export function countNoun(id: string, what: "events" | "denominator"): [string, string] {
  const n = Object.hasOwn(COUNT_NOUNS, id) ? COUNT_NOUNS[id] : undefined;
  return n?.[what] ?? (what === "events" ? ["event", "events"] : ["exchange", "exchanges"]);
}

// ───────────────────────────── change events ─────────────────────────────

/**
 * A change to a project's own files (project settings, project CLAUDE.md, the project's .mcp.json), seen by the
 * SessionStart hook's project snapshot — as opposed to the user's global setup. Its words keep that scope.
 */
export function projectScoped(e: { provenance?: string | null }): boolean {
  return e.provenance === "project_snapshot";
}

/** What a label builder needs from an event. */
export interface EventLike {
  kind: string;
  side: string;
  provenance?: string | null;
  from: string;
  to: string;
  tripwire?: Tripwire | null;
}

const COUNTED: Readonly<Record<string, [string, string]>> = {
  mcp: ["MCP server", "MCP servers"],
  skills: ["skill", "skills"],
  plugins: ["plugin", "plugins"],
  hooks: ["hook", "hooks"],
};

function arrow(name: string, from: string | null, to: string | null, fallback: string, limit: number): string {
  if (from !== null && to !== null) return fit(limit, `${name} ${from} → ${to}`, `${name} changed to ${to}`, fallback);
  if (to !== null) return fit(limit, `${name} changed to ${to}`, fallback);
  return fallback;
}

/** The timeline label of one event (≤ 60). Built from the kind and clean values only — never from notes or paths. */
export function eventLabel(e: EventLike, agent: string, limit = 60): string {
  const A = agentName(agent);
  const from = prose(e.from), to = prose(e.to);
  if (e.side === "meta") return "wasitme's own settings changed";
  const unrecorded = e.side === "unknown" && (e.provenance === "log_field" || e.provenance === undefined || e.provenance === null);
  const tag = (s: string) => (unrecorded ? fit(limit, `${s} (no command recorded)`, s) : s);
  switch (e.kind) {
    case "version":
      if (from !== null && to !== null) return fit(limit, `${A} ${from} → ${to}`, `${A} updated to ${to}`, `${A} updated`);
      return to !== null ? fit(limit, `${A} updated to ${to}`, `${A} updated`) : `${A} updated`;
    case "model":
      return tag(arrow("Model", from, to, "Model changed", limit - (unrecorded ? 23 : 0)));
    case "effort":
      return tag(arrow("Effort", from, to, "Effort changed", limit - (unrecorded ? 23 : 0)));
    case "mode":
      return tag(arrow("Permission mode", from, to, "Permission mode changed", limit - (unrecorded ? 23 : 0)));
    case "entrypoint":
      return tag(arrow("Entry point", from, to, "Entry point changed", limit - (unrecorded ? 23 : 0)));
    case "served-model":
      return "Served model differs from the one you picked";
    case "system-prompt":
      if (e.tripwire === "cache_miss") return fit(limit, `${A}'s tools or system prompt changed`, "Agent tools or system prompt changed");
      return fit(limit, `${A} system prompt changed`, "System prompt changed");
    case "instructions": {
      const file = projectScoped(e) ? `Project ${instructionsFile(agent)}` : instructionsFile(agent);
      if (e.from === "absent") return `${file} added`;
      if (e.to === "absent") return `${file} removed`;
      return `${file} changed`;
    }
    case "config":
      return projectScoped(e) ? "Project settings changed" : "Settings changed";
    default: {
      if (projectScoped(e) && e.kind === "mcp") {
        if (e.from === "absent") return "Project MCP servers added";
        if (e.to === "absent") return "Project MCP servers removed";
        return "Project MCP servers changed";
      }
      const nouns = Object.hasOwn(COUNTED, e.kind) ? COUNTED[e.kind]! : null;
      if (nouns === null) return "Setup changed";
      const a = COUNT.test(e.from) ? Number(e.from) : null, b = COUNT.test(e.to) ? Number(e.to) : null;
      if (a !== null && b !== null && a !== b) {
        const d = Math.abs(b - a);
        const what = d === 1 ? nouns[0] : `${d} ${nouns[1]}`;
        return `${what[0]!.toUpperCase()}${what.slice(1)} ${b > a ? "added" : "removed"}`;
      }
      return `${nouns[1][0]!.toUpperCase()}${nouns[1].slice(1)} changed`;
    }
  }
}

/** Short noun for a change on the user's side: "effort change", "CLAUDE.md edit", "MCP server change". */
export function youNoun(kind: string, agent: string): string {
  switch (kind) {
    case "effort": return "effort change";
    case "model": return "model change";
    case "mode": return "permission-mode change";
    case "entrypoint": return "entry-point change";
    case "instructions": return `${instructionsFile(agent)} edit`;
    case "mcp": return "MCP server change";
    case "skills": return "skills change";
    case "plugins": return "plugins change";
    case "hooks": return "hooks change";
    case "config": return "settings change";
    default: return "setup change";
  }
}

/** "your effort change", or with values "your effort change from high to medium"; a project file keeps its scope. */
export function youPhrase(e: { kind: string; from: string; to: string; provenance?: string | null }, agent: string, long: boolean): string {
  const base = `your ${projectScoped(e) ? "project " : ""}${youNoun(e.kind, agent)}`;
  if (!long || !["effort", "model", "mode", "entrypoint"].includes(e.kind)) return base;
  const from = prose(e.from), to = prose(e.to);
  return from !== null && to !== null ? `${base} from ${from} to ${to}` : base;
}

/** How to undo a change on the user's side, for the "To check, …" line. */
export function undoPhrase(e: { kind: string; from: string; provenance?: string | null }, agent: string): string {
  const from = prose(e.from);
  if (from !== null) {
    if (e.kind === "effort") return `set effort back to ${from}`;
    if (e.kind === "model") return `switch the model back to ${from}`;
    if (e.kind === "mode") return `set the permission mode back to ${from}`;
    if (e.kind === "entrypoint") return `switch back to ${from}`;
  }
  return `undo your ${projectScoped(e) ? "project " : ""}${youNoun(e.kind, agent)}`;
}

/** Phrases for an agent-side change that decides (an admitted tripwire). */
export interface AgentPhrases {
  /** "Claude Code began serving a different model than you picked" */
  long: string;
  /** "Claude Code served another model" */
  short: string;
  /** "Claude Code served a different model than you picked" (the band) */
  band: string;
  /** "Claude Code's model switch" */
  possessive: string;
}

export function agentPhrases(tripwire: Tripwire | null, agent: string): AgentPhrases {
  const A = agentName(agent);
  switch (tripwire) {
    case "served_model":
      return {
        long: `${A} began serving a different model than you picked`,
        short: `${A} served another model`,
        band: `${A} served a different model than you picked`,
        possessive: `${A}'s model switch`,
      };
    case "vendor_template":
      return {
        long: `${A}'s built-in system prompt changed between updates`,
        short: `${A}'s system prompt changed`,
        band: `${A}'s built-in system prompt changed`,
        possessive: `${A}'s system-prompt change`,
      };
    case "cache_miss":
      return {
        long: `${A} changed its own tools or system prompt`,
        short: `${A} changed its tools`,
        band: `${A} changed its own tools or system prompt`,
        possessive: `${A}'s tools change`,
      };
    default:
      return { long: `${A} changed on its side`, short: `${A} changed on its side`, band: `${A} changed on its side`, possessive: `${A}'s change` };
  }
}

/** What the logs could not attribute: "the model", "effort", "the permission mode", … */
export function unknownNoun(kind: string, agent: string): string {
  switch (kind) {
    case "model": case "served-model": return "the model";
    case "effort": return "effort";
    case "mode": return "the permission mode";
    case "entrypoint": return "the entry point";
    case "version": return "the version";
    case "instructions": return instructionsFile(agent);
    case "mcp": return "the MCP servers";
    case "skills": return "the skills";
    case "plugins": return "the plugins";
    case "hooks": return "the hooks";
    case "system-prompt": return "the system prompt";
    case "config": return "the settings";
    default: return "the setup";
  }
}

/** The dimension a strata rule-out held fixed, for "the shift also shows at your old effort". */
export function heldNoun(kind: string): string {
  switch (kind) {
    case "effort": return "effort";
    case "model": return "model";
    case "mode": return "permission mode";
    case "entrypoint": return "entry point";
    default: return "setting";
  }
}
