/**
 * The Control Center pages as VNode trees (pure), to docs/design/UX-V2.md. Every page is one column in the same order
 * (§5): the demo banner (demo data only), the scan notice (after a failed scan only), the title, one sentence, the one
 * chart or table, then disclosures that hold the rest of the evidence. Nothing is deleted: every number on a page
 * stays reachable on it, in a disclosure, a hover tip or a chart's text description.
 *
 * Copy: every word the canvas owns is a template in tokens.json copy.canvas (CANVAS_COPY, filled with `fill`); the
 * engine's strings (deck, note, next step, confidence, trace) are shown verbatim, each in its one role (D67): title =
 * the state, deck = `headline`, note = `because`.
 *
 * Chrome: in "content" (the Mac app) the host draws the window: title bar, toolbar (Check Again, Copy Report, Open as
 * Markdown) and the sidebar with the pages and "local only · updated …". The canvas draws only the page. "full" (the
 * README hero and design comparisons in a plain browser) adds the canvas's own sidebar, never window buttons.
 */

import { CALIBRATION_PENDING, CANVAS_COPY as T, COPY, CHART, STATES } from "./gen/design.js";
import { agentName } from "./decode.js";
import type { Agent, Doc, Metric, TEvent } from "./decode.js";
import {
  bindingGate, eventLabel, findingSide, ineligibleWhy, isContext, isTimelineOnly, knWords, laneLabel, lineUpEvent, metricLabel,
  metricName, moved, openCandidates, recentEvents, rowTag, statusWords, stripDays, sumDays, windowLine, windowOf, baselineWords,
} from "./derive.js";
import type { StripDay } from "./derive.js";
import { badge, brandMark, forest, forestAxis, glyph, legend, strip } from "./charts.js";
import type { AppGlyphState, GlyphState } from "./charts.js";
import { addDays, cap, dayNum, dayOf, duration, fdate, fill, frange, num, plural, stamp, typographic, x2, xs } from "./format.js";
import { h } from "./vnode.js";
import type { Act, KidIn as Kid, VNode } from "./vnode.js";
import { NO_SETTINGS } from "./view.js";
import type { PartId, SettingsView } from "./view.js";

export type Page = "timeline" | "verdict" | "compare" | "setup" | "report" | "sources" | "settings";
export const PAGES: { id: Page; title: string }[] = [
  { id: "timeline", title: "Timeline" }, { id: "verdict", title: "Finding" }, { id: "compare", title: "Compare" },
  { id: "setup", title: "Setup" }, { id: "report", title: "Report" }, { id: "sources", title: "Sources" }, { id: "settings", title: "Settings" },
];

export interface Ui {
  page: Page;
  agent: number;
  /** "full": the canvas draws its own sidebar (plain browser); "content": the host (the Mac app) draws the chrome. */
  chrome: "full" | "content";
  nowMs: number;
  timeZone?: string;
  /** Disclosures the reader has toggled away from their default (keys like "verdict.details"; UX-V2 §5). */
  open?: string[];
  /** What native says about the install (view.settings, view.launchAtLogin); absent outside the app. */
  settings?: SettingsView;
}

interface Ctx { doc: Doc; ui: Ui; a: Agent | null; n: number }
const uid = (c: Ctx) => String(++c.n);

/** Chart width: the page column (960 px; the content pane is 1060 pt at the default window, less 2 × 40 px padding). */
const COL = 960;

/** The mod's frozen capabilities, shown in Settings → Privacy. Must equal the enforced allow-list
 *  (plugin/tests/check-calls.mjs ALLOWED_CALLS); ui/test/model.test.mjs holds the two equal. */
export const MOD_CALLS = "$.clock.every, $.clock.now, $.command.register, $.fs.read, $.fs.stat, $.state.get, $.state.set, $.ui.close, $.ui.open, $.ui.resolve";

/** What the Claude Code plugin can do, in words (Settings → Privacy, UX-V2 §9.2): one line per capability, each naming
 *  the mod calls or plugin hooks it covers. ui/test/model.test.mjs holds `calls` to exactly the enforced allow-list
 *  and `hooks` to exactly the hooks in plugin/hooks/hooks.json. */
export const PLUGIN_CAN: { words: string; calls: string[]; hooks: string[] }[] = [
  { words: T.settings.pluginCan.clockEvery, calls: ["$.clock.every"], hooks: [] },
  { words: T.settings.pluginCan.clockNow, calls: ["$.clock.now"], hooks: [] },
  { words: T.settings.pluginCan.command, calls: ["$.command.register"], hooks: [] },
  { words: T.settings.pluginCan.fsRead, calls: ["$.fs.read"], hooks: [] },
  { words: T.settings.pluginCan.fsStat, calls: ["$.fs.stat"], hooks: [] },
  { words: T.settings.pluginCan.state, calls: ["$.state.get", "$.state.set"], hooks: [] },
  { words: T.settings.pluginCan.ui, calls: ["$.ui.open", "$.ui.resolve", "$.ui.close"], hooks: [] },
  { words: T.settings.pluginCan.sessionHooks, calls: [], hooks: ["SessionStart", "SessionEnd"] },
  { words: T.settings.pluginCan.projectFiles, calls: [], hooks: ["SessionStart"] },
];

// ---------------------------------------------------------------------------------------------------------------
// small parts
// ---------------------------------------------------------------------------------------------------------------

const word = (map: object, key: string | null | undefined): string | undefined => (key ? (map as { [k: string]: string })[key] : undefined);

function chip(state: GlyphState, label: string): VNode {
  if (state === "unclear") {
    return h("span", { cls: "chip chip--unclear" }, h("span", { cls: "swatch", attrs: { "aria-hidden": "true" } }, h("i"), h("i")), glyph("unclear", 16), h("span", { cls: "chip-label" }, label));
  }
  return h("span", { cls: `chip chip--${state}` }, glyph(state, 16), h("span", { cls: "chip-label" }, label));
}

function stateChip(a: Agent): VNode {
  const label = a.label || (isTimelineOnly(a) ? CALIBRATION_PENDING.label : STATES[a.state].label);
  return chip(a.state, label);
}

function btn(label: string, act: Act, cls = "btn", extra?: { [k: string]: string | boolean | null }): VNode {
  return h("button", { cls, attrs: { type: "button", ...(extra ?? {}) }, act }, label);
}

/** A page's title and its one sentence (§5). */
function head(title: string, deck: Kid | null): VNode[] {
  return [h("h1", { cls: "t-title" }, title), deck ? h("p", { cls: "t-deck" }, deck) : null].filter((x): x is VNode => x !== null);
}

/** A chart's section head: "Tool errors per day" with, on the right, the ratio line or the dates. */
function chartHead(title: string, right: Kid | null): VNode {
  return h("div", { cls: "chart-head" }, h("h2", { cls: "t-section" }, title), right ? h("span", { cls: "right" }, right) : null);
}

const agentStripMetric = (a: Agent): Metric | null => (a.strip ? a.metrics.find((m) => m.id === a.strip!.metric) ?? null : null);

function todayOf(c: Ctx): string | null {
  return c.doc.generatedAtMs !== null ? dayOf(c.doc.generatedAtMs, c.ui.timeZone) : null;
}

/** Engine-independent copy with commands in backticks ("Run `wasitme doctor`."): the commands as code, no backticks. */
export function withCode(s: string): Kid[] {
  return s.split("`").map((part, i) => (i % 2 === 1 ? h("code", { cls: "cmd" }, part) : part)).filter((k) => k !== "");
}

// ---------------------------------------------------------------------------------------------------------------
// disclosures (UX-V2 §5): one component on every page; the region is always in the DOM, its children only when open
// ---------------------------------------------------------------------------------------------------------------

/** Open: the key's default, flipped when the reader toggled it (the toggles survive every re-render and agent switch). */
function isOpen(c: Ctx, key: string, byDefault: boolean): boolean {
  return (c.ui.open ?? []).includes(key) !== byDefault;
}

function chevron(open: boolean): VNode {
  return h("span", { cls: "chev", attrs: { "aria-hidden": "true" } },
    // drawn, never a text character: ▸ closed, ▾ open (12 px)
    { tag: "svg", svg: true, attrs: { width: "12", height: "12", viewBox: "0 0 12 12", focusable: "false" },
      kids: [{ tag: "path", svg: true, attrs: { class: "chev-path", d: open ? "M2 4 L6 8.5 L10 4" : "M4 2 L8.5 6 L4 10" }, kids: [] }] });
}

