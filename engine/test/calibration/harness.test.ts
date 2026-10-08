/**
 * WP-23 calibration harness: the fast paths are faithful to the product's own functions, the gate arithmetic is
 * right, and the 50-sequence smoke runs end to end (it is part of npm test). Synthetic data only.
 * The full run (≥ 1,000 sequences per profile) is not part of npm test: see engine/scripts/calibration-run.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessConfounders } from "../../src/analysis/confounders/assess.js";
import { fullStratumKey } from "../../src/analysis/confounders/strata.js";
import { evaluateAgent, type AgentEvaluation, type MetricEvaluation } from "../../src/analysis/gates/evaluate.js";
import { D29_CANDIDATES } from "../../src/analysis/gates/d23.js";
import { buildCells } from "../../src/analysis/metrics/cells.js";
import type { MetricId } from "../../src/analysis/metrics/defs.js";
import { analyticRatio } from "../../src/analysis/stats/analytic.js";
import { bootstrapRatio } from "../../src/analysis/stats/bootstrap.js";
import { studentTQuantile } from "../../src/analysis/stats/distributions.js";
import { dayString } from "../../src/analysis/stats/ratio.js";
import { Rng } from "../../src/analysis/stats/rng.js";
import type { Cluster } from "../../src/analysis/stats/types.js";
import { effectiveDf, WEBB_WEIGHTS, wildRatio, wildTest } from "../../src/analysis/stats/wild.js";
import { prepare } from "../../src/analysis/stats/bootstrap.js";
import {
  aggregateSessionDays, candidateOf, clopperPearson, DailyWork, DaySeries, effectSpec, ERRORS_VOTES, EVALUATED_EXTRA, evaluateDay,
  DECIDERS, fromDecide, generateSequence, Glance, glanceKey, interimDecider, isChangedKey, nullSpec, planDayIndex, PRE_DAYS, PROFILES, runCalibration,
  runSequence, SMOKE_CONFIG, type DecideFnInput, type DeciderInput, type RunConfig, type SequenceCache, type SequenceResult,
} from "../../src/analysis/calibration/index.js";
import type { ConfounderAssessment } from "../../src/analysis/confounders/assess.js";

const VOTING_AND_SPLIT: MetricId[] = ["toolErrors", "toolErrorsNonCmd", "cmdFailures", "readsPerEdit", "blindEdits"];

// ───────────────────────────── synth bridge ─────────────────────────────

test("synth bridge: tool-error split sums to toolErrors, cmdCalls only counts calls that ran, events carry METHOD.md §9 labels", () => {
  for (const p of PROFILES) {
    const seq = generateSequence(nullSpec("t-bridge", p.id, 0));
    assert.ok(seq.exchanges.length > 500, `${p.id}: ${seq.exchanges.length} exchanges`);
    for (const x of seq.exchanges) {
      assert.equal(x.toolErrorsEdit! + x.toolErrorsCmd!, x.toolErrors, `${p.id} split`);
      assert.ok(x.cmdCalls! <= x.toolCalls - x.rejections - x.blocked);
      assert.equal(x.agent, p.agent);
    }
    assert.ok(seq.exchanges.some((x) => x.toolErrorsCmd! > 0) && seq.exchanges.some((x) => x.toolErrorsEdit! > 0), `${p.id}: both kinds of failure occur`);
    for (const e of seq.events) {
      if (e.kind === "version") assert.deepEqual([e.side, e.strength, e.provenance], ["agent", "routine", "log_field"]);
      if (e.kind === "effort") assert.deepEqual([e.side, e.strength, e.provenance], ["you", "strong", "command"]);
      if (e.kind === "model") assert.deepEqual([e.side, e.strength, e.provenance], ["unknown", "weak", "log_field"]);
    }
  }
  const single = generateSequence(nullSpec("t-bridge", "single-project", 1));
  assert.deepEqual([...new Set(single.exchanges.map((x) => x.project))], ["p-0"]);
  const multi = generateSequence(nullSpec("t-bridge", "multi-project", 1));
  assert.equal(new Set(multi.exchanges.map((x) => x.project)).size, 4);
  const codex = generateSequence(nullSpec("t-bridge", "codex", 1));
  assert.ok(codex.exchanges.some((x) => x.entrypoint === "exec"), "Codex exec threads present (excluded from voting)");
});

test("recorded events follow what readers can see: typed changes always, between-session moves left to derivation", () => {
  const ms = generateSequence(nullSpec("t-rec", "many-short", 2));
  const codex = generateSequence(nullSpec("t-rec", "codex", 2));
  const fl = generateSequence(nullSpec("t-rec", "few-long", 2));
  const versions = (s: typeof ms): [number, number] => [s.truth.filter((e) => e.kind === "version").length, s.events.filter((e) => e.kind === "version").length];
  const [msTruth, msRec] = versions(ms), [cxTruth, cxRec] = versions(codex), [flTruth, flRec] = versions(fl);
  assert.ok(msTruth > 20 && msRec < msTruth, `many-short: ${msRec}/${msTruth} bumps visible inside a session`);
  assert.ok(cxTruth > 20 && cxRec === 0, "Codex never records a version change inside a session");
  assert.ok(flRec > flTruth / 2, `few-long: long sessions span most bumps (${flRec}/${flTruth})`);
  for (const s of [ms, codex, fl]) {
    for (const e of s.truth.filter((x) => x.userInitiated && (x.kind === "effort" || x.kind === "model"))) {
      assert.ok(s.events.some((r) => r.id === `ev:${e.id}`), "a typed change is always recorded");
    }
  }
});

test("the WP-21 decider (attributeAgent) runs a sequence end to end through the pipeline form", () => {
  const r = runSequence(nullSpec("t-wp21", "few-long", 0), { candidates: [candidateOf("session-t95-cr2")], decider: DECIDERS["wp21"]! });
  assert.equal(r.tracks.length, 1, "judged under the D47(d) construct only");
  const t = r.tracks[0]!;
  assert.equal(t.errorsVote, "toolErrorsNonCmd");
  assert.equal(Object.values(t.rowDays).reduce((a, b) => a + b, 0), 90);
  assert.ok((t.displayedDays["insufficient:needs_data"] ?? 0) > 0);
  assert.ok((t.diagDays["derivedEvents"] ?? 0) > 0, "between-session label changes are derived");
});

test("session-day aggregation is exact for the work-unit metrics and the confounders' stratum cells", () => {
  for (const id of ["few-long", "many-short", "codex"] as const) {
    const seq = generateSequence(nullSpec("t-agg", id, 0));
    const rows = aggregateSessionDays(seq.exchanges);
    assert.ok(rows.length < seq.exchanges.length);
    const today = dayString(planDayIndex(PRE_DAYS + 70));
    const a = buildCells(seq.exchanges, { agent: seq.agent, today, stratumOf: fullStratumKey });
    const b = buildCells(rows, { agent: seq.agent, today, stratumOf: fullStratumKey });
    const strip = (cs: readonly { session: string; day: string; num: number; den: number }[]) => cs.map((c) => [c.session, c.day, c.num, c.den]);
    for (const m of VOTING_AND_SPLIT) {
      assert.deepEqual(strip(b.cells[m]), strip(a.cells[m]), `${id} ${m} cells`);
      assert.deepEqual(b.strata![m].map((c) => [c.stratum, c.session, c.day, c.num, c.den]), a.strata![m].map((c) => [c.stratum, c.session, c.day, c.num, c.den]), `${id} ${m} strata`);
    }
    assert.equal(b.firstDay, a.firstDay);
  }
});

// ───────────────────────────── day evaluator ─────────────────────────────

test("the day evaluator equals evaluateAgent on the raw exchanges (tiers, selection, history, progress)", () => {
  const methods = [{ ...D29_CANDIDATES["d23-literal"]!, estimator: "analytic" as const }, { ...D29_CANDIDATES["two-level-t95-cr2"]!, estimator: "analytic" as const }];
  for (const id of ["few-long", "many-short", "codex"] as const) {
    const seq = generateSequence(nullSpec("t-faithful", id, 0));
    const series = new DaySeries(seq.agent, aggregateSessionDays(seq.exchanges));
    for (const k of [5, 20, 47, 88]) {
      const todayIdx = planDayIndex(PRE_DAYS + k);
      const day = series.prepare(todayIdx);
      for (const method of methods) {
        const mine = evaluateDay(series, day, method);
        for (const v of ERRORS_VOTES) {
          const ref = evaluateAgent(seq.exchanges, {
            agent: seq.agent, now: new Date(`${day.today}T12:00:00Z`), timeZone: "UTC", errorsVote: v, method, metrics: EVALUATED_EXTRA,
          });
          const got = mine.get(v)!;
          const ctx = `${id} day ${k} ${method.id} ${v}`;
          assert.deepEqual(JSON.parse(JSON.stringify(got.tiers)), JSON.parse(JSON.stringify(ref.tiers)), `${ctx}: tiers`);
          assert.equal(got.selectedTier, ref.selectedTier, ctx);
          assert.equal(got.selection, ref.selection, ctx);
          assert.deepEqual(got.history, ref.history, ctx);
          if (k === 20 || k === 47) assert.deepEqual(JSON.parse(JSON.stringify(got.progress)), JSON.parse(JSON.stringify(ref.progress)), `${ctx}: progress`);
        }
      }
    }
  }
});

test("on a planted regression the confounder assessment from the session-day rows matches the one from the raw exchanges", () => {
  const method = { ...D29_CANDIDATES["session-t95-cr2"]!, estimator: "analytic" as const };
  const seq = generateSequence(effectSpec("t-conf", "multi-project", 0, 2));
  const series = new DaySeries(seq.agent, aggregateSessionDays(seq.exchanges));
  let compared = 0;
  for (const k of [70, 80, 90]) {
    const day = series.prepare(planDayIndex(PRE_DAYS + k));
    const ev = evaluateDay(series, day, method).get("toolErrorsNonCmd")!;
    const ref = evaluateAgent(seq.exchanges, { agent: seq.agent, now: new Date(`${day.today}T12:00:00Z`), timeZone: "UTC", errorsVote: "toolErrorsNonCmd", method, metrics: EVALUATED_EXTRA });
    const a = assessConfounders(day.rows, ev);
    const b = assessConfounders(seq.exchanges, ref);
    assert.deepEqual(a.changed, b.changed);
    assert.deepEqual(a.workload, b.workload);
    assert.deepEqual(JSON.parse(JSON.stringify(a.standardised)), JSON.parse(JSON.stringify(b.standardised)));
    assert.deepEqual(JSON.parse(JSON.stringify(a.projects)), JSON.parse(JSON.stringify(b.projects)));
    assert.deepEqual(JSON.parse(JSON.stringify(a.fragility)), JSON.parse(JSON.stringify(b.fragility)));
    assert.deepEqual(a.singleIndicator, b.singleIndicator);
    if (a.changed.changed) compared++;
  }
  assert.ok(compared >= 1, "the x2 regression is 'changed' on at least one compared day");
});

// ───────────────────────────── estimators ─────────────────────────────

function clusters(rng: Rng, k: number, rate: number, den: number, sd: number, parents = 0): Cluster[] {
  return Array.from({ length: k }, (_, i) => {
    const d = 1 + rng.poisson(den);
    const n = rng.binomial(d, Math.min(0.9, rate * Math.exp(sd * rng.normal())));
    return parents > 0 ? { id: `c${i}`, parent: `p${i % parents}`, num: n, den: d } : { id: `c${i}`, num: n, den: d };
  });
}

test("analytic SE tracks the bootstrap (same point, factor, floor and df rule) on synthetic windows", () => {
  const rng = new Rng("analytic-vs-boot");
  const ratios: number[] = [];
  for (let rep = 0; rep < 12; rep++) {
    const twoLevel = rep % 3 === 2;
    const r = clusters(rng, 25 + rep, 0.06, 30, 0.4, twoLevel ? 8 : 0);
    const b = clusters(rng, 45 + rep, 0.05, 30, 0.4, twoLevel ? 12 : 0);
    for (const smallSample of ["count", "cr2"] as const) {
      const opts = { resamples: 4000, twoLevel, smallSample, floor: "binomial" as const, seed: `s${rep}` };
      const boot = bootstrapRatio(r, b, opts), an = analyticRatio(r, b, opts);
      assert.equal(an.logRatio, boot.logRatio);
      assert.ok(an.ok && boot.ok);
      ratios.push(Math.abs(Math.log(an.se / boot.se)));
      if (smallSample === "count") assert.ok(Math.abs(an.df - boot.df) / boot.df < 0.25, `df ${an.df} vs ${boot.df}`);
    }
  }
  ratios.sort((a, b) => a - b);
  assert.ok(ratios[ratios.length >> 1]! < 0.05, `median |ln SE ratio| ${ratios[ratios.length >> 1]}`);
  // A window with one cluster fails the same way.
  assert.equal(analyticRatio([{ id: "a", num: 1, den: 10 }], [{ id: "b", num: 1, den: 10 }, { id: "c", num: 2, den: 10 }]).ok, false);
});

test("wild cluster bootstrap: Webb weights, df inversion, determinism and size under the null", () => {
  const mean = WEBB_WEIGHTS.reduce((a, b) => a + b, 0) / 6;
  const varW = WEBB_WEIGHTS.reduce((a, b) => a + b * b, 0) / 6;
  assert.ok(Math.abs(mean) < 1e-12 && Math.abs(varW - 1) < 1e-12);
  for (const df of [2, 4.5, 11, 60]) {
    for (const alpha of [0.01, 0.05]) {
      const back = effectiveDf(studentTQuantile(1 - alpha / 2, df), alpha);
      assert.ok(Math.abs(back - df) / df < 0.01, `df ${df} → ${back}`);
    }
  }
  const rng = new Rng("wild-null");
  let rejected = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    const r = clusters(rng, 20, 0.08, 25, 0.5), b = clusters(rng, 30, 0.08, 25, 0.5);
    const t = wildTest(prepare(r), prepare(b), { level: 0.95, resamples: 199, floor: "binomial" })!;
    if (Math.abs(t.t) > t.crit) rejected++;
    if (i === 0) assert.deepEqual(wildTest(prepare(r), prepare(b), { level: 0.95, resamples: 199, floor: "binomial" }), t, "deterministic");
  }
  assert.ok(rejected / N > 0.01 && rejected / N < 0.1, `null rejection ${rejected}/${N}`);
  const w = wildRatio(clusters(rng, 20, 0.15, 20, 0.3), clusters(rng, 20, 0.05, 20, 0.3), { level: 0.99, floor: "binomial" });
  assert.ok(w.ok && w.df > 0 && w.t99.lo > 1, "a 3x shift is detected");
});

// ───────────────────────────── decider, persistence, gates ─────────────────────────────

function mev(id: MetricId, family: "errors" | "research", over: Partial<MetricEvaluation>): MetricEvaluation {
  return {
    id, family, role: "vote", worse: id === "readsPerEdit" ? "down" : "up", scale: 1, unit: "", point: 0.01,
    recent: { events: 50, denominator: 1000, sessions: 9, sessionDays: 20, maxSessionShare: 0.2, topSessionDays: 3, rate: 0.05, missing: 0, clamped: 0 },
    baseline: { events: 90, denominator: 2000, sessions: 15, sessionDays: 40, maxSessionShare: 0.2, topSessionDays: 3, rate: 0.045, missing: 0, clamped: 0 },
    gate: { pass: true, checks: [], blocking: [] }, eligible: true, ineligibleReason: null,
    comparison: { scheme: "session", twoLevel: false, logRatio: 0.1, ratio: 1.1, se: 0.1, df: 20, level: 0.99, range: { lo: 0.85, hi: 1.4 }, pValue: 0.3, other: null, resamples: 2000, seed: "x" },
    mde: 1.6, mdeDown: 0.62, call: null, material: false, direction: null, sensitive: true, status: "none", daily: [], englishShare: null,
    ...over,
  } as MetricEvaluation;
}

function input(metrics: MetricEvaluation[], conf: Partial<ConfounderAssessment> = {}, calibrated = true): DeciderInput {
  const evaluation = { selectedTier: 1, tiers: [{ tier: 1, metrics }], method: { level: 0.99 } } as unknown as AgentEvaluation;
  const c = { fragility: { days: { applicable: true, drops: [], fragile: false } }, workload: { unclear: false, reasons: [], metrics: [] }, ...conf } as unknown as ConfounderAssessment;
  return { evaluation, confounders: () => c, events: [], calibrated, previous: null, today: "2026-06-01", now: "2026-06-01T12:00:00.000Z" };
}

const worse = (x: MetricEvaluation) => ({ ...x, material: true, direction: x.worse, status: "worse" as const, comparison: { ...x.comparison!, pValue: 1e-6, range: x.worse === "up" ? { lo: 1.4, hi: 2.5 } : { lo: 0.4, hi: 0.7 } } });

test("interim decider: decision-table rows 1-5 and 12-14", () => {
  const te = mev("toolErrorsNonCmd", "errors", {}), rpe = mev("readsPerEdit", "research", {}), be = mev("blindEdits", "research", {});
  const d = (i: DeciderInput) => interimDecider.decide(i);
  assert.equal(d(input([te, rpe, be], {}, false)).row, 1);
  assert.equal(d(input([{ ...te, eligible: false }, rpe, be])).row, 2);
  assert.equal(d({ ...input([te, rpe, be]), evaluation: { selectedTier: null, tiers: [], method: { level: 0.99 } } as unknown as AgentEvaluation }).row, 2);
  const better = { ...rpe, material: true, direction: "up" as const, status: "better" as const };
  assert.deepEqual([d(input([worse(te), better, be])).state, d(input([worse(te), better, be])).reason], ["unclear", "mixed"]);
  const changed = [worse(te), worse(rpe), be];
  assert.deepEqual(d(input(changed)), { state: "changed_unattributed", reason: null, row: 5, changed: true });
  assert.deepEqual(d(input(changed, { workload: { unclear: true, reasons: ["standardised_lost"], metrics: [] } })).row, 4);
  const fragile = d(input(changed, { fragility: { days: { applicable: true, drops: [], fragile: true } } } as unknown as Partial<ConfounderAssessment>));
  assert.deepEqual([fragile.row, fragile.changed, fragile.fragile], [14, false, true]);
  const single = d(input([worse(te), rpe, be]));
  assert.deepEqual([single.state, single.reason, single.metric], ["insufficient", "single_indicator", "toolErrorsNonCmd"]);
  assert.equal(d(input([te, rpe, be])).state, "none");
  assert.equal(d(input([te, { ...rpe, sensitive: false }, { ...be, sensitive: false }])).row, 14, "research not sensitive → not none");
  assert.equal(d(input([te, rpe, { ...be, comparison: { ...be.comparison!, df: 3 } }])).row, 14, "low_df blocks none (D53d)");
  assert.equal(glanceKey({ state: "insufficient", reason: "single_indicator" }), "insufficient:single_indicator");
  assert.ok(isChangedKey("changed_unattributed") && isChangedKey("unclear:workload") && isChangedKey("agent") && !isChangedKey("unclear:mixed") && !isChangedKey("none"));
});

test("fromDecide: a WP-21-style pure decide drops in (confounders as a value, its own previous output back, its state is the glance)", () => {
  const seen: DecideFnInput[] = [];
  // A toy persisting decide: it shows "none" only once it has said so on two consecutive days.
  const toy = (i: DecideFnInput) => {
    seen.push(i);
    const prev = i.previous as { want: string; state: string } | null;
    const want = i.evaluation.selectedTier === null ? "insufficient" : "none";
    const state = prev !== null && prev.want === want ? want : prev?.state ?? "insufficient";
    return { state, reason: state === "insufficient" ? "needs_data" : null, pending: state !== want, want, trace: { tier: i.evaluation.selectedTier } };
  };
  const d = fromDecide("toy", toy);
  assert.equal(d.persists, true);
  const r = runSequence(nullSpec("t-adapter", "many-short", 0), { candidates: [candidateOf("d23-literal")], decider: d, errorsVotes: ["toolErrorsNonCmd"] });
  const t = r.tracks[0]!;
  assert.equal(seen.length, 90);
  assert.equal(seen[0]!.previous, null);
  assert.deepEqual((seen[1]!.previous as { want: string }).want, "insufficient");
  assert.ok(seen.every((i) => typeof i.confounders === "object" && i.now === `${i.today}T12:00:00.000Z` && i.today === i.evaluation.today));
  assert.ok((t.displayedDays["none"] ?? 0) > 0 && t.pendingDays >= 1, JSON.stringify(t.displayedDays));
  assert.equal(t.everChanged, false);
  assert.deepEqual(t.rowDays, { "n/a": 90 });
});

test("persistence: two agreeing evaluations ≥ 1 day apart with ≥ 30% new denominator and ≥ 2 new session-days", () => {
  // Days 100…: 10 calls and one session-day per day.
  const cells = Array.from({ length: 60 }, (_, i) => ({ session: `s${i}`, day: dayString(100 + i), num: 0, den: 10, exchanges: 1, missing: 0, clamped: 0 }));
  const work = new DailyWork(cells, (d) => Math.round(Date.parse(d) / 86_400_000));
  const g = new Glance();
  const obs = (key: string, t: number) => ({ key, todayIdx: t, recentFrom: t - 14, recentDen: 140 });
  assert.equal(g.step(obs("none", 140), work), "insufficient:needs_data");
  assert.equal(g.pendingKey, "none");
  // 1 day later: 10 new calls < 30% of 140 → still pending.
  assert.equal(g.step(obs("none", 141), work), "insufficient:needs_data");
  // A disagreeing evaluation resets the pending change.
  assert.equal(g.step(obs("changed_unattributed", 142), work), "insufficient:needs_data");
  assert.equal(g.pendingKey, "changed_unattributed");
  assert.equal(g.step(obs("none", 143), work), "insufficient:needs_data");
  // 143 → 148: 50 new calls ≥ 42 and 5 session-days → confirmed.
  assert.equal(g.step(obs("none", 147), work), "insufficient:needs_data");
  assert.equal(g.step(obs("none", 148), work), "none");
  // Leaving uses the same rule; an evaluation equal to the displayed state clears the pending one.
  g.step(obs("unclear:mixed", 149), work);
  assert.equal(g.step(obs("none", 150), work), "none");
  assert.equal(g.pendingKey, null);
});

test("Clopper–Pearson bounds", () => {
  const [lo0, hi0] = clopperPearson(0, 1000);
  assert.equal(lo0, 0);
  assert.ok(Math.abs(hi0 - (1 - 0.025 ** (1 / 1000))) < 1e-9);
  const [loN, hiN] = clopperPearson(50, 50);
  assert.equal(hiN, 1);
  assert.ok(Math.abs(loN - 0.025 ** (1 / 50)) < 1e-9);
  const [lo, hi] = clopperPearson(40, 1000);
  assert.ok(lo > 0.028 && lo < 0.029 && hi > 0.054 && hi < 0.055, `${lo} ${hi}`);
});

// ───────────────────────────── smoke ─────────────────────────────

test("a replayed sequence is deterministic", () => {
  const opts = { candidates: [candidateOf("d23-literal")] };
  const strip = (r: ReturnType<typeof runSequence>) => ({ ...r, ms: 0 });
  assert.deepEqual(strip(runSequence(nullSpec("t-det", "few-long", 3), opts)), strip(runSequence(nullSpec("t-det", "few-long", 3), opts)));
});

test("50-sequence smoke: every phase runs, every profile is exercised, nothing is flagged calibrated on so few sequences", async () => {
  const a = await runCalibration(SMOKE_CONFIG);
  assert.ok(a.runtime.sequences >= 45, `sequences ${a.runtime.sequences}`);
  assert.equal(a.synthetic, true);
  for (const p of PROFILES) {
    const rows = a.gNullSeq.filter((r) => r.profile === p.id && r.errorsVote === "toolErrorsNonCmd");
    assert.ok(rows.length >= 1, p.id);
    for (const r of rows) {
      assert.ok(r.errorsEligibleDayShare > 0 && r.researchEligibleDayShare > 0, `${p.id}: the voting families are eligible on some days`);
      assert.ok(r.agentExercised === false && r.passFalseAgent === null, "false agent is not exercised by the interim decider");
    }
  }
  const fl = a.gNullSeq.find((r) => r.profile === "few-long" && r.candidate === "d23-literal" && r.errorsVote === "toolErrorsNonCmd")!;
  for (const t of ["1", "2", "3"]) assert.ok((fl.tierDayShare[t] ?? 0) > 0, `few-long reaches tier ${t}`);
  assert.ok(a.gNullSeq.some((r) => r.extensionDayShare > 0), "the extension rule is exercised");
  assert.ok(a.power.length > 0 && a.selection.probed !== null);
  assert.ok((a.seCheck.rows as unknown[]).length > 0);
  assert.ok(Array.isArray((a.gAttr as { scenarios: unknown[] }).scenarios));
  for (const agent of ["claude-code", "codex"]) assert.equal(a.calibrated[agent]!.calibrated, false, `${agent}: never calibrated from a smoke`);
  const json = JSON.stringify(a);
  assert.ok(!/\/Users\/|syn-user|@/.test(json), "aggregates only: no path or address-like text in the artifact");
});

test("budgeted runs: the cache replays finished sequences exactly, and a deadline stops new jobs and marks the artifact partial", async () => {
  const tiny: RunConfig = {
    ...SMOKE_CONFIG, runSeed: "t-cache", candidates: ["session-t95-cr2"], profiles: ["many-short", "codex"],
    nullPilot: 2, nullFull: 2, effectPilot: 1, effectFull: 1, sensitivityNull: 0, attrPerScenario: 0, mdeSequences: 0, etaSequences: 0, seSequences: 0,
  };
  const entries = new Map<string, SequenceResult>();
  const cache: SequenceCache = { get: (k) => entries.get(k), put: (k, r) => void entries.set(k, structuredClone(r)) };
  const first = await runCalibration({ ...tiny, cache });
  assert.equal(entries.size, 2 * (2 + 1), "every finished sequence is cached (2 profiles × (2 null + 1 effect))");
  let computed = 0;
  const second = await runCalibration({ ...tiny, cache: { get: cache.get, put: () => void computed++ } });
  assert.equal(computed, 0, "nothing recomputed");
  assert.equal(second.runtime.sequencesFromCache, 6);
  assert.deepEqual(second.gNullSeq, first.gNullSeq);
  assert.deepEqual(second.effectRows, first.effectRows);
  // A deadline already passed: no job starts, every later phase is skipped, nothing is calibrated.
  const stopped = await runCalibration({ ...tiny, deadlineSeconds: 1e-9 });
  assert.match(stopped.status, /^partial: /);
  assert.equal(stopped.runtime.sequences, 0);
  assert.ok(stopped.runtime.phases.some((p) => /skipped: deadline/.test(p.phase)));
  for (const agent of ["claude-code", "codex"]) assert.equal(stopped.calibrated[agent]!.calibrated, false);
});
