// tokens.json -> generated/tokens.css (custom properties + the two web font families, relative font URLs: local
// mockups) and generated/tokens.inline.css (the same, with every font inlined as a base64 data: URL: what shipped
// single-file HTML such as the evidence report embeds; gen/csp-check.mjs proves it renders under the report CSP).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, colorLeaves, cssColorVar, kebab, sizeEntries, HEADER } from './lib.mjs';

/** The CSP shipped single-file HTML (the evidence report) uses. Measured: default-src 'none' alone blocks the inline
 *  <style> and the data: fonts (gen/csp-check.mjs). A 'sha256-...' hash of the style element may replace 'unsafe-inline'. */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:";

const FONT_FILES = [
  ['Wasitme Serif', 400, 'normal', 'WasitmeSerif-Regular'],
  ['Wasitme Serif', 400, 'italic', 'WasitmeSerif-Italic'],
  ['Wasitme Serif', 700, 'normal', 'WasitmeSerif-Bold'],
  ['Wasitme Serif', 700, 'italic', 'WasitmeSerif-BoldItalic'],
  ['Wasitme Mono', 400, 'normal', 'WasitmeMono-Regular'],
  ['Wasitme Mono', 700, 'normal', 'WasitmeMono-Bold'],
];

export function css(t, { embed = false } = {}) {
  const L = [];
  L.push(`/* ${HEADER} */`);
  L.push('/* Fonts: subsets of IBM Plex Serif / IBM Plex Mono (SIL OFL 1.1), renamed because "Plex" is a Reserved Font Name. See fonts/OFL.txt and fonts/MODIFICATIONS.txt. */');
  if (embed) L.push(`/* For shipped single-file HTML: every font is inlined, nothing is fetched. Use with the CSP ${REPORT_CSP} (checked by gen/csp-check.mjs -> generated/csp-check.txt). */`);
  else L.push(`/* Relative font URLs: local mockups only. Shipped single-file HTML uses generated/tokens.inline.css under the CSP ${REPORT_CSP}; default-src 'none' alone would block the inline style and the data: fonts. */`);
  for (const [fam, w, style, file] of FONT_FILES) {
    const src = embed ? `url(data:font/woff2;base64,${readFileSync(join(ROOT, 'fonts/web', file + '.woff2')).toString('base64')})` : `url("../fonts/web/${file}.woff2")`;
    L.push(`@font-face { font-family: "${fam}"; font-style: ${style}; font-weight: ${w}; font-display: block; src: ${src} format("woff2"); }`);
  }
  L.push('');

  const fam = t.type.families;
  const stack = f => [`"${f.web}"`, `"${f.app}"`, ...f.fallback.map(x => /\s/.test(x) ? `"${x}"` : x)].join(', ');
  const root = [];
  root.push(`  --font-serif: ${stack(fam.serif)};`);
  root.push(`  --font-mono: ${stack(fam.mono)};`);
  for (const [name, s] of Object.entries(t.type.scale)) {
    const k = kebab(name), family = s.family === 'serif' ? 'var(--font-serif)' : 'var(--font-mono)';
    root.push(`  --type-${k}: ${s.style === 'italic' ? 'italic ' : ''}${s.weight} ${s.size}px/${s.line}px ${family};`);
    root.push(`  --type-${k}-size: ${s.size}px;`);
    root.push(`  --type-${k}-line: ${s.line}px;`);
    root.push(`  --type-${k}-tracking: ${s.tracking}em;`);
  }
  for (const [k, v] of Object.entries(t.space)) root.push(`  --space-${k}: ${v}px;`);
  for (const [k, v] of Object.entries(t.radius)) root.push(`  --radius-${kebab(k)}: ${v}px;`);
  for (const [k, v] of Object.entries(t.stroke)) root.push(`  --stroke-${kebab(k)}: ${v}px;`);
  root.push(`  --motion-duration: ${t.motion.durationMs}ms;`);
  root.push(`  --motion-easing: ${t.motion.easing};`);
  for (const e of sizeEntries(t)) {
    if (e.value !== undefined) root.push(`  --size-${kebab(e.name)}: ${e.value}px;`);
    else root.push(`  --size-${kebab(e.name)}-width: ${e.w}px;`, `  --size-${kebab(e.name)}-height: ${e.h}px;`);
  }
  const st = t.chart.strip;
  for (const k of ['tickHeight', 'tickGap', 'denseTickHeight', 'denseTickGap', 'columnWidth', 'columnGap', 'compactColumnWidth', 'compactColumnGap'])
    root.push(`  --chart-${kebab(k)}: ${st[k]}px;`);
  root.push(`  --chart-rule: ${t.chart.timeline.rule}px;`);
  for (const [s, v] of Object.entries(t.color.light.state)) root.push(`  --state-${s}-edge-style: ${v.edgeStyle};`);
  // the app states' chip: existing colours by path, so it follows the theme like they do
  const leaves = new Set([...colorLeaves(t.color.light)].map(([p]) => p));
  for (const k of ['fg', 'bg', 'glyph', 'edge']) {
    const path = t.appStates.chip[k];
    if (!leaves.has(path)) throw new Error(`appStates.chip.${k} names ${path}, which is not a colour`);
    root.push(`  --app-state-${k}: var(${cssColorVar(path)});`);
  }
  root.push(`  --app-state-edge-style: ${t.appStates.chip.edgeStyle};`);
  // terminal mock backgrounds and the palettes the terminal mocks draw with (mode-independent)
  for (const [k, v] of Object.entries(t.terminal.backgrounds)) {
    if (k.startsWith('$')) continue;
    for (const p of ['bg', 'fg', 'muted']) root.push(`  --term-${kebab(k)}-${p}: ${v[p]};`);
  }
  for (const [k, pal] of Object.entries(t.terminal.palettes16)) {
    if (k.startsWith('$')) continue;
    pal.forEach((h, i) => root.push(`  --ansi-${kebab(k)}-${i}: ${h};`));
  }
  for (const [k, h] of Object.entries(t.terminal.sgr.ansi256.xterm256Hex)) root.push(`  --x256-${k}: ${h};`);
  for (const mode of ['dark', 'light']) for (const k of ['muted', 'rule']) root.push(`  --tc-${mode}-${k}: ${t.terminal.sgr.truecolor[mode][k]};`);
  // mode-pinned party colours: terminal and Code-tab mocks keep their own mode whatever the page theme is
  for (const mode of ['light', 'dark']) for (const party of ['you', 'agent']) for (const k of ['fill', 'ink'])
    root.push(`  --${mode}-${party}-${k}: ${t.color[mode].party[party][k]};`);
  root.push(`  --font-terminal: ${t.type.families.terminal.mock};`);
  root.push(`  --font-host: ${t.type.families.host.mock};`);

  const colors = mode => [...colorLeaves(t.color[mode])].map(([p, h]) => `  ${cssColorVar(p)}: ${h};`);
  L.push(':root {');
  L.push('  color-scheme: light dark;');
  L.push(...root);
  L.push('}');
  L.push('');
  L.push(':root, :root[data-theme="light"] {');
  L.push(...colors('light'));
  L.push('}');
  L.push('');
  L.push('@media (prefers-color-scheme: dark) {');
  L.push('  :root:not([data-theme="light"]) {');
  L.push(...colors('dark').map(l => '  ' + l));
  L.push('  }');
  L.push('}');
  L.push('');
  L.push(':root[data-theme="dark"] {');
  L.push(...colors('dark'));
  L.push('}');
  L.push('');
  L.push('@media (prefers-reduced-motion: reduce) { :root { --motion-duration: 0ms; } }');
  return L.join('\n') + '\n';
}
