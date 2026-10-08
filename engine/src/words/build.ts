/**
 * The bridge from attribution results to the two contract documents (glance.v1, snapshot.v1). Pure, no file I/O:
 * WP-12's scan calls `buildOutputs` and writes what it returns; WP-30 renders `words` for the terminal and the report.
 *
 *   buildOutputs({ engine, generatedAt, scanOk, scanError, lead, agents: [{ attribution, setup, knownEventIds }],
 *                  health, calibration }) → { glance, snapshot, words, problems }
 *
 * `problems` lists everything that would make the documents wrong: the contract's semantic checks (`checkGlance`,
 * `checkSnapshot` with the copy lint), the words lints (glance words, "verdict", length bounds), the size ceilings, an
 * unparseable `generatedAt`, a calibration table that disagrees with an agent. It is empty for good output. The caller
 * must not write the documents when it is not empty (keep the previous files; report scanError "internal").
 *
 * Assembly rules:
 *  - Agents are engine-ordered: calibrated agents first, then timeline-only ones, otherwise in input order
 *    (single-glyph surfaces speak for agents[0]).
 *  - Timeline-only agents (calibration_pending) carry no metrics, strip, progress, windows, tier or confounders.
 *  - The snapshot timeline is every dated event (reader, configsnap, derived `d-…`, tripwire `t-…`), oldest first,
 *    at most 500 (candidates always kept); ids longer than 40 are replaced by a stable short hash everywhere.
 *  - Glance events: the newest 5 that are not wasitme's own writes or prompt hashes; `new` = not in `knownEventIds`.
 *  - Snapshot metrics: the bounded indicators only (tool-error constructs, reads per edit, edits without reading first, interruptions,
 *    pushback, churn) — raw token / millisecond totals could exceed the contract's integer counts.
 *  - `setup` is sanitised: keys `^[A-Za-z][A-Za-z0-9]{0,31}$`, ≤ 40; values: numbers, booleans, or clean labels.
 */
import type { Attribution } from "../analysis/attribution/pipeline.js";
import { checkGlance, checkSnapshot } from "../contract/check.js";
import { parseGeneratedAt } from "../contract/display.js";
import type { Glance, GlanceAgent, GlanceEvent, GlanceMetric, Progress, Strip } from "../contract/glance.js";
import type { Calibration, Health, Snapshot, SnapshotAgent, SnapshotMetric, TimelineEvent } from "../contract/snapshot.js";
import {
  DEFAULT_STALE_AFTER_SEC, GLANCE_MAX_BYTES, GLANCE_SCHEMA_ID, SNAPSHOT_MAX_BYTES, SNAPSHOT_SCHEMA_ID,
  type Lead, type MetricFamily, type MetricStatus, type ScanError,
} from "../contract/vocab.js";
import { cleanLabel } from "../util.js";
import { factsOf, safeEventId, type Facts, type MetricFact } from "./facts.js";
import { lintAgentWords } from "./lint.js";
import { fieldValue } from "./names.js";
import { glanceEventFacts, leadMetric, topMetricIds, wordsFor, type AgentWords } from "./words.js";

export interface AgentOutputInput {
  /** One agent's attribution (WP-21 `attributeAgent`). */
  attribution?: Attribution;
  /** Or hand-built facts (tests, `wasitme demo`). Exactly one of the two. */
  facts?: Facts;
  /** Current setup: counts and allow-listed labels (sanitised here). */
  setup?: Readonly<Record<string, unknown>>;
  /** Event ids the previous snapshot's timeline held; null/absent marks nothing new. */
  knownEventIds?: readonly string[] | null;
}

export interface BuildOutputsInput {
  /** Engine version (≤ 32). */
  engine: string;
  /** RFC 3339 with an explicit offset. */
  generatedAt: string;
  staleAfterSec?: number;
  scanOk: boolean;
  scanError?: ScanError | null;
  demo?: boolean;
  /** D28 layout (default "timeline"). */
  lead?: Lead;
  agents: readonly AgentOutputInput[];
  health?: Health;
  calibration?: Calibration;
}

export interface BuiltOutputs {
  glance: Glance;
  snapshot: Snapshot;
  /** Per agent, in the documents' order: every string, plus the CLI/report lines for both lead variants. */
  words: AgentWords[];
  facts: Facts[];
  /** Empty for good output; otherwise do not write (see the file header). */
  problems: string[];
}

