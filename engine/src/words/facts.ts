/**
 * Facts: everything the words layer reads from one agent's attribution, as plain data. Words and the contract
 * documents are built from Facts only, so the copy can be tested from hand-built Facts (the contract goldens) as
 * well as from the real pipeline (one case per decision-table row).
 *
 * Sources, in order of authority:
 *  - `decision` (WP-21): state, reason, row, pending, trace, onset, candidates, observation, blind spot, the row-12
 *    metric. Under persistence a pending decision holds the PREVIOUS outcome; its trace details (counted metrics,
 *    mixed / workload lists, Holm kind) are read from the held trace, so the words describe the state on show.
 *  - `evaluation` (WP-20a): the numbers (ratios, ranges, MDEs, k/n, gates, pace, progress) of the tier in use
 *    (the selected tier, else the progress tier).
 *  - `confounders` (WP-20b): the df floor (`usable`), standardised ratios and the mix flags.
 *  - `evidence`: the onset peak, the version-boundary projects, the fully observed days.
 *  - `events`: every merged event (reader, configsnap, derived `d-…`, tripwire `t-…`), for the snapshot timeline.
 *
 * Pure: no I/O, no clock reads.
 */
import type { Attribution } from "../analysis/attribution/pipeline.js";
import { eventDay, tripwireOf } from "../analysis/attribution/events.js";
import type { CandidateClass, TraceRow, Tripwire } from "../analysis/attribution/types.js";
import type { MetricEvaluation, TierEvaluation } from "../analysis/gates/evaluate.js";
import { METRICS } from "../analysis/metrics/defs.js";
import type { ShareMove } from "../analysis/confounders/mix.js";
import type { Confounder } from "../contract/snapshot.js";
import type { ChangeProvenance, ChangeStrength, IneligibleReason, VerdictReason, VerdictState } from "../contract/vocab.js";
import { decodeSide } from "../contract/vocab.js";
import { hashHex } from "../analysis/stats/rng.js";
import type { ChangeSide } from "../types.js";
import { cleanLabel } from "../util.js";
import { addDays, daysBetween } from "./format.js";
import { recheckEstimate, type Recheck, type RecheckMetric } from "./recheck.js";

/**
 * D66: projected dates ("at your pace, about Oct 10"), re-check estimates and "not at your current pace" are off in v1.
 * Only factual counters are shown. Flip after a calibration run shows G-ETA passing for every profile (D64(c)).
 */
export const SHOW_DATES = false;

export type FamilyFact = "errors" | "research" | "friction" | "context";
export type RoleFact = "vote" | "support" | "context";

export interface WindowFacts {
  from: string;
  to: string;
  /** Calendar days in the window. */
  days: number;
  exchanges: number;
  sessions: number;
  sessionDays: number;
  /** Days with at least one exchange. */
  activeDays: number;
}

export interface KnFacts { k: number; n: number; sessions: number; sessionDays: number }

export interface MetricFact {
  id: string;
  family: FamilyFact;
  role: RoleFact;
  /** Display multiplier for the rate (100 → per 100). */
  scale: number;
  eligible: boolean;
  /** Contract ineligibility reason, null when eligible. */
  ineligibleReason: IneligibleReason | null;
  /** The reader does not supply this metric's fields: waiting cannot unlock it. */
  fieldsMissing: boolean;
  material: boolean;
  sensitive: boolean;
  /** Eligible, with an interval above the df floor (D53d). */
  usable: boolean;
  /** Survives Holm across the eligible voting metrics (20b `familywiseSignificant`): the only rows a surface may
   *  draw in non-neutral ink (D53e). */
  familywise: boolean;
  /** Direction of the move (up/down), when material. */
  direction: "up" | "down" | null;
  status: "worse" | "better" | "shifted" | "none" | "ineligible";
  ratio: number | null;
  range: [number, number] | null;
  mde: number | null;
  recent: KnFacts;
  baseline: KnFacts;
  daily: { d: string; k: number; n: number }[];
  standardized: { ratio: number | null; range: [number, number] | null } | null;
  pace: { sessionDays: number; newSessions: number } | null;
  /** Failing gate checks in the first window that fails (recent first), for "next to unlock". */
  shortfall: { window: "recent" | "baseline"; checks: { id: string; have: number; need: number; shortSessions: number | null; shortSessionDays: number | null }[] } | null;
}

