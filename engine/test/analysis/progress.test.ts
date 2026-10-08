import { test } from "node:test";
import assert from "node:assert/strict";
import { D23_LITERAL } from "../../src/analysis/gates/d23.js";
import { evaluateAgent, projectionMetric, projectionSchemes, type AgentEvaluation } from "../../src/analysis/gates/evaluate.js";
import { buildCells } from "../../src/analysis/metrics/cells.js";
import {
  calibrationFor, dayAggregates, paceOf, perClusterVariance, projectEta, projectMetric, projectWindow,
  type Anchor, type ProjectionInput, type ProjectionMetric,
} from "../../src/analysis/gates/progress.js";
import { metricDef, type MetricExchange } from "../../src/analysis/metrics/defs.js";
import { TIERS } from "../../src/analysis/metrics/windows.js";
import { studentTQuantile } from "../../src/analysis/stats/distributions.js";
import { dayIndex } from "../../src/analysis/stats/ratio.js";
import type { Cell } from "../../src/analysis/stats/types.js";
import { addDays, close, ex } from "./helpers.js";

const TODAY = "2026-10-04";
const T = dayIndex(TODAY)!;
const NOW = new Date(`${TODAY}T12:00:00Z`);
const OPTS = { agent: "claude-code", timeZone: "UTC", errorsVote: "toolErrors" } as const;

test("per-cluster variance, hand-computed: n = [1, 19, 1, 19] of 100 each → c = 0.81 (no small-sample factor)", () => {
  // N = 40, D = 400, u = ±0.225, Σu² = 0.2025, × K = 4 → 0.81. The projection applies K_w/(K_w − 1) per window.
  const cells: Cell[] = [1, 19, 1, 19].map((n, i) => ({ session: `s${i}`, day: "2026-09-01", num: n, den: 100 }));
  assert.ok(close(perClusterVariance(cells, "session-day")!, 0.81));
  assert.ok(close(perClusterVariance(cells, "session")!, 0.81));
});

test("per-cluster variance folds a zero-denominator session-day into its session (as the bootstrap does)", () => {
  const cells: Cell[] = [
    { session: "a", day: "2026-09-01", num: 2, den: 10 },
    { session: "a", day: "2026-09-02", num: 3, den: 0 },
    { session: "b", day: "2026-09-01", num: 1, den: 10 },
    { session: "c", day: "2026-09-01", num: 0, den: 10 },
  ];
  // Clusters {5,10}, {1,10}, {0,10}: N = 6, D = 30, u = 1/2, −1/6, −1/3; Σu² = 7/18; × K = 3 → 7/6.
  assert.ok(close(perClusterVariance(cells, "session-day")!, 7 / 6));
  assert.ok(close(perClusterVariance(cells, "session")!, 7 / 6));
  assert.equal(perClusterVariance(cells.slice(0, 2), "session-day"), null); // one cluster
  assert.equal(perClusterVariance([{ session: "a", day: "2026-09-01", num: 0, den: 5 }, { session: "b", day: "2026-09-01", num: 0, den: 5 }], "session"), 0);
});

test("pace divides by min(28, history): a 10-day-old user is not made to look slow", () => {
  const cells: Cell[] = [];
  for (let k = 1; k <= 10; k++) for (const s of ["a", "b"]) cells.push({ session: `${s}${k}`, day: addDays(TODAY, -k), num: 1, den: 5 });
  const days = dayAggregates(cells, T);
  assert.deepEqual(paceOf(days, T, 10), { sessionDays: 2, newSessions: 2, events: 2, denominator: 10 });
  // With 40 days of history the same 10 days are spread over 28.
  assert.deepEqual(paceOf(days, T, 40), { sessionDays: 20 / 28, newSessions: 20 / 28, events: 20 / 28, denominator: 100 / 28 });
  assert.deepEqual(paceOf(days, T, 0), { sessionDays: 0, newSessions: 0, events: 0, denominator: 0 });
  // A long session seen before the trailing window is not "new".
  const long = dayAggregates([{ session: "L", day: addDays(TODAY, -40), num: 0, den: 1 }, { session: "L", day: addDays(TODAY, -3), num: 0, den: 1 }], T);
  assert.equal(paceOf(long, T, 40).newSessions, 0);
  assert.equal(paceOf(long, T, 40).sessionDays, 1 / 28);
});

