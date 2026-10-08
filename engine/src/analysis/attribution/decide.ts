/**
 * The decision table (METHOD.md §11) as ONE pure function, plus persistence (METHOD.md §12).
 *
 *   decide(input) → Decision { state, reason, pending, trace, … }
 *
 * Pure and deterministic: no I/O, no clock reads (`now` is passed in), no randomness, no bootstraps — every
 * statistic it reads was computed upstream (20a evaluation, 20b assessment, `gatherEvidence`). The same input always
 * gives the same output, so WP-23's calibration harness can wrap it directly (`attributeAgent` runs the whole
 * pipeline).
 *
 * Rows (first match wins); "changed" = 20b `changedOf` (D53c, the single source) AND not fragile under the
 * 3-most-influential-days rule (METHOD.md §7):
 *   1  not calibrated                                                         → insufficient (calibration_pending)
 *   2  no tier selected, or at the selected tier (20a: the first ready tier, else the largest with its history met)
 *      some voting family has no ELIGIBLE voting metric                     → insufficient (needs_data)
 *   3  material voting metrics on both sides (20b `changed.mixed`)           → unclear (mixed)
 *   4  changed ∧ 20b workload test fails (with D53's dims)                   → unclear (workload)
 *   5  changed ∧ an `unknown` candidate in I (incl. an undated decisive event) → unclear (unknown_provenance)
 *   6  changed ∧ an open you·strong candidate ∧ an admitted agent·strong one  → unclear (both_sides)
 *   7  changed ∧ an open you·strong candidate ∧ no admitted agent·strong     → you
 *   8  changed ∧ an admitted agent·strong candidate ∧ no open you·strong     → agent (+ blind spot if partial)
 *   9  changed ∧ only routine / weak / context / ruled-out candidates ∧ I fully observed ∧ boundary test passes
 *                                                                            → agent (by_elimination)
 *  10  changed ∧ only routine / weak / … ∧ I fully observed                  → unclear (nothing_recorded_on_your_side)
 *  11  changed ∧ only routine / weak / … ∧ I partially observed             → unclear (blind_spot)
 *  12  not changed ∧ 20b single-indicator note is `single_indicator` (one usable material voting metric that
 *      survives Holm)                                                       → insufficient (single_indicator)
 *  13  not changed ∧ no material voting metric ∧ in each voting family a voting metric that is eligible, sensitive
 *      and above the df floor (D53d)                                         → none
 *  14  otherwise                                                             → insufficient (needs_data)
 *
 * A ruled-out you·strong candidate is eliminated (row 8's "every strong you-candidate is ruled out"), so rows 9–11
 * apply to what remains. Candidates are the events dated inside I (meta skipped); tripwires count only when their
 * option is on (default off).
 *
 * Persistence (glance surfaces): the displayed (state, reason) moves only when two evaluations agree — the
 * evaluation that first produced the new outcome (the anchor) and a later one with the same outcome, at least 24 h
 * later in data time, whose recent window adds ≥ 30% new denominator for every voting metric (vs the anchor's
 * recent window) and ≥ 2 new session-days. An evaluation with a third outcome, or the displayed one, resets the
 * wait. Leaving a state follows the same rule, with one exception: a move to insufficient (needs_data) while NO new
 * session-day arrived since the anchor (the agent went quiet; its recent windows read 0 / 0) is confirmed on time
 * alone, ≥ 24 h after the anchor (`quiet`, rule "confirmed_quiet") — it can never gather the new data the rule asks
 * for, and holding the old finding forever would show "No detectable change" over no data. Row 1 bypasses
 * persistence both ways (CONTRACT: `calibrated: false` ⇔ insufficient (calibration_pending)). A clock that went
 * backward (`now` before the anchor) re-anchors the wait instead of confirming; nothing throws.
 */
