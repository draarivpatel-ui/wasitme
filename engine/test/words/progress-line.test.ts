/**
 * D64(b) in the words: the "Next to unlock" line always carries the progress counter and carries a date only when the
 * engine shows one; otherwise it says there is no date yet because it depends on how sessions go. Every variant passes
 * every copy lint. Facts from the real pipeline on synthetic workloads, with the progress varied by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { attributeAgent } from "../../src/analysis/attribution/index.js";
import { lintCopy } from "../../src/contract/check.js";
import { factsOf, NO_DATE_YET, wordsFor, type Facts, type MetricFact, type ProgressFacts } from "../../src/words/index.js";
import { BASE, scenario } from "../analysis/attribution-fixtures.js";
import { lintEverything } from "./helpers.js";

const early = (): Facts => factsOf(attributeAgent(scenario({ days: 30 }), [], { ...BASE, calibrated: true }));

function lineOf(f: Facts): string {
  const w = wordsFor(f);
  assert.deepEqual(lintEverything(w), [], "every copy lint");
  assert.deepEqual(lintCopy(w.progressLine ?? ""), []);
  assert.ok(!/\bsoon\b|\bwill (unlock|be ready|compare)\b|\bpromise/i.test(w.progressLine ?? ""), "no promises");
  return w.progressLine!;
}

const withProgress = (f: Facts, p: Partial<ProgressFacts>): Facts => ({ ...f, progress: { ...f.progress!, ...p } });

test("history wait: the counter is days of history; the date only when shown", () => {
  const f = early();
  assert.deepEqual([f.state, f.tier, f.history.days, f.progress!.reason], ["insufficient", null, 30, "no_date"]);
  assert.equal(lineOf(f), `Next to unlock: 30 of 42 days of history. ${NO_DATE_YET}`);
  assert.equal(
    lineOf(withProgress(f, { reason: "eta", etaDate: "2026-10-16" })),
    "Next to unlock: 30 of 42 days of history; at your pace, wasitme can compare from about Oct 16.",
  );
});

test("gate shortfall: the most binding count ('31 of 40 edits'), the session units, then the date or no date", () => {
  const base = early();
  const rpe = base.metrics.find((m) => m.id === "readsPerEdit")!;
  const shortfall: MetricFact["shortfall"] = {
    window: "recent",
    checks: [
      { id: "sessions", have: 4, need: 5, shortSessions: 1, shortSessionDays: null },
      { id: "sessionDays", have: 9, need: 10, shortSessions: null, shortSessionDays: 1 },
      { id: "denominator", have: 31, need: 40, shortSessions: 1, shortSessionDays: 1 },
    ],
  };
  const f: Facts = {
    ...base, tier: 1, history: { days: 50, selection: "largest_available" },
    metrics: base.metrics.map((m) => (m.id === "readsPerEdit" ? { ...rpe, eligible: false, shortfall } : m)),
    progress: {
      ...base.progress!, tier: 1, reason: "no_date", etaDate: null, readyToday: false,
      unlock: [{
        metric: "readsPerEdit", family: "research", state: "ineligible", fieldsMissing: false,
        have: { events: 31, sessions: 4, sessionDays: 9 }, need: { events: 40, sessions: 5, sessionDays: 10 },
        shortSessions: 1, shortSessionDays: 1, blocking: ["sessions", "sessionDays", "denominator"],
      }],
    },
  };
  assert.equal(lineOf(f), `Next to unlock: reads per edit, 31 of 40 edits so far; needs about 1 more session and 1 more session-day. ${NO_DATE_YET}`);
  assert.equal(
    lineOf(withProgress(f, { reason: "eta", etaDate: "2026-10-10" })),
    "Next to unlock: reads per edit, 31 of 40 edits so far; needs about 1 more session and 1 more session-day; at your pace, about Oct 10.",
  );
  // Sessions binding (4 of 5 < 38 of 40): the counter follows the tightest check.
  const sessions = {
    ...shortfall, checks: [shortfall.checks[0]!, { ...shortfall.checks[2]!, have: 38 }],
  };
  const g: Facts = { ...f, metrics: f.metrics.map((m) => (m.id === "readsPerEdit" ? { ...m, shortfall: sessions } : m)) };
  assert.match(lineOf(g), /^Next to unlock: reads per edit, 4 of 5 sessions so far; /);
  // Only the largest-session share fails: no count to show; the words say one session dominates, in the indicator's
  // denominator (the share is of edits here), and never a number of sessions.
  const share = { window: "recent" as const, checks: [{ id: "sessionShare", have: 0.6, need: 0.5, shortSessions: 127, shortSessionDays: 127 }] };
  const h: Facts = withProgress({ ...f, metrics: f.metrics.map((m) => (m.id === "readsPerEdit" ? { ...m, shortfall: share } : m)) }, {
    unlock: [{ ...f.progress!.unlock[0]!, shortSessions: null, shortSessionDays: null, blocking: ["sessionShare"] }],
  });
  assert.equal(lineOf(h), `Next to unlock: reads per edit; one session holds most of the recent edits, so more sessions are needed. ${NO_DATE_YET}`);
});

test("one session dominates: no count of sessions, 'most' only over half, the window named, and the longest name still says why", () => {
  const base = early();
  const at = (id: string, checks: NonNullable<MetricFact["shortfall"]>["checks"], window: "recent" | "baseline" = "recent"): Facts => ({
    ...base, tier: 1, history: { days: 50, selection: "largest_available" },
    metrics: base.metrics.map((m) => (m.id === id ? { ...m, eligible: false, shortfall: { window, checks } } : m)),
    progress: {
      ...base.progress!, tier: 1, reason: "no_date", etaDate: null, readyToday: false,
      unlock: [{
        metric: id, family: "research", state: "ineligible", fieldsMissing: false,
        have: { events: 300, sessions: 43, sessionDays: 56 }, need: { events: 10, sessions: 5, sessionDays: 10 },
        shortSessions: null, shortSessionDays: null, blocking: checks.map((c) => c.id),
      }],
    },
  });
  const share = (have: number) => ({ id: "sessionShare", have, need: 0.5, shortSessions: 169, shortSessionDays: 169 });
  // Exactly half fails the gate (it must be strictly below), and is half, not most; the earlier window is named so.
  assert.equal(lineOf(at("blindEdits", [share(0.5)], "baseline")),
    `Next to unlock: edits without reading first; one session holds half of the earlier edits. ${NO_DATE_YET}`);
  // The longest indicator name: the full sentence is over 160, so the line drops the tail, never the reason.
  const longest = lineOf(at("blindEdits", [share(0.83)]));
  assert.equal(longest, `Next to unlock: edits without reading first; one session holds most of the recent edits. ${NO_DATE_YET}`);
  // With a session count short too, the counter stays (a real count) and the reason still has no estimate of sessions.
  const both = lineOf(at("blindEdits", [{ id: "sessions", have: 3, need: 5, shortSessions: 2, shortSessionDays: 2 }, share(0.9)]));
  assert.match(both, /^Next to unlock: edits without reading first, 3 of 5 sessions so far; one session dominates\. /);
  for (const line of [longest, both]) assert.ok(!/needs about|\b169\b|\b127\b/.test(line), line);
});

test("the note when every indicator waits only on one session's share: per indicator, the window named, unreadable ones left out", () => {
  const base = early();
  const share = (have: number, window: "recent" | "baseline" = "recent"): MetricFact["shortfall"] =>
    ({ window, checks: [{ id: "sessionShare", have, need: 0.5, shortSessions: 127, shortSessionDays: 127 }] });
  const all = (f: (id: string) => Partial<MetricFact>): Facts => ({
    ...base, tier: 1, history: { days: 50, selection: "largest_available" },
    metrics: base.metrics.map((m) => (m.role === "vote" ? { ...m, eligible: false, fieldsMissing: false, ...f(m.id) } : m)),
  });
  const note = (f: Facts) => {
    const w = wordsFor(f);
    assert.deepEqual(lintEverything(w), []);
    return w.because;
  };
  assert.equal(note(all(() => ({ shortfall: share(0.8) }))),
    "For every indicator, a single session holds most of the recent work; wasitme compares only once it is spread over more sessions.");
  // exactly half in one of them, and the windows differ: neither "most" nor one window is claimed
  assert.equal(note(all((id) => ({ shortfall: id === "readsPerEdit" ? share(0.5, "baseline") : share(0.9) }))),
    "For every indicator, a single session holds half or more of one window's work; wasitme compares only once it is spread over more sessions.");
  // an indicator this version can't read is not one of "every indicator"
  assert.equal(note(all((id) => (id === "blindEdits" ? { fieldsMissing: true, shortfall: null } : { shortfall: share(0.8, "baseline") }))),
    "For every indicator wasitme can read, a single session holds most of the earlier work; wasitme compares only once it is spread over more sessions.");
  // anything else short as well: the minimums, as before
  assert.match(note(all((id) => ({ shortfall: id === "readsPerEdit" ? { window: "recent", checks: [{ id: "sessions", have: 3, need: 5, shortSessions: 2, shortSessionDays: 2 }] } : share(0.8) }))),
    /^Each indicator needs at least 5 sessions and 10 session-days in each window\.$/);
});

test("the counter picks from the contract's three pairs by the surfaces' rule: ties to the earlier unit, never reads against edits", () => {
  const base = early();
  const rpe = base.metrics.find((m) => m.id === "readsPerEdit")!;
  const withChecks = (checks: NonNullable<MetricFact["shortfall"]>["checks"], blocking: string[]): Facts => ({
    ...base, tier: 1, history: { days: 50, selection: "largest_available" },
    metrics: base.metrics.map((m) => (m.id === "readsPerEdit" ? { ...rpe, eligible: false, shortfall: { window: "recent", checks } } : m)),
    progress: {
      ...base.progress!, tier: 1, reason: "no_date", etaDate: null, readyToday: false,
      unlock: [{
        metric: "readsPerEdit", family: "research", state: "ineligible", fieldsMissing: false,
        have: { events: 32, sessions: 4, sessionDays: 12 }, need: { events: 40, sessions: 5, sessionDays: 10 },
        shortSessions: 1, shortSessionDays: 1, blocking,
      }],
    },
  });
  // 32 of 40 edits and 4 of 5 sessions tie (0.8), listed edits first: the counter is sessions, as on every surface.
  const tie = withChecks([
    { id: "denominator", have: 32, need: 40, shortSessions: 1, shortSessionDays: 1 },
    { id: "sessions", have: 4, need: 5, shortSessions: 1, shortSessionDays: 1 },
  ], ["denominator", "sessions"]);
  assert.match(lineOf(tie), /^Next to unlock: reads per edit, 4 of 5 sessions so far; /);
  // Reads per edit's events pair is its edits (of 40): a reads shortfall (3 of 10 reads) is not a pair the surfaces
  // carry, so the line names no count rather than one the surfaces cannot show.
  const reads = withChecks([{ id: "events", have: 3, need: 10, shortSessions: null, shortSessionDays: null }], ["events"]);
  assert.ok(!/\bof \d+ (reads|edits)\b/.test(lineOf(reads)), lineOf(reads));
});

test("ready today but not yet on the previous day (D64(a)): the counter is the hold itself", () => {
  const f = withProgress({ ...early(), tier: 1, history: { days: 50, selection: "ready" } }, { readyToday: true, reason: "no_date", etaDate: null });
  assert.equal(lineOf(f), `Next to unlock: enough data on 1 of 2 days in a row. ${NO_DATE_YET}`);
  assert.equal(lineOf(withProgress(f, { reason: "eta", etaDate: "2026-10-05" })), "Next to unlock: enough data on 1 of 2 days in a row; at your pace, about Oct 5.");
});

test("the no-date sentence is plain and lint-clean", () => {
  assert.equal(NO_DATE_YET, "No date yet: it depends on how your sessions go.");
  assert.deepEqual(lintCopy(NO_DATE_YET), []);
});
