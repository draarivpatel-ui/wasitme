// design/system test suite. Zero dependencies. Usage: node design/system/gen/test.mjs
// Fails (exit 1) if: generated files are stale or not byte-stable; any declared colour pair fails WCAG or the
// CVD gate; copy breaks the lint (DESIGN.md §3, D31, D44); a screen hard-codes a colour or lacks the demo stamp;
// demo-data v3 rows don't add up; an asset named in tokens.json is missing; a home path leaked.
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, userInfo, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT, loadTokens, rangeAndMde, wsDf, studentTQuantile, glyphFiles } from './lib.mjs';
import { outputs } from './build.mjs';
import { checks } from './gen-report.mjs';

const t = loadTokens();
const DEMO = JSON.parse(readFileSync(join(ROOT, 'demo-data.v3.json'), 'utf8'));
const STAMP_TEXT = `demo data v${DEMO.version} (analytic) — not engine output`;
const results = [];
const SKIP = Symbol('skip');
const test = async (name, fn) => {
  try { const r = await fn(); if (r && r[0] === SKIP) results.push([name, [], r[1]]); else results.push([name, r === undefined || r === true ? [] : r]); }
  catch (e) { results.push([name, [String(e.stack || e)]]); }
};
// The engine's own contract module (engine/dist, built by `npm run build` in engine/). Optional: checks that need it SKIP without it.
const ENGINE = join(ROOT, '../../engine/dist/src');
const engineMod = async rel => (existsSync(join(ENGINE, rel)) ? import(pathToFileURL(join(ENGINE, rel)).href) : null);
const walk = dir => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(ROOT);
const TEXT_EXT = new Set(['.json', '.mjs', '.css', '.html', '.md', '.svg', '.swift', '.ts', '.txt', '.py']);

// 1. generated files: fresh and byte-stable
await test('generated files are up to date and byte-stable', () => {
  const a = outputs(), b = outputs(), errs = [];
  for (const [rel, body] of Object.entries(a)) {
    if (body !== b[rel]) errs.push(`${rel}: two runs differ (non-deterministic)`);
    const p = join(ROOT, rel);
    if (!existsSync(p)) errs.push(`${rel}: missing (run gen/build.mjs)`);
    else if (readFileSync(p, 'utf8') !== body) errs.push(`${rel}: stale (run gen/build.mjs)`);
  }
  return errs;
});

// 2. contrast + colour vision
await test('every declared colour pair passes WCAG; state colours pass the CVD gate', () => checks(t).failures);
await test('CVD simulation sanity: white and black survive every simulation; report says all pass', async () => {
  const { CVD, simHex } = await import('./lib.mjs');
  const errs = [];
  for (const k of Object.keys(CVD)) {
    if (simHex('#FFFFFF', k) !== '#FFFFFF') errs.push(`${k}: white becomes ${simHex('#FFFFFF', k)}`);
    if (simHex('#000000', k) !== '#000000') errs.push(`${k}: black becomes ${simHex('#000000', k)}`);
  }
  const rep = readFileSync(join(ROOT, 'generated/contrast-report.md'), 'utf8');
  if (!/Result: all pass/.test(rep)) errs.push('contrast-report.md does not say "all pass"');
  return errs;
});

