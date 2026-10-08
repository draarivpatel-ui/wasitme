/**
 * D62 reader follow-ups on SYNTHETIC logs only:
 *  (a) attributed subagent work fills subReads / subEdits / subBlindEdits (hand-computed), never main-thread fields;
 *      a subagent transcript's copies of main-thread records (fork-mode context) are never counted twice;
 *  (b) `relocated` (EnterWorktree moved the transcript to the worktree's project folder): the session keeps its
 *      ORIGINAL project id, no record type drift, no double count across the move, orphaned subagent folders join it.
 * Record shapes follow the public description (`{"type":"relocated", sessionId, relocatedCwd}`, issue reports) and
 * the counts-only key-name probe (D62c); every value here is synthetic.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { claudeReader } from "../../src/readers/claude.js";
import { folderFor, originalFolder } from "../../src/readers/claude/project.js";
import type { Exchange } from "../../src/types.js";
import {
  ctx, hash, makeRoot, projectPath, scan, SessionBuilder, text, toolUseBlock, withRoot, writeJsonl, writeSession, type Rec,
} from "../fixtures/claude/builder.js";
import { readJson, scanIn, tempEnv } from "../store/helpers.js";

const P = "-synthetic-home-proj";
const PER_RESPONSE = 10 + 20 + 1000 + 100; // builder default usage
const side = { isSidechain: true };
const sub = (x: Exchange) => [x.subReads, x.subEdits, x.subBlindEdits];

// ───────────────────────────── (a) subagent research work ─────────────────────────────

test("subagent research work: reads, edits and blind edits of the spawned subagent, hand-computed", async () => {
  const root = makeRoot();
  const m = new SessionBuilder("sess-res", { start: "2026-09-01T10:00:00.000Z" });
  m.prompt("fix the parser");
  m.response([toolUseBlock("t-r1", "Read", { file_path: "/s/a.ts" })]);
  m.toolResult("t-r1");
  m.response([toolUseBlock("ag1", "Agent", { prompt: "do it" })]);
  m.toolResult("ag1", { toolUseResult: { agentId: "sub1", status: "completed" } });
  m.response([text("done")]);
  m.prompt("thanks");
  m.response([text("np")]);
  writeSession(root, P, m);
  const s = new SessionBuilder("sub1", { start: "2026-09-01T10:00:30.000Z" });
  s.user("do it", side);
  s.response([toolUseBlock("s-r1", "Read", { file_path: "/s/b.ts" }), toolUseBlock("s-e1", "Edit", { file_path: "/s/b.ts" })], { extra: side }); // read first: not blind
  s.response([toolUseBlock("s-e2", "Edit", { file_path: "/s/a.ts" })], { extra: side }); // the main thread read a.ts: not blind
  s.response([toolUseBlock("s-e3", "Edit", { file_path: "/s/c.ts" })], { extra: side }); // never read anywhere: BLIND
  s.response([toolUseBlock("s-w1", "Write", { file_path: "/s/d.ts" }), toolUseBlock("s-e4", "Edit", { file_path: "/s/d.ts" })], { extra: side }); // written, then edited: not blind
  s.response([toolUseBlock("s-g1", "Grep", { pattern: "x" }), toolUseBlock("s-b1", "Bash", { command: "ls" })], { extra: side });
  writeJsonl(join(projectPath(root, P), "sess-res", "subagents", "agent-sub1.jsonl"), s.records);

  const r = (await scan(root)).get(`${P}/sess-res.jsonl`)!.result;
  const [a, b] = r.exchanges as [Exchange, Exchange];
  // Main thread untouched: 1 read, no edits.
  assert.deepEqual([a.reads, a.edits, a.blindEdits, a.toolCalls], [1, 0, 0, 2]);
  // Subagent: reads = Read + Grep = 2; edits = Edit b, Edit a, Edit c, Write d, Edit d = 5; blind = Edit c = 1.
  assert.deepEqual(sub(a), [2, 5, 1]);
  assert.equal(a.subToolCalls, 8);
  assert.equal(a.subTokens, 5 * PER_RESPONSE + 0, "five subagent responses (the two-block ones are one response each)");
  assert.deepEqual(sub(b), [0, 0, 0]);
});

test("a subagent edit of a file only the SUBAGENT read earlier is not blind; one the main thread read in an earlier exchange is", async () => {
  const root = makeRoot();
  const m = new SessionBuilder("sess-res2", { start: "2026-09-01T10:00:00.000Z" });
  m.prompt("look at e.ts");
  m.response([toolUseBlock("t-r0", "Read", { file_path: "/s/e.ts" })]);
  m.toolResult("t-r0");
  m.response([text("seen")]);
  m.prompt("now delegate the change");
  m.response([toolUseBlock("ag2", "Agent", {})]);
  m.toolResult("ag2", { toolUseResult: { agentId: "sub2", status: "completed" } });
  writeSession(root, P, m);
  const s = new SessionBuilder("sub2", { start: "2026-09-01T10:01:00.000Z" });
  s.response([toolUseBlock("s2-e1", "Edit", { file_path: "/s/e.ts" })], { extra: side }); // main read it, but in ANOTHER exchange: blind
  s.response([toolUseBlock("s2-n1", "NotebookEdit", { notebook_path: "/s/n.ipynb" })], { extra: side }); // blind
  s.response([toolUseBlock("s2-x", "Edit", {})], { extra: side }); // no path: never judged blind
  writeJsonl(join(projectPath(root, P), "sess-res2", "subagents", "agent-sub2.jsonl"), s.records);
  const r = (await scan(root)).get(`${P}/sess-res2.jsonl`)!.result;
  assert.deepEqual(r.exchanges.map(sub), [[0, 0, 0], [0, 3, 2]]);
});

test("fork-mode copies of main-thread records inside a subagent transcript are never counted as its work (but make files known)", async () => {
  const root = makeRoot();
  const m = new SessionBuilder("sess-fork", { start: "2026-09-01T10:00:00.000Z" });
  m.prompt("read the config first");
  m.response([toolUseBlock("t-cfg", "Read", { file_path: "/s/config.ts" })], { requestId: "req-main-1", msgId: "msg-main-1" });
  const readRec = m.records[m.records.length - 1]!;
  m.toolResult("t-cfg");
  m.response([text("read it")]);
  m.prompt("delegate the edit");
  m.response([toolUseBlock("ag3", "Agent", {})]);
  m.toolResult("ag3", { toolUseResult: { agentId: "fork1", status: "completed" } });
  writeSession(root, P, m);
  const f = new SessionBuilder("fork1", { start: "2026-09-01T10:02:00.000Z" });
  f.push({ ...readRec }); // the parent's record, copied with its uuid (forked context)
  f.push({ ...readRec, uuid: "fork1-copy-2", isSidechain: true }); // re-stamped copy: same tool_use id and response key
  f.response([toolUseBlock("f-e1", "Edit", { file_path: "/s/config.ts" })], { extra: side }); // known through the inherited Read
  writeJsonl(join(projectPath(root, P), "sess-fork", "subagents", "agent-fork1.jsonl"), f.records);
  const r = (await scan(root)).get(`${P}/sess-fork.jsonl`)!.result;
  const x = r.exchanges[1]!;
  assert.deepEqual([x.subToolCalls, x.subTokens], [1, PER_RESPONSE], "only the subagent's own response and call");
  assert.deepEqual(sub(x), [0, 1, 0], "the inherited Read is not the subagent's read, but its file is known");
  assert.deepEqual(r.exchanges.map((e) => [e.reads, e.edits]), [[1, 0], [0, 0]], "main-thread counts untouched");
  assert.ok(r.stats.duplicates >= 2, "the two copies are counted as duplicates");
});

test("sidechain records inside the main transcript: their research work is delegated work of the open exchange", async () => {
  const s = new SessionBuilder("sess-side-res", { start: "2026-09-01T10:00:00.000Z" });
  s.prompt("main task");
  s.response([toolUseBlock("m-r", "Read", { file_path: "/s/m.ts" })]);
  s.toolResult("m-r");
  s.response([toolUseBlock("x-r", "Read", { file_path: "/s/x.ts" }), toolUseBlock("x-e", "Edit", { file_path: "/s/x.ts" })], { extra: side });
  s.response([toolUseBlock("y-e", "Edit", { file_path: "/s/y.ts" })], { extra: side }); // blind
  s.response([toolUseBlock("m-e", "Edit", { file_path: "/s/m.ts" })], { extra: side }); // the main thread read m.ts: not blind
  s.response([text("ok")]);
  const root = makeRoot();
  writeSession(root, P, s);
  const r = (await scan(root)).get(`${P}/sess-side-res.jsonl`)!.result;
  const x = r.exchanges[0]!;
  assert.deepEqual([x.reads, x.edits, x.blindEdits], [1, 0, 0]);
  assert.deepEqual(sub(x), [1, 3, 1]);
  assert.equal(x.subToolCalls, 4);
});

// ───────────────────────────── (b) relocated ─────────────────────────────

const CWD = "/synthetic/home/proj";
const WT = `${CWD}/.claude/worktrees/wt-1`;
const W = folderFor(WT); // "-synthetic-home-proj--claude-worktrees-wt-1"

/** A session started in CWD; EnterWorktree moves it (marker), the second exchange runs in the worktree. */
function movedSession(id: string, opts: { second?: boolean } = {}): { s: SessionBuilder; before: Rec[] } {
  const s = new SessionBuilder(id, { start: "2026-09-02T09:00:00.000Z", cwd: CWD });
  s.prompt("start a worktree for this");
  s.response([toolUseBlock(`${id}-wt`, "EnterWorktree", { name: "wt-1" })]);
  s.toolResult(`${id}-wt`);
  s.response([text("switched")]);
  const before = [...s.records];
  s.meta("relocated", { relocatedCwd: WT });
  if (opts.second !== false) {
    s.cwd = WT;
    s.prompt("now edit inside the worktree");
    s.response([toolUseBlock(`${id}-r`, "Read", { file_path: `${WT}/a.ts` }), toolUseBlock(`${id}-e`, "Edit", { file_path: `${WT}/a.ts` })]);
    s.toolResult(`${id}-r`);
    s.toolResult(`${id}-e`);
  }
  return { s, before };
}

