// Accessibility audit of the built canvas (ui/dist) in headless Chrome: what the browser actually EXPOSES, which the
// DOM-level checks in render.mjs and the VNode tests in model.test.mjs can't see. Every page of the demo golden, the
// two-agent golden (both agents), the agent-side, insufficient, stale and empty goldens, and the crowded test fixtures
// (a busy setup's grouped chart lanes), light and dark:
//   - the accessibility tree (DevTools Accessibility.getFullAXTree): every focusable node has a role and a name; every
//     image has a name and every chart image its full text description; headings start at 1 and skip no level; no
//     name on a generic (role-less) element, which assistive tech ignores
//   - contrast of every visible text run as rendered (computed colour on the first opaque background behind it):
//     4.5:1, or 3:1 for large text (WCAG 1.4.3); disabled controls are exempt
//   - the focus ring is drawn and not clipped by a scrolling or clipping ancestor (WCAG 2.4.7), checked on the pixels
//   - focus survives a page switch (the whole #app subtree is replaced on every paint)
//   - no transition or animation anywhere, with or without prefers-reduced-motion (D48: no animation)
//
//   WASITME_RENDER_JOBS=1 scripts/dev/heavy.sh node ui/test/a11y.mjs [--verbose]
// Output: ui/dist/shots/a11y.json. Exit 1 on a failure. ONE Chrome process, pages one after another (CPU guard).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cases, crowdedChanges, PAGE_IDS, ROOT, UI } from "./fixtures.mjs";
import { launch, mappedCsp, realCsp } from "./cdp.mjs";
import { decodePng } from "./png.mjs";

const verbose = process.argv.includes("--verbose");
const DIST = join(UI, "dist"), OUT = join(DIST, "shots");
if (!existsSync(join(DIST, "app.js"))) { console.error("ui/dist is not built: run node ui/scripts/build.mjs"); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const FILES = ["glance/demo.json", "snapshot/you-and-codex.json", "snapshot/agent-by_elimination.json", "snapshot/insufficient-timeline.json", "glance/stale.json", "glance/empty.json"];

// In the page: every visible text run's contrast against the first opaque background behind it.
const CONTRAST = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const c = rgb(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let b = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) b = over(stack[i], b);
    return b;
  };
  const out = [];
  let min = Infinity;
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (el.closest('[aria-hidden="true"], [hidden], .sr, button:disabled')) continue;
    let r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden') continue;
    const svgText = el instanceof SVGElement;
    // elementsFromPoint only sees the viewport: bring chart text below the fold into view first (a disclosure's chart),
    // or the shape under it is missed and the text is judged against the page instead of its badge
    if (svgText && (r.top < 0 || r.bottom > window.innerHeight)) { el.scrollIntoView({ block: 'center' }); r = el.getBoundingClientRect(); }
    const fg0 = rgb(svgText ? cs.fill : cs.color); if (!fg0) continue;
    // SVG text sits on the topmost filled shape under its centre (a marker), else on the chart's own background
    let bg = bgOf(svgText ? el.closest('svg') : el);
    if (svgText) {
      const under = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        .find((s) => s !== el && s instanceof SVGGeometryElement && !(s instanceof SVGTextElement) && (rgb(getComputedStyle(s).fill) || { a: 0 }).a > 0);
      if (under) bg = over(rgb(getComputedStyle(under).fill), bg);
    }
    const fg = over(fg0, bg);
    const a = L(fg), b = L(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const px = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    min = Math.min(min, ratio);
    if (ratio < need) out.push((el.getAttribute('class') || el.tagName) + ' ' + ratio.toFixed(2) + ':1 < ' + need + ' (' + (svgText ? cs.fill : cs.color) + ' on rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(', ') + ')): ' + el.textContent.trim().slice(0, 30));
  }
  return { min: Math.round(min * 100) / 100, fails: out };
})()`;

// In the page: every enabled, visible button; the 4 px focus ring (2 px outline + 2 px offset) must fit inside every
// ancestor that clips (overflow other than visible), measured while the button has keyboard focus. Returns the rings
// that would be cut.
const RING = `(() => {
  const out = [];
  for (const b of document.querySelectorAll('button:not([disabled])')) {
    if (!b.getClientRects().length) continue;
    b.focus({ focusVisible: true });
    // measured after focusing: focus scrolls a control below the fold into view, and that is where its ring is drawn
    const r = b.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (!b.matches(':focus-visible')) { out.push((b.getAttribute('data-act') || b.textContent.trim()) + ' does not match :focus-visible'); continue; }
    const cs = getComputedStyle(b);
    const reach = (parseFloat(cs.outlineOffset) || 0) + (parseFloat(cs.outlineWidth) || 0);   // how far the ring's outer edge lies outside the box (negative: inside)
    for (let a = b.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const ac = getComputedStyle(a);
      if (ac.overflowX === 'visible' && ac.overflowY === 'visible') continue;
      const p = a.getBoundingClientRect();
      const cut = r.left - reach < p.left + parseFloat(ac.borderLeftWidth) - 0.5 || r.right + reach > p.right - parseFloat(ac.borderRightWidth) + 0.5
        || r.top - reach < p.top + parseFloat(ac.borderTopWidth) - 0.5 || r.bottom + reach > p.bottom - parseFloat(ac.borderBottomWidth) + 0.5;
      if (cut && !(a.classList.contains('content') && (r.top - reach < p.top || r.bottom + reach > p.bottom))) { out.push((b.getAttribute('data-act') || b.textContent.trim()) + ' cut by .' + (a.getAttribute('class') || a.tagName).split(' ')[0]); break; }
    }
  }
  if (document.activeElement) document.activeElement.blur();
  return out;
})()`;

const MOTION = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || cs.animationName !== 'none' || cs.scrollBehavior === 'smooth') out.push(el.getAttribute('class') || el.tagName);
  }
  return out.slice(0, 5);
})()`;

