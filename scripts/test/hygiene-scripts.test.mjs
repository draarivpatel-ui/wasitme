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

test("bug hunt 2026-10-09: check-no-network sees process.getBuiltinModule, absolute-path network commands and the NSURL / raw-string URL forms", () => {
  const rules = (src) => scanSource(src, "t.ts").violations.map((v) => v.rule);
  // process.getBuiltinModule loads node:http or child_process with no import, so it is refused whatever the receiver.
  assert.deepEqual(rules('const http = process.getBuiltinModule("node:http");'), ["dynamic-module-load"]);
  assert.deepEqual(rules('const cp = process.getBuiltinModule("child_process");'), ["dynamic-module-load"]);
  assert.deepEqual(rules('const net = globalThis.process.getBuiltinModule("net");'), ["dynamic-module-load"]);
  assert.deepEqual(rules('const m = process?.getBuiltinModule("fs");'), ["dynamic-module-load"]);
  assert.deepEqual(rules("// process.getBuiltinModule is mentioned here\nconst s = 'getBuiltinModule';"), [], "prose and strings still pass");

  // Shell: a command called by absolute or relative path is still that command (the plugin hooks call every tool by
  // absolute path, so that is the style an accidental call would take).
  const shell = (src) => scanShellSource(src, "t.sh").violations.map((v) => v.rule);
  assert.deepEqual(shell("/usr/bin/curl -fsS https://example.test/x\n"), ["shell-network-command"]);
  assert.deepEqual(shell('x=$(/usr/bin/wget -qO- "$u")\n'), ["shell-network-command"]);
  assert.deepEqual(shell("if true; then ./nc -l 8080; fi\n"), ["shell-network-command"]);
  assert.deepEqual(shell("/usr/bin/ssh host true\n"), ["shell-network-command"]);
  assert.deepEqual(shell("/usr/bin/head -c 10 \"$f\"\n/bin/launchctl kickstart x\n/usr/bin/ssh-keygen -l\n/usr/bin/sed s/a/b/\n"), []);

  // Swift: NSURL and raw string literals with a network scheme.
  const swift = (src) => scanSwiftSource(src, "t.swift").violations.map((v) => v.rule);
  assert.deepEqual(swift('let u = NSURL(string: "https://example.invalid/x")\n'), ["swift-network-url"]);
  assert.deepEqual(swift('let u = URL(string: #"https://example.invalid/x"#)!\n'), ["swift-network-url"]);
  assert.deepEqual(swift('let u = URL(string: ##"wss://example.invalid/x"##)!\n'), ["swift-network-url"]);
  assert.deepEqual(swift('let u = URL(string: "wasitme-app://app/index.html")!\nlet v = NSURL(string: #"wasitme-app://x"#)\n'), []);

  // Lexer: a regex literal right after `)` or `}` that holds a backtick or `/*` must not hide the lines that follow.
  const tail = 'import net from "node:net";\nconst r = await fetch("https://example.invalid");\n';
  for (const [name, head] of [
    ["class with /* after )", "if (ok) /[/*]/.test(s);\n"],
    ["backtick after )", "if (ok) /`/.test(s);\n"],
    ["class with /* after }", "function f() {}\n/[/*]/.test(s);\n"],
    ["backtick after }", "function f() {}\n/`/.test(s);\n"],
  ]) {
    assert.deepEqual(rules(head + tail), ["network-module", "network-global"], name);
    assert.deepEqual(rules(head + tail + "// */\n"), ["network-module", "network-global"], `${name}, with a closing */ later`);
  }
  // Division still reads as division (and a real block comment after it still comments).
  assert.deepEqual(rules("const a = (b) / c; /* note */\nconst d = (e) / f / g;\n"), []);
  assert.deepEqual(rules("const t = (a) / `x` / 2;\n" + tail), ["network-module", "network-global"]);
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
