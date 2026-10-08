import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { collectConfig, collectConfigSnapshots } from "../../src/extract/configsnap/index.js";
import type { CollectOptions, CollectResult } from "../../src/extract/configsnap/index.js";
import { shortHash } from "../../src/extract/configsnap/labels.js";
import { resolveClaudePaths } from "../../src/extract/configsnap/paths.js";
import { KNOWN_HOOK_EVENTS, PERMISSION_MODES } from "../../src/extract/configsnap/vocab.js";
import { Fixture, NOW, hash, opts } from "./helpers.js";

const fixtures: Fixture[] = [];
function fx(): Fixture {
  const f = new Fixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

const claude = (f: Fixture, extra: Partial<CollectOptions> = {}): CollectResult => collectConfig("claude-code", opts(f, extra));
const states = (r: CollectResult): Record<string, string> => Object.fromEntries(r.diagnostics.map((d) => [d.source, d.state]));
const h = (v: string): string => shortHash(hash, v);

function fullTree(f: Fixture): void {
  f.write(".claude/CLAUDE.md", "# rules\nsecond line\n");
  f.json(".claude/settings.json", {
    model: "claude-opus-5-5",
    effortLevel: "high",
    alwaysThinkingEnabled: true,
    statusLine: { type: "command", command: "~/bin/status.sh" },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] }],
      Stop: [{ hooks: [{ type: "command", command: "c" }] }],
      "Weird Event!": [{ hooks: [{ type: "command", command: "d" }] }],
      Empty: [{ matcher: "x", hooks: [] }],
    },
    permissions: { allow: ["Bash(ls:*)", "Read", "Edit"], deny: ["Bash(curl:*)"], defaultMode: "acceptEdits" },
    env: { ONE: "1", TWO: "2" },
    enabledPlugins: { "alpha@market": true, "beta@market": true, "off@market": false },
    theme: "dark",
  });
  f.json(".claude.json", {
    numStartups: 5,
    projects: { "/some/project": { mcpServers: { hidden: {} }, history: [] } },
    mcpServers: { github: { command: "npx", args: ["x"], env: { T: "v" } }, docs: { type: "http", url: "https://example.invalid" } },
  });
  f.json(".claude/plugins/installed_plugins.json", { version: 2, plugins: { "alpha@market": [{ scope: "user" }], "beta@market": [{ scope: "user" }], "gamma@market": [{ scope: "user" }] } });
  f.write(".claude/skills/one/SKILL.md", "x");
  f.write(".claude/skills/two/SKILL.md", "x");
  f.write(".claude/skills/not-a-skill/notes.md", "x");
}

test("full tree: every source read, exact values", () => {
  const f = fx();
  fullTree(f);
  const r = claude(f);
  assert.equal(r.found, true);
  assert.equal(r.snapshot.agent, "claude-code");
  assert.equal(r.snapshot.t, NOW.toISOString());
  const i = r.snapshot.items;

  assert.equal(i["instructions.present"], true);
  assert.equal(i["instructions.bytes"], 20);
  assert.equal(i["instructions.lines"], 2);
  assert.match(String(i["instructions.hash"]), /^h:[0-9a-f]{8}$/);

  assert.equal(i["settings.model"], "claude-opus-5-5");
  assert.equal(i["settings.effort"], "high");
  assert.equal(i["settings.thinking"], "on");
  assert.equal(i["settings.statusline.present"], true);
  assert.match(String(i["settings.statusline.hash"]), /^h:[0-9a-f]{8}$/);

  assert.equal(i["settings.hooks.total"], 4);
  assert.equal(i["settings.hooks.event.PreToolUse"], 2);
  assert.equal(i["settings.hooks.event.Stop"], 1);
  assert.equal(i[`settings.hooks.event.${h("Weird Event!")}`], 1);
  assert.equal(i["settings.hooks.event.Empty"], undefined);

  assert.equal(i["settings.permissions.allow"], 3);
  assert.equal(i["settings.permissions.deny"], 1);
  assert.equal(i["settings.permissions.ask"], 0);
  assert.equal(i["settings.permissions.count"], 4);
  assert.equal(i["settings.permissions.mode"], "acceptEdits");
  assert.equal(i["settings.env.count"], 2);

  assert.equal(i["settings.plugins.count"], 2);
  assert.equal(i[`settings.plugins.name.${h("alpha@market")}`], true);
  assert.equal(i[`settings.plugins.name.${h("off@market")}`], undefined, "disabled plugin is not enabled");

  assert.equal(i["claudejson.mcp.count"], 2);
  assert.equal(i[`claudejson.mcp.name.${h("github")}`], true);
  assert.equal(i[`claudejson.mcp.name.${h("hidden")}`], undefined, "projects.<path>.mcpServers is not the user's list");
  assert.match(String(i["claudejson.mcp.hash"]), /^h:[0-9a-f]{8}$/);

  assert.equal(i["plugins.installed.count"], 3);
  assert.equal(i["skills.count"], 2);
  assert.equal(i[`skills.name.${h("one")}`], true);

  assert.deepEqual(states(r), {
    instructions: "ok", settings: "ok", "claude-json": "ok", "installed-plugins": "ok", skills: "ok",
  });
});

