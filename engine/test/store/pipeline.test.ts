/**
 * The real pipeline end to end: synthetic logs in a temp HOME → `runScan` → attribution (WP-21) → words (WP-22) →
 * glance.json / snapshot.json / state/decisions.json, held to the frozen contract (schemas, `checkGlance` /
 * `checkSnapshot` with the copy lint). Synthetic data only; the real ~/.claude, ~/.codex and ~/.wasitme are never read.
 *
 * Corpora: the synth generator's `insufficient-new-user` scenario and the deterministic hand-built corpus of
 * corpus.ts (four CLI sessions a day in two projects, 56 days from 2026-07-01, a ×3 shift in tool errors and blind
 * edits from day 42 = 2026-08-12, evaluated on 2026-08-26). Calibration comes from the test-only artifact; the
 * brand-new-user test also runs the shipped default and an uncalibrated artifact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkGlance, checkSnapshot } from "../../src/contract/check.js";
import { validate } from "../../src/contract/validate.js";
import { sessionStartHook } from "../../src/hook/session-start.js";
import { loadConfigHistory, saveConfigHistory, updateConfigHistory } from "../../src/store/configs.js";
import { DECISIONS_SCHEMA } from "../../src/store/decisions.js";
import { ensureHome, homePaths } from "../../src/store/home.js";
import { loadSalt } from "../../src/store/salt.js";
import { ScanFailure, type ScanOptions, type ScanReport } from "../../src/store/scan.js";
import { corpusOnDisk } from "../../src/synth/testkit.js";
import { makeHash } from "../../src/util.js";
import { addDays, writeCorpus, type CorpusSpec, type WrittenSession } from "./corpus.js";
import { copyCorpus, readJson, REPO, scanIn, TEST_CALIBRATION, TEST_UNCALIBRATED, TESTDATA, tempEnv, treeDigest, type TempEnv } from "./helpers.js";

const glanceSchema = readJson(join(REPO, "contract", "glance.v1.schema.json"));
const snapshotSchema = readJson(join(REPO, "contract", "snapshot.v1.schema.json"));
const CHECK = join(REPO, "scripts", "check-privacy.mjs");

const NOW = new Date("2026-08-26T12:00:00Z");
const ONSET_DAY = "2026-08-12";
const SHIFT: CorpusSpec = { start: "2026-07-01", days: 56, onset: 42, before: { errors: 1, blind: 1 }, after: { errors: 3, blind: 3 } };
const MODEL = { from: "claude-opus-5-5", to: "claude-sonnet-5-5" };
const cal = (o: ScanOptions = {}): ScanOptions => ({ calibration: TEST_CALIBRATION, now: NOW, ...o });
const until = (day: string): Date => new Date(`${day}T23:59:00Z`);

/** Both files on disk validate and pass the contract's semantic checks (with the copy lint). */
function assertContract(env: TempEnv): { g: any; s: any } {
  const g = readJson(join(env.wh, "glance.json"));
  const s = readJson(join(env.wh, "snapshot.json"));
  assert.deepEqual(validate(glanceSchema, g), [], "glance schema");
  assert.deepEqual(validate(snapshotSchema, s), [], "snapshot schema");
  assert.deepEqual(checkGlance(g, { copy: true }), [], "checkGlance");
  assert.deepEqual(checkSnapshot(s, { copy: true }), [], "checkSnapshot");
  return { g, s };
}

const claudeOf = (r: ScanReport) => r.attributions!.find((a) => a.evaluation.agent === "claude-code")!;

