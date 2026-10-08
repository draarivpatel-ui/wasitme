// Cross-file duplicates from resume (research/05 #2): session B replays all 6 of session A's records with the
// same uuids/timestamps/requestIds but B's sessionId, then continues. Kept in its own file (= own process) because
// a reader may keep cross-source dedupe state between parse() calls; this file controls the parse order.
//
// NOTE: the Reader contract parses one Source at a time and results are cached per source fingerprint, so the
// contract does not say WHERE cross-file dedupe lives. These tests pin the observable outcome a scan must have.
import { expectFields, findSource, makeCtx, total } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ParseResult } from "../../src/types.js";
import { claudeReader } from "../../src/readers/claude.js";

const TOTALS = { exchanges: 3, humanPrompt: 3, steps: 5, toolCalls: 2, outTok: 250, inTok: 445, cacheRead: 6_600, cacheWrite: 4_600 };

function totals(rs: ParseResult[]) {
  const xs = rs.flatMap((r) => r.exchanges);
  return {
    exchanges: xs.length,
    humanPrompt: total(xs, "humanPrompt"),
    steps: total(xs, "steps"),
    toolCalls: total(xs, "toolCalls"),
    outTok: total(xs, "outTok"),
    inTok: total(xs, "inTok"),
    cacheRead: total(xs, "cacheRead"),
    cacheWrite: total(xs, "cacheWrite"),
  };
}

async function scan(order: ("resumeA" | "resumeB")[]): Promise<Record<string, ParseResult>> {
  const sources = claudeReader.list();
  const out: Record<string, ParseResult> = {};
  for (const n of order) out[n] = await claudeReader.parse(findSource(sources, n), makeCtx());
  return out;
}

test("#2 resume replay is counted once across a scan, and rescans are stable", async (t) => {
  let first: Record<string, ParseResult> = {};

  await t.test("scan 1 (A then B): A keeps its 2 exchanges; B contributes only its new exchange; B's 6 replayed records are duplicates", async () => {
    first = await scan(["resumeA", "resumeB"]);
    const a = first.resumeA!, b = first.resumeB!;
    const ax = [...a.exchanges].sort((x, y) => x.seq - y.seq);
    assert.equal(ax.length, 2);
    expectFields(ax[0]!, { t: "2026-09-29T16:00:00.000Z", humanPrompt: 1, steps: 2, toolCalls: 1, outTok: 80, inTok: 110, cacheRead: 2_000, cacheWrite: 2_000 }, "A E0");
    expectFields(ax[1]!, { t: "2026-09-29T16:05:00.000Z", humanPrompt: 1, steps: 1, toolCalls: 0, outTok: 70, inTok: 20, cacheRead: 2_100, cacheWrite: 100 }, "A E1");
    assert.equal(a.stats.duplicates, 0, "A.stats.duplicates");
    assert.equal(b.exchanges.length, 1, "B exchanges");
    expectFields(b.exchanges[0]!, { t: "2026-09-30T09:00:00.000Z", day: "2026-09-30", humanPrompt: 1, steps: 2, toolCalls: 1, outTok: 100, inTok: 315, cacheRead: 2_500, cacheWrite: 2_500 }, "B E0");
    assert.equal(b.stats.duplicates, 6, "B.stats.duplicates");
    assert.deepEqual(totals([a, b]), TOTALS);
  });

  await t.test("scan 2 (list again, A then B): identical per-source results — rescans must not re-classify a source's own records as duplicates", async () => {
    const again = await scan(["resumeA", "resumeB"]);
    assert.deepEqual(again.resumeA, first.resumeA);
    assert.deepEqual(again.resumeB, first.resumeB);
  });

  await t.test("scan 3 (list again, B then A): the replayed work is still counted exactly once in total", async () => {
    const rev = await scan(["resumeB", "resumeA"]);
    assert.deepEqual(totals([rev.resumeA!, rev.resumeB!]), TOTALS);
  });
});
