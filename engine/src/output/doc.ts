/**
 * The document every renderer works from: a parsed `snapshot.json` (or, as a degraded fallback, `glance.json`) made
 * SAFE and COMPLETE, whatever the file held. The terminal, Markdown, HTML and status views never touch raw JSON:
 *
 *  - the consumer display rules run first (`decodeDocument`, docs/CONTRACT.md): a different schema id is "mismatch", a
 *    file that does not promise `privacy.containsText: false` is "refused" (nothing is drawn), an old or future-dated
 *    `generatedAt` is "stale", no agents is "empty";
 *  - every string is cleaned (`clean`: no C0/C1 controls, bidi marks or zero-width characters) and cut to the
 *    contract's length bound; every number is finite; every list is bounded; enums decode with the contract's
 *    tolerant rules (an unknown state is `unclear`, an unknown side is `unknown`);
 *  - a glance fills the snapshot-only parts with empty values (its `events` become a thin timeline), so one renderer
 *    serves both files.
 *
 * Nothing here throws: a field that is missing or the wrong type reads as empty.
 */
import { decodeDocument, type DocumentDisplay } from "../contract/display.js";
import type { GlanceMetric, Progress, SampleCounts, Strip, Unlock } from "../contract/glance.js";
import type {
  Calibration, Candidate, Confounder, ConfounderId, Observation, SnapshotAgent, SnapshotMetric, SourceError, TimelineEvent, TraceStep, Window,
} from "../contract/snapshot.js";
import {
  CHANGE_PROVENANCES, CHANGE_STRENGTHS, GLANCE_SCHEMA_ID, INELIGIBLE_REASONS, LEADS, METRIC_FAMILIES, METRIC_ROLES, METRIC_STATUSES,
  SCAN_ERRORS, SNAPSHOT_SCHEMA_ID, decodeLead, decodeReason, decodeSide, decodeState,
  type ChangeProvenance, type ChangeStrength, type IneligibleReason, type Lead, type MetricFamily, type MetricRole, type MetricStatus, type ScanError,
} from "../contract/vocab.js";
import { clip, clean } from "./text.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The same lengths the contract schema and `words.LIMITS` use. */
const MAX = { label: 24, headline: 80, because: 200, tryThis: 160, confidence: 160, band: 100, statusLine: 80, eventLabel: 60, metricLabel: 40, metricUnit: 24, note: 160, trace: 200 } as const;

const str = (v: unknown, max: number): string => clip(clean(v), max);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(1e9, Math.round(v)) : 0);
const bool = (v: unknown): boolean => v === true;
function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}
function nullableOneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string => (typeof v === "string" && DAY.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ? v : "");
const dayOrNull = (v: unknown): string | null => day(v) || null;
/** Identifier-shaped ids (metric ids, event ids): anything else becomes a fixed placeholder. */
const idOf = (v: unknown, fallback: string): string => (typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/.test(v) ? v : fallback);
const kn = (v: unknown): { k: number; n: number } => (isObj(v) ? { k: count(v.k), n: count(v.n) } : { k: 0, n: 0 });
function range(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const lo = num(v[0]), hi = num(v[1]);
  return lo !== null && hi !== null && lo > 0 && hi >= lo ? [lo, hi] : null;
}
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

function coerceMetric(v: unknown, snapshot: boolean): SnapshotMetric | null {
  if (!isObj(v)) return null;
  const ratio = positive(v.ratio);
  const rg = range(v.range);
  const ineligible = nullableOneOf(INELIGIBLE_REASONS as readonly IneligibleReason[], v.ineligibleReason);
  const status: MetricStatus = oneOf(METRIC_STATUSES, v.status, "ineligible");
  const eligible = snapshot ? v.eligible === true : status !== "ineligible";
  const sev = (series: unknown) => list(series, 200).flatMap((d) => (isObj(d) && day(d.d) ? [{ d: day(d.d), k: count(d.k), n: count(d.n) }] : []));
  return {
    id: idOf(v.id, "other"),
    label: str(v.label, MAX.metricLabel),
    unit: str(v.unit, MAX.metricUnit),
    family: nullableOneOf(METRIC_FAMILIES as readonly MetricFamily[], v.family),
    role: oneOf(METRIC_ROLES as readonly MetricRole[], v.role, "context"),
    recent: kn(v.recent),
    baseline: kn(v.baseline),
    ratio: eligible ? ratio : null,
    range: eligible ? rg : null,
    mde: positive(v.mde),
    status,
    eligible,
    ineligibleReason: eligible ? null : (ineligible ?? "no_data"),
    sensitive: bool(v.sensitive),
    shifted: bool(v.shifted),
    standardized: isObj(v.standardized) ? { ratio: positive(v.standardized.ratio), range: range(v.standardized.range) } : null,
    series: sev(v.series),
  };
}

