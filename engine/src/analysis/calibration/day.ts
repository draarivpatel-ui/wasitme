/**
 * Daily evaluation, as the product runs it (METHOD.md §2–§6, §13), for the calibration harness.
 *
 * `evaluateAgent` rebuilds every metric's cells and computes the progress projection on every call; the harness
 * evaluates each synthetic user once a day for 90 days under several estimator candidates, so it composes the same
 * exported building blocks with the shared work done once:
 *   1. per day: `buildCells` once, on the session-day rows (synth.ts `aggregateSessionDays`, exact for the work-unit
 *      metrics evaluated here) with day < today — exactly what `evaluateAgent` builds;
 *   2. per candidate method: `evaluateMetric` for every tier and the four tool-call metrics `evaluateAgent` evaluates
 *      with `metrics: ["toolErrors", "toolErrorsNonCmd"]` (tool errors both ways, reads per edit, blind edits), the
 *      same `familiesReady` / ready / tier-selection rule;
 *   3. both voting tool-error constructs (`toolErrorsNonCmd`, D47(d)'s fallback, and `toolErrors`) come from the
 *      one set of metric evaluations — only the `role` field differs between them;
 *   4. `progress` is `buildProgress` itself, computed lazily on first read (the decision rules never read it; G-MDE's
 *      ETA check does, threading the D64 progress records from one day to the next as the store does).
 * `test/calibration/harness.test.ts` asserts the result equals `evaluateAgent` on the raw exchanges.
 */
import type { AgentId, Exchange } from "../../types.js";
import { DEFAULT_RESAMPLES } from "../stats/bootstrap.js";
import { dayIndex, dayString } from "../stats/ratio.js";
import { D23_GATE, type AnalysisMethod } from "../gates/d23.js";
import { buildProgress, evaluateMetric, type AgentEvaluation, type MetricContext, type ProgressView, type TierEvaluation } from "../gates/evaluate.js";
import type { EtaRecord } from "../gates/eta.js";
import { buildCells, isAutomationEntrypoint, type CellBuild, type MetricCell } from "../metrics/cells.js";
import { METRICS, roleOf, VOTING_FAMILIES, type MetricDef, type MetricId, type ToolErrorVariant } from "../metrics/defs.js";
import { historyDays as historyDaysOf, historyMetOn, rangeStrings, TIERS, tierWindows } from "../metrics/windows.js";
import { dayIndices } from "./synth.js";

/** The metrics the harness evaluates: what `evaluateAgent` evaluates with `metrics: EVALUATED_EXTRA`. */
export const EVALUATED_EXTRA: readonly MetricId[] = Object.freeze(["toolErrors", "toolErrorsNonCmd"]);
/** Both voting tool-error constructs the gate is judged under (D47(d) fallback first). */
export const ERRORS_VOTES: readonly ToolErrorVariant[] = Object.freeze(["toolErrorsNonCmd", "toolErrors"]);

const DEFS: readonly MetricDef[] = METRICS.filter((m) => EVALUATED_EXTRA.includes(m.id) || roleOf(m.id, "toolErrorsNonCmd") === "vote" || roleOf(m.id, "toolErrors") === "vote");

export interface PreparedDay {
  todayIdx: number;
  today: string;
  /** Rows (session-day aggregates) strictly before today — what the confounder layer is given. */
  rows: Exchange[];
  build: CellBuild;
  firstIdx: number | undefined;
  history: number;
}

/**
 * One sequence's rows, ready for daily evaluation.
 *
 * Fast path: the cells are built ONCE for the whole sequence (`buildCells` with today = the day after its last row)
 * and each day takes the cells strictly before today whose session has a real human prompt before today — the
 * interim classifier's rule 3 (metrics/cells.ts, D47(a)), the only part of the interactive classification that
 * depends on "today" (rule 2, the entrypoint, does not). That is exactly the cell set a per-day `buildCells` gives;
 * `history.firstDay` is the earliest day of a row of such a session. The day's `counts` are the sequence's (they only
 * feed the pushback language share, which the harness does not evaluate). Rows that carry a reader `interactiveClass`
 * take the per-day `buildCells` path.
 */
export class DaySeries {
  readonly dayIdx: Int32Array;
  private readonly global: CellBuild | null;
  private readonly firstHuman = new Map<string, number>();
  private readonly firstUsed = new Map<string, number>();
  private readonly index = new Map<string, { cells: readonly MetricCell[]; day: Int32Array; human: Int32Array }>();

  constructor(readonly agent: AgentId, readonly rows: readonly Exchange[]) {
    this.dayIdx = dayIndices(rows);
    if (rows.length === 0 || rows.some((r) => r.interactiveClass !== undefined)) {
      this.global = null;
      return;
    }
    let last = -Infinity;
    rows.forEach((r, i) => {
      const d = this.dayIdx[i]!;
      if (d > last) last = d;
      const s = String(r.session);
      if (r.humanPrompt === 1 && !(this.firstHuman.get(s)! <= d)) this.firstHuman.set(s, d);
      if (!isAutomationEntrypoint(r.entrypoint) && !(this.firstUsed.get(s)! <= d)) this.firstUsed.set(s, d);
    });
    this.global = buildCells(rows, { agent, today: dayString(last + 1) });
    const add = (key: string, cells: readonly MetricCell[]) =>
      this.index.set(key, {
        cells,
        day: Int32Array.from(cells, (c) => dayIndex(c.day)!),
        human: Int32Array.from(cells, (c) => this.firstHuman.get(String(c.session)) ?? 2 ** 31 - 1),
      });
    for (const d of DEFS) add(d.id, this.global.cells[d.id]);
    add("\u0000language", this.global.language as MetricCell[]);
  }

