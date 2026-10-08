/**
 * D58 speed-up: the WP-21 decider (attributeAgent) on LABEL ROWS (calibration/synth.ts `aggregateLabelRows`, weighted
 * label derivation) gives the same decisions, the same derived label events and the same evidence as on the raw
 * exchanges. Synthetic data only.
 *
 * Coverage: every profile (Codex included: its sessions keep their start version, so a bump day's majority must be
 * counted in exchanges, not rows) × null, planted-regression and attribution scenarios (a typed effort change, a
 * picker model change with no command, both sides on one day, a routine bump plus a far you-event), on evaluation days
 * spread over the run and around the planted onset; plus whole 90-day replays through the harness (persistence
 * included) and a hand-built Codex bump day where rows and exchanges disagree unless weighted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeAgent, labelChangeEvents, majorityChanges } from "../../src/analysis/attribution/index.js";
import type { AttributionEvent } from "../../src/analysis/attribution/types.js";
import { dayString } from "../../src/analysis/stats/ratio.js";
import {
  aggregateLabelRows, ATTR_SCENARIOS, attrSpec, candidateOf, DECIDERS, effectSpec, EVALUATED_EXTRA, generateSequence, nullSpec,
  planDayIndex, PRE_DAYS, PROFILES, runSequence, type SequenceSpec,
} from "../../src/analysis/calibration/index.js";
import { rowWeight } from "../../src/analysis/calibration/wp21.js";
import type { Exchange } from "../../src/types.js";

const METHOD = candidateOf("session-t95-cr2").method;
const json = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown;

/** Everything the decision reads, minus the exchange-count fields aggregates cannot reproduce (see aggregateLabelRows). */
function comparable(a: ReturnType<typeof attributeAgent>) {
  const { counts: _c, englishShare: _e, ...evaluation } = a.evaluation;
  const { mix: _m, ...confounders } = a.confounders;
  return json({ decision: a.decision, events: a.events, evidence: a.evidence, evaluation, confounders });
}

function specsFor(profile: (typeof PROFILES)[number]["id"]): SequenceSpec[] {
  const pick = (id: string) => ATTR_SCENARIOS.find((s) => s.id === id)!;
  return [
    nullSpec("t-rows", profile, 0),
    effectSpec("t-rows", profile, 0, 2),
    attrSpec("t-rows", profile, 0, pick("you-effect")),
    attrSpec("t-rows", profile, 0, pick("desktop-picker-effect")),
    attrSpec("t-rows", profile, 0, pick("both-same-day")),
    attrSpec("t-rows", profile, 0, pick("you-event-far-from-onset")),
  ];
}

const DAYS = [3, 12, 25, 40, 47, 50, 55, 62, 75, 90];

test("label rows: decisions, derived events, evidence and evaluation equal the raw exchanges' (every profile, null + planted + attribution scenarios)", () => {
  let derived = 0, changed = 0, compared = 0;
  const rowsShare: number[] = [];
  for (const p of PROFILES) {
    for (const spec of specsFor(p.id)) {
      const seq = generateSequence(spec);
      const rows = aggregateLabelRows(seq.exchanges);
      rowsShare.push(rows.length / seq.exchanges.length);
      assert.equal(rows.reduce((s, r) => s + r.n, 0), seq.exchanges.length, "every exchange is in exactly one row");
      for (const k of DAYS) {
        const today = dayString(planDayIndex(PRE_DAYS + k));
        const events = seq.events.filter((e) => e.day < today);
        const opts = {
          agent: seq.agent, now: new Date(`${today}T12:00:00.000Z`), timeZone: "UTC", errorsVote: "toolErrorsNonCmd" as const, method: METHOD,
          metrics: EVALUATED_EXTRA, calibrated: true,
          // As the WP-21 decider runs it: days since install fully observed, so the version-boundary rows are reachable.
          fullyObservedDays: Array.from({ length: Math.max(0, k) }, (_, i) => dayString(planDayIndex(PRE_DAYS + i))),
        };
        const raw = attributeAgent(seq.exchanges.filter((x) => x.day < today), events, opts);
        const agg = attributeAgent(rows.filter((x) => x.day < today), events, { ...opts, exchangeWeight: rowWeight });
        const ctx = `${spec.seed} day ${k}`;
        assert.deepEqual(comparable(agg), comparable(raw), ctx);
        compared++;
        derived += raw.events.filter((e) => (e as AttributionEvent).derived === true).length;
        if (raw.evidence.changed) changed++;
      }
    }
  }
  // The comparison is not vacuous: label changes are derived and "changed" evaluations (onset, rule-out, boundary) occur.
  assert.ok(derived > 100, `derived events compared: ${derived}`);
  assert.ok(changed > 5, `changed evaluations compared: ${changed} of ${compared}`);
  assert.ok(Math.max(...rowsShare) < 0.6, `rows are an aggregate (largest rows/exchanges ${Math.max(...rowsShare).toFixed(2)})`);
});

