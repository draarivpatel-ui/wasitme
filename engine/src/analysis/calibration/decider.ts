/**
 * The decision layer's interface, as the calibration harness drives it, and the INTERIM decider.
 *
 * WP-21 builds the real decision table of METHOD.md §11 (onset, version-boundary test, strata rule-out, attribution).
 * Until then the harness calibrates what exists today through `interimDecider`. WP-21's pure
 *   decide({ evaluation, confounders, events, calibrated, previous, options, today, now }) → { state, reason, pending, trace }
 * drops in through `fromDecide` (a thin adapter, below) registered in jobs.ts `DECIDERS`; every gate — G-null-seq,
 * G-attr, G-onset — is then filled from its outputs with no other harness change. A decider that applies the
 * persistence rule (METHOD.md §12) itself (from `previous`, reporting `pending`) sets `persists`, and the harness then
 * shows its state as the glance instead of running its own persistence (persistence.ts).
 *
 * Interim rules (METHOD.md §11 rows 1–4 and 12–14 exactly; rows 5–11 collapsed into one placeholder state):
 *   1  not calibrated                                         → insufficient (calibration_pending)
 *   2  no tier, or some voting family has no eligible voting metric in the selected tier
 *                                                             → insufficient (needs_data)
 *   3  material voting metrics disagree in direction          → unclear (mixed)
 *      "changed" = `changedOf` (D53(c): the single source), minus the fragility rule of METHOD.md §7 (dropping one of
 *      the 3 most influential days removes it → not changed)
 *   4  changed, and the standardised-ratio or projects rule fails → unclear (workload)
 *   5–11 changed                                              → changed_unattributed   (WP-21: you / agent / unclear …)
 *   12 not changed; exactly one material voting metric, usable, surviving Holm → insufficient (single_indicator)
 *   13 not changed; no material voting metric; a sensitive voting metric in each voting family; no voting metric under
 *      the df floor (D53(d): low_df blocks `none`)           → none
 *   14 otherwise                                              → insufficient (needs_data)
 */
import type { AgentId, ChangeEvent, Exchange } from "../../types.js";
import type { VerdictReason as ContractReason, VerdictState as ContractState } from "../../contract/vocab.js";
import type { AnalysisMethod } from "../gates/d23.js";
import type { ToolErrorVariant } from "../metrics/defs.js";
import type { AgentEvaluation } from "../gates/evaluate.js";
import type { ConfounderAssessment } from "../confounders/assess.js";
import { changedOf, DF_FLOOR, dfFloor } from "../confounders/agreement.js";
import { singleIndicatorNote } from "../confounders/single.js";
import { VOTING_FAMILIES, type MetricId } from "../metrics/defs.js";

/** The contract's verdict states (contract/vocab.ts), plus the interim placeholder for "changed, not attributed yet". */
export type VerdictState = ContractState | "changed_unattributed";

/** The contract's reasons (`needs_data` = rows 2 and 14, "insufficient, with progress"). */
export type VerdictReason = ContractReason;

export interface DeciderInput {
  /** The day's evaluation (`evaluateAgent` output, or the harness's equivalent). */
  evaluation: AgentEvaluation;
  /**
   * The confounder assessment of `evaluation` (`assessConfounders` on the same exchanges), computed on first call and
   * memoised: it is the expensive part (strata cells, leave-one-session-out), so call it only when a rule needs it.
   */
  confounders(): ConfounderAssessment;
  /** The agent's change events strictly before `evaluation.today`, oldest first (METHOD.md §9 labels). */
  events: readonly ChangeEvent[];
  /** Decision-table row 1. The harness passes true while it calibrates (the flag is what calibration decides). */
  calibrated: boolean;
  /** This track's previous decision (yesterday's evaluation), or null on the first evaluation. */
  previous: DeciderOutput | null;
  /** The evaluation's local day ("YYYY-MM-DD", = evaluation.today) and instant (ISO; 12:00 UTC of that day). No clock reads. */
  today: string;
  now: string;
}

