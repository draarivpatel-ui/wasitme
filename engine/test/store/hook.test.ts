/**
 * `hook session-start` (D32; PRIVACY.md "What is read") and the snapshots the scan builds on: project snapshots
 * consolidated from the hook inbox, global config snapshots with side/strength/provenance, torn reads that never become
 * events, auth files that are never opened, and the "fully observed" rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { checkCwd, parseHookPayload, sessionStartHook } from "../../src/hook/session-start.js";
import { SessionBuilder, text } from "../fixtures/claude/builder.js";
import { readJson, REPO, scanIn, tempEnv, type TempEnv } from "./helpers.js";

const CANARY_MD = "# project rules SYNTHCANARY-HOOK-0001 never leave this file";
const CANARY_JSON = JSON.stringify({ env: { TOKEN: "sk-ant-api03-SYNTHCANARY-HOOK-0002" }, model: "claude-sonnet-5" });

function project(env: TempEnv, name = "work/proj-a"): string {
  const dir = join(env.home, name);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), CANARY_MD + "\n");
  writeFileSync(join(dir, ".claude", "settings.json"), CANARY_JSON);
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "SYNTHCANARY-HOOK-0003": { command: "x" } } }));
  return dir;
}

function inbox(env: TempEnv): string[] {
  const d = join(env.wh, "state", "projsnap");
  return existsSync(d) ? readdirSync(d) : [];
}

function noCanaries(dir: string): void {
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else assert.doesNotMatch(readFileSync(p, "latin1"), /SYNTHCANARY|\/work\/proj|proj-a/, `${n} holds raw text`);
    }
  };
  walk(dir);
}

test("hook: one record per run, 0600, hashes and sizes only (no file text, no path)", () => {
  const env = tempEnv("hook");
  try {
    const cwd = project(env);
    const r = sessionStartHook({ home: env.wh, userHome: env.home, cwd, session: "sess-hook-1", now: new Date("2026-09-05T10:00:00Z") });
    assert.equal(r.wrote, true);
    assert.equal(r.observed, true);
    assert.deepEqual(r.states, { claudeMd: "ok", claudeLocalMd: "missing", dotClaudeMd: "missing", settings: "ok", settingsLocal: "missing", mcpJson: "ok" });
    const files = inbox(env);
    assert.equal(files.length, 1);
    const p = join(env.wh, "state", "projsnap", files[0]!);
    assert.equal(statSync(p).mode & 0o777, 0o600);
    const rec = readJson(p);
    assert.match(rec.session, /^s-[0-9a-f]{12}$/);
    assert.ok(rec.projects.every((x: string) => /^p-[0-9a-f]{12}$/.test(x)));
    assert.equal(rec.items["claudeMd.present"], true);
    assert.match(rec.items["claudeMd.hash"], /^h:[0-9a-f]{8}$/);
    assert.equal(rec.items["claudeMd.bytes"], Buffer.byteLength(CANARY_MD + "\n"));
    noCanaries(env.wh);
  } finally {
    env.cleanup();
  }
});

test("hook: cwd guard — outside $HOME, $HOME itself, ancestors, `..`, `*`, newlines and relative paths are refused", () => {
  const home = "/Users/synthetic";
  for (const [cwd, why] of [
    ["/tmp/x", "outside-home"], ["/Users/synthetic", "outside-home"], ["/Users", "outside-home"], ["/", "outside-home"],
    ["/Users/synthetic/a/../b", "bad-cwd"], ["/Users/synthetic/a*b", "bad-cwd"], ["/Users/synthetic/a\nb", "bad-cwd"],
    ["relative/dir", "bad-cwd"], ["", "no-cwd"], [undefined, "no-cwd"], ["/Users/syntheticX/p", "outside-home"],
  ] as const) assert.equal(checkCwd(cwd, home), why, String(cwd));
  assert.equal(checkCwd("/Users/synthetic/code/p", home), undefined);
  const env = tempEnv("hook");
  try {
    const r = sessionStartHook({ home: env.wh, userHome: env.home, cwd: env.home });
    assert.equal(r.wrote, false);
    assert.equal(existsSync(env.wh), false, "a refused cwd writes nothing at all");
  } finally {
    env.cleanup();
  }
});

test("hook: payload parsing takes cwd and session_id only, bounded", () => {
  assert.deepEqual(parseHookPayload(JSON.stringify({ session_id: "abc", cwd: "/Users/x/p", transcript_path: "/secret", prompt: "hi" })), { cwd: "/Users/x/p", session: "abc" });
  assert.deepEqual(parseHookPayload("not json"), {});
  assert.deepEqual(parseHookPayload("x".repeat(300_000)), {});
});

test("hook: symlinks are not followed, a FIFO never blocks, big files are sized not hashed, half-written JSON is unknown", () => {
  const env = tempEnv("hook");
  try {
    const cwd = join(env.home, "work", "hostile");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(env.root, "outside.md"), "SYNTHCANARY-HOOK-OUTSIDE\n");
    symlinkSync(join(env.root, "outside.md"), join(cwd, "CLAUDE.md"));
    assert.equal(spawnSync("/usr/bin/mkfifo", [join(cwd, ".mcp.json")]).status, 0);
    writeFileSync(join(cwd, "CLAUDE.local.md"), Buffer.alloc(2 << 20, 0x61));
    mkdirSync(join(env.root, "elsewhere"));
    symlinkSync(join(env.root, "elsewhere"), join(cwd, ".claude"));
    const t0 = Date.now();
    const r = sessionStartHook({ home: env.wh, userHome: env.home, cwd, session: "s1" });
    assert.ok(Date.now() - t0 < 2000, "never blocks on a FIFO");
    assert.equal(r.states!.claudeMd, "symlink");
    assert.equal(r.states!.mcpJson, "not-file");
    assert.equal(r.states!.claudeLocalMd, "too-large");
    assert.equal(r.states!.settings, "symlink", "a symlinked .claude/ folder is not entered");
    const rec = readJson(join(env.wh, "state", "projsnap", inbox(env)[0]!));
    assert.equal(rec.items["claudeMd.present"], undefined, "unknown: no keys");
    assert.equal(rec.items["claudeLocalMd.present"], true);
    assert.equal(rec.items["claudeLocalMd.hash"], undefined);
    noCanaries(env.wh);

    const cwd2 = join(env.home, "work", "torn");
    mkdirSync(join(cwd2, ".claude"), { recursive: true });
    writeFileSync(join(cwd2, ".claude", "settings.json"), '{"model": "claude-son');
    const r2 = sessionStartHook({ home: env.wh, userHome: env.home, cwd: cwd2 });
    assert.equal(r2.states!.settings, "torn");
  } finally {
    env.cleanup();
  }
});

test("scan consolidates the hook inbox: project-file changes become you·strong project_snapshot events; the inbox is emptied", async () => {
  const env = tempEnv("hook");
  try {
    const cwd = project(env);
    sessionStartHook({ home: env.wh, userHome: env.home, cwd, session: "sess-p", now: new Date("2026-09-05T10:00:00Z") });
    writeFileSync(join(cwd, "CLAUDE.md"), CANARY_MD + "\nmore rules\n");
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ model: "claude-opus-5" }));
    sessionStartHook({ home: env.wh, userHome: env.home, cwd, session: "sess-q", now: new Date("2026-09-06T10:00:00Z") });
    // A later run that cannot read CLAUDE.md (torn) must not produce an event.
    writeFileSync(join(cwd, ".claude", "settings.json"), "{ half");
    sessionStartHook({ home: env.wh, userHome: env.home, cwd, session: "sess-r", now: new Date("2026-09-07T10:00:00Z") });
    assert.equal(inbox(env).length, 3);
    const s = new SessionBuilder("sess-p", { start: "2026-09-05T10:00:00.000Z" });
    s.prompt("hello");
    s.response([text("hi")]);
    mkdirSync(join(env.claude, "projects", "-p"), { recursive: true });
    writeFileSync(join(env.claude, "projects", "-p", "sess-p.jsonl"), s.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await scanIn(env, { now: new Date("2026-09-08T12:00:00Z") });
    assert.equal(inbox(env).length, 0);
    assert.equal(readJson(join(env.wh, "history", "projsnap.json")).records.length, 3);
    const snap = readJson(join(env.wh, "snapshot.json"));
    const claude = snap.agents.find((a: any) => a.agent === "claude-code");
    const proj = claude.timeline.filter((e: any) => e.provenance === "project_snapshot");
    // Labels are the words layer's (D59): no printable facet → "Settings changed"; instructions name the file; a
    // project's own files keep the scope cue (D63 words follow-up).
    assert.deepEqual(proj.map((e: any) => [e.kind, e.side, e.strength, e.label]).sort(), [
      ["config", "you", "weak", "Project settings changed"],
      ["instructions", "you", "strong", "Project CLAUDE.md changed"],
    ]);
    noCanaries(env.wh);
    // Idempotent re-ingest: nothing new.
    const before = readFileSync(join(env.wh, "history", "projsnap.json"));
    await scanIn(env, { now: new Date("2026-09-08T12:00:00Z") });
    assert.deepEqual(readFileSync(join(env.wh, "history", "projsnap.json")), before);
  } finally {
    env.cleanup();
  }
});

test("global config snapshots: baseline first, then you·strong / weak / meta events; a torn file is unknown, never an event", async () => {
  const env = tempEnv("config");
  try {
    const settings = join(env.claude, "settings.json");
    writeFileSync(settings, JSON.stringify({ model: "claude-sonnet-5", enabledPlugins: {} }));
    await scanIn(env, { now: new Date("2026-09-01T12:00:00Z") });
    assert.deepEqual(readJson(join(env.wh, "history", "config.json")).agents["claude-code"].events, []);
    writeFileSync(settings, JSON.stringify({ model: "claude-opus-5", enabledPlugins: {} }));
    await scanIn(env, { now: new Date("2026-09-02T12:00:00Z") });
    writeFileSync(settings, "{ \"model\": \"claude-opus-5\", \"enabledPl"); // torn mid-write
    await scanIn(env, { now: new Date("2026-09-03T12:00:00Z") });
    writeFileSync(settings, JSON.stringify({ model: "claude-opus-5", enabledPlugins: { "wasitme@wasitme": true } }));
    await scanIn(env, { now: new Date("2026-09-04T12:00:00Z") });
    const evs = readJson(join(env.wh, "history", "config.json")).agents["claude-code"].events;
    assert.deepEqual(evs.map((e: any) => [e.kind, e.side, e.strength, e.provenance, e.day]), [
      ["model", "you", "strong", "settings_snapshot", "2026-09-02"],
      ["plugins", "meta", "routine", "settings_snapshot", "2026-09-04"],
    ]);
    const days = readJson(join(env.wh, "history", "config.json")).agents["claude-code"].days;
    assert.deepEqual(days, ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  } finally {
    env.cleanup();
  }
});

test("auth.json and .credentials.json are never opened by a scan (fs spied), and their canaries never reach the home folder", async () => {
  const env = tempEnv("auth");
  writeFileSync(join(env.codex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-proj-SYNTHCANARY-AUTH-0001" }));
  writeFileSync(join(env.claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-SYNTHCANARY-AUTH-0002" } }));
  writeFileSync(join(env.codex, "config.toml"), 'model = "gpt-6"\n');
  writeFileSync(join(env.claude, "settings.json"), JSON.stringify({ model: "claude-sonnet-5" }));
  const touched: string[] = [];
  const opened = new Set<string>();
  const mutable = fs as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const name of ["openSync", "readFileSync", "open", "readFile", "createReadStream"]) {
    const orig = mutable[name] as (...a: unknown[]) => unknown;
    originals.set(name, orig);
    mutable[name] = function (this: unknown, ...args: unknown[]) {
      const p = typeof args[0] === "string" ? args[0] : String(args[0]);
      opened.add(p.split("/").pop()!);
      if (/auth\.json|\.credentials\.json/.test(p)) touched.push(`${name}:${p.split("/").pop()}`);
      return orig.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try {
    await scanIn(env, { now: new Date("2026-09-01T12:00:00Z") });
  } finally {
    for (const [name, orig] of originals) mutable[name] = orig;
    syncBuiltinESMExports();
  }
  try {
    // Positive control: the spy does see the collector's (named-import) opens of the files it IS allowed to read.
    assert.ok(opened.has("settings.json") && opened.has("config.toml"), `spy saw: ${[...opened].sort().join(", ")}`);
    assert.deepEqual(touched, []);
    const cfg = readJson(join(env.wh, "history", "config.json"));
    assert.ok(Object.keys(cfg.agents["claude-code"].last.items).length > 0, "the collector did run");
    assert.ok(Object.keys(cfg.agents.codex.last.items).length > 0);
    noCanaries(env.wh);
  } finally {
    env.cleanup();
  }
});

test("fully observed day: a global snapshot that day AND a project snapshot for every Claude session active that day", async () => {
  const env = tempEnv("observe");
  try {
    const cwd = project(env);
    const day1 = new SessionBuilder("sess-obs", { start: "2026-09-05T10:00:00.000Z" });
    day1.prompt("work");
    day1.response([text("ok")]);
    mkdirSync(join(env.claude, "projects", "-obs"), { recursive: true });
    writeFileSync(join(env.claude, "projects", "-obs", "sess-obs.jsonl"), day1.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    sessionStartHook({ home: env.wh, userHome: env.home, cwd, session: "sess-obs", now: new Date("2026-09-05T09:59:00Z") });
    await scanIn(env, { now: new Date("2026-09-05T20:00:00Z") }); // the global snapshot of 09-05
    const other = new SessionBuilder("sess-unobserved", { start: "2026-09-06T10:00:00.000Z" });
    other.prompt("more work");
    other.response([text("ok")]);
    writeFileSync(join(env.claude, "projects", "-obs", "sess-unobserved.jsonl"), other.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await scanIn(env, { now: new Date("2026-09-06T20:00:00Z") });
    const r = await scanIn(env, { now: new Date("2026-09-07T12:00:00Z") });
    // The days the attribution sees as fully observed (09-07 is today, never complete).
    const evidence = r.attributions!.find((a) => a.evaluation.agent === "claude-code")!.evidence;
    assert.deepEqual(evidence.fullyObservedDays, ["2026-09-05"], "09-05: snapshot + hook for its only session; 09-06: a session without a project snapshot");
    // The snapshot counts them over the recent window in use (words, D56 R11): one fully observed day, the rest partial.
    const claude = readJson(join(env.wh, "snapshot.json")).agents.find((a: any) => a.agent === "claude-code");
    assert.equal(claude.observation.fullyObservedDays, 1);
    assert.ok(claude.observation.partiallyObservedDays >= 1);
  } finally {
    env.cleanup();
  }
});

test("the CLI hook entry prints nothing and exits 0, even with garbage input", () => {
  const env = tempEnv("hookcli");
  try {
    const cli = join(REPO, "engine", "dist", "src", "cli", "main.js");
    const cwd = project(env);
    const run = (input: string, args: string[] = []) => spawnSync(process.execPath, [cli, "hook", "session-start", ...args], {
      input, encoding: "utf8", env: { HOME: env.home, WASITME_HOME: env.wh, PATH: "/usr/bin:/bin" },
    });
    const ok = run(JSON.stringify({ session_id: "sess-cli", cwd }));
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, "");
    assert.equal(ok.stderr, "");
    assert.equal(inbox(env).length, 1);
    for (const bad of ["", "nonsense", JSON.stringify({ cwd: "/etc" }), JSON.stringify({ cwd: 42 })]) {
      const r = run(bad);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    }
    assert.equal(run("", ["--bogus"]).status, 0);
    assert.equal(inbox(env).length, 1);
  } finally {
    env.cleanup();
  }
});

test("the CLI hook entry never hangs on a stdin that stays open (gives up after ~2 s, writes nothing, exits 0)", async () => {
  const env = tempEnv("hookcli");
  try {
    const cli = join(REPO, "engine", "dist", "src", "cli", "main.js");
    const t0 = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const c = spawn(process.execPath, [cli, "hook", "session-start"], { env: { HOME: env.home, WASITME_HOME: env.wh, PATH: "/usr/bin:/bin" }, stdio: ["pipe", "ignore", "ignore"] });
      c.stdin.write('{"cwd": "'); // a partial payload, and stdin is never closed
      c.on("close", (n) => resolve(n));
    });
    assert.equal(code, 0);
    assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
    assert.equal(inbox(env).length, 0);
  } finally {
    env.cleanup();
  }
});
