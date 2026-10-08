/**
 * Cross-file dedupe and dependency tracking at the store level (merge.ts; D39, D60):
 *  - a resumed Claude session's replay is dropped by the reader's priors; the store re-parses the dependent when a
 *    prior changes, and keeps it when a prior disappears (history);
 *  - a replay the reader cannot see (another project folder) is dropped by the store's origin dedupe, earliest copy
 *    wins;
 *  - Codex: an exchange whose UUID turn was copied into another rollout is counted once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replayInto, SessionBuilder, text, toolUseBlock } from "../fixtures/claude/builder.js";
import { Rollout, rolloutName, uuid } from "../fixtures/codex/build.js";
import { readJson, scanIn, tempEnv, type TempEnv } from "./helpers.js";

const NOW = new Date("2026-09-10T12:00:00Z");

function writeClaude(env: TempEnv, project: string, s: SessionBuilder): string {
  const dir = join(env.claude, "projects", project);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${s.id}.jsonl`);
  writeFileSync(p, s.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

function session(id: string, start: string, prompts: string[]): SessionBuilder {
  const s = new SessionBuilder(id, { start });
  for (const [i, q] of prompts.entries()) {
    s.prompt(q);
    s.response([toolUseBlock(`${id}-t${i}`, "Read", { file_path: `/synthetic/${i}.ts` })]);
    s.toolResult(`${id}-t${i}`);
    s.response([text("done")]);
  }
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Total real prompts the snapshot counted for Claude, over all history. */
function claudePrompts(env: TempEnv): number {
  const s = readJson(join(env.wh, "snapshot.json"));
  return s.agents.find((a: any) => a.agent === "claude-code").n.exchanges;
}

test("Claude resume: replay deduped by priors; prior changed → dependent re-parsed; prior deleted → dependent kept", async () => {
  const env = tempEnv("dedupe");
  try {
    const a = session("sess-a", "2026-09-01T10:00:00.000Z", ["first task", "second task"]);
    writeClaude(env, "-synthetic-proj", a);
    await sleep(20);
    const b = new SessionBuilder("sess-b", { start: "2026-09-02T10:00:00.000Z" });
    replayInto(b, a.records);
    b.prompt("third task, after resuming");
    b.response([text("ok")]);
    writeClaude(env, "-synthetic-proj", b);
    const r1 = await scanIn(env, { now: NOW });
    assert.equal(r1.parsed, 2);
    assert.equal(claudePrompts(env), 3, "the replayed prompts count once");

    // The prior grows: the dependent is re-parsed with it (D39).
    const pa = join(env.claude, "projects", "-synthetic-proj", "sess-a.jsonl");
    const extra = session("sess-a", "2026-09-01T12:00:00.000Z", ["late follow-up"]).records.map((r) => ({ ...r, uuid: `late-${String(r.uuid)}` }));
    appendFileSync(pa, extra.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r2 = await scanIn(env, { now: NOW });
    assert.equal(r2.parsed, 2, "the prior and its dependent");
    assert.equal(claudePrompts(env), 4);

    // The prior is deleted (Claude Code's cleanup): the dependent is NOT re-parsed (it would re-count the replay);
    // the prior's history stays.
    unlinkSync(pa);
    const r3 = await scanIn(env, { now: NOW });
    assert.equal(r3.parsed, 0);
    assert.equal(r3.historyOnly, 1);
    assert.equal(claudePrompts(env), 4);
  } finally {
    env.cleanup();
  }
});

test("Claude: a replay in ANOTHER project folder (invisible to priors) is dropped by the store; the earliest copy wins", async () => {
  const env = tempEnv("dedupe");
  try {
    const a = session("sess-orig", "2026-09-01T10:00:00.000Z", ["alpha", "beta", "gamma"]);
    writeClaude(env, "-synthetic-one", a);
    await sleep(20);
    const b = new SessionBuilder("sess-moved", { start: "2026-09-03T10:00:00.000Z" });
    replayInto(b, a.records);
    b.prompt("delta");
    b.response([text("ok")]);
    writeClaude(env, "-synthetic-two", b);
    const r = await scanIn(env, { now: NOW });
    assert.equal(r.crossFileDuplicates, 3);
    const s = readJson(join(env.wh, "snapshot.json"));
    const claude = s.agents.find((x: any) => x.agent === "claude-code");
    assert.equal(claude.n.exchanges, 4);
    assert.equal(claude.n.sessions, 2, "the three originals stay with the first session; the new prompt with the second");
    assert.ok(s.health.sources.find((x: any) => x.agent === "claude-code").duplicates >= 3);
  } finally {
    env.cleanup();
  }
});

test("Codex: a human turn copied into another rollout (same UUID turn id) counts once; counter ids never dedupe", async () => {
  const env = tempEnv("dedupe");
  try {
    const turn = uuid(500);
    const mk = (id: string, start: string, turnId: string) => new Rollout(start).meta({ id, threadSource: "user" })
      .started(turnId).ctx(turnId).user(turnId, "please refactor the parser").cmd(turnId).usage(turnId, `r-${id}`, { input: 5, output: 1 }).complete(turnId).text();
    const dir = join(env.codex, "sessions", "2026", "09", "01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, rolloutName(uuid(1), "2026-09-01T10-00-00")), mk(uuid(1), "2026-09-01T10:00:00Z", turn));
    writeFileSync(join(dir, rolloutName(uuid(2), "2026-09-01T11-00-00")), mk(uuid(2), "2026-09-01T11:00:00Z", turn));
    // Two different threads whose turns carry the same COUNTER id: distinct work, never merged.
    writeFileSync(join(dir, rolloutName(uuid(3), "2026-09-01T12-00-00")), mk(uuid(3), "2026-09-01T12:00:00Z", "turn-1"));
    writeFileSync(join(dir, rolloutName(uuid(4), "2026-09-01T13-00-00")), mk(uuid(4), "2026-09-01T13:00:00Z", "turn-1"));
    const r = await scanIn(env, { now: NOW });
    assert.equal(r.crossFileDuplicates, 1);
    const s = readJson(join(env.wh, "snapshot.json"));
    const codex = s.agents.find((x: any) => x.agent === "codex");
    assert.equal(codex.n.exchanges, 3);
    assert.equal(readdirSync(join(env.wh, "history", "shards")).length, 4, "every source keeps its own shard");
  } finally {
    env.cleanup();
  }
});
