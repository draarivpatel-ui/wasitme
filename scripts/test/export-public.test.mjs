// Tests of scripts/dev/export-public.sh: the public tree is built from committed content only, leaves out the internal
// paths (.gitattributes export-ignore), carries ONE commit with a noreply identity, has no remote, and the script fails
// closed when the export is not clean. Everything runs in temporary directories with an empty git configuration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.match(rel.stderr, /CHANGELOG\.md has no notes/, `release.sh --strict stopped at the changelog gate, after the placeholder gate:\n${rel.stderr}`);
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