// 3. copy lint
const visibleText = html => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<title>[\s\S]*?<\/title>/g, m => ' ' + m.replace(/<[^>]+>/g, '') + ' ')
  .replace(/aria-label="([^"]*)"/g, ' $1 ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const copySources = () => {
  const out = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (rel.startsWith('screens/') && f.endsWith('.html')) out.push([rel, visibleText(readFileSync(f, 'utf8'))]);
    if (rel.startsWith('screens/') && f.endsWith('.md')) out.push([rel, readFileSync(f, 'utf8')]);
  }
  const st = t.states;
  for (const s of [...st.order, ...st.displayOnly, 'calibrationPending'])
    out.push([`tokens.states.${s}`, Object.entries(st[s]).filter(([k]) => ['label', 'headline', 'legend', 'voiceOver'].includes(k)).map(([, v]) => v).join(' | ')]);
  out.push(['tokens.copy', [t.copy.privacyLine, t.copy.disclaimer, t.copy.tagline, t.copy.question].join(' | ')]);
  // every string the Control Center canvas owns (copy.canvas, UX-V2 §11.1), wherever it is nested
  const strings = (o, at) => Object.entries(o).flatMap(([k, v]) => k === '$about' ? [] : typeof v === 'string' ? [[`${at}.${k}`, v]] : v && typeof v === 'object' ? strings(v, `${at}.${k}`) : []);
  if (!t.copy.canvas || typeof t.copy.canvas !== 'object') throw new Error('tokens.copy.canvas missing');
  for (const [where, text] of strings(t.copy.canvas, 'tokens.copy.canvas')) out.push([where, text]);
  for (const s of t.appStates.order) out.push([`tokens.appStates.${s}`, [t.appStates[s].label, t.appStates[s].legend, t.appStates[s].glyph].join(' | ')]);
  const demo = JSON.parse(readFileSync(join(ROOT, 'demo-data.v3.json'), 'utf8'));
  for (const [k, c] of Object.entries(demo.cases))
    out.push([`demo-data.v3 ${k}`, [c.headline, c.because, c.detail, c.next, c.disclaimer, c.confidence, ...(c.checked || []).flat(), ...(c.timeline || []).map(e => e.label)].filter(Boolean).join(' | ')]);
  return out;
};
await test('copy lint (DESIGN.md §3, D31, D44)', () => {
  const errs = [];
  for (const [where, text] of copySources()) for (const b of t.copy.banned) {
    let s = text;
    if (b.except) s = s.split(b.except).join(' ');
    const m = new RegExp(b.pattern, b.flags + 'g');
    for (const hit of s.matchAll(m)) errs.push(`${where}: "${hit[0]}" (${b.why})`);
  }
  return errs;
});
await test('glance strings carry no quality words', () => {
  const errs = [], re = new RegExp(t.copy.glanceBanned.pattern, t.copy.glanceBanned.flags);
  const glance = [];
  for (const s of [...t.states.order, ...t.states.displayOnly]) glance.push([`tokens ${s}`, `${t.states[s].label} ${t.states[s].voiceOver} ${t.states[s].legend}`]);
  for (const s of t.appStates.order) glance.push([`tokens appStates.${s}`, `${t.appStates[s].label} ${t.appStates[s].legend}`]);
  for (const f of files.filter(f => f.endsWith('.html') && relative(ROOT, f).startsWith('screens/'))) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/data-glance="([^"]*)"/g)) glance.push([relative(ROOT, f), m[1]]);
  }
  for (const [w, s] of glance) if (re.test(s)) errs.push(`${w}: "${s.trim().slice(0, 80)}"`);
  return errs;
});

