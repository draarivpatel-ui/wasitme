/**
 * Rules the JSON Schema cannot say on its own (docs/CONTRACT.md#semantic-rules), and the engine copy lint
 * (METHOD.md §1, DESIGN.md §3). Used by the contract tests on every golden; WP-30 runs the same checks on real engine output.
 */

import type { Glance, GlanceAgent } from "./glance.js";
import type { Snapshot } from "./snapshot.js";
import { REASONS_BY_STATE } from "./vocab.js";

/** The fixed closing sentence of every none/you/agent body — the only place "quality" may appear. */
export const DISCLAIMER = "These indicators don't measure answer quality. Evidence, not proof.";

const BANNED: readonly [RegExp, string][] = [
  [/\bquality\b/i, '"quality" (outside the fixed disclaimer)'],
  [/\bscores?\b/i, '"score"'],
  [/\bdumber\b/i, '"dumber"'],
  [/\bsmarter\b/i, '"smarter"'],
  [/\bnerf(ed)?\b/i, '"nerf"'],
  [/\bproves?\b/i, '"proves"'],
  [/\bcaused by\b/i, '"caused by"'],
  [/nothing changed on your side/i, '"nothing changed on your side"'],
  [/\blooks? like\b/i, '"look(s) like"'],
  [/\bafter\b.*\b(doubled|rose|fell)\b/i, '"after … doubled/rose/fell"'],
  [/(?<!detectable )\bno change\b/i, 'a bare "no change"'],
  [/99\s*%/, '"99%"'],
];

/** Banned phrases found in one engine-owned string (the copy lint, METHOD.md §1, DESIGN.md §3). */
export function lintCopy(text: string): string[] {
  const body = text.split(DISCLAIMER).join(" ");
  return BANNED.filter(([re]) => re.test(body)).map(([, what]) => what);
}

function agentProblems(a: GlanceAgent, at: string): string[] {
  const out: string[] = [];
  const allowed = REASONS_BY_STATE[a.state];
  if (allowed !== undefined && !allowed.includes(a.reason)) out.push(`${at}: reason ${JSON.stringify(a.reason)} is not allowed for state ${a.state}`);
  if (!a.calibrated && !(a.state === "insufficient" && a.reason === "calibration_pending")) out.push(`${at}: an uncalibrated agent must be insufficient (calibration_pending)`);
  if (a.reason === "calibration_pending" && a.calibrated) out.push(`${at}: calibration_pending on a calibrated agent`);
  if (a.band !== "" && a.state !== "you" && a.state !== "agent") out.push(`${at}: band is only for you/agent`);
  if (a.progress !== null && a.progress.notAtCurrentPace && a.progress.etaDate !== null) out.push(`${at}: notAtCurrentPace with an etaDate`);
  if (a.progress !== null && a.progress.unlock.some((u) => u.metric === "interrupts")) out.push(`${at}: interrupts never get a progress bar`);
  const ids = a.topMetrics.map((m) => m.id);
  if (new Set(ids).size !== ids.length) out.push(`${at}: duplicate topMetrics id`);
  for (const m of a.topMetrics) {
    if (m.range !== null && m.range[0] > m.range[1]) out.push(`${at}.${m.id}: range low > high`);
    if (m.range !== null && m.ratio !== null && (m.ratio < m.range[0] || m.ratio > m.range[1])) out.push(`${at}.${m.id}: ratio outside its range`);
    if (m.status === "ineligible" && m.ratio !== null) out.push(`${at}.${m.id}: an ineligible metric shows a ratio`);
  }
  if (a.strip !== null) {
    const ds = a.strip.days.map((d) => d.d);
    if (ds.some((d, i) => i > 0 && d <= ds[i - 1]!)) out.push(`${at}.strip: days not strictly ascending`);
    if (a.strip.days.some((d) => d.k > d.n && a.strip!.metric !== "readsPerEdit")) out.push(`${at}.strip: k > n`);
  }
  const evDays = a.events.map((e) => e.day);
  if (evDays.some((d, i) => i > 0 && d > evDays[i - 1]!)) out.push(`${at}.events: not newest first`);
  return out;
}

function lintAgent(a: GlanceAgent, at: string): string[] {
  const texts: [string, string][] = [
    ["label", a.label], ["headline", a.headline], ["because", a.because], ["tryThis", a.tryThis],
    ["confidence", a.confidence], ["band", a.band], ["statusLine", a.statusLine],
    ...a.topMetrics.flatMap((m): [string, string][] => [[`${m.id}.label`, m.label], [`${m.id}.unit`, m.unit]]),
    ...a.events.map((e, i): [string, string] => [`events[${i}].label`, e.label]),
  ];
  return texts.flatMap(([field, text]) => lintCopy(text).map((what) => `${at}.${field}: ${what}`));
}

