// Text surfaces: the Claude Code mod pane (64 x 18), the status line, and the `wasitme` CLI (100 columns).
// Every coloured cell is produced by generated/tokens.ts (sticker / styled / statusLine) and its escape codes are
// parsed back into spans here, so these mocks exercise the same module the CLI and the mod ship with.
import * as tk from '../../generated/tokens.ts';
import { T, DEMO, STAMP, esc, fdate, num, page } from './kit.mjs';

const ESC_RE = /\u001b\[([0-9;]*)m/g;
const visible = s => s.replace(ESC_RE, '');
const width = s => [...visible(s)].length;

// ---------- a cell grid with roles, serialised through tokens.ts ----------
class Grid {
  constructor(cols, rows) { this.cols = cols; this.rows = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ch: ' ', role: 'plain', g: 0 }))); this.gid = 1; }
  at(r, c, text, role = 'plain') {
    const g = this.gid++;
    [...text].forEach((ch, i) => { if (c + i >= this.cols) throw new Error(`row ${r} overflows ${this.cols} columns: "${text}"`); this.rows[r][c + i] = { ch, role, g }; });
    return c + [...text].length;
  }
  right(r, text, role = 'plain', pad = 0) { return this.at(r, this.cols - pad - [...text].length, text, role); }
  ansi(mode) {
    return this.rows.map((cells, ri) => {
      let out = '', i = 0;
      while (i < cells.length) {
        const { role, g } = cells[i]; let j = i, txt = '';
        while (j < cells.length && cells[j].role === role && (role === 'plain' || cells[j].g === g)) txt += cells[j++].ch;
        out += role === 'plain' ? txt
          : role === 'you' || role === 'agent' ? tk.sticker(role, txt.trim(), mode)
          : role === 'ul' ? tk.styled('brandUnderline', txt, mode)
          : role === 'bold' ? tk.styled('emphasis', txt, mode)
          : tk.styled(role, txt, mode);
        i = j;
      }
      if (width(out) !== this.cols) throw new Error(`row ${ri} is ${width(out)} cells, expected ${this.cols}`);
      return out;
    });
  }
}

// ---------- escape codes -> spans (colours only through CSS variables) ----------
const PINNED = {};
for (const m of ['light', 'dark']) for (const p of ['you', 'agent']) for (const k of ['fill', 'ink']) PINNED[T.color[m].party[p][k].toUpperCase()] = `--${m}-${p}-${k}`;
for (const m of ['light', 'dark']) for (const k of ['muted', 'rule']) PINNED[T.terminal.sgr.truecolor[m][k].toUpperCase()] = `--tc-${m}-${k}`;
function toHtml(line, palette) {
  let st = {}, out = '', last = 0;
  const flush = text => {
    if (!text) return;
    let fg = st.fg, bg = st.bg;
    if (st.inverse) [fg, bg] = [bg || 'var(--t-bg)', fg || 'var(--t-fg)'];
    const css = [fg && `color:${fg}`, bg && `background:${bg}`, st.bold && 'font-weight:700', st.dim && 'color:var(--t-muted)', st.ul && 'text-decoration:underline;text-underline-offset:2px'].filter(Boolean).join(';');
    out += css ? `<span style="${css}">${esc(text)}</span>` : esc(text);
  };
  const col = (p) => {
    const n = p.shift();
    if (n === 5) { const v = p.shift(); return `var(--x256-${v})`; }
    if (n === 2) { const hex = '#' + [p.shift(), p.shift(), p.shift()].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase(); if (!PINNED[hex]) throw new Error(`no token for ${hex}`); return `var(${PINNED[hex]})`; }
    throw new Error('bad extended colour');
  };
  for (const m of line.matchAll(ESC_RE)) {
    flush(line.slice(last, m.index)); last = m.index + m[0].length;
    const p = (m[1] || '0').split(';').map(Number);
    while (p.length) {
      const c = p.shift();
      if (c === 0) st = {};
      else if (c === 1) st.bold = true; else if (c === 2) st.dim = true; else if (c === 4) st.ul = true; else if (c === 7) st.inverse = true;
      else if (c >= 30 && c <= 37) st.fg = `var(--ansi-${palette}-${c - 30})`; else if (c >= 90 && c <= 97) st.fg = `var(--ansi-${palette}-${c - 82})`;
      else if (c >= 40 && c <= 47) st.bg = `var(--ansi-${palette}-${c - 40})`; else if (c >= 100 && c <= 107) st.bg = `var(--ansi-${palette}-${c - 92})`;
      else if (c === 38) st.fg = col(p); else if (c === 48) st.bg = col(p);
      else if (c === 39) delete st.fg; else if (c === 49) delete st.bg;
    }
  }
  flush(line.slice(last));
  return out;
}

