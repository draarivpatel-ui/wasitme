/**
 * The command line: node engine/dist/src/synth/cli.js --scenario <name> --out <dir> [--seed N]
 * Run as a child process, exactly as documented.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../src/synth/generate.js";
import { findScenario, NAMED_SCENARIOS } from "../src/synth/scenarios.js";
import { readTree } from "../src/synth/testkit.js";
import { assertSafeOut, digestFiles } from "../src/synth/write.js";

const CLI = fileURLToPath(new URL("../src/synth/cli.js", import.meta.url));
const TESTDATA = fileURLToPath(new URL("../../../testdata/", import.meta.url));

function run(...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function scratch(): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wasitme-cli-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("--list names every scenario and --help documents the flags", () => {
  const l = run("--list");
  assert.equal(l.code, 0);
  for (const n of [...NAMED_SCENARIOS, "tiny-both", "hostile", "hostile-full"]) assert.match(l.out, new RegExp(`^${n}\\s`, "m"), n);
  assert.deepEqual(NAMED_SCENARIOS, ["null-few-long", "null-many-short", "effort-drop-you", "version-regression-agent", "confounded-same-week", "insufficient-new-user", "codex-only", "both-agents"]);
  const h = run("--help");
  assert.equal(h.code, 0);
  for (const f of ["--scenario", "--out", "--seed", "--replace", "--digest"]) assert.ok(h.out.includes(f), f);
});

test("writes <out>/claude, <out>/codex-style trees plus the truth files, and the output equals the library's", () => {
  const { root, done } = scratch();
  try {
    const out = join(root, "corpus");
    const r = run("--scenario", "insufficient-new-user", "--out", out);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /wrote \d+ files, \d+ exchanges \(insufficient-new-user, seed 106\)/);
    for (const p of ["claude/projects", "synth-truth.json", "synth-truth-exchanges.jsonl", ".wasitme-synth"]) assert.ok(existsSync(join(out, p)), p);
    const sc = findScenario("insufficient-new-user")!;
    const g = generate(sc.build({}), sc.name);
    const tree = readTree(out);
    tree.delete(".wasitme-synth");
    assert.deepEqual([...tree.keys()].sort(), g.files.map((f) => f.path).sort());
    const d = run("--scenario", "insufficient-new-user", "--digest");
    assert.deepEqual(JSON.parse(d.out), digestFiles(g.files));
  } finally {
    done();
  }
});

test("--seed, --days and --scale change the corpus; the same flags reproduce it", () => {
  const base = JSON.parse(run("--scenario", "null-many-short", "--days", "10", "--digest").out) as { sha256: string; files: number };
  const again = JSON.parse(run("--scenario", "null-many-short", "--days", "10", "--digest").out) as { sha256: string };
  const seeded = JSON.parse(run("--scenario", "null-many-short", "--days", "10", "--seed", "5", "--digest").out) as { sha256: string };
  const scaled = JSON.parse(run("--scenario", "null-many-short", "--days", "10", "--scale", "0.5", "--digest").out) as { sha256: string; files: number };
  assert.equal(again.sha256, base.sha256);
  assert.notEqual(seeded.sha256, base.sha256);
  assert.notEqual(scaled.sha256, base.sha256);
  assert.ok(scaled.files < base.files);
});

test("refuses to overwrite: foreign non-empty dirs, its own output without --replace, real agent directories", () => {
  const { root, done } = scratch();
  try {
    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "keep.txt"), "mine");
    const a = run("--scenario", "insufficient-new-user", "--out", foreign);
    assert.equal(a.code, 1);
    assert.match(a.err, /not empty and was not created by this generator/);
    assert.equal(readFileSync(join(foreign, "keep.txt"), "utf8"), "mine", "nothing was touched");

    const out = join(root, "out");
    assert.equal(run("--scenario", "insufficient-new-user", "--out", out).code, 0);
    const before = readTree(out);
    const b = run("--scenario", "insufficient-new-user", "--out", out);
    assert.equal(b.code, 1);
    assert.match(b.err, /--replace/);
    assert.deepEqual(readTree(out), before, "a refused run changes nothing");
    const c = run("--scenario", "insufficient-new-user", "--out", out, "--replace");
    assert.equal(c.code, 0, c.err);
    assert.deepEqual(readTree(out), before, "--replace regenerates byte-identically");

    // A generated directory that gained a foreign file is left exactly as it was.
    writeFileSync(join(out, "stray.txt"), "y");
    const mid = readTree(out);
    const d = run("--scenario", "insufficient-new-user", "--out", out, "--replace");
    assert.equal(d.code, 1);
    assert.match(d.err, /still has files this generator did not create \(stray\.txt\)/);
    assert.deepEqual(readTree(out), mid, "nothing was deleted");

    for (const bad of [join(root, ".claude"), join(root, ".codex"), join(root, ".claude", "projects"), join(root, ".codex", "sessions"), "/"]) {
      const r = run("--scenario", "insufficient-new-user", "--out", bad);
      assert.equal(r.code, 1, bad);
      assert.ok(!existsSync(join(bad, "synth-truth.json")), bad);
    }
  } finally {
    done();
  }
});

test("refuses to write anywhere inside a real agent directory: nested paths, other spellings, symlinks into one", () => {
  const { root, done } = scratch();
  try {
    // Every one of these would put synthetic rollouts / sessions where the agents (and wasitme) read real ones.
    const nested = [
      [".codex", "sessions", "x"], [".codex", "sessions", "2026", "07", "01"], [".codex", "archived_sessions", "a"], [".codex", "x"],
      [".claude", "projects", "x"], [".claude", "foo"], [".claude", "projects", "-Users-me-code", "x"],
      [".CODEX", "sessions", "x"], [".Claude", "x"], // case-insensitive volumes: the same folder under another spelling
      [".claude", "worktrees"], // the worktrees folder itself, not a checkout inside it
      [".claude", "worktrees", "w", ".codex", "sessions", "x"], // a checkout is fine, a real agent folder inside it is not
      ["proj", ".claude", "worktrees", "w", ".claude", "projects", "x"],
    ];
    for (const parts of nested) {
      const bad = join(root, ...parts);
      const r = run("--scenario", "insufficient-new-user", "--out", bad);
      assert.equal(r.code, 1, `${parts.join("/")}: ${r.out}`);
      assert.match(r.err, /real agent directory/, parts.join("/"));
      assert.ok(!existsSync(join(root, parts[0]!)), `${parts.join("/")}: nothing was created`);
      assert.throws(() => assertSafeOut(bad), /real agent directory/, parts.join("/"));
    }

    // A symlink pointing into an agent directory is caught through the link, whether the target path
    // exists yet or not, and whether --out is the link itself or something below it.
    const real = join(root, "elsewhere", ".codex", "sessions");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, "link"), "dir");
    symlinkSync(join(root, "elsewhere", ".claude", "projects"), join(root, "dangling"), "dir");
    symlinkSync(join(root, "loop"), join(root, "loop"), "dir");
    for (const bad of [join(root, "link"), join(root, "link", "x"), join(root, "link", "x", "y"), join(root, "dangling", "x"), join(root, "loop", "x")]) {
      const r = run("--scenario", "insufficient-new-user", "--out", bad);
      assert.equal(r.code, 1, `${bad}: ${r.out}`);
      assert.match(r.err, /real agent directory|cannot be resolved/, bad);
      assert.throws(() => assertSafeOut(bad));
    }
    assert.deepEqual(readdirSync(real), [], "nothing was written through the link");
    assert.ok(!existsSync(join(root, "elsewhere", ".claude")), "nothing was created through the dangling link");

    // Look-alikes are fine: only the exact folder names count.
    for (const parts of [["claude-demo", "x"], ["codex", "sessions", "x"], [".claude-demo", "x"], ["dot.codex", "x"]]) {
      assert.doesNotThrow(() => assertSafeOut(join(root, ...parts)), parts.join("/"));
    }
  } finally {
    done();
  }
});

test("a repository worktree under .claude/worktrees is not an agent directory: fixtures can be regenerated there", () => {
  const { root, done } = scratch();
  try {
    const out = join(root, "repo", ".claude", "worktrees", "wt-1", "testdata", "out");
    assert.doesNotThrow(() => assertSafeOut(out));
    const r = run("--scenario", "insufficient-new-user", "--out", out);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(out, "claude", "projects")));
    const again = run("--scenario", "insufficient-new-user", "--out", out, "--replace");
    assert.equal(again.code, 0, again.err);
  } finally {
    done();
  }
});

test("usage errors exit non-zero with a message", () => {
  assert.equal(run("--scenario", "no-such-scenario", "--out", "/tmp/x").code, 1);
  assert.match(run("--scenario", "no-such-scenario", "--out", "/tmp/x").err, /unknown scenario/);
  assert.match(run("--scenario", "null-few-long").err, /--out is required/);
  assert.match(run("--out", "/tmp/x").err, /--scenario is required/);
  assert.match(run("--bogus").err, /unknown argument/);
  assert.match(run("--seed", "abc", "--scenario", "null-few-long", "--digest").err, /--seed needs a number/);
});

test("the hostile scenarios and the golden table come out of the CLI too", () => {
  const { root, done } = scratch();
  try {
    const out = join(root, "hostile");
    const r = run("--scenario", "hostile", "--out", out);
    assert.equal(r.code, 0, r.err);
    const fresh = readTree(out);
    const committed = readTree(join(TESTDATA, "hostile"));
    for (const t of [fresh, committed]) t.delete(".wasitme-synth");
    assert.deepEqual([...fresh.keys()], [...committed.keys()]);
    for (const [p, e] of fresh) assert.equal(committed.get(p)!.sha256, e.sha256, p);

    const golden = join(root, "golden.json");
    const g = run("--golden", golden);
    assert.equal(g.code, 0, g.err);
    assert.equal(readFileSync(golden, "utf8"), readFileSync(join(TESTDATA, "seed", "golden.json"), "utf8"));
  } finally {
    done();
  }
});
