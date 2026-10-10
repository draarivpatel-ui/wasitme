/**
 * The scan and the SessionStart hook under the Node permission model (D49, S-NODEPERM): the D49 grant recipe
 * (one flag per path, single prefix wildcards for `~/.claude*` and `~/.codex*`), the config collector's resolveSafe
 * change (ancestors the sandbox hides are walked past), and the permission-flag feature test recorded in engine.json.
 * Everything runs on a synthetic temp HOME in child processes; nothing outside it is granted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probePermissionFlag, recordPermissionFlag } from "../../src/store/permission.js";
import { readJson, REPO, TESTDATA, tempEnv } from "./helpers.js";

const ENGINE = join(REPO, "engine");
const CLI = join(ENGINE, "dist", "src", "cli", "main.js");
const FLAG = probePermissionFlag();

function homeWithLogs(): { root: string; home: string; cleanup(): void } {
  const env = tempEnv("sandbox");
  const home = realpathSync(env.home);
  cpSync(join(TESTDATA, "seed", "tiny-both", "claude"), join(home, ".claude"), { recursive: true, preserveTimestamps: true });
  cpSync(join(TESTDATA, "seed", "tiny-both", "codex"), join(home, ".codex"), { recursive: true, preserveTimestamps: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-sonnet-5", permissions: { allow: ["Bash(npm test)"] } }));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# global rules\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { alpha: { command: "x" } }, projects: {} }));
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-6"\nmodel_reasoning_effort = "high"\n');
  mkdirSync(join(home, ".wasitme"), { mode: 0o700 }); // setup (WP-70) creates it before any sandboxed run
  return { root: env.root, home, cleanup: env.cleanup };
}

function run(args: string[], home: string, flags: string[] = [], input?: string) {
  return spawnSync(process.execPath, [...flags, CLI, ...args], {
    encoding: "utf8", input, timeout: 60_000,
    env: { HOME: home, PATH: "/usr/bin:/bin", TZ: "UTC" },
  });
}

/**
 * D49's recipe. One finding of this work package [ran, Node 26.8.1]: a grant on a directory that does NOT exist when
 * node starts covers that exact path only, not the children created later (mkdir of ~/.wasitme/history is denied);
 * `<dir>/*` covers both. Setup creates ~/.wasitme before any sandboxed run, so the plain spelling works in practice;
 * the `/*` spelling is the robust one for a launcher (the last test below runs it on a home with no ~/.wasitme).
 */
function scanFlags(home: string, wasitme = `${home}/.wasitme`): string[] {
  return [
    FLAG!, `--allow-fs-read=${ENGINE}`,
    `--allow-fs-read=${home}/.claude*`, `--allow-fs-read=${home}/.codex*`,
    `--allow-fs-read=${wasitme}`, `--allow-fs-write=${wasitme}`,
  ];
}

test("the permission flag is feature-tested, not inferred from the version", () => {
  assert.ok(FLAG === "--permission" || FLAG === "--experimental-permission", String(FLAG));
  assert.equal(probePermissionFlag("/nonexistent/node"), null);
});

test("engine.json records the feature test once per node version, keeping the installer's keys one per line", () => {
  const env = tempEnv("enginejson");
  try {
    const p = join(env.root, "engine.json");
    writeFileSync(p, '{\n  "scanLabel": "dev.wasitme.scan",\n  "node": "/opt/node"\n}\n', { mode: 0o600 });
    let probes = 0;
    const probe = () => { probes++; return "--permission" as const; };
    assert.deepEqual(recordPermissionFlag(p, { probe, nodeVersion: "v26.8.1" }), { flag: "--permission", how: "probed" });
    assert.deepEqual(recordPermissionFlag(p, { probe, nodeVersion: "v26.8.1" }), { flag: "--permission", how: "recorded" });
    assert.equal(probes, 1);
    const text = readFileSync(p, "utf8");
    assert.match(text, /^ {2}"scanLabel": "dev\.wasitme\.scan",$/m, "the hook scripts' sed pattern still matches");
    assert.match(text, /^ {2}"permissionFlag": "--permission",$/m);
    recordPermissionFlag(p, { probe, nodeVersion: "v27.0.0" });
    assert.equal(probes, 2, "a node upgrade re-tests");
    writeFileSync(p, "not json");
    assert.equal(recordPermissionFlag(p, { probe }).how, "skipped", "never overwrite a file we cannot read");
  } finally {
    env.cleanup();
  }
});