/** Indicators the snapshot lists (bounded integer totals), in display order. */
export const SNAPSHOT_METRICS: readonly string[] = ["toolErrors", "toolErrorsNonCmd", "cmdFailures", "readsPerEdit", "blindEdits", "interrupts", "pushback", "churn"];

const MAX_TIMELINE = 500;
const STRIP_DAYS = 42;
const SERIES_DAYS = 200;

/** The contract's integer count ceiling (1e9). */
const cap = (v: number): number => Math.min(1e9, v);
const capDay = (d: { d: string; k: number; n: number }) => ({ d: d.d, k: cap(d.k), n: cap(d.n) });
const family = (m: MetricFact): MetricFamily | null => (m.family === "context" ? null : m.family);
const status = (m: MetricFact): MetricStatus => (!m.eligible ? "ineligible" : m.status === "worse" || m.status === "better" ? m.status : "none");

function glanceMetric(m: MetricFact, w: AgentWords): GlanceMetric {
  const t = w.metrics.find((x) => x.id === m.id)!;
  const shown = m.eligible && m.ratio !== null;
  return {
    id: m.id, label: t.label, unit: t.unit, family: family(m), role: m.role,
    recent: { k: cap(m.recent.k), n: cap(m.recent.n) }, baseline: { k: cap(m.baseline.k), n: cap(m.baseline.n) },
    ratio: shown ? m.ratio : null, range: shown ? m.range : null, mde: m.mde, status: status(m),
  };
}

function stripOf(f: Facts): Strip | null {
  if (!f.calibrated) return null;
  const id = leadMetric(f);
  const m = id === null ? undefined : f.metrics.find((x) => x.id === id);
  if (m === undefined || m.daily.length === 0) return null;
  const shown = m.eligible && m.ratio !== null && m.range !== null;
  return {
    metric: m.id,
    days: m.daily.slice(-STRIP_DAYS).map(capDay),
    window: { ratio: shown ? m.ratio : null, lo: shown ? m.range![0] : null, hi: shown ? m.range![1] : null, mde: m.mde },
  };
}

function progressOf(f: Facts): Progress | null {
  const p = f.progress;
  if (p === null || !f.calibrated || f.state !== "insufficient" || p.reason === "ready") return null;
  // An unlock item is a gate shortfall (the schema's "one gate shortfall"): an indicator waiting only for history or for
  // an interval has no gate count to show, and sending its window as 0 of 10 would say there is no data. The headline
  // already says what is missing then.
  const unlock = p.unlock
    .filter((u) => u.state === "ineligible" && !u.fieldsMissing && u.metric !== "interrupts" && u.blocking.length > 0)
    .slice(0, 6)
    .map((u) => ({ metric: u.metric, family: u.family === "context" ? null : u.family, have: { ...u.have }, need: { ...u.need } }));
  return { tier: p.tier, etaDate: p.notAtCurrentPace ? null : p.etaDate, notAtCurrentPace: p.notAtCurrentPace, unlock };
}

/** Facts already carry contract-safe ids; hand-built facts are held to the same rule. */
const safeId = safeEventId;

function sanitiseSetup(setup: Readonly<Record<string, unknown>> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (setup === undefined || setup === null || typeof setup !== "object") return out;
  for (const [k, v] of Object.entries(setup)) {
    if (Object.keys(out).length >= 40) break;
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") {
      const s = cleanLabel(v);
      if (s !== undefined && s.length <= 60) out[k] = s;
    }
  }
  return out;
}

