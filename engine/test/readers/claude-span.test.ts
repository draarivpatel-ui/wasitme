import assert from "node:assert/strict";
import { test } from "node:test";
import { RESET_MS, SpanClock } from "../../src/readers/claude/span.js";

const MIN = 60_000;
const span = (times: number[]): number => {
  const c = new SpanClock();
  for (const t of times) c.add(t);
  return c.ms;
};
const T0 = Date.parse("2026-09-02T10:00:00.000Z");
const at = (min: number): number => T0 + min * MIN;

test("SpanClock: plain forward progress, including a genuine long gap with no reset", () => {
  assert.equal(span([]), 0);
  assert.equal(span([at(0)]), 0);
  assert.equal(span([at(0), at(1), at(2)]), 2 * MIN);
  assert.equal(span([at(0), at(1), at(21), at(22)]), 22 * MIN, "a 20-minute tool run is real time");
  assert.equal(span([at(0), Number.NaN, at(3)]), 3 * MIN, "non-finite times are ignored");
});

test("SpanClock: small reorders never inflate; a confirmed reset re-bases; a stray early record is ignored", () => {
  assert.equal(span([at(0), at(2), at(1), at(3)]), 3 * MIN);
  assert.equal(span([at(0), at(10), at(-120), at(-119)]), 11 * MIN, "reset two hours back, continuing from there");
  assert.equal(span([at(0), at(1), at(-60), at(2)]), 2 * MIN, "stray early record");
});

test("SpanClock: forward jumps undone by a confirmed reset are refunded", () => {
  assert.equal(span([at(0), at(1), at(60), at(2), at(3)]), 3 * MIN, "one stray late record");
  assert.equal(span([at(0), at(1), at(181), at(182), at(2), at(3)]), 3 * MIN, "a corrected multi-record excursion");
  assert.equal(span([at(0), at(1), at(181), at(121), at(122), at(2), at(3)]), 3 * MIN, "corrected in two steps");
  // A genuine long gap and a genuine reset landing below where the gap started: nothing refunded.
  assert.equal(span([at(0), at(10), at(-120), at(-119)]), 11 * MIN);
  // Excursion during which a genuine 20-minute run happened, then corrected: still exact.
  assert.equal(span([at(0), at(180), at(181), at(201), at(22), at(23)]), 23 * MIN);
  // Known trade-off: a genuine 20-minute run followed by a small genuine reset (6 minutes back,
  // landing above where the run started) is read as a correction and undercounted by 6 minutes.
  assert.equal(span([at(0), at(20), at(14), at(15)]), 15 * MIN);
});

test("SpanClock: a jump back on the last record cannot be confirmed and refunds nothing; never negative", () => {
  assert.equal(span([at(0), at(1), at(60), at(2)]), 60 * MIN);
  assert.equal(span([at(0), at(-1), at(-2), at(-3)]), 0);
  assert.equal(span([at(0), at(-30), at(-29), at(-90), at(-89)]), 2 * MIN);
  assert.ok(RESET_MS === 5 * MIN);
});
