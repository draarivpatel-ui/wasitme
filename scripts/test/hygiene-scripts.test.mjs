// Tests for check-no-network.mjs (Swift, shell and host-module support added in WP-01Δ), check-mod-allowlist.mjs, and
// static guards on the workflow wiring that cannot run here (GitHub Actions) and on .gitignore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifySpecifier, scanDirectories, scanShellSource, scanSource, scanSwiftSource } from "../check-no-network.mjs";
import { main as modMain, modFindings } from "../check-mod-allowlist.mjs";
import { makeTree, REPO_ROOT, runMain, runNode, SCRIPTS_DIR } from "./helpers.mjs";

test("review #19: check-no-network: host modules, Swift networking APIs and shell network clients", () => {
  assert.equal(classifySpecifier("claude-code").ok, false);
  assert.equal(classifySpecifier("claude-code", ["claude-code"]).ok, true);
  assert.equal(classifySpecifier("claude-code/testing", ["claude-code"]).ok, true);
  assert.equal(classifySpecifier("claude-codex", ["claude-code"]).ok, false);
  assert.equal(scanSource('import { $ } from "claude-code";', "m.ts", { hostModules: ["claude-code"] }).violations.length, 0);

  assert.deepEqual(scanSwiftSource("import Foundation\n// URLSession\nlet s = \"NWConnection\"\n").violations, []);
  assert.deepEqual(scanSwiftSource("import Network\nlet c = URLSession.shared\n").violations.map((v) => [v.rule, v.line]), [["swift-network-import", 1], ["swift-network-api", 2]]);
  assert.deepEqual(scanShellSource('#!/bin/sh\n# curl\necho "wget"\n').violations, []);
  assert.deepEqual(scanShellSource("#!/bin/sh\ncurl -s x\n").violations.map((v) => v.line), [2]);

  const t = makeTree({ "Sources/A.swift": "import AppKit\n", "scripts/hook.sh": "#!/bin/sh\necho ok\n", "mod/a.ts": 'import x from "claude-code";\n' });
  try {
    const r = scanDirectories([join(t.root, "Sources"), join(t.root, "scripts"), join(t.root, "mod")], { hostModules: ["claude-code"] });
    assert.deepEqual(r.violations, []);
    assert.equal(r.filesScanned, 3);
    const cli = runNode(join(SCRIPTS_DIR, "check-no-network.mjs"), ["--host-module", "claude-code", join(t.root, "mod")]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(runNode(join(SCRIPTS_DIR, "check-no-network.mjs"), [join(t.root, "mod")]).status, 1, "without the flag the host import is a dependency");
  } finally {
    t.cleanup();
  }
});

test("review #19: the real macOS app sources have no networking code (verified, not assumed)", () => {
  const dir = join(REPO_ROOT, "macos", "Sources");
  const r = scanDirectories([dir]);
  if (r.violations.some((v) => v.rule === "missing-directory")) return; // a checkout without macos/
  assert.deepEqual(r.violations, []);
  assert.ok(r.filesScanned > 0);
});

test("review #19: check-mod-allowlist (ported from ci.yml) ignores comments but not calls", () => {
  assert.deepEqual(modFindings("// the environment (`$.fs` does not expand `~`)\n/* $.http.fetch */\n$.fs.read(p)\n"), []);
  const bad = modFindings('$.process.run("x")\nconst f = $.fs\n$.fs.writeFile(p, d)\n$.on("prompt.submit", h)\n$["env"]\n$.session.messages()\n');
  assert.deepEqual(bad.map((b) => b.line), [1, 2, 3, 4, 5, 6]);
  const t = makeTree({ "plugin/mod/a.ts": "// $.fs mention\n$.fs.read(p)\n", "plugin/tests/x.ts": "export {};\n" });
  try {
    assert.equal(runMain(modMain, [join(t.root, "plugin")]).code, 0);
    const missing = runMain(modMain, [join(t.root, "nope")]);
    assert.equal(missing.code, 0);
    assert.match(missing.out, /SKIPPED/);
  } finally {
    t.cleanup();
  }
});

test("review #2: workflow wiring: the release gate passes the email secret; repo greps require it except on fork PRs", () => {
  const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(ci, /workflow_call:\n(?:\s+#.*\n)*\s+secrets:\n\s+WASITME_FORBIDDEN_EMAILS:\n\s+required: false/);
  assert.match(release, /uses: \.\/\.github\/workflows\/ci\.yml\n(?:\s+#.*\n)*\s+secrets:\n\s+WASITME_FORBIDDEN_EMAILS: \$\{\{ secrets\.WASITME_FORBIDDEN_EMAILS \}\}/);
  assert.match(ci, /check-repo\.mjs --strict \$\{\{ \(\(github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository\) && github\.actor != 'dependabot\[bot\]'\) && '--require-email-config' \|\| '' \}\}/);
  assert.match(ci, /check-no-network\.mjs --host-module claude-code/);
  assert.match(ci, /node scripts\/check-mod-allowlist\.mjs plugin/);
  assert.match(ci, /shellcheck --severity=warning/);
});

test("review #2: .ci-local.env is gitignored (it holds the maintainer's address)", () => {
  const ignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
  assert.ok(ignore.includes(".ci-local.env"), ".gitignore must list .ci-local.env");
});
