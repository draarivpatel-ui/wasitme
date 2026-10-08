/**
 * `wasitme history clear`: deletes the saved history and results, keeps the salt, the exclusions, engine.json, the
 * backups, the logs and the install; refuses without --yes when nothing can be asked; never runs beside a scan; and a
 * scan afterwards starts fresh (every source parsed again, the same salted ids). All in temp homes over the committed
 * synthetic corpus.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main.js";
import type { CliContext } from "../../src/cli/context.js";
import { clearHistory, clearTargets } from "../../src/store/clear.js";
import { homePaths } from "../../src/store/home.js";
import { copyCorpus, REPO, TESTDATA, tempEnv, type TempEnv } from "./helpers.js";

const CLI = join(REPO, "engine", "dist", "src", "cli", "main.js");

function cliEnv(env: TempEnv): NodeJS.ProcessEnv {
  return { HOME: env.home, WASITME_HOME: env.wh, WASITME_CLAUDE_DIR: env.claude, WASITME_CODEX_DIR: env.codex, PATH: "/usr/bin:/bin" };
}

function run(env: TempEnv, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cliEnv(env) });
}

/** A scanned home plus the things a clear must keep: exclusions, engine.json, a status-line backup, a log, the install. */
function scannedHome(name: string): TempEnv {
  const env = tempEnv(name);
  copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
  const s = run(env, "scan", "--tz", "UTC");
  assert.equal(s.status, 0, s.stderr);
  const p = homePaths(env.wh);
  writeFileSync(p.exclude, `${JSON.stringify({ dates: [{ from: "2026-01-01", to: "2026-01-02" }], projects: [], entrypoints: [] })}\n`, { mode: 0o600 });
  writeFileSync(p.engineJson, "{\"schema\": \"wasitme.engine/1\"}\n", { mode: 0o600 });
  mkdirSync(join(env.wh, "backups"), { mode: 0o700 });
  writeFileSync(join(env.wh, "backups", "statusline.json"), "{}\n", { mode: 0o600 });
  mkdirSync(p.logs, { recursive: true, mode: 0o700 });
  writeFileSync(join(p.logs, "scan.log"), "2026-07-08T12:00:00.000Z scan_failed internal\n", { mode: 0o600 });
  mkdirSync(join(env.wh, "versions", "0.1.0"), { recursive: true });
  writeFileSync(join(env.wh, "install-manifest"), "format\t1\n", { mode: 0o600 });
  mkdirSync(p.projsnapInbox, { recursive: true, mode: 0o700 });
  writeFileSync(join(p.projsnapInbox, "s1.json"), "{}\n", { mode: 0o600 });
  return env;
}

const kept = (env: TempEnv): Record<string, string> => {
  const p = homePaths(env.wh);
  const out: Record<string, string> = {};
  for (const f of [p.salt, p.exclude, p.engineJson, join(env.wh, "backups", "statusline.json"), join(p.logs, "scan.log"), join(env.wh, "install-manifest")]) out[f] = readFileSync(f, "utf8");
  return out;
};

test("history clear --yes: history and results go; salt, exclusions, engine.json, backups, logs and the install stay", () => {
  const env = scannedHome("hclear");
  try {
    const p = homePaths(env.wh);
    for (const f of [p.glance, p.snapshot, p.index, p.shards]) assert.ok(existsSync(f), `the scan wrote ${f}`);
    assert.ok(readdirSync(p.shards).length > 0);
    const before = kept(env);
    const r = run(env, "history", "clear", "--yes");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Deleted your saved wasitme history and results \(\d+ files, [\d.]+ (KB|MB|bytes)\)\. Your settings, exclusions and the install were kept\.\nThe next scan starts fresh/);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(env.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path is printed");
    for (const t of clearTargets(p)) assert.ok(!existsSync(t), `deleted: ${t}`);
    assert.deepEqual(kept(env), before, "everything else is byte-identical");
    assert.ok(existsSync(join(env.wh, "versions", "0.1.0")), "the install is untouched");
    assert.deepEqual(readdirSync(env.wh).filter((n) => n.startsWith(".cleared-")), [], "no leftovers");
    assert.ok(!existsSync(p.lock), "the lock was released");

    // A second clear has nothing left to delete.
    const again = run(env, "history", "clear", "--yes");
    assert.equal(again.status, 0);
    assert.equal(again.stdout, "There was no saved history to delete.\n");

    // The next scan starts fresh with the same salt: every source is parsed again and the results come back.
    const s = run(env, "scan", "--tz", "UTC");
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stdout, /^wasitme: scanned 22 sources, 22 parsed, 0 unchanged in \d+ ms\.\n$/);
    assert.equal(readFileSync(p.salt, "utf8"), before[p.salt], "the salt was kept, so exclusions still match");
    const g = JSON.parse(readFileSync(p.glance, "utf8"));
    assert.equal(g.scanOk, true);
    assert.equal(g.agents.length, 2);
  } finally {
    env.cleanup();
  }
});

