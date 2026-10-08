// Control Center (1280 x 800): Finding page per case, plus the Timeline, Compare and Setup tabs.
import { T, DEMO, STAMP, esc, fdate, num, x2, glyph, mark, wordmark, chip, marker, page, forest, forestAxis, strip } from './kit.mjs';

const W = DEMO.windows;
const NAV = ['Timeline', 'Finding', 'Compare', 'Setup', 'Report', 'Sources', 'Settings'];

export function sidebar(c, active, stateForGlyph) {
  const n = c.n?.recent;
  const meta = {
    Timeline: `${c.timeline.length} changes`,
    Finding: glyph(stateForGlyph, 16),
    Setup: c.agent === 'codex' ? 'effort high' : 'effort medium',
    Sources: '2 agents',
  };
  return `<aside class="sidebar">
  <div class="lights"><i></i><i></i><i></i></div>
  <div class="brand">${mark(22)}${wordmark()}</div>
  <div class="switcher"><span class="${c.agent === 'codex' ? '' : 'on'}">Claude Code</span><span class="${c.agent === 'codex' ? 'on' : ''}">Codex</span></div>
  <ul class="nav">${NAV.map(p => `<li class="${p === active ? 'on' : ''}"><span>${p}</span><span class="meta">${meta[p] ?? ''}</span></li>`).join('')}</ul>
  <div class="side-foot">
    ${n ? `<div class="nblock"><h4>Read in the last 14 days</h4><div>Exchanges<b>${num(n.exchanges)}</b></div><div>Session-days<b>${n.sessionDays}</b></div><div>Sessions<b>${n.sessions}</b></div></div>` : ''}
    <div class="localonly">${esc(T.copy.privacyShort)}<br>updated 4 min ago</div>
  </div>
</aside>`;
}

export function topbar(buttons = true) {
  return `<header class="topbar">
  <span class="field"><span class="lab">Recent</span><span class="val">${fdate(W.recent.from)} – ${fdate(W.recent.to)}</span><span class="unit">14 days</span></span>
  <span class="field"><span class="lab">compared with</span><span class="val">${fdate(W.baseline.from)} – ${fdate(W.baseline.to)}</span><span class="unit">28 days</span></span>
  <span class="spacer"></span>
  ${buttons ? `<span class="btn">Check again</span><span class="btn">Open as Markdown</span><span class="btn btn--primary">Copy evidence report</span>` : '<span class="btn">Check again</span>'}
</header>`;
}

const ctxLine = c => `${c.agent === 'codex' ? 'Codex' : 'Claude Code'}, last 14 days against the 4 weeks before`;
const inRecent = e => e.day >= W.recent.from && e.day <= W.recent.to;
const evHtml = (e, hitText) => `<span class="ev${hitText ? ' hit' + (e.side === 'agent' ? ' agent' : '') : ''}">${marker(e)}<span class="d">${fdate(e.day)}</span>${esc(e.label.replace(/^Claude Code /, ''))}${hitText ? ` <span class="tag">${esc(hitText)}</span>` : ''}</span>`;

function lanes(c, rule = 'solid') {
  const ev = c.timeline.filter(inRecent);
  const hit = e => e.shift || (c.metrics || []).some(m => m.linesUpWith === e.marker);
  const yours = ev.filter(e => e.side === 'you'), theirs = ev.filter(e => e.side === 'agent');
  const agentName = c.agent === 'codex' ? 'Codex' : 'Claude Code';
  const focus = c.state === 'you' ? 'you' : c.state === 'agent' ? 'agent' : null;
  const youLane = focus === 'you' ? yours.filter(hit).map(e => evHtml(e, 'lines up with the shift')).join('') : yours.length ? yours.map(e => evHtml(e, e.candidate ? 'a candidate' : hit(e) ? 'lines up with the shift' : '')).join('')
    : `<span class="none">No recorded change on your side in the recent window.</span>`;
  const agLane = focus === 'agent' ? theirs.filter(hit).map(e => evHtml(e, 'lines up with the shift')).join('') : theirs.length ? theirs.map(e => evHtml(e, e.candidate ? 'a candidate' : hit(e) ? 'lines up with the shift' : '')).join('') + (theirs.some(e => hit(e) || e.candidate) ? '' : `<span class="aside">updates alone aren’t evidence</span>`)
    : `<span class="none">No ${agentName} update in the recent window.</span>`;
  return { youLane, agLane, agentName, rule };
}