test("collection is deterministic and the hash tracks content", () => {
  const f = fx();
  fullTree(f);
  const a = claude(f).snapshot.items;
  const b = claude(f).snapshot.items;
  assert.deepEqual(a, b);
  f.write(".claude/CLAUDE.md", "# rules\nsecond line\nthird\n");
  const c = claude(f).snapshot.items;
  assert.notEqual(c["instructions.hash"], a["instructions.hash"]);
  assert.equal(c["instructions.lines"], 3);
  assert.equal(c["instructions.bytes"], 26);
  // different salt, different hash: ids are not comparable across installs
  const other = collectConfig("claude-code", opts(f, { hash: (v, p) => p + "00000000ffff".slice(0, 12) })).snapshot.items;
  assert.notEqual(other["instructions.hash"], c["instructions.hash"]);
});

test("a hash is a salted fingerprint: same bytes in a different file hash the same, one byte off does not", () => {
  const f = fx();
  f.write(".claude/CLAUDE.md", "abc");
  const a = claude(f).snapshot.items["instructions.hash"];
  f.write(".claude/CLAUDE.md", "abd");
  assert.notEqual(claude(f).snapshot.items["instructions.hash"], a);
  f.write(".claude/CLAUDE.md", "abc");
  assert.equal(claude(f).snapshot.items["instructions.hash"], a);
});

test("config dir exists but is empty: absence is definitive", () => {
  const f = fx();
  f.mkdir(".claude");
  const r = claude(f);
  assert.equal(r.found, true);
  const i = r.snapshot.items;
  assert.equal(i["instructions.present"], false);
  assert.equal(i["instructions.hash"], undefined);
  assert.equal(i["settings.model"], "unset");
  assert.equal(i["settings.effort"], "unset");
  assert.equal(i["settings.thinking"], "unset");
  assert.equal(i["settings.statusline.present"], false);
  assert.equal(i["settings.hooks.total"], 0);
  assert.equal(i["settings.permissions.count"], 0);
  assert.equal(i["settings.env.count"], 0);
  assert.equal(i["settings.plugins.count"], 0);
  assert.equal(i["claudejson.mcp.count"], 0);
  assert.equal(i["plugins.installed.count"], 0);
  assert.equal(i["skills.count"], 0);
  assert.deepEqual(Object.values(states(r)), ["missing", "missing", "missing", "missing", "missing"]);
});

test("config dir missing: nothing to snapshot", () => {
  const f = fx();
  const r = claude(f);
  assert.equal(r.found, false);
  assert.deepEqual(r.snapshot.items, {});
  assert.deepEqual(r.diagnostics, [{ agent: "claude-code", source: "config-dir", state: "missing" }]);
  assert.deepEqual(collectConfigSnapshots(opts(f)), []);
});

test("config dir that is a file: not found, reported", () => {
  const f = fx();
  f.write(".claude", "i am a file");
  const r = claude(f);
  assert.equal(r.found, false);
  assert.equal(states(r)["config-dir"], "not-file");
});