test("brand-new user: the shipped calibration gives too early to tell (row 2); an uncalibrated artifact gives timeline only (row 1)", async () => {
  const corpus = corpusOnDisk("insufficient-new-user");
  const env = tempEnv("pipe-new");
  try {
    copyCorpus(env, corpus.dir);
    const now = new Date(Date.parse(corpus.rows.at(-1)!.t) + 12 * 3_600_000);

    // The uncalibrated path, through the test seam: an artifact that passed no agent → row 1, "Timeline only" (D28 default lead).
    const r1 = await scanIn(env, { now, calibration: TEST_UNCALIBRATED });
    assert.equal(r1.wrote, true);
    const a = assertContract(env);
    assert.deepEqual(a.g.agents.map((x: any) => [x.agent, x.state, x.reason, x.calibrated, x.label]), [["claude-code", "insufficient", "calibration_pending", false, "Timeline only"]]);
    assert.equal(a.g.lead, "timeline", "D28 default");
    assert.deepEqual(a.s.calibration, { artifactDate: "2026-10-04", methodId: null, agents: [{ agent: "claude-code", calibrated: false, sequences: 0, falseChanged: null, falseAgent: null }] });
    assert.equal(claudeOf(r1).decision.row, 1);
    assert.ok(a.s.agents[0].timeline.length > 0, "the timeline still shows what changed");

    // The shipped default (2026-10-05 artifact: calibrated, session-t95-cr2): a brand-new user is row 2, "Too early to tell".
    const r2 = await scanIn(env, { now });
    assert.equal(r2.reused, false, "the calibration in force is an input of the analysis");
    const b = assertContract(env);
    assert.deepEqual(b.g.agents.map((x: any) => [x.agent, x.state, x.reason, x.calibrated, x.label]), [["claude-code", "insufficient", "needs_data", true, "Too early to tell"]]);
    assert.equal(b.g.lead, "timeline", "D28 default");
    assert.deepEqual(b.s.calibration, { artifactDate: "2026-10-05", methodId: "session-t95-cr2", agents: [{ agent: "claude-code", calibrated: true, sequences: 6000, falseChanged: 0, falseAgent: 0 }] });
    assert.equal(claudeOf(r2).decision.row, 2);
    assert.ok(b.g.agents[0].progress !== null, "insufficient with progress");
    const d = readJson(join(env.wh, "state", "decisions.json"));
    assert.equal(d.schema, DECISIONS_SCHEMA);
    assert.deepEqual([d.errorsVote, d.methodId, d.version], ["toolErrorsNonCmd", "session-t95-cr2", 1]);
    assert.equal(d.agents["claude-code"].state, "insufficient");
    assert.equal("raw" in d.agents["claude-code"], false);
    assert.equal("rule" in d.agents["claude-code"].persistence, false);
    // D64: today's progress record sits beside the decisions for the next daily evaluation (one per day).
    assert.equal(d.progress.schema, "wasitme.progress/1");
    assert.deepEqual(d.progress.agents["claude-code"].map((x: any) => x.day), [claudeOf(r2).evaluation.today]);
    assert.deepEqual(d.progress.agents["claude-code"][0], claudeOf(r2).evaluation.progress.record);
  } finally {
    env.cleanup();
    corpus.cleanup();
  }
});

test("a /model switch typed before the shift → you (row 7), with the command event as the open candidate", async () => {
  const env = tempEnv("pipe-you");
  try {
    writeCorpus(env.claude, { ...SHIFT, switchModel: MODEL });
    const r = await scanIn(env, cal());
    const { g, s } = assertContract(env);
    const a = s.agents[0];
    assert.deepEqual([g.agents[0].state, g.agents[0].reason, g.agents[0].pending], ["you", null, false]);
    assert.equal(claudeOf(r).decision.row, 7);
    assert.ok(a.onset !== null && a.onset.from <= ONSET_DAY && ONSET_DAY <= a.onset.to, JSON.stringify(a.onset));
    const switchEvent = a.timeline.find((e: any) => e.kind === "model" && e.side === "you");
    assert.ok(switchEvent, "the /model command is on the timeline");
    assert.deepEqual([switchEvent.strength, switchEvent.provenance, switchEvent.day], ["strong", "command", ONSET_DAY]);
    assert.ok(a.candidates.some((c: any) => c.event === switchEvent.id && c.status === "open"));
    assert.ok(a.disclaimer !== null && g.agents[0].band !== "");
    assert.ok(a.metrics.find((m: any) => m.id === "toolErrorsNonCmd").ratio > 2);
  } finally {
    env.cleanup();
  }
});

