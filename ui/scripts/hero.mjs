// The README hero images: the Control Center canvas (ui/dist) rendering the snapshot that `wasitme demo --json` prints,
// light and dark, written to docs/images/hero-{light,dark}.png. D21: every README image comes from `wasitme demo`
// engine output, and the canvas marks it as demo data (the banner "Demo data from `wasitme demo`, not from your logs.").
//
//   scripts/dev/heavy.sh sh -c 'npx tsc -p engine && node ui/scripts/build.mjs && node ui/scripts/hero.mjs'
//
// The page is the Finding page of the default demo case in the full chrome (the canvas's own sidebar, no window
// buttons; docs/design/UX-V2.md §3): "Too early to tell", the most common real outcome, with both sides' changes on
// the daily strip's case line. 1280 x 800 is the canvas's design frame; at 1.5x the
// PNG is 1920 px wide, more than twice the width GitHub shows a README image at, and stays under about 400 KB.
// Options: --out DIR (default docs/images), --scale N (device pixel ratio, default 1.5), --page ID (default verdict).
// ONE headless Chrome (ui/test/cdp.mjs: throwaway profile, the real CSP, every non-test request refused). The demo
// runs with a temporary HOME and agent folders, so it cannot read or write anything of the person running this.
// Exit 1 when the page did not render cleanly (render error, web fonts missing, a console error, a CSP report).
import { execFileSync } from "node:child_process"; // wasitme:allow-child_process -- fixed argv: node + the repo's own CLI (`demo --json`), no input from logs
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { launch, mappedCsp, realCsp } from "../test/cdp.mjs";
import { ROOT, UI } from "../test/fixtures.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const OUT = resolve(ROOT, opt("--out", join("docs", "images")));
const SCALE = Number(opt("--scale", "1.5"));
const PAGE = opt("--page", "verdict");
const WIDTH = 1280, HEIGHT = 800;   // the canvas's design frame (design/system/screens/cc-*.html)

const DIST = join(UI, "dist"), CLI = join(ROOT, "engine", "dist", "src", "cli", "main.js");
if (!existsSync(join(DIST, "app.js"))) { console.error("ui/dist is not built: run node ui/scripts/build.mjs"); process.exit(2); }
if (!existsSync(CLI)) { console.error("the engine is not built: run npx tsc -p engine"); process.exit(2); }
if (!(SCALE >= 1 && SCALE <= 3)) { console.error("--scale must be between 1 and 3"); process.exit(2); }

// 1. the demo snapshot, from the engine's own CLI, with throwaway homes
const home = mkdtempSync(join(tmpdir(), "wasitme-hero-"));
let doc;
try {
  const env = { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
    WASITME_HOME: join(home, ".wasitme"), TZ: "UTC", NO_COLOR: "1" };
  doc = JSON.parse(execFileSync(process.execPath, [CLI, "demo", "--json"], { env, encoding: "utf8" }));
} finally {
  rmSync(home, { recursive: true, force: true });
}
if (doc.demo !== true || doc.schema !== "wasitme.snapshot/1") { console.error("`wasitme demo --json` did not print a demo snapshot"); process.exit(1); }
// The demo's own clock: ten minutes after its documents were generated (engine/src/cli/commands/demo.ts, DEMO_NOW).
// The view takes it as an ISO string (a number would fall back to the wall clock, and the page would say "Out of date").
const nowMs = Date.parse(doc.generatedAt) + 10 * 60 * 1000;
if (!Number.isFinite(nowMs)) { console.error("the demo snapshot has no generatedAt"); process.exit(1); }
const now = new Date(nowMs).toISOString();

// 2. render it, light and dark
const CHECKS = `(() => {
  const p = [], de = document.documentElement;
  if (de.dataset.renderError) p.push('render error: ' + de.dataset.renderError);
  if (de.dataset.cspViolations) p.push('CSP violations: ' + de.dataset.cspViolations);
  const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '').startsWith('Wasitme'));
  if (!faces.some((f) => f.status === 'loaded') || faces.some((f) => f.status === 'error')) p.push('web fonts did not load');
  if (!/demo data/i.test(document.body.innerText)) p.push('no demo-data marker on the page');
  if (/out of date/i.test(document.body.innerText)) p.push('the page says the demo is out of date (wrong clock)');
  const W = window.innerWidth;
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && b.right > W + 0.5 && !el.closest('.content')) { p.push('overflow: ' + (el.getAttribute('class') || el.tagName)); break; }
  }
  return p;
})()`;

mkdirSync(OUT, { recursive: true });
const browser = await launch({ dist: DIST, csp: mappedCsp(realCsp(ROOT)) });
let failed = 0;
try {
  await browser.open("app.html");
  for (const theme of ["light", "dark"]) {
    await browser.S("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    await browser.scheme(theme);
    const view = { now, page: PAGE, timeZone: "UTC", chrome: "full" };
    const result = await browser.eval(`window.wasitme.render(${JSON.stringify(JSON.stringify(doc))}, ${JSON.stringify(JSON.stringify(view))})`);
    await browser.eval("document.fonts.ready.then(() => true)");
    const problems = await browser.eval(CHECKS);
    if (result !== "rendered") problems.unshift(`render() returned ${JSON.stringify(result)}`);
    for (const e of browser.log.splice(0)) if (e.level === "error" || e.level === "blocked" || /Content Security Policy/i.test(e.text)) problems.push(`console ${e.level}: ${e.text.slice(0, 160)}`);
    const png = await browser.shot();
    const file = join(OUT, `hero-${theme}.png`);
    writeFileSync(file, png);
    console.log(`${problems.length ? "FAIL" : "ok  "} ${relative(ROOT, file)} (${WIDTH}x${HEIGHT} at ${SCALE}x, ${Math.round(png.length / 1024)} KB)`);
    for (const p of problems) console.log(`  ${p}`);
    if (problems.length) failed++;
  }
} finally {
  await browser.close();
}
if (failed) process.exitCode = 1;
