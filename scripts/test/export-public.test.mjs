// Tests of scripts/dev/export-public.sh: the public tree is built from committed content only, leaves out the internal
// paths (.gitattributes export-ignore), carries ONE commit with a noreply identity, has no remote, and the script fails
// closed when the export is not clean. Everything runs in temporary directories with an empty git configuration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadForbiddenEmails, loadForbiddenPhrases } from "../check-repo.mjs";
import { internalPaths } from "../lib/doc-links.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "dev", "export-public.sh");

// The independent oracle: paths that must never be in the public tree (kept apart from the script's own list on purpose).
const NEVER_PUBLIC = [
  "CLAUDE.local.md", "docs/private", "docs/STATUS.md", "docs/MERGE.md", "docs/PLAN.md", "docs/PREPUBLISH.md",
  "docs/GUARDRAILS.md", "docs/TESTING-FOUNDER.md", "docs/research/06-local-log-structure.md",
  "engine/reference", "engine/scripts/g0.mjs", "spikes-tracked", "design/system/_verify", ".gitattributes",
];

// The forbidden emails and phrases come from this machine's .ci-local.env unless a test sets them. The phrases in these
// tests are synthetic; the real ones live only in that gitignored file.
const ENV = { ...process.env, HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", WASITME_FORBIDDEN_EMAILS: "", WASITME_FORBIDDEN_PHRASES: "" };
const PHRASE = "synthetic-private-phrase-0001";

function sh(args, opts = {}) {
  return spawnSync("sh", [opts.script ?? SCRIPT, ...args], { encoding: "utf8", env: { ...ENV, ...opts.env }, cwd: opts.cwd ?? tmpdir() });
}
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV }).trim();
}
const scratch = () => mkdtempSync(join(tmpdir(), "wasitme-export-test-"));
const gone = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
const isRepo = (() => { try { git(ROOT, "rev-parse", "--verify", "HEAD"); return true; } catch { return false; } })();
const real = { skip: isRepo ? false : "not a git checkout with a commit" };

test("the export of this repository: committed content minus the internal paths, one commit, noreply identity, no remote", real, () => {
  const base = scratch();
  const out = join(base, "public");
  try {
    const r = sh(["--no-checks", out]);
    assert.equal(r.status, 0, r.stderr);
    for (const p of NEVER_PUBLIC) assert.equal(existsSync(join(out, p)), false, `${p} must not be in the public tree`);
    for (const p of ["README.md", "LICENSE", "AGENTS.md", "CLAUDE.md", "SECURITY.md", "CONTRIBUTING.md", "docs/METHOD.md", "docs/PRIVACY.md", "scripts/dev/heavy.sh", "scripts/dev/export-public.sh"]) {
      assert.equal(existsSync(join(out, p)), true, `${p} must be in the public tree`);
    }
    // Exactly HEAD's files, minus the export-ignore list: nothing else was dropped.
    const internal = internalPaths(ROOT);
    const expected = git(ROOT, "ls-tree", "-r", "--name-only", "-z", "HEAD").split("\0").filter(Boolean)
      .filter((f) => !internal.some((d) => f === d || f.startsWith(`${d}/`))).sort();
    const exported = git(out, "ls-files", "-z").split("\0").filter(Boolean).sort();
    assert.deepEqual(exported, expected);
    // One commit, placeholder noreply identity as author and committer, no remote, and the identity is local.
    assert.equal(git(out, "rev-list", "--all", "--count"), "1");
    assert.equal(git(out, "log", "-1", "--format=%an|%ae|%cn|%ce"), "wasitme maintainer|OWNER@users.noreply.github.com|wasitme maintainer|OWNER@users.noreply.github.com");
    assert.equal(git(out, "branch", "--show-current"), "main");
    assert.equal(git(out, "remote"), "");
    assert.equal(git(out, "config", "--local", "user.email"), "OWNER@users.noreply.github.com");
    assert.match(git(out, "log", "-1", "--format=%ai|%ci"), /^\S+ \S+ \+0000\|\S+ \S+ \+0000$/, "the commit is dated in UTC");
    assert.match(r.stdout, /PLACEHOLDER/);
    assert.match(r.stdout, /Nothing was pushed/);
  } finally {
    gone(base);
  }
});

test("the export passes the repository checks: check-repo --strict, git identity, changelog, documentation links", real, () => {
  const base = scratch();
  const out = join(base, "public");
  try {
    // A dummy forbidden address and phrase (built in pieces so this file does not contain them), so the outcome does not
    // depend on this machine's own .ci-local.env.
    const r = sh([out], { env: { WASITME_FORBIDDEN_EMAILS: ["canary-nobody", "example.invalid"].join("@"), WASITME_FORBIDDEN_PHRASES: ["canary", "phrase", "nowhere"].join("-") } });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /check-repo --strict on the new tree/);
    assert.match(r.stdout, /check-repo --git-identity on the new tree/);
    assert.match(r.stdout, /documentation links in the new tree/);
    assert.doesNotMatch(r.stderr, /no forbidden email is configured/);
    assert.doesNotMatch(r.stderr, /no forbidden phrase is configured/);
  } finally {
    gone(base);
  }
});

// Only meaningful where no forbidden email is configured (WASITME_FORBIDDEN_EMAILS, or a .ci-local.env next to this
// checkout or its main worktree); a machine that has one is covered by the test above.
const unconfigured = isRepo && loadForbiddenEmails(ROOT, {}).literals.length === 0;
test("without a configured forbidden email the script warns, and --require-email-config fails and removes the output", { skip: unconfigured ? false : "a forbidden email is configured on this machine" }, () => {
  const base = scratch();
  // A phrase is configured (a dummy, built in pieces), so --require-email-config gets as far as the email check.
  const env = { WASITME_FORBIDDEN_PHRASES: ["canary", "phrase", "nowhere"].join("-") };
  try {
    const warn = sh([join(base, "a")], { env });
    assert.equal(warn.status, 0, warn.stderr);
    assert.match(warn.stderr, /no forbidden email is configured/);
    const out = join(base, "b");
    const r = sh(["--require-email-config", out], { env });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no forbidden email configured/);
    assert.equal(existsSync(out), false, "a failed export must not leave a tree behind");
  } finally {
    gone(base);
  }
});