function disclosure(c: Ctx, key: string, label: string, count: number | null, byDefault: boolean, body: () => Kid[]): VNode {
  const open = isOpen(c, key, byDefault);
  const id = key.replace(/[^A-Za-z0-9]/g, "-");
  const bid = `disc-${id}`, rid = `region-${id}`;
  return h("div", { cls: ["disc-block", open && "open"] },
    h("h2", { cls: "disc-h" },
      h("button", { cls: "disc", attrs: { type: "button", id: bid, "aria-expanded": open ? "true" : "false", "aria-controls": rid }, act: { action: "toggleSection", section: key } },
        chevron(open), h("span", { cls: "disc-label" }, label), count !== null ? h("span", { cls: "disc-count" }, num(count)) : null)),
    h("div", { cls: "disc-region", attrs: { id: rid, role: "region", "aria-labelledby": bid, hidden: !open } }, open ? body() : null));
}

// ---------------------------------------------------------------------------------------------------------------
// change rows (UX-V2 §7.4): date · badge · label · at most one quiet tag
// ---------------------------------------------------------------------------------------------------------------

function changeRow(a: Agent, e: TEvent, hits: Set<string>, strata: boolean): VNode {
  const lab = eventLabel(e);
  const tag = rowTag(a, e, strata);
  return h("li", { cls: ["chg", e.side === "meta" && "dim"] },
    h("span", { cls: "d" }, fdate(e.day)),
    h("span", { cls: "b" }, badge(e, hits.has(e.id), a.name)),
    h("span", { cls: "lbl" }, lab.text),
    tag ? h("span", { cls: ["qtag", tag.tone === "hit" && `qtag--${tag.side}`, tag.tone === "candidate" && "qtag--candidate"] }, tag.text) : null);
}

function routineNote(a: Agent, list: TEvent[]): VNode | null {
  return list.some((e) => e.side === "agent" && e.strength === "routine") ? h("p", { cls: "t-small foot" }, fill(T.routineNote, { agent: a.name })) : null;
}

/** Every change, newest first, grouped by window (the Timeline's "All changes"). */
function allChanges(a: Agent): Kid[] {
  const list = [...a.timeline].reverse();
  if (!list.length) return [h("p", { cls: "t-small" }, T.nothingYet)];
  const hits = openCandidates(a);
  const w = a.windows;
  const order = ["after", "recent", "before", "earlier"] as const;
  const groups = w ? order.map((g) => ({ g, items: list.filter((e) => windowOf(a, e) === g) })).filter((x) => x.items.length) : [{ g: null, items: list }];
  const headOf = (g: string | null) => !w || g === null ? null : g === "recent" ? fill(T.timeline.groupRecent, { range: frange(w.recent.from, w.recent.to) })
    : g === "before" ? fill(T.timeline.groupBefore, { range: frange(w.baseline.from, w.baseline.to) }) : g === "after" ? T.timeline.groupAfter : T.timeline.groupEarlier;
  return [
    h("p", { cls: "sr" }, fill(T.timeline.listCaption, { agent: a.name })),
    groups.map(({ g, items }) => h("div", { cls: "chg-group" },
      headOf(g) ? h("p", { cls: "group-head t-small" }, headOf(g)) : null,
      h("ul", { cls: "chg-list" }, items.map((e) => changeRow(a, e, hits, true))))),
    routineNote(a, list),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// sidebar (full chrome only) + banner + notices
// ---------------------------------------------------------------------------------------------------------------

function sidebar(c: Ctx): VNode {
  const { doc, ui, a } = c;
  const meta: { [p: string]: Kid | null } = {
    timeline: a ? plural(a.timeline.filter((e) => e.side !== "meta").length, "change", "changes") : null,
    verdict: a || doc.display === "stale" ? glyph(doc.display === "stale" ? "stale" : a ? a.state : "insufficient", 16) : null,
    setup: a ? (() => { const eff = a.setup.find((x) => x.key === "effort"); return eff && typeof eff.value === "string" ? `effort ${eff.value}` : null; })() : null,
    sources: doc.health ? plural(doc.health.sources.length, "agent", "agents") : null,
  };
  // agent switcher: the snapshot's agents, plus any source with logs but no results (shown, not selectable)
  const seen = new Set(doc.agents.map((x) => x.name));
  const extra = (doc.health?.sources ?? []).filter((s) => !seen.has(s.name));
  const segs = [
    ...doc.agents.map((x, i) => h("button", {
      cls: ["seg", i === ui.agent && "on"], attrs: { type: "button", "aria-pressed": i === ui.agent ? "true" : "false" },
      act: { action: "selectAgent", index: i, ...(x.bridgeId ? { agent: x.bridgeId } : {}) },
    }, x.name)),
    ...extra.map((s) => h("button", { cls: "seg off", attrs: { type: "button", disabled: true, title: fill(s.found ? T.sidebar.noResults : T.sidebar.noLogs, { agent: s.name }) } }, s.name)),
  ];
  // What was read: the recent window's own counts under its title (the agent's `n` counts BOTH windows, engine
  // words/facts.ts), or, with no comparison window yet, everything read so far.
  const rw = a?.windows?.recent;
  const nb = rw ? { title: fill(T.sources.readRecent, { days: plural(rw.days, "day", "days") }), c: rw } : a?.n ? { title: T.sources.readSoFar, c: a.n } : null;
  // no window buttons: a picture of grey dots where real ones belong reads as a broken window (UX-V2 §3)
  return h("aside", { cls: "sidebar" },
    h("div", { cls: "brand" }, brandMark(), h("span", { cls: "wordmark", attrs: { role: "img", "aria-label": "wasitme" } }, "wasit", h("u", null, "me"))),
    segs.length ? h("div", { cls: ["switcher", segs.length === 1 ? "single" : `n${Math.min(4, segs.length)}`], attrs: { role: "group", "aria-label": T.sidebar.agent } }, segs) : null,
    h("nav", { attrs: { "aria-label": T.sidebar.pages } },
      h("ul", { cls: "nav" }, PAGES.map((p) => h("li", { cls: p.id === ui.page ? "on" : null },
        h("button", { cls: "navbtn", attrs: { type: "button", "aria-current": p.id === ui.page ? "page" : null }, act: { action: "showPage", page: p.id } },
          h("span", null, p.title), h("span", { cls: "meta" }, meta[p.id] ?? null)))))),
    h("div", { cls: "side-foot" },
      nb ? h("div", { cls: "nblock" },
        h("p", { cls: "nblock-title" }, nb.title),
        h("div", null, T.sources.exchanges, h("b", null, num(nb.c.exchanges))),
        h("div", null, T.sources.sessionDays, h("b", null, num(nb.c.sessionDays))),
        h("div", null, T.sources.sessions, h("b", null, num(nb.c.sessions)))) : null,
      h("div", { cls: "localonly" }, COPY.privacyShort, h("br"), updatedWords(doc))));
}

function updatedWords(doc: Doc): string {
  const f = doc.freshness;
  if (f.kind === "future") return T.sidebar.future;
  if (f.kind === "unknown") return doc.generatedAtMs === null ? T.sidebar.notYet : T.sidebar.unknown;
  const age = f.ageSec ?? 0;
  return age < 60 ? T.sidebar.justNow : fill(T.sidebar.ago, { age: duration(age) });
}

/** Demo data is never mistaken for yours: one line at the top of every page (UX-V2 §3, §5). */
function banner(c: Ctx): VNode | null {
  if (!c.doc.demo || c.doc.display === "mismatch" || c.doc.display === "refused") return null;
  return h("p", { cls: "banner" }, withCode(T.demoBanner));
}

function notices(c: Ctx): VNode | null {
  if (!c.doc.scanFailed || c.doc.display === "mismatch" || c.doc.display === "refused") return null;
  return h("p", { cls: "notice", attrs: { role: "status" } },
    fill(T.scanFailed, { why: word(T.scanFailedWhy, c.doc.scanError ?? "internal") ?? "" }), " ",
    btn(T.seeSources, { action: "showPage", page: "sources" }, "btn btn--plain"));
}

// ---------------------------------------------------------------------------------------------------------------
// Finding page (UX-V2 §8.1)
// ---------------------------------------------------------------------------------------------------------------

/**
 * One unlock item: the label, its binding gate pair as "7 of 10 session-days" and the bar drawn from that same pair
 * (`bindingGate`). With no pair short of its target (one session dominating), the reason words and no bar.
 */
function progressRow(a: Agent, metric: string): VNode[] {
  const label = metricLabel(a, metric);
  const g = bindingGate(a.progress?.unlock.find((u) => u.metric === metric));
  if (!g) {
    const m = a.metrics.find((x) => x.id === metric);
    return [h("div", { cls: "progress" }, h("span", { cls: "lbl" }, label), h("span", { cls: "num" }, m ? ineligibleWhy(a, m) : "Not enough yet"))];
  }
  const { have, need, noun } = g;
  const cellsN = Math.min(need, 40);
  const on = Math.round((Math.min(have, need) / need) * cellsN);
  return [
    h("div", { cls: "progress" }, h("span", { cls: "lbl" }, label), h("span", { cls: "num" }, fill(T.finding.unlockCount, { have: num(have), need: num(need), noun }))),
    h("div", { cls: "progress", attrs: { "aria-hidden": "true" } },
      h("span", { cls: "cells" }, Array.from({ length: cellsN }, (_, i) => h("i", { cls: i < on ? null : "off" })))),
  ];
}

function nextStep(a: Agent): string { return a.tryThis || T.finding.nextFallback; }

const CONFOUNDER: { [k: string]: string } = {
  prompt_length: "prompt length", long_context_share: "long-context share", mode_mix: "mode mix", entrypoint_mix: "entrypoint mix",
  subagent_mix: "subagent mix", interactive_mix: "interactive share", project_mix: "project mix", no_overlap: "window overlap",
};
function listWords(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "What was checked" for an agent-side finding (D44 5b), composed from the snapshot's own fields. */
export function checkedRows(a: Agent): [string, string][] {
  const R = T.finding.checkedRow;
  const rows: [string, string][] = [];
  const ev = recentEvents(a);
  const yours = ev.filter((e) => e.side === "you");
  const ruled = yours.filter((e) => a.candidates.some((x) => x.event === e.id && x.status === "ruled_out"));
  rows.push([R.you, yours.length === 0 ? R.youNone
    : ruled.length === yours.length ? fill(R.youRuled, { changes: ruled.map((e) => `${e.label} (${fdate(e.day)})`).join("; ") })
      : fill(R.youSome, { changes: plural(yours.length, "recorded change", "recorded changes") })]);
  const cf = a.confounders.filter((x) => x.moved !== null);
  if (cf.length) {
    const movedC = cf.filter((x) => x.moved === true).map((x) => CONFOUNDER[x.id] ?? x.id);
    const still = cf.filter((x) => x.moved === false).map((x) => CONFOUNDER[x.id] ?? x.id);
    rows.push([R.workload, movedC.length ? fill(R.workloadMoved, { list: cap(listWords(movedC)) }) : fill(R.workloadStill, { list: cap(listWords(still)) })]);
  }
  const shift = lineUpEvent(a);
  if (a.onset || shift) {
    const cand = shift ? a.candidates.find((x) => x.event === shift.id) : undefined;
    const what = shift ? `${shift.kind === "version" ? fill(R.shiftUpdate, { version: shift.to || laneLabel(a, shift) }) : laneLabel(a, shift)} (${fdate(shift.day)})` : "";
    rows.push([R.shift, `${a.onset ? fill(R.shiftBetween, { from: fdate(a.onset.from), to: fdate(a.onset.to) }) : R.shiftStarts}${what ? fill(R.shiftAt, { at: what }) : ""}${cand?.test === "version_boundary" ? R.shiftBoundary : ""}.`]);
  }
  if (a.windows) {
    const w = a.windows;
    rows.push([R.sample, fill(R.sampleLine, { exchanges: num(w.recent.exchanges + w.baseline.exchanges), sessionDays: num(w.recent.sessionDays + w.baseline.sessionDays), sessions: num(w.recent.sessions + w.baseline.sessions) })]);
  }
  if (a.observation) {
    const o = a.observation;
    rows.push([R.notVisible, `${o.note}${o.partiallyObservedDays ? ` ${fill(R.partly, { days: plural(o.partiallyObservedDays, "day was", "days were") })}` : ""}`.trim() || R.nothingNoted]);
  }
  return rows;
}

function checkedList(a: Agent): VNode {
  return h("dl", { cls: "checked" }, checkedRows(a).map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v))));
}

