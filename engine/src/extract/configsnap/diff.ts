import { createHash } from "node:crypto";
import type { AgentId, ChangeEvent, ChangeKind, ConfigSnapshot, HashFn } from "../../types.js";
import { localDay } from "../../util.js";
import { isRecord, safeLabel, SHORT_HASH_RE, shortHash, unsaltedShortHash } from "./labels.js";
import type { Items } from "./types.js";
import { APPROVAL_POLICIES, BUILTIN_PROVIDERS, KNOWN_HOOK_EVENTS, PERMISSION_MODES, SANDBOX_MODES } from "./vocab.js";

export interface DiffOptions {
  /** Salted id factory for event ids (and for hashing any label that is not label-safe). Default: unsalted sha256. */
  hash?: HashFn;
  /** IANA timezone for `day` (default: system). */
  timeZone?: string;
}

type Val = string | number | boolean | undefined;

interface Draft { from: string; to: string; note?: string }
/**
 * `readable` (strings only): the closed set of labels allowed to appear as text. Any other string (a
 * stored snapshot is untrusted input) becomes a salted hash; "unset" and values that already are a
 * hash always pass. Omit it for free-label values (model and effort names).
 */
type Fmt = (v: Val, readable?: ReadonlySet<string>) => string;
interface Cx { p: Items; n: Items; fmt: Fmt }
type Run = (cx: Cx) => Draft | undefined;
interface Facet { id: string; kind: ChangeKind; run: Run }

// ---------------------------------------------------------------------------------------------
// Facet builders. A facet only fires when BOTH snapshots know its keys: a source that could not be
// read (missing keys) is "unknown", never "changed".
// ---------------------------------------------------------------------------------------------

/** Nothing readable: for values the user invents (profile names), only "unset" or a hash may be shown. */
const NO_LABELS: ReadonlySet<string> = new Set();

/** A label-valued key (model, effort, approval policy …); `readable` restricts which labels may be shown as text. */
const scalar = (key: string, note: string, readable?: ReadonlySet<string>): Run => ({ p, n, fmt }) => {
  const a = p[key], b = n[key];
  if (a === undefined || b === undefined || a === b) return undefined;
  return { from: fmt(a, readable), to: fmt(b, readable), note };
};

/** Only a salted hash is stored (settings we do not itemise): report that it changed, nothing more. */
const hashOnly = (key: string, note: string): Run => ({ p, n, fmt }) => {
  const a = p[key], b = n[key];
  if (typeof a !== "string" || typeof b !== "string" || a === b) return undefined;
  return { from: fmt(a), to: fmt(b), note };
};

/** A present/absent flag, optionally with a content hash that reveals edits while it stays present. */
const flag = (key: string, hashKey: string | undefined, note: string): Run => ({ p, n, fmt }) => {
  const a = p[key], b = n[key];
  if (typeof a !== "boolean" || typeof b !== "boolean") return undefined;
  if (a !== b) return { from: a ? "present" : "absent", to: b ? "present" : "absent", note };
  if (a && hashKey) {
    const ha = p[hashKey], hb = n[hashKey];
    if (typeof ha === "string" && typeof hb === "string" && ha !== hb) return { from: fmt(ha), to: fmt(hb), note: `${note} edited` };
  }
  return undefined;
};

interface CountedSpec {
  count: string;
  noun: string;
  /** Salted hash of the whole block: catches edits that leave every count unchanged. */
  hash?: string;
  /** Key prefix of `<prefix><h:hash>` = true members: reports which hashed names were added/removed. */
  names?: string;
  /**
   * Sub-counts to itemise in the note: fixed keys, or every key under a prefix. For a prefix, `vocab`
   * is the set of readable names allowed in the note: any other name (a stored snapshot is untrusted
   * input) is shown as "other", unless it is already a salted hash.
   */
  parts?: readonly string[] | { prefix: string; vocab?: ReadonlySet<string> };
}

const MAX_PIECES = 6;
const MAX_LISTED = 3;

function members(items: Items, prefix: string): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(items)) {
    if (v === true && k.startsWith(prefix)) {
      const h = k.slice(prefix.length);
      if (SHORT_HASH_RE.test(h)) out.add(h);
    }
  }
  return out;
}

function listed(hs: string[]): string {
  return hs.slice(0, MAX_LISTED).join(", ") + (hs.length > MAX_LISTED ? ", ..." : "");
}

