/**
 * Per-agent evaluation (METHOD.md §2–§6, §13): every metric in every tier whose history is met — gate, range,
 * materiality, MDE, sensitivity — then the tier choice and progress. Pure, deterministic, no I/O:
 * same exchanges + same `now`/time zone + same options → identical output (bootstrap seeds are derived
 * from the data). The time zone and the voting tool-error construct are required: neither is ever defaulted
 * (the system zone would make output machine-dependent; the construct is fixed in DECISIONS.md before WP-21).
 *
 * Per metric and tier:
 *  1. Eligibility: history met, the D23 gate passes in both windows, the metric's fields are present for
 *     every contributing exchange, and (pushback) ≥ 70% of ALL prompts in each window are English — a prompt
 *     without `promptEnglish` counts as not English. Both readers set `promptEnglish` (friction family);
 *     pushback is off with reason "language_unknown" only when no prompt carries it and the caller passes no
 *     known `englishShare`.
 *  2. Range: stratified cluster bootstrap (stats `bootstrapRatio`) under the method's scheme; with
 *     `keepLargerSe` and ≥ 5 sessions in each window, also under the other scheme, keeping the larger SE and the
 *     smaller df of the two (METHOD.md §6, D81). Range = exp(θ ± t_{(1+level)/2}(df)·SE), computed here so the kept
 *     SE and df drive it.
 *  3. Material (D23): range excludes 1×, point estimate moved ≥ 25%, |Δrate| ≥ the metric's "1 pt".
 *  4. MDE (METHOD.md §6): exp((t_{1−α/2} + t_{.80})·SE·1.1) with α = 1 − level; sensitive = eligible and MDE ≤ 2×.
 *  5. Status: worse / better by the metric's "worse" direction; "shifted" for a material move of a metric
 *     with no worse direction; "none"; or "ineligible".
 *
 * Tier choice (METHOD.md §4): the first tier with its history met in which every voting family has an eligible
 * and sensitive voting metric; otherwise the largest tier with its history met; otherwise none.
 * Every evaluated tier is returned so the verdict layer (WP-21) can apply its own rules.
 */
import type { AgentId } from "../../types.js";
import { analyticRatio } from "../stats/analytic.js";
import { bootstrapRatio, DEFAULT_RESAMPLES } from "../stats/bootstrap.js";
import { wildRatio, wildResamples } from "../stats/wild.js";
import { studentTQuantile, twoSidedP } from "../stats/distributions.js";
import { classifyChange, type ChangeCall, type ChangeEvidence } from "../stats/material.js";
import { minimumDetectableChange } from "../stats/mdc.js";
import { clusterCells, dayIndex, dayString } from "../stats/ratio.js";
import type { Cell, ClusterScheme, RatioComparison } from "../stats/types.js";
import { buildCells, cellsBetween, dailyTotals, type CellBuild, type LanguageCell, type MetricCell } from "../metrics/cells.js";
import {
  METRICS, metricDef, roleOf, TOOL_ERROR_VARIANTS, VOTING_FAMILIES,
  type Direction, type Family, type MetricDef, type MetricExchange, type MetricId, type Role, type ToolErrorVariant,
} from "../metrics/defs.js";
import {
  checkTimeZone, historyDays as historyDaysOf, historyMetOn, mustDay, rangeStrings, TIERS, tierWindows, todayFor,
  type DayRangeStrings, type Tier, type TierId,
} from "../metrics/windows.js";
import {
  countWindow, D23_GATE, D23_LITERAL, D23_MIN_RELATIVE_CHANGE, distinctSessions, evaluateD23Gate, MDE_POWER, SENSITIVE_MAX_MDE,
  type AnalysisMethod, type GateCheck, type GateOutcome, type GateParams, type WindowCounts,
} from "./d23.js";
import {
  dayAggregates, paceOf, perClusterVariance, projectEta,
  type Anchor, type Pace, type ProjectedMetric, type ProjectionMetric,
} from "./progress.js";
import { dateGate, heldReady, priorRecords, READY_HOLD, stableDate, stableNotAtPace, type DateWithheld, type EtaRecord } from "./eta.js";

/** Pushback is off when fewer than this share of prompts are English (METHOD.md §3). */
export const PUSHBACK_MIN_ENGLISH = 0.7;

export type IneligibleReason =
  | "fields_missing"      // the reader does not emit a field this metric needs (or not for every exchange)
  | "language_unknown"    // pushback: no prompt carries language information and no `englishShare` was passed
  | "not_english"         // pushback: < 70% of a window's prompts are English (unknown counts as not English)
  | "history"             // the tier's history requirement is not met
  | "gate"                // a D23 gate criterion fails (see blocking)
  | "no_interval";        // gates pass but no interval could be computed (e.g. one session holds the denominator)

