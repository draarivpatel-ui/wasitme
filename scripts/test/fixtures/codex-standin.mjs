#!/usr/bin/env node
// A stand-in for the `codex plugin ...` commands wasitme uses, modelled on what Codex CLI 0.160.0 was seen doing in an
// isolated CODEX_HOME (docs/spikes/2026-10-04-codex-node.md §2, S-CX). Tests run it instead of the real codex, so no
// test ever starts the person's codex. Zero dependencies; it reads and writes only under $CODEX_HOME.
//
// What it models, because the D49 recipe depends on it:
//   - `marketplace add` stores the RESOLVED path of the marketplace root, never the symlink it was given (§2.5);
//   - a second `marketplace add` of the same name from a different path is refused (§2.5);
//   - a root needs .agents/plugins/marketplace.json (or the legacy .claude-plugin/marketplace.json) (§2.4);
//   - `plugin add` needs a plugin.json (root or .codex-plugin/); the root plugin.json's version wins (§2.4 v5);
//   - `plugin add` copies the whole plugin root into plugins/cache/<marketplace>/<plugin>/<version>/, replacing any
//     other version, with directories 0755 and file modes kept (§2.3);
//   - list and add fail when a registered marketplace root is gone; remove still works (§2.6);
//   - `plugin remove` prints its line and exits 0 even when nothing was installed (§2.1);
//   - add then remove leaves config.toml byte-identical (§2.2).
// Every call is appended to $CODEX_HOME/standin.log, so a test can check the exact order it ran.

import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const home = process.env.CODEX_HOME ?? "";
if (!isAbsolute(home)) {
  console.error("Error: CODEX_HOME must be an absolute path (the stand-in never touches a real ~/.codex)");
  process.exit(2);
}
mkdirSync(home, { recursive: true });
const argv = process.argv.slice(2);
appendFileSync(join(home, "standin.log"), argv.join(" ") + "\n");

const cfgPath = join(home, "config.toml");
const readCfg = () => (existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "");
const writeCfg = (text) => writeFileSync(cfgPath, text, { mode: 0o600 });
const mktBlock = (name, source) => `\n[marketplaces.${name}]\nsource_type = "local"\nsource = ${JSON.stringify(source)}\n`;
const pluginBlock = (id) => `\n[plugins.${JSON.stringify(id)}]\nenabled = true\n`;

function marketplaces(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\[marketplaces\.([A-Za-z0-9_-]+)\]\nsource_type = "local"\nsource = ("(?:[^"\\]|\\.)*")\n/gm)) out.set(m[1], JSON.parse(m[2]));
  return out;
}

function readMarketplace(root) {
  for (const rel of [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"]) {
    const p = join(root, rel);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  return null;
}

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function loadAll(text) {
  for (const [, source] of marketplaces(text)) {
    if (readMarketplace(source) === null) fail(`failed to load configured marketplace snapshot(s): marketplace root does not contain a supported manifest`);
  }
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true, mode: 0o755 });
  chmodSync(to, 0o755);
  for (const name of readdirSync(from)) {
    const a = join(from, name);
    const b = join(to, name);
    const st = lstatSync(a);
    if (st.isDirectory()) copyTree(a, b);
    else if (st.isFile()) {
      copyFileSync(a, b);
      chmodSync(b, st.mode & 0o777);
    }
  }
}

const cachePlugin = (mkt, plugin) => join(home, "plugins", "cache", mkt, plugin);

const [noun, verb, ...rest] = argv;
if (noun !== "plugin") fail(`unrecognized subcommand '${noun ?? ""}'`, 2);

if (verb === "marketplace") {
  const [action, arg] = rest;
  const text = readCfg();
  if (action === "add") {
    if (arg === undefined || !existsSync(arg)) fail(`marketplace path does not exist`);
    const resolved = realpathSync(arg);
    const m = readMarketplace(resolved);
    if (m === null) fail("marketplace root does not contain a supported manifest");
    const existing = marketplaces(text).get(m.name);
    if (existing !== undefined && existing !== resolved) fail(`marketplace '${m.name}' is already added from a different source; remove it before adding this source`);
    if (existing === undefined) writeCfg(text + mktBlock(m.name, resolved));
    console.log(`Added marketplace \`${m.name}\` from ${resolved}.`);
  } else if (action === "remove") {
    const source = marketplaces(text).get(arg ?? "");
    if (source === undefined) fail(`marketplace '${arg ?? ""}' is not configured`);
    writeCfg(text.replace(mktBlock(arg, source), ""));
    console.log(`Removed marketplace \`${arg}\`.`);
  } else if (action === "list") {
    loadAll(text);
    for (const [name, source] of marketplaces(text)) console.log(`${name}  local  ${source}`);
  } else if (action === "upgrade") {
    console.log("No configured Git marketplaces to upgrade.");
  } else fail(`unrecognized subcommand '${action ?? ""}'`, 2);
} else if (verb === "add") {
  const [id] = rest;
  const [plugin, mkt] = (id ?? "").split("@");
  const text = readCfg();
  loadAll(text);
  const source = marketplaces(text).get(mkt ?? "");
  if (source === undefined) fail(`marketplace '${mkt ?? ""}' is not configured`);
  const m = readMarketplace(source);
  const entry = (m.plugins ?? []).find((p) => p.name === plugin);
  if (entry === undefined) fail(`plugin '${plugin}' not found in marketplace '${mkt}'`);
  const root = resolve(source, entry.source);
  const rootJson = join(root, "plugin.json");
  const codexJson = join(root, ".codex-plugin", "plugin.json");
  const manifest = existsSync(rootJson) ? rootJson : existsSync(codexJson) ? codexJson : null;
  if (manifest === null) fail("missing plugin.json");
  const version = String(JSON.parse(readFileSync(manifest, "utf8")).version);
  rmSync(cachePlugin(mkt, plugin), { recursive: true, force: true });
  const dest = join(cachePlugin(mkt, plugin), version);
  copyTree(root, dest);
  if (!text.includes(pluginBlock(id))) writeCfg(text + pluginBlock(id));
  console.log(`Added plugin \`${plugin}\` from marketplace \`${mkt}\`.`);
  console.log(`Installed plugin root: ${dest}`);
} else if (verb === "remove") {
  const [id] = rest;
  const [plugin, mkt] = (id ?? "").split("@");
  const text = readCfg();
  if (text.includes(pluginBlock(id))) writeCfg(text.replace(pluginBlock(id), ""));
  rmSync(cachePlugin(mkt ?? "", plugin ?? ""), { recursive: true, force: true });
  console.log(`Removed plugin \`${plugin}\` from marketplace \`${mkt}\`.`);
} else if (verb === "list") {
  const text = readCfg();
  loadAll(text);
  for (const m of text.matchAll(/^\[plugins\."([^"]+)"\]\nenabled = true\n/gm)) {
    const [plugin, mkt] = m[1].split("@");
    const dir = cachePlugin(mkt, plugin);
    const versions = existsSync(dir) ? readdirSync(dir).filter((v) => statSync(join(dir, v)).isDirectory()) : [];
    console.log(`${m[1]}  installed, enabled  ${versions.join(",")}`);
  }
} else fail(`unrecognized subcommand '${verb ?? ""}'`, 2);
