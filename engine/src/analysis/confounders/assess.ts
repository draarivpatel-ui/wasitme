/**
 * Confounders, fragility, the df floor and the single-metric note for one agent and one tier (METHOD.md §7–§8; WP-20b).
 * Pure and deterministic, no I/O: the same exchanges and evaluation give the same output (every bootstrap is seeded
 * from its data, like the raw comparison's).
 *
 * Input: the agent's exchanges and the `AgentEvaluation` that `evaluateAgent` built from THE SAME exchanges (checked:
 * the rebuilt window totals must match the evaluation's, else this throws). Output, for the decision layer (WP-21)
 * and the words layer (WP-22):
 *
 *  - changed     METHOD.md §7 / D30 "changed" on the tier's voting metrics, with the research/08 df floor (agreement.ts);
 *  - df          the df floor per voting metric: usable, or `low_df` (counted) — a flag, gates unchanged;
 *  - standardised  per shifted (material) voting or friction metric: the directly standardised ratio and its range
 *                (standardise.ts);
 *  - projects    per shifted voting metric: the ≥ 2 qualifying projects / ≥ ⅔ agree rule (projects.ts);
 *  - workload    `unclear (workload)` (METHOD.md §11 row 4) when, for a shifted voting metric that "changed" can count
 *                (material and usable): no common strata ("your projects differ too much to compare" →
 *                `projects_differ`), or its standardised shift does not hold (`standardised_lost`), or the projects
 *                rule applies and fails (`projects_disagree`). Friction metrics are standardised for display only;
 *  - fragility   leave-one-session-out per eligible voting metric, and the 3-most-influential-days rule
 *                (fragility.ts);
 *  - singleIndicator  the Holm-gated note (single.ts);
 *  - mix         the informational "also flagged" moves (mix.ts) — never a state change.
 */
import { DEFAULT_RESAMPLES } from "../stats/bootstrap.js";
import type { AgentEvaluation, MeasureContext, MetricEvaluation, TierEvaluation } from "../gates/evaluate.js";
import { buildCells, cellsBetween, type StratumCell } from "../metrics/cells.js";
import { metricDef, type MetricId } from "../metrics/defs.js";
import { mustDay, rangeStrings, TIERS, tierWindows, type DayRangeStrings, type TierId } from "../metrics/windows.js";
import { totals } from "../stats/ratio.js";
import type { Cell } from "../stats/types.js";
import { changedOf, DF_FLOOR, dfFloor, usableForVerdict, type ChangedCall, type DfFloor } from "./agreement.js";
import { clusterFragility, dayFragility, type ClusterFragility, type DayFragility, type DayRuleMetric } from "./fragility.js";
import { MixCollector, mixFlags, type MixFlags } from "./mix.js";
import { projectRule, type ProjectRule } from "./projects.js";
import { singleIndicatorNote, type SingleIndicatorNote } from "./single.js";
import { standardisedShift, type StandardisedShift } from "./standardise.js";
import { checkDims, fullStratumKey, regroup, STRATUM_DIMS, type StratumDim } from "./strata.js";

export interface ConfounderOptions {
  /** Tier to assess (default: the evaluation's selected tier). */
  tier?: TierId;
  /** Standardisation strata (default METHOD.md §8's project × model × entrypoint). */
  dims?: readonly StratumDim[];
  /** Bootstrap size (default: the evaluation's own, read from its comparisons; else 2,000). */
  resamples?: number;
  /** research/08 df floor (default 4). */
  dfFloor?: number;
}

export type WorkloadReason = "projects_differ" | "standardised_lost" | "projects_disagree";

export interface Workload {
  /** METHOD.md §11 row 4: the confounder or project rule fails for a shifted voting metric. */
  unclear: boolean;
  /** Distinct reasons, in a fixed order: projects_differ, standardised_lost, projects_disagree. */
  reasons: WorkloadReason[];
  /** Per shifted voting metric that "changed" can count. */
  metrics: { metric: MetricId; reasons: WorkloadReason[] }[];
}

export interface ConfounderAssessment {
  agent: string;
  tier: TierId | null;
  windows: { recent: DayRangeStrings; baseline: DayRangeStrings } | null;
  dims: StratumDim[];
  changed: ChangedCall;
  df: DfFloor;
  standardised: StandardisedShift[];
  projects: ProjectRule[];
  workload: Workload;
  fragility: {
    /** Leave-one-session-out, per eligible voting metric. */
    sessions: ClusterFragility[];
    /** Material voting metrics whose shift does not survive dropping their most influential session. */
    fragileMetrics: MetricId[];
    /** The 3-most-influential-days rule. */
    days: DayFragility;
  };
  singleIndicator: SingleIndicatorNote;
  mix: MixFlags | null;
}

const REASON_ORDER: readonly WorkloadReason[] = ["projects_differ", "standardised_lost", "projects_disagree"];

function resamplesOf(tier: TierEvaluation | undefined): number {
  for (const m of tier?.metrics ?? []) if (m.comparison !== null) return m.comparison.resamples;
  return DEFAULT_RESAMPLES;
}

function sameTotals(cells: readonly Cell[], w: { events: number; denominator: number }): boolean {
  const t = totals(cells);
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  return close(t.num, w.events) && close(t.den, w.denominator);
}