const csp = realCsp(ROOT);
const browser = await launch({ dist: DIST, csp: mappedCsp(csp) });
await browser.S("Accessibility.enable");
const byFile = new Map(cases().map((c) => [c.file, c]));
const results = [];
let failures = 0;

/** Settings as the app sends it once wired (docs/design/UX-V2.md §10.2), so its buttons and switches are live. */
const WIRED_VIEW = {
  chrome: "content", launchAtLogin: "off",
  settings: { version: "0.1.0", integrations: [{ id: "app", state: "on" }, { id: "claude-plugin", state: "on" }, { id: "statusline", state: "own" },
    { id: "codex-plugin", state: "off" }, { id: "scan", state: "on" }], desktopPanel: true, launchAtLogin: null, update: { available: false, why: "no_release" }, busy: null },
};

async function render(c, page, agent, theme, motion = "no-preference", extra = {}) {
  // the page keeps focus on the same control across renders (main.ts paint(true)); start unfocused, so the new render
  // replaces the old focus starting point and a Tab walk begins at the top of the page
  await browser.eval("document.activeElement && document.activeElement.blur(), true");
  await browser.size(extra.chrome === "content" ? 1060 : 1280, 800);
  await browser.S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: motion }] });
  const view = { now: c.now, page, timeZone: "UTC", chrome: "full", ...(agent ? { agent: c.doc?.agents?.[agent]?.agent } : {}), ...extra };
  const r = await browser.eval(`window.wasitme.render(${JSON.stringify(JSON.stringify(c.doc))}, ${JSON.stringify(JSON.stringify(view))})`);
  await browser.eval("document.fonts.ready.then(() => true)");
  return r;
}

/** The AX tree in document order (from the root through childIds), ignored nodes dropped. */
async function axTree() {
  const { nodes } = await browser.S("Accessibility.getFullAXTree");
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const out = [];
  const visit = (n) => { if (!n) return; if (!n.ignored) out.push(n); for (const id of n.childIds ?? []) visit(byId.get(id)); };
  visit(root);
  return out;
}
const prop = (n, k) => n.properties?.find((p) => p.name === k)?.value?.value;

function checkAx(nodes) {
  let lastLevel = 0, first = true;
  for (const n of nodes) {
    const role = n.role?.value ?? "", name = (n.name?.value ?? "").trim();
    if (prop(n, "focusable") && !prop(n, "disabled")) {
      if (!role || role === "generic" || role === "none") P(`focusable node without a role: ${name || n.nodeId}`);
      if (!name) P(`focusable ${role} has no name`);
    }
    if (role === "image" && !name) P("an image has no name");
    if ((role === "generic" || role === "none") && name && (n.name?.sources ?? []).some((s) => s.type === "attribute" && s.attribute === "aria-label" && s.value)) P(`a name on a generic element is ignored by assistive tech: "${name}"`);
    if (role === "heading") {
      const lv = Number(prop(n, "level"));
      if (first && lv !== 1) P(`first heading is h${lv}: "${name.slice(0, 30)}"`);
      if (lastLevel && lv > lastLevel + 1) P(`heading level skips ${lastLevel}→${lv} at "${name.slice(0, 30)}"`);
      lastLevel = lv; first = false;
    }
  }
  return P;
  function P(s) { problems.push(s); }
}
let problems = [];