export type MetricStatusD = "worse" | "better" | "shifted" | "none" | "ineligible";

export interface WindowView extends WindowCounts {
  /** Ratio of totals (no pseudo-count); null with no denominator. */
  rate: number | null;
  /** Contributing exchanges that lacked a needed field. */
  missing: number;
  /** Exchanges clamped to num ≤ den. */
  clamped: number;
}

export interface ComparisonView {
  /** Scheme whose SE was kept. */
  scheme: ClusterScheme;
  twoLevel: boolean;
  logRatio: number;
  ratio: number;
  se: number;
  /** The kept scheme's df, or the smaller of both schemes' df when both were computed (D81). */
  df: number;
  level: number;
  range: { lo: number; hi: number };
  pValue: number;
  /** The scheme not kept (when computed): its SE and df, for the trace. */
  other: { scheme: ClusterScheme; se: number; df: number; ok: boolean } | null;
  resamples: number;
  seed: string;
}

export interface MetricEvaluation {
  id: MetricId;
  family: Family;
  role: Role;
  worse: Direction | null;
  scale: number;
  unit: string;
  point: number | null;
  recent: WindowView;
  baseline: WindowView;
  /** Distinct sessions with a denominator across BOTH windows: a session active on both sides of the boundary counts
   *  once (`recent.sessions + baseline.sessions` counts it twice). */
  distinctSessions: number;
  gate: GateOutcome;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
  comparison: ComparisonView | null;
  /** Smallest detectable increase as a ratio (×2.5); null when not eligible. */
  mde: number | null;
  /** Smallest detectable decrease as a ratio (×0.4); null when not eligible. */
  mdeDown: number | null;
  call: ChangeCall | null;
  /** = shifted (D23 material). */
  material: boolean;
  direction: Direction | null;
  sensitive: boolean;
  status: MetricStatusD;
  /** Daily integer k/n from the baseline's first day to the recent window's last day. */
  daily: { d: string; k: number; n: number }[];
  /** Pushback only: share of each window's prompts that are English (null without prompts); else null. */
  englishShare: { recent: number | null; baseline: number | null } | null;
}

export interface TierEvaluation {
  tier: TierId;
  recentDays: number;
  baselineDays: number;
  historyDays: number;
  historyMet: boolean;
  /** First local day on which this tier's history requirement is (or was) met; null with no data. */
  historyMetOn: string | null;
  windows: { recent: DayRangeStrings; baseline: DayRangeStrings };
  metrics: MetricEvaluation[];
  /** Per voting family: some voting metric is eligible and sensitive. */
  familiesReady: Record<string, boolean>;
  ready: boolean;
}

export interface UnlockItem {
  metric: MetricId;
  family: Family;
  /** Not eligible (with its gate shortfalls) or eligible but not yet sensitive (with its MDE). */
  state: "ineligible" | "not_sensitive";
  reason: IneligibleReason | null;
  /** Failing gate checks; the surfaces show the sessions / session-days ones (METHOD.md §13). */
  blocking: GateCheck[];
  mde: number | null;
}

export interface ProgressView {
  /** Tier the progress refers to: the chosen tier, else tier 1. */
  tier: TierId;
  /** D64(a): the gate and sensitivity held on this AND the previous daily evaluation (eta.ts). */
  ready: boolean;
  /** This evaluation alone: some tier with its history met has an eligible, sensitive voting metric in every family. */
  readyToday: boolean;
  /** The date shown (D64(b), eta.ts); null whenever no date is shown — `projection` keeps the projected one. */
  etaDate: string | null;
  etaDays: number | null;
  etaTier: TierId | null;
  /** The claim shown: no tier gets there at the current pace (D64: only once it held on 3 daily evaluations). */
  notAtCurrentPace: boolean;
  /**
   * ready: usable now (held, D64(a)); eta: a shown date; not_at_current_pace: no tier gets there (no day count is
   * shown); no_date: a projection exists but D64(b) shows no date (see `dateWithheld`); no_data: nothing to project
   * from yet; metric_unavailable: some voting family has no metric this reader can supply (fields missing), so waiting
   * cannot help.
   */
  reason: "ready" | "eta" | "not_at_current_pace" | "no_date" | "no_data" | "metric_unavailable";
  /** Why the projection is not shown (reason "no_date"); null otherwise. */
  dateWithheld: DateWithheld | null;
  /**
   * The hold-aware projection behind the shown fields, shown or not (null when nothing was projected: ready, no_data,
   * metric_unavailable). `maxSessionShare`: D64(b)2's share on the ETA day (null without a projected date).
   */
  projection: { etaDays: number | null; etaTier: TierId | null; etaDate: string | null; notAtCurrentPace: boolean; maxSessionShare: number | null } | null;
  /** This evaluation as the next daily evaluation's rule needs it (the store persists it, D64). */
  record: EtaRecord;
  /** Voting metrics only (friction never gets a progress bar). */
  unlock: UnlockItem[];
  pace: Record<string, Pace>;
  /** Projected voting metrics on the projected ETA day (empty without one), shown or not. */
  projected: ProjectedMetric[];
  /** Per voting metric: the measured SEs the projection is calibrated to (D47(b)), for the trace. */
  anchors: Record<string, Anchor[]>;
}