test("malformed settings.json: that source is unknown, the rest still collected", () => {
  const f = fx();
  fullTree(f);
  f.write(".claude/settings.json", '{"model": "x", ');
  const r = claude(f);
  assert.equal(states(r).settings, "malformed");
  assert.equal(r.snapshot.items["settings.model"], undefined);
  assert.equal(r.snapshot.items["settings.hooks.total"], undefined);
  assert.equal(r.snapshot.items["skills.count"], 2);
  assert.equal(r.snapshot.items["claudejson.mcp.count"], 2);
});

test("settings.json with the wrong top-level type, empty, BOM", () => {
  const f = fx();
  fullTree(f);
  for (const bad of ["[]", "null", '"str"', "12"]) {
    f.write(".claude/settings.json", bad);
    assert.equal(states(claude(f)).settings, "malformed", bad);
  }
  f.write(".claude/settings.json", "   \n");
  assert.equal(states(claude(f)).settings, "ok");
  assert.equal(claude(f).snapshot.items["settings.model"], "unset");
  f.write(".claude/settings.json", "﻿" + JSON.stringify({ model: "opus" }));
  assert.equal(claude(f).snapshot.items["settings.model"], "opus");
});

test("huge settings.json (over the 1 MiB cap): unknown, never a half-parse", () => {
  const f = fx();
  f.write(".claude/settings.json", JSON.stringify({ model: "m", pad: "x".repeat(2 * 1024 * 1024) }));
  const r = claude(f);
  assert.equal(states(r).settings, "capped");
  assert.equal(r.snapshot.items["settings.model"], undefined);
});

test("huge CLAUDE.md: size is the real size, hash covers the first MiB only, flagged capped", () => {
  const f = fx();
  const body = Buffer.alloc(3 * 1024 * 1024, "a");
  f.write(".claude/CLAUDE.md", body);
  const r = claude(f);
  const i = r.snapshot.items;
  assert.equal(i["instructions.present"], true);
  assert.equal(i["instructions.bytes"], 3 * 1024 * 1024);
  assert.equal(i["instructions.capped"], true);
  assert.equal(i["instructions.lines"], undefined, "a line count of a prefix would be a lie");
  assert.equal(i["instructions.hash"], shortHash(hash, body.subarray(0, 1 << 20).toString("latin1")));
  assert.equal(states(r).instructions, "capped");
});

test("CLAUDE.md line counting", () => {
  const f = fx();
  for (const [text, lines] of [["", 0], ["a", 1], ["a\n", 1], ["a\nb", 2], ["a\n\n", 2], ["\n", 1]] as const) {
    f.write(".claude/CLAUDE.md", text);
    assert.equal(claude(f).snapshot.items["instructions.lines"], lines, JSON.stringify(text));
  }
});

test("CLAUDE.md as a directory or a FIFO: unknown, not a crash", () => {
  const f = fx();
  f.mkdir(".claude/CLAUDE.md");
  const r = claude(f);
  assert.equal(states(r).instructions, "not-file");
  assert.equal(r.snapshot.items["instructions.present"], undefined);
});

test("~/.claude.json location rules", () => {
  const home = fx();
  home.mkdir(".claude");
  home.json(".claude.json", { mcpServers: { homeSrv: {} } });
  assert.equal(claude(home).snapshot.items["claudejson.mcp.count"], 1);

  // CLAUDE_CONFIG_DIR: only <dir>/.claude.json — never fall back to the other profile's file
  const prof = fx();
  prof.mkdir("profiles/work");
  prof.json(".claude.json", { mcpServers: { a: {}, b: {} } });
  const envWork = { CLAUDE_CONFIG_DIR: prof.path("profiles", "work") };
  const noFile = claude(prof, { env: envWork });
  assert.equal(noFile.snapshot.items["claudejson.mcp.count"], 0);
  assert.equal(states(noFile)["claude-json"], "missing");
  prof.json("profiles/work/.claude.json", { mcpServers: { only: {} } });
  assert.equal(claude(prof, { env: envWork }).snapshot.items["claudejson.mcp.count"], 1);

  // WASITME_CLAUDE_DIR: directory first, then ~/.claude.json
  const w = fx();
  w.mkdir("copy");
  w.json(".claude.json", { mcpServers: { a: {}, b: {} } });
  const envW = { WASITME_CLAUDE_DIR: w.path("copy") };
  assert.equal(claude(w, { env: envW }).snapshot.items["claudejson.mcp.count"], 2);
  w.json("copy/.claude.json", { mcpServers: { c: {} } });
  assert.equal(claude(w, { env: envW }).snapshot.items["claudejson.mcp.count"], 1);
});

