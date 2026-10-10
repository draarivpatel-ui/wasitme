/**
 * Display decisions derived from a decoded agent: which events line up with the shift, which days a strip shows,
 * what a metric row says. Pure; every rule here is documented once and shared by every page.
 */

import type { Agent, Day, Metric, TEvent, Unlock } from "./decode.js";
import { CANVAS_COPY as T } from "./gen/design.js";
import { addDays, dayNum, fill, num, plural } from "./format.js";

/** Event ids the engine left open as candidates (METHOD.md §10): "lines up with the shift" / "a candidate". */
export function openCandidates(a: Agent): Set<string> {
  return new Set(a.candidates.filter((c) => c.status === "open").map((c) => c.event));
}

export function candidateOf(a: Agent, e: TEvent): { status: string | null; test: string | null } | null {
  const c = a.candidates.find((x) => x.event === e.id);
  return c ? { status: c.status, test: c.test } : null;
}

/** The finding names a side only for you / agent. */
export function findingSide(a: Agent): "you" | "agent" | null {
  return a.state === "you" ? "you" : a.state === "agent" ? "agent" : null;
}

/** Calibration pending is a reason, displayed as "Timeline only" with the insufficient glyph (CONTRACT decision 12). */
export function isTimelineOnly(a: Agent): boolean { return a.state === "insufficient" && a.reason === "calibration_pending"; }

/** Events in the recent window (or, with no comparison window, the newest ones). Wasitme's own (meta) never show. */
export function recentEvents(a: Agent): TEvent[] {
  const ev = a.timeline.filter((e) => e.side !== "meta");
  if (a.windows) return ev.filter((e) => e.day >= a.windows!.recent.from && e.day <= a.windows!.recent.to);
  return ev.slice(-6);
}

/** k and n words for a metric's daily rows ("errors" / "tool calls"): the counted units, the same words as the CLI's
 *  strip (engine/src/output/terminal.ts STRIP_LABELS) and the app's (MetricWords.kn). Edits without reading first count
 *  "unread edits" out of "edits". */
const KN_WORDS: { [id: string]: [string, string] } = {
  toolErrors: ["errors", "tool calls"],
  toolErrorsNonCmd: ["errors", "tool calls"],     // D61's voting construct; the engine's unit is "per 100 tool calls"
  readsPerEdit: ["reads", "edits"],
  blindEdits: ["unread edits", "edits"],
  interrupts: ["interruptions", "exchanges"],
  pushback: ["pushback", "prompts"],
  cmdFailures: ["failures", "commands"],
  churn: ["files", "exchanges"],
};
export function knWords(id: string, unit: string): [string, string] {
  const known = KN_WORDS[id];
  if (known) return known;
  const per = /^per (?:100 )?(.+)$/.exec(unit);
  if (per) return ["events", per[1]!];
  const xy = /^(.+) per (.+)$/.exec(unit);
  if (xy) return [xy[1]!, xy[2]! + "s"];
  return ["events", "opportunities"];
}

/** What one event of a metric is called in "31 of 40 edits needed" (the unlock gate counts these); an indicator's own
 *  events go by its name, as in the CLI. */
const GATE_NOUN: { [id: string]: string } = {
  toolErrors: "errors", toolErrorsNonCmd: "errors", readsPerEdit: "edits", blindEdits: "edits without reading first", interrupts: "interruptions",
  pushback: "pushback prompts", cmdFailures: "command failures", churn: "files",
};
export function gateNoun(id: string): string { return GATE_NOUN[id] ?? "events"; }

export type GateUnit = "sessions" | "sessionDays" | "events";
/** The one pair an unlock counter shows: its unit, count, target and what the unit is called. */
export interface GatePair { unit: GateUnit; have: number; need: number; noun: string }
const GATE_UNITS: readonly GateUnit[] = ["sessions", "sessionDays", "events"];

/** What one unit of a metric's unlock gate is called: "sessions", "session-days", or its events ("edits", "errors"). */
export function gateUnitNoun(metric: string, unit: GateUnit): string {
  return unit === "sessions" ? "sessions" : unit === "sessionDays" ? "session-days" : gateNoun(metric);
}

/**
 * The unlock counter (docs/CONTRACT.md#display-rules; the engine's contract/display.ts `bindingGate` is the reference):
 * of the units still short of their target, the one furthest from it by have ÷ need, a tie going to the earlier of
 * sessions, session-days, events. The counter, its noun and its bar all come from this one pair, so a count is never set
 * against another quantity's target ("3,150 of 10"). Null when no unit is short (only one session dominating): no count.
 */
