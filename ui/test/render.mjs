// Headless-Chrome pass over the built canvas (ui/dist): one screenshot per golden × lead variant × light/dark, every
// page of the snapshot goldens, the design-screen pairs (side by side with design/system/screens/*.png), the app's
// content-only width, and, in the real page: no CSP violation under the real header (scheme source mapped to the test
// origin, see cdp.mjs), no console error, both web fonts loaded, nothing overflowing, every text run on the type
// scale, no chart label overlapping a marker, another label or the lane label (real text metrics; plus a test-only
// dense-updates fixture at an agent's real update cadence, and a crowded one at a busy setup's rate of change), the
// accessibility checks (landmarks, heading order, chart
// summaries, names, focus order by real Tab presses).
//
//   WASITME_RENDER_JOBS=1 scripts/dev/heavy.sh node ui/test/render.mjs [--design] [--only text]
// Output: ui/dist/shots/*.png (gitignored), ui/dist/shots/compare/*.png, ui/dist/shots/report.json. Exit 1 on a failure.
// ONE Chrome process, pages rendered one after another (CPU guard).
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cases, crowdedChanges, denseUpdates, DESIGN_PAIRS, PAGE_IDS, ROOT, UI } from "./fixtures.mjs";
import { launch, mappedCsp, realCsp } from "./cdp.mjs";
import { decodePng, diffShare, encodePng, sideBySide } from "./png.mjs";

const args = process.argv.slice(2);
const onlyDesign = args.includes("--design");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";
const DIST = join(UI, "dist"), OUT = join(DIST, "shots");
if (!existsSync(join(DIST, "app.js"))) { console.error("ui/dist is not built: run node ui/scripts/build.mjs"); process.exit(2); }
if (!only && !onlyDesign) rmSync(OUT, { recursive: true, force: true });   // a filtered run keeps earlier shots
mkdirSync(join(OUT, "compare"), { recursive: true });