/** Assess one agent's evaluation (see the file header). */
export function assessConfounders(
  exchanges: Parameters<typeof buildCells>[0],
  evaluation: AgentEvaluation,
  opts: ConfounderOptions = {},
): ConfounderAssessment {
  const dims = checkDims(opts.dims ?? STRATUM_DIMS);
  const floor = opts.dfFloor ?? DF_FLOOR;
  if (!(Number.isFinite(floor) && floor > 0)) throw new RangeError(`dfFloor must be a positive number (got ${String(floor)})`);
  const tierId = opts.tier ?? evaluation.selectedTier;
  const tierEval = tierId === null ? undefined : evaluation.tiers.find((t) => t.tier === tierId);
  if (tierId !== null && tierEval === undefined) throw new RangeError(`tier ${String(tierId)} is not in the evaluation`);
  const metrics: readonly MetricEvaluation[] = tierEval?.metrics ?? [];
  const changed = changedOf(metrics, floor);
  const df = dfFloor(metrics, floor);
  const singleIndicator = singleIndicatorNote(metrics, evaluation.method.level, floor);
  if (tierId === null || tierEval === undefined) {
    return {
      agent: evaluation.agent, tier: null, windows: null, dims, changed, df, standardised: [], projects: [],
      workload: { unclear: false, reasons: [], metrics: [] },
      fragility: { sessions: [], fragileMetrics: [], days: { applicable: false, drops: [], fragile: false } },
      singleIndicator, mix: null,
    };
  }

  const resamples = opts.resamples ?? resamplesOf(tierEval);
  if (!(Number.isFinite(resamples) && resamples >= 2)) throw new RangeError(`resamples must be a finite number ≥ 2 (got ${String(resamples)})`);
  const ctx: MeasureContext = { method: evaluation.method, resamples: Math.floor(resamples) };
  const todayIdx = mustDay(evaluation.today, "evaluation.today");
  const tier = TIERS.find((t) => t.tier === tierId)!;
  const w = tierWindows(todayIdx, tier);
  const collector = new MixCollector(w);
  // Cells for the tier's evaluated metrics only: nothing below reads another metric.
  const build = buildCells(exchanges, { agent: evaluation.agent, today: evaluation.today, stratumOf: fullStratumKey, onExchange: collector.observe, metrics: metrics.map((m) => m.id) });
  const strata = build.strata!;

  // Windowed cells per metric, checked against the evaluation (it must come from the same exchanges).
  const cut = <T extends Cell>(cells: readonly T[]) => ({ r: cellsBetween(cells, w.recent.from, w.recent.to), b: cellsBetween(cells, w.baseline.from, w.baseline.to) });
  const data = new Map<MetricId, { rc: Cell[]; bc: Cell[]; rs: StratumCell[]; bs: StratumCell[] }>();
  for (const ev of metrics) {
    const plain = cut(build.cells[ev.id]);
    const st = cut(strata[ev.id]);
    if (!sameTotals(plain.r, ev.recent) || !sameTotals(plain.b, ev.baseline)) {
      throw new RangeError(`the exchanges do not match the evaluation (metric ${ev.id}, tier ${tierId})`);
    }
    data.set(ev.id, { rc: plain.r, bc: plain.b, rs: st.r, bs: st.b });
  }

  const standardised: StandardisedShift[] = [];
  const projects: ProjectRule[] = [];
  const workloadRows: Workload["metrics"] = [];
  for (const ev of metrics) {
    if (!ev.material || ev.direction === null || ev.comparison === null) continue;
    if (ev.role !== "vote" && ev.role !== "support") continue;
    const def = metricDef(ev.id);
    const d = data.get(ev.id)!;
    const st = standardisedShift(def, ev, regroup(d.rs, dims), regroup(d.bs, dims), ctx);
    standardised.push(st);
    if (ev.role !== "vote") continue;
    const pr = projectRule(def, d.rs, d.bs, ev.direction, evaluation.gate);
    projects.push(pr);
    if (!usableForVerdict(ev, floor)) continue;
    const reasons: WorkloadReason[] = [];
    if (!st.overlap) reasons.push("projects_differ");
    else if (!st.holds) reasons.push("standardised_lost");
    if (!pr.holds) reasons.push("projects_disagree");
    workloadRows.push({ metric: ev.id, reasons });
  }
  const reasons = REASON_ORDER.filter((r) => workloadRows.some((m) => m.reasons.includes(r)));

  const voting = metrics.filter((m) => m.role === "vote");
  const sessions = voting
    .filter((ev) => ev.eligible && ev.comparison !== null)
    .map((ev) => clusterFragility(metricDef(ev.id), ev, data.get(ev.id)!.rc, data.get(ev.id)!.bc, ctx));
  const dayInputs: DayRuleMetric[] = voting.map((ev) => ({ def: metricDef(ev.id), ev, rc: data.get(ev.id)!.rc, bc: data.get(ev.id)!.bc }));
  const days = dayFragility(dayInputs, ctx, floor);

  return {
    agent: evaluation.agent,
    tier: tierId,
    windows: { recent: rangeStrings(w.recent), baseline: rangeStrings(w.baseline) },
    dims,
    changed,
    df,
    standardised,
    projects,
    workload: { unclear: reasons.length > 0, reasons, metrics: workloadRows },
    fragility: { sessions, fragileMetrics: sessions.filter((s) => s.fragile).map((s) => s.metric), days },
    singleIndicator,
    mix: mixFlags(collector, evaluation.agent),
  };
}