export function bindingGate(u: Unlock | null | undefined): GatePair | null {
  if (!u) return null;
  let best: GatePair | null = null;
  for (const unit of GATE_UNITS) {
    const have = u.have[unit], need = u.need[unit];
    if (have === null || need === null || !(have >= 0) || !(need > 0) || !(have < need) || !Number.isFinite(need)) continue;
    if (best === null || have / need < best.have / best.need) best = { unit, have, need, noun: gateUnitNoun(u.metric, unit) };
  }
  return best;
}

/** Each indicator's label, word for word the engine's (engine/src/words/names.ts METRIC_WORDS), for an id the document
 *  names without a labelled row of its own: an unlock item whose indicator has no metric row (the Codex demo's
 *  "toolErrors 8 of 10 session-days"), or a row that came without its label. The Mac app (MetricNames.label) and the
 *  Claude Code pane (theme.metricName) hold the same table; scripts/test/metric-words.test.mjs keeps all four equal. */
const METRIC_LABEL: { [id: string]: string } = {
  toolErrors: "Tool errors",
  toolErrorsNonCmd: "Tool errors (excl. commands)",
  cmdFailures: "Command failures",
  readsPerEdit: "Reads per edit",
  blindEdits: "Edits without reading first",
  interrupts: "Interruptions",
  pushback: "Pushback prompts",
  churn: "Files edited 3+ times",
};

/** An indicator's name from its id alone: the engine's label, or for an id this version does not know its words
 *  ("fooBarBaz" → "Foo bar baz"; "Indicator" when that is empty or longer than a label's 40). Never the id itself. */
export function metricName(id: string): string {
  if (Object.hasOwn(METRIC_LABEL, id)) return METRIC_LABEL[id]!;
  const words = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9+]+/g, " ").trim().toLowerCase();
  return words !== "" && words.length <= 40 ? words.charAt(0).toUpperCase() + words.slice(1) : "Indicator";
}

/** The label a page shows for an indicator: its row's own label, else `metricName`. */
export function metricLabel(a: Agent, id: string): string {
  return a.metrics.find((m) => m.id === id)?.label || metricName(id);
}

/** A metric moved (filled dot, tinted ratio) only when it is a vote that shifted (D53e: material, family-wise). */
export function moved(m: Metric): boolean {
  return m.eligible && m.role === "vote" && (m.status === "worse" || m.status === "better") && m.shifted !== false;
}

/** Friction and context signals never decide (D30): they are always shown as context. */
export function isContext(m: Metric): boolean { return m.role !== "vote"; }

export function statusWords(m: Metric): string {
  if (!m.eligible) return isContext(m) ? "Context only" : "Not enough yet";
  if (isContext(m)) return "Context only";
  if (m.status === "worse" || m.status === "better") return m.ratio !== null && m.ratio < 1 ? "Moved, fewer" : "Moved, more";
  return "No detectable change";
}

const INELIGIBLE: { [k: string]: string } = {
  too_few_events: "too few to compare yet",
  too_few_session_days: "too few session-days yet",
  too_few_sessions: "too few sessions yet",
  one_session_dominates: "one session dominates",
  too_few_edits: "too few edits yet",
  paused_format_drift: "paused: the log format changed",
  not_english: "prompts not in English",
  no_data: "no data yet",
};
/** Why an ineligible metric shows no ratio: the unlock gate when the engine sent one, else the reason in words. */
export function ineligibleWhy(a: Agent, m: Metric): string {
  const g = bindingGate(a.progress?.unlock.find((x) => x.metric === m.id));
  if (g) return `${num(g.have)} of ${num(g.need)} ${g.noun} needed`;
  const why = m.ineligibleReason ? INELIGIBLE[m.ineligibleReason] ?? "not enough data yet" : "not enough data yet";
  if (m.ineligibleReason === "too_few_events") return `${num(m.recent.k)} in the recent window; ${why}`;
  return why.charAt(0).toUpperCase() + why.slice(1);
}

/** The metric the shift lines up with: the open candidate on the finding's side (or the only open one). */
export function lineUpEvent(a: Agent): TEvent | null {
  const open = openCandidates(a);
  const side = findingSide(a);
  const evs = a.timeline.filter((e) => open.has(e.id));
  return (side ? evs.find((e) => e.side === side) : null) ?? (evs.length === 1 ? evs[0]! : null);
}