test("engine.json rewrite keeps arrays on one line, so the installer's sed still reads the tracked agents", () => {
  const env = tempEnv("enginejson-arrays");
  try {
    const p = join(env.root, "engine.json");
    // The installer's layout (scripts/lib/engine.sh engine_json_write): one key per line, arrays inline.
    writeFileSync(p, [
      "{",
      '  "schema": "wasitme.engine/1",',
      '  "node": "/opt/node",',
      '  "onPath": false,',
      '  "agents": ["claude-code", "codex"],',
      '  "permission": null,',
      '  "scanArgs": ["--permission", "--allow-fs-read=/opt/x"],',
      '  "app": null',
      "}",
      "",
    ].join("\n"), { mode: 0o600 });
    // The exact reader of scripts/lib/install_main.sh agents_from_install.
    const agents = () => spawnSync("sed", ["-n", 's/^[[:space:]]*"agents":[[:space:]]*\\[\\(.*\\)\\][[:space:]]*,\\{0,1\\}$/\\1/p', p], { encoding: "utf8" }).stdout.replace(/["\s]/g, "");
    assert.equal(agents(), "claude-code,codex", "the installer's sed reads the file as written by the installer");
    assert.equal(recordPermissionFlag(p, { probe: () => "--permission", nodeVersion: "v26.8.1" }).how, "probed");
    assert.equal(agents(), "claude-code,codex", "and still reads it after the engine recorded the permission flag");
    const text = readFileSync(p, "utf8");
    for (const line of text.trimEnd().split("\n").slice(1, -1)) assert.match(line, /^ {2}"[A-Za-z]+": [^{[\s].*$|^ {2}"[A-Za-z]+": \[.*\],?$/, `one key per line: ${line}`);
    assert.match(text, /^ {2}"scanArgs": \["--permission",\s?"--allow-fs-read=\/opt\/x"\],$/m);
    assert.match(text, /^ {2}"permissionNode": "v26\.8\.1"$/m, "the last key carries no trailing comma");
    assert.deepEqual(JSON.parse(text), {
      schema: "wasitme.engine/1", node: "/opt/node", onPath: false, agents: ["claude-code", "codex"], permission: null,
      scanArgs: ["--permission", "--allow-fs-read=/opt/x"], app: null, permissionFlag: "--permission", permissionNode: "v26.8.1",
    });
  } finally {
    env.cleanup();
  }
});

test("a full scan under node --permission with the D49 grants: readers AND config collector work, sandbox reported", { skip: FLAG === null ? "no permission flag on this node" : false }, () => {
  const h = homeWithLogs();
  try {
    const sandboxed = run(["scan", "--tz", "UTC"], h.home, scanFlags(h.home));
    assert.equal(sandboxed.status, 0, sandboxed.stderr);
    const wh = join(h.home, ".wasitme");
    const snapS = readJson(join(wh, "snapshot.json"));
    assert.equal(snapS.health.sandbox, true);
    const cfg = readJson(join(wh, "history", "config.json"));
    assert.equal(cfg.agents["claude-code"].last.items["settings.model"], "claude-sonnet-5", "settings.json read under the sandbox");
    assert.equal(cfg.agents["claude-code"].last.items["claudejson.mcp.count"], 1, "~/.claude.json read through the .claude* wildcard");
    assert.equal(cfg.agents["claude-code"].last.items["instructions.present"], true);
    assert.equal(cfg.agents.codex.last.items["config.model"], "gpt-6");
    assert.equal(existsSync(join(wh, "engine.json")), false, "no child processes under the sandbox: nothing probed, nothing written");

    // The same home scanned without the sandbox (same salt): the same analysis, only `sandbox` differs.
    for (const f of ["glance.json", "snapshot.json"]) rmSync(join(wh, f));
    rmSync(join(wh, "history"), { recursive: true });
    const plain = run(["scan", "--tz", "UTC"], h.home);
    assert.equal(plain.status, 0, plain.stderr);
    const snapP = readJson(join(wh, "snapshot.json"));
    assert.equal(snapP.health.sandbox, false);
    assert.deepEqual(snapS.agents, snapP.agents);
    assert.deepEqual({ ...snapS.health, sandbox: null }, { ...snapP.health, sandbox: null });
    assert.equal(readJson(join(wh, "engine.json")).permissionFlag, FLAG, "unsandboxed: feature test recorded");
  } finally {
    h.cleanup();
  }
});

test("switching between a sandboxed and a plain scan re-stamps the results instead of recomputing them (only health.sandbox moves)", { skip: FLAG === null ? "no permission flag on this node" : false }, () => {
  const h = homeWithLogs();
  try {
    const wh = join(h.home, ".wasitme");
    assert.equal(run(["scan", "--tz", "UTC"], h.home, scanFlags(h.home)).status, 0);
    const sandboxed = readJson(join(wh, "snapshot.json"));
    assert.equal(sandboxed.health.sandbox, true);
    const plain = run(["scan", "--tz", "UTC"], h.home);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /\(results unchanged\)/, "the CLI's plain scan reuses the LaunchAgent's sandboxed results");
    const after = readJson(join(wh, "snapshot.json"));
    assert.equal(after.health.sandbox, false, "the re-stamped snapshot says how this scan ran");
    assert.deepEqual(after.agents, sandboxed.agents);
    const back = run(["scan", "--tz", "UTC"], h.home, scanFlags(h.home));
    assert.match(back.stdout, /\(results unchanged\)/);
    assert.equal(readJson(join(wh, "snapshot.json")).health.sandbox, true);
  } finally {
    h.cleanup();
  }
});

test("a grant that misses a log root fails loudly in the counts, not silently as 'no data' (S-NODEPERM row D)", { skip: FLAG === null ? "no permission flag on this node" : false }, () => {
  const h = homeWithLogs();
  try {
    const flags = scanFlags(h.home).filter((f) => !f.includes(".codex"));
    const r = run(["scan", "--tz", "UTC"], h.home, flags);
    assert.equal(r.status, 0, r.stderr);
    const s = readJson(join(h.home, ".wasitme", "snapshot.json"));
    const codex = s.health.sources.find((x: any) => x.agent === "codex");
    // The permission model refuses the folder (ERR_ACCESS_DENIED): it is there but not readable, which doctor reports
    // as a problem — never an empty healthy source, and not "no logs" either.
    assert.equal(codex?.found, false);
    assert.equal(codex?.error, "permission_denied", "Codex shows up as not readable, never as an empty healthy source");
  } finally {
    h.cleanup();
  }
});

test("the SessionStart hook under its sandbox flags (~/.wasitme read/write, cwd read): snapshot recorded, nothing printed", { skip: FLAG === null ? "no permission flag on this node" : false }, () => {
  const h = homeWithLogs();
  try {
    const cwd = join(h.home, "work", "proj");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, "CLAUDE.md"), "# project\n");
    writeFileSync(join(cwd, ".claude", "settings.json"), "{}");
    mkdirSync(join(h.home, ".wasitme"), { recursive: true, mode: 0o700 });
    const flags = [FLAG!, `--allow-fs-read=${ENGINE}`, `--allow-fs-read=${h.home}/.wasitme`, `--allow-fs-read=${cwd}`, `--allow-fs-write=${h.home}/.wasitme`];
    const r = run(["hook", "session-start"], h.home, flags, JSON.stringify({ session_id: "sess-sbx", cwd }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    const inbox = join(h.home, ".wasitme", "state", "projsnap");
    const files = (() => { try { return readFileSync(join(inbox, require_one(inbox)), "utf8"); } catch { return ""; } })();
    assert.match(files, /"claudeMd\.present":true/);
    assert.match(files, /"settings\.present":true/);
  } finally {
    h.cleanup();
  }
});

test("a fresh home with no ~/.wasitme yet: the `<dir>/*` grant spelling lets the sandboxed scan create it and its folders", { skip: FLAG === null ? "no permission flag on this node" : false }, () => {
  const h = homeWithLogs();
  try {
    rmSync(join(h.home, ".wasitme"), { recursive: true });
    const r = run(["scan", "--tz", "UTC"], h.home, scanFlags(h.home, `${h.home}/.wasitme/*`));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(join(h.home, ".wasitme", "snapshot.json")).health.sandbox, true);
  } finally {
    h.cleanup();
  }
});

function require_one(dir: string): string {
  const names = readdirSync(dir);
  assert.equal(names.length, 1, `expected one record, found ${names.length}`);
  return names[0]!;
}