test("~/.claude.json: the legacy .config.json inside the config dir wins when it exists", () => {
  const f = fx();
  f.mkdir(".claude");
  f.json(".claude.json", { mcpServers: { a: {}, b: {} } });
  f.json(".config.json", { mcpServers: { homeRoot1: {}, homeRoot2: {}, homeRoot3: {} } }); // wrong place: never read
  assert.equal(claude(f).snapshot.items["claudejson.mcp.count"], 2);

  f.json(".claude/.config.json", { mcpServers: { legacy: {} } });
  const r = claude(f);
  assert.equal(r.snapshot.items["claudejson.mcp.count"], 1);
  assert.equal(r.snapshot.items[`claudejson.mcp.name.${h("legacy")}`], true);

  // as in Claude Code, the first file that EXISTS is the one: a broken legacy file is unknown, never a fall-through to .claude.json
  f.write(".claude/.config.json", "{broken");
  const broken = claude(f);
  assert.equal(states(broken)["claude-json"], "malformed");
  assert.equal(broken.snapshot.items["claudejson.mcp.count"], undefined);

  // CLAUDE_CONFIG_DIR: <dir>/.config.json beats <dir>/.claude.json
  const p = fx();
  p.mkdir("prof");
  p.json("prof/.claude.json", { mcpServers: { a: {}, b: {} } });
  const env = { CLAUDE_CONFIG_DIR: p.path("prof") };
  assert.equal(claude(p, { env }).snapshot.items["claudejson.mcp.count"], 2);
  p.json("prof/.config.json", { mcpServers: { only: {} } });
  assert.equal(claude(p, { env }).snapshot.items["claudejson.mcp.count"], 1);
});

test("~/.claude.json: CLAUDE_CODE_CUSTOM_OAUTH_URL selects .claude-custom-oauth.json and never falls back to the plain file", () => {
  const f = fx();
  f.mkdir(".claude");
  f.json(".claude.json", { mcpServers: { stale: {} } });
  const env = { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://oauth.example.invalid" };

  const none = claude(f, { env });
  assert.equal(states(none)["claude-json"], "missing");
  assert.equal(none.snapshot.items[`claudejson.mcp.name.${h("stale")}`], undefined, "the plain file is a different, stale file");

  f.json(".claude-custom-oauth.json", { mcpServers: { a: {}, b: {} } });
  const custom = claude(f, { env });
  assert.equal(custom.snapshot.items["claudejson.mcp.count"], 2);
  assert.equal(states(custom)["claude-json"], "ok");

  // empty value = not set, like Claude Code's own truthiness test
  assert.equal(claude(f, { env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: "" } }).snapshot.items["claudejson.mcp.count"], 1);

  // inside CLAUDE_CONFIG_DIR the suffixed name is used too
  const p = fx();
  p.mkdir("prof");
  p.json("prof/.claude.json", { mcpServers: { plain: {} } });
  p.json("prof/.claude-custom-oauth.json", { mcpServers: { x: {}, y: {}, z: {} } });
  assert.equal(claude(p, { env: { ...env, CLAUDE_CONFIG_DIR: p.path("prof") } }).snapshot.items["claudejson.mcp.count"], 3);
});