function agentDocs(f: Facts, w: AgentWords, input: AgentOutputInput): { glance: GlanceAgent; snapshot: SnapshotAgent } {
  const known = input.knownEventIds === null || input.knownEventIds === undefined ? null : new Set(input.knownEventIds);
  const isNew = (id: string) => known !== null && !known.has(id);
  const win = f.windows;
  // Both windows of the tier in use (DESIGN.md §3: the confidence line adds the windows). Exchanges, session-days and
  // days add up exactly (each belongs to one window); sessions are counted DISTINCT across the windows, so a session
  // active on both sides of the boundary counts once (D59) and `n.sessions` says what the confidence line says.
  const n = {
    exchanges: cap((win?.recent.exchanges ?? 0) + (win?.baseline.exchanges ?? 0)),
    sessions: cap(win?.sessions ?? 0),
    sessionDays: cap((win?.recent.sessionDays ?? 0) + (win?.baseline.sessionDays ?? 0)),
    days: cap((win?.recent.activeDays ?? 0) + (win?.baseline.activeDays ?? 0)),
  };
  const events: GlanceEvent[] = glanceEventFacts(f).slice(0, 5).map((e) => ({
    day: e.day, kind: e.kind, side: e.side, strength: e.strength, label: w.eventLabels[e.id]!, new: isNew(e.id),
  }));
  const top = topMetricIds(f).map((id) => glanceMetric(f.metrics.find((m) => m.id === id)!, w));
  const glance: GlanceAgent = {
    agent: f.agent, state: f.state, reason: f.reason, pending: f.pending, calibrated: f.calibrated,
    label: w.label, headline: w.headline, because: w.because, tryThis: w.tryThis, confidence: w.confidence,
    band: f.state === "you" || f.state === "agent" ? w.band : "", statusLine: w.statusLine,
    n, progress: progressOf(f), topMetrics: top, strip: stripOf(f), events,
  };

  // Timeline: every dated event, oldest first; candidates are always kept when the list is capped.
  const candidateIds = new Set(f.candidates.filter((c) => !c.undated).map((c) => c.event));
  let tl = f.events;
  if (tl.length > MAX_TIMELINE) {
    const keepOthers = MAX_TIMELINE - tl.filter((e) => candidateIds.has(e.id)).length;
    const others = tl.filter((e) => !candidateIds.has(e.id));
    const dropped = new Set(others.slice(0, Math.max(0, others.length - keepOthers)).map((e) => e.id));
    tl = tl.filter((e) => !dropped.has(e.id));
  }
  const timeline: TimelineEvent[] = tl.map((e) => ({
    id: safeId(e.id), t: e.t, day: e.day, kind: e.kind, side: e.side, strength: e.strength, provenance: e.provenance,
    label: w.eventLabels[e.id]!, from: fieldValue(e.from), to: fieldValue(e.to), new: isNew(e.id),
  }));
  const inTimeline = new Set(timeline.map((e) => e.id));
  // A held (pending) decision's candidates can name an event the current timeline no longer has (late log writes can
  // move a derived day-majority change): such a candidate is dropped; checkSnapshot still guards by_elimination.
  const candidates = f.candidates
    .filter((c) => !c.undated)
    .map((c) => ({ event: safeId(c.event), status: c.status, test: c.test }))
    .filter((c) => inTimeline.has(c.event));

  const metrics: SnapshotMetric[] = !f.calibrated ? [] : SNAPSHOT_METRICS.flatMap((id) => {
    const m = f.metrics.find((x) => x.id === id);
    if (m === undefined) return [];
    return [{
      ...glanceMetric(m, w),
      eligible: m.eligible, ineligibleReason: m.ineligibleReason, sensitive: m.eligible && m.sensitive, shifted: m.eligible && m.material,
      standardized: m.standardized === null ? null : { ratio: m.standardized.ratio, range: m.standardized.range },
      series: m.daily.slice(-SERIES_DAYS).map(capDay),
    }];
  });
  const windows = f.calibrated && f.tier !== null && win !== null
    ? {
        recent: { from: win.recent.from, to: win.recent.to, days: win.recent.days, exchanges: cap(win.recent.exchanges), sessions: cap(win.recent.sessions), sessionDays: cap(win.recent.sessionDays) },
        baseline: { from: win.baseline.from, to: win.baseline.to, days: win.baseline.days, exchanges: cap(win.baseline.exchanges), sessions: cap(win.baseline.sessions), sessionDays: cap(win.baseline.sessionDays) },
      }
    : null;
  const snapshot: SnapshotAgent = {
    ...glance,
    tier: f.calibrated ? f.tier : null,
    windows,
    metrics,
    onset: f.onset === null ? null : { ...f.onset },
    timeline,
    candidates,
    confounders: f.calibrated ? f.confounders.slice(0, 12) : [],
    observation: { fullyObservedDays: f.observation.fullyObservedDays, partiallyObservedDays: f.observation.partiallyObservedDays, note: w.observationNote },
    setup: sanitiseSetup(input.setup),
    trace: w.trace.map((t) => ({ ...t })),
    disclaimer: w.disclaimer,
  };
  return { glance, snapshot };
}

function bytes(doc: unknown): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

const emptyHealth = (): Health => ({ sources: [], parserVersions: {}, sandbox: false, paused: [] });

const UNKNOWN_TYPE_KEY = /^[A-Za-z0-9._\-[\]:+@ ]{1,60}$/;
const PARSER_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const countOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(1e9, Math.round(v)) : 0);

