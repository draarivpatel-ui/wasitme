/**
 * Scan lock and salt (D60; PRIVACY.md "What is stored"): single writer with stale-lock recovery by pid liveness (never by age,
 * so a clock set backward cannot break or wedge it), and an O_EXCL 0600 salt that concurrent creators agree on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireLock, setUptimeSourceForTests } from "../../src/store/lock.js";
import { ensureHome, homePaths } from "../../src/store/home.js";
import { loadSalt } from "../../src/store/salt.js";
import { REPO, tempEnv } from "./helpers.js";

const DIST = join(REPO, "engine", "dist", "src");

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

test("lock: one holder at a time; release frees it; a second acquire in the same process is busy", () => {
  const env = tempEnv("lock");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    const a = acquireLock(p.lock);
    assert.ok(a);
    assert.equal(acquireLock(p.lock), undefined);
    assert.equal(a.held(), true);
    assert.equal(statSync(p.lock).mode & 0o777, 0o600);
    a.release();
    assert.equal(existsSync(p.lock), false);
    const b = acquireLock(p.lock);
    assert.ok(b);
    b.release();
  } finally {
    env.cleanup();
  }
});

test("lock: a lock whose holder is dead is taken over, however OLD or however far in the FUTURE its file looks", () => {
  const env = tempEnv("lock");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    writeFileSync(p.lock, JSON.stringify({ pid: deadPid(), token: "dead-holder", uptime: 1 }) + "\n", { mode: 0o600 });
    // A clock set backward makes the file look like it comes from the future; age is never consulted.
    const future = new Date(Date.now() + 365 * 86400_000);
    utimesSync(p.lock, future, future);
    const l = acquireLock(p.lock);
    assert.ok(l, "dead holder → stale");
    l.release();
  } finally {
    env.cleanup();
  }
});

test("lock: a live holder is never broken, however old its file looks; a reboot since it was written frees it", async () => {
  const env = tempEnv("lock");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
    try {
      writeFileSync(p.lock, JSON.stringify({ pid: child.pid, token: "live-holder", uptime: uptime() }) + "\n", { mode: 0o600 });
      const past = new Date(Date.UTC(2020, 0, 1));
      utimesSync(p.lock, past, past);
      assert.equal(acquireLock(p.lock), undefined, "live pid → busy");
      // Same live pid, but the lock records an uptime above the current one: the machine rebooted since → stale.
      writeFileSync(p.lock, JSON.stringify({ pid: child.pid, token: "pre-reboot", uptime: uptime() + 10_000 }) + "\n", { mode: 0o600 });
      const l = acquireLock(p.lock);
      assert.ok(l);
      l.release();
    } finally {
      child.kill();
    }
  } finally {
    env.cleanup();
  }
});

test("lock: an empty or garbled lock file (holder died mid-write) is taken over; a stolen lock reports held() = false", () => {
  const env = tempEnv("lock");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    writeFileSync(p.lock, "", { mode: 0o600 });
    const l = acquireLock(p.lock);
    assert.ok(l);
    // Someone (wrongly) replaces it: the original holder must notice before committing anything.
    writeFileSync(p.lock, JSON.stringify({ pid: process.pid, token: "other", uptime: uptime() }) + "\n");
    assert.equal(l.held(), false);
    l.release(); // must not delete the other holder's file
    assert.equal(existsSync(p.lock), true);
  } finally {
    env.cleanup();
  }
});

test("lock: 8 processes race for it; exactly one wins", async () => {
  const env = tempEnv("lock");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    const mod = pathToFileURL(join(DIST, "store", "lock.js")).href;
    const script = `import(${JSON.stringify(mod)}).then((m) => { const l = m.acquireLock(${JSON.stringify(p.lock)}); process.stdout.write(l ? "won" : "busy"); setTimeout(() => {}, 300); });`;
    const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      c.stdout.on("data", (d) => { out += String(d); });
      c.on("close", () => resolve(out));
    })));
    assert.equal(outs.filter((o) => o === "won").length, 1, outs.join(","));
  } finally {
    env.cleanup();
  }
});

test("salt: created once with O_EXCL, 0600, 64 hex; 8 concurrent creators all read the same salt", async () => {
  const env = tempEnv("salt");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    const mod = pathToFileURL(join(DIST, "store", "salt.js")).href;
    const script = `import(${JSON.stringify(mod)}).then((m) => process.stdout.write(m.loadSalt(${JSON.stringify(p.salt)}, { create: true })));`;
    const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      c.stdout.on("data", (d) => { out += String(d); });
      c.on("close", () => resolve(out));
    })));
    assert.equal(new Set(outs).size, 1, "every creator ends with the same salt");
    assert.match(outs[0]!, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(p.salt, "latin1"), `${outs[0]}\n`);
    assert.equal(statSync(p.salt).mode & 0o777, 0o600);
    assert.equal(loadSalt(p.salt, { create: true }), outs[0]);
  } finally {
    env.cleanup();
  }
});

test("salt: a malformed or foreign salt is refused, never overwritten (that would orphan every stored id)", () => {
  const env = tempEnv("salt");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    writeFileSync(p.salt, "not a salt at all, but long enough to not be a partial write.................\n", { mode: 0o600 });
    assert.throws(() => loadSalt(p.salt, { create: true }), /not usable/);
    assert.match(readFileSync(p.salt, "utf8"), /^not a salt/);
  } finally {
    env.cleanup();
  }
});

test("salt: readable by others → tightened to 0600; still the same salt", () => {
  const env = tempEnv("salt");
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    const s = loadSalt(p.salt, { create: true });
    spawnSync("/bin/chmod", ["0644", p.salt]);
    assert.equal(loadSalt(p.salt, { create: false }), s);
    assert.equal(statSync(p.salt).mode & 0o777, 0o600);
  } finally {
    env.cleanup();
  }
});

test("lock: a sandbox that refuses os.uptime() (Codex's macOS sandbox) still scans; the lock is judged by pid only", () => {
  const env = tempEnv("lock-noup");
  setUptimeSourceForTests(() => { throw Object.assign(new Error("uv_uptime blocked"), { code: "EPERM" }); });
  try {
    const p = homePaths(env.wh);
    ensureHome(p);
    const a = acquireLock(p.lock);
    assert.ok(a, "acquire must not throw when uptime is unavailable");
    assert.equal(JSON.parse(readFileSync(p.lock, "utf8")).uptime, -1);
    assert.equal(acquireLock(p.lock), undefined, "a live holder is still busy");
    a.release();
    // A lock left by a dead process with an unknown uptime is taken over (pid liveness alone) ...
    writeFileSync(p.lock, `${JSON.stringify({ pid: deadPid(), token: "t-dead", uptime: -1 })}\n`, { mode: 0o600 });
    const b = acquireLock(p.lock);
    assert.ok(b, "a dead holder's lock is stale even with uptime unknown");
    b.release();
    // ... and a lock written with a real uptime is never judged by age while ours is unknown.
    writeFileSync(p.lock, `${JSON.stringify({ pid: process.ppid, token: "t-live", uptime: 1 })}\n`, { mode: 0o600 });
    assert.equal(acquireLock(p.lock), undefined, "a live holder's lock is busy, whatever its recorded uptime");
  } finally {
    setUptimeSourceForTests(undefined);
    env.cleanup();
  }
});
