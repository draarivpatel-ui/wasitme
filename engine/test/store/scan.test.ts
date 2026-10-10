/**
 * WP-12 acceptance (D60): idempotent scans, history that survives deletion of the source logs,
 * full re-parse of shrunk / rewritten / replaced files, depKey invalidation, parser-version re-derivation that does not
 * change the state, outputs that satisfy the frozen contract. Synthetic data only (testdata/seed/tiny-both).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkGlance, checkSnapshot } from "../../src/contract/check.js";
import { validate } from "../../src/contract/validate.js";
import { GLANCE_MAX_BYTES } from "../../src/contract/vocab.js";
import { CLAUDE_PARSER_VERSIONS } from "../../src/readers/claude.js";
import { CODEX_PARSER_VERSIONS } from "../../src/readers/codex.js";
import type { ScanOptions } from "../../src/store/scan.js";
import { copyCorpus, readJson, REPO, scanIn, T0, TEST_CALIBRATION, TEST_UNCALIBRATED, TESTDATA, tempEnv, treeDigest, type TempEnv } from "./helpers.js";

const TINY = join(TESTDATA, "seed", "tiny-both");
/**
 * The store tests below run with the test-only calibration artifact, so the documents carry the analysis numbers
 * (metrics, tiers, windows, decisions) and "same state" comparisons compare them too. The first test runs the shipped
 * default (calibrated since 2026-10-05) and the uncalibrated path (TEST_UNCALIBRATED).
 */
const scan = (env: TempEnv, o: ScanOptions = {}) => scanIn(env, { calibration: TEST_CALIBRATION, ...o });
const glanceSchema = readJson(join(REPO, "contract", "glance.v1.schema.json"));
const snapshotSchema = readJson(join(REPO, "contract", "snapshot.v1.schema.json"));

function claudeSessions(root: string): string[] {
  const out: string[] = [];
  for (const p of readdirSync(join(root, "projects")).sort()) {
    for (const f of readdirSync(join(root, "projects", p)).sort()) if (f.endsWith(".jsonl")) out.push(join(root, "projects", p, f));
  }
  return out;
}

function codexRollouts(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.startsWith("rollout-")) out.push(p);
    }
  };
  walk(join(root, "sessions"));
  return out;
}

/**
 * The analysis part of a snapshot: the agents (no generatedAt, no health counters that describe the files on disk
 * today). `new` marks are scan-history dependent by the schema's definition ("appeared since the previous scan"), so
 * they are left out when two different histories are compared, and so are event ids (salted: two homes have two salts).
 */
function stateOf(snap: any): unknown {
  const strip = (e: any) => ({ ...e, new: undefined, id: undefined });
  // The status line's "+n" counts new events (words, D59): scan-history dependent like the `new` marks.
  return snap.agents.map((a: any) => ({ ...a, statusLine: a.statusLine.replace(/ \+\d+$/, ""), events: a.events.map(strip), timeline: a.timeline.map(strip) }));
}