const counted = (spec: CountedSpec): Run => ({ p, n, fmt }) => {
  const pc = p[spec.count], nc = n[spec.count];
  if (typeof pc !== "number" || typeof nc !== "number") return undefined;

  const pieces: string[] = [];
  if (spec.names) {
    const a = members(p, spec.names), b = members(n, spec.names);
    const added = [...b].filter((x) => !a.has(x)).sort();
    const removed = [...a].filter((x) => !b.has(x)).sort();
    if (added.length) pieces.push(`added ${added.length} (${listed(added)})`);
    if (removed.length) pieces.push(`removed ${removed.length} (${listed(removed)})`);
  }
  if (spec.parts) {
    const prefixSpec = Array.isArray(spec.parts) ? undefined : (spec.parts as { prefix: string; vocab?: ReadonlySet<string> });
    const keys = prefixSpec
      ? [...new Set([...Object.keys(p), ...Object.keys(n)])].filter((k) => k.startsWith(prefixSpec.prefix)).sort()
      : (spec.parts as readonly string[]);
    for (const k of keys) {
      const a = p[k], b = n[k];
      const av = typeof a === "number" ? a : 0, bv = typeof b === "number" ? b : 0;
      if (av === bv) continue;
      const seg = k.slice(k.lastIndexOf(".") + 1);
      const readable = SHORT_HASH_RE.test(seg) || (prefixSpec?.vocab ? prefixSpec.vocab.has(seg) : safeLabel(seg) !== undefined);
      pieces.push(`${readable ? seg : "other"} ${av} to ${bv}`);
    }
  }
  pieces.splice(MAX_PIECES);

  if (pc === nc && pieces.length === 0) {
    const ha = spec.hash ? p[spec.hash] : undefined;
    const hb = spec.hash ? n[spec.hash] : undefined;
    if (typeof ha === "string" && typeof hb === "string" && ha !== hb) return { from: fmt(ha), to: fmt(hb), note: `${spec.noun} edited` };
    return undefined;
  }
  return { from: fmt(pc), to: fmt(nc), note: pieces.length ? `${spec.noun}: ${pieces.join("; ")}` : spec.noun };
};

/** CLAUDE.md / AGENTS.md: appeared, disappeared, or its hash changed. */
const instructions: Run = ({ p, n, fmt }) => {
  const pp = p["instructions.present"], np = n["instructions.present"];
  if (typeof pp !== "boolean" || typeof np !== "boolean") return undefined;
  const ph = p["instructions.hash"], nh = n["instructions.hash"];
  const hashOf = (present: boolean, h: Val): string => (present ? (typeof h === "string" ? fmt(h) : "unknown") : "absent");
  if (pp === np && !(pp && typeof ph === "string" && typeof nh === "string" && ph !== nh)) return undefined;

  const bytes = (v: Val): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  const pb = bytes(p["instructions.bytes"]), nb = bytes(n["instructions.bytes"]);
  const pl = bytes(p["instructions.lines"]), nl = bytes(n["instructions.lines"]);
  const bits: string[] = [];
  if (pb !== undefined || nb !== undefined) bits.push(`bytes ${pb ?? 0} to ${nb ?? 0}`);
  if (pl !== undefined && nl !== undefined) bits.push(`lines ${pl} to ${nl}`);
  const lead = !pp ? "added" : !np ? "removed" : "edited";
  return { from: hashOf(pp, ph), to: hashOf(np, nh), note: [lead, ...bits].join(", ") };
};

const CLAUDE_FACETS: readonly Facet[] = [
  { id: "instructions", kind: "instructions", run: instructions },
  { id: "model", kind: "model", run: scalar("settings.model", "configured default model") },
  { id: "effort", kind: "effort", run: scalar("settings.effort", "configured effort level") },
  { id: "thinking", kind: "effort", run: scalar("settings.thinking", "always-on thinking setting") },
  { id: "hooks", kind: "hooks", run: counted({ count: "settings.hooks.total", noun: "hooks", hash: "settings.hooks.hash", parts: { prefix: "settings.hooks.event.", vocab: KNOWN_HOOK_EVENTS } }) },
  { id: "statusline", kind: "config", run: flag("settings.statusline.present", "settings.statusline.hash", "status line") },
  {
    id: "permissions", kind: "config",
    run: counted({
      count: "settings.permissions.count", noun: "permission rules", hash: "settings.permissions.hash",
      parts: ["settings.permissions.allow", "settings.permissions.deny", "settings.permissions.ask"],
    }),
  },
  { id: "permission-mode", kind: "config", run: scalar("settings.permissions.mode", "default permission mode", PERMISSION_MODES) },
  { id: "env", kind: "config", run: counted({ count: "settings.env.count", noun: "environment variables in settings", hash: "settings.env.hash" }) },
  { id: "settings-other", kind: "config", run: hashOnly("settings.other.hash", "other settings") },
  { id: "plugins-enabled", kind: "plugins", run: counted({ count: "settings.plugins.count", noun: "enabled plugins", names: "settings.plugins.name." }) },
  { id: "plugins-installed", kind: "plugins", run: counted({ count: "plugins.installed.count", noun: "installed plugins", names: "plugins.installed.name." }) },
  { id: "mcp", kind: "mcp", run: counted({ count: "claudejson.mcp.count", noun: "MCP servers", hash: "claudejson.mcp.hash", names: "claudejson.mcp.name." }) },
  { id: "skills", kind: "skills", run: counted({ count: "skills.count", noun: "skills", names: "skills.name." }) },
];

