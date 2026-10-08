/**
 * WP-12 review regressions (store/scan): the parse clock as a cache input, a missing salt next to existing history,
 * missing or damaged shards, a lost lock that must not overwrite the new holder's glance, the exclude list and the
 * history start, and the failure log that must not follow a symlink. Synthetic data in temp homes only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { claudeReader } from "../../src/readers/claude.js";
import { codexReader } from "../../src/readers/codex.js";
import { HomeError } from "../../src/store/home.js";
import { sessionStartHook } from "../../src/hook/session-start.js";
import type { Reader } from "../../src/types.js";
import { makeHash } from "../../src/util.js";
import { SessionBuilder, text } from "../fixtures/claude/builder.js";
import { Rollout, uuid, writeTree } from "../fixtures/codex/build.js";
import { copyCorpus, readJson, scanIn, T0, TEST_CALIBRATION, TESTDATA, tempEnv, treeDigest } from "./helpers.js";

const TINY = join(TESTDATA, "seed", "tiny-both");

/** The analysis part of a snapshot (no `new` marks, no salted event ids: two homes have two salts). */
function stateOf(snap: any): unknown {
  const strip = (e: any) => ({ ...e, new: undefined, id: undefined });
  // The status line's "+n" counts new events (words, D59): scan-history dependent like the `new` marks.
  return snap.agents.map((a: any) => ({ ...a, statusLine: a.statusLine.replace(/ \+\d+$/, ""), events: a.events.map(strip), timeline: a.timeline.map(strip) }));
}

/** A fresh home's state after scans at `nows` (the same scan days as the home it is compared with: the days a scan
 *  ran are an input — they are the days a global config snapshot was taken, which decide fully observed days). */
async function freshState(...nows: Date[]): Promise<unknown> {
  const ref = tempEnv("ref");
  try {
    copyCorpus(ref, TINY);
    for (const now of nows.length > 0 ? nows : [T0]) await scanIn(ref, { now });
    return stateOf(readJson(join(ref.wh, "snapshot.json")));
  } finally {
    ref.cleanup();
  }
}

const shardNames = (wh: string): string[] => readdirSync(join(wh, "history", "shards")).filter((n) => n.endsWith(".json")).sort();

test("HIGH: a scan run while the clock was set backward does not lose the records it saw as future-dated", async () => {
  const env = tempEnv("clock");
  try {
    copyCorpus(env, TINY);
    // The clock is set back into the middle of the corpus (2026-07-01..07-06): later records look future-dated.
    const back = new Date("2026-07-02T00:00:00Z");
    const r1 = await scanIn(env, { now: back });
    assert.ok(r1.parsed > 0);
    const idx = readJson(join(env.wh, "history", "index.json"));
    const withFuture = Object.values(idx.sources).filter((e: any) => e.fut !== null) as any[];
    assert.ok(withFuture.length > 0, "the manifest records which shards rejected future-dated records");
    for (const e of withFuture) assert.ok(e.fut > back.getTime() + 86_400_000);
    // Same wrong clock again: nothing is re-parsed (the horizon has not moved).
    const r2 = await scanIn(env, { now: back });
    assert.equal(r2.parsed, 0);
    // The clock is fixed. The files are unchanged, but the shards that rejected records are re-parsed.
    const r3 = await scanIn(env);
    assert.equal(r3.parsed, withFuture.length, "exactly the shards whose rejected records are now in range");
    assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), await freshState(), "same state as a scan that never saw the wrong clock");
    // And no perpetual re-parse afterwards.
    const r4 = await scanIn(env, { now: new Date(T0.getTime() + 3_600_000) });
    assert.equal(r4.parsed, 0);
  } finally {
    env.cleanup();
  }
});

