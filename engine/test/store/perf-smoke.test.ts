/**
 * Perf smoke (the full performance run is `engine/dist/test/perf/perf.js`, ~2.3 GB, via scripts/dev/heavy.sh): a small padded
 * synthetic corpus, each scan in a fresh process. Bounds here are deliberately loose (the suite may share the machine);
 * they catch an order-of-magnitude regression, not a budget breach.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { appendExchange, buildCorpus, runOnce, singleProject, type MeasureEnv } from "../perf/perf.js";
import { tempEnv } from "./helpers.js";

test("perf smoke: full scan, nothing changed, one changed session — fresh processes, loose bounds", () => {
  const env = tempEnv("perf");
  try {
    const root = realpathSync(env.root);
    const corpus = buildCorpus(join(root, "corpus"), 40 << 20, 12 << 20);
    assert.ok(corpus.bytes > 30 << 20, `corpus ${corpus.bytes}`);
    assert.ok(corpus.bigBytes > 10 << 20);
    const userHome = join(root, "home2");
    mkdirSync(join(userHome, ".wasitme"), { recursive: true, mode: 0o700 });
    const m: MeasureEnv = { corpus, home: join(userHome, ".wasitme"), userHome, tz: "UTC", flag: null };
    const full = runOnce(m, false);
    assert.ok(full.parsed > 50 && full.parsed === full.sources);
    assert.ok(full.exchanges > 500);
    assert.ok(full.wallMs < 20_000, `full ${full.wallMs}`);
    const none = runOnce(m, false);
    assert.equal(none.parsed, 0);
    assert.equal(none.reused, true);
    assert.ok(none.scanMs < 1500, `nothing changed ${none.scanMs}`);
    appendExchange(corpus.bigSession, 1);
    const one = runOnce(m, false);
    assert.equal(one.parsed, 1, "only the changed session (it is the newest in its project, so nothing depends on it)");
    assert.ok(one.scanMs < 5000, `one changed ${one.scanMs}`);
    for (const r of [full, none, one]) assert.ok(r.maxRssMB < 400, `rss ${r.maxRssMB}`);
    // WP-12 review: a single-project layout — every session in one project, the big one newest. A fresh process that
    // re-parses it takes every earlier session's record ids from the store and reads none of their logs.
    const single = singleProject(corpus);
    assert.ok(single.moved > 0 && single.priorsMB > 10, JSON.stringify(single));
    runOnce(m, false); // the move re-keys every source
    appendExchange(corpus.bigSession, 2);
    const oneSingle = runOnce(m, false);
    assert.equal(oneSingle.parsed, 1);
    assert.equal(oneSingle.priorReads, 0, "no prior log re-read in a fresh process");
    assert.ok(oneSingle.scanMs < 5000, `one changed (single project) ${oneSingle.scanMs}`);
  } finally {
    env.cleanup();
  }
});
