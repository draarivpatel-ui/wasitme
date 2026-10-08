// Writes design/system/demo-data.v3.json: ANALYTIC demo data (synthetic, deterministic), a superset of
// design/demo-data.v2.json with a timeline and integer daily rows PER CASE, numbers for the agent case,
// and copy written to the engine-owned templates (DESIGN.md §3). Daily rows are generated with a fixed-seed LCG and
// then forced to sum exactly to each window's totals (test.mjs re-checks every sum and every ratio).
// Ranges and MDEs use the engine's formulas (METHOD.md §6, engine gates/evaluate.ts): each eligible metric hand-sets
// only the MDE it should print; df comes from the case's session-days (Welch-Satterthwaite), SE is derived from the
// MDE, and the range from SE. df and SE are stored, so anyone can recompute range and MDE (test.mjs does).
// Usage: node design/system/gen/make-demo-v3.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, rangeAndMde, seForMde, wsDf } from './lib.mjs';

const pad = n => String(n).padStart(2, '0');
function days(from, count) {
  const out = []; const d = new Date(Date.UTC(2026, from[0] - 1, from[1]));
  for (let i = 0; i < count; i++) { out.push(`${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const BASE = days([8, 23], 28), RECENT = days([9, 20], 14);
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
function apportion(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map(w => (sum ? (w / sum) * total : 0));
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let j = 0; left > 0; j++, left--) out[order[j % order.length][1]]++;
  return out;
}
/** rows for one window: zero = indices with no sessions, low = indices with a light day, rate(i) = relative error rate */
function rows(dayList, K, N, seed, { zero = [], low = [], rate = () => 1 } = {}) {
  const r = lcg(seed);
  const w = dayList.map((_, i) => (zero.includes(i) ? 0 : (low.includes(i) ? 0.25 : 0.75 + 0.5 * r())));
  const n = apportion(w, N);
  const k = apportion(n.map((x, i) => x * rate(i)), K);
  return dayList.map((d, i) => ({ d, k: k[i], n: n[i] }));
}
const r2 = x => Math.round(x * 100) / 100;
const ratio = (rk, rn, bk, bn) => r2((rk / rn) / (bk / bn));

const SHARED_AGENT = [
  { day: '2026-08-27', side: 'agent', kind: 'version', label: 'Claude Code 2.1.249 → 2.1.255', routine: true },
  { day: '2026-09-03', side: 'agent', kind: 'version', label: 'Claude Code 2.1.255 → 2.1.262', routine: true },
  { day: '2026-09-12', side: 'agent', kind: 'version', label: 'Claude Code 2.1.262 → 2.1.266', routine: true },
  { day: '2026-09-15', side: 'agent', kind: 'version', label: 'Claude Code 2.1.266 → 2.1.270', routine: true },
  { day: '2026-09-18', side: 'agent', kind: 'version', label: 'Claude Code 2.1.270 → 2.1.274', routine: true },
  { day: '2026-09-24', side: 'agent', kind: 'version', label: 'Claude Code 2.1.274 → 2.1.277', routine: true },
  { day: '2026-10-01', side: 'agent', kind: 'version', label: 'Claude Code 2.1.277 → 2.1.281', routine: true },
];
const EFFORT = { day: '2026-09-21', side: 'you', kind: 'effort', label: 'Effort high → medium' };
const MCP = { day: '2026-09-27', side: 'you', kind: 'mcp', label: 'MCP server added (MCP-1)' };
const MODEL = { day: '2026-09-22', side: 'you', kind: 'model', label: 'Model opus-5 → opus-5-5' };
const sortT = t => [...t].sort((a, b) => a.day.localeCompare(b.day) || (a.side === 'you' ? -1 : 1));
const label = t => { let y = 0, a = 0; return sortT(t).map(e => ({ ...e, marker: e.side === 'you' ? String(++y) : String.fromCharCode(65 + a++) })); };

/** Range, MDE, SE and df for one eligible metric from the MDE it should print (see the header). */
function stats(exact, eventsR, eventsB, n, mdeTarget, status, id) {
  const df = Math.round(wsDf(eventsR, n.recent.sessionDays, eventsB, n.baseline.sessionDays) * 10) / 10;
  const se = Math.round(seForMde(mdeTarget, df) * 1e4) / 1e4;
  const { range, mde } = rangeAndMde(exact, se, df);
  const out = { range: range.map(r2), mde: Math.round(mde * 10) / 10, se, df };
  const moved = out.range[0] > 1 || out.range[1] < 1;
  if (out.mde !== mdeTarget) throw new Error(`${id}: MDE ${out.mde} after rounding SE, wanted ${mdeTarget}`);
  if (moved !== (status === 'moved')) throw new Error(`${id}: status ${status} but the derived range is ${out.range}`);
  return out;
}
/** Metric builders for one case (they need the case's session-days for df). */
const builders = n => ({
  m: (id, lbl, family, rk, rn, bk, bn, mde, status, extra = {}) =>
    ({ id, label: lbl, family, eligible: true, recent: { k: rk, n: rn }, baseline: { k: bk, n: bn }, ratio: ratio(rk, rn, bk, bn), ...stats((rk / rn) / (bk / bn), rk, bk, n, mde, status, id), status, ...extra }),
  rpe: (rr, re, br, be, mde, status, extra = {}) =>
    ({ id: 'readsPerEdit', label: 'Reads per edit', family: 'research', eligible: true, recent: { reads: rr, edits: re }, baseline: { reads: br, edits: be }, ratio: r2((rr / re) / (br / be)), ...stats((rr / re) / (br / be), re, be, n, mde, status, 'readsPerEdit'), status, ...extra }),
});
const ctx = (id, lbl, family, rk, rn, bk, bn, why) => ({ id, label: lbl, family, eligible: false, ineligibleReason: why, recent: { k: rk, n: rn }, baseline: { k: bk, n: bn } });
const N = {
  insufficient: { recent: { exchanges: 214, sessions: 6, sessionDays: 19, activeDays: 13 }, baseline: { exchanges: 520, sessions: 10, sessionDays: 47, activeDays: 25 } },
  none: { recent: { exchanges: 388, sessions: 9, sessionDays: 30, activeDays: 14 }, baseline: { exchanges: 790, sessions: 16, sessionDays: 58, activeDays: 26 } },
  unclear: { recent: { exchanges: 402, sessions: 9, sessionDays: 31, activeDays: 14 }, baseline: { exchanges: 520, sessions: 11, sessionDays: 49, activeDays: 25 } },
  you: { recent: { exchanges: 402, sessions: 9, sessionDays: 31, activeDays: 14 }, baseline: { exchanges: 655, sessions: 13, sessionDays: 52, activeDays: 26 } },
  agent: { recent: { exchanges: 395, sessions: 9, sessionDays: 30, activeDays: 14 }, baseline: { exchanges: 800, sessions: 15, sessionDays: 57, activeDays: 26 } },
};
const B = Object.fromEntries(Object.entries(N).map(([k, n]) => [k, builders(n)]));

const DISCLAIMER = "These indicators don't measure answer quality. Evidence, not proof.";
const x1 = v => v.toFixed(1).replace(/\.0$/, '');
const VOTING = new Set(['errors', 'research']);

const insufficientMetrics = [
  B.insufficient.m('toolErrors', 'Tool errors', 'errors', 88, 3290, 201, 5610, 2.5, 'none', { unit: 'of tool calls' }),
  { id: 'readsPerEdit', label: 'Reads per edit', family: 'research', eligible: false, ineligibleReason: '31 edits in the recent window (needs 40)', progress: { have: 31, need: 40 }, recent: { reads: 131, edits: 31 }, baseline: { reads: 1130, edits: 233 } },
  ctx('interrupts', 'Interruptions', 'friction', 2, 214, 13, 520, '2 in the recent window (needs 10); context only'),
  ctx('pushback', 'Pushback prompts', 'friction', 8, 214, 31, 520, '8 in the recent window (needs 10); context only'),
];
const noneMetrics = [
  B.none.m('toolErrors', 'Tool errors', 'errors', 203, 3110, 338, 5580, 1.9, 'none'),
  B.none.m('blindEdits', 'Edits without reading first', 'research', 61, 402, 128, 815, 1.7, 'none'),
  B.none.rpe(2010, 402, 4160, 815, 1.4, 'none'),
  ctx('interrupts', 'Interruptions', 'friction', 9, 388, 22, 790, '9 in the recent window (needs 10); context only'),
];
// The engine's none template (D67): "changes bigger than about x{max MDE} in {n} indicators would have shown" (sensitive voting metrics)
const noneVoting = noneMetrics.filter(m => m.eligible && VOTING.has(m.family) && m.mde <= 2);

const cases = {
  insufficient: {
    _why: 'Most common real outcome for a single user (D61: only tool errors have enough data; research signals are gated on edits, METHOD.md §5). Decision table row 2 or 14 (METHOD.md §11): insufficient, reason needs_data (with progress).',
    agent: 'claude-code', state: 'insufficient', reason: 'needs_data',
    headline: 'Too early to tell.',
    because: `wasitme can already rule out changes bigger than about ×${x1(insufficientMetrics[0].mde)} in tool errors.`,
    detail: 'Reads per edit and edits without reading first need 40 edits; you have 31. Interruptions and pushback are context only.',
    next: 'Keep working normally; wasitme checks every 15 minutes.',
    // D66: no projected dates in v1, so the progress carries counts only (the screens say "No date yet").
    progress: { family: 'research', unlocking: 'readsPerEdit', have: 31, need: 40, unit: 'edits' },
    n: N.insufficient,
    metrics: insufficientMetrics,
    timeline: label([...SHARED_AGENT, EFFORT, MCP]),
    daily: { metric: 'toolErrors',
      baseline: rows(BASE, 201, 5610, 11, { zero: [6, 13, 20], low: [7, 14, 21] }),
      recent: rows(RECENT, 88, 3290, 12, { zero: [8], low: [1, 7] }) },
  },
  none: {
    _why: 'Decision table row 13 (METHOD.md §11): not changed; no voting metric material; a sensitive voting metric (MDE <= 2) in each voting family.',
    agent: 'claude-code', state: 'none',
    headline: 'No detectable change.',
    because: `Changes bigger than about ×${x1(Math.max(...noneVoting.map(m => m.mde)))} in ${noneVoting.length} indicators would have shown.`,
    detail: 'Your effort change on Sep 21 didn’t move anything wasitme can detect at your volume.',
    next: 'If it still feels different, keep working; wasitme keeps checking every 15 minutes.',
    disclaimer: DISCLAIMER,
    n: N.none,
    metrics: noneMetrics,
    timeline: label([...SHARED_AGENT, EFFORT, MCP]),
    daily: { metric: 'toolErrors',
      baseline: rows(BASE, 338, 5580, 21, { zero: [6, 20], low: [13] }),
      recent: rows(RECENT, 203, 3110, 22, { low: [8] }) },
  },
  unclear: {
    _why: 'Decision table row 6 (METHOD.md §11), unclear (both_sides): your effort change (Sep 21, you-strong) and Claude Code serving a different model than you picked (Sep 23, agent-strong) land in the same week. Two changes on your own side alone would be `you` (row 7, CONTRACT.md decision 13).',
    agent: 'claude-code', state: 'unclear', reason: 'both_sides',
    headline: 'Can’t tell which.',
    because: 'Your numbers moved, but your effort change (Sep 21) and Claude Code’s model switch (Sep 23) happened the same week.',
    next: 'Undo your effort change to separate them.',
    n: N.unclear,
    metrics: [
      B.unclear.m('toolErrors', 'Tool errors', 'errors', 286, 3120, 201, 5610, 2.0, 'moved'),
      B.unclear.m('blindEdits', 'Edits without reading first', 'research', 74, 410, 79, 820, 1.7, 'moved'),
      { ...B.unclear.m('pushback', 'Pushback prompts', 'friction', 29, 402, 31, 520, 2.6, 'none'), context: true },
    ],
    timeline: label([...SHARED_AGENT, { ...EFFORT, candidate: true },
      { day: '2026-09-23', side: 'agent', kind: 'model', label: 'Claude Code served a different model than you picked', short: 'model', strength: 'strong', candidate: true }, MCP]),
    daily: { metric: 'toolErrors',
      baseline: rows(BASE, 201, 5610, 31, { zero: [6, 13, 20], low: [7] }),
      recent: rows(RECENT, 286, 3120, 32, { low: [8], rate: i => (i >= 1 ? 2.8 : 1) }) },
  },
  you: {
    _why: 'Isolated change on your side (effort high → medium, Sep 21); the Claude Code updates on Sep 24 and Oct 1 came after the shift.',
    agent: 'claude-code', state: 'you',
    headline: 'Your side changed.',
    because: 'Your numbers moved around the time of your effort change from high to medium (Sep 21).',
    detail: 'The Claude Code updates on Sep 24 and Oct 1 came after the shift; updates alone aren’t evidence.',
    next: 'To check, set effort back to high.',
    disclaimer: DISCLAIMER,
    n: N.you,
    metrics: [
      B.you.m('toolErrors', 'Tool errors', 'errors', 296, 3150, 193, 5528, 2.0, 'moved', { linesUpWith: '1' }),
      B.you.m('blindEdits', 'Edits without reading first', 'research', 71, 400, 79, 820, 1.7, 'moved', { linesUpWith: '1' }),
      B.you.rpe(1240, 400, 4830, 820, 1.5, 'moved', { linesUpWith: '1' }),
      ctx('interrupts', 'Interruptions', 'friction', 4, 402, 13, 655, '4 in the recent window (needs 10); context only'),
    ],
    timeline: label([...SHARED_AGENT, EFFORT, MCP]),
    daily: { metric: 'toolErrors',
      baseline: [...rows(BASE.slice(0, 14), 98, 2797, 41, { zero: [6], low: [0] }),
        ...[{ d: '09-06', k: 8, n: 231 }, { d: '09-07', k: 5, n: 160 }, { d: '09-08', k: 11, n: 290 }, { d: '09-09', k: 7, n: 214 }, { d: '09-10', k: 6, n: 188 },
          { d: '09-11', k: 9, n: 247 }, { d: '09-12', k: 4, n: 121 }, { d: '09-13', k: 0, n: 38 }, { d: '09-14', k: 7, n: 205 }, { d: '09-15', k: 10, n: 262 },
          { d: '09-16', k: 8, n: 230 }, { d: '09-17', k: 6, n: 176 }, { d: '09-18', k: 9, n: 219 }, { d: '09-19', k: 5, n: 150 }]],
      recent: [{ d: '09-20', k: 7, n: 201 }, { d: '09-21', k: 19, n: 224 }, { d: '09-22', k: 24, n: 251 }, { d: '09-23', k: 22, n: 230 }, { d: '09-24', k: 18, n: 196 },
        { d: '09-25', k: 15, n: 171 }, { d: '09-26', k: 26, n: 262 }, { d: '09-27', k: 21, n: 228 }, { d: '09-28', k: 6, n: 64 }, { d: '09-29', k: 23, n: 244 },
        { d: '09-30', k: 25, n: 259 }, { d: '10-01', k: 27, n: 276 }, { d: '10-02', k: 30, n: 296 }, { d: '10-03', k: 33, n: 248 }] },
  },
  agent: {
    _why: 'Rare. By elimination (METHOD.md §11 row 9): no recorded change on your side since tracking started, only an update in the window, fully observed, and the shift starts at that update in both projects.',
    agent: 'claude-code', state: 'agent', reason: 'by_elimination',
    headline: 'The agent changed.',
    because: 'Nothing recorded changed on your side; your tool errors and edits without reading first rose at the 2.1.277 update (Sep 23), in 2 projects.',
    next: 'If you file an issue, share the report; it says what it can and can’t show.',
    disclaimer: DISCLAIMER,
    checked: [
      ['Your setup', 'No recorded change since tracking started (Sep 5): model, effort, MCP servers, skills, instructions.'],
      ['Workload', 'The same 2 projects; task sizes inside the range of the 4 weeks before.'],
      ['The shift', 'Starts at 2.1.277 (Sep 23) in both projects.'],
      ['Sample', `${(N.agent.recent.exchanges + N.agent.baseline.exchanges).toLocaleString('en-US')} exchanges, ${N.agent.recent.sessionDays + N.agent.baseline.sessionDays} session-days, ${N.agent.recent.sessions + N.agent.baseline.sessions} sessions (both windows).`],
      ['Not visible', 'Other machines; anything before Sep 5.'],
    ],
    n: N.agent,
    metrics: [
      B.agent.m('toolErrors', 'Tool errors', 'errors', 274, 3080, 196, 5560, 2.0, 'moved', { linesUpWith: 'E' }),
      B.agent.m('blindEdits', 'Edits without reading first', 'research', 70, 402, 80, 815, 1.7, 'moved', { linesUpWith: 'E' }),
      B.agent.rpe(2010, 402, 4240, 815, 1.4, 'none'),
      ctx('interrupts', 'Interruptions', 'friction', 6, 395, 14, 800, '6 in the recent window (needs 10); context only'),
    ],
    timeline: label([
      { day: '2026-08-27', side: 'agent', kind: 'version', label: 'Claude Code 2.1.249 → 2.1.255', routine: true },
      { day: '2026-09-03', side: 'agent', kind: 'version', label: 'Claude Code 2.1.255 → 2.1.262', routine: true },
      { day: '2026-09-12', side: 'agent', kind: 'version', label: 'Claude Code 2.1.262 → 2.1.266', routine: true },
      { day: '2026-09-18', side: 'agent', kind: 'version', label: 'Claude Code 2.1.266 → 2.1.274', routine: true },
      { day: '2026-09-23', side: 'agent', kind: 'version', label: 'Claude Code 2.1.274 → 2.1.277', shift: true },
      { day: '2026-09-30', side: 'agent', kind: 'version', label: 'Claude Code 2.1.277 → 2.1.281', routine: true },
    ]),
    daily: { metric: 'toolErrors',
      baseline: rows(BASE, 196, 5560, 51, { zero: [6, 20], low: [13] }),
      recent: rows(RECENT, 274, 3080, 52, { low: [7], rate: i => (i >= 3 ? 2.9 : 1) }) },
  },
  codex: {
    agent: 'codex', state: 'insufficient', reason: 'calibration_pending', label: 'Timeline only',
    headline: 'Timeline only, for now.',
    because: 'Findings for Codex are off until wasitme’s tests pass for Codex logs. Here’s what changed.',
    detail: 'Codex’s baseline also has 8 of the 10 session-days a comparison needs, and your recent Codex sessions are mostly scripted runs.',
    next: 'Keep working normally; the timeline updates every 15 minutes.',
    progress: { have: 8, need: 10, unit: 'session-days in the baseline' },
    n: { recent: { exchanges: 96, sessions: 14, sessionDays: 12, activeDays: 9 }, baseline: { exchanges: 41, sessions: 6, sessionDays: 8, activeDays: 8 } },
    timeline: label([
      { day: '2026-09-09', side: 'agent', kind: 'version', label: 'Codex CLI 0.91 → 0.92', routine: true },
      { day: '2026-09-16', side: 'agent', kind: 'version', label: 'Codex CLI 0.92 → 0.94', routine: true },
      { day: '2026-09-25', side: 'you', kind: 'model', label: 'Model gpt-6 → gpt-6-luna' },
      { day: '2026-09-29', side: 'agent', kind: 'version', label: 'Codex CLI 0.94 → 0.95', routine: true },
      { day: '2026-10-02', side: 'you', kind: 'effort', label: 'Reasoning effort medium → high' },
    ]),
  },
};
// The confidence line (DESIGN.md §3), from both windows of each case
const CONFIDENCE = 'Based on {exchanges} exchanges over {sessionDays} session-days ({sessions} sessions) on this Mac. Sessions on other machines aren’t visible.';
for (const c of Object.values(cases)) {
  // the summed numbers are stored too, so every number on a screen traces to a number in this file
  c.n.total = Object.fromEntries(['exchanges', 'sessionDays', 'sessions'].map(k => [k, c.n.recent[k] + c.n.baseline[k]]));
  const t = k => c.n.total[k].toLocaleString('en-US');
  c.confidence = CONFIDENCE.replace('{exchanges}', t('exchanges')).replace('{sessionDays}', t('sessionDays')).replace('{sessions}', t('sessions'));
}
const lastVersion = [...cases.insufficient.timeline].reverse().find(e => e.side === 'agent' && e.kind === 'version').label.split(' → ')[1];

const out = {
  _label: 'ANALYTIC DEMO DATA v3 — synthetic and deterministic (gen/make-demo-v3.mjs). NOT engine output. Every image made from it says "demo data v3 (analytic) — not engine output". README and launch images must come from `wasitme demo` engine output instead (release gate, D21).',
  version: 3,
  supersedes: 'design/demo-data.v2.json for every rendered screen (adds a timeline and integer daily rows per case, numbers for the agent case, engine-template copy, ranges and MDEs derived with the engine formulas; removes the false-agent-rate claim; research signals, not friction, unlock a finding per D30). Every number change from v2 is listed in DESIGN.md section 11.',
  windows: { recent: { from: '2026-09-20', to: '2026-10-03', days: 14 }, baseline: { from: '2026-08-23', to: '2026-09-19', days: 28 }, today: '2026-10-04', note: 'today excluded (incomplete day)' },
  trackingStarted: '2026-09-05',
  method: { range: 'exp(ln ratio ± t.995(df)·se), METHOD.md §6; printed as "range"', mde: 'exp((t.995 + t.80)(df)·se·1.1), METHOD.md §6 and engine gates/evaluate.ts: the smallest change that would show at this volume', df: 'Welch–Satterthwaite over the two windows: session-days − 1 per window, variance weight 1/events (edits for reads per edit)', se: 'hand-set analytic value, chosen so the MDE rounds to the number the copy prints; not computed from daily rows', ratiosFrom: 'recent k/n ÷ baseline k/n, rounded to 2 places (the range is centred on the unrounded ratio)' },
  confidenceTemplate: CONFIDENCE,
  cases,
  setup: { agentVersion: `Claude Code ${lastVersion}`, model: 'opus-5-5', effort: 'medium', mcpServers: 6, skills: 14, instructionsSize: '3.1k tokens', hooks: 2, codex: { version: 'Codex CLI 0.95', model: 'gpt-6-luna', effort: 'high' } },
  coverageNote: 'Only sessions on this Mac are visible. Config tracking started Sep 5; earlier edits are invisible except what your logs recorded.',
};
writeFileSync(join(ROOT, 'demo-data.v3.json'), JSON.stringify(out, null, 1) + '\n');
console.log('wrote demo-data.v3.json');
