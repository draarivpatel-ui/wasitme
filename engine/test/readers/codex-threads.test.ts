import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLeadingLines, threadMeta } from "../../src/readers/codex/threads.js";
import { Rollout, uuid, writeTree, type TreeFile } from "../fixtures/codex/build.js";
import { scan, sum } from "../fixtures/codex/harness.js";
import { tempDir } from "../fixtures/temp.js";

const P = uuid(1), C = uuid(2), G = uuid(3), D = uuid(4);
const [PT1, PT2, CT1, GT1, DT1] = [uuid(11), uuid(12), uuid(21), uuid(31), uuid(41)];
const SUBAGENT = { subagent: { thread_spawn: { parent_thread_id: P, depth: 1 } } };

function parent(): string {
  return new Rollout("2026-09-10T10:00:00Z").meta({ id: P, threadSource: "user" })
    .started(PT1).ctx(PT1).user(PT1, "plan the migration").cmd(PT1).usage(PT1, "p1", { input: 100, output: 10 })
    .at("2026-09-10T10:00:50Z").complete(PT1)
    .at("2026-09-10T10:01:00Z").started(PT2).ctx(PT2).user(PT2, "use subagents to do it")
    .collab(PT2).subActivity(PT2, C).cmd(PT2).usage(PT2, "p2", { input: 200, output: 20 })
    .at("2026-09-10T10:05:00Z").complete(PT2)
    .text();
}

/** Forked subagent: own meta, then a verbatim copy of the parent's history (ordinals 1..6), then its own work. */
function forkedChild(): string {
  const r = new Rollout("2026-09-10T10:01:05Z")
    .meta({ id: C, parent: P, forkedFrom: P, source: SUBAGENT, threadSource: "subagent", startOrdinal: 7, agentRole: "worker" })
    .meta({ id: P, threadSource: "user" })
    .ctx(PT1).user(PT1, "plan the migration").cmd(PT1).usage(PT1, "p1", { input: 100, output: 10 })
    .respUser("use subagents to do it");
  assert.equal(r.ordinal, 7, "fixture: copied prefix occupies ordinals 1..6");
  return r.settings({ model: "gpt-mini" })
    .started(CT1).ctx(CT1, { model: "gpt-mini", root: PT2 }).user(CT1, "do subtask A").subActivity(CT1, G)
    .cmd(CT1).cmd(CT1, { status: "failed" }).usage(CT1, "c1", { input: 300, cached: 100, output: 30 }, PT2).complete(CT1)
    .text();
}

/** Grandchild spawned by the child (no fork; its start ordinal is meaningless and must be ignored). */
function grandchild(): string {
  return new Rollout("2026-09-10T10:01:30Z")
    .meta({ id: G, parent: C, source: SUBAGENT, threadSource: "subagent", startOrdinal: 500 })
    .started(GT1).ctx(GT1, { root: PT2 }).user(GT1, "do sub-subtask").cmd(GT1).usage(GT1, "g1", { input: 50, output: 5 }, PT2).complete(GT1)
    .text();
}

/** Child without root_turn_id linkage or spawn item → attributed by span (it started while PT1 was running). */
function timedChild(): string {
  return new Rollout("2026-09-10T10:00:30Z")
    .meta({ id: D, parent: P, source: SUBAGENT, threadSource: "subagent" })
    .started(DT1).ctx(DT1).user(DT1, "check something").cmd(DT1).usage(DT1, "d1", { input: 10, output: 1 }).complete(DT1)
    .text();
}

const tree = (withParent: boolean): TreeFile[] => [
  ...(withParent ? [{ id: P, stamp: "2026-09-10T10-00-00", content: parent() }] : []),
  { id: C, stamp: "2026-09-10T10-01-05", content: forkedChild() },
  { id: G, stamp: "2026-09-10T10-01-30", content: grandchild() },
  { id: D, stamp: "2026-09-10T10-00-30", content: timedChild() },
];

test("subagent threads are folded into the spawning exchange, never exchanges of their own", async () => {
  const { root } = writeTree(tree(true));
  const s = await scan(root, [P, C, G, D]);
  assert.equal(s.byThread.get(C)!.exchanges.length, 0);
  assert.equal(s.byThread.get(G)!.exchanges.length, 0);
  assert.equal(s.byThread.get(D)!.exchanges.length, 0);
  assert.equal(s.exchanges.length, 2);
  const [e0, e1] = s.exchanges as [typeof s.exchanges[0], typeof s.exchanges[0]];
  assert.deepEqual([e0.humanPrompt, e1.humanPrompt], [1, 1]);
  assert.equal(e0.toolCalls, 1);
  assert.equal(e1.toolCalls, 2, "collab call + command; SubAgentActivity is not a tool call");
  assert.equal(e0.subToolCalls, 1, "child that started inside PT1's span");
  assert.equal(e0.subTokens, 11);
  assert.equal(e1.subToolCalls, 3, "forked child (2, copied prefix excluded) + grandchild (1)");
  assert.equal(e1.subTokens, 330 + 55);
  assert.equal(s.events.length, 0, "child model differs but subagent settings are not user changes");
  assert.equal(s.stats.files, 4);
});

