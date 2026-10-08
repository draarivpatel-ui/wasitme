// Stateful stand-ins for the `claude` and `codex` plugin commands the installer runs (SHIM_STATEFUL=1, via shim.sh).
// They model the behaviour the spikes OBSERVED on Claude Code 2.1.289 and Codex 0.160.0, so the installer tests can
// check the lifecycle rules by their effect, not only by the command log. Never a real CLI, never a login, no network.
//
// claude (docs/spikes/2026-10-04-claude-plugin.md):
//   - `plugin marketplace add <path>` stores the path UNRESOLVED (the `current` symlink keeps working after a flip);
//     the same name from another source re-points in place and keeps installed plugins and their options (S-GIT 4.3).
//   - `plugin uninstall` (even --keep-data) and `plugin marketplace remove` ERASE the plugin's saved options (S-INST 3.4).
//   - `plugin update` records the folder's version and keeps the options; `plugin configure --values-stdin` takes a
//     JSON object of strings and keeps keys it is not given.
//   - `plugin validate --strict <dir>` prints `calls:` from <dir>/.fake-calls when that file exists (test fixture only).
//   State, as s-inst-ro.txt shows it: $CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json (keyed by name, the path
//   unresolved) and installed_plugins.json; and in the person's settings.json: extraKnownMarketplaces (marketplace
//   add), enabledPlugins (install) and pluginConfigs[id].options (configure). Uninstall and marketplace remove delete
//   the entries but leave the three keys behind as {} (observed), so settings.json is NOT byte-identical afterwards.
// codex (docs/spikes/2026-10-04-codex-node.md, S-CX):
//   - `plugin marketplace add <path>` stores the RESOLVED path; the same name from a different source is refused.
//   - `plugin add` copies the root into plugins/cache/<mkt>/<plugin>/<version>/ and fails when the registered folder
//     is gone (a pruned version dir); `plugin list` fails then too.
//   - `plugin remove` always exits 0; `marketplace remove` alone leaves the [plugins."id"] table (the orphan of S-CX 2.6).
//   - config.toml gets exactly the tables of S-CX 2.2, and add then remove leaves it byte-identical.
import fs from "node:fs";
import path from "node:path";

const [tool, ...argv] = process.argv.slice(2);
const out = (s) => process.stdout.write(`${s}\n`);
const die = (s, code = 1) => { process.stderr.write(`${s}\n`); process.exit(code); };
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const args = argv.filter((a) => !a.startsWith("--"));
const flags = new Set(argv.filter((a) => a.startsWith("--")));