export interface AgentEvaluation {
  agent: string;
  today: string;
  timeZone: string;
  method: AnalysisMethod;
  errorsVote: ToolErrorVariant;
  gate: GateParams;
  history: { firstDay: string | null; days: number };
  counts: CellBuild["counts"];
  /**
   * Share of all used prompts that are English, unknown counted as not English (the caller's `englishShare`
   * when given); null when no prompt carries language information.
   */
  englishShare: number | null;
  tiers: TierEvaluation[];
  selectedTier: TierId | null;
  selection: "ready" | "largest_available" | "no_history";
  progress: ProgressView;
}

export interface EvaluateOptions {
  agent: AgentId | string;
  now: Date;
  /** IANA zone; must be the zone the reader used for `Exchange.day`. Required: the system zone is never assumed. */
  timeZone: string;
  method?: AnalysisMethod;
  /**
   * Which tool-error construct votes. Required: nothing here defaults it. The scan passes `SCAN_ERRORS_VOTE`
   * (store/settings.ts) = `G0_FALLBACK_ERRORS_VOTE` ("toolErrorsNonCmd", D47(d), kept by D61): non-command failures
   * vote and command exits stay context. It needs the split fields, which both readers fill.
   */
  errorsVote: ToolErrorVariant;
  resamples?: number;
  /** Share of prompts that are English (0..1), when known outside the exchanges; applies to every window. */
  englishShare?: number;
  /** History start known to the store (e.g. the oldest log), when earlier than the exchanges show. */
  firstDay?: string;
  gate?: GateParams;
  /** Metrics to evaluate (default: all). Voting metrics are always included. */
  metrics?: readonly MetricId[];
  /**
   * This agent's records of the previous daily evaluations (D64, eta.ts; the store persists them). Absent or empty:
   * nothing is held or stable yet, so progress is never "ready" and shows no date on this evaluation.
   */
  progressHistory?: readonly EtaRecord[] | null;
}

function rateOf(w: WindowCounts): number | null {
  return w.denominator > 0 ? w.events / w.denominator : null;
}

function sum(cells: readonly MetricCell[], key: "missing" | "clamped"): number {
  let s = 0;
  for (const c of cells) s += c[key];
  return s;
}

function otherScheme(m: AnalysisMethod): ClusterScheme {
  if (m.twoLevel) return "session";
  return m.clusters === "session" ? "session-day" : "session";
}

export interface MetricContext {
  method: AnalysisMethod;
  gate: GateParams;
  resamples: number;
  /** Caller-supplied English share (applies to every window); null = derive per window from `language`. */
  englishOverride: number | null;
  /** Per session-day prompts and English prompts (cells.ts); unknown language counts as not English. */
  language: readonly LanguageCell[];
  /** Some used prompt carries `promptEnglish`. */
  languageKnown: boolean;
  errorsVote: ToolErrorVariant;
}

/** Share of the window's prompts that are English; null when the window has no prompts. */
function windowEnglishShare(language: readonly LanguageCell[], from: number, to: number): number | null {
  let english = 0, prompts = 0;
  for (const c of cellsBetween(language, from, to)) {
    english += c.num;
    prompts += c.den;
  }
  return prompts > 0 ? english / prompts : null;
}

/** What the range estimator needs from the context (the method and the bootstrap size). */
export type MeasureContext = Pick<MetricContext, "method" | "resamples">;

