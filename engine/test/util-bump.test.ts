// bump(): counts keyed by log-derived strings must survive keys that collide with Object.prototype (SECURITY.md
// "Hostile input handling"; a contract-freeze reconcile item: null-prototype semantics for unknownTypes and friends).

import { test } from "node:test";
import assert from "node:assert/strict";

import { bump } from "../src/util.js";
import { emptyStats } from "../src/types.js";

test("bump counts prototype-colliding keys as plain numbers and never touches the prototype", () => {
  const counts = emptyStats().unknownTypes;
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "relocated"]) {
    bump(counts, key);
    bump(counts, key, 2);
  }
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "relocated"]) {
    assert.equal(Object.getOwnPropertyDescriptor(counts, key)?.value, 3, key);
  }
  assert.equal(Object.getPrototypeOf(counts), Object.prototype, "the prototype was not swapped");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const round = JSON.parse(JSON.stringify(counts)) as Record<string, unknown>;
  assert.ok(Object.values(round).every((v) => v === 3), "serialises as numbers");
  assert.equal(Object.keys(round).length, 6);
});