  /** Rows strictly before `todayIdx` (rows are sorted by day). */
  prefix(todayIdx: number): Exchange[] {
    let lo = 0, hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dayIdx[mid]! < todayIdx) lo = mid + 1;
      else hi = mid;
    }
    return this.rows.slice(0, lo);
  }

  private cut(key: string, todayIdx: number): MetricCell[] {
    const ix = this.index.get(key)!;
    const out: MetricCell[] = [];
    for (let i = 0; i < ix.cells.length; i++) if (ix.day[i]! < todayIdx && ix.human[i]! < todayIdx) out.push(ix.cells[i]!);
    return out;
  }

  prepare(todayIdx: number): PreparedDay {
    const today = dayString(todayIdx);
    const rows = this.prefix(todayIdx);
    let build: CellBuild;
    let firstIdx: number | undefined;
    if (this.global === null) {
      build = buildCells(rows, { agent: this.agent, today });
      firstIdx = build.firstDay === null ? undefined : dayIndex(build.firstDay);
    } else {
      for (const [s, h] of this.firstHuman) {
        if (h >= todayIdx) continue;
        const u = this.firstUsed.get(s);
        if (u !== undefined && u < todayIdx && (firstIdx === undefined || u < firstIdx)) firstIdx = u;
      }
      const cells = {} as Record<MetricId, MetricCell[]>;
      for (const m of METRICS) cells[m.id] = this.index.has(m.id) ? this.cut(m.id, todayIdx) : [];
      build = {
        agent: this.agent, today,
        firstDay: firstIdx === undefined ? null : dayString(firstIdx),
        lastDay: null,
        counts: this.global.counts,
        cells,
        language: this.cut("\u0000language", todayIdx),
      };
    }
    return { todayIdx, today, rows, build, firstIdx, history: historyDaysOf(todayIdx, firstIdx) };
  }
}

function familiesReady(metrics: TierEvaluation["metrics"]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of VOTING_FAMILIES) out[f] = metrics.some((x) => x.role === "vote" && x.family === f && x.eligible && x.sensitive);
  return out;
}

function withRoles(tiers: readonly TierEvaluation[], errorsVote: ToolErrorVariant): TierEvaluation[] {
  return tiers.map((t) => {
    const metrics = t.metrics.map((m) => (m.role === roleOf(m.id, errorsVote) ? m : { ...m, role: roleOf(m.id, errorsVote) }));
    const fam = familiesReady(metrics);
    return { ...t, metrics, familiesReady: fam, ready: t.historyMet && VOTING_FAMILIES.every((f) => fam[f]) };
  });
}

function ctxFor(day: PreparedDay, method: AnalysisMethod, errorsVote: ToolErrorVariant, resamples: number): MetricContext {
  return {
    method,
    gate: D23_GATE,
    resamples,
    englishOverride: null,
    language: day.build.language,
    languageKnown: day.build.counts.languageKnown > 0,
    errorsVote,
  };
}

/**
 * Evaluate one prepared day under one method, for each voting tool-error construct. Equivalent to
 * `evaluateAgent(rowsBeforeToday, { agent, now: today 12:00 UTC, timeZone: "UTC", errorsVote, method, metrics: EVALUATED_EXTRA,
 * progressHistory })`.
 */
export function evaluateDay(
  series: DaySeries,
  day: PreparedDay,
  method: AnalysisMethod,
  errorsVotes: readonly ToolErrorVariant[] = ERRORS_VOTES,
  resamples = DEFAULT_RESAMPLES,
  progressHistory: readonly EtaRecord[] = [],
): Map<ToolErrorVariant, AgentEvaluation> {
  const { todayIdx, build, history, firstIdx } = day;
  const ctx0 = ctxFor(day, method, errorsVotes[0]!, resamples);
  const base: TierEvaluation[] = TIERS.map((tier) => {
    const met = history >= tier.historyDays;
    const w = tierWindows(todayIdx, tier);
    const metrics = DEFS.map((d) => evaluateMetric(d, build.cells[d.id], tier, todayIdx, met, ctx0));
    return {
      tier: tier.tier, recentDays: tier.recentDays, baselineDays: tier.baselineDays, historyDays: tier.historyDays,
      historyMet: met,
      historyMetOn: firstIdx === undefined ? null : dayString(historyMetOn(firstIdx, tier)),
      windows: { recent: rangeStrings(w.recent), baseline: rangeStrings(w.baseline) },
      metrics,
      familiesReady: {},
      ready: false,
    };
  });
  const languageKnown = build.counts.languageKnown > 0;
  const englishShare = languageKnown && build.counts.prompts > 0 ? build.counts.english / build.counts.prompts : null;
  const out = new Map<ToolErrorVariant, AgentEvaluation>();
  for (const errorsVote of errorsVotes) {
    const tiers = withRoles(base, errorsVote);
    let selectedTier: AgentEvaluation["selectedTier"] = null;
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
    const ev = {
      agent: series.agent, today: day.today, timeZone: "UTC", method, errorsVote, gate: D23_GATE,
      history: { firstDay: firstIdx === undefined ? null : dayString(firstIdx), days: history },
      counts: build.counts, englishShare, tiers, selectedTier, selection,
    } as Omit<AgentEvaluation, "progress"> as AgentEvaluation;
    let progress: ProgressView | undefined;
    const ctx = ctxFor(day, method, errorsVote, resamples);
    Object.defineProperty(ev, "progress", {
      enumerable: true,
      configurable: true,
      get: () => (progress ??= buildProgress(build, tiers, selectedTier, todayIdx, history, ctx, DEFS, progressHistory)),
    });
    out.set(errorsVote, ev);
  }
  return out;
}
