/**
 * Decodes a snapshot (wasitme.snapshot/1) the way every surface must (docs/CONTRACT.md#display-rules; the reference
 * is engine/src/contract/display.ts), into a typed, sanitized model. Tolerant: it never throws, unknown values map to
 * the contract's no-claim defaults, and every string passes through sanitize.clean with the schema's bound.
 *
 * Reads only own properties (Object.hasOwn), so a "__proto__" key or a replaced prototype in the data can never
 * supply a value. Document-level display, first match wins:
 *   1. not an object, or schema is not exactly "wasitme.snapshot/1"  → mismatch (nothing shown)
 *   2. privacy.containsText is not the boolean false               → refused (nothing shown)
 *   3. generatedAt unparseable, older than staleAfterSec, or more than 300 s in the future → stale
 *   4. no agents                                                   → empty
 *   5. otherwise                                                   → ok
 * When the native app has already decided the display with its own clock (`view.document`), that decision is used
 * for rules 3–5 (and for its own states: loading, notSetUp, unreadable).
 */

import { clean, isBridgeId } from "./sanitize.js";
import { validDay } from "./format.js";

export const SNAPSHOT_SCHEMA = "wasitme.snapshot/1";
export const DEFAULT_STALE_AFTER_SEC = 7200;
export const FUTURE_TOLERANCE_SEC = 300;

export type State = "insufficient" | "none" | "unclear" | "you" | "agent";
export type Reason =
  | "calibration_pending" | "needs_data" | "single_indicator" | "mixed" | "workload" | "unknown_provenance"
  | "both_sides" | "nothing_recorded_on_your_side" | "blind_spot" | "by_elimination";
export type Side = "you" | "agent" | "unknown" | "meta";
export type Strength = "strong" | "weak" | "routine";
export type DocDisplay = "ok" | "stale" | "empty" | "mismatch" | "refused" | "loading" | "notSetUp" | "unreadable";
export type ScanError = "permission_denied" | "write_failed" | "timeout" | "internal";
export type Lead = "timeline" | "verdict";
export type MetricStatus = "worse" | "better" | "none" | "ineligible";
export type Role = "vote" | "support" | "context";

const STATES: readonly State[] = ["insufficient", "none", "unclear", "you", "agent"];
const REASONS: readonly Reason[] = ["calibration_pending", "needs_data", "single_indicator", "mixed", "workload",
  "unknown_provenance", "both_sides", "nothing_recorded_on_your_side", "blind_spot", "by_elimination"];
const SIDES: readonly Side[] = ["you", "agent", "unknown", "meta"];
const STRENGTHS: readonly Strength[] = ["strong", "weak", "routine"];
const SCAN_ERRORS: readonly ScanError[] = ["permission_denied", "write_failed", "timeout", "internal"];
const DISPLAYS: readonly DocDisplay[] = ["ok", "stale", "empty", "mismatch", "refused", "loading", "notSetUp", "unreadable"];
const STATUSES: readonly MetricStatus[] = ["worse", "better", "none", "ineligible"];
const ROLES: readonly Role[] = ["vote", "support", "context"];

export interface KN { k: number; n: number }
export interface Day { d: string; k: number; n: number }
export interface StripWindow { ratio: number | null; lo: number | null; hi: number | null; mde: number | null }
export interface Strip { metric: string; days: Day[]; window: StripWindow }
export interface Metric {
  id: string; label: string; unit: string; family: string | null; role: Role;
  recent: KN; baseline: KN; ratio: number | null; range: [number, number] | null; mde: number | null;
  status: MetricStatus; eligible: boolean; ineligibleReason: string | null; shifted: boolean | null;
  standardized: { ratio: number | null; range: [number, number] | null } | null; series: Day[];
}
export interface TEvent {
  id: string; t: string; day: string; kind: string; side: Side; strength: Strength; provenance: string | null;
  label: string; from: string; to: string; isNew: boolean;
  /** "1", "2" for your changes; "A", "B" for the agent's; "?" for unknown origin; null for wasitme's own (meta). */
  marker: string | null;
}
/** One unlock item's gate counts; null = not in the document (never shown as a count). */
export interface Gate { events: number | null; sessions: number | null; sessionDays: number | null }
export interface Unlock { metric: string; family: string | null; have: Gate; need: Gate }
export interface Progress { tier: number | null; etaDate: string | null; notAtCurrentPace: boolean; unlock: Unlock[] }
export interface Win { from: string; to: string; days: number; exchanges: number; sessions: number; sessionDays: number }
export interface Candidate { event: string; status: "open" | "ruled_out" | "background" | null; test: string | null }
export interface Confounder { id: string; moved: boolean | null; value: number | null }
export interface TraceStep { row: number; matched: boolean; text: string }
export interface Counts { exchanges: number; sessions: number; sessionDays: number; days: number }