function boot(recent: readonly Cell[], baseline: readonly Cell[], scheme: ClusterScheme, twoLevel: boolean, def: MetricDef, ctx: MeasureContext): RatioComparison {
  const m = ctx.method;
  const opts = {
    resamples: ctx.resamples,
    twoLevel,
    smallSample: m.smallSample,
    floor: def.floor,
    ...(m.pseudo !== undefined ? { pseudo: m.pseudo } : {}),
  };
  const r = clusterCells(recent, scheme), b = clusterCells(baseline, scheme);
  // WP-23 calibration estimators (d23.ts `estimator`); absent → the production bootstrap, unchanged.
  if (m.estimator === "analytic") return analyticRatio(r, b, opts);
  if (m.estimator === "wild") return wildRatio(r, b, { ...opts, resamples: wildResamples(ctx.resamples, m.level), level: m.level });
  return bootstrapRatio(r, b, opts);
}

/** Two-sided α of the MDE: the method's `mdeAlpha` when set (research/08 #5), else 1 − level. */
export function mdeAlphaOf(m: AnalysisMethod): number {
  return m.mdeAlpha !== undefined && m.mdeAlpha > 0 && m.mdeAlpha < 1 ? m.mdeAlpha : 1 - m.level;
}

export function evaluateMetric(
  def: MetricDef,
  cells: readonly MetricCell[],
  tier: Tier,
  todayIdx: number,
  historyMet: boolean,
  ctx: MetricContext,
): MetricEvaluation {
  const w = tierWindows(todayIdx, tier);
  const rc = cellsBetween(cells, w.recent.from, w.recent.to);
  const bc = cellsBetween(cells, w.baseline.from, w.baseline.to);
  const rCounts = countWindow(rc), bCounts = countWindow(bc);
  const recent: WindowView = { ...rCounts, rate: rateOf(rCounts), missing: sum(rc, "missing"), clamped: sum(rc, "clamped") };
  const baseline: WindowView = { ...bCounts, rate: rateOf(bCounts), missing: sum(bc, "missing"), clamped: sum(bc, "clamped") };
  const gate = evaluateD23Gate(rCounts, bCounts, def.minDenominator, ctx.gate);
  const role = roleOf(def.id, ctx.errorsVote);

  let englishShare: MetricEvaluation["englishShare"] = null;
  let languageReason: IneligibleReason | null = null;
  if (def.id === "pushback") {
    if (ctx.englishOverride !== null) {
      englishShare = { recent: ctx.englishOverride, baseline: ctx.englishOverride };
    } else if (ctx.languageKnown) {
      englishShare = {
        recent: windowEnglishShare(ctx.language, w.recent.from, w.recent.to),
        baseline: windowEnglishShare(ctx.language, w.baseline.from, w.baseline.to),
      };
    }
    if (englishShare === null) languageReason = "language_unknown";
    // A window without prompts has no pushback data either; the gate reports that.
    else if ([englishShare.recent, englishShare.baseline].some((x) => x !== null && x < PUSHBACK_MIN_ENGLISH)) languageReason = "not_english";
  }

  let reason: IneligibleReason | null = null;
  if (recent.missing > 0 || baseline.missing > 0) reason = "fields_missing";
  else if (languageReason !== null) reason = languageReason;
  else if (!historyMet) reason = "history";
  else if (!gate.pass) reason = "gate";

  const base = {
    id: def.id, family: def.family, role, worse: def.worse, scale: def.scale, unit: def.unit, point: def.point,
    recent, baseline, distinctSessions: distinctSessions(rc, bc), gate,
    daily: dailyTotals(cells, w.baseline.from, w.recent.to),
    englishShare,
  };
  const ineligible = (r: IneligibleReason, comparison: ComparisonView | null = null): MetricEvaluation => ({
    ...base, eligible: false, ineligibleReason: r, comparison, mde: null, mdeDown: null, call: null,
    material: false, direction: null, sensitive: false, status: "ineligible",
  });
  if (reason !== null) return ineligible(reason);

  const measured = measureShift(def, rc, bc, ctx);
  if (measured === null) return ineligible("no_interval");
  const { comparison, call, mde, mdeDown } = measured;
  const material = call.material;
  const direction = material ? call.direction : null;
  const status = statusOf(def, call);
  return {
    ...base, eligible: true, ineligibleReason: null, comparison, mde, mdeDown, call,
    material, direction, sensitive: mde <= SENSITIVE_MAX_MDE, status,
  };
}

/** One measured comparison: the range, the D23 call and the MDE (both directions, as ratios). */
export interface Measurement {
  comparison: ComparisonView;
  call: ChangeCall;
  mde: number;
  mdeDown: number;
}