test("orphaned subagent (parent file missing): humanPrompt 0 exchanges, copied prefix skipped", async () => {
  const { root } = writeTree(tree(false));
  const s = await scan(root, [C, G, D]);
  const c = s.byThread.get(C)!;
  assert.equal(c.exchanges.length, 1);
  const [e] = c.exchanges;
  assert.equal(e!.humanPrompt, 0);
  assert.equal(e!.promptChars, 0);
  assert.equal(e!.toolCalls, 2);
  assert.equal(e!.toolErrors, 1);
  assert.equal(e!.steps, 1, "copied parent usage not counted");
  assert.equal(e!.inTok, 200);
  assert.equal(e!.subToolCalls, 1, "grandchild still links to its (present) parent, which names it in a spawn item");
  assert.equal(e!.subTokens, 55);
  assert.equal(c.stats.duplicates, 6, "copied parent meta + 5 copied records");
  assert.equal(c.events.length, 0);
  assert.equal(s.byThread.get(G)!.exchanges.length, 0);
  const d = s.byThread.get(D)!;
  assert.equal(d.exchanges.length, 1);
  assert.equal(d.exchanges[0]!.humanPrompt, 0);
  assert.equal(sum(s.exchanges, "humanPrompt"), 0);
});

test("a non-forked child's start ordinal does not hide its own records", async () => {
  const { root } = writeTree([{ id: G, content: grandchild() }]);
  const s = await scan(root);
  assert.equal(s.exchanges.length, 1);
  assert.equal(s.exchanges[0]!.toolCalls, 1);
  assert.equal(s.exchanges[0]!.steps, 1);
  assert.equal(s.stats.duplicates, 0);
});

test("fork with history_base holds only its own records: nothing is skipped", async () => {
  const id = uuid(5);
  const t = uuid(51);
  const content = new Rollout("2026-09-11T10:00:00Z")
    .meta({ id, forkedFrom: uuid(78), threadSource: "user", startOrdinal: 50, historyBase: { thread_id: uuid(78), end_ordinal_exclusive: 50, end_byte_offset: 1 } })
    .started(t).ctx(t).user(t, "continue from the fork").cmd(t).usage(t, "h1", { input: 5, output: 1 }).complete(t)
    .text();
  const { root } = writeTree([{ id, content }]);
  const s = await scan(root);
  assert.equal(s.exchanges.length, 1);
  assert.equal(s.exchanges[0]!.humanPrompt, 1);
  assert.equal(s.exchanges[0]!.toolCalls, 1);
  assert.equal(s.stats.duplicates, 0);
});

test("exec sessions: real prompts with entrypoint 'exec' (voting is decided downstream), no setting events", async () => {
  const id = uuid(6);
  const [x1, x2] = [uuid(61), uuid(62)];
  const content = new Rollout("2026-09-12T10:00:00Z").meta({ id, source: "exec", originator: "codex_exec" })
    .started(x1).ctx(x1, { model: "gpt-a" }).user(x1, "summarize the repo").cmd(x1).cmd(x1, { status: "failed" })
    .usage(x1, "r1", { input: 10, output: 1 }).aborted(x1)
    .tick(30_000).started(x2).ctx(x2, { model: "gpt-b" }).user(x2, "no, list the todos instead").cmd(x2).complete(x2)
    .text();
  const { root } = writeTree([{ id, content }]);
  const s = await scan(root);
  assert.equal(s.exchanges.length, 2);
  assert.deepEqual(s.exchanges.map((e) => e.entrypoint), ["exec", "exec"], "session_meta.source, never the originator");
  assert.deepEqual(s.exchanges.map((e) => e.humanPrompt), [1, 1]);
  assert.deepEqual(s.exchanges.map((e) => e.promptChars), ["summarize the repo".length, "no, list the todos instead".length]);
  assert.deepEqual(s.exchanges.map((e) => e.interrupted), [1, 0]);
  assert.deepEqual(s.exchanges.map((e) => e.pushback), [0, 1]);
  assert.deepEqual(s.exchanges.map((e) => e.toolCalls), [2, 1]);
  assert.equal(s.exchanges[0]!.toolErrors, 1);
  assert.equal(s.events.length, 0, "a scripted run's settings are not user changes");
});