function finding(c, state) {
  return `<div class="finding">
    <div class="meta">${chip(state, c.label)}<span class="ctx">${esc(ctxLine(c))}</span></div>
    <h1 class="t-display">${esc(c.headline)}</h1>
    <p class="t-deck">${esc(c.because)}</p>
    ${c.detail ? `<p class="t-note">${esc(c.detail)}</p>` : ''}
  </div>`;
}

function sidepanel(c) {
  if (c.state === 'insufficient' && c.progress && c.reason !== 'calibration_pending') {
    const p = c.progress;
    const cells = Array.from({ length: p.need }, (_, i) => `<i class="${i < p.have ? '' : 'off'}"></i>`).join('');
    return `<div class="sidepanel"><h3>Next to unlock</h3>
      <div class="progress"><span class="lbl">Reads per edit</span><span class="num">${p.have} of ${p.need}</span></div>
      <div class="progress"><span class="cells">${cells}</span></div>
      <p>Edits in the recent window. No date yet: it depends on how your sessions go. Then wasitme has the second kind of signal a finding needs.</p>
      <p>${esc(c.next)}</p></div>`;
  }
  if (c.reason === 'calibration_pending') {
    const p = c.progress;
    const cells = Array.from({ length: p.need }, (_, i) => `<i class="${i < p.have ? '' : 'off'}" style="width:14px"></i>`).join('');
    return `<div class="sidepanel"><h3>Before Codex can be compared</h3>
      <div class="progress"><span class="lbl">Baseline</span><span class="cells">${cells}</span><span class="num">${p.have} of ${p.need}</span></div>
      <p>Session-days in the 4 weeks before. Findings also wait for wasitme’s Codex tests to pass.</p><p>${esc(c.next)}</p></div>`;
  }
  // DESIGN.md §3: every none / you / agent body ends with the fixed disclaimer
  const disc = c.disclaimer ? `<p class="t-note disc">${esc(c.disclaimer)}</p>` : '';
  if (c.checked) {
    return `<div class="sidepanel"><h3>What was checked</h3><dl class="checked">${c.checked.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${disc}</div>`;
  }
  return `<div class="sidepanel"><h3>Next step</h3><p>${esc(c.next)}</p>${disc}</div>`;
}

/** The hero: the finding sits on its side of the case line (above = yours, below = the agent's, before both = neither). */
function hero(c, state) {
  const L = lanes(c);
  const dashed = state === 'insufficient' ? ' case-rule--dashed' : '';
  const pin = `<span class="glyph-pin">${glyph(state === 'calibrationPending' ? 'insufficient' : state, 18, 22)}</span>`;
  let body;
  if (state === 'you') {
    body = `<div class="lanes">
      <div class="side-label" style="align-self:start;padding-top:40px">Your side</div><div class="lane lane--finding">${finding(c, state)}<div class="lane" style="padding-top:4px">${L.youLane}</div></div>
      <div class="case-rule${dashed}" style="grid-column:1/-1">${pin}</div>
      <div class="side-label">${L.agentName}</div><div class="lane">${L.agLane}</div></div>`;
  } else if (state === 'agent') {
    body = `<div class="lanes">
      <div class="side-label">Your side</div><div class="lane">${L.youLane}<span class="aside">tracking since ${fdate(DEMO.trackingStarted)}</span></div>
      <div class="case-rule${dashed}">${pin}</div>
      <div class="side-label" style="align-self:start;padding-top:56px">${L.agentName}</div><div class="lane lane--finding below">${finding(c, state)}<div class="lane" style="padding-top:4px">${L.agLane}</div></div></div>`;
  } else {
    body = `${finding(c, state)}<div class="lanes">
      <div class="side-label">Your side</div><div class="lane">${L.youLane}</div>
      <div class="case-rule${dashed}">${pin}</div>
      <div class="side-label">${L.agentName}</div><div class="lane">${L.agLane}</div></div>`;
  }
  return `<section class="hero${c.checked ? ' hero--wide' : ''}"><div>${body}</div>${sidepanel(c)}</section>`;
}

