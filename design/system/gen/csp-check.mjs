// Proves generated/tokens.inline.css renders under the CSP shipped single-file HTML uses (REPORT_CSP), in headless
// Chrome: every one of the six embedded faces must be the font that actually draws its text (CSS.getPlatformFontsForNode),
// with no CSP violation. Also records the control (default-src 'none' alone) and the hash-based variant.
// Writes generated/csp-check.txt (ends in "RESULT: PASS" or "RESULT: FAIL"); test.mjs checks the result and that the
// recorded sha256 still matches tokens.inline.css.  Usage: node design/system/gen/csp-check.mjs   (needs Chrome)
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT, loadTokens } from './lib.mjs';
import { REPORT_CSP } from './gen-css.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const inline = readFileSync(join(ROOT, 'generated/tokens.inline.css'), 'utf8');
const sha = createHash('sha256').update(inline).digest('hex');
const t = loadTokens();
const FACES = [
  ['serif-400', 'Wasitme Serif', 'var(--font-serif)', 400, 'normal', 'WasitmeSerif-Regular'], ['serif-400i', 'Wasitme Serif', 'var(--font-serif)', 400, 'italic', 'WasitmeSerif-Italic'],
  ['serif-700', 'Wasitme Serif', 'var(--font-serif)', 700, 'normal', 'WasitmeSerif-Bold'], ['serif-700i', 'Wasitme Serif', 'var(--font-serif)', 700, 'italic', 'WasitmeSerif-BoldItalic'],
  ['mono-400', 'Wasitme Mono', 'var(--font-mono)', 400, 'normal', 'WasitmeMono-Regular'], ['mono-700', 'Wasitme Mono', 'var(--font-mono)', 700, 'normal', 'WasitmeMono-Bold'],
];
const style = inline + '\nbody { margin: 20px; background: var(--surface-sheet); color: var(--ink-primary); }\n' +
  FACES.map(([id, , fam, w, st]) => `#${id} { font-family: ${fam}; font-weight: ${w}; font-style: ${st}; font-size: 24px; }`).join('\n');
const styleHash = `'sha256-${createHash('sha256').update(style).digest('base64')}'`;
const pageFor = csp => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${style}</style></head><body>${FACES.map(([id]) => `<p id="${id}">${t.states.insufficient.headline} ×2.52 range</p>`).join('')}</body></html>`;
const VARIANTS = [
  ['shipped', REPORT_CSP, true],
  ['hash', `default-src 'none'; style-src ${styleHash}; font-src data:`, true],
  ['control: default-src none alone', "default-src 'none'", false],
];

const dir = mkdtempSync(join(tmpdir(), 'wasitme-csp-'));
VARIANTS.forEach((_, i) => writeFileSync(join(dir, `v${i}.html`), pageFor(VARIANTS[i][1])));
const prof = join(dir, 'profile');
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = [`# CSP check for generated/tokens.inline.css`, `sha256 ${sha}`, `shipped CSP: ${REPORT_CSP}`, ''];
let pass = true;
try {
  let port; for (let i = 0; i < 80 && !port; i++) { const f = join(prof, 'DevToolsActivePort'); if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n'); else await sleep(150); }
  if (!port) throw new Error('Chrome did not start');
  const ws = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(), events = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); } else events.push(m); };
  const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  for (const d of ['Page', 'DOM', 'CSS', 'Log', 'Runtime']) await S(`${d}.enable`);
  for (let i = 0; i < VARIANTS.length; i++) {
    const [name, csp, mustPass] = VARIANTS[i];
    events.length = 0;
    await S('Page.navigate', { url: `file://${join(dir, `v${i}.html`)}` });
    await S('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => 1)', awaitPromise: true });
    await sleep(300);
    const { root } = await S('DOM.getDocument', { depth: 0 });
    const got = [];
    for (const [fid, want, , , , ps] of FACES) {
      const { nodeId } = await S('DOM.querySelector', { nodeId: root.nodeId, selector: `#${fid}` });
      const fonts = (await S('CSS.getPlatformFontsForNode', { nodeId })).fonts || [];
      // the exact face file must draw the text (a missing bold face would otherwise pass as synthetic bold)
      const ok = fonts.length > 0 && fonts.every(f => f.isCustomFont && f.familyName === want && (!f.postScriptName || f.postScriptName === ps)) && fonts.some(f => f.postScriptName === ps);
      got.push([fid, ok, fonts.map(f => `${f.familyName}${f.postScriptName ? ' / ' + f.postScriptName : ''}${f.isCustomFont ? ' (embedded)' : ' (system)'}`).join(' + ')]);
    }
    const viol = events.filter(e => /Content Security Policy|Refused/i.test(JSON.stringify(e.params || {}))).length;
    const allOk = got.every(g => g[1]) && viol === 0;
    const verdict = mustPass ? (allOk ? 'ok' : 'FAIL') : (allOk ? 'FAIL (control unexpectedly renders)' : 'ok (blocked, as expected)');
    if (verdict.startsWith('FAIL')) pass = false;
    lines.push(`## ${name}: ${verdict}`, `CSP: ${csp.replace(/'sha256-[^']+'/, "'sha256-<style hash>'")}`, `CSP violations reported: ${viol}`);
    for (const [fid, ok, desc] of got) lines.push(`  ${ok ? 'ok  ' : 'no  '} ${fid}: ${desc || 'nothing drawn'}`);
    lines.push('');
  }
  ws.close();
} catch (e) { pass = false; lines.push(`error: ${String(e).slice(0, 200)}`); }
finally { chrome.kill(); await sleep(300); rmSync(dir, { recursive: true, force: true }); }
lines.push(`RESULT: ${pass ? 'PASS' : 'FAIL'}`);
writeFileSync(join(ROOT, 'generated/csp-check.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exitCode = pass ? 0 : 1;