import type { VerdictReason, VerdictState } from "../../contract/vocab.js";
import { usableForVerdict } from "../confounders/agreement.js";
import type { ConfounderAssessment } from "../confounders/assess.js";
import type { StratumDim } from "../confounders/strata.js";
import type { AgentEvaluation, TierEvaluation } from "../gates/evaluate.js";
import { VOTING_FAMILIES, type MetricId } from "../metrics/defs.js";
import { dayIndex, dayString } from "../stats/ratio.js";
import { classifyEvent, dayIn, eventDay, mergeEvents } from "./events.js";
import {
  TRIPWIRES_OFF,
  type AttributionEvent, type AttributionEvidence, type Candidate, type Decision, type Fingerprint, type Observation,
  type PendingCandidate, type PersistenceData, type TraceCondition, type TraceRow, type TripwireOptions, type Verdict,
} from "./types.js";

export interface PersistenceOptions {
  /** Minimum data-time gap between the two agreeing evaluations (hours). */
  minHours: number;
  /** New denominator in the second's recent window, as a share of the anchor's recent-window denominator. */
  minNewShare: number;
  /** New session-days in the second's recent window. */
  minNewSessionDays: number;
}

export const PERSISTENCE_DEFAULTS: Readonly<PersistenceOptions> = Object.freeze({ minHours: 24, minNewShare: 0.3, minNewSessionDays: 2 });

export interface DecideOptions {
  /** Tripwire admissibility (default all off). */
  tripwires?: Partial<TripwireOptions>;
  /** `false` disables persistence (investigations are always live). */
  persistence?: Partial<PersistenceOptions> | false;
  /** df floor for row 13's "usable" check (default: the assessment's own floor). */
  dfFloor?: number;
}

export interface DecideInput {
  evaluation: AgentEvaluation;
  /** Assessed at the evaluation's selected tier, with `evidence.dims` (D53). */
  confounders: ConfounderAssessment;
  evidence: AttributionEvidence;
  /** The agent's change events (reader + configsnap + derived + tripwire), already deduplicated. */
  events: readonly AttributionEvent[];
  calibrated: boolean;
  /** The last decision for this agent, or null. */
  previous: Decision | null;
  /** Evaluation time (data time); never read from the clock. */
  now: Date;
  options?: DecideOptions;
}

/** Event kinds whose you·strong change must have dropped a stratum dimension (D53a). */
const DROPS: Partial<Record<string, StratumDim>> = { model: "model", entrypoint: "entrypoint" };

function selected(evaluation: AgentEvaluation): TierEvaluation | undefined {
  return evaluation.selectedTier === null ? undefined : evaluation.tiers.find((t) => t.tier === evaluation.selectedTier);
}

function checkConsistent(input: DecideInput): void {
  const { evaluation: ev, confounders: cf, evidence } = input;
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new RangeError("now must be a valid Date");
  if (cf.agent !== ev.agent || evidence.agent !== ev.agent) throw new RangeError(`agent mismatch: evaluation ${ev.agent}, confounders ${cf.agent}, evidence ${evidence.agent}`);
  if (evidence.today !== ev.today) throw new RangeError(`evidence.today ${evidence.today} ≠ evaluation.today ${ev.today}`);
  if (cf.tier !== ev.selectedTier || evidence.tier !== ev.selectedTier) {
    throw new RangeError(`tier mismatch: selected ${String(ev.selectedTier)}, confounders ${String(cf.tier)}, evidence ${String(evidence.tier)}`);
  }
}