export interface Agent {
  /** Cleaned for display. */
  id: string;
  /** The raw id when it is safe to send back over the bridge (selectAgent); else null. */
  bridgeId: string | null;
  name: string;
  state: State;
  reason: Reason | null;
  pending: boolean;
  calibrated: boolean;
  label: string; headline: string; because: string; tryThis: string; confidence: string;
  n: Counts | null;
  progress: Progress | null;
  strip: Strip | null;
  tier: number | null;
  windows: { recent: Win; baseline: Win } | null;
  metrics: Metric[];
  onset: { from: string; to: string } | null;
  timeline: TEvent[];
  candidates: Candidate[];
  confounders: Confounder[];
  observation: { fullyObservedDays: number; partiallyObservedDays: number; note: string } | null;
  setup: { key: string; value: string | number | boolean }[];
  trace: TraceStep[];
  disclaimer: string | null;
}

export interface Source {
  agent: string; name: string; found: boolean; files: number; badLines: number; truncatedTail: number; duplicates: number;
  unknownTypes: { key: string; count: number }[]; firstDay: string | null; lastDay: string | null; error: string | null;
}
export interface Health {
  sources: Source[]; parserVersions: { key: string; version: number }[]; sandbox: boolean | null;
  paused: { agent: string; metric: string; why: string }[];
}
export interface Calibration {
  artifactDate: string | null; methodId: string | null;
  agents: { agent: string; calibrated: boolean; sequences: number }[];
}

export type Freshness = { kind: "fresh" | "stale"; ageSec: number } | { kind: "future" | "unknown"; ageSec: null };

export interface Doc {
  display: DocDisplay;
  scanFailed: boolean;
  scanError: ScanError | null;
  lead: Lead;
  demo: boolean;
  engine: string;
  generatedAtMs: number | null;
  freshness: Freshness;
  agents: Agent[];
  health: Health | null;
  calibration: Calibration | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Tolerant readers: own properties only.
// ---------------------------------------------------------------------------------------------------------------

type Obj = { [key: string]: unknown };
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const arr = (o: unknown, k: string): unknown[] => { const v = own(o, k); return Array.isArray(v) ? v : []; };
const str = (o: unknown, k: string, max: number): string => clean(own(o, k), max);
const bool = (o: unknown, k: string): boolean => own(o, k) === true;
function numOr(o: unknown, k: string): number | null {
  const v = own(o, k);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** A count: a finite integer ≥ 0, clamped to the schema's ceiling; anything else is 0. */
function count(o: unknown, k: string): number {
  const v = numOr(o, k);
  return v === null || v < 0 ? 0 : Math.min(Math.floor(v), 1_000_000_000);
}
function posOr(o: unknown, k: string): number | null { const v = numOr(o, k); return v !== null && v >= 0 ? v : null; }
function member<T extends string>(list: readonly T[], v: unknown): v is T { return typeof v === "string" && (list as readonly string[]).includes(v); }
const dayOr = (o: unknown, k: string): string | null => validDay(own(o, k));

function kn(o: unknown): KN { return { k: count(o, "k"), n: count(o, "n") }; }
function range(o: unknown, k: string): [number, number] | null {
  const v = own(o, k);
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = v[0], b = v[1];
  return typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a ? [a, b] : null;
}
function days(list: unknown[]): Day[] {
  const out: Day[] = [];
  for (const x of list) {
    const d = validDay(own(x, "d"));
    if (d) out.push({ d, k: count(x, "k"), n: count(x, "n") });
  }
  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return out.filter((x, i) => i === 0 || out[i - 1]!.d !== x.d);
}

// ---------------------------------------------------------------------------------------------------------------
// Time (RFC 3339 with an explicit offset only; never guessed as local time).
// ---------------------------------------------------------------------------------------------------------------

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

export function parseGeneratedAt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = RFC3339.exec(raw);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), hh = Number(m[4]), mi = Number(m[5]);
  const dim = mo === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(mo) ? 30 : 31;
  if (mo < 1 || mo > 12 || d < 1 || d > dim || hh > 23 || mi > 59) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] === "60" ? "59" : m[6]}.${(m[7] ?? "").slice(0, 3).padEnd(3, "0")}${m[8] === "z" ? "Z" : m[8]}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function freshnessOf(generatedAtMs: number | null, staleAfterSec: number, nowMs: number): Freshness {
  if (generatedAtMs === null) return { kind: "unknown", ageSec: null };
  const age = (nowMs - generatedAtMs) / 1000;
  if (age < -FUTURE_TOLERANCE_SEC) return { kind: "future", ageSec: null };
  return { kind: age > staleAfterSec ? "stale" : "fresh", ageSec: Math.max(0, age) };
}