test("folderFor / originalFolder: Claude Code's folder encoding, validated against the folder the file is in", () => {
  assert.equal(folderFor("/Users/syn-user/my.proj_x"), "-Users-syn-user-my-proj-x");
  assert.equal(W, "-synthetic-home-proj--claude-worktrees-wt-1");
  assert.equal(originalFolder(W, CWD, [WT]), P);
  assert.equal(originalFolder(W, CWD, [undefined, WT]), P, "the relocation target alone validates");
  assert.equal(originalFolder(W, CWD, [CWD]), undefined, "the encoding does not reproduce this folder: keep it");
  assert.equal(originalFolder(`${W}-a1b2c3`, CWD, [WT]), undefined, "a shortened folder name is never guessed");
  assert.equal(originalFolder(P, CWD, [CWD]), undefined, "moved back home: nothing to change");
  assert.equal(originalFolder(W, undefined, [WT]), undefined);
});

test("relocated: a moved session keeps its ORIGINAL project id (no project switch) and `relocated` is not format drift", async () => {
  const { s, before } = movedSession("sess-moved");
  const moved = makeRoot();
  writeSession(moved, W, s);
  const r = (await scan(moved)).get(`${W}/sess-moved.jsonl`)!.result;
  assert.equal(r.exchanges.length, 2);
  const home = hash(P, "p-");
  assert.deepEqual(r.exchanges.map((x) => x.project), [home, home], "both exchanges, before and after the move");
  assert.deepEqual(r.stats.unknownTypes, {});
  // The same session parsed before the move (from the original folder): same project, same cross-file identity.
  const orig = makeRoot();
  writeJsonl(join(projectPath(orig, P), "sess-moved.jsonl"), before);
  const o = (await scan(orig)).get(`${P}/sess-moved.jsonl`)!.result;
  assert.equal(o.exchanges.length, 1);
  assert.equal(o.exchanges[0]!.project, home);
  assert.equal(o.exchanges[0]!.session, r.exchanges[0]!.session, "same session id: the file kept its name");
  assert.equal(o.origins![0], r.origins![0], "same opening record: the store counts the exchange once");
  // Main-thread work after the move is counted normally.
  assert.deepEqual([r.exchanges[1]!.reads, r.exchanges[1]!.edits, r.exchanges[1]!.blindEdits], [1, 1, 0]);
});