/** The decision-table row (METHOD.md §11) that yields a state/reason; needs_data is row 2 or 14. */
export function decisionRow(state: string, reason: string | null): number | null {
  const byReason: Record<string, number> = {
    calibration_pending: 1, needs_data: 2, mixed: 3, workload: 4, unknown_provenance: 5, both_sides: 6,
    by_elimination: 9, nothing_recorded_on_your_side: 10, blind_spot: 11, single_indicator: 12,
  };
  if (reason !== null) return Object.hasOwn(byReason, reason) ? byReason[reason]! : null;
  return state === "you" ? 7 : state === "agent" ? 8 : state === "none" ? 13 : null;
}

/** Semantic problems in a schema-valid glance (empty = fine). `copy` also runs the copy lint. */
export function checkGlance(g: Glance, opts: { copy?: boolean } = {}): string[] {
  const out: string[] = [];
  if (g.scanOk !== (g.scanError === null)) out.push("$: scanError must be null exactly when scanOk is true");
  g.agents.forEach((a, i) => {
    out.push(...agentProblems(a, `$.agents[${i}]`));
    if (opts.copy) out.push(...lintAgent(a, `$.agents[${i}]`));
  });
  const names = g.agents.map((a) => a.agent);
  if (new Set(names).size !== names.length) out.push("$: an agent appears twice");
  return out;
}

/** Semantic problems in a schema-valid snapshot, including its glance part. */
export function checkSnapshot(s: Snapshot, opts: { copy?: boolean } = {}): string[] {
  const out = checkGlance({ ...s, schema: "wasitme.glance/1", agents: s.agents } as unknown as Glance, opts);
  s.agents.forEach((a, i) => {
    const at = `$.agents[${i}]`;
    const ids = new Set(a.timeline.map((e) => e.id));
    if (ids.size !== a.timeline.length) out.push(`${at}.timeline: duplicate id`);
    const days = a.timeline.map((e) => e.day);
    if (days.some((d, j) => j > 0 && d < days[j - 1]!)) out.push(`${at}.timeline: not oldest first`);
    for (const c of a.candidates) if (!ids.has(c.event)) out.push(`${at}.candidates: ${c.event} is not a timeline event`);
    if (a.onset !== null && a.onset.from > a.onset.to) out.push(`${at}.onset: from after to`);
    if ((a.state === "you" || a.state === "agent") && a.onset === null) out.push(`${at}: a you/agent verdict needs an onset`);
    if (a.state === "agent" && a.reason === "by_elimination") {
      if (a.observation.partiallyObservedDays !== 0) out.push(`${at}: by_elimination needs fully observed days`);
      if (!a.candidates.some((c) => c.test === "version_boundary")) out.push(`${at}: by_elimination needs a version-boundary test`);
    }
    const wantsDisclaimer = a.state === "none" || a.state === "you" || a.state === "agent";
    if (wantsDisclaimer !== (a.disclaimer === DISCLAIMER)) out.push(`${at}: disclaimer must be the fixed sentence exactly for none/you/agent, else null`);
    for (const m of a.metrics) if (m.eligible !== (m.ineligibleReason === null)) out.push(`${at}.metrics.${m.id}: eligible and ineligibleReason disagree`);
    if (opts.copy) for (const t of a.trace) for (const what of lintCopy(t.text)) out.push(`${at}.trace: ${what}`);
    if (a.trace.length > 0) {
      const matched = a.trace.filter((t) => t.matched);
      const want = decisionRow(a.state, a.reason);
      if (matched.length !== 1 || a.trace[a.trace.length - 1] !== matched[0]) out.push(`${at}.trace: exactly one row must match, and it must be the last`);
      else if (want !== null && matched[0]!.row !== want && !(want === 2 && matched[0]!.row === 14)) out.push(`${at}.trace: matched row ${matched[0]!.row} doesn't give ${a.state} (${a.reason})`);
      const rows = a.trace.map((t) => t.row);
      if (rows.some((r, j) => j > 0 && r <= rows[j - 1]!)) out.push(`${at}.trace: rows not in table order`);
    }
  });
  const calibrated = new Map(s.calibration.agents.map((c) => [c.agent, c.calibrated]));
  for (const a of s.agents) if (calibrated.has(a.agent) && calibrated.get(a.agent) !== a.calibrated) out.push(`$: calibration.agents disagrees with ${a.agent}.calibrated`);
  return out;
}