const SIZES = [12, 13, 14, 15, 17, 18, 19, 26, 30, 52, 84];
const CHECKS = `(() => {
  const r = { problems: [] };
  const P = (s) => r.problems.push(s);
  const de = document.documentElement;
  if (de.dataset.renderError) P('render error: ' + de.dataset.renderError);
  if (de.dataset.cspViolations) P('CSP violations: ' + de.dataset.cspViolations + ' (' + de.dataset.cspLast + ')');
  const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '').startsWith('Wasitme'));
  if (!faces.some((f) => f.status === 'loaded') || faces.some((f) => f.status === 'error')) P('web fonts: ' + faces.map((f) => f.family + ' ' + f.weight + ' ' + f.style + ' ' + f.status).join(', '));
  const W = window.innerWidth;
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && b.right > W + 0.5 && !el.closest('.content')) { P('overflow: ' + (el.getAttribute('class') || el.tagName) + ' right ' + Math.round(b.right)); break; }
  }
  const content = document.querySelector('.content');
  if (content && content.scrollWidth > content.clientWidth + 1) P('content scrolls sideways: ' + content.scrollWidth + ' > ' + content.clientWidth);
  const boxed = (e) => { const c = getComputedStyle(e); return ['Top', 'Right', 'Bottom', 'Left'].every((k) => parseFloat(c['border' + k + 'Width']) > 0); };
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    let a = el.parentElement; while (a && a !== document.body && !boxed(a)) a = a.parentElement;
    if (!a || a === document.body) continue;
    const t = el.getBoundingClientRect(), b = a.getBoundingClientRect();
    if (t.width > 0 && (t.right > b.right + 1 || t.bottom > b.bottom + 1 || t.left < b.left - 1 || t.top < b.top - 1)) { P('text escapes its box: ' + el.textContent.trim().slice(0, 30)); break; }
  }
  const sizes = ${JSON.stringify(SIZES)};
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (el.closest('svg') && el.closest('svg').getAttribute('aria-hidden') === 'true' && el.tagName.toLowerCase() !== 'text') continue;
    const cs = getComputedStyle(el), fam = cs.fontFamily.replace(/"/g, ''), px = parseFloat(cs.fontSize);
    if (!fam.startsWith('Wasitme')) continue;
    const serif = fam.startsWith('Wasitme Serif');
    if (!sizes.includes(px) || (serif && px < 13) || (!serif && px < 12)) { P('type off the scale: ' + (serif ? 'serif ' : 'mono ') + px + 'px: ' + el.textContent.trim().slice(0, 30)); break; }
  }
  for (const el of document.querySelectorAll('[style]')) { P('inline style attribute on ' + el.tagName); break; }
  // chart labels and markers vs markers, other labels and the lane labels, with the real text metrics (sibling text
  // can't trip the "escapes its box" check above); a crowded lane groups its markers, so no two may touch either
  for (const svg of document.querySelectorAll('svg.chart')) {
    const items = [...svg.querySelectorAll('text.c-label-2, text.c-side, rect.c-you, path.c-agent, path.c-agent-routine')]
      .map((e) => ({ text: e.tagName.toLowerCase() === 'text', b: e.getBoundingClientRect(), t: e.textContent || e.getAttribute('class') }));
    let hit = '';
    for (let i = 0; i < items.length && !hit; i++) for (let j = i + 1; j < items.length && !hit; j++) {
      const a = items[i], b = items[j];
      const ox = Math.min(a.b.right, b.b.right) - Math.max(a.b.left, b.b.left), oy = Math.min(a.b.bottom, b.b.bottom) - Math.max(a.b.top, b.b.top);
      if (ox > 0.5 && oy > 0.5) hit = '"' + a.t + '" and "' + b.t + '" by ' + ox.toFixed(1) + 'px';
    }
    if (hit) { P('chart labels overlap: ' + hit); break; }
  }
  // accessibility
  if (document.querySelectorAll('main').length !== 1) P('a11y: expected one <main>');
  if (document.querySelector('.sidebar') && !document.querySelector('nav[aria-label]')) P('a11y: no labelled <nav>');
  const hs = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => h.getClientRects().length);
  if (!hs.length || hs.filter((h) => h.tagName === 'H1').length !== 1) P('a11y: expected exactly one visible h1, got ' + hs.filter((h) => h.tagName === 'H1').length);
  let prev = 0; for (const h of hs) { const lv = Number(h.tagName[1]); if (prev && lv > prev + 1) { P('a11y: heading level skips ' + prev + '→' + lv + ' at "' + h.textContent.slice(0, 30) + '"'); break; } prev = lv; }
  if (hs[0] && hs[0].tagName !== 'H1' && !hs[0].closest('.sidebar')) P('a11y: first content heading is not the h1');
  for (const svg of document.querySelectorAll('svg')) {
    if (svg.closest('[aria-hidden="true"]')) continue;
    if (svg.getAttribute('role') !== 'img') { P('a11y: an svg is neither aria-hidden nor role=img'); break; }
    const label = svg.getAttribute('aria-label') || '';
    const d = svg.getAttribute('aria-describedby'), desc = d && document.getElementById(d);
    if (!label.trim() || !desc || !desc.textContent.trim()) { P('a11y: a chart has no text summary'); break; }
  }
  for (const b of document.querySelectorAll('button')) {
    const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
    if (!name) { P('a11y: a button has no name'); break; }
  }
  if (document.querySelector('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')) P('a11y: positive tabindex');
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id); if (new Set(ids).size !== ids.length) P('duplicate ids');
  // UX-V2 §3, §5: no window chrome drawn in the page; in the app's content chrome no sidebar either
  for (const k of ['lights', 'topbar', 'stamp']) if (document.querySelector('.' + k)) P('v2: the page draws .' + k);
  if (document.querySelector('.window--content') && document.querySelector('.sidebar')) P('v2: a sidebar in the content chrome');
  if (document.documentElement.dataset.demo === '1' && !document.querySelector('.page > .banner')) P('v2: demo data without the demo banner');
  // disclosures: a button with aria-expanded and aria-controls; the region is always there, hidden and empty when closed
  for (const b of document.querySelectorAll('button.disc')) {
    const ex = b.getAttribute('aria-expanded'), reg = document.getElementById(b.getAttribute('aria-controls') || '');
    if (ex !== 'true' && ex !== 'false') { P('disclosure without aria-expanded: ' + b.textContent.trim()); break; }
    if (!reg || reg.getAttribute('role') !== 'region' || reg.getAttribute('aria-labelledby') !== b.id) { P('disclosure without its region: ' + b.textContent.trim()); break; }
    if ((ex === 'false') !== reg.hidden || (ex === 'false' && reg.childElementCount)) { P('disclosure region out of step: ' + b.textContent.trim()); break; }
  }
  r.words = (document.querySelector('.page') ? document.querySelector('.page').innerText : '').split(/\\s+/).filter(Boolean).length;
  r.tabbables = [...document.querySelectorAll('button:not([disabled])')].filter((b) => b.getClientRects().length).map((b) => b.getAttribute('data-act') || b.textContent.trim());
  r.text = document.body.innerText.length;
  return r;
})()`;