// ---------------------------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------------------------

export function agentName(rawId: unknown, cleaned: string): string {
  if (rawId === "claude-code") return "Claude Code";
  if (rawId === "codex") return "Codex";
  return cleaned || "Agent";
}

function metricOf(x: unknown, fromGlance: boolean): Metric | null {
  const id = str(x, "id", 32);
  if (!id) return null;
  const status: MetricStatus = member(STATUSES, own(x, "status")) ? (own(x, "status") as MetricStatus) : "ineligible";
  const eligibleRaw = own(x, "eligible");
  const eligible = typeof eligibleRaw === "boolean" ? eligibleRaw : status !== "ineligible";
  const ratio = eligible ? posOr(x, "ratio") : null;
  const r = eligible ? range(x, "range") : null;
  const mdeV = numOr(x, "mde");
  const st = own(x, "standardized");
  const shiftedRaw = own(x, "shifted");
  return {
    id, label: str(x, "label", 40) || id, unit: str(x, "unit", 24),
    family: typeof own(x, "family") === "string" ? str(x, "family", 16) : null,
    role: member(ROLES, own(x, "role")) ? (own(x, "role") as Role) : "context",
    recent: kn(own(x, "recent")), baseline: kn(own(x, "baseline")),
    ratio, range: r, mde: mdeV !== null && mdeV >= 1 ? mdeV : null,
    status, eligible,
    ineligibleReason: eligible ? null : (str(x, "ineligibleReason", 32) || null),
    shifted: typeof shiftedRaw === "boolean" ? shiftedRaw : fromGlance ? null : false,
    standardized: isObj(st) ? { ratio: posOr(st, "ratio"), range: range(st, "range") } : null,
    series: days(arr(x, "series")),
  };
}

function eventOf(x: unknown, i: number): TEvent | null {
  const day = dayOr(x, "day");
  if (!day) return null;
  const sideRaw = own(x, "side");
  const side: Side = member(SIDES, sideRaw) ? sideRaw : "unknown";      // an unknown side is never "agent"
  const stRaw = own(x, "strength");
  const strength: Strength = member(STRENGTHS, stRaw) ? stRaw : side === "meta" ? "routine" : "weak";
  return {
    id: str(x, "id", 40) || `e${i}`, t: str(x, "t", 40), day, kind: str(x, "kind", 24) || "change", side, strength,
    provenance: str(x, "provenance", 24) || null, label: str(x, "label", 60), from: str(x, "from", 60), to: str(x, "to", 60),
    isNew: bool(x, "new"), marker: null,
  };
}