/** The strip with its head (the one chart of the Finding and Timeline pages). */
function stripSection(c: Ctx, a: Agent, show: number, mode: "key" | "all"): VNode | null {
  if (!a.strip) return null;
  const m = agentStripMetric(a);
  const [kL, nL] = knWords(a.strip.metric, m?.unit ?? "");
  const sv = stripDays(a, show, a.strip.days, null);
  const w = a.strip.window;
  // the noise band stays visible above the strip (AGENTS.md rule 4): the estimate, its range, the smallest change that shows
  const right: Kid | null = mode === "key"
    ? (w.ratio !== null ? [h("b", null, x2(w.ratio)), w.lo !== null && w.hi !== null ? `, range ${x2(w.lo)} to ${x2(w.hi)}` : "", w.mde !== null ? `; changes under ${xs(w.mde)} wouldn’t show` : ""] : null)
    : (sv.days.length ? frange(sv.days[0]!, sv.days[sv.days.length - 1]!) : null);
  return h("section", { cls: "chart-block" },
    chartHead(fill(T.chart.perDay, { metric: m?.label ?? T.chart.events }), right),
    strip({
      days: sv.days, rows: sv.rows, events: a.timeline, hits: openCandidates(a), recentStart: sv.recentStart,
      baseDays: a.windows?.baseline.days ?? null, recentDays: a.windows?.recent.days ?? null, brackets: !!a.windows,
      agentName: a.name, title: m?.label, kLabel: kL, nLabel: nL, width: COL, uid: uid(c), markLabels: mode,
      hitWords: findingSide(a) ? T.tag.lineUp : T.tag.candidate,
      // the Finding's case line is dashed while it is too early to tell (DESIGN.md, the case line)
      dashed: mode === "key" && a.state === "insufficient" && c.doc.display !== "stale",
    }));
}

/** No daily counts (Codex while its calibration is pending, Setup's old chart): the changes alone, six weeks. */
function eventsSection(c: Ctx, a: Agent, dashed = false): VNode {
  const sv = stripDays(a, 42, null, todayOf(c) ? addDays(todayOf(c)!, -1) : null);
  return h("section", { cls: "chart-block" },
    chartHead(T.chart.changes, sv.days.length ? frange(sv.days[0]!, sv.days[sv.days.length - 1]!) : null),
    strip({
      days: sv.days, rows: null, events: a.timeline, hits: openCandidates(a), recentStart: sv.recentStart,
      baseDays: a.windows?.baseline.days ?? null, recentDays: a.windows?.recent.days ?? null, brackets: !!a.windows,
      agentName: a.name, kLabel: "changes", nLabel: "days", width: COL, uid: uid(c), hitWords: findingSide(a) ? T.tag.lineUp : T.tag.candidate, dashed,
    }));
}

/** The day-level counts (UX-V2 §13 P3): one small table per two weeks, every day's k and n. */
function dailyCounts(a: Agent, rows: StripDay[], totals: string | null): Kid[] {
  const m = agentStripMetric(a);
  const [kL, nL] = knWords(a.strip?.metric ?? "", m?.unit ?? "");
  const days = rows.filter((r) => !r.out);
  const chunks: StripDay[][] = [];
  for (let i = 0; i < days.length; i += 14) chunks.push(days.slice(i, i + 14));
  return [
    totals ? h("p", { cls: "t-small" }, totals) : null,
    h("div", { cls: "daily-grid" }, chunks.map((ch) => h("table", { cls: "daily" },
      h("caption", { cls: "sr" }, fill(T.daily.caption, { metric: m?.label ?? T.chart.events, range: frange(ch[0]!.d, ch[ch.length - 1]!.d), k: kL, n: nL })),
      h("thead", null, h("tr", null, h("th", { attrs: { scope: "col" } }, T.daily.day), h("th", { cls: "num", attrs: { scope: "col" } }, kL), h("th", { cls: "num", attrs: { scope: "col" } }, nL))),
      h("tbody", null, ch.map((r) => h("tr", { cls: r.n > 0 && r.n < CHART.strip.lowNThreshold ? "low" : null },
        h("th", { attrs: { scope: "row" } }, fdate(r.d)), h("td", { cls: "num" }, r.n === 0 ? "–" : num(r.k)), h("td", { cls: "num" }, num(r.n)))))))),
    h("p", { cls: "t-small" }, fill(T.legend.narrow, { n: CHART.strip.lowNThreshold, noun: nL })),
  ];
}

