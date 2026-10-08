/**
 * Golden fingerprints: one SHA-256 per scenario (default seed and length) plus the small hostile tier.
 * Committed as testdata/seed/golden.json; a test recomputes them, so any change to generator output
 * (an intentional improvement or an accidental nondeterminism) is loud. Regenerate with
 *   node engine/dist/src/synth/cli.js --golden testdata/seed/golden.json
 */
import { generate } from "./generate.js";
import { generateHostile } from "./hostile.js";
import { SCENARIOS } from "./scenarios.js";
import { digestFiles } from "./write.js";

export interface GoldenEntry { seed: number | null; days: number | null; files: number; bytes: number; sha256: string }

export function goldenTable(): Record<string, GoldenEntry> {
  const out: Record<string, GoldenEntry> = {};
  for (const sc of SCENARIOS) {
    const p = sc.build({});
    const g = generate(p, sc.name);
    out[sc.name] = { seed: p.seed, days: p.days, ...digestFiles(g.files) };
  }
  const h = generateHostile("small");
  out["hostile"] = { seed: null, days: null, ...digestFiles(h.files, h.links) };
  return out;
}
