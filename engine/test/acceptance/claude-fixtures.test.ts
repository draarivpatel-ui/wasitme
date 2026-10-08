// Guards the fixtures themselves: the committed files are exactly what build-fixtures.ts produces, and the
// byte-level traps the reader tests rely on (raw U+2028, no trailing newline, empty file) are really there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildAll, FIXTURE_DIR } from "../fixtures/acceptance/claude/build-fixtures.js";
import { mainPath } from "../fixtures/acceptance/claude/harness.js";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("committed fixture tree is byte-identical to build-fixtures.ts output (regenerate if this fails)", () => {
  const want = buildAll();
  const onDisk = walk(join(FIXTURE_DIR, "home")).map((p) => relative(FIXTURE_DIR, p).split(sep).join("/")).sort();
  assert.deepEqual(onDisk, [...want.keys()].sort(), "file set differs");
  for (const [rel, content] of want) {
    assert.equal(readFileSync(join(FIXTURE_DIR, rel), "utf8"), content, `${rel} differs from generator output`);
  }
});

test("unicode fixture contains RAW U+2028/U+2029 inside JSON strings (not \\u escapes)", () => {
  const buf = readFileSync(mainPath("unicode"));
  assert.ok(buf.includes(Buffer.from([0xe2, 0x80, 0xa8])), "raw U+2028 missing");
  assert.ok(buf.includes(Buffer.from([0xe2, 0x80, 0xa9])), "raw U+2029 missing");
  assert.ok(!buf.toString("utf8").includes("\\u2028"), "U+2028 must not be escaped");
  // Every \n-delimited line is still valid JSON — a reader that also splits on U+2028 would break them.
  const lines = buf.toString("utf8").split("\n").filter((l) => l.length > 0);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

test("damaged fixture ends mid-record with no trailing newline, and has exactly 4 non-object lines before it", () => {
  const s = readFileSync(mainPath("damaged"), "utf8");
  assert.ok(!s.endsWith("\n"), "must not end with a newline");
  const lines = s.split("\n");
  const last = lines.pop()!;
  assert.throws(() => JSON.parse(last), "final line must be a partial record");
  let bad = 0;
  for (const l of lines) {
    try {
      const v: unknown = JSON.parse(l);
      if (!v || typeof v !== "object" || Array.isArray(v)) bad++;
    } catch { bad++; }
  }
  assert.equal(bad, 4);
});

test("empty fixture is a zero-byte session file", () => {
  assert.equal(statSync(mainPath("empty")).size, 0);
});