function ledger(a: Agent, list: Metric[], withConfidence: boolean): VNode | null {
  if (!list.length) return null;
  const side = findingSide(a);
  const tint = side === "agent" ? "agent" : side === "you" ? null : "neutral";
  const shift = lineUpEvent(a);
  const rows = list.map((m) => {
    const fam = m.family === "friction" || m.role !== "vote" ? "context" : m.family ?? "context";
    const sig = h("td", { cls: "sig" }, h("span", { cls: "name" }, m.label), h("span", { cls: "fam" }, fam));
    const rec = h("td", { cls: "kn num" }, `${num(m.recent.k)} / ${num(m.recent.n)}`);
    const bef = h("td", { cls: "kn num" }, `${num(m.baseline.k)} / ${num(m.baseline.n)}`);
    const words = statusWords(m);
    const mv = moved(m);
    const st = h("td", { cls: ["st", (words === "Context only") && "ctx"] }, words, mv && shift ? badge(shift, true, a.name) : null);
    if (!m.eligible || m.ratio === null) {
      return h("tr", { cls: "dim" }, sig, rec, bef, h("td", { cls: "x", attrs: { colspan: "2" } }, h("span", { cls: "t-small" }, ineligibleWhy(a, m))), st);
    }
    return h("tr", null, sig, rec, bef,
      h("td", { cls: ["x", mv && "moved", mv && tint] }, x2(m.ratio), m.range ? h("span", { cls: "rng" }, `${x2(m.range[0])}–${x2(m.range[1])}`) : null),
      h("td", null, forest({ ratio: m.ratio, range: m.range, mde: m.mde, moved: mv })), st);
  });
  return h("div", { cls: "ledger" },
    h("div", { cls: "table-wrap" }, h("table", null,
      h("caption", { cls: "sr" }, fill(T.ledger.caption, { title: T.ledger.signal })),
      h("thead", null, h("tr", null,
        h("th", { attrs: { scope: "col" } }, T.ledger.signal), h("th", { cls: "num", attrs: { scope: "col" } }, T.ledger.recent), h("th", { cls: "num", attrs: { scope: "col" } }, T.ledger.before),
        h("th", { attrs: { scope: "col" } }, T.ledger.change), h("th", { attrs: { scope: "col" } }, forestAxis(220)), h("th", { attrs: { scope: "col" } }, T.ledger.status))),
      h("tbody", null, rows))),
    h("p", { cls: "t-small foot" }, T.ledger.key),
    withConfidence && a.confidence ? h("p", { cls: "t-small conf" }, a.confidence) : null);
}

function traceList(a: Agent): VNode {
  // the engine's words for each step, in order, without the decision table's row numbers (they mean nothing to a reader)
  return h("ul", { cls: "r-trace" }, a.trace.map((t) => h("li", { cls: t.matched ? "matched" : null },
    t.text, t.matched ? h("strong", null, ` (${T.finding.decidedMark})`) : null)));
}

/** "Changes in the recent window": the two old lanes as one list (§7.4), with the empty-side lines. */
function recentChanges(a: Agent): Kid[] {
  const ev = [...recentEvents(a)].reverse();
  const hits = openCandidates(a);
  const anyYou = ev.some((e) => e.side === "you"), anyAgent = ev.some((e) => e.side === "agent");
  return [
    h("h3", { cls: "t-section" }, T.finding.recentChanges),
    ev.length ? h("ul", { cls: "chg-list" }, ev.map((e) => changeRow(a, e, hits, false))) : null,
    // an agent-side finding already says it in "What was checked" (Your setup); said once
    !anyYou && a.state !== "agent" ? h("p", { cls: "t-small" }, a.windows ? T.finding.noneYours : T.finding.noneYoursYet) : null,
    !anyAgent ? h("p", { cls: "t-small" }, fill(a.windows ? T.finding.noneAgent : T.finding.noneAgentYet, { agent: a.name })) : null,
    routineNote(a, ev),
  ];
}

/** What each state shows in Details before the change list (§8.1). */
function statePanel(c: Ctx, a: Agent): Kid[] {
  if (isTimelineOnly(a)) {
    const cal = c.doc.calibration?.agents.find((x) => x.agent === a.id);
    const u = a.progress?.unlock[0];
    return [h("h3", { cls: "t-section" }, fill(T.finding.codexTitle, { agent: a.name })),
      u ? progressRow(a, u.metric) : null,
      h("p", null, fill(cal && cal.sequences === 0 ? T.finding.codexNotRun : T.finding.codexWait, { agent: a.name })),
      h("p", null, a.tryThis || T.finding.codexNext)];
  }
  if (a.state === "insufficient" && a.progress && a.progress.unlock.length) {
    const u = a.progress.unlock[0]!;
    const votingWithData = new Set(a.metrics.filter((m) => m.role === "vote" && m.eligible).map((m) => m.family));
    const then = u.family && !votingWithData.has(u.family) ? T.finding.unlockThenFamily : fill(T.finding.unlockThenMetric, { metric: metricLabel(a, u.metric).toLowerCase() });
    // What the counter above counts, in its own unit and without naming a window the document does not carry: the gate
    // applies to each window ("Each window needs at least 10 session-days.").
    const g = bindingGate(u);
    return [h("p", null, g ? [fill(T.finding.unlockEachWindow, { need: num(g.need), noun: g.noun }), " "] : null, then)];
  }
  if (a.state === "agent") return [h("h3", { cls: "t-section" }, T.finding.checked), checkedList(a)];
  return [];
}

function findingPage(c: Ctx, a: Agent): Kid[] {
  const stale = c.doc.display === "stale";
  const timelineOnly = isTimelineOnly(a);
  const display = stale ? STATES.stale.headline : timelineOnly ? CALIBRATION_PENDING.headline : STATES[a.state].headline;
  const f = c.doc.freshness;
  const staleWhy = f.kind === "future" ? T.finding.staleFuture : f.kind === "unknown" ? T.finding.staleUnknown
    : f.kind === "stale" ? fill(T.finding.staleAge, { age: duration(f.ageSec ?? 0) }) : "";
  const answer = h("section", { cls: "answer", attrs: { "aria-label": PAGES[1]!.title } },
    h("div", { cls: "meta" },
      stale ? chip("stale", STATES.stale.label) : stateChip(a),
      h("span", { cls: "ctx" }, stale ? fill(T.finding.lastKnown, { state: a.label || STATES[a.state].label }) : windowLine(a)),
      a.pending && !stale ? h("span", { cls: "ctx" }, T.finding.pending) : null),
    h("h1", { cls: "t-display" }, typographic(display)),
    stale ? [h("p", { cls: "t-deck" }, T.finding.staleDeck), staleWhy ? h("p", { cls: "t-small" }, staleWhy) : null]
      : a.headline ? h("p", { cls: "t-deck" }, a.headline) : null);

  const rest: Kid[] = [];
  if (timelineOnly) {
    rest.push(eventsSection(c, a, !stale),
      disclosure(c, "verdict.details", T.disclosure.details, null, false, () => [statePanel(c, a)]),
      disclosure(c, "verdict.changes", T.disclosure.allChanges, a.timeline.length, false, () => allChanges(a)));
  } else {
    const unlock = a.state === "insufficient" && a.progress?.unlock.length ? a.progress.unlock[0]! : null;
    const today = todayOf(c);
    const p = a.progress;
    // D66: the v1 engine sends no etaDate and never "not at your current pace", so this says "No date yet". The date
    // branch stays for an engine that sends one again (only once every calibration profile passes, D64(c)); a
    // not-at-pace document still shows no date and makes no pace claim.
    const eta = p && p.etaDate && !p.notAtCurrentPace
      ? (today ? fill(T.finding.etaDays, { days: plural(Math.max(1, dayNum(p.etaDate) - dayNum(today)), "day", "days"), date: fdate(p.etaDate) }) : fill(T.finding.etaDate, { date: fdate(p.etaDate) }))
      : T.finding.noDate;
    const next: VNode | null = unlock
      ? h("section", { cls: "next" }, h("h2", { cls: "next-title" }, T.finding.unlock),
        progressRow(a, unlock.metric),
        h("p", null, eta), h("p", null, nextStep(a)))
      : a.tryThis || a.state === "insufficient" ? h("section", { cls: "next" }, h("h2", { cls: "next-title" }, T.finding.next), h("p", null, nextStep(a))) : null;
    const disclaim = (a.state === "none" || a.state === "you" || a.state === "agent") && a.disclaimer ? h("p", { cls: "t-small disclaimer" }, a.disclaimer) : null;
    const votes = a.metrics.filter((m) => m.role === "vote" || m.role === "support");
    const sv = a.strip ? stripDays(a, 28, a.strip.days, null) : null;
    // the one chart: the daily strip, or, for an agent with no daily counts yet, the changes alone on the case line
    rest.push(a.strip ? stripSection(c, a, 28, "key") : eventsSection(c, a, a.state === "insufficient" && !stale), next, disclaim,
      disclosure(c, "verdict.details", T.disclosure.details, null, a.state === "agent" && !stale, () => [
        a.because ? h("p", { cls: "t-small because" }, a.because) : null,
        statePanel(c, a),
        recentChanges(a),
        a.confidence ? h("p", { cls: "t-small conf" }, a.confidence) : null,
        // the observation note, unless the confidence line or "What was checked" already says it (said once)
        a.observation?.note && a.state !== "agent" && !a.confidence.includes(a.observation.note) ? h("p", { cls: "t-small" }, a.observation.note) : null,
      ]),
      votes.length ? disclosure(c, "verdict.compared", T.disclosure.compared, null, false, () => [ledger(a, votes, false)]) : null,
      sv && sv.rows ? disclosure(c, "verdict.daily", T.disclosure.dailyCounts, null, false, () => dailyCounts(a, sv.rows!, null)) : null,
      a.trace.length ? disclosure(c, "verdict.decided", T.disclosure.decided, null, false, () => [traceList(a)]) : null);
  }
  return [answer, stale ? h("div", { cls: "lastknown" }, rest) : rest];
}