function coerceStrip(v: unknown): Strip | null {
  if (!isObj(v)) return null;
  const days = list(v.days, 42).flatMap((d) => (isObj(d) && day(d.d) ? [{ d: day(d.d), k: count(d.k), n: count(d.n) }] : []));
  // The strip is drawn left to right in date order; a file that is out of order (or repeats a day) is not drawn.
  const ordered = days.every((d, i) => i === 0 || d.d > days[i - 1]!.d);
  if (days.length === 0 || !ordered) return null;
  const w = isObj(v.window) ? v.window : {};
  return { metric: idOf(v.metric, "other"), days, window: { ratio: positive(w.ratio), lo: positive(w.lo), hi: positive(w.hi), mde: positive(w.mde) } };
}

function coerceProgress(v: unknown): Progress | null {
  if (!isObj(v)) return null;
  // Gate counts must all be counts: an item with a missing or invalid one is dropped, never shown as "0 of 5".
  const isCount = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
  const gate = (g: unknown) => (isObj(g) && isCount(g.events) && isCount(g.sessions) && isCount(g.sessionDays)
    ? { events: count(g.events), sessions: count(g.sessions), sessionDays: count(g.sessionDays) } : null);
  const unlock: Unlock[] = list(v.unlock, 6).flatMap((u) => {
    if (!isObj(u)) return [];
    const have = gate(u.have), need = gate(u.need);
    if (have === null || need === null) return [];
    return [{ metric: idOf(u.metric, "other"), family: nullableOneOf(METRIC_FAMILIES as readonly MetricFamily[], u.family), have, need }];
  });
  const tier = v.tier === 1 || v.tier === 2 || v.tier === 3 ? v.tier : 1;
  const notAtCurrentPace = bool(v.notAtCurrentPace);
  return { tier, etaDate: notAtCurrentPace ? null : dayOrNull(v.etaDate), notAtCurrentPace, unlock };
}

function coerceWindow(v: unknown): Window | null {
  if (!isObj(v) || !day(v.from) || !day(v.to)) return null;
  return { from: day(v.from), to: day(v.to), days: count(v.days), exchanges: count(v.exchanges), sessions: count(v.sessions), sessionDays: count(v.sessionDays) };
}

function coerceEvent(v: unknown, i: number, fromGlance: boolean): TimelineEvent | null {
  if (!isObj(v) || !day(v.day)) return null;
  const strength: ChangeStrength = oneOf(CHANGE_STRENGTHS as readonly ChangeStrength[], v.strength, "weak");
  const provenance: ChangeProvenance = oneOf(CHANGE_PROVENANCES as readonly ChangeProvenance[], v.provenance, "log_field");
  return {
    id: fromGlance ? `g-${i}` : idOf(v.id, `x-${i}`),
    t: `${day(v.day)}T00:00:00Z`,
    day: day(v.day),
    kind: idOf(v.kind, "other"),
    side: decodeSide(v.side),
    strength,
    provenance,
    label: str(v.label, MAX.eventLabel),
    from: str(v.from, 60),
    to: str(v.to, 60),
    new: bool(v.new),
  };
}

const CONFOUNDER_IDS: readonly ConfounderId[] = ["prompt_length", "long_context_share", "mode_mix", "entrypoint_mix", "subagent_mix", "interactive_mix", "project_mix", "no_overlap"];

