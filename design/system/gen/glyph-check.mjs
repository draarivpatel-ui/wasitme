// Rasterises every menu-bar glyph at true 1x in headless Chrome (black on a light bar, white on a dark bar),
// then measures how far apart they are. Writes:
//   glyphs/capture-1x.png      the raw 1x capture (the glyph sheet zooms into it with nearest-neighbour)
//   glyphs/capture-layout.json where each glyph sits in the capture
//   glyphs/separation.txt      pixel coverage maps, pairwise distances, the mirror (flip) test
// Glyphs: the six states, the mark, and the six app states (tokens.json appStates); look-alikes: the appearance toggle
// and the info icon (toolbar neighbours), pause and battery (menu-bar neighbours), and ÷ (what the app's interim
// "error" glyph looked like before the app states were drawn).
// Needs Google Chrome; not part of `npm test` (CI has no Chrome). Run: node design/system/gen/glyph-check.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodePng } from './png.mjs';
import { ROOT, loadTokens, appGlyphKey } from './lib.mjs';

const T = loadTokens();
const G = join(ROOT, 'glyphs');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STATES = [...T.states.order, ...T.states.displayOnly];
const APP = T.appStates.order;
// Look-alikes we must NOT resemble, drawn the way macOS-style toolbars and menu bars draw them.
const LOOKALIKE = {
  appearance: s => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="none" stroke="#000" stroke-width="1.25"/><path d="M8 1.6 A6.4 6.4 0 0 0 8 14.4 Z" fill="#000"/></svg>`,
  info: s => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="none" stroke="#000" stroke-width="1.25"/><rect x="7.25" y="7" width="1.5" height="5" fill="#000"/><circle cx="8" cy="4.75" r="1" fill="#000"/></svg>`,
  pause: s => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 16 16"><rect x="4" y="3" width="3" height="10" fill="#000"/><rect x="9" y="3" width="3" height="10" fill="#000"/></svg>`,
  battery: s => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 16 16"><rect x="0.5" y="4.5" width="13" height="7" rx="1.5" fill="none" stroke="#000" stroke-width="1"/><rect x="2" y="6" width="7" height="4" fill="#000"/><rect x="14.5" y="6.5" width="1" height="3" fill="#000"/></svg>`,
  divide: s => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 16 16"><rect x="2" y="7" width="12" height="2" fill="#000"/><rect x="7" y="2" width="2" height="2" fill="#000"/><rect x="7" y="12" width="2" height="2" fill="#000"/></svg>`,
  // the app's interim "error" glyph before the app states were drawn (WP-50 AppInterimGlyphs: a bar above the rule and
  // a dot below it), kept here only to show in the report how close it was to ÷
  interimError: s => s === 16
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="#000"><rect x="1" y="7" width="14" height="2"/><rect x="7" y="0" width="2" height="5"/><rect x="7" y="11" width="2" height="2"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="#000"><rect x="1" y="8" width="16" height="2"/><rect x="8" y="0" width="2" height="6"/><rect x="8" y="12" width="2" height="2"/></svg>',
};
// Toolbar neighbours: every glyph. Menu-bar neighbours (pause, battery): the app glyphs (the states' grammar was judged
// and blind-named against the toolbar pair). ÷: the app glyph that stands for an error (unreadable), because the
// interim one read as ÷; every app glyph's distance to ÷ is printed too (three dots on the rule's line are a subset of
// the ÷ bar, so `loading` measures close by pixels without having a bar or anything above or below it).
const LOOK_ALL = ['appearance', 'info'], LOOK_APP = ['pause', 'battery'], DIVIDE_CHECKED = ['unreadable'];
const NAMES = [...STATES, 'mark', ...APP, ...LOOK_ALL, ...LOOK_APP, 'divide', 'interimError'];
const svgFor = (n, px) => LOOKALIKE[n] ? LOOKALIKE[n](px)
  : readFileSync(join(G, n === 'mark' ? `mark-${px}.svg` : APP.includes(n) ? `${appGlyphKey(n, px)}.svg` : `state-${n}-${px}.svg`), 'utf8').trim();

const CELL = 24, PAD = 4;
const themes = [['light', '#F2F2F2', '#000000'], ['dark', '#1E1E1E', '#FFFFFF']];
const sizes = [16, 18];
const layout = { cell: CELL, pad: PAD, cols: NAMES.length, items: [] };
let html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:${NAMES.length * CELL}px;height:${themes.length * sizes.length * CELL}px;position:relative}div{position:absolute;width:${NAMES.length * CELL}px;height:${CELL}px;left:0}svg{position:absolute;display:block}</style></head><body>`;
let row = 0;
for (const [th, bg, fg] of themes) for (const px of sizes) {
  html += `<div style="top:${row * CELL}px;background:${bg}"></div>`;
  NAMES.forEach((n, i) => {
    const x = i * CELL + PAD, y = row * CELL + PAD;
    const svg = svgFor(n, px).replace(/#000\b|#000000\b/g, fg)
      .replace('<svg ', `<svg style="left:${x}px;top:${y}px" `);
    html += svg;
    layout.items.push({ name: n, theme: th, px, x, y });
  });
  row++;
}
html += '</body></html>';
const tmp = mkdtempSync(join(tmpdir(), 'wim-glyph-'));
writeFileSync(join(tmp, 'g.html'), html);
const out = join(G, 'capture-1x.png');
execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--virtual-time-budget=2000', `--window-size=${NAMES.length * CELL},${row * CELL}`, `--screenshot=${out}`, `file://${join(tmp, 'g.html')}`], { stdio: 'ignore' });
writeFileSync(join(G, 'capture-layout.json'), JSON.stringify(layout, null, 1) + '\n');

