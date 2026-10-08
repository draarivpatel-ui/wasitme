import { test } from "node:test";
import assert from "node:assert/strict";
import { D29_CANDIDATES } from "../../src/analysis/gates/d23.js";
import { evaluateAgent, G0_FALLBACK_ERRORS_VOTE, type AgentEvaluation, type EvaluateOptions, type MetricEvaluation } from "../../src/analysis/gates/evaluate.js";
import type { MetricExchange } from "../../src/analysis/metrics/defs.js";
import { studentTQuantile } from "../../src/analysis/stats/distributions.js";
import { addDays, close, ex, shuffled } from "./helpers.js";

const TODAY = "2026-10-04";
const NOW = new Date(`${TODAY}T12:00:00Z`);

/**
 * 90 days, four new one-day sessions a day, one exchange each. In the last 14 days tool errors and blind
 * edits rise and reads per edit fall (all "worse"); before that the patterns repeat exactly.
 */
function workload(change: boolean): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 90; k++) {
    const day = addDays(TODAY, -k);
    const recent = change && k <= 14;
    for (let i = 0; i < 4; i++) {
      const errs = recent ? [4, 8, 6, 10][i]! : [1, 3, 2, 4][i]!;
      const blind = recent ? [4, 6, 5, 7][i]! : [1, 2, 1, 2][i]!;
      const reads = recent ? [28, 32, 29, 31][i]! : [58, 62, 59, 61][i]!;
      xs.push(ex({ session: `s${i}-${day}`, day, toolCalls: 50, toolErrors: errs, edits: 20, blindEdits: blind, reads, steps: 5 + i, promptChars: 100 }));
    }
  }
  return xs;
}

const metric = (ev: AgentEvaluation, tier: number, id: string): MetricEvaluation =>
  ev.tiers.find((t) => t.tier === tier)!.metrics.find((m) => m.id === id)!;

test("a clear rise in errors and research problems: material, worse, sensitive; tier 1 chosen", () => {
  const ev = evaluateAgent(workload(true), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 400 });
  assert.equal(ev.history.days, 90);
  assert.deepEqual([ev.selectedTier, ev.selection, ev.progress.readyToday, ev.progress.ready], [1, "ready", true, false]);
  // D64(a): progress counts as ready once the gate and sensitivity also held on the previous daily evaluation.
  const yesterday = { day: addDays(TODAY, -1), ready: true, tier: null, eta: null, notAtPace: false };
  const held = evaluateAgent(workload(true), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 400, progressHistory: [yesterday] });
  assert.deepEqual(
    [held.progress.reason, held.progress.ready, held.progress.projection, held.progress.record],
    ["ready", true, null, { day: TODAY, ready: true, tier: null, eta: null, notAtPace: false }],
  );
  const te = metric(ev, 1, "toolErrors");
  assert.equal(te.role, "vote");
  assert.deepEqual([te.eligible, te.material, te.direction, te.status, te.sensitive], [true, true, "up", "worse", true]);
  // Hand-computed totals: recent 14 days × (4+8+6+10) = 392 errors of 14 × 200 = 2,800 calls;
  // baseline 28 days × 10 = 280 of 5,600.
  assert.deepEqual([te.recent.events, te.recent.denominator, te.baseline.events, te.baseline.denominator], [392, 2800, 280, 5600]);
  assert.deepEqual([te.recent.sessions, te.recent.sessionDays, te.baseline.sessions, te.baseline.sessionDays], [56, 56, 112, 112]);
  assert.ok(close(te.recent.maxSessionShare, 50 / 2800));
  const c = te.comparison!;
  assert.ok(close(c.logRatio, Math.log((392 + 0.5) / 2800) - Math.log((280 + 0.5) / 5600)));
  // The range is exp(θ ± t_.995(df)·SE) with the kept (larger) SE.
  const q = studentTQuantile(0.995, c.df);
  assert.ok(close(c.range.lo, Math.exp(c.logRatio - q * c.se)) && close(c.range.hi, Math.exp(c.logRatio + q * c.se)));
  assert.ok(c.range.lo > 1);
  assert.equal(c.level, 0.99);
  assert.ok(c.other !== null && c.se >= c.other.se);
  // MDE = exp((t.995 + t.80)·SE·1.1).
  assert.ok(close(te.mde!, Math.exp((q + studentTQuantile(0.8, c.df)) * c.se * 1.1)));
  assert.equal(te.daily.length, 42);
  assert.deepEqual(te.daily[41], { d: "2026-10-03", k: 28, n: 200 });

  const rpe = metric(ev, 1, "readsPerEdit");
  assert.deepEqual([rpe.status, rpe.direction, rpe.material], ["worse", "down", true]);
  assert.deepEqual([rpe.recent.events, rpe.recent.denominator], [14 * 120, 14 * 80]);
  assert.equal(metric(ev, 1, "blindEdits").status, "worse");
  assert.deepEqual(ev.tiers[0]!.familiesReady, { errors: true, research: true });
});