test("pace: a one-off marathon counts for no more than the next-largest session", () => {
  // 28 days × 3 one-day sessions of 50 calls (5 errors), plus one 6,000-call session (600 errors) at T−5.
  const cells: Cell[] = [];
  for (let k = 1; k <= 28; k++) for (let i = 0; i < 3; i++) cells.push({ session: `s${i}-${k}`, day: addDays(TODAY, -k), num: 5, den: 50 });
  cells.push({ session: "giant", day: addDays(TODAY, -5), num: 600, den: 6000 });
  const pace = paceOf(dayAggregates(cells, T), T, 60);
  // Uncapped the pace would be (4,200 + 6,000)/28 ≈ 364 calls a day. Capped at 50: (84·50 + 50)/28; events
  // keep the giant's rate: (84·5 + 600·50/6000)/28.
  assert.ok(close(pace.denominator, (84 * 50 + 50) / 28));
  assert.ok(close(pace.events, (84 * 5 + 5) / 28));
  assert.ok(close(pace.sessionDays, 85 / 28) && close(pace.newSessions, 85 / 28));
  // Two equally large sessions are a pattern, not a one-off: nothing is capped.
  const twins = dayAggregates([...cells, { session: "giant2", day: addDays(TODAY, -6), num: 600, den: 6000 }], T);
  assert.ok(close(paceOf(twins, T, 60).denominator, (84 * 50 + 12000) / 28));
});

test("projected window = real past part + pace × future days; the largest session's projected share", () => {
  const m: ProjectionMetric = {
    id: "toolErrors", family: "errors", floor: "binomial", minDenominator: 0, c: { "session-day": 1, session: 1 }, anchors: [],
    pace: { sessionDays: 2, newSessions: 1, events: 3, denominator: 30 },
    days: [
      { day: T - 2, events: 4, denominator: 40, sessions: ["a", "b"], perSession: [{ session: "a", events: 3, denominator: 30 }, { session: "b", events: 1, denominator: 10 }] },
      { day: T - 1, events: 1, denominator: 10, sessions: ["a"], perSession: [{ session: "a", events: 1, denominator: 10 }] },
      { day: T - 9, events: 99, denominator: 99, sessions: ["z"], perSession: [{ session: "z", events: 99, denominator: 99 }] }, // outside
    ],
  };
  // Window [T−2, T+4]: past days T−2, T−1 (session a: 40 of 50); 5 future days at 30/day, one new session a
  // day holding 30 each. Top = 40 of 200.
  assert.deepEqual(projectWindow(m, T, { from: T - 2, to: T + 4 }), {
    sessions: 2 + 5, sessionDays: 3 + 10, events: 5 + 15, denominator: 50 + 150, topDenominator: 40, maxSessionShare: 0.2,
  });
  // Fully past: a holds 30 of 40. Fully future (2 days): each new session holds 30 of 60.
  assert.deepEqual(projectWindow(m, T, { from: T - 2, to: T - 2 }), { sessions: 2, sessionDays: 2, events: 4, denominator: 40, topDenominator: 30, maxSessionShare: 0.75 });
  assert.deepEqual(projectWindow(m, T, { from: T + 3, to: T + 4 }), { sessions: 2, sessionDays: 4, events: 6, denominator: 60, topDenominator: 30, maxSessionShare: 0.5 });
  // No new sessions at all: the whole future part may belong to one session.
  const noNew = { ...m, pace: { ...m.pace, newSessions: 0 } };
  assert.equal(projectWindow(noNew, T, { from: T + 3, to: T + 4 }).maxSessionShare, 1);
});

