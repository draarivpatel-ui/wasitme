// Builds the Control Center canvas: ui/src (TypeScript) → ui/dist/{app.html, app.js, app.css, fonts/}.
//   node ui/scripts/build.mjs          (run it through scripts/dev/heavy.sh, which runs heavy jobs one at a time)
// Steps: regenerate src/gen/design.ts from the design system → tsc (the repo's own TypeScript, found by Node's normal
// parent-directory lookup) into ui/build/ → bundle the ES modules into ONE classic script (S-WEB verified classic
// scripts under the CSP; static type=module was not tested) → app.css = tokens.css (font URLs rewritten) +
// components.css + ui/static/canvas.css → copy the six subset woff2 faces and their OFL licence files.
// Zero runtime dependencies. Fails loudly on anything the CSP or the canvas rules forbid.
import { execFileSync } from "node:child_process"; // wasitme:allow-child_process -- fixed argv: node + the repo's tsc, no input from logs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const UI = dirname(dirname(fileURLToPath(import.meta.url)));
const DS = join(UI, "..", "design", "system");
const BUILD = join(UI, "build"), DIST = join(UI, "dist");

// 1. design tokens → src/gen/design.ts
execFileSync(process.execPath, [join(UI, "scripts", "gen.mjs")], { stdio: "inherit" });

// 2. tsc
const tsc = createRequire(join(UI, "package.json")).resolve("typescript/bin/tsc");
rmSync(BUILD, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", join(UI, "tsconfig.json")], { stdio: "inherit" });

// 3. bundle: each module in its own function scope; imports become destructuring of the dependency's exports
function walk(dir) {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : []; });
}
const mods = new Map();
for (const file of walk(BUILD)) {
  const id = relative(BUILD, file).replace(/\\/g, "/").replace(/\.js$/, "");
  let code = readFileSync(file, "utf8");
  const deps = [];
  code = code.replace(/^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm, (_, names, spec) => {
    if (!spec.startsWith("./") && !spec.startsWith("../")) throw new Error(`${id}: only relative imports are allowed (${spec})`);
    const dep = join(dirname(id), spec).replace(/\\/g, "/").replace(/\.js$/, "");
    deps.push(dep);
    const list = names.split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ": "));
    return `const { ${list.join(", ")} } = ${modVar(dep)};`;
  });
  if (/^import\b/m.test(code)) throw new Error(`${id}: unsupported import form`);
  code = code.replace(/^export \{\};?[ \t]*$/gm, "");
  const exports = [];
  code = code.replace(/^export (async function|function|const|let|class) ([A-Za-z_$][\w$]*)/gm, (_, kw, name) => { exports.push(name); return `${kw} ${name}`; });
  if (/^export\b/m.test(code)) throw new Error(`${id}: unsupported export form (only "export" on declarations)`);
  mods.set(id, { id, code, deps, exports });
}
function modVar(id) { return "__" + id.replace(/[^A-Za-z0-9]/g, "_"); }
const order = [], seen = new Set();
function visit(id, stack = []) {
  if (seen.has(id)) return;
  if (stack.includes(id)) throw new Error(`import cycle: ${[...stack, id].join(" → ")}`);
  const m = mods.get(id);
  if (!m) throw new Error(`missing module ${id}`);
  for (const d of m.deps) visit(d, [...stack, id]);
  seen.add(id); order.push(m);
}
visit("main");
const js = [
  "/* wasitme Control Center canvas (WP-41). Built by ui/scripts/build.mjs from ui/src; do not edit. MIT. */",
  "(function () {",
  "\"use strict\";",
  ...order.map((m) => `// ---- ${m.id}\nconst ${modVar(m.id)} = (function () {\n${m.code.trim()}\nreturn { ${m.exports.join(", ")} };\n})();`),
  "})();",
  "",
].join("\n");

// 4. css
const tokensCss = readFileSync(join(DS, "generated", "tokens.css"), "utf8").replace(/url\("\.\.\/fonts\/web\/([A-Za-z0-9-]+\.woff2)"\)/g, 'url("fonts/$1")');
const css = [
  "/* wasitme Control Center canvas. Built by ui/scripts/build.mjs: design/system/generated/tokens.css + design/system/screens/components.css + ui/static/canvas.css. */",
  tokensCss, readFileSync(join(DS, "screens", "components.css"), "utf8"), readFileSync(join(UI, "static", "canvas.css"), "utf8"),
].join("\n");

// 5. guards: what the CSP and the canvas rules forbid
const html = readFileSync(join(UI, "static", "app.html"), "utf8");
const bad = [];
for (const [what, re] of [["innerHTML/outerHTML", /\b(inner|outer)HTML\b/], ["insertAdjacentHTML", /insertAdjacentHTML/], ["document.write", /document\.write/],
  ["eval", /\beval\s*\(/], ["new Function", /new Function\b/], ["requestAnimationFrame", /requestAnimationFrame/], ["string timer", /set(Timeout|Interval)\s*\(\s*["'`]/],
  ["fetch / XHR / WebSocket", /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon)/], ["style attribute", /setAttribute\(\s*["']style["']|\.style\s*=|cssText/]]) {
  if (re.test(js)) bad.push(`app.js: ${what}`);
}
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) bad.push("app.html: inline <script>");
if (/<style\b|\sstyle=|\son[a-z]+=/i.test(html)) bad.push("app.html: inline style or handler");
if (/https?:\/\//.test(css.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ""))) bad.push("app.css: a remote URL");
if (bad.length) { console.error("build refused:\n  " + bad.join("\n  ")); process.exit(1); }

// 6. write dist
rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "fonts"), { recursive: true });
writeFileSync(join(DIST, "app.js"), js);
writeFileSync(join(DIST, "app.css"), css);
writeFileSync(join(DIST, "app.html"), html);
const faces = readdirSync(join(DS, "fonts", "web")).filter((f) => f.endsWith(".woff2"));
for (const f of faces) cpSync(join(DS, "fonts", "web", f), join(DIST, "fonts", f));
for (const f of ["OFL.txt", "MODIFICATIONS.txt"]) cpSync(join(DS, "fonts", f), join(DIST, "fonts", f));
for (const f of faces) if (!css.includes(`url("fonts/${f}")`)) { console.error(`build: app.css does not reference fonts/${f}`); process.exit(1); }
execFileSync(process.execPath, ["--check", join(DIST, "app.js")]);
const kb = (p) => `${Math.round(statSync(p).size / 1024)} KB`;
console.log(`ui/dist: app.html, app.js (${kb(join(DIST, "app.js"))}, ${order.length} modules), app.css (${kb(join(DIST, "app.css"))}), fonts/ (${faces.length} faces + OFL)`);
if (!existsSync(join(DIST, "app.html"))) process.exit(1);
