// Tests for scripts/ci-local.sh. It is run inside a throwaway repository whose tools are stubs that record their calls, so
// the orchestration (order, fail-fast, summary, skips, heavy routing, flags) is checked without running the real suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, hasGit, makeTree, SCRIPTS_DIR, writeExecutable } from "./helpers.mjs";

const NODE_SCRIPTS = ["check-no-network", "assemble-changelog", "check-privacy", "lint-copy", "check-repo", "swift-macros", "check-mod-allowlist"];

const stubNode = (name) => `import { appendFileSync } from "node:fs";
appendFileSync(process.env.CALLS, "${name} " + process.argv.slice(2).join(" ") + "\\n");
const noise = process.env.NOISE_${name.replace(/-/g, "_")};
if (noise) console.error(noise);
if (process.env.FAIL === "${name}") { console.error("stub failure in ${name}"); process.exit(1); }
if (process.env.EXIT77 === "${name}") process.exit(77);
`;

const stubShell = (name, extra = "") => `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n${extra}\n`;

/** A repository with ci-local.sh and stubs for every tool it calls. */
function makeRepo(extra = {}) {
  const files = {
    "package-lock.json": "{}\n",
    "docs/METHOD.md": "stub\n",
    "scripts/test/sample.test.mjs": 'import { test } from "node:test";\ntest("stands in for the real script tests", () => {});\n',
    ...extra,
  };
  for (const n of NODE_SCRIPTS) files[`scripts/${n}.mjs`] = stubNode(n);
  const t = makeTree(files);
  copyFileSync(join(SCRIPTS_DIR, "ci-local.sh"), join(t.root, "scripts", "ci-local.sh"));
  const bin = join(t.root, "_bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  writeExecutable(join(bin, "npm"), stubShell("npm", 'case "$FAIL" in "npm $*") echo "stub failure in npm $*" >&2; exit 1;; esac'));
  writeExecutable(join(bin, "xcode-select"), `#!/bin/sh\necho "\${XCODE_SELECT_P:-/Applications/Xcode.app/Contents/Developer}"\n`);
  const run = (args = [], env = {}) => {
    const callsFile = join(t.root, "calls.log");
    writeFileSync(callsFile, "");
    // A minimal environment: no NODE_TEST_CONTEXT (a nested `node --test` would misbehave) and no real tools beyond /usr/bin:/bin.
    const r = spawnSync("sh", [join(t.root, "scripts", "ci-local.sh"), ...args], {
      encoding: "utf8",
      // CI_LOCAL_CLT_DIR points at nothing by default: a test must never reach the machine's real Command Line Tools.
      // CI_LOCAL_SHELLCHECK points at nothing by default too: ubuntu runners have a real shellcheck in /usr/bin.
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: t.root, TMPDIR: t.root, CALLS: callsFile, CI_LOCAL_CLT_DIR: join(t.root, "no-clt"), CI_LOCAL_SHELLCHECK: join(t.root, "no-shellcheck"), ...env },
    });
    const out = r.stdout + r.stderr;
    const table = Object.fromEntries(
      [...out.matchAll(/^([a-z-]+)[ \t]+(PASS|FAIL|SKIP|NOT RUN|-)[ \t]+(?:\d+s)?[ \t]*(.*)$/gm)].map((m) => [m[1], { result: m[2], note: m[3].trim() }]),
    );
    const calls = readFileSync(callsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    return { status: r.status, out, table, calls };
  };
  return { ...t, bin, run };
}

const results = (r, ...names) => names.map((n) => r.table[n]?.result);

test("all green: steps run in order, the table says PASS or SKIP with a reason, exit 0, temp logs removed", () => {
  const t = makeRepo();
  try {
    const r = t.run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /ci-local: PASS \(\d+ passed, \d+ skipped\)/);
    assert.deepEqual(r.calls, [
      "npm ci",
      "npm run typecheck",
      "npm test",
      "check-no-network --host-module claude-code",
      "assemble-changelog --check",
      "check-privacy --self-test",
      "check-no-network --self-test",
      "assemble-changelog --self-test",
      "check-privacy docs",
      "lint-copy",
      "check-repo",
      "swift-macros",
    ]);
    assert.deepEqual(
      results(r, "npm-ci", "typecheck", "test", "no-network", "changelog", "privacy-selftest", "hygiene-selftests", "privacy-scan", "sh-syntax", "script-tests", "copy-lint", "repo-greps", "swift-macros"),
      Array(13).fill("PASS"),
      r.out,
    );
    for (const s of ["swift-build", "swift-test", "swift-build-clt"]) assert.match(r.table[s].note, /no Swift package under macos\//);
    assert.equal(r.table["plugin-validate"].result, "SKIP");
    assert.match(r.table["plugin-validate"].note, /no plugin\/ yet/);
    assert.equal(r.table["git-identity"].result, "SKIP");
    assert.match(r.table["git-identity"].note, /--prepublish only/);
    assert.equal(r.table["mod-allowlist"].result, "SKIP");
    assert.equal(r.table["app-capture"].result, "SKIP", "the release capture is opt-in");
    assert.match(r.table["app-capture"].note, /^opt-in: pass --capture or CI_LOCAL_CAPTURE=1/);
    assert.deepEqual(readdirSync(t.root).filter((n) => n.startsWith("wasitme-ci-local.")), [], "per-step logs are cleaned up");
  } finally {
    t.cleanup();
  }
});

test("fail-fast: the first failure stops the run, later steps are NOT RUN, its output sits above the table, exit 1", () => {
  const t = makeRepo();
  try {
    const r = t.run([], { FAIL: "lint-copy" });
    assert.equal(r.status, 1);
    assert.equal(r.table["copy-lint"].result, "FAIL");
    assert.deepEqual(results(r, "npm-ci", "test", "no-network"), ["PASS", "PASS", "PASS"]);
    assert.deepEqual(results(r, "repo-greps", "swift-macros", "swift-build", "plugin-validate"), ["NOT RUN", "NOT RUN", "NOT RUN", "NOT RUN"]);
    assert.equal(r.table["repo-greps"].note, "stopped at copy-lint");
    assert.ok(!r.calls.includes("check-repo") && !r.calls.includes("swift-macros"), "later steps never ran");
    assert.match(r.out, /ci-local: FAIL \(1 failed, \d+ passed, \d+ skipped; first failure: copy-lint\)/);
    assert.ok(r.out.indexOf("stub failure in lint-copy") < r.out.indexOf("ci-local summary"), "the failing output is shown above the table");
  } finally {
    t.cleanup();
  }
});

test("--keep-going: every step runs, exit 1, all failures counted", () => {
  const t = makeRepo();
  try {
    const r = t.run(["--keep-going"], { FAIL: "check-no-network" }); // fails the no-network and hygiene-selftests steps
    assert.equal(r.status, 1);
    assert.deepEqual(results(r, "no-network", "hygiene-selftests"), ["FAIL", "FAIL"]);
    assert.equal(r.table["repo-greps"].result, "PASS", "later steps still ran");
    assert.ok(r.calls.includes("check-repo"));
    assert.match(r.out, /ci-local: FAIL \(2 failed/);
    assert.match(r.out, /first failure: no-network\)/);

    const npm = t.run(["--keep-going"], { FAIL: "npm test" });
    assert.equal(npm.table.test.result, "FAIL");
    assert.equal(npm.table["copy-lint"].result, "PASS");
  } finally {
    t.cleanup();
  }
});

test("--only, --skip, --list and usage errors", () => {
  const t = makeRepo();
  try {
    const only = t.run(["--only", "copy-lint,repo-greps"]);
    assert.equal(only.status, 0, only.out);
    assert.match(only.out, /ci-local: PASS \(PARTIAL: --only\/--skip used; /, "a partial run never reads as a full PASS");
    assert.deepEqual(only.calls, ["lint-copy", "check-repo"]);
    assert.equal(only.table["npm-ci"].result, "-");
    assert.equal(only.table["npm-ci"].note, "not selected");

    const skip = t.run(["--skip", "npm-ci,test"]);
    assert.ok(!skip.calls.includes("npm ci") && !skip.calls.includes("npm test"));
    assert.equal(skip.table["npm-ci"].result, "SKIP");
    assert.equal(skip.table["npm-ci"].note, "skipped by --skip");

    const list = t.run(["--list"]);
    assert.equal(list.status, 0);
    assert.equal(list.out.trim().split("\n").length, 31);
    assert.match(list.out, /^copy-lint\s+copy lint/m);

    for (const bad of [["--only", "nope"], ["--skip", "copy-lint,nope"], ["--bogus"], ["--only"]]) {
      const r = t.run(bad);
      assert.equal(r.status, 2, bad.join(" "));
      assert.deepEqual(r.calls, [], "nothing runs after a usage error");
    }
    assert.equal(t.run(["--help"]).status, 0);
    assert.match(t.run(["--help"]).out, /Usage: scripts\/ci-local\.sh/);
  } finally {
    t.cleanup();
  }
});

test("--prepublish makes check-repo strict and requires the email config", () => {
  const t = makeRepo();
  try {
    assert.ok(t.run(["--only", "repo-greps", "--prepublish"]).calls.includes("check-repo --strict --require-email-config"));
    assert.ok(t.run(["--only", "repo-greps"]).calls.includes("check-repo"));
  } finally {
    t.cleanup();
  }
});

test("a check that ran with part of itself skipped is repeated under the table", () => {
  const t = makeRepo();
  try {
    const r = t.run([], { NOISE_check_repo: "check-repo: SKIPPED forbidden-email (not configured)" });
    assert.equal(r.status, 0);
    const after = r.out.slice(r.out.indexOf("ci-local summary"));
    assert.match(after, /Heads-up[^\n]*\n\s+check-repo: SKIPPED forbidden-email \(not configured\)/);
    assert.ok(!t.run().out.includes("Heads-up"), "no heads-up when nothing was skipped");
  } finally {
    t.cleanup();
  }
});

test("heavy routing: npm test and swift go through scripts/dev/heavy.sh, light steps do not; CI_LOCAL_NO_HEAVY turns it off", () => {
  const t = makeRepo({ "macos/Package.swift": "// stub\n" });
  try {
    writeExecutable(join(t.root, "scripts", "dev", "heavy.sh"), stubShell("heavy", 'exec "$@"'));
    writeExecutable(join(t.bin, "swift"), stubShell("swift", 'echo "swift-cwd $(basename "$PWD")" >> "$CALLS"'));
    const r = t.run();
    assert.equal(r.status, 0, r.out);
    const heavy = r.calls.filter((c) => c.startsWith("heavy "));
    assert.deepEqual(heavy, ["heavy npm test", "heavy swift build", "heavy swift test"]);
    assert.ok(r.calls.includes("npm ci") && r.calls.includes("npm run typecheck"));
    assert.ok(!r.calls.some((c) => c.startsWith("heavy npm ci") || c.startsWith("heavy npm run")));
    assert.ok(r.calls.includes("swift build") && r.calls.includes("swift test") && r.calls.filter((c) => c === "swift-cwd macos").length === 2, "swift ran inside macos/");
    assert.equal(r.table["swift-build-clt"].result, "SKIP", "no Command Line Tools at the test's CI_LOCAL_CLT_DIR");

    const direct = t.run([], { CI_LOCAL_NO_HEAVY: "1" });
    assert.deepEqual(direct.calls.filter((c) => c.startsWith("heavy ")), []);
    assert.ok(direct.calls.includes("npm test") && direct.calls.includes("swift build"));
  } finally {
    t.cleanup();
  }
});

test("swift: CLT-only build runs with DEVELOPER_DIR when the CLT exist and are not the selected toolchain; CLT default adds the testing plugin path", () => {
  const t = makeRepo({ "macos/Package.swift": "// stub\n" });
  try {
    writeExecutable(join(t.bin, "swift"), stubShell("swift"));
    const clt = join(t.root, "CLT");
    writeExecutable(join(clt, "usr", "bin", "swift"), `#!/bin/sh\necho "clt-swift $* DEVELOPER_DIR=$DEVELOPER_DIR" >> "$CALLS"\n`);
    const withClt = t.run(["--only", "swift-build,swift-test,swift-build-clt"], { CI_LOCAL_CLT_DIR: clt });
    assert.equal(withClt.status, 0, withClt.out);
    assert.ok(withClt.calls.includes(`clt-swift build --scratch-path .build/clt DEVELOPER_DIR=${clt}`), withClt.calls.join("\n"));
    assert.ok(withClt.calls.includes("swift test"), "Xcode selected: no extra plugin flags");

    const noClt = t.run(["--only", "swift-build-clt"], { CI_LOCAL_CLT_DIR: join(t.root, "missing") });
    assert.equal(noClt.table["swift-build-clt"].result, "SKIP");
    assert.match(noClt.table["swift-build-clt"].note, /no Command Line Tools/);

    // the selected toolchain IS the CLT: swift test gets the testing plugin path, the CLT-only build is redundant
    const dev = join(t.root, "CommandLineToolsDev");
    mkdirSync(join(dev, "usr", "lib", "swift", "host", "plugins", "testing"), { recursive: true });
    const cltDefault = t.run(["--only", "swift-test,swift-build-clt"], { CI_LOCAL_CLT_DIR: clt, XCODE_SELECT_P: dev });
    assert.ok(cltDefault.calls.includes(`swift test -Xswiftc -plugin-path -Xswiftc ${dev}/usr/lib/swift/host/plugins/testing`), cltDefault.calls.join("\n"));
    assert.match(cltDefault.table["swift-build-clt"].note, /already is the Command Line Tools/);
  } finally {
    t.cleanup();
  }
});

test("sh-syntax: interpreter chosen by shebang like ci.yml; a syntax error fails; non-shell shebangs are skipped", () => {
  const t = makeRepo({
    "scripts/ok.sh": "#!/bin/sh\necho ok\n",
    "scripts/noshebang.sh": "echo no shebang\n",
    "scripts/tool.py": "#!/usr/bin/env python3\nthis is ( not valid shell\n",
    "scripts/data.txt": "if then fi\n",
  });
  try {
    const ok = t.run(["--only", "sh-syntax"]);
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /ok\s+scripts\/ok\.sh \(sh -n(?:, dash -n)?\)/);
    assert.match(ok.out, /ok\s+scripts\/noshebang\.sh \(sh -n(?:, dash -n)?\)/);
    assert.match(ok.out, /ok\s+scripts\/ci-local\.sh \(sh -n(?:, dash -n)?\)/);
    assert.ok(!ok.out.includes("tool.py") && !ok.out.includes("data.txt"));

    writeFileSync(join(t.root, "scripts", "bad.sh"), "#!/bin/sh\nif then fi\n");
    const bad = t.run(["--only", "sh-syntax"]);
    assert.equal(bad.status, 1);
    assert.match(bad.out, /FAIL\s+scripts\/bad\.sh/);

    writeFileSync(join(t.root, "scripts", "bad.sh"), "#!/usr/bin/env bash\nx=(1 2 3)\n[[ -n ${x[0]} ]] && echo ok\n");
    const bash = t.run(["--only", "sh-syntax"]);
    assert.equal(bash.status, 0, bash.out);
    assert.match(bash.out, /ok\s+scripts\/bad\.sh \(bash -n\)/);
  } finally {
    t.cleanup();
  }
});

test("script-tests: runs scripts/test/*.test.mjs with node --test; a failing test fails the step; none present is a skip", () => {
  const t = makeRepo({ "scripts/test/boom.test.mjs": 'import { test } from "node:test";\ntest("boom", () => { throw new Error("boom"); });\n' });
  try {
    const bad = t.run(["--only", "script-tests"]);
    assert.equal(bad.status, 1);
    assert.equal(bad.table["script-tests"].result, "FAIL");
    assert.match(bad.out, /boom/);
  } finally {
    t.cleanup();
  }
  const none = makeRepo();
  try {
    spawnSync("rm", ["-rf", join(none.root, "scripts", "test")]);
    const r = none.run(["--only", "script-tests"]);
    assert.equal(r.status, 0);
    assert.equal(r.table["script-tests"].result, "SKIP");
  } finally {
    none.cleanup();
  }
});

test("plugin-validate: runs the claude CLI with a temp HOME and CLAUDE_CONFIG_DIR, never the real ones; skips without the CLI", () => {
  const t = makeRepo({
    ".claude-plugin/marketplace.json": "{}\n",
    "plugin/.claude-plugin/plugin.json": "{}\n",
  });
  try {
    const noCli = t.run(["--only", "plugin-validate"]);
    assert.equal(noCli.status, 0, noCli.out);
    assert.match(noCli.table["plugin-validate"].note, /claude CLI is not installed/);

    writeExecutable(join(t.bin, "claude"), stubShell("claude", 'echo "claude-env HOME=$HOME CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" >> "$CALLS"\ncase "$FAIL" in claude) exit 1;; esac'));
    const ok = t.run(["--only", "plugin-validate"], { HOME: "/home-that-must-not-be-used" });
    assert.equal(ok.status, 0, ok.out);
    assert.ok(ok.calls.includes("claude plugin validate --strict ."));
    assert.ok(ok.calls.includes("claude plugin validate --strict plugin"));
    const envLines = ok.calls.filter((c) => c.startsWith("claude-env "));
    assert.equal(envLines.length, 2);
    for (const l of envLines) {
      assert.ok(!l.includes("/home-that-must-not-be-used"), l);
      assert.match(l, new RegExp(`HOME=${t.root}/wasitme-claude-validate\\.\\w+ CLAUDE_CONFIG_DIR=${t.root}/wasitme-claude-validate\\.\\w+/claude`));
    }
    assert.deepEqual(readdirSync(t.root).filter((n) => n.startsWith("wasitme-claude-validate.")), [], "the temp config is removed");

    const fail = t.run(["--only", "plugin-validate"], { FAIL: "claude" });
    assert.equal(fail.status, 1);
    assert.equal(fail.table["plugin-validate"].result, "FAIL");
  } finally {
    t.cleanup();
  }
  const noManifest = makeRepo({ "plugin/README.md": "x\n" });
  try {
    writeExecutable(join(noManifest.bin, "claude"), stubShell("claude"));
    const r = noManifest.run(["--only", "plugin-validate"]);
    assert.equal(r.status, 0);
    assert.match(r.table["plugin-validate"].note, /no plugin manifest/);
    assert.ok(!r.calls.some((c) => c.startsWith("claude ")));
  } finally {
    noManifest.cleanup();
  }
});

test("installer and plugin suites: run.sh (heavy, then under dash), the hook/run.sh tests, fixture sync, mod tests in a temp config", () => {
  const t = makeRepo({
    "scripts/test/run.sh": '#!/bin/sh\necho "installer-run.sh $* SKIP_HEAVY=${WASITME_TEST_SKIP_HEAVY:-} SH=${WASITME_TEST_SH:-}" >> "$CALLS"\n',
    "plugin/tests/hooks.sh": '#!/bin/sh\necho "hooks.sh" >> "$CALLS"\n',
    "plugin/tests/run-sh.sh": '#!/bin/sh\necho "run-sh.sh" >> "$CALLS"\n',
    "plugin/tests/fixtures/sync.mjs": 'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.CALLS, "sync " + process.argv.slice(2).join(" ") + "\\n");\n',
    "plugin/mod/register.ts": "// stub\n",
  });
  try {
    writeExecutable(join(t.root, "scripts", "dev", "heavy.sh"), stubShell("heavy", 'exec "$@"'));
    writeExecutable(join(t.bin, "dash"), '#!/bin/sh\nexec sh "$@"\n');
    const steps = "installer-tests,installer-tests-dash,plugin-sh-tests,plugin-fixtures,plugin-mod-tests";
    const r = t.run(["--only", steps]);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.calls.includes("heavy env WASITME_TEST_SKIP_HEAVY=1 sh scripts/test/run.sh"), r.calls.join("\n"));
    assert.ok(r.calls.includes("installer-run.sh  SKIP_HEAVY=1 SH="), "the suites run without the Swift builds");
    assert.ok(r.calls.includes("installer-run.sh  SKIP_HEAVY=1 SH=dash"), "and again with dash as the shell");
    assert.ok(r.calls.includes("hooks.sh") && r.calls.includes("run-sh.sh"), "both plugin shell suites run");
    assert.ok(r.calls.includes("sync --check"), "the fixture sync is checked, never rewritten");
    assert.match(r.table["plugin-mod-tests"].note, /claude CLI is not installed/);

    writeExecutable(join(t.bin, "claude"), stubShell("claude", 'echo "claude-env HOME=$HOME CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" >> "$CALLS"'));
    const mod = t.run(["--only", "plugin-mod-tests"], { HOME: "/home-that-must-not-be-used" });
    assert.equal(mod.status, 0, mod.out);
    assert.ok(mod.calls.includes("claude plugin test plugin"));
    const env = mod.calls.find((c) => c.startsWith("claude-env "));
    assert.match(env, new RegExp(`HOME=${t.root}/wasitme-claude-modtest\\.\\w+ CLAUDE_CONFIG_DIR=${t.root}/wasitme-claude-modtest\\.\\w+/claude`));
    assert.deepEqual(readdirSync(t.root).filter((n) => n.startsWith("wasitme-claude-modtest.")), [], "the temp config is removed");

    const failing = t.run(["--only", "plugin-sh-tests"], {});
    assert.equal(failing.status, 0);
    writeFileSync(join(t.root, "plugin", "tests", "hooks.sh"), "#!/bin/sh\nexit 1\n");
    const bad = t.run(["--only", "plugin-sh-tests"]);
    assert.equal(bad.table["plugin-sh-tests"].result, "FAIL", "a failing hook suite fails the step");
    assert.ok(!bad.calls.includes("run-sh.sh"), "and stops there");
  } finally {
    t.cleanup();
  }
  const none = makeRepo();
  try {
    const r = none.run(["--only", "installer-tests,installer-heavy,plugin-sh-tests,plugin-fixtures,plugin-mod-tests"]);
    assert.equal(r.status, 0, r.out);
    for (const s of ["installer-tests", "installer-heavy", "plugin-sh-tests", "plugin-fixtures", "plugin-mod-tests"]) assert.equal(r.table[s].result, "SKIP", s);
  } finally {
    none.cleanup();
  }
});

