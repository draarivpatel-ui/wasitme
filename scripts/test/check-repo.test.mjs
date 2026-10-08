import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import {
  assetFindings, bufferHasEmail, emailFindings, emailMatchers, gitIdentityFindings, homePathFindings, isAssetScope,
  isGithubNoreply, isPlaceholderName, isSwiftScope, loadForbiddenEmails, main, parseEnvFile, stringBuiltJsFindings,
} from "../check-repo.mjs";
import { git, hasGit, makeTree, runMain, runNode, SCRIPTS_DIR } from "./helpers.mjs";

// Home-path samples are assembled from pieces so this file does not trip the very check it tests.
const homePath = (root, name, ...rest) => ["", root, name, ...rest].join("/");
const REAL_LOOKING = homePath("Users", "jdoe", "projects", "app.ts");
const EMAIL = "someone" + "@example.invalid"; // synthetic; never a real address

const noEnv = {}; // an environment with no WASITME_FORBIDDEN_EMAILS

test("abs-home-path: real-looking names are findings, placeholders and look-alikes are not", () => {
  assert.equal(homePathFindings(`open ${REAL_LOOKING}`).length, 1);
  assert.equal(homePathFindings(`open ${homePath("home", "jdoe", "x")}`).length, 1);
  assert.equal(homePathFindings(["C:", "Users", "jdoe", "Desktop"].join("\\")).length, 1, "Windows form");
  assert.equal(homePathFindings(`a\n${REAL_LOOKING}\nb\n${REAL_LOOKING}`).map((f) => f.line).join(), "2,4");
  for (const ok of [
    homePath("Users", "<you>", ".wasitme"), homePath("Users", "$USER", "x"), homePath("Users", "${USER}", "x"),
    homePath("Users", "x", "a"), homePath("Users", "someone", "a"), homePath("Users", "canary", "a"),
    homePath("Users", "SECRETPERSON", "a"), homePath("Users", "SENTINEL_FILE", "a"), homePath("Users", "sentinel-path"),
    homePath("home", "x"), homePath("Users", "Shared"), homePath("Users", "WASITME-CANARY-1"),
    "/synthetic/home/project-alpha", // not a /home/<name> root
    "src/Users/helper.ts", // a directory that happens to be called Users
    "https://example.com/Users/profile", // a URL path is not a home directory
  ]) {
    assert.equal(homePathFindings(ok).length, 0, ok);
  }
  assert.ok(isPlaceholderName("<you>") && isPlaceholderName("example") && !isPlaceholderName("jdoe"));
});

test("forbidden-email: matching, case-insensitivity, no echo, and the three ways to configure it", () => {
  assert.equal(emailFindings(`contact: ${EMAIL.toUpperCase()}`, [EMAIL]).length, 1);
  assert.equal(emailFindings("nothing here", [EMAIL]).length, 0);

  assert.deepEqual(parseEnvFile(`# c\nexport A=1\nWASITME_FORBIDDEN_EMAILS="a@b.example, c@d.example"\nbad line\n`), { A: "1", WASITME_FORBIDDEN_EMAILS: "a@b.example, c@d.example" });

  const t = makeTree({ "a.txt": "x" });
  try {
    assert.deepEqual(loadForbiddenEmails(t.root, noEnv).literals, [], "unconfigured");
    assert.deepEqual(loadForbiddenEmails(t.root, { WASITME_FORBIDDEN_EMAILS: "A@b.example, c@d.example" }).literals, ["a@b.example", "c@d.example"]);
    writeFileSync(join(t.root, ".ci-local.env"), `WASITME_FORBIDDEN_EMAILS=${EMAIL}\n`);
    const fromFile = loadForbiddenEmails(t.root, noEnv);
    assert.deepEqual(fromFile.literals, [EMAIL]);
    assert.equal(fromFile.source, ".ci-local.env");
    assert.throws(() => loadForbiddenEmails(t.root, { WASITME_FORBIDDEN_EMAILS: "abc" }), /shorter than 5/);
  } finally {
    t.cleanup();
  }
});

test("forbidden-email: CLI reports file and line without echoing the address; the env file itself is never scanned", () => {
  const t = makeTree({ "docs/a.md": `line one\nreach me at ${EMAIL}\n`, ".ci-local.env": `WASITME_FORBIDDEN_EMAILS=${EMAIL}\n` });
  try {
    const r = runMain(main, ["--root", t.root, "--rules", "forbidden-email"], noEnv);
    assert.equal(r.code, 1);
    assert.match(r.err, /docs\/a\.md:2: \[forbidden-email\]/);
    assert.ok(!r.err.includes(EMAIL) && !r.out.includes(EMAIL), "the address is never echoed");
    assert.ok(!r.err.includes(".ci-local.env:"), "the private config file is not scanned");
  } finally {
    t.cleanup();
  }
});

