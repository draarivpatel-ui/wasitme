/**
 * Global config snapshots over time (METHOD.md §9: changes found in snapshots of the configuration, from the day of
 * install; PRIVACY.md "What is read"). Each scan runs the config collector (configsnap: counts, allow-listed labels
 * and salted hashes only; it never opens auth.json or .credentials.json, never executes anything, and never touches
 * macOS-protected folders), compares the result with the last known state, and stores the change events between them
 * in `history/config.json`.
 *
 *  - Written on change only: when nothing moved, the stored snapshot (and its time) stay as they were, so a second
 *    scan is byte-identical; the set of days on which a snapshot was taken grows once per day (it feeds "fully
 *    observed", D63).
 *  - A torn or unreadable source is "unknown": the collector leaves that source's keys out, the diff compares only
 *    keys known to both sides (no event), and the last known state of that source is kept (mergeSnapshots).
 *  - Side and strength (METHOD.md §9 table): every snapshot change is side `you`, provenance `settings_snapshot`. Strong:
 *    instructions, model, effort, MCP, skills, plugins and hooks sets, the Codex model provider, the permission mode
 *    / approval policy. Weak: everything else (other settings keys, permission-rule tweaks, env counts, status line).
 *    Meta (wasitme's own writes): a plugin-set change that only adds or removes wasitme's own plugins.
 *  - The first snapshot is a baseline: no events (anything before it is "before snapshots existed").
 */
import { collectConfig, diffSnapshots, mergeSnapshots } from "../extract/configsnap/index.js";
import { shortHash } from "../extract/configsnap/labels.js";
import type { AgentId, ChangeEvent, ConfigSnapshot, HashFn } from "../types.js";
import { localDay } from "../util.js";
import { readOwnJson, writeIfChanged } from "./atomic.js";

export const CONFIG_SCHEMA = "wasitme.config/1";
const MAX_DAYS = 400;
const MAX_EVENTS = 2000;

/** Plugin ids wasitme installs for itself (the `meta` key-path allow-list, METHOD.md §9). */
export const OWN_PLUGINS = ["wasitme@wasitme", "wasitme@wasitme-codex"] as const;

export interface AgentConfigHistory {
  last: ConfigSnapshot | null;
  /** Local days (scan zone) on which a snapshot was taken, ascending, bounded. */
  days: string[];
  events: ChangeEvent[];
}

export interface ConfigHistory {
  schema: typeof CONFIG_SCHEMA;
  agents: Partial<Record<AgentId, AgentConfigHistory>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function loadConfigHistory(path: string): ConfigHistory {
  const v = readOwnJson(path, 32 << 20);
  const out: ConfigHistory = { schema: CONFIG_SCHEMA, agents: {} };
  if (!isObj(v) || v.schema !== CONFIG_SCHEMA || !isObj(v.agents)) return out;
  for (const agent of ["claude-code", "codex"] as const) {
    const a = v.agents[agent];
    if (!isObj(a)) continue;
    const last = isObj(a.last) && a.last.agent === agent && typeof a.last.t === "string" && isObj(a.last.items) ? (a.last as unknown as ConfigSnapshot) : null;
    const days = Array.isArray(a.days) ? a.days.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
    const events = Array.isArray(a.events) ? a.events.filter((e): e is ChangeEvent => isObj(e) && typeof e.id === "string" && typeof e.t === "string") : [];
    out.agents[agent] = { last, days, events };
  }
  return out;
}

function sortedItems(items: ConfigSnapshot["items"]): ConfigSnapshot["items"] {
  const out: ConfigSnapshot["items"] = {};
  for (const k of Object.keys(items).sort()) out[k] = items[k]!;
  return out;
}

export function serializeConfigHistory(h: ConfigHistory): string {
  const agents: Record<string, unknown> = {};
  for (const agent of ["claude-code", "codex"] as const) {
    const a = h.agents[agent];
    if (!a) continue;
    agents[agent] = {
      last: a.last ? { t: a.last.t, agent: a.last.agent, items: sortedItems(a.last.items) } : null,
      days: a.days,
      events: a.events,
    };
  }
  return `${JSON.stringify({ schema: h.schema, agents })}\n`;
}

const STRONG_KINDS = new Set(["instructions", "model", "effort", "mcp", "skills", "plugins", "hooks"]);
const STRONG_CONFIG_NOTES = new Set(["model provider", "default permission mode", "approval policy"]);
const PLUGIN_PREFIXES = ["settings.plugins.name.", "plugins.installed.name.", "config.plugins.name."];

function pluginNames(items: ConfigSnapshot["items"]): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(items)) for (const p of PLUGIN_PREFIXES) if (v === true && k.startsWith(p)) out.add(`${p}${k.slice(p.length)}`);
  return out;
}