test("global state file candidates, in the order Claude Code tries them", () => {
  const home = join(sep, "h");
  const at = (...parts: string[]): string => join(sep, ...parts);
  const custom = { CLAUDE_CODE_CUSTOM_OAUTH_URL: "x" };
  const cand = (env: Record<string, string>): string[] => resolveClaudePaths(env, home).jsonCandidates;
  assert.deepEqual(cand({}), [at("h", ".claude", ".config.json"), at("h", ".claude.json")]);
  assert.deepEqual(cand(custom), [at("h", ".claude", ".config.json"), at("h", ".claude-custom-oauth.json")]);
  assert.deepEqual(cand({ CLAUDE_CONFIG_DIR: at("c") }), [at("c", ".config.json"), at("c", ".claude.json")]);
  assert.deepEqual(cand({ CLAUDE_CONFIG_DIR: at("c"), ...custom }), [at("c", ".config.json"), at("c", ".claude-custom-oauth.json")]);
  assert.deepEqual(cand({ WASITME_CLAUDE_DIR: at("w") }), [at("w", ".config.json"), at("w", ".claude.json"), at("h", ".claude.json")]);
});

test("directory override precedence and spelling", () => {
  const f = fx();
  f.write("a/CLAUDE.md", "A");
  f.write("b/CLAUDE.md", "BB");
  f.write("c/CLAUDE.md", "CCC");
  f.write("rel/dir/CLAUDE.md", "DDDD");
  const bytes = (env: Record<string, string>): unknown => claude(f, { env }).snapshot.items["instructions.bytes"];
  assert.equal(bytes({ WASITME_CLAUDE_DIR: f.path("a"), CLAUDE_CONFIG_DIR: f.path("b") }), 1);
  assert.equal(bytes({ CLAUDE_CONFIG_DIR: f.path("b") }), 2);
  assert.equal(bytes({ WASITME_CLAUDE_DIR: "", CLAUDE_CONFIG_DIR: f.path("c") }), 3, "empty means unset");
  assert.equal(bytes({ CLAUDE_CONFIG_DIR: "rel/dir" }), 4, "relative paths resolve against home, never the cwd");
  assert.equal(bytes({ CLAUDE_CONFIG_DIR: "~/c" }), 3, "~ expands to the overridden home");
  assert.equal(resolveClaudePaths({}, f.home).dir, f.path(".claude"));
});

