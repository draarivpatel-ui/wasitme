/**
 * Copy goldens, one per decision-table row (METHOD.md §11) × lead variant, from the REAL pipeline (WP-21
 * `attributeAgent` on the synthetic workloads of the attribution tests). For every case: the documents validate against the frozen schemas
 * and pass checkGlance/checkSnapshot; every produced string passes lintCopy, the repo's lint-copy (glance rules on the
 * glance strings) and tokens.json's banned list; and the words equal engine/test/words/copy-goldens.json.
 *
 * The goldens freeze the wording so a change is deliberate: regenerate with WASITME_UPDATE_COPY=1 and review the diff.
 * Synthetic numbers and opaque labels only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { attributeAgent, type Attribution, type AttributeOptions, type AttributionEvent } from "../../src/analysis/attribution/index.js";
import type { MetricExchange } from "../../src/analysis/metrics/defs.js";
import { decisionRow } from "../../src/contract/check.js";
import { LEADS, type Lead } from "../../src/contract/vocab.js";
import { buildOutputs, explain, type AgentWords } from "../../src/words/index.js";
import { BASE, daysBack, recorded, scenario, TODAY } from "../analysis/attribution-fixtures.js";
import { addDays, ex } from "../analysis/helpers.js";
import { assertValidOutputs, ROOT } from "./helpers.js";

const ONSET = 10;
const ONSET_DAY = addDays(TODAY, -ONSET);
const SHIFT = { onset: ONSET, errors: [2, 6] as [number, number], blind: [2, 4] as [number, number] };
const GENERATED_AT = `${TODAY}T12:00:00Z`;

function run(xs: readonly MetricExchange[], events: readonly AttributionEvent[] = [], over: Partial<AttributeOptions> = {}): Attribution {
  return attributeAgent(xs, events, { ...BASE, calibrated: true, ...over });
}

function fragile(): MetricExchange[] {
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= 60; k++) {
    const day = addDays(TODAY, -k);
    const recent = k <= 14;
    const n = recent ? (k === 1 ? 12 : 3) : 4;
    for (let i = 0; i < n; i++) {
      const e = recent ? 6 : 2;
      xs.push(ex({
        session: `s${i}-${day}`, day, project: i % 2 === 0 ? "p-A" : "p-B", toolCalls: 50, cmdCalls: 0, toolErrors: e, toolErrorsEdit: e,
        toolErrorsCmd: 0, edits: 20, reads: 40, blindEdits: recent && k === 1 ? 8 : 2,
      }));
    }
  }
  return xs;
}

/** One case per row (plus Codex and a pending hold), each with the row it must reach. */
const CASES: { name: string; row: number; make: () => Attribution }[] = [
  { name: "row01-calibration_pending", row: 1, make: () => run(scenario(SHIFT), [], { calibrated: false }) },
  { name: "row02-needs_data", row: 2, make: () => run(scenario({ ...SHIFT, days: 30 })) },
  { name: "row03-mixed", row: 3, make: () => run(scenario({ onset: ONSET, errors: [2, 6], blind: [4, 2] })) },
  {
    name: "row04-workload", row: 4, make: () => {
      const projects = (after: boolean, i: number) => (after ? ["p-A", "p-B", "p-B", "p-B"] : ["p-A", "p-A", "p-A", "p-B"])[i]!;
      return run(scenario({
        onset: 14,
        label: (after, i) => {
          const p = projects(after, i);
          const v = p === "p-A" ? 1 : 5;
          return { project: p, toolErrors: v, toolErrorsEdit: v, blindEdits: v };
        },
      }));
    },
  },
  { name: "row05-unknown_provenance", row: 5, make: () => run(scenario({ ...SHIFT, label: (after) => ({ effort: after ? "medium" : "high" }) })) },
  {
    name: "row06-both_sides", row: 6, make: () => {
      const xs = scenario({ ...SHIFT, label: (after) => (after ? { effort: "medium", servedModel: "m-x", steps: 6 } : { effort: "high" }) });
      const effort = recorded({ id: "e-effort", kind: "effort", side: "you", from: "high", to: "medium", day: ONSET_DAY });
      return run(xs, [effort], { decide: { tripwires: { servedModel: true } } });
    },
  },
  {
    name: "row07-you", row: 7, make: () => {
      const xs = scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) });
      return run(xs, [recorded({ id: "e-model", kind: "model", side: "you", from: "m1", to: "m2", day: ONSET_DAY })]);
    },
  },
  {
    name: "row08-agent", row: 8, make: () => run(scenario({ ...SHIFT, label: (after) => (after ? { servedModel: "m-x", steps: 6 } : {}) }), [], { decide: { tripwires: { servedModel: true } } }),
  },
  { name: "row09-by_elimination", row: 9, make: () => run(scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) }), [], { fullyObservedDays: daysBack(70) }) },
  {
    name: "row10-nothing_recorded_on_your_side", row: 10,
    make: () => run(scenario({ ...SHIFT, project: () => "p-A", label: (after) => ({ version: after ? "1.1" : "1.0" }) }), [], { fullyObservedDays: daysBack(70) }),
  },
  { name: "row11-blind_spot", row: 11, make: () => run(scenario({ ...SHIFT, label: (after) => ({ version: after ? "1.1" : "1.0" }) })) },
  {
    name: "row11-codex-partial_by_design", row: 11,
    make: () => run(scenario({ ...SHIFT, label: (after) => ({ agent: "codex", version: after ? "0.161" : "0.160" }) }), [], { agent: "codex", fullyObservedDays: daysBack(70) }),
  },
  { name: "row12-single_indicator", row: 12, make: () => run(scenario({ onset: ONSET, errors: [2, 6] })) },
  { name: "row13-none", row: 13, make: () => run(scenario({})) },
  { name: "row14-fragile", row: 14, make: () => run(fragile()) },
  {
    // A you-shaped evaluation held at the previous `none` (persistence, METHOD.md §12): pending, the held state's words.
    name: "pending-none-held", row: 13, make: () => {
      const prev = run(scenario({}));
      const xs = scenario({ ...SHIFT, label: (after) => ({ model: after ? "m2" : "m1", servedModel: after ? "m2" : "m1" }) });
      return run(xs, [recorded({ id: "e-model", kind: "model", side: "you", from: "m1", to: "m2", day: ONSET_DAY })], { previous: prev.decision });
    },
  },
];