/**
 * The range estimator of every comparison in the engine (METHOD.md §6), on cells already cut to the two windows:
 * a stratified cluster bootstrap under the method's scheme; with `keepLargerSe` and ≥ 5 sessions (with a
 * denominator) in each window, also under the other scheme, keeping the larger SE and the smaller of the two df
 * (D81: never a narrower range, lower MDE or higher df than the primary scheme alone). Range =
 * exp(θ ± t_{(1+level)/2}(df)·SE); D23 materiality; MDE. No gate is applied here (callers gate first).
 * Returns null when no interval can be computed (e.g. < 2 clusters in a window, or one session holds the
 * denominator). The confounder layer (WP-20b) calls this, so a standardised or leave-one-out range is computed
 * exactly like the raw one.
 */
export function measureShift(def: MetricDef, rc: readonly Cell[], bc: readonly Cell[], ctx: MeasureContext): Measurement | null {
  const rSessions = countWindow(rc).sessions, bSessions = countWindow(bc).sessions;
  // Range: primary scheme, plus the other scheme's SE when both windows have ≥ 5 sessions (METHOD.md §6).
  const m = ctx.method;
  const primaryScheme: ClusterScheme = m.twoLevel ? "session-day" : m.clusters;
  const primary = boot(rc, bc, primaryScheme, m.twoLevel, def, ctx);
  let kept = primary, keptScheme = primaryScheme, keptTwoLevel = m.twoLevel;
  let other: ComparisonView["other"] = null;
  let df = primary.df;
  if (m.keepLargerSe && rSessions >= 5 && bSessions >= 5) {
    const alt = otherScheme(m);
    const second = boot(rc, bc, alt, false, def, ctx);
    const primaryOk = primary.ok && Number.isFinite(primary.se);
    const secondOk = second.ok && Number.isFinite(second.se);
    if (secondOk && (!primaryOk || second.se > primary.se)) {
      other = { scheme: primaryScheme, se: primary.se, df: primary.df, ok: primaryOk };
      kept = second;
      keptScheme = alt;
      keptTwoLevel = false;
    } else {
      other = { scheme: alt, se: second.se, df: second.df, ok: secondOk };
    }
    // The larger SE comes with the SMALLER df of the two schemes (METHOD.md §6), so keeping the other scheme can only
    // widen the range, raise the MDE and the p-value, and never lift a metric over the df floor (agreement.ts) on the
    // other scheme's extra clusters. Taking that scheme's df too narrowed the range whenever its SE won by a hair.
    df = primaryOk && secondOk && primary.df > 0 && second.df > 0 ? Math.min(primary.df, second.df) : kept.df;
  }
  if (!kept.ok || !Number.isFinite(kept.se) || !(df > 0)) return null;

  const q = studentTQuantile(1 - (1 - m.level) / 2, df);
  const range = { lo: Math.exp(kept.logRatio - q * kept.se), hi: Math.exp(kept.logRatio + q * kept.se) };
  const comparison: ComparisonView = {
    scheme: keptScheme, twoLevel: keptTwoLevel, logRatio: kept.logRatio, ratio: kept.ratio, se: kept.se, df,
    level: m.level, range, pValue: twoSidedP(kept.logRatio / kept.se, df), other, resamples: kept.resamples, seed: kept.seed,
  };
  const call = d23Call(def, { ratio: kept.ratio, lo: range.lo, hi: range.hi, recentRate: kept.recent.rate, baselineRate: kept.baseline.rate });
  const mdc = minimumDetectableChange(kept.se, { alpha: mdeAlphaOf(m), df, power: MDE_POWER });
  return { comparison, call, mde: Math.exp(mdc.logDelta), mdeDown: Math.exp(-mdc.logDelta) };
}

/**
 * D23 materiality for one metric: range excludes 1×, ≥ 25% relative move, ≥ the metric's "1 pt" absolute
 * move. The floor carries a 1e-9 relative tolerance so a move of exactly one point (e.g. 5% → 4%, which is
 * 0.00999… in floating point) counts as one point.
 */
export function d23Call(def: MetricDef, ev: ChangeEvidence): ChangeCall {
  return classifyChange(ev, { minRelativeChange: D23_MIN_RELATIVE_CHANGE, absoluteFloor: def.point === null ? 0 : def.point * (1 - 1e-9) });
}

/** worse / better by the metric's worse direction; "shifted" when it has none; else "none". */
export function statusOf(def: MetricDef, call: ChangeCall): MetricStatusD {
  if (!call.material) return "none";
  if (def.worse === null) return "shifted";
  return call.direction === def.worse ? "worse" : "better";
}

