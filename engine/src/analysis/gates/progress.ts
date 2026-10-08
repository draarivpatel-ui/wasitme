/**
 * Progress projection and ETA (METHOD.md §13; D47(b), D64). Effective sample size scales with clusters, not events
 * (the standard error resamples whole clusters, METHOD.md §6), so the projection works on cluster counts:
 *
 *  1. Pace. Over the trailing 28 complete days (fewer when history is shorter: the divisor is
 *     min(28, historyDays), so a ten-day-old user is not made to look slow), per voting metric:
 *     session-days/day, new sessions/day, events/day and denominator/day. Only session-days and
 *     sessions with a denominator count (as in the gate). A one-off marathon is not projected to repeat:
 *     in the pace, the single largest session's denominator is capped at the next-largest session's, and its
 *     events are scaled down with it (its rate is kept). Its real data still sits in the past windows.
 *  2. Projected windows. For an evaluation on day today + d, each window [a, b] keeps its real data for
 *     the days already past (≤ today − 1) and adds pace × (days of the window on or after today).
 *     Distinct sessions = real distinct sessions in the past part + new-session pace × future days
 *     (conservative for users with few long sessions: a session already running when the future part
 *     starts is only counted through the past part). The largest session's projected share is the larger of
 *     the biggest real session in the past part and one future session's share (pace denominator ÷ new-session
 *     pace, at most the whole future part); like the session count, it does not grow a past session into the
 *     future.
 *  3. Projected SE, anchored to the measured SE (D47(b); SE_tier ≈ SE_now·√(K_now/K_tier), METHOD.md §13). The model is
 *     SE²_model = Σ_window max(c / (K_w − 1), floor_w): c is the metric's per-cluster variance of the log rate
 *     (estimated once from the pooled data, without a small-sample factor, see `perClusterVariance`), K_w the
 *     window's projected cluster count (so each window gets its own K_w/(K_w − 1) factor), and floor_w the
 *     Poisson/binomial variance of its projected event count. The model is then calibrated to what the
 *     evaluation actually measured: with an anchor (a bootstrap SE and df measured on some tier's windows
 *     today), SE² = λ·SE²_model and df = ρ·df_model, where λ = SE²_measured / SE²_model(anchor windows, d = 0)
 *     and ρ = df_measured / df_model(anchor windows, d = 0). So on the anchor's own windows at d = 0 the
 *     projection reproduces the measured SE, df and MDE exactly, and later days scale it by the model's
 *     change in cluster counts. Anchor choice per tier and scheme: that tier's own measurement, else the
 *     largest measured tier (same scheme first, then the other scheme). Without any anchor the model is used
 *     as is (λ = ρ = 1). The projected variance never goes below the counting floor. With `keepLargerSe`
 *     both cluster schemes are projected and the larger SE is kept, mirroring the range (METHOD.md §6). A
 *     two-level measurement is reported under the "session-day" scheme, so it calibrates the session-day model
 *     (whose clusters grow faster than sessions do); the session scheme's projection is the check on that.
 *     df_model: each window K_w − 1, combined Welch–Satterthwaite.
 *  4. MDE = exp((t_{1−α/2}(df) + t_{.80}(df))·SE·1.1) from the stats module; sensitive = the projected D23
 *     gate passes in both windows (sessions, session-days, events, the metric's denominator floor and the
 *     largest session's share) and MDE ≤ 2×.
 *  5. ETA = the first day d = 1 … 84 on which some tier has its history requirement met AND at least one
 *     voting metric in each voting family is projected sensitive. After 84 days every window of every tier
 *     is fully projected and stationary, so no success by then means "not at your current pace" — and then
 *     no day count is ever shown. With `hold` = 2 (D64(a), what the evaluation uses) the ETA is the second of two
 *     consecutive projected-ready days, today's measured readiness counting as day 0.
 * Whether a projected date is SHOWN is D64(b)'s product rule (eta.ts), not this module's.
 */