/** Run the SessionStart hook for every session (at its start time) and record a config snapshot for every day, as a
 *  daily scan would (the store's own collector, so the test does not need 56 scans). `skip` sessions get no hook. */
function observeEverything(env: TempEnv, sessions: readonly WrittenSession[], skip: ReadonlySet<string> = new Set()): void {
  const p = homePaths(env.wh);
  ensureHome(p);
  const salt = loadSalt(p.salt, { create: true });
  for (const s of sessions) {
    if (skip.has(s.id)) continue;
    const cwd = join(env.home, "code", s.project);
    mkdirSync(cwd, { recursive: true });
    assert.equal(sessionStartHook({ home: env.wh, userHome: env.home, cwd, session: s.id, now: new Date(s.start) }).wrote, true);
  }
  const cfg = loadConfigHistory(p.config);
  for (let d = 0; d < SHIFT.days; d++) {
    updateConfigHistory(cfg, {
      hash: makeHash(salt), now: new Date(`${addDays(SHIFT.start, d)}T23:00:00Z`), timeZone: "UTC", home: env.home,
      env: { WASITME_CLAUDE_DIR: env.claude, WASITME_CODEX_DIR: env.codex },
    });
  }
  saveConfigHistory(p.config, cfg);
}

test("a planted agent-side shift at a version update: blind spot unless every day was watched; agent by elimination when it was", async () => {
  const bump = { ...SHIFT, bumpVersion: { from: "2.1.250", to: "2.1.251" } };
  // 1. Nothing watched the user's setup (no hook records, no daily config snapshots): row 11.
  const blind = tempEnv("pipe-agent-blind");
  try {
    writeCorpus(blind.claude, bump);
    const r = await scanIn(blind, cal());
    const { g, s } = assertContract(blind);
    assert.deepEqual([g.agents[0].state, g.agents[0].reason], ["unclear", "blind_spot"]);
    assert.equal(claudeOf(r).decision.row, 11);
    const bumpEvent = s.agents[0].timeline.find((e: any) => e.kind === "version" && e.day === ONSET_DAY);
    assert.ok(bumpEvent && bumpEvent.side === "agent" && bumpEvent.strength === "routine");
    assert.ok(s.agents[0].candidates.some((c: any) => c.event === bumpEvent.id));
  } finally {
    blind.cleanup();
  }
  // 2. The hook saw every session and the scan ran every day: row 9 (version-boundary test passes).
  const seen = tempEnv("pipe-agent-seen");
  try {
    const sessions = writeCorpus(seen.claude, bump);
    observeEverything(seen, sessions);
    const r = await scanIn(seen, cal());
    const { g, s } = assertContract(seen);
    assert.deepEqual([g.agents[0].state, g.agents[0].reason], ["agent", "by_elimination"]);
    assert.equal(claudeOf(r).decision.row, 9);
    assert.ok(s.agents[0].candidates.some((c: any) => c.test === "version_boundary"));
    assert.ok(s.agents[0].observation.fullyObservedDays > 0 && s.agents[0].observation.partiallyObservedDays === 0);
    assert.equal(claudeOf(r).evidence.fullyObservedDays.length, SHIFT.days);
  } finally {
    seen.cleanup();
  }
  // 3. One session on the update day had no hook record: that day is not fully observed → blind spot again.
  const gap = tempEnv("pipe-agent-gap");
  try {
    const sessions = writeCorpus(gap.claude, bump);
    observeEverything(gap, sessions, new Set(sessions.filter((x) => x.day === ONSET_DAY).slice(0, 1).map((x) => x.id)));
    const r = await scanIn(gap, cal());
    assertContract(gap);
    assert.equal(claudeOf(r).decision.state, "unclear");
    assert.ok(!claudeOf(r).evidence.fullyObservedDays.includes(ONSET_DAY));
  } finally {
    gap.cleanup();
  }
});