function familiesReady(metrics: readonly MetricEvaluation[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of VOTING_FAMILIES) out[f] = metrics.some((x) => x.role === "vote" && x.family === f && x.eligible && x.sensitive);
  return out;
}

/**
 * D47(d)'s voting tool-error construct when G0 is inconclusive (D61 kept it): non-command failures vote and command
 * exits stay context. Exported for WP-21; evaluateAgent never applies it on its own (`errorsVote` is required).
 */
export const G0_FALLBACK_ERRORS_VOTE: ToolErrorVariant = "toolErrorsNonCmd";

/** Evaluate one agent's exchanges. */
export function evaluateAgent(exchanges: readonly MetricExchange[], opts: EvaluateOptions): AgentEvaluation {
  const method = opts.method ?? D23_LITERAL;
  if (method.level !== 0.95 && method.level !== 0.99) throw new RangeError(`method.level must be 0.95 or 0.99 (got ${String(method.level)})`);
  const gate = opts.gate ?? D23_GATE;
  const errorsVote = opts.errorsVote;
  if (!(TOOL_ERROR_VARIANTS as readonly unknown[]).includes(errorsVote)) {
    throw new RangeError(`errorsVote is required: one of ${TOOL_ERROR_VARIANTS.join(", ")} (got ${String(errorsVote)})`);
  }
  const timeZone = checkTimeZone(opts.timeZone);
  if (opts.resamples !== undefined && !(Number.isFinite(opts.resamples) && opts.resamples >= 2)) {
    // NaN would silently skip every bootstrap draw and leave only the counting floor (a falsely tight range).
    throw new RangeError(`resamples must be a finite number ≥ 2 (got ${String(opts.resamples)})`);
  }
  const today = todayFor(opts.now, timeZone);
  const todayIdx = mustDay(today, "today");
  const wanted = new Set<MetricId>(opts.metrics ?? METRICS.map((m) => m.id));
  const defs = METRICS.filter((m) => wanted.has(m.id) || roleOf(m.id, errorsVote) === "vote");
  // Cells for the evaluated metrics only (the others are never read here).
  const build = buildCells(exchanges, { agent: String(opts.agent), today, metrics: defs.map((d) => d.id) });

  let firstIdx = build.firstDay === null ? undefined : mustDay(build.firstDay);
  if (opts.firstDay !== undefined) {
    const f = dayIndex(opts.firstDay);
    if (f !== undefined && f < todayIdx && (firstIdx === undefined || f < firstIdx)) firstIdx = f;
  }
  const history = historyDaysOf(todayIdx, firstIdx);

  let englishOverride: number | null = null;
  if (opts.englishShare !== undefined && Number.isFinite(opts.englishShare)) englishOverride = Math.min(1, Math.max(0, opts.englishShare));
  const languageKnown = build.counts.languageKnown > 0;
  const englishShare = englishOverride ?? (languageKnown && build.counts.prompts > 0 ? build.counts.english / build.counts.prompts : null);

  const ctx: MetricContext = {
    method,
    gate,
    resamples: Math.floor(opts.resamples ?? DEFAULT_RESAMPLES),
    englishOverride,
    language: build.language,
    languageKnown,
    errorsVote,
  };
  const tiers: TierEvaluation[] = TIERS.map((tier) => {
    const met = history >= tier.historyDays;
    const w = tierWindows(todayIdx, tier);
    const metrics = defs.map((d) => evaluateMetric(d, build.cells[d.id], tier, todayIdx, met, ctx));
    const fam = familiesReady(metrics);
    return {
      tier: tier.tier, recentDays: tier.recentDays, baselineDays: tier.baselineDays, historyDays: tier.historyDays,
      historyMet: met,
      historyMetOn: firstIdx === undefined ? null : dayString(historyMetOn(firstIdx, tier)),
      windows: { recent: rangeStrings(w.recent), baseline: rangeStrings(w.baseline) },
      metrics,
      familiesReady: fam,
      ready: met && VOTING_FAMILIES.every((f) => fam[f]),
    };
  });

  let selectedTier: TierId | null = null;
  let selection: AgentEvaluation["selection"] = "no_history";
  const firstReady = tiers.find((t) => t.ready);
  if (firstReady) {
    selectedTier = firstReady.tier;
    selection = "ready";
  } else {
    const available = tiers.filter((t) => t.historyMet);
    if (available.length > 0) {
      selectedTier = available[available.length - 1]!.tier;
      selection = "largest_available";
    }
  }

  const evaluation = {
    agent: String(opts.agent), today, timeZone, method, errorsVote, gate,
    history: { firstDay: firstIdx === undefined ? null : dayString(firstIdx), days: history },
    counts: build.counts, englishShare, tiers, selectedTier, selection,
  } as Omit<AgentEvaluation, "progress"> as AgentEvaluation;
  // Progress (the progress.ts projection, the costliest part when no tier is ready) is computed on first read and kept: the
  // decision layer never reads it, the words layer and serialisation do (it is enumerable, so it serialises as before).
  let progress: ProgressView | undefined;
  Object.defineProperty(evaluation, "progress", {
    enumerable: true,
    configurable: true,
    get: () => (progress ??= buildProgress(build, tiers, selectedTier, todayIdx, history, ctx, defs, opts.progressHistory ?? [])),
  });
  return evaluation;
}