// 4. screens: colours only through tokens, stamp everywhere, fonts never remote
await test('screens use tokens only (no colour literals), carry the demo stamp, load nothing remote', () => {
  const errs = [];
  const named = /(?:^|[\s:;,(])(white|black|red|green|blue|yellow|gray|grey|orange|purple|pink|navy|teal|silver|gold|cyan|magenta)(?=[\s;,)!"]|$)/i;
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (!rel.startsWith('screens/') || !['.html', '.css'].includes(extname(f))) continue;
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    const styleish = extname(f) === '.css' ? src : [...src.matchAll(/<style[\s\S]*?<\/style>|style="[^"]*"|(?:fill|stroke|color|stop-color)="[^"]*"/g)].map(m => m[0]).join('\n');
    const hex = styleish.match(/#[0-9a-fA-F]{3,8}\b/g) || (extname(f) === '.html' ? src.match(/(?:fill|stroke|color)="#[0-9a-fA-F]{3,8}"/g) : null);
    if (hex) errs.push(`${rel}: colour literal ${hex[0]}`);
    if (/\brgba?\(|\bhsla?\(/.test(styleish)) errs.push(`${rel}: rgb()/hsl() literal`);
    for (const line of styleish.split('\n')) if (/opacity\s*:\s*0?\.\d/.test(line) && !/tw-bar i\b/.test(line)) errs.push(`${rel}: text dimmed with opacity (its contrast is unchecked; use a muted token): ${line.trim().slice(0, 80)}`);
    for (const line of styleish.split('\n')) {
      const decl = line.match(/(?:color|background|fill|stroke|border[a-z-]*|outline)\s*:\s*([^;}"]*)/gi) || [];
      for (const d of decl) if (named.test(d.split(':').slice(1).join(':'))) errs.push(`${rel}: named colour in "${d.trim()}"`);
    }
    const urls = (src.match(/https?:\/\/[^\s"')<]+/g) || []).filter(u => !u.startsWith('http://www.w3.org/'));
    if (urls.length) errs.push(`${rel}: remote URL ${urls[0]}`);
    if (extname(f) === '.html' && !src.includes(STAMP_TEXT)) errs.push(`${rel}: missing the demo-data stamp "${STAMP_TEXT}"`);
  }
  return errs;
});
await test('every screen in the manifest has light/dark PNGs of the right size', () => {
  const man = join(ROOT, 'screens/manifest.json');
  if (!existsSync(man)) return ['screens/manifest.json missing'];
  const errs = [];
  for (const p of JSON.parse(readFileSync(man, 'utf8'))) for (const m of p.modes) {
    const f = join(ROOT, 'screens', `${p.name}-${m}.png`);
    if (!existsSync(f)) { errs.push(`missing ${p.name}-${m}.png`); continue; }
    const b = readFileSync(f);
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    if (w !== p.w || h !== p.h) errs.push(`${p.name}-${m}.png is ${w}x${h}, expected ${p.w}x${p.h}`);
  }
  return errs;
});

// 5. demo data v3 adds up
await test('demo-data v3: daily rows sum to the window totals; ratios match k/n', () => {
  const d = JSON.parse(readFileSync(join(ROOT, 'demo-data.v3.json'), 'utf8')), errs = [];
  if (!/^ANALYTIC/.test(d._label)) errs.push('v3 _label must start with ANALYTIC');
  for (const [k, c] of Object.entries(d.cases)) {
    for (const m of c.metrics || []) {
      if (!m.eligible || m.ratio === undefined) continue;
      const r = m.recent.k !== undefined ? (m.recent.k / m.recent.n) / (m.baseline.k / m.baseline.n) : (m.recent.reads / m.recent.edits) / (m.baseline.reads / m.baseline.edits);
      if (Math.round(r * 100) / 100 !== m.ratio) errs.push(`${k}.${m.id}: ratio ${m.ratio} but k/n gives ${r.toFixed(4)}`);
      if (!(m.range[0] < m.ratio && m.ratio < m.range[1])) errs.push(`${k}.${m.id}: ratio outside its range`);
      const movedByRange = m.range[0] > 1 || m.range[1] < 1;
      if (!m.context && (m.status === 'moved') !== movedByRange) errs.push(`${k}.${m.id}: status ${m.status} disagrees with range ${m.range}`);
    }
    if (!c.daily) continue;
    const tm = c.metrics.find(m => m.id === c.daily.metric);
    for (const w of ['recent', 'baseline']) {
      const s = c.daily[w].reduce((a, r) => [a[0] + r.k, a[1] + r.n], [0, 0]);
      if (s[0] !== tm[w].k || s[1] !== tm[w].n) errs.push(`${k}.daily.${w}: rows sum to ${s} but the window says ${tm[w].k}/${tm[w].n}`);
      if (c.daily[w].length !== d.windows[w].days) errs.push(`${k}.daily.${w}: ${c.daily[w].length} rows for a ${d.windows[w].days}-day window`);
      if (c.daily[w].some(r => r.k > r.n)) errs.push(`${k}.daily.${w}: a day has more events than opportunities`);
    }
  }
  return errs;
});

// 6. assets named in tokens exist; glyph separation passed; fonts + licence present
await test('glyph, mark and font files exist; glyph separation PASS', () => {
  const errs = [];
  const need = [...Object.values(t.states).flatMap(s => (s && s.files ? Object.values(s.files) : [])), ...Object.values(t.mark.files),
    ...t.appStates.order.flatMap(s => Object.values(t.appStates[s].files)),
    'fonts/OFL.txt', 'fonts/MODIFICATIONS.txt', ...['Regular', 'Italic', 'Bold', 'BoldItalic'].map(w => `fonts/web/WasitmeSerif-${w}.woff2`),
    'fonts/web/WasitmeMono-Regular.woff2', 'fonts/web/WasitmeMono-Bold.woff2',
    ...['Regular', 'Italic', 'Bold', 'BoldItalic'].map(w => `fonts/app/IBMPlexSerif-${w}.ttf`), 'fonts/app/IBMPlexMono-Regular.ttf', 'fonts/app/IBMPlexMono-Bold.ttf'];
  for (const p of need) if (!existsSync(join(ROOT, p))) errs.push(`missing ${p}`);
  if (!/Reserved Font Name "Plex"/.test(readFileSync(join(ROOT, 'fonts/OFL.txt'), 'utf8'))) errs.push('fonts/OFL.txt is not the IBM Plex OFL');
  const sep = join(ROOT, 'glyphs/separation.txt');
  if (!existsSync(sep) || !/RESULT: PASS\s*$/.test(readFileSync(sep, 'utf8'))) errs.push('glyphs/separation.txt does not end in PASS (run gen/glyph-check.mjs)');
  const sepText = existsSync(sep) ? readFileSync(sep, 'utf8') : '';
  for (const s of t.appStates.order) if (!new RegExp(`app ${s}: nearest glyph`).test(sepText)) errs.push(`glyphs/separation.txt does not measure the app state ${s} (run gen/glyph-check.mjs)`);
  for (const f of files.filter(f => /glyphs\/(state|app)-.*\.svg$/.test(f))) {
    const s = readFileSync(f, 'utf8');
    if (/opacity|#(?!000\b)[0-9a-fA-F]{3,6}/.test(s)) errs.push(`${relative(ROOT, f)}: template glyphs are pure black + alpha`);
  }
  return errs;
});

// 6b. the app states keep their own rule: never a side, a quiet chip from existing colours
await test('app states: glyphs never draw a side (no triangle, no strike, no square above the rule); chip colours are declared pairs', async () => {
  const { loadGlyphs } = await import('./lib.mjs');
  const errs = [];
  for (const [key, g] of loadGlyphs(t).filter(([k]) => k.startsWith('app-'))) {
    const ruleTop = g.size === 16 ? 7 : 8;   // the states' rule: rect(1, 7, 14, 2) / rect(1, 8, 16, 2)
    for (const p of g.prims) {
      if (p.kind === 'fill') errs.push(`${key}: a filled path (triangles are the agent's)`);
      if (p.kind === 'stroke') errs.push(`${key}: a stroked line (a diagonal strike is stale's)`);
      if (p.kind === 'rect' && p.y + p.h <= ruleTop && p.w >= 4 && p.h >= 4) errs.push(`${key}: a block above the rule (squares above are your side's)`);
      if (p.kind === 'rect' && (![p.x, p.y, p.w, p.h].every(Number.isInteger))) errs.push(`${key}: off the pixel grid`);
    }
  }
  const c = t.appStates.chip, leaves = new Set([...(await import('./lib.mjs')).colorLeaves(t.color.light)].map(([p]) => p));
  for (const k of ['fg', 'bg', 'glyph', 'edge']) if (!leaves.has(c[k])) errs.push(`appStates.chip.${k}: ${c[k]} is not a colour path`);
  const textPair = t.contrast.text.find(([fg]) => fg === c.fg);
  if (!textPair || !textPair[1].includes(c.bg)) errs.push(`appStates.chip: ${c.fg} on ${c.bg} is not a declared text pair (contrast.text)`);
  if (new Set(t.appStates.order.map(s => t.appStates[s].label)).size !== t.appStates.order.length) errs.push('two app states share a label');
  for (const s of t.appStates.order) if ([...t.states.order, ...t.states.displayOnly].some(x => t.states[x].label === t.appStates[s].label)) errs.push(`app state ${s} reuses a finding state's label`);
  return errs;
});

// 7. nothing private leaks into the public repo
await test('no home paths or user names in design/system', () => {
  const errs = [], who = userInfo().username.replace(/[^\w.-]/g, '');
  const leak = new RegExp([homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), '/' + 'Users/', '/' + 'home/[a-z]', '/' + 'private/tmp', ...(who.length > 2 ? [who] : [])].join('|'));
  for (const f of files) {
    if (!TEXT_EXT.has(extname(f))) continue;
    const s = readFileSync(f, 'utf8');
    if (leak.test(s)) errs.push(relative(ROOT, f));
  }
  return errs;
});

// 8. the TS module loads and behaves
const tsErrs = [];
try {
  const m = await import(join(ROOT, 'generated/tokens.ts'));
  for (const s of Object.keys(m.tokens.states)) for (const mode of ['none', 'ansi16', 'ansi256-dark', 'ansi256-light', 'truecolor-dark', 'truecolor-light']) {
    const line = m.statusLine(s, 1, mode);
    const plain = line.replace(/\u001b\[[0-9;]*m/g, '');
    if (!plain.includes(m.tokens.states[s].label.toLowerCase())) tsErrs.push(`statusLine(${s}, ${mode}) lost its label`);
    if (mode === 'none' && line !== plain) tsErrs.push(`statusLine(${s}, none) emits escape codes`);
    if (new RegExp(t.copy.glanceBanned.pattern, 'i').test(plain)) tsErrs.push(`statusLine(${s}) has a quality word`);
  }
  if (m.chooseMode({ NO_COLOR: '1', TERM: 'xterm-256color' }, true) !== 'none') tsErrs.push('NO_COLOR not honoured');
  if (m.sticker('you', '1', 'none') !== '[1]') tsErrs.push('NO_COLOR sticker should be [1]');
} catch (e) { tsErrs.push(String(e)); }
results.push(['generated/tokens.ts loads; status line honours NO_COLOR and glance rules', tsErrs]);
const tsc = join(ROOT, '../../engine/node_modules/.bin/tsc'), tsc2 = join(ROOT, '../../node_modules/.bin/tsc');
const tscBin = existsSync(tsc) ? tsc : existsSync(tsc2) ? tsc2 : null;
if (tscBin) {
  let errs = [];
  try { execFileSync(tscBin, ['--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--allowImportingTsExtensions', join(ROOT, 'generated/tokens.ts')], { stdio: 'pipe' }); }
  catch (e) { errs = [String(e.stdout || e.message).slice(0, 2000)]; }
  results.push(['generated/tokens.ts passes tsc --strict', errs]);
}

// 9. Required copy (DESIGN.md §3): every none / you / agent body ends with the fixed disclaimer, verbatim
const visibleOf = rel => visibleText(readFileSync(join(ROOT, rel), 'utf8'));
await test('required copy: the fixed disclaimer closes every none/you/agent body (screens, popovers, report); one string everywhere', async () => {
  const errs = [], D = t.copy.disclaimer;
  for (const rel of ['screens/cc-none.html', 'screens/cc-you.html', 'screens/cc-agent.html', 'screens/popover-none.html', 'screens/popover-you.html', 'screens/report-agent.html'])
    if (!visibleOf(rel).includes(D)) errs.push(`${rel}: no "${D}"`);
  const md = readFileSync(join(ROOT, 'screens/report-agent.md'), 'utf8');
  if (!md.includes(D)) errs.push('screens/report-agent.md: no disclaimer');
  for (const [k, c] of Object.entries(DEMO.cases)) {
    const needs = ['none', 'you', 'agent'].includes(c.state);
    if (needs && c.disclaimer !== D) errs.push(`demo-data.v3 ${k}: disclaimer is ${JSON.stringify(c.disclaimer)}`);
    if (!needs && c.disclaimer) errs.push(`demo-data.v3 ${k}: a ${c.state} case carries the disclaimer`);
  }
  const check = await engineMod('contract/check.js');
  if (check && check.DISCLAIMER !== D) errs.push(`tokens copy.disclaimer differs from the engine's DISCLAIMER: ${JSON.stringify(check.DISCLAIMER)}`);
  const q = t.copy.banned.find(b => b.pattern.includes('quality'));
  if (q.except !== D) errs.push('copy.banned quality exception must be the full disclaimer');
  return errs;
});

// 10. the engine's own copy lint (engine/src/contract/check.ts lintCopy), run per string, never over a joined page
const segments = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  .split(/<[^>]+>/).map(x => x.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()).filter(Boolean);
await test('engine lintCopy passes on every screen text run, every report line and every demo string', async () => {
  const check = await engineMod('contract/check.js');
  if (!check) return [SKIP, 'engine/dist not built (cd engine && npm run build)'];
  const errs = [], lint = (where, text) => { for (const w of check.lintCopy(text)) errs.push(`${where}: ${w} in "${text.slice(0, 90)}"`); };
  for (const f of files.filter(f => relative(ROOT, f).startsWith('screens/') && f.endsWith('.html')))
    for (const seg of segments(readFileSync(f, 'utf8'))) lint(relative(ROOT, f), seg);
  for (const line of readFileSync(join(ROOT, 'screens/report-agent.md'), 'utf8').split('\n')) if (line.trim()) lint('screens/report-agent.md', line);
  for (const [k, c] of Object.entries(DEMO.cases))
    for (const v of [c.headline, c.because, c.detail, c.next, c.disclaimer, c.confidence, c.label, ...(c.checked || []).flat(), ...(c.timeline || []).map(e => e.label), ...(c.metrics || []).map(m => m.label)].filter(Boolean)) lint(`demo-data.v3 ${k}`, v);
  return errs;
});

// 11. the demo cases are states the engine can produce
await test('demo-data v3: every (state, reason) is allowed by the contract (REASONS_BY_STATE)', async () => {
  const vocab = await engineMod('contract/vocab.js');
  if (!vocab) return [SKIP, 'engine/dist not built'];
  const errs = [];
  for (const [k, c] of Object.entries(DEMO.cases)) {
    const allowed = vocab.REASONS_BY_STATE[c.state];
    if (!allowed) { errs.push(`${k}: unknown state ${c.state}`); continue; }
    if (!allowed.includes(c.reason ?? null)) errs.push(`${k}: reason ${JSON.stringify(c.reason ?? null)} is not allowed for ${c.state} (allowed: ${allowed.map(String).join(', ')})`);
  }
  // Decision table row 6 vs 7 (METHOD.md §11): an unclear case with only your-side candidates would be "you"
  const u = DEMO.cases.unclear;
  if (u.reason === 'both_sides' && !(u.timeline.some(e => e.candidate && e.side === 'you') && u.timeline.some(e => e.candidate && e.side === 'agent' && !e.routine)))
    errs.push('unclear (both_sides) needs a your-side candidate and an agent-strong candidate');
  return errs;
});

// 12. ranges and MDEs follow the engine formulas from the stored SE and df
await test('demo-data v3: range and MDE recompute from se/df (METHOD.md §6); df from session-days; copy prints the MDE; t quantiles match the engine', async () => {
  const errs = [];
  for (const [k, c] of Object.entries(DEMO.cases)) for (const m of (c.metrics || []).filter(m => m.eligible)) {
    const exact = m.recent.k !== undefined ? (m.recent.k / m.recent.n) / (m.baseline.k / m.baseline.n) : (m.recent.reads / m.recent.edits) / (m.baseline.reads / m.baseline.edits);
    const ev = m.recent.k !== undefined ? [m.recent.k, m.baseline.k] : [m.recent.edits, m.baseline.edits];
    const df = Math.round(wsDf(ev[0], c.n.recent.sessionDays, ev[1], c.n.baseline.sessionDays) * 10) / 10;
    if (df !== m.df) errs.push(`${k}.${m.id}: df ${m.df}, session-days give ${df}`);
    const { range, mde } = rangeAndMde(exact, m.se, m.df);
    if (Math.abs(range[0] - m.range[0]) > 0.0051 || Math.abs(range[1] - m.range[1]) > 0.0051) errs.push(`${k}.${m.id}: range ${m.range} but se/df give ${range.map(x => x.toFixed(3))}`);
    if (Math.abs(mde - m.mde) > 0.051) errs.push(`${k}.${m.id}: MDE ${m.mde} but se/df give ${mde.toFixed(3)}`);
  }
  const ins = DEMO.cases.insufficient, te = ins.metrics.find(m => m.id === 'toolErrors');
  if (!ins.because.includes(`×${te.mde}`)) errs.push(`insufficient: copy does not print the tool-error MDE ×${te.mde}`);
  const nv = DEMO.cases.none.metrics.filter(m => m.eligible && ['errors', 'research'].includes(m.family));
  if (!DEMO.cases.none.because.includes(`×${Math.max(...nv.map(m => m.mde))} in ${nv.length} indicators`)) errs.push('none: copy does not match the engine template (D67) "×{max MDE} in {n} indicators"');
  if (nv.some(m => m.mde > 2)) errs.push('none: a voting metric is not sensitive (MDE > 2), so the state cannot be none (METHOD.md §11 row 13)');
  const dist = await engineMod('analysis/stats/distributions.js');
  if (dist) for (const df of [4, 12, 34.6, 80]) for (const p of [0.8, 0.995])
    if (Math.abs(dist.studentTQuantile(p, df) - studentTQuantile(p, df)) > 1e-6) errs.push(`t quantile p=${p} df=${df} differs from the engine`);
  const lastVer = [...ins.timeline].reverse().find(e => e.side === 'agent' && e.kind === 'version').label.split(' → ')[1];
  if (!DEMO.setup.agentVersion.endsWith(lastVer)) errs.push(`setup.agentVersion ${DEMO.setup.agentVersion} is not the timeline's last version ${lastVer}`);
  const ag = DEMO.cases.agent;
  if (/^Nothing recorded changed on your side/.test(ag.because) && ag.timeline.some(e => e.side === 'you')) errs.push('agent: says nothing recorded changed on your side but its timeline has a your-side change');
  return errs;
});

// 13. forest plots draw the printed range: no silent clamping at the axis edge
await test('forest plots: the drawn range matches the printed range, or ends in an overflow arrow', async () => {
  const { forest } = await import('./screens/kit.mjs');
  const errs = [], D = t.chart.ratio.domain, W = 220;
  const X = v => (Math.log(v / D[0]) / Math.log(D[1] / D[0])) * W;
  const cases = [...Object.entries(DEMO.cases).flatMap(([k, c]) => (c.metrics || []).filter(m => m.eligible).map(m => [`${k}.${m.id}`, m])),
    ['synthetic over', { ratio: 6, range: [3, 12], mde: 2, status: 'moved' }], ['synthetic under', { ratio: 0.2, range: [0.1, 0.4], mde: 2, status: 'moved' }]];
  for (const [id, m] of cases) {
    const svg = forest({ ratio: m.ratio, range: m.range, mde: m.mde, moved: m.status === 'moved' }, W);
    const line = /<line class="c-range" x1="([\d.]+)" y1="11" x2="([\d.]+)" y2="11"\/>/.exec(svg);
    if (!line) { errs.push(`${id}: no range bar`); continue; }
    const [a, b] = [Number(line[1]), Number(line[2])], over = (svg.match(/c-range-over/g) || []).length;
    const wantOver = (m.range[0] < D[0] ? 1 : 0) + (m.range[1] > D[1] ? 1 : 0);
    if (over !== wantOver) errs.push(`${id}: ${over} overflow arrows, expected ${wantOver}`);
    if (m.range[0] >= D[0] && Math.abs(a - X(m.range[0])) > 0.1) errs.push(`${id}: bar starts at ${a}, range says ${X(m.range[0]).toFixed(1)}`);
    if (m.range[1] <= D[1] && Math.abs(b - X(m.range[1])) > 0.1) errs.push(`${id}: bar ends at ${b}, range says ${X(m.range[1]).toFixed(1)}`);
    if (!/aria-hidden="true"/.test(svg)) errs.push(`${id}: forest svg is not aria-hidden (its numbers are in the row)`);
  }
  return errs;
});

// 14. type: sizes only from the scale (static half; render.mjs checks the rendered DOM)
await test('type: no literal font sizes outside the scale in components.css or screen CSS (host/terminal mocks exempt)', () => {
  const errs = [], sizes = new Set(Object.values(t.type.scale).map(s => s.size));
  const srcs = [['screens/components.css', readFileSync(join(ROOT, 'screens/components.css'), 'utf8')],
    ...files.filter(f => relative(ROOT, f).startsWith('screens/') && f.endsWith('.html')).map(f => [relative(ROOT, f), [...readFileSync(f, 'utf8').matchAll(/<style>([\s\S]*?)<\/style>|style="([^"]*)"/g)].map(m => m[1] ?? `x{${m[2]}}`).join('\n')])];
  for (const [rel, css] of srcs) for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const [, sel, body] = rule;
    if (/font-(host|terminal)/.test(body) || /^\s*\.(md|issue|term|tw|ct)\b/.test(sel)) continue; // mocks of other apps' type
    for (const d of body.matchAll(/font(?:-size)?\s*:\s*([^;]*)/g)) for (const px of d[1].matchAll(/(?<![\w.-])(\d+(?:\.\d+)?)px/g))
      if (!/\/\s*$/.test(d[1].slice(0, px.index)) && !sizes.has(Number(px[1]))) errs.push(`${rel}: ${sel.trim().slice(0, 40)} { ${d[0].trim().slice(0, 60)} }`);
  }
  return errs;
});

// 15. Swift: compile and run a probe against generated/Tokens.swift (macOS with Xcode tools only)
await test('Tokens.swift: compiles with -warnings-as-errors; noDetectableChange = "none"; no unfilled placeholder; VoiceOver plurals; copy, sizes, PostScript names, chart, edge styles and glyphs match tokens.json', () => {
  let xcrun = null; try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }); xcrun = 'xcrun'; } catch { return [SKIP, 'no xcrun swiftc on this machine']; }
  if (process.env.WASITME_SKIP_SWIFT) return [SKIP, 'WASITME_SKIP_SWIFT set'];
  const dir = mkdtempSync(join(tmpdir(), 'wasitme-swift-'));
  try {
    const pop = t.size.popover, chipH = t.size.chip.height;
    writeFileSync(join(dir, 'main.swift'), `import CoreGraphics
func f(_ s: Tokens.FindingState?) -> String { switch s { case .none: return "nil"; case .some(let x): return x.rawValue } }
precondition(Tokens.Copy.disclaimer == ${JSON.stringify(t.copy.disclaimer)} && Tokens.Copy.privacyLine == ${JSON.stringify(t.copy.privacyLine)})
precondition(Tokens.Size.popover == CGSize(width: ${pop.width}, height: ${pop.height}) && Tokens.Size.chipHeight == ${chipH})
precondition(Tokens.TypeScale.note.postScriptName == ${JSON.stringify(t.type.families.serif.postscript['400i'])} && Tokens.TypeScale.ui.size == ${t.type.scale.ui.size})
precondition(Tokens.Chart.Strip.lowNThreshold == ${t.chart.strip.lowNThreshold} && Tokens.Chart.Ratio.domain == ${t.chart.ratio.domain[0]}...${t.chart.ratio.domain[1]})
${[...t.states.order, ...t.states.displayOnly].map(s => `precondition(Tokens.FindingState(rawValue: "${s}")!.edgeStyle == .${t.color.light.state[s].edgeStyle})`).join('\n')}
precondition(Tokens.Glyphs.all.count == ${glyphFiles(t).length})
precondition(Tokens.AppState.allCases.map { $0.rawValue } == ${JSON.stringify(t.appStates.order)})
for a in Tokens.AppState.allCases { precondition(Tokens.Glyphs.all[a.menuBarImage16]?.grid == 16 && Tokens.Glyphs.all[a.menuBarImage18]?.grid == 18, a.rawValue) }
for s in Tokens.FindingState.allCases { precondition(Tokens.Glyphs.all[s.menuBarImage16]?.grid == 16 && Tokens.Glyphs.all[s.menuBarImage18]?.grid == 18, s.rawValue) }
for (k, g) in Tokens.Glyphs.all { precondition(!g.primitives.isEmpty && (g.grid == 16 || g.grid == 18) && k.hasSuffix("-\\(Int(g.grid))"), k) }
precondition(Tokens.FindingState.noDetectableChange.rawValue == "none")
precondition(Tokens.FindingState(rawValue: "none") == .noDetectableChange)
precondition(f(nil) == "nil" && f(.noDetectableChange) == "none")
precondition(Tokens.FindingState.allCases.map { $0.rawValue } == ${JSON.stringify([...t.states.order, ...t.states.displayOnly])})
for s in Tokens.FindingState.allCases {
  for v in [s.label, s.headline, s.legend, s.textGlyph, s.ascii, s.menuBarImage16, s.menuBarImage18, s.voiceOver(lastChecked: "2 h ago")] {
    precondition(!v.contains("{") && !v.contains("}"), "placeholder left in \(v)")
  }
}
precondition(Tokens.FindingState.stale.voiceOver(lastChecked: "2 h ago") == ${JSON.stringify(t.states.stale.voiceOver.replace('{when}', '2 h ago'))})
precondition(Tokens.FindingState.newChangesVoiceOver(1) == ${JSON.stringify(t.states.newEvent.voiceOver.one.replace('{n}', '1'))})
precondition(Tokens.FindingState.newChangesVoiceOver(3) == ${JSON.stringify(t.states.newEvent.voiceOver.other.replace('{n}', '3'))})
precondition(Tokens.FindingState.newChangesText(2) == "+2")
precondition(Tokens.CalibrationPending.glyph == .insufficient && Tokens.CalibrationPending.label == ${JSON.stringify(t.states.calibrationPending.label)})
print("ok")
`);
    execFileSync(xcrun, ['swiftc', '-warnings-as-errors', '-o', join(dir, 'probe'), join(ROOT, 'generated/Tokens.swift'), join(dir, 'main.swift')], { stdio: 'pipe', timeout: 240000 });
    const out = execFileSync(join(dir, 'probe'), { stdio: 'pipe' }).toString().trim();
    return out === 'ok' ? [] : [`probe printed ${out}`];
  } catch (e) { return [String(e.stderr || e.message).slice(0, 1500)]; }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

// 16. shipped-HTML fonts: inlined, nothing fetched, proven under the report CSP
await test('tokens.inline.css: fonts only as data: URLs; csp-check.txt PASS for this exact file', () => {
  const errs = [], css = readFileSync(join(ROOT, 'generated/tokens.inline.css'), 'utf8');
  if (/https?:/i.test(css)) errs.push('tokens.inline.css mentions http(s)');
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map(m => m[1]);
  if (urls.length !== 6 || urls.some(u => !u.startsWith('data:font/woff2;base64,'))) errs.push(`tokens.inline.css: expected 6 data: font URLs, found ${urls.map(u => u.slice(0, 20)).join(', ')}`);
  const rep = join(ROOT, 'generated/csp-check.txt');
  if (!existsSync(rep)) return [...errs, 'generated/csp-check.txt missing (run gen/csp-check.mjs)'];
  const txt = readFileSync(rep, 'utf8');
  if (!/RESULT: PASS\s*$/.test(txt)) errs.push('csp-check.txt does not end in PASS');
  if (!txt.includes(`sha256 ${createHash('sha256').update(css).digest('hex')}`)) errs.push('csp-check.txt was made for a different tokens.inline.css (re-run gen/csp-check.mjs)');
  return errs;
});

// 17. terminal output modes
await test('tokens.ts modes: SGR 2 (dim) only in 16 colours; 16-colour stickers are reverse video; greys are explicit elsewhere', async () => {
  const m = await import(join(ROOT, 'generated/tokens.ts')), errs = [];
  for (const mode of ['ansi256-dark', 'ansi256-light', 'truecolor-dark', 'truecolor-light'])
    for (const role of ['muted', 'rule']) if (/\u001b\[2m/.test(m.styled(role, 'x', mode))) errs.push(`${mode} ${role} uses SGR 2`);
  for (const p of ['you', 'agent']) if (m.sticker(p, '1', 'ansi16') !== '\u001b[7m 1 \u001b[0m') errs.push(`ansi16 ${p} sticker is ${JSON.stringify(m.sticker(p, '1', 'ansi16'))}`);
  const tc = m.styled('muted', 'x', 'truecolor-dark'), want = t.terminal.sgr.truecolor.dark.muted;
  if (!tc.includes('38;2;' + [1, 3, 5].map(i => parseInt(want.slice(i, i + 2), 16)).join(';'))) errs.push(`truecolor-dark muted is ${JSON.stringify(tc)}`);
  const env = [[{ TERM: 'xterm-256color' }, true, 'ansi256-dark'], [{ TERM: 'xterm-256color', COLORFGBG: '0;15' }, true, 'ansi256-light'], [{ COLORTERM: 'truecolor' }, true, 'truecolor-dark'],
    [{ TERM: 'screen' }, true, 'ansi16'], [{ TERM: 'dumb' }, true, 'none'], [{ TERM: 'xterm-256color' }, false, 'none'], [{ NO_COLOR: '' , TERM: 'xterm-256color' }, true, 'none']];
  for (const [e, tty, want2] of env) if (m.chooseMode(e, tty) !== want2) errs.push(`chooseMode(${JSON.stringify(e)}, ${tty}) = ${m.chooseMode(e, tty)}, expected ${want2}`);
  return errs;
});

let failed = 0;
for (const [name, errs, skip] of results) {
  if (skip) { console.log(`skip ${name}\n       ${skip}`); continue; }
  console.log(`${errs.length ? 'FAIL' : 'ok  '} ${name}`);
  for (const e of errs.slice(0, 25)) console.log(`       ${e}`);
  if (errs.length > 25) console.log(`       ... ${errs.length - 25} more`);
  if (errs.length) failed++;
}
const skipped = results.filter(r => r[2]).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length - skipped} checks pass${skipped ? ` (${skipped} skipped)` : ''}`);
process.exitCode = failed ? 1 : 0;
