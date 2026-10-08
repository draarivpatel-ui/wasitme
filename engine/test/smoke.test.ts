import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanLabel, cleanTime, makeHash, readJsonl } from "../src/util.js";
import { tempDir } from "./fixtures/temp.js";

test("readJsonl splits on \\n only (U+2028/U+2029 inside strings survive)", async () => {
  const dir = tempDir("wasitme-");
  const p = join(dir, "a.jsonl");
  const rec = { type: "user", text: "a b c" };
  writeFileSync(p, JSON.stringify(rec) + "\n" + "{not json}\n" + '{"type":"tail"');
  const stats = { badLines: 0, truncatedTail: 0 };
  const out = [];
  for await (const r of readJsonl(p, stats)) out.push(r);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.text, "a b c");
  assert.equal(stats.badLines, 1);
  assert.equal(stats.truncatedTail, 1);
});

test("cleanLabel rejects paths, prose, ANSI and long strings", () => {
  assert.equal(cleanLabel("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(cleanLabel("2.1.289"), "2.1.289");
  assert.equal(cleanLabel("/Users/x/secret"), undefined);
  assert.equal(cleanLabel("\u001b[31mred"), undefined);
  assert.equal(cleanLabel("x".repeat(61)), undefined);
});

test("cleanTime rejects out-of-range timestamps", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  assert.equal(cleanTime("2019-12-31T00:00:00Z", now), undefined);
  assert.equal(cleanTime("2026-10-06T00:00:00Z", now), undefined);
  assert.equal(cleanTime("2026-10-04T11:00:00Z", now), "2026-10-04T11:00:00.000Z");
});

test("makeHash is salted and stable", () => {
  const a = makeHash("salt-a"), b = makeHash("salt-b");
  assert.equal(a("x", "s-"), a("x", "s-"));
  assert.notEqual(a("x", "s-"), b("x", "s-"));
  assert.match(a("x", "s-"), /^s-[0-9a-f]{12}$/);
});
