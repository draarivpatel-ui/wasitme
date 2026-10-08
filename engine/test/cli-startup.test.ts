/**
 * The CLI entry point loads only what every command needs (main.ts): `wasitme status` runs as the status line, so its
 * start-up must not load the scan, the readers, the analysis or the renderers. Checked on the built JavaScript's
 * STATIC import graph (dynamic `import()` is how commands load their own modules).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+"(\.{1,2}\/[^"]+)";/gm)) visit(resolve(dirname(file), m[1]!));
    for (const m of text.matchAll(/^import\s+"(\.{1,2}\/[^"]+)";/gm)) visit(resolve(dirname(file), m[1]!));
  };
  visit(entry);
  return seen;
}

test("the CLI entry point's static imports reach no command, scan, reader, analysis or renderer module", () => {
  const graph = [...staticGraph(resolve(DIST, "cli", "main.js"))].map((f) => f.slice(DIST.length + 1));
  assert.ok(graph.length >= 5 && graph.length <= 20, `a small graph (${graph.length}): ${graph.join(", ")}`);
  for (const f of graph) {
    assert.doesNotMatch(f, /^(store\/scan|readers\/|analysis\/|output\/|words\/|cli\/commands\/|hook\/|demo\/)/, `main.js loads ${f} at start-up`);
  }
});

test("`wasitme status` loads its own graph only: no scan, reader, evaluation or decision module", () => {
  const graph = [...staticGraph(resolve(DIST, "cli", "commands", "status.js"))].map((f) => f.slice(DIST.length + 1));
  for (const f of graph) {
    assert.doesNotMatch(f, /^(store\/scan|store\/merge|readers\/|analysis\/(gates|confounders|calibration|metrics\/cells)|analysis\/stats\/(bootstrap|permutation|wild)|analysis\/attribution\/(decide|pipeline|evidence))/, `status loads ${f}`);
  }
});