// ---------- content ----------
const C = DEMO.cases.insufficient;
const recentDays = C.daily.recent, recentEv = C.timeline.filter(e => e.day >= DEMO.windows.recent.from);
const tg = s => T.states[s].textGlyph;

function modPane() {
  const g = new Grid(64, 18);
  // buttons first (an 80-column inline pane must never clip them); Claude Code draws Buttons itself
  let c = g.at(0, 0, '[ Report ]', 'bold'); c = g.at(0, c + 2, '[ Check again ]'); g.at(0, c + 2, '[ Hide ]');
  g.at(0, 57, 'wasit'); g.at(0, 62, 'me', 'ul');
  c = g.at(2, 0, tg('insufficient')); c = g.at(2, c + 1, 'too early to tell', 'bold'); g.right(2, 'Claude Code, 14 days vs 28', 'muted');
  g.at(3, 0, `Can already rule out changes bigger than ×${C.metrics[0].mde} in tool errors.`);
  // the case line: 14 recent days, 4 cells each, starting at column 8
  const X = d => 8 + recentDays.findIndex(r => r.d === d.slice(5)) * 4;
  g.at(5, 0, 'yours', 'muted'); g.at(7, 0, 'agent', 'muted');
  const rule = Array.from({ length: 56 }, () => '┄');
  for (const e of recentEv) {
    const x = X(e.day);
    if (e.side === 'you') { g.at(5, x, ` ${e.marker} `, 'you'); rule[x + 1 - 8] = '┴'; }
    else { g.at(7, x, ` ${e.marker} `, 'agent'); rule[x + 1 - 8] = '┬'; }
  }
  g.at(6, 8, rule.join(''), 'rule');
  [0, 7, 13].forEach(i => g.at(8, 8 + i * 4 + (i === 13 ? -1 : 0), fdate(recentDays[i].d), 'muted'));
  g.at(9, 0, 'errors', 'muted'); g.at(10, 0, 'calls', 'muted');
  recentDays.forEach((r, i) => { const k = r.n === 0 ? '–' : String(r.k); g.at(9, 8 + i * 4 + 3 - k.length, k); g.at(10, 8 + i * 4 + 3 - String(r.n).length, String(r.n), 'muted'); });
  const tm = C.metrics[0];
  g.at(12, 0, `Tool errors ×${tm.ratio.toFixed(2)}, range ×${tm.range[0].toFixed(2)}–×${tm.range[1].toFixed(2)}; under ×${tm.mde} won’t show`);
  const fill = Math.round(30 * C.progress.have / C.progress.need);
  c = g.at(13, 0, `Reads per edit: ${C.progress.have} of ${C.progress.need} edits `); c = g.at(13, c, '█'.repeat(fill)); g.at(13, c, '░'.repeat(30 - fill), 'muted');
  g.at(14, 0, 'No date yet: it depends on how your sessions go.', 'muted'); // D66: no projected dates in v1
  c = g.at(16, 0, ' 1 ', 'you'); c = g.at(16, c + 1, 'yours  '); c = g.at(16, c, ' A ', 'agent'); g.at(16, c + 1, 'Claude Code’s');
  g.right(16, 'local only', 'muted');
  g.at(17, 0, 'updated 4 min ago; checks every 15 minutes', 'muted');
  return g;
}

