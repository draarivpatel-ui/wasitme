/**
 * Calibration harness: how often does each interval method cry wolf when nothing changed, and how
 * often does it catch a real change? Everything is synthetic — no real logs are ever involved.
 *
 * Data model (per simulated user):
 *  - Sessions start as a Poisson process over the baseline + recent windows (plus lead-in days, so long
 *    sessions can already be running when the baseline starts). Each session spans a geometric number
 *    of calendar days and is active on each day of its span with some probability.
 *  - Each active session-day has an exposure (denominator) ~ negative binomial.
 *  - The rate on that session-day is base × exp(u_session + v_sessionDay) × (m if in the recent window),
 *    with u ~ N(0, sessionSd²), v ~ N(0, daySd²). The shared u makes days of one session correlated —
 *    the reason a flat session-day bootstrap is too narrow.
 *  - Events (numerator) ~ Binomial(den, min(0.95, rate)) for proportions, Poisson(den × rate) for counts.
 *
 * Two user shapes matter (DECISIONS D11): few very long sessions (~22 sessions over 72 days) and
 * many short ones. Both are provided as presets.
 */
import { bootstrapRatio, type VarianceFloor } from "./bootstrap.js";
import { evaluateGate, summarizeWindow, type GateThresholds } from "./gate.js";
import { minimumDetectableChange } from "./mdc.js";
import { permutationTest } from "./permutation.js";
import { clusterCells, dayString } from "./ratio.js";
import { Rng } from "./rng.js";
import type { Cell, Cluster, ClusterScheme, Interval } from "./types.js";

export interface UserShape {
  name: string;
  baselineDays: number;
  recentDays: number;
  /** Days before the baseline window in which sessions may already have started. */
  leadDays: number;
  /** Expected new sessions per calendar day. */
  sessionsPerDay: number;
  /** Mean calendar span of a session in days (geometric, ≥ 1). */
  meanSpanDays: number;
  /** Probability a session is used on each later day of its span (its first day is always active). */
  activeDayProb: number;
  /** Prompts per active session-day: negative binomial mean and size. */
  promptsMean: number;
  promptsSize: number;
  /** Log-scale SD of the per-session random effect on the rate. */
  sessionSd: number;
  /** Log-scale SD of the per-session-day random effect. */
  daySd: number;
}

export interface MetricShape {
  name: string;
  /** "proportion": events ≤ exposure (binomial); "count": events per unit of exposure (Poisson). */
  kind: "proportion" | "count";
  /** Baseline rate (probability for proportions, events per unit for counts). */
  rate: number;
  /** Exposure units per prompt (e.g. 5 tool calls per prompt for a tool-error rate). */
  exposurePerPrompt: number;
}

/** The few-long shape (D11): ~22 long sessions over 72 days, ~18 prompts/day, sessions spanning weeks. */
export const FEW_LONG_SESSIONS: UserShape = {
  name: "few-long",
  baselineDays: 28,
  recentDays: 14,
  leadDays: 30,
  sessionsPerDay: 0.3,
  meanSpanDays: 14,
  activeDayProb: 0.45,
  promptsMean: 10,
  promptsSize: 1.5,
  sessionSd: 0.5,
  daySd: 0.35,
};

/** Many short sessions: ~5 a day, each one day, a handful of prompts. */
export const MANY_SHORT_SESSIONS: UserShape = {
  name: "many-short",
  baselineDays: 28,
  recentDays: 14,
  leadDays: 0,
  sessionsPerDay: 5,
  meanSpanDays: 1.1,
  activeDayProb: 1,
  promptsMean: 6,
  promptsSize: 1.5,
  sessionSd: 0.5,
  daySd: 0.15,
};

/** In between: ~1 session a day lasting a few days. */
export const MEDIUM_SESSIONS: UserShape = {
  name: "medium",
  baselineDays: 28,
  recentDays: 14,
  leadDays: 7,
  sessionsPerDay: 1,
  meanSpanDays: 3,
  activeDayProb: 0.7,
  promptsMean: 8,
  promptsSize: 1.5,
  sessionSd: 0.5,
  daySd: 0.3,
};

export const TOOL_ERROR_RATE: MetricShape = { name: "tool-error", kind: "proportion", rate: 0.06, exposurePerPrompt: 5 };
export const INTERRUPT_RATE: MetricShape = { name: "interrupt", kind: "proportion", rate: 0.04, exposurePerPrompt: 1 };
export const STEPS_PER_PROMPT: MetricShape = { name: "steps", kind: "count", rate: 7, exposurePerPrompt: 1 };

export interface SimulatedWindows {
  recent: Cell[];
  baseline: Cell[];
}

const EPOCH = 20_000; // arbitrary day index (2024-10-04) for synthetic calendar days

