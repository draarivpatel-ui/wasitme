/**
 * WP-12 review regressions (home folder): the lock and the salt are linked into place complete (never visible empty),
 * a lock whose pid was reused goes stale by uptime age, and the SessionStart hook resolves a symlinked cwd before
 * reading anything. Synthetic data in temp homes only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sessionStartHook } from "../../src/hook/session-start.js";
import { ensureHome, homePaths } from "../../src/store/home.js";
import { acquireLock, LOCK_MAX_AGE_S, setUptimeSourceForTests } from "../../src/store/lock.js";
import { REPO, T0, tempEnv } from "./helpers.js";

const DIST = join(REPO, "engine", "dist", "src");

function runChild(script: string): Promise<string> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d) => { out += String(d); });
    c.on("close", () => resolve(out));
  });
}

/** Poll `path` until every child is done; return how often it existed but was empty or short. */
async function watchWhile(path: string, minBytes: number, children: Promise<string>[]): Promise<{ partial: number; seen: number; outs: string[] }> {
  let done = false;
  const all = Promise.all(children).then((o) => { done = true; return o; });
  let partial = 0, seen = 0;
  while (!done) {
    for (let i = 0; i < 2000; i++) {
      try {
        const b = readFileSync(path);
        seen++;
        if (b.length < minBytes) partial++;
      } catch { /* missing: fine */ }
    }
    await new Promise((r) => setImmediate(r));
  }
  return { partial, seen, outs: await all };
}

test("MEDIUM: the scan lock is never visible empty (link(2) into place), so a waiter cannot steal it from a live holder", async () => {
  const env = tempEnv("lock-link");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    const mod = pathToFileURL(join(DIST, "store", "lock.js")).href;
    const script = `const m = await import(${JSON.stringify(mod)}); let won = 0;
      for (let i = 0; i < 60; i++) { const l = m.acquireLock(${JSON.stringify(p.lock)}); if (l) { won++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); if (!l.held()) process.stdout.write("LOST "); l.release(); } }
      process.stdout.write(String(won));`;
    const r = await watchWhile(p.lock, 10, [runChild(script), runChild(script), runChild(script)]);
    assert.ok(r.seen > 0, "the poller saw the lock");
    assert.equal(r.partial, 0, "never empty or partial");
    assert.ok(r.outs.every((o) => /^\d+$/.test(o)), r.outs.join(","));
    assert.equal(existsSync(p.lock), false, "every holder released it");
  } finally {
    env.cleanup();
  }
});

test("LOW: a lock whose recorded pid is alive (reused) goes stale once it is older than any scan by uptime", () => {
  const env = tempEnv("lock-age");
  // A machine that has been up for a while, whatever this one's uptime is: a freshly booted CI runner has been up for
  // less than the bound, so "older than the bound" would be a negative uptime, which the lock reads as unknown.
  const UP = 2 * LOCK_MAX_AGE_S + 1000;
  setUptimeSourceForTests(() => UP);
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    // pid 1 is always alive (EPERM): a crashed scan's pid reused by a daemon looks exactly like this.
    writeFileSync(p.lock, JSON.stringify({ pid: 1, token: "crashed-scan", uptime: UP - 60 }) + "\n", { mode: 0o600 });
    assert.equal(acquireLock(p.lock), undefined, "younger than the bound: still treated as a live holder");
    writeFileSync(p.lock, JSON.stringify({ pid: 1, token: "crashed-scan", uptime: UP - LOCK_MAX_AGE_S - 60 }) + "\n", { mode: 0o600 });
    const l = acquireLock(p.lock);
    assert.ok(l, "older than the bound by uptime: stale");
    assert.equal(l.held(), true);
    assert.equal(JSON.parse(readFileSync(p.lock, "utf8")).uptime, UP, "the new holder records the same uptime source");
    l.release();
  } finally {
    setUptimeSourceForTests(undefined);
    env.cleanup();
  }
});

test("LOW: the salt is never visible empty or short while 8 processes race to create it", async () => {
  const env = tempEnv("salt-link");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    const mod = pathToFileURL(join(DIST, "store", "salt.js")).href;
    const script = `const m = await import(${JSON.stringify(mod)}); process.stdout.write(m.loadSalt(${JSON.stringify(p.salt)}, { create: true }));`;
    const r = await watchWhile(p.salt, 65, Array.from({ length: 8 }, () => runChild(script)));
    assert.equal(r.partial, 0);
    assert.equal(new Set(r.outs).size, 1, "one salt for everyone");
    assert.equal(readFileSync(p.salt, "latin1"), `${r.outs[0]}\n`);
  } finally {
    env.cleanup();
  }
});

test("LOW: the SessionStart hook refuses a cwd whose real path leaves $HOME through a symlink; a link inside $HOME is fine", () => {
  const env = tempEnv("hook-link");
  try {
    const outside = join(env.root, "outside-home");
    mkdirSync(join(outside, "secret-proj"), { recursive: true });
    writeFileSync(join(outside, "secret-proj", "CLAUDE.md"), "# outside rules\n");
    symlinkSync(outside, join(env.home, "code"));
    const r = sessionStartHook({ home: env.wh, userHome: env.home, cwd: join(env.home, "code", "secret-proj"), session: "s1", now: T0 });
    assert.deepEqual([r.wrote, r.skipped, r.states], [false, "bad-cwd", undefined], "nothing outside $HOME was read");
    // A symlink whose target stays below $HOME is read through its real path.
    mkdirSync(join(env.home, "work", "proj"), { recursive: true });
    writeFileSync(join(env.home, "work", "proj", "CLAUDE.md"), "# rules\n");
    symlinkSync(join(env.home, "work"), join(env.home, "w"));
    const ok = sessionStartHook({ home: env.wh, userHome: env.home, cwd: join(env.home, "w", "proj"), session: "s2", now: T0 });
    assert.equal(ok.wrote, true);
    assert.equal(ok.states?.claudeMd, "ok");
  } finally {
    env.cleanup();
  }
});