test("HIGH: a record stamped far in the future (garbage) does not re-parse its source on every scan", async () => {
  const env = tempEnv("clock2");
  try {
    const dir = join(env.claude, "projects", "-garbage");
    mkdirSync(dir, { recursive: true });
    const s = new SessionBuilder("sess-garbage", { start: "2026-07-01T10:00:00.000Z" });
    s.prompt("hi");
    s.response([text("a")], { model: "claude-sonnet-5" });
    s.setTime("2099-01-01T00:00:00.000Z");
    s.prompt("from the far future");
    s.response([text("b")], { model: "claude-sonnet-5" });
    writeFileSync(join(dir, "sess-garbage.jsonl"), s.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    assert.equal((await scanIn(env)).parsed, 1);
    const idx = readJson(join(env.wh, "history", "index.json"));
    const fut = (Object.values(idx.sources)[0] as any).fut;
    assert.ok(fut >= Date.parse("2099-01-01T00:00:00.000Z") && fut < Date.parse("2099-01-02T00:00:00.000Z"), String(fut));
    assert.equal((await scanIn(env, { now: new Date(T0.getTime() + 86_400_000) })).parsed, 0);
  } finally {
    env.cleanup();
  }
});

test("MEDIUM: a missing salt next to existing history is refused (never a second salt that doubles every count)", async () => {
  const env = tempEnv("salt-missing");
  try {
    copyCorpus(env, TINY);
    await scanIn(env);
    const history = treeDigest(join(env.wh, "history"));
    const before = readJson(join(env.wh, "snapshot.json"));
    unlinkSync(join(env.wh, "salt"));
    await assert.rejects(scanIn(env, { now: new Date(T0.getTime() + 3_600_000) }), (e: unknown) => e instanceof HomeError && e.kind === "internal");
    assert.equal(existsSync(join(env.wh, "salt")), false, "no new salt was created");
    assert.deepEqual(treeDigest(join(env.wh, "history")), history, "history untouched");
    const g = readJson(join(env.wh, "glance.json"));
    assert.equal(g.scanOk, false);
    assert.equal(g.scanError, "internal");
    assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), stateOf(before), "the last snapshot is kept");
    // The SessionStart hook refuses the same way (it creates the salt on a first run, without the scan lock).
    const proj = join(env.home, "code", "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "CLAUDE.md"), "# rules\n");
    const h = sessionStartHook({ home: env.wh, userHome: env.home, cwd: proj, session: "s1", now: T0 });
    assert.deepEqual([h.wrote, h.skipped], [false, "home-error"]);
    assert.equal(existsSync(join(env.wh, "salt")), false);
  } finally {
    env.cleanup();
  }
});

test("MEDIUM: a shard that is missing or damaged while its source is on disk is rebuilt; a lost history-only shard is reported", async () => {
  const env = tempEnv("shard-lost");
  try {
    copyCorpus(env, TINY);
    await scanIn(env);
    const names = shardNames(env.wh);
    unlinkSync(join(env.wh, "history", "shards", names[0]!));
    writeFileSync(join(env.wh, "history", "shards", names[1]!), "garbage");
    // A different day: the inputs change, so the outputs are recomputed from every shard.
    const day2 = new Date(T0.getTime() + 86_400_000);
    const r = await scanIn(env, { now: day2 });
    assert.equal(r.reused, false);
    assert.equal(r.rebuiltShards, 2);
    assert.equal(r.lostShards, 0);
    // A rebuilt source is "parsed", never also "unchanged": the summary's counts add up to the sources scanned.
    assert.equal(r.parsed, 2);
    assert.equal(r.parsed + r.unchanged + r.rederivedPartial + r.rederivedFull + r.failed, r.sources, JSON.stringify({ parsed: r.parsed, unchanged: r.unchanged, sources: r.sources }));
    assert.deepEqual(shardNames(env.wh), names, "both shards are back");
    assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), await freshState(T0, day2));
    // The rebuilt state is stable: the next scan finds nothing to rebuild.
    const again = await scanIn(env, { now: new Date(day2.getTime() + 86_400_000) });
    assert.equal(again.rebuiltShards, 0);
    assert.equal(again.parsed, 0);

    // History only (its log is gone): the loss cannot be repaired, but it is counted on every analysis.
    const idx = readJson(join(env.wh, "history", "index.json"));
    const [sid] = Object.entries(idx.sources).find(([, e]: [string, any]) => e.agent === "codex" && e.n > 0)!;
    const rollouts: string[] = [];
    const walk = (d: string): void => { for (const n of readdirSync(d, { withFileTypes: true })) n.isDirectory() ? walk(join(d, n.name)) : rollouts.push(join(d, n.name)); };
    walk(env.codex);
    for (const p of rollouts) unlinkSync(p);
    await scanIn(env, { now: new Date(day2.getTime() + 2 * 86_400_000) });
    unlinkSync(join(env.wh, "history", "shards", `${sid}.json`));
    const lost = await scanIn(env, { now: new Date(day2.getTime() + 3 * 86_400_000) });
    assert.equal(lost.lostShards, 1);
  } finally {
    env.cleanup();
  }
});

