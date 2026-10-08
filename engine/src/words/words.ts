/**
 * The engine's words (METHOD.md §1, DESIGN.md §3, D57, D59): every engine-owned string of glance.v1 / snapshot.v1 for
 * one agent, plus the lines the CLI, report and Control Center lay out for BOTH lead variants (D28).
 *
 *   wordsFor(facts, opts) → AgentWords        pure; facts from `factsOf(attribution)` or built by hand
 *   explain(attribution, opts)                = wordsFor(factsOf(attribution))
 *
 * Hero roles (the Finding page, the popover, the CLI's first lines read title → deck → note; none repeats another):
 *   title    = the state, from tokens ("Too early to tell.", "The agent changed."); never in `headline`/`because`.
 *   headline = the deck: the one-sentence finding (≤ 80), with no state words.
 *   because  = the note: the evidence — the numbers, the window, what was ruled out or is still missing (≤ 200). It
 *              never restates the deck.
 *
 * Templates by decision-table row (state · reason → headline / because; `fit` drops detail, never cuts a label):
 *   1  insufficient · calibration_pending   "Findings for {Codex} are off until wasitme's tests pass for {Codex} logs."
 *                                           / "Here's what changed on each side in the meantime."
 *   2,14 insufficient · needs_data           "wasitme can already rule out changes bigger than about ×{2.5} in {tool
 *                                           errors}." / "Only {E} have enough data so far; {I} need (a few) more
 *                                           sessions." (no history: "The shortest comparison puts your last 14 days
 *                                           against the 28 before them.") Row 14 with a moved
 *                                           indicator: "{An indicator | Your numbers} moved, but not clearly enough to
 *                                           count as a change yet." / "{Tool errors (×2.4) rose}, but {the failed check}."
 *   3  unclear · mixed                      "Your numbers moved, but in different directions." / "{Tool errors ×2.6}
 *                                           against {reads per edit ×1.2}: the moves point opposite ways."
 *   4  unclear · workload                   "Your numbers moved, but your work changed too." / "{Reason}. Overall: {tool
 *                                           errors ×2.6, edits without reading first ×1.9}."
 *   5  unclear · unknown_provenance         "Your numbers moved, but the logs don't say who changed {the model}." /
 *                                           "{The model} went from {a} to {b} ({Sep 22}) with no command and no settings
 *                                           change recorded, so the change could be yours or {Claude Code}'s."
 *   6  unclear · both_sides                 "Your numbers moved, but changes on both sides landed the same week." /
 *                                           "{Your effort change} ({Sep 21}) and {Claude Code's model switch} ({Sep 23})
 *                                           both line up with the shift: {tool errors ×2.6, edits without reading first ×1.9}."
 *   7  you                                  "Your numbers moved around the time of {your effort change from high to
 *                                           medium} ({Sep 21})." / "{Tool errors (×2.7) and edits without reading first (×1.8) rose};
 *                                           {the Claude Code 2.1.274 update (Sep 24)} in the same window is routine, and
 *                                           updates alone aren't evidence." (or "nothing recorded changed on {Claude
 *                                           Code}'s side in the same window")
 *   8  agent                                "Nothing recorded changed on your side; {Claude Code served another model}."
 *                                           / "Around the time {Claude Code began serving a different model than you
 *                                           picked} ({Sep 30}), your {tool errors (×2.6) and edits without reading first (×1.9)} rose."
 *   9  agent · by_elimination               "Nothing recorded changed on your side; {tool errors} rose at the {2.1.281}
 *                                           update." / "The shift shows in {2} projects from {Oct 1}, and every day
 *                                           around the update was fully observed: {tool errors ×2.6, …}."
 *  10  unclear · nothing_recorded_on_your_side  "Your numbers moved, but updates alone aren't evidence." / "Nothing
 *                                           recorded changed on your side; {the Claude Code 2.1.277 update} landed in the
 *                                           same window{, but the shift doesn't show in enough of your projects}."
 *  11  unclear · blind_spot                 "Your numbers moved, but before wasitme was watching your setup." / "None of
 *                                           the {7} days in the onset window ({Sep 21–Sep 27}) were fully observed, so
 *                                           changes on your side then can't be ruled out."
 *  12  insufficient · single_indicator     "One indicator moved ({tool errors} ×{2.3}); a second kind has to agree." /
 *                                           "The move in {tool errors} holds up with all the indicators checked together;
 *                                           {reads per edit and edits without reading first} show no detectable change."
 *  13  none                                 "Changes bigger than about ×{1.9} in {3} indicators would have shown." /
 *                                           "wasitme compared {tool errors, reads per edit and edits without reading first} over your
 *                                           last {14 days} against the {28} before."
 * The lead variant (D28) changes the order of the body, never these strings (the contract goldens hold the same
 * words for `{state}-timeline` and `{state}-verdict`).
 *
 * Glance strings (`label`, `statusLine`) carry only the state and "+n" (DESIGN.md §3). "Possible shift — confirming"
 * is `pendingLine`, never a contract string (METHOD.md §12: the glance holds its state; the golden `pending.json` keeps
 * the held state's words).
 */
import type { Attribution } from "../analysis/attribution/pipeline.js";
import { DISCLAIMER } from "../contract/check.js";
import { TIERS } from "../analysis/metrics/windows.js";
import type { Lead } from "../contract/vocab.js";
import { factsOf, gateEventsCheck, traceCondition, type CandidateFact, type EventFact, type Facts, type FactsOptions, type MetricFact } from "./facts.js";
import { addDays, cap, count, day, daysBetween, fit, list, mde as mdeText, noun, plural, range as rangeText, rate, ratio as ratioText, ratio2 } from "./format.js";
import {
  agentName, agentPhrases, countNoun, eventLabel, heldNoun, metricWords, prose, undoPhrase, unknownNoun, youPhrase,
} from "./names.js";
import { CALIBRATION_PENDING_WORDS, STATE_WORDS } from "./tokens.js";
import { traceWords, workloadText, type TraceStepWords } from "./trace.js";

export const LIMITS = { label: 24, headline: 80, because: 200, tryThis: 160, confidence: 160, band: 100, statusLine: 80, eventLabel: 60, metricLabel: 40, metricUnit: 24, note: 160, trace: 200 } as const;

export const KEEP_WORKING = "Keep working normally; wasitme checks every 15 minutes.";
export const ISSUE_LINE = "If you file an issue, share the report — it says what it can and can't show.";
export const PENDING_LINE = "Possible shift — confirming";
export const UNSEEN = "Sessions on other machines aren't visible.";
export const PARTIAL = "Some days weren't fully observed.";