/** Your changes are numbered 1, 2, 3; the agent's lettered A, B, C; over the whole timeline, oldest first. */
export function assignMarkers(timeline: TEvent[]): void {
  let you = 0, agent = 0;
  for (const e of timeline) {
    if (e.side === "you") e.marker = String(++you);
    else if (e.side === "agent") e.marker = letters(agent++);
    else if (e.side === "unknown") e.marker = "?";
    else e.marker = null;
  }
}
function letters(i: number): string {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/** A gate count, or null when the field is missing or not a count: an unknown count is never shown as "0 of 5". */
function gateCount(o: unknown, k: string): number | null {
  const v = numOr(o, k);
  return v === null || v < 0 ? null : Math.min(Math.floor(v), 1_000_000_000);
}
function gate(o: unknown): Gate { return { events: gateCount(o, "events"), sessions: gateCount(o, "sessions"), sessionDays: gateCount(o, "sessionDays") }; }

function win(o: unknown): Win | null {
  const from = dayOr(o, "from"), to = dayOr(o, "to");
  if (!from || !to || from > to) return null;
  return { from, to, days: count(o, "days"), exchanges: count(o, "exchanges"), sessions: count(o, "sessions"), sessionDays: count(o, "sessionDays") };
}

function agentOf(x: unknown, idx: number): Agent | null {
  const rawId = own(x, "agent");
  if (typeof rawId !== "string" || rawId === "") return null;
  const id = clean(rawId, 32) || `agent ${idx + 1}`;
  const stateRaw = own(x, "state");
  const state: State = member(STATES, stateRaw) ? stateRaw : "unclear";       // unknown state → unclear
  const reasonRaw = own(x, "reason");
  const reason: Reason | null = member(REASONS, reasonRaw) ? reasonRaw : null; // unknown reason → no claim

  // metrics: the snapshot's full list, else the glance's topMetrics
  const fromGlance = !Array.isArray(own(x, "metrics"));
  const metrics = (fromGlance ? arr(x, "topMetrics") : arr(x, "metrics")).map((m) => metricOf(m, fromGlance)).filter((m): m is Metric => m !== null);

  // timeline: the snapshot's full list (oldest first), else the glance's newest-first events
  let timeline: TEvent[];
  if (Array.isArray(own(x, "timeline"))) timeline = arr(x, "timeline").map(eventOf).filter((e): e is TEvent => e !== null);
  else timeline = arr(x, "events").map(eventOf).filter((e): e is TEvent => e !== null).reverse();
  timeline.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  assignMarkers(timeline);

  const s = own(x, "strip");
  const strip: Strip | null = isObj(s) && str(s, "metric", 32) ? {
    metric: str(s, "metric", 32),
    days: days(arr(s, "days")),
    window: (() => { const w = own(s, "window"); return { ratio: posOr(w, "ratio"), lo: posOr(w, "lo"), hi: posOr(w, "hi"), mde: posOr(w, "mde") }; })(),
  } : null;

  const p = own(x, "progress");
  const progress: Progress | null = isObj(p) ? {
    tier: numOr(p, "tier"), etaDate: dayOr(p, "etaDate"), notAtCurrentPace: bool(p, "notAtCurrentPace"),
    unlock: arr(p, "unlock").slice(0, 6).map((u) => ({ metric: str(u, "metric", 32), family: str(u, "family", 16) || null, have: gate(own(u, "have")), need: gate(own(u, "need")) })).filter((u) => u.metric !== ""),
  } : null;

  const w = own(x, "windows");
  const recent = win(own(w, "recent")), baseline = win(own(w, "baseline"));
  const n = own(x, "n");
  const o = own(x, "onset");
  const onsetFrom = dayOr(o, "from"), onsetTo = dayOr(o, "to");
  const ob = own(x, "observation");
  const setupObj = own(x, "setup");
  const setup: { key: string; value: string | number | boolean }[] = [];
  if (isObj(setupObj)) {
    for (const k of Object.keys(setupObj).slice(0, 40)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) continue;
      const v = setupObj[k];
      if (typeof v === "string") setup.push({ key: k, value: clean(v, 60) });
      else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") setup.push({ key: k, value: v });
    }
  }
  const disc = str(x, "disclaimer", 160);
  return {
    id, bridgeId: isBridgeId(rawId) ? rawId : null, name: agentName(rawId, id), state, reason,
    pending: bool(x, "pending"), calibrated: bool(x, "calibrated"),
    label: str(x, "label", 24), headline: str(x, "headline", 80), because: str(x, "because", 200),
    tryThis: str(x, "tryThis", 160), confidence: str(x, "confidence", 160),
    n: isObj(n) ? { exchanges: count(n, "exchanges"), sessions: count(n, "sessions"), sessionDays: count(n, "sessionDays"), days: count(n, "days") } : null,
    progress, strip,
    tier: numOr(x, "tier"),
    windows: recent && baseline ? { recent, baseline } : null,
    metrics, onset: onsetFrom && onsetTo ? { from: onsetFrom, to: onsetTo } : null,
    timeline,
    candidates: arr(x, "candidates").slice(0, 50).map((c) => ({
      event: str(c, "event", 40),
      status: member(["open", "ruled_out", "background"] as const, own(c, "status")) ? (own(c, "status") as Candidate["status"]) : null,
      test: str(c, "test", 24) || null,
    })),
    confounders: arr(x, "confounders").slice(0, 12).map((c) => ({
      id: str(c, "id", 32), moved: typeof own(c, "moved") === "boolean" ? (own(c, "moved") as boolean) : null, value: numOr(c, "value"),
    })).filter((c) => c.id !== ""),
    observation: isObj(ob) ? { fullyObservedDays: count(ob, "fullyObservedDays"), partiallyObservedDays: count(ob, "partiallyObservedDays"), note: str(ob, "note", 160) } : null,
    setup,
    trace: arr(x, "trace").slice(0, 14).map((t) => ({ row: count(t, "row"), matched: bool(t, "matched"), text: str(t, "text", 200) })).filter((t) => t.row >= 1 && t.row <= 14),
    disclaimer: disc || null,
  };
}

