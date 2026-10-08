/**
 * The whole attribution pipeline for one agent (what WP-23's `Decider` wraps). Pure and deterministic: same
 * exchanges + events + options (incl. `now`) → identical output. No I/O, no clock reads.
 *
 *  1. 20a `evaluateAgent` (errorsVote is REQUIRED — D47d: until G0 decides, callers pass
 *     `G0_FALLBACK_ERRORS_VOTE` = "toolErrorsNonCmd" explicitly; nothing here defaults it).
 *  2. Cells once (`prepare`), then the events: the caller's reader/configsnap events (minus /model · /effort re-picks
 *     of the value already in effect, D65), plus between-session label
 *     changes derived from Exchange labels (labels.ts), plus tripwire detections (tripwires.ts) — merged and
 *     deduplicated (events.ts), then one version event per new version (labels.ts `collapseVersionRepeats`).
 *  3. Evidence (evidence.ts): onset, rule-outs, the version-boundary test, D53 dims, persistence data.
 *  4. 20b `assessConfounders` ONCE, with `evidence.dims` (D53a: a you·strong model/entrypoint change in I drops that
 *     stratum dimension before the workload test).
 *  5. `decide`.
 */
import { assessConfounders, type ConfounderAssessment } from "../confounders/assess.js";
import { evaluateAgent, type AgentEvaluation, type EvaluateOptions } from "../gates/evaluate.js";
import type { MetricExchange } from "../metrics/defs.js";
import { decide, type DecideOptions } from "./decide.js";
import { mergeEvents } from "./events.js";
import { gatherEvidence, prepare, type EvidenceOptions } from "./evidence.js";
import { collapseVersionRepeats, dropRepicks, labelChangeEvents, type ExchangeWeight } from "./labels.js";
import { servedModelTripwire, signalEvents, type ServedModelOptions, type TripwireSignal } from "./tripwires.js";
import type { AttributionEvent, AttributionEvidence, Decision, OnsetOptions } from "./types.js";

export interface AttributeOptions extends EvaluateOptions {
  /** Whether this agent's verdicts are calibrated (D23; Codex off until its own null calibration passes). */
  calibrated: boolean;
  previous?: Decision | null;
  /** Fully observed local days (store snapshot records, WP-12). Default none. */
  fullyObservedDays?: readonly string[];
  /** Default: true for Codex (METHOD.md §9). */
  partialByDesign?: boolean;
  /** Derive between-session version/model/effort changes from Exchange labels (default true). */
  deriveLabels?: boolean;
  /**
   * How many log exchanges each input stands for, in the label derivation's day-majority count (default 1). Only for
   * inputs that are aggregates with uniform labels (the calibration harness's session-day rows, calibration/synth.ts
   * `aggregateLabelRows`); every other step works on sums, so aggregates give the same decision.
   */
  exchangeWeight?: ExchangeWeight;
  /** Tripwire admissibility and detector settings (default all off). */
  decide?: DecideOptions;
  servedModel?: ServedModelOptions;
  /** Vendor-template / cache_miss signals from a future source (S11 / S-TRIP). */
  signals?: readonly TripwireSignal[];
  onset?: Partial<OnsetOptions>;
  boundaryDays?: number;
  dfFloor?: number;
}

export interface Attribution {
  evaluation: AgentEvaluation;
  confounders: ConfounderAssessment;
  evidence: AttributionEvidence;
  /** The merged, deduplicated events the decision saw (oldest first). */
  events: AttributionEvent[];
  /** Ids of the recorded /model · /effort events dropped as re-picks of the value already in effect (D65). */
  repicks: string[];
  decision: Decision;
}

/** Run the pipeline (see the file header). `events`: the agent's reader/configsnap change events. */
export function attributeAgent(exchanges: readonly MetricExchange[], events: readonly AttributionEvent[], opts: AttributeOptions): Attribution {
  if (typeof opts.calibrated !== "boolean") throw new RangeError("calibrated is required (true / false)");
  const evaluation = evaluateAgent(exchanges, opts);
  const prepared = prepare(exchanges, evaluation);
  const agent = evaluation.agent;
  // D65: a /model or /effort that re-picks the value already in effect is not a change (labels.ts `dropRepicks`).
  const repick = dropRepicks(agent, prepared.used, events.filter((e) => e && String(e.agent) === agent), evaluation.timeZone, opts.exchangeWeight);
  const recorded = repick.kept;
  const derived = opts.deriveLabels === false ? [] : labelChangeEvents(agent, prepared.used, recorded, opts.exchangeWeight);
  const served = servedModelTripwire(agent, prepared.used, opts.servedModel);
  const signals = signalEvents(agent, opts.signals ?? [], recorded);
  // One event per new version: resumed sessions record the same update again (labels.ts `collapseVersionRepeats`).
  const merged = collapseVersionRepeats(agent, mergeEvents(agent, evaluation.timeZone, recorded, derived, served, signals), evaluation.timeZone);
  const evOpts: EvidenceOptions = { calibrated: opts.calibrated };
  if (opts.dfFloor !== undefined) evOpts.dfFloor = opts.dfFloor;
  if (opts.onset !== undefined) evOpts.onset = opts.onset;
  if (opts.boundaryDays !== undefined) evOpts.boundaryDays = opts.boundaryDays;
  if (opts.fullyObservedDays !== undefined) evOpts.fullyObservedDays = opts.fullyObservedDays;
  if (opts.partialByDesign !== undefined) evOpts.partialByDesign = opts.partialByDesign;
  const evidence = gatherEvidence(prepared, evaluation, merged, evOpts);
  const confounders = assessConfounders(exchanges, evaluation, { dims: evidence.dims, ...(opts.dfFloor !== undefined ? { dfFloor: opts.dfFloor } : {}) });
  const decision = decide({
    evaluation, confounders, evidence, events: merged, calibrated: opts.calibrated, previous: opts.previous ?? null, now: opts.now,
    options: { ...opts.decide, ...(opts.dfFloor !== undefined ? { dfFloor: opts.dfFloor } : {}) },
  });
  return { evaluation, confounders, evidence, events: merged, repicks: repick.dropped, decision };
}
