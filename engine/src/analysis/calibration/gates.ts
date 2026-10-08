/**
 * Gate arithmetic for the calibration harness (METHOD.md §14; D23): Clopper–Pearson bounds and the per-profile tables.
 *
 * D23: "calibration asserts Clopper-Pearson 95% upper bound ≤ 6% false 'changed' and ≤ 2% false 'agent' over ≥ 1,000
 * null sims incl. 90-day sequences". The bound used here is the upper end of the two-sided 95% Clopper–Pearson
 * interval (one-sided 97.5%) — the more conservative reading.
 *
 * A false "changed" is a NULL sequence whose PERSISTED glance claimed a change (METHOD.md §11 rows 4–11) on any of
 * its 90 evaluation days; a false `agent` one whose glance ever showed `agent`. The raw (unpersisted) daily rate is
 * reported beside it as the upper bound persistence starts from.
 */
import { incompleteBeta } from "../stats/distributions.js";
import type { SequenceResult, Track } from "./sequence.js";

export const MAX_FALSE_CHANGED = 0.06;
export const MAX_FALSE_AGENT = 0.02;
export const MIN_NULL_SEQUENCES = 1000;

/** Inverse of the regularised incomplete beta in x (bisection; I_x(a, b) increases in x). */
function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (incompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

/** Two-sided Clopper–Pearson interval for k successes in n trials. */
export function clopperPearson(k: number, n: number, conf = 0.95): [number, number] {
  if (!(n > 0)) return [0, 1];
  const a = (1 - conf) / 2;
  const lo = k <= 0 ? 0 : betaQuantile(a, k, n - k + 1);
  const hi = k >= n ? 1 : betaQuantile(1 - a, k + 1, n - k);
  return [lo, hi];
}

export interface Proportion {
  k: number;
  n: number;
  rate: number;
  /** Two-sided 95% Clopper–Pearson interval. */
  lo: number;
  hi: number;
}

export function proportion(k: number, n: number): Proportion {
  const [lo, hi] = clopperPearson(k, n);
  return { k, n, rate: n > 0 ? k / n : NaN, lo, hi };
}

const round = (x: number, d = 5) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
function roundP(p: Proportion): Proportion {
  return { k: p.k, n: p.n, rate: round(p.rate), lo: round(p.lo), hi: round(p.hi) };
}

export interface NullRow {
  profile: string;
  agent: string;
  candidate: string;
  errorsVote: string;
  sequences: number;
  falseChanged: Proportion;
  falseAgent: Proportion;
  /** The interim decider never emits `agent`: the bound is reported, never counted as a pass. */
  agentExercised: boolean;
  falseYou: Proportion;
  everNonSteady: Proportion;
  singleIndicator: Proportion;
  mixed: Proportion;
  workload: Proportion;
  /** Sequences with ≥ 1 raw (unpersisted) changed day, and the share of all evaluation days that were raw changed. */
  rawChangedAny: Proportion;
  rawChangedDayRate: number;
  everNone: Proportion;
  /** Share of evaluation days per selected tier ("none", "1", "2", "3"), the extension share and the vacuity checks. */
  tierDayShare: Record<string, number>;
  extensionDayShare: number;
  errorsEligibleDayShare: number;
  researchEligibleDayShare: number;
  lowDfDayShare: number;
  fragileDays: number;
  /** Share of all evaluation days the glance displayed each key. */
  displayedDayShare: Record<string, number>;
  /** Raw (unpersisted) decision-table row (METHOD.md §11) → share of evaluation days. */
  rowDayShare: Record<string, number>;
  /**
   * Decider diagnostics (e.g. D56: rawRow5 / rawRow5DerivedOnly / shownRow5DerivedOnly): sequences in which the flag was
   * ever true, and its per-evaluation-day rate (numbers: the mean per day).
   */
  diag: Record<string, { sequences: Proportion; perDay: number }>;
  passFalseChanged: boolean;
  passFalseAgent: boolean | null;
}

function tracksOf(results: readonly SequenceResult[], candidate: string, errorsVote: string): Track[] {
  const out: Track[] = [];
  for (const r of results) for (const t of r.tracks) if (t.candidate === candidate && t.errorsVote === errorsVote) out.push(t);
  return out;
}

function shares(counts: Record<string, number>, total: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(counts).sort()) out[k] = round(counts[k]! / total, 5);
  return out;
}

