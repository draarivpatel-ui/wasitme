// WP-10Δ invariants over every acceptance-suite fixture (the acceptance tests themselves are not edited beyond the
// contract field sets). The harness import must come first: it points the Claude root and HOME at synthetic dirs.
import { bySeq, findSource, parseScenario } from "../fixtures/acceptance/claude/harness.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCENARIOS, type ScenarioName } from "../fixtures/acceptance/claude/build-fixtures.js";
import { claudeReader } from "../../src/readers/claude.js";
import type { ParseResult } from "../../src/types.js";

const NAMES = Object.keys(SCENARIOS) as ScenarioName[]; // resumeA before resumeB

async function all(): Promise<Map<ScenarioName, ParseResult>> {
  const sources = claudeReader.list();
  const out = new Map<ScenarioName, ParseResult>();
  for (const n of NAMES) {
    try { findSource(sources, n); } catch { continue; } // the empty file's listing is optional
    out.set(n, await parseScenario(claudeReader, n));
  }
  return out;
}

test("every exchange: toolErrorsEdit + toolErrorsCmd = toolErrors; one interactive class per session", async () => {
  for (const [name, r] of await all()) {
    const classes = new Set<string | undefined>();
    for (const x of r.exchanges) {
      const at = `${name} seq ${x.seq}`;
      assert.ok(Number.isInteger(x.toolErrorsEdit) && x.toolErrorsEdit! >= 0, `${at}.toolErrorsEdit`);
      assert.ok(Number.isInteger(x.toolErrorsCmd) && x.toolErrorsCmd! >= 0, `${at}.toolErrorsCmd`);
      assert.equal(x.toolErrorsEdit! + x.toolErrorsCmd!, x.toolErrors, `${at}: split sums to toolErrors`);
      assert.ok(["interactive", "scripted", "unknown"].includes(x.interactiveClass!), `${at}.interactiveClass`);
      classes.add(x.interactiveClass);
    }
    assert.ok(classes.size <= 1, `${name}: one class per session`);
  }
});

test("every event: strength and provenance from the frozen enums; unknown is weak, agent routine, you strong", async () => {
  for (const [name, r] of await all()) {
    for (const e of r.events) {
      const at = `${name} event ${e.kind}`;
      assert.ok(["strong", "weak", "routine"].includes(e.strength!), `${at}.strength`);
      assert.ok(["command", "settings_snapshot", "project_snapshot", "org_settings", "log_field", "attachment"].includes(e.provenance!), `${at}.provenance`);
      const want = { unknown: "weak", agent: "routine", you: "strong", meta: "routine" }[e.side];
      assert.equal(e.strength, want, `${at}: ${e.side} is ${want}`);
    }
  }
});

test("tools: the failed Bash call (#4, 'Exit code 1') is a command failure; rejections and blocks are on neither side", async () => {
  const [e0, e1] = bySeq(await parseScenario(claudeReader, "tools"));
  assert.deepEqual([e0!.toolErrors, e0!.toolErrorsCmd, e0!.toolErrorsEdit, e0!.rejections, e0!.blocked], [1, 1, 0, 1, 2]);
  assert.deepEqual([e1!.toolErrors, e1!.toolErrorsCmd, e1!.toolErrorsEdit], [0, 0, 0]);
});

test("labels: version is agent · routine; the /model change you · strong · command; effort without a command unknown · weak", async () => {
  const { events } = await parseScenario(claudeReader, "labels");
  const by = (k: string) => events.filter((e) => e.kind === k).map((e) => [e.side, e.strength, e.provenance]);
  assert.deepEqual(by("version"), [["agent", "routine", "log_field"]]);
  assert.deepEqual(by("model"), [["you", "strong", "command"]]);
  assert.deepEqual(by("mode"), [["you", "strong", "log_field"]]);
  assert.deepEqual(by("effort"), [["unknown", "weak", "log_field"]], "only /model ran; nothing records who moved effort");
});

test("interactive class of the acceptance scenarios: human-driven Desktop, CLI and IDE sessions are interactive", async () => {
  const results = await all();
  for (const n of ["basic", "filters", "modern", "tools", "usage", "subagents", "resumeA", "labels", "labelsDirty"] as const) {
    assert.deepEqual([...new Set(results.get(n)!.exchanges.map((x) => x.interactiveClass))], ["interactive"], n);
  }
});