export interface MetricText {
  id: string;
  label: string;
  unit: string;
  /** Name inside a sentence. */
  name: string;
  /** Ledger status: "Moved, more" / "Moved, fewer" / "No detectable change" / "Not enough yet" / "Context only". */
  status: string;
  /** Popover form ("Not detected" for "No detectable change"). */
  statusShort: string;
  /** Friction and context indicators are always tagged "context" (D30). */
  context: boolean;
  /** May be drawn in non-neutral ink (D53e: family-wise significant); every other row stays neutral. */
  familywise: boolean;
  /** "Tool errors 3.2 → 7.1 per 100 tool calls · ×2.20 (range ×1.40–×3.50) · N 5,528 | 3,326 · Moved, more" */
  line: string;
}

export interface AgentWords {
  agent: string;
  // glance / snapshot agent strings
  label: string;
  headline: string;
  because: string;
  tryThis: string;
  confidence: string;
  band: string;
  statusLine: string;
  // snapshot-only strings
  disclaimer: string | null;
  observationNote: string;
  trace: TraceStepWords[];
  /** Timeline label per event id. */
  eventLabels: Record<string, string>;
  metrics: MetricText[];
  // lines for the surfaces that lay the words out (CLI, report, Control Center); not contract fields
  /** The state's headline from tokens ("Too early to tell.", "Timeline only, for now."). */
  title: string;
  pendingLine: string | null;
  progressLine: string | null;
  /** The strip's window line: "×0.75, range ×0.40 to ×1.41; changes under ×2.5 wouldn't show". */
  stripLine: string | null;
  candidateLines: { event: string; text: string }[];
  timelineLine: string;
  /** The glance events (newest first, ≤ 5), one line each. */
  eventLines: string[];
  /** New changes since `knownEventIds` (the "+n"). */
  newChanges: number;
  /** Body lines in order, per lead variant (D28). */
  body: Record<Lead, string[]>;
}

export interface WordsOptions {
  /** Event ids already shown (the previous snapshot's timeline). null/absent: nothing is marked new. */
  knownEventIds?: readonly string[] | null;
}

// ───────────────────────────── selection helpers (shared with build.ts) ─────────────────────────────

