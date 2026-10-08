/**
 * The heavy, data-bound half of attribution (METHOD.md §10): everything the decision table needs that is not in the
 * 20a evaluation or the 20b assessment — onset, the strata rule-out, the version-boundary test, the D53 strata
 * dimensions, per-day observation and the persistence data. Pure and deterministic (every bootstrap is seeded from
 * its data, as in 20a/20b), no I/O, no clock reads.
 *
 * Rule-out by strata (METHOD.md §10 step 5, positive evidence only). A dated you·strong candidate in I whose kind has an
 * Exchange field (model, effort, mode, entrypoint) is re-evaluated with that dimension HELD at the event's old
 * value: only the agent's interactive exchanges whose field equals `from` (in both windows of the selected tier),
 * every voting metric through 20a's own `evaluateMetric` (same D23 gate, same estimator, same df floor via 20b's
 * `changedOf`). It is RULED OUT only when that restricted run is still "changed" on the same side. A restricted run
 * that loses the shift proves nothing (the candidate stays open). Kinds without an Exchange field (instructions,
 * mcp, skills, plugins, hooks, config — incl. Codex's model_provider switch) and unusable old values ("unknown",
 * "other", empty) are never ruled out.
 *
 * Version-boundary test (METHOD.md §10 step 6, D33), required for `agent` by elimination:
 *  - the version events inside I are grouped by their new version; each group's earliest day is a boundary. It
 *    runs only when there is exactly one boundary day;
 *  - pre = [b − 7, b − 1], post = [b, b + 6] (days before today only), every voting metric through 20a's
 *    `evaluateMetric` (same D23 gates); `changedOf` must be "changed" on the same side as the main shift;
 *  - for every counted metric of that comparison, 20b's `projectRule` on the same two windows: ≥ 2 projects qualify
 *    (the full D23 gate per project) and ≥ 2 agree, and agreeing ≥ ⅔ of qualifying;
 *  - every day of pre ∪ post is fully observed (D33 "on fully observed days").
 *
 * D53(a): a dated you·strong candidate in I of kind `model` or `entrypoint` drops that stratum dimension for the
 * workload test (`dims`); `unknown` events never drop one. Effort and mode are not strata, so they drop nothing.
 */
import { changedOf, DF_FLOOR, type ChangedCall, type Side } from "../confounders/agreement.js";
import { projectAgreement, projectRule } from "../confounders/projects.js";
import { fullStratumKey, STRATUM_DIMS, type StratumDim } from "../confounders/strata.js";
import { evaluateMetric, type AgentEvaluation, type MetricContext, type MetricEvaluation, type TierEvaluation } from "../gates/evaluate.js";
import { buildCells, cellsBetween, type CellBuild } from "../metrics/cells.js";
import { metricDef, type MetricExchange, type MetricId } from "../metrics/defs.js";
import { mustDay, rangeStrings, TIERS, tierWindows, type DayRangeStrings, type Tier } from "../metrics/windows.js";
import { DEFAULT_RESAMPLES } from "../stats/bootstrap.js";
import { dayIndex, dayString, totals } from "../stats/ratio.js";
import type { ChangeKind } from "../../types.js";
import { classifyEvent, dayIn, eventDay } from "./events.js";
import { ONSET_DEFAULTS, onsetInterval, type OnsetMetric } from "./onset.js";
import {
  TRIPWIRES_OFF,
  type AttributionEvent, type AttributionEvidence, type BoundaryProjects, type BoundaryTest, type DailyPersistence,
  type HoldDimension, type OnsetOptions, type PersistenceData, type RuleOutResult,
} from "./types.js";

/** METHOD.md §10 step 6: ±7 days around the boundary. */
export const BOUNDARY_DAYS = 7;
/** The longest recent window (tier 3), the span of the persistence data. */
const PERSISTENCE_DAYS = Math.max(...TIERS.map((t) => t.recentDays));

const HOLDABLE: Partial<Record<ChangeKind, HoldDimension>> = { model: "model", effort: "effort", mode: "mode", entrypoint: "entrypoint" };
const UNUSABLE_OLD = new Set(["", "unknown", "other"]);
/** Event kinds whose you·strong change drops a stratum dimension (D53a). */
const DROPS: Partial<Record<ChangeKind, StratumDim>> = { model: "model", entrypoint: "entrypoint" };