// ---------------------------------------------------------------------------------------------------------------
// Timeline, Compare, Setup (UX-V2 §8.2–8.4)
// ---------------------------------------------------------------------------------------------------------------

function findingLine(a: Agent): VNode {
  // timeline-led (D28): the page leads with the change timeline, and still says where the finding stands
  return h("div", { cls: "finding-line" }, stateChip(a), a.headline ? h("span", { cls: "fl-text" }, a.headline) : null,
    btn(T.seeFinding, { action: "showPage", page: "verdict" }, "btn btn--plain"));
}

function timelinePage(c: Ctx, a: Agent): Kid[] {
  const m = agentStripMetric(a);
  const sv = a.strip ? stripDays(a, 42, a.strip.days, null) : null;
  const totals = m ? fill(T.timeline.totals, { bk: num(m.baseline.k), bn: num(m.baseline.n), noun: knWords(m.id, m.unit)[1], rk: num(m.recent.k), rn: num(m.recent.n) }) : null;
  return [
    h("h1", { cls: "t-title" }, PAGES[0]!.title),
    c.doc.display === "ok" ? findingLine(a) : null,
    a.strip ? stripSection(c, a, 42, "all") : eventsSection(c, a),
    disclosure(c, "timeline.changes", T.disclosure.allChanges, a.timeline.length, false, () => allChanges(a)),
    sv && sv.rows ? disclosure(c, "timeline.daily", T.disclosure.dailyCounts, null, false, () => dailyCounts(a, sv.rows!, totals)) : null,
  ];
}

function comparePage(c: Ctx, a: Agent): Kid[] {
  const w = a.windows;
  const halves = (): Kid[] => {
    if (!a.strip || !w) return [];
    const m = agentStripMetric(a);
    const [kL, nL] = knWords(a.strip.metric, m?.unit ?? "");
    const all = stripDays(a, 28, a.strip.days, null);
    const rows = all.rows!;
    const before = rows.slice(0, Math.min(14, all.recentStart)), recent = rows.slice(all.recentStart);
    const halfW = (COL - 28) / 2;
    const half = (rs: StripDay[], title: string, totals: string, label: string, today: boolean) => {
      const days = rs.map((r) => r.d);
      return h("div", { cls: "cmp-half" }, h("div", { cls: "chart-head" }, h("h3", { cls: "t-section" }, title), h("span", { cls: "right" }, totals)),
        strip({ days, rows: rs, events: a.timeline, hits: openCandidates(a), recentStart: 0, baseDays: null, recentDays: days.length,
          brackets: true, agentName: a.name, title: m?.label, kLabel: kL, nLabel: nL, width: halfW, gutter: 72, today, windowLabel: label, uid: uid(c),
          kRow: true, nRow: true, hitWords: findingSide(a) ? T.tag.lineUp : T.tag.candidate }));
    };
    const out: Kid[] = [];
    const bs = sumDays(before);
    if (before.length) out.push(half(before, fill(T.compare.beforeHalf, { shown: before.length, days: w.baseline.days }),
      fill(T.compare.allDays, { days: w.baseline.days, k: num(m ? m.baseline.k : bs.k), n: num(m ? m.baseline.n : bs.n) }),
      fill(T.chart.beforeShown, { range: frange(before[0]!.d, before[before.length - 1]!.d) }), false));
    const rsum = sumDays(recent);
    out.push(half(recent, T.compare.recentHalf, m ? `${num(m.recent.k)} / ${num(m.recent.n)}` : `${num(rsum.k)} / ${num(rsum.n)}`, fill(T.chart.recent, { days: w.recent.days }), true));
    return [h("div", { cls: "cmp-two" }, out)];
  };
  return [
    ...head(PAGES[2]!.title, w ? fill(T.compare.deck, { recent: num(w.recent.days), baseline: baselineWords(w.baseline.days) }) : fill(T.compare.noWindow, { agent: a.name })),
    ledger(a, a.metrics, true),
    a.strip && w ? disclosure(c, "compare.strips", T.disclosure.strips, null, false, halves) : null,
  ];
}

/**
 * The Setup page's rows: every key a scan writes in an agent's `setup` (engine/src/contract/vocab.ts SETUP_KEYS, D80;
 * ui/test/model.test.mjs holds this table to that list), with its label and the timeline kind whose last change the
 * row links to. A null label is the agent's own word: its name for the installed version, its instructions file
 * (CLAUDE.md / AGENTS.md) for the file's presence and size, which share one row. Labels are the engine's words for
 * the same parts (engine/src/words/names.ts). A key this version doesn't know (a newer engine's) still shows, under
 * its own words and with no link.
 */
export const SETUP_ROWS: { readonly [key: string]: { readonly label: string | null; readonly kind: string } } = {
  version: { label: null, kind: "version" },
  model: { label: "Model", kind: "model" },
  effort: { label: "Effort", kind: "effort" },
  mode: { label: "Permission mode", kind: "mode" },
  entrypoint: { label: "Entry point", kind: "entrypoint" },
  mcpServers: { label: "MCP servers", kind: "mcp" },
  skills: { label: "Skills", kind: "skills" },
  hooks: { label: "Hooks", kind: "hooks" },
  pluginsEnabled: { label: "Plugins enabled", kind: "plugins" },
  pluginsInstalled: { label: "Plugins installed", kind: "plugins" },
  instructions: { label: null, kind: "instructions" },
  instructionsBytes: { label: null, kind: "instructions" },
};
const setupKind = (key: string): string | undefined => (Object.hasOwn(SETUP_ROWS, key) ? SETUP_ROWS[key]!.kind : undefined);