/** Candidates inside I (see the file header); `undated` decisive events count as `unknown`. */
function candidatesOf(input: DecideInput, interval: { from: string; to: string }, tripwires: Readonly<TripwireOptions>): Candidate[] {
  const { evaluation: ev, evidence } = input;
  const ruled = new Map(evidence.ruleOut.map((r) => [r.event, r]));
  const boundary = evidence.boundary;
  const out: Candidate[] = [];
  for (const e of mergeEvents(ev.agent, ev.timeZone, input.events)) {
    const cls = classifyEvent(e, tripwires);
    if (cls.class === "meta") continue;
    const day = eventDay(e, ev.timeZone);
    const base = {
      event: String(e.id), kind: e.kind, side: e.side, strength: e.strength ?? null, day,
      tripwire: cls.tripwire, admitted: cls.admitted,
    };
    if (day === null) {
      if (cls.class === "you_strong" || cls.class === "unknown" || cls.class === "agent_strong") {
        out.push({ ...base, class: "unknown", status: "open", test: null, undated: true });
      }
      continue;
    }
    if (!dayIn(day, interval)) continue;
    let status: Candidate["status"] = "background";
    let test: Candidate["test"] = null;
    switch (cls.class) {
      case "you_strong":
        if (ruled.get(String(e.id))?.ruledOut === true) {
          status = "ruled_out";
          test = "strata";
        } else status = "open";
        break;
      case "agent_strong":
      case "unknown":
        status = "open";
        break;
      case "agent_routine":
        if (boundary !== null && boundary.passes && boundary.event === String(e.id)) {
          status = "open";
          test = "version_boundary";
        } else test = "routine";
        break;
      default:
        break;
    }
    out.push({ ...base, class: cls.class, status, test, undated: false });
  }
  return out;
}

function observationOf(evidence: AttributionEvidence, interval: { from: string; to: string } | null): Observation {
  if (interval === null) return { scope: "none", fullyObservedDays: 0, partiallyObservedDays: 0, partialByDesign: evidence.partialByDesign };
  const fully = new Set(evidence.fullyObservedDays);
  let f = 0, p = 0;
  const lo = dayIndex(interval.from)!, hi = dayIndex(interval.to)!;
  for (let i = lo; i <= hi; i++) {
    if (!evidence.partialByDesign && fully.has(dayString(i))) f++;
    else p++;
  }
  return { scope: "onset", fullyObservedDays: f, partiallyObservedDays: p, partialByDesign: evidence.partialByDesign };
}

const ids = (cs: readonly Candidate[]) => cs.map((c) => c.event);

