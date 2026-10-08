/**
 * One synthetic user, replayed day by day (G-null-seq, METHOD.md §14): every evaluation day runs the evaluation, the
 * decider and the glance persistence exactly as the product would, so a false alarm is counted per USER OVER TIME
 * (did the glance ever claim a change in 90 days?), never per window.
 *
 * For each (candidate method × voting tool-error construct) the sequence yields one `Track`: the persisted glance's
 * history (ever changed / agent / you / non-steady / single_indicator, first changed day), the raw (unpersisted)
 * daily outputs, and the tier / extension / df-floor bookkeeping that shows those paths were exercised.
 */
import type { ChangeEvent } from "../../types.js";
import { assessConfounders, type ConfounderAssessment } from "../confounders/assess.js";
import type { AnalysisMethod } from "../gates/d23.js";
import type { AgentEvaluation } from "../gates/evaluate.js";
import { dfFloor } from "../confounders/agreement.js";
import type { ToolErrorVariant } from "../metrics/defs.js";
import { dayIndex } from "../stats/ratio.js";
import { DaySeries, ERRORS_VOTES, evaluateDay } from "./day.js";
import { changedOfOutput, glanceKey, interimDecider, isChangedKey, type Decider, type DeciderOutput } from "./decider.js";
import { DailyWork, Glance, INITIAL_GLANCE } from "./persistence.js";
import { aggregateLabelRows, aggregateSessionDays, EVAL_DAYS, generateSequence, planDayIndex, PRE_DAYS, type Sequence, type SequenceSpec } from "./synth.js";

export interface Candidate {
  id: string;
  method: AnalysisMethod;
}

export interface Track {
  candidate: string;
  errorsVote: ToolErrorVariant;
  /** Persisted glance. Eval days are 1 … EVAL_DAYS. */
  everChanged: boolean;
  firstChanged: number | null;
  everAgent: boolean;
  everYou: boolean;
  /** Displayed key ever outside none / insufficient. */
  everNonSteady: boolean;
  everSingle: boolean;
  everNone: boolean;
  everMixed: boolean;
  everWorkload: boolean;
  /** Days the displayed key held each value. */
  displayedDays: Record<string, number>;
  /** Raw (unpersisted) decider outputs. */
  rawChangedDays: number;
  firstRawChanged: number | null;
  rawAgentDays: number;
  rawSingleDays: number;
  rowDays: Record<string, number>;
  /** The decider's onset interval on the day the persisted glance first claimed a change (G-onset). */
  onsetAtDetection: { from: string; to: string } | null;
  /** Eval days on which the displayed key switched INTO a changed-class key, and the decider's onset on each. */
  changedStarts: number[];
  /** The displayed key at each of those switches. */
  changedStartKeys: string[];
  onsetAtStarts: ({ from: string; to: string } | null)[];
  /** Selected-tier days (key "none" | "1" | "2" | "3") and days the selection extended past the smallest available tier. */
  tierDays: Record<string, number>;
  extensionDays: number;
  /** Days the errors family had an eligible voting metric in the selected tier (the calibration is not vacuous). */
  errorsEligibleDays: number;
  researchEligibleDays: number;
  /** Days some voting metric sat under the df floor; days "changed" was removed by the fragility rule. */
  lowDfDays: number;
  fragileDays: number;
  /** Days a persisting decider reported a pending change. */
  pendingDays: number;
  /** Per decider diagnostic: days it was true (booleans) or summed (numbers), and whether it was ever true. */
  diagDays: Record<string, number>;
  diagEver: Record<string, boolean>;
}

export interface SequenceResult {
  profile: string;
  agent: string;
  seed: string;
  /** Eval day on which a planted change first shows (its plan day + 1 − PRE_DAYS); null for a null sequence. */
  onsetEvalDay: number | null;
  /** Planted onset as a calendar day. */
  onsetDay: string | null;
  tracks: Track[];
  exchanges: number;
  sessions: number;
  ms: number;
}

export interface RunOptions {
  candidates: readonly Candidate[];
  errorsVotes?: readonly ToolErrorVariant[];
  decider?: Decider;
  /** Decision-table row 1 input (METHOD.md §11; default true: calibration evaluates the verdict rules themselves). */
  calibrated?: boolean;
}

