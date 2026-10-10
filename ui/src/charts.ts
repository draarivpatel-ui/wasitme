/**
 * SVG charts as VNode trees (createElementNS at materialize time; no rAF, no measurement). A port of the design
 * system's own chart code (design/system/gen/screens/kit.mjs: strip, forest, forestAxis): integer daily ticks (one per
 * event) on the case line, your badges above, the agent's below, window brackets; and the one-line forest plot on the
 * shared log axis (×0.25–×8) with the too-small zone hatched. Colours come only from classes (components.css /
 * canvas.css / tokens.css).
 *
 * Badges (docs/design/UX-V2.md §7.1): one drawing per change, in charts, rows and legends alike. Yours: an 18 px
 * rounded square with the numeral; the agent's: an 18 × 20 rounded tag with a shallow point and the letter (filled when
 * the shift lines up with it or the change is agent-strong, hollow for a routine update); origin unknown: a dashed
 * circle with "?". The party grammar of D57 is unchanged: yours are square, numbered and above the rule; the agent's
 * are pointed, lettered and below it.
 *
 * Crowded lanes (UX-V2 §7.3): in a chart each lane holds at most one mark a day; several changes on a day, or on days
 * too close for their marks, become one wider range badge ("18–21", "X–Z") over the days it covers (`laneMarks`). A
 * change that lines up with the shift keeps its own badge, and its short label: beside the badge when there is room, else
 * in the legend line with its badge ("effort: lines up with the shift"). Changes of unknown origin are one faint tick a day on the
 * line. Rows, reports and the terminal still show every change with its own marker; the chart only groups them.
 */

import { CANVAS_COPY as T, CHART, GLYPHS } from "./gen/design.js";
import type { TEvent } from "./decode.js";
import { fdate, fill, frange } from "./format.js";
import { countWords, shortLabel } from "./derive.js";
import { h, s } from "./vnode.js";
import type { VNode } from "./vnode.js";

export type GlyphState = "insufficient" | "none" | "unclear" | "you" | "agent" | "stale";
/** The app's own document states (design tokens appStates): never a finding, drawn with "app:<state>" glyphs. */
export type AppGlyphState = "loading" | "notSetUp" | "empty" | "unreadable" | "updateNeeded" | "refused";

/** A state glyph (template image) drawn in currentColor; `box` is the CSS box class (g16 / g22). */
export function glyph(state: GlyphState | "mark" | `app:${AppGlyphState}`, px: 16 | 18, box: "g16" | "g22" = "g16"): VNode {
  const g = GLYPHS[`${state}-${px}`]!;
  return h("span", { cls: ["glyph", box], attrs: { "aria-hidden": "true" } },
    s("svg", { viewBox: `0 0 ${g.size} ${g.size}`, fill: "currentColor", focusable: "false" },
      g.shapes.map((sh) => s(sh.t, sh.a))));
}

/** The colour brand mark (square + triangle, no rule: never a state). */
export function brandMark(): VNode {
  return s("svg", { class: "mark", width: 22, height: 22, viewBox: "0 0 44 44", "aria-hidden": "true", focusable: "false" },
    s("rect", { class: "c-you", x: 3, y: 4, width: 20, height: 20, rx: 2, transform: "rotate(-5 13 14)", "stroke-width": 2 }),
    s("path", { class: "c-agent", d: "M31 21 L41.5 39.5 L20.5 39.5 Z", "stroke-width": 2, "stroke-linejoin": "round" }));
}

// ---------------------------------------------------------------------------------------------------------------
// badges
// ---------------------------------------------------------------------------------------------------------------

const BW = CHART.badge.you.width, BH = CHART.badge.you.height, AH = CHART.badge.agent.height, BR = CHART.badge.radius;
const r1 = (v: number) => String(Math.round(v * 10) / 10);

/** The agent's tag in its 18 × 20 box with the top-left corner at (x, y), in absolute coordinates (UX-V2 §7.1). A
 *  range (`w` wider than 18) is the same tag stretched: the point stays 3 px high, at the centre. */
export function agentPath(x: number, y: number, w: number = BW): string {
  const p = (px: number, py: number) => `${r1(x + px)} ${r1(y + py)}`;
  return `M${p(w / 2, 0.5)} L${p(w - 1.8, 3.6)} Q${p(w - 0.5, 4.2)} ${p(w - 0.5, 5.6)} V${r1(y + 15.5)} Q${p(w - 0.5, 19.5)} ${p(w - 4.5, 19.5)} `
    + `H${r1(x + 4.5)} Q${p(0.5, 19.5)} ${p(0.5, 15.5)} V${r1(y + 5.6)} Q${p(0.5, 4.2)} ${p(1.8, 3.6)} Z`;
}

/** The shapes of one badge with its box's top-left corner at (x, y); `label` "" draws the shape alone (legends); `w`
 *  wider than 18 draws a range ("18–21"). */
