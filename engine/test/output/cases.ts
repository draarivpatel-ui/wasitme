/**
 * Shared cases for the output tests: engine output for every verdict state from the REAL pipeline (WP-21
 * `attributeAgent` on the synthetic workloads of the attribution tests, then `buildOutputs`), the same way
 * engine/test/words/rows.test.ts builds its copy goldens. Synthetic numbers and opaque labels only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { attributeAgent, type Attribution, type AttributeOptions, type AttributionEvent } from "../../src/analysis/attribution/index.js";
import type { MetricExchange } from "../../src/analysis/metrics/defs.js";
import type { Lead } from "../../src/contract/vocab.js";
import { coerceDoc, type ReportDoc } from "../../src/output/doc.js";
import { buildOutputs, type BuiltOutputs } from "../../src/words/index.js";
import { BASE, daysBack, recorded, scenario, TODAY } from "../analysis/attribution-fixtures.js";
import { addDays } from "../analysis/helpers.js";

export const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const GOLDENS = `${ROOT}engine/test/output/goldens/`;
export const UPDATE = process.env.WASITME_UPDATE_GOLDENS === "1";
export const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));

const ONSET = 10;
const ONSET_DAY = addDays(TODAY, -ONSET);
const SHIFT = { onset: ONSET, errors: [2, 6] as [number, number], blind: [2, 4] as [number, number] };

export const GENERATED_AT = `${TODAY}T12:00:00Z`;
/** Thirty minutes after the documents were generated: fresh under the default 7,200 s. */
export const NOW_MS = Date.parse(`${TODAY}T12:30:00Z`);

function run(xs: readonly MetricExchange[], events: readonly AttributionEvent[] = [], over: Partial<AttributeOptions> = {}): Attribution {
  return attributeAgent(xs, events, { ...BASE, calibrated: true, ...over });
}

/** One case per verdict state (and the reasons that change the screen), each with the decision-table row it reaches. */
export const CASES: { name: string; row: number; make: () => Attribution }[] = [
  { name: "insufficient", row: 2, make: () => run(scenario({ ...SHIFT, days: 30 })) },
  { name: "timeline-only", row: 1, make: () => run(scenario(SHIFT), [], { calibrated: false }) },
  { name: "none", row: 13, make: () => run(scenario({})) },
  {
    name: "unclear", row: 6, make: () => {
      const xs = scenario({ ...SHIFT, label: (after) => (after ? { effort: "medium", servedModel: "m-x", steps: 6 } : { effort: "high" }) });
      const effort = recorded({ id: "e-effort", kind: "effort", side: "you", from: "high", to: "medium", day: ONSET_DAY });
      return run(xs, [effort], { decide: { tripwires: { servedModel: true } } });
    },
  },
  {
    name: "you", row: 7, make: () => {
      const xs = scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) });
      return run(xs, [recorded({ id: "e-model", kind: "model", side: "you", from: "m1", to: "m2", day: ONSET_DAY })]);
    },
  },
  { name: "agent", row: 9, make: () => run(scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) }), [], { fullyObservedDays: daysBack(70) }) },
  { name: "unknown-origin", row: 5, make: () => run(scenario({ ...SHIFT, label: (after) => ({ effort: after ? "medium" : "high" }) })) },
  { name: "single-indicator", row: 12, make: () => run(scenario({ onset: ONSET, errors: [2, 6] })) },
  {
    name: "pending", row: 13, make: () => {
      const prev = run(scenario({}));
      const xs = scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) });
      return run(xs, [recorded({ id: "e-model", kind: "model", side: "you", from: "m1", to: "m2", day: ONSET_DAY })], { previous: prev.decision });
    },
  },
];

const cache = new Map<string, Attribution>();
export function attributionOf(name: string): Attribution {
  let a = cache.get(name);
  if (a === undefined) {
    const c = CASES.find((x) => x.name === name);
    if (c === undefined) throw new Error(`no case ${name}`);
    a = c.make();
    cache.set(name, a);
  }
  return a;
}

export function outputsOf(name: string, lead: Lead = "timeline"): BuiltOutputs {
  const out = buildOutputs({ engine: "0.1.0", generatedAt: GENERATED_AT, scanOk: true, lead, agents: [{ attribution: attributionOf(name) }] });
  if (out.problems.length > 0) throw new Error(`${name}: ${out.problems.join("; ")}`);
  return out;
}

export function docOf(name: string, lead: Lead = "timeline", nowMs: number = NOW_MS): ReportDoc {
  return coerceDoc(outputsOf(name, lead).snapshot, nowMs);
}

/** Remove the design system's colour codes. */
export const stripSgr = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
