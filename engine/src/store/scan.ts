/**
 * `wasitme scan` (D60, D63): lock and salt → list sources → re-parse only what changed → shards → global merge and
 * dedupe → read-time filters → analysis → atomic outputs.
 *
 *  1. Lock and salt. The scan lock (single writer) and the salt (O_EXCL, 0600). `--read-only` takes neither: it uses
 *     an ephemeral salt, reads no history and writes nothing anywhere.
 *  2. Sources. Each reader lists its sources (stat only) and, where its parses read other files, fills `depKey`
 *     (D39). Every listed file is stat'ed once more for the fingerprint (inode, size, mtime, ctime + depKey).
 *  3. Re-parse. Fingerprint moved (appended, shrunk, rewritten, replaced, a dependency changed) → full re-parse;
 *     parser version of a family moved → re-derive that family only; nothing moved → the shard is reused unread.
 *     A source that is no longer listed keeps its shard: history survives deletion of the logs.
 *  4. Config and project snapshots: global config collected and diffed (history/config.json); hook records
 *     consolidated (history/projsnap.json). Scans never read project folders (`--no-project-files` is the default and
 *     the only mode).
 *  5. If every input of the last analysis is unchanged (sources, versions, zone, day, cutoff, exclusions, snapshots,
 *     log-folder problems, engine, voting construct, lead, calibration, attribution version) and no pending decision's
 *     24-hour wait ended since the last evaluation, the last outputs are re-stamped with the new `generatedAt` (and
 *     the snapshot with this scan's `health.sandbox`: whether a scan ran under `node --permission` changes no number,
 *     so the CLI's unsandboxed scan and the LaunchAgent's sandboxed one do not recompute each other's results) and
 *     nothing is recomputed.
 *  6. Otherwise: merge all shards (cross-file dedupe, merge.ts), apply `--until` and the exclude list, and per agent run
 *     the attribution pipeline (WP-21 `attributeAgent`: 20a gates with D47's interactive filter inside, events,
 *     evidence, 20b confounders, the decision table and persistence of METHOD.md §11-§12) with
 *       errorsVote  SCAN_ERRORS_VOTE (settings.ts; a ruling changes it there),
 *       calibrated  the dated calibration artifact's flag for the agent (calflags.ts; absent/failed → row 1),
 *       previous    the agent's persisted decision (decisions.ts; reset when the construct, method or version moved),
 *       now/today   the evaluation time (the scan's clock, or the `--until` cutoff) in the scan's zone; persistence
 *                   measures time from the data fingerprints and re-anchors when the clock went backward,
 *       fully observed days (Claude Code only; Codex is partial by design): days before today on which the scan took
 *                   a config snapshot and every session with exchanges had a hook project snapshot;
 *     then the words layer's `buildOutputs` (WP-22) assembles glance and snapshot in the lead variant from engine.json
 *     (settings.ts). When it reports problems, nothing is written: the previous files stay, the glance is flagged
 *     scanOk:false / "internal" (failure path). One exception first: when persisted decisions were used, the analysis
 *     is retried once without them (a held decision can name an event the timeline no longer has); only if that also
 *     has problems does the scan fail. Writes, after re-checking that the lock is still ours: snapshot, glance (the
 *     commit point), decisions, then the manifest with the inputs digest (a crash before it forces a recompute).
 * Idempotent: a second scan with nothing changed rewrites nothing but the two outputs' `generatedAt` (identical bytes
 * when `now` is the same).
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { attributeAgent, type Attribution, type Decision } from "../analysis/attribution/index.js";
import { dayIndex, dayString } from "../analysis/stats/ratio.js";
import type { MetricId } from "../analysis/metrics/defs.js";
import { MAX_SPAN_DAYS } from "../analysis/metrics/windows.js";
import { nextHistory, type EtaRecord } from "../analysis/gates/eta.js";
import type { Glance } from "../contract/glance.js";
import type { Health, Paused, Snapshot, SourceError, SourceHealth } from "../contract/snapshot.js";
import { GLANCE_SCHEMA_ID, SNAPSHOT_SCHEMA_ID, type Lead, type ScanError, type SetupKey } from "../contract/vocab.js";
import { buildOutputs, SNAPSHOT_METRICS, type BuiltOutputs } from "../words/build.js";
import { claudeReader } from "../readers/claude.js";
import { codexReader } from "../readers/codex.js";
import type { AgentId, ChangeEvent, Exchange, ParseContext, ParseResult, Reader, Source } from "../types.js";
import { bump, FUTURE_SLACK_MS, makeHash, typeKey } from "../util.js";
import { ENGINE_VERSION } from "../version.js";
import { appendOwnFile, readOwnJson, writeIfChanged } from "./atomic.js";
import { calibrationKey, calibrationOf, contractCalibration, readCalibration, SHIPPED_CALIBRATION } from "./calflags.js";
import {
  loadConfigHistory, retzConfigHistory, saveConfigHistory, serializeConfigHistory, updateConfigHistory, type ConfigHistory,
} from "./configs.js";
import { filterEvents, filterExchanges, loadExclude, type ExcludeList } from "./exclude.js";
import { loadDecisions, loadProgressHistory, persistenceDue, saveDecisions, type DecisionKey } from "./decisions.js";
import { dependencyFingerprint, dependencyParts, sourceFingerprint, sourceId, statId } from "./fingerprint.js";
import { errorKind, ScanFailure } from "./errors.js";
import { ensureDir, ensureHome, historyExists, homePaths, wasitmeHome, type HomePaths } from "./home.js";
import { acquireLock, type ScanLock } from "./lock.js";
import { emptyManifest, loadManifest, saveManifest, type Manifest, type SourceEntry } from "./manifest.js";
import { mergeShards, type AgentMerge } from "./merge.js";
import { prunePriorCache, storePriorCache } from "./priorcache.js";
import { serializeOutput } from "./outputs.js";
import { recordPermissionFlag, sandboxed, type PermissionFlag } from "./permission.js";
import {
  ingestInbox, loadProjHistory, observedSessionsByDay, projectEvents, removeConsumed, saveProjHistory, serializeProjHistory,
  type ProjHistory,
} from "./projsnap.js";
import { ephemeralSalt, loadSalt } from "./salt.js";
import { ATTRIBUTION_VERSION, readLead, SCAN_ERRORS_VOTE } from "./settings.js";
import { readShard, rederive, retz, serializeShard, shardDigest, shardFromParse, type Shard } from "./shard.js";
import { evaluationNow, dayOf, resolveTimeZone } from "./time.js";
import { changedFamilies, currentVersions, FIELD_FAMILY, healthParserVersions, type VersionOverride } from "./versions.js";

export interface ScanOptions {
  /** wasitme home (default: WASITME_HOME or ~/.wasitme). */
  home?: string;
  /** The user's home directory for the config collector (default: os.homedir()). */
  userHome?: string;
  /** Environment for the config collector (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  /** IANA zone (default: resolveTimeZone()). */
  timeZone?: string;
  /** Read-time cutoff: exchanges and events after it are left out. */
  until?: Date;
  /** Scan in memory, write nothing anywhere, ephemeral salt. */
  readOnly?: boolean;
  /** Accepted for explicitness; scans never read project files (only the SessionStart hook does). */
  noProjectFiles?: boolean;
  readers?: Reader[];
  /** Test hook: pretend a reader family's parser version is different. */
  parserVersions?: VersionOverride;
  /** Collect global config snapshots (default true). */
  collectConfig?: boolean;
  /** Feature-test the permission flag into engine.json when needed (default true; never in read-only). */
  recordPermission?: boolean;
  probe?: () => PermissionFlag | null;
  /** Bootstrap resamples for the evaluation (default: the analysis layer's 2,000). */
  resamples?: number;
  /**
   * Test hook: the calibration artifact document to read instead of the shipped one (calflags.ts). Tests only —
   * nothing a user controls (no environment variable, no file) reaches it.
   */
  calibration?: unknown;
  /** Test hook: called with each agent's attribution before the words are built (to exercise the problems path). */
  inspectAttribution?: (a: Attribution) => void;
}