/**
 * Golden fixture. 30 days of history; every day two new one-day sessions, each one exchange:
 *  - tool errors: 100 calls, 1 or 19 failures (rate 10%) → per-cluster variance c = 0.81 in both schemes
 *    (each session is one day): u = ±0.015 over 60 clusters, Σu² = 0.0135, × 60;
 *  - blind edits: 100 edits, 5 or 15 blind → c = 0.25; reads per edit: 200 reads → 2.0 exactly, c = 0
 *    (only the count floor limits it).
 * Pace = 2 session-days, 2 new sessions, 20 errors, 200 calls per day; no session is larger than another.
 * Model variance of a tier evaluated with recent / baseline cluster counts K_R / K_B:
 *   v(K_R, K_B) = c/(K_R − 1) + c/(K_B − 1), df = Welch–Satterthwaite with K_R − 1, K_B − 1.
 *  - today's tier-1 windows (the calibration probe): K = 28 / 32 → v0 = 0.0561290, df0 = 56.912;
 *  - tier 1, any d ≥ 12 (reachable from 30 + 12 = 42): K = 28 / 56 → v = 0.0447273, df = 53.667;
 *  - tier 2, any d ≥ 33: K = 42 / 84 → v = 0.0295151, df = 81.667;
 *  - tier 3, any d ≥ 54: K = 56 / 112 → v = 0.0220246, df = 109.667.
 * With calibration λ (SE² = λ·v) and ρ ≈ 1, MDE = exp((t.995 + t.80)(df)·√(λ·v)·1.1) ≤ 2 holds at tier 1 only
 * for λ ≤ 0.7169, at tier 2 for λ ≤ 1.1087, at tier 3 for λ ≤ 1.5005 (uncalibrated MDEs 2.267, 1.931, 1.761).
 * Research is ready at tier 1 from d = 12. So for any λ in (0.7169, 1.1087] the ETA is d = 33 at tier 2.
 */
function goldenExchanges(extraDays = 0): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 30; k >= 1 - extraDays; k--) {
    const day = addDays(TODAY, -k);
    for (const [s, err, blind] of [["a", 1, 5], ["b", 19, 15]] as const) {
      xs.push(ex({ session: `${s}-${day}`, day, toolCalls: 100, toolErrors: err, edits: 100, reads: 200, blindEdits: blind }));
    }
  }
  return xs;
}

function tSum(df: number): number {
  return studentTQuantile(0.995, df) + studentTQuantile(0.8, df);
}

/** v and df of the model for cluster counts kR / kB with per-cluster variance c (see the fixture comment). */
function model(c: number, kR: number, kB: number): { v: number; df: number } {
  const vR = c / (kR - 1), vB = c / (kB - 1);
  return { v: vR + vB, df: (vR + vB) ** 2 / (vR ** 2 / (kR - 1) + vB ** 2 / (kB - 1)) };
}

test("ETA golden: calibrated to tier 1's probe, the projection gives 33 days at tier 2", () => {
  const ev = evaluateAgent(goldenExchanges(), { ...OPTS, now: NOW, resamples: 200 });
  assert.equal(ev.history.days, 30);
  assert.equal(ev.history.firstDay, "2026-09-04");
  assert.equal(ev.selectedTier, null);
  assert.equal(ev.selection, "no_history");
  assert.deepEqual(ev.tiers.map((t) => t.historyMetOn), ["2026-10-16", "2026-11-06", "2026-11-27"]);
  const p = ev.progress;
  // Tier 2 is first projected ready on d = 33 (2026-11-06) and stays so: D64(a)'s hold puts the ETA on the second
  // ready day, d = 34. A first evaluation has no earlier ones to be stable with, so no date is shown (D64(b)).
  assert.equal(projectEta(goldenInput(ev)).etaDays, 33);
  assert.deepEqual(
    [p.reason, p.ready, p.readyToday, p.etaDays, p.etaTier, p.etaDate, p.notAtCurrentPace, p.dateWithheld],
    ["no_date", false, false, null, null, null, false, "unstable"],
  );
  assert.deepEqual({ ...p.projection, maxSessionShare: null }, { etaDays: 34, etaTier: 2, etaDate: "2026-11-07", notAtCurrentPace: false, maxSessionShare: null });
  assert.ok(close(p.projection!.maxSessionShare!, 100 / 4200));
  assert.deepEqual(p.record, { day: TODAY, ready: false, tier: 2, eta: "2026-11-07", notAtPace: false });
  assert.deepEqual(p.pace.toolErrors, { sessionDays: 2, newSessions: 2, events: 20, denominator: 200 });

  // No tier's history is met, so tier 1's windows were measured as a probe, in both schemes.
  const anchors = p.anchors.toolErrors!;
  assert.deepEqual(anchors.map((a) => [a.tier, a.source]).sort(), [[1, "probe"], [1, "probe"]]);
  assert.deepEqual(anchors.map((a) => a.scheme).sort(), ["session", "session-day"]);

  const te = p.projected.find((m) => m.id === "toolErrors")!;
  assert.deepEqual(te.recent, { sessions: 42, sessionDays: 42, events: 420, denominator: 4200, topDenominator: 100, maxSessionShare: 100 / 4200 });
  assert.deepEqual(te.baseline, { sessions: 84, sessionDays: 84, events: 840, denominator: 8400, topDenominator: 100, maxSessionShare: 100 / 8400 });
  // Both schemes share one model here, so the kept scheme is the one whose measured SE is larger.
  const kept = anchors.reduce((a, b) => (b.se > a.se ? b : a));
  const m0 = model(0.81, 28, 32), m2 = model(0.81, 42, 84);
  assert.ok(close(m0.v, 0.0561290, 1e-5) && close(m2.v, 0.0295151, 1e-5) && close(m2.df, 81.667, 1e-4));
  const lambda = kept.se ** 2 / m0.v, rho = kept.df / m0.df;
  assert.deepEqual(te.calibration, { tier: 1, scheme: kept.scheme, source: "probe", varianceRatio: te.calibration!.varianceRatio, dfRatio: te.calibration!.dfRatio });
  assert.ok(close(te.calibration!.varianceRatio, lambda, 1e-9) && close(te.calibration!.dfRatio, rho, 1e-9));
  const se = Math.sqrt(lambda * m2.v), df = rho * m2.df;
  assert.ok(close(te.se, se, 1e-9));
  assert.ok(close(te.df, df, 1e-9));
  assert.ok(close(te.mde, Math.exp(tSum(df) * se * 1.1), 1e-9));
  // The measured probe lands inside the hand-derived bracket that makes d = 33, tier 2 the answer.
  assert.ok(lambda > 0.7169 && lambda <= 1.1087, `λ = ${lambda}`);
  assert.ok(te.mde <= 2 && te.sensitive);
});

