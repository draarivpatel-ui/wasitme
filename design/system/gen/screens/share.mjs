// Shareable surfaces: the markdown evidence report (and how it renders when pasted into an issue), the README hero.
import { T, DEMO, STAMP, esc, fdate, num, x2, mark, wordmark, page, strip } from './kit.mjs';

// The report is built once as blocks, then emitted as markdown (what `wasitme report --md` prints) and as HTML
// (how a typical issue tracker renders that markdown), so the two can't drift.
function reportBlocks() {
  const c = DEMO.cases.agent;
  const st = T.states.agent;
  const daily = c.daily.recent;
  const ev = c.timeline;
  const shift = ev.find(e => e.shift);
  const kRow = daily.map(r => String(r.k).padStart(4)).join(''), nRow = daily.map(r => String(r.n).padStart(4)).join('');
  const markRow = daily.map(r => { const e = ev.find(x => x.day.slice(5) === r.d && x.side === 'agent'); return e ? `  ▲${e.marker}` : '    '; }).join('');
  const dates = daily.map((r, i) => (i % 7 === 0 ? fdate(r.d).padEnd(28) : '')).join('').trimEnd();
  const metricRow = m => [
    m.label + (m.family === 'friction' ? ' (context)' : ''),
    m.recent.k !== undefined ? `${num(m.recent.k)} / ${num(m.recent.n)}` : `${num(m.recent.reads)} / ${num(m.recent.edits)}`,
    m.baseline.k !== undefined ? `${num(m.baseline.k)} / ${num(m.baseline.n)}` : `${num(m.baseline.reads)} / ${num(m.baseline.edits)}`,
    m.eligible ? x2(m.ratio) : '', m.eligible ? `${x2(m.range[0])}–${x2(m.range[1])}` : '',
    !m.eligible ? 'context only' : m.status === 'moved' ? `moved, ${m.ratio >= 1 ? 'more' : 'fewer'}` : 'not detected'];
  return [
    { t: 'h3', text: 'wasitme report: the agent changed (Claude Code)' },
    { t: 'p', md: `\`${st.textGlyph}\` **${st.label}.** ${c.because}`, html: `<code>${esc(st.textGlyph)}</code> <strong>${esc(st.label)}.</strong> ${esc(c.because)}` },
    { t: 'p', md: c.confidence, html: esc(c.confidence) },
    // DESIGN.md §3: the body ends with the fixed disclaimer, verbatim (engine lintCopy exempts only the exact string)
    { t: 'p', md: `_One person’s logs on one Mac. ${T.copy.disclaimer}_`, html: `<em>One person’s logs on one Mac. ${esc(T.copy.disclaimer)}</em>` },
    { t: 'h4', text: 'What was checked' },
    { t: 'table', head: ['checked', 'what wasitme found'], align: ['l', 'l'], rows: c.checked },
    { t: 'h4', text: `What moved (recent ${fdate(DEMO.windows.recent.from)} – ${fdate(DEMO.windows.recent.to)} against ${fdate(DEMO.windows.baseline.from)} – ${fdate(DEMO.windows.baseline.to)})` },
    { t: 'table', head: ['signal', 'recent', 'before', 'change', 'range', 'status'], align: ['l', 'r', 'r', 'r', 'l', 'l'], rows: c.metrics.map(metricRow) },
    { t: 'p', md: 'Counts are events / opportunities per window. Range: where the ratio could be at this volume (calibrated; see METHOD.md). “Not detected” means any change was too small to show at this volume.', html: 'Counts are events / opportunities per window. Range: where the ratio could be at this volume (calibrated; see METHOD.md). “Not detected” means any change was too small to show at this volume.' },
    { t: 'h4', text: 'Tool errors per day, recent window' },
    { t: 'code', text: `        ${dates}\nerrors${kRow}\ncalls ${nRow}\n      ${markRow.trimEnd()}` },
    { t: 'h4', text: 'Timeline (■ your side, ▲ Claude Code)' },
    { t: 'list', items: [...ev].reverse().map(e => `${fdate(e.day)}  ${e.side === 'you' ? '■' : '▲'}${e.marker}  ${e.label}${e === shift ? ' (the shift starts here)' : e.side === 'agent' ? ' (update)' : ''}`) },
    { t: 'sub', text: `wasitme 0.1, numbers only: no prompts, code or paths. ${STAMP}` },
  ];
}

export function reportMarkdown() {
  const out = [];
  for (const b of reportBlocks()) {
    if (b.t === 'h3') out.push(`### ${b.text}`);
    else if (b.t === 'h4') out.push(`**${b.text}**`);
    else if (b.t === 'p') out.push(b.md);
    else if (b.t === 'table') {
      out.push(`| ${b.head.join(' | ')} |`, `|${b.align.map(a => (a === 'r' ? '---:' : '---')).join('|')}|`, ...b.rows.map(r => `| ${r.join(' | ')} |`));
    } else if (b.t === 'code') out.push('```text', b.text, '```');
    else if (b.t === 'list') out.push(...b.items.map(i => `- ${i}`));
    else if (b.t === 'sub') out.push(`<sub>${b.text}</sub>`);
    out.push('');
  }
  return out.join('\n');
}