/** A setup row's label: the agent's name for its version, its instructions file's name, else the key's own words. */
export function setupLabel(a: Agent, key: string): string {
  if (key === "version") return a.name;
  if (key === "instructions" || key === "instructionsBytes") return a.id === "codex" ? "AGENTS.md" : a.id === "claude-code" ? "CLAUDE.md" : "Instructions file";
  const known = Object.hasOwn(SETUP_ROWS, key) ? SETUP_ROWS[key]!.label : null;
  return known ?? cap(key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
}

const bytesWords = (n: number): string => `${num(n)} ${n === 1 ? "byte" : "bytes"}`;
/** A `from` value worth printing: a label or a count, never a short hash, "absent" or "unknown". */
const readableFrom = (v: string): boolean => v !== "" && v !== "unknown" && v !== "absent" && !v.startsWith("h:");

function setupPage(a: Agent): Kid[] {
  const open = openCandidates(a);
  const size = a.setup.find((x) => x.key === "instructionsBytes");
  const bytes = size && typeof size.value === "number" ? size.value : null;
  const hasFile = a.setup.some((x) => x.key === "instructions");
  // The file's size shows in its presence row; on its own (no presence key) it is that row.
  const shown = a.setup.filter((x) => !(x.key === "instructionsBytes" && hasFile));
  const rows = shown.map(({ key, value }) => {
    const text = key === "instructions" ? (value === false ? "none" : bytes !== null ? bytesWords(bytes) : "present")
      : key === "instructionsBytes" && typeof value === "number" ? bytesWords(value)
      : typeof value === "boolean" ? (value ? "on" : "off") : String(value);
    const kind = setupKind(key);
    // Two rows of one kind (Claude Code's enabled and installed plugins) each link only to a change that ended at their
    // own value. Setup is the global setup: a project's own files (project_snapshot events) are not among its parts.
    const shared = kind !== undefined && shown.filter((x) => setupKind(x.key) === kind).length > 1;
    const e = kind ? [...a.timeline].reverse().find((x) => x.kind === kind && x.provenance !== "project_snapshot"
      && (key === "version" ? x.side === "agent" : true) && (!shared || x.to === String(value))) : undefined;
    return h("tr", null, h("td", { cls: "sig" }, setupLabel(a, key)), h("td", { cls: "x" }, text),
      h("td", { cls: "when" }, e ? [badge(e, open.has(e.id), a.name), h("span", { cls: "kn" }, fdate(e.day)), e.side !== "agent" && readableFrom(e.from) ? h("span", { cls: "t-small" }, fill(T.setup.from, { value: e.from })) : null]
        : h("span", { cls: "t-small" }, T.setup.noneRecorded)));
  });
  return [
    ...head(PAGES[3]!.title, fill(T.setup.deck, { agent: a.name })),
    h("div", { cls: "ledger setup" },
      h("table", null, h("caption", { cls: "sr" }, fill(T.setup.caption, { agent: a.name })),
        h("thead", null, h("tr", null, h("th", { attrs: { scope: "col" } }, T.setup.part), h("th", { attrs: { scope: "col" } }, T.setup.now), h("th", { attrs: { scope: "col" } }, T.setup.lastChange))),
        h("tbody", null, rows.length ? rows : h("tr", null, h("td", { cls: "words", attrs: { colspan: "3" } }, T.setup.empty)))),
      a.observation?.note ? h("p", { cls: "t-small foot" }, a.observation.note) : null),
    h("p", { cls: "links" }, btn(T.seeTimeline, { action: "showPage", page: "timeline" }, "btn btn--plain")),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Report, Sources, Settings (UX-V2 §8.5–8.7, §9)
// ---------------------------------------------------------------------------------------------------------------

function reportPage(c: Ctx, a: Agent): Kid[] {
  const R = T.report;
  const st: GlyphState = c.doc.display === "stale" ? "stale" : a.state;
  const label = isTimelineOnly(a) ? CALIBRATION_PENDING.label : a.label || STATES[a.state].label;
  const title = fill(R.title, { headline: (isTimelineOnly(a) ? CALIBRATION_PENDING.headline : STATES[a.state].headline).replace(/\.$/, "").toLowerCase(), agent: a.name });
  const w = a.windows;
  const finding: Kid[] = [
    // The finding (deck) and its evidence (note), as the engine's report prints them (engine/src/output/report.ts).
    h("p", { cls: "r-finding" }, glyph(st, 16), " ", h("strong", null, `${label}.`), a.headline ? ` ${a.headline}` : ""),
    a.because ? h("p", null, a.because) : null,
    a.confidence ? h("p", null, a.confidence) : null,
    a.disclaimer ? h("p", { cls: "t-small" }, `${R.disclaimerLead} ${a.disclaimer}`) : null,
  ];
  const checked = a.state === "agent" ? [h("h3", { cls: "t-section r-h" }, T.finding.checked), checkedList(a)] : [];
  const movedRows: Kid[] = a.metrics.length ? [
    h("h3", { cls: "t-section r-h" }, w ? fill(R.movedWindows, { recent: frange(w.recent.from, w.recent.to), before: frange(w.baseline.from, w.baseline.to) }) : R.moved),
    h("div", { cls: "table-wrap" }, h("table", { cls: "r-table" }, h("thead", null, h("tr", null, [R.col.signal, R.col.recent, R.col.before, R.col.change, R.col.range, R.col.status].map((t, i) => h("th", { cls: i > 0 && i < 4 ? "num" : null, attrs: { scope: "col" } }, t)))),
      h("tbody", null, a.metrics.map((m) => h("tr", null,
        h("td", null, m.label + (isContext(m) ? ` ${R.context}` : "")), h("td", { cls: "num" }, `${num(m.recent.k)} / ${num(m.recent.n)}`), h("td", { cls: "num" }, `${num(m.baseline.k)} / ${num(m.baseline.n)}`),
        h("td", { cls: "num" }, m.eligible && m.ratio !== null ? x2(m.ratio) : ""), h("td", null, m.eligible && m.range ? `${x2(m.range[0])}–${x2(m.range[1])}` : ""),
        h("td", { cls: "words" }, statusWords(m).toLowerCase().replace("no detectable change", R.notDetected))))))),
    h("p", { cls: "t-small" }, R.movedNote),
  ] : [];
  const sm = agentStripMetric(a);
  const daily: Kid[] = a.strip && w ? (() => {
    const sv = stripDays(a, w.recent.days || 14, a.strip!.days, null);
    const rows = sv.rows!.slice(sv.recentStart);
    const [kL, nL] = knWords(a.strip!.metric, sm?.unit ?? "");
    return [h("h3", { cls: "t-section r-h" }, fill(R.daily, { metric: sm?.label ?? T.chart.events })),
      h("div", { cls: "table-wrap" }, h("table", { cls: "r-table r-daily" }, h("thead", null, h("tr", null, h("th", { attrs: { scope: "col" } }, R.col.day), rows.map((r) => h("th", { cls: "num", attrs: { scope: "col" } }, fdate(r.d).split(" ")[1]!)))),
        h("tbody", null, h("tr", null, h("th", { attrs: { scope: "row" } }, kL), rows.map((r) => h("td", { cls: "num" }, r.n === 0 ? "–" : String(r.k)))),
          h("tr", null, h("th", { attrs: { scope: "row" } }, nL.split(" ").pop()!), rows.map((r) => h("td", { cls: "num" }, String(r.n)))))))];
  })() : [];
  const tlEvents = [...a.timeline].reverse().filter((e) => e.side !== "meta");
  const hits = openCandidates(a);
  const tl: Kid[] = [h("h3", { cls: "t-section r-h" }, R.timeline),
    h("ul", { cls: "chg-list" }, tlEvents.map((e) => changeRow(a, e, hits, true))),
    legend([
      tlEvents.some((e) => e.side === "you") ? { kind: "you", text: T.legend.you } : null,
      tlEvents.some((e) => e.side === "agent" && e.strength === "routine" && !hits.has(e.id)) ? { kind: "agent", text: fill(T.legend.agent, { agent: a.name }) } : null,
      tlEvents.some((e) => e.side === "agent" && hits.has(e.id)) ? { kind: "agentFilled", text: findingSide(a) ? T.tag.lineUp : T.tag.candidate }
        : tlEvents.some((e) => e.side === "agent" && e.strength !== "routine") ? { kind: "agentFilled", text: fill(T.legend.agentChange, { agent: a.name }) } : null,
      tlEvents.some((e) => e.side === "unknown") ? { kind: "unknown", text: T.legend.unknown } : null,
    ].filter((x): x is { kind: "you" | "agent" | "agentFilled" | "unknown"; text: string } => x !== null))];
  const why: Kid[] = a.trace.length ? [h("h3", { cls: "t-section r-h" }, T.disclosure.decided), traceList(a)] : [];
  const next: Kid[] = a.tryThis ? [h("p", { cls: "r-next" }, h("strong", null, R.next), ` ${a.tryThis}`)] : [];
  // The engine's report order (engine/src/output/report.ts agentBlocks), whatever the lead: the page previews that
  // report, and the copy is the engine's own Markdown (ReportExporter runs `report --md`).
  const sections = [...finding, ...checked, ...movedRows, ...daily, ...tl, ...why, ...next];
  return [
    ...head(PAGES[4]!.title, R.deck),
    h("section", { cls: "report-sheet", attrs: { "aria-label": R.label } },
      h("h2", { cls: "r-title" }, title), sections,
      h("p", { cls: "t-small r-foot" }, `${fill(R.foot, { version: c.doc.engine || "" }).replace(" ,", ",")}${c.doc.demo ? ` ${R.footDemo}` : ""}`)),
  ];
}

const SOURCE_ERR: { [k: string]: string } = { not_found: "no logs found", permission_denied: "permission denied", protected_folder: "in a protected folder (background scanning off)", unreadable: "unreadable" };
const PAUSE_WHY: { [k: string]: string } = { unknown_records_in_family: "record types wasitme doesn’t know yet", unknown_records_over_2pct: "more than 2 in 100 records unknown", parser_changed: "the reader changed; re-reading" };

function sourcesPage(c: Ctx): Kid[] {
  const S = T.sources;
  const hl = c.doc.health;
  const srcs = hl?.sources ?? [];
  const status = (s: (typeof srcs)[number]) => cap(s.found ? (s.error ? SOURCE_ERR[s.error] ?? s.error : S.read) : SOURCE_ERR[s.error ?? "not_found"] ?? SOURCE_ERR["not_found"]!);
  const setAside = (s: (typeof srcs)[number]) => s.badLines + s.truncatedTail + s.unknownTypes.reduce((n, u) => n + u.count, 0);
  const cal = c.doc.calibration;
  const a = c.a;
  const rw = a?.windows?.recent;
  const nb = rw ? { title: fill(S.readRecent, { days: plural(rw.days, "day", "days") }), c: rw } : a?.n ? { title: S.readSoFar, c: a.n } : null;
  return [
    ...head(PAGES[5]!.title, S.deck),
    srcs.length ? h("ul", { cls: "src-list" }, srcs.map((s) => h("li", { cls: "src" },
      h("span", { cls: "src-name" }, s.name), h("span", { cls: "src-status" }, status(s)),
      h("span", { cls: "src-facts" }, s.found ? fill(S.files, { files: plural(s.files, "log file", "log files"), range: s.firstDay && s.lastDay ? frange(s.firstDay, s.lastDay) : "–" }) : ""),
      setAside(s) ? h("span", { cls: "src-aside t-small" }, fill(S.setAside, { lines: plural(setAside(s), "line", "lines") })) : null)))
      : h("p", { cls: "t-small" }, S.noSources),
    hl && hl.paused.length ? [h("h2", { cls: "t-section gap" }, S.paused),
      h("ul", { cls: "plain-list" }, hl.paused.map((p) => h("li", null, h("strong", null, metricName(p.metric)), ` ${fill(S.pausedRow, { agent: agentName(p.agent, p.agent), why: PAUSE_WHY[p.why] ?? p.why })}`)))] : null,
    srcs.length ? disclosure(c, "sources.setAside", T.disclosure.setAside, null, false, () => [
      h("div", { cls: "ledger" }, h("div", { cls: "table-wrap" }, h("table", null, h("caption", { cls: "sr" }, S.caption),
        h("thead", null, h("tr", null, [S.col.agent, S.col.files, S.col.bad, S.col.cut, S.col.dup, S.col.days, S.col.unknown].map((t, i) => h("th", { cls: i >= 1 && i <= 4 ? "num" : null, attrs: { scope: "col" } }, t)))),
        h("tbody", null, srcs.map((s) => h("tr", null,
          h("td", { cls: "sig" }, s.name), h("td", { cls: "kn num" }, num(s.files)), h("td", { cls: "kn num" }, num(s.badLines)), h("td", { cls: "kn num" }, num(s.truncatedTail)), h("td", { cls: "kn num" }, num(s.duplicates)),
          h("td", { cls: "kn" }, s.firstDay && s.lastDay ? frange(s.firstDay, s.lastDay) : "–"),
          h("td", { cls: "words" }, s.unknownTypes.length ? (s.unknownTypes.length > 4 ? fill(S.unknownTypes, { list: s.unknownTypes.slice(0, 4).map((u) => `${u.key} ×${num(u.count)}`).join(", "), more: s.unknownTypes.length - 4 }) : s.unknownTypes.map((u) => `${u.key} ×${num(u.count)}`).join(", ")) : S.none)))))))]) : null,
    disclosure(c, "sources.scan", T.disclosure.scan, null, false, () => [
      h("dl", { cls: "checked wide" },
        h("div", null, h("dt", null, S.lastScan), h("dd", null, (() => {
          const state = c.doc.scanFailed ? fill(S.failed, { why: word(T.scanFailedWhy, c.doc.scanError ?? "internal") ?? "" }) : S.finished;
          return c.doc.generatedAtMs !== null ? fill(S.checkedAt, { state, time: stamp(c.doc.generatedAtMs, c.ui.timeZone) }) : state;
        })())),
        h("div", null, h("dt", null, S.sandbox), h("dd", null, hl?.sandbox === true ? S.sandboxOn : hl?.sandbox === false ? S.sandboxOff : S.notReported)),
        // the readers' internal ids and versions are for `wasitme doctor`, not this page
        h("div", null, h("dt", null, S.readers), h("dd", null, hl && hl.parserVersions.length ? withCode(fill(S.readersLine, { readers: plural(hl.parserVersions.length, "reader", "readers") })) : S.notReported)),
        c.doc.engine ? h("div", null, h("dt", null, S.engine), h("dd", null, fill(S.engineLine, { version: c.doc.engine }))) : null,
        h("div", null, h("dt", null, S.calibration), h("dd", null, cal && cal.agents.length
          ? h("ul", { cls: "plain-list" }, cal.agents.map((x) => h("li", null, h("strong", null, x.agent === "claude-code" ? "Claude Code" : x.agent === "codex" ? "Codex" : x.agent), " ",
            x.calibrated ? `${fill(S.calOn, { n: num(x.sequences) })}${cal.artifactDate ? ` (${fdate(cal.artifactDate)})` : ""}` : x.sequences ? fill(S.calOff, { n: num(x.sequences) }) : S.calNotRun)))
          : S.calNone)),
        nb ? h("div", null, h("dt", null, nb.title), h("dd", null, `${T.sources.exchanges} ${num(nb.c.exchanges)} · ${T.sources.sessionDays} ${num(nb.c.sessionDays)} · ${T.sources.sessions} ${num(nb.c.sessions)}`)) : null),
    ]),
  ];
}

// --- Settings (UX-V2 §9): buttons and switches that send named bridge actions; native confirms and runs them ---------

interface Row { key: string; title: string; desc: string; muted: boolean; state: string | null; control: VNode | null; reasonId?: string }

/** A switch drawn in the page (role switch). `act` null: disabled. Its name is the row's title. */
function toggle(title: string, on: boolean, act: Act | null, reasonId: string | null): VNode {
  return h("button", { cls: ["switch", on && "on"], attrs: { type: "button", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": title,
    disabled: act === null, "aria-describedby": act === null ? reasonId : null }, act: act ?? undefined }, h("span", { cls: "knob", attrs: { "aria-hidden": "true" } }));
}

function settingRow(r: Row): VNode {
  const rid = `why-${r.key}`;
  return h("li", { cls: "srow" },
    h("div", { cls: "srow-text" }, h("span", { cls: "srow-title" }, r.title), h("span", { cls: ["srow-desc", r.muted && "muted"], attrs: { id: rid } }, r.desc)),
    h("span", { cls: "srow-state" }, r.state ?? ""),
    h("span", { cls: "srow-ctl" }, r.control));
}

function group(title: string, rows: Row[] | null, extra?: Kid): VNode {
  return h("section", { cls: "sgroup" }, h("h2", { cls: "t-section" }, title), rows ? h("ul", { cls: "sbox" }, rows.map(settingRow)) : null, extra ?? null);
}

/** A row's button: enabled only when native can run it (`act`), else disabled and described by the row's reason. */
function rowButton(key: string, label: string, act: Act | null): VNode {
  return h("button", { cls: "btn", attrs: { type: "button", disabled: act === null, "aria-describedby": act === null ? `why-${key}` : null }, act: act ?? undefined }, label);
}

function settingsPage(c: Ctx): Kid[] {
  const S = T.settings;
  const st = c.ui.settings ?? NO_SETTINGS;
  const version = st.version ?? (c.doc.engine || null);
  const busy = st.busy;
  const notYet = S.notYet;
  // The installer runs these (add, remove, update, uninstall): only once it has answered for an install it recorded.
  const canAsk = st.wired && st.answered && st.installed;
  const askWhy = !st.wired ? notYet : !st.answered ? S.why.unanswered : S.why.no_install_record;

  // Integrations: each part's state comes from native (install.sh --status), never guessed here
  const part = (id: PartId): Row => {
    const p = st.parts[id] ?? { state: "unknown" as const, why: null };
    const meta = S.row[id];
    const agent = id === "codex-plugin" ? "Codex" : "Claude Code";
    const running = busy === id;
    const scan = id === "scan";
    // native runs one change at a time (another copy's run included), so any run disables every change here. The id is
    // IntegrationID's raw value (macos/Sources/WasitmeCore/Setup/SetupCommand.swift): the scan is `scan`, the id the
    // installer's status, add and remove modes all take.
    const act = (action: "addIntegration" | "removeIntegration"): Act | null => (canAsk && busy === null ? { action, integration: id } : null);
    const row: Row = { key: id, title: meta.title, desc: meta.desc, muted: false, state: S.state[p.state], control: null };
    if (p.state === "on") row.control = rowButton(id, scan ? S.button.turnOff : S.button.remove, act("removeIntegration"));
    else if (p.state === "off" && id !== "app") row.control = rowButton(id, scan ? S.button.turnOn : S.button.add, act("addIntegration"));
    else if (p.state === "own") row.desc = S.why.own;
    else if (p.state === "unavailable") { row.desc = p.why === "agent_missing" ? fill(S.why.agent_missing, { agent }) : p.why === "not_supported" ? S.why.not_supported : notYet; row.muted = true; }
    // not answered yet: the row keeps its own words (the reason shows once, on Updates and Uninstall, not on every row)
    else if (p.state === "unknown" && !(st.wired && !st.answered)) { row.desc = st.wired ? S.why.no_install_record : notYet; row.muted = true; }
    if (running) row.state = S.working;
    return row;
  };
  const dpKnown = st.desktopPanel !== null && st.wired;
  const panel: Row = {
    key: "desktopPanel", title: S.row.desktopPanel.title, desc: dpKnown ? S.row.desktopPanel.desc : notYet, muted: !dpKnown,
    state: busy === "desktopPanel" ? S.working : null,
    control: toggle(S.row.desktopPanel.title, st.desktopPanel === true, dpKnown && busy === null ? { action: "setDesktopPanel", enabled: !st.desktopPanel } : null, "why-desktopPanel"),
  };
  const integrations = [part("app"), panel, part("claude-plugin"), part("statusline"), part("codex-plugin"), part("scan")];

  // General
  const lal = st.launchAtLogin;
  const lalOn = lal === "on" || lal === "needsApproval" || lal === "viaInstaller";
  const lalLive = (lal === "on" || lal === "off" || lal === "needsApproval") && busy !== "launchAtLogin";
  const launch: Row = {
    key: "launchAtLogin", title: S.row.launchAtLogin.title,
    desc: lal === "needsApproval" ? S.why.needsApproval : lal === "viaInstaller" ? S.why.viaInstaller : lal === "on" || lal === "off" ? S.row.launchAtLogin.desc : notYet,
    muted: lal !== "on" && lal !== "off" && lal !== "needsApproval", state: busy === "launchAtLogin" ? S.working : null,
    control: toggle(S.row.launchAtLogin.title, lalOn, lalLive ? { action: "setLaunchAtLogin", enabled: !lalOn } : null, "why-launchAtLogin"),
  };
  // A control that could run keeps its own words; one that can't says why. While a change runs (busy) the ones that
  // could run wait, disabled: native runs one change at a time.
  const idle = busy === null;
  const up = st.update;
  const updateOffered = canAsk && up !== null && up.available;
  const updates: Row = {
    key: "updates", title: S.row.updates.title,
    desc: updateOffered ? fill(S.row.updates.desc, { version: version ?? "" }) : !canAsk ? askWhy : up && up.why === "no_release" ? S.why.no_release : notYet,
    muted: !updateOffered, state: busy === "updateApp" ? S.working : null,
    control: rowButton("updates", S.button.update, updateOffered && idle ? { action: "updateApp" } : null),
  };

  // Data and Uninstall: native runs them (after its own confirmation sheet for the destructive ones). Show in Finder
  // changes nothing, so a running change does not hold it back.
  const history: Row = { key: "history", title: S.row.history.title, desc: st.wired ? S.row.history.desc : notYet, muted: !st.wired, state: null,
    control: rowButton("history", S.button.reveal, st.wired ? { action: "revealDataFolder" } : null) };
  const clearOffered = st.wired && st.canClearHistory;
  const clear: Row = { key: "clearHistory", title: S.row.clearHistory.title,
    desc: clearOffered ? S.row.clearHistory.desc : st.wired ? S.why.no_install_record : notYet, muted: !clearOffered,
    state: busy === "clearHistory" ? S.working : null,
    control: rowButton("clearHistory", S.button.clear, clearOffered && idle ? { action: "clearHistory" } : null) };
  const uninstall: Row = { key: "uninstall", title: S.row.uninstall.title, desc: canAsk ? S.row.uninstall.desc : askWhy, muted: !canAsk,
    state: busy === "uninstallAll" ? S.working : null,
    control: rowButton("uninstall", S.button.uninstall, canAsk && idle ? { action: "uninstallAll" } : null) };

  return [
    ...head(PAGES[6]!.title, version ? fill(S.deck, { version }) : S.deckNoVersion),
    group(S.group.integrations, integrations),
    group(S.group.general, [launch, updates]),
    group(S.group.data, [history, clear]),
    group(S.group.privacy, null, [
      h("p", { cls: "privacy" }, withCode(COPY.privacyLine)),
      h("p", { cls: "privacy" }, S.privacyReports),
      disclosure(c, "settings.plugin", T.disclosure.pluginCalls, null, false, () => [
        h("p", null, S.pluginIntro),
        h("ul", { cls: "plain-list can" }, PLUGIN_CAN.map((x) => h("li", null, x.words))),
        h("p", { cls: "t-small" }, S.pluginExact),
        h("p", { cls: "calls" }, h("code", null, MOD_CALLS)),
      ]),
    ]),
    group(S.group.uninstall, [uninstall]),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Document-level states (nothing from the document is shown for mismatch / refused)
// ---------------------------------------------------------------------------------------------------------------

/** Each document-level display's app state (design tokens appStates): its own glyph, never a finding's. */
const APP_STATE_OF: { [k: string]: AppGlyphState } = {
  loading: "loading", notSetUp: "notSetUp", empty: "empty", unreadable: "unreadable", mismatch: "updateNeeded", refused: "refused",
};

/** The quiet app-state chip (components.css .chip--app): the app glyph and the state's words. */
function appChip(state: AppGlyphState, label: string): VNode {
  return h("span", { cls: "chip chip--app" }, glyph(`app:${state}`, 16), h("span", { cls: "chip-label" }, label));
}

function messagePage(c: Ctx): Kid[] {
  const d = c.doc.display;
  const M: { [k: string]: { title: string; text: string } } = {
    loading: T.message.loading, notSetUp: T.message.notSetUp, unreadable: T.message.unreadable, mismatch: T.message.mismatch, refused: T.message.refused,
  };
  let title: string, text: string;
  if (d === "stale") {
    // out of date AND nothing to show (the engine wrote no agents): say both, as the Finding page does when it has agents
    const f = c.doc.freshness;
    const why = f.kind === "future" ? T.finding.staleFuture : f.kind === "unknown" ? T.finding.staleUnknown
      : f.kind === "stale" ? fill(T.finding.staleAge, { age: duration(f.ageSec ?? 0) }) : "";
    const found = (c.doc.health?.sources ?? []).some((s) => s.found);
    return [h("section", { cls: "message", attrs: { "aria-live": "polite" } },
      h("div", { cls: "meta" }, chip("stale", STATES.stale.label)),
      h("h1", { cls: "t-display" }, STATES.stale.headline),
      why ? h("p", { cls: "t-deck" }, why) : null,
      h("p", { cls: "t-deck" }, withCode(found ? T.message.emptyFound : T.message.emptyNone)),
      c.doc.health ? h("p", null, btn(T.seeSources, { action: "showPage", page: "sources" }, "btn btn--plain")) : null)];
  }
  if (d === "empty") {
    const found = (c.doc.health?.sources ?? []).some((s) => s.found);
    title = T.message.empty.title;
    text = found ? T.message.emptyFound : T.message.emptyNone;
  } else {
    const m = M[d] ?? M["loading"]!;
    title = m.title; text = m.text;
  }
  const app = APP_STATE_OF[d] ?? "loading";
  return [h("section", { cls: "message", attrs: { "aria-live": "polite" } },
    h("div", { cls: "meta" }, appChip(app, title.replace(/\.$/, ""))),
    h("h1", { cls: "t-display" }, title),
    h("p", { cls: "t-deck" }, withCode(text)),
    d === "empty" && c.doc.health ? h("p", null, btn(T.seeSources, { action: "showPage", page: "sources" }, "btn btn--plain")) : null)];
}

// ---------------------------------------------------------------------------------------------------------------
// The whole window
// ---------------------------------------------------------------------------------------------------------------

export function renderApp(doc: Doc, ui: Ui): VNode {
  const showAgents = doc.display === "ok" || doc.display === "stale";
  const a = showAgents ? doc.agents[Math.max(0, Math.min(ui.agent, doc.agents.length - 1))] ?? null : null;
  const c: Ctx = { doc, ui: { ...ui, agent: a ? doc.agents.indexOf(a) : 0 }, a, n: 0 };
  let body: Kid[];
  if (!a) {
    const p = c.ui.page;
    if ((p === "sources" || p === "settings") && doc.display !== "mismatch" && doc.display !== "refused") {
      body = p === "sources" ? sourcesPage(c) : settingsPage(c);
    } else body = messagePage(c);
  } else {
    switch (c.ui.page) {
      case "timeline": body = timelinePage(c, a); break;
      case "compare": body = comparePage(c, a); break;
      case "setup": body = setupPage(a); break;
      case "report": body = reportPage(c, a); break;
      case "sources": body = sourcesPage(c); break;
      case "settings": body = settingsPage(c); break;
      default: body = findingPage(c, a);
    }
  }
  const pageTitle = PAGES.find((p) => p.id === c.ui.page)?.title ?? "Finding";
  return h("div", { cls: ["window", ui.chrome === "content" && "window--content", `page-${c.ui.page}`], attrs: { "data-page": c.ui.page, "data-display": doc.display } },
    ui.chrome === "full" ? sidebar(c) : null,
    h("main", { cls: "content", attrs: { "aria-label": `${pageTitle}${a ? `, ${a.name}` : ""}` } },
      h("div", { cls: "page" }, banner(c), notices(c), body)));
}

/** The page the Control Center lands on (D28): timeline-led → Timeline, verdict-led → Finding. */
export function landingPage(doc: Doc): Page { return doc.lead === "verdict" ? "verdict" : "timeline"; }

export function isPage(p: unknown): p is Page { return typeof p === "string" && PAGES.some((x) => x.id === p); }
