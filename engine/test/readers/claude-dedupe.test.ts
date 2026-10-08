import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { claudeReader } from "../../src/readers/claude.js";
import { clearPriorCache, priorDiskReads } from "../../src/readers/claude/priors.js";
import { ctx, makeRoot, pause, projectPath, replayInto, scan, SessionBuilder, text, toolUseBlock, withRoot, writeSession } from "../fixtures/claude/builder.js";

const P = "-synthetic-proj";

/** Session A (2 prompts) and B = `claude --resume A`: B replays A verbatim (sessionId rewritten), then continues. */
async function resumedPair(root: string): Promise<{ a: SessionBuilder; b: SessionBuilder }> {
  const a = new SessionBuilder("sess-a", { start: "2026-09-01T09:00:00.000Z" });
  a.prompt("set up the project skeleton");
  a.response([toolUseBlock("a1", "Bash", {})], { model: "claude-sonnet-5" });
  a.toolResult("a1");
  a.response([text("done")], { model: "claude-sonnet-5" });
  a.system("compact_boundary", { compactMetadata: { trigger: "manual" } });
  a.prompt("add a readme describing the skeleton layout");
  a.response([text("added")], { model: "claude-sonnet-5" });
  writeSession(root, P, a);
  await pause();

  const b = new SessionBuilder("sess-b", { start: "2026-09-03T09:00:00.000Z" });
  replayInto(b, a.records);
  b.prompt("add a readme describing the skeleton layout please"); // near-duplicate of the replayed prompt
  b.response([toolUseBlock("b1", "Bash", {})], { model: "claude-opus-5" });
  b.toolResult("b1");
  writeSession(root, P, b);
  return { a, b };
}

test("resumed session: replayed records are dropped from the later file, kept in the earliest", async () => {
  clearPriorCache();
  const root = makeRoot();
  const { a } = await resumedPair(root);
  const all = await scan(root);
  const ra = all.get(`${P}/sess-a.jsonl`)!.result;
  const rb = all.get(`${P}/sess-b.jsonl`)!.result;

  assert.equal(ra.exchanges.length, 2);
  assert.equal(ra.stats.duplicates, 0);
  assert.equal(rb.exchanges.length, 1, "only the new prompt is B's");
  assert.equal(rb.stats.duplicates, a.records.length);
  const humanTotal = [...all.values()].reduce((n, s) => n + s.result.exchanges.filter((x) => x.humanPrompt === 1).length, 0);
  assert.equal(humanTotal, 3, "every prompt counted exactly once across both files");

  const x = rb.exchanges[0]!;
  assert.equal(x.seq, 0);
  assert.equal(x.steps, 1);
  assert.equal(x.toolCalls, 1);
  assert.equal(x.afterCompaction, true, "the replayed history contained a compaction");
  assert.equal(x.pushback, 1, "near-duplicate of the replayed previous prompt");
  // State carried silently from the replay; the replay emits nothing. D63: B opening on another model than its replayed
  // history, with no command in B, is B's starting model — a between-session move that attribution derives (and ties
  // to a recorded /model typed anywhere), not an in-session `unknown` change.
  assert.deepEqual(rb.events.map((e) => [e.kind, e.from, e.to]), []);
  assert.equal(rb.stats.files, 1, "priors are read for uuids only, not counted as parsed files");
});

test("a resumed session's source lists only its own transcript; dedupe against the earlier session happens inside parse", async () => {
  clearPriorCache();
  const root = makeRoot();
  const { a } = await resumedPair(root);
  await withRoot(root, async () => {
    const dir = projectPath(root, P);
    const sources = new Map(claudeReader.list().map((s) => [s.key, s]));
    const sa = sources.get(`${P}/sess-a.jsonl`)!;
    const sb = sources.get(`${P}/sess-b.jsonl`)!;
    assert.deepEqual(sa.files.map((f) => f.path), [join(dir, "sess-a.jsonl")]);
    assert.deepEqual(sb.files.map((f) => f.path), [join(dir, "sess-b.jsonl")], "the earlier session is not one of B's files");
    clearPriorCache(); // no listing in memory: parse finds B's priors by stat on its own
    const rb = await claudeReader.parse(sb, ctx);
    assert.equal(rb.stats.duplicates, a.records.length);
    assert.equal(rb.stats.files, sb.files.length);
  });
});