/** The decision table alone (no persistence). Pure. */
export function decideTable(input: DecideInput): Verdict {
  checkConsistent(input);
  const { evaluation: ev, confounders: cf, evidence } = input;
  const tripwires: TripwireOptions = { ...TRIPWIRES_OFF, ...input.options?.tripwires };
  const floor = input.options?.dfFloor ?? cf.df.floor;
  const trace: TraceRow[] = [];
  let onset: { from: string; to: string } | null = null;
  let candidates: Candidate[] = [];
  let observation = observationOf(evidence, null);

  /** Evaluates a row's conditions in order, stopping at the first that fails; records the row. */
  const row = (n: number, ...conds: (() => TraceCondition)[]): boolean => {
    const conditions: TraceCondition[] = [];
    for (const c of conds) {
      const r = c();
      conditions.push(r);
      if (!r.holds) break;
    }
    const matched = conditions.length === conds.length && conditions.every((c) => c.holds);
    trace.push({ row: n, matched, conditions });
    return matched;
  };
  // A routine update shows as the version-boundary candidate only when row 9 decides; under any other row it is
  // background (METHOD.md §1: routine agent updates never decide alone).
  const verdict = (state: VerdictState, reason: VerdictReason | null, n: number, extra: Partial<Verdict> = {}): Verdict => ({
    state, reason, row: n, trace, onset,
    candidates: n === 9 ? candidates : candidates.map((c) => (c.test === "version_boundary" ? { ...c, status: "background" as const, test: "routine" as const } : c)),
    blindSpot: false, observation, singleIndicator: null, ...extra,
  });

  // Row 1
  if (row(1, () => ({ id: "not_calibrated", holds: input.calibrated !== true }))) return verdict("insufficient", "calibration_pending", 1);
  if (evidence.calibrated !== true) throw new RangeError("evidence was gathered for an uncalibrated agent");

  // Row 2
  const t = selected(ev);
  const voting = t ? t.metrics.filter((m) => m.role === "vote") : [];
  const missing = t ? VOTING_FAMILIES.filter((f) => !voting.some((m) => m.family === f && m.eligible)) : [...VOTING_FAMILIES];
  if (row(2, () => ({ id: "family_without_eligible_metric", holds: missing.length > 0, detail: { tier: ev.selectedTier, families: [...missing], selection: ev.selection } }))) {
    return verdict("insufficient", "needs_data", 2);
  }

  // Row 3
  if (row(3, () => ({ id: "mixed", holds: cf.changed.mixed, metrics: [...cf.changed.worse, ...cf.changed.better], detail: { worse: [...cf.changed.worse], better: [...cf.changed.better] } }))) {
    return verdict("unclear", "mixed", 3);
  }

  const fragileDays = cf.fragility.days.fragile;
  const changed = cf.changed.changed && !fragileDays;
  const changedCond = (): TraceCondition => ({
    id: "changed",
    holds: changed,
    metrics: [...cf.changed.counted],
    detail: { side: cf.changed.side, families: [...cf.changed.families], fragileDays, sessionFragile: [...cf.fragility.fragileMetrics], unusableMaterial: [...cf.changed.unusableMaterial] },
  });

  if (changed) {
    if (!evidence.changed || evidence.onset === null) throw new RangeError("changed, but the evidence has no onset (gatherEvidence must run on the same evaluation)");
    onset = { ...evidence.onset.interval };
    candidates = candidatesOf(input, onset, tripwires);
    observation = observationOf(evidence, onset);
    // D53(a): the workload test must not stratify on the user's own recorded change.
    const required = [...new Set(candidates.filter((c) => c.class === "you_strong" && !c.undated).map((c) => DROPS[c.kind]).filter((d): d is StratumDim => d !== undefined))];
    const stillIn = required.filter((d) => cf.dims.includes(d));
    if (stillIn.length > 0) throw new RangeError(`D53: confounders must be assessed without the ${stillIn.join(", ")} dimension(s) (use evidence.dims)`);
  }

  const unknown = candidates.filter((c) => c.class === "unknown");
  const youOpen = candidates.filter((c) => c.class === "you_strong" && c.status === "open");
  const youRuledOut = candidates.filter((c) => c.class === "you_strong" && c.status === "ruled_out");
  const agentStrong = candidates.filter((c) => c.class === "agent_strong");
  const background = candidates.filter((c) => c.status === "background" || c.status === "ruled_out");
  const fully = observation.scope === "onset" && observation.partiallyObservedDays === 0;

  // Row 4
  if (row(4, changedCond, () => ({ id: "workload", holds: cf.workload.unclear, metrics: cf.workload.metrics.map((m) => m.metric), detail: { reasons: [...cf.workload.reasons], dims: [...cf.dims] } }))) {
    return verdict("unclear", "workload", 4);
  }
  // Row 5
  if (row(5, changedCond, () => ({ id: "unknown_candidate", holds: unknown.length > 0, events: ids(unknown) }))) return verdict("unclear", "unknown_provenance", 5);
  // Row 6
  if (row(6, changedCond,
    () => ({ id: "you_strong_open", holds: youOpen.length > 0, events: ids(youOpen), detail: { ruledOut: ids(youRuledOut) } }),
    () => ({ id: "agent_strong", holds: agentStrong.length > 0, events: ids(agentStrong) }))) {
    return verdict("unclear", "both_sides", 6);
  }
  // Row 7
  if (row(7, changedCond,
    () => ({ id: "you_strong_open", holds: youOpen.length > 0, events: ids(youOpen), detail: { ruledOut: ids(youRuledOut) } }),
    () => ({ id: "no_agent_strong", holds: agentStrong.length === 0 }))) {
    return verdict("you", null, 7);
  }
  // Row 8
  if (row(8, changedCond,
    () => ({ id: "agent_strong", holds: agentStrong.length > 0, events: ids(agentStrong) }),
    () => ({ id: "no_you_strong_open", holds: youOpen.length === 0, detail: { ruledOut: ids(youRuledOut) } }))) {
    return verdict("agent", null, 8, { blindSpot: !fully });
  }
  const onlyRoutine = (): TraceCondition => ({
    id: "only_routine_or_weak",
    holds: unknown.length === 0 && youOpen.length === 0 && agentStrong.length === 0,
    events: ids(background),
  });
  const observedCond = (): TraceCondition => ({
    id: "fully_observed", holds: fully,
    detail: { fullyObservedDays: observation.fullyObservedDays, partiallyObservedDays: observation.partiallyObservedDays, partialByDesign: observation.partialByDesign },
  });
  // Row 9
  const b = evidence.boundary;
  if (row(9, changedCond, onlyRoutine, observedCond, () => ({
    id: "version_boundary", holds: b !== null && b.passes,
    events: b?.event ? [b.event] : [],
    detail: { reason: b?.reason ?? null, boundary: b?.boundary ?? null, boundaries: b?.boundaries ?? 0 },
  }))) {
    return verdict("agent", "by_elimination", 9);
  }
  // Row 10
  if (row(10, changedCond, onlyRoutine, observedCond)) return verdict("unclear", "nothing_recorded_on_your_side", 10);
  // Row 11
  if (row(11, changedCond, onlyRoutine, () => ({
    id: "partially_observed", holds: !fully,
    detail: { fullyObservedDays: observation.fullyObservedDays, partiallyObservedDays: observation.partiallyObservedDays, partialByDesign: observation.partialByDesign },
  }))) {
    return verdict("unclear", "blind_spot", 11, { blindSpot: true });
  }
  if (changed) throw new Error("decision table: a changed evaluation matched none of rows 4–11 (unreachable)");

  const notChanged = (): TraceCondition => ({ id: "not_changed", holds: true, detail: { changedOf: cf.changed.changed, fragileDays } });
  const note = cf.singleIndicator;
  // Row 12
  if (row(12, notChanged, () => ({
    id: "single_indicator", holds: note.kind === "single_indicator",
    metrics: note.metric ? [note.metric.id] : [],
    detail: { kind: note.kind, adjustedP: note.metric?.adjustedP ?? null, alpha: note.alpha },
  }))) {
    const m = note.metric!;
    return verdict("insufficient", "single_indicator", 12, { singleIndicator: { metric: m.id, ratio: m.ratio, range: { ...m.range } } });
  }
  // Row 13
  const sensitiveMissing = VOTING_FAMILIES.filter((f) => !voting.some((m) => m.family === f && m.eligible && m.sensitive && usableForVerdict(m, floor)));
  if (row(13, notChanged,
    () => ({ id: "no_material", holds: !note.blocksNone, metrics: [...note.material] }),
    () => ({ id: "sensitive_each_family", holds: sensitiveMissing.length === 0, detail: { families: [...sensitiveMissing] } }))) {
    return verdict("none", null, 13);
  }
  // Row 14
  row(14, () => ({ id: "otherwise", holds: true, detail: { kind: note.kind, material: [...note.material] } }));
  return verdict("insufficient", "needs_data", 14);
}