function cli() {
  const W = 100, rows = 28, g = new Grid(W, rows);
  let r = 0, c;
  c = g.at(r, 0, '~/code/api $ ', 'muted'); g.at(r, c, 'wasitme'); r += 1;
  g.at(r, 0, 'wasit'); g.at(r, 5, 'me', 'ul'); g.right(r, 'Claude Code   checked Oct 4, 09:14', 'muted'); r += 1;
  g.at(r, 0, '═'.repeat(W), 'rule'); r += 1;
  // timeline first (timeline-led layout, D28): 21 days x 4 cells from column 16
  const days = [...C.daily.baseline, ...C.daily.recent].slice(-21), X0 = 16;
  const X = d => X0 + days.findIndex(x => x.d === d.slice(5)) * 4;
  g.at(r, 0, 'What changed', 'bold'); g.at(r, X0, 'yours numbered above the line, Claude Code’s lettered below', 'muted'); r += 1;
  const ev = C.timeline.filter(e => days.some(d => d.d === e.day.slice(5)));
  g.at(r, 0, 'your side', 'muted'); g.at(r + 2, 0, 'Claude Code', 'muted');
  const rule = Array.from({ length: 84 }, () => '┄');
  for (const e of ev) {
    const x = X(e.day);
    if (e.side === 'you') { g.at(r, x, ` ${e.marker} `, 'you'); rule[x + 1 - X0] = '┴'; }
    else { g.at(r + 2, x, ` ${e.marker} `, 'agent'); rule[x + 1 - X0] = '┬'; }
  }
  g.at(r + 1, X0, rule.join(''), 'rule'); r += 3;
  [0, 7, 14, 20].forEach(i => g.at(r, X0 + i * 4 + (i === 20 ? -2 : 0), fdate(days[i].d), 'muted')); r += 1;
  g.at(r, 0, 'errors', 'muted'); g.at(r + 1, 0, 'tool calls', 'muted');
  days.forEach((d, i) => { const k = d.n === 0 ? '–' : String(d.k); g.at(r, X0 + i * 4 + 3 - k.length, k); g.at(r + 1, X0 + i * 4 + 3 - String(d.n).length, String(d.n), 'muted'); });
  r += 2;
  g.at(r, X0, '└' + '─'.repeat(9) + ' before ' + '─'.repeat(9) + '┘', 'muted'); g.at(r, X0 + 28, '└' + '─'.repeat(19) + ' recent, 14 days ' + '─'.repeat(18) + '┘', 'muted'); r += 2;
  // finding
  g.at(r, 0, 'Finding', 'bold'); c = g.at(r, X0, tg('insufficient')); g.at(r, c + 1, 'too early to tell', 'bold'); r += 1;
  g.at(r, X0, C.because); r += 1;
  g.at(r, X0, C.detail.split('. ')[0] + '.', 'muted'); r += 1;
  // The confidence line (DESIGN.md §3), one sentence per row
  for (const sentence of C.confidence.split(/(?<=\.) /)) { g.at(r, X0, sentence, 'muted'); r += 1; }
  r += 1;
  // signals ledger with a text forest plot on the shared log axis (tokens chart.ratio.domain, 4 cells per doubling)
  const D = T.chart.ratio.domain, AX = 64, AW = Math.round(Math.log2(D[1] / D[0]) * 4) + 1, ST = 87;
  const pos = v => Math.max(0, Math.min(AW - 1, Math.round(Math.log2(v / D[0]) * 4)));
  g.at(r, 0, 'Signals', 'bold'); g.at(r, 22, 'recent', 'muted'); g.at(r, 35, 'before', 'muted'); g.at(r, 44, 'change  range', 'muted');
  for (const v of T.chart.ratio.ticks) { const lab = `×${v}`; g.at(r, AX + pos(v) - (lab.length > 2 ? 2 : 1), lab, 'muted'); }
  g.at(r, ST, 'status', 'muted'); r += 1;
  g.at(r, 0, '─'.repeat(W), 'rule'); r += 1;
  for (const m of C.metrics) {
    const kn = w => m[w].k !== undefined ? `${num(m[w].k)} / ${num(m[w].n)}` : `${num(m[w].reads)} / ${num(m[w].edits)}`;
    g.at(r, 0, m.label); g.at(r, 28 - kn('recent').length, kn('recent')); g.at(r, 41 - kn('baseline').length, kn('baseline'));
    if (m.eligible) {
      g.at(r, 44, `×${m.ratio.toFixed(2)}  ×${m.range[0].toFixed(2)}–×${m.range[1].toFixed(2)}`);
      const plot = Array.from({ length: AW }, () => ' ');
      for (let i = pos(1 / m.mde); i <= pos(m.mde); i++) plot[i] = '░';
      const a = pos(m.range[0]), b = pos(m.range[1]);
      for (let i = a; i <= b; i++) plot[i] = '─';
      // an end cap only where the range really ends; past the axis, an arrow at the edge (tokens chart.ratio.overflow)
      plot[a] = m.range[0] < D[0] ? '<' : '├'; plot[b] = m.range[1] > D[1] ? '>' : '┤'; plot[pos(1)] = plot[pos(1)] === '─' ? '┼' : '│';
      plot[pos(m.ratio)] = m.status === 'moved' ? '●' : '○';
      g.at(r, AX, plot.join(''));
      g.at(r, ST, m.status === 'moved' ? (m.ratio >= 1 ? 'moved, more' : 'moved, fewer') : 'not detected');
    } else {
      g.at(r, 44, m.progress ? `${m.progress.have} of ${m.progress.need} edits needed` : m.ineligibleReason.replace('; context only', ''), 'muted');
      g.at(r, ST, m.family === 'friction' ? 'context' : 'not yet', 'muted');
    }
    r += 1;
  }
  g.at(r, 44, '○ estimate, not detected  ├─┤ range  ░ too small to show', 'muted'); r += 2;
  g.at(r, 0, 'Next', 'bold'); g.at(r, X0, C.next); r += 1;
  g.at(r, 0, 'Share', 'bold'); c = g.at(r, X0, 'wasitme report --md | pbcopy'); g.at(r, c + 3, 'numbers only: no prompts, code or paths', 'muted');
  return g;
}