test("ETA golden: tier 1 stays above 2× for tool errors at constant pace", () => {
  const ev = evaluateAgent(goldenExchanges(), { ...OPTS, now: NOW, resamples: 200 });
  const input = goldenInput(ev);
  const te = input.metrics.find((m) => m.id === "toolErrors")!;
  assert.ok(close(te.c["session-day"]!, 0.81));
  assert.ok(close(te.c.session!, 0.81));
  const m1 = model(0.81, 28, 56);
  for (const d of [12, 32]) {
    const pm = projectMetric(input, te, TIERS[0]!, d);
    assert.deepEqual([pm.recent.sessionDays, pm.baseline.sessionDays], [28, 56]);
    const cal = pm.calibration!;
    const se = Math.sqrt(cal.varianceRatio * m1.v), df = cal.dfRatio * m1.df;
    assert.ok(close(pm.mde, Math.exp(tSum(df) * se * 1.1), 1e-9));
    assert.ok(pm.mde > 2 && !pm.sensitive);
  }
  const be = input.metrics.find((m) => m.id === "blindEdits")!;
  assert.ok(projectMetric(input, be, TIERS[0]!, 12).sensitive);
  assert.equal(projectEta({ ...input, metrics: input.metrics.filter((m) => m.family === "research"), families: ["research"] }).etaDays, 12);
});