/** The most days a strip shows: the snapshot schema's cap on `strip.days` (six weeks). */
export const MAX_STRIP_DAYS = 42;

export interface StripView { days: string[]; rows: StripDay[] | null; recentStart: number; baseShown: number }
/** A strip day; `out` marks a day outside the engine's strip (not covered: no claim, drawn blank, never "–"). */
export interface StripDay extends Day { out?: boolean }

/**
 * The days a strip shows: `show` days ending at the recent window's last day, gaps filled as "no sessions" (n = 0,
 * drawn as –). With no comparison window, the strip's own day range (or, for events-only, the 42 days up to the
 * snapshot's day).
 */
export function stripDays(a: Agent, wanted: number, rows: Day[] | null, fallbackEnd: string | null): StripView {
  // `wanted` can come from a snapshot (the recent window's length), and a snapshot is hostile input: the engine's strip
  // is at most 42 days (snapshot schema maxItems), so never build more days than that, whatever the field says.
  const show = Math.max(1, Math.min(Number.isFinite(wanted) ? Math.floor(wanted) : 1, MAX_STRIP_DAYS));
  let end: string | null = a.windows?.recent.to ?? null;
  if (!end && rows && rows.length) end = rows[rows.length - 1]!.d;
  if (!end) end = fallbackEnd ?? (a.timeline.length ? a.timeline[a.timeline.length - 1]!.day : null);
  if (!end) return { days: [], rows: rows ? [] : null, recentStart: 0, baseShown: 0 };
  const first = addDays(end, -(show - 1));
  const days: string[] = [];
  for (let i = 0; i < show; i++) days.push(addDays(first, i));
  const byDay = new Map<string, Day>();
  if (rows) for (const r of rows) byDay.set(r.d, r);
  const lo = rows && rows.length ? rows[0]!.d : null, hi = rows && rows.length ? rows[rows.length - 1]!.d : null;
  // inside the strip's own range a missing day had no sessions ("–"); outside it the strip says nothing
  const filled: StripDay[] | null = rows ? days.map((d) => byDay.get(d) ?? (lo && hi && d >= lo && d <= hi ? { d, k: 0, n: 0 } : { d, k: 0, n: 0, out: true })) : null;
  const recentFrom = a.windows?.recent.from ?? null;
  const recentStart = recentFrom ? Math.max(0, Math.min(show, dayNum(recentFrom) - dayNum(first))) : 0;
  return { days, rows: filled, recentStart, baseShown: recentFrom ? recentStart : 0 };
}

/** "4 weeks" for a baseline of whole weeks (two or more), else "28 days". */
export function baselineWords(days: number): string {
  return days % 7 === 0 && days >= 14 ? `${days / 7} weeks` : plural(days, "day", "days");
}

/** The finding's window line, "Last 14 days against the 4 weeks before" (UX-V2 §8.1). The agent's name is the window's
 *  subtitle, so it is not repeated here. */
export function windowLine(a: Agent): string {
  if (!a.windows) return T.finding.noWindow;
  return fill(T.finding.window, { recent: num(a.windows.recent.days), baseline: baselineWords(a.windows.baseline.days) });
}

interface Version { parts: string[]; nums: number[]; pre: boolean }
function parseVersion(v: string): Version | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  const parts = m[1]!.split(".");
  return { parts, nums: parts.map(Number), pre: m[2] !== undefined };
}

/**
 * A version change shown short (UX-V2 §7.2). When the numeric cores differ, both are cut after the first component
 * that differs, keeping at least major.minor and never the pre-release: "0.144.0-alpha.4 → 0.145.0-alpha.18" is
 * "0.144 → 0.145", while "2.1.274 → 2.1.277" stays whole. Equal cores are shown in full. `preRelease`: the new version
 * is a pre-release. null when either side doesn't parse (the label is then shown verbatim). The full versions stay in
 * the badge's accessible name and hover tip, and in the Markdown report.
 */
export function shortVersions(from: string, to: string): { from: string; to: string; preRelease: boolean } | null {
  const a = parseVersion(from), b = parseVersion(to);
  if (!a || !b) return null;
  let i = -1;
  for (let j = 0; j < Math.max(a.nums.length, b.nums.length); j++) if ((a.nums[j] ?? 0) !== (b.nums[j] ?? 0)) { i = j; break; }
  if (i < 0) return { from, to, preRelease: b.pre };
  const keep = Math.max(i, 1) + 1;
  return { from: a.parts.slice(0, keep).join("."), to: b.parts.slice(0, keep).join("."), preRelease: b.pre };
}

