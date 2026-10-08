import { test } from "node:test";
import assert from "node:assert/strict";
import { scanTopLevel } from "../../src/extract/configsnap/jsonscan.js";

const WANT = new Set(["mcpServers"]);
const scan = (text: string) => scanTopLevel(text, WANT);

test("extracts a top-level value and reports the object complete", () => {
  const text = JSON.stringify({ a: 1, mcpServers: { x: { command: "c", args: ["a", "b"] } }, z: [1, 2] });
  const r = scan(text);
  assert.equal(r.complete, true);
  assert.deepEqual(JSON.parse(r.found.get("mcpServers")!), { x: { command: "c", args: ["a", "b"] } });
});

test("a key that is genuinely absent: complete, not found", () => {
  const r = scan('{"a":1,"b":{"c":2}}');
  assert.equal(r.complete, true);
  assert.equal(r.found.size, 0);
});

test("nested keys with the same name are ignored (projects.<path>.mcpServers is not the user's list)", () => {
  const text = JSON.stringify({
    projects: { "/Users/someone/proj": { mcpServers: { hidden: {} } } },
    mcpServers: { real: {} },
  });
  const r = scan(text);
  assert.deepEqual(Object.keys(JSON.parse(r.found.get("mcpServers")!)), ["real"]);
});

test("braces, brackets, quotes and escapes inside strings do not confuse the scanner", () => {
  const nasty = 'he said "}" and \\ then ] { [ \\"';
  const text = JSON.stringify({ junk: nasty, nested: { k: [nasty, { "}": "{" }] }, mcpServers: { s: { note: nasty } }, after: 1 });
  const r = scan(text);
  assert.equal(r.complete, true);
  assert.equal(JSON.parse(r.found.get("mcpServers")!).s.note, nasty);
});

test("escaped key spelling still matches (\\u006dcpServers)", () => {
  const r = scan('{"\\u006dcpServers": {"a": 1}}');
  assert.deepEqual(JSON.parse(r.found.get("mcpServers")!), { a: 1 });
});

test("truncated before the key: incomplete and not found (caller must say unknown, not zero)", () => {
  const full = JSON.stringify({ projects: { p: { history: "x".repeat(1000) } }, mcpServers: { a: {} } });
  const cut = full.slice(0, 500);
  const r = scan(cut);
  assert.equal(r.complete, false);
  assert.equal(r.found.size, 0);
});

test("truncated after the key: value still returned, object incomplete", () => {
  const full = JSON.stringify({ mcpServers: { a: {} }, projects: { p: "x".repeat(1000) } });
  const r = scan(full.slice(0, 200));
  assert.equal(r.complete, false);
  assert.deepEqual(JSON.parse(r.found.get("mcpServers")!), { a: {} });
});

test("a value cut off mid-way is not returned", () => {
  const r = scan('{"mcpServers": {"a": {"command": "x"');
  assert.equal(r.complete, false);
  assert.equal(r.found.size, 0);
});

test("a scalar cut off at the end is not trusted", () => {
  assert.equal(scan('{"a": 12').complete, false);
  assert.equal(scan('{"a": 12}').complete, true);
});

test("BOM, whitespace, empty object, non-objects, garbage", () => {
  assert.equal(scan("﻿  { }  ").complete, true);
  assert.equal(scan("[]").complete, false);
  assert.equal(scan("").complete, false);
  assert.equal(scan("not json").complete, false);
  assert.equal(scan('{"a" 1}').complete, false);
  assert.equal(scan('{"a": 1,}').complete, false);
});

test("hostile nesting does not overflow the stack", () => {
  const text = '{"x":' + "[".repeat(1_000_000) + "]".repeat(1_000_000) + ',"mcpServers":{}}';
  const r = scan(text);
  assert.equal(r.complete, true);
  assert.equal(r.found.get("mcpServers"), "{}");
});

test("fast on multi-megabyte input", () => {
  const big = JSON.stringify({ projects: Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`/p/${i}`, { history: ["x".repeat(100)] }])), mcpServers: { a: {} } });
  assert.ok(big.length > 2_000_000);
  const t0 = Date.now();
  const r = scan(big);
  assert.equal(r.complete, true);
  assert.ok(r.found.has("mcpServers"));
  assert.ok(Date.now() - t0 < 2000);
});