import type { VarianceFloor } from "../stats/bootstrap.js";
import { dayIndex, PSEUDO_COUNT } from "../stats/ratio.js";
import { minimumDetectableChange } from "../stats/mdc.js";
import type { Cell, ClusterScheme } from "../stats/types.js";
import { MAX_SPAN_DAYS, tierWindows, type DayRange, type Tier, type TierId } from "../metrics/windows.js";
import { D23_GATE, MDE_POWER, SENSITIVE_MAX_MDE, type GateParams } from "./d23.js";

/** Trailing window for the pace, in days (METHOD.md §13). */
export const PACE_DAYS = 28;

export interface Pace {
  /** Per calendar day. */
  sessionDays: number;
  newSessions: number;
  events: number;
  denominator: number;
}

/** One session's totals on one day. */
export interface SessionDayAgg {
  session: string;
  events: number;
  denominator: number;
}

/** One past day of one metric. */
export interface DayAgg {
  day: number;
  events: number;
  denominator: number;
  /** Sessions with a denominator that day (session-days = its length), sorted. */
  sessions: readonly string[];
  /** Every session with events or a denominator that day, sorted by session. */
  perSession: readonly SessionDayAgg[];
}

export type PerScheme<T> = { "session-day": T; session: T };

/** A measured comparison the projection is calibrated to: the bootstrap SE and df on a tier's windows today. */
export interface Anchor {
  tier: TierId;
  scheme: ClusterScheme;
  se: number;
  df: number;
  /** "measured": the tier's own evaluation; "probe": tier 1's windows measured before its history is met. */
  source: "measured" | "probe";
}

export interface ProjectionMetric {
  id: string;
  family: string;
  floor: VarianceFloor;
  minDenominator: number;
  /** Per-cluster variance of the log rate, per scheme, without a small-sample factor; null = not estimable. */
  c: PerScheme<number | null>;
  /** Measured SEs to calibrate to (empty = the uncalibrated model). */
  anchors: readonly Anchor[];
  pace: Pace;
  /** Past days with data (any order; only days before today are used). */
  days: readonly DayAgg[];
}

export interface ProjectionInput {
  todayIdx: number;
  /** Complete days of history before today. */
  historyDays: number;
  tiers: readonly Tier[];
  /** Interval level; the MDE uses α = 1 − level. */
  level: number;
  power?: number;
  optimism?: number;
  gate?: GateParams;
  maxMde?: number;
  /** Schemes to project; the larger SE is kept. */
  schemes: readonly ClusterScheme[];
  /** Voting families that each need one sensitive metric. */
  families: readonly string[];
  /** Voting metrics. */
  metrics: readonly ProjectionMetric[];
  /** Last day offset searched (default 84 = the largest tier's history). */
  maxDays?: number;
  /**
   * Consecutive projected-ready daily evaluations the ETA needs (default 1). D64(a) "ready" is 2: the ETA is then the
   * second of two consecutive ready days, day 0 being today's measured readiness (`readyToday`).
   */
  hold?: number;
  /** Today's measured readiness (day 0 of the hold); default false. */
  readyToday?: boolean;
}

export interface ProjectedWindow {
  sessions: number;
  sessionDays: number;
  events: number;
  denominator: number;
  /** Largest single session's projected denominator in the window. */
  topDenominator: number;
  /** topDenominator ÷ denominator (0 with no denominator). */
  maxSessionShare: number;
}

/** How the kept scheme's SE was calibrated: λ (variance ratio) and ρ (df ratio), and from which anchor. */
export interface Calibration {
  tier: TierId;
  scheme: ClusterScheme;
  source: Anchor["source"];
  varianceRatio: number;
  dfRatio: number;
}

export interface ProjectedMetric {
  id: string;
  family: string;
  tier: TierId;
  recent: ProjectedWindow;
  baseline: ProjectedWindow;
  gatePass: boolean;
  /** Larger projected SE across schemes (Infinity when no scheme is computable). */
  se: number;
  df: number;
  scheme: ClusterScheme | null;
  /** Calibration of the kept scheme; null = uncalibrated model (no usable anchor). */
  calibration: Calibration | null;
  /** Projected MDE as a ratio (×2.0 = a doubling); Infinity when not computable. */
  mde: number;
  sensitive: boolean;
}