test("friction, language and missing fields are ineligible with named reasons", () => {
  const ev = evaluateAgent(workload(true), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 200 });
  const intr = metric(ev, 1, "interrupts");
  assert.deepEqual([intr.role, intr.eligible, intr.ineligibleReason], ["support", false, "gate"]);
  assert.deepEqual(intr.gate.blocking.map((b) => `${b.id}:${b.window}:${b.have}/${b.need}`), ["events:recent:0/10", "events:baseline:0/10"]);
  // No reader emits `promptEnglish` yet: pushback is off pending that field.
  assert.equal(metric(ev, 1, "pushback").ineligibleReason, "language_unknown");
  assert.equal(ev.englishShare, null);
  assert.equal(metric(ev, 1, "toolErrorsNonCmd").ineligibleReason, "fields_missing");
  assert.equal(metric(ev, 1, "cmdFailures").ineligibleReason, "fields_missing");
  // An English share below 70% switches pushback off; at or above it the gate decides.
  const fr = evaluateAgent(workload(true), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 50, englishShare: 0.69, metrics: ["pushback"] });
  assert.equal(metric(fr, 1, "pushback").ineligibleReason, "not_english");
  const en = evaluateAgent(workload(true), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 50, englishShare: 0.7, metrics: ["pushback"] });
  assert.equal(metric(en, 1, "pushback").ineligibleReason, "gate");
  // Only the requested metrics plus the voting ones are evaluated.
  assert.deepEqual(en.tiers[0]!.metrics.map((m) => m.id), ["toolErrors", "readsPerEdit", "blindEdits", "pushback"]);
});