const img = decodePng(out);
const BGL = { light: 0xF2, dark: 0x1E }, FGL = { light: 0, dark: 255 };
function cov(it) {
  const a = [];
  for (let y = 0; y < it.px; y++) {
    const r = [];
    for (let x = 0; x < it.px; x++) {
      const i = ((it.y + y) * img.width + (it.x + x)) * 4;
      const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
      r.push(Math.min(1, Math.max(0, (l - BGL[it.theme]) / (FGL[it.theme] - BGL[it.theme]))));
    }
    a.push(r);
  }
  return a;
}
const get = (n, th, px) => cov(layout.items.find(i => i.name === n && i.theme === th && i.px === px));
const diff = (a, b) => a.reduce((s, r, y) => s + r.reduce((t, v, x) => t + (Math.abs(v - b[y][x]) >= 0.5 ? 1 : 0), 0), 0);
const flip = a => [...a].reverse();
const art = a => a.map(r => '   ' + r.map(v => v < 0.05 ? '.' : String(Math.min(9, Math.round(v * 9)))).join('')).join('\n');
const fmtPairs = (ps, n) => ps.slice(0, n).map(p => `${p[1]}/${p[2]} ${p[0]}`).join(', ');

let rep = '# Glyph separation (true 1x, headless Chrome). Pixels whose coverage differs by >= 0.5.\n';
rep += '# Generated by gen/glyph-check.mjs. Thresholds: states+mark+app states >= 12 px apart; you vs vertically-flipped agent >= 12 px\n';
rep += '# (not a mirror pair); every glyph >= 30 px from the appearance toggle and the info icon; every app glyph >= 30 px from pause\n# and battery; the error glyph (unreadable) >= 30 px from the division sign.\n';
const fails = [];
for (const [th] of themes) for (const px of sizes) {
  const C = Object.fromEntries(NAMES.map(n => [n, get(n, th, px)]));
  const pairsOf = list => {
    const ps = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) ps.push([diff(C[list[i]], C[list[j]]), list[i], list[j]]);
    return ps.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
  };
  const core = [...STATES, 'mark'];
  const pairs = pairsOf(core);                                 // the judged set, as before the app states
  const all = pairsOf([...core, ...APP]);
  const appPairs = all.filter(p => APP.includes(p[1]) || APP.includes(p[2]));
  const mirror = diff(flip(C.you), C.agent);
  const look = [];
  for (const n of [...core, ...APP]) for (const l of LOOK_ALL) look.push([diff(C[n], C[l]), n, l]);
  for (const n of APP) for (const l of LOOK_APP) look.push([diff(C[n], C[l]), n, l]);
  look.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  const lookToolbar = look.filter(l => LOOK_ALL.includes(l[2]) && !APP.includes(l[1]));
  const lookApp = look.filter(l => APP.includes(l[1]));
  rep += `\n## ${th} bar, ${px} px\n  closest pairs: ${fmtPairs(pairs, 6)}\n`;
  const mk = pairs.filter(p => p[1] === 'mark' || p[2] === 'mark')[0];
  rep += `  mirror test, you vs flipped agent: ${mirror} px\n  mark vs nearest state: ${mk[1] === 'mark' ? mk[2] : mk[1]} ${mk[0]} px\n  closest look-alike: ${lookToolbar[0][1]}/${lookToolbar[0][2]} ${lookToolbar[0][0]} px\n`;
  rep += `  app states, closest pairs: ${fmtPairs(appPairs, 6)}\n`;
  for (const a of APP) {
    const near = appPairs.find(p => p[1] === a || p[2] === a), la = lookApp.find(l => l[1] === a);
    rep += `  app ${a}: nearest glyph ${near[1] === a ? near[2] : near[1]} ${near[0]} px; nearest look-alike ${la[2]} ${la[0]} px; ÷ ${diff(C[a], C.divide)} px\n`;
  }
  rep += `  the interim error glyph (bar above, dot below the rule) vs ÷: ${diff(C.interimError, C.divide)} px\n`;
  if (all[0][0] < 12) fails.push(`${th}-${px}: ${all[0][1]}/${all[0][2]} only ${all[0][0]} px apart`);
  if (mirror < 12) fails.push(`${th}-${px}: you/agent are a near-mirror pair (${mirror} px)`);
  if (look[0][0] < 30) fails.push(`${th}-${px}: ${look[0][1]} is close to the ${look[0][2]} icon (${look[0][0]} px)`);
  for (const a of DIVIDE_CHECKED) if (diff(C[a], C.divide) < 30) fails.push(`${th}-${px}: ${a} is close to ÷ (${diff(C[a], C.divide)} px)`);
  if (th === 'light') for (const n of [...core, ...APP]) rep += `  -- ${n}\n${art(C[n])}\n`;
}
rep += `\nRESULT: ${fails.length ? 'FAIL\n  ' + fails.join('\n  ') : 'PASS'}\n`;
writeFileSync(join(G, 'separation.txt'), rep);
console.log(rep.split('\n').filter(l => !/^ {3}[.0-9]+$/.test(l) && !/^  -- /.test(l)).join('\n'));
process.exitCode = fails.length ? 1 : 0;