test("problems → nothing new written: previous results kept, both flagged scanOk:false / internal, decisions and manifest untouched", async () => {
  const env = tempEnv("pipe-problems");
  try {
    writeCorpus(env.claude, { ...SHIFT, days: 20, onset: undefined });
    await scanIn(env, cal());
    const before = {
      glance: readFileSync(join(env.wh, "glance.json"), "utf8"),
      snapshot: readFileSync(join(env.wh, "snapshot.json"), "utf8"),
      decisions: readFileSync(join(env.wh, "state", "decisions.json"), "utf8"),
      inputs: readJson(join(env.wh, "history", "index.json")).inputs,
    };
    // A decision the contract rejects (state `none` with row 2's trace): words build it, the checks refuse it.
    const tamper = (a: { decision: { state: string; reason: string | null } }) => {
      a.decision.state = "none";
      a.decision.reason = null;
    };
    await assert.rejects(scanIn(env, cal({ until: until("2026-07-18"), inspectAttribution: tamper as never })), (e: unknown) => {
      assert.ok(e instanceof ScanFailure);
      assert.equal(e.kind, "internal");
      assert.ok(e.problems.length > 0);
      return true;
    });
    // Both documents keep the last result and carry the failure: the glance for the status line and the app, the
    // snapshot for `wasitme`, `report` and `doctor` (which read only it).
    assert.deepEqual(readJson(join(env.wh, "snapshot.json")), { ...JSON.parse(before.snapshot), scanOk: false, scanError: "internal" }, "snapshot kept, flagged");
    assert.deepEqual(readJson(join(env.wh, "glance.json")), { ...JSON.parse(before.glance), scanOk: false, scanError: "internal" }, "glance kept, flagged");
    assert.equal(readFileSync(join(env.wh, "state", "decisions.json"), "utf8"), before.decisions, "decisions kept");
    assert.equal(readJson(join(env.wh, "history", "index.json")).inputs, before.inputs, "manifest digest kept: the next scan recomputes");
    assert.match(readFileSync(join(env.wh, "logs", "scan.log"), "utf8"), /scan_failed internal\n$/);
    // The next good scan clears the flag.
    await scanIn(env, cal());
    assert.equal(readJson(join(env.wh, "glance.json")).scanOk, true);
    assert.equal(readJson(join(env.wh, "snapshot.json")).scanOk, true);
  } finally {
    env.cleanup();
  }
});

test("persistence across scans: a new outcome is held (pending) until a later scan with new data confirms it", async () => {
  const env = tempEnv("pipe-persist");
  try {
    writeCorpus(env.claude, { ...SHIFT, switchModel: MODEL });
    const r1 = await scanIn(env, cal({ until: until("2026-08-11") }));
    const first = claudeOf(r1).decision;
    assert.equal(first.persistence.rule, "first");
    assert.equal(first.state, "none");
    // Three days after the switch the table already says `you`, but one evaluation is not enough: held.
    const r2 = await scanIn(env, cal({ until: until("2026-08-15") }));
    const held = claudeOf(r2).decision;
    assert.deepEqual([held.raw.state, held.state, held.pending, held.persistence.rule], ["you", "none", true, "pending"]);
    const g2 = assertContract(env).g;
    assert.deepEqual([g2.agents[0].state, g2.agents[0].pending], ["none", true], "the glance holds its state and says so");
    const d2 = readJson(join(env.wh, "state", "decisions.json")).agents["claude-code"];
    assert.equal(d2.persistence.candidate.state, "you");
    // Nothing moved and the 24-hour wait has not ended since that evaluation: the shortcut may re-stamp a held glance.
    const again = await scanIn(env, cal({ until: until("2026-08-15") }));
    assert.equal(again.reused, true);
    assert.deepEqual([readJson(join(env.wh, "glance.json")).agents[0].state, readJson(join(env.wh, "glance.json")).agents[0].pending], ["none", true]);
    // Two days later: under 30% new denominator since the anchor, still held (and never re-stamped while pending).
    const r3 = await scanIn(env, cal({ until: until("2026-08-17") }));
    assert.equal(r3.reused, false);
    assert.deepEqual([claudeOf(r3).decision.state, claudeOf(r3).decision.pending], ["none", true]);
    // Six days after the anchor: ≥ 24 h, ≥ 2 new session-days, ≥ 30% new denominator → confirmed.
    const r4 = await scanIn(env, cal({ until: until("2026-08-21") }));
    assert.deepEqual([claudeOf(r4).decision.state, claudeOf(r4).decision.pending, claudeOf(r4).decision.persistence.rule], ["you", false, "confirmed"]);
    const g4 = assertContract(env).g;
    assert.deepEqual([g4.agents[0].state, g4.agents[0].pending], ["you", false]);
    // D64: the progress records of the last 3 daily evaluations travel with the decisions (the re-stamp wrote none).
    const hist = readJson(join(env.wh, "state", "decisions.json")).progress.agents["claude-code"];
    assert.deepEqual(hist.map((x: any) => x.day), [r2, r3, r4].map((r) => claudeOf(r).evaluation.today));
  } finally {
    env.cleanup();
  }
});