function statusCell(m, c) {
  if (!m.eligible) return m.context || m.family === 'friction' ? `<td class="st ctx">Context only</td>` : `<td class="st">Not enough yet</td>`;
  if (m.context) return `<td class="st ctx">Context only</td>`;
  if (m.status === 'moved') {
    const e = c.timeline.find(e => e.marker === m.linesUpWith);
    return `<td class="st">Moved, ${m.ratio >= 1 ? 'more' : 'fewer'}${e ? marker(e) : ''}</td>`;
  }
  return `<td class="st">No detectable change</td>`;
}
const kn = (m, w) => m[w].k !== undefined ? `${num(m[w].k)} / ${num(m[w].n)}` : `${num(m[w].reads)} / ${num(m[w].edits)}`;

export function ledger(c, { title = 'What wasitme compared', foot = true } = {}) {
  const rows = (c.metrics || []).map(m => {
    const fam = m.family === 'friction' ? 'context' : m.family;
    if (!m.eligible) {
      const why = m.progress ? `${m.progress.have} of ${m.progress.need} edits needed` : m.ineligibleReason.replace(/; context only$/, '');
      return `<tr class="dim"><td class="sig">${esc(m.label)}<span class="fam">${fam}</span></td><td class="kn num">${kn(m, 'recent')}</td><td class="kn num">${kn(m, 'baseline')}</td><td class="x" colspan="2"><span class="t-note">${esc(why)}</span></td>${statusCell(m, c)}</tr>`;
    }
    const moved = m.status === 'moved';
    // canary / blue only when the finding names that side; a moved metric in an unclear finding gets a neutral tint
    const side = c.timeline.find(e => e.marker === m.linesUpWith)?.side;
    const tint = side === 'agent' ? ' agent' : side === 'you' ? '' : ' neutral';
    return `<tr><td class="sig">${esc(m.label)}<span class="fam">${fam}</span></td><td class="kn num">${kn(m, 'recent')}</td><td class="kn num">${kn(m, 'baseline')}</td><td class="x${moved && !m.context ? ' moved' + tint : ''}">${x2(m.ratio)}<span class="rng">${x2(m.range[0])}–${x2(m.range[1])}</span></td><td>${forest({ ratio: m.ratio, range: m.range, mde: m.mde, moved: moved && !m.context }, 220)}</td>${statusCell(m, c)}</tr>`;
  }).join('');
  return `<section class="ledger">
  <table><thead><tr><th>${esc(title)}</th><th class="num">recent</th><th class="num">before</th><th>change, range</th><th>${forestAxis(220)}</th><th>status</th></tr></thead><tbody>${rows}</tbody></table>
  ${foot ? `<div class="foot"><span>Counts are events / opportunities in each window. Bar: the range; dot: the estimate (open: no detectable change); hatched: changes too small to show at your volume.</span></div>` : ''}
  ${foot && c.confidence ? `<p class="conf">${esc(c.confidence)}</p>` : ''}
</section>`;
}

function evidence(c) {
  const tm = (c.metrics || []).find(m => m.id === c.daily.metric);
  const ratioLine = tm ? `<span class="right"><b>${x2(tm.ratio)}</b>, range ${x2(tm.range[0])} to ${x2(tm.range[1])}; changes under ×${tm.mde} wouldn’t show</span>` : '';
  return `<section class="evidence">
  <div class="sec-head"><h2 class="t-heading">Tool errors per day</h2><p class="t-note">one tick per error; narrow: under ${T.chart.strip.lowNThreshold} calls that day</p>${ratioLine}</div>
  ${strip(c, { width: 984 })}
</section>`;
}