test("forbidden-email: unconfigured is a loud skip (exit 0) unless --require-email-config (exit 2)", () => {
  const t = makeTree({ "a.md": "hello\n" });
  try {
    const skipped = runMain(main, ["--root", t.root], noEnv);
    assert.equal(skipped.code, 0);
    assert.match(skipped.err, /check-repo: SKIPPED forbidden-email/);
    const required = runMain(main, ["--root", t.root, "--require-email-config"], noEnv);
    assert.equal(required.code, 2);
    assert.match(required.err, /no forbidden email configured/);
    const tooShort = runMain(main, ["--root", t.root], { WASITME_FORBIDDEN_EMAILS: "ab" });
    assert.equal(tooShort.code, 2);
    // running only the other rules never needs the config
    assert.equal(runMain(main, ["--root", t.root, "--rules", "abs-home-path", "--require-email-config"], noEnv).code, 0);
  } finally {
    t.cleanup();
  }
});

test("forbidden-email: a linked git worktree falls back to the main worktree's .ci-local.env", { skip: !hasGit }, () => {
  const main1 = makeTree({ ".gitignore": ".ci-local.env\n", ".ci-local.env": `WASITME_FORBIDDEN_EMAILS=${EMAIL}\n`, "a.md": "x\n" });
  const wt = makeTree({});
  try {
    git(main1.root, "init", "-q", "-b", "main");
    git(main1.root, "add", ".gitignore", "a.md");
    git(main1.root, "commit", "-q", "-m", "init");
    const added = git(main1.root, "worktree", "add", "-q", join(wt.root, "linked"), "-b", "wt");
    assert.equal(added.status, 0, added.stderr);
    const linked = join(wt.root, "linked");
    assert.deepEqual(loadForbiddenEmails(linked, noEnv).literals, [EMAIL], "found via git, not via a hardcoded path");
    writeFileSync(join(linked, "leak.md"), `mail ${EMAIL}\n`);
    const r = runMain(main, ["--root", linked, "--rules", "forbidden-email"], noEnv);
    assert.equal(r.code, 1);
    assert.match(r.err, /leak\.md:1:/);
  } finally {
    wt.cleanup();
    main1.cleanup();
  }
});

test("remote-asset-url: remote scripts, styles, fonts, images and imports are findings; links and namespaces are not", () => {
  const bad = [
    '<script src="https://cdn.example.com/x.js"></script>',
    "<script\n  defer\n  src='//cdn.example.com/x.js'></script>",
    '<link rel="stylesheet" href="https://fonts.example.com/css?family=X">',
    '<link href=https://fonts.example.com/a.css rel=preload as=font>',
    '<img alt="" src="http://example.com/p.png">',
    '<iframe src="https://example.com/embed"></iframe>',
    '@import url("https://fonts.example.com/css");',
    "@import 'https://fonts.example.com/css';",
    "@font-face { src: url(https://fonts.example.com/f.woff2) format('woff2'); }",
    ".x { background: url( '//cdn.example.com/b.png' ) }",
    '<use xlink:href="https://example.com/sprite.svg#a"/>',
  ];
  for (const text of bad) assert.equal(assetFindings(text).length, 1, text);
  assert.equal(assetFindings("a\nb\n<script\nsrc=\"https://x.example/y.js\"></script>").map((f) => f.line).join(), "3");

  const good = [
    '<script src="app.js"></script>',
    '<script src="./app.js" type="module"></script>',
    '<a href="https://github.com/example/wasitme">source</a>',
    '<link rel="canonical" href="https://example.com/">',
    '<link rel="stylesheet" href="app.css">',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
    '.x { background: url("data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'/>") }',
    ".y { background: url(img/a.png) }",
    '<img src="data:image/png;base64,AAAA" alt="">',
    "const s = 'https://example.com/docs'; // a plain URL string is not a load",
  ];
  for (const text of good) assert.equal(assetFindings(text).length, 0, text);
});