export interface EtaResult {
  /** Days from today to the first evaluation day that is projected ready; null if none. */
  etaDays: number | null;
  etaTier: TierId | null;
  /** True when no tier gets there at the current pace (then no day count is shown). */
  notAtCurrentPace: boolean;
  /** False when nothing could be projected at all (no estimable variance for any voting metric). */
  projectable: boolean;
  /** The projected metrics of the ETA tier on the ETA day (empty when there is no ETA). */
  at: ProjectedMetric[];
}

const DAY_SEP = "\u001f";

function floorVariance(kind: VarianceFloor, events: number, den: number): number {
  if (kind === "none") return 0;
  const base = 1 / (events + PSEUDO_COUNT);
  if (kind === "poisson") return base;
  const r = den > 0 ? Math.min(1, events / den) : 0;
  return (1 - r) * base;
}

/** Projected counts of one window [a, b] for an evaluation on todayIdx + d. */
export function projectWindow(m: ProjectionMetric, todayIdx: number, range: DayRange): ProjectedWindow {
  const pastTo = Math.min(range.to, todayIdx - 1);
  const futureDays = Math.max(0, range.to - Math.max(range.from, todayIdx) + 1);
  const sessions = new Set<string>();
  const perSession = new Map<string, number>();
  let sessionDays = 0, events = 0, denominator = 0;
  if (pastTo >= range.from) {
    for (const d of m.days) {
      if (d.day < range.from || d.day > pastTo) continue;
      events += d.events;
      denominator += d.denominator;
      sessionDays += d.sessions.length;
      for (const s of d.sessions) sessions.add(s);
      for (const p of d.perSession) if (p.denominator > 0) perSession.set(p.session, (perSession.get(p.session) ?? 0) + p.denominator);
    }
  }
  let pastTop = 0;
  for (const v of perSession.values()) if (v > pastTop) pastTop = v;
  const futureDen = m.pace.denominator * futureDays;
  const perNewSession = m.pace.newSessions > 0 ? m.pace.denominator / m.pace.newSessions : futureDen;
  const topDenominator = Math.max(pastTop, Math.min(futureDen, perNewSession));
  const totalDen = denominator + futureDen;
  return {
    sessions: sessions.size + m.pace.newSessions * futureDays,
    sessionDays: sessionDays + m.pace.sessionDays * futureDays,
    events: events + m.pace.events * futureDays,
    denominator: totalDen,
    topDenominator,
    maxSessionShare: totalDen > 0 ? topDenominator / totalDen : 0,
  };
}

function clustersOf(w: ProjectedWindow, scheme: ClusterScheme): number {
  return scheme === "session" ? w.sessions : w.sessionDays;
}

interface ModelSe {
  /** Model variance of the log ratio (before calibration). */
  v: number;
  df: number;
  /** Σ counting floors of both windows (the projection never goes below it). */
  floor: number;
}

/** The uncalibrated model SE² and df of one scheme on two projected windows; null when not computable. */
function modelSe(m: ProjectionMetric, scheme: ClusterScheme, recent: ProjectedWindow, baseline: ProjectedWindow): ModelSe | null {
  const c = m.c[scheme];
  if (c === null || !Number.isFinite(c)) return null;
  const kR = clustersOf(recent, scheme), kB = clustersOf(baseline, scheme);
  if (!(kR >= 2) || !(kB >= 2)) return null;
  const fR = floorVariance(m.floor, recent.events, recent.denominator);
  const fB = floorVariance(m.floor, baseline.events, baseline.denominator);
  const vR = Math.max(c / (kR - 1), fR);
  const vB = Math.max(c / (kB - 1), fB);
  const v = vR + vB;
  const df = v > 0 ? (v * v) / ((vR * vR) / (kR - 1) + (vB * vB) / (kB - 1)) : kR + kB - 2;
  return { v, df, floor: fR + fB };
}