test("outputs satisfy the frozen contract (schema, semantic rules, copy lint, size)", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    /** Read both documents and hold them to the schema, the semantic rules and the copy lint. */
    const readOutputs = (): { g: any; s: any } => {
      const g = readJson(join(env.wh, "glance.json"));
      const s = readJson(join(env.wh, "snapshot.json"));
      assert.deepEqual(validate(glanceSchema, g), []);
      assert.deepEqual(validate(snapshotSchema, s), []);
      assert.deepEqual(checkGlance(g, { copy: true }), []);
      assert.deepEqual(checkSnapshot(s, { copy: true }), []);
      return { g, s };
    };

    // The shipped default: the 2026-10-05 artifact calibrates both agents (D58/D64), so the decision table runs past row 1.
    const r = await scanIn(env);
    assert.equal(r.busy, false);
    assert.equal(r.wrote, true);
    const { g, s } = readOutputs();
    assert.ok(readFileSync(join(env.wh, "glance.json")).length <= GLANCE_MAX_BYTES);
    assert.deepEqual(g.agents.map((a: any) => a.agent), ["claude-code", "codex"]);
    for (const a of g.agents) {
      // Honest state on this small corpus: calibrated, but too little history to compare anything (row 2), not "timeline only".
      assert.equal(a.state, "insufficient");
      assert.equal(a.reason, "needs_data");
      assert.equal(a.calibrated, true);
    }
    assert.deepEqual(s.calibration, {
      artifactDate: "2026-10-05", methodId: "session-t95-cr2",
      agents: [
        { agent: "claude-code", calibrated: true, sequences: 6000, falseChanged: 0, falseAgent: 0 },
        { agent: "codex", calibrated: true, sequences: 1000, falseChanged: 0, falseAgent: 0 },
      ],
    });
    assert.ok(s.agents.every((a: any) => a.calibrated === true && a.metrics.length === 8));
    assert.ok(r.attributions && r.attributions.length === 2 && r.attributions.every((x) => x.evaluation.tiers.length === 3));
    assert.equal(s.health.sandbox, false);
    // Families whose numbers differ by agent are reported per agent (D62b moved Claude's exchanges; context moved in
    // both readers, Claude once more for replayed-response copies). Research and events moved in both readers to the
    // same numbers (Claude events: the D81 session id; Codex events: its provider-switch time fix, kept equal to Claude's).
    assert.deepEqual(Object.keys(s.health.parserVersions).sort(), [
      "claudeCodeContext", "claudeCodeExchanges", "codexContext", "codexExchanges",
      "events", "friction", "interactive", "labels", "research", "toolErrors",
    ]);

    // The uncalibrated path (an artifact that passed no agent, through the test seam): row 1, "Timeline only". The words
    // layer writes no metrics, tier or windows for an uncalibrated agent (D59) — the evaluation's numbers stay available
    // in memory on the report (G0-style reads).
    const u = await scanIn(env, { calibration: TEST_UNCALIBRATED });
    assert.equal(u.reused, false, "the calibration in force is an input of the analysis");
    const { g: g1, s: s1 } = readOutputs();
    assert.deepEqual(g1.agents.map((a: any) => a.agent), ["claude-code", "codex"]);
    for (const a of g1.agents) {
      assert.equal(a.state, "insufficient");
      assert.equal(a.reason, "calibration_pending");
      assert.equal(a.calibrated, false);
    }
    assert.deepEqual(s1.calibration, {
      artifactDate: "2026-10-04", methodId: null,
      agents: [
        { agent: "claude-code", calibrated: false, sequences: 0, falseChanged: null, falseAgent: null },
        { agent: "codex", calibrated: false, sequences: 0, falseChanged: null, falseAgent: null },
      ],
    });
    assert.ok(s1.agents.every((a: any) => a.metrics.length === 0 && a.tier === null && a.windows === null));
    assert.ok(u.attributions && u.attributions.length === 2 && u.attributions.every((x) => x.evaluation.tiers.length === 3));

    // Calibrated (test-only artifact with distinct rates): the same corpus, the 8 snapshot metrics, pooled rates.
    const c = await scan(env);
    assert.equal(c.reused, false, "the calibration in force is an input of the analysis");
    const { g: g2, s: s2 } = readOutputs();
    assert.ok(g2.agents.every((a: any) => a.calibrated === true));
    assert.ok(s2.agents.every((a: any) => a.calibrated === true && a.metrics.length === 8));
    assert.deepEqual(s2.calibration, {
      artifactDate: "2026-10-01", methodId: "session-t95-cr2",
      agents: [
        { agent: "claude-code", calibrated: true, sequences: 2000, falseChanged: 0.03, falseAgent: 0.005 },
        { agent: "codex", calibrated: true, sequences: 1000, falseChanged: 0.04, falseAgent: null },
      ],
    });
  } finally {
    env.cleanup();
  }
});

test("idempotent: a second scan with nothing changed leaves every byte of the home folder identical", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    const first = await scan(env);
    assert.ok(first.parsed > 10);
    const before = treeDigest(env.wh);
    const second = await scan(env);
    assert.equal(second.parsed, 0);
    assert.equal(second.unchanged, first.sources);
    assert.equal(second.reused, true, "inputs unchanged: outputs re-stamped, not recomputed");
    assert.deepEqual(treeDigest(env.wh), before);
    // Even when the outputs are recomputed from scratch (manifest inputs cleared), the bytes are the same.
    const idx = readJson(join(env.wh, "history", "index.json"));
    idx.inputs = null;
    writeFileSync(join(env.wh, "history", "index.json"), JSON.stringify(idx) + "\n");
    const third = await scan(env);
    assert.equal(third.reused, false);
    assert.deepEqual(treeDigest(env.wh), before);
  } finally {
    env.cleanup();
  }
});

