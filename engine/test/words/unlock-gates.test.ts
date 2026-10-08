/**
 * "Next to unlock" counters show the binding gate in its own unit (docs/CONTRACT.md#display-rules). Before this, an
 * indicator with thousands of edits but too few session-days in the recent window went out as
 * `have.events 3,150 / need.events 10` (reads, not edits, against the events floor), and every surface drew
 * "3,150 of 10 edits" with a full bar next to "Not enough yet". One synthetic workload per gate kind, through the real
 * pipeline: the glance's pairs are one quantity each, the binding pair is the unmet one, and the words, the terminal
 * ledger and `bindingGate` all name the same pair. Synthetic data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { attributeAgent } from "../../src/analysis/attribution/index.js";
import type { MetricExchange } from "../../src/analysis/metrics/defs.js";
import { bindingGate, type BindingGate } from "../../src/contract/display.js";
import type { Unlock } from "../../src/contract/glance.js";
import { coerceDoc } from "../../src/output/doc.js";
import { ineligibleText } from "../../src/output/terminal.js";
import { buildOutputs, count, type BuiltOutputs } from "../../src/words/index.js";
import { BASE, TODAY } from "../analysis/attribution-fixtures.js";
import { addDays, ex } from "../analysis/helpers.js";
import { assertValidOutputs } from "./helpers.js";

const AT = `${TODAY}T12:00:00Z`;
const NOW_MS = Date.parse(`${TODAY}T12:30:00Z`);

interface Work { calls?: number; errors?: number; edits?: number; reads?: number; blind?: number }
const BIG: Work = { calls: 600, errors: 20, edits: 300, reads: 450, blind: 80 };

function session(xs: MetricExchange[], id: string, day: string, i: number, w: Work = {}): void {
  const e = w.errors ?? 2 + (i % 2);
  xs.push(ex({
    session: id, day, project: i % 2 ? "p-A" : "p-B", t: `${day}T${String(10 + (i % 10)).padStart(2, "0")}:00:00.000Z`,
    toolCalls: w.calls ?? 50, cmdCalls: 0, toolErrors: e, toolErrorsEdit: e, toolErrorsCmd: 0,
    edits: w.edits ?? 20, reads: w.reads ?? 40, blindEdits: w.blind ?? 2 + (i % 2), steps: 4,
  }));
}

/** `days` days of history; the 28-day baseline has four ordinary sessions a day, `recent(k, day)` fills the last 14. */
function corpus(recent: (xs: MetricExchange[], k: number, day: string) => void, days = 60): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= days; k++) {
    const day = addDays(TODAY, -k);
    if (k <= 14) recent(xs, k, day);
    else for (let i = 0; i < 4; i++) session(xs, `s${i}-${day}`, day, i);
  }
  return xs;
}

function outputs(xs: readonly MetricExchange[]): BuiltOutputs {
  const a = attributeAgent(xs, [], { ...BASE, calibrated: true });
  const out = buildOutputs({ engine: "0.1.0", generatedAt: AT, scanOk: true, agents: [{ attribution: a }] });
  assertValidOutputs(out, "unlock gates");
  return out;
}

const unlockOf = (out: BuiltOutputs, metric: string): Unlock => {
  const u = out.glance.agents[0]!.progress?.unlock.find((x) => x.metric === metric);
  assert.ok(u, `an unlock item for ${metric}`);
  return u;
};

/** The counter as the words print it ("7 of 10 session-days"). */
function counter(g: BindingGate, eventsNoun: string): string {
  const noun = g.unit === "sessions" ? "sessions" : g.unit === "sessionDays" ? "session-days" : eventsNoun;
  return `${count(g.have)} of ${count(g.need)} ${noun}`;
}

/** The terminal ledger's change cell for an indicator (the same rule, from the snapshot). */
function ledger(out: BuiltOutputs, metric: string): string {
  const doc = coerceDoc(JSON.parse(JSON.stringify(out.snapshot)), NOW_MS);
  const a = doc.agents[0]!;
  return ineligibleText(a.metrics.find((m) => m.id === metric)!, a);
}

/** Every unlock item: each events pair is the indicator's one gate quantity (edits of 40 for reads per edit). */
function eventsPairsAreOneQuantity(out: BuiltOutputs): void {
  const snap = out.snapshot.agents[0]!;
  for (const u of out.glance.agents[0]!.progress?.unlock ?? []) {
    const m = snap.metrics.find((x) => x.id === u.metric)!;
    const floor = u.metric === "readsPerEdit";
    assert.equal(u.need.events, floor ? 40 : 10, `${u.metric}: need.events`);
    // the window's own count of that quantity (the recent window here: every case below falls short there)
    assert.equal(u.have.events, floor ? m.recent.n : m.recent.k, `${u.metric}: have.events is ${floor ? "edits" : "its events"}`);
  }
}