/** The model on one tier's windows for an evaluation on todayIdx + d. */
function modelAt(input: ProjectionInput, m: ProjectionMetric, tier: Tier, d: number, scheme: ClusterScheme): ModelSe | null {
  const w = tierWindows(input.todayIdx + d, tier);
  return modelSe(m, scheme, projectWindow(m, input.todayIdx, w.recent), projectWindow(m, input.todayIdx, w.baseline));
}

/**
 * Calibration for (tier, scheme): the tier's own anchor in that scheme, else the largest measured tier in that
 * scheme, else the same two steps in the other scheme. An anchor is usable when its SE and df are positive and
 * finite and the model on its windows at d = 0 is computable and positive.
 */
export function calibrationFor(input: ProjectionInput, m: ProjectionMetric, tier: TierId, scheme: ClusterScheme): Calibration | null {
  const byTierDesc = [...m.anchors].sort((a, b) => b.tier - a.tier || (a.scheme < b.scheme ? -1 : a.scheme > b.scheme ? 1 : 0));
  const other: ClusterScheme = scheme === "session" ? "session-day" : "session";
  const order: Anchor[] = [];
  for (const s of [scheme, other]) {
    for (const a of byTierDesc) if (a.scheme === s && a.tier === tier) order.push(a);
    for (const a of byTierDesc) if (a.scheme === s && a.tier !== tier) order.push(a);
  }
  for (const a of order) {
    if (!(a.se > 0) || !Number.isFinite(a.se) || !(a.df > 0) || !Number.isFinite(a.df)) continue;
    const t = input.tiers.find((x) => x.tier === a.tier);
    if (!t) continue;
    const at0 = modelAt(input, m, t, 0, a.scheme);
    if (!at0 || !(at0.v > 0) || !(at0.df > 0)) continue;
    return { tier: a.tier, scheme: a.scheme, source: a.source, varianceRatio: (a.se * a.se) / at0.v, dfRatio: a.df / at0.df };
  }
  return null;
}

/** Project one metric for one tier, evaluated on todayIdx + d. */
export function projectMetric(input: ProjectionInput, m: ProjectionMetric, tier: Tier, d: number): ProjectedMetric {
  const gate = input.gate ?? D23_GATE;
  const w = tierWindows(input.todayIdx + d, tier);
  const recent = projectWindow(m, input.todayIdx, w.recent);
  const baseline = projectWindow(m, input.todayIdx, w.baseline);
  const ok = (x: ProjectedWindow) =>
    x.sessions >= gate.minSessions && x.sessionDays >= gate.minSessionDays && x.events >= gate.minEventsPerWindow &&
    x.denominator >= m.minDenominator && x.denominator > 0 && x.maxSessionShare < gate.maxSessionShareBelow;
  const gatePass = ok(recent) && ok(baseline);

  let se = -1, df = 0;
  let scheme: ClusterScheme | null = null;
  let calibration: Calibration | null = null;
  for (const s of input.schemes) {
    const model = modelSe(m, s, recent, baseline);
    if (!model) continue;
    const cal = calibrationFor(input, m, tier.tier, s);
    const v = Math.max((cal?.varianceRatio ?? 1) * model.v, model.floor);
    const seS = Math.sqrt(v);
    if (seS > se) {
      se = seS;
      df = (cal?.dfRatio ?? 1) * model.df;
      scheme = s;
      calibration = cal;
    }
  }
  if (scheme === null) {
    return { id: m.id, family: m.family, tier: tier.tier, recent, baseline, gatePass, se: Infinity, df: 0, scheme: null, calibration: null, mde: Infinity, sensitive: false };
  }
  const mdc = minimumDetectableChange(se, {
    alpha: 1 - input.level,
    df,
    power: input.power ?? MDE_POWER,
    ...(input.optimism !== undefined ? { optimism: input.optimism } : {}),
  });
  const mde = Math.exp(mdc.logDelta);
  return {
    id: m.id, family: m.family, tier: tier.tier, recent, baseline, gatePass, se, df, scheme, calibration, mde,
    sensitive: gatePass && mde <= (input.maxMde ?? SENSITIVE_MAX_MDE),
  };
}