test("pushback's 70% English rule counts every prompt in each window; unknown language is not English", () => {
  // One prompt in 360 is known to be English: under the old rule (share among known prompts) that was 100%.
  const xs = workload(true);
  xs[0] = { ...xs[0]!, promptEnglish: 1 };
  const one = evaluateAgent(xs, { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 20, metrics: ["pushback"] });
  assert.equal(metric(one, 1, "pushback").ineligibleReason, "not_english");
  assert.ok(close(one.englishShare!, 1 / 360));
  // Every prompt English except in the recent window, where only 9 in 14 days are: that window is off.
  const mostly = workload(true).map((x) => {
    const k = Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${x.day}T00:00:00Z`)) / 86_400_000);
    return { ...x, promptEnglish: (k <= 14 && k > 9 ? 0 : 1) as 0 | 1 };
  });
  const m = metric(evaluateAgent(mostly, { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 20, metrics: ["pushback"] }), 1, "pushback");
  assert.deepEqual([m.ineligibleReason, m.englishShare], ["not_english", { recent: 9 / 14, baseline: 1 }]);
  // All English: the language rule passes and the gate decides (no pushback events in this workload).
  const all = workload(true).map((x) => ({ ...x, promptEnglish: 1 as const }));
  const a = metric(evaluateAgent(all, { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 20, metrics: ["pushback"] }), 1, "pushback");
  assert.deepEqual([a.ineligibleReason, a.englishShare], ["gate", { recent: 1, baseline: 1 }]);
});

test("the time zone and the voting tool-error construct are required, never defaulted", () => {
  const base = { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", metrics: [] } as const;
  const without = (k: "timeZone" | "errorsVote") => {
    const o: Record<string, unknown> = { ...base };
    delete o[k];
    return o as unknown as EvaluateOptions;
  };
  assert.throws(() => evaluateAgent(workload(false), without("timeZone")), /timeZone is required/);
  assert.throws(() => evaluateAgent(workload(false), { ...base, timeZone: "Not/AZone" }), /valid IANA zone/);
  assert.throws(() => evaluateAgent(workload(false), without("errorsVote")), /errorsVote is required/);
  assert.throws(() => evaluateAgent(workload(false), { ...base, errorsVote: "everything" as "toolErrors" }), /errorsVote is required/);
  // A non-numeric resample count would skip every bootstrap draw (a falsely tight range): refused.
  for (const r of [Number.NaN, 1, Number.POSITIVE_INFINITY]) assert.throws(() => evaluateAgent(workload(false), { ...base, resamples: r }), /resamples must be/);
  // D47(d)'s fallback construct is exported for WP-21; with today's readers it has no fields to vote with.
  assert.equal(G0_FALLBACK_ERRORS_VOTE, "toolErrorsNonCmd");
  const fb = evaluateAgent(workload(true), { ...base, errorsVote: G0_FALLBACK_ERRORS_VOTE, resamples: 20, metrics: ["toolErrors"] });
  assert.equal(metric(fb, 1, "toolErrorsNonCmd").role, "vote");
  assert.equal(metric(fb, 1, "toolErrors").role, "context");
  assert.equal(fb.progress.reason, "metric_unavailable");
});

test("automation runs never vote: exec / spawned work is excluded end to end and does not age the history", () => {
  const human = workload(false).map((x) => ({ ...x, agent: "codex" as const, entrypoint: "cli" }));
  const automation: MetricExchange[] = [];
  for (let k = 1; k <= 14; k++) {
    const day = addDays(TODAY, -k);
    automation.push(ex({ agent: "codex", session: `exec-${day}`, day, entrypoint: "exec", toolCalls: 400, toolErrors: 200 }));
    automation.push(ex({ agent: "codex", session: `spawn-${day}`, day, entrypoint: "cli", humanPrompt: 0, toolCalls: 400, toolErrors: 200 }));
  }
  // An automated thread long before the human data must not make the history look older.
  automation.push(ex({ agent: "codex", session: "old-spawn", day: addDays(TODAY, -200), humanPrompt: 0, toolCalls: 5 }));
  const opts = { agent: "codex", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 100, metrics: [] } as const;
  const ref = evaluateAgent(human, opts);
  const mixed = evaluateAgent([...human, ...automation], opts);
  assert.equal(mixed.counts.nonInteractive, 29);
  assert.deepEqual(mixed.history, ref.history);
  assert.deepEqual(mixed.tiers, ref.tiers);
  assert.equal(metric(mixed, 1, "toolErrors").status, "none");
});

test("no change → status none, not material; nothing shifted", () => {
  const ev = evaluateAgent(workload(false), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 300 });
  for (const id of ["toolErrors", "readsPerEdit", "blindEdits"]) {
    const m = metric(ev, 1, id);
    assert.deepEqual([id, m.eligible, m.material, m.status], [id, true, false, "none"]);
  }
});

test("identical output for shuffled and duplicated input (determinism)", () => {
  const xs = workload(true);
  const opts = { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 150 } as const;
  const ref = evaluateAgent(xs, opts);
  const again = evaluateAgent(shuffled(xs, 7), opts);
  assert.deepEqual(again, ref);
  const dup = evaluateAgent([...shuffled(xs, 3), ...xs.slice(0, 10)], opts);
  assert.equal(dup.counts.duplicates, 10);
  assert.deepEqual({ ...dup, counts: { ...dup.counts, input: ref.counts.input, duplicates: 0 } }, ref);
});

test("window edges: today and the future are excluded; the day before tier 1's baseline is in tier 2 only", () => {
  const xs = workload(false);
  const extra = [
    ex({ session: "today", day: TODAY, toolCalls: 1000, toolErrors: 900 }),
    ex({ session: "future", day: "2026-12-01", toolCalls: 1000, toolErrors: 900 }),
    ex({ session: "edge", day: "2026-08-22", toolCalls: 7, toolErrors: 3 }), // tier-1 baseline starts 2026-08-23
  ];
  const ev = evaluateAgent([...xs, ...extra], { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 50, metrics: [] });
  assert.equal(ev.counts.today, 1);
  assert.equal(ev.counts.future, 1);
  const t1 = metric(ev, 1, "toolErrors"), t2 = metric(ev, 2, "toolErrors");
  assert.equal(t1.baseline.denominator, 28 * 200);
  assert.equal(t2.baseline.denominator, 42 * 200 + 7); // 2026-08-22 is inside tier 2 baseline
  assert.deepEqual(ev.tiers[0]!.windows, { recent: { from: "2026-09-20", to: "2026-10-03" }, baseline: { from: "2026-08-23", to: "2026-09-19" } });
});

test("the analysis day follows the supplied zone: 03:00 UTC is still yesterday in Chicago", () => {
  const xs = [ex({ session: "a", day: "2026-10-03", toolCalls: 5 }), ex({ session: "b", day: "2026-10-02", toolCalls: 5 })];
  const chicago = evaluateAgent(xs, { agent: "claude-code", now: new Date("2026-10-04T03:00:00Z"), timeZone: "America/Chicago", errorsVote: "toolErrors", metrics: [] });
  assert.equal(chicago.today, "2026-10-03");
  assert.equal(chicago.counts.today, 1);
  const utc = evaluateAgent(xs, { agent: "claude-code", now: new Date("2026-10-04T03:00:00Z"), timeZone: "UTC", errorsVote: "toolErrors", metrics: [] });
  assert.equal(utc.counts.today, 0);
});

test("history: 41 days → no tier; 42 days → tier 1 available (largest available until ready)", () => {
  const mk = (days: number) => {
    const xs: MetricExchange[] = [];
    for (let k = 1; k <= days; k++) xs.push(ex({ session: `s${k}`, day: addDays(TODAY, -k), toolCalls: 3 }));
    return xs;
  };
  const a = evaluateAgent(mk(41), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", metrics: [] });
  assert.deepEqual([a.history.days, a.selectedTier, a.selection], [41, null, "no_history"]);
  assert.equal(metric(a, 1, "toolErrors").ineligibleReason, "history");
  const b = evaluateAgent(mk(42), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", metrics: [] });
  assert.deepEqual([b.history.days, b.selectedTier, b.selection], [42, 1, "largest_available"]);
  // A store-supplied first day extends history; one after the data's first day changes nothing.
  const c = evaluateAgent(mk(41), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", metrics: [], firstDay: "2026-08-01" });
  assert.equal(c.history.days, 64);
  assert.equal(c.selectedTier, 2);
  assert.equal(evaluateAgent(mk(41), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", metrics: [], firstDay: "2026-09-30" }).history.days, 41);
});

test("one dominant session: exactly half the denominator fails the gate", () => {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 90; k++) {
    const day = addDays(TODAY, -k);
    for (let i = 0; i < 4; i++) xs.push(ex({ session: `s${i}-${day}`, day, toolCalls: 10, toolErrors: 1 }));
  }
  // One marathon session in the recent window with as many calls as everyone else there combined.
  xs.push(ex({ session: "marathon", day: addDays(TODAY, -3), toolCalls: 14 * 40, toolErrors: 30 }));
  const ev = evaluateAgent(xs, { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 50, metrics: [] });
  const te = metric(ev, 1, "toolErrors");
  assert.equal(te.recent.maxSessionShare, 0.5);
  assert.deepEqual([te.eligible, te.ineligibleReason, te.gate.blocking.map((b) => b.id)], [false, "gate", ["sessionShare"]]);
});

test("method candidates run end to end; levels other than 95/99 are refused", () => {
  for (const m of Object.values(D29_CANDIDATES)) {
    const ev = evaluateAgent(workload(true), { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", resamples: 100, method: m, metrics: [] });
    const te = metric(ev, 1, "toolErrors");
    assert.equal(te.comparison!.level, m.level);
    assert.equal(te.status, "worse");
  }
  assert.throws(() => evaluateAgent([], { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: "toolErrors", method: { ...D29_CANDIDATES["d23-literal"]!, level: 0.9 as 0.95 } }));
});
