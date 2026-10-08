// The Codex plugin root (plugin-codex/, WP-61): its files, its one-source manifests, and the D49 install / update /
// uninstall order run against a codex STAND-IN (fixtures/codex-standin.mjs) in a temp CODEX_HOME. The real codex is
// never started: the stand-in models what Codex CLI 0.160.0 was seen doing in docs/spikes/2026-10-04-codex-node.md
// (S-CX), so these tests check wasitme's root and recipe against that record, not Codex itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expected, main as manifestsMain } from "../plugin-manifests.mjs";
import { makeTree, REPO_ROOT, runMain, writeExecutable } from "./helpers.mjs";

const ROOT = join(REPO_ROOT, "plugin-codex");
const STANDIN = join(REPO_ROOT, "scripts", "test", "fixtures", "codex-standin.mjs");
const ID = "wasitme@wasitme-codex";

/** Every file under a directory, relative, sorted. */
function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** A throwaway world: HOME, CODEX_HOME, a `codex` launcher for the stand-in, and the installer's version layout. */
function world() {
  const t = makeTree();
  const home = join(t.root, "home");
  const codexHome = join(home, ".codex");
  const wh = join(home, ".wasitme");
  mkdirSync(codexHome, { recursive: true });
  const codex = join(t.root, "bin", "codex");
  writeExecutable(codex, `#!/bin/sh\nexec "${process.execPath}" "${STANDIN}" "$@"\n`);
  // The person's own config.toml, which add + remove must leave byte for byte as it was (S-CX §2.2).
  const seed = '# my codex config\nmodel = "gpt-6"\nnotify = ["/bin/echo", "done"] # my notifier\n\n[mcp_servers.demo]\ncommand = "demo"\nenv = { TOKEN = "x" }\n';
  writeFileSync(join(codexHome, "config.toml"), seed, { mode: 0o600 });
  const run = (...args) => {
    const r = spawnSync(codex, args, {
      encoding: "utf8",
      cwd: t.root,
      env: { PATH: `${join(t.root, "bin")}:/usr/bin:/bin`, HOME: home, CODEX_HOME: codexHome },
    });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  /** A read-only version dir holding plugin-codex/ at `version` (the release step bumps both manifests together). */
  const version = (v, extra = () => {}) => {
    const dir = join(wh, "versions", v, "plugin-codex");
    cpSync(ROOT, dir, { recursive: true });
    for (const rel of ["plugin.json", ".codex-plugin/plugin.json"]) {
      const p = join(dir, rel);
      writeFileSync(p, readFileSync(p, "utf8").replace(/"version": "[^"]*"/, `"version": "${v}"`));
    }
    extra(dir);
    spawnSync("/bin/chmod", ["-R", "a-w", join(wh, "versions", v)]);
    return realpathSync(dir);
  };
  /** Point `current` at a version atomically (symlink + rename), as the installer does. */
  const flip = (v) => {
    mkdirSync(wh, { recursive: true });
    const tmp = join(wh, `.current-${v}`);
    rmSync(tmp, { force: true });
    symlinkSync(join("versions", v), tmp);
    renameSync(tmp, join(wh, "current"));
  };
  const cache = join(codexHome, "plugins", "cache", "wasitme-codex", "wasitme");
  const cleanup = () => {
    spawnSync("/bin/chmod", ["-R", "u+w", t.root]);
    t.cleanup();
  };
  return { home, codexHome, wh, seed, run, version, flip, cache, cleanup, config: () => readFileSync(join(codexHome, "config.toml"), "utf8"), log: () => readFileSync(join(codexHome, "standin.log"), "utf8") };
}

// The D49 recipes, exactly as the installer runs them (Codex stores the resolved marketplace path, so the `current`
// symlink never carries an update to Codex on its own).
const current = (w) => join(w.wh, "current", "plugin-codex");
const install = (w) => [w.run("plugin", "marketplace", "add", current(w)), w.run("plugin", "add", ID)];
const update = (w) => [w.run("plugin", "marketplace", "remove", "wasitme-codex"), w.run("plugin", "marketplace", "add", current(w)), w.run("plugin", "add", ID)];
const uninstall = (w) => [w.run("plugin", "remove", ID), w.run("plugin", "marketplace", "remove", "wasitme-codex")];
const ok = (results) => results.forEach((r) => assert.equal(r.status, 0, r.out));

/** Anything named hooks* anywhere under a directory. */
function hookFiles(dir) {
  return existsSync(dir) ? files(dir).filter((f) => f.split("/").some((part) => part.startsWith("hooks"))) : [];
}

test("plugin-codex/ holds exactly the release allow-list (Codex copies the whole root into its cache)", () => {
  assert.deepEqual(files(ROOT), [".agents/plugins/marketplace.json", ".codex-plugin/plugin.json", "plugin.json", "skills/report/SKILL.md"]);
});

test("both Codex manifests and the Claude plugin come from one source, at the engine's version (D49)", () => {
  const r = runMain(manifestsMain, ["--check"]);
  assert.equal(r.code, 0, r.err);
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "engine", "package.json"), "utf8")).version;
  const read = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
  assert.equal(read("plugin-codex/plugin.json").version, version);
  assert.equal(read("plugin-codex/.codex-plugin/plugin.json").version, version);
  assert.equal(read("plugin/.claude-plugin/plugin.json").version, version);
  assert.equal(read("plugin-codex/plugin.json").$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  const mkt = read("plugin-codex/.agents/plugins/marketplace.json");
  assert.equal(mkt.name, "wasitme-codex");
  assert.deepEqual(mkt.plugins, [{ name: "wasitme", source: "./" }]);
  assert.equal(Object.keys(expected()).length, 4);
});