function statusLines(mode) {
  return [...T.states.order, 'stale'].map((s, i) => tk.statusLine(s, i === 0 ? 2 : 0, mode));
}

const VARIANTS = {
  dark: { mode: 'ansi256-dark', palette: 'xterm', bg: '--term-dark-mock-bg', fg: '--term-dark-mock-fg', muted: '--term-dark-mock-muted', title: 'Dark terminal, xterm-256 colours' },
  light: { mode: 'ansi256-light', palette: 'xterm', bg: '--term-light-mock-bg', fg: '--term-light-mock-fg', muted: '--term-light-mock-muted', title: 'Light terminal, xterm-256 colours' },
  ansi16: { mode: 'ansi16', palette: 'xterm', bg: '--term-ansi16-mock-bg', fg: '--term-ansi16-mock-fg', muted: '--term-ansi16-mock-muted', title: '16 colours: reverse-video stickers' },
  nocolor: { mode: 'none', palette: 'xterm', bg: '--term-dark-mock-bg', fg: '--term-dark-mock-fg', muted: '--term-dark-mock-muted', title: 'NO_COLOR: glyphs and words carry everything' },
  'codetab-light': { mode: 'truecolor-light', palette: 'xterm', bg: '--term-code-tab-light-bg', fg: '--term-code-tab-light-fg', muted: '--term-code-tab-light-muted', title: 'Claude Desktop Code tab, light (colours assumed, not captured)', codetab: true },
  'codetab-dark': { mode: 'truecolor-dark', palette: 'xterm', bg: '--term-code-tab-dark-bg', fg: '--term-code-tab-dark-fg', muted: '--term-code-tab-dark-muted', title: 'Claude Desktop Code tab, dark (colours assumed, not captured)', codetab: true },
};