function newTrack(candidate: string, errorsVote: ToolErrorVariant): Track {
  return {
    candidate, errorsVote, everChanged: false, firstChanged: null, everAgent: false, everYou: false, everNonSteady: false,
    everSingle: false, everNone: false, everMixed: false, everWorkload: false, displayedDays: {},
    rawChangedDays: 0, firstRawChanged: null, rawAgentDays: 0, rawSingleDays: 0, rowDays: {}, onsetAtDetection: null,
    changedStarts: [], changedStartKeys: [], onsetAtStarts: [],
    tierDays: {}, extensionDays: 0, errorsEligibleDays: 0, researchEligibleDays: 0, lowDfDays: 0, fragileDays: 0, pendingDays: 0,
    diagDays: {}, diagEver: {},
  };
}

const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);

/** Events strictly before `today`, oldest first. */
function eventsBefore(events: readonly ChangeEvent[], today: string): ChangeEvent[] {
  return events.filter((e) => e.day < today);
}

/** Run one already generated sequence. */
export function replaySequence(seq: Sequence, opts: RunOptions): SequenceResult {
  const t0 = performance.now();
  const decider = opts.decider ?? interimDecider;
  const errorsVotes = opts.errorsVotes ?? decider.errorsVotes ?? ERRORS_VOTES;
  const calibrated = opts.calibrated ?? true;
  const rows = aggregateSessionDays(seq.exchanges);
  const series = new DaySeries(seq.agent, rows);
  const tracks = new Map<string, Track>();
  const glances = new Map<string, Glance>();
  const previous = new Map<string, DeciderOutput>();
  for (const c of opts.candidates) {
    for (const v of errorsVotes) {
      tracks.set(`${c.id}|${v}`, newTrack(c.id, v));
      glances.set(`${c.id}|${v}`, new Glance(INITIAL_GLANCE));
    }
  }
  const planted = (seq.spec.planted ?? []).filter((e) => e.effect !== undefined && Object.keys(e.effect).length > 0);
  const onsetPlan = planted.length > 0 ? Math.min(...planted.map((e) => e.day)) : null;
  const dayIdxOf = (d: string) => dayIndex(d)!;

  const show = (tr: Track, g: Glance, before: string, shown: string, out: DeciderOutput, k: number) => {
    bump(tr.displayedDays, shown);
    if (isChangedKey(shown) && !isChangedKey(before)) {
      tr.changedStarts.push(k);
      tr.changedStartKeys.push(shown);
      tr.onsetAtStarts.push(out.onset ?? null);
    }
    const state = shown.split(":")[0];
    if (isChangedKey(shown) && !tr.everChanged) {
      tr.everChanged = true;
      tr.firstChanged = k;
      tr.onsetAtDetection = out.onset ?? null;
    }
    if (state === "agent") tr.everAgent = true;
    if (state === "you") tr.everYou = true;
    if (state !== "none" && state !== "insufficient") tr.everNonSteady = true;
    if (shown === "insufficient:single_indicator") tr.everSingle = true;
    if (state === "none") tr.everNone = true;
    if (shown === "unclear:mixed") tr.everMixed = true;
    if (shown === "unclear:workload") tr.everWorkload = true;
    void g;
  };

  if (decider.decideDay) {
    // Pipeline decider (WP-21): the exchanges (or label rows, both sorted by day) and recorded events before today,
    // its own persistence.
    const input = decider.rows ? aggregateLabelRows(seq.exchanges) : seq.exchanges;
    const days = input.map((x) => dayIndex(x.day)!);
    let n = 0;
    for (let k = 1; k <= EVAL_DAYS; k++) {
      const todayIdx = planDayIndex(PRE_DAYS + k);
      while (n < days.length && days[n]! < todayIdx) n++;
      const xs = input.slice(0, n);
      const today = new Date(todayIdx * 86_400_000).toISOString().slice(0, 10);
      const events = eventsBefore(seq.events, today);
      for (const c of opts.candidates) {
        for (const v of errorsVotes) {
          const key = `${c.id}|${v}`;
          const tr = tracks.get(key)!;
          const g = glances.get(key)!;
          const { output: out, evaluation: ev } = decider.decideDay({
            agent: seq.agent, exchanges: xs, events, method: c.method, errorsVote: v, today, now: `${today}T12:00:00.000Z`,
            calibrated, previous: previous.get(key) ?? null,
          });
          previous.set(key, out);
          record(tr, ev, out, k);
          if (out.pending !== undefined && out.pending !== null && out.pending !== false) tr.pendingDays++;
          const before = g.displayed;
          g.displayed = glanceKey(out);
          show(tr, g, before, g.displayed, out, k);
        }
      }
    }
    return finish();
  }

  for (let k = 1; k <= EVAL_DAYS; k++) {
    const todayIdx = planDayIndex(PRE_DAYS + k);
    const day = series.prepare(todayIdx);
    const events = eventsBefore(seq.events, day.today);
    const work = new Map<ToolErrorVariant, DailyWork>();
    for (const v of errorsVotes) work.set(v, new DailyWork(day.build.cells[v], dayIdxOf));
    for (const c of opts.candidates) {
      const evals = evaluateDay(series, day, c.method, errorsVotes);
      for (const v of errorsVotes) {
        const ev = evals.get(v)!;
        const key = `${c.id}|${v}`;
        const tr = tracks.get(key)!;
        let conf: ConfounderAssessment | undefined;
        const out: DeciderOutput = decider.decide!({
          evaluation: ev,
          confounders: () => (conf ??= assessConfounders(day.rows, ev)),
          events,
          calibrated,
          previous: previous.get(key) ?? null,
          today: day.today,
          now: `${day.today}T12:00:00.000Z`,
        });
        previous.set(key, out);
        record(tr, ev, out, k);
        const g = glances.get(key)!;
        const tier = ev.tiers.find((t) => t.tier === (ev.selectedTier ?? 1))!;
        const m = tier.metrics.find((x) => x.id === v)!;
        const before = g.displayed;
        // A persisting decider's state is the glance; otherwise the harness applies persistence (METHOD.md §12; persistence.ts).
        const shown = decider.persists
          ? (g.displayed = glanceKey(out))
          : g.step(
            { key: glanceKey(out), todayIdx, recentFrom: dayIdxOf(tier.windows.recent.from), recentDen: m.recent.denominator },
            work.get(v)!,
          );
        if (out.pending !== undefined && out.pending !== null && out.pending !== false) tr.pendingDays++;
        show(tr, g, before, shown, out, k);
      }
    }
  }
  return finish();

  function finish(): SequenceResult {
  const sessions = new Set(seq.exchanges.map((x) => x.session)).size;
  return {
    profile: seq.spec.profile,
    agent: seq.agent,
    seed: seq.spec.seed,
    onsetEvalDay: onsetPlan === null ? null : onsetPlan + 1 - PRE_DAYS,
    onsetDay: onsetPlan === null ? null : seq.exchanges.length ? dayStringOfPlan(onsetPlan) : null,
    tracks: [...tracks.values()],
    exchanges: seq.exchanges.length,
    sessions,
    ms: performance.now() - t0,
  };
  }
}