test("remote-asset-url: scope is shipped code only (not docs, design, tests, reference)", () => {
  for (const rel of ["ui/app.html", "ui/src/style.css", "engine/src/output/report.ts", "plugin/skills/x/page.html", "packaging/a.html", "macos/Sources/Page.swift"]) {
    assert.ok(isAssetScope(rel), rel);
  }
  for (const rel of ["docs/METHOD.md", "design/preview.html", "ui/test/page.html", "ui/reference/old.html", "ui/node_modules/p/a.js", "scripts/check-repo.mjs", "engine/test/x.ts", "README.md"]) {
    assert.ok(!isAssetScope(rel), rel);
  }
  const t = makeTree({ "ui/app.html": '<script src="https://x.example/a.js"></script>\n', "design/mock.html": '<script src="https://x.example/a.js"></script>\n' });
  try {
    const r = runMain(main, ["--root", t.root, "--rules", "remote-asset-url"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /ui\/app\.html:1: \[remote-asset-url\]/);
    assert.ok(!r.err.includes("design/"));
  } finally {
    t.cleanup();
  }
});

const swift = (body) => `import WebKit\nfinal class Bridge {\n${body}\n}\n`;

test("string-built-js: interpolation, concatenation, variables and format strings are findings", () => {
  const cases = [
    'web.callAsyncJavaScript("render(\\(json))", arguments: [:], in: nil, in: .page)',
    'web.callAsyncJavaScript("a" + b, arguments: [:])',
    "web.callAsyncJavaScript(body, arguments: [:])",
    'web.evaluateJavaScript("setState(\\(state))")',
    'web.evaluateJavaScript("x" + y) { _, _ in }',
    "try await web.evaluateJavaScript(script)",
    'web.evaluateJavaScript(String(format: "f(%@)", v))',
    'let s = WKUserScript(source: "var a = \\(v)", injectionTime: .atDocumentStart, forMainFrameOnly: true)',
    "let s = WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true)",
    'web.callAsyncJavaScript(#"render(\\#(json))"#, arguments: [:])',
  ];
  for (const c of cases) {
    const found = stringBuiltJsFindings(swift(c));
    assert.equal(found.length, 1, c);
    assert.equal(found[0].line, 3);
  }
});

test("string-built-js: constant literals, declarations, comments and strings are fine", () => {
  const cases = [
    'web.callAsyncJavaScript("return window.render(snap)", arguments: ["snap": decoded], in: nil, in: .page)',
    'web.evaluateJavaScript("document.documentElement.dataset.marker") { _, _ in }',
    'try await web.evaluateJavaScript(#"document.title"#)',
    'web.callAsyncJavaScript("""\n  return 1\n  """, arguments: [:])',
    'let s = WKUserScript(source: "window.__x = 1", injectionTime: .atDocumentStart, forMainFrameOnly: true)',
    "func evaluateJavaScript(_ js: String) async throws {}",
    '// web.evaluateJavaScript("x" + y)',
    'let doc = "call evaluateJavaScript(js) to ..."',
    "/* callAsyncJavaScript(body) */",
  ];
  for (const c of cases) assert.deepEqual(stringBuiltJsFindings(swift(c)), [], c);
});

test("string-built-js: the allow marker needs a reason, on the line or the line above", () => {
  const call = "web.evaluateJavaScript(constantScript)";
  assert.equal(stringBuiltJsFindings(swift(`${call} // wasitme:allow-string-js -- constantScript is a static let literal`)).length, 0);
  assert.equal(stringBuiltJsFindings(swift(`// wasitme:allow-string-js -- audited constant\n${call}`)).length, 0);
  const noReason = stringBuiltJsFindings(swift(`${call} // wasitme:allow-string-js`));
  assert.equal(noReason.length, 1);
  assert.match(noReason[0].problem, /needs a reason/);
  assert.equal(stringBuiltJsFindings(swift(`// wasitme:allow-string-js -- reason\n\n${call}`)).length, 1, "two lines away does not count");
});

test("string-built-js: scope is Swift under macos/ including Tests, excluding reference and .build", () => {
  assert.ok(isSwiftScope("macos/Sources/App/Bridge.swift"));
  assert.ok(isSwiftScope("macos/Tests/AppTests/BridgeTests.swift"));
  assert.ok(!isSwiftScope("macos/reference/menubar-spike/x.swift"));
  assert.ok(!isSwiftScope("macos/.build/checkouts/x.swift"));
  assert.ok(!isSwiftScope("engine/src/x.swift"));
  assert.ok(!isSwiftScope("macos/Sources/x.ts"));
  const t = makeTree({
    "macos/Sources/Bridge.swift": swift('web.evaluateJavaScript("f(\\(x))")'),
    "macos/reference/spike/Bridge.swift": swift('web.evaluateJavaScript("f(\\(x))")'),
  });
  try {
    const r = runMain(main, ["--root", t.root, "--rules", "string-built-js"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /macos\/Sources\/Bridge\.swift:3: \[string-built-js\] evaluateJavaScript/);
    assert.ok(!r.err.includes("reference"));
  } finally {
    t.cleanup();
  }
});

test("allow-list, --strict and stale entries", () => {
  const t = makeTree({
    "CLAUDE.md": `helper at ${REAL_LOOKING} for agents\n`,
    "notes.md": "clean\n",
    "scripts/check-repo.allow": "abs-home-path | CLAUDE.md | for agents | the agent instructions name a helper path; scrub before publishing\n",
  });
  try {
    const ok = runMain(main, ["--root", t.root, "--rules", "abs-home-path"]);
    assert.equal(ok.code, 0, ok.err);

    const strict = runMain(main, ["--root", t.root, "--rules", "abs-home-path", "--strict"]);
    assert.equal(strict.code, 1, "--strict ignores the allow-list");
    assert.match(strict.out, /strict: allow-list ignored/);

    writeFileSync(join(t.root, "scripts", "check-repo.allow"), "abs-home-path | CLAUDE.md | for agents | ok\nabs-home-path | CLAUDE.md | text that is gone | stale\n");
    const stale = runMain(main, ["--root", t.root]);
    assert.equal(stale.code, 1);
    assert.match(stale.err, /\[stale-allow\]/);
    assert.equal(runMain(main, ["--root", t.root, "--rules", "abs-home-path"]).code, 0, "no staleness check on a rule subset");

    for (const bad of ["abs-home-path | a | b", "forbidden-email | a | b | why", "unknown | a | b | why"]) {
      writeFileSync(join(t.root, "scripts", "check-repo.allow"), bad + "\n");
      assert.equal(runMain(main, ["--root", t.root]).code, 2, bad);
    }
  } finally {
    t.cleanup();
  }
});

test("CLI: usage errors, vacuous scans, and the process exit codes", () => {
  assert.equal(runMain(main, ["--bogus"]).code, 2);
  assert.equal(runMain(main, ["--rules", "nope"]).code, 2);
  assert.equal(runMain(main, ["--list-rules"]).code, 0);
  const empty = makeTree({});
  const dirty = makeTree({ "a.md": `see ${REAL_LOOKING}\n` });
  try {
    assert.equal(runMain(main, ["--root", empty.root], noEnv).code, 2, "nothing to scan");
    const r = runNode(join(SCRIPTS_DIR, "check-repo.mjs"), ["--root", dirty.root], { env: { ...process.env, WASITME_FORBIDDEN_EMAILS: "" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a\.md:1: \[abs-home-path\]/);
    assert.ok(!r.stderr.includes("jdoe"), "the name is not echoed");
  } finally {
    empty.cleanup();
    dirty.cleanup();
  }
});

test("--walk-all: an unpacked release tree's dist/ (the shipped code) is scanned too", () => {
  const t = makeTree({ "README.md": "fine\n", "engine/dist/src/cli/main.js": `const p = "${REAL_LOOKING}";\n` });
  try {
    const plain = runMain(main, ["--root", t.root, "--rules", "abs-home-path"], noEnv);
    assert.equal(plain.code, 0, "a source-tree walk skips dist/ (build output)");
    assert.match(plain.out, /1 file\(s\) scanned/);
    const all = runMain(main, ["--root", t.root, "--rules", "abs-home-path", "--walk-all"], noEnv);
    assert.equal(all.code, 1, "with --walk-all the home path in dist/ is a finding");
    assert.match(all.err, /engine\/dist\/src\/cli\/main\.js:1: \[abs-home-path\]/);
    assert.match(all.out, /2 file\(s\) scanned/);
    assert.ok(!isAssetScope("ui/dist/app.html"), "in a source tree ui/dist is build output");
    assert.ok(isAssetScope("ui/dist/app.html", { releaseTree: true }), "in a release tree it is the shipped page");
    assert.ok(isAssetScope("engine/dist/src/output/report.js", { releaseTree: true }), "and the compiled engine ships too");
    assert.ok(!isAssetScope("plugin/tests/x.ts", { releaseTree: true }), "tests stay out of scope");
  } finally {
    t.cleanup();
  }
});

test("binary and oversized files are not scanned", () => {
  const t = makeTree({ "ok.md": "fine\n" });
  try {
    writeFileSync(join(t.root, "blob.bin"), Buffer.concat([Buffer.from(`${REAL_LOOKING}\0`), Buffer.alloc(10)]));
    writeFileSync(join(t.root, "huge.txt"), `${REAL_LOOKING}\n` + "x".repeat(5 * 1024 * 1024)); // over the 4 MB limit
    const r = runMain(main, ["--root", t.root, "--rules", "abs-home-path"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /1 file\(s\) scanned/);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Review fixes (WP-01Δ). Every sample is assembled from pieces, so this file never trips the check it tests.
// ---------------------------------------------------------------------------------------------------------------

const dashPath = (...parts) => ["", ...parts, ""].join("-"); // -Users-<name>-projects-

test("review #1: the synthetic corpus user (syn-user) is a placeholder; real names are still findings", () => {
  for (const name of ["syn-user", "syn_user", "syn", "SYN-USER"]) assert.ok(isPlaceholderName(name), name);
  for (const name of ["jdoe", "synthia", "synonym", "aliceb"]) assert.ok(!isPlaceholderName(name), name);
  assert.equal(homePathFindings(homePath("Users", "syn-user", "code", "app")).length, 0);
  assert.equal(homePathFindings(homePath("Users", "synthia", "code")).length, 1, "a name that merely starts with syn is real");
  assert.equal(homePathFindings(`cwd ${dashPath("Users", "syn", "user", "code")}`).length, 0, "the dash encoding of syn-user");
});

test("review #9: mounted prefixes, JSON-escaped Windows paths; globs, regex, one-letter and node names pass", () => {
  for (const bad of [
    ["", "System", "Volumes", "Data", "Users", "jdoe", "x"].join("/"),
    ["", "Volumes", "Backup", "Users", "jdoe", "x"].join("/"),
    ["", "mnt", "c", "Users", "jdoe", "x"].join("/"),
    ["", "private", "Users", "jdoe"].join("/"),
    JSON.stringify(["C:", "Users", "jdoe", "x"].join("\\")), // a Windows path as it appears in JSON (doubled backslashes)
  ]) {
    assert.equal(homePathFindings(bad).length, 1, bad);
  }
  for (const ok of [
    homePath("Users", "*", "Library"), homePath("Users", "[a-z]+", "Library"), homePath("Users", "(.+)", "x"),
    homePath("home", "node", "app"), homePath("home", "u", ".claude"), homePath("Users", "x", "a"),
    "src" + homePath("Users", "jdoe"), // a directory named Users inside a project is not a home
  ]) {
    assert.equal(homePathFindings(ok).length, 0, ok);
  }
});

test("review #6: Claude's project-directory encoding is a home path; flags and CSS names are not", () => {
  assert.equal(homePathFindings(`dir ${dashPath("Users", "jdoe", "Documents", "foo")}`).length, 1);
  assert.equal(homePathFindings(`dir "${dashPath("home", "jdoe", "src")}"`).length, 1);
  for (const ok of ["--home-page-color: red", "a-home-made-thing", "the -Users- column", `x ${dashPath("Users", "alice", "secret")}`]) {
    assert.equal(homePathFindings(ok).length, 0, ok);
  }
});

test("review #6: path names, directory names and symlink targets are scanned (home path and email)", () => {
  const t = makeTree({
    [`testdata/x/${dashPath("Users", "jdoe", "Documents", "foo").slice(0, -1)}/s.jsonl`]: "{}\n",
    [`docs/${EMAIL}.md`]: "fine\n",
    "ok.md": "clean\n",
  });
  try {
    symlinkSync(homePath("Users", "jdoe", "notes.md"), join(t.root, "abs-link"));
    symlinkSync(`../${EMAIL}`, join(t.root, "mail-link"));
    symlinkSync("ok.md", join(t.root, "rel-link"));
    const r = runMain(main, ["--root", t.root], { WASITME_FORBIDDEN_EMAILS: EMAIL });
    assert.equal(r.code, 1);
    assert.match(r.err, /testdata\/x\/-Users-<name>-Documents-foo\/s\.jsonl: \[abs-home-path\] absolute home path in the path/, "printed with the name redacted");
    assert.match(r.err, /docs\/\[address\]\.md: \[forbidden-email\] .*in the path/, "printed with the address redacted");
    assert.match(r.err, /abs-link: \[abs-home-path\] symlink with an absolute target/);
    assert.match(r.err, /abs-link: \[abs-home-path\] absolute home path in the symlink target/);
    assert.match(r.err, /mail-link: \[forbidden-email\] .*symlink target/);
    assert.ok(!r.err.includes("rel-link"), "a relative, clean symlink is fine");
    assert.ok(!r.err.includes("jdoe") && !r.err.includes(EMAIL), "nothing guarded is echoed");
    assert.match(r.out, /3 symlink\(s\)/);
  } finally {
    t.cleanup();
  }
});

test("review #5: forbidden-email cannot be allow-listed: '*' entries are rejected, and the filter never applies", () => {
  const t = makeTree({ "wild.md": `reach ${EMAIL} sentinel-needle\n`, "scripts/check-repo.allow": "* | wild.md | sentinel-needle | x\n" });
  try {
    const wildcard = runMain(main, ["--root", t.root], { WASITME_FORBIDDEN_EMAILS: EMAIL });
    assert.equal(wildcard.code, 2);
    assert.match(wildcard.err, /"\*" is not accepted here/);
    writeFileSync(join(t.root, "scripts", "check-repo.allow"), "abs-home-path | wild.md | sentinel-needle | x\n");
    const r = runMain(main, ["--root", t.root, "--rules", "forbidden-email,abs-home-path"], { WASITME_FORBIDDEN_EMAILS: EMAIL });
    assert.equal(r.code, 1);
    assert.match(r.err, /wild\.md:1: \[forbidden-email\]/);
  } finally {
    t.cleanup();
  }
});

test("review #5: a .ci-local.env that git would commit is a finding, configured or not; an ignored one is not", { skip: !hasGit }, () => {
  const t = makeTree({ "a.md": "x\n", ".ci-local.env": `WASITME_FORBIDDEN_EMAILS=${EMAIL}\n`, "docs/.ci-local.env": "X=1\n" });
  try {
    git(t.root, "init", "-q");
    const r = runMain(main, ["--root", t.root, "--rules", "forbidden-email"], {});
    assert.equal(r.code, 1);
    assert.match(r.err, /^\.ci-local\.env: \[forbidden-email\] the private forbidden-email config would be committed/m);
    assert.match(r.err, /^docs\/\.ci-local\.env: \[forbidden-email\]/m);
    assert.ok(!r.err.includes(EMAIL));
    writeFileSync(join(t.root, ".gitignore"), ".ci-local.env\n");
    const ignored = runMain(main, ["--root", t.root, "--rules", "forbidden-email"], {});
    assert.equal(ignored.code, 0, ignored.err);
  } finally {
    t.cleanup();
  }
  const walk = makeTree({ "a.md": "x\n", ".ci-local.env": `WASITME_FORBIDDEN_EMAILS=${EMAIL}\n` }); // not a git repo
  try {
    assert.equal(runMain(main, ["--root", walk.root, "--rules", "forbidden-email"], {}).code, 0, "outside git the walk just skips it");
  } finally {
    walk.cleanup();
  }
});

test("review #10: plus-addressing, UTF-16 files, binaries and oversize files; NOT SCANNED is reported", () => {
  const [local, domain] = EMAIL.split("@");
  const plus = `${local}+news@${domain}`;
  assert.equal(emailFindings(`mail ${plus.toUpperCase()}`, [EMAIL]).length, 1, "local+tag@domain");
  assert.equal(emailFindings(`mail ${local}x@${domain}`, [EMAIL]).length, 0, "a different local part is not a match");
  assert.ok(bufferHasEmail(Buffer.from(`\0\x89PNG..tEXt ${EMAIL}\0`, "latin1"), emailMatchers([EMAIL])));
  assert.ok(bufferHasEmail(Buffer.from(`x${EMAIL}`, "utf16le"), [EMAIL]));
  assert.ok(bufferHasEmail(Buffer.concat([Buffer.from([0]), Buffer.from(EMAIL, "utf16le")]), [EMAIL]), "odd byte offset");

  const t = makeTree({ "ok.md": "fine\n" });
  try {
    writeFileSync(join(t.root, "Localizable.strings"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`"k" = "${REAL_LOOKING}";\n`, "utf16le")]));
    writeFileSync(join(t.root, "shot.png"), Buffer.concat([Buffer.from("\x89PNG\0\0", "latin1"), Buffer.from(`tEXt ${EMAIL}`)]));
    writeFileSync(join(t.root, "big.txt"), "x".repeat(5 * 1024 * 1024) + `\n${EMAIL}\n`);
    const r = runMain(main, ["--root", t.root], { WASITME_FORBIDDEN_EMAILS: EMAIL });
    assert.equal(r.code, 1);
    assert.match(r.err, /Localizable\.strings:1: \[abs-home-path\]/, "UTF-16LE with a BOM is decoded, not skipped as binary");
    assert.match(r.err, /shot\.png: \[forbidden-email\] .*raw bytes \(binary file/);
    assert.match(r.err, /big\.txt: \[forbidden-email\] .*raw bytes \(oversize file/);
    assert.match(r.err, /NOT SCANNED by the text rules: 2 file\(s\): big\.txt \(oversize\), shot\.png \(binary\)/);
    assert.ok(!r.err.includes(EMAIL));
  } finally {
    t.cleanup();
  }
});

test("review #10: --strict fails when a file with a text extension could not be read as text", () => {
  const t = makeTree({ "ok.md": "fine\n" });
  try {
    writeFileSync(join(t.root, "huge.txt"), "x".repeat(5 * 1024 * 1024));
    writeFileSync(join(t.root, "logo.png"), Buffer.from([0x89, 0x50, 0, 0]));
    assert.equal(runMain(main, ["--root", t.root, "--rules", "abs-home-path"]).code, 0, "non-strict: reported, not failed");
    const strict = runMain(main, ["--root", t.root, "--rules", "abs-home-path", "--strict"]);
    assert.equal(strict.code, 1);
    assert.match(strict.err, /huge\.txt: \[not-scanned\]/);
    assert.ok(!strict.err.includes("logo.png: [not-scanned]"), "a binary format is expected not to be text");
  } finally {
    t.cleanup();
  }
});

test("review #13: an allow-list needle must sit near the finding, so one entry cannot hide a new violation on the same line", () => {
  const line = `quoted example ${REAL_LOOKING} ${"y".repeat(120)} and later ${homePath("Users", "jdoe2", "x")}`;
  const t = makeTree({ "notes.md": `${line}\n`, "scripts/check-repo.allow": "abs-home-path | notes.md | quoted example | the first path is quoted\n" });
  try {
    const r = runMain(main, ["--root", t.root, "--rules", "abs-home-path"]);
    assert.equal(r.code, 1, "the second path, 120+ characters away, is still a finding");
    assert.equal((r.err.match(/notes\.md:1: \[abs-home-path\]/g) ?? []).length, 1);
  } finally {
    t.cleanup();
  }
});

test("review #8: remote assets inside escaped strings, <base>, alternate stylesheet, srcset, image-set, imports, .src", () => {
  const swiftHtml = 'let page = "<link rel=\\"stylesheet\\" href=\\"https://fonts.example.com/a.css\\">"';
  const tsHtml = 'const html = "<script src=\\"https://cdn.example.com/x.js\\"></script>";';
  const jsonEscaped = '{"html": "<img src=\\"https:\\/\\/cdn.example.com\\/a.png\\">"}';
  for (const text of [
    swiftHtml, tsHtml, jsonEscaped,
    '<base href="https://example.com/">',
    '<link rel="alternate stylesheet" href="https://cdn.example.com/dark.css">',
    '<img src="a.png" srcset="a.png 1x, https://cdn.example.com/b.png 2x">',
    ".h { background-image: image-set('https://cdn.example.com/a.png' 1x) }",
    'import confetti from "https://cdn.example.com/confetti.mjs";',
    'const m = await import("https://cdn.example.com/m.js");',
    'img.src = "https://cdn.example.com/p.png";',
    'el.setAttribute("src", "https://cdn.example.com/p.png");',
    '<form action="https://collect.example.com/">',
    '<meta http-equiv="refresh" content="0; url=https://example.com/">',
  ]) {
    assert.equal(assetFindings(text).length, 1, text);
  }
  for (const ok of [
    '<link rel="alternate" type="application/rss+xml" href="https://example.com/feed">',
    'let s = "<a href=\\"https://github.com/example\\">source</a>"',
    '<img srcset="a.png 1x, b.png 2x">',
    'import x from "./local.js";',
  ]) {
    assert.equal(assetFindings(ok).length, 0, ok);
  }
});

test("review #18: evaluateScript (JavaScriptCore) and loadHTMLString need constant literals too", () => {
  assert.equal(stringBuiltJsFindings(swift('ctx.evaluateScript("run(\\(x))")')).length, 1);
  assert.equal(stringBuiltJsFindings(swift('web.loadHTMLString("<script>run(\\(x))</script>", baseURL: nil)')).length, 1);
  assert.equal(stringBuiltJsFindings(swift("web.loadHTMLString(html, baseURL: nil)")).length, 1);
  assert.equal(stringBuiltJsFindings(swift('ctx.evaluateScript("1 + 1")')).length, 0);
  assert.equal(stringBuiltJsFindings(swift('web.loadHTMLString("<p>static</p>", baseURL: nil)')).length, 0);
});

test("review #19/#20: options without a value are usage errors; env-file typos warn; inline comments are stripped", () => {
  for (const bad of [["--root"], ["--allow"], ["--rules"], ["--root", "--strict"]]) {
    const r = runMain(main, bad, noEnv);
    assert.equal(r.code, 2, bad.join(" "));
    assert.match(r.err, /needs a value/);
  }
  assert.deepEqual(parseEnvFile(`WASITME_FORBIDDEN_EMAILS=${EMAIL} # mine\nB="x # kept"\n`), { WASITME_FORBIDDEN_EMAILS: EMAIL, B: "x # kept" });
  const t = makeTree({ "a.md": "x\n", ".ci-local.env": `WASITME_FORBIDDEN_EMAIL=${EMAIL}\n` });
  try {
    const loaded = loadForbiddenEmails(t.root, noEnv);
    assert.deepEqual(loaded.literals, []);
    assert.match(loaded.warnings.join("\n"), /sets WASITME_FORBIDDEN_EMAIL, which check-repo does not read/);
    const r = runMain(main, ["--root", t.root], noEnv);
    assert.match(r.err, /warning: \.ci-local\.env sets WASITME_FORBIDDEN_EMAIL\b/);
    assert.ok(!r.err.includes(EMAIL), "the warning names the key, never the value");
  } finally {
    t.cleanup();
  }
});

test("review #3: --git-identity: every commit and tag email must be GitHub noreply; forbidden literals anywhere fail; values never printed", { skip: !hasGit }, () => {
  assert.ok(isGithubNoreply("12345+someone@users.noreply.github.com"));
  assert.ok(isGithubNoreply("someone@users.noreply.github.com"));
  assert.ok(isGithubNoreply("noreply@github.com"));
  assert.ok(!isGithubNoreply(EMAIL));
  assert.ok(!isGithubNoreply("x@users.noreply.github.com.evil.example"));

  const NOREPLY = "1234+tester@users.noreply.github.com";
  const t = makeTree({ "a.md": "x\n" });
  const commit = (email, msg) => spawnGit(t.root, ["-c", "user.name=t", "-c", `user.email=${email}`, "commit", "-q", "--allow-empty", "-m", msg]);
  try {
    spawnGit(t.root, ["init", "-q", "-b", "main"]);
    commit(NOREPLY, "first");
    const clean = runMain(main, ["--root", t.root, "--git-identity"], { WASITME_FORBIDDEN_EMAILS: EMAIL });
    assert.equal(clean.code, 0, clean.err);
    assert.match(clean.out, /git-identity checked 1 commit/);

    commit(NOREPLY, `Co-Authored-By: someone <${EMAIL}>`);
    const inMessage = runMain(main, ["--root", t.root, "--git-identity"], { WASITME_FORBIDDEN_EMAILS: EMAIL });
    assert.equal(inMessage.code, 1);
    assert.match(inMessage.err, /forbidden address appears in history metadata \(1 commit\(s\)\/tag\(s\); message x1/);

    spawnGit(t.root, ["checkout", "-q", "-b", "side"]);
    commit("test@example.invalid", "on another branch"); // not on main: --all must still see it
    spawnGit(t.root, ["checkout", "-q", "main"]);
    const r = runMain(main, ["--root", t.root, "--git-identity"], { WASITME_FORBIDDEN_EMAILS: EMAIL });
    assert.equal(r.code, 1);
    assert.match(r.err, /not a GitHub noreply address \(1 commit\(s\)\/tag\(s\); author email x1, committer email x1/);
    assert.ok(!/@/.test(r.err.replace(/GitHub noreply/g, "")), "no address is printed");
    const found = gitIdentityFindings(t.root, [EMAIL]);
    assert.equal(found.commits, 3);

    // annotated tag by a non-noreply tagger
    spawnGit(t.root, ["-c", "user.name=t", "-c", "user.email=tagger@example.invalid", "tag", "-a", "v0", "-m", "tag"]);
    assert.ok(gitIdentityFindings(t.root, []).notNoreply.some((x) => x.field === "tagger email"));

    // without config: the noreply part still runs, the email part is skipped loudly; --require-email-config fails
    const unconfigured = runMain(main, ["--root", t.root, "--git-identity"], noEnv);
    assert.equal(unconfigured.code, 1);
    assert.match(unconfigured.err, /SKIPPED forbidden-email/);
    assert.equal(runMain(main, ["--root", t.root, "--git-identity", "--require-email-config"], noEnv).code, 2);
  } finally {
    t.cleanup();
  }
});

function spawnGit(cwd, args) {
  const r = git(cwd, ...args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r;
}