/** One synthetic user's cells for both windows, with the recent rate multiplied by `multiplier`. */
export function simulateWindows(shape: UserShape, metric: MetricShape, multiplier: number, rng: Rng): SimulatedWindows {
  const total = shape.baselineDays + shape.recentDays;
  const startMin = -shape.leadDays;
  const nSessions = rng.poisson(shape.sessionsPerDay * (total + shape.leadDays));
  const recent: Cell[] = [];
  const baseline: Cell[] = [];
  const stay = shape.meanSpanDays > 1 ? 1 - 1 / shape.meanSpanDays : 0;
  for (let s = 0; s < nSessions; s++) {
    const start = startMin + rng.int(total + shape.leadDays);
    let span = 1;
    if (stay > 0) span += Math.floor(Math.log(rng.open()) / Math.log(stay));
    const u = rng.normal() * shape.sessionSd;
    const session = `s${s}`;
    for (let k = 0; k < span; k++) {
      const day = start + k;
      if (day >= total) break;
      if (k > 0 && rng.next() >= shape.activeDayProb) continue;
      if (day < 0) continue;
      const prompts = rng.negBinomial(shape.promptsMean, shape.promptsSize);
      if (prompts <= 0) continue;
      const den = metric.exposurePerPrompt === 1 ? prompts : rng.poisson(prompts * metric.exposurePerPrompt);
      if (den <= 0) continue;
      const isRecent = day >= shape.baselineDays;
      const rate = metric.rate * Math.exp(u + rng.normal() * shape.daySd) * (isRecent ? multiplier : 1);
      const num = metric.kind === "proportion" ? rng.binomial(den, Math.min(0.95, rate)) : rng.poisson(den * rate);
      (isRecent ? recent : baseline).push({ session, day: dayString(EPOCH + day), num, den });
    }
  }
  return { recent, baseline };
}

/**
 * Method ids: "<clusters>/<interval>[:<correction>]".
 *  clusters: session | day (flat session-day) | two-level (sessions, then days within session)
 *  interval: pct95 (bootstrap percentile) | t95 | t99 (small-sample t; correction count or cr2)
 *  plus perm/session and perm/day (cluster permutation test at α = 0.05).
 */
export type MethodId =
  | `${"session" | "day" | "two-level"}/pct95`
  | `${"session" | "day" | "two-level"}/${"t95" | "t99"}:${"count" | "cr2"}`
  | "perm/session" | "perm/day";

export const ALL_METHODS: readonly MethodId[] = [
  "session/pct95", "session/t95:count", "session/t95:cr2", "session/t99:count", "session/t99:cr2",
  "day/pct95", "day/t95:count", "day/t95:cr2", "day/t99:count", "day/t99:cr2",
  "two-level/pct95", "two-level/t95:count", "two-level/t95:cr2", "two-level/t99:count", "two-level/t99:cr2",
  "perm/session", "perm/day",
];

export interface CalibrationOptions {
  shape: UserShape;
  metric: MetricShape;
  /** Multipliers to inject in the recent window (1 = no change). Default [1]. */
  multipliers?: number[];
  /** Simulated users per multiplier ≠ 1 (default 300). */
  sims?: number;
  /** Simulated users at multiplier 1 (default 2 × sims). */
  nullSims?: number;
  /** Bootstrap / permutation resamples per test (default 2000). */
  resamples?: number;
  methods?: readonly MethodId[];
  seed?: string;
  /** Gate applied before counting (default: DEFAULT_GATE); `false` counts every simulated user. */
  gate?: Partial<GateThresholds> | false;
  /** Scheme the gate counts clusters under (default "session", as compareMetric does for the recommended method). */
  gateScheme?: ClusterScheme;
  /** Variance floor (default: binomial for proportions, poisson for counts). */
  floor?: VarianceFloor;
  /** Also measure power at each t method's own predicted MDC (default false). */
  mdcCheck?: boolean;
}

export interface MethodRow {
  method: MethodId;
  /** Share of gate-passing null users where the method called a change (either direction). */
  falsePositiveRate: number;
  /** 95% Wilson interval of that share (simulation noise). */
  falsePositiveCi: [number, number];
  /** Multiplier → share of gate-passing users where the change was called in the right direction. */
  power: Record<string, number>;
  /** Calls in the wrong direction across all non-null multipliers. */
  wrongDirection: number;
  /** For t methods with mdcCheck: median predicted detectable increase (no optimism correction / with it) and the power measured there. */
  mdc?: { predictedRaw: number; predictedCorrected: number; powerAtRaw: number; powerAtCorrected: number };
}

export interface CalibrationResult {
  shape: string;
  metric: string;
  resamples: number;
  /** Gate-passing users counted at multiplier 1. */
  nullCounted: number;
  /** Share of null users that passed the gate. */
  gatePassRate: number;
  /** Medians over null users: sessions, session-days and events per window. */
  medians: { recentSessions: number; recentSessionDays: number; recentEvents: number; baselineSessions: number; baselineEvents: number };
  rows: MethodRow[];
}

