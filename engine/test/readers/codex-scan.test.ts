import { test } from "node:test";
import assert from "node:assert/strict";
import { codexReader, codexScanIndex } from "../../src/readers/codex.js";
import { Rollout, testCtx, uuid, writeTree, type TreeFile } from "../fixtures/codex/build.js";
import "../fixtures/codex/harness.js"; // points WASITME_CODEX_DIR at an empty dir for the whole file

/** One trivial main-thread session per file; every 10th file is a subagent of the file before it. */
function sessions(n: number): TreeFile[] {
  const out: TreeFile[] = [];
  for (let i = 0; i < n; i++) {
    const id = uuid(10_000 + i);
    const turn = uuid(50_000 + i);
    const parent = i % 10 === 9 ? uuid(10_000 + i - 1) : undefined;
    const content = new Rollout("2026-09-01T10:00:00Z")
      .meta(parent ? { id, parent, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } }, threadSource: "subagent" } : { id, threadSource: "user" })
      .started(turn).ctx(turn).user(turn, `prompt ${i}`).cmd(turn).usage(turn, `r${i}`, { input: 10, output: 1 }).complete(turn)
      .text();
    out.push({ id, stamp: `2026-09-01T10-${String(Math.floor(i / 60) % 60).padStart(2, "0")}-${String(i % 60).padStart(2, "0")}`, content });
  }
  return out;
}

async function withRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.WASITME_CODEX_DIR;
  process.env.WASITME_CODEX_DIR = root;
  try { return await fn(); } finally { process.env.WASITME_CODEX_DIR = prev; }
}

test("the thread index is built once per scan (list), not once per parse", async () => {
  const { root } = writeTree(sessions(3));
  await withRoot(root, async () => {
    const before = codexScanIndex.builds;
    const sources = codexReader.list();
    assert.equal(sources.length, 3);
    assert.equal(codexScanIndex.builds, before, "list() stays stat-only");
    for (const s of sources) await codexReader.parse(s, testCtx());
    assert.equal(codexScanIndex.builds - before, 1);
    codexReader.list();
    await codexReader.parse(sources[0]!, testCtx());
    await codexReader.parse(sources[1]!, testCtx());
    assert.equal(codexScanIndex.builds - before, 2, "a new list() starts a new scan");
  });
});

test("a full scan stays roughly linear in the number of rollout files", async () => {
  const n = 2000;
  const { root } = writeTree(sessions(n));
  await withRoot(root, async () => {
    const before = codexScanIndex.builds;
    const t0 = performance.now();
    const sources = codexReader.list();
    let exchanges = 0, sub = 0;
    for (const s of sources) {
      const r = await codexReader.parse(s, testCtx());
      exchanges += r.exchanges.length;
      for (const e of r.exchanges) sub += e.subToolCalls;
    }
    const ms = performance.now() - t0;
    assert.equal(sources.length, n);
    assert.equal(exchanges, n - n / 10, "subagent files report through their parent");
    assert.equal(sub, n / 10);
    assert.equal(codexScanIndex.builds - before, 1);
    // Coarse on purpose (the machine may be busy): the per-parse index made this ~11 s; linear is well under 1 s.
    assert.ok(ms < 6000, `scan of ${n} files took ${Math.round(ms)} ms`);
  });
});
