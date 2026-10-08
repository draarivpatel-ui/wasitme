// Renders screens/*.html to PNG with headless Chrome (light and dark) and checks, in the real render: the web fonts
// loaded, nothing overflows the frame, and every Wasitme-family text run is a type.scale size (serif >= 13, mono >= 12, unscaled).
// Usage: node design/system/gen/render.mjs [name-filter]
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './lib.mjs';
const run = promisify(execFile);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--virtual-time-budget=5000'];
const filter = process.argv[2] || '';
const pages = JSON.parse(readFileSync(join(ROOT, 'screens', 'manifest.json'), 'utf8')).filter(p => p.name.includes(filter));
const jobs = pages.flatMap(p => p.modes.map(m => ({ ...p, mode: m })));
const bad = [];
async function one(j) {
  const url = `file://${join(ROOT, 'screens', j.name + '.html')}#${j.mode}`;
  const out = join(ROOT, 'screens', `${j.name}-${j.mode}.png`);
  await run(CHROME, [...base, `--window-size=${j.w},${j.h}`, `--screenshot=${out}`, url]);
  const { stdout } = await run(CHROME, [...base, `--window-size=${j.w},${j.h}`, '--dump-dom', url], { maxBuffer: 64 << 20 });
  if (!/data-fonts="ok"/.test(stdout)) bad.push(`${j.name} ${j.mode}: web fonts did not load`);
  const fit = /data-fit="([^"]*)"/.exec(stdout);
  if (!fit || fit[1] !== 'ok') bad.push(`${j.name} ${j.mode}: content does not fit (${fit ? fit[1] : 'no fit check'})`);
  const ty = /data-type="([^"]*)"/.exec(stdout);
  if (!ty || ty[1] !== 'ok') bad.push(`${j.name} ${j.mode}: type off the scale (${ty ? ty[1] : 'no type check'})`);
}
const N = Number(process.env.WASITME_RENDER_JOBS || 1); let i = 0; // keep CPU low: one headless Chrome at a time
await Promise.all(Array.from({ length: N }, async () => { while (i < jobs.length) await one(jobs[i++]); }));
console.log(`rendered ${jobs.length} PNGs`);
if (bad.length) { console.error(bad.join('\n')); process.exitCode = 1; }