test("MEDIUM: a scan whose lock was taken over writes nothing more: the new holder's glance stays as it is", async () => {
  const env = tempEnv("lock-lost");
  try {
    copyCorpus(env, TINY);
    await scanIn(env);
    const lockPath = join(env.wh, "state", "scan.lock");
    const thiefGlance = JSON.stringify({ ...readJson(join(env.wh, "glance.json")), generatedAt: "2026-07-08T12:30:00Z" }) + "\n";
    // A reader that, mid-scan, plays the process that (wrongly) judged us dead: it takes the lock and commits a glance.
    const thief: Reader = {
      ...codexReader,
      list() {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "thief", uptime: uptime() }) + "\n", { mode: 0o600 });
        writeFileSync(join(env.wh, "glance.json"), thiefGlance, { mode: 0o600 });
        return codexReader.list();
      },
    };
    const idx = readJson(join(env.wh, "history", "index.json"));
    idx.inputs = null; // force a full analysis, so the scan reaches its commit point
    writeFileSync(join(env.wh, "history", "index.json"), JSON.stringify(idx) + "\n");
    await assert.rejects(scanIn(env, { readers: [claudeReader, thief] }), /taken over/);
    assert.equal(readFileSync(join(env.wh, "glance.json"), "utf8"), thiefGlance, "the victim did not write its failure glance");
    assert.equal(readJson(lockPath).token, "thief", "and did not release the thief's lock");
    assert.equal(existsSync(join(env.wh, "logs", "scan.log")), false, "nor log a failure that was not its own");
  } finally {
    env.cleanup();
  }
});

test("LOW: the failure log never writes through a symlink planted at logs/scan.log", async () => {
  const env = tempEnv("log-link");
  try {
    copyCorpus(env, TINY);
    await scanIn(env);
    const outside = join(env.root, "outside.txt");
    writeFileSync(outside, "ORIGINAL\n");
    mkdirSync(join(env.wh, "logs"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(env.wh, "logs", "scan.log"));
    writeFileSync(join(env.wh, "salt"), "not a salt at all, but long enough to not be a partial write.................\n", { mode: 0o600 });
    await assert.rejects(scanIn(env, { now: new Date(T0.getTime() + 3_600_000) }));
    assert.equal(readFileSync(outside, "utf8"), "ORIGINAL\n");
    assert.equal(readJson(join(env.wh, "glance.json")).scanOk, false, "the failure is still flagged in the glance");
  } finally {
    env.cleanup();
  }
});

test("LOW: re-stamped outputs carry no stale `new` marks (reuse equals a recompute)", async () => {
  const env = tempEnv("restamp");
  try {
    copyCorpus(env, TINY);
    // First scan with the cutoff before the last day, then without: the later events are new once.
    await scanIn(env, { until: new Date("2026-07-03T00:00:00Z") });
    await scanIn(env);
    const marked = readJson(join(env.wh, "snapshot.json")).agents.flatMap((a: any) => a.timeline).filter((e: any) => e.new).length;
    assert.ok(marked > 0, "the events after the old cutoff are new");
    const r = await scanIn(env);
    assert.equal(r.reused, true);
    const reused = readFileSync(join(env.wh, "snapshot.json"), "utf8");
    const reusedGlance = readFileSync(join(env.wh, "glance.json"), "utf8");
    assert.equal(JSON.parse(reused).agents.flatMap((a: any) => [...a.timeline, ...a.events]).filter((e: any) => e.new).length, 0);
    const idx = readJson(join(env.wh, "history", "index.json"));
    idx.inputs = null;
    writeFileSync(join(env.wh, "history", "index.json"), JSON.stringify(idx) + "\n");
    assert.equal((await scanIn(env)).reused, false);
    assert.equal(readFileSync(join(env.wh, "snapshot.json"), "utf8"), reused);
    assert.equal(readFileSync(join(env.wh, "glance.json"), "utf8"), reusedGlance);
  } finally {
    env.cleanup();
  }
});

function session(dir: string, id: string, startIso: string, n: number, cwd: string): void {
  mkdirSync(dir, { recursive: true });
  const s = new SessionBuilder(id, { start: startIso, cwd });
  for (let i = 0; i < n; i++) {
    s.prompt(`question ${i}`);
    s.response([text(`answer ${i}`)], { model: "claude-sonnet-5" });
    s.tick(120);
  }
  writeFileSync(join(dir, `${id}.jsonl`), s.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("LOW: an excluded project does not count as history (the history start follows the exclude list)", async () => {
  const late = (root: string): void => {
    for (let d = 0; d < 12; d++) {
      const day = new Date(Date.parse("2026-06-26T10:00:00Z") + d * 86_400_000).toISOString();
      session(join(root, "projects", "-late"), `late-${d}`, day, 3, "/synthetic/home/late");
    }
  };
  // Calibrated (test-only artifact): the documents carry the history requirement (progress, headline) compared here.
  const cal = { calibration: TEST_CALIBRATION };
  const withEarly = tempEnv("first-a");
  const without = tempEnv("first-b");
  try {
    late(withEarly.claude);
    late(without.claude);
    for (let d = 0; d < 4; d++) {
      session(join(withEarly.claude, "projects", "-early"), `early-${d}`, new Date(Date.parse("2026-04-01T10:00:00Z") + d * 86_400_000).toISOString(), 3, "/synthetic/home/early");
    }
    await scanIn(withEarly, cal);
    const salt = readFileSync(join(withEarly.wh, "salt"), "latin1").trim();
    writeFileSync(join(withEarly.wh, "state", "exclude.json"), JSON.stringify({ projects: [makeHash(salt)("-early", "p-")] }));
    const r = await scanIn(withEarly, cal);
    assert.ok(r.excluded > 0);
    await scanIn(without, cal);
    const a = readJson(join(withEarly.wh, "snapshot.json")).agents[0];
    const b = readJson(join(without.wh, "snapshot.json")).agents[0];
    assert.equal(a.n.exchanges, b.n.exchanges);
    assert.ok(a.progress !== null, "the comparison is not vacuous: the history requirement is on show");
    assert.deepEqual([a.tier, a.windows, a.progress, a.headline], [b.tier, b.windows, b.progress, b.headline], "same history as a home that never had the excluded project");
  } finally {
    withEarly.cleanup();
    without.cleanup();
  }
});

/** A parent Codex thread with a linked subagent, plus one unrelated older rollout. */
function codexFamily(root: string, childCmds: number): { child: string; unrelated: string } {
  const P = uuid(9010), C = uuid(9011), U = uuid(9012), tp = uuid(90100), tc = uuid(90110), tu = uuid(90120);
  const parent = new Rollout("2026-07-03T10:00:00Z").meta({ id: P, threadSource: "user" })
    .started(tp).ctx(tp).user(tp, "spawn a helper").subActivity(tp, C).usage(tp, "rp", { input: 5, output: 1 }).complete(tp).text();
  let child = new Rollout("2026-07-03T10:00:05Z").meta({ id: C, parent: P, source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1 } } }, threadSource: "subagent" })
    .started(tc).ctx(tc, { root: tp });
  for (let i = 0; i < childCmds; i++) child = child.cmd(tc);
  const childText = child.usage(tc, "rc", { input: 3 * childCmds, output: childCmds }, tp).complete(tc).text();
  const unrelated = new Rollout("2026-07-01T09:00:00Z").meta({ id: U }).started(tu).ctx(tu).user(tu, "unrelated work").complete(tu).text();
  const { paths } = writeTree([
    { id: P, content: parent, date: "2026/07/03", stamp: "2026-07-03T10-00-00" },
    { id: C, content: childText, date: "2026/07/03", stamp: "2026-07-03T10-00-05" },
    { id: U, content: unrelated, date: "2026/07/01", stamp: "2026-07-01T09-00-00" },
  ], root);
  return { child: paths.get(C)!, unrelated: paths.get(U)! };
}

