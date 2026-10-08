/**
 * WP-12 review regressions (privacy): log-derived record types and labels that are prose or e-mail-shaped never reach
 * the shards, snapshot.json, glance.json or `scan --read-only` stdout. The hostile values are planted at test time in
 * a temp tree (testdata/hostile is pinned by golden hashes), using canaries from testdata/hostile/CANARIES.txt so
 * scripts/check-privacy.mjs recognises them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { labelOf } from "../../src/extract/configsnap/labels.js";
import { modelLabel } from "../../src/readers/claude/labels.js";
import { label } from "../../src/readers/codex/rollout.js";
import { makeHash, typeKey } from "../../src/util.js";
import { SessionBuilder, text } from "../fixtures/claude/builder.js";
import { Rollout, rolloutName, uuid } from "../fixtures/codex/build.js";
import { readJson, REPO, scanIn, TESTDATA, tempEnv } from "./helpers.js";

const CHECK = join(REPO, "scripts", "check-privacy.mjs");
const CLI = join(REPO, "engine", "dist", "src", "cli", "main.js");
const CANARIES = readFileSync(join(TESTDATA, "hostile", "CANARIES.txt"), "utf8").split("\n").map((l) => l.trim());
const PROSE = CANARIES.find((c) => c.startsWith("the launch codename is"))!;
const EMAIL = CANARIES.find((c) => /^canary\.synthcanary\d+@example\.invalid$/.test(c))!;
const TOKEN = CANARIES.find((c) => c.startsWith("ghp_"))!;

test("label shapes: prose, e-mail addresses and tokens are never a type key, a model or a setup label", () => {
  for (const bad of [PROSE, EMAIL, TOKEN, "a b", "x@y.z", "/Users/x/y"]) {
    assert.equal(typeKey(bad, "other"), "other", bad);
    assert.equal(typeKey(`codex:event_msg:${bad}`, "codex:unrecognised"), "codex:unrecognised", bad);
    assert.equal(modelLabel(bad), "other", bad);
    assert.equal(label(bad), "other", bad);
    assert.match(labelOf(makeHash("synthetic-test-salt"), bad), /^h:[0-9a-f]{8}$/, bad);
  }
  // Real shapes are kept: drift names (Codex item types are PascalCase), Vertex dates, context suffixes.
  for (const ok of ["relocated", "file-history-delta", "codex:item:WebSearch", "codex:event_msg:__proto__", "codex:fork-unresolved"]) assert.equal(typeKey(ok, "other"), ok);
  for (const ok of ["claude-opus-5-5@20260101", "claude-sonnet-5", "claude-opus-5@latest"]) assert.equal(modelLabel(ok), ok);
  for (const ok of ["gpt-6.1-sol", "gpt-oss:20b", "opus[1m]", "claude-opus-5@20260101"]) assert.equal(label(ok), ok);
});

test("MEDIUM: hostile record types, models, efforts and approval policies leave no canary in the home folder or the CLI output", async () => {
  const env = tempEnv("review-privacy");
  try {
    // Claude: unknown record types that are prose / an address, and a newest session whose model is an address.
    const dir = join(env.claude, "projects", "-synthetic-home-hostile");
    mkdirSync(dir, { recursive: true });
    const a = new SessionBuilder("sess-types", { start: "2026-07-01T10:00:00.000Z" });
    for (let i = 0; i < 3; i++) {
      a.prompt(`question ${i}`);
      a.response([text("answer")], { model: "claude-sonnet-5" });
      a.records.push({ type: PROSE, uuid: `t-prose-${i}`, timestamp: a.tick(1), sessionId: "sess-types" });
      a.records.push({ type: EMAIL, uuid: `t-mail-${i}`, timestamp: a.tick(1), sessionId: "sess-types" });
      a.records.push({ type: TOKEN, uuid: `t-tok-${i}`, timestamp: a.tick(1), sessionId: "sess-types" });
    }
    writeFileSync(join(dir, "sess-types.jsonl"), a.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const b = new SessionBuilder("sess-model", { start: "2026-07-05T10:00:00.000Z" });
    for (let i = 0; i < 2; i++) {
      b.prompt(`later question ${i}`);
      b.response([text("answer")], { model: EMAIL });
    }
    writeFileSync(join(dir, "sess-model.jsonl"), b.records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // Codex: an envelope, an event_msg and a response_item type set to canaries; turn_contexts whose model, effort and
    // approval policy are prose / an address; a session_meta whose cli_version is prose.
    const id = uuid(7001);
    const [t1, t2] = [uuid(70011), uuid(70012)];
    const r = new Rollout("2026-07-04T09:00:00Z").meta({ id, cli: PROSE })
      .started(t1).ctx(t1, { model: PROSE, effort: EMAIL, approval: PROSE }).user(t1, "first synthetic prompt").complete(t1)
      .rec(EMAIL, { x: 1 }).event(EMAIL).rec("response_item", { type: PROSE })
      .tick(60_000).started(t2).ctx(t2, { model: EMAIL, effort: PROSE, approval: { [EMAIL]: {} } }).user(t2, "second synthetic prompt").complete(t2);
    const path = join(env.codex, "sessions", "2026", "07", "04", rolloutName(id, "2026-07-04T09-00-00"));
    mkdirSync(join(env.codex, "sessions", "2026", "07", "04"), { recursive: true });
    writeFileSync(path, r.text());

    const rep = await scanIn(env);
    assert.equal(rep.wrote, true);
    const snap = readJson(join(env.wh, "snapshot.json"));
    const claude = snap.health.sources.find((s: any) => s.agent === "claude-code");
    const codex = snap.health.sources.find((s: any) => s.agent === "codex");
    assert.ok(claude.unknownTypes.other >= 9, JSON.stringify(claude.unknownTypes));
    assert.ok(codex.unknownTypes["codex:unrecognised"] >= 3, JSON.stringify(codex.unknownTypes));
    for (const ag of snap.agents) for (const v of Object.values(ag.setup)) assert.ok(typeof v !== "string" || !v.includes("@example"), String(v));

    const probe = spawnSync(process.execPath, [CHECK, "--require-canaries", env.wh], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    const out = spawnSync(process.execPath, [CLI, "scan", "--read-only", "--tz", "UTC"], {
      encoding: "utf8",
      env: { HOME: env.home, WASITME_HOME: env.wh, WASITME_CLAUDE_DIR: env.claude, WASITME_CODEX_DIR: env.codex, PATH: "/usr/bin:/bin" },
    });
    assert.equal(out.status, 0, out.stderr);
    const check = spawnSync(process.execPath, [CHECK, "--require-canaries", "-"], { input: out.stdout + out.stderr, encoding: "utf8" });
    assert.equal(check.status, 0, check.stdout);
  } finally {
    env.cleanup();
  }
});

test("MEDIUM: shards stored by a reader with the old label shapes are re-derived (labels/events family bump)", async () => {
  const env = tempEnv("review-relabel");
  try {
    const dir = join(env.claude, "projects", "-synthetic-home-relabel");
    mkdirSync(dir, { recursive: true });
    const s = new SessionBuilder("sess-relabel", { start: "2026-07-05T10:00:00.000Z" });
    for (let i = 0; i < 2; i++) {
      s.prompt(`question ${i}`);
      s.response([text("answer")], { model: EMAIL });
    }
    writeFileSync(join(dir, "sess-relabel.jsonl"), s.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    // A store written before the fix: label/event families at version 1, the address kept as the model.
    const old = { "claude-code": { labels: 1, events: 1 }, codex: { labels: 1, events: 1 } };
    await scanIn(env, { parserVersions: old });
    const shardDir = join(env.wh, "history", "shards");
    for (const n of readdirSync(shardDir)) {
      const sh = readJson(join(shardDir, n));
      for (const x of sh.exchanges) x.model = EMAIL;
      writeFileSync(join(shardDir, n), JSON.stringify(sh) + "\n", { mode: 0o600 });
    }
    const r = await scanIn(env);
    assert.ok(r.rederivedPartial + r.rederivedFull > 0, "the bumped families are re-derived from the logs");
    assert.equal(r.parsed, 0);
    for (const n of readdirSync(shardDir)) {
      const sh = readJson(join(shardDir, n));
      assert.deepEqual(sh.exchanges.map((x: any) => x.model), sh.exchanges.map(() => "other"));
      assert.equal(sh.pv.labels, 2);
    }
    const probe = spawnSync(process.execPath, [CHECK, "--require-canaries", env.wh], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  } finally {
    env.cleanup();
  }
});