const orderOf = (f: Facts, id: string) => {
  const i = f.metrics.findIndex((m) => m.id === id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};
const byOrder = (f: Facts, ids: readonly string[]) => [...ids].sort((a, b) => orderOf(f, a) - orderOf(f, b));
const metric = (f: Facts, id: string | undefined) => (id === undefined ? undefined : f.metrics.find((m) => m.id === id));

/** The metric the strip and the first metric row show. */
export function leadMetric(f: Facts): string | null {
  if (f.single !== null && metric(f, f.single.metric)) return f.single.metric;
  if (f.counted.length > 0) return byOrder(f, f.counted)[0]!;
  if (f.mixed !== null) {
    const ids = byOrder(f, [...f.mixed.worse, ...f.mixed.better]);
    if (ids.length > 0) return ids[0]!;
  }
  if (metric(f, f.errorsVote)) return f.errorsVote;
  return f.metrics.find((m) => m.role === "vote")?.id ?? null;
}

/** The glance's top metrics (≤ 3): the lead, then the other voting metrics in display order. Timeline only → none. */
export function topMetricIds(f: Facts): string[] {
  if (!f.calibrated) return [];
  const lead = leadMetric(f);
  const votes = f.metrics.filter((m) => m.role === "vote").map((m) => m.id);
  const ids = lead === null ? votes : [lead, ...votes.filter((id) => id !== lead)];
  return ids.slice(0, 3);
}

/** Events a glance shows (no wasitme writes, no prompt hashes), newest first. */
export function glanceEventFacts(f: Facts): EventFact[] {
  return f.events
    .filter((e) => e.side !== "meta" && e.kind !== "system-prompt")
    .sort((a, b) => (a.day !== b.day ? (a.day < b.day ? 1 : -1) : a.t !== b.t ? (a.t < b.t ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ───────────────────────────── phrase helpers ─────────────────────────────

const verbOf = (m: MetricFact | undefined) => (m?.direction === "up" ? "rose" : m?.direction === "down" ? "fell" : "moved");

/** "tool errors and edits without reading first rose" / "tool errors rose and reads per edit fell". */
function metricsVerb(f: Facts, ids: readonly string[]): string {
  const groups: { verb: string; names: string[] }[] = [];
  for (const id of byOrder(f, ids)) {
    const verb = verbOf(metric(f, id));
    const g = groups.find((x) => x.verb === verb);
    if (g) g.names.push(metricWords(id).name);
    else groups.push({ verb, names: [metricWords(id).name] });
  }
  return list(groups.map((g) => `${list(g.names)} ${g.verb}`));
}

/** "tool errors ×2.7, edits without reading first ×1.8". */
function ratioList(f: Facts, ids: readonly string[], joiner = ", "): string {
  return byOrder(f, ids).map((id) => {
    const m = metric(f, id);
    return m?.ratio != null ? `${metricWords(id).name} ${ratioText(m.ratio)}` : metricWords(id).name;
  }).join(joiner);
}

/** "tool errors (×2.7) and edits without reading first (×1.8) rose" / "tool errors (×2.7) rose and reads per edit (×0.53) fell". */
function movedText(f: Facts, ids: readonly string[]): string {
  const groups: { verb: string; names: string[] }[] = [];
  for (const id of byOrder(f, ids)) {
    const m = metric(f, id);
    const verb = verbOf(m);
    const name = m?.ratio != null ? `${metricWords(id).name} (${ratioText(m.ratio)})` : metricWords(id).name;
    const g = groups.find((x) => x.verb === verb);
    if (g) g.names.push(name);
    else groups.push({ verb, names: [name] });
  }
  return list(groups.map((g) => `${list(g.names)} ${g.verb}`));
}

const dated = (f: Facts, c: { day: string | null } | undefined) => (c?.day ? ` (${day(c.day, f.today)})` : "");

/** " (Sep 21–Sep 27)", the onset window as the trace prints it, or "". */
const onsetDates = (f: Facts) => (f.onset === null ? "" : ` (${day(f.onset.from, f.today)}–${day(f.onset.to, f.today)})`);

/** Why the version-boundary test failed (row 10), as a clause; null when the trace doesn't say. */
const BOUNDARY_CLAUSE: Readonly<Record<string, string>> = {
  no_boundary: "no single update lines up with the start of the shift",
  several_boundaries: "more than one update landed in it",
  shift_not_shown: "the weeks either side of the update don't show the shift by themselves",
  projects: "the shift doesn't show in enough of your projects",
  not_observed: "the days around the update weren't fully observed",
};

/** The open you·strong candidate nearest the onset peak (ties: the earlier). */
function primaryYou(f: Facts): CandidateFact | undefined {
  const open = f.candidates.filter((c) => c.class === "you_strong" && c.status === "open");
  if (open.length <= 1 || f.peak === null) return open[0];
  const dist = (c: CandidateFact) => (c.day === null ? Number.MAX_SAFE_INTEGER : Math.abs(daysBetween(f.peak!, c.day) ?? Number.MAX_SAFE_INTEGER));
  return [...open].sort((a, b) => dist(a) - dist(b) || ((a.day ?? "") < (b.day ?? "") ? -1 : 1))[0];
}

function sameWindow(f: Facts): string {
  if (f.onset === null) return "around the same time";
  const width = (daysBetween(f.onset.from, f.onset.to) ?? 99) + 1;
  return width <= 7 ? "the same week" : "around the same time";
}

/** "Nothing recorded changed on your side", or the ruled-out variant (row 8–10 leads). */
function sideLead(f: Facts): string {
  const ruled = f.candidates.filter((c) => c.class === "you_strong" && c.status === "ruled_out");
  if (ruled.length === 0) return "Nothing recorded changed on your side";
  if (ruled.length === 1) return `${cap(youPhrase(ruled[0]!, f.agent, false))} was ruled out`;
  return "Your recorded changes were ruled out";
}

// ───────────────────────────── the deck: headline, because, try-this, band ─────────────────────────────

interface Deck { headline: string; because: string; tryThis: string; band: string }

function insufficientDeck(f: Facts): Deck {
  const votes = f.metrics.filter((m) => m.role === "vote");
  const eligible = votes.filter((m) => m.eligible);
  const waiting = votes.filter((m) => !m.eligible && !m.fieldsMissing);
  const missing = votes.filter((m) => !m.eligible && m.fieldsMissing);
  const withMde = eligible.filter((m) => m.mde !== null).sort((a, b) => a.mde! - b.mde! || orderOf(f, a.id) - orderOf(f, b.id));
  const moved = f.row === 14 && (f.fragileDays || f.materialVoting.length > 0);

  const shortest = TIERS[0]!.historyDays;
  const noHistory = f.tier === null && f.history.selection === "no_history";
  let headline: string;
  if (moved) headline = `${f.materialVoting.length > 1 ? "Your numbers" : "An indicator"} moved, but not clearly enough to count as a change yet.`;
  else if (noHistory) headline = `wasitme needs ${plural(Math.max(1, shortest - f.history.days), "more day", "more days")} of history before it can compare.`;
  else if (withMde.length > 0) {
    const best = withMde[0]!;
    headline = fit(LIMITS.headline,
      `wasitme can already rule out changes bigger than about ${mdeText(best.mde!)} in ${metricWords(best.id).name}.`,
      `wasitme can already rule out changes bigger than about ${mdeText(best.mde!)}.`);
  } else headline = "wasitme needs more sessions before it can compare anything.";

  // The note says why it is too early (the title already says that it is): what moved and the check it failed, or
  // what each indicator still lacks.
  const material = f.pending ? [] : byOrder(f, f.materialVoting);
  const what = material.length > 0 ? cap(movedText(f, material)) : null;
  let because: string;
  if (f.fragileDays) {
    because = fit(LIMITS.because, ...variants(
      what !== null && `${what}, but the shift disappears when any one of its three most influential days is left out.`,
      "The shift disappears when any one of its three most influential days is left out."));
  } else if (moved) {
    const byKind: Readonly<Record<string, [string, string]>> = {
      fails_holm: [", but the move doesn't stand out once all the indicators are checked together.", "The move doesn't stand out once all the indicators are checked together."],
      several_not_changed: [", but only one kind of indicator moved; a second kind has to agree before it counts.", "Only one kind of indicator moved; a second kind has to agree before it counts."],
      low_df: [", but too few independent days back the move to count it yet.", "Too few independent days back the move to count it yet."],
    };
    const [tail, alone] = byKind[f.holmKind ?? ""] ?? [", but the move doesn't pass wasitme's checks yet.", "The move doesn't pass wasitme's checks yet."];
    because = fit(LIMITS.because, ...variants(what !== null && `${what}${tail}`, alone));
  } else if (noHistory) {
    const t = TIERS[0]!;
    // The progress line already counts the days ("30 of 42 days of history"): the note says what they are for.
    because = `The shortest comparison puts your last ${t.recentDays} days against the ${t.baselineDays} before them.`;
  } else if (eligible.length === 0 && waiting.length === 0 && missing.length > 0) {
    because = fit(LIMITS.because, `This version can't read ${list(missing.map((m) => metricWords(m.id).name))} from your logs yet.`, "This version can't read some indicators from your logs yet.");
  } else if (eligible.length === 0 && waiting.length > 0 && waiting.every(dominatedOnly)) {
    // Enough sessions and session-days, but in each indicator one session holds half or more of a window's work: the
    // minimums are met, so saying them would point at the wrong thing. Indicators (and windows) can be dominated by
    // different sessions, so the words never say it is the same one.
    const windows = new Set(waiting.map((m) => m.shortfall!.window));
    const where = windows.size > 1 ? "of one window's" : windows.has("recent") ? "of the recent" : "of the earlier";
    const most = waiting.every((m) => m.shortfall!.checks.every((c) => c.have > 0.5)) ? "most" : "half or more";
    const which = missing.length > 0 ? "every indicator wasitme can read" : "every indicator";
    because = `For ${which}, a single session holds ${most} ${where} work; wasitme compares only once it is spread over more sessions.`;
  } else if (eligible.length === 0) {
    because = `Each indicator needs at least ${plural(f.gate.minSessions, "session")} and ${plural(f.gate.minSessionDays, "session-day")} in each window.`;
  } else if (waiting.length > 0) {
    // The share check's estimate is no count of sessions anyone can act on (see `dominatedWords`): it never makes "a few".
    const shorts = waiting.flatMap((m) => m.shortfall?.checks.map((c) => (c.id === "sessionShare" ? null : c.shortSessions) ?? Number.MAX_SAFE_INTEGER) ?? []);
    const few = shorts.length > 0 && Math.max(...shorts) <= 3;
    because = fit(LIMITS.because,
      `Only ${list(eligible.map((m) => metricWords(m.id).name))} have enough data so far; ${list(waiting.map((m) => metricWords(m.id).name))} need ${few ? "a few more sessions" : "more sessions"}.`,
      "Some indicators need more sessions.");
  } else {
    const dull = eligible.filter((m) => !m.sensitive);
    because = dull.length > 0
      ? fit(LIMITS.because, `Every indicator has enough data, but ${list(dull.map((m) => metricWords(m.id).name))} can't rule out a doubling yet.`, "Some indicators can't rule out a doubling yet.")
      : "wasitme needs more data before it can say more.";
  }
  return { headline, because, tryThis: KEEP_WORKING, band: "" };
}

/** The candidates that are strings (a `false` entry is a variant that does not apply). */
const variants = (...xs: (string | false)[]): string[] => xs.filter((x): x is string => x !== false);

function deckFor(f: Facts): Deck {
  const A = agentName(f.agent);
  // While a new outcome is pending, the decision on show is the HELD one, but the evaluation's numbers are the new
  // ones: prose that pairs the held story with today's ratios could contradict itself, so it names no numbers.
  const numbers = !f.pending;
  const counted = numbers ? byOrder(f, f.counted) : [];
  const hasCounted = counted.length > 0;
  switch (f.row) {
    case 1:
      return {
        headline: fit(LIMITS.headline, `Findings for ${A} are off until wasitme's tests pass for ${A} logs.`, `Findings for ${A} are off until wasitme's tests pass.`, "Findings are off until wasitme's tests pass for these logs."),
        because: "Here's what changed on each side in the meantime.",
        tryThis: "",
        band: "",
      };
    case 3: {
      const worse = f.mixed?.worse ?? [], better = f.mixed?.better ?? [];
      return {
        headline: "Your numbers moved, but in different directions.",
        because: fit(LIMITS.because, ...variants(
          numbers && worse.length > 0 && better.length > 0 && `${cap(ratioList(f, worse, " and "))} against ${ratioList(f, better, " and ")}: the moves point opposite ways.`,
          worse.length > 0 && better.length > 0 && `${cap(list(byOrder(f, worse).map((id) => metricWords(id).name)))} against ${list(byOrder(f, better).map((id) => metricWords(id).name))}: the moves point opposite ways.`,
          "The indicators that moved point opposite ways.")),
        tryThis: "", band: "",
      };
    }
    case 4: {
      const why = `${cap(workloadText(f.workload[0]))}.`;
      return {
        headline: "Your numbers moved, but your work changed too.",
        because: fit(LIMITS.because, ...variants(hasCounted && `${why} Overall: ${ratioList(f, counted)}.`, why, "Your projects and setup moved too much to compare.")),
        tryThis: "", band: "",
      };
    }
    case 5: {
      const unknown = f.candidates.filter((c) => c.class === "unknown");
      const nouns = [...new Set(unknown.map((c) => unknownNoun(c.kind, f.agent)))];
      const what = nouns.length <= 2 ? list(nouns.length > 0 ? nouns : ["a setting"]) : `${nouns[0]} and ${nouns.length - 1} other settings`;
      const one = unknown.length === 1 ? unknown[0]! : null;
      const when = one !== null ? dated(f, one) : "";
      const from = one !== null ? prose(one.from) : null, to = one !== null ? prose(one.to) : null;
      const moved = from !== null && to !== null ? `${cap(what)} went from ${from} to ${to}${when}` : `${cap(what)} changed${when}`;
      const tail = " with no command and no settings change recorded";
      return {
        headline: fit(LIMITS.headline, `Your numbers moved, but the logs don't say who changed ${what}.`, "Your numbers moved, but the logs don't say who made a change."),
        because: fit(LIMITS.because,
          `${moved}${tail}, so the change could be yours or ${A}'s.`,
          `${cap(what)} changed${tail}, so the change could be yours or ${A}'s.`,
          `A setting changed${tail}, so the change could be on either side.`),
        tryThis: "", band: "",
      };
    }
    case 6: {
      const you = primaryYou(f);
      const ag = f.candidates.find((c) => c.class === "agent_strong");
      const ap = agentPhrases(ag?.tripwire ?? null, f.agent);
      const yp = you ? youPhrase(you, f.agent, false) : "your change";
      const same = sameWindow(f);
      const r = f.recheck;
      const undo = `Undo ${yp} to separate them`;
      const tryThis = r === null ? `${undo}.`
        : r.kind === "eta" ? `${undo}; at your pace that takes about ${plural(Math.max(1, Math.ceil(r.days / 7)), "week")}.`
        : `${undo}; at your pace wasitme can't confirm a change this size.`;
      const both = `${cap(yp)}${dated(f, you)} and ${ap.possessive}${dated(f, ag)} both line up with the shift`;
      return {
        headline: fit(LIMITS.headline, `Your numbers moved, but changes on both sides landed ${same}.`, "Your numbers moved, but changes on both sides landed together."),
        because: fit(LIMITS.because, ...variants(
          hasCounted && `${both}: ${ratioList(f, counted)}.`,
          `${both}.`,
          `${cap(yp)} and ${ap.possessive} both line up with the shift.`,
          `A change on your side and one on ${A}'s side both line up with the shift.`,
          "A change on each side lines up with the shift.")),
        tryThis: fit(LIMITS.tryThis, tryThis, `${undo}.`, "Undo your change to separate them."),
        band: "",
      };
    }
    case 7: {
      const you = primaryYou(f);
      const others = f.candidates.filter((c) => c.class === "you_strong" && c.status === "open").length - 1;
      const more = others > 0 ? ` and ${others} other ${noun(others, "change")} of yours` : "";
      const long = you ? `${youPhrase(you, f.agent, true)}${more}` : "a change on your side";
      const short = you ? youPhrase(you, f.agent, false) : "a change on your side";
      const when = dated(f, you);
      const moved = ratioList(f, counted);
      const r = f.recheck;
      const undo = you ? undoPhrase(you, f.agent) : "undo your change";
      const tryThis = r === null ? `To check, ${undo}.`
        : r.kind === "eta" ? `To check, ${undo}; at your pace a re-check needs about ${plural(r.sessions, "session")} (${day(r.date, f.today)}).`
        : `To check, ${undo}; at your pace wasitme can't confirm a change this size.`;
      // The note: what moved, and what the agent's side had in the same window (only routine updates, or nothing).
      const routine = f.candidates.filter((c) => c.class === "agent_routine");
      const v = routine.length === 1 ? prose(routine[0]!.to) : null;
      const theirs = routine.length === 0 ? `nothing recorded changed on ${A}'s side in the same window`
        : routine.length === 1 ? `the ${A}${v !== null ? ` ${v}` : ""} update${dated(f, routine[0])} in the same window is routine, and updates alone aren't evidence`
        : `the ${plural(routine.length, `${A} update`)} in the same window are routine, and updates alone aren't evidence`;
      const theirsShort = routine.length === 0 ? `nothing recorded changed on ${A}'s side then` : "updates alone aren't evidence";
      return {
        headline: fit(LIMITS.headline,
          `Your numbers moved around the time of ${long}${when}.`,
          `Your numbers moved around the time of ${short}${when}.`,
          `Your numbers moved around the time of a change on your side${when}.`,
          "Your numbers moved around the time of a change on your side."),
        because: fit(LIMITS.because, ...variants(
          hasCounted && `${cap(movedText(f, counted))}; ${theirs}.`,
          hasCounted && `${cap(moved)}; ${theirsShort}.`,
          `${cap(theirs)}.`,
          `${cap(theirsShort)}.`)),
        tryThis: fit(LIMITS.tryThis, tryThis, `To check, ${undo}.`, "To check, undo your change."),
        band: fit(LIMITS.band, `Your side: your numbers moved around ${short}${when}.`, "Your side: your numbers moved around a change on your side."),
      };
    }
    case 8: {
      const ag = f.candidates.find((c) => c.class === "agent_strong");
      const ap = agentPhrases(ag?.tripwire ?? null, f.agent);
      const lead = sideLead(f);
      const when = dated(f, ag);
      const first = counted.slice(0, 1);
      // The note: what moved around the agent's change, and (when the headline says one was ruled out) why.
      const ruled = f.candidates.filter((c) => c.class === "you_strong" && c.status === "ruled_out");
      const why = ruled.length === 1 ? ` The shift also shows at your old ${heldNoun(ruled[0]!.kind)}.` : ruled.length > 1 ? " The shift also shows without them." : "";
      return {
        headline: fit(LIMITS.headline, `${lead}; ${ap.short}.`, `${lead}.`, "Nothing recorded changed on your side."),
        because: fit(LIMITS.because, ...variants(
          hasCounted && `Around the time ${ap.long}${when}, your ${movedText(f, counted)}.${why}`,
          hasCounted && `Around the time ${ap.long}${when}, your ${movedText(f, counted)}.`,
          hasCounted && `Around the time ${ap.short}${when}, your ${metricsVerb(f, first)}.`,
          `Around the time ${ap.long}${when}, your numbers moved.${why}`,
          `Around the time ${ap.short}${when}, your numbers moved.`,
          "Your numbers moved around a change on the agent's side.")),
        tryThis: ISSUE_LINE,
        band: fit(LIMITS.band, `Agent side: ${ap.band}${when}.`, `Agent side: ${ap.short}${when}.`, "Agent side: a change on the agent's side lines up with the shift."),
      };
    }
    case 9: {
      const vb = f.candidates.find((c) => c.test === "version_boundary");
      const v = vb ? prose(vb.to) : null;
      const update = v !== null ? `the ${v} update` : "an update";
      const named = v !== null ? `the ${A} ${v} update` : `a ${A} update`;
      const when = dated(f, vb);
      const lead = sideLead(f);
      const p = f.boundary?.projects ?? null;
      const first = counted.slice(0, 1);
      return {
        headline: fit(LIMITS.headline, ...variants(
          hasCounted && `${lead}; ${metricsVerb(f, counted)} at ${update}.`,
          hasCounted && `${lead}; ${metricsVerb(f, first)} at ${update}.`,
          `${lead}; the shift starts at ${update}.`,
          "Nothing recorded changed on your side; the shift starts at an update.")),
        // The note: where and from when it shows, that the days around the update were seen, and the numbers.
        because: fit(LIMITS.because, ...variants(
          hasCounted && `The shift shows ${p !== null ? `in ${plural(p, "project")} ` : ""}from ${day(vb?.day, f.today) || "the update"}, and every day around the update was fully observed: ${ratioList(f, counted)}.`,
          `The shift shows ${p !== null ? `in ${plural(p, "project")} ` : ""}from ${day(vb?.day, f.today) || "the update"}, and every day around the update was fully observed.`,
          "Every day around the update was fully observed, and nothing recorded on your side lines up with the shift.")),
        tryThis: ISSUE_LINE,
        band: fit(LIMITS.band, ...variants(
          hasCounted && `Agent side: ${metricsVerb(f, first)} at ${named}${when}.`,
          `Agent side: the shift starts at ${named}${when}.`,
          "Agent side: the shift starts at an update.")),
      };
    }
    case 10: {
      const routine = f.candidates.filter((c) => c.class === "agent_routine");
      const lead = sideLead(f);
      // The note: what landed in the window, and why the update test didn't pass (row 9) when the trace says.
      const vb = traceCondition(f.trace, "version_boundary");
      const reason = vb !== undefined && vb.holds === false && typeof vb.detail?.reason === "string" ? BOUNDARY_CLAUSE[vb.detail.reason] : undefined;
      const but = reason !== undefined ? `, but ${reason}` : "";
      const v = routine.length === 1 ? prose(routine[0]!.to) : null;
      const what = routine.length === 1
        ? (v !== null ? `the ${A} ${v} update${dated(f, routine[0])}` : `a ${A} update${dated(f, routine[0])}`)
        : `${plural(routine.length, `${A} update`)}`;
      return {
        headline: routine.length > 0 ? "Your numbers moved, but updates alone aren't evidence." : "Your numbers moved, but no recorded change lines up with it.",
        because: routine.length > 0
          ? fit(LIMITS.because, `${lead}; ${what} landed in the same window${but}.`, `${lead}; ${what} landed in the same window.`, `${lead}; an update landed in the same window.`)
          : fit(LIMITS.because, `${lead}, and no ${A} update landed in the onset window${onsetDates(f)}.`, `${lead}, and no ${A} update landed in the onset window.`, `${lead}, and no update landed in the onset window.`),
        tryThis: "", band: "",
      };
    }
    case 11: {
      const o = f.observation;
      const total = o.partiallyObservedDays + o.fullyObservedDays;
      const window = `the ${plural(total, "day")} in the onset window`;
      if (o.partialByDesign) {
        return {
          headline: fit(LIMITS.headline, `Your numbers moved, but wasitme can't fully see your ${A} setup.`, "Your numbers moved, but wasitme can't fully see this setup."),
          because: fit(LIMITS.because,
            `${A} has no session hooks, so wasitme can't see every change on your side, and changes there can't be ruled out.`,
            "This agent has no session hooks, so wasitme can't see every change on your side, and changes there can't be ruled out."),
          tryThis: "", band: "",
        };
      }
      if (o.fullyObservedDays === 0) {
        return {
          headline: "Your numbers moved, but before wasitme was watching your setup.",
          because: fit(LIMITS.because,
            `${total === 1 ? `The 1 day in the onset window${onsetDates(f)} wasn't` : `None of ${window}${onsetDates(f)} were`} fully observed, so changes on your side then can't be ruled out.`,
            "No day in the onset window was fully observed, so changes on your side then can't be ruled out."),
          tryThis: "", band: "",
        };
      }
      return {
        headline: "Your numbers moved, but wasitme couldn't see your setup on some of those days.",
        because: fit(LIMITS.because,
          `Only ${o.fullyObservedDays} of ${window}${onsetDates(f)} ${o.fullyObservedDays === 1 ? "was" : "were"} fully observed, so changes on your side on the others can't be ruled out.`,
          `Only ${o.fullyObservedDays} of ${window} ${o.fullyObservedDays === 1 ? "was" : "were"} fully observed, so changes on your side on the others can't be ruled out.`,
          "Some days in the onset window weren't fully observed, so changes on your side then can't be ruled out."),
        tryThis: "", band: "",
      };
    }
    case 12: {
      const s = f.single;
      const named = s !== null ? `${metricWords(s.metric).name} ${ratioText(s.ratio)}` : "";
      // The note: it survives the joint check, and the other voting indicators show nothing to agree with it.
      const quiet = f.metrics.filter((m) => m.role === "vote" && m.eligible && !m.material && m.id !== s?.metric).map((m) => metricWords(m.id).name);
      const holds = s !== null ? `The move in ${metricWords(s.metric).name} holds up with all the indicators checked together` : null;
      return {
        headline: fit(LIMITS.headline, `One indicator moved (${named}); a second kind has to agree.`, "One indicator moved; a second kind has to agree."),
        because: fit(LIMITS.because, ...variants(
          holds !== null && quiet.length > 0 && `${holds}; ${list(quiet)} show no detectable change.`,
          holds !== null && `${holds}, but no second kind of indicator moved with it.`,
          "The move holds up with all the indicators checked together, but no second kind of indicator moved with it.")),
        tryThis: KEEP_WORKING, band: "",
      };
    }
    case 13: {
      // The deck is the sensitivity (the title already says "No detectable change."); the note is what was compared.
      const sens = f.metrics.filter((m) => m.role === "vote" && m.eligible && m.sensitive && m.usable && m.mde !== null);
      const compared = sens.length > 0 ? sens : f.metrics.filter((m) => m.role === "vote" && m.eligible);
      const w = f.windows;
      const over = w !== null ? ` over your last ${plural(w.recent.days, "day")} against the ${count(w.baseline.days)} before` : "";
      const because = compared.length > 0
        ? fit(LIMITS.because, `wasitme compared ${list(compared.map((m) => metricWords(m.id).name))}${over}.`, `wasitme compared ${plural(compared.length, "indicator")}${over}.`, "wasitme compared your recent days against the weeks before.")
        : "wasitme compared your recent days against the weeks before.";
      if (sens.length === 0) return { headline: "No indicator moved enough to show at your volume.", because, tryThis: "", band: "" };
      const x = Math.max(...sens.map((m) => m.mde!));
      return {
        headline: fit(LIMITS.headline, `Changes bigger than about ${mdeText(x)} in ${plural(sens.length, "indicator")} would have shown.`, `Changes bigger than about ${mdeText(x)} would have shown.`),
        because,
        tryThis: "", band: "",
      };
    }
    default:
      return insufficientDeck(f); // rows 2 and 14
  }
}

// ───────────────────────────── the rest ─────────────────────────────

function confidenceLine(f: Facts): string {
  const w = f.windows;
  const ex = (w?.recent.exchanges ?? 0) + (w?.baseline.exchanges ?? 0);
  const sd = (w?.recent.sessionDays ?? 0) + (w?.baseline.sessionDays ?? 0);
  const s = w?.sessions ?? 0; // distinct across both windows: a session on both sides of the boundary counts once
  const base = ex === 0
    ? "No exchanges on this Mac yet."
    : `Based on ${plural(ex, "exchange")} over ${plural(sd, "session-day")} (${plural(s, "session")}) on this Mac.`;
  const blind = f.blindSpot ? ` ${PARTIAL}` : "";
  return fit(LIMITS.confidence, `${base} ${UNSEEN}${blind}`, `${base}${blind}`, base);
}

function statusWords(m: MetricFact): { status: string; short: string } {
  if (m.role === "context") return { status: "Context only", short: "Context only" };
  if (!m.eligible) return { status: "Not enough yet", short: "Not enough yet" };
  if (m.material && m.direction === "up") return { status: "Moved, more", short: "Moved, more" };
  if (m.material && m.direction === "down") return { status: "Moved, fewer", short: "Moved, fewer" };
  return { status: "No detectable change", short: "Not detected" };
}

function metricText(m: MetricFact): MetricText {
  const w = metricWords(m.id);
  const st = statusWords(m);
  const context = m.role !== "vote";
  const rates = `${rate(m.baseline.k, m.baseline.n, m.scale)} → ${rate(m.recent.k, m.recent.n, m.scale)}`;
  const cmp = m.eligible && m.ratio !== null && m.range !== null ? ` · ${ratio2(m.ratio)} (range ${rangeText(m.range[0], m.range[1])})` : "";
  const tag = m.role === "support" ? " (context)" : "";
  return {
    id: m.id, label: w.label, unit: w.unit, name: w.name, status: st.status, statusShort: st.short, context, familywise: m.familywise,
    line: `${w.label} ${rates} ${w.unit}${cmp} · N ${count(m.baseline.n)} | ${count(m.recent.n)} · ${st.status}${tag}`,
  };
}

function stripLine(f: Facts): string | null {
  if (!f.calibrated) return null;
  const m = metric(f, leadMetric(f) ?? undefined);
  if (m === undefined) return null;
  if (m.ratio === null || m.range === null) return "Not enough data yet for a ratio.";
  const tail = m.mde !== null ? `; changes under ${mdeText(m.mde)} wouldn't show` : "";
  return `${ratio2(m.ratio)}, range ${rangeText(m.range[0], m.range[1], " to ")}${tail}`;
}

/** D64(b): what the progress line says when no date is shown. No promise, no "soon": the date depends on the sessions. */
export const NO_DATE_YET = "No date yet: it depends on how your sessions go.";

/**
 * The progress counter of one unlock item (D64(b): always shown): its most binding failing gate count in the window
 * that falls short — "31 of 40 edits", "4 of 5 sessions", "9 of 10 session-days". Null when only the largest-session
 * share fails (no count to show) or the facts carry no shortfall. It picks from the same three pairs the contract
 * carries (sessions, session-days and the indicator's one events check, `gateEventsCheck`) by the same rule as the
 * surfaces (`bindingGate`, docs/CONTRACT.md#display-rules), so the line and the counters on every surface agree.
 */
function gateCounter(f: Facts, metricId: string): string | null {
  const checks = metric(f, metricId)?.shortfall?.checks ?? [];
  let best: { id: string; have: number; need: number } | null = null;
  // In the units' own order, whatever order the facts list them in, so a tie goes to the earlier unit as on the surfaces.
  for (const id of ["sessions", "sessionDays", gateEventsCheck(metricId)]) {
    const c = checks.find((x) => x.id === id);
    if (c === undefined || !(c.have >= 0) || !(c.need > 0) || !(c.have < c.need) || !Number.isFinite(c.need)) continue;
    if (best === null || c.have / c.need < best.have / best.need) best = c;
  }
  if (best === null) return null;
  const [one, many] = best.id === "sessions" ? ["session", "sessions"]
    : best.id === "sessionDays" ? ["session-day", "session-days"]
    : countNoun(metricId, best.id === "denominator" ? "denominator" : "events");
  return `${count(best.have)} of ${plural(best.need, one, many)}`;
}

/** True when the only gate an indicator fails is the largest-session share (in one window or both): D23 orders the
 *  share check last, so a shortfall that lists nothing else has nothing else short. */
function dominatedOnly(m: MetricFact): boolean {
  const checks = m.shortfall?.checks ?? [];
  return checks.length > 0 && checks.every((c) => c.id === "sessionShare" && c.have >= c.need);
}

/**
 * "one session holds most of the recent tool calls": why an indicator whose largest session holds half or more of a
 * window's denominator (D23's share gate) can't be compared, in the denominator's own words. "most" only when the share
 * is over half (exactly half fails the gate too, and is "half"). Null when the facts carry no failing share check.
 */
function dominatedWords(f: Facts, metricId: string): string | null {
  const sf = metric(f, metricId)?.shortfall;
  const c = sf?.checks.find((x) => x.id === "sessionShare");
  if (sf === undefined || sf === null || c === undefined || !(c.have >= c.need)) return null;
  const when = sf.window === "recent" ? "recent" : "earlier";
  const share = c.have > 0.5 ? "most" : c.have === 0.5 ? "half" : "too large a share";
  return `one session holds ${share} of the ${when} ${countNoun(metricId, "denominator")[1]}`;
}

/**
 * The "Next to unlock" line (METHOD.md §13, D64). It always leads with the counter when there is one: a gate shortfall
 * ("reads per edit, 31 of 40 edits so far"), history ("30 of 42 days of history") or the ready hold ("enough data on 1
 * of 2 days in a row"). The date comes after it only when one is shown; otherwise NO_DATE_YET.
 */
function progressLine(f: Facts): string | null {
  const p = f.progress;
  if (p === null || !f.calibrated || f.state !== "insufficient" || p.reason === "ready") return null;
  const first = p.unlock.find((u) => !u.fieldsMissing);
  const name = (id: string | undefined): string => metricWords(id ?? f.errorsVote).name;
  switch (p.reason) {
    case "not_at_current_pace": {
      const dull = first?.metric ?? f.metrics.find((m) => m.role === "vote" && !m.sensitive)?.id;
      const plan = `At your current pace wasitme can't rule out a doubling in ${name(dull)}; it will keep watching for large changes.`;
      const counter = first !== undefined && first.state === "ineligible" ? gateCounter(f, first.metric) : null;
      return counter !== null ? fit(160, `Next to unlock: ${name(first!.metric)}, ${counter} so far. ${plan}`, plan) : plan;
    }
    case "no_data":
      return "wasitme needs a few more sessions before it can estimate when the indicators unlock.";
    case "metric_unavailable": {
      const missing = f.metrics.find((m) => m.role === "vote" && m.fieldsMissing);
      return `This version can't read ${name(missing?.id)} from your logs yet, so waiting won't unlock it.`;
    }
    default: {
      // "eta" (a date is shown) or "no_date" (D64(b) shows none).
      const eta = p.etaDate !== null ? `about ${day(p.etaDate, f.today)}` : null;
      const tail = (lead: string, pace: string) => (eta !== null ? `${lead}; ${pace} ${eta}.` : `${lead}. ${NO_DATE_YET}`);
      // D64(a): today has enough data; "ready" needs it on the next day's evaluation too.
      if (p.readyToday) return tail("Next to unlock: enough data on 1 of 2 days in a row", "at your pace,");
      // The first indicator with a gate shortfall (shown in sessions and session-days, METHOD.md §13), else one that is
      // not yet sensitive; history-only waits have no shortfall to name.
      const gated = p.unlock.find((u) => !u.fieldsMissing && u.state === "ineligible" && u.blocking.length > 0);
      const dull = p.unlock.find((u) => u.state === "not_sensitive");
      const u = gated ?? dull;
      if (u === undefined) {
        const needDays = TIERS[0]!.historyDays;
        const history = f.tier === null && f.history.selection === "no_history" && f.history.days < needDays
          ? `Next to unlock: ${count(f.history.days)} of ${plural(needDays, "day")} of history` : null;
        if (history !== null) return tail(history, "at your pace, wasitme can compare from");
        return eta !== null ? `At your pace, wasitme can compare from ${eta}.` : NO_DATE_YET;
      }
      const counter = u.state === "ineligible" ? gateCounter(f, u.metric) : null;
      const head = counter !== null ? `Next to unlock: ${name(u.metric)}, ${counter} so far` : `Next to unlock: ${name(u.metric)}`;
      // One session dominates: how many more sessions would dilute it depends on how big they are, so no count is
      // shown (an estimate from the window's other, small sessions ran to hundreds); the words say what is wrong.
      const dominated = u.state === "ineligible" && u.blocking.includes("sessionShare") ? dominatedWords(f, u.metric) : null;
      if (dominated !== null) {
        return fit(160,
          tail(`${head}; ${dominated}, so more sessions are needed`, "at your pace,"),
          tail(`${head}; ${dominated}`, "at your pace,"),
          tail(`${head}; one session dominates`, "at your pace,"),
          `${head}; one session dominates.`,
          `Next to unlock: ${name(u.metric)}; one session dominates.`);
      }
      let need: string;
      if (u.state === "not_sensitive") need = "can't rule out a doubling yet";
      else {
        const parts: string[] = [];
        if (u.shortSessions !== null && u.shortSessions > 0) parts.push(plural(u.shortSessions, "more session", "more sessions"));
        if (u.shortSessionDays !== null && u.shortSessionDays > 0) parts.push(plural(u.shortSessionDays, "more session-day", "more session-days"));
        need = parts.length > 0 ? `needs about ${parts.join(" and ")}` : "needs more data";
      }
      return fit(160,
        tail(counter !== null ? `${head}; ${need}` : `${head} ${need}`, "at your pace,"),
        tail(head, "at your pace,"),
        eta !== null ? `${head}.` : `${head}. ${NO_DATE_YET}`,
        `Next to unlock: ${name(u.metric)}.`);
    }
  }
}

function candidateLine(f: Facts, c: CandidateFact, label: string): string {
  const when = c.day !== null ? day(c.day, f.today) : "date unknown";
  const p = f.boundary?.projects ?? null;
  const head = `${when} · ${label}`;
  switch (c.class) {
    case "you_strong":
      return c.status === "ruled_out" ? `${head}: ruled out; the shift also shows at your old ${heldNoun(c.kind)}.` : `${head}: on your side; it lines up with the shift.`;
    case "you_weak": return `${head}: a minor setting; listed, never decides.`;
    case "agent_strong": return `${head}: on the agent's side; it lines up with the shift.`;
    case "agent_routine":
      return c.test === "version_boundary"
        ? `${head}: the shift starts at this update${p !== null ? ` in ${plural(p, "project")}` : ""}.`
        : `${head}: routine update; updates alone aren't evidence.`;
    case "unknown": return `${head}: the logs don't say who made this change.`;
    default: return `${head}: context only.`;
  }
}

const SIDE_WORD: Readonly<Record<string, string>> = { you: "your side", agent: "agent side", unknown: "origin unknown", meta: "wasitme" };

function timelineLine(f: Facts): string {
  const from = addDays(f.today, -30);
  const recent = glanceEventFacts(f).filter((e) => e.day >= from && e.day < f.today);
  const you = recent.filter((e) => e.side === "you").length;
  const agent = recent.filter((e) => e.side === "agent").length;
  const unknown = recent.filter((e) => e.side === "unknown").length;
  if (you + agent + unknown === 0) return "No changes recorded in the last 30 days.";
  return `In the last 30 days: ${plural(you, "change")} on your side, ${count(agent)} on the agent's side${unknown > 0 ? `, ${count(unknown)} of unknown origin` : ""}.`;
}

/** Every engine string for one agent (see the file header). Pure. */
export function wordsFor(f: Facts, opts: WordsOptions = {}): AgentWords {
  const pendingCal = f.reason === "calibration_pending";
  const state = STATE_WORDS[f.state];
  const label = pendingCal ? CALIBRATION_PENDING_WORDS.label : state.label;
  const title = pendingCal ? CALIBRATION_PENDING_WORDS.headline : state.headline;
  const deck = deckFor(f);

  const eventLabels: Record<string, string> = {};
  for (const e of f.events) eventLabels[e.id] = eventLabel(e, f.agent, LIMITS.eventLabel);

  const known = opts.knownEventIds === null || opts.knownEventIds === undefined ? null : new Set(opts.knownEventIds);
  const glanceEvents = glanceEventFacts(f);
  const newChanges = known === null ? 0 : glanceEvents.filter((e) => !known.has(e.id)).length;
  const statusLine = `wasitme: ${label.toLowerCase()}${newChanges > 0 ? ` +${newChanges}` : ""}`;

  const changedState = f.onset !== null;
  const observationNote = changedState && f.observation.partiallyObservedDays > 0 ? `${UNSEEN} ${PARTIAL}` : UNSEEN;
  const disclaimer = f.state === "none" || f.state === "you" || f.state === "agent" ? DISCLAIMER : null;

  const metrics = f.metrics.map(metricText);
  const candidateLines = f.candidates.map((c) => {
    const e = f.events.find((x) => x.id === c.event);
    const lbl = e ? eventLabels[e.id]! : eventLabel({ kind: c.kind, side: c.side, provenance: c.provenance, from: c.from, to: c.to, tripwire: c.tripwire }, f.agent, LIMITS.eventLabel);
    return { event: c.event, text: candidateLine(f, c, lbl) };
  });
  const eventLines = glanceEvents.slice(0, 5).map((e) => `${day(e.day, f.today)} · ${eventLabels[e.id]} · ${SIDE_WORD[e.side] ?? "origin unknown"}`);
  const confidence = confidenceLine(f);
  const progress = progressLine(f);
  const timeline = timelineLine(f);
  const pendingLine = f.pending ? PENDING_LINE : null;
  const top = topMetricIds(f).map((id) => metrics.find((m) => m.id === id)!.line);
  const stateLine = `${title} ${deck.headline}`;
  const nonEmpty = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => typeof x === "string" && x !== "");

  return {
    agent: f.agent,
    label,
    headline: deck.headline,
    because: deck.because,
    tryThis: deck.tryThis,
    confidence,
    band: deck.band,
    statusLine,
    disclaimer,
    observationNote,
    trace: traceWords(f),
    eventLabels,
    metrics,
    title,
    pendingLine,
    progressLine: progress,
    stripLine: stripLine(f),
    candidateLines,
    timelineLine: timeline,
    eventLines,
    newChanges,
    body: {
      timeline: nonEmpty([timeline, ...eventLines, stateLine, pendingLine, deck.because, progress, deck.tryThis, confidence, disclaimer]),
      verdict: nonEmpty([stateLine, pendingLine, deck.because, ...top, ...candidateLines.map((c) => c.text), progress, deck.tryThis, timeline, ...eventLines, confidence, disclaimer]),
    },
  };
}

/** The words for one agent's attribution: `wordsFor(factsOf(attribution))`. Pure. */
export function explain(a: Attribution, opts: WordsOptions & FactsOptions = {}): AgentWords & { facts: Facts } {
  const facts = factsOf(a, opts);
  return { ...wordsFor(facts, opts), facts };
}