test("persistence resets when the voting construct, the calibrated method or the attribution version changes (D56)", async () => {
  const env = tempEnv("pipe-reset");
  try {
    writeCorpus(env.claude, { ...SHIFT, switchModel: MODEL });
    await scanIn(env, cal({ until: until("2026-08-11") }));
    const held = await scanIn(env, cal({ until: until("2026-08-15") }));
    assert.equal(claudeOf(held).decision.pending, true);
    const path = join(env.wh, "state", "decisions.json");
    const saved = readFileSync(path, "utf8");
    // A file written under another errorsVote (what a G0 ruling changing SCAN_ERRORS_VOTE leaves behind).
    writeFileSync(path, saved.replace('"errorsVote":"toolErrorsNonCmd"', '"errorsVote":"toolErrors"'));
    const r1 = await scanIn(env, cal({ until: until("2026-08-16") }));
    assert.deepEqual([claudeOf(r1).decision.persistence.rule, claudeOf(r1).decision.pending, claudeOf(r1).decision.state], ["first", false, "you"]);
    // Another attribution version.
    writeFileSync(path, saved.replace('"version":1', '"version":0'));
    const r2 = await scanIn(env, cal({ until: until("2026-08-15") }));
    assert.equal(claudeOf(r2).decision.persistence.rule, "first");
    // Another calibrated method (a new artifact choosing another estimator): the file's methodId no longer matches.
    writeFileSync(path, saved);
    const other = { ...TEST_CALIBRATION, selection: { chosen: "d23-literal" }, gNullSeq: [] };
    const r3 = await scanIn(env, cal({ until: until("2026-08-15"), calibration: other }));
    assert.equal(claudeOf(r3).decision.persistence.rule, "first");
    assert.equal(readJson(path).methodId, "d23-literal");
  } finally {
    env.cleanup();
  }
});

test("a held decision naming an event the timeline no longer has (a collapsed version repeat) still scans and keeps the contract", async () => {
  const env = tempEnv("pipe-gone-event");
  try {
    writeCorpus(env.claude, { ...SHIFT, switchModel: MODEL });
    await scanIn(env, cal({ until: until("2026-08-11") }));
    const path = join(env.wh, "state", "decisions.json");
    const doc = readJson(path);
    const held = doc.agents["claude-code"];
    held.candidates = [...(held.candidates ?? []), { event: "e-0123456789ab", kind: "version", side: "agent", class: "agent_routine", status: "background", test: null, day: "2026-08-05", undated: false, tripwire: null }];
    writeFileSync(path, JSON.stringify(doc));
    const r = await scanIn(env, cal({ until: until("2026-08-15") }));
    assert.equal(r.wrote, true);
    assertContract(env);
    const timeline = new Set(readJson(join(env.wh, "snapshot.json")).agents[0].timeline.map((e: { id: string }) => e.id));
    for (const c of readJson(join(env.wh, "snapshot.json")).agents[0].candidates) assert.ok(timeline.has(c.event), `candidate ${c.event} is on the timeline`);
  } finally {
    env.cleanup();
  }
});

