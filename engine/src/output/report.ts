/**
 * The shareable evidence report (`wasitme report`): one block model, emitted as Markdown (what people paste into an
 * issue) and as a single HTML file (no script, CSP `default-src 'none'; style-src 'sha256-…'; font-src data:`, the
 * design system's inline Plex subsets). Shape: design/system/screens/report-agent.md; share rules: PRIVACY.md "What a
 * report reveals".
 *
 *   - numbers only: no ids, no paths, no prompts; dates are days (no clock times, no zone);
 *   - every report carries the MDE sentence, the fixed disclaimer ("These indicators don't measure answer quality.
 *     Evidence, not proof."), "one person's logs on one Mac", the engine version and a METHOD pointer;
 *   - the words are the engine's: this file adds structure (tables, headings) and a few fixed phrases, all linted.
 *
 * Every dynamic string is cleaned (`clean`) and then escaped for the target format, so hostile labels cannot become
 * Markdown (links, images, HTML) or HTML.
 */
import { createHash } from "node:crypto";
import type { SnapshotAgent, SnapshotMetric, TimelineEvent } from "../contract/snapshot.js";
import { mde as mdeText, count, day as dayText, range as rangeText, ratio2, plural } from "../words/format.js";
import { agentName, metricWords } from "../words/names.js";
import { CALIBRATION_PENDING_WORDS, PRODUCT_WORDS, STATE_WORDS } from "../words/tokens.js";
import { stateGlyph } from "../cli/design-tokens.js";
import type { ReportDoc } from "./doc.js";
import { INLINE_CSS } from "./inline-css.js";
import { ineligibleText, NO_COMPARISON_NOTE, statusWord, STRIP_LABELS, timelineMarkers, visibleEvent } from "./terminal.js";
import { clean } from "./text.js";

// ───────────────────────────── block model ─────────────────────────────

type Run = string | { code: string } | { strong: string } | { em: string };
type Align = "l" | "r";

export type Block =
  | { t: "h1"; text: string }
  | { t: "h3"; text: string }
  | { t: "h4"; text: string }
  | { t: "p"; runs: Run[] }
  | { t: "banner"; text: string }
  | { t: "table"; head: string[]; align: Align[]; rows: string[][]; nowrap?: boolean[] }
  | { t: "code"; text: string }
  | { t: "list"; items: string[] }
  | { t: "sub"; text: string };

export interface ReportOptions {
  /** Only this agent (an id from the document). */
  agent?: string;
}

const DISCLAIMER = PRODUCT_WORDS.disclaimer;
const METHOD = "docs/METHOD.md";

const lowerFirst = (s: string): string => (s === "" ? s : s[0]!.toLowerCase() + s.slice(1));
const noStop = (s: string): string => s.replace(/\.$/, "");

function stateHeadline(a: SnapshotAgent): string {
  const text = a.reason === "calibration_pending" ? CALIBRATION_PENDING_WORDS.headline : STATE_WORDS[a.state].headline;
  return lowerFirst(noStop(text));
}

function stateLabel(a: SnapshotAgent): string {
  return a.reason === "calibration_pending" ? CALIBRATION_PENDING_WORDS.label : STATE_WORDS[a.state].label;
}

/** Day-level date ("Sep 21"); the year is added when it differs from the report's. */
function when(d: string, today: string): string {
  return dayText(d, today) || d;
}

