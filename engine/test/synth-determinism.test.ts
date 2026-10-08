import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../src/synth/generate.js";
import { goldenTable } from "../src/synth/golden.js";
import { SCENARIOS, findScenario } from "../src/synth/scenarios.js";
import { readTree } from "../src/synth/testkit.js";
import { digestFiles, writeTree } from "../src/synth/write.js";

const TESTDATA = fileURLToPath(new URL("../../../testdata/", import.meta.url));

function bytesByPath(files: { path: string; data: string | Buffer; mtimeMs?: number }[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, `${f.mtimeMs ?? ""}\0${Buffer.from(f.data).toString("base64")}`]));
}

test("every scenario is a pure function of (scenario, seed): two runs are byte-identical", () => {
  for (const sc of SCENARIOS) {
    const a = generate(sc.build({}), sc.name);
    const b = generate(sc.build({}), sc.name);
    assert.deepEqual(digestFiles(a.files), digestFiles(b.files), sc.name);
    const ma = bytesByPath(a.files);
    const mb = bytesByPath(b.files);
    assert.deepEqual([...ma.keys()], [...mb.keys()], `${sc.name}: same files in the same order`);
    for (const [p, v] of ma) assert.equal(v, mb.get(p), `${sc.name}: ${p}`);
  }
});

test("a different seed, length or volume changes the output", () => {
  const sc = findScenario("null-many-short")!;
  const base = digestFiles(generate(sc.build({}), sc.name).files).sha256;
  assert.notEqual(digestFiles(generate(sc.build({ seed: 999 }), sc.name).files).sha256, base);
  assert.notEqual(digestFiles(generate(sc.build({ days: 20 }), sc.name).files).sha256, base);
  assert.notEqual(digestFiles(generate(sc.build({ scale: 0.5 }), sc.name).files).sha256, base);
});

test("the on-disk tree is identical across two writes, mtimes included", () => {
  const sc = findScenario("tiny-both")!;
  const g = generate(sc.build({}), sc.name);
  const root = mkdtempSync(join(tmpdir(), "wasitme-det-"));
  try {
    writeTree(join(root, "one"), g.files);
    writeTree(join(root, "two"), g.files);
    const a = readTree(join(root, "one"));
    const b = readTree(join(root, "two"));
    assert.deepEqual([...a.keys()], [...b.keys()]);
    for (const [p, e] of a) assert.deepEqual(e, b.get(p), p);
    const mtimes = new Set([...a.values()].map((e) => e.mtimeMs));
    assert.ok(mtimes.size > 5, "files carry distinct, deterministic mtimes");
    // mtimes follow the (synthetic) content, not the wall clock: all inside the scenario's date range.
    for (const [p, e] of a) assert.ok(e.mtimeMs === 0 || (e.mtimeMs >= Date.UTC(2026, 0, 1) && e.mtimeMs < Date.UTC(2026, 8, 1)), `${p}: ${e.mtimeMs}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all generated numbers and times are integers (no float formatting to drift between machines)", () => {
  const sc = findScenario("tiny-both")!;
  const g = generate(sc.build({}), sc.name);
  for (const f of g.files) {
    if (!f.path.endsWith(".jsonl") || f.path.startsWith("synth-")) continue;
    const text = String(f.data);
    assert.doesNotMatch(text, /"(?:timestamp|durationMs|duration_ms|output_tokens|input_tokens)":-?\d+\.\d/, f.path);
  }
});

test("golden fingerprints (testdata/seed/golden.json) match the generator", () => {
  const committed = JSON.parse(readFileSync(join(TESTDATA, "seed", "golden.json"), "utf8")) as Record<string, unknown>;
  const now = goldenTable();
  assert.deepEqual(
    now, committed,
    "generator output changed. If that is intended, regenerate: node engine/dist/src/synth/cli.js --golden testdata/seed/golden.json (and the committed fixtures, see testdata/README.md)",
  );
});

test("the committed seed fixture testdata/seed/tiny-both is exactly what the generator writes", () => {
  const sc = findScenario("tiny-both")!;
  const g = generate(sc.build({}), sc.name);
  const root = mkdtempSync(join(tmpdir(), "wasitme-seed-"));
  try {
    writeTree(join(root, "fresh"), g.files);
    const fresh = readTree(join(root, "fresh"));
    const committed = readTree(join(TESTDATA, "seed", "tiny-both"));
    for (const p of [".wasitme-synth"]) { fresh.delete(p); committed.delete(p); }
    assert.deepEqual([...committed.keys()], [...fresh.keys()], "same file set");
    for (const [p, e] of fresh) {
      // git does not preserve mtimes, so compare content only.
      assert.equal(committed.get(p)!.sha256, e.sha256, p);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
