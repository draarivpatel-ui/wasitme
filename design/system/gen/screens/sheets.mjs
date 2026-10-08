// Reference sheets: the menu bar glyph sheet and the app icon sheet.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib.mjs';
import { T, STAMP, esc, glyph, appGlyph, appChip, mark, wordmark, page } from './kit.mjs';

const STATES = [...T.states.order, ...T.states.displayOnly];
const layout = JSON.parse(readFileSync(join(ROOT, 'glyphs/capture-layout.json'), 'utf8'));
const sep = readFileSync(join(ROOT, 'glyphs/separation.txt'), 'utf8');
const CAP_W = layout.cols * layout.cell;
/** The glyph sheet's height (build.mjs sizes the PNG with it): the states, then the app states. */
export const SHEET_H = 2010;

/** nearest-neighbour zoom into the true-1x capture */
function zoom(name, theme, px, z = 5) {
  const it = layout.items.find(i => i.name === name && i.theme === theme && i.px === px);
  const pad = 2, w = (px + pad * 2) * z;
  return `<span class="zoom" style="width:${w}px;height:${w}px;background-image:url(../glyphs/capture-1x.png);background-size:${CAP_W * z}px auto;background-position:-${(it.x - pad) * z}px -${(it.y - pad) * z}px"></span>`;
}
const neighbourL = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 10 L14 14" stroke="currentColor" stroke-width="1.75"/></svg>`;
const neighbourR = `<svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true"><rect x="1.5" y="3.5" width="18" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1"/><rect x="3" y="5" width="11" height="6" rx="1" fill="currentColor"/><rect x="20.5" y="6" width="1.5" height="4" rx=".75" fill="currentColor"/></svg>`;

function bar(theme, state, px, extra = '') {
  return `<span class="mbar mbar--${theme}"><span class="nb">${neighbourL}</span><span class="ours" data-glance="${esc(T.states[state].label)}">${glyph(state, px)}${extra}</span><span class="nb">${neighbourR}</span><span class="clock">9:41</span></span>`;
}

function barApp(theme, s, px) {
  return `<span class="mbar mbar--${theme}"><span class="nb">${neighbourL}</span><span class="ours" data-glance="${esc(T.appStates[s].label)}">${appGlyph(s, px)}</span><span class="nb">${neighbourR}</span><span class="clock">9:41</span></span>`;
}