test("usage errors exit 2 and change nothing: non-empty output, output inside the repository, a personal email, a bad ref", real, () => {
  const base = scratch();
  try {
    const full = join(base, "full");
    mkdirSync(full);
    writeFileSync(join(full, "keep.txt"), "x");
    let r = sh(["--no-checks", full]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not empty/);
    assert.equal(readFileSync(join(full, "keep.txt"), "utf8"), "x");

    r = sh(["--no-checks", join(ROOT, "export-test-output")]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /outside this repository/);
    assert.equal(existsSync(join(ROOT, "export-test-output")), false);

    for (const bad of ["someone@example.com", "someone@gmail.com", "a b@users.noreply.github.com", "x@users.noreply.github.com.evil.example"]) {
      r = sh(["--no-checks", "--email", bad, join(base, "e")]);
      assert.equal(r.status, 2, bad);
      assert.match(r.stderr, /noreply/);
      assert.equal(existsSync(join(base, "e")), false);
    }

    r = sh(["--no-checks", "--ref", "no-such-ref", join(base, "r")]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a commit/);

    r = sh([]);
    assert.equal(r.status, 2);
    assert.match(r.stdout + r.stderr, /Usage: scripts\/dev\/export-public\.sh/);
  } finally {
    gone(base);
  }
});