const CODEX_FACETS: readonly Facet[] = [
  { id: "instructions", kind: "instructions", run: instructions },
  { id: "model", kind: "model", run: scalar("config.model", "configured default model") },
  { id: "effort", kind: "effort", run: scalar("config.effort", "configured reasoning effort") },
  { id: "provider", kind: "config", run: scalar("config.provider", "model provider", BUILTIN_PROVIDERS) },
  { id: "approval", kind: "config", run: scalar("config.approval", "approval policy", APPROVAL_POLICIES) },
  { id: "sandbox", kind: "config", run: scalar("config.sandbox", "sandbox mode", SANDBOX_MODES) },
  { id: "profile", kind: "config", run: scalar("config.profile", "active profile", NO_LABELS) },
  { id: "notify", kind: "config", run: flag("config.notify.present", undefined, "notify command") },
  { id: "mcp", kind: "mcp", run: counted({ count: "config.mcp.count", noun: "MCP servers", hash: "config.mcp.hash", names: "config.mcp.name." }) },
  { id: "plugins", kind: "plugins", run: counted({ count: "config.plugins.count", noun: "enabled plugins", names: "config.plugins.name." }) },
  { id: "skills", kind: "skills", run: counted({ count: "skills.count", noun: "skills", names: "skills.name." }) },
];

const AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(["claude-code", "codex"]);

/**
 * Changes between two snapshots of the same agent, as ChangeEvents: side "you", evidence "snapshot".
 *
 * - Only keys known to BOTH snapshots are compared. A source that was unreadable in either one is
 *   unknown, not changed (see mergeSnapshots to keep the last known state across such gaps).
 * - `t` is `next.t`: a snapshot proves the change happened sometime between the two snapshots,
 *   not when. No time arithmetic happens here, so a backward clock cannot produce negative anything.
 * - `from`/`to` are counts, "present"/"absent", "on"/"off", allow-listed labels or "h:xxxxxxxx"
 *   hashes; stored values are re-validated, so a tampered snapshot cannot smuggle text into an event.
 * - One event per facet (e.g. one for "MCP servers", not one per server), ids unique per facet.
 */
export function diffSnapshots(prev: ConfigSnapshot, next: ConfigSnapshot, opts: DiffOptions = {}): ChangeEvent[] {
  if (!prev || !next || prev.agent !== next.agent || !AGENTS.has(next.agent)) return [];
  if (!isRecord(prev.items) || !isRecord(next.items)) return [];
  const ms = Date.parse(next.t);
  if (!Number.isFinite(ms)) return [];
  const t = new Date(ms).toISOString();
  const day = localDay(t, opts.timeZone);

  const idHash: HashFn = opts.hash ?? ((v, prefix) => prefix + createHash("sha256").update(v).digest("hex").slice(0, 12));
  const fmt: Fmt = (v, readable) => {
    if (typeof v === "boolean") return v ? "on" : "off";
    if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : "unknown";
    if (typeof v === "string") {
      const label = safeLabel(v);
      const shown = label !== undefined && (readable === undefined || label === "unset" || SHORT_HASH_RE.test(label) || readable.has(label));
      return shown ? label : opts.hash ? shortHash(opts.hash, v) : unsaltedShortHash(v);
    }
    return "unknown";
  };

  const cx: Cx = { p: prev.items, n: next.items, fmt };
  const events: ChangeEvent[] = [];
  for (const f of next.agent === "claude-code" ? CLAUDE_FACETS : CODEX_FACETS) {
    const d = f.run(cx);
    if (!d) continue;
    const ev: ChangeEvent = {
      // The facet id is part of the hash input: two facets changing "1" -> "2" at the same t stay distinct.
      id: idHash(`${next.agent}|${f.kind}|${f.id}|${d.from}|${d.to}|${t}`, "c-"),
      t, day, agent: next.agent, kind: f.kind, side: "you", from: d.from, to: d.to, evidence: "snapshot",
    };
    if (d.note) ev.note = d.note;
    events.push(ev);
  }
  return events;
}

/**
 * The baseline to store after taking `next`: `next`, plus — for any source `next` could not read —
 * the last known state from `prev`. Without this, a change made while a file was briefly
 * unreadable/malformed would never be reported. Sources are the first key segment
 * (instructions, settings, claudejson, plugins, config, skills); a source is replaced as a whole.
 */
export function mergeSnapshots(prev: ConfigSnapshot | undefined, next: ConfigSnapshot): ConfigSnapshot {
  if (!prev || prev.agent !== next.agent || !isRecord(prev.items)) return next;
  const have = new Set(Object.keys(next.items).map(sourceOf));
  const items: Items = {};
  for (const [k, v] of Object.entries(prev.items)) {
    if (k === "__proto__" || have.has(sourceOf(k))) continue;
    items[k] = v;
  }
  for (const [k, v] of Object.entries(next.items)) if (k !== "__proto__") items[k] = v;
  return { t: next.t, agent: next.agent, items };
}

function sourceOf(key: string): string {
  const dot = key.indexOf(".");
  return dot < 0 ? key : key.slice(0, dot);
}
