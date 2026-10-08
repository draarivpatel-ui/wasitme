/**
 * Lints for engine copy, runnable on real output (WP-30 / WP-12 call them on what they are about to write):
 *  - `lintCopy` (contract/check.ts; METHOD.md §1, DESIGN.md §3) on every string;
 *  - the glance-word rule (DESIGN.md §3, tokens.json `copy.glanceBanned`): glance strings carry only the state
 *    and "+n" — the status line is exactly "wasitme: <label>" with an optional " +n", and no glance string uses
 *    worse/better/nerf/degrade/improve;
 *  - D57: the UI says "finding", so no engine string says "verdict";
 *  - the contract's length bounds (the schema is not shipped, so producers check them here).
 * Each returns problems as text (empty = clean).
 */
import { lintCopy } from "../contract/check.js";
import { len } from "./format.js";
import { CALIBRATION_PENDING_WORDS, STATE_WORDS } from "./tokens.js";
import { LIMITS, type AgentWords } from "./words.js";

/** tokens.json copy.glanceBanned (held equal to it by engine/test/words/tokens-sync.test.ts). */
export const GLANCE_BANNED = /\b(worse|better|nerf\w*|degrad\w*|improv\w*)\b/i;

const LABELS: readonly string[] = [...Object.values(STATE_WORDS).map((s) => s.label), CALIBRATION_PENDING_WORDS.label];

/** Problems with one glance string (label, status line, band): a glance-banned word. */
export function lintGlanceWords(text: string): string[] {
  return GLANCE_BANNED.test(text) ? [`glance string uses a banned word: ${JSON.stringify(text)}`] : [];
}

/** The status line must be the state label (lower case) plus an optional "+n", nothing else. */
export function lintStatusLine(text: string): string[] {
  const m = /^wasitme: (.+?)(?: \+([1-9]\d*))?$/.exec(text);
  const ok = m !== null && LABELS.some((l) => l.toLowerCase() === m[1]);
  return ok ? lintGlanceWords(text) : [`status line is not "wasitme: <state>[ +n]": ${JSON.stringify(text)}`];
}

/** Every string of one agent's words, with a path for messages. */
export function agentStrings(w: AgentWords): [string, string][] {
  return [
    ["label", w.label], ["headline", w.headline], ["because", w.because], ["tryThis", w.tryThis],
    ["confidence", w.confidence], ["band", w.band], ["statusLine", w.statusLine],
    ["observationNote", w.observationNote], ["title", w.title], ["timelineLine", w.timelineLine],
    ...(w.disclaimer !== null ? [["disclaimer", w.disclaimer] as [string, string]] : []),
    ...(w.pendingLine !== null ? [["pendingLine", w.pendingLine] as [string, string]] : []),
    ...(w.progressLine !== null ? [["progressLine", w.progressLine] as [string, string]] : []),
    ...(w.stripLine !== null ? [["stripLine", w.stripLine] as [string, string]] : []),
    ...w.trace.map((t): [string, string] => [`trace[row ${t.row}]`, t.text]),
    ...Object.entries(w.eventLabels).map(([id, t]): [string, string] => [`eventLabels.${id}`, t]),
    ...w.metrics.flatMap((m): [string, string][] => [[`metrics.${m.id}.label`, m.label], [`metrics.${m.id}.unit`, m.unit], [`metrics.${m.id}.line`, m.line], [`metrics.${m.id}.status`, m.status]]),
    ...w.candidateLines.map((c): [string, string] => [`candidateLines.${c.event}`, c.text]),
    ...w.eventLines.map((t, i): [string, string] => [`eventLines[${i}]`, t]),
    ...w.body.timeline.map((t, i): [string, string] => [`body.timeline[${i}]`, t]),
    ...w.body.verdict.map((t, i): [string, string] => [`body.verdict[${i}]`, t]),
  ];
}

const BOUNDS: readonly [string, number][] = [
  ["label", LIMITS.label], ["headline", LIMITS.headline], ["because", LIMITS.because], ["tryThis", LIMITS.tryThis],
  ["confidence", LIMITS.confidence], ["band", LIMITS.band], ["statusLine", LIMITS.statusLine], ["observationNote", LIMITS.note],
];

/** All copy problems of one agent's words (empty = clean). */
export function lintAgentWords(w: AgentWords): string[] {
  const at = `${w.agent}`;
  const out: string[] = [];
  for (const [field, text] of agentStrings(w)) {
    for (const what of lintCopy(text)) out.push(`${at}.${field}: ${what}`);
    if (/\bverdicts?\b/i.test(text)) out.push(`${at}.${field}: says "verdict" (D57: the UI says "finding")`);
  }
  for (const [field, limit] of BOUNDS) {
    const text = (w as unknown as Record<string, string>)[field] ?? "";
    if (len(text) > limit) out.push(`${at}.${field}: longer than ${limit}`);
  }
  for (const t of w.trace) if (len(t.text) > LIMITS.trace) out.push(`${at}.trace[row ${t.row}]: longer than ${LIMITS.trace}`);
  for (const [id, t] of Object.entries(w.eventLabels)) if (len(t) > LIMITS.eventLabel) out.push(`${at}.eventLabels.${id}: longer than ${LIMITS.eventLabel}`);
  for (const m of w.metrics) {
    if (len(m.label) > LIMITS.metricLabel) out.push(`${at}.metrics.${m.id}.label: longer than ${LIMITS.metricLabel}`);
    if (len(m.unit) > LIMITS.metricUnit) out.push(`${at}.metrics.${m.id}.unit: longer than ${LIMITS.metricUnit}`);
  }
  if (!LABELS.includes(w.label)) out.push(`${at}.label: not a state label: ${JSON.stringify(w.label)}`);
  out.push(...lintGlanceWords(w.label).map((p) => `${at}.label: ${p}`));
  out.push(...lintGlanceWords(w.band).map((p) => `${at}.band: ${p}`));
  out.push(...lintStatusLine(w.statusLine).map((p) => `${at}.statusLine: ${p}`));
  return out;
}