function codexBody(c) {
  const rows = [...c.timeline].reverse().map(e => `<tr><td class="kn">${fdate(e.day)}</td><td>${marker(e)}</td><td class="sig">${esc(e.label)}</td><td class="st ctx">${e.side === 'you' ? 'your side' : 'Codex update'}${inRecent(e) ? ', recent window' : ''}</td></tr>`).join('');
  return `<section class="evidence"><div class="sec-head"><h2 class="t-heading">What changed, and when</h2><p class="t-note">your changes above the line, Codex’s below; six weeks</p></div>
  ${strip(c, { width: 984, show: 42, eventsOnly: true })}</section>
  <section class="ledger"><table><thead><tr><th>Date</th><th></th><th>Change</th><th>Side</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function findingPage(key) {
  const c = DEMO.cases[key];
  const state = c.reason === 'calibration_pending' ? 'calibrationPending' : c.state;
  const glyphState = state === 'calibrationPending' ? 'insufficient' : state;
  const body = `<div class="window">${sidebar(c, 'Finding', glyphState)}<main class="content">${topbar(true)}${hero(c, state)}${c.daily ? evidence(c) : ''}${c.metrics ? ledger(c) : ''}${c.agent === 'codex' ? codexBody(c) : ''}<footer class="stamp"><span>${STAMP}</span><span>checked Oct 4, 09:14</span></footer></main></div>`;
  return page({ title: `wasitme · ${c.headline}`, w: 1280, h: 800, body });
}

// ---------- tabs ----------
function tabShell(c, active, glyphState, top, inner) {
  return `<div class="window">${sidebar(c, active, glyphState)}<main class="content">${top}${inner}<footer class="stamp"><span>${STAMP}</span><span>checked Oct 4, 09:14</span></footer></main></div>`;
}
const filterBar = fields => `<header class="topbar">${fields.map(([l, v]) => `<span class="field"><span class="lab">${esc(l)}</span><span class="val">${esc(v)}</span></span>`).join('')}<span class="spacer"></span><span class="btn">Check again</span></header>`;

export function timelinePage() {
  const c = DEMO.cases.insufficient;
  const tm = c.metrics[0];
  const rows = [...c.timeline].reverse().map(e => {
    const inR = inRecent(e);
    const note = e.side === 'you' ? 'your change' : 'Claude Code update; updates alone aren’t evidence';
    return `<tr><td class="kn">${fdate(e.day)}</td><td>${marker(e)}</td><td class="sig">${esc(e.label)}</td><td class="st ctx">${esc(note)}</td><td class="st">${inR ? 'recent window' : 'before'}</td></tr>`;
  }).join('') + `<tr class="dim"><td class="kn">${fdate(DEMO.trackingStarted)}</td><td></td><td class="sig">wasitme started tracking your setup</td><td class="st ctx">earlier edits only show if your logs recorded them</td><td class="st ctx">before</td></tr>`;
  const inner = `<section class="evidence" style="padding-top:18px">
  <div class="sec-head"><h1 class="t-title">Timeline</h1><p class="t-note">everything wasitme saw change on each side, over the tool-error strip it is compared with</p></div>
  <div class="sec-head" style="margin-top:8px"><h2 class="t-heading">Tool errors per day, six weeks</h2><p class="t-note">one tick per error; narrow: under ${T.chart.strip.lowNThreshold} calls that day</p><span class="right">before ${tm.baseline.k} / ${num(tm.baseline.n)} calls; recent ${tm.recent.k} / ${num(tm.recent.n)}</span></div>
  ${strip(c, { width: 984, show: 42, nRow: false })}</section>
  <section class="ledger"><table><thead><tr><th>Date</th><th></th><th>What changed</th><th>Note</th><th>Window</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  return page({ title: 'wasitme · Timeline', w: 1280, h: 800, body: tabShell(c, 'Timeline', 'insufficient', filterBar([['Showing', 'Claude Code'], ['signal', 'Tool errors'], ['over', 'Aug 23 – Oct 3']]), inner) });
}

export function comparePage() {
  const c = DEMO.cases.you;
  const tm = c.metrics[0];
  const half = (rowsArr, label, totals, win, today) => {
    const sub = { ...c, daily: { ...c.daily, baseline: [], recent: rowsArr }, timeline: c.timeline };
    return `<div class="cmp-half"><div class="sec-head"><h2 class="t-heading">${esc(label)}</h2><span class="right">${totals}</span></div>${strip(sub, { width: 478, show: 14, gutter: 72, labels: true, windowLabel: win, today })}</div>`;
  };
  const inner = `<section class="evidence" style="padding-top:16px">
  <div class="sec-head"><h1 class="t-title">Compare</h1><p class="t-note">pick two windows, or the days around one of your changes; wasitme recomputes every signal with its range</p></div>
  <div class="presets"><span class="preset on">Recent 14 days vs the 4 weeks before</span>${[c.timeline.find(e => e.side === 'you' && e.kind === 'effort'), c.timeline.find(e => e.side === 'agent' && e.day >= W.recent.from)].filter(Boolean).map(e => `<span class="preset">Around ${marker(e)} ${esc(e.side === 'you' ? e.label : e.label.split(' → ')[1] || e.label)}, ${fdate(e.day)}</span>`).join('')}<span class="preset">Custom…</span></div>
  <div class="cmp-two">${half(c.daily.baseline.slice(-14), 'Before (last 14 of 28 days)', `all 28 days: ${tm.baseline.k} / ${num(tm.baseline.n)}`, 'before, Sep 6 – Sep 19 shown', false)}${half(c.daily.recent, 'Recent', `${tm.recent.k} / ${num(tm.recent.n)}`, 'recent, 14 days', true)}</div></section>
  ${ledger(c, { title: 'Signal' })}`;
  const css = `.presets { display: flex; gap: 8px; margin: 10px 0 6px; flex-wrap: wrap; }
.preset { display: inline-flex; align-items: center; gap: 6px; font: var(--type-typed-sm); padding: 5px 10px; border: 1px solid var(--rule-strong); border-radius: var(--radius-control); color: var(--ink-secondary); }
.preset.on { border-color: var(--ink-primary); color: var(--ink-primary); font-weight: 700; box-shadow: inset 0 -2px 0 var(--ink-primary); }
.cmp-two { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }`;
  return page({ title: 'wasitme · Compare', w: 1280, h: 800, extraCss: css, body: tabShell(c, 'Compare', 'you', topbar(true), inner) });
}