test("history survives deletion of the source logs (Claude sessions and Codex rollouts)", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    await scan(env);
    const s1 = readJson(join(env.wh, "snapshot.json"));
    const sessions = claudeSessions(env.claude);
    const rollouts = codexRollouts(env.codex);
    // Delete half of every agent's logs.
    for (const p of [...sessions.slice(0, Math.ceil(sessions.length / 2)), ...rollouts.slice(0, Math.ceil(rollouts.length / 2))]) remove(p);
    const r = await scan(env);
    assert.ok(r.historyOnly > 0, "deleted sources are kept as history");
    const s2 = readJson(join(env.wh, "snapshot.json"));
    assert.deepEqual(stateOf(s2), stateOf(s1), "same timeline, counts, metrics and series after the logs are gone");
    for (const a of s2.health.sources) assert.equal(a.found, true);
    // Delete everything: still the same history.
    for (const p of [...claudeSessions(env.claude), ...codexRollouts(env.codex)]) remove(p);
    await scan(env);
    assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), stateOf(s1));
  } finally {
    env.cleanup();
  }
});

function remove(p: string): void {
  if (existsSync(p)) unlinkSync(p);
}

function shardOf(wh: string, pred: (s: any) => boolean): any {
  for (const n of readdirSync(join(wh, "history", "shards"))) {
    const s = readJson(join(wh, "history", "shards", n));
    if (pred(s)) return s;
  }
  return undefined;
}

test("a shrunk, rewritten-in-place or replaced file is re-parsed in full (never resumed from an old offset)", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    await scan(env);
    // The biggest Claude session that is nobody's prior (the newest in its project), so only it re-parses.
    const target = claudeSessions(env.claude).sort((a, b) => statSync(b).size - statSync(a).size)[0]!;
    const st = statSync(target);
    const text = readFileSync(target, "utf8");
    const lines = text.split("\n").filter(Boolean);

    // Times are put back to the sub-millisecond (`st.atime`/`st.mtime` are whole-millisecond Dates): setting an mtime
    // earlier than a file's birth time moves the birth time too (macOS), and birth time is the creation order the resume
    // dedupe ranks sessions by. A git checkout writes the corpus within a millisecond or two, so a truncated time could
    // put the target before its sibling and the final state would differ from a fresh scan for a reason no real log has.
    const back = (path: string, s: { atimeMs: number; mtimeMs: number }): void => utimesSync(path, s.atimeMs / 1000, s.mtimeMs / 1000);

    // 1. Truncated to its first half (what a concurrent rewrite could leave), mtime put back.
    writeFileSync(target, lines.slice(0, Math.floor(lines.length / 2)).join("\n") + "\n");
    back(target, st);
    const r1 = await scan(env);
    assert.ok(r1.parsed >= 1, "shrunk file re-parsed");
    // 2. Same size, same mtime, different bytes (a rewrite in place that restored the mtime): ctime moved.
    const half = readFileSync(target, "utf8");
    const swapped = half.replace(/"cli"/, '"cl1"');
    assert.notEqual(swapped, half);
    assert.equal(Buffer.byteLength(swapped), Buffer.byteLength(half));
    const st2 = statSync(target);
    writeFileSync(target, swapped);
    back(target, st2);
    const r2 = await scan(env);
    assert.ok(r2.parsed >= 1, "same-size rewrite detected");
    // 3. Replaced by the original content through a rename (new inode), mtime restored.
    writeFileSync(target + ".tmp", text);
    back(target + ".tmp", st);
    renameSync(target + ".tmp", target);
    const r3 = await scan(env);
    assert.ok(r3.parsed >= 1, "replaced file detected");
    // Back to the original content: the state equals a fresh scan of the original corpus.
    const fresh = tempEnv();
    try {
      copyCorpus(fresh, TINY);
      await scan(fresh);
      assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), stateOf(readJson(join(fresh.wh, "snapshot.json"))));
    } finally {
      fresh.cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test("appending to a session re-parses it (and only what depends on it)", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    const first = await scan(env);
    const rollout = codexRollouts(env.codex).at(-1)!;
    appendFileSync(rollout, "\n");
    const r = await scan(env);
    assert.ok(r.parsed >= 1 && r.parsed < first.sources, `parsed ${r.parsed} of ${first.sources}`);
  } finally {
    env.cleanup();
  }
});