/** The app's own document states: same rule, changed itself; never a side. */
function appSection() {
  const A = T.appStates.order;
  const lines = [...sep.matchAll(/## light bar, 16 px[\s\S]*?app states, closest pairs: ([^\n]*)/g)][0];
  const interim = /## light bar, 16 px[\s\S]*?the interim error glyph[^:]*: (\d+) px/.exec(sep);
  const unreadable = /## light bar, 16 px[\s\S]*?app unreadable: [^\n]*÷ (\d+) px/.exec(sep);
  const head = A.map(s => `<th><span class="code">${s}</span><span class="lab">${esc(T.appStates[s].label)}</span></th>`).join('');
  const body = [
    ['Light bar, 16 px', s => barApp('light', s, 16)],
    ['Dark bar, 18 px', s => barApp('dark', s, 18)],
  ].map(([lab, f]) => `<tr><th class="rl">${lab}</th>${A.map(s => `<td>${f(s)}</td>`).join('')}</tr>`).join('') +
    `<tr class="zr"><th class="rl">5× zoom, 16 px</th>${A.map(s => `<td>${zoom(s, 'light', 16, 4)}${zoom(s, 'dark', 16, 4)}</td>`).join('')}</tr>` +
    `<tr><th class="rl">Chip</th>${A.map(s => `<td>${appChip(s)}</td>`).join('')}</tr>` +
    `<tr><th class="rl">Legend line</th>${A.map(s => `<td class="t-note">${esc(T.appStates[s].legend)}</td>`).join('')}</tr>`;
  return `<section class="apps">
    <div class="apps-head"><h2 class="t-title">App states</h2>
    <p class="t-note">About wasitme itself, never a finding. Each one changes the rule itself and never puts a square above it or a triangle below it, so none can be read as a side; every one is a separate shape from the states, the mark, the toolbar icons and the menu bar’s pause and battery. Closest pairs at 16 px: ${esc(lines ? lines[1] : '')} pixels apart. The interim error glyph (a bar above the rule and a dot below) was ${esc(interim ? interim[1] : '?')} pixels from ÷; can’t-read is ${esc(unreadable ? unreadable[1] : '?')}.</p></div>
    <table class="gt"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

export function glyphSheet() {
  const closest = sep.match(/## light bar, 16 px\n {2}closest pairs: ([^\n]*)\n {2}mirror test, you vs flipped agent: (\d+)/);
  const look = sep.match(/## light bar, 16 px[\s\S]*?closest look-alike: ([^\n]*)/);
  const rows = [
    ['Light bar, 16 px', s => bar('light', s, 16)],
    ['Light bar, 18 px', s => bar('light', s, 18)],
    ['Dark bar, 16 px', s => bar('dark', s, 16)],
    ['Dark bar, 18 px', s => bar('dark', s, 18)],
    ['+ new changes', s => (s === 'stale' ? '<span class="t-note">never shown while out of date</span>' : bar('light', s, 16, '<span class="plus">+1</span>'))],
  ];
  const head = STATES.map(s => `<th><span class="code">${s}</span><span class="lab">${esc(T.states[s].label)}</span></th>`).join('');
  const body = rows.map(([lab, f]) => `<tr><th class="rl">${lab}</th>${STATES.map(s => `<td>${f(s)}</td>`).join('')}</tr>`).join('') +
    `<tr class="zr"><th class="rl">5× zoom of the true 1× pixels, 16 px</th>${STATES.map(s => `<td>${zoom(s, 'light', 16)}${zoom(s, 'dark', 16)}</td>`).join('')}</tr>` +
    `<tr class="zr"><th class="rl">18 px</th>${STATES.map(s => `<td>${zoom(s, 'light', 18)}${zoom(s, 'dark', 18)}</td>`).join('')}</tr>` +
    `<tr><th class="rl">Legend line</th>${STATES.map(s => `<td class="t-note">${esc(T.states[s].legend)}</td>`).join('')}</tr>` +
    `<tr><th class="rl">VoiceOver</th>${STATES.map(s => `<td class="t-note">“${esc(T.states[s].voiceOver.replace('{when}', '2 h ago'))}”</td>`).join('')}</tr>` +
    `<tr><th class="rl">Terminal, ASCII</th>${STATES.map(s => `<td><span class="tg">${esc(T.states[s].textGlyph)}</span> <span class="tg muted">${esc(T.states[s].ascii)}</span></td>`).join('')}</tr>`;
  const html = `<div class="sheet">
  <header class="sh-head">
    <div><div class="brand">${mark(26)}${wordmark()}</div><h1 class="t-display">Menu bar glyphs</h1></div>
    <p class="t-deck">One grammar: <b>a rule between the two sides.</b> Your changes are squares and sit above it; the agent’s are triangles and hang below it. A shape on the rule is a side the numbers moved with. Nothing on it: no detectable change. Dashed with specks: not enough yet. Struck through: out of date. Template images, pure black and alpha; macOS tints them.</p>
  </header>
  <table class="gt"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>
  <section class="cmp">
    <div><h2 class="t-heading">The mark is not a state</h2><div class="pair">${zoom('mark', 'light', 16)}${zoom('mark', 'light', 18)}${zoom('unclear', 'light', 16)}<span class="big">${mark(64)}</span></div>
      <p class="t-note">The mark has no rule; every state has one. It lives in the Dock, the wordmark and the README, never in the menu bar.</p></div>
    <div><h2 class="t-heading">Not the appearance toggle, not the info icon</h2><div class="pair">${zoom('appearance', 'light', 16)}${zoom('info', 'light', 16)}${zoom('none', 'light', 16)}${zoom('you', 'light', 16)}</div>
      <p class="t-note">No circles, no half fills, nothing enclosed. Closest look-alike at 16 px: ${esc(look ? look[1] : '')}.</p></div>
    <div><h2 class="t-heading">Measured, not eyeballed</h2>
      <p class="t-note">True 1× pixels from headless Chrome. Closest pairs at 16 px: ${esc(closest ? closest[1] : '')} pixels apart. Your side against the agent’s turned upside down: ${esc(closest ? closest[2] : '')} pixels apart, so they are different shapes, not mirror images. Full numbers: glyphs/separation.txt.</p></div>
  </section>
  ${appSection()}
  <footer class="stamp2"><span>${STAMP}</span><span>glyphs/state-*-16|18.svg, glyphs/app-*-16|18.svg</span></footer>
</div>`;
  const css = `
.sheet { padding: 40px 48px 24px; background: var(--surface-sheet); height: 100%; display: flex; flex-direction: column; }
.sh-head { display: grid; grid-template-columns: 1fr 560px; gap: 48px; align-items: end; border-bottom: 2px solid var(--rule-ink); padding-bottom: 20px; }
.sh-head .brand { padding: 0 0 8px; }
.sh-head b { font-weight: 700; }
.gt { border-collapse: collapse; width: 100%; margin-top: 8px; }
.gt th, .gt td { text-align: left; vertical-align: middle; padding: 10px 8px 10px 0; border-bottom: 1px solid var(--rule-hair); }
.gt thead th { vertical-align: bottom; }
.gt .code { display: block; font: var(--type-typed-sm); font-weight: 700; }
.gt .lab { display: block; font: var(--type-heading); font-size: var(--type-deck-size); }
.gt .rl { font: var(--type-note); color: var(--ink-muted); font-weight: 400; width: 150px; }
.gt td.t-note { line-height: var(--type-typed-line); padding-right: 16px; }
.mbar { display: inline-flex; align-items: center; gap: 12px; height: 24px; padding: 0 10px; border-radius: 6px; font: var(--type-typed-size)/1 var(--font-mono); }
.mbar--light { background: var(--surface-well); color: var(--ink-primary); border: 1px solid var(--rule-hair); }
.mbar--dark { background: var(--ink-primary); color: var(--surface-sheet); }
.mbar .nb { display: inline-flex; opacity: 1; }
.mbar .ours { display: inline-flex; align-items: center; gap: 3px; }
.mbar .plus { font: var(--type-typed-sm-size)/1 var(--font-mono); }
.mbar .clock { font: var(--type-typed-sm-size)/1 var(--font-mono); }
.zoom { display: inline-block; background-repeat: no-repeat; image-rendering: pixelated; margin-right: 6px; border: 1px solid var(--rule-hair); vertical-align: middle; }
.tg { font: var(--type-typed-size)/var(--type-typed-line) var(--font-terminal); } /* text glyphs are terminal-font only: Plex Mono has no ■ or ▲ */
.cmp { display: grid; grid-template-columns: 1.2fr 1.2fr 1fr; gap: 40px; margin-top: 24px; }
.cmp .pair { display: flex; align-items: center; gap: 4px; margin: 10px 0; }
.cmp .big { margin-left: 12px; }
.cmp p { font-size: var(--type-note-size); line-height: var(--type-note-line); }
.apps { margin-top: 28px; border-top: 2px solid var(--rule-ink); padding-top: 16px; }
.apps-head { display: grid; grid-template-columns: 1fr 820px; gap: 48px; align-items: start; }
.apps-head h2 { margin: 0; }
.apps-head p { margin: 4px 0 0; }
.apps .zr .zoom { display: block; }
.stamp2 { margin-top: auto; display: flex; justify-content: space-between; font: var(--type-typed-sm); color: var(--ink-muted); border-top: 1px solid var(--rule-hair); padding-top: 8px; }`;
  return page({ title: 'wasitme · menu bar glyphs', w: 1280, h: SHEET_H, body: html, extraCss: css });
}

export function iconSheet() {
  const html = `<div class="sheet">
  <header class="sh-head"><div><div class="brand">${mark(26)}${wordmark()}</div><h1 class="t-display">App icon</h1></div>
  <p class="t-deck">Two stickers on a ruled form: your change, numbered, and the agent’s, lettered on a tag. Flat fills, ink keylines, one small offset shadow. 1024 master on the macOS grid (824 tile, 185.4 corner).</p></header>
  <div class="masters"><figure><img src="../glyphs/appicon-1024.svg" width="400" height="400" alt="wasitme app icon, light"><figcaption class="t-note">Light, 1024 master shown at 400</figcaption></figure>
  <figure><img src="../glyphs/appicon-1024-dark.svg" width="400" height="400" alt="wasitme app icon, dark"><figcaption class="t-note">Dark appearance</figcaption></figure>
  <figure class="sizes">${[128, 64, 32, 16].map(px => `<span><img src="../glyphs/appicon-1024.svg" width="${px}" height="${px}" alt=""><em class="t-typed-sm">${px} px</em></span>`).join('')}
  <figcaption class="t-note">128, 64, 32 and 16 px at 1×. At 32 px it still reads as a yellow square and a blue tag.</figcaption></figure></div>
  <div class="dock"><span class="t-note">In a Dock row</span>${['', '', 'us', '', ''].map(x => x ? `<img src="../glyphs/appicon-1024.svg" width="64" height="64" alt="">` : '<i class="other"></i>').join('')}</div>
  <footer class="stamp2"><span>${STAMP}</span><span>glyphs/appicon-1024.svg, glyphs/appicon-1024-dark.svg</span></footer></div>`;
  const css = `
.sheet { padding: 40px 48px 24px; background: var(--surface-sheet); height: 100%; display: flex; flex-direction: column; }
.sh-head { display: grid; grid-template-columns: 1fr 560px; gap: 48px; align-items: end; border-bottom: 2px solid var(--rule-ink); padding-bottom: 20px; }
.masters { display: flex; gap: 40px; align-items: flex-end; margin-top: 28px; }
figure { margin: 0; }
figcaption { margin-top: 8px; font-size: var(--type-note-size); }
.sizes { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 18px; width: 300px; }
.sizes span { display: inline-flex; flex-direction: column; align-items: center; gap: 6px; color: var(--ink-muted); }
.sizes em { font-style: normal; }
.dock { margin-top: 28px; display: flex; align-items: center; gap: 14px; padding: 10px 18px; background: var(--surface-well); border: 1px solid var(--rule-hair); border-radius: 18px; width: max-content; }
.dock .other { width: 64px; height: 64px; border-radius: 14px; background: var(--rule-strong); display: block; }
.stamp2 { margin-top: auto; display: flex; justify-content: space-between; font: var(--type-typed-sm); color: var(--ink-muted); border-top: 1px solid var(--rule-hair); padding-top: 8px; }`;
  return page({ title: 'wasitme · app icon', w: 1280, h: 820, body: html, extraCss: css });
}