function badgeShapes(side: "you" | "agent" | "unknown", filled: boolean, x: number, y: number, label: string, w: number = BW): VNode[] {
  if (side === "you") {
    return [s("rect", { class: "c-you", x: x + 0.5, y: y + 0.5, width: w - 1, height: BH - 1, rx: BR }),
      label ? s("text", { class: "c-mk-text", x: x + w / 2, y: y + 13, "text-anchor": "middle" }, label) : null].filter((n): n is VNode => n !== null);
  }
  if (side === "agent") {
    return [s("path", { class: filled ? "c-agent" : "c-agent-routine", d: agentPath(x, y, w) }),
      label ? s("text", { class: filled ? "c-mk-text" : "c-mk-text-2", x: x + w / 2, y: y + 16, "text-anchor": "middle" }, label) : null].filter((n): n is VNode => n !== null);
  }
  return [s("circle", { class: "c-unknown", cx: x + BW / 2, cy: y + BH / 2, r: BW / 2 - 0.5 }),
    label ? s("text", { class: "c-mk-text-2", x: x + BW / 2, y: y + 13, "text-anchor": "middle" }, label) : null].filter((n): n is VNode => n !== null);
}

/** "your change 1, Sep 21: Effort high → medium" / "Claude Code change D, Oct 1: Claude Code 2.1.277 → 2.1.281": who,
 *  which mark, when, and the engine's full label (never the short one). */
export function badgeName(e: TEvent, agentName: string): string {
  const who = e.side === "you" ? fill(T.badge.you, { marker: e.marker ?? "" })
    : e.side === "agent" ? fill(T.badge.agent, { agent: agentName, marker: e.marker ?? "" })
      : e.side === "unknown" ? T.badge.unknown : T.badge.meta;
  return `${who}, ${fdate(e.day)}${e.label ? `: ${e.label}` : ""}`;
}

/** A change's badge in a row: one named image (role img, the full label as its name and hover tip). */
export function badge(e: TEvent, filled: boolean, agentName: string): VNode | null {
  if (!e.marker || (e.side !== "you" && e.side !== "agent" && e.side !== "unknown")) return null;
  const name = badgeName(e, agentName);
  const tall = e.side === "agent" ? AH : BH;
  const fillIt = e.side === "agent" && (filled || e.strength !== "routine");
  return h("span", { cls: ["bdg", `bdg--${e.side}`], attrs: { role: "img", "aria-label": name, title: name } },
    s("svg", { class: "badge", width: BW, height: tall, viewBox: `0 0 ${BW} ${tall}`, "aria-hidden": "true", focusable: "false" },
      badgeShapes(e.side, fillIt, 0, 0, e.marker)));
}

/** A legend's sample: the real 18 px shape, unlabelled (badges are never scaled down) unless it names one change (`mark`,
 *  drawn as on the chart); a range at a typical width; the unknown-origin tick on a piece of the case line. */
function sample(kind: LegendKind, mark = ""): VNode {
  const svg = (w: number, ht: number, kids: VNode[]) =>
    s("svg", { class: "badge", width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, "aria-hidden": "true", focusable: "false" }, kids);
  if (kind === "tick") return svg(10, 14, [s("rect", { class: "c-tick", x: 0, y: 6, width: 10, height: CHART.strip.tickHeight })]);
  if (kind === "unknownTick") {
    return svg(14, 14, [s("line", { class: "c-axis", x1: 0, y1: 8, x2: 14, y2: 8 }), s("line", { class: "c-unknown-tick", x1: 7, y1: 2, x2: 7, y2: 11 })]);
  }
  const side = kind === "you" || kind === "youGroup" ? "you" : kind === "unknown" ? "unknown" : "agent";
  const w = kind === "youGroup" || kind === "agentGroup" ? RANGE_SAMPLE : mark ? markWidth(mark) : BW, tall = side === "agent" ? AH : BH;
  return svg(w, tall, badgeShapes(side, kind === "agentFilled", 0, 0, mark, w));
}

export type LegendKind = "tick" | "you" | "youGroup" | "agent" | "agentGroup" | "agentFilled" | "unknown" | "unknownTick";
/** `mark`: the item names one change, its badge drawn with its own marker beside "effort: lines up with the shift";
 *  `name` is that badge's accessible name ("your change 26"), as a row's badge has (`badge`). */
export interface LegendItem { kind: LegendKind; text: string; mark?: string; name?: string }

/** One line under a chart, built from what the chart actually shows (UX-V2 §7.3). */
export function legend(items: LegendItem[]): VNode | null {
  if (!items.length) return null;
  return h("p", { cls: "legend" }, items.map((it) => h("span", { cls: "lg" },
    it.name ? h("span", { cls: "bdg", attrs: { role: "img", "aria-label": it.name } }, sample(it.kind, it.mark)) : sample(it.kind, it.mark),
    h("span", null, it.text))));
}

// ---------------------------------------------------------------------------------------------------------------
// forest plot
// ---------------------------------------------------------------------------------------------------------------

const D = CHART.ratio.domain;
const LOG = (v: number, w: number) => (Math.log(v / D[0]) / Math.log(D[1] / D[0])) * w;