/** subToolCalls/subTokens of the Codex exchanges that carry subagent work. */
function subFields(wh: string): number[][] {
  const out: number[][] = [];
  for (const n of readdirSync(join(wh, "history", "shards"))) {
    const s = readJson(join(wh, "history", "shards", n));
    if (s.agent !== "codex") continue;
    for (const x of s.exchanges) if (x.subToolCalls > 0) out.push([x.subToolCalls, x.subTokens]);
  }
  return out;
}

test("LOW: a dependency that changed in the same scan as an unrelated deletion still re-parses its dependent", async () => {
  const env = tempEnv("dep-masked");
  const ref = tempEnv("dep-ref");
  try {
    const { child, unrelated } = codexFamily(env.codex, 1);
    await scanIn(env);
    const before = subFields(env.wh);
    assert.equal(before.length, 1);
    // The child grows (only its file is rewritten) and, before the next scan, an unrelated old rollout is deleted
    // (Codex's own cleanup, say).
    const { child: grown } = codexFamily(ref.root + "/staging", 3);
    writeFileSync(child, readFileSync(grown));
    unlinkSync(unrelated);
    const r2 = await scanIn(env);
    assert.equal(r2.parsed, 2, "the child and its parent");
    const { unrelated: u2 } = codexFamily(ref.codex, 3);
    unlinkSync(u2);
    await scanIn(ref);
    assert.notDeepEqual(subFields(ref.wh), before, "the grown child changes the parent's subagent fields");
    assert.deepEqual(subFields(env.wh), subFields(ref.wh), "the parent was re-parsed with the grown child");
    // A dependency that only disappears still keeps the stored result (history survives deletion of the logs).
    const kept = subFields(env.wh);
    const r = await scanIn(env, { now: new Date(T0.getTime() + 3_600_000) });
    assert.equal(r.parsed, 0);
    unlinkSync(join(env.codex, "sessions", "2026", "07", "03", `rollout-2026-07-03T10-00-05-${uuid(9011)}.jsonl`));
    const gone = await scanIn(env, { now: new Date(T0.getTime() + 7_200_000) });
    assert.equal(gone.parsed, 0, "the parent is not re-parsed without its child");
    assert.deepEqual(subFields(env.wh), kept);
  } finally {
    env.cleanup();
    ref.cleanup();
  }
});