test("a persisted decision that makes the outputs fail is dropped once: the scan retries without persistence", async () => {
  const env = tempEnv("pipe-retry");
  try {
    writeCorpus(env.claude, { ...SHIFT, switchModel: MODEL });
    await scanIn(env, cal({ until: until("2026-08-11") }));
    // A held `agent (by_elimination)` with row 13's trace and no boundary candidate: words build it, the checks refuse it.
    const path = join(env.wh, "state", "decisions.json");
    const doc = readJson(path);
    Object.assign(doc.agents["claude-code"], { state: "agent", reason: "by_elimination", row: 9 });
    writeFileSync(path, JSON.stringify(doc));
    const r = await scanIn(env, cal({ until: until("2026-08-15") }));
    assert.equal(r.wrote, true);
    assert.equal(r.persistenceDropped, true);
    assert.deepEqual([claudeOf(r).decision.state, claudeOf(r).decision.persistence.rule], ["you", "first"]);
    assertContract(env);
    assert.equal(readJson(path).agents["claude-code"].state, "you");
  } finally {
    env.cleanup();
  }
});

test("idempotent: a second scan leaves every byte identical; so does a forced recompute (decisions included)", async () => {
  const env = tempEnv("pipe-idem");
  try {
    writeCorpus(env.claude, { ...SHIFT, switchModel: MODEL });
    const first = await scanIn(env, cal());
    assert.equal(first.wrote, true);
    const before = treeDigest(env.wh);
    assert.ok(before.has("state/decisions.json"));
    const second = await scanIn(env, cal());
    assert.equal(second.reused, true);
    assert.equal(second.attributions, undefined, "re-stamped, not recomputed");
    assert.deepEqual(treeDigest(env.wh), before);
    const idx = readJson(join(env.wh, "history", "index.json"));
    idx.inputs = null;
    writeFileSync(join(env.wh, "history", "index.json"), JSON.stringify(idx) + "\n");
    const third = await scanIn(env, cal());
    assert.equal(third.reused, false);
    assert.equal(claudeOf(third).decision.persistence.rule, "same");
    assert.deepEqual(treeDigest(env.wh), before);
  } finally {
    env.cleanup();
  }
});

test("lead variant: engine.json's `lead` (default timeline, D28) is an input of the analysis", async () => {
  const env = tempEnv("pipe-lead");
  try {
    writeCorpus(env.claude, { ...SHIFT, switchModel: MODEL });
    await scanIn(env, cal());
    assert.equal(readJson(join(env.wh, "glance.json")).lead, "timeline");
    const engineJson = join(env.wh, "engine.json");
    writeFileSync(engineJson, JSON.stringify({ lead: "verdict", permissionFlag: null }), { mode: 0o600 });
    const r = await scanIn(env, cal());
    assert.equal(r.reused, false);
    assert.equal(r.lead, "verdict");
    const { g, s } = assertContract(env);
    assert.deepEqual([g.lead, s.lead], ["verdict", "verdict"]);
    writeFileSync(engineJson, JSON.stringify({ lead: "<b>verdict</b>" }), { mode: 0o600 });
    await scanIn(env, cal());
    assert.equal(readJson(join(env.wh, "glance.json")).lead, "timeline", "anything else is the default");
  } finally {
    env.cleanup();
  }
});

test("hostile corpus, calibrated: no canary reaches glance, snapshot, decisions or anything else in the home folder", async () => {
  const env = tempEnv("pipe-hostile");
  try {
    copyCorpus(env, join(TESTDATA, "hostile"));
    const r = await scanIn(env, cal({ now: new Date("2026-06-10T12:00:00Z") }));
    assert.equal(r.wrote, true);
    assertContract(env);
    const probe = spawnSync(process.execPath, [CHECK, "--require-canaries", env.wh], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    assert.match(probe.stdout, /0 hits/);
    // The in-memory report's documents too (what `--read-only` prints).
    const text = JSON.stringify({ g: r.glance, s: r.snapshot });
    const check = spawnSync(process.execPath, [CHECK, "--require-canaries", "-"], { input: text, encoding: "utf8" });
    assert.equal(check.status, 0, check.stdout);
  } finally {
    env.cleanup();
  }
});