/** Projection inputs for one voting metric, from its cells (pooled over the largest tier span) and its anchors. */
export function projectionMetric(
  def: MetricDef,
  cells: readonly MetricCell[],
  todayIdx: number,
  history: number,
  anchors: readonly Anchor[] = [],
): ProjectionMetric {
  const pool = cellsBetween(cells, todayIdx - TIERS[TIERS.length - 1]!.historyDays, todayIdx - 1);
  const days = dayAggregates(cells, todayIdx);
  return {
    id: def.id,
    family: def.family,
    floor: def.floor,
    minDenominator: def.minDenominator,
    c: {
      "session-day": perClusterVariance(pool, "session-day"),
      session: perClusterVariance(pool, "session"),
    },
    anchors: [...anchors],
    pace: paceOf(days, todayIdx, history),
    days,
  };
}

/** Anchors from one metric evaluation: the kept scheme's SE and df, plus the other scheme's when computed. */
export function anchorsOf(tier: TierId, m: MetricEvaluation, source: Anchor["source"]): Anchor[] {
  const c = m.comparison;
  if (!m.eligible || c === null) return [];
  const out: Anchor[] = [{ tier, scheme: c.scheme, se: c.se, df: c.df, source }];
  if (c.other !== null && c.other.ok && Number.isFinite(c.other.se) && c.other.df > 0) {
    out.push({ tier, scheme: c.other.scheme, se: c.other.se, df: c.other.df, source });
  }
  return out;
}

/**
 * Measured anchors of one voting metric (D47(b): the projection starts from the SE measured now). Every tier in
 * which the metric is eligible contributes its measured SE. When tier 1's history is not met yet but its
 * windows already pass the gate, tier 1's windows are measured anyway (a "probe", used only to calibrate the
 * projection, never reported as a comparison), so a new user's ETA is anchored too.
 */
export function measuredAnchors(
  def: MetricDef,
  cells: readonly MetricCell[],
  tiers: readonly TierEvaluation[],
  todayIdx: number,
  ctx: MetricContext,
): Anchor[] {
  const out: Anchor[] = [];
  for (const t of tiers) {
    const m = t.metrics.find((x) => x.id === def.id);
    if (m) out.push(...anchorsOf(t.tier, m, "measured"));
  }
  const first = tiers.find((t) => t.tier === TIERS[0]!.tier);
  if (out.length === 0 && first && !first.historyMet) {
    const probe = evaluateMetric(def, cells, TIERS[0]!, todayIdx, true, ctx);
    out.push(...anchorsOf(TIERS[0]!.tier, probe, "probe"));
  }
  return out;
}

/** Schemes the projection uses: both with keepLargerSe, else the method's (two-level ≈ session). */
export function projectionSchemes(method: AnalysisMethod): ClusterScheme[] {
  if (method.keepLargerSe) return ["session-day", "session"];
  return [method.twoLevel ? "session" : method.clusters];
}

/**
 * Progress (METHOD.md §13) under the D64 product rule (eta.ts): `prior` holds this agent's records of the previous daily
 * evaluations. Ready = ready today and on the previous daily evaluation; otherwise the hold-aware projection, of which
 * a date (or a not-at-pace claim) is shown only when the rule allows it.
 */
