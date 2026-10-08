import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng, clamp, shiftOdds } from "../src/synth/rng.js";

test("same seed and label give the same stream; different seeds differ", () => {
  const a = new Rng(42, "x");
  const b = new Rng(42, "x");
  const c = new Rng(43, "x");
  const d = new Rng(42, "y");
  const xs = Array.from({ length: 50 }, () => a.nextU32());
  assert.deepEqual(xs, Array.from({ length: 50 }, () => b.nextU32()));
  assert.notDeepEqual(xs, Array.from({ length: 50 }, () => c.nextU32()));
  assert.notDeepEqual(xs, Array.from({ length: 50 }, () => d.nextU32()));
});

test("fork derives a stream without consuming the parent, so adding draws elsewhere never shifts it", () => {
  const p1 = new Rng(7, "root");
  const p2 = new Rng(7, "root");
  p2.next(); p2.next(); p2.next(); // the parent has been used heavily
  const f1 = p1.fork("child");
  const f2 = p2.fork("child");
  assert.deepEqual(Array.from({ length: 20 }, () => f1.nextU32()), Array.from({ length: 20 }, () => f2.nextU32()));
  assert.notEqual(p1.fork("a").nextU32(), p1.fork("b").nextU32());
});

test("int is inclusive, next is in [0,1), chance honours its probability", () => {
  const r = new Rng(1);
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) seen.add(r.int(3, 6));
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6]);
  for (let i = 0; i < 1000; i++) { const x = r.next(); assert.ok(x >= 0 && x < 1); }
  let hits = 0;
  for (let i = 0; i < 20_000; i++) if (r.chance(0.25)) hits++;
  assert.ok(Math.abs(hits / 20_000 - 0.25) < 0.02);
  assert.equal(r.int(5, 5), 5);
  assert.equal(r.int(9, 2), 9, "empty range collapses to lo");
});

test("poisson, lognormal and geometric have the right means", () => {
  const r = new Rng(2);
  const n = 20_000;
  let p = 0, g = 0, l = 0;
  for (let i = 0; i < n; i++) { p += r.poisson(4); g += r.geometric(3); l += r.lognormal(10, 0.3); }
  assert.ok(Math.abs(p / n - 4) < 0.1, `poisson mean ${p / n}`);
  assert.ok(Math.abs(g / n - 3) < 0.15, `geometric mean ${g / n}`);
  assert.ok(Math.abs(l / n - 10 * Math.exp(0.045)) < 0.2, `lognormal mean ${l / n}`);
  assert.equal(r.poisson(0), 0);
  assert.ok(r.poisson(500) > 400, "large lambda uses the normal approximation");
});

test("weighted, shuffled and pick behave", () => {
  const r = new Rng(3);
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 10_000; i++) counts[r.weighted(["a", "b"] as const, [1, 3])]++;
  assert.ok(Math.abs(counts.b / 10_000 - 0.75) < 0.03);
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual([...r.shuffled(xs)].sort((a, b) => a - b), xs);
  assert.deepEqual(xs, [1, 2, 3, 4, 5, 6, 7, 8], "input untouched");
  assert.throws(() => r.pick([]));
});

test("ids have the expected shapes and lengths", () => {
  const r = new Rng(4);
  assert.match(r.uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(r.hex(40), /^[0-9a-f]{40}$/);
  assert.match(r.base62(22), /^[0-9A-Za-z]{22}$/);
  assert.match(r.base64(100), /^[A-Za-z0-9+/]{100}$/);
  assert.equal(r.bytes(64).length, 64);
  assert.notEqual(r.uuid(), r.uuid());
});

test("clamp and shiftOdds", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.ok(Math.abs(shiftOdds(0.5, 0) - 0.5) < 1e-9);
  assert.ok(shiftOdds(0.1, 1) > 0.1 && shiftOdds(0.1, -1) < 0.1);
  assert.ok(shiftOdds(0, 5) > 0 && shiftOdds(1, -5) < 1, "never hits 0 or 1 exactly");
});