/** A change's row label: a version change whose label ends in "{from} → {to}" with both versions short (§7.2);
 *  anything else (a model name, "MCP server added") verbatim. */
export function eventLabel(e: TEvent): { text: string; preRelease: boolean } {
  if (e.kind === "version" && e.from && e.to) {
    const sv = shortVersions(e.from, e.to), tail = `${e.from} → ${e.to}`;
    if (sv && e.label.endsWith(tail)) return { text: `${e.label.slice(0, e.label.length - tail.length)}${sv.from} → ${sv.to}`, preRelease: sv.preRelease };
  }
  return { text: e.label, preRelease: false };
}

/** Short label next to a chart badge: "effort", "MCP", or the agent's new version (short, §7.2). */
export function shortLabel(e: TEvent): string {
  if (e.side === "you" || e.side === "unknown") return ({ effort: "effort", model: "model", mcp: "MCP", instructions: "instructions", skills: "skills", hooks: "hooks", mode: "mode" } as { [k: string]: string })[e.kind] ?? e.kind;
  if (e.kind === "version") {
    const sv = e.from && e.to ? shortVersions(e.from, e.to) : null;
    return sv ? sv.to : e.to || e.label.split(" → ")[1] || e.label;
  }
  return ({ "served-model": "model", model: "model", effort: "effort", mode: "mode", instructions: "instructions" } as { [k: string]: string })[e.kind] ?? e.kind;
}

/** An event label without the agent's own name in front ("Claude Code 2.1.274 → 2.1.277" → "2.1.274 → 2.1.277"). */
export function laneLabel(a: Agent, e: TEvent): string {
  const p = a.name + " ";
  return e.label.startsWith(p) ? e.label.slice(p.length) : e.label;
}

/** "1 error", "3 errors": the singular of the k/n words above ("tool calls" → "tool call", "opportunities" → "opportunity"). */
export function countWords(n: number, plural: string): string {
  const one = /ies$/.test(plural) ? plural.replace(/ies$/, "y") : plural.replace(/s$/, "");
  return `${num(n)} ${n === 1 ? one : plural}`;
}

/**
 * A change row's one quiet tag (UX-V2 §7.4), in priority order: "lines up with the shift" (tinted with the finding's
 * side) or "a candidate", "ruled out", "wasitme's own change", "origin unknown", "pre-release". Nothing else becomes a
 * tag: a routine update says so by its hollow badge, and the list says once what that means. `strata`: spell out a
 * stratified ruling-out (the Timeline list and the report).
 */
export function rowTag(a: Agent, e: TEvent, strata = false): { text: string; side: "you" | "agent" | null; tone: "hit" | "candidate" | "quiet" } | null {
  const c = candidateOf(a, e);
  if (c?.status === "open") {
    const side = findingSide(a);
    return side ? { text: T.tag.lineUp, side, tone: "hit" } : { text: T.tag.candidate, side: null, tone: "candidate" };
  }
  if (c?.status === "ruled_out") return { text: strata && c.test === "strata" ? T.tag.ruledOutStrata : T.tag.ruledOut, side: null, tone: "quiet" };
  if (e.side === "meta") return { text: T.tag.meta, side: null, tone: "quiet" };
  if (e.side === "unknown") return { text: T.tag.unknown, side: null, tone: "quiet" };
  if (eventLabel(e).preRelease) return { text: T.tag.preRelease, side: null, tone: "quiet" };
  return null;
}

/** Which window a change falls in (the Timeline list's groups); null with no comparison window. */
export function windowOf(a: Agent, e: TEvent): "recent" | "before" | "earlier" | "after" | null {
  if (!a.windows) return null;
  if (e.day >= a.windows.recent.from && e.day <= a.windows.recent.to) return "recent";
  if (e.day >= a.windows.baseline.from && e.day <= a.windows.baseline.to) return "before";
  return e.day > a.windows.recent.to ? "after" : "earlier";
}

export function sumDays(rows: Day[]): { k: number; n: number } {
  let k = 0, n = 0;
  for (const r of rows) { k += r.k; n += r.n; }
  return { k, n };
}