/** Health as the contract bounds it: `unknownTypes` keys are log-derived, so only cleanLabel-shaped keys pass. */
function sanitiseHealth(h: Health): Health {
  return {
    sources: h.sources.slice(0, 8).map((s) => {
      const unknownTypes: Record<string, number> = {};
      for (const [k, v] of Object.entries(s.unknownTypes ?? {})) {
        if (Object.keys(unknownTypes).length >= 64) break;
        if (UNKNOWN_TYPE_KEY.test(k)) unknownTypes[k] = countOf(v);
      }
      return { ...s, files: countOf(s.files), badLines: countOf(s.badLines), truncatedTail: countOf(s.truncatedTail), duplicates: countOf(s.duplicates), unknownTypes };
    }),
    parserVersions: Object.fromEntries(Object.entries(h.parserVersions ?? {}).filter(([k, v]) => PARSER_KEY.test(k) && Number.isInteger(v) && v >= 1).slice(0, 24)),
    sandbox: h.sandbox === true,
    paused: (h.paused ?? []).slice(0, 48),
  };
}

/** Build both documents and every agent's words (see the file header). Pure. */
export function buildOutputs(input: BuildOutputsInput): BuiltOutputs {
  const problems: string[] = [];
  const built = input.agents.map((a, i) => {
    if ((a.attribution === undefined) === (a.facts === undefined)) throw new RangeError(`agents[${i}]: pass exactly one of attribution / facts`);
    const facts = a.facts ?? factsOf(a.attribution!);
    const words = wordsFor(facts, { knownEventIds: a.knownEventIds ?? null });
    return { input: a, facts, words, index: i };
  });
  // Engine order: calibrated first (single-glyph surfaces speak for agents[0]), then input order.
  built.sort((x, y) => Number(y.facts.calibrated) - Number(x.facts.calibrated) || x.index - y.index);

  const docs = built.map((b) => agentDocs(b.facts, b.words, b.input));
  for (const b of built) {
    problems.push(...lintAgentWords(b.words));
    // The agent id is written as-is (an open string, CONTRACT): it must be a clean, short id.
    if (cleanLabel(b.facts.agent) !== b.facts.agent || b.facts.agent.length > 32) problems.push(`agent id ${JSON.stringify(b.facts.agent)} is not a clean id`);
  }

  const scanError: ScanError | null = input.scanOk ? null : (input.scanError ?? "internal");
  const staleAfterSec = input.staleAfterSec ?? DEFAULT_STALE_AFTER_SEC;
  const lead: Lead = input.lead ?? "timeline";
  const demo = input.demo === true;
  if (parseGeneratedAt(input.generatedAt) === null) problems.push("generatedAt is not RFC 3339 with an explicit offset");

  const glance: Glance = {
    schema: GLANCE_SCHEMA_ID, engine: input.engine, generatedAt: input.generatedAt, staleAfterSec, scanOk: input.scanOk,
    scanError, demo, lead, agents: docs.map((d) => d.glance), privacy: { containsText: false },
  };
  const calibration: Calibration = input.calibration ?? {
    artifactDate: null, methodId: null,
    agents: built.map((b) => ({ agent: b.facts.agent, calibrated: b.facts.calibrated, sequences: 0, falseChanged: null, falseAgent: null })),
  };
  const snapshot: Snapshot = {
    schema: SNAPSHOT_SCHEMA_ID, engine: input.engine, generatedAt: input.generatedAt, staleAfterSec, scanOk: input.scanOk,
    scanError, demo, lead, agents: docs.map((d) => d.snapshot), health: input.health ? sanitiseHealth(input.health) : emptyHealth(), calibration,
    privacy: { containsText: false },
  };

  problems.push(...checkGlance(glance, { copy: true }).map((p) => `glance ${p}`));
  problems.push(...checkSnapshot(snapshot, { copy: true }).map((p) => `snapshot ${p}`));
  const gb = bytes(glance), sb = bytes(snapshot);
  if (gb > GLANCE_MAX_BYTES) problems.push(`glance is ${gb} bytes (limit ${GLANCE_MAX_BYTES})`);
  if (sb > SNAPSHOT_MAX_BYTES) problems.push(`snapshot is ${sb} bytes (limit ${SNAPSHOT_MAX_BYTES})`);

  return { glance, snapshot, words: built.map((b) => b.words), facts: built.map((b) => b.facts), problems };
}