/** The focus ring's pixels: focus the element by real Tab presses, then look for the focus colour just outside it. */
async function ringVisible(selector) {
  await browser.eval("document.activeElement && document.activeElement.blur(), true");
  const target = await browser.eval(`(() => { const all = [...document.querySelectorAll('button:not([disabled])')].filter((b) => b.getClientRects().length); return all.indexOf(document.querySelector(${JSON.stringify(selector)})); })()`);
  if (target < 0) return null;
  for (let i = 0; i <= target; i++) {
    await browser.S("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await browser.S("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  }
  const info = await browser.eval(`(() => { const a = document.activeElement, r = a.getBoundingClientRect(), cs = getComputedStyle(a);
    return { ok: a.matches(${JSON.stringify(selector)}) && a.matches(':focus-visible'), x: r.left, y: r.top, w: r.width, h: r.height, color: cs.outlineColor, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), offset: parseFloat(cs.outlineOffset) }; })()`);
  if (!info.ok || info.style === "none" || !(info.width > 0)) return { visible: false, why: `outline ${info.style} ${info.width}px` };
  const shot = await browser.S("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const img = decodePng(Buffer.from(shot.data, "base64"));
  const want = /rgba?\(([^)]+)\)/.exec(info.color)[1].split(/[ ,]+/).map(Number);
  // the ring's centre line on each of the four sides, sampled at the middle of that side
  const d = info.offset + info.width / 2;
  const cx = Math.round(info.x + info.w / 2), cy = Math.round(info.y + info.h / 2);
  const pts = { left: [Math.round(info.x - d), cy], right: [Math.round(info.x + info.w + d - 1), cy], top: [cx, Math.round(info.y - d)], bottom: [cx, Math.round(info.y + info.h + d - 1)] };
  const sides = {};
  for (const [k, [x, y]] of Object.entries(pts)) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) { sides[k] = false; continue; }
    const i = (y * img.width + x) * 4, px = [img.data[i], img.data[i + 1], img.data[i + 2]];
    sides[k] = px.every((v, j) => Math.abs(v - want[j]) <= 24);
  }
  return { visible: Object.values(sides).filter(Boolean).length >= 3, sides };
}

/** Everything the audit checks on the page as it stands; returns the problems' count of AX nodes and charts. */
async function audit() {
  const nodes = await axTree();
  checkAx(nodes);
  const charts = nodes.filter((n) => n.role?.value === "image" && /per day|changes on each side/.test(n.name?.value ?? ""));
  for (const n of charts) if (!(n.description?.value ?? "").trim()) problems.push(`chart "${(n.name?.value ?? "").slice(0, 40)}" exposes no description`);
  const contrast = await browser.eval(CONTRAST);
  for (const f of contrast.fails.slice(0, 4)) problems.push(`contrast: ${f}`);
  const cut = await browser.eval(RING);
  for (const x of [...new Set(cut)].slice(0, 4)) problems.push(`focus ring clipped: ${x}`);
  const moving = await browser.eval(MOTION);
  if (moving.length) problems.push(`motion: ${moving.join(", ")}`);
  return { nodes: nodes.length, charts: charts.length, min: contrast.min };
}