test("dedupe is order independent and stable across repeated parses (memo is a pure cache)", async () => {
  const root = makeRoot();
  await resumedPair(root);
  const run = async (reverse: boolean) => {
    clearPriorCache();
    return withRoot(root, async () => {
      const sources = claudeReader.list();
      if (reverse) sources.reverse();
      const out = new Map<string, unknown>();
      for (const s of sources) out.set(s.key, await claudeReader.parse(s, ctx));
      for (const s of sources) out.set(s.key + "#again", await claudeReader.parse(s, ctx));
      return out;
    });
  };
  const fwd = await run(false);
  const rev = await run(true);
  for (const [k, v] of fwd) assert.deepEqual(rev.get(k), v, k);
  assert.deepEqual(fwd.get(`${P}/sess-b.jsonl`), fwd.get(`${P}/sess-b.jsonl#again`));
});

test("a prior that changed is re-read, not served stale from the memo", async () => {
  clearPriorCache();
  const root = makeRoot();
  const { b } = await resumedPair(root);
  const keyB = `${P}/sess-b.jsonl`;
  const before = (await scan(root)).get(keyB)!.result;
  assert.equal(before.exchanges.length, 1);
  // A later gains a copy of B's new prompt (e.g. a fork written back): B must now treat it as replayed.
  const bPrompt = b.records.find((r) => (r.message as { content?: unknown } | undefined)?.content === "add a readme describing the skeleton layout please")!;
  appendFileSync(join(projectPath(root, P), "sess-a.jsonl"), JSON.stringify({ ...bPrompt, sessionId: "sess-a" }) + "\n");
  const after = (await scan(root)).get(keyB)!.result;
  assert.equal(after.exchanges.filter((x) => x.humanPrompt === 1).length, 0);
  assert.equal(after.stats.duplicates, before.stats.duplicates + 1);
});

test("resume chains: C replays B which replayed A", async () => {
  clearPriorCache();
  const root = makeRoot();
  const { b } = await resumedPair(root);
  await pause();
  const c = new SessionBuilder("sess-c", { start: "2026-09-05T09:00:00.000Z" });
  replayInto(c, b.records);
  c.prompt("final polish on the readme wording");
  c.response([text("polished")]);
  writeSession(root, P, c);
  const all = await scan(root);
  assert.deepEqual(
    [...all.values()].map((s) => [s.key, s.result.exchanges.filter((x) => x.humanPrompt === 1).length]),
    [[`${P}/sess-a.jsonl`, 2], [`${P}/sess-b.jsonl`, 1], [`${P}/sess-c.jsonl`, 1]],
  );
});

test("changes inside the replayed history are reported once (by the original session), not again on resume", async () => {
  clearPriorCache();
  const root = makeRoot();
  const a = new SessionBuilder("sess-h1", { version: "2.1.250" });
  a.prompt("first"); a.response([text("a")], { model: "claude-sonnet-5" });
  a.version = "2.1.251";
  a.prompt("second"); a.response([text("b")], { model: "claude-sonnet-5-5", effort: "max" });
  writeSession(root, P, a);
  await pause();
  const b = new SessionBuilder("sess-h2", { version: "2.1.251", start: "2026-09-03T09:00:00.000Z" });
  replayInto(b, a.records);
  b.prompt("third"); b.response([text("c")], { model: "claude-sonnet-5-5", effort: "max" });
  writeSession(root, P, b);
  const all = await scan(root);
  const kinds = (k: string) => all.get(k)!.result.events.map((e) => `${e.kind}:${e.from}->${e.to}`);
  assert.deepEqual(kinds(`${P}/sess-h1.jsonl`), ["version:2.1.250->2.1.251", "model:claude-sonnet-5->claude-sonnet-5-5", "effort:high->max"]);
  assert.deepEqual(kinds(`${P}/sess-h2.jsonl`), []);
});

