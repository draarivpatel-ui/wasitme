/**
 * Phase B parses each project's Claude Code sessions in creation order (scan.ts `parseOrder`), the order the
 * resume-dedupe priors index uses: a fresh full scan then reads no earlier session from disk twice (once for the index,
 * once for its own parse). The results are the order's business only in speed: the same exchanges either way.
 * Synthetic sessions in a temp folder only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearPriorCache, priorDiskReads } from "../../src/readers/claude/priors.js";
import { parseOrder } from "../../src/store/scan.js";
import { pause, replayInto, SessionBuilder, text, writeSession } from "../fixtures/claude/builder.js";
import { readJson, scanIn, tempEnv } from "./helpers.js";
import { join } from "node:path";

const P = "-synthetic-proj";

/** "sess-z" first, then "sess-a" = `claude --resume sess-z` (created later, but its name sorts first). */
async function resumedOutOfNameOrder(root: string): Promise<void> {
  const z = new SessionBuilder("sess-z", { start: "2026-06-01T09:00:00.000Z" });
  z.prompt("set up the project skeleton");
  z.response([text("done")], { model: "claude-sonnet-5" });
  z.prompt("add a readme describing the skeleton layout");
  z.response([text("added")], { model: "claude-sonnet-5" });
  writeSession(root, P, z);
  await pause(30);
  const a = new SessionBuilder("sess-a", { start: "2026-06-03T09:00:00.000Z" });
  replayInto(a, z.records);
  a.prompt("now add the tests");
  a.response([text("tests added")], { model: "claude-sonnet-5" });
  writeSession(root, P, a);
}

test("a fresh full scan reads no earlier session twice: sessions are parsed in creation order within a project", async () => {
  const env = tempEnv("parse-order");
  try {
    await resumedOutOfNameOrder(env.claude);
    clearPriorCache();
    const r = await scanIn(env, { collectConfig: false });
    assert.equal(r.parsed, 2);
    assert.equal(priorDiskReads(), 0, "the resumed session's prior was already in the index when it was parsed");
    // The replay is still counted once: the earlier session keeps its two prompts, the resumed one only its new one.
    const idx = readJson(join(env.wh, "history", "index.json"));
    assert.deepEqual(Object.values(idx.sources).map((e: any) => e.n).sort(), [1, 2]);
  } finally {
    env.cleanup();
  }
});

test("parseOrder: Claude Code sessions oldest first within each project (ties by name); everything else keeps the listing order", () => {
  const claude = { agent: "claude-code" as const }, codex = { agent: "codex" as const };
  const item = (reader: { agent: "claude-code" | "codex" }, key: string, born: number) => ({ reader, s: { key }, born });
  const listed = [
    item(claude, "p1/b.jsonl", 5), item(claude, "p1/a.jsonl", 9), item(claude, "p1/c.jsonl", 5),
    item(claude, "p2/a.jsonl", 3), item(claude, "p2/z.jsonl", 1),
    item(codex, "codex:r2.jsonl", 1), item(codex, "codex:r1.jsonl", 0),
  ];
  assert.deepEqual(parseOrder(listed).map((x) => x.s.key), ["p1/b.jsonl", "p1/c.jsonl", "p1/a.jsonl", "p2/z.jsonl", "p2/a.jsonl", "codex:r2.jsonl", "codex:r1.jsonl"]);
  assert.deepEqual(listed.map((x) => x.s.key)[0], "p1/b.jsonl", "the listing itself is not reordered");
});