function healthOf(h: unknown): Health | null {
  if (!isObj(h)) return null;
  const pv = own(h, "parserVersions");
  const parserVersions: { key: string; version: number }[] = [];
  if (isObj(pv)) for (const k of Object.keys(pv).slice(0, 24)) {
    const v = pv[k];
    if (/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k) && typeof v === "number" && Number.isInteger(v)) parserVersions.push({ key: k, version: v });
  }
  const sb = own(h, "sandbox");
  return {
    sources: arr(h, "sources").slice(0, 8).map((s) => {
      const raw = own(s, "agent");
      const id = clean(raw, 32);
      const ut = own(s, "unknownTypes");
      const unknownTypes: { key: string; count: number }[] = [];
      if (isObj(ut)) for (const k of Object.keys(ut).slice(0, 64)) {
        const c = ut[k];
        if (typeof c === "number" && Number.isFinite(c)) unknownTypes.push({ key: clean(k, 60), count: Math.max(0, Math.floor(c)) });
      }
      return {
        agent: id, name: agentName(raw, id), found: bool(s, "found"), files: count(s, "files"), badLines: count(s, "badLines"),
        truncatedTail: count(s, "truncatedTail"), duplicates: count(s, "duplicates"), unknownTypes,
        firstDay: dayOr(s, "firstDay"), lastDay: dayOr(s, "lastDay"), error: str(s, "error", 24) || null,
      };
    }).filter((s) => s.agent !== ""),
    parserVersions,
    sandbox: typeof sb === "boolean" ? sb : null,
    paused: arr(h, "paused").slice(0, 48).map((p) => ({ agent: str(p, "agent", 32), metric: str(p, "metric", 32), why: str(p, "why", 32) })),
  };
}

function calibrationOf(c: unknown): Calibration | null {
  if (!isObj(c)) return null;
  return {
    artifactDate: dayOr(c, "artifactDate"), methodId: str(c, "methodId", 40) || null,
    agents: arr(c, "agents").slice(0, 8).map((a) => ({ agent: str(a, "agent", 32), calibrated: bool(a, "calibrated"), sequences: count(a, "sequences") })),
  };
}

export interface DecodeOptions {
  nowMs: number;
  /** The native app's own decision (GlanceDisplay.document), if it sent one. */
  viewDocument?: unknown;
}

const blank = (display: DocDisplay): Doc => ({
  display, scanFailed: false, scanError: null, lead: "timeline", demo: false, engine: "", generatedAtMs: null,
  freshness: { kind: "unknown", ageSec: null }, agents: [], health: null, calibration: null,
});

export function decodeSnapshot(raw: unknown, opt: DecodeOptions): Doc {
  const vd = member(DISPLAYS, opt.viewDocument) ? opt.viewDocument : null;
  // The native app's own document states: nothing from the document is drawn.
  if (vd === "loading" || vd === "notSetUp" || vd === "unreadable" || vd === "mismatch" || vd === "refused") return blank(vd);
  if (raw === null || raw === undefined) return blank(vd === "empty" ? "empty" : "loading");
  if (!isObj(raw) || own(raw, "schema") !== SNAPSHOT_SCHEMA) return blank("mismatch");
  const priv = own(raw, "privacy");
  if (!isObj(priv) || own(priv, "containsText") !== false) return blank("refused");

  const gen = parseGeneratedAt(own(raw, "generatedAt"));
  const sa = numOr(raw, "staleAfterSec");
  const staleAfter = sa !== null && sa > 0 ? sa : DEFAULT_STALE_AFTER_SEC;
  const freshness = freshnessOf(gen, staleAfter, opt.nowMs);
  const agents = arr(raw, "agents").slice(0, 8).map(agentOf).filter((a): a is Agent => a !== null);
  const stale = vd !== null ? vd === "stale" : freshness.kind !== "fresh";
  const display: DocDisplay = stale ? "stale" : agents.length === 0 ? "empty" : "ok";
  const se = own(raw, "scanError");
  const scanOk = own(raw, "scanOk") === true;
  return {
    display,
    scanFailed: !scanOk,
    scanError: scanOk ? null : member(SCAN_ERRORS, se) ? se : "internal",
    lead: own(raw, "lead") === "verdict" ? "verdict" : "timeline",
    demo: own(raw, "demo") === true,
    engine: str(raw, "engine", 32),
    generatedAtMs: gen,
    freshness,
    agents,
    health: healthOf(own(raw, "health")),
    calibration: calibrationOf(own(raw, "calibration")),
  };
}