export interface DeciderOutput {
  state: VerdictState;
  reason: VerdictReason | null;
  /** The decision-table row that matched (1–14; the interim decider reports 5 for its collapsed rows 5–11). */
  row?: number;
  /**
   * A "changed" row (4–11) matched: "changed" (METHOD.md §7) held after the fragility rule. When absent the harness
   * derives it from the state (`isChangedKey`). For a persisting decider this is the RAW (unpersisted) call, if it
   * reports one.
   */
  changed?: boolean;
  /** A persisting decider's pending change ("Possible shift — confirming"); opaque to the harness, counted only. */
  pending?: unknown;
  /** The decider's own trace (opaque; never aggregated). */
  trace?: unknown;
  /** Adapter slot: the wrapped decider's own output, handed back to it as `previous` on the next day. */
  raw?: unknown;
  /** Diagnostic flags/counts the harness aggregates per day (e.g. D56's row-5-from-derived-events count). */
  diag?: Record<string, boolean | number>;
  /** single_indicator: the metric the headline names. */
  metric?: MetricId | null;
  /** Onset interval I (METHOD.md §10; inclusive "YYYY-MM-DD" days), when the decider estimates one. G-onset reads it. */
  onset?: { from: string; to: string } | null;
  /** Changed was removed by the 3-most-influential-days rule (trace). */
  fragile?: boolean;
}

/** The pipeline form's input: what the product has on an evaluation day (WP-21's `attributeAgent` takes this). */
export interface PipelineDayInput {
  agent: AgentId;
  /**
   * The agent's synthetic exchanges dated before today: raw (one per exchange), or label rows (`aggregateLabelRows`,
   * each carrying `n`, the exchanges it stands for) when the decider sets `rows`.
   */
  exchanges: readonly Exchange[];
  /** Recorded change events dated before today (METHOD.md §9 labels). */
  events: readonly ChangeEvent[];
  method: AnalysisMethod;
  errorsVote: ToolErrorVariant;
  today: string;
  now: string;
  calibrated: boolean;
  previous: DeciderOutput | null;
}

export interface PipelineDayOutput {
  output: DeciderOutput;
  /** The evaluation the decision was made on (the harness's tier / eligibility bookkeeping reads it). */
  evaluation: AgentEvaluation;
}

/**
 * A decider: either the decision step alone (`decide`, given the harness's evaluation and confounders) or the whole
 * pipeline from exchanges (`decideDay`, e.g. WP-21's attributeAgent). Exactly one is used: `decideDay` when present.
 */
export interface Decider {
  /** Recorded in the calibration artifact. */
  id: string;
  /** True when the decider applies the persistence rule (METHOD.md §12) itself (from `previous`): its state IS the glance. */
  persists?: boolean;
  /** Voting tool-error constructs it is judged under (default: both, ERRORS_VOTES). */
  errorsVotes?: readonly ToolErrorVariant[];
  decide?(input: DeciderInput): DeciderOutput;
  decideDay?(input: PipelineDayInput): PipelineDayOutput;
  /** `decideDay` takes label rows (synth.ts `aggregateLabelRows`) instead of raw exchanges (D58 speed-up). */
  rows?: boolean;
}

/** The shape WP-21's `decide` is announced with (fields beyond these pass through untouched). */
export interface DecideFnInput {
  evaluation: AgentEvaluation;
  confounders: ConfounderAssessment;
  events: readonly ChangeEvent[];
  calibrated: boolean;
  previous: unknown;
  options: unknown;
  today: string;
  now: string;
}

export interface DecideFnOutput {
  state: string;
  reason?: string | null;
  pending?: unknown;
  trace?: unknown;
}

export interface FromDecideOptions<O extends DecideFnOutput> {
  /** Passed through as `input.options`. */
  options?: unknown;
  /** Whether the wrapped decide applies persistence itself (default true: it receives `previous` and reports `pending`). */
  persists?: boolean;
  /** Where its onset interval I is, for G-onset (default: none). */
  onsetOf?: (out: O) => { from: string; to: string } | null;
  /** Its raw (unpersisted) "changed" call, when it reports one; default: derived from the state. */
  changedOf?: (out: O) => boolean;
  /** The decision-table row it matched, when it reports one. */
  rowOf?: (out: O) => number | undefined;
}