export interface EventFact {
  id: string;
  /** RFC 3339 with an offset. */
  t: string;
  day: string;
  kind: string;
  side: ChangeSide;
  strength: ChangeStrength;
  provenance: ChangeProvenance;
  from: string;
  to: string;
  tripwire: Tripwire | null;
  derived: boolean;
}

export interface CandidateFact {
  event: string;
  kind: string;
  side: ChangeSide;
  class: CandidateClass;
  status: "open" | "ruled_out" | "background";
  test: "strata" | "version_boundary" | "routine" | null;
  day: string | null;
  undated: boolean;
  tripwire: Tripwire | null;
  from: string;
  to: string;
  /** The event's provenance when it is a known one (a project file keeps its scope in the words), else null. */
  provenance?: ChangeProvenance | null;
}

export interface UnlockFact {
  metric: string;
  family: FamilyFact;
  state: "ineligible" | "not_sensitive";
  fieldsMissing: boolean;
  /** The counts of the window that falls short (the recent one when none does), one quantity per pair: `events` is
   *  the indicator's denominator when it has a floor (reads per edit: edits of 40), else its own events (of 10). */
  have: { events: number; sessions: number; sessionDays: number };
  need: { events: number; sessions: number; sessionDays: number };
  /** Estimated sessions / session-days still short, from the sessions, session-days and events checks only (never the
   *  largest-session share's estimate); null when none of those fails or none can be estimated. */
  shortSessions: number | null;
  shortSessionDays: number | null;
  /** The failing gate checks (sessions, sessionDays, events, denominator, sessionShare); empty when the history or
   *  the reader's fields are what is missing. */
  blocking: string[];
}

export interface ProgressFacts {
  tier: 1 | 2 | 3;
  /** "no_date": a projection exists but D64(b) shows no date (gates/eta.ts). */
  reason: "ready" | "eta" | "not_at_current_pace" | "no_date" | "no_data" | "metric_unavailable";
  /** The SHOWN date (null whenever none is shown). */
  etaDate: string | null;
  notAtCurrentPace: boolean;
  /** Today's gate + sensitivity hold before D64(a)'s second day (ready = held on two consecutive daily evaluations). */
  readyToday: boolean;
  unlock: UnlockFact[];
}

export interface Facts {
  agent: string;
  today: string;
  state: VerdictState;
  reason: VerdictReason | null;
  row: number;
  pending: boolean;
  calibrated: boolean;
  /** The selected tier (null: no comparison ran). */
  tier: 1 | 2 | 3 | null;
  /** History days and how the tier was chosen. */
  history: { days: number; selection: "ready" | "largest_available" | "no_history" };
  /** Windows of the tier in use (selected, else the progress tier); counts both windows for `n`. `sessions` is the
   *  number of DISTINCT sessions across both windows (a session active on both sides of the boundary counts once),
   *  so it is not `recent.sessions + baseline.sessions`. */
  windows: { recent: WindowFacts; baseline: WindowFacts; sessions: number } | null;
  metrics: MetricFact[];
  /** The tool-error construct that votes (D47d). */
  errorsVote: string;
  /** The usable material voting metrics "changed" counted (from the held trace). */
  counted: string[];
  side: "worse" | "better" | null;
  /** "Changed" was lost to the 3-most-influential-days rule. */
  fragileDays: boolean;
  mixed: { worse: string[]; better: string[] } | null;
  workload: string[];
  single: { metric: string; ratio: number } | null;
  /** The single-indicator note's kind (rows 12–14). */
  holmKind: string | null;
  /** Material voting metrics on a not-changed outcome (rows 12–14). */
  materialVoting: string[];
  onset: { from: string; to: string } | null;
  peak: string | null;
  candidates: CandidateFact[];
  observation: { fullyObservedDays: number; partiallyObservedDays: number; partialByDesign: boolean; scope: "onset" | "window" };
  blindSpot: boolean;
  /** Row 9: the projects the version-boundary shift replicated in. */
  boundary: { event: string | null; projects: number | null } | null;
  progress: ProgressFacts | null;
  recheck: Recheck | null;
  trace: TraceRow[];
  events: EventFact[];
  confounders: Confounder[];
  gate: { minSessions: number; minSessionDays: number; minEvents: number };
}

// ───────────────────────────── helpers ─────────────────────────────