function coerceAgent(v: unknown): SnapshotAgent | null {
  if (!isObj(v) || typeof v.agent !== "string" || v.agent === "") return null;
  const snapshot = Array.isArray(v.timeline) || Array.isArray(v.metrics);
  const metricSource = snapshot && Array.isArray(v.metrics) ? v.metrics : v.topMetrics;
  const metrics = list(metricSource, 12).flatMap((m) => {
    const c = coerceMetric(m, snapshot);
    return c === null ? [] : [c];
  });
  const timelineSource = snapshot && Array.isArray(v.timeline) ? v.timeline : v.events;
  const events = list(timelineSource, 500).flatMap((e, i) => {
    const c = coerceEvent(e, i, !snapshot);
    return c === null ? [] : [c];
  });
  // The timeline is drawn oldest first; sort a glance's newest-first events (stable for equal days).
  const timeline = events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.day < b.e.day ? -1 : a.e.day > b.e.day ? 1 : a.i - b.i)).map((x) => x.e);
  const ids = new Set(timeline.map((e) => e.id));
  const candidates: Candidate[] = list(v.candidates, 40).flatMap((c) => (isObj(c) && typeof c.event === "string" && ids.has(c.event) ? [{
    event: c.event,
    status: oneOf(["open", "ruled_out", "background"] as const, c.status, "background"),
    test: nullableOneOf(["strata", "version_boundary", "routine"] as const, c.test),
  }] : []));
  const confounders: Confounder[] = list(v.confounders, 12).flatMap((c) => (isObj(c) && (CONFOUNDER_IDS as readonly unknown[]).includes(c.id) ? [{
    id: c.id as ConfounderId, moved: c.moved === true ? true : c.moved === false ? false : null, value: num(c.value),
  }] : []));
  const trace: TraceStep[] = list(v.trace, 14).flatMap((t) => (isObj(t) && Number.isInteger(t.row) ? [{ row: t.row as number, matched: bool(t.matched), text: str(t.text, MAX.trace) }] : []));
  const n = isObj(v.n) ? v.n : {};
  const sample: SampleCounts = { exchanges: count(n.exchanges), sessions: count(n.sessions), sessionDays: count(n.sessionDays), days: count(n.days) };
  const w = isObj(v.windows) ? v.windows : {};
  const recent = coerceWindow(w.recent), baseline = coerceWindow(w.baseline);
  const o = isObj(v.onset) && day(v.onset.from) && day(v.onset.to) ? { from: day(v.onset.from), to: day(v.onset.to) } : null;
  const ob = isObj(v.observation) ? v.observation : {};
  const observation: Observation = { fullyObservedDays: count(ob.fullyObservedDays), partiallyObservedDays: count(ob.partiallyObservedDays), note: str(ob.note, MAX.note) };
  const state = decodeState(v.state);
  return {
    agent: clip(clean(v.agent), 32) || "agent",
    state,
    reason: decodeReason(v.reason),
    pending: bool(v.pending),
    calibrated: bool(v.calibrated),
    label: str(v.label, MAX.label),
    headline: str(v.headline, MAX.headline),
    because: str(v.because, MAX.because),
    tryThis: str(v.tryThis, MAX.tryThis),
    confidence: str(v.confidence, MAX.confidence),
    band: str(v.band, MAX.band),
    statusLine: str(v.statusLine, MAX.statusLine),
    n: sample,
    progress: coerceProgress(v.progress),
    topMetrics: metrics.slice(0, 3) as GlanceMetric[],
    strip: coerceStrip(v.strip),
    events: [],
    tier: v.tier === 1 || v.tier === 2 || v.tier === 3 ? v.tier : null,
    windows: recent !== null && baseline !== null ? { recent, baseline } : null,
    metrics,
    onset: o,
    timeline,
    candidates,
    confounders,
    observation,
    setup: {},
    trace,
    disclaimer: typeof v.disclaimer === "string" ? str(v.disclaimer, MAX.because) : null,
  };
}

function coerceCalibration(v: unknown): Calibration {
  if (!isObj(v)) return { artifactDate: null, methodId: null, agents: [] };
  const rate = (r: unknown): number | null => (typeof r === "number" && Number.isFinite(r) && r >= 0 && r <= 1 ? r : null);
  return {
    artifactDate: dayOrNull(v.artifactDate),
    methodId: typeof v.methodId === "string" ? str(v.methodId, 40) : null,
    agents: list(v.agents, 8).flatMap((a) => (isObj(a) && typeof a.agent === "string" ? [{
      agent: clip(clean(a.agent), 32), calibrated: bool(a.calibrated), sequences: count(a.sequences), falseChanged: rate(a.falseChanged), falseAgent: rate(a.falseAgent),
    }] : [])),
  };
}