/** One-line forest plot: MDE zone (hatched), the ×1 line, the range (open arrowheads past the axis), the estimate. */
export function forest(o: { ratio: number | null; range: [number, number] | null; mde: number | null; moved: boolean }, w = 220, ht = 22): VNode {
  const cy = ht / 2;
  const X = (v: number) => Math.max(0, Math.min(w, LOG(v, w)));
  const kids: VNode[] = [];
  if (o.mde) {
    const a = X(1 / o.mde), b = X(o.mde);
    kids.push(s("rect", { class: "c-mde", x: a, y: cy - 6, width: b - a, height: 12 }));
    for (let x = Math.ceil(a / 5) * 5 - 12; x < b; x += 5) {
      const x1 = Math.max(a, x), x2 = Math.min(b, x + 12);
      if (x2 <= x1) continue;
      const y1 = cy + 6 - (x1 - x), y2 = cy + 6 - (x2 - x);
      kids.push(s("line", { class: "c-mde-hatch", x1, y1: Math.min(cy + 6, y1), x2, y2: Math.max(cy - 6, y2) }));
    }
  }
  kids.push(s("line", { class: "c-one", x1: X(1), y1: 1, x2: X(1), y2: ht - 1 }));
  if (o.range) {
    const a = X(o.range[0]), b = X(o.range[1]);
    kids.push(s("line", { class: "c-range", x1: a, y1: cy, x2: b, y2: cy }));
    const end = (x: number, past: boolean, dir: number) => past
      ? s("path", { class: "c-range-over", d: `M${(x - dir * 6).toFixed(1)} ${cy - 4} L${x.toFixed(1)} ${cy} L${(x - dir * 6).toFixed(1)} ${cy + 4}` })
      : s("line", { class: "c-range", x1: x, y1: cy - 4, x2: x, y2: cy + 4 });
    kids.push(end(a, o.range[0] < D[0], -1), end(b, o.range[1] > D[1], 1));
  }
  if (o.ratio !== null && o.ratio > 0) kids.push(s("circle", { class: o.moved ? "c-est" : "c-est-open", cx: X(o.ratio), cy, r: 3.5 }));
  // aria-hidden: the row prints the same numbers as text
  return s("svg", { class: "chart", width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, "aria-hidden": "true", focusable: "false" }, kids);
}

