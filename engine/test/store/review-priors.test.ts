/**
 * WP-12 review regression (perf): the Claude resume-dedupe index is backed by the store, so a fresh process (every hook
 * and LaunchAgent scan is one) that re-parses the newest session of a project reads no earlier session's log — and the
 * dedupe it does with the stored ids gives exactly the state of a scan from scratch. Synthetic data in temp homes only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearPriorCache, priorDiskReads } from "../../src/readers/claude/priors.js";
import { pause, replayInto, SessionBuilder, text, writeSession } from "../fixtures/claude/builder.js";
import { readJson, scanIn, tempEnv, type TempEnv } from "./helpers.js";

const P = "-synthetic-home-big";

function stateOf(snap: any): unknown {
  const strip = (e: any) => ({ ...e, new: undefined, id: undefined });
  return snap.agents.map((a: any) => ({ ...a, events: a.events.map(strip), timeline: a.timeline.map(strip) }));
}

/** The state a home that never scanned these logs before gets from them. */
async function scratchState(env: TempEnv): Promise<unknown> {
  const other = tempEnv("priors-ref");
  try {
    clearPriorCache();
    await scanIn({ ...other, claude: env.claude, codex: env.codex });
    return stateOf(readJson(join(other.wh, "snapshot.json")));
  } finally {
    other.cleanup();
  }
}

test("MEDIUM: a fresh process re-parsing the newest session of a big project reads no earlier session's log", async () => {
  const env = tempEnv("priors");
  try {
    // One project, nine sessions, each resuming the previous one (it replays every earlier record).
    const sessions: SessionBuilder[] = [];
    for (let i = 0; i < 9; i++) {
      const s = new SessionBuilder(`sess-${i}`, { start: `2026-07-0${1 + Math.floor(i / 2)}T${10 + i}:00:00.000Z` });
      if (sessions.length) replayInto(s, sessions[sessions.length - 1]!.records);
      for (let k = 0; k < 4; k++) {
        s.prompt(`question ${i}.${k}`);
        s.response([text("answer")], { model: "claude-sonnet-5" });
      }
      writeSession(env.claude, P, s);
      sessions.push(s);
      await pause();
    }
    clearPriorCache();
    const cold = await scanIn(env);
    assert.equal(cold.parsed, 9);

    // The store holds salted ids only: no record uuid, path or text.
    const dir = join(env.wh, "history", "priors");
    const files = readdirSync(dir);
    assert.equal(files.length, 9);
    for (const f of files) {
      const body = readFileSync(join(dir, f), "utf8");
      assert.ok(!body.includes("sess-") && !body.includes("synthetic") && !body.includes("question"), f);
      assert.match(JSON.parse(body).ids[0], /^[A-Za-z0-9_-]{16}$/);
    }

    // A fresh process: nothing in memory. The newest session grows; only it is parsed, from stored ids.
    clearPriorCache();
    const newest = sessions[sessions.length - 1]!;
    const before = newest.records.length;
    newest.prompt("one more question");
    newest.response([text("answer")], { model: "claude-sonnet-5" });
    appendFileSync(join(env.claude, "projects", P, `${newest.id}.jsonl`), newest.records.slice(before).map((r) => JSON.stringify(r)).join("\n") + "\n");
    const warm = await scanIn(env);
    assert.equal(warm.parsed, 1);
    assert.equal(priorDiskReads(), 0, "every earlier session's ids came from the store");
    assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), await scratchState(env), "dedupe with stored ids = dedupe from the logs");

    // An earlier session changes on disk: its stored ids are not trusted (file identity moved); it and the session
    // that replays it are re-parsed, and the state still equals a scan from scratch.
    clearPriorCache();
    const third = sessions[3]!;
    const n3 = third.records.length;
    third.prompt("resumed in place");
    third.response([text("answer")], { model: "claude-sonnet-5" });
    appendFileSync(join(env.claude, "projects", P, `${third.id}.jsonl`), third.records.slice(n3).map((r) => JSON.stringify(r)).join("\n") + "\n");
    const again = await scanIn(env);
    assert.ok(again.parsed >= 2, `parsed ${again.parsed}`);
    assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), await scratchState(env));

    // A session whose log is gone keeps its shard (history) but loses its cached ids (no longer anyone's prior).
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(env.claude, "projects", P, `${sessions[0]!.id}.jsonl`));
    await scanIn(env);
    assert.equal(readdirSync(dir).length, 8);
  } finally {
    env.cleanup();
  }
});