export function buildProgress(
  build: CellBuild,
  tiers: readonly TierEvaluation[],
  selectedTier: TierId | null,
  todayIdx: number,
  history: number,
  ctx: MetricContext,
  defs: readonly MetricDef[],
  prior: readonly EtaRecord[] = [],
): ProgressView {
  const { method, gate, errorsVote } = ctx;
  const tierId: TierId = selectedTier ?? 1;
  const tier = tiers.find((t) => t.tier === tierId)!;
  const today = dayString(todayIdx);
  const readyToday = selectedTier !== null && tier.ready;
  const earlier = priorRecords(prior, today);
  const ready = heldReady(readyToday, earlier);
  const voting = defs.filter((d) => roleOf(d.id, errorsVote) === "vote");

  const unlock: UnlockItem[] = [];
  for (const m of tier.metrics) {
    if (m.role !== "vote") continue;
    if (!m.eligible) unlock.push({ metric: m.id, family: m.family, state: "ineligible", reason: m.ineligibleReason, blocking: m.gate.blocking, mde: null });
    else if (!m.sensitive) unlock.push({ metric: m.id, family: m.family, state: "not_sensitive", reason: null, blocking: [], mde: m.mde });
  }

  const usable = voting.filter((d) => {
    // A metric whose fields are missing can never become sensitive by waiting.
    const ev = tier.metrics.find((x) => x.id === d.id);
    return ev?.ineligibleReason !== "fields_missing";
  });
  const anchors: Record<string, Anchor[]> = {};
  const pace: Record<string, Pace> = {};
  const none = { etaDate: null, etaDays: null, etaTier: null, notAtCurrentPace: false, dateWithheld: null } as const;
  const view = (
    rest: Pick<ProgressView, "etaDate" | "etaDays" | "etaTier" | "notAtCurrentPace" | "reason" | "dateWithheld" | "projection" | "projected">,
    record: Omit<EtaRecord, "day" | "ready"> = { tier: null, eta: null, notAtPace: false },
  ): ProgressView => ({
    tier: tierId, ready: rest.reason === "ready", readyToday, ...rest,
    record: { day: today, ready: readyToday, ...record }, unlock, pace, anchors,
  });

  if (ready) {
    for (const d of usable) pace[d.id] = paceOf(dayAggregates(build.cells[d.id], todayIdx), todayIdx, history);
    return view({ ...none, reason: "ready", projection: null, projected: [] });
  }
  const pm = usable.map((d) => {
    const def = metricDef(d.id);
    const a = measuredAnchors(def, build.cells[d.id], tiers, todayIdx, ctx);
    anchors[d.id] = a;
    return projectionMetric(def, build.cells[d.id], todayIdx, history, a);
  });
  for (const p of pm) pace[p.id] = p.pace;
  if (!VOTING_FAMILIES.every((f) => pm.some((p) => p.family === f))) {
    return view({ ...none, reason: "metric_unavailable", projection: null, projected: [] });
  }
  const eta = projectEta({
    todayIdx,
    historyDays: history,
    tiers: TIERS,
    // projectEta's MDE uses α = 1 − level; a method's `mdeAlpha` (when set) carries through.
    level: method.mdeAlpha === undefined ? method.level : 1 - mdeAlphaOf(method),
    gate,
    schemes: projectionSchemes(method),
    families: VOTING_FAMILIES,
    metrics: pm,
    // D64(a): the ETA is the second of two consecutive ready days; today's measured readiness is day 0.
    hold: READY_HOLD,
    readyToday,
  });
  if (!eta.projectable) {
    return view({ ...none, reason: "no_data", projection: null, projected: [] });
  }
  if (eta.notAtCurrentPace || eta.etaDays === null) {
    const record = { tier: null, eta: null, notAtPace: true };
    const projection = { etaDays: null, etaTier: null, etaDate: null, notAtCurrentPace: true, maxSessionShare: null };
    return stableNotAtPace({ day: today, ready: readyToday, ...record }, earlier)
      ? view({ ...none, notAtCurrentPace: true, reason: "not_at_current_pace", projection, projected: [] }, record)
      : view({ ...none, reason: "no_date", dateWithheld: "unstable", projection, projected: [] }, record);
  }
  const etaDate = dayString(todayIdx + eta.etaDays);
  const record = { tier: eta.etaTier, eta: etaDate, notAtPace: false };
  const gated = dateGate(eta.at, VOTING_FAMILIES, build.agent);
  const projection = { etaDays: eta.etaDays, etaTier: eta.etaTier, etaDate, notAtCurrentPace: false, maxSessionShare: gated.share };
  const withheld: DateWithheld | null = !stableDate({ day: today, ready: readyToday, ...record }, earlier, eta.etaDays) ? "unstable" : gated.withheld;
  if (withheld !== null) return view({ ...none, reason: "no_date", dateWithheld: withheld, projection, projected: eta.at }, record);
  return view({
    etaDate, etaDays: eta.etaDays, etaTier: eta.etaTier, notAtCurrentPace: false, reason: "eta", dateWithheld: null, projection, projected: eta.at,
  }, record);
}