export function forestAxis(w = 220): VNode[] {
  return [
    h("span", { cls: "sr" }, T.ledger.axis),
    s("svg", { class: "chart", width: w, height: 14, viewBox: `0 0 ${w} 14`, "aria-hidden": "true", focusable: "false" },
      CHART.ratio.ticks.map((v) => s("text", { class: "c-label", x: LOG(v, w), y: 11, "text-anchor": "middle" }, `×${v}`))),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// markers on a lane: one per day, ranges when days collide (UX-V2 §7.3, "Crowded lanes")
// ---------------------------------------------------------------------------------------------------------------

/** The gap between two marks on a lane, and the mono label face's width per character (type-typed-sm, 12 px: 0.6 em,
 *  rounded up). */
const GAP = 2, CHAR_W = 7.3;
/** A range's sample width in the legend: what "1–3" takes. */
const RANGE_SAMPLE = 28;

/** One mark on a lane: a change's own badge, or a range for consecutive changes on one day or on neighbouring days. */
export interface LaneMark {
  /** The changes it stands for, oldest first: consecutive markers on the lane (a range never skips one). */
  members: TEvent[];
  /** The members' distinct days, oldest first. */
  days: string[];
  /** Lines up with the shift: never part of a range, keeps its own number at its own day. */
  hit: boolean;
  /** Never part of a range, held at its day: a change that lines up with the shift, or an agent's change that isn't
   *  a routine update (the agent-side finding's own cause, drawn filled). */
  pinned: boolean;
  /** Yours always; the agent's when it lines up with the shift or holds a change that isn't a routine update. */
  filled: boolean;
  /** The marker, or "first–last" for a range ("18–21", "X–Z"). */
  text: string;
  /** Box width: 18, wider for a range or a marker of three or more characters. */
  w: number;
  /** Its days' x span (the left edges of their slots); its centre wants to sit in the middle. */
  lo: number;
  hi: number;
  /** The box's left edge as placed. */
  x: number;
}

/** A mark's box width: the 18 px badge for one or two characters, else the text plus 3 px each side. */
export function markWidth(text: string): number {
  const n = Array.from(text).length;
  return n <= 2 ? BW : Math.ceil(n * CHAR_W + 6);
}

/** How far two marks may overlap and still be nudged apart instead of merged, and how far a mark may sit from its days
 *  before it joins its neighbour: half a badge. */
const NUDGE = 4, SLACK = BW / 2;

/**
 * Lays out one lane's marks, so a lane stays readable at any number of changes (the strip's text description, its hover
 * tips, the change lists and the report still name every change with its own marker; the chart only groups them):
 *
 * 1. One mark per day. A day's changes form one range ("18–21"), except a pinned change (one that lines up with the
 *    shift, or an agent's change that isn't a routine update), which keeps its own badge; the day's other changes
 *    before and after it form their own ranges, so a range's markers are always consecutive and its label never claims
 *    a change drawn elsewhere.
 * 2. Neighbouring marks whose boxes would overlap by more than a nudge (4 px, with the 2 px gap) merge into one range
 *    over their days, left to right, again with the mark before, until none does (a pinned mark never merges). Two
 *    badges on neighbouring days that nearly fit (the 42-day chart's 18.9 px days) stay two, nudged apart.
 * 3. The marks are placed with the least movement that keeps the gap (weighted pool-adjacent-violators on the left
 *    edges; a pinned mark weighs 1000 to 1, so it moves a hundredth of a pixel, and two pinned marks on one day sit
 *    side by side), between `minLeft` and `maxRight` (a lane wider than its room is held at the left and runs past the
 *    right). While a mark then sits more than half a badge from its days (nudges add up along a run, or a range is
 *    pushed aside by a pinned badge), it joins the neighbour that pushed it, and the lane is placed again. Every merge
 *    removes a mark and every mark that can't merge is set aside, so the loop ends.
 *
 * `events` are the lane's changes in view, oldest first (marker order); `edge` gives a day's x (the left edge of its
 * slot). Days that go backward in that order (a clock reset) still draw truthfully, only less grouped: a range keeps
 * consecutive markers and its comb reaches each of its real days.
 */
export function laneMarks(events: TEvent[], side: "you" | "agent", hits: Set<string>, edge: (d: string) => number, minLeft: number, maxRight: number): LaneMark[] {
  const pin = (e: TEvent) => hits.has(e.id) || (side === "agent" && e.strength !== "routine");
  const mark = (members: TEvent[]): LaneMark => {
    const days = [...new Set(members.map((e) => e.day))].sort();
    const xs = days.map(edge);
    const text = members.length === 1 ? members[0]!.marker ?? "" : `${members[0]!.marker ?? ""}–${members[members.length - 1]!.marker ?? ""}`;
    const hit = members.length === 1 && hits.has(members[0]!.id), pinned = members.length === 1 && pin(members[0]!);
    return { members, days, hit, pinned, filled: side === "you" || hit || members.some((e) => e.strength !== "routine"), text, w: markWidth(text),
      lo: Math.min(...xs), hi: Math.max(...xs), x: 0 };
  };
  const days: LaneMark[] = [];
  let run: TEvent[] = [];
  const flush = () => { if (run.length) days.push(mark(run)); run = []; };
  for (const e of events) {
    if (pin(e)) { flush(); days.push(mark([e])); continue; }
    if (run.length && run[0]!.day !== e.day) flush();
    run.push(e);
  }
  flush();
  let out: LaneMark[] = [];
  for (const m of days) {
    out.push(m);
    while (out.length >= 2) {
      const b = out[out.length - 1]!, a = out[out.length - 2]!;
      if (a.pinned || b.pinned || (b.lo + b.hi) / 2 - (a.lo + a.hi) / 2 >= (a.w + b.w) / 2 + GAP - NUDGE) break;
      out.splice(-2, 2, mark([...a.members, ...b.members]));
    }
  }
  const off = (m: LaneMark) => { const mid = m.x + m.w / 2; return mid < m.lo ? m.lo - mid : mid > m.hi ? mid - m.hi : 0; };
  const stuck = new Set<LaneMark>();
  for (;;) {
    place(out, minLeft, maxRight);
    let worst = -1, most = SLACK;
    out.forEach((m, i) => { if (!m.pinned && !stuck.has(m) && off(m) > most) { most = off(m); worst = i; } });
    if (worst < 0) return out;
    const m = out[worst]!, right = m.x + m.w / 2 > m.hi;
    const j = (right ? [worst - 1, worst + 1] : [worst + 1, worst - 1]).find((k) => k >= 0 && k < out.length && !out[k]!.pinned);
    if (j === undefined) { stuck.add(m); continue; }
    const [a, b] = j < worst ? [out[j]!, m] : [m, out[j]!];
    out = [...out.slice(0, Math.min(worst, j)), mark([...a.members, ...b.members]), ...out.slice(Math.max(worst, j) + 1)];
  }
}

/** Places marks in their order with a 2 px gap and the least movement from the middle of their days (weighted
 *  pool-adjacent-violators: left edges x_i = y_i + offset_i, y non-decreasing), pinned marks weighted to stay put; held
 *  between `minLeft` and `maxRight` (too little room: held at the left). */
function place(marks: LaneMark[], minLeft: number, maxRight: number): void {
  if (!marks.length) return;
  const offs: number[] = [];
  let acc = 0;
  for (const m of marks) { offs.push(acc); acc += m.w + GAP; }
  const blocks: { sum: number; wt: number; n: number }[] = [];
  marks.forEach((m, i) => {
    const wt = m.pinned ? 1000 : 1;
    blocks.push({ sum: ((m.lo + m.hi) / 2 - m.w / 2 - offs[i]!) * wt, wt, n: 1 });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1]!, a = blocks[blocks.length - 2]!;
      if (a.sum / a.wt <= b.sum / b.wt) break;
      blocks.splice(-2, 2, { sum: a.sum + b.sum, wt: a.wt + b.wt, n: a.n + b.n });
    }
  });
  const last = marks.length - 1, hiY = maxRight - marks[last]!.w - offs[last]!;
  let i = 0;
  for (const b of blocks) {
    const y = Math.max(minLeft, Math.min(hiY, b.sum / b.wt));
    for (let k = 0; k < b.n; k++, i++) marks[i]!.x = y + offs[i]!;
  }
}