test("design-tests: runs design/system/gen/test.mjs when it exists (light, not through heavy.sh); a failure fails the step; none is a skip", () => {
  const t = makeRepo({
    "design/system/gen/test.mjs": 'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.CALLS, "design-test " + process.argv.slice(2).join(" ") + "\\n");\nif (process.env.FAIL === "design-test") process.exit(1);\n',
  });
  try {
    writeExecutable(join(t.root, "scripts", "dev", "heavy.sh"), stubShell("heavy", 'exec "$@"'));
    const r = t.run(["--only", "design-tests"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.table["design-tests"].result, "PASS");
    assert.deepEqual(r.calls, ["design-test"], "run once, directly");
    const bad = t.run(["--only", "design-tests"], { FAIL: "design-test" });
    assert.equal(bad.table["design-tests"].result, "FAIL", "a failing design check fails the step");
  } finally {
    t.cleanup();
  }
  const none = makeRepo();
  try {
    const r = none.run(["--only", "design-tests"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.table["design-tests"].result, "SKIP");
    assert.match(r.table["design-tests"].note, /no design\/system yet/);
  } finally {
    none.cleanup();
  }
});

test("privacy-scan passes the docs, contract, design, README, CHANGELOG and changelog.d paths that exist", () => {
  const t = makeRepo({ "contract/a.json": "{}\n", "design/b.md": "x\n", "README.md": "x\n", "changelog.d/c.added.md": "- x\n" });
  try {
    assert.ok(t.run(["--only", "privacy-scan"]).calls.includes("check-privacy docs contract design README.md changelog.d"));
  } finally {
    t.cleanup();
  }
  const bare = makeRepo();
  try {
    spawnSync("rm", ["-rf", join(bare.root, "docs")]);
    const r = bare.run(["--only", "privacy-scan"]);
    assert.equal(r.table["privacy-scan"].result, "SKIP");
    assert.ok(!existsSync(join(bare.root, "docs")));
  } finally {
    bare.cleanup();
  }
});

test("CI_LOCAL_KEEP_LOGS keeps the per-step logs and says where", () => {
  const t = makeRepo();
  try {
    const r = t.run(["--only", "copy-lint"], { CI_LOCAL_KEEP_LOGS: "1" });
    const m = /ci-local: logs kept in (\S+)/.exec(r.out);
    assert.ok(m, r.out);
    assert.ok(existsSync(join(m[1], "copy-lint.log")));
    assert.match(readFileSync(join(m[1], "summary.tsv"), "utf8"), /copy-lint\tPASS/);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Review fixes (WP-01Δ)
// ---------------------------------------------------------------------------------------------------------------

test("review #4: exit 77 is a SKIP only after skip(); a tool that happens to exit 77 is a FAIL", () => {
  const t = makeRepo();
  try {
    const r = t.run(["--only", "no-network"], { EXIT77: "check-no-network" });
    assert.equal(r.status, 1, r.out);
    assert.equal(r.table["no-network"].result, "FAIL");
    assert.match(r.table["no-network"].note, /exit 77 without a SKIP/);
    assert.match(r.out, /ci-local: FAIL/);
  } finally {
    t.cleanup();
  }
});

test("review #2: a run without the forbidden-email rule says so on its last line", () => {
  const t = makeRepo();
  try {
    const r = t.run([], { NOISE_check_repo: "check-repo: SKIPPED forbidden-email (not configured)" });
    assert.equal(r.status, 0, "still green: the maintainer's .ci-local.env is optional locally");
    assert.match(r.out.trim().split("\n").pop(), /^ci-local: PASS \(forbidden-email rule NOT run; \d+ passed/);
    assert.match(t.run().out.trim().split("\n").pop(), /^ci-local: PASS \(\d+ passed, \d+ skipped\)$/);
  } finally {
    t.cleanup();
  }
});

test("canvas steps: skip without ui/; with it, build and render go through heavy.sh, render gets one job and CHROME, no Chrome is a SKIP", () => {
  const none = makeRepo();
  try {
    const r = none.run(["--only", "ui-build,ui-test,ui-render"]);
    assert.equal(r.status, 0, r.out);
    for (const s of ["ui-build", "ui-test", "ui-render"]) assert.match(r.table[s].note, /no ui\/ canvas/, s);
  } finally {
    none.cleanup();
  }
  const record = (name) => `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
appendFileSync(process.env.CALLS, "${name} " + process.argv.slice(2).join(" ") + " jobs=" + process.env.WASITME_RENDER_JOBS + " chrome=" + (process.env.CHROME ? "set" : "unset") + "\\n");
if ("${name}" === "ui-build") { mkdirSync("ui/build", { recursive: true }); writeFileSync("ui/build/pages.js", ""); mkdirSync("ui/dist", { recursive: true }); writeFileSync("ui/dist/app.js", ""); }
`;
  const t = makeRepo({
    "ui/package.json": "{}\n",
    "ui/scripts/build.mjs": record("ui-build"),
    "ui/test/render.mjs": record("ui-render"),
    "ui/test/model.test.mjs": 'import { test } from "node:test";\nimport { appendFileSync } from "node:fs";\ntest("stands in for the canvas model tests", () => { appendFileSync(process.env.CALLS, "ui-model\\n"); });\n',
  });
  try {
    writeExecutable(join(t.root, "scripts", "dev", "heavy.sh"), stubShell("heavy", 'exec "$@"'));
    const chrome = join(t.root, "fake-chrome");
    writeExecutable(chrome, "#!/bin/sh\nexit 0\n");
    const r = t.run(["--only", "ui-build,ui-test,ui-render"], { CHROME: chrome });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(results(r, "ui-build", "ui-test", "ui-render"), ["PASS", "PASS", "PASS"], r.out);
    assert.ok(r.calls.includes("heavy node ui/scripts/build.mjs"), r.calls.join("\n"));
    assert.ok(r.calls.some((c) => c.startsWith("ui-model")), "model tests ran");
    assert.ok(r.calls.some((c) => /^heavy env CHROME=\S+ WASITME_RENDER_JOBS=1 node ui\/test\/render\.mjs --design$/.test(c)), r.calls.join("\n"));
    assert.ok(r.calls.includes("ui-render --design jobs=1 chrome=set"), r.calls.join("\n"));
    assert.ok(!r.calls.some((c) => c.startsWith("heavy node --test")), "model tests are light");
    const noChrome = t.run(["--only", "ui-render"], { CHROME: join(t.root, "missing-chrome") });
    assert.equal(noChrome.table["ui-render"].result, "SKIP");
    assert.match(noChrome.table["ui-render"].note, /no Chrome at /);
    assert.equal(t.run(["--only", "ui-render", "--prepublish"], { CHROME: join(t.root, "missing-chrome") }).table["ui-render"].result, "FAIL", "a render that did not run is not green under --prepublish");
  } finally {
    t.cleanup();
  }
});

test("app-capture: listed after the canvas build; opt-in by --capture, CI_LOCAL_CAPTURE=1 or --only; skipped otherwise and off macOS", () => {
  const t = makeRepo({ "macos/Package.swift": "// stub\n", "ui/package.json": "{}\n", "ui/dist/app.js": "" });
  try {
    writeExecutable(join(t.bin, "swift"), stubShell("swift"));
    writeExecutable(join(t.bin, "uname"), '#!/bin/sh\necho "${FAKE_UNAME:-Darwin}"\n');
    writeExecutable(join(t.root, "macos", ".build", "release", "WasitmeApp"), stubShell("app", 'echo "memory budget (release build, enforced): idle (app RSS): 33.6 MiB RSS, limit 60.0 MiB: PASS"'));
    const list = t.run(["--list"]);
    assert.match(list.out, /^app-capture\s+release app's offscreen --capture, memory budgets enforced \(heavy, opt-in: --capture\)$/m);
    const names = list.out.trim().split("\n").map((l) => l.split(/\s+/)[0]);
    assert.ok(names.indexOf("app-capture") > names.indexOf("ui-build"), "after ui-build, which makes ui/dist");
    const others = names.filter((n) => n !== "app-capture").join(",");
    const ran = (r) => r.calls.some((c) => c.startsWith("app ") || c === "swift build -c release");

    for (const env of [{}, { CI_LOCAL_CAPTURE: "0" }, { CI_LOCAL_CAPTURE: "yes" }]) {
      const r = t.run(["--skip", others], env);
      assert.equal(r.status, 0, r.out);
      assert.equal(r.table["app-capture"].result, "SKIP", JSON.stringify(env));
      assert.match(r.table["app-capture"].note, /^opt-in: pass --capture or CI_LOCAL_CAPTURE=1/);
      assert.ok(!ran(r), "nothing is built or captured unless requested");
    }
    for (const [args, env] of [[["--capture", "--skip", others], {}], [["--skip", others], { CI_LOCAL_CAPTURE: "1" }], [["--only", "app-capture"], {}]]) {
      const r = t.run(args, env);
      assert.equal(r.table["app-capture"].result, "PASS", `${args.join(" ")} ${JSON.stringify(env)}\n${r.out}`);
      assert.ok(ran(r));
    }
    const linux = t.run(["--only", "app-capture"], { FAKE_UNAME: "Linux" });
    assert.equal(linux.status, 0, linux.out);
    assert.equal(linux.table["app-capture"].result, "SKIP");
    assert.match(linux.table["app-capture"].note, /needs macOS/);
    assert.ok(!ran(linux));

    const pre = t.run(["--prepublish", "--skip", others]);
    assert.equal(pre.table["app-capture"].result, "FAIL", "a budget nobody measured is not green under --prepublish");
    assert.match(pre.table["app-capture"].note, /^skipped, not allowed under --prepublish: opt-in/);
    assert.equal(t.run(["--prepublish", "--capture", "--skip", others]).table["app-capture"].result, "PASS");
  } finally {
    t.cleanup();
  }
});

test("app-capture, requested: release build, then the capture through heavy.sh into the log dir; an OVER budget, a failed capture or no enforced budget FAILS", () => {
  const t = makeRepo({
    "macos/Package.swift": "// stub\n",
    "ui/package.json": "{}\n",
    "ui/scripts/build.mjs": 'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\nappendFileSync(process.env.CALLS, "ui-build\\n");\nmkdirSync("ui/dist", { recursive: true });\nwriteFileSync("ui/dist/app.js", "");\n',
  });
  // Stands in for the release binary: records its arguments and prints the budget lines the way CaptureLog.finish() does.
  const appStub = `#!/bin/sh
echo "app $*" >> "$CALLS"
mode=\${APP_MODE:-release build, enforced}
echo "capture: 332 PNGs, 40 checks passed, 0 failed -> $2"
echo "memory budget ($mode): idle (app RSS): 33.6 MiB RSS, limit 60.0 MiB: PASS"
echo "memory budget ($mode): Control Center open (app + WebContent RSS): \${APP_CC:-116.1} MiB RSS, limit 180.0 MiB: \${APP_CC_RESULT:-PASS}"
exit \${APP_EXIT:-0}
`;
  const app = join(t.root, "macos", ".build", "release", "WasitmeApp");
  try {
    writeExecutable(join(t.root, "scripts", "dev", "heavy.sh"), stubShell("heavy", 'exec "$@"'));
    writeExecutable(join(t.bin, "swift"), stubShell("swift", 'echo "swift-cwd $(basename "$PWD")" >> "$CALLS"'));
    writeExecutable(join(t.bin, "uname"), '#!/bin/sh\necho Darwin\n');
    writeExecutable(app, appStub);

    const r = t.run(["--only", "app-capture"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.table["app-capture"].result, "PASS");
    const capture = r.calls.find((c) => c.startsWith("app "));
    assert.match(capture, new RegExp(`^app --capture ${t.root}/wasitme-ci-local\\.\\w+/capture --fixtures contract/fixtures --canvas ui/dist$`), r.calls.join("\n"));
    const at = (c) => r.calls.indexOf(c);
    assert.deepEqual(
      [at("heavy node ui/scripts/build.mjs"), at("heavy swift build -c release"), at("swift-cwd macos")].map((i) => i >= 0),
      [true, true, true],
      `ui/dist was missing, so it is built; the release build runs in macos/ through heavy.sh\n${r.calls.join("\n")}`,
    );
    assert.ok(at("heavy swift build -c release") < r.calls.findIndex((c) => c.startsWith("heavy macos/.build/release/WasitmeApp --capture ")), "built, then captured through heavy.sh");
    assert.match(r.out, /memory budget \(release build, enforced\): Control Center open .*: PASS/, "the capture's own output is shown");
    assert.deepEqual(readdirSync(t.root).filter((n) => n.startsWith("wasitme-ci-local.")), [], "the PNGs go with the per-step logs");

    const again = t.run(["--only", "app-capture"]);
    assert.ok(!again.calls.includes("ui-build"), "an existing ui/dist is used as it is");

    const failing = [
      [{ APP_CC: "190.2", APP_CC_RESULT: "OVER", APP_EXIT: "1" }, /FAIL: a memory budget is over/],
      [{ APP_CC: "190.2", APP_CC_RESULT: "OVER" }, /FAIL: a memory budget is over/], // even if the binary exited 0
      [{ APP_EXIT: "1" }, /FAIL: the capture exited 1/],
      [{ APP_EXIT: "2" }, /FAIL: the capture exited 2/],
      [{ APP_MODE: "debug build, reported only" }, /FAIL: the capture reported no enforced memory budget/],
    ];
    for (const [env, message] of failing) {
      const bad = t.run(["--only", "app-capture"], env);
      assert.equal(bad.status, 1, `${JSON.stringify(env)}\n${bad.out}`);
      assert.equal(bad.table["app-capture"].result, "FAIL", JSON.stringify(env));
      assert.match(bad.out, message);
    }

    spawnSync("rm", ["-f", app]);
    const noBinary = t.run(["--only", "app-capture"]);
    assert.equal(noBinary.table["app-capture"].result, "FAIL");
    assert.match(noBinary.out, /FAIL: swift build -c release left no executable at macos\/\.build\/release\/WasitmeApp/);

    writeExecutable(join(t.bin, "swift"), stubShell("swift", "exit 1"));
    writeExecutable(app, appStub);
    const broken = t.run(["--only", "app-capture"]);
    assert.equal(broken.table["app-capture"].result, "FAIL", "a release build that fails fails the step");
    assert.ok(!broken.calls.some((c) => c.startsWith("app ")), "and nothing is captured");
  } finally {
    t.cleanup();
  }
});

test("review #14: --prepublish turns every skip into a FAIL and passes the strict flags", () => {
  const t = makeRepo();
  try {
    const all = t.run(["--prepublish", "--keep-going"]);
    assert.equal(all.status, 1);
    for (const s of ["plugin-validate", "mod-allowlist", "shellcheck", "swift-build", "app-capture"]) {
      assert.equal(all.table[s].result, "FAIL", s);
      assert.match(all.table[s].note, /^skipped, not allowed under --prepublish: /, s);
    }
    assert.match(all.out.trim().split("\n").pop(), /^ci-local: FAIL \(--prepublish; /);
    assert.ok(all.calls.includes("check-privacy --require-canaries docs"), all.calls.join("\n"));
    assert.ok(all.calls.includes("lint-copy --require-copy"));
    assert.ok(all.calls.includes("check-repo --strict --require-email-config"));
    assert.ok(all.calls.includes("check-repo --git-identity --require-email-config"), "git-identity runs under --prepublish");
  } finally {
    t.cleanup();
  }
});

test("review #14: Swift sources without a Package.swift fail the Swift steps; an already-CLT toolchain stays an allowed skip", () => {
  const t = makeRepo({ "macos/App/Sources/A.swift": "let a = 1\n", "macos/reference/spike/B.swift": "let b = 1\n" });
  try {
    writeExecutable(join(t.bin, "swift"), stubShell("swift"));
    const r = t.run(["--only", "swift-build,swift-test,swift-build-clt", "--keep-going"]);
    assert.equal(r.status, 1);
    for (const s of ["swift-build", "swift-test", "swift-build-clt"]) assert.equal(r.table[s].result, "FAIL", s);
    assert.match(r.out, /macos\/ has Swift sources but no Package\.swift/);
  } finally {
    t.cleanup();
  }
  const spikeOnly = makeRepo({ "macos/reference/spike/B.swift": "let b = 1\n" });
  try {
    const r = spikeOnly.run(["--only", "swift-build"]);
    assert.equal(r.table["swift-build"].result, "SKIP", "reference/ spike code alone is not a package to build");
  } finally {
    spikeOnly.cleanup();
  }
  const clt = makeRepo({ "macos/Package.swift": "// stub\n" });
  try {
    writeExecutable(join(clt.root, "CLT", "usr", "bin", "swift"), stubShell("clt-swift"));
    const dev = join(clt.root, "CommandLineToolsDev");
    mkdirSync(dev, { recursive: true });
    const r = clt.run(["--only", "swift-build-clt", "--prepublish"], { CI_LOCAL_CLT_DIR: join(clt.root, "CLT"), XCODE_SELECT_P: dev });
    assert.equal(r.table["swift-build-clt"].result, "SKIP", r.out);
    assert.match(r.table["swift-build-clt"].note, /already is the Command Line Tools/);
  } finally {
    clt.cleanup();
  }
});

const hasDash = spawnSync("sh", ["-c", "command -v dash"], { stdio: "ignore" }).status === 0;

test("review #15: sh-syntax checks non-ASCII file names and runs dash -n on sh scripts", { skip: !hasGit }, () => {
  const t = makeRepo({ "scripts/café.sh": "#!/bin/sh\nif then fi\n" });
  try {
    git(t.root, "init", "-q");
    git(t.root, "add", "-A");
    const r = t.run(["--only", "sh-syntax"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAIL\s+scripts\/caf\S*\.sh/, "the accented name is checked, not silently skipped");
  } finally {
    t.cleanup();
  }
});

test("review #15: a bashism that macOS sh accepts but dash rejects fails sh-syntax", { skip: !hasDash }, () => {
  const t = makeRepo({ "scripts/arr.sh": "#!/bin/sh\nx=(1 2 3)\necho \"$x\"\n" });
  try {
    const r = t.run(["--only", "sh-syntax"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAIL\s+scripts\/arr\.sh \(shell syntax error under (?:dash|sh) -n\)/);
  } finally {
    t.cleanup();
  }
});

test("review #15: shellcheck runs on sh/bash scripts when installed and skips loudly when not", () => {
  const t = makeRepo({ "scripts/ok.sh": "#!/bin/sh\necho ok\n", "scripts/b.sh": "#!/usr/bin/env bash\necho b\n", "scripts/z.sh": "#!/bin/zsh\necho z\n" });
  try {
    const missing = t.run(["--only", "shellcheck"]);
    assert.equal(missing.table.shellcheck.result, "SKIP");
    assert.match(missing.table.shellcheck.note, /shellcheck is not installed/);
    const sc = join(t.bin, "shellcheck-stub");
    writeExecutable(sc, stubShell("shellcheck", 'case "$*" in *bad*) exit 1;; esac'));
    const ok = t.run(["--only", "shellcheck"], { CI_LOCAL_SHELLCHECK: sc });
    assert.equal(ok.status, 0, ok.out);
    assert.ok(ok.calls.includes("shellcheck --severity=warning --shell=sh scripts/ok.sh"), ok.calls.join("\n"));
    assert.ok(ok.calls.includes("shellcheck --severity=warning --shell=bash scripts/b.sh"));
    assert.ok(!ok.calls.some((c) => c.includes("z.sh")), "shellcheck has no zsh support");
    writeFileSync(join(t.root, "scripts", "bad.sh"), "#!/bin/sh\necho bad\n");
    assert.equal(t.run(["--only", "shellcheck"], { CI_LOCAL_SHELLCHECK: sc }).status, 1);
  } finally {
    t.cleanup();
  }
});

test("review #19: no-network scans the plugin mod, hook scripts and macOS sources; mod-allowlist runs when plugin/ exists", () => {
  const t = makeRepo({ "plugin/mod/a.ts": "export {};\n", "plugin/scripts/s.sh": "#!/bin/sh\n", "macos/Sources/A.swift": "let a = 1\n", "engine/src/x.ts": "export {};\n" });
  try {
    const r = t.run(["--only", "no-network,mod-allowlist"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.calls.includes("check-no-network --host-module claude-code engine/src plugin/mod plugin/scripts macos/Sources"), r.calls.join("\n"));
    assert.ok(r.calls.includes("check-mod-allowlist plugin"));
  } finally {
    t.cleanup();
  }
});

test("review #20: TERM stops the running step's whole process tree promptly", async () => {
  const t = makeRepo();
  try {
    // npm test sleeps; the marker argument makes the sleeping process findable (and killable) afterwards.
    writeExecutable(join(t.bin, "npm"), '#!/bin/sh\necho "npm $*" >> "$CALLS"\ncase "$*" in test) sleep 47.25 ;; esac\n');
    const env = { PATH: `${t.bin}:/usr/bin:/bin`, HOME: t.root, TMPDIR: t.root, CALLS: join(t.root, "calls.log"), CI_LOCAL_NO_HEAVY: "1", CI_LOCAL_CLT_DIR: join(t.root, "no-clt") };
    const child = spawn("sh", [join(t.root, "scripts", "ci-local.sh"), "--only", "test"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    child.kill("SIGTERM");
    const status = await new Promise((r) => child.on("exit", (code, signal) => r(code ?? signal)));
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 300));
    // Anchored: an unanchored -f pattern also matches any shell whose own command line mentions the marker.
    const left = spawnSync("pgrep", ["-f", "^sleep 47\\.25$"], { encoding: "utf8" }).stdout.trim();
    if (left) spawnSync("pkill", ["-f", "^sleep 47\\.25$"]);
    assert.equal(status, 143, out);
    assert.ok(elapsed < 5000, `took ${elapsed} ms`);
    assert.equal(left, "", "the step's sleep was stopped too");
    assert.match(out, /interrupted; stopped the running step/);
  } finally {
    t.cleanup();
  }
});
