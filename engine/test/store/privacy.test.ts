/**
 * Privacy probe (WP-12 acceptance): scan the hostile corpus (testdata/hostile: fake secrets, paths, prompts, ANSI,
 * bidi, HTML, malformed lines; all synthetic) plus config and project files seeded with the same canaries, run the
 * SessionStart hook on a hostile project, and require that NO canary appears anywhere under the temp WASITME_HOME
 * (scripts/check-privacy.mjs, which also catches JSON/URL/HTML-escaped and re-wrapped forms) nor in the CLI output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { labelOf } from "../../src/extract/configsnap/labels.js";
import { sessionStartHook } from "../../src/hook/session-start.js";
import { makeHash } from "../../src/util.js";
import { copyCorpus, REPO, scanIn, TESTDATA, tempEnv } from "./helpers.js";

const CHECK = join(REPO, "scripts", "check-privacy.mjs");
const CANARIES = readFileSync(join(TESTDATA, "hostile", "CANARIES.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("# ") && l !== "#");

test("config labels: short prose in a model / effort value is hashed, never kept as a 'label' (found by this probe)", () => {
  const h = makeHash("synthetic-test-salt");
  for (const bad of ["the launch codename is SYNTHCANARY00029", "my client acme", "opus 5", "a b"]) assert.match(labelOf(h, bad), /^h:[0-9a-f]{8}$/, bad);
  for (const good of ["claude-opus-5-5", "opus[1m]", "us.anthropic.claude-sonnet-4-20250514-v1:0", "claude-opus-5@20260101", "gpt-6.1-sol", "high"]) assert.equal(labelOf(h, good), good);
});

test("no canary from the hostile corpus, config or project files reaches the wasitme home or the CLI output", async () => {
  const env = tempEnv("privacy");
  try {
    copyCorpus(env, join(TESTDATA, "hostile"));
    const c = (i: number) => CANARIES[i % CANARIES.length]!;
    // Global config seeded with canaries in every free-text position the collector reads.
    writeFileSync(join(env.claude, "CLAUDE.md"), `# rules\n${c(0)}\n${c(5)}\n`);
    writeFileSync(join(env.claude, "settings.json"), JSON.stringify({
      model: c(1), env: { SECRET: c(4) }, statusLine: { type: "command", command: c(10) },
      permissions: { allow: [`Bash(${c(11)})`], defaultMode: c(12) }, enabledPlugins: { [c(13)]: true },
      hooks: { [c(14)]: [{ hooks: [{ type: "command", command: c(15) }] }] },
    }));
    writeFileSync(join(env.home, ".claude.json"), JSON.stringify({ mcpServers: { [c(16)]: { command: c(17), env: { K: c(18) } } } }));
    writeFileSync(join(env.codex, "config.toml"), `model = "${c(19)}"\nmodel_provider = "${c(20)}"\n[mcp_servers.x]\ncommand = "${c(21)}"\n`);
    writeFileSync(join(env.codex, "AGENTS.md"), `${c(22)}\n`);
    // A hostile project for the hook.
    const proj = join(env.home, "code", "hostile-SYNTHCANARY00001");
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, "CLAUDE.md"), `${c(23)}\n${c(24)}\n`);
    writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ env: { T: c(25) } }));
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { [c(26)]: { command: c(27) } } }));
    const hook = sessionStartHook({ home: env.wh, userHome: env.home, cwd: proj, session: "hostile-session", now: new Date("2026-06-02T10:00:00Z") });
    assert.equal(hook.wrote, true);

    const r1 = await scanIn(env, { now: new Date("2026-06-10T12:00:00Z") });
    assert.equal(r1.wrote, true);
    assert.ok(r1.sources > 0, "the hostile corpus has sources");
    // A second scan with the config changed, so diffs (events, notes) are exercised too.
    writeFileSync(join(env.claude, "settings.json"), JSON.stringify({ model: c(28), env: { SECRET: c(29), OTHER: c(30) } }));
    await scanIn(env, { now: new Date("2026-06-11T12:00:00Z") });

    const probe = spawnSync(process.execPath, [CHECK, "--require-canaries", env.wh], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    assert.match(probe.stdout, /0 hits/);

    // The CLI's own output (read-only report and summary line) is checked the same way.
    const cli = join(REPO, "engine", "dist", "src", "cli", "main.js");
    const runEnv = { HOME: env.home, WASITME_HOME: env.wh, WASITME_CLAUDE_DIR: env.claude, WASITME_CODEX_DIR: env.codex, PATH: "/usr/bin:/bin" };
    for (const args of [["scan", "--read-only", "--tz", "UTC"], ["scan", "--tz", "UTC"], ["scan", "--until", "not-a-time"]]) {
      const out = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: runEnv });
      const text = out.stdout + out.stderr;
      const check = spawnSync(process.execPath, [CHECK, "--require-canaries", "-"], { input: text, encoding: "utf8" });
      assert.equal(check.status, 0, `${args.join(" ")}: ${check.stdout}`);
      assert.doesNotMatch(text, /\/Users\/|\/private\/|\/var\//, `${args.join(" ")} printed a path`);
    }
  } finally {
    env.cleanup();
  }
});