// ───────────────────────────── persistence ─────────────────────────────

function fingerprintOf(input: DecideInput): Fingerprint {
  const p = input.evidence.persistence;
  return { now: input.now.toISOString(), today: input.evaluation.today, recent: { ...p.recent }, den: { ...p.den } };
}

/** Whether `cur` is far enough from `anchor` (data time, new data) to confirm; `backward` when time went back. */
export function separated(anchor: Fingerprint, cur: Fingerprint, data: PersistenceData, p: PersistenceOptions): { ok: boolean; backward: boolean } {
  const a = Date.parse(anchor.now), c = Date.parse(cur.now);
  if (!Number.isFinite(a) || !Number.isFinite(c) || c < a) return { ok: false, backward: true };
  if (c - a < p.minHours * 3_600_000) return { ok: false, backward: false };
  const fresh = data.daily.filter((x) => x.d > anchor.recent.to && x.d <= cur.recent.to);
  const sessionDays = fresh.reduce((s, x) => s + x.sessionDays, 0);
  if (sessionDays < p.minNewSessionDays) return { ok: false, backward: false };
  for (const [m, before] of Object.entries(anchor.den) as [MetricId, number][]) {
    if (!(typeof before === "number" && before > 0)) continue;
    const added = fresh.reduce((s, x) => s + (x.den[m] ?? 0), 0);
    // Relative tolerance so exactly 30% counts (0.3 × 100 is 30.000000000000004 in floating point).
    if (added < p.minNewShare * before * (1 - 1e-12)) return { ok: false, backward: false };
  }
  return { ok: true, backward: false };
}

