// Confounder labels per exchange (research/05 #12) and in-log change events. Fixtures: labels(), labelsDirty().
import { bySeq, expectFields, oneOf, parseScenario } from "../fixtures/acceptance/claude/harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangeEvent } from "../../src/types.js";
import { claudeReader } from "../../src/readers/claude.js";

test("labels: version / model / effort / mode / entrypoint per exchange", async () => {
  const xs = bySeq(await parseScenario(claudeReader, "labels"));
  assert.equal(xs.length, 3); // the /model command, its caveat and its stdout are not prompts
  expectFields(xs[0]!, { version: "2.1.287", model: "claude-sonnet-5", servedModel: "claude-sonnet-5", effort: "medium", mode: "default", entrypoint: "cli" }, "labels E0");
  expectFields(xs[1]!, { version: "2.1.288", model: "claude-sonnet-5", servedModel: "claude-sonnet-5", effort: "medium", mode: "default", entrypoint: "cli" }, "labels E1");
  expectFields(xs[2]!, { version: "2.1.288", model: "claude-opus-5-5", servedModel: "claude-opus-5-5", effort: "high", mode: "bypassPermissions", entrypoint: "cli" }, "labels E2");
});

function only(events: ChangeEvent[], kind: ChangeEvent["kind"]): ChangeEvent {
  const hits = events.filter((e) => e.kind === kind);
  assert.equal(hits.length, 1, `expected exactly one '${kind}' event, got ${JSON.stringify(hits)}`);
  return hits[0]!;
}

function within(e: ChangeEvent, from: string, to: string): void {
  assert.ok(e.t >= from && e.t <= to, `${e.kind} event t=${e.t} should be within [${from}, ${to}]`);
}

test("in-log changes become ChangeEvents with from/to labels and a time between the last old and first new record", async () => {
  const { events } = await parseScenario(claudeReader, "labels");
  const v = only(events, "version");
  expectFields(v, { from: "2.1.287", to: "2.1.288", agent: "claude-code", evidence: "log" }, "version event");
  within(v, "2026-10-03T08:00:10.000Z", "2026-10-03T08:10:00.000Z");
  const m = only(events, "model");
  expectFields(m, { from: "claude-sonnet-5", to: "claude-opus-5-5", agent: "claude-code", evidence: "log" }, "model event");
  within(m, "2026-10-03T08:10:10.000Z", "2026-10-03T08:20:05.000Z");
  const ef = only(events, "effort");
  expectFields(ef, { from: "medium", to: "high", agent: "claude-code", evidence: "log" }, "effort event");
  within(ef, "2026-10-03T08:10:10.000Z", "2026-10-03T08:20:05.000Z");
  const mo = only(events, "mode");
  expectFields(mo, { from: "default", to: "bypassPermissions", agent: "claude-code", evidence: "log" }, "mode event");
  within(mo, "2026-10-03T08:15:02.000Z", "2026-10-03T08:20:00.000Z");
});

test("unchanged labels (entrypoint) produce no events; nothing else is invented", async () => {
  const { events } = await parseScenario(claudeReader, "labels");
  assert.deepEqual(events.map((e) => e.kind).sort(), ["effort", "mode", "model", "version"]);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, "event ids unique");
});

test("a model change right after a /model command is user-initiated (side 'you')", async () => {
  const m = only((await parseScenario(claudeReader, "labels")).events, "model");
  expectFields(m, { userInitiated: true, side: "you" }, "model event");
});

test("labels that fail cleanLabel (path, ANSI, HTML, > 60 chars) are never reported", async () => {
  const [e0] = bySeq(await parseScenario(claudeReader, "labelsDirty"));
  oneOf(e0!.model, ["unknown", "other"], "labelsDirty E0.model");
  oneOf(e0!.servedModel, ["unknown", "other"], "labelsDirty E0.servedModel");
  oneOf(e0!.effort, ["unknown", "other"], "labelsDirty E0.effort");
  expectFields(e0!, { version: "2.1.288", mode: "default", entrypoint: "claude-vscode", steps: 2 }, "labelsDirty E0");
});

test("labels are the majority value within the exchange (version 2.1.288 on 3 records vs 2.1.289 on 1)", async () => {
  const [, e1] = bySeq(await parseScenario(claudeReader, "labelsDirty"));
  expectFields(e1!, { version: "2.1.288", model: "claude-opus-5-5", effort: "low", steps: 3 }, "labelsDirty E1");
});