test("a parser-version bump with the sources present re-derives only that family and does not change the state", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    await scan(env);
    const g1 = readFileSync(join(env.wh, "glance.json"), "utf8");
    const s1 = readJson(join(env.wh, "snapshot.json"));
    const shard1 = shardOf(env.wh, (s) => s.agent === "claude-code" && s.exchanges.length > 3);

    const bumped = await scan(env, { parserVersions: { "claude-code": { toolErrors: CLAUDE_PARSER_VERSIONS.toolErrors + 1 } } });
    assert.equal(bumped.parsed, 0, "no content change: nothing is parsed from scratch");
    assert.ok(bumped.rederivedPartial > 0, "claude sources re-derived (toolErrors family only)");
    assert.equal(bumped.rederivedFull, 0);
    const codexShard = shardOf(env.wh, (s) => s.agent === "codex");
    assert.equal(codexShard.pv.toolErrors, 1, "the other agent's shards are untouched");
    const shard2 = shardOf(env.wh, (s) => s.sid === shard1.sid);
    assert.equal(shard2.pv.toolErrors, 2);
    assert.deepEqual(shard2.exchanges, shard1.exchanges, "same parser output → same stored fields");
    assert.equal(readFileSync(join(env.wh, "glance.json"), "utf8"), g1, "glance byte-identical");
    const s2 = readJson(join(env.wh, "snapshot.json"));
    assert.deepEqual(stateOf(s2), stateOf(s1));
    assert.deepEqual(s2.health.paused, []);
    assert.equal(s2.health.parserVersions.claudeCodeToolErrors, 2, "versions differ by agent: reported per agent");
    assert.equal(s2.health.parserVersions.codexToolErrors, 1);

    // A structural bump (what an exchange is) replaces whole shards; still the same state.
    const full = await scan(env, {
      parserVersions: { "claude-code": { toolErrors: CLAUDE_PARSER_VERSIONS.toolErrors + 1, exchanges: CLAUDE_PARSER_VERSIONS.exchanges + 1 }, codex: { exchanges: CODEX_PARSER_VERSIONS.exchanges + 1 } },
    });
    assert.ok(full.rederivedFull > 0);
    assert.equal(readFileSync(join(env.wh, "glance.json"), "utf8"), g1);
    assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), stateOf(s1));
  } finally {
    env.cleanup();
  }
});

test("a bump whose sources are gone cannot re-derive: history is kept and the affected metrics report parser_changed", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    await scan(env);
    for (const p of claudeSessions(env.claude)) remove(p);
    const r = await scan(env, { parserVersions: { "claude-code": { research: CLAUDE_PARSER_VERSIONS.research + 1 } } });
    assert.ok(r.historyOnly > 0);
    const s = readJson(join(env.wh, "snapshot.json"));
    assert.deepEqual(s.health.paused, [
      { agent: "claude-code", metric: "blindEdits", why: "parser_changed" },
      { agent: "claude-code", metric: "readsPerEdit", why: "parser_changed" },
    ]);
    assert.deepEqual(validate(snapshotSchema, s), []);
  } finally {
    env.cleanup();
  }
});