function dayStringOfPlan(planDay: number): string {
  return new Date(planDayIndex(planDay) * 86_400_000).toISOString().slice(0, 10);
}

function record(tr: Track, ev: AgentEvaluation, out: DeciderOutput, k: number): void {
  bump(tr.rowDays, out.row === undefined ? "n/a" : String(out.row));
  for (const [name, v] of Object.entries(out.diag ?? {})) {
    const inc = typeof v === "number" ? v : v ? 1 : 0;
    tr.diagDays[name] = (tr.diagDays[name] ?? 0) + inc;
    if (inc > 0) tr.diagEver[name] = true;
  }
  if (changedOfOutput(out)) {
    tr.rawChangedDays++;
    if (tr.firstRawChanged === null) tr.firstRawChanged = k;
  }
  if (out.state === "agent") tr.rawAgentDays++;
  if (out.reason === "single_indicator") tr.rawSingleDays++;
  if (out.fragile) tr.fragileDays++;
  bump(tr.tierDays, ev.selectedTier === null ? "none" : String(ev.selectedTier));
  const available = ev.tiers.filter((t) => t.historyMet);
  if (ev.selectedTier !== null && available.length > 0 && ev.selectedTier > available[0]!.tier) tr.extensionDays++;
  const tier = ev.selectedTier === null ? undefined : ev.tiers.find((t) => t.tier === ev.selectedTier);
  if (tier) {
    const voting = tier.metrics.filter((m) => m.role === "vote");
    if (voting.some((m) => m.family === "errors" && m.eligible)) tr.errorsEligibleDays++;
    if (voting.some((m) => m.family === "research" && m.eligible)) tr.researchEligibleDays++;
    if (dfFloor(tier.metrics).lowDf.length > 0) tr.lowDfDays++;
  }
}

/** Generate and replay. */
export function runSequence(spec: SequenceSpec, opts: RunOptions): SequenceResult {
  return replaySequence(generateSequence(spec), opts);
}