function percent(x: number | null): string | null {
  return x === null ? null : `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

const CONFOUNDER_WORDS: Readonly<Record<string, string>> = {
  prompt_length: "prompt length", long_context_share: "long-context share", mode_mix: "mode mix", entrypoint_mix: "entry-point mix",
  subagent_mix: "subagent share", interactive_mix: "interactive share", project_mix: "project mix", no_overlap: "no project overlap",
};

function recentRange(a: SnapshotAgent, today: string): string {
  const w = a.windows;
  return w === null ? "" : ` (recent ${when(w.recent.from, today)} – ${when(w.recent.to, today)} against ${when(w.baseline.from, today)} – ${when(w.baseline.to, today)})`;
}

/** The checks behind a finding, one row each, from the document's own fields (never invented). */
function checkedRows(a: SnapshotAgent, today: string): string[][] {
  const rows: string[][] = [];
  const w = a.windows;
  // These three describe a comparison; they appear only when one ran (a calibrated agent with enough history).
  if (a.calibrated && w !== null) {
    const yours = a.timeline.filter((e) => e.side === "you" && e.strength !== "routine" && e.strength !== "weak" && e.day >= w.baseline.from && visibleEvent(e));
    rows.push(["Your setup", yours.length === 0
      ? "Nothing recorded changed on your side in the windows compared."
      : `${plural(yours.length, "change")} recorded on your side: ${yours.slice(-4).map((e) => `${e.label} (${when(e.day, today)})`).join("; ")}.`]);
    if (a.confounders.length > 0) {
      const moved = a.confounders.filter((c) => c.moved === true).map((c) => CONFOUNDER_WORDS[c.id] ?? c.id);
      rows.push(["Workload", moved.length === 0
        ? "No sign that your work changed between the windows (project mix, prompt length, long-context share and more)."
        : `Moved between the windows: ${moved.join(", ")}.`]);
    }
    if (a.onset !== null) {
      const open = a.candidates.filter((c) => c.status === "open");
      const named = open.map((c) => a.timeline.find((e) => e.id === c.event)).filter((e): e is TimelineEvent => e !== undefined);
      rows.push(["The shift", `Starts between ${when(a.onset.from, today)} and ${when(a.onset.to, today)}.${named.length > 0 ? ` Lines up with: ${named.map((e) => e.label).join("; ")}.` : ""}`]);
    } else if (a.state === "none") {
      rows.push(["The shift", "No shift met wasitme's rule for a change."]);
    }
  }
  rows.push(["Sample", `${count(a.n.exchanges)} exchanges, ${count(a.n.sessionDays)} session-days, ${count(a.n.sessions)} sessions (both windows).`]);
  const seen = a.observation.note !== "" ? a.observation.note : "Sessions on other machines aren't visible.";
  const days = a.observation.fullyObservedDays + a.observation.partiallyObservedDays;
  let observed = "";
  if (a.onset !== null && days > 0) {
    observed = a.observation.partiallyObservedDays === 0
      ? ` All ${plural(days, "day")} in the onset window ${days === 1 ? "was" : "were"} fully observed.`
      : ` ${count(a.observation.fullyObservedDays)} of ${plural(days, "day")} in the onset window ${a.observation.fullyObservedDays === 1 ? "was" : "were"} fully observed.`;
  }
  rows.push(["Not visible", `${seen}${observed}`]);
  return rows;
}

function metricRow(m: SnapshotMetric, a: SnapshotAgent): string[] {
  const label = m.label !== "" ? m.label : metricWords(m.id).label;
  const context = m.role !== "vote" ? " (context)" : "";
  // No comparison yet: the row is just the status word; the paragraph under the table says why, once.
  const why = m.eligible ? "" : ineligibleText(m, a);
  return [
    `${label}${context}`,
    `${count(m.recent.k)} / ${count(m.recent.n)}`,
    `${count(m.baseline.k)} / ${count(m.baseline.n)}`,
    m.eligible && m.ratio !== null ? ratio2(m.ratio) : "",
    m.eligible && m.range !== null ? rangeText(m.range[0], m.range[1]) : "",
    why === "" ? statusWord(m) : `${statusWord(m)}: ${why}`,
  ];
}

function stripBlock(a: SnapshotAgent, today: string): Block[] {
  const s = a.strip;
  if (s === null || s.days.length === 0) return [];
  const days = s.days.slice(-14);
  const [kName, nName] = STRIP_LABELS[s.metric] ?? ["events", "opportunities"];
  const events = a.timeline.filter((e) => visibleEvent(e) && e.day >= days[0]!.d && e.day <= days[days.length - 1]!.d);
  const mark = timelineMarkers(a);
  const lw = Math.max(kName.length, nName.length) + 1;
  const cell = (v: string): string => v.padStart(4);
  const dates = days.map((d, i) => (i % 7 === 0 ? when(d.d, today).replace(/, \d{4}$/, "").padEnd(28) : "")).join("").trimEnd();
  const marks = days.map((d) => {
    const e = events.find((x) => x.day === d.d && x.side !== "unknown");
    const unknown = events.find((x) => x.day === d.d && x.side === "unknown");
    if (e !== undefined) return `${e.side === "you" ? " ■" : " ▲"}${mark.get(e.id) ?? ""}`.padStart(4);
    return unknown !== undefined ? "   ?" : "    ";
  }).join("");
  const text = [
    `${" ".repeat(lw)}${dates}`,
    `${kName.padEnd(lw)}${days.map((d) => cell(d.n === 0 ? "–" : String(d.k))).join("")}`,
    `${nName.padEnd(lw)}${days.map((d) => cell(String(d.n))).join("")}`,
    `${" ".repeat(lw)}${marks}`,
  ].map((l) => l.trimEnd()).filter((l, i, all) => l !== "" || all.slice(i).some((x) => x !== "")).join("\n").replace(/\n+$/, "");
  const lead = a.metrics.find((m) => m.id === s.metric)?.label ?? metricWords(s.metric).label;
  return [{ t: "h4", text: `${lead} per day, last ${days.length} days` }, { t: "code", text }];
}

function timelineBlock(a: SnapshotAgent, name: string, today: string): Block[] {
  const events = a.timeline.filter(visibleEvent).slice(-20);
  if (events.length === 0) return [];
  const mark = timelineMarkers(a);
  const onset = a.onset;
  const items = [...events].reverse().map((e) => {
    const m = mark.get(e.id) ?? "";
    const glyph = e.side === "you" ? `■${m}` : e.side === "agent" ? `▲${m}` : "?";
    const open = a.candidates.some((c) => c.event === e.id && c.status === "open");
    const tag = open && onset !== null ? " (lines up with the shift)" : e.strength === "routine" ? " (update)" : "";
    return `${when(e.day, today).padEnd(6)}  ${glyph}  ${e.label}${tag}`;
  });
  return [{ t: "h4", text: `Timeline (■ your side, ▲ ${name}, ? origin unknown)` }, { t: "list", items }];
}

function agentBlocks(doc: ReportDoc, a: SnapshotAgent, today: string): Block[] {
  const name = agentName(a.agent);
  const out: Block[] = [];
  out.push({ t: "h3", text: `wasitme report: ${stateHeadline(a)} (${name})` });
  const glyph = stateGlyph(a.state);
  // D67: the bold label is the state; the deck (headline) is the one-sentence finding and the note (because) is the
  // evidence (numbers, window, what was ruled out or is missing). Every state prints both, deck first.
  out.push({ t: "p", runs: [{ code: glyph }, " ", { strong: `${stateLabel(a)}.` }, a.headline !== "" ? ` ${a.headline}` : ""] });
  if (a.because !== "") out.push({ t: "p", runs: [a.because] });
  if (a.confidence !== "") out.push({ t: "p", runs: [a.confidence] });
  out.push({ t: "p", runs: [{ em: `One person’s logs on one Mac. ${DISCLAIMER}` }] });

  out.push({ t: "h4", text: "What was checked" });
  out.push({ t: "table", head: ["checked", "what wasitme found"], align: ["l", "l"], rows: checkedRows(a, today) });

  const ms = a.metrics.filter((m) => m.recent.n > 0 || m.baseline.n > 0);
  if (ms.length > 0) {
    out.push({ t: "h4", text: `What moved${recentRange(a, today)}` });
    // Counts, ratios and ranges never break inside a value ("296 /" above "3,150"); the HTML table scrolls instead.
    out.push({ t: "table", head: ["signal", "recent", "before", "change", "range", "status"], align: ["l", "r", "r", "r", "l", "l"], nowrap: [false, true, true, true, true, false], rows: ms.map((m) => metricRow(m, a)) });
    // The detection limit of a VOTING indicator (one that can decide), never a context row's; and only where nothing
    // moved: a limit stated next to a change that did show would contradict it.
    const lead = a.metrics.find((m) => m.role === "vote" && m.eligible && m.mde !== null && m.status !== "worse" && m.status !== "better");
    const sentence = lead !== undefined && lead.mde !== null
      ? ` At this volume, changes under ${mdeText(lead.mde)} in ${metricWords(lead.id).name} might not show.` : "";
    const none = a.windows === null ? `${NO_COMPARISON_NOTE} ` : "";
    out.push({ t: "p", runs: [`${none}Counts are events / opportunities per window. Range: where the ratio could be at this volume (see ${METHOD}). “Not detected” means any change was too small to show at this volume.${sentence}`] });
    const cal = doc.calibration.agents.find((c) => c.agent === a.agent);
    if (a.calibrated && cal !== undefined && doc.calibration.artifactDate !== null) {
      const fc = percent(cal.falseChanged), fa = percent(cal.falseAgent);
      const rates = fc !== null && fa !== null ? ` On ${plural(cal.sequences, "synthetic no-change run")}, ${fc} wrongly reported a change and ${fa} wrongly named the agent's side.` : "";
      out.push({ t: "p", runs: [`Calibration: tested on synthetic logs on ${when(doc.calibration.artifactDate, today)}.${rates}`] });
    }
  }
  out.push(...stripBlock(a, today));
  out.push(...timelineBlock(a, name, today));
  if (a.trace.length > 0) {
    out.push({ t: "h4", text: "How wasitme decided" });
    out.push({ t: "list", items: a.trace.map((t) => `${t.text}${t.matched ? " (this decided it)" : ""}`) });
  }
  if (a.tryThis !== "") out.push({ t: "p", runs: [{ strong: "Next:" }, ` ${a.tryThis}`] });
  return out;
}