test("process.env is never consulted when an explicit env is given", () => {
  const f = fx();
  f.write(".claude/CLAUDE.md", "mine");
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/definitely/not/a/real/dir";
  try {
    const r = claude(f);
    assert.equal(r.found, true);
    assert.equal(r.snapshot.items["instructions.bytes"], 4);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("~/.claude.json: huge file, mcpServers after a giant projects map (default 16 MiB cap reads it)", () => {
  const f = fx();
  f.mkdir(".claude");
  const projects = Object.fromEntries(Array.from({ length: 12000 }, (_, i) => [`/p/${i}`, { history: ["x".repeat(100)] }]));
  const text = JSON.stringify({ projects, mcpServers: { a: {}, b: {}, c: {} } });
  assert.ok(text.length > 1024 * 1024);
  f.write(".claude.json", text);
  const r = claude(f);
  assert.equal(r.snapshot.items["claudejson.mcp.count"], 3);
  assert.equal(states(r)["claude-json"], "ok");
});

test("~/.claude.json beyond the cap: unknown, NEVER a silent zero", () => {
  const f = fx();
  f.mkdir(".claude");
  const text = JSON.stringify({ projects: { p: "x".repeat(300_000) }, mcpServers: { a: {} } });
  f.write(".claude.json", text);
  const r = claude(f, { claudeJsonCapBytes: 100_000 });
  assert.equal(r.snapshot.items["claudejson.mcp.count"], undefined);
  assert.equal(states(r)["claude-json"], "capped");

  // ...but if the key sits inside the prefix we did read, it is used (and flagged capped)
  f.write(".claude.json", JSON.stringify({ mcpServers: { a: {}, b: {} }, projects: { p: "x".repeat(300_000) } }));
  const r2 = claude(f, { claudeJsonCapBytes: 100_000 });
  assert.equal(r2.snapshot.items["claudejson.mcp.count"], 2);
  assert.equal(states(r2)["claude-json"], "capped");
});

test("~/.claude.json: malformed or odd shapes", () => {
  const f = fx();
  f.mkdir(".claude");
  f.write(".claude.json", "{not json");
  assert.equal(states(claude(f))["claude-json"], "malformed");
  assert.equal(claude(f).snapshot.items["claudejson.mcp.count"], undefined);

  f.write(".claude.json", "[]");
  assert.equal(states(claude(f))["claude-json"], "malformed");

  f.json(".claude.json", { other: 1 });
  assert.equal(claude(f).snapshot.items["claudejson.mcp.count"], 0, "key absent in a complete file is a real zero");

  f.json(".claude.json", { mcpServers: null });
  assert.equal(claude(f).snapshot.items["claudejson.mcp.count"], 0);

  f.json(".claude.json", { mcpServers: [1, 2] });
  assert.equal(states(claude(f))["claude-json"], "malformed");
  assert.equal(claude(f).snapshot.items["claudejson.mcp.count"], undefined);
});

test("installed_plugins.json: malformed and odd shapes", () => {
  const f = fx();
  f.mkdir(".claude");
  f.write(".claude/plugins/installed_plugins.json", "{oops");
  assert.equal(states(claude(f))["installed-plugins"], "malformed");
  f.json(".claude/plugins/installed_plugins.json", { version: 2 });
  assert.equal(states(claude(f))["installed-plugins"], "malformed");
  f.json(".claude/plugins/installed_plugins.json", { plugins: {} });
  assert.equal(claude(f).snapshot.items["plugins.installed.count"], 0);
});

test("symlinks: CLAUDE.md, settings.json, skills and the config dir itself may be links", () => {
  const f = fx();
  f.write("dotfiles/CLAUDE.md", "from dotfiles\n");
  f.json("dotfiles/settings.json", { model: "sonnet" });
  f.write("dotfiles/skills/linked/SKILL.md", "x");
  f.write("real-claude/skills/plain/SKILL.md", "x");
  f.link("real-claude/CLAUDE.md", f.path("dotfiles", "CLAUDE.md"));
  f.link("real-claude/settings.json", f.path("dotfiles", "settings.json"));
  f.link("real-claude/skills/linked", f.path("dotfiles", "skills", "linked"));
  f.link(".claude", f.path("real-claude"));
  const r = claude(f);
  assert.equal(r.found, true);
  assert.equal(r.snapshot.items["instructions.bytes"], 14);
  assert.equal(r.snapshot.items["settings.model"], "sonnet");
  assert.equal(r.snapshot.items["skills.count"], 2);
});

test("symlinks into an avoided folder are never followed", () => {
  const f = fx();
  f.write("Documents/dotfiles/CLAUDE.md", "SECRET CONTENT");
  f.write("Documents/dotfiles/skills/x/SKILL.md", "x");
  f.mkdir(".claude");
  f.link(".claude/CLAUDE.md", f.path("Documents", "dotfiles", "CLAUDE.md"));
  f.link(".claude/skills", f.path("Documents", "dotfiles", "skills"));
  const r = claude(f, { avoid: [f.path("Documents")] });
  assert.equal(states(r).instructions, "protected");
  assert.equal(states(r).skills, "protected");
  assert.equal(r.snapshot.items["instructions.present"], undefined);
  assert.equal(r.snapshot.items["skills.count"], undefined);
  assert.equal(JSON.stringify(r).includes("SECRET"), false);
  // settings etc. outside the avoided folder are unaffected
  assert.equal(states(r).settings, "missing");

  // a config dir that itself lives in an avoided folder is not touched at all
  const r2 = claude(f, { env: { CLAUDE_CONFIG_DIR: f.path("Documents", "dotfiles") }, avoid: [f.path("Documents")] });
  assert.equal(r2.found, false);
  assert.deepEqual(states(r2), { "config-dir": "protected" });
});

test("wrong types everywhere in settings.json: no throw, sane items", () => {
  const f = fx();
  f.json(".claude/settings.json", {
    model: { nested: true },
    effortLevel: ["x"],
    alwaysThinkingEnabled: "yes",
    statusLine: null,
    hooks: "nope",
    permissions: [1, 2],
    env: 5,
    enabledPlugins: ["a", "b"],
    other: { deep: [1, { a: 1 }] },
  });
  const r = claude(f);
  const i = r.snapshot.items;
  assert.equal(states(r).settings, "ok");
  assert.match(String(i["settings.model"]), /^h:[0-9a-f]{8}$/);
  assert.match(String(i["settings.effort"]), /^h:[0-9a-f]{8}$/);
  assert.equal(i["settings.thinking"], "other");
  assert.equal(i["settings.statusline.present"], false);
  assert.equal(i["settings.hooks.total"], 0);
  assert.equal(i["settings.permissions.count"], 0);
  assert.equal(i["settings.env.count"], 0);
  assert.equal(i["settings.plugins.count"], 0);
});

test("labels that are not label-safe (paths, prose, token-shaped) become hashes", () => {
  const f = fx();
  for (const bad of ["/opt/models/secret", "has spaces and prose, plus comma", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "x".repeat(61), "\u001b[31mred"]) {
    f.json(".claude/settings.json", { model: bad });
    const m = claude(f).snapshot.items["settings.model"];
    assert.match(String(m), /^h:[0-9a-f]{8}$/, bad);
  }
  for (const good of ["claude-opus-5-5", "opus[1m]", "us.anthropic.claude-sonnet-4-20250514-v1:0", "sonnet"]) {
    f.json(".claude/settings.json", { model: good });
    assert.equal(claude(f).snapshot.items["settings.model"], good);
  }
});

test("hook event names: well-formed ones kept, others hashed; duplicate-after-hash events add up", () => {
  const f = fx();
  f.json(".claude/settings.json", {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }],
      "../../etc": [{ hooks: [{ type: "command", command: "x" }] }],
      "bad name": [{ hooks: [{ type: "command", command: "x" }, { type: "command", command: "y" }] }],
    },
  });
  const i = claude(f).snapshot.items;
  assert.equal(i["settings.hooks.event.PreToolUse"], 1);
  assert.equal(i[`settings.hooks.event.${h("../../etc")}`], 1);
  assert.equal(i[`settings.hooks.event.${h("bad name")}`], 2);
  assert.equal(i["settings.hooks.total"], 4);
});

