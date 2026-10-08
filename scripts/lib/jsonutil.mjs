// JSON helpers for the wasitme installer. node: built-ins only, no network, nothing is executed.
// Used for everything the shell must not parse itself: package.json, the plugin marketplace manifest and
// the user's Claude Code settings.json.
//
//   package <package.json>                      -> name= version= bin= deps=   (validated)
//   marketplace <marketplace.json>              -> name= then plugin=/source= per plugin (validated)
//   statusline-state <settings.json> <command>  -> absent-file | none | ours | present | invalid
//   statusline-add <settings.json> <command> <backup-path>
//        exit 0 added (prints backup=<path|-> and sha=<hex>), 10 a statusLine already exists, 12 invalid JSON
//   statusline-replace <settings.json> <old-command> <new-command>
//        rewrites OUR statusLine command in place (only when the current command is exactly <old-command>);
//        exit 0 replaced (prints sha=<hex>), 10 the statusLine is not ours any more, 12 invalid JSON
//   statusline-restore <settings.json> <backup|-> <expected-sha> <command>
//        prints restored | removed | left | absent
//   sha256 <file>                               -> hex digest, or "-" if the file does not exist
//   hooks-list <hooks.json>                     -> one sorted line per mod module and per command hook (growth check)
//   validate-calls <file>                       -> the mod's calls from `claude plugin validate` output, one per line
//   codex-root <dir> <version>                  -> name= plugin= of a Codex marketplace root (validated, see below)
//   known-marketplace <known_marketplaces.json> <name> -> absent | present   (Claude Code's own registry, read only)
//   toml-remove <config.toml> <header>...       -> removes exactly those [header] tables; prints removed=<n>
//   rc-add <file> <line> <backup-path>          -> appends the marked PATH block; prints backup=<path|-> sha=<hex>
//   rc-remove <file> <backup|-> <sha> <line>    -> restored | removed | left | absent
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [cmd, ...args] = process.argv.slice(2);

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function sha256(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "-";
  }
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Names become CLI arguments (claude plugin install NAME@MARKET): never option-like, never exotic.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function cmdPackage([file]) {
  let pkg;
  try { pkg = readJsonFile(file); } catch (e) { fail(4, `${file}: cannot read as JSON (${e.code ?? e.message})`); }
  if (!isPlainObject(pkg)) fail(4, `${file}: not a JSON object`);
  const version = pkg.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) || version.includes("..")) {
    fail(4, `${file}: "version" must be a semantic version like 1.2.3 (got ${JSON.stringify(version)})`);
  }
  const bin = typeof pkg.bin === "string" ? pkg.bin : isPlainObject(pkg.bin) ? pkg.bin.wasitme : undefined;
  if (typeof bin !== "string" || !/^[A-Za-z0-9_./-]+$/.test(bin) || bin.startsWith("/") || bin.split("/").includes("..")) {
    fail(4, `${file}: "bin.wasitme" must be a relative path inside the package (got ${JSON.stringify(bin)})`);
  }
  const deps = isPlainObject(pkg.dependencies) ? Object.keys(pkg.dependencies).length : 0;
  process.stdout.write(`name=${typeof pkg.name === "string" ? pkg.name : "wasitme"}\nversion=${version}\nbin=${bin.replace(/^\.\//, "")}\ndeps=${deps}\n`);
}