export interface ReportDoc {
  /** Which file this came from. */
  source: "snapshot" | "glance";
  display: DocumentDisplay;
  /** Epoch ms of `generatedAt`, or null when it did not parse. */
  generatedAtMs: number | null;
  generatedAt: string;
  engine: string;
  demo: boolean;
  scanOk: boolean;
  scanError: ScanError | null;
  lead: Lead;
  agents: SnapshotAgent[];
  calibration: Calibration;
  /**
   * Where the logs were looked for, per agent (the snapshot's `health.sources`: found, and the listing problem if any).
   * Empty for a glance, a demo, or no file. Lets an empty report say "not found" vs "not readable".
   */
  sources: DocSource[];
  /**
   * `read`: the document came from a results file (or a scan). `missing`: there is no results file yet (nothing was
   * scanned). `damaged`: a results file exists but is not valid JSON. Only an empty document is ever missing or damaged.
   */
  file: "read" | "missing" | "damaged";
}

export interface DocSource { agent: string; found: boolean; error: SourceError | null }

const SOURCE_ERRORS: readonly SourceError[] = ["not_found", "permission_denied", "protected_folder", "unreadable"];

function coerceSources(raw: Obj): DocSource[] {
  const h = isObj(raw.health) ? raw.health : null;
  if (h === null) return [];
  return list(h.sources, 8).flatMap((s) => (isObj(s) && typeof s.agent === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(s.agent)
    ? [{ agent: s.agent, found: s.found === true, error: nullableOneOf(SOURCE_ERRORS, s.error) }]
    : []));
}

/**
 * An empty document with the given display state (nothing was read, or what was read cannot be drawn). `file` says
 * why nothing was read (no results file yet, or a damaged one); a scanned-but-empty document comes from `coerceDoc`.
 */
export function emptyDoc(display: DocumentDisplay = "empty", file: ReportDoc["file"] = "read"): ReportDoc {
  return {
    source: "snapshot", display, generatedAtMs: null, generatedAt: "", engine: "", demo: false, scanOk: true, scanError: null, lead: "timeline",
    agents: [], calibration: { artifactDate: null, methodId: null, agents: [] }, sources: [], file,
  };
}

/** Make a parsed snapshot or glance safe to render (see the file header). `nowMs` drives the stale rule. */
export function coerceDoc(raw: unknown, nowMs: number): ReportDoc {
  const isSnapshot = isObj(raw) && raw.schema === SNAPSHOT_SCHEMA_ID;
  const isGlance = isObj(raw) && raw.schema === GLANCE_SCHEMA_ID;
  const decoded = decodeDocument(raw, isGlance ? GLANCE_SCHEMA_ID : SNAPSHOT_SCHEMA_ID, nowMs);
  if (!isObj(raw) || (!isSnapshot && !isGlance) || decoded.display === "mismatch" || decoded.display === "refused") {
    return emptyDoc(decoded.display === "refused" ? "refused" : "mismatch");
  }
  const agents = list(raw.agents, 8).flatMap((a) => {
    const c = coerceAgent(a);
    return c === null ? [] : [c];
  });
  // A repeated agent id keeps its first entry (the contract forbids duplicates).
  const seen = new Set<string>();
  const unique = agents.filter((a) => (seen.has(a.agent) ? false : (seen.add(a.agent), true)));
  const at = typeof raw.generatedAt === "string" ? raw.generatedAt : "";
  const ms = Date.parse(at);
  return {
    source: isSnapshot ? "snapshot" : "glance",
    display: unique.length === 0 && decoded.display === "ok" ? "empty" : decoded.display,
    generatedAtMs: Number.isFinite(ms) ? ms : null,
    generatedAt: str(at, 40),
    engine: str(raw.engine, 32),
    demo: raw.demo === true,
    scanOk: raw.scanOk === true,
    scanError: nullableOneOf(SCAN_ERRORS as readonly ScanError[], raw.scanError) ?? (raw.scanOk === true ? null : "internal"),
    lead: decodeLead(raw.lead) ?? (LEADS[0] as Lead),
    agents: unique,
    calibration: coerceCalibration(raw.calibration),
    sources: isSnapshot && raw.demo !== true ? coerceSources(raw) : [],
    file: "read",
  };
}