test("a chosen noreply identity and message are used, and the placeholder note is not printed", real, () => {
  const base = scratch();
  const out = join(base, "public");
  try {
    const r = sh(["--no-checks", "--name", "Some Maintainer", "--email", "12345+maintainer@users.noreply.github.com", "--message", "wasitme 0.1.0", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(out, "log", "-1", "--format=%an|%ae|%cn|%ce|%s"), "Some Maintainer|12345+maintainer@users.noreply.github.com|Some Maintainer|12345+maintainer@users.noreply.github.com|wasitme 0.1.0");
    assert.doesNotMatch(r.stdout, /PLACEHOLDER/);
  } finally {
    gone(base);
  }
});

const placeholder = "OWNER" + "/wasitme"; // spelled in pieces: this file is itself rewritten by --owner
// The public tree has no placeholder left (the export that made it replaced them), so there is nothing to test there.
const hasPlaceholder = isRepo && spawnSync("git", ["-C", ROOT, "grep", "-q", "-F", placeholder], { env: ENV }).status === 0;
test("--owner replaces the OWNER placeholder in every file that has one; without it the script says how many remain", { skip: hasPlaceholder ? false : "no placeholder left in this tree" }, () => {
  const base = scratch();
  try {
    const plain = sh(["--no-checks", join(base, "plain")]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /\d+ file\(s\) still carry the OWNER placeholder/);
    assert.equal(spawnSync("git", ["-C", join(base, "plain"), "grep", "-q", "-F", placeholder, "--", "SECURITY.md"], { env: ENV }).status, 0);

    const out = join(base, "owned");
    const r = sh(["--no-checks", "--owner", "some-owner", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /still carry the OWNER placeholder/);
    assert.equal(spawnSync("git", ["-C", out, "grep", "-q", "-F", placeholder], { env: ENV }).status, 1, "no placeholder may remain");
    for (const f of ["SECURITY.md", ".github/ISSUE_TEMPLATE/config.yml", "engine/package.json", "scripts/install.sh"]) {
      assert.match(readFileSync(join(out, f), "utf8"), /github\.com\/some-owner\/wasitme/, `${f} must name the owner`);
    }
    // The note saying the advisory link is still a placeholder stays without --owner and goes with it.
    assert.match(readFileSync(join(base, "plain", "SECURITY.md"), "utf8"), /\(placeholder: `OWNER`/);
    assert.doesNotMatch(readFileSync(join(out, "SECURITY.md"), "utf8"), /\(placeholder:/, "SECURITY.md must not call the owned link a placeholder");
    // A script that looks FOR the placeholder must not be rewritten into one that looks for the owner: release.sh's
    // --strict gate would then call every real repository URL a placeholder and refuse to build.
    assert.doesNotMatch(readFileSync(join(out, "scripts/release.sh"), "utf8"), /some-owner/, "release.sh's placeholder gate must survive --owner");
    // And that gate passes on the owned tree: the public repository's release workflow runs `release.sh --strict`, which
    // checks placeholders first and the changelog second, so a refusal that names the changelog got past the placeholders.
    const rel = spawnSync("sh", [join(out, "scripts", "release.sh"), "--strict", "--out", join(base, "release-out")], { cwd: out, env: ENV, encoding: "utf8" });
    assert.doesNotMatch(rel.stderr + rel.stdout, /OWNER placeholders are still in public files|PLACEHOLDER: /, "no OWNER placeholder is left for release.sh --strict to refuse");
    // On a release commit the changelog already has the version's notes, so the refusal comes from the next gate (the
    // build needs the locked TypeScript, which this scratch tree never installs): past the placeholders either way.
    assert.match(rel.stderr, /CHANGELOG\.md has no notes|TypeScript is not installed/, `release.sh --strict stopped at a gate after the placeholder gate:\n${rel.stderr}`);
    // The rewrite keeps modes, and the checkout is still one commit with the files committed as rewritten.
    assert.equal(git(out, "status", "--porcelain"), "");
    assert.equal(git(out, "rev-list", "--all", "--count"), "1");
    assert.equal(git(out, "ls-files", "-s", "scripts/install.sh").slice(0, 6), git(ROOT, "ls-files", "-s", "scripts/install.sh").slice(0, 6));
  } finally {
    gone(base);
  }
});

test("--owner must be a GitHub account name", real, () => {
  const base = scratch();
  try {
    for (const bad of ["-x", "x-", "a b", "a--b", "a/b", "x".repeat(40)]) {
      const r = sh(["--no-checks", "--owner", bad, join(base, "o")]);
      assert.equal(r.status, 2, bad);
      assert.match(r.stderr, /--owner/);
      assert.equal(existsSync(join(base, "o")), false);
    }
  } finally {
    gone(base);
  }
});

// ---- the assertions, on a small synthetic repository ----------------------------------------------------------------

const PUBLIC_FILES = {
  "README.md": "# demo\n", LICENSE: "MIT\n", "AGENTS.md": "rules\n", "CLAUDE.md": "@AGENTS.md\n", "SECURITY.md": "s\n",
  "CONTRIBUTING.md": "c\n", "CODE_OF_CONDUCT.md": "c\n", "THIRD_PARTY_NOTICES.md": "t\n", "docs/METHOD.md": "m\n",
  "docs/PRIVACY.md": "p\n", "docs/DECISIONS.md": "d\n", "engine/package.json": "{}\n", "scripts/ci-local.sh": "#!/bin/sh\n",
  "scripts/dev/heavy.sh": "#!/bin/sh\n",
};

/** A git repository holding a copy of the script, `files`, and a committed .gitattributes. */
function miniRepo(files, attributes) {
  const dir = scratch();
  mkdirSync(join(dir, "scripts", "dev"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts", "dev", "export-public.sh"));
  for (const [rel, body] of Object.entries({ ...PUBLIC_FILES, ...files })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  if (attributes !== null) writeFileSync(join(dir, ".gitattributes"), attributes);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "t"], { env: ENV });
  return dir;
}
const miniScript = (dir) => join(dir, "scripts", "dev", "export-public.sh");

test("an internal file that .gitattributes forgot to list makes the export fail, and nothing is left behind", () => {
  const repo = miniRepo({ "docs/STATUS.md": "private status\n" }, ".gitattributes export-ignore\n");
  const base = scratch();
  const out = join(base, "public");
  try {
    const r = sh(["--no-checks", out], { script: miniScript(repo) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /internal path in the export: docs\/STATUS\.md/);
    assert.equal(existsSync(out), false);
  } finally {
    gone(repo, base);
  }
});

test("with the file listed in .gitattributes the same repository exports, without it", () => {
  const repo = miniRepo({ "docs/STATUS.md": "private status\n" }, ".gitattributes export-ignore\ndocs/STATUS.md export-ignore\n");
  const base = scratch();
  const out = join(base, "public");
  try {
    const r = sh(["--no-checks", out], { script: miniScript(repo) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(out, "docs", "STATUS.md")), false);
    assert.equal(existsSync(join(out, ".gitattributes")), false);
    assert.equal(git(out, "rev-list", "--all", "--count"), "1");
  } finally {
    gone(repo, base);
  }
});

test("a stray local file and a missing public file each fail the export", () => {
  const attrs = ".gitattributes export-ignore\n";
  const cases = [
    [{ "sub/CLAUDE.local.md": "private\n" }, /local files in the export/],
    [{ "sub/.ci-local.env": "WASITME_FORBIDDEN_EMAILS=x\n" }, /local files in the export/],
  ];
  for (const [files, pattern] of cases) {
    const repo = miniRepo(files, attrs);
    const base = scratch();
    try {
      const r = sh(["--no-checks", join(base, "public")], { script: miniScript(repo) });
      assert.equal(r.status, 1, JSON.stringify(files));
      assert.match(r.stderr, pattern);
    } finally {
      gone(repo, base);
    }
  }
  // An over-broad exclusion must not ship an empty shell.
  const repo = miniRepo({}, ".gitattributes export-ignore\nREADME.md export-ignore\n");
  const base = scratch();
  try {
    const r = sh(["--no-checks", join(base, "public")], { script: miniScript(repo) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing from the export: README\.md/);
  } finally {
    gone(repo, base);
  }
});

// ---- the private phrases: configured, never written in a tracked file ------------------------------------------------

test("a configured private phrase in a public file fails the export; it is matched case-insensitively and never printed", () => {
  const repo = miniRepo({ "docs/notes.md": `a note with ${PHRASE.toUpperCase()} in it\n` }, ".gitattributes export-ignore\n");
  const base = scratch();
  const out = join(base, "public");
  try {
    const phrases = `another synthetic phrase\n${PHRASE}`; // newline separated here, comma separated below
    assert.deepEqual(loadForbiddenPhrases(repo, { WASITME_FORBIDDEN_PHRASES: phrases }).phrases, ["another synthetic phrase", PHRASE]);
    const r = sh(["--no-checks", out], { script: miniScript(repo), env: { WASITME_FORBIDDEN_PHRASES: phrases } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /forbidden phrase 2 of 2 \(in WASITME_FORBIDDEN_PHRASES\) found in:\n {2}docs\/notes\.md/);
    assert.ok(!`${r.stdout}${r.stderr}`.toLowerCase().includes(PHRASE), "the phrase itself is never printed");
    assert.equal(existsSync(out), false);
    // The same tree exports when no configured phrase is in it, and then nothing is said about a missing configuration.
    const ok = sh(["--no-checks", join(base, "ok")], { script: miniScript(repo), env: { WASITME_FORBIDDEN_PHRASES: "another synthetic phrase, yet another one" } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stderr, /no forbidden phrase/);
  } finally {
    gone(repo, base);
  }
});

test("a configured private phrase in a file or folder NAME, or inside a binary file, fails the export too, and is still never printed", () => {
  // Path names are part of the public tree, and binary metadata (PNG text chunks, media tags) is where a name hides.
  const cases = [
    ["a file name", { "docs/notes.md": "harmless\n", [`docs/${PHRASE}-notes.md`]: "harmless\n" }],
    ["a folder name", { [`testdata/${PHRASE.toUpperCase()}/a.txt`]: "harmless\n" }],
    ["a binary file", { "img/shot.png": `\u0089PNG\r\n\0\0tEXtComment\0${PHRASE}\0\0` }],
    ["a binary file, upper case", { "img/shot.bin": `\0\0${PHRASE.toUpperCase()}\0` }],
  ];
  for (const [name, files] of cases) {
    const repo = miniRepo(files, ".gitattributes export-ignore\n");
    const base = scratch();
    const out = join(base, "public");
    try {
      const r = sh(["--no-checks", out], { script: miniScript(repo), env: { WASITME_FORBIDDEN_PHRASES: `another synthetic phrase\n${PHRASE}` } });
      assert.equal(r.status, 1, `${name}: ${r.stderr}`);
      assert.match(r.stderr, /forbidden phrase 2 of 2 \(in WASITME_FORBIDDEN_PHRASES\) found in/, name);
      assert.ok(!`${r.stdout}${r.stderr}`.toLowerCase().includes(PHRASE), `${name}: the phrase itself is never printed, not even inside a path`);
      assert.equal(existsSync(out), false, name);
    } finally {
      gone(repo, base);
    }
  }
  // A phrase in the temporary folder the export is built in is not a hit: only names inside the tree count.
  const repo = miniRepo({ "docs/notes.md": "harmless\n" }, ".gitattributes export-ignore\n");
  const base = mkdtempSync(join(tmpdir(), `wasitme-export-test-${PHRASE}-`));
  try {
    const ok = sh(["--no-checks", join(base, "public")], { script: miniScript(repo), env: { WASITME_FORBIDDEN_PHRASES: PHRASE } });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    gone(repo, base);
  }
});

test("without a configured phrase the export warns, --require-email-config refuses before writing, and a short entry is refused", () => {
  const repo = miniRepo({}, ".gitattributes export-ignore\n");
  const base = scratch();
  try {
    for (const unset of ["", " \n "]) {
      const warn = sh(["--no-checks", join(base, `w${unset.length}`)], { script: miniScript(repo), env: { WASITME_FORBIDDEN_PHRASES: unset } });
      assert.equal(warn.status, 0, warn.stderr);
      assert.match(warn.stderr, /no forbidden phrase is configured, so the private-phrase scan did NOT run/);
    }
    const out = join(base, "required");
    const r = sh(["--no-checks", "--require-email-config", out], { script: miniScript(repo) });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no forbidden phrase configured/);
    assert.equal(existsSync(out), false, "nothing is written");
    const short = join(base, "short");
    const s = sh(["--no-checks", short], { script: miniScript(repo), env: { WASITME_FORBIDDEN_PHRASES: `${PHRASE}, abcd` } });
    assert.equal(s.status, 2, s.stderr);
    assert.match(s.stderr, /shorter than 5 characters/);
    assert.ok(!s.stderr.includes("abcd") && !s.stderr.includes(PHRASE), "the entries are never printed");
    assert.equal(existsSync(short), false);
    assert.throws(() => loadForbiddenPhrases(repo, { WASITME_FORBIDDEN_PHRASES: `${PHRASE}, abcd` }), /shorter than 5 characters/);
  } finally {
    gone(repo, base);
  }
});

test("export-public.sh reads the phrases from .ci-local.env exactly as loadForbiddenPhrases does", () => {
  const second = "second synthetic phrase";
  const forms = [
    `WASITME_FORBIDDEN_PHRASES=${PHRASE}, ${second}\n`,
    `export WASITME_FORBIDDEN_PHRASES="${PHRASE},${second}"\n`,
    `WASITME_FORBIDDEN_PHRASES='${PHRASE} , ${second}'\n`,
    `WASITME_FORBIDDEN_PHRASES=${PHRASE},${second} # a comment\n`,
    `WASITME_FORBIDDEN_EMAILS=someone@example.invalid\r\n  WASITME_FORBIDDEN_PHRASES = ${PHRASE},  ${second}  \r\n`,
    `WASITME_FORBIDDEN_PHRASES=an-older-synthetic-value\n# WASITME_FORBIDDEN_PHRASES=commented-out\nWASITME_FORBIDDEN_PHRASES=${PHRASE},${second}\n`,
  ];
  for (const body of forms) {
    const label = JSON.stringify(body);
    // The public file holds only the LAST phrase, so a quote, comment or space left on it would let the export pass.
    const repo = miniRepo({ "docs/notes.md": `${second}\n` }, ".gitattributes export-ignore\n");
    const base = scratch();
    try {
      writeFileSync(join(repo, ".ci-local.env"), body); // untracked, as the real one is
      assert.deepEqual(loadForbiddenPhrases(repo, {}), { phrases: [PHRASE, second], source: ".ci-local.env" }, label);
      const r = sh(["--no-checks", join(base, "public")], { script: miniScript(repo) });
      assert.equal(r.status, 1, label);
      assert.match(r.stderr, /forbidden phrase 2 of 2 \(in \.ci-local\.env\) found in:\n {2}docs\/notes\.md/, label);
    } finally {
      gone(repo, base);
    }
  }
  // A commented-out or empty setting configures nothing, for both readers.
  const repo = miniRepo({}, ".gitattributes export-ignore\n");
  const base = scratch();
  try {
    writeFileSync(join(repo, ".ci-local.env"), `# WASITME_FORBIDDEN_PHRASES=${PHRASE}\nWASITME_FORBIDDEN_PHRASES=  \n`);
    assert.deepEqual(loadForbiddenPhrases(repo, {}).phrases, []);
    const r = sh(["--no-checks", join(base, "public")], { script: miniScript(repo) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no forbidden phrase is configured/);
  } finally {
    gone(repo, base);
  }
});

test("the commit is dated in UTC (+0000) whatever the time zone of the machine that runs the export", () => {
  const zone = { TZ: "TST-9" }; // a POSIX zone nine hours east of UTC; needs no time zone database
  assert.equal(execFileSync("date", ["+%z"], { encoding: "utf8", env: { ...ENV, ...zone } }).trim(), "+0900", "the test zone takes effect");
  const repo = miniRepo({}, ".gitattributes export-ignore\n");
  const base = scratch();
  const out = join(base, "public");
  try {
    const r = sh(["--no-checks", out], { script: miniScript(repo), env: zone });
    assert.equal(r.status, 0, r.stderr);
    const [authored, committed] = git(out, "log", "-1", "--format=%ai|%ci").split("|");
    assert.match(authored, / \+0000$/);
    assert.match(committed, / \+0000$/);
  } finally {
    gone(repo, base);
  }
});

test("--keep leaves a failed export in place for inspection", () => {
  const repo = miniRepo({ "docs/STATUS.md": "x\n" }, ".gitattributes export-ignore\n");
  const base = scratch();
  const out = join(base, "public");
  try {
    const r = sh(["--no-checks", "--keep", out], { script: miniScript(repo) });
    assert.equal(r.status, 1);
    assert.equal(existsSync(join(out, "docs", "STATUS.md")), true);
  } finally {
    gone(repo, base);
  }
});

test("only committed content is exported: an uncommitted edit is not in the tree, and the script says so", () => {
  const repo = miniRepo({}, ".gitattributes export-ignore\n");
  const base = scratch();
  const out = join(base, "public");
  try {
    writeFileSync(join(repo, "README.md"), "# changed but not committed\n");
    const r = sh(["--no-checks", out], { script: miniScript(repo) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /uncommitted changes in this repository are NOT exported/);
    assert.equal(readFileSync(join(out, "README.md"), "utf8"), "# demo\n");
  } finally {
    gone(repo, base);
  }
});

// ---- --onto: an update committed on top of a clone of the public repository (D79) -------------------------------------
// The "public repository" is a fresh export in a temporary folder, and the maintainer's clone of it a local `git clone`:
// no network, no GitHub.

const ID = ["--name", "Some Maintainer", "--email", "12345+maintainer@users.noreply.github.com"];
const IDENTITY = "Some Maintainer|12345+maintainer@users.noreply.github.com|Some Maintainer|12345+maintainer@users.noreply.github.com";

/** Commit everything in `dir` with a throwaway identity (the source repository's identity is never checked). */
function commitAll(dir, message, email = "t@example.invalid") {
  git(dir, "add", "-A");
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: ENV });
}

/** A fresh export of `repo` (the public repository's first commit) and a local clone of it: the setup after publication. */
function published(repo, base, extra = [], opts = {}) {
  const pub = join(base, "public");
  const r = sh([...(opts.checks ? [] : ["--no-checks"]), ...ID, ...extra, pub], { script: opts.script ?? miniScript(repo), env: opts.env });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const clone = join(base, "clone");
  execFileSync("git", ["clone", "-q", pub, clone], { env: ENV });
  return { pub, clone };
}

const onto = (repo, clone, args = [], env = {}) => sh(["--no-checks", ...ID, ...args, "--onto", clone], { script: miniScript(repo), env });

test("--onto makes one ordinary commit on top of the public history holding exactly the new export; ignored files, the remote and the first commit are untouched", () => {
  const repo = miniRepo({ ".gitignore": "*.log\nscratch/\n", "docs/old.md": "old\n", "docs/same.md": "same\n", "tools/run.sh": "#!/bin/sh\n" },
    ".gitattributes export-ignore\ndocs/internal.md export-ignore\n");
  const base = scratch();
  try {
    const { pub, clone } = published(repo, base);
    const first = git(clone, "rev-parse", "HEAD");
    const remotes = git(clone, "remote", "-v");
    // A clone on a file system without executable bits: the new tree must still record them.
    git(clone, "config", "core.fileMode", "false");
    writeFileSync(join(clone, "notes.log"), "ignored, and mine\n");
    mkdirSync(join(clone, "scratch"));
    writeFileSync(join(clone, "scratch", "x.txt"), "an ignored folder\n");
    // The development tree moves on: a changed file, a deleted one, a new one, a new executable, and an internal file.
    writeFileSync(join(repo, "README.md"), "# demo, updated\n");
    rmSync(join(repo, "docs", "old.md"));
    writeFileSync(join(repo, "docs", "new.md"), "new\n");
    writeFileSync(join(repo, "tools", "new.sh"), "#!/bin/sh\necho new\n");
    chmodSync(join(repo, "tools", "new.sh"), 0o755);
    writeFileSync(join(repo, "docs", "internal.md"), "internal\n");
    commitAll(repo, "second");

    const r = onto(repo, clone, ["--message", "wasitme 0.2.0"], { TZ: "TST-9" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    // One new commit with the old HEAD as its only parent; the first commit is still the root, unchanged.
    assert.equal(git(clone, "rev-list", "--count", "HEAD"), "2");
    assert.equal(git(clone, "log", "-1", "--format=%P"), first, "one parent: an ordinary commit on top, not a merge");
    assert.equal(git(clone, "rev-list", "--max-parents=0", "HEAD"), first);
    assert.equal(git(clone, "branch", "--show-current"), "main");
    assert.equal(git(clone, "log", "-1", "--format=%an|%ae|%cn|%ce|%s"), `${IDENTITY}|wasitme 0.2.0`);
    assert.match(git(clone, "log", "-1", "--format=%ai|%ci"), /^\S+ \S+ \+0000\|\S+ \S+ \+0000$/, "dated in UTC whatever the machine's zone");
    // Exactly the export: the same tree object as a fresh export of the same commit (same files, contents and modes).
    const again = join(base, "again");
    const fresh = sh(["--no-checks", ...ID, again], { script: miniScript(repo) });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(git(clone, "rev-parse", "HEAD^{tree}"), git(again, "rev-parse", "HEAD^{tree}"));
    assert.deepEqual(git(clone, "diff", "--name-status", "--no-renames", "HEAD^", "HEAD").split("\n").sort(),
      ["A\tdocs/new.md", "A\ttools/new.sh", "D\tdocs/old.md", "M\tREADME.md"]);
    assert.match(git(clone, "ls-tree", "HEAD", "tools/new.sh"), /^100755 /);
    assert.match(r.stdout, /2 added, 1 changed, 1 deleted/);
    // The working tree followed: changed, deleted and added files, the executable bit, and nothing left uncommitted.
    assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "# demo, updated\n");
    assert.equal(existsSync(join(clone, "docs", "old.md")), false);
    assert.equal(existsSync(join(clone, "docs", "internal.md")), false);
    assert.equal(readFileSync(join(clone, "docs", "new.md"), "utf8"), "new\n");
    assert.equal(statSync(join(clone, "tools", "new.sh")).mode & 0o111, 0o111);
    assert.equal(git(clone, "status", "--porcelain"), "");
    // Ignored files are left alone.
    assert.equal(readFileSync(join(clone, "notes.log"), "utf8"), "ignored, and mine\n");
    assert.equal(readFileSync(join(clone, "scratch", "x.txt"), "utf8"), "an ignored folder\n");
    // No remote added or changed, nothing pushed, and the clone's own identity is now the export's.
    assert.equal(git(clone, "remote", "-v"), remotes);
    assert.equal(git(pub, "rev-parse", "HEAD"), first, "nothing was pushed to the public repository");
    assert.equal(git(clone, "config", "--local", "user.email"), "12345+maintainer@users.noreply.github.com");
    assert.ok(r.stdout.includes(`git -C ${realpathSync(clone)} push origin main\n`), r.stdout);
    assert.ok(r.stdout.includes(`git -C ${realpathSync(clone)} show --stat\n`), r.stdout);
  } finally {
    gone(repo, base);
  }
});

test("--onto commits every exported file, even one that a .gitignore in the public tree matches", () => {
  const repo = miniRepo({ ".gitignore": "*.log\n" }, ".gitattributes export-ignore\n");
  const base = scratch();
  try {
    const { clone } = published(repo, base);
    // Tracked in the development tree although the public .gitignore matches it (added with -f), so it is in the archive.
    writeFileSync(join(repo, "docs", "sample.log"), "a tracked example log\n");
    git(repo, "add", "-f", "docs/sample.log");
    commitAll(repo, "a tracked example log");
    const r = onto(repo, clone);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(clone, "ls-files", "docs/sample.log"), "docs/sample.log");
    assert.equal(git(clone, "show", "HEAD:docs/sample.log"), "a tracked example log");
    assert.equal(git(clone, "status", "--porcelain"), "");
  } finally {
    gone(repo, base);
  }
});

test("--onto with an unchanged public tree says 'nothing to update', exits 0 and commits nothing; the default message", () => {
  const repo = miniRepo({}, ".gitattributes export-ignore\ndocs/internal.md export-ignore\n");
  const base = scratch();
  try {
    const { clone } = published(repo, base);
    const first = git(clone, "rev-parse", "HEAD");
    let r = onto(repo, clone);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to update/);
    assert.equal(git(clone, "rev-parse", "HEAD"), first);
    assert.equal(spawnSync("git", ["-C", clone, "config", "--local", "user.email"], { env: ENV }).status, 1, "nothing in the clone changed, its config included");
    // A commit that only touches an internal file changes nothing public either.
    writeFileSync(join(repo, "docs", "internal.md"), "internal\n");
    commitAll(repo, "internal only");
    r = onto(repo, clone);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to update/);
    assert.equal(git(clone, "rev-list", "--count", "HEAD"), "1");
    // A public change without --message gets the update's default message. Git settings inherited from the caller's
    // environment (another repository, another index, fixed dates in another zone) are dropped.
    writeFileSync(join(repo, "README.md"), "# demo, again\n");
    commitAll(repo, "public change");
    const stray = { GIT_DIR: join(base, "nowhere"), GIT_INDEX_FILE: join(base, "stray.index"), GIT_AUTHOR_DATE: "2001-02-03T04:05:06+0900", GIT_COMMITTER_DATE: "2001-02-03T04:05:06+0900" };
    r = onto(repo, clone, [], stray);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(git(clone, "log", "-1", "--format=%s"), "Update from the development tree");
    assert.equal(git(clone, "rev-list", "--count", "HEAD"), "2");
    assert.match(git(clone, "log", "-1", "--format=%ai|%ci"), /^\S+ \S+ \+0000\|\S+ \S+ \+0000$/);
    assert.doesNotMatch(git(clone, "log", "-1", "--format=%ai|%ci"), /^2001-/);
    assert.equal(existsSync(join(base, "stray.index")), false);
    assert.equal(git(clone, "status", "--porcelain"), "");
  } finally {
    gone(repo, base);
  }
});

test("--onto refuses, changing nothing (exit 2): no such folder, not a repository, a subfolder, this repository or a checkout of it, no commits", () => {
  const repo = miniRepo({}, ".gitattributes export-ignore\n");
  const base = scratch();
  try {
    const { pub, clone } = published(repo, base);
    writeFileSync(join(repo, "README.md"), "# a pending public change\n");
    commitAll(repo, "pending");
    const refuse = (dir, pattern, extra = []) => {
      const r = onto(repo, dir, extra);
      assert.equal(r.status, 2, `${dir}: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, pattern);
      assert.doesNotMatch(r.stdout, /committed onto/);
    };
    refuse(join(base, "missing"), /no such directory/);
    const plain = join(base, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "x.txt"), "x\n");
    refuse(plain, /not a git repository/);
    assert.deepEqual(readdirSync(plain), ["x.txt"]);
    refuse(join(clone, "docs"), /not its top folder/);
    refuse(repo, /outside this repository/);
    refuse(join(repo, "docs"), /outside this repository/);
    const wt = join(base, "dev-worktree");
    git(repo, "worktree", "add", "-q", "--detach", wt);
    refuse(wt, /checkout of this development repository/);
    const empty = join(base, "empty");
    git(base, "init", "-q", "-b", "main", empty);
    refuse(empty, /no commits/);
    assert.equal(spawnSync("git", ["-C", empty, "rev-parse", "--verify", "HEAD"], { env: ENV }).status, 128);
    // A shallow clone (its older history, which the identity check reads, is missing).
    writeFileSync(join(pub, "docs", "PRIVACY.md"), "p, a second public commit\n");
    commitAll(pub, "second public commit", "12345+maintainer@users.noreply.github.com");
    const shallow = join(base, "shallow");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${pub}`, shallow], { env: ENV });
    assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
    refuse(shallow, /shallow clone/);
    // An address that only ends like a noreply one.
    refuse(clone, /--email must be a GitHub noreply address/, ["--email", "a@b@users.noreply.github.com"]);
    // The clone itself was never touched by any of these.
    assert.equal(git(clone, "rev-list", "--count", "HEAD"), "1");
    assert.equal(git(clone, "status", "--porcelain"), "");
    // Usage: --onto with an OUT_DIR, or with the placeholder identity.
    let r = sh(["--no-checks", ...ID, "--onto", clone, join(base, "out")], { script: miniScript(repo) });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not both/);
    assert.equal(existsSync(join(base, "out")), false);
    r = sh(["--no-checks", "--onto", clone], { script: miniScript(repo) });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /placeholder/);
    assert.equal(git(clone, "rev-list", "--count", "HEAD"), "1");
  } finally {
    gone(repo, base);
  }
});

test("--onto refuses, changing nothing (exit 2): not on main, a detached HEAD, uncommitted or untracked files, a HEAD that is not a noreply identity, a main behind origin/main", () => {
  const repo = miniRepo({ ".gitignore": "*.log\n" }, ".gitattributes export-ignore\n");
  const base = scratch();
  try {
    const { pub, clone } = published(repo, base);
    const first = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(repo, "README.md"), "# a pending public change\n");
    commitAll(repo, "pending");
    const refuse = (pattern) => {
      const r = onto(repo, clone);
      assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, pattern);
      return r;
    };
    git(clone, "checkout", "-q", "-b", "other");
    refuse(/must have main checked out, not other/);
    git(clone, "checkout", "-q", "--detach");
    refuse(/HEAD is detached/);
    git(clone, "checkout", "-q", "main");

    writeFileSync(join(clone, "README.md"), "# an edit in the clone\n");
    refuse(/uncommitted changes/);
    assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "# an edit in the clone\n", "the edit is kept");
    git(clone, "add", "README.md");
    refuse(/uncommitted changes/);
    git(clone, "reset", "-q", "--hard");
    writeFileSync(join(clone, "stray.txt"), "untracked\n");
    refuse(/untracked files/);
    rmSync(join(clone, "stray.txt"));
    writeFileSync(join(clone, "fine.log"), "ignored files are fine\n");
    // A file git status does not look at.
    git(clone, "update-index", "--skip-worktree", "docs/METHOD.md");
    refuse(/assume-unchanged or skip-worktree/);
    git(clone, "update-index", "--no-skip-worktree", "docs/METHOD.md");
    // A merge in progress whose index still matches HEAD, so git status lists nothing.
    git(clone, "checkout", "-q", "-b", "side");
    writeFileSync(join(clone, "docs", "METHOD.md"), "m, on a side branch\n");
    commitAll(clone, "side", "12345+maintainer@users.noreply.github.com");
    git(clone, "checkout", "-q", "main");
    execFileSync("git", ["-C", clone, "-c", "user.name=x", "-c", "user.email=12345+maintainer@users.noreply.github.com", "merge", "-q", "-s", "ours", "--no-commit", "side"], { env: ENV });
    assert.equal(git(clone, "status", "--porcelain"), "");
    refuse(/merge, cherry-pick, revert or rebase in progress \(MERGE_HEAD\)/);
    git(clone, "merge", "--abort");
    git(clone, "branch", "-q", "-D", "side");

    // A HEAD commit made with an address that is not a GitHub noreply one: refused, and the value is never printed.
    const personal = ["someone", "example.invalid"].join("@");
    writeFileSync(join(clone, "docs", "METHOD.md"), "m, edited\n");
    commitAll(clone, "edited by hand", personal);
    const r = refuse(/HEAD \([0-9a-f]+\) is not a GitHub noreply address \(value not shown\)/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(personal), "the address is never printed");
    git(clone, "reset", "-q", "--hard", first);
    // The same refusal for a committer-only mismatch.
    writeFileSync(join(clone, "docs", "METHOD.md"), "m, edited again\n");
    git(clone, "add", "-A");
    execFileSync("git", ["-C", clone, "-c", "user.name=Some Maintainer", "-c", "user.email=12345+maintainer@users.noreply.github.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"],
      { env: { ...ENV, GIT_COMMITTER_EMAIL: personal } });
    assert.equal(git(clone, "log", "-1", "--format=%ae"), "12345+maintainer@users.noreply.github.com");
    refuse(/not a GitHub noreply address/);
    git(clone, "reset", "-q", "--hard", first);

    // The public main moved on (a merge on GitHub; here a commit in the "public" repository) and the clone fetched it
    // without merging it: an update on top of the stale main would be refused at push time, so it is refused now.
    writeFileSync(join(pub, "docs", "PRIVACY.md"), "p, edited on GitHub\n");
    commitAll(pub, "merged on GitHub", "12345+maintainer@users.noreply.github.com");
    git(clone, "fetch", "-q");
    refuse(/does not contain origin\/main as of its last fetch: run git -C \S+ pull --ff-only first/);
    assert.equal(git(clone, "rev-parse", "HEAD"), first);
    git(clone, "merge", "-q", "--ff-only", "origin/main");

    // With every refusal cleared, the same update goes through.
    const ok = onto(repo, clone);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(git(clone, "rev-list", "--count", "HEAD"), "3");
    assert.equal(readFileSync(join(clone, "fine.log"), "utf8"), "ignored files are fine\n");
  } finally {
    gone(repo, base);
  }
});

test("--onto refuses to overwrite an ignored file where the export adds one (exit 2, nothing changed), and goes through once it is moved", () => {
  const repo = miniRepo({}, ".gitattributes export-ignore\n");
  const base = scratch();
  try {
    const { clone } = published(repo, base);
    const first = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(repo, "docs", "new.md"), "the public version\n");
    commitAll(repo, "adds docs/new.md");
    // Ignored only in this clone (its .git/info/exclude), so git status does not list it.
    mkdirSync(join(clone, ".git", "info"), { recursive: true });
    writeFileSync(join(clone, ".git", "info", "exclude"), "docs/new.md\n");
    writeFileSync(join(clone, "docs", "new.md"), "my own notes\n");
    assert.equal(git(clone, "status", "--porcelain"), "");
    const r = onto(repo, clone);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /docs\/new\.md/);
    assert.match(r.stderr, /Nothing was changed/);
    assert.equal(readFileSync(join(clone, "docs", "new.md"), "utf8"), "my own notes\n");
    assert.equal(git(clone, "rev-parse", "HEAD"), first);
    assert.equal(git(clone, "rev-parse", "main"), first);
    rmSync(join(clone, "docs", "new.md"));
    const ok = onto(repo, clone);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(join(clone, "docs", "new.md"), "utf8"), "the public version\n");
  } finally {
    gone(repo, base);
  }
});

