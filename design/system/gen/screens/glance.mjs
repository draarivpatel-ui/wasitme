// Glance surfaces: the menu bar popover (352 x 480) and the desktop panel (170 x 170, 360 x 170).
import { T, DEMO, STAMP, esc, fdate, num, x2, glyph, chip, page, strip } from './kit.mjs';

const POP_CSS = `
.pop { width: var(--size-popover-width); height: var(--size-popover-height); background: var(--surface-raised); border: 1px solid var(--rule-strong); border-radius: var(--radius-popover); display: flex; flex-direction: column; overflow: hidden; }
.pop-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 0; }
.pop-head .agent { font: var(--type-typed-sm); color: var(--ink-muted); }
.pop-body { padding: 6px 16px 0; }
.pop h1 { font: var(--type-pop-title); letter-spacing: var(--type-pop-title-tracking); margin: 0 0 4px; }
.pop .deck { font: var(--type-ui); line-height: var(--type-typed-lg-line); color: var(--ink-secondary); margin: 0; }
.mrows { margin: 6px 16px 0; border-top: 2px solid var(--rule-ink); }
.mrow { display: grid; grid-template-columns: 1fr auto; gap: 0 8px; padding: 1px 0; border-bottom: 1px solid var(--rule-hair); }
.mrow .l { font: var(--type-ui); line-height: var(--type-typed-line); }
.mrow .v { font: var(--type-typed-sm); font-weight: 700; text-align: right; }
.mrow .n { font: var(--type-typed-sm); color: var(--ink-muted); }
.mrow .s { font: var(--type-typed-sm); color: var(--ink-secondary); text-align: right; }
.pop-foot { margin-top: auto; padding: 5px 16px 6px; border-top: 1px solid var(--rule-hair); }
.pop-foot .btns { display: flex; gap: 6px; }
.pop-foot .btn { height: var(--size-button-compact-height); }
.pop-foot .btn--primary { margin-left: auto; }
.pop-foot .meta { display: flex; justify-content: space-between; margin-top: 4px; font: var(--type-typed-sm); color: var(--ink-muted); }
.pop .disc { font: var(--type-note); line-height: var(--type-typed-sm-line); color: var(--ink-secondary); margin: 3px 16px 0; }`;

function metricRows(c) {
  const rows = (c.metrics || []).slice(0, 3).map(m => {
    const N = m.recent.n !== undefined ? `N ${num(m.recent.n)} ${m.id === 'toolErrors' ? 'calls' : m.family === 'friction' ? 'prompts' : 'edits'}` : `N ${num(m.recent.edits)} edits`;
    if (!m.eligible) return `<div class="mrow"><span class="l">${esc(m.label)}</span><span class="v">${m.progress ? `${m.progress.have} of ${m.progress.need}` : `${m.recent.k} in 14 days`}</span><span class="n">${m.progress ? 'edits so far' : N}</span><span class="s">${m.family === 'friction' ? 'Context only' : 'Not enough yet'}</span></div>`;
    const moved = m.status === 'moved';
    return `<div class="mrow"><span class="l">${esc(m.label)}</span><span class="v">${x2(m.ratio)} <span class="n" style="font-weight:400">${x2(m.range[0])}–${x2(m.range[1])}</span></span><span class="n">${N}</span><span class="s">${moved ? `Moved, ${m.ratio >= 1 ? 'more' : 'fewer'}` : 'Not detected'}</span></div>`;
  }).join('');
  return `<div class="mrows">${rows}</div>`;
}

export function popover(key) {
  const stale = key === 'stale';
  const c = DEMO.cases[stale ? 'insufficient' : key];
  const tm = c.metrics.find(m => m.id === 'toolErrors');
  const head = stale
    ? `<div class="pop-head">${chip('stale')}<span class="agent">Claude Code</span></div><div class="pop-body"><h1>Out of date.</h1><p class="deck">The last check ran at 06:34, 2 h 40 min ago. Below is what it found then.</p></div>`
    : `<div class="pop-head">${chip(c.state)}<span class="agent">Claude Code</span></div><div class="pop-body"><h1>${esc(c.headline)}</h1><p class="deck">${esc(c.because)}</p></div>`;
  const body = `<div class="pop${stale ? ' is-stale' : ''}" role="dialog" aria-label="wasitme">${head}
  <div class="pop-body was" style="padding-top:8px">${strip(c, { width: 320, show: 14, gutter: 0, compact: true, labels: false, nRow: false, compactHeight: 28 })}</div>
  <div class="was">${metricRows(c)}${!stale && c.disclaimer ? `<p class="disc">${esc(c.disclaimer)}</p>` : ''}</div>
  <div class="pop-foot"><div class="btns">${stale ? '<span class="btn btn--primary" style="margin-left:0">Check again</span><span class="btn">Open wasitme</span>' : '<span class="btn">It feels worse…</span><span class="btn">Share</span><span class="btn btn--primary">Open wasitme</span>'}</div>
  <div class="meta"><span>${stale ? 'Updated 2 h 40 min ago' : 'Updated 4 min ago'}, ${esc(T.copy.privacyShort)}</span></div><div class="meta stamp-l">${STAMP}</div></div></div>`;
  return page({ title: 'wasitme popover', w: T.size.popover.width, h: T.size.popover.height, body, extraCss: POP_CSS + '\n.pop-foot .stamp-l { margin-top: 2px; }' });
}

