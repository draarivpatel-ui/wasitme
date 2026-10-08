/**
 * The terminal report (`wasitme`): one 100-column block per agent, laid out like design/system/screens/text-*.png
 * and coloured only through the design system's tokens (`design-tokens.ts`; NO_COLOR, a pipe and TERM=dumb print no
 * escape codes at all). Pure: the caller passes the colour mode, width, zone and platform; nothing here reads the
 * environment, the clock or a file.
 *
 *   timeline-led (the D28/D61 default):  What changed · Finding · Signals · Next · Share
 *   finding-led (`--lead finding`):      Finding · Signals · What changed · Next · Share
 *
 * Every word comes from the document (the engine's own strings in snapshot.json: label, headline, because, tryThis,
 * confidence, disclaimer, event labels, metric labels) or from the fixed chrome below (section names, column
 * headings, legend). The ledger's status words are the mock-up's lower-case forms ("not detected", "moved, more").
 * Which side an event is on is carried four ways (RUBRIC): sticker colour, numeral vs letter, above vs below the
 * rule, and the words.
 */
import { stateGlyph, type ColorMode } from "../cli/design-tokens.js";
import { bindingGate, type GateUnit } from "../contract/display.js";
import type { SnapshotAgent, SnapshotMetric, TimelineEvent } from "../contract/snapshot.js";
import type { Lead } from "../contract/vocab.js";
import { count, day as dayText, range as rangeText, ratio2 } from "../words/format.js";
import { agentName, metricWords } from "../words/names.js";
import { CALIBRATION_PENDING_WORDS, STATE_WORDS } from "../words/tokens.js";
import type { ReportDoc } from "./doc.js";
import { emptyReason, type RootLabels } from "./empty.js";
import { Grid, type Role } from "./grid.js";
import { clip, cols, sentences, stamp, wrap } from "./text.js";

export interface TerminalOptions {
  mode: ColorMode;
  /** ASCII-only glyphs and box characters (TERM=linux, WASITME_ASCII=1). */
  ascii: boolean;
  /** Terminal width; the layout is 100 columns and shrinks (never grows) to fit, down to 64. */
  columns: number;
  /** Overrides the document's own `lead`. */
  lead?: Lead;
  timeZone: string;
  /** `process.platform`: picks the clipboard command in the Share line. */
  platform: string;
  /** How the log folders are named in the empty-state message (default "~/.claude", "~/.codex"). */
  roots?: RootLabels;
}

export const LEFT = 16;
const PITCH = 4;

/**
 * Row labels under the strip, by indicator: the counted units, events then opportunities (the canvas and the app use
 * the same words, ui/src/derive.ts KN_WORDS). They sit in the LEFT column (at most 15 cells), so edits without reading
 * first count "unread edits" out of "edits".
 */
export const STRIP_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  toolErrors: ["errors", "tool calls"],
  toolErrorsNonCmd: ["errors", "tool calls"],
  cmdFailures: ["failures", "commands"],
  readsPerEdit: ["reads", "edits"],
  blindEdits: ["unread edits", "edits"],
  interrupts: ["interruptions", "exchanges"],
  pushback: ["pushback", "prompts"],
  churn: ["edited 3+ times", "edit exchanges"],
};

/** What a metric's "events" are, for "31 of 40 edits needed" (an indicator's own events go by its name). */
const EVENT_NOUN: Readonly<Record<string, string>> = {
  toolErrors: "errors", toolErrorsNonCmd: "errors", cmdFailures: "failures", readsPerEdit: "edits",
  blindEdits: "edits without reading first", interrupts: "interruptions", pushback: "pushback prompts", churn: "files edited 3+ times",
};

/** What one unit of an unlock gate is called: the indicator's events noun, sessions or session-days. */
function gateNoun(metric: string, unit: GateUnit): string {
  return unit === "sessions" ? "sessions" : unit === "sessionDays" ? "session-days" : EVENT_NOUN[metric] ?? "events";
}