/** All blocks of the report for a document, in order. `today` is the document's own date. */
export function reportBlocks(doc: ReportDoc, o: ReportOptions = {}): Block[] {
  const today = doc.generatedAtMs !== null ? new Date(doc.generatedAtMs).toISOString().slice(0, 10) : "";
  const out: Block[] = [];
  if (doc.demo) out.push({ t: "banner", text: "DEMO: made from wasitme's synthetic demo data, not from anyone's logs." });
  if (doc.display === "stale") {
    const at = doc.generatedAtMs !== null ? when(today, "") : "an unknown day";
    out.push({ t: "banner", text: `Out of date: these results were last updated on ${at}. Run wasitme scan to refresh them before sharing.` });
  }
  if (!doc.scanOk) out.push({ t: "banner", text: `The last scan failed (${doc.scanError ?? "internal"}); this is the last good result.` });
  const agents = o.agent === undefined ? doc.agents : doc.agents.filter((a) => a.agent === o.agent);
  if (agents.length === 0) {
    out.push({ t: "h3", text: "wasitme report" });
    out.push({ t: "p", runs: ["No findings to report yet. Run wasitme scan first."] });
  }
  agents.forEach((a, i) => {
    if (i > 0) out.push({ t: "h4", text: "———" });
    out.push(...agentBlocks(doc, a, today));
  });
  const date = today === "" ? "" : ` on ${when(today, "")}`;
  out.push({ t: "sub", text: `Generated locally by wasitme${doc.engine === "" ? "" : ` ${doc.engine}`}${date} · numbers only: no prompts, code or paths · method: ${METHOD}${doc.demo ? " · demo data (analytic), run through the engine" : ""}` });
  return out;
}