test("too few session-days in the recent window, thousands of edits: '7 of 10 session-days', never '3,150 of 10'", () => {
  // The recent window: one big session every other day (7 sessions, 7 session-days, 2,100 edits, 3,150 reads).
  const out = outputs(corpus((xs, k, day) => { if (k % 2 === 0) session(xs, `r-${day}`, day, k, BIG); }));
  eventsPairsAreOneQuantity(out);
  const rpe = unlockOf(out, "readsPerEdit");
  assert.deepEqual([rpe.have, rpe.need], [{ events: 2100, sessions: 7, sessionDays: 7 }, { events: 40, sessions: 5, sessionDays: 10 }]);
  for (const u of out.glance.agents[0]!.progress!.unlock) {
    assert.deepEqual(bindingGate(u), { unit: "sessionDays", have: 7, need: 10 }, u.metric);
  }
  assert.equal(ledger(out, "readsPerEdit"), "7 of 10 session-days needed");
  const line = out.words[0]!.progressLine!;
  assert.match(line, /^Next to unlock: tool errors, 7 of 10 session-days so far; /);
  assert.ok(!/3,150|2,100 of|of 10 edits/.test(JSON.stringify(out.words[0])), "no count of another quantity anywhere in the words");
});

test("too few sessions (three long ones): '3 of 5 sessions'", () => {
  const out = outputs(corpus((xs, k, day) => session(xs, `long-${k % 3}`, day, k, BIG)));
  eventsPairsAreOneQuantity(out);
  const u = unlockOf(out, "readsPerEdit");
  assert.deepEqual(bindingGate(u), { unit: "sessions", have: 3, need: 5 });
  assert.equal(ledger(out, "readsPerEdit"), "3 of 5 sessions needed");
  assert.match(out.words[0]!.progressLine!, /^Next to unlock: tool errors, 3 of 5 sessions so far; /);
});

test("too few edits for reads per edit (its own floor): '28 of 40 edits'; too few blind edits: '0 of 10 edits without reading first'", () => {
  // The recent window: one session a day with 2 edits (28 edits in 14 sessions and session-days) and no blind edits.
  const out = outputs(corpus((xs, k, day) => {
    session(xs, `r-${day}`, day, k, { edits: 2, reads: 6, blind: 0 });
    for (let i = 1; i < 4; i++) session(xs, `o${i}-${day}`, day, i, { edits: 0, reads: 0, blind: 0 });
  }));
  eventsPairsAreOneQuantity(out);
  const rpe = unlockOf(out, "readsPerEdit");
  assert.deepEqual(bindingGate(rpe), { unit: "events", have: 28, need: 40 });
  assert.equal(counter(bindingGate(rpe)!, "edits"), "28 of 40 edits");
  assert.equal(ledger(out, "readsPerEdit"), "28 of 40 edits needed");
  const blind = unlockOf(out, "blindEdits");
  assert.deepEqual(bindingGate(blind), { unit: "events", have: 0, need: 10 });
  assert.equal(ledger(out, "blindEdits"), "0 of 10 edits without reading first needed");
  assert.match(out.words[0]!.progressLine!, /Next to unlock: reads per edit, 28 of 40 edits so far; /);
});

test("one session dominates: an unlock item with no count to show (no pair is short); the ledger says why, the words show no counter", () => {
  const out = outputs(corpus((xs, k, day) => {
    for (let i = 0; i < 4; i++) session(xs, i === 0 ? "marathon" : `s${i}-${day}`, day, i, i === 0 ? BIG : {});
  }));
  eventsPairsAreOneQuantity(out);
  const u = unlockOf(out, "readsPerEdit");
  assert.equal(bindingGate(u), null, "every pair is met; the share is what fails");
  assert.equal(ledger(out, "readsPerEdit"), "one session dominates");
  assert.ok(!/\b\d[\d,]* of \d/.test(out.words[0]!.progressLine!), `no counter: ${out.words[0]!.progressLine}`);
  // No invented count: the share's estimate from the other, small sessions (127 here) is neither in the facts nor in
  // the words, which say what is wrong instead; and the note does not name minimums the user already meets (43
  // sessions and 56 session-days here).
  const f = out.facts[0]!;
  for (const x of f.progress!.unlock) assert.deepEqual([x.metric, x.shortSessions, x.shortSessionDays], [x.metric, null, null]);
  assert.equal(out.words[0]!.progressLine,
    "Next to unlock: tool errors; one session holds most of the recent tool calls, so more sessions are needed. No date yet: it depends on how your sessions go.");
  assert.equal(out.words[0]!.because, "For every indicator, a single session holds most of the recent work; wasitme compares only once it is spread over more sessions.");
  assert.ok(!/needs about|\b\d+ more session/.test(`${out.words[0]!.progressLine} ${out.words[0]!.because}`));
});