function writeJsonOrRemove(file, value) {
  if (Object.keys(value).length === 0) {
    fs.rmSync(file, { force: true });
    let d = path.dirname(file);
    while (d.length > 1 && !/[/](\.claude|\.codex)$/.test(d)) { try { fs.rmdirSync(d); } catch { break; } d = path.dirname(d); }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function claude() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) die("fake claude: CLAUDE_CONFIG_DIR is not set (the installer must pin it under --home)");
  const kmFile = path.join(dir, "plugins", "known_marketplaces.json");
  const ipFile = path.join(dir, "plugins", "installed_plugins.json");
  const km = readJson(kmFile, {});
  const ip = readJson(ipFile, {});
  const setFile = path.join(dir, "settings.json");
  const st = readJson(setFile, {});
  const section = (k) => (st[k] && typeof st[k] === "object" ? st[k] : (st[k] = {}));
  let stTouched = false;
  const save = () => {
    writeJsonOrRemove(kmFile, km);
    writeJsonOrRemove(ipFile, ip);
    if (stTouched) fs.writeFileSync(setFile, `${JSON.stringify(st, null, 2)}\n`);
  };
  const forget = (id) => { delete ip[id]; delete section("enabledPlugins")[id]; delete section("pluginConfigs")[id]; stTouched = true; };
  const pluginFolder = (id) => {
    const [name, mkt] = id.split("@");
    const m = km[mkt];
    if (!m) return null;
    const mf = readJson(path.join(m.path, ".claude-plugin", "marketplace.json"), null);
    const p = mf?.plugins?.find((x) => x.name === name);
    return p ? path.join(m.path, p.source) : null;
  };
  const folderVersion = (id) => readJson(path.join(pluginFolder(id) ?? "/nonexistent", ".claude-plugin", "plugin.json"), {}).version;
  const [a0, a1, a2] = args;
  if (a0 !== "plugin") die(`fake claude: unsupported: ${argv.join(" ")}`, 2);
  if (a1 === "marketplace" && a2 === "add") {
    const p = args[3];
    const mf = readJson(path.join(p, ".claude-plugin", "marketplace.json"), null);
    if (!mf) die(`fake claude: no .claude-plugin/marketplace.json at ${p}`);
    const was = km[mf.name];
    km[mf.name] = { source: { source: "directory", path: p }, path: p };   // unresolved, as observed
    section("extraKnownMarketplaces")[mf.name] = { source: { source: "directory", path: p } };
    stTouched = true;
    save();
    return out(was && was.path !== p ? `Marketplace '${mf.name}' was already added from ${was.path} and now points at dir:${p}.` : `Successfully added marketplace: ${mf.name}`);
  }
  if (a1 === "marketplace" && a2 === "remove") {
    const name = args[3];
    if (!km[name]) die(`fake claude: marketplace '${name}' not found`);
    delete km[name];
    delete section("extraKnownMarketplaces")[name];
    stTouched = true;
    for (const id of Object.keys(ip)) if (id.endsWith(`@${name}`)) forget(id);   // also uninstalls, erasing options
    save();
    return out(`Removed marketplace ${name}. The removal also deletes their saved options, secrets and data where it can.`);
  }
  if (a1 === "install") {
    const id = args[2];
    if (!pluginFolder(id)) die(`fake claude: plugin ${id} not found in any marketplace`);
    if (ip[id]) die(`fake claude: ${id} is already installed`);
    ip[id] = { version: folderVersion(id) };
    section("enabledPlugins")[id] = true;
    stTouched = true;
    save();
    return out(`Successfully installed plugin ${id} (scope: user)\n2 userConfig options not yet set`);
  }
  if (a1 === "update") {
    const id = args[2];
    if (!ip[id]) die(`fake claude: ${id} is not installed`);
    const v = folderVersion(id);
    if (v === ip[id].version) return out(`${id} is read from its folder; nothing to update`);
    const from = ip[id].version;
    ip[id].version = v;
    save();
    return out(`Plugin ${id} updated from ${from} to ${v}. Restart to apply changes.`);
  }
  if (a1 === "uninstall") {
    const id = args[2];
    if (!ip[id]) die(`fake claude: ${id} is not installed`);
    forget(id);   // --keep-data keeps plugins/data only; the options go either way
    save();
    return out(`Uninstalled ${id}`);
  }
  if (a1 === "configure") {
    const id = args[2];
    if (!ip[id]) die(`fake claude: ${id} is not installed`);
    if (!flags.has("--values-stdin")) die("fake claude: only --values-stdin is modelled", 2);
    let v;
    try { v = JSON.parse(fs.readFileSync(0, "utf8")); } catch { die("fake claude: stdin is not JSON"); }
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.values(v).some((x) => typeof x !== "string")) die("fake claude: values must be a JSON object of strings");
    const pc = section("pluginConfigs");
    pc[id] = { options: { ...(pc[id]?.options ?? {}), ...v } };
    stTouched = true;
    save();
    return out(`Saved ${Object.keys(v).length} option(s) for ${id}`);
  }
  if (a1 === "validate") {
    const d = args[2];
    const f = path.join(d, ".fake-calls");
    out(`Validating ${d}`);
    if (fs.existsSync(f)) out(`./register.tsx calls: ${fs.readFileSync(f, "utf8").trim()}`);
    return out("Validation passed");
  }
  die(`fake claude: unsupported: ${argv.join(" ")}`, 2);
}

