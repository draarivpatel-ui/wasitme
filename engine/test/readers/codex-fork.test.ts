import { test } from "node:test";
import assert from "node:assert/strict";
import { Rollout, uuid, writeTree } from "../fixtures/codex/build.js";
import { scan } from "../fixtures/codex/harness.js";

const P = uuid(201), F = uuid(202);
const SETTINGS = { model: "gpt-legacy", effort: "medium", approval: "on-request" };

/**
 * The parent's history up to the fork point: 8 records, including legacy turn markers (task_started,
 * turn_context) and task_complete — the shape a verbatim copy of rollout items would have.
 */
const history = (r: Rollout): Rollout => r
  .started().ctx(undefined, SETTINGS)
  .respUser("old prompt from the parent").fnCall("o1").fnOutput("o1", "ok").respAssistant()
  .tokenCount({ input: 100, output: 10 })
  .complete();
const COPIED = 8;

/** Parent that went on after the fork point with a turn whose markers are identical to the fork's own. */
const parent = (): string => history(new Rollout("2026-09-12T10:00:00Z").meta({ id: P, legacy: true, threadSource: "user" }))
  .tick(60_000).started().ctx(undefined, SETTINGS)
  .respUser("parent went on").fnCall("o2").fnOutput("o2", "ok").tokenCount({ input: 150, output: 15 }).complete()
  .text();

/** Fork: own meta, a re-stamped copy of the parent's meta and history, then its own turn. */
const fork = (copy: boolean): string => {
  const r = new Rollout("2026-09-12T10:05:00Z").meta({ id: F, legacy: true, forkedFrom: P, threadSource: "user" });
  if (copy) history(r.meta({ id: P, legacy: true, threadSource: "user" }));
  return r.tick(30_000).started().ctx(undefined, SETTINGS)
    .respUser("new prompt in the fork").fnCall("n1").fnOutput("n1", "ok")
    .tokenCount(copy ? { input: 130, output: 13 } : { input: 30, output: 3 })
    .complete()
    .text();
};

test("legacy fork with its parent present: the copied prefix (markers included) is skipped exactly", async () => {
  const { root } = writeTree([
    { id: P, stamp: "2026-09-12T10-00-00", content: parent() },
    { id: F, stamp: "2026-09-12T10-05-00", content: fork(true) },
  ]);
  const s = await scan(root, [P, F]);
  const f = s.byThread.get(F)!;
  assert.equal(f.exchanges.length, 1);
  const [e] = f.exchanges;
  assert.equal(e!.humanPrompt, 1);
  assert.equal(e!.promptChars, "new prompt in the fork".length);
  assert.equal(e!.toolCalls, 1);
  assert.equal(e!.steps, 1);
  assert.equal(e!.inTok, 30, "copied cumulative token_count is the baseline: 130 - 100");
  assert.equal(e!.outTok, 3);
  assert.equal(e!.model, "gpt-legacy", "the fork's own turn_context (identical to the parent's next one) is kept");
  assert.equal(e!.effort, "medium");
  assert.equal(e!.mode, "on-request");
  assert.equal(f.stats.duplicates, COPIED + 1, "8 copied records + the copied parent session_meta");
  assert.deepEqual(f.stats.unknownTypes, {});
  const p = s.byThread.get(P)!;
  assert.deepEqual(p.exchanges.map((x) => x.promptChars), ["old prompt from the parent".length, "parent went on".length]);
  assert.equal(p.stats.duplicates, 0);
  assert.equal(s.exchanges.length, 3, "2 parent prompts + 1 fork prompt: nothing counted twice");
});

test("legacy fork whose parent is present but which copied nothing: no record is skipped", async () => {
  const { root } = writeTree([
    { id: P, stamp: "2026-09-12T10-00-00", content: parent() },
    { id: F, stamp: "2026-09-12T10-05-00", content: fork(false) },
  ]);
  const s = await scan(root, [F]);
  const f = s.byThread.get(F)!;
  assert.equal(f.exchanges.length, 1);
  assert.equal(f.exchanges[0]!.promptChars, "new prompt in the fork".length);
  assert.equal(f.exchanges[0]!.model, "gpt-legacy", "markers matching the parent's first records were held, then released");
  assert.equal(f.exchanges[0]!.inTok, 30);
  assert.equal(f.stats.duplicates, 0);
  assert.deepEqual(f.stats.unknownTypes, {});
});

test("legacy fork whose copy ends on turn markers: held markers are processed, no phantom exchange", async () => {
  const content = history(new Rollout("2026-09-12T10:05:00Z").meta({ id: F, legacy: true, forkedFrom: P, threadSource: "user" }))
    .started().ctx(undefined, SETTINGS)
    .text();
  const { root } = writeTree([
    { id: P, stamp: "2026-09-12T10-00-00", content: parent() },
    { id: F, stamp: "2026-09-12T10-05-00", content },
  ]);
  const s = await scan(root, [F]);
  const f = s.byThread.get(F)!;
  assert.equal(f.exchanges.length, 0);
  assert.equal(f.stats.duplicates, COPIED);
  assert.equal(f.events.length, 0);
});

test("legacy fork whose parent file is missing: marker heuristic, flagged as codex:fork-unresolved", async () => {
  const { root } = writeTree([{ id: F, stamp: "2026-09-12T10-05-00", content: fork(true) }]);
  const s = await scan(root, [F]);
  const f = s.byThread.get(F)!;
  assert.deepEqual(f.stats.unknownTypes, { "codex:fork-unresolved": 1 });
  // The copy starts with a marker, so the heuristic skips only the copied parent meta: the parent's prompt
  // is counted again. This is the documented limitation of the fallback, surfaced via the counter above.
  assert.equal(f.exchanges.length, 2);
  assert.equal(f.stats.duplicates, 1);
});