/** An indicator's own denominator floor (reads per edit: 40 edits; 0 = none). Unknown ids (hand-built facts) have none. */
export function denominatorFloor(metricId: string): number {
  const floor = METRICS.find((d) => d.id === metricId)?.minDenominator ?? 0;
  return floor > 0 && Number.isFinite(floor) ? floor : 0;
}

/**
 * The gate check an unlock item's `events` pair stands for (METHOD.md §13: "31 of 40 edits"): the denominator floor for an
 * indicator that has one (reads per edit counts edits), else the indicator's own events. The contract carries one events
 * pair, so the "Next to unlock" counter considers only this check besides sessions and session-days: the words and every
 * surface then pick from the same three pairs.
 */
export function gateEventsCheck(metricId: string): "events" | "denominator" {
  return denominatorFloor(metricId) > 0 ? "denominator" : "events";
}

/** A non-negative integer total. Not capped here: the documents cap at the contract's 1e9 (build.ts), and the
 *  ledger lines of unbounded context totals (tokens, milliseconds) must not be falsified by a cap. */
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** The last condition with this id in the trace (rows are in table order), or undefined. */
export function traceCondition(trace: readonly TraceRow[], id: string) {
  for (let i = trace.length - 1; i >= 0; i--) {
    const c = trace[i]!.conditions.find((x) => x.id === id);
    if (c !== undefined) return c;
  }
  return undefined;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function contractIneligible(m: MetricEvaluation): IneligibleReason | null {
  if (m.eligible) return null;
  switch (m.ineligibleReason) {
    case "gate": {
      const first = m.gate.blocking[0]?.id;
      if (first === "sessions") return "too_few_sessions";
      if (first === "sessionDays") return "too_few_session_days";
      if (first === "sessionShare") return "one_session_dominates";
      if (first === "denominator") return m.id === "readsPerEdit" ? "too_few_edits" : "too_few_events";
      return "too_few_events";
    }
    case "language_unknown":
    case "not_english":
      return "not_english";
    case "no_interval":
      return "one_session_dominates";
    default:
      return "no_data"; // history not met, or the reader does not supply the fields
  }
}

/** Prompt-unit metrics whose denominator is one per exchange (a real human prompt). */
const EXCHANGE_METRICS = ["interrupts", "pushback", "steps", "promptChars"];

/** Exchange-unit metric of the tier: its windows give the exchange, session and session-day counts. */
function exchangeMetric(t: TierEvaluation): MetricEvaluation | undefined {
  return EXCHANGE_METRICS.map((id) => t.metrics.find((x) => x.id === id)).find((x) => x !== undefined);
}

function windowFacts(t: TierEvaluation, which: "recent" | "baseline"): WindowFacts {
  const r = t.windows[which];
  const m = exchangeMetric(t);
  const w = m?.[which];
  const active = m ? m.daily.filter((d) => d.d >= r.from && d.d <= r.to && d.n > 0).length : 0;
  return {
    from: r.from, to: r.to, days: (daysBetween(r.from, r.to) ?? 0) + 1,
    exchanges: int(w?.denominator), sessions: int(w?.sessions), sessionDays: int(w?.sessionDays), activeDays: active,
  };
}

function shortfallOf(m: MetricEvaluation): MetricFact["shortfall"] {
  const b = m.gate.blocking;
  if (b.length === 0) return null;
  const window = b[0]!.window;
  return {
    window,
    checks: b.filter((c) => c.window === window).map((c) => ({ id: c.id, have: c.have, need: c.need, shortSessions: c.shortSessions, shortSessionDays: c.shortSessionDays })),
  };
}

function metricFact(m: MetricEvaluation, a: Attribution): MetricFact {
  const c = m.comparison;
  const df = a.confounders.df.metrics.find((x) => x.metric === m.id);
  const st = a.confounders.standardised.find((s) => s.metric === m.id);
  const pace = a.evaluation.progress.pace[m.id];
  const shownRatio = m.eligible && c !== null && Number.isFinite(c.ratio) && c.ratio > 0;
  return {
    id: m.id,
    family: m.family,
    role: m.role,
    scale: m.scale,
    eligible: m.eligible,
    ineligibleReason: contractIneligible(m),
    fieldsMissing: m.ineligibleReason === "fields_missing",
    material: m.material,
    sensitive: m.sensitive,
    usable: df !== undefined ? df.usable : m.eligible && c !== null,
    familywise: a.confounders.singleIndicator.familywiseSignificant.includes(m.id),
    direction: m.direction,
    status: m.status,
    ratio: shownRatio ? c!.ratio : null,
    range: shownRatio ? [c!.range.lo, c!.range.hi] : null,
    mde: m.eligible && m.mde !== null && Number.isFinite(m.mde) && m.mde >= 1 ? m.mde : null,
    recent: { k: int(m.recent.events), n: int(m.recent.denominator), sessions: int(m.recent.sessions), sessionDays: int(m.recent.sessionDays) },
    baseline: { k: int(m.baseline.events), n: int(m.baseline.denominator), sessions: int(m.baseline.sessions), sessionDays: int(m.baseline.sessionDays) },
    daily: m.daily.map((d) => ({ d: d.d, k: int(d.k), n: int(d.n) })),
    standardized: st === undefined ? null : st.comparison !== null
      ? { ratio: st.comparison.ratio, range: [st.comparison.range.lo, st.comparison.range.hi] }
      : { ratio: null, range: null },
    pace: pace ? { sessionDays: pace.sessionDays, newSessions: pace.newSessions } : null,
    shortfall: shortfallOf(m),
  };
}

/** An event id as the contract carries it (1–40 characters): the event's own, else a stable short hash of it. */
export function safeEventId(id: string): string {
  return id.length >= 1 && id.length <= 40 ? id : `x-${hashHex(id).slice(0, 16)}`;
}

const STRENGTH_DEFAULT: Record<ChangeSide, ChangeStrength> = { you: "weak", agent: "routine", unknown: "weak", meta: "routine" };
const PROVENANCES: readonly ChangeProvenance[] = ["command", "settings_snapshot", "project_snapshot", "org_settings", "log_field", "attachment"];

function eventFacts(a: Attribution): EventFact[] {
  const tz = a.evaluation.timeZone;
  const out: EventFact[] = [];
  for (const e of a.events) {
    const day = eventDay(e, tz);
    if (day === null) continue;
    const side = decodeSide(e.side);
    const ms = Date.parse(String(e.t));
    const kind = cleanLabel(e.kind);
    out.push({
      id: safeEventId(String(e.id)),
      t: Number.isFinite(ms) ? new Date(ms).toISOString() : `${day}T00:00:00Z`,
      day,
      kind: kind !== undefined && kind.length <= 24 ? kind : "other",
      side,
      strength: e.strength === "strong" || e.strength === "weak" || e.strength === "routine" ? e.strength : STRENGTH_DEFAULT[side],
      provenance: PROVENANCES.includes(e.provenance as ChangeProvenance) ? (e.provenance as ChangeProvenance) : e.evidence === "snapshot" ? "settings_snapshot" : "log_field",
      from: typeof e.from === "string" ? e.from : String(e.from ?? ""),
      to: typeof e.to === "string" ? e.to : String(e.to ?? ""),
      tripwire: tripwireOf(e),
      derived: e.derived === true,
    });
  }
  return out;
}

/** The larger of two share moves (a move without data loses to one with data); flagged when either is. */
function larger(a: ShareMove, b: ShareMove | undefined): { move: number | null; flagged: boolean } {
  if (b === undefined || b.move === null) return a;
  if (a.move === null) return b;
  return { move: Math.max(a.move, b.move), flagged: a.flagged || b.flagged };
}

function confoundersOf(a: Attribution): Confounder[] {
  const mix = a.confounders.mix;
  if (mix === null) return [];
  const share = (id: Confounder["id"], s: { move: number | null; flagged: boolean }): Confounder =>
    ({ id, moved: s.move === null ? null : s.flagged, value: s.move === null || !Number.isFinite(s.move) ? null : round4(s.move) });
  const out: Confounder[] = [
    { id: "prompt_length", moved: mix.promptLength.ratio === null ? null : mix.promptLength.flagged, value: mix.promptLength.ratio === null || !Number.isFinite(mix.promptLength.ratio) ? null : round4(mix.promptLength.ratio) },
    { id: "long_context_share", moved: null, value: null },
    share("mode_mix", mix.mode),
    share("entrypoint_mix", mix.entrypoint),
    // The subagent mix moves when either share does: exchanges that delegate, or the edits made by subagents (D62a).
    share("subagent_mix", larger(mix.subagent, mix.subagentWork)),
  ];
  if (mix.interactive !== null) out.push(share("interactive_mix", mix.interactive));
  const st = a.confounders.standardised;
  out.push({ id: "project_mix", moved: st.length === 0 ? null : st.some((s) => s.overlap && !s.holds), value: null });
  out.push({ id: "no_overlap", moved: st.length === 0 ? null : st.some((s) => !s.overlap), value: null });
  return out;
}

export interface FactsOptions {
  /** Upper bound for the re-check estimate in days (default 84). */
  recheckMaxDays?: number;
}

/** Facts of one agent's attribution (see the file header). */
export function factsOf(a: Attribution, opts: FactsOptions = {}): Facts {
  const ev = a.evaluation, d = a.decision, evidence = a.evidence;
  const tierId = ev.selectedTier ?? ev.progress.tier;
  const tier = ev.tiers.find((t) => t.tier === tierId) ?? ev.tiers[0];
  const metrics = tier ? tier.metrics.map((m) => metricFact(m, a)) : [];
  const windows = tier
    ? { recent: windowFacts(tier, "recent"), baseline: windowFacts(tier, "baseline"), sessions: int(exchangeMetric(tier)?.distinctSessions) }
    : null;
  const events = eventFacts(a);
  const raw = new Map(a.events.map((e) => [String(e.id), e]));

  const changed = traceCondition(d.trace, "changed");
  const counted = changed?.holds === true ? strs(changed.metrics) : [];
  const mixedCond = traceCondition(d.trace, "mixed");
  const workloadCond = traceCondition(d.trace, "workload");
  const singleCond = traceCondition(d.trace, "single_indicator");
  const otherwise = traceCondition(d.trace, "otherwise");
  const noMaterial = traceCondition(d.trace, "no_material");

  const candidates: CandidateFact[] = d.candidates.map((c) => {
    const e = raw.get(c.event);
    return {
      event: safeEventId(c.event), kind: c.kind, side: decodeSide(c.side), class: c.class, status: c.status, test: c.test,
      day: c.day, undated: c.undated, tripwire: c.tripwire,
      from: e ? String(e.from ?? "") : "", to: e ? String(e.to ?? "") : "",
      provenance: e && PROVENANCES.includes(e.provenance as ChangeProvenance) ? (e.provenance as ChangeProvenance) : null,
    };
  });

  // Observation: over the onset interval I for a changed outcome (R11/D56: the scope checkSnapshot's
  // by_elimination rule reads); without an onset, over the recent window in use.
  let observation: Facts["observation"];
  if (d.onset !== null) {
    observation = { fullyObservedDays: d.observation.fullyObservedDays, partiallyObservedDays: d.observation.partiallyObservedDays, partialByDesign: d.observation.partialByDesign, scope: "onset" };
  } else if (windows !== null) {
    const fully = new Set(evidence.fullyObservedDays);
    let f = 0;
    for (let i = 0; i < windows.recent.days; i++) {
      const day = addDays(windows.recent.from, i);
      if (!evidence.partialByDesign && fully.has(day)) f++;
    }
    observation = { fullyObservedDays: f, partiallyObservedDays: windows.recent.days - f, partialByDesign: evidence.partialByDesign, scope: "window" };
  } else {
    observation = { fullyObservedDays: 0, partiallyObservedDays: 0, partialByDesign: evidence.partialByDesign, scope: "window" };
  }

  let boundary: Facts["boundary"] = null;
  if (d.row === 9) {
    const vb = candidates.find((c) => c.test === "version_boundary");
    const b = evidence.boundary;
    const projects = vb && b !== null && b.event === vb.event && b.projects.length > 0 ? Math.min(...b.projects.map((p) => p.agreeing)) : null;
    boundary = { event: vb?.event ?? null, projects };
  }

  const p = ev.progress;
  const gate = { minSessions: ev.gate.minSessions, minSessionDays: ev.gate.minSessionDays, minEvents: ev.gate.minEventsPerWindow };
  const unlock: UnlockFact[] = p.unlock.map((u) => {
    const m = metrics.find((x) => x.id === u.metric);
    const sf = m?.shortfall ?? null;
    // The window that falls short; with no gate shortfall (a history or interval wait) both windows pass, and the recent
    // one's counts say so, never a made-up 0.
    const w = m === undefined ? null : m[sf?.window ?? "recent"];
    const floor = denominatorFloor(u.metric);
    // The largest-session share's estimate is left out: it assumes new sessions look like the window's OTHER sessions,
    // which are small by construction when one session dominates, so it runs to hundreds of sessions (a count nobody
    // can act on). The words say one session dominates instead, with no count.
    const short = (key: "shortSessions" | "shortSessionDays") => {
      const vals = (sf?.checks ?? []).filter((c) => c.id !== "sessionShare").map((c) => c[key]).filter((x): x is number => typeof x === "number");
      return vals.length === 0 ? null : Math.max(...vals);
    };
    return {
      metric: u.metric, family: u.family, state: u.state, fieldsMissing: u.reason === "fields_missing",
      // One quantity per pair (gateEventsCheck): a floor metric's events are its denominator (edits), whether or not
      // that check fails, so "3,150 reads" is never set against "10" and called edits.
      have: { events: w === null ? 0 : floor > 0 ? w.n : w.k, sessions: w?.sessions ?? 0, sessionDays: w?.sessionDays ?? 0 },
      need: { events: floor > 0 ? floor : gate.minEvents, sessions: gate.minSessions, sessionDays: gate.minSessionDays },
      shortSessions: short("shortSessions"), shortSessionDays: short("shortSessionDays"),
      blocking: (sf?.checks ?? []).map((c) => c.id),
    };
  });
  // D66: no projected dates or "not at your current pace" claims in v1 — they failed G-ETA for few-long, sparse and
  // Codex users (D64). The analysis still computes them (calibration keeps measuring); the words show counters only.
  const datesOff = !SHOW_DATES && (p.reason === "eta" || p.reason === "not_at_current_pace");
  const progress: ProgressFacts = datesOff
    ? { tier: p.tier, reason: "no_date", etaDate: null, notAtCurrentPace: false, readyToday: p.readyToday, unlock }
    : { tier: p.tier, reason: p.reason, etaDate: p.etaDate, notAtCurrentPace: p.notAtCurrentPace, readyToday: p.readyToday, unlock };

  const recheckMetrics: RecheckMetric[] = counted.flatMap((id) => {
    const m = metrics.find((x) => x.id === id);
    if (!m || m.ratio === null || m.mde === null) return [];
    return [{ family: m.family, ratio: m.ratio, mde: m.mde, recentSessionDays: m.recent.sessionDays, baselineSessionDays: m.baseline.sessionDays, pace: m.pace }];
  });

  const voting = metrics.filter((m) => m.role === "vote");
  const holmKind = singleCond?.detail?.kind ?? otherwise?.detail?.kind;
  const changedSide = changed?.detail?.side;
  return {
    agent: ev.agent,
    today: ev.today,
    state: d.state,
    reason: d.reason,
    row: d.row,
    pending: d.pending,
    // CONTRACT: calibrated false ⇔ insufficient (calibration_pending); row 1 bypasses persistence both ways.
    calibrated: d.reason !== "calibration_pending",
    tier: ev.selectedTier,
    history: { days: ev.history.days, selection: ev.selection },
    windows,
    metrics,
    errorsVote: ev.errorsVote,
    counted,
    side: changedSide === "worse" || changedSide === "better" ? changedSide : null,
    fragileDays: changed?.detail?.fragileDays === true,
    mixed: mixedCond?.holds === true ? { worse: strs(mixedCond.detail?.worse), better: strs(mixedCond.detail?.better) } : null,
    workload: workloadCond?.holds === true ? strs(workloadCond.detail?.reasons) : [],
    single: d.singleIndicator !== null ? { metric: d.singleIndicator.metric, ratio: d.singleIndicator.ratio } : null,
    holmKind: typeof holmKind === "string" ? holmKind : null,
    materialVoting: otherwise !== undefined ? strs(otherwise.detail?.material) : noMaterial !== undefined ? strs(noMaterial.metrics) : voting.filter((m) => m.material).map((m) => m.id),
    onset: d.onset === null ? null : { from: d.onset.from, to: d.onset.to },
    peak: evidence.onset?.peak ?? null,
    candidates,
    observation,
    blindSpot: d.blindSpot,
    boundary,
    progress,
    recheck: SHOW_DATES ? recheckEstimate(recheckMetrics, gate, ev.today, opts.recheckMaxDays) : null,
    trace: d.trace,
    events,
    confounders: confoundersOf(a),
    gate,
  };
}