test("ETA golden, hand-set anchor: a measured SE 10% above the model (λ = 1.21) moves the ETA to tier 3 at d = 54", () => {
  const ev = evaluateAgent(goldenExchanges(), { ...OPTS, now: NOW, resamples: 50 });
  const base = goldenInput(ev, false);
  const m0 = model(0.81, 28, 32);
  // An anchor on today's tier-1 windows with SE² = 1.21 × the model and the model's df (ρ = 1).
  const anchor: Anchor = { tier: 1, scheme: "session-day", se: Math.sqrt(1.21 * m0.v), df: m0.df, source: "measured" };
  const metrics = base.metrics.map((m) => (m.id === "toolErrors" ? { ...m, anchors: [anchor] } : m));
  const input = { ...base, metrics };
  const te = metrics.find((m) => m.id === "toolErrors")!;
  // The session scheme has no anchor of its own: it borrows the session-day one (same tier, other scheme).
  const cal = calibrationFor(input, te, 2, "session")!;
  assert.deepEqual([cal.tier, cal.scheme, cal.source], [1, "session-day", "measured"]);
  assert.ok(close(cal.varianceRatio, 1.21, 1e-12) && close(cal.dfRatio, 1, 1e-12));
  // Tier 2 now projects exp(t·√(1.21·0.0295151)·1.1) = 2.063 > 2 on every day; tier 3 first counts at
  // d = 54 (30 + 54 = 84): 1.21 · 0.0220246 → SE = 0.163247, df = 109.667, MDE = 1.8635 ≤ 2.
  const m2 = model(0.81, 42, 84), m3 = model(0.81, 56, 112);
  assert.ok(close(projectMetric(input, te, TIERS[1]!, 40).mde, Math.exp(tSum(m2.df) * Math.sqrt(1.21 * m2.v) * 1.1), 1e-9));
  assert.ok(projectMetric(input, te, TIERS[1]!, 40).mde > 2.06);
  const eta = projectEta(input);
  assert.deepEqual([eta.etaDays, eta.etaTier], [54, 3]);
  const at = eta.at.find((m) => m.id === "toolErrors")!;
  assert.ok(close(at.se, 0.163247, 1e-5) && close(at.df, 109.667, 1e-5));
  assert.ok(close(at.mde, Math.exp(tSum(m3.df) * Math.sqrt(1.21 * m3.v) * 1.1), 1e-9));
  assert.ok(close(at.mde, 1.8635, 1e-4));
  // Uncalibrated (no anchors) the same data says d = 33 at tier 2.
  assert.deepEqual([projectEta(base).etaDays, projectEta(base).etaTier], [33, 2]);
});

function goldenInput(ev: AgentEvaluation, withAnchors = true): ProjectionInput {
  // The same path the evaluation takes: cells → projection inputs per voting metric (+ its measured anchors).
  const build = buildCells(goldenExchanges(), { agent: "claude-code", today: TODAY });
  const ids = ["toolErrors", "readsPerEdit", "blindEdits"] as const;
  return {
    todayIdx: T, historyDays: ev.history.days, tiers: TIERS, level: 0.99, schemes: projectionSchemes(D23_LITERAL), families: ["errors", "research"],
    metrics: ids.map((id) => projectionMetric(metricDef(id), build.cells[id], T, ev.history.days, withAnchors ? ev.progress.anchors[id] ?? [] : [])),
  };
}

/**
 * D47(b) anchors the projection to the measured SE. 70 days, two one-day sessions a day of 100 calls; in the
 * last 42 days one session fails 0 calls and the other 30, before that both fail 10. The pooled 84-day model
 * (quiet old data) is optimistic: uncalibrated it promised tier 2 "tomorrow" every day while tier 2's measured
 * MDE stayed above 2×.
 */
function noisyTail(extraDays: number): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 70; k >= 1 - extraDays; k--) {
    const day = addDays(TODAY, -k);
    for (let i = 0; i < 2; i++) {
      const err = k <= 42 ? (i === 0 ? 0 : 30) : 10;
      xs.push(ex({ session: `s${i}-${day}`, day, toolCalls: 100, toolErrors: err, edits: 50, reads: 100, blindEdits: 5 }));
    }
  }
  return xs;
}

test("calibration: on today's windows the projection reproduces the measured MDE exactly", () => {
  const ev = evaluateAgent(noisyTail(0), { ...OPTS, now: NOW, resamples: 300 });
  assert.equal(ev.progress.reason, "no_date");
  assert.notEqual(ev.progress.projection?.etaDate ?? null, null);
  const build = buildCells(noisyTail(0), { agent: "claude-code", today: TODAY });
  const te = projectionMetric(metricDef("toolErrors"), build.cells.toolErrors, T, ev.history.days, ev.progress.anchors.toolErrors);
  const input: ProjectionInput = {
    todayIdx: T, historyDays: ev.history.days, tiers: TIERS, level: 0.99, schemes: projectionSchemes(D23_LITERAL), families: ["errors"], metrics: [te],
  };
  for (const tier of [1, 2] as const) {
    const measured = ev.tiers[tier - 1]!.metrics.find((m) => m.id === "toolErrors")!;
    assert.equal(measured.eligible, true);
    const at0 = projectMetric(input, te, TIERS[tier - 1]!, 0);
    assert.deepEqual([at0.calibration!.tier, at0.calibration!.source, at0.scheme], [tier, "measured", measured.comparison!.scheme]);
    assert.ok(close(at0.se, measured.comparison!.se, 1e-9), `tier ${tier}: se ${at0.se} vs ${measured.comparison!.se}`);
    assert.ok(close(at0.df, measured.comparison!.df, 1e-9));
    assert.ok(close(at0.mde, measured.mde!, 1e-9), `tier ${tier}: mde ${at0.mde} vs ${measured.mde}`);
  }
});