test("subagent work is attributed only on evidence: a spawn item names the child, or it ran inside the exchange", async () => {
  const [N, U] = [uuid(71), uuid(72)];
  const [NT, UT] = [uuid(711), uuid(721)];
  const p = new Rollout("2026-09-10T10:00:00Z").meta({ id: P, threadSource: "user" })
    .started(PT1).ctx(PT1).user(PT1, "plan the migration").cmd(PT1).usage(PT1, "p1", { input: 100, output: 10 })
    .at("2026-09-10T10:00:50Z").complete(PT1)
    .at("2026-09-10T10:01:00Z").started(PT2).ctx(PT2).user(PT2, "spawn a worker").collab(PT2).subActivity(PT2, N)
    .usage(PT2, "p2", { input: 200, output: 20 }).at("2026-09-10T10:05:00Z").complete(PT2)
    .text();
  const child = (id: string, turn: string, at: string, cmds: number) => {
    const r = new Rollout(at).meta({ id, parent: P, source: SUBAGENT, threadSource: "subagent" }).started(turn).ctx(turn).user(turn, "subtask");
    for (let i = 0; i < cmds; i++) r.cmd(turn);
    return r.usage(turn, `u-${id}`, { input: 10, output: 1 }).complete(turn).text();
  };
  const { root } = writeTree([
    { id: P, stamp: "2026-09-10T10-00-00", content: p },
    // Named by PT2's spawn item, but its turn starts after PT2 finished: still PT2's.
    { id: N, stamp: "2026-09-10T10-20-00", content: child(N, NT, "2026-09-10T10:20:00Z", 2) },
    // No root turn, no spawn item, and nothing running when it started: attributed to nobody.
    { id: U, stamp: "2026-09-10T10-10-00", content: child(U, UT, "2026-09-10T10:10:00Z", 3) },
  ]);
  const s = await scan(root, [P, N, U]);
  assert.equal(s.byThread.get(N)!.exchanges.length, 0);
  assert.equal(s.byThread.get(U)!.exchanges.length, 0, "a linked child never reports its own exchanges, attributed or not");
  assert.deepEqual(s.exchanges.map((e) => e.subToolCalls), [0, 2]);
  assert.deepEqual(s.exchanges.map((e) => e.subTokens), [0, 11]);
});

test("archived copy of a live rollout is listed once; exchange ids survive archiving", async () => {
  const content = parent();
  const live = writeTree([{ id: P, stamp: "2026-09-10T10-00-00", content }, { id: P, dir: "archived_sessions", stamp: "2026-09-10T10-00-00", content }]);
  const a = await scan(live.root);
  assert.equal(a.stats.files, 1);
  assert.equal(a.exchanges.length, 2);
  const archivedOnly = writeTree([{ id: P, dir: "archived_sessions", stamp: "2026-09-10T10-00-00", content }]);
  const b = await scan(archivedOnly.root);
  assert.deepEqual(b.exchanges.map((e) => e.id), a.exchanges.map((e) => e.id));
  assert.deepEqual(b.exchanges.map((e) => e.session), a.exchanges.map((e) => e.session));
});