/** A mark's hover tip: a badge's own name, or "your changes 18–21, Sep 21 – Sep 22: 18 MCP server added; …". */
export function markName(m: LaneMark, side: "you" | "agent", agentName: string): string {
  if (m.members.length === 1) return badgeName(m.members[0]!, agentName);
  const who = side === "you" ? fill(T.badge.youGroup, { range: m.text }) : fill(T.badge.agentGroup, { agent: agentName, range: m.text });
  const when = m.days.length === 1 ? fdate(m.days[0]!) : frange(m.days[0]!, m.days[m.days.length - 1]!);
  return `${who}, ${when}: ${m.members.map((e) => `${e.marker} ${e.label}`).join("; ")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// the strip on the case line
// ---------------------------------------------------------------------------------------------------------------

export interface StripOptions {
  /** The days in view, oldest first. */
  days: string[];
  /** Daily k/n for those days (gaps already filled with n = 0), or null for an events-only strip. */
  rows: { d: string; k: number; n: number; out?: boolean }[] | null;
  /** All change events; those inside the view are drawn. */
  events: TEvent[];
  /** Event ids that line up with the shift (drawn filled, joined to the data by a solid line). */
  hits: Set<string>;
  /** Index of the first recent-window day in `days` (0 = no "before" bracket). */
  recentStart: number;
  baseDays: number | null;
  recentDays: number | null;
  /** Whether brackets are drawn (needs comparison windows). */
  brackets: boolean;
  agentName: string;
  /** The metric's own label ("Tool errors (excl. commands)"): what the chart's text summary says it shows. */
  title?: string;
  kLabel: string;
  nLabel: string;
  width?: number;
  gutter?: number;
  /** The k and n rows under the strip (off by default: the day-level counts sit in "Daily counts", UX-V2 §13 P3). */
  kRow?: boolean;
  nRow?: boolean;
  /** Lane labels ("Your side", the agent's name) in the gutter. */
  labels?: boolean;
  /** Which badges get a short label: "all" try (the Timeline; the collision rule decides), "key" only yours, the filled
   *  agent badges and the newest agent update (the Finding page, UX-V2 §7.3). */
  markLabels?: "all" | "key";
  /** The legend line under the chart (UX-V2 §7.3). */
  legend?: boolean;
  /** "lines up with the shift" (a side was found) or "a candidate", for a filled agent badge in the legend. */
  hitWords?: string;
  /** The case line drawn dashed: too early to tell (DESIGN.md, the case line). */
  dashed?: boolean;
  today?: boolean;
  windowLabel?: string;
  /** Unique id for the hidden description. */
  uid: string;
}

/** The evidence strip on the case line. Returns the SVG, its hidden description paragraph and, unless `legend` is
 *  false, the legend line. */
export function strip(o: StripOptions): VNode[] {
  const width = o.width ?? 960, gutter = o.gutter ?? 104, kRow = o.kRow ?? false, nRow = o.nRow ?? false;
  const labels = o.labels ?? true, today = o.today ?? true, mode = o.markLabels ?? "all";
  const ticks = o.rows !== null;
  const rows: { d: string; k: number; n: number; out?: boolean }[] = o.rows ?? o.days.map((d) => ({ d, k: 0, n: 0 }));
  const S = CHART.strip;
  const x0 = gutter, x1 = width - 64, pitch = (x1 - x0) / Math.max(1, rows.length);
  const colW = Math.min(S.columnWidth, pitch - 4);
  const maxK = Math.max(10, ...rows.map((r) => r.k));
  const dense = maxK > S.denseAbove;
  const th = dense ? S.denseTickHeight : S.tickHeight, unit = th + (dense ? S.denseTickGap : S.tickGap);
  // A column never grows past maxTicks (a day of thousands of events must not make a thousand-pixel strip, or a page of
  // thousands of nodes): `top` is the tallest column drawn, and a column that holds more ends in an open arrowhead.
  const top = Math.min(Math.ceil(maxK / 5) * 5, S.maxTicks), stripH = !ticks ? 18 : Math.max(42, top * unit);
  const yTop = 30, yA = yTop + stripH;
  const yYou = 6, yAgent = yA + 3;                    // badge boxes: yours 6..24 above, the agent's yA+3..yA+23 below
  const labY = { you: yYou + 13, agent: yAgent + 16 }; // label baselines, level with the badge's own letter
  const idx = new Map<string, number>(rows.map((r, i) => [r.d, i]));
  const dayX = (d: string) => x0 + (idx.get(d) ?? 0) * pitch;
  const out: VNode[] = [];

  // grid lines every 10 events
  for (let v = 10; ticks && v <= top; v += 10) {
    const y = yA - v * unit;
    out.push(s("line", { class: "c-grid", x1: x0, y1: y, x2: x1, y2: y }), s("text", { class: "c-label", x: x0 - 8, y: y + 4, "text-anchor": "end" }, String(v)));
  }
  // ticks: one per event; a day under the low-n threshold is drawn half width (a shape cue, not a colour)
  if (ticks) rows.forEach((r, i) => {
    const cx = x0 + i * pitch + (pitch - colW) / 2;
    if (r.n === 0) return;
    if (r.k === 0) { out.push(s("rect", { class: "c-zero", x: cx + colW / 2 - 1, y: yA - 3, width: 2, height: 2 })); return; }
    const low = r.n < S.lowNThreshold;
    for (let j = 0; j < Math.min(r.k, top); j++) {
      const y = yA - (j + 1) * unit;
      out.push(low ? s("rect", { class: "c-tick", x: cx + colW / 4, y, width: colW / 2, height: th })
        : s("rect", { class: "c-tick", x: cx, y, width: colW, height: th }));
    }
    // past the cap: an open arrowhead above the column's last tick (DESIGN.md §8, as a forest range that runs off its axis);
    // the day's exact count is in its hover tip, the k row and the text description
    if (r.k > top) {
      const mid = cx + colW / 2, hw = (low ? colW / 4 : colW / 2) - 1;
      out.push(s("path", { class: "c-tick-over", d: `M${(mid - hw).toFixed(1)} ${yTop - 2} L${mid.toFixed(1)} ${yTop - 6} L${(mid + hw).toFixed(1)} ${yTop - 2}` }));
    }
  });
  // per-day hover tooltips (date, k, n, changes that day)
  const dayWords = (r: { k: number; n: number; out?: boolean }) => r.out ? T.chart.outside : r.n === 0 ? T.chart.noSessions
    : fill(T.chart.dayCounts, { k: countWords(r.k, o.kLabel), n: countWords(r.n, o.nLabel) });
  if (ticks) rows.forEach((r, i) => {
    const evs = o.events.filter((e) => e.day === r.d && e.marker);
    const tip = `${fdate(r.d)}: ${dayWords(r)}${evs.length ? `; ${evs.map((e) => `${e.marker} ${e.label}`).join("; ")}` : ""}`;
    out.push(s("rect", { class: "c-hit", fill: "transparent", x: x0 + i * pitch, y: yTop - 4, width: pitch, height: stripH + 4 }, s("title", null, tip)));
  });

  // events in view: each lane laid out by laneMarks (one mark per day, ranges where days collide), then labelled per
  // cluster on its outer side; changes of unknown origin as one faint tick per day on the line
  const first = rows[0]?.d ?? "", last = rows[rows.length - 1]?.d ?? "";
  const inView = o.events.filter((e) => e.marker && e.day >= first && e.day <= last);
  const edge = (d: string) => dayX(d) - 0.5;   // the left edge of the day's slot, as the design kit draws it (kit.mjs dayX)
  // a mark keeps clear of the lane label in the gutter (right-aligned at x0 − 12) and of the chart's right end
  const lanes = {
    you: laneMarks(inView.filter((e) => e.side === "you"), "you", o.hits, edge, x0 - 10, width - 2),
    agent: laneMarks(inView.filter((e) => e.side === "agent"), "agent", o.hits, edge, x0 - 10, width - 2),
  };
  const unknownDays = [...new Set(inView.filter((e) => e.side === "unknown").map((e) => e.day))];
  // Labels never collide: each is placed only where it overlaps no badge on its row, no label placed before it, and
  // not the lane label in the gutter (right-aligned at x0 − 12, so labels start at x0 − 8 at the earliest), nor
  // runs off the chart. A label with no free spot is dropped; its badge stays, and the change is still in the hover
  // tip, the change list and the chart's text description. (An agent can ship an update every two days.) A lined-up
  // change's label is placed first, and when even it finds no spot, the legend line names it with its badge.
  const minLeft = x0 - 8, maxRight = width - 2;
  const yComb = yYou + BH + 4;   // a range's connectors meet here, under its box and above the strip's top
  // A change that lines up with the shift but whose label found no room on its row (a crowded day, ranges abutting it
  // on both sides): the legend names it instead, with its own badge, so the change the headline names keeps its words.
  const unlabelled: { side: "you" | "agent"; m: LaneMark }[] = [];
  for (const side of ["you", "agent"] as const) {
    const L = lanes[side];
    const taken: [number, number][] = L.map((m) => [m.x - 2, m.x + m.w + 2]);
    const free = ([a, b]: [number, number]) => a >= minLeft && b <= maxRight && taken.every(([l, r]) => b <= l || a >= r);
    // marks that abut (2 px apart) form a cluster: labelled on its outer sides only
    const abuts = (i: number) => i > 0 && L[i]!.x - (L[i - 1]!.x + L[i - 1]!.w) < GAP + 0.5;
    L.forEach((m) => {
      const mid = m.x + m.w / 2, legs = m.days.map(edge), y0 = side === "you" ? yYou : yAgent;
      const kids: VNode[] = [s("title", null, markName(m, side, o.agentName))];
      const aligned = legs.length === 1 && Math.abs(mid - legs[0]!) < 1.5;   // a nudge of a pixel needs no elbow
      if (side === "you") {
        if (m.hit || aligned) kids.push(s("line", { class: m.hit ? "c-conn-hit" : "c-conn", x1: legs[0]!, y1: yYou + BH + 2, x2: legs[0]!, y2: yA }));
        else {
          // a range (or a mark moved off its day): a comb, from under the box to the line at each of its days
          const lo = Math.min(mid, ...legs), hi = Math.max(mid, ...legs);
          kids.push(s("line", { class: "c-conn", x1: mid, y1: yYou + BH + 1, x2: mid, y2: yComb }), s("line", { class: "c-conn", x1: lo, y1: yComb, x2: hi, y2: yComb }),
            ...legs.map((x) => s("line", { class: "c-conn", x1: x, y1: yComb, x2: x, y2: yA })));
        }
      } else if (m.hit) kids.push(s("line", { class: "c-conn-hit", x1: legs[0]!, y1: yTop, x2: legs[0]!, y2: yA }));
      else if (!aligned) {
        // the agent's lane has no connectors: a range marks the days it covers on the underside of the line
        const lo = Math.min(mid, ...legs), hi = Math.max(mid, ...legs);
        kids.push(s("rect", { class: "c-agent-span", x: lo - 1, y: yA + 1, width: hi - lo + 2, height: 2 }));
      }
      kids.push(...badgeShapes(side, m.filled, m.x, y0, m.text, m.w));
      out.push(s("g", { class: "c-mark" }, kids));
    });
    // labels, a lined-up change's first (so a neighbour's label never takes its room), then left to right
    const order = L.map((_, i) => i).sort((i, j) => Number(L[j]!.hit) - Number(L[i]!.hit) || i - j);
    for (const i of order) {
      const m = L[i]!;
      if (mode === "key" && side === "agent" && !m.filled && i !== L.length - 1) continue;
      // a lone badge's label on its right, else its left; a range of yours says its kinds when it has one or two, the
      // agent's its newest version
      const kinds = [...new Set(m.members.map(shortLabel))];
      const label = side === "agent" ? shortLabel(m.members[m.members.length - 1]!) : kinds.length <= 2 ? kinds.join(", ") : "";
      if (!label) continue;
      const need = Array.from(label).length * CHAR_W, before = abuts(i), after = i < L.length - 1 && abuts(i + 1);
      const right: [number, number] = [m.x + m.w + 5, m.x + m.w + 5 + need], left: [number, number] = [m.x - 6 - need, m.x - 6];
      const tries = before && after ? [] : after ? [left] : before ? [right] : [right, left];
      const spot = tries.find(free);
      if (!spot) { if (m.hit) unlabelled.push({ side, m }); continue; }
      taken.push([spot[0] - 4, spot[1] + 4]);
      out.push(spot === right ? s("text", { class: "c-label-2", x: right[0], y: labY[side] }, label)
        : s("text", { class: "c-label-2", x: m.x - 6, y: labY[side], "text-anchor": "end" }, label));
    }
  }

  // the case line itself
  out.push(s("line", { class: o.dashed ? "c-axis-dash" : "c-axis", x1: x0 - 4, y1: yA, x2: x1, y2: yA }));
  if (today) out.push(s("line", { class: "c-today", x1: x1 + 4, y1: yA, x2: x1 + 40, y2: yA }));
  // changes of unknown origin sit ON the line, neither above (yours) nor below (the agent's): one faint tick a day, in
  // the gap between the day's column and the one before (clear of a connector at the day's edge and of the agent's point)
  for (const d of unknownDays) out.push(s("line", { class: "c-unknown-tick", x1: edge(d) + 2, y1: yA - 6, x2: edge(d) + 2, y2: yA + 3 }));
  if (labels) out.push(s("text", { class: "c-side", x: x0 - 12, y: labY.you, "text-anchor": "end" }, T.chart.yourSide),
    s("text", { class: "c-side", x: x0 - 12, y: labY.agent, "text-anchor": "end" }, o.agentName));

  // k / n rows (only where asked: Compare's day-by-day halves)
  let y = yAgent + AH + 2;
  const yk = ticks && kRow ? (y += 19) : null;
  const yn = ticks && nRow ? (y += yk === null ? 19 : 15) : null;
  if (labels && yk !== null) out.push(s("text", { class: "c-label", x: x0 - 12, y: yk, "text-anchor": "end" }, o.kLabel));
  if (labels && yn !== null) out.push(s("text", { class: "c-label", x: x0 - 12, y: yn, "text-anchor": "end" }, o.nLabel));
  if (yk !== null || yn !== null) rows.forEach((r, i) => {
    if (r.out) return;
    const cx = x0 + i * pitch + pitch / 2;
    if (yk !== null) out.push(s("text", { class: r.n === 0 ? "c-label" : "c-label-ink", x: cx, y: yk, "text-anchor": "middle" }, r.n === 0 ? "–" : String(r.k)));
    if (yn !== null) out.push(s("text", { class: "c-label", x: cx, y: yn, "text-anchor": "middle" }, String(r.n)));
  });
  // dates + window brackets
  const yd = y + 19;
  rows.forEach((r, i) => {
    const isLast = i === rows.length - 1;
    if ((i % 7 === 0 && rows.length - 1 - i >= 3) || isLast) {
      out.push(s("text", { class: "c-label", x: isLast ? x1 : x0 + i * pitch + pitch / 2, y: yd, "text-anchor": isLast ? "end" : "middle" }, fdate(r.d)));
    }
  });
  if (today) out.push(s("text", { class: "c-label", x: x1 + 8, y: yd }, T.chart.today));
  const yb = yd + 6, rb = x0 + o.recentStart * pitch;
  const br = (a: number, b: number, label: string) => [
    s("path", { class: "c-bracket", d: `M${a + 2} ${yb} v5 H${b - 2} v-5` }),
    s("text", { class: "c-side", x: (a + b) / 2, y: yb + 19, "text-anchor": "middle" }, label),
  ];
  let H = yd + 8;
  if (o.brackets) {
    if (o.recentStart > 0) {
      const baseDays = o.baseDays ?? o.recentStart;
      out.push(...br(x0, rb, o.recentStart < baseDays ? fill(T.chart.beforePart, { shown: o.recentStart, days: baseDays }) : fill(T.chart.before, { days: baseDays })));
    }
    out.push(...br(rb, x1, o.windowLabel ?? fill(T.chart.recent, { days: o.recentDays ?? rows.length - o.recentStart })));
    H = yb + 24;
  }

  // accessible summary (role=img label) plus every day's k and n and every marked change in a hidden description
  const sum = rows.reduce((acc, r) => [acc[0]! + r.k, acc[1]! + r.n], [0, 0]);
  const span = rows.length ? `${fdate(first)} to ${fdate(last)}` : "";
  const evText = inView.map((e) => `${e.side === "you" ? T.legend.you : e.side === "agent" ? fill(T.legend.agentChange, { agent: o.agentName }) : T.badge.unknown} ${e.marker} on ${fdate(e.day)}: ${e.label}`).join("; ");
  const marked = inView.length ? fill(T.chart.summaryMarked, { changes: countWords(inView.length, "changes") }) : "";
  const aria = ticks
    ? `${fill(T.chart.summary, { title: o.title ?? o.kLabel, span, k: countWords(sum[0]!, o.kLabel), n: countWords(sum[1]!, o.nLabel) })}${marked}`
    : `${fill(T.chart.summaryEvents, { span })}${inView.length ? `: ${countWords(inView.length, "changes")} marked` : T.chart.summaryNone}`;
  const desc = [ticks ? rows.map((r) => `${fdate(r.d)}: ${dayWords(r)}`).join("; ") : "", evText].filter(Boolean).join(". ");
  const did = `strip-desc-${o.uid}`;
  const res: VNode[] = [
    s("svg", { class: "chart chart--strip", width, height: H, viewBox: `0 0 ${width} ${H}`, role: "img", "aria-label": aria, "aria-describedby": did, focusable: "false" }, out),
    h("p", { attrs: { hidden: true, id: did } }, desc || T.chart.noDays),
  ];
  if (o.legend ?? true) {
    const items: LegendItem[] = [];
    const unitOne = countWords(1, o.kLabel).replace(/^1 /, "");
    if (ticks && sum[0]! > 0) items.push({ kind: "tick", text: fill(T.legend.tick, { unit: unitOne }) });
    const yo = lanes.you, ag = lanes.agent, one = (m: LaneMark) => m.members.length === 1;
    const hitWords = o.hitWords ?? T.tag.candidate;
    // a lined-up change the chart could not label: its own badge, its short label and why it is marked
    const named = (side: "you" | "agent") => unlabelled.filter((u) => u.side === side).map(({ m }): LegendItem => ({
      kind: side === "you" ? "you" : "agentFilled", mark: m.text, text: `${shortLabel(m.members[0]!)}: ${hitWords}`,
      name: side === "you" ? fill(T.badge.you, { marker: m.text }) : fill(T.badge.agent, { agent: o.agentName, marker: m.text }),
    }));
    if (yo.some(one)) items.push({ kind: "you", text: T.legend.you });
    if (yo.some((m) => !one(m))) items.push({ kind: "youGroup", text: T.legend.youGroup });
    items.push(...named("you"));
    if (ag.some((m) => !m.filled && one(m))) items.push({ kind: "agent", text: fill(T.legend.agent, { agent: o.agentName }) });
    if (ag.some((m) => !one(m))) items.push({ kind: "agentGroup", text: fill(T.legend.agentGroup, { agent: o.agentName }) });
    // the filled tag's meaning, unless every lined-up tag is already named on its own just below
    if (ag.some((m) => m.hit && !unlabelled.some((u) => u.m === m))) items.push({ kind: "agentFilled", text: hitWords });
    else if (!ag.some((m) => m.hit) && ag.some((m) => m.filled)) items.push({ kind: "agentFilled", text: fill(T.legend.agentChange, { agent: o.agentName }) });
    items.push(...named("agent"));
    if (unknownDays.length) items.push({ kind: "unknownTick", text: T.legend.unknownTick });
    const lg = legend(items);
    if (lg) res.push(lg);
  }
  return res;
}