test("calibration: no false 'tomorrow' while the measured MDE stays above 2×, and the ETA comes true", () => {
  const etas: (string | null)[] = [];
  for (const d of [0, 1]) {
    const day = addDays(TODAY, d);
    const ev = evaluateAgent(noisyTail(d), { ...OPTS, now: new Date(`${day}T12:00:00Z`), resamples: 1000 });
    const t2 = ev.tiers[1]!.metrics.find((m) => m.id === "toolErrors")!;
    // The scenario's premise: tier 2 is measured, not sensitive (and tier 1 neither).
    assert.ok(t2.eligible && t2.mde! > 2, `measured tier-2 MDE ${t2.mde}`);
    const proj = ev.progress.projection!;
    assert.notEqual(proj.etaDays, 1);
    assert.notEqual(proj.etaTier, 2);
    etas.push(proj.etaDate);
  }
  // Tier 3 first counts on 2026-10-18 (70 + 14 = 84 days); with D64(a)'s hold the ETA is the next day, and it holds
  // still as the days pass.
  assert.deepEqual(etas, ["2026-10-19", "2026-10-19"]);
  // Re-evaluated on that day with the data continuing as before, tier 3 is measured sensitive.
  const later = evaluateAgent(noisyTail(14), { ...OPTS, now: new Date("2026-10-18T12:00:00Z"), resamples: 1000 });
  const t3 = later.tiers[2]!.metrics.find((m) => m.id === "toolErrors")!;
  assert.ok(t3.eligible && t3.sensitive, `measured tier-3 MDE ${t3.mde}`);
});

/**
 * Largest-session share in the projected gate (METHOD.md §5). 60 days, three one-day sessions a day of 50 calls at 10%
 * errors (and steady research work), plus one marathon session of G calls at T−5 (10% errors, no edits).
 *  - Tier 1 (14/28): the marathon sits in the recent window for d ≤ 9 and in the baseline for 10 ≤ d ≤ 37;
 *    its share there is G/(G + 28·150) whatever the pace adds (≥ 0.5 for both G below), so tier 1 cannot
 *    pass before d = 38.
 *  - Tier 2 (21/42, reachable from d = 3): recent for d ≤ 16; from d = 17 the baseline is [T−46, T−5], all
 *    past: G/(G + 42·150).
 *  - Tier 3 (28/56, reachable from d = 24): baseline share G/(G + 56·150) until the marathon leaves at d = 80.
 * G = 6,000: tier 2 at d = 17 has share 6,000/12,300 = 0.488 < 0.5 → ETA d = 17, tier 2 (2026-10-21).
 * G = 20,000: tier 2 (0.760) and tier 3 (0.704) stay blocked, so the ETA is tier 1 at d = 38 (2026-11-11).
 * With the marathon repeated in the pace (≈864 calls a day instead of ≈152), tier 1's baseline would dilute it
 * below 0.5 by d = 37 — one day early.
 */
function marathon(calls: number): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 60; k++) {
    const day = addDays(TODAY, -k);
    for (let i = 0; i < 3; i++) xs.push(ex({ session: `s${i}-${day}`, day, toolCalls: 50, toolErrors: 5, edits: 20, reads: 60, blindEdits: i + 1 }));
  }
  xs.push(ex({ session: "marathon", day: addDays(TODAY, -5), toolCalls: calls, toolErrors: calls / 10 }));
  return xs;
}