type Golden = Pick<AgentWords, "label" | "headline" | "because" | "tryThis" | "confidence" | "band" | "statusLine" | "disclaimer" | "observationNote" | "title" | "pendingLine" | "progressLine" | "stripLine" | "timelineLine"> & {
  trace: AgentWords["trace"];
  candidateLines: string[];
  body: Record<Lead, string[]>;
};

function goldenOf(w: AgentWords): Golden {
  return {
    label: w.label, headline: w.headline, because: w.because, tryThis: w.tryThis, confidence: w.confidence, band: w.band,
    statusLine: w.statusLine, disclaimer: w.disclaimer, observationNote: w.observationNote, title: w.title,
    pendingLine: w.pendingLine, progressLine: w.progressLine, stripLine: w.stripLine, timelineLine: w.timelineLine,
    trace: w.trace, candidateLines: w.candidateLines.map((c) => c.text), body: w.body,
  };
}

const GOLDEN_FILE = `${ROOT}engine/test/words/copy-goldens.json`;
const UPDATE = process.env.WASITME_UPDATE_COPY === "1";
const committed: Record<string, Golden> = existsSync(GOLDEN_FILE) ? JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) : {};
const produced: Record<string, Golden> = {};
const attributions = new Map<string, Attribution>();
const attributionOf = (name: string) => {
  let a = attributions.get(name);
  if (!a) attributions.set(name, (a = CASES.find((c) => c.name === name)!.make()));
  return a;
};