function codex() {
  const dir = process.env.CODEX_HOME;
  if (!dir) die("fake codex: CODEX_HOME is not set (the installer must pin it under --home)");
  const cfg = path.join(dir, "config.toml");
  const read = () => (fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : null);
  // A config.toml that only ever held wasitme's tables is deleted again when they go, so "nothing changed" can be
  // checked byte for byte; a seeded one keeps its own bytes exactly.
  const persist = (text) => {
    if (text === "") { fs.rmSync(cfg, { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cfg, text, { mode: 0o600 });
  };
  const mktBlock = (name, src) => `\n[marketplaces.${name}]\nsource_type = "local"\nsource = "${src}"\n`;
  const plugBlock = (id) => `\n[plugins."${id}"]\nenabled = true\n`;
  const state = () => {
    const t = read() ?? "";
    const mkts = {};
    for (const m of t.matchAll(/\n\[marketplaces\.([^\]]+)\]\nsource_type = "local"\nsource = "([^"]*)"\n/g)) mkts[m[1]] = m[2];
    const plugs = new Set([...t.matchAll(/\n\[plugins\."([^"]+)"\]\nenabled = true\n/g)].map((m) => m[1]));
    return { t, mkts, plugs };
  };
  const [a0, a1, a2] = args;
  if (a0 !== "plugin") die(`fake codex: unsupported: ${argv.join(" ")}`, 2);
  const s = state();
  const checkSnapshots = () => {
    for (const [n, src] of Object.entries(s.mkts)) {
      if (!fs.existsSync(path.join(src, ".agents", "plugins", "marketplace.json"))) {
        die(`Error: failed to load configured marketplace snapshot(s): marketplace '${n}': marketplace root does not contain a supported manifest`);
      }
    }
  };
  if (a1 === "marketplace" && a2 === "add") {
    const resolved = fs.realpathSync(args[3]);
    const mf = readJson(path.join(resolved, ".agents", "plugins", "marketplace.json"), null);
    if (!mf) die("Error: marketplace root does not contain a supported manifest");
    if (s.mkts[mf.name] !== undefined) {
      if (s.mkts[mf.name] === resolved) return out(`Marketplace \`${mf.name}\` is already added.`);
      die(`Error: marketplace '${mf.name}' is already added from a different source; remove it before adding this source`);
    }
    persist(s.t + mktBlock(mf.name, resolved));
    return out(`Added marketplace \`${mf.name}\` from ${resolved}.`);
  }
  if (a1 === "marketplace" && a2 === "remove") {
    const name = args[3];
    if (s.mkts[name] === undefined) die(`Error: marketplace '${name}' is not configured`);
    persist(s.t.replace(mktBlock(name, s.mkts[name]), ""));
    return out(`Removed marketplace \`${name}\`.`);
  }
  if (a1 === "add") {
    checkSnapshots();
    const id = args[2];
    const [name, mkt] = id.split("@");
    const src = s.mkts[mkt];
    if (src === undefined) die(`Error: marketplace '${mkt}' is not configured`);
    const pj = readJson(path.join(src, "plugin.json"), null) ?? readJson(path.join(src, ".codex-plugin", "plugin.json"), null);
    if (!pj) die("Error: missing plugin.json");
    const cacheParent = path.join(dir, "plugins", "cache", mkt, name);
    fs.rmSync(cacheParent, { recursive: true, force: true });
    fs.mkdirSync(cacheParent, { recursive: true });
    fs.cpSync(src, path.join(cacheParent, pj.version), { recursive: true });
    fs.chmodSync(path.join(cacheParent, pj.version), 0o755);
    if (!s.plugs.has(id)) persist(s.t + plugBlock(id));
    return out(`Added plugin \`${name}\` from marketplace \`${mkt}\`.\nInstalled plugin root: ${path.join(cacheParent, pj.version)}`);
  }
  if (a1 === "remove") {
    const id = args[2];
    const [name, mkt] = id.split("@");
    fs.rmSync(path.join(dir, "plugins", "cache", mkt, name), { recursive: true, force: true });
    for (const d of [path.join(dir, "plugins", "cache", mkt), path.join(dir, "plugins", "cache"), path.join(dir, "plugins")]) {
      try { fs.rmdirSync(d); } catch { break; }
    }
    if (s.plugs.has(id)) persist(s.t.replace(plugBlock(id), ""));
    return out(`Removed plugin \`${name}\` from marketplace \`${mkt}\`.`);   // printed even when nothing was installed
  }
  if (a1 === "list") {
    checkSnapshots();
    return out([...s.plugs].join("\n"));
  }
  die(`fake codex: unsupported: ${argv.join(" ")}`, 2);
}

if (tool === "claude") claude();
else if (tool === "codex") codex();
else die("usage: fake-agents.mjs claude|codex ...", 2);