/** True when the plugin-name sets differ only by wasitme's own plugins. */
function onlyOwnPlugins(prev: ConfigSnapshot, next: ConfigSnapshot, hash: HashFn): boolean {
  const own = new Set(OWN_PLUGINS.map((n) => shortHash(hash, n)));
  const a = pluginNames(prev.items), b = pluginNames(next.items);
  const diff = [...a].filter((k) => !b.has(k)).concat([...b].filter((k) => !a.has(k)));
  return diff.length > 0 && diff.every((k) => own.has(k.slice(k.lastIndexOf(".") + 1)));
}

/** Side / strength / provenance for one snapshot diff event (see the header). */
export function tagSnapshotEvent(e: ChangeEvent, prev: ConfigSnapshot, next: ConfigSnapshot, hash: HashFn): ChangeEvent {
  const out: ChangeEvent = { ...e, provenance: "settings_snapshot" };
  if (e.kind === "plugins" && onlyOwnPlugins(prev, next, hash)) {
    out.side = "meta";
    out.strength = "routine";
    return out;
  }
  out.side = "you";
  out.strength = STRONG_KINDS.has(e.kind) || (e.kind === "config" && STRONG_CONFIG_NOTES.has(e.note ?? "")) ? "strong" : "weak";
  return out;
}

const sameItems = (a: ConfigSnapshot["items"], b: ConfigSnapshot["items"]): boolean =>
  JSON.stringify(sortedItems(a)) === JSON.stringify(sortedItems(b));

export interface CollectInputs {
  hash: HashFn;
  now: Date;
  timeZone: string;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Take this scan's snapshots and fold them into the history (in memory). Returns whether anything changed. */
export function updateConfigHistory(h: ConfigHistory, inp: CollectInputs): boolean {
  let changed = false;
  const today = localDay(inp.now.toISOString(), inp.timeZone);
  for (const agent of ["claude-code", "codex"] as const) {
    let r;
    try {
      r = collectConfig(agent, { hash: inp.hash, now: inp.now, home: inp.home, env: inp.env });
    } catch {
      continue; // the collector degrades per source; a throw here means "not observed this time"
    }
    if (!r.found) continue;
    const cur = h.agents[agent] ?? { last: null, days: [], events: [] };
    if (!cur.days.includes(today)) {
      cur.days = [...cur.days, today].sort().slice(-MAX_DAYS);
      changed = true;
    }
    if (!cur.last) {
      cur.last = { ...r.snapshot, items: sortedItems(r.snapshot.items) };
      changed = true;
    } else {
      const merged = mergeSnapshots(cur.last, r.snapshot);
      if (!sameItems(merged.items, cur.last.items)) {
        const evs = diffSnapshots(cur.last, r.snapshot, { hash: inp.hash, timeZone: inp.timeZone })
          .map((e) => tagSnapshotEvent(e, cur.last!, r.snapshot, inp.hash));
        const known = new Set(cur.events.map((e) => e.id));
        cur.events = [...cur.events, ...evs.filter((e) => !known.has(e.id))].slice(-MAX_EVENTS);
        cur.last = { ...merged, items: sortedItems(merged.items) };
        changed = true;
      }
    }
    h.agents[agent] = cur;
  }
  return changed;
}

export function saveConfigHistory(path: string, h: ConfigHistory): boolean {
  return writeIfChanged(path, serializeConfigHistory(h));
}

/** Re-day stored events in another zone (their `t` is UTC). */
export function retzConfigHistory(h: ConfigHistory, timeZone: string): void {
  for (const a of Object.values(h.agents)) if (a) a.events = a.events.map((e) => ({ ...e, day: localDay(e.t, timeZone) }));
}