export interface ScanReport {
  busy: boolean;
  /** Outputs written (false in read-only and when busy). */
  wrote: boolean;
  /** Inputs were unchanged: the last outputs were re-stamped instead of recomputed. */
  reused: boolean;
  timeZone: string;
  sources: number;
  parsed: number;
  rederivedPartial: number;
  rederivedFull: number;
  unchanged: number;
  failed: number;
  historyOnly: number;
  /** Shards found missing or damaged while their source is still on disk: re-parsed (counted in `parsed` too). */
  rebuiltShards: number;
  /** Shards found missing or damaged whose source log is gone: that history is lost and left out of the analysis. */
  lostShards: number;
  crossFileDuplicates: number;
  excluded: number;
  afterCutoff: number;
  excludeError: ExcludeList["error"];
  permission: { flag: PermissionFlag | null; how: string } | null;
  /** The lead variant in force (engine.json, settings.ts). */
  lead: Lead;
  glance?: Glance;
  snapshot?: Snapshot;
  /**
   * Each reported agent's attribution, in memory only (never written): the evaluation's numbers for every agent —
   * snapshot.json carries no metrics for a timeline-only (uncalibrated) agent — plus the decision and its persistence.
   * Absent when the outputs were re-stamped.
   */
  attributions?: Attribution[];
  /** The analysis was retried without the persisted decisions because they made the outputs fail their checks. */
  persistenceDropped: boolean;
  ms: number;
  /** Where the time went (ms): listing + fingerprints, parsing, snapshots, merge, evaluation, output build + writes. */
  timings: { list: number; parse: number; snapshots: number; merge: number; evaluate: number; outputs: number };
}

// The failure kinds live in a light module (the CLI names failures without loading the scan); re-exported here.
export { errorKind, ScanFailure } from "./errors.js";

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

async function safeParse(reader: Reader, s: Source, ctx: ParseContext): Promise<ParseResult | undefined> {
  try {
    return await reader.parse(s, ctx);
  } catch {
    return undefined;
  }
}

function entryOf(s: Shard, present: boolean, h: string, deps: string[] | null): SourceEntry {
  let first: string | null = null, last: string | null = null;
  for (const x of s.exchanges) {
    if (first === null || x.day < first) first = x.day;
    if (last === null || x.day > last) last = x.day;
  }
  return { agent: s.agent, fp: s.fp, h, dep: s.dep, uses: [...s.uses], pv: { ...s.pv }, present, born: s.born, n: s.exchanges.length, first, last, fut: s.stats.futureMin ?? null, deps };
}

/** Salted ids of the sources a parse reported using (never itself), sorted and unique. */
function usesOf(byKeyId: ReadonlyMap<string, string>, sid: string, r: ParseResult): string[] {
  const out = new Set<string>();
  // ParseResult.deps holds `hash(key, "k-")`; a dependency that is not listed any more is gone and never re-parses.
  for (const k of r.deps ?? []) {
    const dep = typeof k === "string" ? byKeyId.get(k) : undefined;
    if (dep !== undefined) out.add(dep);
  }
  out.delete(sid);
  return [...out].sort();
}

/** Metrics a family's version touches (for the parser_changed pause). */
const FAMILY_METRICS: Readonly<Record<string, readonly string[]>> = {
  exchanges: SNAPSHOT_METRICS, labels: SNAPSHOT_METRICS, interactive: SNAPSHOT_METRICS,
  toolErrors: ["toolErrors", "toolErrorsNonCmd", "cmdFailures"],
  research: ["readsPerEdit", "blindEdits"],
  friction: ["interrupts", "pushback"],
};

