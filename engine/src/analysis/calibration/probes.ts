/**
 * Metric-level probes of the harness:
 *
 *  - G-MDE (a), METHOD.md §6 "an effect planted at the reported MDE must be detected 60 to 95% of the time": on a null sequence,
 *    evaluate one day (eval day 60–90), read each eligible voting metric's reported MDE in the selected tier, then
 *    replay the SAME user (same seed; the synth forks its randomness per day, so every day before the plant is
 *    identical) with that metric's rate multiplied by the MDE from the first day of that tier's recent window, and
 *    evaluate the same day again. Detected = the range excludes 1× in the planted direction. The realised multiplier
 *    (planted ÷ null recent-window rate) is recorded, because a rate factor does not always move the metric 1:1
 *    (reads per edit: the planner adds a read before most edits, which damps a factor on the read weight).
 *  - G-ETA (D64(c), was G-MDE (b) "projected ETAs land within ±30%"), over SHOWN dates only: the evaluation runs
 *    daily with the D64 progress records threaded from one day to the next (as the store does); every 10th evaluation
 *    day from the first one that SHOWS a date (progress reason "eta"), while not ready, records the shown ETA; the
 *    outcome is the first later evaluation that is ready under D64(a) (the gate and sensitivity held on it and on the
 *    previous day). Every not-ready day whose projection had a date counts as shown or withheld (by reason), so the
 *    suppression share is measured beside the error.
 *  - SE check, METHOD.md §6: the analytic SE (`stats/analytic.ts`) against the B = 2,000 bootstrap on the same clusters,
 *    per scheme / correction configuration.
 */
import { analyticRatio } from "../stats/analytic.js";
import { bootstrapRatio, DEFAULT_RESAMPLES } from "../stats/bootstrap.js";
import { nextHistory, type DateWithheld, type EtaRecord } from "../gates/eta.js";
import { clusterCells, dayString } from "../stats/ratio.js";
import { hashString } from "../stats/rng.js";
import type { AnalysisMethod } from "../gates/d23.js";
import { metricDef, type MetricId, type ToolErrorVariant } from "../metrics/defs.js";
import { cellsBetween } from "../metrics/cells.js";
import { tierWindows, TIERS } from "../metrics/windows.js";
import type { RateSet } from "../../synth/params.js";
import { DaySeries, evaluateDay } from "./day.js";
import { aggregateSessionDays, EVAL_DAYS, generateSequence, planDayIndex, PRE_DAYS, specProfile, type SequenceSpec } from "./synth.js";
import type { Candidate } from "./sequence.js";

const u01 = (key: string) => hashString(key)[2] / 2 ** 32;

function seriesOf(spec: SequenceSpec): DaySeries {
  const seq = generateSequence(spec);
  return new DaySeries(seq.agent, aggregateSessionDays(seq.exchanges));
}

// ───────────────────────────── G-MDE (a) ─────────────────────────────

export interface MdeProbe {
  profile: string;
  metric: MetricId;
  tier: number;
  evalDay: number;
  /** Reported MDE in the worse direction (×, > 1 for an increase; < 1 for reads per edit). */
  mde: number;
  /** Planted rate factor. */
  factor: number;
  /** Planted ÷ null recent-window rate of the metric (same seed). */
  realised: number | null;
  detected: boolean;
  material: boolean;
}

function factorFor(metric: MetricId, mde: number, mdeDown: number): { effect: Partial<RateSet>; factor: number; dir: "up" | "down" } | null {
  if (metric === "toolErrors" || metric === "toolErrorsNonCmd") return { effect: { toolError: mde }, factor: mde, dir: "up" };
  if (metric === "blindEdits") return { effect: { blindEdit: mde }, factor: mde, dir: "up" };
  if (metric === "readsPerEdit") return { effect: { read: mdeDown }, factor: mdeDown, dir: "down" };
  return null;
}