await browser.open("app.html");
const CROWDED = [crowdedChanges("insufficient"), crowdedChanges("you")];
for (const theme of ["light", "dark"]) {
  for (const c of [...FILES.map((f) => byFile.get(f)), ...CROWDED]) {
    const agents = c.file === "snapshot/you-and-codex.json" ? [0, 1] : [0];
    for (const agent of agents) for (const page of PAGE_IDS) for (const extra of [{}, ...(page === "settings" ? [WIRED_VIEW] : [])]) {
      problems = [];
      const r = await render(c, page, agent, theme, "no-preference", extra);
      if (r !== "rendered") problems.push(`render() returned ${JSON.stringify(r)}`);
      const first = await audit();
      // UX-V2 §14.2: the same audit with every disclosure open (opened by clicking, then closed again for the next page)
      const opened = await browser.eval(`(() => { const keys = []; let b; while (keys.length < 20 && (b = document.querySelector('button.disc[aria-expanded="false"]'))) { keys.push(b.getAttribute('data-act')); b.click(); } return keys; })()`);
      let second = null;
      if (opened.length) {
        const before = problems.length;
        second = await audit();
        for (let i = before; i < problems.length; i++) problems[i] = `with every disclosure open: ${problems[i]}`;
        await browser.eval(`(() => { for (const k of ${JSON.stringify(opened)}) { const b = [...document.querySelectorAll('button.disc')].find((x) => x.getAttribute('data-act') === k); if (b) b.click(); } return true; })()`);
      }
      const name = `${c.name}--${page}${agent ? `-agent${agent}` : ""}${extra.settings ? "-wired" : ""}--${theme}`;
      const dedup = [...new Set(problems)];
      if (dedup.length) { failures++; console.log(`FAIL ${name}\n  ${dedup.join("\n  ")}`); }
      else if (verbose) console.log(`ok   ${name} (min contrast ${Math.min(first.min, second?.min ?? Infinity)}:1, ${first.charts} chart(s) described, ${opened.length} disclosure(s) opened)`);
      results.push({ name, problems: dedup, minContrast: Math.min(first.min, second?.min ?? Infinity), charts: first.charts, axNodes: first.nodes, opened: opened.length });
    }
  }
}

// focus ring pixels on each kind of control, light and dark (the sidebar and the switcher clip their content)
const ringCases = [["nav button", 'button.navbtn[aria-current="page"]'], ["nav button (not current)", "button.navbtn:not([aria-current])"], ["agent switcher", "button.seg.on"],
  ["disclosure", "button.disc"], ["plain button", "button.btn--plain"], ["settings button", ".sgroup button.btn:not([disabled])"], ["settings switch", "button.switch:not([disabled])"]];
const rings = [];
for (const theme of ["light", "dark"]) {
  const c = byFile.get("snapshot/you-and-codex.json");
  for (const [what, sel] of ringCases) {
    const settings = /^settings/.test(what);
    await render(c, what === "plain button" ? "timeline" : settings ? "settings" : "verdict", 0, theme, "no-preference", settings ? WIRED_VIEW : {});
    const v = await ringVisible(sel);
    if (v === null) { failures++; console.log(`FAIL no ${what} to check the focus ring on (${theme})`); continue; }
    rings.push({ what, theme, ...v });
    if (!v.visible) { failures++; console.log(`FAIL focus ring not visible on the ${what} (${theme}): ${JSON.stringify(v.sides ?? v.why)}`); }
    else if (verbose) console.log(`ok   focus ring on the ${what} (${theme}): ${JSON.stringify(v.sides)}`);
  }
}

// focus survives a page switch: the button that switched the page still has focus in the new tree
{
  const c = byFile.get("snapshot/you-and-codex.json");
  await render(c, "verdict", 0, "light");
  const kept = await browser.eval(`(() => { const b = document.querySelector('button[data-act="showPage:compare::"]'); b.focus(); b.click();
    return { page: document.documentElement.dataset.page, focused: document.activeElement && document.activeElement.getAttribute('data-act') }; })()`);
  if (kept.page !== "compare" || kept.focused !== "showPage:compare::") { failures++; console.log(`FAIL focus after a page switch: ${JSON.stringify(kept)}`); }
  else if (verbose) console.log("ok   focus stays on the nav button after a page switch");
}

// reduced motion: nothing moves either way (D48), and the bundle has no animation to switch off
{
  const c = byFile.get("glance/demo.json");
  for (const page of PAGE_IDS) {
    await render(c, page, 0, "light", "reduce");
    const moving = await browser.eval(MOTION);
    if (moving.length) { failures++; console.log(`FAIL motion under prefers-reduced-motion on ${page}: ${moving.join(", ")}`); }
  }
}

await browser.close();
writeFileSync(join(OUT, "a11y.json"), JSON.stringify({ pages: results.length, failures, rings, results }, null, 2));
const minAll = Math.min(...results.map((r) => r.minContrast));
console.log(`a11y: ${results.length} page renders, ${rings.length} focus rings, ${failures} failure(s); lowest text contrast ${minAll}:1 -> ui/dist/shots/a11y.json`);
process.exitCode = failures ? 1 : 0;