function pausedFor(m: Manifest, today: string, pv: ReadonlyMap<AgentId, Record<string, number>>, agents: readonly AgentId[]): Paused[] {
  const ti = dayIndex(today)!;
  const from = dayString(ti - MAX_SPAN_DAYS), to = dayString(ti - 1);
  const seen = new Set<string>();
  const out: Paused[] = [];
  for (const e of Object.values(m.sources)) {
    if (e.present || !agents.includes(e.agent) || e.first === null || e.last === null) continue;
    if (e.last < from || e.first > to) continue;
    const cur = pv.get(e.agent);
    if (!cur) continue;
    for (const fam of changedFamilies(e.pv, cur)) {
      for (const metric of FAMILY_METRICS[fam] ?? []) {
        const key = `${e.agent}|${metric}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ agent: e.agent, metric, why: "parser_changed" });
      }
    }
  }
  return out.sort((a, b) => (a.agent + a.metric < b.agent + b.metric ? -1 : 1));
}

/** Key a record type that is not identifier-shaped is counted under (the readers' own fallbacks). */
export const UNKNOWN_FALLBACK: Readonly<Record<AgentId, string>> = { "claude-code": "other", codex: "codex:unrecognised" };

/**
 * Why a reader's log folder lists nothing, as a kind (never a path): it is not there, or it is there but cannot be read.
 * The listing itself swallows errors (readers/fs.ts `entries` gives []), so the folder is probed once here. EPERM is
 * what macOS privacy protection (TCC) raises for a folder such as ~/Documents; ERR_ACCESS_DENIED is the Node
 * permission model's refusal.
 */
export function rootProblem(reader: Pick<Reader, "root">): SourceError | null {
  let dir: string;
  try {
    dir = reader.root();
  } catch {
    return "unreadable";
  }
  try {
    readdirSync(dir);
    return null;
  } catch (e) {
    const c = code(e);
    if (c === "ENOENT" || c === "ENOTDIR") return "not_found";
    if (c === "EACCES" || c === "ERR_ACCESS_DENIED") return "permission_denied";
    if (c === "EPERM") return "protected_folder";
    return "unreadable";
  }
}

/** The health row of an agent with nothing to analyse: no logs listed and no history kept. */
function absentHealth(agent: AgentId, problem: SourceError | null): SourceHealth {
  return {
    agent, found: false, files: 0, badLines: 0, truncatedTail: 0, duplicates: 0, unknownTypes: {}, firstDay: null, lastDay: null,
    error: problem ?? "not_found",
  };
}

function sourceHealth(agent: AgentId, m: AgentMerge | undefined, listed: number, kept: readonly Exchange[], today: string, problem: SourceError | null): SourceHealth {
  // Last gate before snapshot.json and `--read-only` stdout: only identifier-shaped keys (util.ts typeKey) survive;
  // anything else (prose, an address, a path from an older shard or a reader bug) is folded into the fallback key.
  const types: Record<string, number> = {};
  for (const [k, v] of Object.entries(m?.stats.unknownTypes ?? {})) if (typeof v === "number" && Number.isFinite(v)) bump(types, typeKey(k, UNKNOWN_FALLBACK[agent]), v);
  const keys = Object.keys(types).sort((a, b) => (types[b]! - types[a]!) || (a < b ? -1 : 1)).slice(0, 64).sort();
  const unknownTypes: Record<string, number> = {};
  for (const k of keys) bump(unknownTypes, k, Math.max(0, Math.round(types[k]!)));
  let firstDay: string | null = null, lastDay: string | null = null;
  for (const x of kept) {
    if (x.day >= today) continue;
    if (firstDay === null || x.day < firstDay) firstDay = x.day;
    if (lastDay === null || x.day > lastDay) lastDay = x.day;
  }
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(1e9, Math.round(v)) : 0);
  return {
    agent,
    found: listed > 0 || (m?.historyOnly ?? 0) > 0,
    files: n(m?.stats.files),
    badLines: n(m?.stats.badLines),
    truncatedTail: n(m?.stats.truncatedTail),
    duplicates: n((m?.stats.duplicates ?? 0) + (m?.crossFileDuplicates ?? 0)),
    unknownTypes,
    firstDay,
    lastDay,
    // Nothing listed: the folder's problem (history may still be kept). Something listed: the folder was readable.
    error: listed === 0 ? (problem ?? ((m?.historyOnly ?? 0) === 0 ? "not_found" : null)) : null,
  };
}

/**
 * The order Phase B parses in: the listing's, except that each project's Claude Code sessions go oldest first
 * (creation time, then name — the order the resume-dedupe priors index uses, readers/claude/priors.ts). A session's
 * parse needs every earlier session's record ids; parsed in name order, a session created later but named earlier
 * had its earlier siblings read from disk for the index and then read again for their own parse (a full scan spent
 * ~15% of its time there). Same parses, same results; only the order changes. Never changes the listing itself.
 */
export function parseOrder<T extends { reader: Pick<Reader, "agent">; s: Pick<Source, "key">; born: number }>(all: readonly T[]): T[] {
  const project = (l: T): string | null => {
    if (l.reader.agent !== "claude-code") return null;
    const i = l.s.key.indexOf("/");
    return i < 0 ? null : l.s.key.slice(0, i);
  };
  const out: T[] = [];
  let i = 0;
  while (i < all.length) {
    const p = project(all[i]!);
    let j = i + 1;
    if (p !== null) while (j < all.length && project(all[j]!) === p) j++;
    const run = all.slice(i, j);
    if (run.length > 1) run.sort((a, b) => a.born - b.born || (a.s.key < b.s.key ? -1 : a.s.key > b.s.key ? 1 : 0));
    out.push(...run);
    i = j;
  }
  return out;
}

/** Setup labels (version, model, effort, mode, entrypoint): id-shaped; `@` only as a Vertex-style version suffix. */
const SETUP_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,59}(@(?:\d{8}|latest|default))?$/;
/** The setup keys taken from the last kept exchange; the rest come from the config snapshot (SETUP_KEYS, D80). */
const SETUP_LABELS = ["version", "model", "effort", "mode", "entrypoint"] as const satisfies readonly SetupKey[];
const SETUP_COUNTS: Readonly<Record<AgentId, readonly [string, SetupKey][]>> = {
  "claude-code": [
    ["claudejson.mcp.count", "mcpServers"], ["skills.count", "skills"], ["settings.hooks.total", "hooks"],
    ["settings.plugins.count", "pluginsEnabled"], ["plugins.installed.count", "pluginsInstalled"],
    ["instructions.present", "instructions"], ["instructions.bytes", "instructionsBytes"],
  ],
  codex: [
    ["config.mcp.count", "mcpServers"], ["skills.count", "skills"], ["config.plugins.count", "pluginsEnabled"],
    ["instructions.present", "instructions"], ["instructions.bytes", "instructionsBytes"],
  ],
};

function setupOf(agent: AgentId, kept: readonly Exchange[], cfg: ConfigHistory): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const last = kept[kept.length - 1];
  if (last) {
    for (const k of SETUP_LABELS) {
      const v = last[k];
      if (typeof v === "string" && v !== "unknown" && SETUP_LABEL_RE.test(v)) out[k] = v;
    }
  }
  const items = cfg.agents[agent]?.last?.items;
  if (items) {
    for (const [key, name] of SETUP_COUNTS[agent]) {
      const v = items[key];
      if (typeof v === "boolean" || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) out[name] = v;
    }
  }
  return out;
}

/**
 * Fully observed local days before `today` (D63, WP-12's rule): the scan took a config snapshot that day and every
 * session with exchanges that day had an observed project snapshot from the SessionStart hook. A config day with no
 * sessions is fully observed (nothing ran that the hook could have missed). Claude Code only: Codex has no hooks.
 */
export function fullyObservedDays(
  kept: readonly Exchange[], configDays: readonly string[], observed: ReadonlyMap<string, ReadonlySet<string>>, today: string,
): string[] {
  const sessions = new Map<string, Set<string>>();
  for (const x of kept) {
    if (x.day >= today) continue;
    let s = sessions.get(x.day);
    if (!s) sessions.set(x.day, (s = new Set()));
    s.add(x.session);
  }
  const out: string[] = [];
  for (const day of new Set(configDays)) {
    if (day >= today) continue;
    const seen = observed.get(day);
    if ([...(sessions.get(day) ?? [])].every((s) => seen?.has(s) === true)) out.push(day);
  }
  return out.sort();
}

function previousTimelines(p: HomePaths, readOnly: boolean): Map<string, Set<string>> | null {
  if (readOnly) return null;
  const v = readOwnJson(p.snapshot, 4 << 20) as Snapshot | undefined;
  if (!v || v.schema !== SNAPSHOT_SCHEMA_ID || !Array.isArray(v.agents)) return null;
  const out = new Map<string, Set<string>>();
  for (const a of v.agents) {
    if (a && typeof a.agent === "string" && Array.isArray(a.timeline)) out.set(a.agent, new Set(a.timeline.map((e) => e?.id).filter((x): x is string => typeof x === "string")));
  }
  return out;
}

function dedupeEvents(es: readonly ChangeEvent[]): ChangeEvent[] {
  const m = new Map<string, ChangeEvent>();
  for (const e of es) if (!m.has(e.id)) m.set(e.id, e);
  return [...m.values()].sort((a, b) => {
    const ta = Date.parse(a.t), tb = Date.parse(b.t);
    return ta !== tb ? ta - tb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Re-stamp the last outputs (inputs unchanged). Returns undefined when they are missing or not ours. `new` marks mean
 * "appeared since the previous scan": with nothing changed, nothing appeared, so every mark is cleared, and so is the
 * status line's new-change count (words: `wasitme: {label}[ +n]`, D59) — exactly what a recompute against the previous
 * snapshot gives, so the reuse shortcut and a recompute write the same bytes.
 */
function restamp(p: HomePaths, now: Date, sandbox: boolean): { glance: Glance; snapshot: Snapshot } | undefined {
  const g = readOwnJson(p.glance, 1 << 20) as Glance | undefined;
  const s = readOwnJson(p.snapshot, 4 << 20) as Snapshot | undefined;
  if (!g || !s || g.schema !== GLANCE_SCHEMA_ID || s.schema !== SNAPSHOT_SCHEMA_ID || g.engine !== ENGINE_VERSION || s.engine !== ENGINE_VERSION) return undefined;
  if (g.privacy?.containsText !== false || s.privacy?.containsText !== false || g.scanOk !== true || s.scanOk !== true) return undefined;
  if (!Array.isArray(g.agents) || !Array.isArray(s.agents)) return undefined;
  if (typeof s.health !== "object" || s.health === null) return undefined;
  const generatedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const seen = <T extends { new: boolean }>(xs: readonly T[] | undefined): T[] => (Array.isArray(xs) ? xs.map((e) => (e && e.new === true ? { ...e, new: false } : e)) : []);
  const line = (v: unknown): string => (typeof v === "string" ? v.replace(/ \+\d+$/, "") : "");
  return {
    glance: { ...g, generatedAt, agents: g.agents.map((a) => ({ ...a, statusLine: line(a.statusLine), events: seen(a.events) })) },
    snapshot: { ...s, generatedAt, health: { ...s.health, sandbox }, agents: s.agents.map((a) => ({ ...a, statusLine: line(a.statusLine), events: seen(a.events), timeline: seen(a.timeline) })) },
  };
}

/**
 * On a failed scan: keep the last results (their generatedAt ages them into "stale"), and flag the failure by kind in
 * BOTH documents — the glance (what the status line and the app watch) and the snapshot (what `wasitme`, `report` and
 * `doctor` read), so every surface can say the last scan failed. A missing or foreign glance is replaced by an empty
 * one carrying the flag; a missing or foreign snapshot is left alone (the glance carries the flag). The next good scan
 * recomputes both (the reuse shortcut never re-stamps a document with scanOk:false).
 */
export function writeFailureGlance(p: HomePaths, kind: ScanError, now: Date): void {
  // Snapshot first, glance last: the glance is the commit point every surface watches (as in a good scan).
  try {
    const s = readOwnJson(p.snapshot, 4 << 20) as Snapshot | undefined;
    if (s && s.schema === SNAPSHOT_SCHEMA_ID && Array.isArray(s.agents) && s.privacy?.containsText === false) {
      writeIfChanged(p.snapshot, serializeOutput({ ...s, scanOk: false, scanError: kind }), 4 << 20);
    }
  } catch { /* the glance still carries the flag */ }
  try {
    const g = readOwnJson(p.glance, 1 << 20) as Glance | undefined;
    const doc: Glance = g && g.schema === GLANCE_SCHEMA_ID && Array.isArray(g.agents) && g.privacy?.containsText === false
      ? { ...g, scanOk: false, scanError: kind }
      : {
        schema: GLANCE_SCHEMA_ID, engine: ENGINE_VERSION, generatedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        staleAfterSec: 7200, scanOk: false, scanError: kind, demo: false, lead: "timeline", agents: [], privacy: { containsText: false },
      };
    writeIfChanged(p.glance, serializeOutput(doc));
  } catch { /* nothing more we can do */ }
  try {
    ensureDir(p.logs);
    appendOwnFile(join(p.logs, "scan.log"), `${now.toISOString()} scan_failed ${kind}\n`);
  } catch { /* logging is best effort */ }
}

export async function runScan(o: ScanOptions = {}): Promise<ScanReport> {
  const t0 = performance.now();
  const now = o.now ?? new Date();
  const tz = o.timeZone ?? resolveTimeZone();
  const readers = o.readers ?? [claudeReader, codexReader];
  const ro = o.readOnly === true;
  const p = homePaths(o.home ?? wasitmeHome());
  const report: ScanReport = {
    busy: false, wrote: false, reused: false, timeZone: tz, sources: 0, parsed: 0, rederivedPartial: 0, rederivedFull: 0,
    unchanged: 0, failed: 0, historyOnly: 0, rebuiltShards: 0, lostShards: 0, crossFileDuplicates: 0, excluded: 0, afterCutoff: 0, excludeError: null,
    permission: null, lead: "timeline", persistenceDropped: false, ms: 0, timings: { list: 0, parse: 0, snapshots: 0, merge: 0, evaluate: 0, outputs: 0 },
  };
  let mark = performance.now();
  const lap = (k: keyof ScanReport["timings"]): void => {
    const t = performance.now();
    report.timings[k] += t - mark;
    mark = t;
  };
  let lock: ScanLock | undefined;
  if (!ro) {
    ensureHome(p);
    lock = acquireLock(p.lock);
    if (!lock) {
      report.busy = true;
      report.ms = performance.now() - t0;
      return report;
    }
  }
  try {
    const salt = ro ? ephemeralSalt() : loadSalt(p.salt, { create: true, refuseIf: () => historyExists(p) });
    const hash = makeHash(salt);
    /** Main file path → source id, for the store-backed resume-dedupe cache (filled while listing, memory only). */
    const sidOfPath = new Map<string, string>();
    const ctx: ParseContext = { hash, now, timeZone: tz, ...(ro ? {} : { priorCache: storePriorCache(salt, p.priors, sidOfPath) }) };
    const manifest = ro ? emptyManifest() : loadManifest(p).manifest;
    const tzChanged = manifest.tz !== null && manifest.tz !== tz;
    manifest.tz = tz;

    const shards = new Map<string, Shard>();
    /** Sources counted "unchanged" without reading their shard: a damaged shard found later moves them to "parsed". */
    const unreadShards = new Set<string>();
    const present = new Set<string>();
    const listed = new Map<AgentId, number>();
    /** Per agent with nothing listed: why its log folder gave nothing (rootProblem). */
    const rootProblems = new Map<AgentId, SourceError | null>();
    const pvByAgent = new Map<AgentId, Record<string, number>>();
    /** Store a shard; `deps` are the dependency parts it was derived with (undefined: keep the entry's). */
    const commit = (s: Shard, isPresent: boolean, deps?: string[] | null): void => {
      shards.set(s.sid, s);
      const bytes = serializeShard(s);
      if (!ro) writeIfChanged(join(p.shards, `${s.sid}.json`), bytes, 256 << 20, { fsync: false });
      manifest.sources[s.sid] = entryOf(s, isPresent, shardDigest(s, bytes), deps !== undefined ? deps : manifest.sources[s.sid]?.deps ?? null);
    };

    // Phase A: list every reader's sources (stat only, plus the readers' dependency keys) and fingerprint them.
    interface Listed { reader: Reader; s: Source; sid: string; fp: string; dep: string | null; deps: string[] | null; born: number }
    const all: Listed[] = [];
    /** Per agent: `hash(source.key, "k-")` (the form ParseResult.deps uses) → source id. */
    const keyIds = new Map<AgentId, Map<string, string>>();
    for (const reader of readers) {
      const agent = reader.agent;
      pvByAgent.set(agent, currentVersions(agent, o.parserVersions));
      const byKey = new Map<string, string>();
      keyIds.set(agent, byKey);
      let sources: Source[] = [];
      let listFailed = false;
      try {
        sources = reader.list();
        reader.depKeys?.(sources);
      } catch {
        sources = [];
        listFailed = true;
      }
      listed.set(agent, sources.length);
      // Nothing listed: say why (not there, or not readable), so doctor and the empty report can tell the user. A
      // listing that threw is a reader failure on a folder that may well hold logs: never "not found".
      if (sources.length === 0) rootProblems.set(agent, listFailed ? "unreadable" : rootProblem(reader));
      for (const s of sources) {
        const sid = sourceId(salt, agent, s.key);
        if (present.has(sid)) continue;
        present.add(sid);
        byKey.set(hash(s.key, "k-"), sid);
        if (s.files[0]) sidOfPath.set(s.files[0].path, sid);
        const ids = s.files.map((f) => statId(f.path));
        all.push({
          reader, s, sid, fp: sourceFingerprint(salt, s, ids), dep: dependencyFingerprint(salt, s), deps: dependencyParts(salt, s),
          born: ids[0]?.bornMs ?? Math.round(s.files[0]?.mtimeMs ?? 0),
        });
      }
    }
    // Which agents lost sources since the last scan (logs deleted, e.g. Claude Code's 30-day cleanup).
    const lostSources = new Set<AgentId>();
    for (const [sid, e] of Object.entries(manifest.sources)) if (e.present && !present.has(sid)) lostSources.add(e.agent);
    // Sources whose own files changed (or that are new): a source that USED one of them is re-parsed too.
    const changedSids = new Set<string>();
    for (const l of all) {
      const e = manifest.sources[l.sid];
      if (!e || e.fp !== l.fp) changedSids.add(l.sid);
    }

    // Phase B: re-parse only what changed — Claude Code sessions in creation order within each project (parseOrder).
    lap("list");
    for (const { reader, s, sid, fp, dep, deps, born } of parseOrder(all)) {
      const agent = reader.agent;
      const pv = pvByAgent.get(agent)!;
      report.sources++;
      const entry = manifest.sources[sid];
      // Its last parse rejected records as future-dated, and this scan's clock has reached the earliest of them (the
      // clock was set backward then, or is now): the parse's clock was an input, so the stored shard is stale.
      const clockCaughtUp = entry !== undefined && entry.fut !== null && now.getTime() + FUTURE_SLACK_MS >= entry.fut;
      if (entry && entry.fp === fp && entry.agent === agent && !clockCaughtUp) {
        // Own files unchanged. A dependency that CHANGED or APPEARED re-parses (D39); one that merely DISAPPEARED does
        // not: the stored shard was derived with that file present, the most informed result there will ever be, and
        // a re-parse without it can only degrade (a fork without its parent falls back to a heuristic; a resumed
        // session without its prior re-counts the replay). This is what lets history survive the deletion of logs.
        // With the reader's dependency parts this is decided per source: re-parse iff a dependency present now was not
        // present (with the same identity) at the last decision. Without them (an old manifest entry, a reader that
        // gives none), the agent-wide rule: any deletion among the agent's sources masks a moved digest.
        // A source this one USED (ParseResult.deps: a Claude session it replays) changed: re-parse. One that is gone
        // is not in `changedSids` (not listed), so a deletion never triggers it.
        const depMoved = entry.dep !== dep;
        let depGrew = false;
        if (depMoved) {
          if (deps !== null && entry.deps !== null) {
            const before = new Set(entry.deps);
            depGrew = deps.some((d) => !before.has(d));
          } else depGrew = !lostSources.has(agent);
        }
        const usedChanged = entry.uses.some((u) => changedSids.has(u));
        if (!depGrew && !usedChanged) {
          const fams = changedFamilies(entry.pv, pv);
          entry.deps = deps;
          if (fams.length === 0 && !tzChanged) {
            entry.present = true;
            entry.dep = dep;
            report.unchanged++;
            unreadShards.add(sid);
            continue;
          }
          let old = readShard(join(p.shards, `${sid}.json`), { sid, agent });
          if (old) {
            old = { ...old, dep };
            if (tzChanged) old = retz(old, tz);
            if (fams.length > 0) {
              const fresh = await safeParse(reader, s, ctx);
              if (fresh) {
                const r = rederive(old, fresh, fams, FIELD_FAMILY[agent], pv);
                old = { ...r.shard, uses: usesOf(keyIds.get(agent)!, sid, fresh) };
                if (r.mode === "partial") report.rederivedPartial++;
                else report.rederivedFull++;
              } else report.failed++; // keep the stored history; the next scan tries again
            } else report.unchanged++;
            commit(old, true, deps);
            continue;
          }
          // Shard missing or damaged: fall through to a full parse.
        }
      }
      const r = await safeParse(reader, s, ctx);
      if (!r) {
        report.failed++;
        if (entry) entry.present = true;
        continue;
      }
      commit(shardFromParse(agent, sid, fp, dep, usesOf(keyIds.get(agent)!, sid, r), pv, tz, born, r), true, deps);
      report.parsed++;
    }
    for (const [sid, e] of Object.entries(manifest.sources)) {
      if (present.has(sid)) continue;
      e.present = false;
      report.historyOnly++;
      if (tzChanged && !ro) {
        const s = readShard(join(p.shards, `${sid}.json`), { sid, agent: e.agent });
        if (s) commit(retz(s, tz), false);
      }
    }
    lap("parse");

    let cfg: ConfigHistory = { schema: "wasitme.config/1", agents: {} };
    let proj: ProjHistory = { records: [] };
    let consumed: string[] = [];
    if (!ro) {
      cfg = loadConfigHistory(p.config);
      if (tzChanged) retzConfigHistory(cfg, tz);
      if (o.collectConfig !== false) updateConfigHistory(cfg, { hash, now, timeZone: tz, home: o.userHome, env: o.env });
      proj = loadProjHistory(p.projsnapHistory);
      consumed = ingestInbox(p.projsnapInbox, proj).consumed;
    }

    lap("snapshots");
    const exclude = loadExclude(p.exclude);
    report.excludeError = exclude.error;
    const evalNow = evaluationNow(now, o.until);
    const today = dayOf(evalNow, tz);
    const sandbox = sandboxed();
    // Analysis settings: the voting construct, the calibration in force, the layout, and the persisted decisions.
    const calibration = readCalibration(o.calibration === undefined ? SHIPPED_CALIBRATION : o.calibration, SCAN_ERRORS_VOTE);
    const lead: Lead = readLead(p.engineJson);
    report.lead = lead;
    const decisionKey: DecisionKey = { errorsVote: SCAN_ERRORS_VOTE, methodId: calibration.methodId, version: ATTRIBUTION_VERSION };
    const previousDecisions: ReadonlyMap<string, Decision> = ro ? new Map() : loadDecisions(p.decisions, decisionKey);
    // D64: each agent's previous daily evaluations (ready hold, ETA stability), persisted with the decisions.
    const previousProgress: ReadonlyMap<string, readonly EtaRecord[]> = ro ? new Map() : loadProgressHistory(p.decisions, decisionKey);
    const inputsDigest = (): string => sha(JSON.stringify({
      engine: ENGINE_VERSION, tz, today, until: o.until ? o.until.toISOString() : null, exclude: exclude.digest,
      roots: [...rootProblems].sort(),
      errorsVote: SCAN_ERRORS_VOTE, lead, calibration: calibrationKey(calibration), attribution: ATTRIBUTION_VERSION,
      sources: Object.keys(manifest.sources).sort().map((sid) => {
        const e = manifest.sources[sid]!;
        return [sid, e.fp, e.h, e.dep, e.pv, e.present];
      }),
      config: sha(serializeConfigHistory(cfg)),
      proj: sha(serializeProjHistory(proj)),
    }));
    let inputs = inputsDigest();

    /**
     * `decisions`: each agent's new decision (undefined when the last outputs are re-stamped: nothing was decided);
     * `progress`: each agent's progress records after this evaluation (D64), saved with the decisions.
     */
    const finish = (glance: Glance, snapshot: Snapshot, decisions?: ReadonlyMap<string, Decision>, progress?: ReadonlyMap<string, readonly EtaRecord[]>): void => {
      report.glance = glance;
      report.snapshot = snapshot;
      if (ro) return;
      if (!lock!.held()) throw new ScanFailure("internal", "the scan lock was taken over");
      // snapshot first: glance.json is what every surface watches, so it is the commit point. Then the decisions the
      // glance shows (persistence for the next scan), and the manifest with the inputs digest last.
      writeIfChanged(p.snapshot, serializeOutput(snapshot), 4 << 20);
      writeIfChanged(p.glance, serializeOutput(glance), 1 << 20);
      if (decisions) saveDecisions(p.decisions, decisionKey, decisions, progress);
      saveConfigHistory(p.config, cfg);
      saveProjHistory(p.projsnapHistory, proj);
      manifest.inputs = inputs;
      saveManifest(p, manifest);
      prunePriorCache(p.priors, present);
      removeConsumed(consumed);
      report.wrote = true;
      if (o.recordPermission !== false) {
        try { report.permission = recordPermissionFlag(p.engineJson, { probe: o.probe }); } catch { report.permission = null; }
      }
    };

    // A decision is a function of the digested inputs, except that a pending one is also confirmed by elapsed time
    // (>= 24 h of data time since its anchor): when that wait ended since the last evaluation, recompute.
    if (!ro && manifest.inputs === inputs && !persistenceDue(previousDecisions, evalNow)) {
      const again = restamp(p, now, sandbox);
      if (again) {
        report.reused = true;
        finish(again.glance, again.snapshot);
        lap("outputs");
        report.ms = performance.now() - t0;
        return report;
      }
    }

    // Full analysis: every shard (history included) is needed for the merge.
    const listedBySid = new Map(all.map((l) => [l.sid, l]));
    let rebuilt = false;
    for (const [sid, e] of Object.entries(manifest.sources)) {
      if (shards.has(sid)) continue;
      const s = ro ? undefined : readShard(join(p.shards, `${sid}.json`), { sid, agent: e.agent });
      if (s) {
        shards.set(sid, tzChanged ? retz(s, tz) : s);
        continue;
      }
      // Its manifest entry is intact but the shard is missing or damaged (an unsynced write lost in a crash, a
      // restore, a stray edit). Skipping it would drop the source from every later analysis without a word.
      const l = listedBySid.get(sid);
      if (l) {
        // The source is still on disk: rebuild its shard now.
        const r = await safeParse(l.reader, l.s, ctx);
        if (r) {
          commit(shardFromParse(e.agent, sid, l.fp, l.dep, usesOf(keyIds.get(e.agent)!, sid, r), pvByAgent.get(e.agent)!, tz, l.born, r), true, l.deps);
          report.parsed++;
          report.rebuiltShards++;
          if (unreadShards.delete(sid)) report.unchanged--;
          rebuilt = true;
        } else {
          report.failed++;
          e.fp = ""; // never a real fingerprint: the next scan re-parses it
          if (unreadShards.delete(sid)) report.unchanged--;
          rebuilt = true;
        }
      } else {
        // History only: its log is gone, so the loss cannot be repaired. Reported on every analysis (doctor).
        report.lostShards++;
      }
    }
    if (rebuilt) inputs = inputsDigest();
    const merged = mergeShards([...shards.values()], present);
    const observed = observedSessionsByDay(proj, tz);
    const previous = previousTimelines(p, ro);
    interface AgentRun {
      agent: AgentId;
      kept: readonly Exchange[];
      events: ChangeEvent[];
      firstDay: string | undefined;
      fullyObservedDays: string[];
      setup: Record<string, string | number | boolean>;
      known: string[] | null;
    }
    const runs: AgentRun[] = [];
    const sources: SourceHealth[] = [];
    for (const reader of readers) {
      const agent = reader.agent;
      const m = merged.get(agent);
      const nListed = listed.get(agent) ?? 0;
      if (nListed === 0 && (!m || m.historyOnly === 0)) {
        // No logs and no history: no agent to analyse (the documents stay "empty"), but a health row says where
        // nothing was found and why, so doctor and the empty report can name the problem.
        sources.push(absentHealth(agent, rootProblems.get(agent) ?? null));
        continue;
      }
      report.crossFileDuplicates += m?.crossFileDuplicates ?? 0;
      // The cutoff and the exclude list only: D47's interactive filter runs inside the analysis (metrics/cells.ts),
      // which needs every session to tell an automation-only one from a person's.
      const f = filterExchanges(m?.exchanges ?? [], exclude, o.until);
      report.excluded += f.excluded;
      report.afterCutoff += f.afterCutoff;
      const events = filterEvents(dedupeEvents([
        ...(m?.events ?? []),
        ...(cfg.agents[agent]?.events ?? []),
        ...(agent === "claude-code" ? projectEvents(proj, hash, tz) : []),
      ]), o.until);
      // History starts at the earliest exchange the analysis may use: after the exclude list and the --until cutoff
      // (an excluded project or date range is not history, so it cannot meet a tier's history requirement).
      let firstDay: string | undefined;
      for (const x of f.kept) if (firstDay === undefined || x.day < firstDay) firstDay = x.day;
      runs.push({
        agent, kept: f.kept, events, firstDay,
        fullyObservedDays: agent === "claude-code" ? fullyObservedDays(f.kept, cfg.agents[agent]?.days ?? [], observed, today) : [],
        setup: setupOf(agent, f.kept, cfg),
        known: previous ? [...(previous.get(agent) ?? [])] : null,
      });
      sources.push(sourceHealth(agent, m, nListed, f.kept, today, rootProblems.get(agent) ?? null));
    }
    const agentsOut = runs.map((r) => r.agent);
    const health: Health = {
      sources,
      parserVersions: healthParserVersions(new Map([...pvByAgent].filter(([a]) => agentsOut.includes(a)))),
      sandbox,
      paused: pausedFor(manifest, today, pvByAgent, agentsOut),
    };
    const generatedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    lap("merge");

    /** Attribution per agent, then the words layer's documents. Pure apart from the test hook. */
    const analyse = (prev: ReadonlyMap<string, Decision>, prevProgress: ReadonlyMap<string, readonly EtaRecord[]>): { built: BuiltOutputs; attributions: Attribution[] } => {
      const attributions: Attribution[] = [];
      for (const r of runs) {
        const a = attributeAgent(r.kept, r.events, {
          agent: r.agent, now: evalNow, timeZone: tz, errorsVote: SCAN_ERRORS_VOTE, metrics: SNAPSHOT_METRICS as MetricId[],
          calibrated: calibrationOf(calibration, r.agent).calibrated,
          previous: prev.get(r.agent) ?? null,
          progressHistory: prevProgress.get(r.agent) ?? [],
          fullyObservedDays: r.fullyObservedDays,
          ...(calibration.method !== null ? { method: calibration.method } : {}),
          ...(r.firstDay !== undefined && r.firstDay < today ? { firstDay: r.firstDay } : {}),
          ...(o.resamples !== undefined ? { resamples: o.resamples } : {}),
        });
        o.inspectAttribution?.(a);
        attributions.push(a);
      }
      lap("evaluate");
      const built = buildOutputs({
        engine: ENGINE_VERSION, generatedAt, scanOk: true, scanError: null, lead,
        agents: runs.map((r, i) => ({ attribution: attributions[i]!, setup: r.setup, knownEventIds: r.known })),
        health,
        calibration: contractCalibration(calibration, agentsOut),
      });
      lap("outputs");
      return { built, attributions };
    };
    type Attempt = { built: BuiltOutputs; attributions: Attribution[]; progress: ReadonlyMap<string, readonly EtaRecord[]> } | { error: unknown };
    const attempt = (prev: ReadonlyMap<string, Decision>, prevProgress: ReadonlyMap<string, readonly EtaRecord[]>): Attempt => {
      try {
        const r = analyse(prev, prevProgress);
        if (r.built.problems.length > 0) return { error: new ScanFailure("internal", `output failed the contract checks (${r.built.problems.length})`, r.built.problems) };
        // D64: today's record joins each agent's history (reading `progress` computes it; the words already did).
        const progress = new Map(r.attributions.map((a) => [a.evaluation.agent, nextHistory(prevProgress.get(a.evaluation.agent), a.evaluation.progress.record)]));
        return { ...r, progress };
      } catch (e) {
        return { error: e };
      }
    };
    let result = attempt(previousDecisions, previousProgress);
    if ("error" in result && (previousDecisions.size > 0 || previousProgress.size > 0)) {
      report.persistenceDropped = true;
      result = attempt(new Map(), new Map());
    }
    if ("error" in result) throw result.error;
    const { built, attributions, progress } = result;
    report.attributions = attributions;
    const decisions = new Map(attributions.map((a) => [a.evaluation.agent, a.decision]));
    const { glance, snapshot } = built;
    finish(glance, snapshot, decisions, progress);
    lap("outputs");
    report.ms = performance.now() - t0;
    return report;
  } catch (e) {
    // A scan whose lock was taken over writes nothing more: the glance on disk is the new holder's.
    if (!ro && lock!.held()) writeFailureGlance(p, errorKind(e), now);
    throw e;
  } finally {
    lock?.release();
  }
}