/**
 * First day d ≥ 1 that ends a run of `hold` consecutive projected-ready days (default 1: the first projected-ready
 * day, 1 … maxDays). Projected ready on day d = some tier with its history met has a sensitive voting metric in every
 * voting family; day 0 is today's measured readiness (`readyToday`). Every window is fully projected and stationary
 * after maxDays, so the search runs to maxDays + hold − 1 and no success by then is "not at your current pace".
 * `etaTier` / `at` are the tier and projected metrics of the ETA day itself.
 */
export function projectEta(input: ProjectionInput): EtaResult {
  const maxDays = input.maxDays ?? MAX_SPAN_DAYS;
  const hold = Math.max(1, Math.floor(input.hold ?? 1));
  const projectable = input.metrics.some((m) => input.schemes.some((s) => m.c[s] !== null && Number.isFinite(m.c[s]!)));
  if (!projectable || input.families.length === 0) {
    return { etaDays: null, etaTier: null, notAtCurrentPace: false, projectable: false, at: [] };
  }
  const tiers = [...input.tiers].sort((a, b) => a.tier - b.tier);
  let run = input.readyToday === true ? 1 : 0;
  for (let d = 1; d <= maxDays + hold - 1; d++) {
    let hit: { tier: TierId; at: ProjectedMetric[] } | null = null;
    for (const tier of tiers) {
      if (input.historyDays + d < tier.historyDays) continue;
      const projected = input.metrics.map((m) => projectMetric(input, m, tier, d));
      const ready = input.families.every((f) => projected.some((p) => p.family === f && p.sensitive));
      if (ready) {
        hit = { tier: tier.tier, at: projected };
        break;
      }
    }
    run = hit === null ? 0 : run + 1;
    if (hit !== null && run >= hold) return { etaDays: d, etaTier: hit.tier, notAtCurrentPace: false, projectable: true, at: hit.at };
  }
  return { etaDays: null, etaTier: null, notAtCurrentPace: true, projectable: true, at: [] };
}

// ---------------------------------------------------------------------------------------------------
// Inputs from cells

const nonneg = (v: number) => (v > 0 && Number.isFinite(v) ? v : 0);

/** Per-day aggregates of one metric's cells strictly before today. */
export function dayAggregates(cells: readonly Cell[], todayIdx: number): DayAgg[] {
  const byDay = new Map<number, { events: number; denominator: number; perSession: Map<string, SessionDayAgg> }>();
  for (const c of cells) {
    const i = dayIndex(c.day);
    if (i === undefined || i >= todayIdx) continue;
    let a = byDay.get(i);
    if (!a) byDay.set(i, (a = { events: 0, denominator: 0, perSession: new Map() }));
    const n = nonneg(c.num), d = nonneg(c.den);
    if (n === 0 && d === 0) continue;
    a.events += n;
    a.denominator += d;
    const s = String(c.session);
    const p = a.perSession.get(s) ?? { session: s, events: 0, denominator: 0 };
    p.events += n;
    p.denominator += d;
    a.perSession.set(s, p);
  }
  return [...byDay.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([day, a]) => {
      const perSession = [...a.perSession.values()].sort((x, y) => (x.session < y.session ? -1 : x.session > y.session ? 1 : 0));
      return {
        day, events: a.events, denominator: a.denominator,
        sessions: perSession.filter((p) => p.denominator > 0).map((p) => p.session),
        perSession,
      };
    });
}

/**
 * Trailing-28-day pace (METHOD.md §13) from one metric's day aggregates. The single largest session in the pace
 * window counts for no more denominator than the next-largest one (its events scaled by the same factor; D47(c)),
 * so a one-off marathon is not projected to repeat every day; with one session only, nothing is capped.
 */