type Outcome = { up: boolean; down: boolean; t?: { se: number; df: number; level: number } };

function decide(iv: Interval): { up: boolean; down: boolean } {
  return { up: iv.lo > 1, down: iv.hi < 1 };
}

function needs(methods: readonly MethodId[], prefix: string): boolean {
  return methods.some((m) => m.startsWith(prefix));
}

/** Run every requested method on one simulated user. */
function evaluate(w: SimulatedWindows, methods: readonly MethodId[], resamples: number, floor: VarianceFloor, seed: string): Map<MethodId, Outcome> {
  const out = new Map<MethodId, Outcome>();
  const sessR = clusterCells(w.recent, "session"), sessB = clusterCells(w.baseline, "session");
  const dayR = clusterCells(w.recent, "session-day"), dayB = clusterCells(w.baseline, "session-day");
  const runBoot = (prefix: "session" | "day" | "two-level", r: Cluster[], b: Cluster[], twoLevel: boolean) => {
    if (!needs(methods, prefix + "/")) return;
    for (const corr of ["count", "cr2"] as const) {
      const wanted = corr === "count"
        ? needs(methods, prefix + "/pct") || needs(methods, prefix + "/t95:count") || needs(methods, prefix + "/t99:count")
        : needs(methods, prefix + "/t95:cr2") || needs(methods, prefix + "/t99:cr2");
      if (!wanted) continue;
      // Same seed for both corrections → identical replicates; only the t post-processing differs.
      const c = bootstrapRatio(r, b, { resamples, floor, twoLevel, smallSample: corr, seed: `${seed}|${prefix}` });
      const tInfo = (level: number) => ({ se: c.se, df: c.df, level });
      if (corr === "count") out.set(`${prefix}/pct95`, decide(c.percentile95));
      out.set(`${prefix}/t95:${corr}`, { ...decide(c.t95), t: tInfo(0.95) });
      out.set(`${prefix}/t99:${corr}`, { ...decide(c.t99), t: tInfo(0.99) });
    }
  };
  runBoot("session", sessR, sessB, false);
  runBoot("day", dayR, dayB, false);
  runBoot("two-level", dayR, dayB, true);
  const perm = (id: MethodId, r: ReturnType<typeof permutationTest>) => {
    const sig = r.ok && r.pValue <= 0.05;
    out.set(id, { up: sig && r.statistic > 0, down: sig && r.statistic < 0 });
  };
  if (methods.includes("perm/session")) perm("perm/session", permutationTest(sessR, sessB, { resamples, seed: seed + "|ps" }));
  if (methods.includes("perm/day")) perm("perm/day", permutationTest(dayR, dayB, { resamples, seed: seed + "|pd" }));
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 95% Wilson score interval for k successes out of n. */
export function wilson(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const z = 1.959963984540054;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const fmtMult = (m: number) => String(Math.round(m * 1000) / 1000);

export function calibrate(opts: CalibrationOptions): CalibrationResult {
  const methods = opts.methods ?? ALL_METHODS;
  const resamples = opts.resamples ?? 2000;
  const sims = opts.sims ?? 300;
  const nullSims = opts.nullSims ?? 2 * sims;
  const seed = opts.seed ?? "wasitme-calibration";
  const floor = opts.floor ?? (opts.metric.kind === "proportion" ? "binomial" : "poisson");
  const mults = [...(opts.multipliers ?? [1])];
  if (!mults.includes(1)) mults.unshift(1);

  const gateScheme = opts.gateScheme ?? "session";
  const passGate = (w: SimulatedWindows) =>
    opts.gate === false ||
    evaluateGate(summarizeWindow(w.recent, gateScheme), summarizeWindow(w.baseline, gateScheme), opts.gate ?? {}).pass;

  const rows = new Map<MethodId, MethodRow>(
    methods.map((m) => [m, { method: m, falsePositiveRate: 0, falsePositiveCi: [0, 1], power: {}, wrongDirection: 0 }]),
  );
  const tPredictions = new Map<MethodId, { raw: number[]; corrected: number[] }>();
  let nullCounted = 0, nullTried = 0;
  const med = { rs: [] as number[], rsd: [] as number[], re: [] as number[], bs: [] as number[], be: [] as number[] };

  const runAt = (
    m: number,
    n: number,
    collectNull: boolean,
    only: readonly MethodId[] = methods,
  ): { counted: number; hits: Map<MethodId, number>; wrong: Map<MethodId, number> } => {
    const rng = new Rng(`${seed}|${opts.shape.name}|${opts.metric.name}|${fmtMult(m)}`);
    const hits = new Map<MethodId, number>(only.map((x) => [x, 0]));
    const wrong = new Map<MethodId, number>(only.map((x) => [x, 0]));
    let counted = 0;
    for (let i = 0; i < n; i++) {
      const w = simulateWindows(opts.shape, opts.metric, m, rng);
      if (collectNull) nullTried++;
      if (!passGate(w)) continue;
      counted++;
      const res = evaluate(w, only, resamples, floor, `${seed}|${fmtMult(m)}|${i}`);
      for (const [id, o] of res) {
        if (!hits.has(id)) continue;
        const hit = m === 1 ? o.up || o.down : m > 1 ? o.up : o.down;
        const bad = m > 1 ? o.down : m < 1 ? o.up : false;
        if (hit) hits.set(id, hits.get(id)! + 1);
        if (bad) wrong.set(id, wrong.get(id)! + 1);
        if (collectNull && o.t && opts.mdcCheck) {
          const alpha = 1 - o.t.level;
          let p = tPredictions.get(id);
          if (!p) tPredictions.set(id, (p = { raw: [], corrected: [] }));
          p.raw.push(minimumDetectableChange(o.t.se, { alpha, df: o.t.df, optimism: 0 }).logDelta);
          p.corrected.push(minimumDetectableChange(o.t.se, { alpha, df: o.t.df }).logDelta);
        }
      }
      if (collectNull) {
        const sr = summarizeWindow(w.recent, "session-day"), sb = summarizeWindow(w.baseline, "session-day");
        med.rs.push(sr.sessions);
        med.rsd.push(sr.clusters);
        med.re.push(sr.events);
        med.bs.push(sb.sessions);
        med.be.push(sb.events);
      }
    }
    return { counted, hits, wrong };
  };

  for (const m of mults) {
    const isNull = m === 1;
    const r = runAt(m, isNull ? nullSims : sims, isNull);
    for (const row of rows.values()) {
      const h = r.hits.get(row.method)!;
      if (isNull) {
        nullCounted = r.counted;
        row.falsePositiveRate = r.counted ? h / r.counted : NaN;
        row.falsePositiveCi = wilson(h, r.counted);
      } else {
        row.power[fmtMult(m)] = r.counted ? h / r.counted : NaN;
        row.wrongDirection += r.wrong.get(row.method)!;
      }
    }
  }

  if (opts.mdcCheck) {
    for (const [id, p] of tPredictions) {
      const row = rows.get(id)!;
      const rawM = Math.exp(median(p.raw)), corrM = Math.exp(median(p.corrected));
      const at = (mm: number) => {
        if (!Number.isFinite(mm)) return NaN;
        const r = runAt(mm, sims, false, [id]);
        return r.counted ? r.hits.get(id)! / r.counted : NaN;
      };
      row.mdc = { predictedRaw: rawM - 1, predictedCorrected: corrM - 1, powerAtRaw: at(rawM), powerAtCorrected: at(corrM) };
    }
  }

  return {
    shape: opts.shape.name,
    metric: opts.metric.name,
    resamples,
    nullCounted,
    gatePassRate: nullTried ? nullCounted / nullTried : NaN,
    medians: { recentSessions: median(med.rs), recentSessionDays: median(med.rsd), recentEvents: median(med.re), baselineSessions: median(med.bs), baselineEvents: median(med.be) },
    rows: [...rows.values()],
  };
}

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "n/a");

/** Markdown table of calibration results (aggregate numbers only). */
export function formatCalibration(results: readonly CalibrationResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const mults = Object.keys(r.rows[0]?.power ?? {});
    lines.push(
      `### ${r.shape} × ${r.metric}  (null users counted ${r.nullCounted}, gate pass ${pct(r.gatePassRate)}, B=${r.resamples}; ` +
        `median recent sessions ${r.medians.recentSessions}, session-days ${r.medians.recentSessionDays}, events ${r.medians.recentEvents} vs baseline ${r.medians.baselineEvents})`,
    );
    lines.push(`| method | false-positive (95% sim CI) | ${mults.map((m) => `power ×${m}`).join(" | ")} | wrong dir | MDC check |`);
    lines.push(`|---|---|${mults.map(() => "---|").join("")}---|---|`);
    for (const row of r.rows) {
      const mdc = row.mdc
        ? `pred +${pct(row.mdc.predictedRaw)}→power ${pct(row.mdc.powerAtRaw)}; corrected +${pct(row.mdc.predictedCorrected)}→${pct(row.mdc.powerAtCorrected)}`
        : "";
      lines.push(
        `| ${row.method} | ${pct(row.falsePositiveRate)} (${pct(row.falsePositiveCi[0])}–${pct(row.falsePositiveCi[1])}) | ` +
          `${mults.map((m) => pct(row.power[m] ?? NaN)).join(" | ")} | ${row.wrongDirection} | ${mdc} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