test("a thread split across several files (pages) attributes each subagent turn exactly once", async () => {
  const [PT3, C1T, C2T, C3T] = [uuid(13), uuid(61), uuid(62), uuid(63)];
  const [C1, C2, C3, PAGE2] = [uuid(6), uuid(7), uuid(8), uuid(99)];
  const page1 = parent(); // PT1 @10:00, PT2 @10:01..10:05
  const page2 = new Rollout("2026-09-10T11:00:00Z")
    .meta({ id: P, threadSource: "user", historyBase: { thread_id: P, end_ordinal_exclusive: 12, end_byte_offset: 1 } })
    .started(PT3).ctx(PT3).user(PT3, "now the second half").cmd(PT3).usage(PT3, "p3", { input: 5, output: 1 })
    .at("2026-09-10T11:02:00Z").complete(PT3)
    .text();
  const child = (id: string, turn: string, at: string, root: string | undefined, cmds: number) => {
    const r = new Rollout(at).meta({ id, parent: P, source: SUBAGENT, threadSource: "subagent" })
      .started(turn).ctx(turn, root ? { root } : {}).user(turn, "subtask");
    for (let i = 0; i < cmds; i++) r.cmd(turn);
    return r.usage(turn, `u-${id}`, { input: 10, output: 1 }, root ?? turn).complete(turn).text();
  };
  const { root } = writeTree([
    { id: P, stamp: "2026-09-10T10-00-00", content: page1 },
    { id: PAGE2, stamp: "2026-09-10T11-00-00", content: page2 },
    { id: C1, stamp: "2026-09-10T10-02-00", content: child(C1, C1T, "2026-09-10T10:02:00Z", PT2, 1) },
    { id: C2, stamp: "2026-09-10T11-00-30", content: child(C2, C2T, "2026-09-10T11:00:30Z", PT3, 2) },
    { id: C3, stamp: "2026-09-10T11-01-00", content: child(C3, C3T, "2026-09-10T11:01:00Z", undefined, 4) },
  ]);
  const s = await scan(root, [P, PAGE2]);
  assert.equal(sum(s.exchanges, "subToolCalls"), 1 + 2 + 4, "each child once");
  assert.equal(sum(s.exchanges, "subTokens"), 3 * 11);
  const p1 = s.byThread.get(P)!.exchanges, p2 = s.byThread.get(PAGE2)!.exchanges;
  assert.deepEqual(p1.map((e) => e.subToolCalls), [0, 1], "root turn PT2 lives in page 1");
  assert.deepEqual(p2.map((e) => e.subToolCalls), [2 + 4], "PT3 by root id; unlinked child inside PT3's span");
  assert.equal(new Set([...p1, ...p2].map((e) => e.session)).size, 1, "pages share the thread's session id");
});

test("import-time token_count does not make an imported turn look real", async () => {
  const id = uuid(9);
  const r = new Rollout("2026-09-02T09:00:00Z").meta({ id, threadSource: "user" });
  for (let i = 1; i <= 2; i++) r.started(`external-import-turn-${i}`).user(`external-import-turn-${i}`, `imported prompt ${i}`);
  r.tokenCount({ input: 50_000, output: 0 }, { input: 50_000, output: 0 });
  const t = uuid(91);
  const withReal = new Rollout("2026-09-02T09:00:00Z").meta({ id, threadSource: "user" })
    .started("external-import-turn-1").user("external-import-turn-1", "imported prompt").tokenCount({ input: 50_000, output: 0 })
    .tick(60_000).started(t).ctx(t).user(t, "real prompt").usage(t, "r", { input: 10, output: 1 }).complete(t)
    .text();
  const a = await scan(writeTree([{ id, content: r.text() }]).root);
  assert.equal(a.exchanges.length, 0);
  const b = await scan(writeTree([{ id, content: withReal }]).root);
  assert.equal(b.exchanges.length, 1);
  assert.equal(b.exchanges[0]!.steps, 1);
  assert.equal(b.exchanges[0]!.inTok, 10);
});

/** Parent P (one command in PT1) and a child linked to PT1 by root_turn_id with two commands. */
function linkedPair(o: { childLead?: string[]; parentLead?: string[] }): TreeFile[] {
  const p = new Rollout("2026-09-10T10:00:00Z");
  for (const l of o.parentLead ?? []) p.rawLine(l);
  p.meta({ id: P, threadSource: "user" })
    .started(PT1).ctx(PT1).user(PT1, "plan the migration").cmd(PT1).usage(PT1, "p1", { input: 100, output: 10 }).complete(PT1);
  const c = new Rollout("2026-09-10T10:00:20Z");
  for (const l of o.childLead ?? []) c.rawLine(l);
  c.meta({ id: C, parent: P, source: SUBAGENT, threadSource: "subagent" })
    .started(CT1).ctx(CT1, { root: PT1 }).user(CT1, "subtask").cmd(CT1).cmd(CT1).usage(CT1, "c1", { input: 5, output: 5 }, PT1).complete(CT1);
  return [
    { id: P, stamp: "2026-09-10T10-00-00", content: p.text() },
    { id: C, stamp: "2026-09-10T10-00-20", content: c.text() },
  ];
}

test("child whose first line is torn: still linked, its calls land once in the parent's subToolCalls", async () => {
  const s = await scan(writeTree(linkedPair({ childLead: ["{garbage"] })).root, [P, C]);
  assert.equal(s.byThread.get(C)!.exchanges.length, 0);
  assert.equal(s.byThread.get(C)!.stats.badLines, 1);
  assert.equal(s.exchanges.length, 1);
  assert.equal(s.exchanges[0]!.toolCalls, 1);
  assert.equal(s.exchanges[0]!.subToolCalls, 2);
  assert.equal(s.exchanges[0]!.subTokens, 10);
});