export function paceOf(days: readonly DayAgg[], todayIdx: number, historyDays: number, paceDays = PACE_DAYS): Pace {
  const divisor = Math.min(paceDays, historyDays);
  if (!(divisor >= 1)) return { sessionDays: 0, newSessions: 0, events: 0, denominator: 0 };
  const from = todayIdx - paceDays;
  const firstSeen = new Map<string, number>();
  const inWindow = new Map<string, { events: number; denominator: number }>();
  let sessionDays = 0, events = 0, denominator = 0;
  for (const d of days) {
    for (const s of d.sessions) {
      const f = firstSeen.get(s);
      if (f === undefined || d.day < f) firstSeen.set(s, d.day);
    }
    if (d.day < from || d.day >= todayIdx) continue;
    sessionDays += d.sessions.length;
    events += d.events;
    denominator += d.denominator;
    for (const p of d.perSession) {
      const t = inWindow.get(p.session) ?? { events: 0, denominator: 0 };
      t.events += p.events;
      t.denominator += p.denominator;
      inWindow.set(p.session, t);
    }
  }
  // One-off marathon guard (ties: no cap, the two largest are equal).
  const sized = [...inWindow.values()].filter((t) => t.denominator > 0).sort((a, b) => b.denominator - a.denominator);
  if (sized.length >= 2 && sized[0]!.denominator > sized[1]!.denominator) {
    const top = sized[0]!, cap = sized[1]!.denominator;
    const keep = cap / top.denominator;
    denominator -= top.denominator - cap;
    events -= top.events * (1 - keep);
  }
  let newSessions = 0;
  for (const f of firstSeen.values()) if (f >= from && f < todayIdx) newSessions++;
  return { sessionDays: sessionDays / divisor, newSessions: newSessions / divisor, events: Math.max(0, events) / divisor, denominator: Math.max(0, denominator) / divisor };
}

/**
 * Per-cluster variance c of a log ratio-of-totals, from the linearised (delta-method) cluster sandwich
 * WITHOUT a small-sample factor (the projection applies K_w/(K_w − 1) per projected window):
 * Var(log N/D) ≈ Σ_k (n_k/N − d_k/D)², c = Var · K. Under session-day clusters a zero-denominator session-day
 * is folded into a sibling of the same session first (as the bootstrap does). Returns null with fewer than 2
 * clusters or no denominator; 0 when there are no events (only the count floor then limits precision).
 */
export function perClusterVariance(cells: readonly Cell[], scheme: ClusterScheme): number | null {
  const groups = new Map<string, Map<string, { n: number; d: number }>>();
  for (const c of cells) {
    const session = String(c.session);
    const id = scheme === "session" ? session : session + DAY_SEP + String(c.day);
    let g = groups.get(session);
    if (!g) groups.set(session, (g = new Map()));
    const t = g.get(id) ?? { n: 0, d: 0 };
    t.n += nonneg(c.num);
    t.d += nonneg(c.den);
    g.set(id, t);
  }
  const ns: number[] = [], ds: number[] = [];
  for (const session of [...groups.keys()].sort()) {
    const g = groups.get(session)!;
    const kids = [...g.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => ({ ...v }));
    const merged: { n: number; d: number }[] = [];
    if (kids.some((k) => k.d > 0)) {
      let leading = 0;
      for (const k of kids) {
        if (k.d > 0) merged.push(k);
        else if (merged.length > 0) merged[merged.length - 1]!.n += k.n;
        else leading += k.n;
      }
      merged[0]!.n += leading;
    } else merged.push(...kids);
    for (const k of merged) {
      if (k.n === 0 && k.d === 0) continue;
      ns.push(k.n);
      ds.push(k.d);
    }
  }
  const K = ns.length;
  let N = 0, D = 0;
  for (let i = 0; i < K; i++) {
    N += ns[i]!;
    D += ds[i]!;
  }
  if (K < 2 || !(D > 0)) return null;
  if (N === 0) return 0;
  let s = 0;
  for (let i = 0; i < K; i++) {
    const u = ns[i]! / N - ds[i]! / D;
    s += u * u;
  }
  return s * K;
}