test("projected gate includes the largest session's share: no ETA while one session holds half the calls", () => {
  const ev = evaluateAgent(marathon(6000), { ...OPTS, now: NOW, resamples: 200 });
  const t1 = ev.tiers[0]!.metrics.find((m) => m.id === "toolErrors")!;
  assert.deepEqual(t1.gate.blocking.map((b) => `${b.id}:${b.window}`), ["sessionShare:recent"]);
  const p = ev.progress;
  // Tier 2 is first projected ready at d = 17 and stays ready (its baseline is all past from then on): D64(a) → d = 18.
  assert.equal(projectEta(progressInput(ev, marathon(6000))).etaDays, 17);
  assert.deepEqual([p.projection!.etaDays, p.projection!.etaTier, p.projection!.etaDate], [18, 2, "2026-10-22"]);
  const te = p.projected.find((m) => m.id === "toolErrors")!;
  assert.deepEqual([te.baseline.topDenominator, te.baseline.denominator], [6000, 12300]);
  assert.ok(close(te.baseline.maxSessionShare, 6000 / 12300) && te.gatePass);
  // The day before, tier 2's recent window still holds the marathon: 6,000 of 6,750 + 16 days at pace.
  const input = progressInput(ev, marathon(6000));
  const before = projectMetric(input, input.metrics.find((m) => m.id === "toolErrors")!, TIERS[1]!, 16);
  assert.equal(before.gatePass, false);
  assert.ok(close(before.recent.maxSessionShare, 6000 / (6750 + 16 * ((84 * 50 + 50) / 28))));
});

test("projected gate with a marathon no tier can absorb: tier 1 at d = 38, after it leaves every window", () => {
  const ev = evaluateAgent(marathon(20000), { ...OPTS, now: NOW, resamples: 200 });
  const p = ev.progress;
  assert.deepEqual([p.projection!.etaDays, p.projection!.etaTier, p.projection!.etaDate], [39, 1, "2026-11-12"]);
  const input = progressInput(ev, marathon(20000));
  assert.equal(projectEta(input).etaDays, 38);
  const te = input.metrics.find((m) => m.id === "toolErrors")!;
  for (const [tier, d] of [[0, 37], [1, 37], [2, 37]] as const) assert.equal(projectMetric(input, te, TIERS[tier]!, d).gatePass, false);
});

function progressInput(ev: AgentEvaluation, xs: MetricExchange[]): ProjectionInput {
  const build = buildCells(xs, { agent: "claude-code", today: TODAY });
  const ids = ["toolErrors", "readsPerEdit", "blindEdits"] as const;
  return {
    todayIdx: T, historyDays: ev.history.days, tiers: TIERS, level: 0.99, schemes: projectionSchemes(D23_LITERAL), families: ["errors", "research"],
    metrics: ids.map((id) => projectionMetric(metricDef(id), build.cells[id], T, ev.history.days, ev.progress.anchors[id] ?? [])),
  };
}

test("not at the current pace: no tier ever gets there → no day count", () => {
  const ev = evaluateAgent(goldenExchanges(), { ...OPTS, now: NOW, resamples: 200 });
  // Uncalibrated, so a hand-set per-cluster variance is taken at face value (an anchor would rescale it).
  const input = goldenInput(ev, false);
  const noisy = input.metrics.map((m) => (m.id === "toolErrors" ? { ...m, c: { "session-day": 50, session: 50 } } : m));
  const r = projectEta({ ...input, metrics: noisy });
  assert.deepEqual([r.etaDays, r.etaTier, r.notAtCurrentPace, r.projectable], [null, null, true, true]);
  // A user who stopped working: pace 0, windows empty out → never.
  const stopped = input.metrics.map((m) => ({ ...m, pace: { sessionDays: 0, newSessions: 0, events: 0, denominator: 0 } }));
  assert.equal(projectEta({ ...input, metrics: stopped }).notAtCurrentPace, true);
  // Nothing estimable at all → not projectable (no claim either way).
  const none = input.metrics.map((m) => ({ ...m, c: { "session-day": null, session: null } }));
  assert.deepEqual([projectEta({ ...input, metrics: none }).projectable, projectEta({ ...input, metrics: none }).notAtCurrentPace], [false, false]);
});

test("progress through evaluateAgent: no data at all → no_data; split variant without fields → metric_unavailable", () => {
  const empty = evaluateAgent([], { ...OPTS, now: NOW });
  assert.deepEqual([empty.progress.reason, empty.progress.etaDate, empty.progress.notAtCurrentPace, empty.selectedTier], ["no_data", null, false, null]);
  const split = evaluateAgent(goldenExchanges(), { ...OPTS, now: NOW, resamples: 100, errorsVote: "toolErrorsNonCmd" });
  assert.equal(split.progress.reason, "metric_unavailable");
  const unlock = split.progress.unlock.find((u) => u.metric === "toolErrorsNonCmd")!;
  assert.deepEqual([unlock.state, unlock.reason], ["ineligible", "fields_missing"]);
  // Friction never appears in progress.
  assert.equal(split.progress.unlock.some((u) => u.family === "friction"), false);
});