test("an MCP server added between sessions shows up when the session is resumed", async () => {
  clearPriorCache();
  const root = makeRoot();
  const a = new SessionBuilder("sess-m1");
  a.prompt("first"); a.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__alpha__x"], removedNames: [], readdedNames: [] }); a.response([text("a")]);
  a.prompt("second"); a.response([text("b")]);
  writeSession(root, P, a);
  await pause();
  const b = new SessionBuilder("sess-m2", { start: "2026-09-03T09:00:00.000Z" });
  replayInto(b, a.records);
  b.prompt("third");
  b.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__alpha__x", "mcp__beta__y"], removedNames: [], readdedNames: [] });
  b.response([text("c")]);
  writeSession(root, P, b);
  const all = await scan(root);
  assert.deepEqual(all.get(`${P}/sess-m1.jsonl`)!.result.events, []);
  assert.deepEqual(all.get(`${P}/sess-m2.jsonl`)!.result.events.map((e) => [e.kind, e.note]), [["mcp", "+1 (1->2 servers)"]]);
});

test("sessions in different project folders never dedupe against each other", async () => {
  clearPriorCache();
  const root = makeRoot();
  const a = new SessionBuilder("sess-x");
  a.prompt("hello from project one"); a.response([text("hi")]);
  writeSession(root, "-proj-one", a);
  await pause();
  const b = new SessionBuilder("sess-y");
  replayInto(b, a.records); // pathological copy into another project
  writeSession(root, "-proj-two", b);
  const all = await scan(root);
  assert.equal(all.get("-proj-two/sess-y.jsonl")!.source.files.length, 1);
  assert.equal(all.get("-proj-two/sess-y.jsonl")!.result.exchanges.length, 1);
});

test("a resumed file holding only a queued prompt and an interrupt after the replay keeps both", async () => {
  clearPriorCache();
  const root = makeRoot();
  const { a } = await resumedPair(root);
  await pause();
  const c = new SessionBuilder("sess-q", { start: "2026-09-04T09:00:00.000Z" });
  replayInto(c, a.records);
  c.attachment({ type: "queued_command", prompt: "also update the changelog", commandMode: "prompt" });
  c.user("[Request interrupted by user]");
  writeSession(root, P, c);
  const rc = (await scan(root)).get(`${P}/sess-q.jsonl`)!.result;
  assert.deepEqual(rc.exchanges.map((x) => [x.humanPrompt, x.queuedMidTurn, x.interrupted, x.steps, x.seq]), [[0, 1, 1, 0, 0]]);
});

/** `n` tiny sessions in one project; every 5th resumes the previous one (replays its records). */
async function manySessions(root: string, n: number): Promise<number> {
  const dir = projectPath(root, P);
  mkdirSync(dir, { recursive: true });
  let replayed = 0;
  let prev: SessionBuilder | undefined;
  for (let i = 0; i < n; i++) {
    const s = new SessionBuilder(`s${String(i).padStart(5, "0")}`, { start: "2026-09-01T09:00:00.000Z" });
    if (prev && i % 5 === 0) {
      replayInto(s, prev.records);
      replayed += prev.records.length;
    }
    s.prompt(`task number ${i}`);
    s.response([text("ok")]);
    writeSession(root, P, s);
    prev = s;
  }
  return replayed;
}