test("a time-zone change recomputes stored days without re-parsing (deleted sources included)", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    await scan(env);
    remove(claudeSessions(env.claude)[0]!);
    const r = await scan(env, { timeZone: "Pacific/Kiritimati" });
    assert.equal(r.parsed, 0);
    const idx = readJson(join(env.wh, "history", "index.json"));
    assert.equal(idx.tz, "Pacific/Kiritimati");
    for (const n of readdirSync(join(env.wh, "history", "shards"))) {
      const s = readJson(join(env.wh, "history", "shards", n));
      assert.equal(s.tz, "Pacific/Kiritimati");
      for (const x of s.exchanges) assert.equal(x.day, new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(new Date(x.t)));
    }
    // And back: identical to a scan that never left UTC.
    await scan(env, { timeZone: "UTC" });
    const back = readJson(join(env.wh, "snapshot.json"));
    const ref = tempEnv();
    try {
      copyCorpus(ref, TINY);
      await scan(ref);
      remove(claudeSessions(ref.claude)[0]!);
      await scan(ref);
      assert.deepEqual(stateOf(back), stateOf(readJson(join(ref.wh, "snapshot.json"))));
    } finally {
      ref.cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test("--read-only writes nothing anywhere (no home folder, no salt) and still returns the report", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    const before = treeDigest(env.root);
    const r = await scan(env, { readOnly: true });
    assert.equal(r.wrote, false);
    assert.ok(r.snapshot && r.snapshot.agents.length === 2);
    assert.equal(existsSync(env.wh), false);
    assert.deepEqual(treeDigest(env.root), before);
    // Ephemeral salt: ids differ between two read-only runs.
    const r2 = await scan(env, { readOnly: true });
    const ids = (x: typeof r) => x.snapshot!.agents[0]!.timeline.map((e) => e.id).join();
    if (r.snapshot!.agents[0]!.timeline.length) assert.notEqual(ids(r), ids(r2));
  } finally {
    env.cleanup();
  }
});

test("--until leaves out later exchanges and events and evaluates as of the cutoff", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    const all = await scan(env, { readOnly: true });
    const cut = await scan(env, { readOnly: true, until: new Date("2026-07-04T23:59:00Z") });
    assert.ok(cut.afterCutoff > 0);
    for (const a of cut.snapshot!.agents) {
      for (const e of a.timeline) assert.ok(e.t <= "2026-07-04T23:59:00Z");
      assert.ok(a.n.exchanges <= all.snapshot!.agents.find((b) => b.agent === a.agent)!.n.exchanges);
    }
    for (const s of cut.snapshot!.health.sources) assert.ok(s.lastDay === null || s.lastDay <= "2026-07-04");
  } finally {
    env.cleanup();
  }
});

test("exclude list: date ranges, project ids and entrypoints drop exchanges at read time; a malformed list excludes nothing", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    await scan(env);
    const base = readJson(join(env.wh, "snapshot.json"));
    writeFileSync(join(env.wh, "state", "exclude.json"), JSON.stringify({ dates: [{ from: "2026-07-01", to: "2026-07-03" }], entrypoints: ["exec"] }));
    const r = await scan(env);
    assert.equal(r.parsed, 0, "exclusions never re-parse");
    assert.ok(r.excluded > 0);
    const s = readJson(join(env.wh, "snapshot.json"));
    assert.ok(s.agents[0].n.exchanges < base.agents[0].n.exchanges);
    for (const src of s.health.sources) assert.ok(src.firstDay === null || src.firstDay > "2026-07-03");
    writeFileSync(join(env.wh, "state", "exclude.json"), "{ not json");
    const bad = await scan(env);
    assert.equal(bad.excludeError, "malformed");
    assert.equal(bad.excluded, 0);
    assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), stateOf(base));
  } finally {
    env.cleanup();
  }
});

test("files are 0600 and folders 0700; the salt is 64 hex characters", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    await scan(env);
    const { modes } = await import("./helpers.js");
    for (const [p, m] of modes(env.wh)) {
      const isDir = statSync(join(env.wh, p)).isDirectory();
      assert.equal(m, isDir ? 0o700 : 0o600, `${p}: ${m.toString(8)}`);
    }
    assert.match(readFileSync(join(env.wh, "salt"), "latin1"), /^[0-9a-f]{64}\n$/);
  } finally {
    env.cleanup();
  }
});

test("a damaged manifest is rebuilt from the shards without losing history", async () => {
  const env = tempEnv();
  try {
    copyCorpus(env, TINY);
    await scan(env);
    const s1 = readJson(join(env.wh, "snapshot.json"));
    for (const p of codexRollouts(env.codex)) remove(p);
    writeFileSync(join(env.wh, "history", "index.json"), "garbage");
    const r = await scan(env);
    assert.ok(r.historyOnly > 0, "codex shards found again from their own headers");
    assert.deepEqual(stateOf(readJson(join(env.wh, "snapshot.json"))), stateOf(s1));
  } finally {
    env.cleanup();
  }
});

test("T0 sanity: the corpus ends before the injected now", () => {
  assert.ok(T0.toISOString() > "2026-07-07");
});