const INELIGIBLE_TEXT: Readonly<Record<string, string>> = {
  too_few_session_days: "needs more session-days",
  too_few_sessions: "needs more sessions",
  one_session_dominates: "one session dominates",
  too_few_edits: "needs more edits",
  paused_format_drift: "paused: the log format changed",
  not_english: "prompts are not in English",
  no_data: "no data yet",
};

const SIDE_WORD: Readonly<Record<string, string>> = { you: "your side", agent: "agent side", unknown: "origin unknown", meta: "wasitme" };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The fewest label columns a ledger row keeps before its tag gives way (a cut label still names the change). */
const MIN_LABEL = 12;

// ───────────────────────────── helpers ─────────────────────────────

export const visibleEvent = (e: TimelineEvent): boolean => e.side !== "meta" && e.kind !== "system-prompt";

export function addDays(d: string, n: number): string {
  const ms = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** "Sep 21" (the year is added when it differs from `today`'s). */
const when = (d: string, today: string): string => dayText(d, today) || d;

function kn(m: SnapshotMetric, w: "recent" | "baseline"): string {
  return `${count(m[w].k)} / ${count(m[w].n)}`;
}

/** The glance's party glyph and the label the Finding line shows for this agent. */
function findingFace(a: SnapshotAgent, stale: boolean, ascii: boolean): { glyph: string; label: string; role: "you" | "agent" | null } {
  if (stale) return { glyph: stateGlyph("stale", ascii), label: STATE_WORDS.stale.label, role: null };
  const pendingCal = a.reason === "calibration_pending";
  const label = pendingCal ? CALIBRATION_PENDING_WORDS.label : STATE_WORDS[a.state].label;
  return { glyph: stateGlyph(a.state, ascii), label, role: a.state === "you" ? "you" : a.state === "agent" ? "agent" : null };
}

interface Layout {
  W: number;
  X: number;
}

interface View {
  a: SnapshotAgent;
  name: string;
  today: string;
  doc: ReportDoc;
  stale: boolean;
  tz: string;
  ascii: boolean;
}

// ───────────────────────────── sections ─────────────────────────────

/** A, B, … Z, AA, AB, … (the canvas's sequence, so a long timeline never runs out of letters). */
function letters(i: number): string {
  let s = "", n = i;
  do { s = ALPHABET[n % 26]! + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/** Event markers: yours are numbered, the agent's lettered (one per day and side), unknown origin is "?". */
export function markers(events: readonly TimelineEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, string>();
  let n = 0, l = 0;
  for (const e of events) {
    if (e.side === "unknown") { out.set(e.id, "?"); continue; }
    const key = `${e.day}|${e.side}`;
    let m = groups.get(key);
    if (m === undefined) {
      m = e.side === "you" ? String(++n) : letters(l++);
      groups.set(key, m);
    }
    out.set(e.id, m);
  }
  return out;
}

/**
 * The agent's markers, assigned ONCE over its whole visible timeline (oldest first), so a change has the same marker in
 * the terminal (at any width), the Markdown strip and timeline, and the HTML report — like the canvas, which also
 * numbers over the whole timeline. Each renderer shows the part that fits; none renumbers it.
 */
export function timelineMarkers(a: SnapshotAgent): Map<string, string> {
  return markers(a.timeline.filter(visibleEvent));
}

function tagFor(a: SnapshotAgent, e: TimelineEvent): string {
  const c = a.candidates.find((x) => x.event === e.id);
  const parts: string[] = [];
  if (c !== undefined) {
    if (c.status === "open") parts.push("lines up with the shift");
    else if (c.status === "ruled_out") parts.push("ruled out");
    else if (e.strength === "routine") parts.push("routine update");
    else if (e.strength === "weak") parts.push("minor setting");
    else parts.push("background");
  } else if (e.strength === "routine") parts.push("routine update");
  if (e.new) parts.push("new");
  return parts.join(" · ");
}

function whatChanged(g: Grid, r0: number, v: View, L: Layout): number {
  const { a } = v;
  const strip = a.strip;
  const all = a.timeline.filter(visibleEvent);
  let r = r0;
  g.at(r, 0, "What changed", "bold");

  if (strip === null || strip.days.length === 0) {
    // Timeline only (no comparison ran): the last 30 days as a list.
    const from = addDays(v.today, -30);
    const inView = all.filter((e) => e.day >= from);
    g.at(r, LEFT, "the last 30 days", "muted");
    r += 1;
    if (inView.length === 0) {
      g.at(r, LEFT, "No changes recorded in the last 30 days.");
      return r + 1;
    }
    return legend(g, r, v, inView, new Map(), L, 0);
  }

  const slots = Math.max(6, Math.min(21, Math.floor((L.W - LEFT) / PITCH)));
  const days = strip.days.slice(-slots);
  const first = days[0]!.d, last = days[days.length - 1]!.d;
  const inView = all.filter((e) => e.day >= first && e.day <= last);
  const mark = timelineMarkers(a);
  const dayIdx = new Map(days.map((x, i) => [x.d, i]));

  const how = `yours numbered above the line, ${v.name}'s lettered below`;
  g.at(r, LEFT, cols(how) <= L.W - LEFT ? how : "yours above the line, the agent's below", "muted");
  r += 1;
  g.at(r, 0, "your side", "muted");
  g.at(r + 2, 0, v.name, "muted");
  const rule = Array.from({ length: days.length * PITCH }, () => "┄");
  const placed = new Set<string>();
  for (const e of inView) {
    const i = dayIdx.get(e.day);
    const m = mark.get(e.id);
    if (i === undefined || m === undefined) continue;
    const key = `${e.day}|${e.side}`;
    const x = LEFT + i * PITCH;
    if (e.side === "unknown") { rule[i * PITCH + 1] = "?"; continue; }
    if (placed.has(key)) continue;
    placed.add(key);
    if (e.side === "you") { g.at(r, x, ` ${m} `, "you"); rule[i * PITCH + 1] = "┴"; }
    else { g.at(r + 2, x, ` ${m} `, "agent"); rule[i * PITCH + 1] = "┬"; }
  }
  g.at(r + 1, LEFT, rule.join(""), "rule");
  r += 3;

  // date labels: first, a week in, two weeks in, and the last (right-aligned to the strip)
  const pick = [0, 7, 14].filter((i) => i < days.length - 2);
  for (const i of pick) g.at(r, LEFT + i * PITCH, when(days[i]!.d, v.today).replace(/, \d{4}$/, ""), "muted");
  const lastLabel = when(last, v.today).replace(/, \d{4}$/, "");
  g.at(r, LEFT + days.length * PITCH - 1 - cols(lastLabel), lastLabel, "muted");
  r += 1;

  const [kName, nName] = STRIP_LABELS[strip.metric] ?? ["events", "opportunities"];
  g.at(r, 0, kName, "muted");
  g.at(r + 1, 0, nName, "muted");
  days.forEach((d, i) => {
    const k = d.n === 0 ? "–" : count(d.k);
    const n = count(d.n);
    g.at(r, LEFT + i * PITCH + 3 - cols(k), k);
    g.at(r + 1, LEFT + i * PITCH + 3 - cols(n), n, "muted");
  });
  r += 2;

  // window brackets: before | recent, from the windows the comparison used
  const w = a.windows;
  if (w !== null) {
    const split = days.findIndex((d) => d.d >= w.recent.from);
    const recentDays = split < 0 ? 0 : days.length - split;
    const baseDays = split < 0 ? days.length : split;
    if (baseDays > 0) bracket(g, r, LEFT, baseDays * PITCH, "before");
    if (recentDays > 0) bracket(g, r, LEFT + baseDays * PITCH, recentDays * PITCH, `recent, ${w.recent.days} days`);
    r += 1;
  }
  if (inView.length === 0) return r;
  r += 1;
  return legend(g, r, v, inView, mark, L, 0);
}

function bracket(g: Grid, r: number, x: number, width: number, label: string): void {
  if (width < 3) return;
  const body = ` ${label} `;
  if (cols(body) + 2 > width) {
    g.at(r, x, `└${"─".repeat(width - 2)}┘`, "muted");
    return;
  }
  const left = Math.floor((width - 2 - cols(body)) / 2);
  g.at(r, x, `└${"─".repeat(left)}${body}${"─".repeat(width - 2 - left - cols(body))}┘`, "muted");
}

/** One line per event: marker, date, label, then the side and what it lines up with. */
function legend(g: Grid, r0: number, v: View, events: readonly TimelineEvent[], mark: Map<string, string>, L: Layout, hidden: number): number {
  let r = r0;
  const shown = events.slice(-12);
  const earlier = events.length - shown.length + Math.max(0, hidden);
  if (earlier > 0) {
    g.at(r, LEFT, `${count(earlier)} earlier ${earlier === 1 ? "change" : "changes"} not shown; wasitme report lists them all`, "muted");
    r += 1;
  }
  const marked = mark.size > 0;
  let routine = false;
  for (const e of shown) {
    const m = mark.get(e.id);
    let x = LEFT;
    if (marked) {
      if (m !== undefined) {
        const party = e.side === "you" ? "you" : e.side === "agent" ? "agent" : null;
        if (party !== null) g.at(r, x, ` ${m} `, party);
        else g.at(r, x + 1, m, "plain");
      }
      x += 4;
    }
    g.at(r, x, when(e.day, v.today), "muted");
    x += 9;
    const side = SIDE_WORD[e.side] ?? "origin unknown";
    const tag = tagFor(v.a, e);
    const room = L.W - x;
    // The side and tag go at the right edge. When both do not fit beside the label, an EVIDENCE tag ("lines up with
    // the shift", "ruled out") is what the Finding rests on, so the label is cut to keep it (down to MIN_LABEL columns);
    // any other tag gives way to the label (a version row's label is its content).
    const full = tag === "" ? side : `${side} · ${tag}`;
    const evidence = /lines up with the shift|ruled out/.test(tag);
    const right = cols(e.label) + 2 + cols(full) <= room || (evidence && room - cols(full) - 2 >= MIN_LABEL) ? full : side;
    g.at(r, x, clip(e.label, Math.max(8, room - cols(right) - 2)));
    g.right(r, right, "muted");
    if (right.includes("routine update")) routine = true;
    r += 1;
  }
  // The footnote explains the "routine update" tag, so it is printed only when a row on screen carries it.
  if (routine) {
    g.at(r, LEFT, "Routine updates alone aren't evidence.", "muted");
    r += 1;
  }
  return r;
}

function finding(g: Grid, r0: number, v: View, L: Layout): number {
  const { a } = v;
  let r = r0;
  const face = findingFace(a, v.stale, v.ascii);
  g.at(r, 0, "Finding", "bold");
  // In ASCII the side's glyph is a bracketed word ("[you]") and its sticker prints in brackets too ("[Your side]"):
  // the sticker alone says it once.
  let x = LEFT;
  if (!(v.ascii && face.role !== null)) x = g.at(r, LEFT, face.glyph) + 1;
  if (face.role !== null) g.at(r, x, ` ${face.label} `, face.role);
  else g.at(r, x, face.label, "bold");
  r += 1;
  const width = L.W - LEFT;
  const put = (text: string, role: Role = "plain"): void => {
    for (const line of wrap(text, width)) { g.at(r, LEFT, line, role); r += 1; }
  };
  if (v.stale) {
    const was = a.reason === "calibration_pending" ? CALIBRATION_PENDING_WORDS.label : STATE_WORDS[a.state].label;
    put(`Last result, from ${v.doc.generatedAtMs !== null ? stamp(v.doc.generatedAtMs, v.tz) : "an unknown time"}: ${was}. Run wasitme scan to refresh.`, "plain");
    return r;
  }
  // D67: the title is the state (already printed), the deck (headline) is the one-sentence finding, and the note
  // (because) is the evidence. Every state prints the deck, then the note in the muted role.
  if (a.headline !== "") put(a.headline);
  if (a.pending) put("Possible shift — confirming", "plain");
  if (a.because !== "") put(a.because, "muted");
  r = progress(g, r, v, L);
  for (const s of sentences(a.confidence)) put(s, "muted");
  if (a.disclaimer !== null && a.disclaimer !== "") put(a.disclaimer, "muted");
  return r;
}

/** "Next to unlock": what an unqualified comparison is still missing, and the projected date when there is a stable one. */
function progress(g: Grid, r0: number, v: View, L: Layout): number {
  const { a } = v;
  const p = a.progress;
  if (p === null || a.state !== "insufficient" || a.reason === "calibration_pending") return r0;
  let r = r0;
  const width = L.W - LEFT;
  const put = (text: string): void => {
    for (const line of wrap(text, width)) { g.at(r, LEFT, line, "muted"); r += 1; }
  };
  // No comparison yet (windows null): the gate counts are all zero and say nothing; the headline already says what is missing.
  const waiting = a.windows === null ? [] : p.unlock.map((u) => {
    const name = metricWords(u.metric).name;
    // Every pair still short of its target, each in its own unit (a met pair is never shown as a count).
    const parts: string[] = [];
    const short = (unit: GateUnit) => u.need[unit] > 0 && u.need[unit] > u.have[unit];
    if (short("events")) parts.push(`${count(u.have.events)} of ${count(u.need.events)} ${gateNoun(u.metric, "events")}`);
    if (short("sessions")) parts.push(`${count(u.have.sessions)} of ${count(u.need.sessions)} sessions`);
    if (short("sessionDays")) parts.push(`${count(u.have.sessionDays)} of ${count(u.need.sessionDays)} session-days`);
    return { name, parts };
  }).filter((x) => x.parts.length > 0);
  const gaps = waiting.map((x) => x.name);
  if (waiting.length > 0) {
    const first = waiting[0]!;
    const others = waiting.slice(1).map((x) => x.name);
    put(`Next to unlock: ${first.name} (${first.parts.join(", ")})${others.length > 0 ? `, then ${others.join(" and ")}` : ""}.`);
  }
  // D66: no projected dates and no "not at your pace" claim in v1, even if a document carries them.
  if (gaps.length > 0 || a.windows === null) put("No date yet: it depends on how your sessions go.");
  return r;
}

/**
 * The one line a signals table carries when no comparison ran yet (not enough history): it explains the empty change
 * and range columns once, so the rows stay clean. The finding above already says how much history is missing.
 */
export const NO_COMPARISON_NOTE = "Change and range show once there is enough history to compare.";

/**
 * Why an ineligible row has no ratio, for its change cell; "" when there is no comparison yet (the table says that once,
 * NO_COMPARISON_NOTE). `max` is the cell's width: a gate count that does not fit drops its noun ("7 of 10 needed").
 */
export function ineligibleText(m: SnapshotMetric, a: SnapshotAgent, max = Number.POSITIVE_INFINITY): string {
  // With no comparison (not enough history yet) there are no gate counts worth showing: they would all read "0 of N".
  if (a.windows === null) return "";
  // The one binding pair, in its own unit (docs/CONTRACT.md#display-rules): "7 of 10 session-days needed".
  const g = bindingGate(a.progress?.unlock.find((x) => x.metric === m.id));
  if (g !== null) {
    const full = `${count(g.have)} of ${count(g.need)} ${gateNoun(m.id, g.unit)} needed`;
    return cols(full) <= max ? full : `${count(g.have)} of ${count(g.need)} needed`;
  }
  if (m.ineligibleReason === "too_few_events") return `only ${count(m.recent.k)} in the recent window`;
  return INELIGIBLE_TEXT[m.ineligibleReason ?? "no_data"] ?? "not enough data yet";
}

/**
 * The ledger's status word. Same rules as the words layer's `statusWords` (words.ts), in the mock-up's lower-case short
 * forms: a context indicator is always "context" (D30), an ineligible one is "not yet" (friction: "context"), and an
 * eligible voting or supporting one is "moved, more" / "moved, fewer" / "not detected".
 */
/** A row that cannot decide (context or support, D30: friction signals are always context) says "context" whatever it did. */
export function statusWord(m: SnapshotMetric): string {
  if (m.role !== "vote" || m.family === "friction") return "context";
  if (!m.eligible) return "not yet";
  if (m.status === "worse" || m.status === "better") return m.ratio !== null && m.ratio < 1 ? "moved, fewer" : "moved, more";
  return "not detected";
}

interface SignalCols {
  labelW: number;
  rEnd: number;
  bEnd: number;
  cStart: number;
  range: boolean;
  /** Cells per doubling on the forest plot (0: no plot). */
  per: number;
  aw: number;
  ax: number;
  st: number;
}

/**
 * Column positions for the ledger. The 100-column layout is the design's (recent and before right-aligned, change and
 * range, a forest plot at four cells per doubling, status). Narrower terminals give up, in this order: cells per
 * doubling (4 → 3 → 2), the plot, the range, label width.
 */
function signalCols(W: number, recentW: number, beforeW: number, changeFull: number): SignalCols {
  const stW = 12;
  const tries: [number, boolean, number][] = [
    [17, true, 4], [17, true, 3], [17, true, 2], [17, true, 0], [14, true, 3], [14, true, 2], [14, true, 0], [14, false, 0], [12, false, 0],
  ];
  let last: SignalCols | undefined;
  for (const [labelW, range, per] of tries) {
    const rEnd = labelW + 1 + recentW;
    const bEnd = rEnd + 2 + beforeW;
    const cStart = bEnd + 3;
    const cw = range ? changeFull : 6;
    const aw = per > 0 ? Math.round(Math.log2(32) * per) + 1 : 0;
    const ax = cStart + cw + 2;
    const st = per > 0 ? ax + aw + 2 : cStart + cw + 2;
    last = { labelW, rEnd, bEnd, cStart, range, per, aw, ax, st };
    if (st + stW <= W) return last;
  }
  return last!;
}

function signals(g: Grid, r0: number, v: View, L: Layout): number {
  const { a } = v;
  const ms = a.metrics.filter((m) => m.recent.n > 0 || m.baseline.n > 0).slice(0, 8);
  if (ms.length === 0) return r0;
  let r = r0;
  const recents = ms.map((m) => kn(m, "recent")), befores = ms.map((m) => kn(m, "baseline"));
  const recentW = Math.max(6, ...recents.map(cols)), beforeW = Math.max(6, ...befores.map(cols));
  const full = ms.map((m) => (m.eligible && m.ratio !== null && m.range !== null ? `${ratio2(m.ratio)}  ${rangeText(m.range[0], m.range[1])}` : ""));
  const C = signalCols(L.W, recentW, beforeW, Math.max(13, ...full.map(cols)));
  const changes = ms.map((m, i) => (C.range ? full[i]! : m.eligible && m.ratio !== null ? ratio2(m.ratio) : ""));
  const per = C.per;

  g.at(r, 0, "Signals", "bold");
  g.at(r, C.rEnd - 6, "recent", "muted");
  g.at(r, C.bEnd - 6, "before", "muted");
  g.at(r, C.cStart, C.range ? "change  range" : "change", "muted");
  const pos = (x: number): number => Math.max(0, Math.min(C.aw - 1, Math.round(Math.log2(x / 0.25) * per)));
  const plotted = per > 0 && ms.some((m) => m.eligible && m.ratio !== null && m.range !== null);
  if (plotted) {
    // axis labels: x1 first (the reference), then x2, x0.5, x4; a label that would touch another is left out
    const taken: [number, number][] = [];
    for (const t of [1, 2, 0.5, 4]) {
      const lab = `×${t}`;
      const x = C.ax + pos(t) - (cols(lab) > 2 ? 2 : 1);
      if (x < C.ax - 1 || taken.some(([a, b]) => x <= b + 1 && x + cols(lab) - 1 >= a - 1)) continue;
      taken.push([x, x + cols(lab) - 1]);
      g.at(r, x, lab, "muted");
    }
  }
  g.at(r, C.st, "status", "muted");
  r += 1;
  g.at(r, 0, "─".repeat(L.W), "rule");
  r += 1;
  ms.forEach((m, i) => {
    const label = wrap(m.label || metricWords(m.id).label, C.labelW);
    g.at(r, 0, label[0] ?? "");
    g.at(r, C.rEnd - cols(recents[i]!), recents[i]!);
    g.at(r, C.bEnd - cols(befores[i]!), befores[i]!);
    if (m.eligible && m.ratio !== null && m.range !== null) {
      g.at(r, C.cStart, changes[i]!);
      if (per > 0) {
        const plot = Array.from({ length: C.aw }, () => " ");
        const mde = m.mde ?? 1;
        for (let k = pos(1 / mde); k <= pos(mde); k++) plot[k] = "░";
        const lo = pos(m.range[0]), hi = pos(m.range[1]);
        for (let k = lo; k <= hi; k++) plot[k] = "─";
        // an end cap only where the range really ends; past the axis, an arrow at the edge (tokens chart.ratio.overflow)
        plot[lo] = m.range[0] < 0.25 ? "<" : "├";
        plot[hi] = m.range[1] > 8 ? ">" : "┤";
        plot[pos(1)] = plot[pos(1)] === "─" ? "┼" : "│";
        // The filled dot means "moved" (the legend); a context row never decides, so it keeps the open estimate dot.
        plot[pos(m.ratio)] = m.role === "vote" && (m.status === "worse" || m.status === "better") ? "●" : "○";
        g.at(r, C.ax, plot.join(""));
      }
      g.at(r, C.st, statusWord(m));
    } else {
      // At least two spaces before the status word, so "… needed" and "not yet" never read as one phrase.
      const cell = Math.max(8, C.st - C.cStart - 2);
      const why = ineligibleText(m, a, cell);
      if (why !== "") g.at(r, C.cStart, clip(why, cell), "muted");
      g.at(r, C.st, statusWord(m), "muted");
    }
    for (let k = 1; k < label.length; k++) { r += 1; g.at(r, 0, label[k]!); }
    r += 1;
  });
  // No comparison yet: said once for the whole table, not on every row.
  if (a.windows === null) {
    for (const line of wrap(NO_COMPARISON_NOTE, L.W)) { g.at(r, 0, line, "muted"); r += 1; }
    return r;
  }
  if (plotted) g.right(r, "○ estimate, not detected  ● moved  ├─┤ range  ░ too small to show", "muted");
  return r + (plotted ? 1 : 0);
}

function next(g: Grid, r0: number, v: View, L: Layout, platform: string): number {
  let r = r0;
  const width = L.W - LEFT;
  if (v.a.tryThis !== "" && !v.stale) {
    g.at(r, 0, "Next", "bold");
    for (const line of wrap(v.a.tryThis, width)) { g.at(r, LEFT, line); r += 1; }
  }
  g.at(r, 0, "Share", "bold");
  const clip_ = platform === "darwin" ? " | pbcopy" : "";
  const x = g.at(r, LEFT, `wasitme report --md${clip_}`);
  const note = "numbers only: no prompts, code or paths";
  if (x + 3 + cols(note) <= L.W) g.at(r, x + 3, note, "muted");
  else { r += 1; g.at(r, LEFT, note, "muted"); }
  return r + 1;
}

// ───────────────────────────── document ─────────────────────────────

function header(g: Grid, r: number, name: string, first: boolean, v: ReportDocView): number {
  if (first) {
    g.at(r, 0, "wasit");
    g.at(r, 5, "me", "ul");
  }
  const at = v.generatedAtMs !== null ? stamp(v.generatedAtMs, v.timeZone) : "an unknown time";
  const tail = v.stale ? `out of date · checked ${at}` : `checked ${at}`;
  g.right(r, `${name}   ${tail}`, "muted");
  g.at(r + 1, 0, "═".repeat(g.width), "rule");
  let y = r + 2;
  if (first && v.demo) {
    g.at(y, 0, "DEMO", "bold");
    g.at(y, LEFT, "analytic demo data run through the engine; not your logs", "muted");
    y += 1;
  }
  return y;
}

interface ReportDocView { demo: boolean; generatedAtMs: number | null; stale: boolean; timeZone: string }

function notice(g: Grid, r: number, text: string): number {
  let y = r;
  for (const line of wrap(text, g.width)) { g.at(y, 0, line); y += 1; }
  return y;
}

/**
 * ASCII mode spells the arrow "->": the grid's one-cell fallback ">" reads "2.1.266 > 2.1.270" as "greater than".
 * Done on the text before layout, so every width is computed on what is printed.
 */
function asciiArrows(doc: ReportDoc): ReportDoc {
  const arrow = (s: string): string => s.replace(/\s*→\s*/g, " -> ");
  return {
    ...doc,
    agents: doc.agents.map((a) => ({
      ...a,
      headline: arrow(a.headline), because: arrow(a.because), tryThis: arrow(a.tryThis), confidence: arrow(a.confidence), band: arrow(a.band),
      timeline: a.timeline.map((e) => ({ ...e, label: arrow(e.label) })),
      trace: a.trace.map((t) => ({ ...t, text: arrow(t.text) })),
    })),
  };
}

/** The terminal report for a document. Lines end in "\n"; the result is never empty. */
export function renderTerminal(input: ReportDoc, o: TerminalOptions): string {
  const doc = o.ascii ? asciiArrows(input) : input;
  const W = Math.max(64, Math.min(100, Math.floor(o.columns) || 100));
  const L: Layout = { W, X: LEFT };
  const g = new Grid(W);
  const stale = doc.display === "stale";
  const view: ReportDocView = { demo: doc.demo, generatedAtMs: doc.generatedAtMs, stale, timeZone: o.timeZone };
  const today = doc.generatedAtMs !== null ? new Date(doc.generatedAtMs).toISOString().slice(0, 10) : "";
  let r = 0;

  if (doc.display === "mismatch" || doc.display === "refused" || doc.agents.length === 0) {
    g.at(0, 0, "wasit");
    g.at(0, 5, "me", "ul");
    g.at(1, 0, "═".repeat(W), "rule");
    r = 2;
    r = notice(g, r, emptyReason(doc, o.roots).text);
    return `${g.render(o.mode, o.ascii).join("\n")}\n`;
  }

  const lead: Lead = o.lead ?? doc.lead;
  doc.agents.forEach((a, i) => {
    if (i > 0) r += 1;
    const name = agentName(a.agent);
    const v: View = { a, name, today, doc, stale, tz: o.timeZone, ascii: o.ascii };
    r = header(g, r, name, i === 0, view);
    if (!doc.scanOk && i === 0) {
      r = notice(g, r, `Last scan failed (${doc.scanError ?? "internal"}); showing the last good result. Run wasitme doctor to see why.`);
      r += 1;
    }
    const sections: ((r: number) => number)[] = lead === "verdict"
      ? [(y) => finding(g, y, v, L), (y) => signals(g, y, v, L), (y) => whatChanged(g, y, v, L)]
      : [(y) => whatChanged(g, y, v, L), (y) => finding(g, y, v, L), (y) => signals(g, y, v, L)];
    for (const s of sections) {
      const before = r;
      const after = s(r);
      r = after > before ? after + 1 : r;
    }
    r = next(g, r, v, L, o.platform);
  });
  return `${g.render(o.mode, o.ascii).join("\n")}\n`;
}
