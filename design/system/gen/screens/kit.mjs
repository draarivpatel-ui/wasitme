// Shared pieces for the screen mockups. Output HTML may only colour things through var(--...) from tokens.css.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadTokens } from '../lib.mjs';

export const T = loadTokens();
export const DEMO = JSON.parse(readFileSync(join(ROOT, 'demo-data.v3.json'), 'utf8'));
export const STAMP = `demo data v${DEMO.version} (analytic) — not engine output`;
/** Every size the Wasitme families may be set in (tokens type.scale); the in-page check reports anything else. */
const SIZES = [...new Set(Object.values(T.type.scale).map(s => s.size))].sort((a, b) => a - b);
let uid = 0;
const mmdd = (from, n) => { const out = [], d = new Date(from + 'T00:00:00Z'); for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(5, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; };
export const DAYS_BASE = mmdd(DEMO.windows.baseline.from, DEMO.windows.baseline.days), DAYS_RECENT = mmdd(DEMO.windows.recent.from, DEMO.windows.recent.days);
export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-09-21' or '09-21' -> 'Sep 21' */
export const fdate = s => { const p = s.split('-').slice(-2).map(Number); return `${MON[p[0] - 1]} ${p[1]}`; };
export const num = n => n.toLocaleString('en-US');
export const x2 = n => '×' + n.toFixed(2);

/** A state glyph (template image) inline, drawn in currentColor. */
export function glyph(state, px = 16, size = px) {
  const f = state === 'mark' ? `mark-${px}.svg` : `state-${state}-${px}.svg`;
  const svg = readFileSync(join(ROOT, 'glyphs', f), 'utf8').trim()
    .replace(/<title>[^<]*<\/title>/, '').replace(/#000\b/g, 'currentColor')
    .replace(/ width="\d+" height="\d+"/, '');
  return `<span class="glyph" style="width:${size}px;height:${size}px" aria-hidden="true">${svg}</span>`;
}
/** An app state's glyph (tokens.json appStates; glyphs/app-*-16|18.svg), inline in currentColor. */
export function appGlyph(state, px = 16, size = px) {
  const svg = readFileSync(join(ROOT, T.appStates[state].files[px]), 'utf8').trim()
    .replace(/<title>[^<]*<\/title>/, '').replace(/#000\b/g, 'currentColor').replace(/ width="\d+" height="\d+"/, '');
  return `<span class="glyph" style="width:${size}px;height:${size}px" aria-hidden="true">${svg}</span>`;
}
/** An app state's chip: the quiet neutral chip (tokens.json appStates.chip) with the app glyph and its label. */
export function appChip(state, label) {
  const text = esc(label ?? T.appStates[state].label);
  return `<span class="chip chip--app" data-glance="${text}">${appGlyph(state, 16)}${text}</span>`;
}
/** The colour brand mark, drawn from tokens via classes. */
export function mark(size = 22) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 44 44" aria-label="wasitme"><rect class="c-you" x="3" y="4" width="20" height="20" rx="2" transform="rotate(-5 13 14)" stroke-width="2"/><path class="c-agent" d="M31 21 L41.5 39.5 L20.5 39.5 Z" stroke-width="2" stroke-linejoin="round"/></svg>`;
}
export const wordmark = () => `<span class="wordmark">wasit<u>me</u></span>`;

export function chip(state, label) {
  const st = state === 'calibrationPending' ? 'insufficient' : state;
  const text = esc(label ?? T.states[state].label);
  if (st === 'unclear') return `<span class="chip chip--unclear" data-glance="${text}"><span class="swatch"><i></i><i></i></span>${glyph('unclear', 16)}${text}</span>`;
  return `<span class="chip chip--${st}" data-glance="${text}">${glyph(st, 16)}${text}</span>`;
}
export const mkYou = n => `<span class="mk mk--you">${esc(n)}</span>`;
export const mkAgent = (l, routine = false) => `<span class="mk mk--agent${routine ? ' mk--routine' : ''}"><span>${esc(l)}</span></span>`;
export const marker = e => (e.side === 'you' ? mkYou(e.marker) : mkAgent(e.marker, !e.shift && e.routine));

/** Wrap a body into a standalone page. Theme comes from the URL hash (#dark / #light) so one file renders both. */
export function page({ title, w, h, body, extraCss = '', bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${w}">
<title>${esc(title)}</title>
<script>document.documentElement.dataset.theme = location.hash === '#dark' ? 'dark' : 'light';</script>
<link rel="stylesheet" href="../generated/tokens.css">
<link rel="stylesheet" href="components.css">
${extraCss ? `<style>\n${extraCss}\n</style>\n` : ''}</head>
<body class="${bodyClass}" style="width:${w}px;height:${h}px;overflow:hidden">
${body}
<script>document.fonts.ready.then(() => { const faces = [...document.fonts].filter(x => x.family.replace(/"/g, '').startsWith('Wasitme')); const ok = faces.every(x => x.status !== 'error') && faces.some(x => x.status === 'loaded'); document.documentElement.dataset.fonts = ok ? 'ok' : 'missing'; let bad = ''; for (const el of document.body.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && (r.right > ${w} + 0.5 || r.bottom > ${h} + 0.5)) { bad = ((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || el.tagName) + '@' + Math.round(r.right) + 'x' + Math.round(r.bottom); break; } } if (!bad) { const boxed = e => { const c = getComputedStyle(e); return ['Top', 'Right', 'Bottom', 'Left'].every(k => parseFloat(c['border' + k + 'Width']) > 0); }; for (const el of document.body.querySelectorAll('*')) { if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue; let a = el.parentElement; while (a && a !== document.body && !boxed(a)) a = a.parentElement; if (!a || a === document.body) continue; const r = el.getBoundingClientRect(), b = a.getBoundingClientRect(); if (r.width > 0 && (r.right > b.right + 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.top < b.top - 1)) { bad = 'text escapes its box: ' + el.textContent.trim().slice(0, 24); break; } } } document.documentElement.dataset.fit = bad ? (bad.startsWith('text') ? bad : 'overflow:' + bad) : 'ok'; const sizes = ${JSON.stringify(SIZES)}; let tb = ''; for (const el of document.querySelectorAll('body *')) { if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue; const cs = getComputedStyle(el), fam = cs.fontFamily.replace(/"/g, ''), px = parseFloat(cs.fontSize); if (!fam.startsWith('Wasitme')) continue; const serif = fam.startsWith('Wasitme Serif'); if (!sizes.includes(px) || (serif && px < 13) || (!serif && px < 12)) { tb = (serif ? 'serif ' : 'mono ') + px + 'px: ' + el.textContent.trim().slice(0, 30); break; } let a = el; while (a && a !== document.body) { if (getComputedStyle(a).transform !== 'none') { tb = 'scaled text: ' + el.textContent.trim().slice(0, 30); break; } a = a.parentElement; } if (tb) break; } document.documentElement.dataset.type = tb ? 'bad:' + tb : 'ok'; });</script>
</body>
</html>
`;
}

// ---------- charts ----------
const LOG = (v, [lo, hi], w) => (Math.log(v / lo) / Math.log(hi / lo)) * w;
/** One-line forest plot on the shared log axis: MDE zone (hatched), x1 line, range, estimate. */
export function forest({ ratio, range, mde, moved }, w = 240, h = 22) {
  const D = T.chart.ratio.domain, cy = h / 2;
  const X = v => Math.max(0, Math.min(w, LOG(v, D, w)));
  // aria-hidden: the row prints the same numbers as text
  let s = `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`;
  if (mde) {
    const a = X(1 / mde), b = X(mde);
    s += `<rect class="c-mde" x="${a.toFixed(1)}" y="${cy - 6}" width="${(b - a).toFixed(1)}" height="12"/>`;
    for (let x = Math.ceil(a / 5) * 5 - 12; x < b; x += 5) {
      const x1 = Math.max(a, x), x2v = Math.min(b, x + 12);
      if (x2v <= x1) continue;
      const y1 = cy + 6 - (x1 - x), y2 = cy + 6 - (x2v - x);
      s += `<line class="c-mde-hatch" x1="${x1.toFixed(1)}" y1="${Math.min(cy + 6, y1).toFixed(1)}" x2="${x2v.toFixed(1)}" y2="${Math.max(cy - 6, y2).toFixed(1)}"/>`;
    }
  }
  s += `<line class="c-one" x1="${X(1).toFixed(1)}" y1="1" x2="${X(1).toFixed(1)}" y2="${h - 1}"/>`;
  if (range) {
    const a = X(range[0]), b = X(range[1]);
    s += `<line class="c-range" x1="${a.toFixed(1)}" y1="${cy}" x2="${b.toFixed(1)}" y2="${cy}"/>`;
    // an end cap only where the range really ends; past the domain, an open arrowhead at the edge (tokens chart.ratio.overflow)
    const end = (x, past, dir) => past
      ? `<path class="c-range-over" d="M${(x - dir * 6).toFixed(1)} ${cy - 4} L${x.toFixed(1)} ${cy} L${(x - dir * 6).toFixed(1)} ${cy + 4}"/>`
      : `<line class="c-range" x1="${x.toFixed(1)}" y1="${cy - 4}" x2="${x.toFixed(1)}" y2="${cy + 4}"/>`;
    s += end(a, range[0] < D[0], -1) + end(b, range[1] > D[1], 1);
  }
  if (ratio) s += moved ? `<circle class="c-est" cx="${X(ratio).toFixed(1)}" cy="${cy}" r="3.5"/>` : `<circle class="c-est-open" cx="${X(ratio).toFixed(1)}" cy="${cy}" r="3.5"/>`;
  return s + '</svg>';
}
export function forestAxis(w = 240) {
  const D = T.chart.ratio.domain;
  return `<span class="sr">range on a log axis</span><svg class="chart" width="${w}" height="14" viewBox="0 0 ${w} 14" aria-hidden="true">` +
    T.chart.ratio.ticks.map(v => `<text class="c-label" x="${LOG(v, D, w).toFixed(1)}" y="11" text-anchor="middle">×${v}</text>`).join('') + '</svg>';
}

/**
 * The evidence strip: integer daily ticks (one per event) on the case line, your markers above,
 * the agent's below, k and n rows under it, window brackets. Shows `show` days ending at the recent window's end.
 */
export function strip(c, { width = 984, show = 28, gutter = 104, kLabel = 'errors', nLabel = 'tool calls', compact = false, lowN = T.chart.strip.lowNThreshold, eventsOnly = false, labels = true, nRow = true, kRow = true, caption = null, windowLabel = null, today = true, compactHeight = 36 } = {}) {
  const ticks = !eventsOnly && !!c.daily;
  const allDays = [...DAYS_BASE, ...DAYS_RECENT];
  const rowsAll = c.daily ? [...c.daily.baseline, ...c.daily.recent] : allDays.map(d => ({ d, k: 0, n: 0 }));
  const rows = rowsAll.slice(-show);
  const x0 = gutter, x1 = width - (compact ? 20 : 64), pitch = (x1 - x0) / rows.length;
  const colW = Math.min(T.chart.strip.columnWidth, pitch - 4);
  const maxK = Math.max(...rows.map(r => r.k), 10);
  const S = T.chart.strip, dense = maxK > S.denseAbove;
  const th = dense ? S.denseTickHeight : S.tickHeight, unit = th + (dense ? S.denseTickGap : S.tickGap);
  const top = Math.ceil(maxK / 5) * 5, stripH = !ticks ? 18 : compact ? compactHeight : Math.max(42, top * unit);
  const cu = stripH / top; // compact: one solid column per day, k printed under it
  const oy = compact ? 16 : 0, yTop = (compact ? 24 : 30) + oy, yA = yTop + stripH;
  const dayX = d => x0 + rows.findIndex(r => r.d === d) * pitch; // left edge of the day's slot
  const recentStart = rows.length - DAYS_RECENT.length;
  let s = '';
  // grid lines every 10 events
  for (let v = 10; ticks && v <= top; v += 10) {
    const y = yA - v * unit;
    if (compact) continue;
    s += `<line class="c-grid" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/><text class="c-label" x="${x0 - 8}" y="${y + 4}" text-anchor="end">${v}</text>`;
  }
  // ticks
  if (ticks) rows.forEach((r, i) => {
    const cx = x0 + i * pitch + (pitch - colW) / 2;
    if (r.n === 0) return;
    if (compact && r.k > 0) { const h = r.k * cu, w = r.n < lowN ? colW / 2 : colW; s += `<rect class="c-tick" x="${(cx + (colW - w) / 2).toFixed(1)}" y="${(yA - h).toFixed(1)}" width="${w}" height="${h.toFixed(1)}"/>`; return; }
    if (r.k === 0) { s += `<rect class="c-zero" x="${(cx + colW / 2 - 1).toFixed(1)}" y="${yA - 3}" width="2" height="2"/>`; return; }
    for (let j = 0; j < r.k; j++) {
      const y = yA - (j + 1) * unit;
      s += r.n < lowN
        ? `<rect class="c-tick" x="${(cx + colW / 4).toFixed(1)}" y="${y}" width="${colW / 2}" height="${th}"/>`
        : `<rect class="c-tick" x="${cx.toFixed(1)}" y="${y}" width="${colW}" height="${th}"/>`;
    }
  });
  // events in view
  const first = rows[0].d, last = rows[rows.length - 1].d;
  const inView = c.timeline.filter(e => e.day.slice(5) >= first && e.day.slice(5) <= last);
  // place markers (abutting with a 2 px gap when days collide), then label each cluster on its outer sides
  const placed = { you: [], agent: [] };
  for (const e of inView) {
    const bx = dayX(e.day.slice(5)) - 0.5, list = placed[e.side];
    let mx = bx - 10; const prev = list[list.length - 1];
    if (prev && mx - prev.mx < 22) mx = prev.mx + 22;
    list.push({ e, bx, mx, hit: e.shift || (c.metrics || []).some(m => m.linesUpWith === e.marker), cluster: prev && mx - prev.mx < 23 ? prev.cluster : (prev ? prev.cluster + 1 : 0) });
  }
  const short = e => e.short || (e.side === 'you' ? ({ effort: 'effort', model: 'model', mcp: 'MCP' }[e.kind] || e.kind) : (e.label.split(' → ')[1] || e.label));
  for (const side of ['you', 'agent']) {
    const L = placed[side];
    L.forEach((p, i) => {
      const { e, bx, mx, hit } = p;
      const y = side === 'you' ? 18 : yA + 22;
      if (side === 'you') {
        s += `<line class="${hit ? 'c-conn-hit' : 'c-conn'}" x1="${bx}" y1="${26 + oy}" x2="${bx}" y2="${yA}"/>`;
        s += `<rect class="c-you" x="${mx}" y="${4 + oy}" width="20" height="20" rx="2"/><text class="c-mk-text" x="${mx + 10}" y="${18 + oy}" text-anchor="middle">${esc(e.marker)}</text>`;
      } else {
        if (hit) s += `<line class="c-conn-hit" x1="${bx}" y1="${yTop}" x2="${bx}" y2="${yA}"/>`;
        // filled: the change a shift lines up with, or any agent-strong change; hollow: routine updates
        const strong = hit || !e.routine, cls = strong ? 'c-agent' : 'c-agent-routine', tcls = strong ? 'c-mk-text' : 'c-mk-text-2';
        s += `<path class="${cls}" d="M${mx + 10} ${yA + 3} L${mx + 20} ${yA + 9} L${mx + 20} ${yA + 26} L${mx} ${yA + 26} L${mx} ${yA + 9} Z"/><text class="${tcls}" x="${mx + 10}" y="${yA + 22}" text-anchor="middle">${esc(e.marker)}</text>`;
      }
      if (compact) return;
      const sameBefore = i > 0 && L[i - 1].cluster === p.cluster, sameAfter = i < L.length - 1 && L[i + 1].cluster === p.cluster;
      const room = (L[i + 1] ? L[i + 1].mx : x1 + 60) - (mx + 25), need = [...short(e)].length * 7.3;
      if (!sameAfter && !sameBefore && room < need) {
        // the previous marker may have its label on its right; leave room for it
        const leftRoom = mx - 6 - (i > 0 ? L[i - 1].mx + 28 + [...short(L[i - 1].e)].length * 7.3 : x0 - 90);
        if (leftRoom >= need) s += `<text class="c-label-2" x="${mx - 6}" y="${y}" text-anchor="end">${esc(short(e))}</text>`;
        return;
      }
      if (!sameBefore && sameAfter) s += `<text class="c-label-2" x="${mx - 6}" y="${y}" text-anchor="end">${esc(short(e))}</text>`;
      else if (!sameAfter) s += `<text class="c-label-2" x="${mx + 25}" y="${y}">${esc(short(e))}</text>`;
    });
  }
  // the case line itself
  s += `<line class="c-axis" x1="${x0 - 4}" y1="${yA}" x2="${x1}" y2="${yA}"/>`;
  if (today) s += `<line class="c-today" x1="${x1 + 4}" y1="${yA}" x2="${x1 + (compact ? 18 : 40)}" y2="${yA}"/>`;
  if (labels) s += `<text class="c-side" x="${x0 - 12}" y="18" text-anchor="end">Your side</text><text class="c-side" x="${x0 - 12}" y="${yA + 22}" text-anchor="end">${esc(c.agent === 'codex' ? 'Codex' : 'Claude Code')}</text>`;
  // k / n rows
  // events-only strips: the date row clears the agent tags and their labels (they end about yA + 26)
  const yk = yA + (compact ? 41 : 44), yn = ticks && nRow ? yA + 59 : ticks ? yA + 44 : yA + 22;
  if (ticks && labels) s += `<text class="c-label" x="${x0 - 12}" y="${yk}" text-anchor="end">${kLabel}</text>` + (nRow ? `<text class="c-label" x="${x0 - 12}" y="${yn}" text-anchor="end">${nLabel}</text>` : '');
  if (ticks && kRow) rows.forEach((r, i) => {
    const cx = x0 + i * pitch + pitch / 2;
    s += `<text class="${r.n === 0 ? 'c-label' : 'c-label-ink'}" x="${cx.toFixed(1)}" y="${yk}" text-anchor="middle">${r.n === 0 ? '–' : r.k}</text>`;
    if (nRow) s += `<text class="c-label" x="${cx.toFixed(1)}" y="${yn}" text-anchor="middle">${r.n}</text>`;
  });
  // dates + window brackets
  const yd = yn + 19;
  if (!compact) rows.forEach((r, i) => { const last = i === rows.length - 1; if ((i % 7 === 0 && rows.length - 1 - i >= 3) || last) s += `<text class="c-label" x="${(last ? x1 : x0 + i * pitch + pitch / 2).toFixed(1)}" y="${yd}" text-anchor="${last ? 'end' : 'middle'}">${fdate(r.d)}</text>`; });
  if (!compact && today) s += `<text class="c-label" x="${x1 + 8}" y="${yd}">today</text>`;
  const yb = yd + 6, rb = x0 + recentStart * pitch;
  // accessible summary (role=img label) plus every day's k and n in a hidden description, so no number is visual-only
  const sum = rows.reduce((a, r) => [a[0] + r.k, a[1] + r.n], [0, 0]);
  const evText = inView.map(e => `${e.side === 'you' ? 'your change' : 'agent change'} ${e.marker} on ${fdate(e.day)}: ${e.label}`).join('; ');
  const aria = ticks ? `${kLabel} per day, ${fdate(rows[0].d)} to ${fdate(rows[rows.length - 1].d)}: ${num(sum[0])} ${kLabel} in ${num(sum[1])} ${nLabel}${inView.length ? `; ${inView.length} changes marked` : ''}` : `changes on each side, ${fdate(rows[0].d)} to ${fdate(rows[rows.length - 1].d)}`;
  const did = `strip-desc-${++uid}`;
  const desc = `<p hidden id="${did}">${esc([ticks ? rows.map(r => `${fdate(r.d)}: ${r.n === 0 ? 'no sessions' : `${r.k} ${kLabel} in ${r.n} ${nLabel}`}`).join('; ') : '', evText].filter(Boolean).join('. '))}</p>`;
  const open = (W, H) => `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}" aria-describedby="${did}">`;
  if (compact) { const H = kRow ? yk + 6 : yA + 30; s += `<text class="c-label" x="0" y="11" aria-hidden="true">${esc(caption ?? `tool errors per day, ${fdate(rows[0].d)} – ${fdate(rows[rows.length - 1].d)}`)}</text>`; return `${open(width, H)}${s}</svg>${desc}`; }
  const br = (a, b, label) => `<path class="c-bracket" d="M${a + 2} ${yb} v5 H${b - 2} v-5"/><text class="c-side" x="${(a + b) / 2}" y="${yb + 19}" text-anchor="middle">${label}</text>`;
  const shownBase = recentStart, baseDays = DEMO.windows.baseline.days;
  if (shownBase > 0) s += br(x0, rb, compact ? 'before' : shownBase < baseDays ? `before: last ${shownBase} of ${baseDays} days shown` : `before, ${baseDays} days`);
  s += br(rb, x1, windowLabel ?? `recent, ${DAYS_RECENT.length} days`);
  const H = yb + 24;
  return `${open(width, H)}${s}</svg>${desc}`;
}