test("a token-shaped hook event name is hashed, not kept as a key", () => {
  const f = fx();
  const tokenish = "AbCdEf0123456789AbCdEf0123456789"; // 32 alphanumerics: passes the event-name pattern, fails the token guard
  f.json(".claude/settings.json", { hooks: { [tokenish]: [{ hooks: [{ type: "command", command: "x" }] }] } });
  const i = claude(f).snapshot.items;
  assert.equal(JSON.stringify(i).includes(tokenish), false);
  assert.equal(i[`settings.hooks.event.${h(tokenish)}`], 1);
});

test("hook events: only Claude Code's own event names are readable; a label-safe unknown name is hashed", () => {
  const f = fx();
  const hook = [{ hooks: [{ type: "command", command: "x" }] }];
  // AcmeClientSecretProj is plain letters, so a charset check would have let it through as text
  f.json(".claude/settings.json", { hooks: { SessionStart: hook, Stop: hook, AcmeClientSecretProj: hook, stop: hook } });
  const r = claude(f);
  const i = r.snapshot.items;
  assert.equal(i["settings.hooks.event.SessionStart"], 1);
  assert.equal(i["settings.hooks.event.Stop"], 1);
  assert.equal(i[`settings.hooks.event.${h("AcmeClientSecretProj")}`], 1);
  assert.equal(i[`settings.hooks.event.${h("stop")}`], 1, "the list is exact, not case-insensitive");
  assert.equal(i["settings.hooks.total"], 4, "unlisted events still count");
  assert.equal(JSON.stringify(r).includes("Acme"), false);

  // every listed event survives as itself
  const all = Object.fromEntries([...KNOWN_HOOK_EVENTS].map((e) => [e, hook]));
  f.json(".claude/settings.json", { hooks: all });
  const j = claude(f).snapshot.items;
  for (const e of KNOWN_HOOK_EVENTS) assert.equal(j[`settings.hooks.event.${e}`], 1, e);
});