test("too few sessions AND one of them dominating: the sessions estimate stays, the share's estimate never counts", () => {
  // The recent window: one marathon session and one small one that recurs every day, so 2 of 5 sessions and the
  // marathon holds most of the calls. The sessions check says 3 more sessions; the share check's own estimate (from the
  // one small session's average) would be far larger and is left out.
  const out = outputs(corpus((xs, k, day) => {
    session(xs, "marathon", day, 0, BIG);
    session(xs, "small", day, 1);
  }));
  const u = out.facts[0]!.progress!.unlock.find((x) => x.metric === "toolErrorsNonCmd")!;
  assert.deepEqual(u.blocking, ["sessions", "sessionShare"]);
  assert.deepEqual([u.shortSessions, u.shortSessionDays], [3, 3], "the sessions check's own estimate");
  const share = out.facts[0]!.metrics.find((m) => m.id === "toolErrorsNonCmd")!.shortfall!.checks.find((c) => c.id === "sessionShare")!;
  assert.ok(share.shortSessions !== null && share.shortSessions > 3, `the share's estimate (${share.shortSessions}) is larger and not used`);
  const line = out.words[0]!.progressLine!;
  assert.match(line, /^Next to unlock: tool errors, 2 of 5 sessions so far; one session holds most of the recent tool calls[.,]/);
  assert.ok(!/needs about|\b\d+ more session/.test(line), line);
});

test("reads per edit with enough edits but under 10 reads: the edits pair is met, so no count of reads is set against edits", () => {
  const out = outputs(corpus((xs, k, day) => {
    for (let i = 0; i < 4; i++) session(xs, `s${i}-${day}`, day, i, { edits: 5, reads: 0, blind: 0 });
  }));
  const u = unlockOf(out, "readsPerEdit");
  assert.deepEqual([u.have.events, u.need.events], [280, 40], "edits of 40, met");
  assert.equal(bindingGate(u), null);
  assert.ok(!/ of \d+ (reads|edits)/.test(out.words[0]!.progressLine ?? ""), String(out.words[0]!.progressLine));
});

test("a history wait has no unlock item (no gate count to show; never '0 of 10 edits'); the words count days of history", () => {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 30; k++) {
    const day = addDays(TODAY, -k);
    for (let i = 0; i < 4; i++) session(xs, `s${i}-${day}`, day, i, BIG);
  }
  const out = outputs(xs);
  assert.equal(out.facts[0]!.history.selection, "no_history");
  assert.deepEqual(out.glance.agents[0]!.progress?.unlock ?? [], []);
  assert.equal(out.words[0]!.progressLine, "Next to unlock: 30 of 42 days of history. No date yet: it depends on how your sessions go.");
});

test("the report's reader drops an unlock item with a missing or invalid gate count instead of reading it as 0", () => {
  const out = outputs(corpus((xs, k, day) => { if (k % 2 === 0) session(xs, `r-${day}`, day, k, BIG); }));
  const raw = JSON.parse(JSON.stringify(out.snapshot));
  const items = raw.agents[0].progress.unlock as { metric: string; have: Record<string, unknown> }[];
  delete items.find((u) => u.metric === "readsPerEdit")!.have.sessions;
  items.find((u) => u.metric === "blindEdits")!.have.sessionDays = "7";
  const a = coerceDoc(raw, NOW_MS).agents[0]!;
  assert.deepEqual(a.progress!.unlock.map((u) => u.metric), ["toolErrorsNonCmd"]);
  assert.equal(ineligibleText(a.metrics.find((m) => m.id === "readsPerEdit")!, a), "needs more session-days", "the reason, not 0 of 5");
});

test("bindingGate: the unit furthest from its target; ties to the earlier unit; missing, negative or met pairs never count", () => {
  const u = (have: Record<string, unknown>, need: Record<string, unknown>) => ({ have, need });
  const N = { events: 40, sessions: 5, sessionDays: 10 };
  assert.deepEqual(bindingGate(u({ events: 31, sessions: 4, sessionDays: 9 }, N)), { unit: "events", have: 31, need: 40 });
  assert.deepEqual(bindingGate(u({ events: 3150, sessions: 7, sessionDays: 7 }, { events: 10, sessions: 5, sessionDays: 10 })), { unit: "sessionDays", have: 7, need: 10 });
  // ties: 4 of 5 and 8 of 10 → sessions (the earlier unit); 0 everywhere → sessions
  assert.deepEqual(bindingGate(u({ events: 40, sessions: 4, sessionDays: 8 }, N)), { unit: "sessions", have: 4, need: 5 });
  assert.deepEqual(bindingGate(u({ events: 0, sessions: 0, sessionDays: 0 }, N)), { unit: "sessions", have: 0, need: 5 });
  // nothing short (only the share fails) → null; a met pair is never shown
  assert.equal(bindingGate(u({ events: 3150, sessions: 43, sessionDays: 56 }, N)), null);
  // a missing or invalid field is not 0 of N
  assert.deepEqual(bindingGate(u({ events: 3150, sessionDays: 7 }, { events: 10, sessions: 5, sessionDays: 10 })), { unit: "sessionDays", have: 7, need: 10 });
  assert.equal(bindingGate(u({ sessions: -1, sessionDays: "3", events: Number.NaN }, N)), null);
  assert.equal(bindingGate(u({ events: 0, sessions: 0, sessionDays: 0 }, { events: 0, sessions: 0, sessionDays: 0 })), null, "a target of 0 is met");
  assert.equal(bindingGate(null), null);
  assert.equal(bindingGate({ have: 3 } as never), null);
});