for (const c of CASES) {
  for (const lead of LEADS) {
    test(`copy golden ${c.name} × ${lead}`, () => {
      const a = attributionOf(c.name);
      assert.equal(a.decision.row, c.row, `${c.name} reaches row ${c.row}`);
      if (c.name.startsWith("pending")) assert.deepEqual([a.decision.pending, a.decision.raw.row], [true, 7]);
      const w = explain(a);
      const out = buildOutputs({ engine: "0.1.0", generatedAt: GENERATED_AT, scanOk: true, lead, agents: [{ attribution: a }] });
      assertValidOutputs(out, `${c.name}/${lead}`);
      assert.equal(out.glance.lead, lead);
      // The trace ends at the row that yields the state (CONTRACT), and the words never depend on the lead.
      const want = decisionRow(a.decision.state, a.decision.reason);
      assert.ok(want === c.row || (want === 2 && c.row === 14));
      assert.equal(out.snapshot.agents[0]!.trace.at(-1)!.row, c.row);
      assert.deepEqual(goldenOf(out.words[0]!), goldenOf(w));
      produced[c.name] = goldenOf(w);
      if (UPDATE) return;
      const g = committed[c.name];
      assert.ok(g !== undefined, `no committed copy golden for ${c.name} (run with WASITME_UPDATE_COPY=1)`);
      const { body, ...shared } = goldenOf(w);
      const { body: gBody, ...gShared } = g;
      assert.deepEqual(shared, gShared, `${c.name}: shared strings`);
      assert.deepEqual(body[lead], gBody[lead], `${c.name}: ${lead}-led body`);
    });
  }
}

test("copy goldens: the committed file lists exactly these cases (written when WASITME_UPDATE_COPY=1)", () => {
  for (const c of CASES) if (!produced[c.name]) produced[c.name] = goldenOf(explain(attributionOf(c.name)));
  if (UPDATE) {
    writeFileSync(GOLDEN_FILE, `${JSON.stringify(produced, null, 2)}\n`);
    return;
  }
  assert.deepEqual(Object.keys(committed).sort(), CASES.map((c) => c.name).sort());
});

test("hero roles: title = state, deck = the finding, note = the evidence; none repeats another (every row)", () => {
  for (const c of CASES) {
    const w = explain(attributionOf(c.name));
    // The state words live in the title only.
    const state = w.title.replace(/\.$/, "").replace(/, for now$/, "").toLowerCase();
    assert.ok(!w.headline.toLowerCase().includes(state), `${c.name}: the deck repeats the title: ${w.headline}`);
    assert.ok(!w.because.toLowerCase().includes(state), `${c.name}: the note repeats the title: ${w.because}`);
    // The note never restates the deck, not even its lead clause.
    const lead = w.headline.split(/[,;:]/)[0]!.replace(/\.$/, "").trim();
    assert.notEqual(w.because, w.headline, c.name);
    assert.ok(!w.because.includes(lead), `${c.name}: the note restates the deck's "${lead}": ${w.because}`);
  }
});

test("D53(e): only family-wise significant metrics are marked for non-neutral ink", () => {
  const single = explain(attributionOf("row12-single_indicator"));
  const s = single.facts.single!.metric;
  assert.deepEqual(single.metrics.filter((m) => m.familywise).map((m) => m.id), [s]);
  assert.deepEqual(single.metrics.filter((m) => m.familywise).map((m) => m.id), attributionOf("row12-single_indicator").confounders.singleIndicator.familywiseSignificant);
  assert.deepEqual(explain(attributionOf("row13-none")).metrics.filter((m) => m.familywise), []);
});

test("every decision-table row has a copy golden in both lead variants", () => {
  const rows = new Set(CASES.map((c) => c.row));
  for (let r = 1; r <= 14; r++) assert.ok(rows.has(r), `row ${r}`);
});