// ───────────────────────────── Markdown ─────────────────────────────

/** Backslash-escape what Markdown (and the HTML it may contain) would act on. */
export function mdEscape(s: string): string {
  return clean(s).replace(/[\\`*_[\]<>|#~&]/g, (c) => `\\${c}`);
}

function runMd(r: Run): string {
  if (typeof r === "string") return mdEscape(r);
  if ("code" in r) return `\`${clean(r.code).replace(/`/g, "'")}\``;
  if ("strong" in r) return `**${mdEscape(r.strong)}**`;
  return `_${mdEscape(r.em)}_`;
}

/** The report as Markdown (ends in a newline). */
export function renderMarkdown(doc: ReportDoc, o: ReportOptions = {}): string {
  const out: string[] = [];
  for (const b of reportBlocks(doc, o)) {
    if (b.t === "h1") out.push(`# ${mdEscape(b.text)}`);
    else if (b.t === "h3") out.push(`### ${mdEscape(b.text)}`);
    else if (b.t === "h4") out.push(`**${mdEscape(b.text)}**`);
    else if (b.t === "p") out.push(b.runs.map(runMd).join(""));
    else if (b.t === "banner") out.push(`> **${mdEscape(b.text)}**`);
    else if (b.t === "table") {
      const cell = (v: string): string => mdEscape(v);
      out.push(`| ${b.head.map(cell).join(" | ")} |`, `|${b.align.map((a) => (a === "r" ? "---:" : "---")).join("|")}|`, ...b.rows.map((r) => `| ${r.map(cell).join(" | ")} |`));
    } else if (b.t === "code") out.push("```text", ...b.text.split("\n").map((l) => clean(l).replace(/`{3,}/g, "'''")), "```");
    else if (b.t === "list") out.push(...b.items.map((i) => `- ${mdEscape(i)}`));
    else out.push(`<sub>${htmlEscape(b.text)}</sub>`);
    out.push("");
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

// ───────────────────────────── HTML ─────────────────────────────

export function htmlEscape(s: string): string {
  return clean(s).replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

function runHtml(r: Run): string {
  if (typeof r === "string") return htmlEscape(r);
  if ("code" in r) return `<code>${htmlEscape(r.code)}</code>`;
  if ("strong" in r) return `<strong>${htmlEscape(r.strong)}</strong>`;
  return `<em>${htmlEscape(r.em)}</em>`;
}

/** The report's own rules, written only with the design tokens' variables (the colours and faces come from them). */
export const REPORT_CSS = `
html { background: var(--surface-page); }
body { margin: 0; color: var(--ink-primary); font: var(--type-body); }
main { box-sizing: border-box; max-width: 900px; margin: 0 auto; padding: 28px 28px 44px; background: var(--surface-sheet); min-height: 100vh; }
.brand { font: var(--type-wordmark); margin: 0 0 18px; }
.brand u { text-underline-offset: 3px; }
h3 { font: var(--type-heading); margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--rule-hair); }
h4 { font: var(--type-ui); font-weight: 700; margin: 18px 0 6px; }
p, li { font: var(--type-body); margin: 0 0 10px; }
li { margin: 0 0 4px; }
ul { margin: 0 0 10px; padding-left: 22px; }
code, pre { font-family: var(--font-terminal); font-size: 12.5px; }
code { background: var(--surface-well); padding: 1px 4px; border-radius: var(--radius-sticker); }
pre { background: var(--surface-well); padding: 10px 12px; margin: 0 0 12px; overflow-x: auto; line-height: 16px; }
pre code { background: none; padding: 0; }
.tw { overflow-x: auto; max-width: 100%; margin: 0 0 10px; }
table { border-collapse: collapse; margin: 0; font: var(--type-typed-sm); }
th, td { border: 1px solid var(--rule-strong); padding: 4px 10px; text-align: left; vertical-align: top; }
th { font-weight: 700; }
td.r, th.r { text-align: right; }
td.nw, th.nw { white-space: nowrap; }
.banner { border: 2px dashed var(--rule-ink); padding: 8px 12px; margin: 0 0 14px; font: var(--type-typed-lg); }
.foot { font: var(--type-typed-sm); color: var(--ink-muted); margin-top: 22px; }
@media (max-width: 600px) { main { padding: 18px 14px 32px; } }
`;

/** The `<style>` element's text: the design tokens (with their inline fonts) and the report's rules. */
export function styleText(): string {
  return `${INLINE_CSS}\n${REPORT_CSS}`;
}

/** `'sha256-…'` of the exact style text, for the CSP (the hash is preferred over 'unsafe-inline'; D57). */
export function styleHash(text: string = styleText()): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

export function cspFor(text: string = styleText()): string {
  return `default-src 'none'; style-src ${styleHash(text)}; font-src data:`;
}

/** The report as one HTML file: no script, no network, no external file; opens with the CSP above. */
export function renderHtml(doc: ReportDoc, o: ReportOptions = {}): string {
  const css = styleText();
  const body = reportBlocks(doc, o).map((b) => {
    if (b.t === "h1") return `<h1>${htmlEscape(b.text)}</h1>`;
    if (b.t === "h3") return `<h3>${htmlEscape(b.text)}</h3>`;
    if (b.t === "h4") return `<h4>${htmlEscape(b.text)}</h4>`;
    if (b.t === "p") return `<p>${b.runs.map(runHtml).join("")}</p>`;
    if (b.t === "banner") return `<p class="banner">${htmlEscape(b.text)}</p>`;
    if (b.t === "table") {
      const cls = (i: number): string => `${b.align[i]}${b.nowrap?.[i] === true ? " nw" : ""}`;
      return `<div class="tw"><table><thead><tr>${b.head.map((h, i) => `<th class="${cls(i)}">${htmlEscape(h)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((v, i) => `<td class="${cls(i)}">${htmlEscape(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    if (b.t === "code") return `<pre><code>${b.text.split("\n").map(htmlEscape).join("\n")}</code></pre>`;
    if (b.t === "list") return `<ul>${b.items.map((i) => `<li>${htmlEscape(i)}</li>`).join("")}</ul>`;
    return `<p class="foot">${htmlEscape(b.text)}</p>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${cspFor(css)}">
<title>wasitme report</title>
<style>${css}</style>
</head>
<body>
<main>
<p class="brand">wasit<u>me</u></p>
${body}
</main>
</body>
</html>
`;
}