/**
 * Thin adapter from a WP-21-style pure `decide` to the harness's `Decider`: computes the confounder assessment (the
 * wrapped function takes it as a value), hands back its own previous output, and maps its output fields.
 */
export function fromDecide<O extends DecideFnOutput>(id: string, decide: (input: DecideFnInput) => O, opts: FromDecideOptions<O> = {}): Decider {
  return {
    id,
    persists: opts.persists ?? true,
    decide(input: DeciderInput): DeciderOutput {
      const out = decide({
        evaluation: input.evaluation,
        confounders: input.confounders(),
        events: input.events,
        calibrated: input.calibrated,
        previous: input.previous?.raw ?? null,
        options: opts.options,
        today: input.today,
        now: input.now,
      });
      const mapped: DeciderOutput = {
        state: out.state as VerdictState,
        reason: (out.reason ?? null) as VerdictReason | null,
        pending: out.pending,
        trace: out.trace,
        raw: out,
        onset: opts.onsetOf ? opts.onsetOf(out) : null,
      };
      if (opts.changedOf) mapped.changed = opts.changedOf(out);
      const row = opts.rowOf?.(out);
      if (row !== undefined) mapped.row = row;
      return mapped;
    },
  };
}

/** The raw "changed" call of an output: its own flag, else its state (rows 4–11). */
export function changedOfOutput(o: DeciderOutput): boolean {
  return o.changed ?? isChangedKey(glanceKey(o));
}

export const interimDecider: Decider & { decide(input: DeciderInput): DeciderOutput } = {
  id: "interim-wp23 (rows 1-4, 12-14; rows 5-11 collapsed to changed_unattributed)",
  decide(input: DeciderInput): DeciderOutput {
    if (!input.calibrated) return { state: "insufficient", reason: "calibration_pending", row: 1, changed: false };
    const ev = input.evaluation;
    const tier = ev.selectedTier === null ? undefined : ev.tiers.find((t) => t.tier === ev.selectedTier);
    if (tier === undefined) return { state: "insufficient", reason: "needs_data", row: 2, changed: false };
    const metrics = tier.metrics;
    const voting = metrics.filter((m) => m.role === "vote");
    if (!VOTING_FAMILIES.every((f) => voting.some((m) => m.family === f && m.eligible))) {
      return { state: "insufficient", reason: "needs_data", row: 2, changed: false };
    }
    const ch = changedOf(metrics, DF_FLOOR);
    if (ch.mixed) return { state: "unclear", reason: "mixed", row: 3, changed: false };
    let fragile = false;
    if (ch.changed) {
      const c = input.confounders();
      fragile = c.fragility.days.fragile;
      if (!fragile) {
        if (c.workload.unclear) return { state: "unclear", reason: "workload", row: 4, changed: true };
        return { state: "changed_unattributed", reason: null, row: 5, changed: true };
      }
    }
    const note = singleIndicatorNote(metrics, ev.method.level, DF_FLOOR);
    if (note.kind === "single_indicator") {
      return { state: "insufficient", reason: "single_indicator", row: 12, changed: false, metric: note.metric?.id ?? null, fragile };
    }
    const sensitiveEach = VOTING_FAMILIES.every((f) => voting.some((m) => m.family === f && m.eligible && m.sensitive));
    if (!note.blocksNone && sensitiveEach && dfFloor(metrics, DF_FLOOR).lowDf.length === 0) {
      return { state: "none", reason: null, row: 13, changed: false, fragile };
    }
    return { state: "insufficient", reason: "needs_data", row: 14, changed: false, fragile };
  },
};

/** Glance key of an output: state plus reason (what the glance shows). */
export function glanceKey(o: Pick<DeciderOutput, "state" | "reason">): string {
  return o.reason === null ? o.state : `${o.state}:${o.reason}`;
}

/** Keys whose glance claims a change (rows 4–11 and their WP-21 states). */
export function isChangedKey(key: string): boolean {
  const state = key.split(":")[0];
  if (state === "you" || state === "agent" || state === "changed_unattributed") return true;
  return state === "unclear" && key !== "unclear:mixed";
}