export function reportPage() {
  const html = reportBlocks().map(b => {
    if (b.t === 'h3') return `<h3>${esc(b.text)}</h3>`;
    if (b.t === 'h4') return `<p><strong>${esc(b.text)}</strong></p>`;
    if (b.t === 'p') return `<p>${b.html}</p>`;
    if (b.t === 'table') return `<table>${b.headless ? '' : `<thead><tr>${b.head.map((h, i) => `<th class="${b.align[i]}">${esc(h)}</th>`).join('')}</tr></thead>`}<tbody>${b.rows.map(r => `<tr>${r.map((v, i) => `<td class="${b.align[i]}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    if (b.t === 'code') return `<pre><code>${esc(b.text)}</code></pre>`;
    if (b.t === 'list') return `<ul>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    if (b.t === 'sub') return `<p><sub>${esc(b.text)}</sub></p>`;
    return '';
  }).join('\n');
  const body = `<div class="rp"><header><h1 class="t-title">Shareable evidence report</h1><p class="t-note">What “Copy evidence report” puts on the clipboard (Markdown), shown the way an issue tracker renders it. The agent screen is the one people post, so it leads with what was checked.</p></header>
  <div class="issue"><div class="who"><span class="av"></span><b>someone</b> commented</div><div class="md">${html}</div></div></div>`;
  const css = `
.rp { padding: 28px 40px; background: var(--surface-page); height: 100%; }
.rp header { display: flex; align-items: baseline; gap: 24px; margin-bottom: 18px; }
.rp header .t-title { white-space: nowrap; }
.issue { background: var(--surface-raised); border: 1px solid var(--rule-strong); border-radius: 8px; max-width: 920px; }
.issue .who { padding: 10px 16px; border-bottom: 1px solid var(--rule-strong); background: var(--surface-well); font: 14px/20px var(--font-host); color: var(--ink-secondary); display: flex; align-items: center; gap: 8px; border-radius: 8px 8px 0 0; }
.issue .av { width: 20px; height: 20px; border-radius: 50%; background: var(--rule-strong); display: inline-block; }
.md { padding: 14px 18px 16px; font: 14px/1.5 var(--font-host); color: var(--ink-primary); }
.md h3 { font: 600 17px/1.3 var(--font-host); margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--rule-hair); }
.md p { margin: 0 0 10px; }
.md code { font: 12.5px/1.4 var(--font-terminal); background: var(--surface-well); padding: 1px 4px; border-radius: 4px; }
.md pre { background: var(--surface-well); padding: 10px 12px; border-radius: 6px; margin: 0 0 10px; overflow: hidden; }
.md pre code { background: none; padding: 0; font-size: 12px; line-height: 16px; }
.md table { border-collapse: collapse; margin: 0 0 10px; font-size: 13px; }
.md th, .md td { border: 1px solid var(--rule-strong); padding: 4px 10px; text-align: left; }
.md th { font-weight: 600; }
.md .r { text-align: right; }
.md ul { margin: 0 0 10px; padding-left: 22px; font-size: 13.5px; }
.md li { margin: 1px 0; }
.md sub { color: var(--ink-muted); font-size: 11.5px; }`;
  return page({ title: 'wasitme · evidence report', w: 1280, h: 1180, body, extraCss: css });
}

export function readmeHero() {
  const c = DEMO.cases.you;
  const body = `<div class="rh">
  <div class="rh-top"><span class="brand">${mark(30)}${wordmark()}</span><span class="t-typed-sm muted">for Claude Code and Codex, on macOS</span></div>
  <h1 class="rh-q">Was it <span class="me">me</span>, or the model?</h1>
  <div class="rh-sub"><p class="rh-tag">${esc(T.copy.tagline)}</p><p class="t-deck">wasitme reads your coding agent’s logs on this Mac and lays out what changed on your side and on the agent’s. It names a side only when the evidence lines up, and says “too early to tell” when that’s the honest answer.</p></div>
  <div class="rh-chart">${strip(c, { width: 1184, show: 28, gutter: 96, nRow: true })}</div>
  <footer class="stamp2"><span>MIT, local only, no account</span><span>${STAMP}</span></footer></div>`;
  const css = `
.rh { padding: 36px 48px 18px; background: var(--surface-sheet); height: 100%; display: flex; flex-direction: column; }
.rh-top { display: flex; justify-content: space-between; align-items: center; }
.rh-top .brand { display: inline-flex; align-items: center; gap: 10px; }
.rh-q { font: var(--type-readme); letter-spacing: var(--type-readme-tracking); margin: 18px 0 8px; }
.rh-q .me { background: linear-gradient(var(--you-fill), var(--you-fill)) 0 92% / 100% 8px no-repeat; }
.rh-sub { display: grid; grid-template-columns: 420px 1fr; gap: 32px; align-items: baseline; max-width: 1080px; }
.rh-tag { font: var(--type-title); font-style: italic; margin: 0; }
.rh-chart { margin-top: auto; margin-bottom: 18px; }
.stamp2 { margin-top: auto; display: flex; justify-content: space-between; font: var(--type-typed-sm); color: var(--ink-muted); border-top: 1px solid var(--rule-hair); padding-top: 8px; }`;
  return page({ title: 'wasitme · README hero', w: 1280, h: 640, body, extraCss: css });
}