export function mdeProbes(spec: SequenceSpec, candidate: Candidate, errorsVote: ToolErrorVariant): MdeProbe[] {
  const k = 60 + Math.floor(u01(`${spec.seed}|mdeday`) * (EVAL_DAYS - 59));
  const todayPlan = PRE_DAYS + k;
  const todayIdx = planDayIndex(todayPlan);
  const nullSeries = seriesOf(spec);
  const ev = evaluateDay(nullSeries, nullSeries.prepare(todayIdx), candidate.method, [errorsVote]).get(errorsVote)!;
  if (ev.selectedTier === null) return [];
  const tier = ev.tiers.find((t) => t.tier === ev.selectedTier)!;
  const out: MdeProbe[] = [];
  const agent = specProfile(spec).agent;
  for (const m of tier.metrics) {
    if (m.role !== "vote" || !m.eligible || m.mde === null || m.mdeDown === null || !Number.isFinite(m.mde)) continue;
    const f = factorFor(m.id, m.mde, m.mdeDown);
    if (f === null) continue;
    const plant: SequenceSpec = {
      ...spec,
      planted: [...(spec.planted ?? []), { day: todayPlan - tier.recentDays, agent, kind: "config", to: "next", by: "you", effect: f.effect, note: "G-MDE plant" }],
    };
    const s2 = seriesOf(plant);
    const ev2 = evaluateDay(s2, s2.prepare(todayIdx), candidate.method, [errorsVote]).get(errorsVote)!;
    const m2 = ev2.tiers.find((t) => t.tier === tier.tier)!.metrics.find((x) => x.id === m.id)!;
    const call = m2.call;
    const realised = m.recent.rate !== null && m2.recent.rate !== null && m.recent.rate > 0 ? m2.recent.rate / m.recent.rate : null;
    out.push({
      profile: spec.profile, metric: m.id, tier: tier.tier, evalDay: k,
      mde: f.dir === "up" ? m.mde : m.mdeDown, factor: f.factor, realised,
      detected: m2.eligible && call !== null && call.significant && call.direction === f.dir,
      material: m2.eligible && m2.material && m2.direction === f.dir,
    });
  }
  return out;
}

// ───────────────────────────── G-ETA (D64(c)): shown ETAs ─────────────────────────────

export interface EtaProbe {
  profile: string;
  anchorDay: number;
  /** The SHOWN ETA: days from the anchor day to the shown date. */
  etaDays: number;
  etaTier: number | null;
  /** Days from the anchor to the first ready evaluation (D64(a): held on two consecutive days); null if none by the last evaluation day. */
  actualDays: number | null;
  /** The ETA's ±30% band ends after the last evaluation day, so a miss cannot be told from a late hit. */
  censored: boolean;
}

/**
 * One null sequence's progress claims beside the scored dates:
 *  - `days` / `readyWithin30` (D58): days on which progress SHOWED "not at your current pace" (no day count) with at
 *    least 30 evaluation days left, and how many were followed by a ready evaluation within 30 days — the median ETA
 *    error cannot see these: a projection that goes quiet more often scores better while being wrong;
 *  - D64(c) suppression: not-ready days whose projection had a date (`projectedDays`), of them `shownDays`, and the
 *    withheld ones by reason; not-ready days whose projection said "not at your current pace", and of them the shown.
 */
export interface EtaSilence {
  profile: string;
  days: number;
  readyWithin30: number;
  projectedDays: number;
  shownDays: number;
  withheld: Record<DateWithheld, number>;
  notAtPaceProjected: number;
  notAtPaceShown: number;
}

export const SILENCE_HORIZON_DAYS = 30;