test("relocated: when the folder can't be reproduced from the records, the folder the file is in is kept (as before D62)", async () => {
  const { s } = movedSession("sess-odd");
  const root = makeRoot();
  const odd = `${W}-7f3a9c`; // e.g. a long path Claude Code shortened with a hash suffix
  writeSession(root, odd, s);
  const r = (await scan(root)).get(`${odd}/sess-odd.jsonl`)!.result;
  assert.deepEqual([...new Set(r.exchanges.map((x) => x.project))], [hash(odd, "p-")]);
  // A session never moved (no marker) whose replayed history carries another cwd stays where it is.
  const t = new SessionBuilder("sess-plain", { cwd: "/synthetic/elsewhere" });
  t.prompt("hi"); t.response([text("ok")]);
  t.cwd = WT;
  t.prompt("again"); t.response([text("ok")]);
  writeSession(root, W, t);
  const p = (await scan(root)).get(`${W}/sess-plain.jsonl`)!.result;
  assert.deepEqual([...new Set(p.exchanges.map((x) => x.project))], [hash(W, "p-")]);
});

test("relocated: moved there and back again (ExitWorktree) — the file is home, the project is unchanged", async () => {
  const { s } = movedSession("sess-back");
  s.meta("relocated", { relocatedCwd: CWD });
  s.cwd = CWD;
  s.prompt("back home");
  s.response([text("ok")]);
  const root = makeRoot();
  writeSession(root, P, s);
  const r = (await scan(root)).get(`${P}/sess-back.jsonl`)!.result;
  assert.equal(r.exchanges.length, 3);
  assert.deepEqual([...new Set(r.exchanges.map((x) => x.project))], [hash(P, "p-")]);
  assert.deepEqual(r.stats.unknownTypes, {});
});