test("resume dedupe scales linearly: 2,500 sessions in one project", async () => {
  clearPriorCache();
  const root = makeRoot();
  const n = 2500;
  const replayed = await manySessions(root, n);
  const started = Date.now();
  const results = await withRoot(root, async () => {
    const sources = claudeReader.list();
    assert.equal(sources.length, n);
    const stamps = sources.reduce((k, s) => k + s.files.length, 0);
    assert.equal(stamps, n, "one main stamp each: sibling sessions are never stamped into a source");
    sources.reverse(); // newest first: the first parse needs every other session as a prior
    const out = [];
    for (const s of sources) out.push(await claudeReader.parse(s, ctx));
    return out;
  });
  const elapsed = Date.now() - started;
  assert.ok(priorDiskReads() <= n, `each session read at most once for dedupe (read ${priorDiskReads()})`);
  assert.equal(results.reduce((k, r) => k + r.exchanges.filter((x) => x.humanPrompt === 1).length, 0), n, "every prompt counted exactly once");
  assert.equal(results.reduce((k, r) => k + r.stats.duplicates, 0), replayed);
  assert.ok(elapsed < 30_000, `took ${elapsed} ms`); // generous: the work-count assertions above are the real check
});

test("rescans with nothing changed re-read nothing; a grown session is the only file read again", async () => {
  clearPriorCache();
  const root = makeRoot();
  await manySessions(root, 30);
  const parseAll = () => withRoot(root, async () => {
    const out = new Map<string, unknown>();
    for (const s of claudeReader.list().reverse()) out.set(s.key, await claudeReader.parse(s, ctx));
    return out;
  });
  const first = await parseAll();
  const reads = priorDiskReads();
  assert.ok(reads > 0 && reads <= 30);
  assert.deepEqual(await parseAll(), first);
  assert.equal(priorDiskReads(), reads, "identical listing: the loaded index is reused");
  // An older session grows (e.g. it was resumed in place): only it is read again.
  appendFileSync(join(projectPath(root, P), "s00003.jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "x" }) + "\n");
  assert.deepEqual(await parseAll(), first);
  assert.equal(priorDiskReads(), reads + 1);
});

test("concurrent parses give the same results as sequential ones", async () => {
  const root = makeRoot();
  const replayed = await manySessions(root, 40);
  const run = async (concurrent: boolean) => {
    clearPriorCache();
    return withRoot(root, async () => {
      const sources = claudeReader.list().reverse();
      const results = concurrent
        ? await Promise.all(sources.map((s) => claudeReader.parse(s, ctx)))
        : await sources.reduce<Promise<unknown[]>>(async (acc, s) => [...(await acc), await claudeReader.parse(s, ctx)], Promise.resolve([]));
      return { results, reads: priorDiskReads() };
    });
  };
  const seq = await run(false);
  const par = await run(true);
  assert.deepEqual(par.results, seq.results);
  assert.ok(par.reads <= 40, `read ${par.reads}`);
  const dupes = (par.results as { stats: { duplicates: number } }[]).reduce((k, r) => k + r.stats.duplicates, 0);
  assert.equal(dupes, replayed);
});

test("a re-listing while parses are in flight never corrupts their dedupe", async () => {
  const root = makeRoot();
  await manySessions(root, 20);
  clearPriorCache();
  const expected = await withRoot(root, async () => {
    const out = [];
    for (const s of claudeReader.list()) out.push(await claudeReader.parse(s, ctx));
    return out;
  });
  for (const settleFirst of [0, 6]) {
    clearPriorCache();
    const got = await withRoot(root, async () => {
      const sources = claudeReader.list();
      const pending = sources.map((s) => claudeReader.parse(s, ctx));
      if (settleFirst) await pending[settleFirst]; // later parses are now loading or waiting their turn
      appendFileSync(join(projectPath(root, P), "s00001.jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "x" }) + "\n");
      claudeReader.list(); // re-listing mid-flight: s00001 changed, so the loaded prefix is cut back
      return Promise.all(pending);
    });
    assert.deepEqual(got, expected, `re-listed after ${settleFirst} parses settled`);
  }
});