/**
 * The agent went quiet: at least `minHours` of data time since the anchor and not one new session-day since it. A move
 * to "too early to tell (needs data)" BECAUSE data stopped arriving could never meet `separated` (it needs ≥ 2 new
 * session-days), so the old outcome would be held forever over windows that read 0 / 0. This is the one move that is
 * confirmed on time alone (see `decide`). It only ever moves the glance TO insufficient, never to a finding, so it
 * cannot add a false "changed" or a false "agent" (the D23/D69 calibration bounds are unaffected).
 */
export function quiet(anchor: Fingerprint, cur: Fingerprint, data: PersistenceData, p: PersistenceOptions): boolean {
  const a = Date.parse(anchor.now), c = Date.parse(cur.now);
  if (!Number.isFinite(a) || !Number.isFinite(c) || c - a < p.minHours * 3_600_000) return false;
  return data.daily.every((x) => !(x.d > anchor.recent.to && x.d <= cur.recent.to) || !(x.sessionDays > 0));
}

function verdictOf(d: Verdict): Verdict {
  return {
    state: d.state, reason: d.reason, row: d.row, trace: d.trace, onset: d.onset, candidates: d.candidates,
    blindSpot: d.blindSpot, observation: d.observation, singleIndicator: d.singleIndicator,
  };
}

const same = (a: { state: VerdictState; reason: VerdictReason | null }, b: { state: VerdictState; reason: VerdictReason | null }) =>
  a.state === b.state && a.reason === b.reason;

/** The decision table plus persistence (see the file header). Pure. */
export function decide(input: DecideInput): Decision {
  const raw = decideTable(input);
  const fingerprint = fingerprintOf(input);
  const opt = input.options?.persistence;
  const p: PersistenceOptions = { ...PERSISTENCE_DEFAULTS, ...(opt === false ? {} : opt) };
  const shown = (v: Verdict, pending: boolean, candidate: PendingCandidate | null, rule: Decision["persistence"]["rule"]): Decision =>
    ({ ...verdictOf(v), pending, raw, persistence: { fingerprint, candidate, rule } });

  if (raw.row === 1) return shown(raw, false, null, "bypass_calibration");
  if (opt === false) return shown(raw, false, null, "disabled");
  const prev = input.previous;
  if (prev === null || prev === undefined) return shown(raw, false, null, "first");
  if (prev.reason === "calibration_pending") return shown(raw, false, null, "bypass_calibration");
  const held = verdictOf(prev);
  if (same(raw, held)) return shown(raw, false, null, "same");
  const cand = prev.persistence?.candidate ?? null;
  if (cand !== null && same(cand, raw)) {
    const sep = separated(cand.since, fingerprint, input.evidence.persistence, p);
    if (sep.ok) return shown(raw, false, null, "confirmed");
    if (sep.backward) return shown(held, true, { state: raw.state, reason: raw.reason, row: raw.row, since: fingerprint }, "pending_reanchored");
    if (raw.state === "insufficient" && raw.reason === "needs_data" && quiet(cand.since, fingerprint, input.evidence.persistence, p)) {
      return shown(raw, false, null, "confirmed_quiet");
    }
    return shown(held, true, cand, "pending");
  }
  return shown(held, true, { state: raw.state, reason: raw.reason, row: raw.row, since: fingerprint }, "pending");
}

/** Snapshot `candidates[]` (CONTRACT): event id, status, test. Undated events have no timeline day and are omitted. */
export function snapshotCandidates(v: Verdict): { event: string; status: Candidate["status"]; test: Candidate["test"] }[] {
  return v.candidates.filter((c) => !c.undated).map((c) => ({ event: c.event, status: c.status, test: c.test }));
}