test("label rows: whole 90-day replays through the harness (persistence, D56 diagnostics) are identical", () => {
  const specs: SequenceSpec[] = [
    effectSpec("t-rows-replay", "codex", 1, 2),
    effectSpec("t-rows-replay", "many-short", 1, 2),
    attrSpec("t-rows-replay", "few-long", 1, ATTR_SCENARIOS.find((s) => s.id === "desktop-picker-effect")!),
  ];
  for (const spec of specs) {
    const opts = { candidates: [candidateOf("session-t95-cr2")] };
    const fast = runSequence(spec, { ...opts, decider: DECIDERS["wp21"]! });
    const ref = runSequence(spec, { ...opts, decider: DECIDERS["wp21-raw"]! });
    assert.deepEqual(json(fast.tracks), json(ref.tracks), spec.seed);
    assert.ok((ref.tracks[0]!.diagDays["derivedEvents"] ?? 0) > 0, `${spec.seed}: derived events exercised`);
  }
});

test("Codex bump day: an old session's many exchanges outvote two new sessions' few — rows agree only when weighted", () => {
  const base = (over: Partial<Exchange> & { id: string; session: string; day: string; version: string; t: string }): Exchange => ({
    v: 1, agent: "codex", project: "p", model: "gpt", servedModel: "gpt", effort: "high", mode: "auto", entrypoint: "cli", seq: 1,
    afterCompaction: false, promptChars: 10, humanPrompt: 1, interrupted: 0, pushback: 0, queuedMidTurn: 0, steps: 1, toolCalls: 1,
    toolErrors: 0, rejections: 0, blocked: 0, reads: 0, edits: 0, blindEdits: 0, churned: 0, outTok: 1, inTok: 1, cacheRead: 0,
    cacheWrite: 0, apiErrors: 0, apiRetries: 0, compactions: 0, thinkBlocks: 0, thinkRedacted: 0, thinkSigMedian: 0, subToolCalls: 0,
    subTokens: 0, durationMs: 1, ...over,
  } as Exchange);
  const xs: Exchange[] = [];
  // Day 1: everything on 1.0. Day 2 (bump day): the old session keeps 1.0 for 5 exchanges; two new sessions open on 1.1
  // with 2 exchanges each. By exchanges 1.0 still leads (5 vs 4); by rows 1.1 leads (2 rows vs 1).
  for (let i = 0; i < 3; i++) xs.push(base({ id: `a${i}`, session: "old", day: "2026-09-01", version: "1.0", t: `2026-09-01T10:0${i}:00Z`, seq: i }));
  for (let i = 0; i < 5; i++) xs.push(base({ id: `b${i}`, session: "old", day: "2026-09-02", version: "1.0", t: `2026-09-02T10:0${i}:00Z`, seq: 10 + i }));
  for (const s of ["new1", "new2"]) for (let i = 0; i < 2; i++) xs.push(base({ id: `${s}${i}`, session: s, day: "2026-09-02", version: "1.1", t: `2026-09-02T11:0${i}:00Z`, seq: i }));
  // Day 3: the new version only (the change lands here by exchange count).
  for (let i = 0; i < 2; i++) xs.push(base({ id: `c${i}`, session: "new1", day: "2026-09-03", version: "1.1", t: `2026-09-03T09:0${i}:00Z`, seq: 5 + i }));
  const rows = aggregateLabelRows(xs);
  assert.equal(rows.length, 5);
  const byExchange = majorityChanges(xs, "version");
  assert.deepEqual(byExchange.map((c) => [c.day, c.from, c.to]), [["2026-09-03", "1.0", "1.1"]]);
  assert.deepEqual(majorityChanges(rows, "version").map((c) => c.day), ["2026-09-02"], "unweighted rows move the change a day early");
  assert.deepEqual(majorityChanges(rows, "version", rowWeight), byExchange, "weighted rows give the exchange-count majority, t included");
  assert.deepEqual(labelChangeEvents("codex", rows, [], rowWeight), labelChangeEvents("codex", xs, []));
  assert.throws(() => majorityChanges(rows, "version", () => 0), /positive finite/);
});