test("history clear without --yes and without a terminal refuses (exit 2) and deletes nothing; --json is plain data", () => {
  const env = scannedHome("hclear-refuse");
  try {
    const p = homePaths(env.wh);
    for (const args of [["history", "clear"], ["history", "clear", "--json"]]) {
      const r = run(env, ...args);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /add --yes to proceed\. Nothing was deleted\./);
      assert.ok(existsSync(p.glance) && existsSync(p.index), "nothing was deleted");
    }
    for (const args of [["history"], ["history", "wipe"], ["history", "clear", "--force"]]) assert.equal(run(env, ...args).status, 2, args.join(" "));
    const j = run(env, "history", "clear", "--yes", "--json");
    assert.equal(j.status, 0, j.stderr);
    const doc = JSON.parse(j.stdout);
    assert.equal(doc.schema, "wasitme.history-clear/1");
    assert.equal(doc.cleared, true);
    assert.ok(doc.files > 0 && doc.bytes > 0);
    assert.ok(!existsSync(p.glance));
  } finally {
    env.cleanup();
  }
});

function ctxFor(env: TempEnv, answer: string | undefined, out: string[]): CliContext {
  return {
    env: cliEnv(env), stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => out.push(`ERR:${s}`) },
    stdoutIsTTY: true, columns: 80, platform: "darwin", now: () => new Date("2026-07-08T12:00:00Z"),
    stdinIsTTY: true, ...(answer === undefined ? {} : { ask: async (q: string) => { out.push(`Q:${q}`); return answer; } }),
  };
}

test("on a terminal it asks first: Enter or no keeps everything, yes deletes", async () => {
  const env = scannedHome("hclear-ask");
  try {
    const p = homePaths(env.wh);
    for (const answer of ["", "n", "nope"]) {
      const out: string[] = [];
      assert.equal(await main(["history", "clear"], ctxFor(env, answer, out)), 0);
      assert.match(out.join(""), /Q:Permanently delete your saved wasitme history and results \(\d+ files, [\d.]+ (KB|MB|bytes)\)\? Your settings, exclusions and the install stay\. \[y\/N\] /);
      assert.match(out.join(""), /Nothing was deleted\.\n$/);
      assert.ok(existsSync(p.glance) && existsSync(p.index), `answer ${JSON.stringify(answer)} deleted nothing`);
    }
    const out: string[] = [];
    assert.equal(await main(["history", "clear"], ctxFor(env, "y", out)), 0);
    assert.match(out.join(""), /Deleted your saved wasitme history/);
    assert.ok(!existsSync(p.glance) && !existsSync(p.history));
    const none: string[] = [];
    assert.equal(await main(["history", "clear"], ctxFor(env, "y", none)), 0);
    assert.equal(none.join(""), "There is no saved history to delete.\n", "nothing left: no question");
    // A terminal on stdout but nothing to ask with (no ask function) is the same as no terminal.
    const noAsk: string[] = [];
    assert.equal(await main(["history", "clear"], ctxFor(env, undefined, noAsk)), 2);
  } finally {
    env.cleanup();
  }
});

test("a running scan holds the lock: the clear waits, then gives up having deleted nothing; a missing home is not an error", async () => {
  const env = scannedHome("hclear-busy");
  try {
    const p = homePaths(env.wh);
    // A lock held by a live process (the test runner that started this file), written the way lock.ts writes it.
    writeFileSync(p.lock, `${JSON.stringify({ pid: process.ppid, token: "held-by-test", uptime: uptime() })}\n`, { mode: 0o600 });
    const t0 = Date.now();
    const r = await clearHistory(p, { waitMs: 600 });
    assert.ok(Date.now() - t0 >= 500, "it waited for the scan");
    assert.deepEqual(r, { existed: true, busy: true, files: 0, bytes: 0 });
    assert.ok(existsSync(p.glance) && existsSync(p.index), "nothing was deleted");
    assert.match(readFileSync(p.lock, "utf8"), /held-by-test/, "the scan's lock is untouched");
    const cli = run(env, "history", "clear", "--yes");
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /a scan is running right now, so nothing was deleted/);
    renameSync(p.lock, `${p.lock}.gone`);
    // An interrupted clear's leftover folder is removed by the next clear.
    mkdirSync(join(env.wh, ".cleared-0123456789ab", "shards"), { recursive: true });
    writeFileSync(join(env.wh, ".cleared-0123456789ab", "shards", "x.json"), "{}\n");
    const ok = await clearHistory(p, { waitMs: 0 });
    assert.equal(ok.busy, false);
    assert.ok(!existsSync(join(env.wh, ".cleared-0123456789ab")), "leftover removed");
    assert.ok(!existsSync(p.history));
    const missing = await clearHistory(homePaths(join(env.root, "no-such-home")), { waitMs: 0 });
    assert.deepEqual(missing, { existed: false, busy: false, files: 0, bytes: 0 });
    assert.ok(!existsSync(join(env.root, "no-such-home")), "and it creates nothing");
  } finally {
    env.cleanup();
  }
});