test("--check fails when the two Codex manifests drift apart", () => {
  const t = makeTree();
  try {
    cpSync(join(REPO_ROOT, "engine", "package.json"), join(t.root, "engine", "package.json"));
    cpSync(join(REPO_ROOT, "plugin"), join(t.root, "plugin"), { recursive: true });
    cpSync(ROOT, join(t.root, "plugin-codex"), { recursive: true });
    assert.equal(runMain(manifestsMain, ["--check"], t.root).code, 0);
    const p = join(t.root, "plugin-codex", "plugin.json");
    writeFileSync(p, readFileSync(p, "utf8").replace(/"version": "[^"]*"/, '"version": "9.9.9"'));
    const r = runMain(manifestsMain, ["--check"], t.root);
    assert.equal(r.code, 1);
    assert.match(r.err, /plugin-codex\/plugin\.json is out of date/);
  } finally {
    t.cleanup();
  }
});

test("the Codex skill runs run.sh for the Codex report, and does not yet document $wasitme:report (D49)", () => {
  const skill = readFileSync(join(ROOT, "skills", "report", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: report\ndescription: /);
  assert.ok(skill.includes('/bin/sh "$HOME/.wasitme/current/plugin/scripts/run.sh" report --md --agent codex'));
  assert.ok(!skill.includes("$wasitme:report"));
  // The only command it gives is that one: never a PATH-resolved `wasitme`.
  const commands = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  assert.deepEqual(commands, ['/bin/sh "$HOME/.wasitme/current/plugin/scripts/run.sh" report --md --agent codex']);
  assert.ok(!/`wasitme[ `]/.test(skill), "no inline `wasitme ...` command");
});

test("D49: install, flip-only (the trap), update, uninstall, in a temp CODEX_HOME with the stand-in", () => {
  const w = world();
  try {
    const v1 = w.version("0.1.0");
    const v2 = w.version("0.2.0");
    w.flip("0.1.0");

    // Install: register the marketplace at current/plugin-codex, then add the plugin.
    ok(install(w));
    assert.ok(w.config().includes(`source = ${JSON.stringify(v1)}`), "Codex stores the resolved version dir");
    assert.deepEqual(readdirSync(w.cache), ["0.1.0"]);
    assert.deepEqual(files(join(w.cache, "0.1.0")), [".agents/plugins/marketplace.json", ".codex-plugin/plugin.json", "plugin.json", "skills/report/SKILL.md"]);
    assert.deepEqual(hookFiles(w.codexHome), [], "no hooks.json reaches Codex's cache");
    assert.match(w.run("plugin", "list").out, /wasitme@wasitme-codex {2}installed, enabled {2}0\.1\.0/);

    // Flip alone does not move Codex: it still installs what the resolved 0.1.0 dir holds.
    w.flip("0.2.0");
    ok([w.run("plugin", "add", ID)]);
    assert.deepEqual(readdirSync(w.cache), ["0.1.0"]);
    // And the same name from the new path is refused until the old registration is removed.
    const again = w.run("plugin", "marketplace", "add", current(w));
    assert.equal(again.status, 1);
    assert.match(again.out, /already added from a different source/);

    // Update (D49): marketplace remove -> marketplace add <current>/plugin-codex -> plugin add.
    ok(update(w));
    assert.ok(w.config().includes(`source = ${JSON.stringify(v2)}`));
    assert.deepEqual(readdirSync(w.cache), ["0.2.0"]);
    assert.ok(w.config().includes(`[plugins."${ID}"]\nenabled = true\n`), "the plugin stays enabled");
    assert.deepEqual(hookFiles(w.codexHome), []);

    // Uninstall (D49): plugin remove, then marketplace remove: config.toml is back to the person's own, byte for byte.
    ok(uninstall(w));
    assert.equal(w.config(), w.seed);
    assert.equal(existsSync(w.cache), false);
    assert.equal(statSync(join(w.codexHome, "config.toml")).mode & 0o777, 0o600);

    // The stand-in saw exactly the D49 order.
    const mk = `plugin marketplace add ${current(w)}`;
    assert.deepEqual(w.log().trim().split("\n"), [
      mk, `plugin add ${ID}`, "plugin list",
      `plugin add ${ID}`, mk,
      "plugin marketplace remove wasitme-codex", mk, `plugin add ${ID}`,
      `plugin remove ${ID}`, "plugin marketplace remove wasitme-codex",
    ]);
  } finally {
    w.cleanup();
  }
});

test("positive control: a root that ships hooks/hooks.json does get it copied, so the no-hooks check can fail", () => {
  const w = world();
  try {
    w.version("0.1.0", (dir) => {
      mkdirSync(join(dir, "hooks"));
      writeFileSync(join(dir, "hooks", "hooks.json"), '{ "hooks": {} }\n');
    });
    w.flip("0.1.0");
    ok(install(w));
    assert.deepEqual(hookFiles(w.codexHome), ["plugins/cache/wasitme-codex/wasitme/0.1.0/hooks/hooks.json"]);
  } finally {
    w.cleanup();
  }
});

test("the uninstall order matters: marketplace remove first leaves the plugin enabled and cached", () => {
  const w = world();
  try {
    w.version("0.1.0");
    w.flip("0.1.0");
    ok(install(w));
    ok([w.run("plugin", "marketplace", "remove", "wasitme-codex")]);
    assert.ok(w.config().includes(`[plugins."${ID}"]`), "orphaned plugin table");
    assert.ok(existsSync(w.cache), "orphaned cache copy");
    ok([w.run("plugin", "remove", ID)]);
    assert.equal(w.config(), w.seed);
  } finally {
    w.cleanup();
  }
});

test("a pruned version dir that Codex still points at breaks list and add, and remove still cleans up", () => {
  const w = world();
  try {
    w.version("0.1.0");
    w.flip("0.1.0");
    ok(install(w));
    spawnSync("/bin/chmod", ["-R", "u+w", join(w.wh, "versions", "0.1.0")]);
    rmSync(join(w.wh, "versions", "0.1.0"), { recursive: true, force: true });
    const list = w.run("plugin", "list");
    assert.equal(list.status, 1);
    assert.match(list.out, /failed to load configured marketplace snapshot/);
    ok(uninstall(w));
    assert.equal(w.config(), w.seed);
  } finally {
    w.cleanup();
  }
});

test("the stand-in refuses to run without an absolute CODEX_HOME (it can never reach a real ~/.codex)", () => {
  const r = spawnSync(process.execPath, [STANDIN, "plugin", "list"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assert.equal(r.status, 2);
});