test("permission mode: listed modes are readable, anything else is hashed", () => {
  const f = fx();
  const mode = (m: unknown): unknown => {
    f.json(".claude/settings.json", { permissions: { defaultMode: m } });
    return claude(f).snapshot.items["settings.permissions.mode"];
  };
  for (const m of PERMISSION_MODES) assert.equal(mode(m), m);
  assert.deepEqual([...PERMISSION_MODES].sort(), ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);
  assert.equal(mode("AcmeProject"), h("AcmeProject"));
  assert.equal(mode("Acme Project"), h("Acme Project"));
  assert.equal(mode("Plan"), h("Plan"), "the list is exact, not case-insensitive");
  assert.equal(mode(undefined), "unset");
});

test("more than the name cap: count stays exact, names capped deterministically", () => {
  const f = fx();
  const skills = 230;
  for (let n = 0; n < skills; n++) f.write(`.claude/skills/s${n}/SKILL.md`, "x");
  const a = claude(f).snapshot.items;
  assert.equal(a["skills.count"], skills);
  assert.equal(Object.keys(a).filter((k) => k.startsWith("skills.name.")).length, 200);
  assert.deepEqual(a, claude(f).snapshot.items);
});

test("other-settings hash ignores key order and whitespace but sees real edits", () => {
  const f = fx();
  f.write(".claude/settings.json", '{"theme":"dark","x":{"b":1,"a":2}}');
  const a = claude(f).snapshot.items["settings.other.hash"];
  f.write(".claude/settings.json", '{\n  "x": {"a": 2, "b": 1},\n  "theme": "dark"\n}');
  assert.equal(claude(f).snapshot.items["settings.other.hash"], a);
  f.write(".claude/settings.json", '{"theme":"light","x":{"b":1,"a":2}}');
  assert.notEqual(claude(f).snapshot.items["settings.other.hash"], a);
  // itemised keys do not leak into "other"
  f.write(".claude/settings.json", '{"theme":"dark","x":{"b":1,"a":2},"model":"opus"}');
  assert.equal(claude(f).snapshot.items["settings.other.hash"], a);
});

test("a __proto__ key in settings is just a key (counted in the hash, pollutes nothing)", () => {
  const f = fx();
  f.write(".claude/settings.json", '{"__proto__":{"polluted":true},"model":"m"}');
  const a = claude(f).snapshot.items["settings.other.hash"];
  f.write(".claude/settings.json", '{"__proto__":{"polluted":false},"model":"m"}');
  assert.notEqual(claude(f).snapshot.items["settings.other.hash"], a);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("read caps: tiny cap flags capped, nonsense caps fall back to the defaults, absurd caps are clamped", () => {
  const f = fx();
  f.write(".claude/CLAUDE.md", "0123456789abcdef");
  const tiny = claude(f, { capBytes: 4 });
  assert.equal(tiny.snapshot.items["instructions.capped"], true);
  assert.equal(tiny.snapshot.items["instructions.bytes"], 16);
  for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = claude(f, { capBytes: nonsense });
    assert.equal(r.snapshot.items["instructions.capped"], undefined, String(nonsense));
  }
  assert.equal(claude(f, { capBytes: 1e15 }).snapshot.items["instructions.bytes"], 16);
});

test("explicit home + empty env: every location read is inside the fixture home (the real ~/.claude is unreachable)", () => {
  const f = fx();
  const p = resolveClaudePaths({}, f.home);
  assert.ok(p.dir.startsWith(f.home));
  for (const c of p.jsonCandidates) assert.ok(c.startsWith(f.home), c);
});

test("both agents: only agents with a config dir get a snapshot", () => {
  const f = fx();
  f.mkdir(".claude");
  assert.deepEqual(collectConfigSnapshots(opts(f)).map((s) => s.agent), ["claude-code"]);
  f.mkdir(".codex");
  assert.deepEqual(collectConfigSnapshots(opts(f)).map((s) => s.agent), ["claude-code", "codex"]);
});
