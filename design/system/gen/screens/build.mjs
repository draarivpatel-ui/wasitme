// Writes every screen mockup to design/system/screens/*.html and screens/manifest.json.
// Usage: node design/system/gen/screens/build.mjs   (then gen/render.mjs makes the PNGs)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib.mjs';
import { T } from './kit.mjs';
import { findingPage, timelinePage, comparePage, setupPage } from './cc.mjs';
import { glyphSheet, iconSheet, SHEET_H } from './sheets.mjs';
import { termSheet, TERM_VARIANTS } from './term.mjs';
import { popover, desktopPanels } from './glance.mjs';
import { reportMarkdown, reportPage, readmeHero } from './share.mjs';

const pages = [];
const add = (name, html, w, h, modes = ['light', 'dark']) => { writeFileSync(join(ROOT, 'screens', name + '.html'), html); pages.push({ name, w, h, modes }); };

for (const k of ['insufficient', 'none', 'unclear', 'you', 'agent', 'codex']) add(`cc-${k === 'codex' ? 'codex-insufficient' : k}`, findingPage(k), 1280, 800);

add('cc-timeline', timelinePage(), 1280, 800);
add('cc-compare', comparePage(), 1280, 800);
add('cc-setup', setupPage(), 1280, 800);
writeFileSync(join(ROOT, 'screens', 'report-agent.md'), reportMarkdown());
add('report-agent', reportPage(), 1280, 1180);
add('readme-hero', readmeHero(), 1280, 640);
add('menubar-glyphs', glyphSheet(), 1280, SHEET_H);
add('appicon-sheet', iconSheet(), 1280, 820);
for (const k of ['insufficient', 'none', 'you', 'stale']) add(`popover-${k}`, popover(k), T.size.popover.width, T.size.popover.height);
add('desktop-panel', desktopPanels(), 1280, 620);
for (const v of TERM_VARIANTS) add(`text-${v}`, termSheet(v), 1280, v.startsWith('codetab') ? 1200 : 1100, ['light']);

writeFileSync(join(ROOT, 'screens', 'manifest.json'), JSON.stringify(pages, null, 1) + '\n');
console.log(`wrote ${pages.length} screens`);
