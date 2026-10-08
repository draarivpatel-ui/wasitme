/**
 * Results must not depend on the file system the logs sit on. CI on Ubuntu once failed where macOS passed: Linux keeps
 * the real creation time of a file that was copied or written with an old mtime (APFS moves it back to the mtime), so the
 * resume-dedupe creation order followed the order the files were copied in, and a typed /model or /effort came out as an
 * `unknown` change. This file re-runs the acceptance paths that depend on that order (the D63 seed sweep, the store
 * review and scan tests, resume dedupe) on this machine with Linux-like birth times, ext4-like inode number reuse and
 * every directory listing reversed or shuffled (support/fs-emulate.ts), so macOS catches the same class of bug.
 * Synthetic data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { bornMs } from "../src/readers/fs.js";
import { installFsEmulation, parseEmulation } from "./support/fs-emulate.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // engine/dist/test
const ENGINE = join(HERE, "..", "..");
const PRELOAD = join(HERE, "support", "fs-emulate.js");
/** Shuffle seed; WASITME_TEST_FS_SEED=<n> replays another one. */
const SEED = Number(process.env.WASITME_TEST_FS_SEED ?? 20261007) >>> 0;

/** Run whole test files in a child process under the emulation; fail with its output (and how to replay it). */
function runUnder(spec: string, files: readonly string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env, WASITME_TEST_FS: spec };
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` would otherwise report to this runner, not to its stdout
  const args = ["--import", PRELOAD, "--test", "--test-concurrency=1", "--test-reporter=spec", ...files.map((f) => join(HERE, f))];
  const r = spawnSync(process.execPath, args, { cwd: ENGINE, env, encoding: "utf8", maxBuffer: 64 << 20, timeout: 600_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const replay = `WASITME_TEST_FS='${spec}' node --import dist/test/support/fs-emulate.js --test ${files.map((f) => `dist/test/${f}`).join(" ")}`;
  // The head of the failure details (not the tail: a long list of misses must show its first entries).
  const at = out.indexOf("✖ failing tests");
  assert.equal(r.status, 0, `failed under ${spec} (replay from engine/: ${replay})\n${at >= 0 ? out.slice(at, at + 6000) : out.slice(-6000)}`);
  const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0);
  assert.ok(pass > 0, `no test ran under ${spec}`);
}

/** The test files whose results depend on session creation order or listing order. */
const ORDER_SENSITIVE = [
  "readers/claude-d63.test.js",
  "store/review-scan.test.js",
  "store/review-priors.test.js",
  "store/scan.test.js",
  "store/dedupe.test.js",
  "acceptance/claude-resume.test.js",
];

test("bornMs: a birth time past an mtime that was set back after the file existed (a copy, a restore) gives way to the mtime", () => {
  const st = (birthtimeMs: number, mtimeMs: number, ctimeMs: number) => ({ birthtimeMs, mtimeMs, ctimeMs });
  assert.equal(bornMs(st(1_000, 5_000, 5_000)), 1_000, "born, then written: its birth time");
  assert.equal(bornMs(st(5_000, 5_000, 5_000)), 5_000);
  assert.equal(bornMs(st(9_000, 5_000, 9_500)), 5_000, "copied with its old mtime: Linux keeps the copy's birth time, APFS moves it to the mtime");
  assert.equal(bornMs(st(9_000, 5_000, 9_000)), 5_000, "a birth time equal to the last change");
  assert.equal(bornMs(st(9_000, 5_000, 6_000)), 9_000, "changed before it was born: the clock went backward, the birth time stands");
  assert.equal(bornMs(st(0, 5_000, 5_000)), 5_000, "no birth time recorded");
  assert.equal(bornMs({ birthtimeMs: 9_000n, mtimeMs: 5_000n, ctimeMs: 9_500n }), 5_000, "bigint stats");
  assert.equal(bornMs({ birthtimeMs: 1_000n, mtimeMs: 5_000n, ctimeMs: 5_000n }), 1_000);
});

test("the engine lists folders only with readdir and reads birth times only through bornMs (what the emulation covers)", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".ts")) continue;
      const rel = relative(ENGINE, p);
      const code = readFileSync(p, "utf8");
      if (/from\s*"node:fs(?:\/promises)?"/.test(code.replace(/(?:import|export)\s*(?:type\s*)?\{[^}]*\}\s*from\s*"node:fs(?:\/promises)?"/g, ""))) {
        offenders.push(`${rel}: imports node:fs other than by name (the check below reads named imports only)`);
      }
      for (const m of code.matchAll(/(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g)) {
        for (const name of m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, ""))) {
          if (/^(?:opendir|opendirSync|glob|globSync|Dir)$/.test(name)) offenders.push(`${rel}: imports ${name} (teach support/fs-emulate.ts to reorder it)`);
        }
      }
      if (/\b(?:fs|promises)\.(?:opendir|opendirSync|glob|globSync)\b/.test(code)) offenders.push(`${rel}: uses opendir/glob`);
      if (/birthtime/.test(code) && rel !== join("src", "readers", "fs.ts")) offenders.push(`${rel}: reads a birth time directly (use readers/fs.ts bornMs)`);
    }
  };
  walk(join(ENGINE, "src"));
  assert.deepEqual(offenders, []);
});

test("the emulation tells a new file from a deleted one that had the same inode number (ext4 reuses them)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wasitme-fsemu-"));
  const uninstall = installFsEmulation(parseEmulation("birth=copy;ino=reuse"));
  try {
    const old = Date.UTC(2026, 6, 1) / 1000;
    const a = join(dir, "a.jsonl");
    writeFileSync(a, "a\n");
    utimesSync(a, old, old);
    const sa = statSync(a, { bigint: true });
    assert.ok(Number(sa.birthtimeMs) > Number(sa.mtimeMs) && Number(sa.birthtimeMs) <= Number(sa.ctimeMs), "a copy's birth: after the old mtime, by the copy");
    assert.equal(bornMs(sa), Number(sa.mtimeMs));
    rmSync(a);
    const b = join(dir, "b.jsonl");
    writeFileSync(b, "b\n");
    utimesSync(b, old + 86_400, old + 86_400);
    const sb = statSync(b, { bigint: true });
    assert.equal(sb.ino, sa.ino, "the deleted file's inode number went to the new file");
    assert.notEqual(sb.birthtimeMs, sa.birthtimeMs, "the new file has a birth time of its own, not the deleted file's");
    assert.ok(Number(sb.birthtimeMs) > Number(sb.mtimeMs) && Number(sb.birthtimeMs) <= Number(sb.ctimeMs));
    assert.equal(bornMs(sb), Number(sb.mtimeMs));
  } finally {
    uninstall();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("order-sensitive acceptance paths pass on a copied tree whose folders list in shuffled order and whose inode numbers are reused", () => {
  runUnder(`birth=copy;dirs=shuffle:${SEED};ino=reuse`, ORDER_SENSITIVE);
});

test("the D63 seed sweep and the store review and scan tests pass with Linux birth times and inode reuse, every folder listed in reverse", () => {
  runUnder("birth=linux;dirs=reverse;ino=reuse", ["readers/claude-d63.test.js", "store/review-scan.test.js", "store/scan.test.js"]);
});