export function desktopPanels() {
  const tile = (key, size, theme) => {
    const st = key === 'stale' ? 'stale' : DEMO.cases[key].state, c = DEMO.cases[key === 'stale' ? 'insufficient' : key];
    const label = T.states[st].label;
    const wide = size === 'medium';
    const s = strip(c, { width: 176, show: 14, gutter: 0, compact: true, labels: false, nRow: false, kRow: false, caption: 'errors per day, 14 days' });
    return `<div class="dp dp--${size}" data-glance="${esc(label)}">
      <div class="dp-top">${glyph(st, 18, T.size.panelGlyph)}</div>
      <div class="dp-label">${esc(label)}</div>
      <div class="dp-meta">Claude Code<br>${key === 'stale' ? 'checked 2 h 40 min ago' : key === 'you' ? '+1 new change<br>4 min ago' : wide ? 'updated 4 min ago' : '4 min ago'}</div>
      ${wide ? `<div class="dp-strip">${s}</div>` : ''}
    </div>`;
  };
  // tiles at their real sizes (flex: none), small row then medium row
  const rowFor = theme => `<div class="desk">${['insufficient', 'you', 'stale'].map(k => tile(k, 'small', theme)).join('')}<i class="brk"></i>${['insufficient', 'you'].map(k => tile(k, 'medium', theme)).join('')}</div>`;
  const body = `<div class="ds"><header><h1 class="t-title">Desktop panel</h1><p class="t-note">170 × 170 and 360 × 170, at desktop-icon level. Glance rules: the state, a count of new changes and the time; never a cause, never “worse” or “better”. Out of date after 2 hours.</p></header>
  ${rowFor('light')}<footer class="stamp2"><span>${STAMP}</span><span>the strip is the same integer daily strip as the app, without labels</span></footer></div>`;
  const css = `
.ds { padding: 28px 40px 16px; background: var(--surface-page); height: 100%; display: flex; flex-direction: column; gap: 18px; }
.ds header { display: flex; align-items: baseline; gap: 24px; }
.desk { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; padding: 22px; border-radius: 16px; background: var(--surface-page); border: 1px solid var(--rule-hair); }
.desk .brk { flex-basis: 100%; height: 0; }
.dp { flex: none; width: var(--size-panel-small-width); height: var(--size-panel-small-height); border-radius: var(--radius-panel); background: var(--surface-raised); color: var(--ink-primary); border: 1px solid var(--rule-strong); padding: 16px; display: flex; flex-direction: column; position: relative; }
.dp--medium { width: var(--size-panel-medium-width); height: var(--size-panel-medium-height); display: grid; grid-template-columns: 150px 1fr; grid-template-rows: auto auto 1fr; column-gap: 8px; }
.dp--medium .dp-strip { grid-column: 2; grid-row: 1 / 4; align-self: end; }
.dp-top { display: flex; justify-content: space-between; align-items: flex-start; }
.dp-label { font: var(--type-heading); margin-top: auto; }
.dp--small .dp-label { font-size: var(--type-deck-size); line-height: var(--type-typed-lg-line); }
.dp--medium .dp-label { margin-top: 30px; }
.dp-meta { font: var(--type-typed-sm); color: var(--ink-secondary); margin-top: 6px; }
.stamp2 { margin-top: auto; display: flex; justify-content: space-between; font: var(--type-typed-sm); color: var(--ink-muted); border-top: 1px solid var(--rule-hair); padding-top: 8px; }`;
  return page({ title: 'wasitme desktop panel', w: 1280, h: 620, body, extraCss: css });
}