export function termSheet(name) {
  const v = VARIANTS[name];
  const block = (lines, cls) => `<pre class="${cls}">${lines.map(l => toHtml(l, v.palette)).join('\n')}</pre>`;
  const mod = modPane().ansi(v.mode), cliRows = cli().ansi(v.mode), status = statusLines(v.mode);
  const frame = (label, inner, cols) => v.codetab
    ? `<div class="ct"><div class="ct-head"><span>${esc(label)}</span></div>${inner}<div class="ct-prompt">Reply to Claude…</div></div>`
    : `<div class="tw"><div class="tw-bar"><i></i><i></i><i></i><span>${esc(label)}</span></div>${inner}</div>`;
  const body = `<div class="ts" style="--t-bg:var(${v.bg});--t-fg:var(${v.fg});--t-muted:var(${v.muted})">
  <header><h1 class="t-title">${esc(v.title)}</h1><p class="t-note">Mod pane 64 × 18 cells, status line one row per state, CLI 100 columns. ${v.mode === 'none' ? 'No escape codes: party is carried by [1] / [A], above / below the line, and the words.' : v.mode === 'ansi16' ? 'The palette is unknown in 16 colours (Solarized turns bright yellow and cyan grey), so stickers are reverse video: the theme’s own contrast, every palette. Numerals vs letters, above vs below and the words carry the party. Drawn here with xterm’s palette.' : 'Colour only inside the stickers; everything else is the terminal’s own foreground.'}</p></header>
  <div class="row">${frame('Claude Code mod pane, 64 × 18', block(mod, 'term term--mod'), 64)}
    <div class="sl">${frame('Status line, one row per state', block(status, 'term term--sl'), 40)}<p class="t-note">${v.mode === 'none' ? 'No escape codes at all. Stickers become [1] and [A].' : 'Only the state and a count of new changes. Never a cause, never “worse” or “better”.'}</p></div></div>
  ${frame('wasitme, 100 columns', block(cliRows, 'term term--cli'), 100)}
  <footer class="stamp2"><span>${STAMP}</span><span>case: too early to tell (the most common finding)</span></footer>
</div>`;
  const css = `
.ts { padding: 28px 40px 16px; background: var(--surface-page); height: 100%; display: flex; flex-direction: column; gap: 16px; }
.ts header { display: flex; align-items: baseline; gap: 24px; white-space: nowrap; }
.ts header .t-note { white-space: normal; }
.ts .row { display: flex; gap: 32px; align-items: flex-start; }
.sl { display: flex; flex-direction: column; gap: 8px; max-width: 520px; }
.tw { background: var(--t-bg); color: var(--t-fg); border-radius: var(--radius-window); overflow: hidden; border: 1px solid var(--rule-strong); width: max-content; flex: none; }
.tw-bar { height: 28px; display: flex; align-items: center; gap: 7px; padding: 0 12px; border-bottom: 1px solid var(--rule-strong); background: var(--t-bg); }
.tw-bar i { width: 10px; height: 10px; border-radius: 50%; background: var(--t-fg); opacity: .25; display: block; }
.tw-bar span { margin-left: 10px; font: 12px/1 var(--font-terminal); color: var(--t-muted); }
.ct { background: var(--t-bg); color: var(--t-fg); border-radius: 14px; border: 1px solid var(--rule-strong); width: max-content; overflow: hidden; flex: none; }
.ct-head { padding: 10px 16px; font: var(--type-typed-sm); color: var(--t-muted); border-bottom: 1px solid var(--rule-hair); }
.ct-prompt { margin: 0 14px 14px; padding: 10px 14px; border: 1px solid var(--rule-strong); border-radius: 10px; font: var(--type-note); color: var(--t-muted); }
.term { margin: 0; padding: 12px 16px; font: 13px/17px var(--font-terminal); color: var(--t-fg); background: var(--t-bg); white-space: pre; }
.stamp2 { margin-top: auto; display: flex; justify-content: space-between; font: var(--type-typed-sm); color: var(--ink-muted); border-top: 1px solid var(--rule-hair); padding-top: 8px; }`;
  return page({ title: `wasitme · ${v.title}`, w: 1280, h: v.codetab ? 1200 : 1100, body, extraCss: css });
}
export const TERM_VARIANTS = Object.keys(VARIANTS);