/** One G-null-seq row: one profile's null sequences under one candidate and voting tool-error construct. */
export function nullRow(results: readonly SequenceResult[], candidate: string, errorsVote: string, agentExercised: boolean): NullRow {
  const ts = tracksOf(results, candidate, errorsVote);
  const n = ts.length;
  const count = (f: (t: Track) => boolean) => ts.filter(f).length;
  const days = ts.reduce((s, t) => s + Object.values(t.tierDays).reduce((a, b) => a + b, 0), 0);
  const sum = (f: (t: Track) => number) => ts.reduce((s, t) => s + f(t), 0);
  const tier: Record<string, number> = {};
  const disp: Record<string, number> = {};
  const rows: Record<string, number> = {};
  const diagDays: Record<string, number> = {};
  const diagEver: Record<string, number> = {};
  for (const t of ts) {
    for (const [k, v] of Object.entries(t.tierDays)) tier[k] = (tier[k] ?? 0) + v;
    for (const [k, v] of Object.entries(t.displayedDays)) disp[k] = (disp[k] ?? 0) + v;
    for (const [k, v] of Object.entries(t.rowDays)) rows[k] = (rows[k] ?? 0) + v;
    for (const [k, v] of Object.entries(t.diagDays ?? {})) diagDays[k] = (diagDays[k] ?? 0) + v;
    for (const [k, v] of Object.entries(t.diagEver ?? {})) if (v) diagEver[k] = (diagEver[k] ?? 0) + 1;
  }
  const diag: NullRow["diag"] = {};
  for (const k of Object.keys(diagDays).sort()) diag[k] = { sequences: roundP(proportion(diagEver[k] ?? 0, n)), perDay: round(days > 0 ? diagDays[k]! / days : NaN, 6) };
  const falseChanged = proportion(count((t) => t.everChanged), n);
  const falseAgent = proportion(count((t) => t.everAgent), n);
  return {
    profile: results[0]?.profile ?? "",
    agent: results[0]?.agent ?? "",
    candidate,
    errorsVote,
    sequences: n,
    falseChanged: roundP(falseChanged),
    falseAgent: roundP(falseAgent),
    agentExercised,
    falseYou: roundP(proportion(count((t) => t.everYou), n)),
    everNonSteady: roundP(proportion(count((t) => t.everNonSteady), n)),
    singleIndicator: roundP(proportion(count((t) => t.everSingle), n)),
    mixed: roundP(proportion(count((t) => t.everMixed), n)),
    workload: roundP(proportion(count((t) => t.everWorkload), n)),
    rawChangedAny: roundP(proportion(count((t) => t.rawChangedDays > 0), n)),
    rawChangedDayRate: round(days > 0 ? sum((t) => t.rawChangedDays) / days : NaN, 6),
    everNone: roundP(proportion(count((t) => t.everNone), n)),
    tierDayShare: shares(tier, days),
    extensionDayShare: round(sum((t) => t.extensionDays) / days),
    errorsEligibleDayShare: round(sum((t) => t.errorsEligibleDays) / days),
    researchEligibleDayShare: round(sum((t) => t.researchEligibleDays) / days),
    lowDfDayShare: round(sum((t) => t.lowDfDays) / days),
    fragileDays: sum((t) => t.fragileDays),
    displayedDayShare: shares(disp, days),
    rowDayShare: shares(rows, days),
    diag,
    passFalseChanged: n >= 1 && falseChanged.hi <= MAX_FALSE_CHANGED,
    passFalseAgent: agentExercised ? falseAgent.hi <= MAX_FALSE_AGENT : null,
  };
}

export interface PowerRow {
  profile: string;
  agent: string;
  candidate: string;
  errorsVote: string;
  effect: string;
  sequences: number;
  /** Persisted glance claimed a change on or after the planted onset. */
  detected: Proportion;
  /** Claimed a change BEFORE the onset (a false alarm inside an effect sequence). */
  early: Proportion;
  /** Evaluation days from the onset to the first persisted claim (median, detected sequences only). */
  medianDelayDays: number | null;
}

export function powerRow(results: readonly SequenceResult[], candidate: string, errorsVote: string, effect: string): PowerRow {
  const pairs = results.flatMap((r) => r.tracks.filter((t) => t.candidate === candidate && t.errorsVote === errorsVote).map((t) => ({ r, t })));
  const n = pairs.length;
  const firstAfter = ({ r, t }: { r: SequenceResult; t: Track }) => t.changedStarts.find((k) => r.onsetEvalDay !== null && k >= r.onsetEvalDay);
  const det = pairs.filter((p) => firstAfter(p) !== undefined);
  const early = pairs.filter(({ r, t }) => r.onsetEvalDay !== null && t.changedStarts.some((k) => k < r.onsetEvalDay!));
  const delays = det.map((p) => firstAfter(p)! - p.r.onsetEvalDay!).sort((a, b) => a - b);
  return {
    profile: results[0]?.profile ?? "",
    agent: results[0]?.agent ?? "",
    candidate, errorsVote, effect, sequences: n,
    detected: roundP(proportion(det.length, n)),
    early: roundP(proportion(early.length, n)),
    medianDelayDays: delays.length ? delays[delays.length >> 1]! : null,
  };
}