function cmdMarketplace([file]) {
  let m;
  try { m = readJsonFile(file); } catch (e) { fail(4, `${file}: cannot read as JSON (${e.code ?? e.message})`); }
  if (!isPlainObject(m) || typeof m.name !== "string" || !SAFE_NAME.test(m.name)) {
    fail(4, `${file}: needs a "name" made of letters, digits, . _ -`);
  }
  if (!Array.isArray(m.plugins) || m.plugins.length === 0) fail(4, `${file}: "plugins" must list at least one plugin`);
  const lines = [`name=${m.name}`];
  for (const p of m.plugins) {
    if (!isPlainObject(p) || typeof p.name !== "string" || !SAFE_NAME.test(p.name)) {
      fail(4, `${file}: every plugin needs a "name" made of letters, digits, . _ -`);
    }
    lines.push(`plugin=${p.name}`);
    if (typeof p.source === "string") {
      if (!/^[A-Za-z0-9_./-]+$/.test(p.source) || p.source.split("/").includes("..")) {
        fail(4, `${file}: plugin "${p.name}" has an unsupported "source" (${JSON.stringify(p.source)})`);
      }
      lines.push(`source=${p.source}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---- settings.json ---------------------------------------------------------------------------------------
// Everything below follows symlinks (dotfile managers link settings.json) and writes atomically.
function realTarget(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

function atomicWrite(target, text, mode) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.wasitme-tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

function loadSettings(file) {
  const target = realTarget(file);
  if (!fs.existsSync(target)) return { state: "absent-file", target };
  const raw = fs.readFileSync(target, "utf8");
  let data;
  try { data = raw.trim() === "" ? {} : JSON.parse(raw); } catch { return { state: "invalid", target, raw }; }
  if (!isPlainObject(data)) return { state: "invalid", target, raw };
  return { state: "ok", target, raw, data };
}

const isOurs = (sl, command) => isPlainObject(sl) && sl.type === "command" && sl.command === command;

function detectIndent(raw) {
  const m = /^([ \t]+)"/m.exec(raw ?? "");
  return m ? m[1] : "  ";
}

function serialize(data, raw) {
  const trailingNewline = raw === undefined || raw === "" || raw.endsWith("\n");
  return JSON.stringify(data, null, detectIndent(raw)) + (trailingNewline ? "\n" : "");
}

function cmdStatuslineState([file, command]) {
  const s = loadSettings(file);
  if (s.state === "absent-file") return process.stdout.write("absent-file\n");
  if (s.state === "invalid") return process.stdout.write("invalid\n");
  const sl = s.data.statusLine;
  if (sl === undefined || sl === null) return process.stdout.write("none\n");
  return process.stdout.write(isOurs(sl, command) ? "ours\n" : "present\n");
}

function cmdStatuslineAdd([file, command, backup]) {
  const s = loadSettings(file);
  if (s.state === "invalid") fail(12, `${file} is not valid JSON; leaving it untouched`);
  const existing = s.state === "ok" ? s.data.statusLine : undefined;
  if (existing !== undefined && existing !== null) fail(10, "a statusLine is already configured");
  let backupPath = "-";
  if (s.state === "ok") {
    try { fs.copyFileSync(s.target, backup, fs.constants.COPYFILE_EXCL); } catch (e) { fail(1, `could not back up ${file}: ${e.code ?? e.message}`); }
    backupPath = backup;
  }
  const data = s.state === "ok" ? s.data : {};
  data.statusLine = { type: "command", command, padding: 0 };   // the same fragment `wasitme statusline install` writes
  let mode = 0o600;
  try { if (s.state === "ok") mode = fs.statSync(s.target).mode & 0o777; } catch { /* keep default */ }
  try {
    atomicWrite(s.target, serialize(data, s.raw), mode);
  } catch (e) {
    if (backupPath !== "-") { try { fs.unlinkSync(backupPath); } catch { /* best effort */ } }
    fail(1, `could not write ${file}: ${e.code ?? e.message}`);
  }
  process.stdout.write(`backup=${backupPath}\nsha=${sha256(s.target)}\n`);
}

function cmdStatuslineReplace([file, oldCommand, newCommand]) {
  const s = loadSettings(file);
  if (s.state === "invalid") fail(12, `${file} is not valid JSON; leaving it untouched`);
  if (s.state !== "ok" || !isOurs(s.data.statusLine, oldCommand)) fail(10, "the statusLine is not the one wasitme added");
  s.data.statusLine.command = newCommand;   // keeps any other keys the user added to the statusLine object
  let mode = 0o600;
  try { mode = fs.statSync(s.target).mode & 0o777; } catch { /* keep default */ }
  try {
    atomicWrite(s.target, serialize(s.data, s.raw), mode);
  } catch (e) {
    fail(1, `could not write ${file}: ${e.code ?? e.message}`);
  }
  process.stdout.write(`sha=${sha256(s.target)}\n`);
}

function cmdStatuslineRestore([file, backup, expectedSha, command]) {
  const s = loadSettings(file);
  if (s.state === "absent-file") return process.stdout.write("absent\n");
  // Untouched since we edited it: put the original bytes back exactly (or delete the file we created). A recorded "-"
  // means the installer could not promise that (the file had changed before a refresh), and sha256() itself answers "-"
  // for a file it cannot read, so "-" never counts as a match.
  if (expectedSha !== "-" && sha256(s.target) === expectedSha) {
    if (backup === "-") {
      fs.unlinkSync(s.target);
      return process.stdout.write("restored\n");
    }
    if (fs.existsSync(backup)) {
      const mode = fs.statSync(s.target).mode & 0o777;
      atomicWrite(s.target, fs.readFileSync(backup), mode);
      fs.unlinkSync(backup);
      return process.stdout.write("restored\n");
    }
  }
  // The user edited it afterwards: remove only our statusLine, keep everything else.
  if (s.state === "ok" && isOurs(s.data.statusLine, command)) {
    delete s.data.statusLine;
    const mode = fs.statSync(s.target).mode & 0o777;
    atomicWrite(s.target, serialize(s.data, s.raw), mode);
    return process.stdout.write("removed\n");
  }
  return process.stdout.write("left\n");
}

// ---- plugin growth check (README "Update and uninstall") -------------------------------------------------------------
// Every mod module and every command hook as one line, sorted, so the shell can compare an installed plugin with a new
// one by set difference. A line that is new in the update is growth.
function cmdHooksList([file]) {
  let h;
  try { h = readJsonFile(file); } catch (e) { fail(4, `${file}: cannot read as JSON (${e.code ?? e.message})`); }
  if (!isPlainObject(h)) fail(4, `${file}: not a JSON object`);
  const oneLine = (v) => String(v).replace(/[\t\r\n]+/g, " ");
  const lines = [];
  for (const m of Array.isArray(h.modules) ? h.modules : []) lines.push(`module\t${oneLine(m)}`);
  for (const [event, groups] of Object.entries(isPlainObject(h.hooks) ? h.hooks : {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!isPlainObject(g)) continue;
      for (const hk of Array.isArray(g.hooks) ? g.hooks : []) {
        if (!isPlainObject(hk)) continue;
        lines.push(`hook\t${oneLine(event)}\t${oneLine(g.matcher ?? "*")}\t${oneLine(hk.type ?? "")}\t${oneLine(hk.command ?? hk.url ?? "")}`);
      }
    }
  }
  process.stdout.write([...new Set(lines)].sort().map((l) => `${l}\n`).join(""));
}

// `claude plugin validate` prints e.g. "./register.tsx calls: $.clock.now (via load), $.fs.read". The " (via <helper>)"
// annotation is stripped (S-INST 3.5); several modules' lines are merged.
function cmdValidateCalls([file]) {
  const text = fs.readFileSync(file, "utf8");
  const calls = new Set();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("calls:");
    if (i < 0) continue;
    for (const item of line.slice(i + "calls:".length).split(",")) {
      const c = item.replace(/\(.*?\)/g, "").trim();
      if (c) calls.add(c);
    }
  }
  process.stdout.write([...calls].sort().map((c) => `${c}\n`).join(""));
}

// ---- Codex marketplace root (D32, D49) -----------------------------------------------------------------------------
// The root must hold .agents/plugins/marketplace.json with one plugin whose source is the root itself, and the plugin
// manifest(s): .codex-plugin/plugin.json and/or a root plugin.json. Both are generated from one source; Codex installs
// the ROOT file's version when they differ (S-CX 2.4), so they must be equal, and equal to the engine's version because
// the root moves together with the engine through `current`. Codex gets skills only: a hooks file is refused.
function cmdCodexRoot([dir, version]) {
  const mf = path.join(dir, ".agents", "plugins", "marketplace.json");
  let m;
  try { m = readJsonFile(mf); } catch (e) { fail(4, `plugin-codex/.agents/plugins/marketplace.json: cannot read as JSON (${e.code ?? e.message})`); }
  if (!isPlainObject(m) || typeof m.name !== "string" || !SAFE_NAME.test(m.name)) fail(4, "plugin-codex marketplace needs a plain \"name\"");
  if (!Array.isArray(m.plugins) || m.plugins.length !== 1 || !isPlainObject(m.plugins[0])) fail(4, "plugin-codex marketplace must list exactly one plugin");
  const p = m.plugins[0];
  if (typeof p.name !== "string" || !SAFE_NAME.test(p.name)) fail(4, "plugin-codex marketplace: the plugin needs a plain \"name\"");
  const src = typeof p.source === "string" ? p.source : isPlainObject(p.source) ? p.source.path : undefined;
  if (src !== undefined && src !== "./" && src !== ".") fail(4, `plugin-codex marketplace: the plugin's source must be the root ("./"), got ${JSON.stringify(src)}`);
  const versions = [];
  for (const rel of [path.join(".codex-plugin", "plugin.json"), "plugin.json"]) {
    const f = path.join(dir, rel);
    if (!fs.existsSync(f)) continue;
    let pj;
    try { pj = readJsonFile(f); } catch (e) { fail(4, `plugin-codex/${rel}: cannot read as JSON (${e.code ?? e.message})`); }
    if (!isPlainObject(pj)) fail(4, `plugin-codex/${rel}: not a JSON object`);
    if (pj.name !== p.name) fail(4, `plugin-codex/${rel}: "name" must be ${JSON.stringify(p.name)}`);
    versions.push([rel, pj.version]);
  }
  if (versions.length === 0) fail(4, "plugin-codex has no plugin.json (neither .codex-plugin/plugin.json nor plugin.json)");
  for (const [rel, v] of versions) {
    if (v !== version) fail(4, `plugin-codex/${rel} says version ${JSON.stringify(v)}, but this release is ${version}; both plugin.json files are generated from one source and must match`);
  }
  for (const rel of ["hooks", "hooks.json", path.join(".codex-plugin", "hooks.json")]) {
    if (fs.existsSync(path.join(dir, rel))) fail(4, `plugin-codex/${rel} exists; the Codex plugin is skills only (D32)`);
  }
  process.stdout.write(`name=${m.name}\nplugin=${p.name}\n`);
}

// Claude Code's own list of registered marketplaces, read only, to spot a `wasitme` marketplace the person added some
// other way (e.g. the GitHub "plugin only" install) before setup registers ~/.wasitme/current under the same name.
// The file is an object keyed by marketplace name (observed on 2.1.289: spikes-tracked/claude-plugin/evidence/s-inst-ro.txt).
function cmdKnownMarketplace([file, name]) {
  let k;
  try { k = readJsonFile(file); } catch { return process.stdout.write("absent\n"); }
  const present = isPlainObject(k) && Object.prototype.hasOwnProperty.call(k, name);
  process.stdout.write(present ? "present\n" : "absent\n");
}

// ---- Codex config.toml fallback (PRIVACY.md "Backups the installer makes") -----------------------------------------
// Only when the `codex` command is gone: remove exactly the named tables (header line through the line before the next
// table header). Everything else keeps its bytes. Written atomically with the file's own mode.
function cmdTomlRemove([file, ...headers]) {
  const target = realTarget(file);
  if (!fs.existsSync(target)) return process.stdout.write("removed=0\n");
  const raw = fs.readFileSync(target, "utf8");
  const lines = raw.split(/(?<=\n)/);
  const want = new Set(headers.map((h) => `[${h}]`));
  const out = [];
  let skipping = false;
  let removed = 0;
  for (const line of lines) {
    const t = line.trim();
    if (/^\[\[?[^\]]+\]\]?(\s*#.*)?$/.test(t)) {
      const head = t.replace(/\s*#.*$/, "");
      skipping = want.has(head);
      if (skipping) { removed++; continue; }
    }
    if (!skipping) out.push(line);
  }
  if (removed > 0) {
    const mode = fs.statSync(target).mode & 0o777;
    atomicWrite(target, out.join(""), mode);
  }
  process.stdout.write(`removed=${removed}\n`);
}

// ---- PATH line in a shell profile (only after a [y/N] yes, backed up first; README "Install") ----------------------
const RC_MARK = "# Added by the wasitme installer (the wasitme uninstaller removes these two lines)";
function cmdRcAdd([file, line, backup]) {
  const target = realTarget(file);
  const exists = fs.existsSync(target);
  const raw = exists ? fs.readFileSync(target, "utf8") : "";
  let backupPath = "-";
  if (exists) {
    try { fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL); } catch (e) { fail(1, `could not back up ${file}: ${e.code ?? e.message}`); }
    backupPath = backup;
  }
  const sep = raw === "" || raw.endsWith("\n") ? "" : "\n";
  const mode = exists ? fs.statSync(target).mode & 0o777 : 0o644;
  try {
    atomicWrite(target, `${raw}${sep}${RC_MARK}\n${line}\n`, mode);
  } catch (e) {
    if (backupPath !== "-") { try { fs.unlinkSync(backupPath); } catch { /* best effort */ } }
    fail(1, `could not write ${file}: ${e.code ?? e.message}`);
  }
  process.stdout.write(`backup=${backupPath}\nsha=${sha256(target)}\n`);
}

function cmdRcRemove([file, backup, expectedSha, line]) {
  const target = realTarget(file);
  if (!fs.existsSync(target)) return process.stdout.write("absent\n");
  if (expectedSha !== "-" && sha256(target) === expectedSha) {   // untouched since we added the block: put the original bytes back exactly ("-" never matches, see above)
    if (backup === "-") { fs.unlinkSync(target); return process.stdout.write("restored\n"); }
    if (fs.existsSync(backup)) {
      const mode = fs.statSync(target).mode & 0o777;
      atomicWrite(target, fs.readFileSync(backup), mode);
      fs.unlinkSync(backup);
      return process.stdout.write("restored\n");
    }
  }
  const raw = fs.readFileSync(target, "utf8");
  const block = `${RC_MARK}\n${line}\n`;
  if (!raw.includes(block)) return process.stdout.write("left\n");
  const mode = fs.statSync(target).mode & 0o777;
  atomicWrite(target, raw.replace(block, ""), mode);
  return process.stdout.write("removed\n");
}

const COMMANDS = {
  package: cmdPackage,
  marketplace: cmdMarketplace,
  "statusline-state": cmdStatuslineState,
  "statusline-add": cmdStatuslineAdd,
  "statusline-replace": cmdStatuslineReplace,
  "statusline-restore": cmdStatuslineRestore,
  sha256: ([file]) => process.stdout.write(`${sha256(file)}\n`),
  "hooks-list": cmdHooksList,
  "validate-calls": cmdValidateCalls,
  "codex-root": cmdCodexRoot,
  "known-marketplace": cmdKnownMarketplace,
  "toml-remove": cmdTomlRemove,
  "rc-add": cmdRcAdd,
  "rc-remove": cmdRcRemove,
};
const handler = COMMANDS[cmd];
if (!handler) fail(2, `usage: jsonutil.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
const need = {
  package: 1, marketplace: 1, "statusline-state": 2, "statusline-add": 3, "statusline-replace": 3, "statusline-restore": 4, sha256: 1,
  "hooks-list": 1, "validate-calls": 1, "codex-root": 2, "known-marketplace": 2, "toml-remove": 2, "rc-add": 3, "rc-remove": 4,
}[cmd];
if (args.length < need) fail(2, `jsonutil.mjs ${cmd}: expected ${need} argument(s)`);
handler(args);