test("relocated: subagent transcripts left in the original folder join the moved session; never when two folders hold its id", async () => {
  const root = makeRoot();
  const { s } = movedSession("sess-orph");
  writeSession(root, W, s);
  const left = new SessionBuilder("orph-sub", { start: "2026-09-02T09:00:30.000Z" });
  left.response([toolUseBlock("o-e", "Edit", { file_path: `${CWD}/z.ts` })], { extra: side });
  writeJsonl(join(projectPath(root, P), "sess-orph", "subagents", "agent-orph-sub.jsonl"), left.records);
  // Ambiguous: the same session id in two folders (a stray re-creation), plus an orphan folder in a third.
  for (const dir of ["-synthetic-a", "-synthetic-b"]) {
    const d = new SessionBuilder("sess-dup", { start: "2026-09-03T09:00:00.000Z" });
    d.prompt("x"); d.response([text("y")]);
    writeSession(root, dir, d);
  }
  writeJsonl(join(projectPath(root, "-synthetic-c"), "sess-dup", "subagents", "agent-q.jsonl"), left.records);

  const list = await withRoot(root, () => claudeReader.list());
  const src = list.find((x) => x.key === `${W}/sess-orph.jsonl`)!;
  assert.equal(src.files.length, 2, "main + the orphaned subagent transcript");
  for (const k of ["-synthetic-a/sess-dup.jsonl", "-synthetic-b/sess-dup.jsonl"]) assert.equal(list.find((x) => x.key === k)!.files.length, 1, k);
  assert.ok(!list.some((x) => x.key.startsWith(`${P}/`)), "the original folder holds no session any more");
  const r = await withRoot(root, () => claudeReader.parse(src, ctx));
  assert.equal(r.stats.files, 2);
  const total = r.exchanges.reduce((a, x) => a + (x.subEdits ?? 0), 0);
  assert.equal(total, 1, "the left-behind subagent's edit is counted once");
  assert.equal(r.exchanges.reduce((a, x) => a + x.subToolCalls, 0), 1);
});

test("relocated end to end: scanned before and after the move — no double count, one project, the history-only shard agrees", async () => {
  const env = tempEnv("relocated");
  try {
    const NOW = new Date("2026-09-10T12:00:00Z");
    const { s, before } = movedSession("sess-e2e");
    const pDir = join(env.claude, "projects", P);
    mkdirSync(pDir, { recursive: true });
    writeFileSync(join(pDir, "sess-e2e.jsonl"), before.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await scanIn(env, { now: NOW });
    // EnterWorktree: the file is moved (rename) into the worktree's folder and keeps growing there.
    const wDir = join(env.claude, "projects", W);
    mkdirSync(wDir, { recursive: true });
    renameSync(join(pDir, "sess-e2e.jsonl"), join(wDir, "sess-e2e.jsonl"));
    writeFileSync(join(wDir, "sess-e2e.jsonl"), s.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const rep = await scanIn(env, { now: NOW });
    assert.equal(rep.crossFileDuplicates, 1, "the exchange from before the move is in both shards, counted once");
    const snap = readJson(join(env.wh, "snapshot.json"));
    const claude = snap.agents.find((a: any) => a.agent === "claude-code");
    assert.equal(claude.n.exchanges, 2);
    assert.equal(claude.n.sessions, 1);
    const projects = new Set<string>();
    for (const n of readdirSync(join(env.wh, "history", "shards"))) {
      const sh = readJson(join(env.wh, "history", "shards", n));
      if (sh.agent !== "claude-code") continue;
      for (const x of sh.exchanges) projects.add(x.project);
    }
    assert.equal(projects.size, 1, "the stored history and the moved file agree on the project");
  } finally {
    env.cleanup();
  }
});
