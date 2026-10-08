/**
 * `wasitme scan` from the command line (the minimal WP-12 CLI): flags, output that never carries a path, exit codes,
 * two scans started at once, the `new` marks on events, and the failure glance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseUntil } from "../../src/store/time.js";
import { SessionBuilder, text } from "../fixtures/claude/builder.js";
import { copyCorpus, readJson, REPO, scanIn, TESTDATA, tempEnv, type TempEnv } from "./helpers.js";

const CLI = join(REPO, "engine", "dist", "src", "cli", "main.js");

function cliEnv(env: TempEnv): NodeJS.ProcessEnv {
  return { HOME: env.home, WASITME_HOME: env.wh, WASITME_CLAUDE_DIR: env.claude, WASITME_CODEX_DIR: env.codex, PATH: "/usr/bin:/bin" };
}

test("scan: one summary line, no paths; --read-only and --json print the snapshot; bad flags exit 2", () => {
  const env = tempEnv("cli");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cliEnv(env) });
    const a = run("scan", "--tz", "UTC", "--no-project-files");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /^wasitme: scanned 22 sources, 22 parsed, 0 unchanged in \d+ ms\.\n$/);
    const b = run("scan", "--tz", "UTC");
    assert.match(b.stdout, /22 unchanged \(results unchanged\)/);
    const ro = run("scan", "--read-only", "--tz", "UTC", "--until", "2026-07-05T23:59");
    assert.equal(ro.status, 0, ro.stderr);
    const snap = JSON.parse(ro.stdout);
    assert.equal(snap.schema, "wasitme.snapshot/1");
    for (const out of [a.stdout, b.stdout, ro.stdout]) assert.doesNotMatch(out, new RegExp(env.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    for (const [args, re] of [
      [["scan", "--until", "yesterday"], /--until must look like/], [["scan", "--tz", "Mars/Olympus"], /--tz is not a valid/],
      [["scan", "--bogus"], /unknown option --bogus/], [["frobnicate"], /unknown command/],
    ] as const) {
      const r = run(...args);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, re);
      assert.doesNotMatch(r.stderr, /\/Users\/|\/private\//);
    }
  } finally {
    env.cleanup();
  }
});

test("--until accepts RFC 3339 with an offset or a local wall time in the scan's zone; rejects impossible dates", () => {
  assert.equal(parseUntil("2026-10-03T23:59:00-05:00", "UTC").toISOString(), "2026-10-04T04:59:00.000Z");
  assert.equal(parseUntil("2026-10-03T23:59Z", "UTC").toISOString(), "2026-10-03T23:59:00.000Z");
  assert.equal(parseUntil("2026-10-03T23:59", "America/Chicago").toISOString(), "2026-10-04T04:59:00.000Z");
  assert.equal(parseUntil("2026-01-15T08:00:30", "America/Chicago").toISOString(), "2026-01-15T14:00:30.000Z");
  for (const bad of ["2026-02-30T10:00", "2026-10-03", "2026-10-03T25:00Z", "2026-10-03 23:59", "soon"]) assert.throws(() => parseUntil(bad, "UTC"), RangeError, bad);
});

test("two scans started at the same moment: one runs, the other skips; outputs stay valid", async () => {
  const env = tempEnv("cli");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    const outs = await Promise.all([0, 1, 2].map(() => new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, [CLI, "scan", "--tz", "UTC"], { env: cliEnv(env), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => { out += String(d); });
      c.on("close", (code) => resolve({ code, out }));
    })));
    for (const o of outs) assert.equal(o.code, 0);
    assert.ok(outs.some((o) => /scanned/.test(o.out)));
    const g = readJson(join(env.wh, "glance.json"));
    assert.equal(g.scanOk, true);
    assert.equal(g.agents.length, 2);
  } finally {
    env.cleanup();
  }
});

test("`new` marks: nothing is new on the first scan; an event that appears later is new for the next scan only", async () => {
  const env = tempEnv("new");
  try {
    const dir = join(env.claude, "projects", "-new");
    mkdirSync(dir, { recursive: true });
    const s = new SessionBuilder("sess-new", { start: "2026-09-01T10:00:00.000Z" });
    s.prompt("hi");
    s.response([text("a")], { model: "claude-sonnet-5" });
    s.prompt("again");
    s.response([text("b")], { model: "claude-sonnet-5" });
    writeFileSync(join(dir, "sess-new.jsonl"), s.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await scanIn(env, { now: new Date("2026-09-03T12:00:00Z") });
    const first = readJson(join(env.wh, "snapshot.json")).agents[0].timeline;
    assert.ok(first.every((e: any) => e.new === false));
    // A version bump arrives in the log.
    s.version = "2.1.251";
    s.prompt("third");
    s.response([text("c")], { model: "claude-sonnet-5" });
    writeFileSync(join(dir, "sess-new.jsonl"), s.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await scanIn(env, { now: new Date("2026-09-03T13:00:00Z") });
    const second = readJson(join(env.wh, "snapshot.json")).agents[0];
    const fresh = second.timeline.filter((e: any) => e.new);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].kind, "version");
    assert.equal(second.events.find((e: any) => e.kind === "version").new, true, "the glance carries the same mark");
    // Nothing changed since: nothing appeared since the previous scan, so the re-stamped outputs carry no mark —
    // exactly what a recompute against the previous snapshot gives (the reuse shortcut must not change the outputs).
    const third = await scanIn(env, { now: new Date("2026-09-03T13:00:00Z") });
    assert.equal(third.reused, true);
    const reusedGlance = readFileSync(join(env.wh, "glance.json"), "utf8");
    const reusedSnap = readFileSync(join(env.wh, "snapshot.json"), "utf8");
    assert.equal(JSON.parse(reusedSnap).agents[0].timeline.filter((e: any) => e.new).length, 0);
    assert.ok(JSON.parse(reusedGlance).agents[0].events.every((e: any) => e.new === false));
    const idx = readJson(join(env.wh, "history", "index.json"));
    idx.inputs = null;
    writeFileSync(join(env.wh, "history", "index.json"), JSON.stringify(idx) + "\n");
    const recomputed = await scanIn(env, { now: new Date("2026-09-03T13:00:00Z") });
    assert.equal(recomputed.reused, false);
    assert.equal(readFileSync(join(env.wh, "glance.json"), "utf8"), reusedGlance, "reuse and recompute give the same glance");
    assert.equal(readFileSync(join(env.wh, "snapshot.json"), "utf8"), reusedSnap, "and the same snapshot");
  } finally {
    env.cleanup();
  }
});

test("a failed scan keeps the last glance, flags scanOk:false with a kind (never text), and logs only the kind", async () => {
  const env = tempEnv("fail");
  try {
    copyCorpus(env, join(TESTDATA, "seed", "tiny-both"));
    await scanIn(env);
    const before = readJson(join(env.wh, "glance.json"));
    // The snapshot can no longer be written (something put a folder in its place).
    rmSync(join(env.wh, "snapshot.json"));
    mkdirSync(join(env.wh, "snapshot.json"));
    await assert.rejects(scanIn(env, { now: new Date("2026-07-09T12:00:00Z") }));
    const g = readJson(join(env.wh, "glance.json"));
    assert.equal(g.scanOk, false);
    assert.equal(g.scanError, "write_failed");
    assert.equal(g.generatedAt, before.generatedAt, "data age unchanged: surfaces show it as stale in time");
    assert.deepEqual(g.agents, before.agents);
    const log = readFileSync(join(env.wh, "logs", "scan.log"), "utf8");
    assert.match(log, /^\S+ scan_failed write_failed\n$/);
    // The next good scan clears it.
    rmSync(join(env.wh, "snapshot.json"), { recursive: true });
    await scanIn(env, { now: new Date("2026-07-09T12:00:00Z") });
    assert.equal(readJson(join(env.wh, "glance.json")).scanOk, true);
  } finally {
    env.cleanup();
  }
});