/** Shown-ETA anchors (G-ETA) and the progress claims of one null sequence, evaluated daily under the D64 rule. */
export function etaCheck(spec: SequenceSpec, candidate: Candidate, errorsVote: ToolErrorVariant): { probes: EtaProbe[]; silence: EtaSilence } {
  const series = seriesOf(spec);
  const ready: boolean[] = [];
  const reasons: (string | null)[] = [];
  const anchors: { k: number; eta: number; tier: number | null }[] = [];
  const quiet: EtaSilence = {
    profile: spec.profile, days: 0, readyWithin30: 0, projectedDays: 0, shownDays: 0,
    withheld: { unstable: 0, dominant_session: 0, no_measured_anchor: 0 }, notAtPaceProjected: 0, notAtPaceShown: 0,
  };
  let history: EtaRecord[] = [];
  let nextAnchor = 1;
  for (let k = 1; k <= EVAL_DAYS; k++) {
    const day = series.prepare(planDayIndex(PRE_DAYS + k));
    const ev = evaluateDay(series, day, candidate.method, [errorsVote], DEFAULT_RESAMPLES, history).get(errorsVote)!;
    const p = ev.progress;
    history = nextHistory(history, p.record);
    ready[k] = p.ready;
    reasons[k] = null;
    if (ready[k]) continue;
    reasons[k] = p.reason;
    if (p.projection?.etaDate != null) {
      quiet.projectedDays++;
      if (p.reason === "eta") quiet.shownDays++;
      else if (p.dateWithheld !== null) quiet.withheld[p.dateWithheld]++;
    }
    if (p.projection?.notAtCurrentPace === true) {
      quiet.notAtPaceProjected++;
      if (p.reason === "not_at_current_pace") quiet.notAtPaceShown++;
    }
    if (k >= nextAnchor && p.reason === "eta" && p.etaDays !== null) {
      anchors.push({ k, eta: p.etaDays, tier: p.etaTier });
      nextAnchor = k + 10;
    }
  }
  const probes = anchors.map(({ k, eta, tier }) => {
    let actual: number | null = null;
    for (let j = k + 1; j <= EVAL_DAYS; j++) if (ready[j]) { actual = j - k; break; }
    return { profile: spec.profile, anchorDay: k, etaDays: eta, etaTier: tier, actualDays: actual, censored: actual === null && k + Math.ceil(eta * 1.3) > EVAL_DAYS };
  });
  for (let k = 1; k + SILENCE_HORIZON_DAYS <= EVAL_DAYS; k++) {
    if (reasons[k] !== "not_at_current_pace") continue;
    quiet.days++;
    for (let j = k + 1; j <= k + SILENCE_HORIZON_DAYS; j++) if (ready[j]) { quiet.readyWithin30++; break; }
  }
  return { probes, silence: quiet };
}

// ───────────────────────────── SE check ─────────────────────────────

export interface SeProbe {
  profile: string;
  config: string;
  metric: MetricId;
  /** ln(analytic SE / bootstrap SE), both after the small-sample factor and the floor. */
  logSeRatio: number;
  dfAnalytic: number;
  dfBootstrap: number;
}

export function seProbes(spec: SequenceSpec, methods: readonly AnalysisMethod[], resamples = 2000): SeProbe[] {
  const series = seriesOf(spec);
  const k = 45 + Math.floor(u01(`${spec.seed}|seday`) * (EVAL_DAYS - 44));
  const todayIdx = planDayIndex(PRE_DAYS + k);
  const day = series.prepare(todayIdx);
  const tier = TIERS[Math.floor(u01(`${spec.seed}|setier`) * TIERS.length)]!;
  const w = tierWindows(todayIdx, tier);
  const out: SeProbe[] = [];
  const configs = new Map<string, AnalysisMethod>();
  for (const m of methods) {
    configs.set(`${m.twoLevel ? "two-level" : m.clusters}/${m.smallSample}`, m);
    if (m.keepLargerSe && !m.twoLevel) configs.set(`${m.clusters === "session" ? "session-day" : "session"}/${m.smallSample}`, { ...m, clusters: m.clusters === "session" ? "session-day" : "session" });
  }
  for (const id of ["toolErrorsNonCmd", "readsPerEdit", "blindEdits"] as MetricId[]) {
    const def = metricDef(id);
    const cells = day.build.cells[id];
    const rc = cellsBetween(cells, w.recent.from, w.recent.to), bc = cellsBetween(cells, w.baseline.from, w.baseline.to);
    if (rc.length < 4 || bc.length < 4) continue;
    for (const [config, m] of configs) {
      const scheme = m.twoLevel ? "session-day" : m.clusters;
      const r = clusterCells(rc, scheme), b = clusterCells(bc, scheme);
      const opts = { resamples, twoLevel: m.twoLevel, smallSample: m.smallSample, floor: def.floor, seed: `se|${spec.seed}|${config}|${id}|${dayString(todayIdx)}` };
      const boot = bootstrapRatio(r, b, opts);
      const an = analyticRatio(r, b, opts);
      if (!boot.ok || !an.ok || !(boot.se > 0) || !(an.se > 0)) continue;
      out.push({ profile: spec.profile, config, metric: id, logSeRatio: Math.log(an.se / boot.se), dfAnalytic: an.df, dfBootstrap: boot.df });
    }
  }
  return out;
}
