/**
 * The scan's reading of the dated calibration artifact (store/calflags.ts), the persisted-decision file
 * (store/decisions.ts) and the fully-observed-day rule. Synthetic documents only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calibrationOf, contractCalibration, readCalibration, SHIPPED_CALIBRATION } from "../../src/store/calflags.js";
import type { Decision } from "../../src/analysis/attribution/types.js";
import type { EtaRecord } from "../../src/analysis/gates/eta.js";
import {
  DECISIONS_SCHEMA, loadDecisions, loadProgressHistory, persistenceDue, PROGRESS_SCHEMA, saveDecisions, serializeDecisions,
} from "../../src/store/decisions.js";
import { fullyObservedDays } from "../../src/store/scan.js";
import { readLead } from "../../src/store/settings.js";
import type { Exchange } from "../../src/types.js";
import { readJson, REPO, TEST_CALIBRATION, TEST_UNCALIBRATED, tempEnv } from "./helpers.js";

test("drift guard: the shipped calibration is exactly what the newest committed artifact says", () => {
  const dir = join(REPO, "docs", "calibration");
  const newest = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().at(-1)!;
  const doc = readJson(join(dir, newest));
  for (const vote of ["toolErrorsNonCmd", "toolErrors"] as const) {
    assert.deepEqual(readCalibration(SHIPPED_CALIBRATION, vote), readCalibration(doc, vote), `${newest} under ${vote}`);
  }
  // A chosen estimator must be one the engine can run, or every agent would silently stay uncalibrated.
  const chosen = doc.selection?.chosen ?? null;
  if (chosen !== null && doc.status === "complete") assert.equal(readCalibration(doc, "toolErrorsNonCmd").methodId, chosen);
});

test("the shipped artifact calibrates both agents under toolErrorsNonCmd: 1,000 null sequences per profile, 0 false changed, 0 false agent (D58, D64)", () => {
  const s = readCalibration(SHIPPED_CALIBRATION, "toolErrorsNonCmd");
  assert.equal(s.artifactDate, "2026-10-05");
  assert.equal(s.methodId, "session-t95-cr2");
  assert.equal(s.method?.id, "session-t95-cr2");
  // Claude Code: six profiles x 1,000 sequences; Codex: one profile x 1,000. No false "changed" and no false "agent" anywhere.
  assert.deepEqual(calibrationOf(s, "claude-code"), { calibrated: true, sequences: 6000, falseChanged: 0, falseAgent: 0 });
  assert.deepEqual(calibrationOf(s, "codex"), { calibrated: true, sequences: 1000, falseChanged: 0, falseAgent: 0 });
  const rows = ((SHIPPED_CALIBRATION as { gNullSeq: Array<Record<string, any>> }).gNullSeq);
  assert.equal(rows.length, 7, "six Claude Code profiles and one Codex profile");
  for (const r of rows) {
    assert.equal(r.candidate, "session-t95-cr2");
    assert.equal(r.errorsVote, "toolErrorsNonCmd");
    assert.equal(r.sequences, 1000, `${r.profile}: 1,000 null sequences`);
    assert.deepEqual([r.falseChanged.k, r.falseAgent.k], [0, 0], `${r.profile}: no false changed, no false agent`);
  }
  // An agent the artifact does not name is still uncalibrated (it has no record of passing).
  assert.deepEqual(calibrationOf(s, "someone-else"), { calibrated: false, sequences: 0, falseChanged: null, falseAgent: null });
  assert.deepEqual(contractCalibration(s, ["claude-code", "codex"]), {
    artifactDate: "2026-10-05", methodId: "session-t95-cr2",
    agents: [
      { agent: "claude-code", calibrated: true, sequences: 6000, falseChanged: 0, falseAgent: 0 },
      { agent: "codex", calibrated: true, sequences: 1000, falseChanged: 0, falseAgent: 0 },
    ],
  });
});

test("an artifact that passed no agent (the reduced 2026-10-04 run, D58) leaves every agent uncalibrated: row 1, dated, no method", () => {
  const s = readCalibration(TEST_UNCALIBRATED, "toolErrorsNonCmd");
  assert.equal(s.artifactDate, "2026-10-04", "a dated record exists even though nothing passed");
  assert.equal(s.methodId, null);
  assert.equal(s.method, null);
  for (const agent of ["claude-code", "codex", "someone-else"]) assert.deepEqual(calibrationOf(s, agent), { calibrated: false, sequences: 0, falseChanged: null, falseAgent: null });
  assert.deepEqual(contractCalibration(s, ["claude-code"]), {
    artifactDate: "2026-10-04", methodId: null, agents: [{ agent: "claude-code", calibrated: false, sequences: 0, falseChanged: null, falseAgent: null }],
  });
  // No artifact at all reads the same way, minus the date.
  assert.deepEqual(contractCalibration(readCalibration(undefined, "toolErrorsNonCmd"), ["claude-code"]), {
    artifactDate: null, methodId: null, agents: [{ agent: "claude-code", calibrated: false, sequences: 0, falseChanged: null, falseAgent: null }],
  });
});

test("an agent is calibrated only when the artifact passed it under the voting construct in force, with an estimator the engine runs", () => {
  const ok = readCalibration(TEST_CALIBRATION, "toolErrorsNonCmd");
  assert.equal(ok.methodId, "session-t95-cr2");
  assert.equal(ok.method?.level, 0.95);
  assert.equal(calibrationOf(ok, "claude-code").calibrated, true);
  assert.deepEqual(contractCalibration(ok, ["codex"]), {
    artifactDate: "2026-10-01", methodId: "session-t95-cr2", agents: [{ agent: "codex", calibrated: true, sequences: 1000, falseChanged: 0.04, falseAgent: null }],
  });
  // Another construct (G0 changing the vote) un-calibrates until an artifact passes under it.
  assert.equal(calibrationOf(readCalibration(TEST_CALIBRATION, "toolErrors"), "claude-code").calibrated, false);
  // Unknown estimator, a run still in progress, a foreign or malformed document: nobody is calibrated.
  const cases: unknown[] = [
    { ...TEST_CALIBRATION, selection: { chosen: "wcb-something-new" } },
    { ...TEST_CALIBRATION, status: "pilot" },
    { ...TEST_CALIBRATION, kind: "something-else" },
    { ...TEST_CALIBRATION, formatVersion: 2 },
    { ...TEST_CALIBRATION, date: "yesterday" },
    { ...TEST_CALIBRATION, calibrated: { "claude-code": { calibrated: "yes", byConstruct: { toolErrorsNonCmd: true } } } },
    null, "calibrated", [TEST_CALIBRATION],
  ];
  for (const c of cases) assert.equal(calibrationOf(readCalibration(c, "toolErrorsNonCmd"), "claude-code").calibrated, false, JSON.stringify(c)?.slice(0, 80));
  // A document that is not an artifact at all has no date either.
  assert.equal(readCalibration({ hello: 1 }, "toolErrorsNonCmd").artifactDate, null);
});

test("decisions file: wrong key, foreign schema, malformed or hostile content → no previous decision", () => {
  const env = tempEnv("decisions");
  try {
    const path = join(env.root, "decisions.json");
    const key = { errorsVote: "toolErrorsNonCmd", methodId: "session-t95-cr2", version: 1 };
    const fp = { now: "2026-08-15T23:59:00.000Z", today: "2026-08-16", recent: { from: "2026-08-02", to: "2026-08-15" }, den: { toolErrorsNonCmd: 100 } };
    const good = {
      state: "none", reason: null, row: 13, trace: [{ row: 13, matched: true, conditions: [{ id: "not_changed", holds: true }] }], onset: null, candidates: [],
      blindSpot: false, observation: { scope: "none", fullyObservedDays: 0, partiallyObservedDays: 0, partialByDesign: false }, singleIndicator: null,
      pending: false, persistence: { fingerprint: fp, candidate: null },
    };
    const write = (doc: unknown) => writeFileSync(path, typeof doc === "string" ? doc : JSON.stringify(doc), { mode: 0o600 });
    write({ schema: DECISIONS_SCHEMA, ...key, agents: { "claude-code": good } });
    const loaded = loadDecisions(path, key);
    assert.equal(loaded.get("claude-code")?.state, "none");
    assert.deepEqual(loaded.get("claude-code")?.raw.state, "none");
    assert.equal(loadDecisions(path, { ...key, errorsVote: "toolErrors" }).size, 0);
    assert.equal(loadDecisions(path, { ...key, methodId: null }).size, 0);
    assert.equal(loadDecisions(path, { ...key, version: 2 }).size, 0);
    const bad: unknown[] = [
      "{ not json",
      { schema: "wasitme.decisions/2", ...key, agents: { "claude-code": good } },
      { schema: DECISIONS_SCHEMA, ...key, agents: { "claude-code": { ...good, state: "maybe" } } },
      { schema: DECISIONS_SCHEMA, ...key, agents: { "claude-code": { ...good, reason: "mixed" } } },
      { schema: DECISIONS_SCHEMA, ...key, agents: { "claude-code": { ...good, row: 15 } } },
      { schema: DECISIONS_SCHEMA, ...key, agents: { "claude-code": { ...good, candidates: [{ event: "<script>alert(1)</script>", class: "x", status: "open" }] } } },
      { schema: DECISIONS_SCHEMA, ...key, agents: { "claude-code": { ...good, trace: [{ row: 13, matched: true, conditions: [{ id: "x", holds: true, detail: { note: "my secret prompt text" } }] }] } } },
      { schema: DECISIONS_SCHEMA, ...key, agents: { "Claude Code!": good } },
      { schema: DECISIONS_SCHEMA, ...key, agents: { "claude-code": { ...good, persistence: { fingerprint: fp, candidate: { state: "you", reason: null, row: 7, since: { now: "soon" } } } } } },
    ];
    for (const doc of bad) {
      write(doc);
      assert.equal(loadDecisions(path, key).size, 0, JSON.stringify(doc).slice(0, 120));
    }
  } finally {
    env.cleanup();
  }
});

test("progress history (D64) round-trips beside the decisions; a bad section drops only the history", () => {
  const env = tempEnv("progress-history");
  try {
    const path = join(env.root, "decisions.json");
    const key = { errorsVote: "toolErrorsNonCmd", methodId: "session-t95-cr2", version: 1 };
    const r = (day: string, over: Record<string, unknown> = {}) => ({ day, ready: false, tier: 2, eta: "2026-11-07", notAtPace: false, ...over }) as EtaRecord;
    const history = new Map<string, EtaRecord[]>([
      ["claude-code", [r("2026-10-01"), r("2026-10-02", { ready: true }), r("2026-10-03"), r("2026-10-04", { tier: null, eta: null, notAtPace: true })]],
      ["codex", [r("2026-10-03", { tier: null, eta: null })]],
    ]);
    saveDecisions(path, key, new Map(), history);
    const doc = readJson(path);
    assert.equal(doc.progress.schema, PROGRESS_SCHEMA);
    // At most 3 records per agent; only days, booleans and a tier — no ids.
    assert.deepEqual(doc.progress.agents["claude-code"].map((x: { day: string }) => x.day), ["2026-10-02", "2026-10-03", "2026-10-04"]);
    assert.deepEqual(loadProgressHistory(path, key), new Map([["claude-code", history.get("claude-code")!.slice(1)], ["codex", history.get("codex")!]]));
    assert.equal(loadProgressHistory(path, { ...key, methodId: null }).size, 0, "another key: fresh history");
    assert.equal(loadDecisions(path, key).size, 0);
    // Same input, same bytes (an idempotent scan rewrites nothing).
    assert.equal(serializeDecisions(key, new Map(), history), serializeDecisions(key, new Map(), history));
    const write = (progress: unknown) => writeFileSync(path, JSON.stringify({ schema: DECISIONS_SCHEMA, ...key, agents: {}, progress }), { mode: 0o600 });
    const bad: [unknown, number][] = [
      [{ schema: "wasitme.progress/2", agents: { "claude-code": [r("2026-10-03")] } }, 0],
      [{ schema: PROGRESS_SCHEMA, agents: { "claude-code": [r("2026-10-03", { eta: "soon" })], codex: [r("2026-10-03")] } }, 1],
      [{ schema: PROGRESS_SCHEMA, agents: { "claude-code": [r("2026-10-03", { tier: 4 })] } }, 0],
      [{ schema: PROGRESS_SCHEMA, agents: { "claude-code": [r("2026-10-03", { tier: null })] } }, 0],
      [{ schema: PROGRESS_SCHEMA, agents: { "claude-code": [r("2026-10-03", { note: "my secret prompt text" })] } }, 0],
      [{ schema: PROGRESS_SCHEMA, agents: { "claude-code": [1, 2, 3, 4].map((i) => r(`2026-10-0${i}`)) } }, 0],
      [{ schema: PROGRESS_SCHEMA, agents: { "Claude Code!": [r("2026-10-03")] } }, 0],
      [{ schema: PROGRESS_SCHEMA, agents: { "claude-code": { day: "2026-10-03" } } }, 0],
      ["wasitme.progress/1", 0],
    ];
    for (const [progress, n] of bad) {
      write(progress);
      assert.equal(loadProgressHistory(path, key).size, n, JSON.stringify(progress).slice(0, 120));
    }
  } finally {
    env.cleanup();
  }
});

test("reuse gate: a pending decision forces a recompute only when its 24-hour wait ended since the last evaluation", () => {
  const H = 3_600_000;
  const t = (h: number) => new Date(Date.parse("2026-08-15T00:00:00.000Z") + h * H);
  const fp = (h: number) => ({ now: t(h).toISOString(), today: "2026-08-15", recent: { from: "2026-08-01", to: "2026-08-14" }, den: {} });
  const dec = (anchorH: number | null, lastH: number) => new Map([["claude-code", {
    persistence: { fingerprint: fp(lastH), candidate: anchorH === null ? null : { state: "you", reason: null, row: 7, since: fp(anchorH) }, rule: "pending" },
  } as unknown as Decision]]);
  assert.equal(persistenceDue(dec(null, 0), t(100)), false, "nothing pending");
  assert.equal(persistenceDue(dec(0, 0), t(23)), false, "still waiting");
  assert.equal(persistenceDue(dec(0, 0), t(24)), true, "the wait ended since the last evaluation");
  assert.equal(persistenceDue(dec(0, 30), t(40)), false, "it had already ended at the last evaluation: the data decides");
  assert.equal(persistenceDue(dec(0, 10), t(5)), true, "the clock went backward");
  assert.equal(persistenceDue(dec(0, 10), new Date(Number.NaN)), true);
});

test("fully observed days: a config snapshot that day and a hook record for every session with exchanges", () => {
  const x = (session: string, day: string) => ({ session, day }) as Exchange;
  const kept = [x("a", "2026-08-01"), x("b", "2026-08-01"), x("a", "2026-08-02"), x("c", "2026-08-04"), x("d", "2026-08-05")];
  const observed = new Map([["2026-08-01", new Set(["a", "b"])], ["2026-08-02", new Set(["b"])], ["2026-08-05", new Set(["d"])]]);
  const configDays = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"];
  // 08-01 all seen; 08-02 session a unseen; 08-03 no sessions; 08-04 c unseen; 08-05 is today; 08-06 is after it.
  assert.deepEqual(fullyObservedDays(kept, configDays, observed, "2026-08-05"), ["2026-08-01", "2026-08-03"]);
  // No config snapshot that day → never fully observed, whatever the hook saw.
  assert.deepEqual(fullyObservedDays(kept, ["2026-08-02"], observed, "2026-08-09"), []);
});

test("lead setting: engine.json `lead` when it is a known variant, otherwise timeline (D28)", () => {
  const env = tempEnv("lead");
  try {
    const p = join(env.root, "engine.json");
    assert.equal(readLead(p), "timeline", "missing file");
    for (const [doc, want] of [[{ lead: "verdict" }, "verdict"], [{ lead: "timeline" }, "timeline"], [{ lead: "VERDICT" }, "timeline"], [{ lead: 1 }, "timeline"], [[], "timeline"]] as const) {
      writeFileSync(p, JSON.stringify(doc), { mode: 0o600 });
      assert.equal(readLead(p), want, JSON.stringify(doc));
    }
    writeFileSync(p, "{ nope", { mode: 0o600 });
    assert.equal(readLead(p), "timeline");
  } finally {
    env.cleanup();
  }
});