const csp = realCsp(ROOT);
const browser = await launch({ dist: DIST, csp: mappedCsp(csp) });
const all = cases();
const byFile = new Map(all.map((c) => [c.file, c]));
const results = [];
let failures = 0;

/** Settings as the app sends it once wired (UX-V2 §10.2): what the installer's `--status --json` reports, plus the app's own. */
const WIRED_VIEW = {
  launchAtLogin: "viaInstaller",
  settings: { version: "0.1.0", integrations: [{ id: "app", state: "on" }, { id: "claude-plugin", state: "on" }, { id: "statusline", state: "own" },
    { id: "codex-plugin", state: "off" }, { id: "scan", state: "on" }], desktopPanel: false, launchAtLogin: null, update: { available: false, why: "no_release" }, busy: null },
};

async function shot(c, { page, agent = 0, theme, width = 1280, height = 800, chrome = "full", tag = "", tabs = false, extra = {} }) {
  // the page keeps focus on the same control across renders (main.ts paint(true)); start each shot unfocused, so the
  // new render replaces the old starting point and a Tab walk begins at the top of the page
  await browser.eval("document.activeElement && document.activeElement.blur(), true");
  await browser.size(width, height);
  await browser.scheme(theme);
  const view = { now: c.now, page, timeZone: "UTC", chrome, ...(agent ? { agent: c.doc?.agents?.[agent]?.agent } : {}), ...extra };
  const result = await browser.eval(`window.wasitme.render(${JSON.stringify(JSON.stringify(c.doc))}, ${JSON.stringify(JSON.stringify(view))})`);
  await browser.eval("document.fonts.ready.then(() => true)");
  const checks = await browser.eval(CHECKS);
  if (result !== "rendered") checks.problems.unshift(`render() returned ${JSON.stringify(result)}`);
  const png = await browser.shot();   // before the Tab walk, so no focus ring is left in the picture
  if (tabs) {
    // real Tab presses: focus must walk the buttons in DOM order
    await browser.eval("document.activeElement && document.activeElement.blur(), true");
    const seen = [];
    for (let i = 0; i < Math.min(checks.tabbables.length, 14); i++) {
      await browser.S("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await browser.S("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      seen.push(await browser.eval("document.activeElement ? (document.activeElement.getAttribute('data-act') || document.activeElement.textContent.trim()) : ''"));
    }
    const want = checks.tabbables.slice(0, seen.length);
    if (JSON.stringify(seen) !== JSON.stringify(want)) checks.problems.push(`focus order: ${JSON.stringify(seen.slice(0, 6))} vs DOM ${JSON.stringify(want.slice(0, 6))}`);
    checks.focusSteps = seen.length;
  }
  // UX-V2 §14.2: open every disclosure (as a reader would, by clicking each) and every check above still holds
  const opened = await browser.eval(`(() => { const keys = []; let b; while (keys.length < 20 && (b = document.querySelector('button.disc[aria-expanded="false"]'))) { keys.push(b.getAttribute('data-act')); b.click(); } return keys; })()`);
  if (opened.length) {
    await browser.eval("document.fonts.ready.then(() => true)");
    const again = await browser.eval(CHECKS);
    for (const p of again.problems) checks.problems.push(`with every disclosure open: ${p}`);
    if (await browser.eval("document.querySelectorAll('button.disc[aria-expanded=\"false\"]').length")) checks.problems.push("a disclosure did not open on click");
    // close them again (the page keeps a reader's toggles across renders), so the next shot starts from the defaults
    await browser.eval(`(() => { for (const k of ${JSON.stringify(opened)}) { const b = [...document.querySelectorAll('button.disc')].find((x) => x.getAttribute('data-act') === k); if (b) b.click(); } return true; })()`);
  }
  checks.opened = opened.length;
  const name = `${c.name}--${page}${agent ? `-agent${agent}` : ""}${tag}--${theme}.png`;
  writeFileSync(join(OUT, name), png);
  const errs = browser.log.splice(0).filter((l) => l.level === "error" || l.level === "blocked" || /Content Security Policy/i.test(l.text));
  for (const e of errs) checks.problems.push(`console ${e.level}: ${e.text.slice(0, 160)}`);
  if (checks.problems.length) failures++;
  results.push({ name, problems: checks.problems, focusSteps: checks.focusSteps ?? null, words: checks.words, opened: checks.opened });
  if (checks.problems.length) console.log(`FAIL ${name}\n  ${checks.problems.join("\n  ")}`);
  return { name, png, words: checks.words };
}

// UX-V2 §8 word budgets: visible words on each page (the .page innerText, chart labels included), default view, in the
// app's content chrome. Measured on the insufficient-timeline golden (the shape of `wasitme demo`: too early to tell,
// a daily strip, both sides' changes; the lifted glance goldens carry no strip); the agent-side Finding (Details open by
// default) on its golden. A budget the design cannot meet is raised in the spec with the measured count, never loosened
// here (§14).
// Three budgets were raised from §8's estimates to the counts measured on the first v2 render, as §14 says to, because
// nothing left on those pages could go without breaking a §12 hold: the Finding 130 → 135 (132 on `wasitme demo`), the
// agent-side Finding 270 → 280 (276 here), Compare 200 → 220 (219 here: Compare's ledger stays open with a row per
// signal, and this golden has more signals than the demo's 184).
const BUDGETS = { timeline: 100, verdict: 135, compare: 220, setup: 80, report: 386, sources: 60, settings: 180 };
const AGENT_FINDING_BUDGET = 280;
async function budgets(theme) {
  for (const [file, pages] of [["snapshot/insufficient-timeline.json", Object.keys(BUDGETS)], ["snapshot/agent-by_elimination.json", ["verdict"]]]) {
    const c = byFile.get(file);
    for (const page of pages) {
      const { name, words } = await shot(c, { page, theme, width: 1060, chrome: "content", tag: "-budget" });
      const max = file.includes("agent-by") ? AGENT_FINDING_BUDGET : BUDGETS[page];
      if (!(words <= max)) { failures++; console.log(`FAIL ${name}: ${words} visible words, budget ${max} (UX-V2 §8)`); }
      wordCounts.push({ name, words, budget: max });
    }
  }
}
const wordCounts = [];

await browser.open("app.html");
const served = browser.takeServed();
if (!["app.html", "app.css", "app.js"].every((f) => served.includes(f))) { console.error(`page files not served: ${served.join(", ")}`); failures++; }
const ready = await browser.eval("document.documentElement.dataset.wasitmeReady === '1' && typeof window.wasitme.render === 'function'");
if (!ready) { console.error("app.js did not set its ready marker"); failures++; }

const designShares = [];
for (const theme of ["light", "dark"]) {
  // 1. design pairs, side by side with the approved screen
  for (const p of DESIGN_PAIRS) {
    if (only && !p.screen.includes(only)) continue;
    const c = byFile.get(p.file);
    const { png } = await shot(c, { page: p.page, agent: p.agent, theme, tag: `-${p.screen}` });
    const ref = join(ROOT, "design/system/screens", `${p.screen}-${theme}.png`);
    if (existsSync(ref)) {
      const a = decodePng(readFileSync(ref)), b = decodePng(png);
      writeFileSync(join(OUT, "compare", `${p.screen}--${theme}.png`), encodePng(sideBySide(a, b)));
      designShares.push({ screen: p.screen, theme, differingPixels: diffShare(a, b) });
    }
  }
  if (onlyDesign) continue;
  // 2. every golden, both lead variants (the lead decides the landing page, D28), as the app would land
  for (const c of all) {
    if (only && !c.name.includes(only)) continue;
    for (const lead of ["timeline", "verdict"]) {
      const doc = c.doc && typeof c.doc === "object" && !Array.isArray(c.doc) ? { ...c.doc, lead } : c.doc;
      await shot({ ...c, doc }, { page: lead === "verdict" ? "verdict" : "timeline", theme, tag: `-lead_${lead}`, tabs: theme === "light" && lead === "verdict" });
    }
  }
  // 3. every page of every snapshot golden (and the Codex agent)
  for (const c of all.filter((x) => x.contract === "snapshot")) {
    if (only && !c.name.includes(only)) continue;
    for (const page of PAGE_IDS) {
      await shot(c, { page, theme });
      if (c.name === "snapshot-you-and-codex") await shot(c, { page, agent: 1, theme });
    }
  }
  // 3b. an agent at its real update cadence (test fixture): labels must give way, never overlap
  if (!only || "dense-updates".includes(only)) {
    const dense = denseUpdates();
    for (const page of ["timeline", "verdict", "setup", "compare"]) await shot(dense, { page, theme });
  }
  // 3c. a busy setup (test fixture: 44 changes of yours in 28 days, 20 of unknown origin, 30 agent updates; and the same
  //     around a change that lines up with the shift): each lane groups into ranges, nothing overlaps or runs off, at
  //     the app's width and at its minimum
  for (const base of ["insufficient", "you"]) {
    const crowded = crowdedChanges(base);
    if (only && !crowded.name.includes(only)) continue;
    for (const page of ["timeline", "verdict", "setup", "compare"]) await shot(crowded, { page, theme });
    for (const page of ["verdict", "timeline"]) {
      await shot(crowded, { page, theme, width: 1060, chrome: "content", tag: "-app1060" });
      await shot(crowded, { page, theme, width: 680, height: 600, chrome: "content", tag: "-app680" });
    }
  }
  // 4. the Mac app's canvas width (1280 − the 220-pt native sidebar), content only, every page; Settings also as native
  //    sends it once wired (view.settings, UX-V2 §10.2), and at the window's minimum width (900 − 220)
  for (const file of ["snapshot/insufficient-timeline.json", "snapshot/you-and-codex.json", "snapshot/agent-by_elimination.json"]) {
    const c = byFile.get(file);
    if (only && !c.name.includes(only)) continue;
    for (const page of PAGE_IDS) await shot(c, { page, theme, width: 1060, chrome: "content", tag: "-app1060" });
    await shot(c, { page: "settings", theme, width: 1060, chrome: "content", tag: "-app1060-wired", extra: WIRED_VIEW });
    for (const page of ["verdict", "timeline", "settings"]) await shot(c, { page, theme, width: 680, height: 600, chrome: "content", tag: "-app680" });
  }
  // 5. the word budgets (UX-V2 §8)
  if (!only || "demo".includes(only)) await budgets(theme);
}

// CSP negative control (so "no violations" above is not vacuous): under the same header, an inline script and an
// inline style attribute injected into the live page must be blocked and reported.
await browser.open("app.html");
browser.log.splice(0);
const control = await browser.eval(`new Promise((done) => {
  const s = document.createElement('script'); s.textContent = 'document.documentElement.dataset.inlineRan = "1"'; document.head.appendChild(s);
  const p = document.createElement('p'); p.setAttribute('style', 'color: rgb(255, 0, 0)'); p.textContent = 'x'; document.body.appendChild(p);
  setTimeout(() => done({ inlineRan: document.documentElement.dataset.inlineRan === '1', styled: getComputedStyle(p).color === 'rgb(255, 0, 0)',
    violations: Number(document.documentElement.dataset.cspViolations || 0) }), 300);
})`);
const controlOk = !control.inlineRan && !control.styled && control.violations >= 2;
console.log(`CSP negative control: inline script ${control.inlineRan ? "RAN" : "blocked"}, inline style ${control.styled ? "APPLIED" : "blocked"}, ${control.violations} violations reported`);
if (!controlOk) failures++;
await browser.close();
writeFileSync(join(OUT, only || onlyDesign ? "report-partial.json" : "report.json"), JSON.stringify({ csp: mappedCsp(csp), cspControl: control, shots: results.length, failures, designShares, wordCounts, results }, null, 2));
console.log(`render: ${results.length} screenshots, ${failures} with problems -> ui/dist/shots/`);
for (const w of wordCounts.filter((x) => x.name.endsWith("--light.png"))) console.log(`  ${w.name.replace(/--light\.png$/, "")}: ${w.words} visible words (budget ${w.budget})`);
for (const d of designShares) console.log(`  ${d.screen} ${d.theme}: ${d.differingPixels === null ? "size differs" : (d.differingPixels * 100).toFixed(1) + "% of pixels differ from the design screen"}`);
process.exitCode = failures ? 1 : 0;