test("--onto fails (exit 1, nothing changed) on an export that still carries the OWNER placeholder; --owner fixes it", () => {
  const repo = miniRepo({ "docs/links.md": `https://github.com/${placeholder}\n` }, ".gitattributes export-ignore\n");
  const base = scratch();
  try {
    const { clone } = published(repo, base, ["--owner", "some-owner"]);
    const first = git(clone, "rev-parse", "HEAD");
    assert.equal(readFileSync(join(clone, "docs", "links.md"), "utf8"), "https://github.com/some-owner/wasitme\n");
    writeFileSync(join(repo, "README.md"), "# a pending public change\n");
    commitAll(repo, "pending");
    const r = onto(repo, clone);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /1 file\(s\) still carry the OWNER placeholder/);
    assert.equal(git(clone, "rev-parse", "HEAD"), first);
    assert.equal(git(clone, "status", "--porcelain"), "");
    const ok = onto(repo, clone, ["--owner", "some-owner"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(git(clone, "diff", "--name-only", "HEAD^", "HEAD"), "README.md", "the owner's links are not reverted");
  } finally {
    gone(repo, base);
  }
});

test("--keep with --onto keeps a tree that failed its assertions, and DIR is not touched", () => {
  const repo = miniRepo({}, ".gitattributes export-ignore\n");
  const base = scratch();
  try {
    const { clone } = published(repo, base);
    const first = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(repo, "docs", "STATUS.md"), "internal, but .gitattributes forgot it\n");
    commitAll(repo, "leaks an internal file");
    const r = onto(repo, clone, ["--keep"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /internal path in the export: docs\/STATUS\.md/);
    const kept = r.stderr.match(/the failed tree is kept in (\S+) \(--keep\)/);
    assert.ok(kept, r.stderr);
    assert.equal(existsSync(join(kept[1], "docs", "STATUS.md")), true);
    gone(dirname(kept[1]));
    assert.equal(git(clone, "rev-parse", "HEAD"), first);
    assert.equal(existsSync(join(clone, "docs", "STATUS.md")), false);
  } finally {
    gone(repo, base);
  }
});

// The same update with every check on, on a copy of this repository's own public tree: the checks run on the clone, a
// history that fails the identity check is refused before anything changes, and a failed check puts main back.
test("--onto with the checks: run on the clone; a bad history is refused first; a failed check undoes the commit (or --keep keeps it)", real, () => {
  const base = scratch();
  const src = join(base, "src");
  try {
    // The source: HEAD's files (the archive already leaves out the internal ones), .gitattributes, and the script under
    // test rather than the committed one. The public tree has no .gitattributes; one that leaves out itself stands in.
    mkdirSync(src);
    execFileSync("git", ["-C", ROOT, "archive", "--format=tar", "-o", join(base, "head.tar"), "HEAD"], { env: ENV });
    execFileSync("tar", ["-xf", join(base, "head.tar"), "-C", src]);
    const attrs = spawnSync("git", ["-C", ROOT, "show", "HEAD:.gitattributes"], { encoding: "utf8", env: ENV });
    writeFileSync(join(src, ".gitattributes"), attrs.status === 0 ? attrs.stdout : ".gitattributes export-ignore\n");
    copyFileSync(SCRIPT, join(src, "scripts", "dev", "export-public.sh"));
    git(src, "init", "-q");
    commitAll(src, "source");
    const script = join(src, "scripts", "dev", "export-public.sh");
    // A dummy forbidden address and phrase (built in pieces so this file does not contain them).
    const forbidden = ["canary-nobody", "example.invalid"].join("@");
    const env = { WASITME_FORBIDDEN_EMAILS: forbidden, WASITME_FORBIDDEN_PHRASES: ["canary", "phrase", "nowhere"].join("-") };
    const run = (args) => sh([...ID, "--owner", "some-owner", "--require-email-config", ...args], { script, env });
    const { clone } = published(src, base, ["--owner", "some-owner"], { script, env });
    const first = git(clone, "rev-parse", "HEAD");

    // A public change: checked and committed.
    writeFileSync(join(src, "docs", "onto-test.md"), "# Onto test\n\nA synthetic page.\n");
    writeFileSync(join(src, "README.md"), `${readFileSync(join(src, "README.md"), "utf8")}\nA synthetic line.\n`);
    commitAll(src, "a public change");
    let r = run(["--onto", clone]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /check-repo --git-identity on .* before the update/);
    assert.match(r.stdout, /check-repo --strict on the new tree/);
    assert.match(r.stdout, /check-repo --git-identity on the new tree/);
    assert.match(r.stdout, /git-identity checked 2 commit\(s\) on all refs, 0 problem\(s\)/);
    assert.match(r.stdout, /documentation links in the new tree/);
    assert.match(r.stdout, /1 added, 1 changed, 0 deleted/);
    const second = git(clone, "rev-parse", "HEAD");
    assert.equal(git(clone, "rev-parse", "HEAD^"), first);
    assert.equal(git(clone, "log", "-1", "--format=%an|%ae|%cn|%ce"), IDENTITY);

    // A history with the forbidden address in a commit message: refused before anything is built.
    writeFileSync(join(clone, "docs", "onto-test.md"), "# Onto test\n\nEdited in the clone.\n");
    commitAll(clone, `mentions ${forbidden}`, "12345+maintainer@users.noreply.github.com");
    const bad = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(src, "docs", "onto-test.md"), "# Onto test\n\nA second synthetic version.\n");
    commitAll(src, "another public change");
    r = run(["--onto", clone]);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /fails the identity check/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(forbidden), "the address is never printed");
    assert.equal(git(clone, "rev-parse", "HEAD"), bad);
    git(clone, "reset", "-q", "--hard", second);

    // A public file with the forbidden address: check-repo --strict fails after the commit, and main goes back.
    writeFileSync(join(src, "docs", "contact.md"), `# Contact\n\nWrite to ${forbidden}.\n`);
    commitAll(src, "leaks an address");
    r = run(["--onto", clone]);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /check-repo --strict found problems/);
    assert.match(r.stderr, /is back on its previous commit/);
    assert.equal(git(clone, "rev-parse", "HEAD"), second);
    assert.equal(existsSync(join(clone, "docs", "contact.md")), false);
    assert.equal(readFileSync(join(clone, "docs", "onto-test.md"), "utf8"), "# Onto test\n\nA synthetic page.\n");
    assert.equal(git(clone, "status", "--porcelain"), "");

    // The same with --keep: the failed commit stays on main, and the way to undo it is printed.
    r = run(["--keep", "--onto", clone]);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /the commit stays on .* main \(--keep\)\. Undo it with: git -C \S+ reset --keep [0-9a-f]+/);
    assert.equal(git(clone, "rev-parse", "HEAD^"), second);
    assert.equal(existsSync(join(clone, "docs", "contact.md")), true);
  } finally {
    gone(base);
  }
});