/** The agent's cells (with full strata) and its deduplicated interactive exchanges, built once. */
export interface Prepared {
  agent: string;
  today: string;
  build: CellBuild;
  /** Deduplicated interactive exchanges on complete past days (`interactiveClass` pinned to "interactive"). */
  used: MetricExchange[];
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

/**
 * Builds the agent's cells once. The exchanges must be the ones the evaluation was built from (checked on every
 * evaluated metric's window totals, as 20b does; throws otherwise).
 */
export function prepare(exchanges: readonly MetricExchange[], evaluation: AgentEvaluation): Prepared {
  const used: MetricExchange[] = [];
  const build = buildCells(exchanges, {
    agent: evaluation.agent,
    today: evaluation.today,
    stratumOf: fullStratumKey,
    onExchange: (x, v) => {
      if (v === "interactive") used.push({ ...x, interactiveClass: "interactive" });
    },
    // Only the evaluated metrics are ever read from these cells (and the check below covers each of them).
    metrics: evaluatedIds(evaluation),
  });
  const todayIdx = mustDay(evaluation.today, "evaluation.today");
  for (const t of evaluation.tiers) {
    const tier = TIERS.find((x) => x.tier === t.tier)!;
    const w = tierWindows(todayIdx, tier);
    for (const m of t.metrics) {
      const r = totals(cellsBetween(build.cells[m.id], w.recent.from, w.recent.to));
      const b = totals(cellsBetween(build.cells[m.id], w.baseline.from, w.baseline.to));
      if (!close(r.num, m.recent.events) || !close(r.den, m.recent.denominator) || !close(b.num, m.baseline.events) || !close(b.den, m.baseline.denominator)) {
        throw new RangeError(`the exchanges do not match the evaluation (metric ${m.id}, tier ${t.tier})`);
      }
    }
  }
  return { agent: evaluation.agent, today: evaluation.today, build, used };
}

/** The metrics the evaluation evaluated (every tier evaluates the same list). */
function evaluatedIds(evaluation: AgentEvaluation): MetricId[] {
  return [...new Set(evaluation.tiers.flatMap((t) => t.metrics.map((m) => m.id)))];
}

function selectedTier(evaluation: AgentEvaluation): TierEvaluation | undefined {
  return evaluation.selectedTier === null ? undefined : evaluation.tiers.find((t) => t.tier === evaluation.selectedTier);
}

function votingIds(t: TierEvaluation): MetricId[] {
  return t.metrics.filter((m) => m.role === "vote").map((m) => m.id);
}

/** 20a's metric context for re-evaluations (voting metrics only, so the language fields are inert). */
export function metricContext(evaluation: AgentEvaluation): MetricContext {
  let resamples = DEFAULT_RESAMPLES;
  outer: for (const t of evaluation.tiers) {
    for (const m of t.metrics) {
      if (m.comparison !== null) {
        resamples = m.comparison.resamples;
        break outer;
      }
    }
  }
  return {
    method: evaluation.method,
    gate: evaluation.gate,
    resamples,
    englishOverride: null,
    language: [],
    languageKnown: false,
    errorsVote: evaluation.errorsVote,
  };
}

/** Voting metrics re-evaluated on other cells/windows, through 20a's own `evaluateMetric`. */
function revaluate(ids: readonly MetricId[], cells: CellBuild["cells"], tier: Tier, todayIdx: number, ctx: MetricContext): MetricEvaluation[] {
  return ids.map((id) => evaluateMetric(metricDef(id), cells[id], tier, todayIdx, true, ctx));
}

/** METHOD.md §10 step 5 for one you·strong candidate (see the file header). */
export function ruleOutCandidate(
  prepared: Prepared,
  evaluation: AgentEvaluation,
  event: AttributionEvent,
  side: Side,
  floor = DF_FLOOR,
): RuleOutResult {
  const dimension = HOLDABLE[event.kind] ?? null;
  const base = { event: String(event.id), kind: event.kind, dimension };
  if (dimension === null) return { ...base, held: null, attempted: false, ruledOut: false, reason: "not_holdable", changed: null };
  const held = typeof event.from === "string" ? event.from : "";
  if (UNUSABLE_OLD.has(held)) return { ...base, held: null, attempted: false, ruledOut: false, reason: "old_value_unknown", changed: null };
  const t = selectedTier(evaluation);
  if (t === undefined) return { ...base, held, attempted: false, ruledOut: false, reason: "shift_not_shown", changed: null };
  const sub = prepared.used.filter((x) => String((x as unknown as Record<string, unknown>)[dimension]) === held);
  const build = buildCells(sub, { agent: prepared.agent, today: prepared.today, metrics: votingIds(t) });
  const tier = TIERS.find((x) => x.tier === t.tier)!;
  const metrics = revaluate(votingIds(t), build.cells, tier, mustDay(prepared.today), metricContext(evaluation));
  const changed = changedOf(metrics, floor);
  const ruledOut = changed.changed && changed.side === side;
  return { ...base, held, attempted: true, ruledOut, reason: ruledOut ? "ruled_out" : "shift_not_shown", changed };
}

function boundaryDays(b: number, w: number, todayIdx: number): string[] {
  const out: string[] = [];
  for (let d = b - w; d <= Math.min(b + w - 1, todayIdx - 1); d++) out.push(dayString(d));
  return out;
}

/** METHOD.md §10 step 6 (see the file header). `versions`: dated version events inside I. */
export function versionBoundaryTest(
  prepared: Prepared,
  evaluation: AgentEvaluation,
  versions: readonly { event: AttributionEvent; day: string }[],
  side: Side,
  observed: (day: string) => boolean,
  opts: { floor?: number; days?: number } = {},
): BoundaryTest {
  const floor = opts.floor ?? DF_FLOOR;
  const w = opts.days ?? BOUNDARY_DAYS;
  if (!(Number.isInteger(w) && w >= 1)) throw new RangeError(`boundaryDays must be an integer ≥ 1 (got ${String(w)})`);
  // Earliest event per new version; distinct days are the boundaries.
  const firstByTo = new Map<string, { event: AttributionEvent; day: string }>();
  for (const v of versions) {
    const to = String(v.event.to);
    const cur = firstByTo.get(to);
    if (!cur || v.day < cur.day || (v.day === cur.day && String(v.event.id) < String(cur.event.id))) firstByTo.set(to, v);
  }
  const days = [...new Set([...firstByTo.values()].map((v) => v.day))].sort();
  const none = { pre: null, post: null, shift: null, projects: [], observed: false, passes: false };
  if (days.length === 0) return { event: null, boundary: null, boundaries: 0, ...none, reason: "no_boundary" };
  if (days.length > 1) return { event: null, boundary: null, boundaries: days.length, ...none, reason: "several_boundaries" };
  const day = days[0]!;
  const tested = [...firstByTo.values()].filter((v) => v.day === day).sort((a, b) => (String(a.event.id) < String(b.event.id) ? -1 : 1))[0]!;
  const t = selectedTier(evaluation);
  const todayIdx = mustDay(prepared.today);
  const b = mustDay(day);
  const pre: DayRangeStrings = { from: dayString(b - w), to: dayString(b - 1) };
  const post: DayRangeStrings = { from: day, to: dayString(Math.min(b + w - 1, todayIdx - 1)) };
  const isObserved = boundaryDays(b, w, todayIdx).every(observed);
  const base = { event: String(tested.event.id), boundary: day, boundaries: 1, pre, post, observed: isObserved };
  if (t === undefined) return { ...base, shift: null, projects: [], passes: false, reason: "shift_not_shown" };
  // A synthetic "tier" whose recent window is post and baseline is pre: evaluateMetric's windows end the day before
  // its `today`, so today' = b + w. Cells never hold today or later days, so post is clipped to before today.
  const tier: Tier = { tier: 1, recentDays: w, baselineDays: w, historyDays: 2 * w };
  const metrics = revaluate(votingIds(t), prepared.build.cells, tier, b + w, metricContext(evaluation));
  const shift = changedOf(metrics, floor);
  if (!(shift.changed && shift.side === side)) return { ...base, shift, projects: [], passes: false, reason: "shift_not_shown" };
  const strata = prepared.build.strata!;
  const projects: BoundaryProjects[] = shift.counted.map((id) => {
    const ev = metrics.find((m) => m.id === id)!;
    const pr = projectRule(
      metricDef(id),
      cellsBetween(strata[id], b, b + w - 1),
      cellsBetween(strata[id], b - w, b - 1),
      ev.direction!,
      evaluation.gate,
    );
    const holds = pr.qualifying >= 2 && pr.agreeing >= 2 && projectAgreement(pr.qualifying, pr.agreeing).holds;
    return { metric: id, qualifying: pr.qualifying, agreeing: pr.agreeing, holds };
  });
  if (!projects.every((p) => p.holds)) return { ...base, shift, projects, passes: false, reason: "projects" };
  if (!isObserved) return { ...base, shift, projects, passes: false, reason: "not_observed" };
  return { ...base, shift, projects, passes: true, reason: "passes" };
}

/** Per-day voting denominators and session-days over the last 28 complete days; the recent window's totals. */
export function persistenceData(prepared: Prepared, evaluation: AgentEvaluation): PersistenceData {
  const t = selectedTier(evaluation) ?? evaluation.tiers.find((x) => x.tier === 1) ?? evaluation.tiers[0];
  const ids = t ? votingIds(t) : [];
  const todayIdx = mustDay(prepared.today);
  const recent = t ? { from: t.windows.recent.from, to: t.windows.recent.to } : rangeStrings(tierWindows(todayIdx, TIERS[0]!).recent);
  const den: Partial<Record<MetricId, number>> = {};
  if (t) for (const m of t.metrics) if (m.role === "vote") den[m.id] = m.recent.denominator;
  const from = todayIdx - PERSISTENCE_DAYS;
  const byDay = new Map<number, { sessions: Set<string>; den: Partial<Record<MetricId, number>> }>();
  for (const id of ids) {
    for (const c of prepared.build.cells[id]) {
      const i = dayIndex(c.day);
      if (i === undefined || i < from || i >= todayIdx || !(c.den > 0)) continue;
      let d = byDay.get(i);
      if (!d) byDay.set(i, (d = { sessions: new Set(), den: {} }));
      d.sessions.add(String(c.session));
      d.den[id] = (d.den[id] ?? 0) + c.den;
    }
  }
  const daily: DailyPersistence[] = [];
  for (let i = from; i < todayIdx; i++) {
    const d = byDay.get(i);
    if (d) daily.push({ d: dayString(i), sessionDays: d.sessions.size, den: d.den });
  }
  return { recent, den, daily };
}

export interface EvidenceOptions {
  /** Whether the agent is calibrated (false → only the persistence data is gathered; row 1 needs nothing else). */
  calibrated: boolean;
  dfFloor?: number;
  onset?: Partial<OnsetOptions>;
  boundaryDays?: number;
  /** Fully observed local days (from the store's snapshot records; WP-12). Default none: everything partial. */
  fullyObservedDays?: readonly string[];
  /** Default: true for Codex (no hooks; METHOD.md §9). */
  partialByDesign?: boolean;
}

/** Gather the evidence for one agent (see the file header). `events`: the merged events (mergeEvents). */
export function gatherEvidence(
  prepared: Prepared,
  evaluation: AgentEvaluation,
  events: readonly AttributionEvent[],
  opts: EvidenceOptions,
): AttributionEvidence {
  const floor = opts.dfFloor ?? DF_FLOOR;
  const fully = [...new Set((opts.fullyObservedDays ?? []).filter((d) => typeof d === "string" && dayIndex(d) !== undefined))].sort();
  const partialByDesign = opts.partialByDesign ?? evaluation.agent === "codex";
  const fullySet = new Set(fully);
  const observed = (day: string) => !partialByDesign && fullySet.has(day);
  const t = selectedTier(evaluation);
  const changed = t === undefined ? false : changedOf(t.metrics, floor).changed;
  const base: AttributionEvidence = {
    agent: evaluation.agent,
    today: evaluation.today,
    tier: evaluation.selectedTier,
    changed,
    calibrated: opts.calibrated,
    onset: null,
    ruleOut: [],
    boundary: null,
    dims: [...STRATUM_DIMS],
    dropped: [],
    fullyObservedDays: fully,
    partialByDesign,
    persistence: persistenceData(prepared, evaluation),
  };
  if (!opts.calibrated || t === undefined || !changed) return base;

  const ch: ChangedCall = changedOf(t.metrics, floor);
  const side = ch.side!;
  const onsetMetrics: OnsetMetric[] = ch.counted.map((id) => {
    const ev = t.metrics.find((m) => m.id === id)!;
    return { metric: id, sign: ev.direction === "down" ? -1 : 1, floor: metricDef(id).floor, cells: prepared.build.cells[id] };
  });
  const onset = onsetInterval(onsetMetrics, { from: t.windows.baseline.from, to: t.windows.recent.to }, evaluation.method, { ...ONSET_DEFAULTS, ...opts.onset });

  const inI: { event: AttributionEvent; day: string; cls: ReturnType<typeof classifyEvent> }[] = [];
  for (const e of events) {
    if (String(e.agent) !== evaluation.agent) continue;
    const day = eventDay(e, evaluation.timeZone);
    if (day === null || !dayIn(day, onset.interval)) continue;
    inI.push({ event: e, day, cls: classifyEvent(e, TRIPWIRES_OFF) });
  }
  const youStrong = inI.filter((c) => c.cls.class === "you_strong");

  const dropped: { dim: StratumDim; events: string[] }[] = [];
  for (const dim of STRATUM_DIMS) {
    const ids = youStrong.filter((c) => DROPS[c.event.kind] === dim).map((c) => String(c.event.id));
    if (ids.length > 0) dropped.push({ dim, events: ids });
  }
  const dims = STRATUM_DIMS.filter((d) => !dropped.some((x) => x.dim === d));

  const ruleOut = youStrong.map((c) => ruleOutCandidate(prepared, evaluation, c.event, side, floor));
  const versions = inI.filter((c) => c.cls.class === "agent_routine" && c.event.kind === "version").map((c) => ({ event: c.event, day: c.day }));
  const boundary = versionBoundaryTest(prepared, evaluation, versions, side, observed, { floor, ...(opts.boundaryDays !== undefined ? { days: opts.boundaryDays } : {}) });
  return { ...base, onset, ruleOut, boundary, dims, dropped };
}
