/**
 * `wasitme demo` (WP-30, D21): the engine's own output over the design system's analytic demo data. Every case must be
 * engine output that validates against the frozen schemas, passes every copy lint, carries `demo: true` and a visible
 * DEMO marker in every format, and reaches the decision-table row its story describes. The command never touches the
 * wasitme home or the agents' logs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decisionRow } from "../../src/contract/check.js";
import { DEMO_CASES, demoFacts, demoOutputs } from "../../src/demo/facts.js";
import { coerceDoc } from "../../src/output/doc.js";
import { renderHtml, renderMarkdown } from "../../src/output/report.js";
import { renderTerminal } from "../../src/output/terminal.js";
import { SNAPSHOT_METRICS } from "../../src/words/build.js";
import { metricWords } from "../../src/words/names.js";
import { assertValidOutputs } from "../words/helpers.js";
import { GOLDENS, ROOT, stripSgr, UPDATE } from "./cases.js";

const CLI = `${ROOT}engine/dist/src/cli/main.js`;
const DEMO_NOW = Date.parse("2026-10-04T14:24:00Z");

const EXPECT: Record<string, [state: string, reason: string | null, row: number]> = {
  insufficient: ["insufficient", "needs_data", 2],
  none: ["none", null, 13],
  unclear: ["unclear", "both_sides", 6],
  you: ["you", null, 7],
  agent: ["agent", "by_elimination", 9],
  // Codex is calibrated in the shipped artifact (D69): its demo is a light Codex user's "too early to tell".
  codex: ["insufficient", "needs_data", 2],
};

test("demo: no projected date or 'at your pace' estimate anywhere (D66), and the snapshot carries real-looking health and calibration", () => {
  for (const name of DEMO_CASES) {
    const out = demoOutputs(name, { engine: "0.1.0" });
    const doc = coerceDoc(out.snapshot, DEMO_NOW);
    for (const text of [renderTerminal(doc, { mode: "none", ascii: false, columns: 100, timeZone: "UTC", platform: "darwin" }), renderMarkdown(doc), renderHtml(doc), JSON.stringify(out.snapshot)]) {
      assert.doesNotMatch(text, /at your pace|re-check needs|\(Nov \d+\)|takes about \d+ weeks/, `${name}: no estimate`);
    }
    for (const a of out.snapshot.agents) assert.equal(a.progress?.etaDate ?? null, null, `${name}: no etaDate`);
    const s = out.snapshot;
    assert.deepEqual(s.health.sources.map((x) => [x.agent, x.found, x.error]), [[s.agents[0]!.agent, true, null]], `${name}: one source row for its agent`);
    assert.ok(s.health.sources[0]!.files > 0);
    assert.ok(Object.keys(s.health.parserVersions).length > 0, `${name}: parser versions`);
    assert.equal(s.calibration.artifactDate, "2026-10-05", `${name}: the shipped artifact's date`);
    assert.equal(s.calibration.methodId, "session-t95-cr2");
    assert.deepEqual(s.calibration.agents.map((x) => [x.agent, x.calibrated, x.sequences > 0]), [[s.agents[0]!.agent, true, true]]);
  }
});

for (const name of DEMO_CASES) {
  test(`demo ${name}: valid engine output for its decision-table row, with the DEMO marker in every format`, () => {
    for (const lead of ["timeline", "verdict"] as const) {
      const out = demoOutputs(name, { engine: "0.1.0", lead });
      assertValidOutputs(out, `demo/${name}/${lead}`);
      const a = out.snapshot.agents[0]!;
      const [state, reason, row] = EXPECT[name]!;
      assert.deepEqual([a.state, a.reason], [state, reason]);
      assert.equal(decisionRow(a.state, a.reason), row === 14 ? 2 : row);
      assert.equal(a.trace.at(-1)!.row, row, "the trace ends at the matched row");
      assert.equal(out.glance.demo, true);
      assert.equal(out.snapshot.demo, true);
      const doc = coerceDoc(out.snapshot, DEMO_NOW);
      assert.equal(doc.display, "ok");
      assert.match(stripSgr(renderTerminal(doc, { mode: "none", ascii: false, columns: 100, timeZone: "UTC", platform: "darwin", lead })), /^DEMO {12}analytic demo data run through the engine; not your logs$/m);
      assert.match(renderMarkdown(doc), /^> \*\*DEMO: /m);
      assert.match(renderHtml(doc), /<p class="banner">DEMO: /);
    }
  });
}

test("demo: the numbers are the demo file's, and the words are the engine's", () => {
  const f = demoFacts("insufficient");
  const tool = f.metrics.find((m) => m.id === "toolErrors")!;
  assert.deepEqual([tool.recent.k, tool.recent.n, tool.baseline.k, tool.baseline.n, tool.ratio, tool.mde], [88, 3290, 201, 5610, 0.75, 2.5]);
  assert.equal(f.progress!.etaDate, null, "D66: no projected dates in v1");
  const out = demoOutputs("insufficient", { engine: "0.1.0" });
  assert.equal(out.glance.agents[0]!.headline, "wasitme can already rule out changes bigger than about ×2.5 in tool errors.");
  // the design file's hand-written prose is not used: the engine's confidence line counts both windows
  assert.match(out.glance.agents[0]!.confidence, /^Based on 734 exchanges over 66 session-days \(16 sessions\) on this Mac\./);
  assert.throws(() => demoFacts("nope" as never), RangeError);
});

test("demo: every unlock item has its indicator's row, and no output names an indicator by its id", () => {
  // The Codex demo's unlock list named tool errors with no metric row, and the Control Center printed "toolErrors".
  const RAW = new RegExp(`\\b(${SNAPSHOT_METRICS.filter((id) => /[A-Z]/.test(id)).join("|")})\\b`);
  for (const name of DEMO_CASES) {
    for (const lead of ["timeline", "verdict"] as const) {
      const out = demoOutputs(name, { engine: "0.1.0", lead });
      for (const a of out.snapshot.agents) {
        for (const u of a.progress?.unlock ?? []) {
          const row = a.metrics.find((m) => m.id === u.metric);
          assert.ok(row, `${name}: unlock ${u.metric} has a metric row`);
          assert.equal(row.label, metricWords(u.metric).label, `${name}: ${u.metric} is labelled as the engine names it`);
        }
      }
      const doc = coerceDoc(out.snapshot, DEMO_NOW);
      const terminal = stripSgr(renderTerminal(doc, { mode: "none", ascii: false, columns: 100, timeZone: "UTC", platform: "darwin", lead }));
      for (const [what, text] of [["terminal", terminal], ["markdown", renderMarkdown(doc)], ["html", renderHtml(doc)]] as const) {
        assert.doesNotMatch(text, RAW, `${name}/${lead}: ${what} names an indicator by its id`);
      }
      if (name === "codex") assert.match(terminal, /Next to unlock: tool errors \(8 of 10 session-days\)\./);
    }
  }
  // An id this version does not know (a newer document's) is named by its words, never as the id.
  assert.deepEqual(metricWords("fooBarBaz"), { label: "Foo bar baz", unit: "", name: "foo bar baz" });
  assert.equal(metricWords("").label, "Indicator");
  assert.equal(metricWords("aA".repeat(16)).label, "Indicator", "words longer than a label's 40 are no name");
});

test("demo: each agent's Setup is its own, its installed version the last one its own timeline moved to", () => {
  for (const name of DEMO_CASES) {
    const a = demoOutputs(name, { engine: "0.1.0" }).snapshot.agents[0]!;
    const last = a.timeline.filter((e) => e.kind === "version").at(-1);
    assert.ok(last, `${name}: the timeline has an update`);
    assert.equal(a.setup.agentVersion, last.to, `${name}: Setup says ${a.agent} ${String(a.setup.agentVersion)}, the timeline ends at ${last.to}`);
    // A real scan reports hooks for Claude Code only (engine/src/store/scan.ts SETUP_COUNTS).
    assert.equal(Object.hasOwn(a.setup, "hooks"), a.agent === "claude-code", `${name}: hooks only for Claude Code`);
  }
  assert.equal(demoOutputs("codex", { engine: "0.1.0" }).snapshot.agents[0]!.setup.agentVersion, "0.95");
});

function cli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
}

test("demo (CLI): never reads or creates the wasitme home, a Claude folder or a Codex folder; works with nothing installed", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wasitme-demo-")));
  try {
    const home = join(root, "home");
    const wh = join(root, "no-such-wasitme-home");
    const env = { HOME: home, WASITME_HOME: wh, WASITME_CLAUDE_DIR: join(root, "nope-claude"), WASITME_CODEX_DIR: join(root, "nope-codex"), PATH: "/usr/bin:/bin" };
    mkdirSync(home);
    const before = readdirSync(root).sort();
    for (const args of [["demo"], ["demo", "--case", "agent", "--lead", "verdict"], ["demo", "--md"], ["demo", "--html", "--case", "you"], ["demo", "--json"], ["demo", "--case", "codex", "--format", "md"]]) {
      const r = cli(args, env);
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      assert.ok(r.stdout.length > 200);
      assert.match(r.stdout, args.includes("--json") ? /"demo": true/ : /DEMO/, `${args.join(" ")}: marked as demo`);
      assert.equal(r.stderr, "");
      assert.ok(!r.stdout.includes("\x1b"), "no colour when piped");
      assert.ok(!r.stdout.includes(root), "no path in the output");
    }
    assert.ok(!existsSync(wh), "the wasitme home was not created");
    assert.deepEqual(readdirSync(root).sort(), before, "nothing else was created");
    assert.deepEqual(readdirSync(home), [], "the fake home is untouched");
    const json = JSON.parse(cli(["demo", "--json", "--case", "unclear"], env).stdout);
    assert.equal(json.schema, "wasitme.snapshot/1");
    assert.equal(json.demo, true);
    const bad = cli(["demo", "--case", "nope"], env);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--case must be one of insufficient, none, unclear, you, agent, codex/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// D21: README and launch images come from `wasitme demo`, so what it prints is pinned like any other golden.
for (const name of DEMO_CASES) {
  test(`demo ${name}: the terminal output is a golden (the text the README images are made from)`, () => {
    const out = demoOutputs(name, { engine: "0.1.0" });
    const text = renderTerminal(coerceDoc(out.snapshot, DEMO_NOW), { mode: "none", ascii: false, columns: 100, timeZone: "UTC", platform: "darwin" });
    const path = `${GOLDENS}demo/${name}.txt`;
    if (UPDATE) {
      mkdirSync(`${GOLDENS}demo`, { recursive: true });
      writeFileSync(path, text);
      return;
    }
    assert.ok(existsSync(path), `missing golden ${path.slice(ROOT.length)} (run with WASITME_UPDATE_GOLDENS=1)`);
    assert.equal(text, readFileSync(path, "utf8"));
  });
}