test("parent whose session_meta is past the leading lines the index reads: child counted once, as its own", async () => {
  const s = await scan(writeTree(linkedPair({ parentLead: ["{torn", "{torn", "{torn", "{torn", "{torn"] })).root, [P, C]);
  const c = s.byThread.get(C)!;
  assert.equal(c.exchanges.length, 1, "parent not in the index → child is not linked");
  assert.equal(c.exchanges[0]!.humanPrompt, 0);
  assert.equal(c.exchanges[0]!.toolCalls, 2);
  assert.equal(sum(s.exchanges, "subToolCalls"), 0, "the parent does not attribute what the child already reports");
  assert.equal(sum(s.exchanges, "toolCalls"), 3);
  assert.equal(sum(s.exchanges, "humanPrompt"), 1);
});

test("leading-line reader: lines across 64 KiB reads, no trailing newline, torn lines before the meta", () => {
  const dir = tempDir("wasitme-lines-");
  const big = "x".repeat(200_000);
  const a = join(dir, "a.jsonl");
  writeFileSync(a, `${big}\nsecond\nthird`);
  assert.deepEqual(readLeadingLines(a, 5).map((l) => l.length), [200_000, 6, 5]);
  assert.deepEqual(readLeadingLines(a, 1).map((l) => l.length), [200_000]);
  const meta = new Rollout("2026-09-10T10:00:00Z").meta({ id: C, parent: P }).text().trimEnd();
  const b = join(dir, "b.jsonl");
  writeFileSync(b, `{${big}\n${meta}`);
  assert.deepEqual(threadMeta(b), { threadId: C, parentThreadId: P });
  const c = join(dir, "c.jsonl");
  writeFileSync(c, `${new Rollout("2026-09-10T10:00:00Z").started(CT1).text()}${meta}\n`);
  assert.deepEqual(threadMeta(c), {}, "first parseable record is not a session_meta");
  assert.deepEqual(readLeadingLines(join(dir, "missing.jsonl"), 3), []);
});

test("D62a: research work of a child attributed with evidence fills subReads / subEdits / subBlindEdits (hand-computed)", async () => {
  const PA = uuid(101), CA = uuid(102);
  const [PTA, PTB, CTA] = [uuid(111), uuid(112), uuid(121)];
  const parentA = new Rollout("2026-09-11T10:00:00Z").meta({ id: PA, threadSource: "user" })
    .started(PTA).ctx(PTA).user(PTA, "read the config, then delegate the edits")
    .cmd(PTA, { parsed: [{ type: "read", path: "/synthetic/project/cfg.ts" }] })
    .collab(PTA).subActivity(PTA, CA).usage(PTA, "pa1", { input: 10, output: 1 })
    .at("2026-09-11T10:05:00Z").complete(PTA)
    .at("2026-09-11T10:10:00Z").started(PTB).ctx(PTB).user(PTB, "thanks").cmd(PTB).usage(PTB, "pa2", { input: 10, output: 1 }).complete(PTB)
    .text();
  const childA = new Rollout("2026-09-11T10:01:00Z")
    .meta({ id: CA, parent: PA, source: { subagent: { thread_spawn: { parent_thread_id: PA, depth: 1 } } }, threadSource: "subagent" })
    .started(CTA).ctx(CTA, { root: PTA }).user(CTA, "do the edits")
    .cmd(CTA, { parsed: [{ type: "read", path: "/synthetic/project/b.ts" }] }) // a read
    .fileChange(CTA, { "/synthetic/project/b.ts": "update" }) // read by the child first: not blind
    .fileChange(CTA, { "/synthetic/project/cfg.ts": "update" }) // read by the spawning exchange: not blind
    .fileChange(CTA, { "/synthetic/project/c.ts": "update", "/synthetic/project/n.ts": "add" }) // c: BLIND; n: a new file
    .usage(CTA, "ca1", { input: 20, output: 2 }, PTA).complete(CTA)
    .text();
  const { root } = writeTree([
    { id: PA, stamp: "2026-09-11T10-00-00", content: parentA },
    { id: CA, stamp: "2026-09-11T10-01-00", content: childA },
  ]);
  const s = await scan(root, [PA, CA]);
  assert.equal(s.exchanges.length, 2);
  const [a, b] = s.exchanges as [typeof s.exchanges[0], typeof s.exchanges[0]];
  assert.deepEqual([a.reads, a.edits, a.blindEdits], [1, 0, 0], "main-thread fields untouched");
  assert.deepEqual([a.subReads, a.subEdits, a.subBlindEdits], [1, 4, 1]);
  assert.equal(a.subToolCalls, 4);
  assert.deepEqual([b.subReads, b.subEdits, b.subBlindEdits], [0, 0, 0]);
});