export function setupPage() {
  const c = DEMO.cases.insufficient, s = DEMO.setup;
  const last = pred => [...c.timeline].reverse().find(pred);
  const ver = last(e => e.side === 'agent' && e.kind === 'version'), eff = last(e => e.side === 'you' && e.kind === 'effort'), mcp = last(e => e.side === 'you' && e.kind === 'mcp');
  const rows = [
    ['Claude Code', s.agentVersion, ver, fdate(ver.day)], ['Model', s.model, null, 'unchanged since tracking started'], ['Effort', s.effort, eff, `${fdate(eff.day)}, from ${eff.label.split(' → ')[0].replace(/^Effort /, '')}`],
    ['MCP servers', String(s.mcpServers), mcp, `${fdate(mcp.day)}, ${mcp.label.replace(/^MCP server /, 'one ')}`], ['Skills', String(s.skills), null, 'unchanged'], ['Instructions', s.instructionsSize, null, 'unchanged'], ['Hooks', String(s.hooks), null, 'unchanged'],
  ].map(([k, v, e, when]) => `<tr><td class="sig">${esc(k)}</td><td class="x">${esc(v)}</td><td>${e ? marker(e) : ''}</td><td class="st ctx">${esc(when)}</td></tr>`).join('');
  const integ = [['Menu bar', 'on'], ['Desktop panel', 'on, small'], ['Claude Code mod and status line', 'installed'], ['Codex skills', 'installed'], ['Login item', 'on']]
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const inner = `<section class="evidence" style="padding-top:16px"><div class="sec-head"><h1 class="t-title">Setup</h1><p class="t-note">what wasitme can see about your side, and since when</p></div></section>
  <div class="setup-grid"><section class="ledger" style="padding-top:4px"><table><thead><tr><th>Your Claude Code setup</th><th>now</th><th></th><th>last change</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="foot"><span>${esc(DEMO.coverageNote)}</span></div>
  <div class="sec-head" style="margin-top:22px"><h2 class="t-heading">What changed, six weeks</h2><p class="t-note">yours above the line, Claude Code’s below</p></div>${strip(c, { width: 640, show: 42, gutter: 92, eventsOnly: true })}</section>
  <aside class="sidepanel" style="margin:4px 32px 0 0"><h3>Coverage</h3><p>Logs read: ~/.claude/projects (Claude Code) and ~/.codex/sessions (Codex). Config snapshots since ${fdate(DEMO.trackingStarted)}.</p>
  <h3 style="margin-top:14px">Connected</h3><dl class="checked">${integ}</dl>
  <h3 style="margin-top:14px">Privacy</h3><p>${esc(T.copy.privacyLine.replace(/`/g, ''))} The report contains numbers only: no prompts, code or paths.</p></aside></div>`;
  const css = `.setup-grid { display: grid; grid-template-columns: 1fr 340px; gap: 32px; }
.setup-grid .checked div { grid-template-columns: 150px 1fr; }`;
  return page({ title: 'wasitme · Setup', w: 1280, h: 800, extraCss: css, body: tabShell(c, 'Setup', 'insufficient', topbar(false), inner) });
}
