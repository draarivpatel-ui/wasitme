/**
 * The Codex report skill (plugin-codex/skills/report/SKILL.md) against what the engine prints today. The skill tells
 * the model how to read `report --md --agent codex`: a report is recognised by its "wasitme report:" heading, anything
 * else is a short message to repeat; and the states that are not a cause are named in the engine's own words. These
 * tests fail when either side drifts. Synthetic data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderMarkdown } from "../../src/output/report.js";
import { CALIBRATION_PENDING_WORDS, STATE_WORDS } from "../../src/words/tokens.js";
import { tempEnv } from "../store/helpers.js";
import { CASES, docOf, outputsOf, ROOT } from "./cases.js";

const SKILL = readFileSync(`${ROOT}plugin-codex/skills/report/SKILL.md`, "utf8");
const CLI = `${ROOT}engine/dist/src/cli/main.js`;
const HEADING = /^### wasitme report: /m;
const COMMAND = '/bin/sh "$HOME/.wasitme/current/plugin/scripts/run.sh" report --md --agent codex';

test("the skill's command is `report --md --agent codex`, and it tells a report by its \"wasitme report:\" heading", () => {
  assert.ok(SKILL.includes(COMMAND));
  assert.ok(SKILL.includes('"wasitme report:"'), "the skill names the heading it uses to tell a report from a message");
});

test("every report the engine renders, timeline-only included, carries that heading and its state's label", () => {
  for (const c of CASES) {
    const doc = docOf(c.name);
    const md = renderMarkdown(doc);
    assert.match(md, HEADING, c.name);
    for (const a of doc.agents) {
      const label = a.reason === "calibration_pending" ? CALIBRATION_PENDING_WORDS.label : STATE_WORDS[a.state].label;
      assert.ok(md.includes(`**${label}.**`), `${c.name}: the bold state label`);
    }
  }
});

test("the skill names every state that is not a cause, and the out-of-date banner, in the engine's own words", () => {
  const skill = SKILL.toLowerCase();
  for (const label of [STATE_WORDS.insufficient.label, STATE_WORDS.none.label, STATE_WORDS.unclear.label, CALIBRATION_PENDING_WORDS.label]) {
    assert.ok(skill.includes(`"${label.toLowerCase()}"`), `the skill quotes "${label}" among the findings never to turn into a cause`);
  }
  for (const label of [STATE_WORDS.you.label, STATE_WORDS.agent.label, STATE_WORDS.stale.label]) {
    assert.ok(skill.includes(label.toLowerCase()), `the skill says what to do for "${label}"`);
  }
});

test("when the results hold no Codex sessions, the command prints one plain line and no report heading", () => {
  const env = tempEnv("codex-skill");
  try {
    // Results that hold Claude Code only (the "you" case), the way a Codex-plugin user with no Codex logs read yet has.
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const out = outputsOf("you");
    mkdirSync(env.wh, { recursive: true, mode: 0o700 });
    writeFileSync(join(env.wh, "snapshot.json"), `${JSON.stringify({ ...out.snapshot, generatedAt: at })}\n`, { mode: 0o600 });
    writeFileSync(join(env.wh, "glance.json"), `${JSON.stringify({ ...out.glance, generatedAt: at })}\n`, { mode: 0o600 });
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { HOME: env.home, WASITME_HOME: env.wh, WASITME_CLAUDE_DIR: env.claude, WASITME_CODEX_DIR: env.codex, WASITME_TZ: "UTC", PATH: "/usr/bin:/bin" },
      timeout: 120_000,
    });
    const claude = run(["report", "--md", "--no-scan", "--agent", "claude-code"]);
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(claude.stdout, HEADING, "positive control: the agent that is there gets a report");
    const codex = run(["report", "--md", "--no-scan", "--agent", "codex"]);
    assert.equal(codex.status, 1);
    const text = codex.stdout + codex.stderr;
    assert.doesNotMatch(text, HEADING);
    assert.equal(text.trimEnd().split("\n").length, 1, `one line, not a usage text: ${text}`);
    assert.match(text, /^wasitme: No Codex sessions in the results yet/);
    assert.doesNotMatch(text, /usage:/);
  } finally {
    env.cleanup();
  }
});
