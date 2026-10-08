// The frozen contract (docs/CONTRACT.md): schemas, shared goldens, display rules, semantic rules and copy lint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process"; // wasitme:allow-child_process -- test only: runs the repo's own fixture generator with a fixed argv
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CHANGE_SIDES, GLANCE_MAX_BYTES, GLANCE_SCHEMA_ID, REASONS_BY_STATE, SNAPSHOT_MAX_BYTES, SNAPSHOT_SCHEMA_ID,
  VERDICT_REASONS, VERDICT_STATES, assertSupportedSchema, checkGlance, checkSnapshot, decodeDocument, decodeReason,
  decodeScanError, decodeSide, decodeState, isStale, lintCopy, validate,
} from "../../src/contract/index.js";
import type { Glance, JsonSchema, Snapshot } from "../../src/contract/index.js";
import type { ChangeSide } from "../../src/types.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CONTRACT = `${ROOT}contract/`;
const FIXTURES = `${CONTRACT}fixtures/`;

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const glanceSchema = readJson(`${CONTRACT}glance.v1.schema.json`) as JsonSchema & Record<string, any>;
const snapshotSchema = readJson(`${CONTRACT}snapshot.v1.schema.json`) as JsonSchema & Record<string, any>;

interface ExpectAgent { agent: string; state: string; reason: string | null; pending: boolean; calibrated: boolean; display: string }
interface Entry {
  file: string;
  contract: "glance" | "snapshot";
  valid: boolean;
  now: string;
  covers: string[];
  expect: { display: string; scanFailed: boolean; lead: string; demo: boolean; agents: ExpectAgent[]; firstEventSide?: string };
}
const manifest = readJson(`${FIXTURES}manifest.json`) as { defaultStaleAfterSec: number; futureToleranceSec: number; fixtures: Entry[] };
const schemaFor = (e: Entry) => (e.contract === "glance" ? glanceSchema : snapshotSchema);
const idFor = (e: Entry) => (e.contract === "glance" ? GLANCE_SCHEMA_ID : SNAPSHOT_SCHEMA_ID);
const load = (e: Entry) => readJson(FIXTURES + e.file);

// ---- the schemas themselves ----------------------------------------------------------------------------------

test("both schemas use only keywords the validator implements (so no rule is silently skipped)", () => {
  assertSupportedSchema(glanceSchema);
  assertSupportedSchema(snapshotSchema);
  assert.throws(() => assertSupportedSchema({ type: "object", patternProperties: {} }), /unsupported keyword "patternProperties"/);
  assert.throws(() => assertSupportedSchema({ $ref: "#/$defs/missing" }), /unresolvable \$ref/);
  assert.throws(() => assertSupportedSchema({ type: "string", format: "email" }), /unsupported format/);
});

test("the schemas carry the D22 vocabulary exactly, and the engine's lists match them", () => {
  for (const s of [glanceSchema, snapshotSchema]) {
    assert.deepEqual([...s.$defs.state.enum].sort(), [...VERDICT_STATES].sort());
    assert.deepEqual(s.$defs.reason.enum.filter((r: unknown) => r !== null).sort(), [...VERDICT_REASONS].sort());
    assert.ok(s.$defs.reason.enum.includes(null), "reason is nullable");
    assert.deepEqual([...s.$defs.side.enum].sort(), [...CHANGE_SIDES].sort());
    assert.ok(!s.$defs.state.enum.includes("stale"), "stale is a display state, never written");
    for (const old of ["your_side", "no_change", "unclear"]) {
      if (old !== "unclear") assert.ok(!s.$defs.state.enum.includes(old), `no pre-D22 state ${old}`);
      assert.ok(!s.$defs.side.enum.includes(old), `no pre-freeze side ${old}`);
    }
  }
  const allowed = new Set(Object.values(REASONS_BY_STATE).flat().filter((r) => r !== null));
  assert.deepEqual([...allowed].sort(), [...VERDICT_REASONS].sort(), "every reason belongs to some state");
});

test("the snapshot is the glance plus: shared fields have identical sub-schemas", () => {
  const g = glanceSchema, s = snapshotSchema;
  for (const [name, sub] of Object.entries(g.properties)) {
    if (name !== "schema") assert.deepEqual(s.properties[name], sub, `top-level ${name}`);
  }
  for (const [name, sub] of Object.entries(g.$defs)) {
    if (name === "agent") continue;
    assert.deepEqual(s.$defs[name], sub, `$defs.${name}`);
  }
  for (const [name, sub] of Object.entries(g.$defs.agent.properties)) assert.deepEqual(s.$defs.agent.properties[name], sub, `agent.${name}`);
  for (const name of g.$defs.agent.required) assert.ok(s.$defs.agent.required.includes(name), `agent requires ${name}`);
  for (const name of g.required) assert.ok(s.required.includes(name), `requires ${name}`);
});

test("one glance path: the schema names ~/.wasitme/glance.json and no out/ subfolder", () => {
  assert.match(glanceSchema.description, /~\/\.wasitme\/glance\.json/);
  assert.match(snapshotSchema.description, /~\/\.wasitme\/snapshot\.json/);
  assert.doesNotMatch(JSON.stringify(glanceSchema) + JSON.stringify(snapshotSchema), /\/out\//);
});

// ---- the goldens -----------------------------------------------------------------------------------------------

test("the committed goldens are exactly what generate.mjs writes", () => {
  execFileSync(process.execPath, [`${FIXTURES}generate.mjs`, "--check"], { stdio: "pipe" });
});

test("the Claude Code plugin embeds the current goldens (no private copies drift)", () => {
  execFileSync(process.execPath, [`${ROOT}plugin/tests/fixtures/sync.mjs`, "--check"], { stdio: "pipe" });
});

test("every golden validates against its schema; every tamper fixture does not", () => {
  assert.ok(manifest.fixtures.length >= 30);
  for (const e of manifest.fixtures) {
    const errors = validate(schemaFor(e), load(e));
    if (e.valid) assert.deepEqual(errors, [], `${e.file}:\n${errors.map((x) => `  ${x.path}: ${x.message}`).join("\n")}`);
    else assert.ok(errors.length > 0, `${e.file} is a tamper case but validates`);
  }
});

test("every golden obeys the semantic rules and the copy lint", () => {
  for (const e of manifest.fixtures.filter((x) => x.valid)) {
    const doc = load(e);
    const copy = !e.covers.includes("hostile");
    const problems = e.contract === "glance" ? checkGlance(doc as Glance, { copy }) : checkSnapshot(doc as Snapshot, { copy });
    assert.deepEqual(problems, [], e.file);
  }
});

test("the goldens cover every state × lead, every reason, stale, pending, calibration_pending, mismatch, empty, demo, hostile", () => {
  const covers = new Set(manifest.fixtures.flatMap((e) => e.covers));
  const fileFor = (state: string, lead: string) => manifest.fixtures.find((e) => e.file === `glance/${state}-${lead}.json`);
  for (const state of VERDICT_STATES) for (const lead of ["timeline", "verdict"]) assert.ok(fileFor(state, lead), `glance/${state}-${lead}.json`);
  for (const reason of VERDICT_REASONS) assert.ok(covers.has(`reason:${reason}`), `reason ${reason}`);
  for (const c of ["stale", "pending", "calibration_pending", "mismatch", "empty", "demo", "hostile", "unknown-state", "refused", "clock-backward", "scan-failed"]) {
    assert.ok(covers.has(c), c);
  }
});

test("glance goldens are at most 16 KB and snapshots at most 512 KB, as the engine writes them (compact)", () => {
  for (const e of manifest.fixtures) {
    const bytes = Buffer.byteLength(JSON.stringify(load(e)), "utf8");
    assert.ok(bytes <= (e.contract === "glance" ? GLANCE_MAX_BYTES : SNAPSHOT_MAX_BYTES), `${e.file}: ${bytes} bytes`);
  }
});

test("a worst-case two-agent glance (every string at its limit, full strip, 3 metrics, 5 events) fits 16 KB", () => {
  const doc = load(manifest.fixtures.find((e) => e.file === "glance/calibration_pending.json")!) as Glance;
  const max = (n: number) => "W".repeat(n);
  const worst = doc.agents.map((a) => ({
    ...a,
    agent: max(32), label: max(24), headline: max(80), because: max(200), tryThis: max(160), confidence: max(160), band: max(100), statusLine: max(80),
    topMetrics: [0, 1, 2].map((i) => ({ id: `m${i}${max(30)}`, label: max(40), unit: max(24), family: "research" as const, role: "vote" as const, recent: { k: 999_999, n: 9_999_999 }, baseline: { k: 999_999, n: 9_999_999 }, ratio: 1.23456789, range: [0.123456789, 12.3456789] as [number, number], mde: 2.3456789, status: "worse" as const })),
    strip: { metric: max(32), days: Array.from({ length: 42 }, (_, i) => ({ d: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`, k: 99_999, n: 999_999 })), window: { ratio: 1.23456789, lo: 0.123456789, hi: 12.3456789, mde: 2.3456789 } },
    events: [0, 1, 2, 3, 4].map(() => ({ day: "2026-09-30", kind: max(24), side: "unknown" as const, strength: "routine" as const, label: max(60), new: true })),
    progress: { tier: 3 as const, etaDate: "2026-12-31", notAtCurrentPace: false, unlock: [0, 1, 2, 3, 4, 5].map(() => ({ metric: max(32), family: "research" as const, have: { events: 999, sessions: 999, sessionDays: 999 }, need: { events: 999, sessions: 999, sessionDays: 999 } })) },
  }));
  const bytes = Buffer.byteLength(JSON.stringify({ ...doc, agents: worst }), "utf8");
  assert.ok(bytes <= GLANCE_MAX_BYTES, `${bytes} bytes`);
});

// ---- decoding and display rules ------------------------------------------------------------------------------

test("every manifest entry decodes to exactly the display the manifest promises", () => {
  for (const e of manifest.fixtures) {
    const d = decodeDocument(load(e), idFor(e), Date.parse(e.now));
    assert.equal(d.display, e.expect.display, `${e.file}: display`);
    assert.equal(d.scanFailed, e.expect.scanFailed, `${e.file}: scanFailed`);
    assert.equal(d.lead, e.expect.lead, `${e.file}: lead`);
    assert.equal(d.demo, e.expect.demo, `${e.file}: demo`);
    assert.deepEqual(d.agents.map(({ eventSides: _, ...a }) => a), e.expect.agents, `${e.file}: agents`);
    if (e.expect.firstEventSide !== undefined) assert.equal(d.agents[0]?.eventSides[0], e.expect.firstEventSide, `${e.file}: first event side`);
  }
});

test("an unknown state decodes as unclear; unknown reason → null; unknown side → unknown (never agent)", () => {
  assert.equal(decodeState("exploded"), "unclear");
  assert.equal(decodeState(undefined), "unclear");
  assert.equal(decodeState(42), "unclear");
  assert.equal(decodeState("your_side"), "unclear", "pre-D22 names are not silently mapped");
  assert.equal(decodeState("no_change"), "unclear");
  for (const s of VERDICT_STATES) assert.equal(decodeState(s), s);
  assert.equal(decodeReason("aliens"), null);
  assert.equal(decodeReason("needs_data"), "needs_data");
  assert.equal(decodeSide("sideways"), "unknown");
  assert.equal(decodeSide("unclear"), "unknown", "the pre-freeze side name decodes as unknown, never agent");
  for (const s of CHANGE_SIDES) assert.equal(decodeSide(s), s);
  assert.equal(decodeScanError("kaboom"), "internal");
  assert.equal(decodeScanError(null), null);
});

test("stale: older than staleAfterSec, future-dated beyond 5 minutes, or no parseable timestamp", () => {
  const at = Date.parse("2026-10-04T18:00:00Z");
  assert.equal(isStale("2026-10-04T18:00:00Z", 7200, at + 7200_000), false, "exactly at the limit is still fresh");
  assert.equal(isStale("2026-10-04T18:00:00Z", 7200, at + 7201_000), true);
  assert.equal(isStale("2026-10-04T18:00:00Z", undefined, at + 7201_000), true, "default 7200 s when absent");
  assert.equal(isStale("2026-10-04T18:00:00Z", 60, at + 61_000), true, "the file's own staleAfterSec wins");
  assert.equal(isStale("2026-10-04T18:00:00Z", 7200, at - 299_000), false, "a little clock skew is tolerated");
  assert.equal(isStale("2026-10-04T18:00:00Z", 7200, at - 301_000), true, "a clock that went backward is not trusted as fresh");
  assert.equal(isStale("2026-10-04T18:00:00", 7200, at), true, "no offset: never guessed as local time");
  assert.equal(isStale("2026-02-30T18:00:00Z", 7200, at), true, "impossible date");
  assert.equal(isStale(undefined, 7200, at), true);
  assert.equal(isStale("2026-10-04T20:00:00+02:00", 7200, at), false, "offsets are honoured");
});

test("the validator catches the mistakes it exists for", () => {
  const good = load(manifest.fixtures.find((e) => e.file === "glance/you-verdict.json")!) as any;
  const bad = (mutate: (g: any) => void) => { const g = structuredClone(good); mutate(g); return validate(glanceSchema, g).map((x) => `${x.path}: ${x.message}`).join("\n"); };
  assert.match(bad((g) => { g.agents[0].state = "your_side"; }), /agents\[0\]\.state/);
  assert.match(bad((g) => { g.agents[0].headline = "x".repeat(81); }), /longer than 80/);
  assert.match(bad((g) => { g.agents[0].headline = "\u{1F600}".repeat(80); }), /^$/, "lengths are code points, not UTF-16 units");
  assert.match(bad((g) => { g.agents[0].typo = 1; }), /unexpected property/);
  assert.match(bad((g) => { delete g.agents[0].reason; }), /missing "reason"/);
  assert.match(bad((g) => { g.agents[0].events[0].side = "unclear"; }), /side/);
  assert.match(bad((g) => { g.agents[0].topMetrics[0].range = [1, 2, 3]; }), /more than 2 items/);
  assert.match(bad((g) => { g.agents[0].topMetrics[0].recent.k = 1.5; }), /expected integer/);
  assert.match(bad((g) => { g.generatedAt = "2026-10-04 18:00"; }), /date-time/);
  assert.match(bad((g) => { g.agents[0].strip.days[0].d = "2026-02-30"; }), /not a date/);
  assert.match(bad((g) => { g.privacy.containsText = true; }), /privacy\.containsText/);
  assert.match(bad((g) => { g.agents = Array(9).fill(g.agents[0]); }), /more than 8 items/);
  const snap = load(manifest.fixtures.find((e) => e.file === "snapshot/you-and-codex.json")!) as any;
  snap.health.sources[0].unknownTypes = { "<script>": 1, ["x".repeat(61)]: 2 };
  const errs = validate(snapshotSchema, snap).map((x) => x.path);
  assert.equal(errs.filter((p) => p.includes("(name)")).length, 2, "log-derived unknownTypes keys are bounded");
});

test("copy lint: the banned phrases are caught; the fixed disclaimer is the one place 'quality' may appear", () => {
  assert.deepEqual(lintCopy("No detectable change: changes bigger than about ×1.9 would have shown."), []);
  assert.deepEqual(lintCopy("These indicators don't measure answer quality. Evidence, not proof."), []);
  assert.ok(lintCopy("Model quality dropped").length > 0);
  assert.ok(lintCopy("Nothing changed on your side").length > 0);
  assert.ok(lintCopy("It looks like the agent was nerfed").length >= 2);
  assert.ok(lintCopy("After the update tool errors doubled").length > 0);
  assert.ok(lintCopy("no change").length > 0);
  assert.ok(lintCopy("99% interval").length > 0);
  assert.ok(lintCopy("This proves it was caused by the update").length >= 2);
});

test("ChangeSide in types.ts is the contract's side vocabulary", () => {
  const sides: ChangeSide[] = ["you", "agent", "unknown", "meta"];
  assert.deepEqual([...sides].sort(), [...CHANGE_SIDES].sort());
});
