/**
 * Codex-only and both-agents scenarios (plus the tiny fixture scenario): per-agent planted effects are
 * recovered independently, the Codex history modes both occur, and a change planted for one agent
 * leaves the other alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dayString } from "../src/synth/params.js";
import {
  METRICS, clusterRatio, corpusOnDisk, diffRows, rangeAssign, referenceRows, splitAssign, zScore, type Corpus,
} from "../src/synth/testkit.js";
import type { RefExchange } from "../src/synth/verify.js";

type Ref = RefExchange[];

async function withCorpus(name: string, run: (c: Corpus, ref: Ref) => void): Promise<void> {
  const c = corpusOnDisk(name);
  try {
    const ref = await referenceRows(c.dir);
    assert.deepEqual(diffRows(c.rows, ref), [], "planted facts are exactly recoverable from the files");
    run(c, ref);
  } finally {
    c.cleanup();
  }
}

const est = (ref: Ref, agent: string, metric: string, split: string): ReturnType<typeof clusterRatio> =>
  clusterRatio(ref.filter((r) => r.agent === agent), METRICS[metric]!, splitAssign(split));

function recovered(e: ReturnType<typeof clusterRatio>, planted: number, label: string): void {
  assert.ok(Math.abs(zScore(e, planted)) < 4, `${label}: ratio ${e.ratio.toFixed(2)} vs planted ${planted} (z ${zScore(e, planted).toFixed(1)})`);
}
function detected(e: ReturnType<typeof clusterRatio>, up: boolean, label: string): void {
  const z = zScore(e);
  assert.ok(up ? z > 3 : z < -3, `${label}: ratio ${e.ratio.toFixed(2)} z ${z.toFixed(1)}`);
}
function unchanged(e: ReturnType<typeof clusterRatio>, label: string): void {
  assert.ok(Math.abs(zScore(e)) < 4, `${label} should not move: ratio ${e.ratio.toFixed(2)} z ${zScore(e).toFixed(1)}`);
}

function codexModes(c: Corpus): { legacy: number; paginated: number } {
  let legacy = 0;
  let paginated = 0;
  for (const f of c.generated.files) {
    if (!f.path.startsWith("codex/") || !f.path.endsWith(".jsonl")) continue;
    const text = String(f.data);
    if (!text.includes('"type":"task_started"')) continue;
    if (text.includes('"type":"item_completed"')) paginated++;
    else legacy++;
  }
  return { legacy, paginated };
}

test("codex-only: no Claude tree at all; you raised effort and output tokens and tool calls follow", async () => {
  await withCorpus("codex-only", (c, ref) => {
    assert.ok(!existsSync(join(c.dir, "claude")), "no claude directory");
    assert.ok(existsSync(join(c.dir, "codex", "sessions")));
    assert.ok(ref.every((r) => r.agent === "codex"));
    assert.deepEqual(c.truth.params.agents, ["codex"]);

    const planted = c.truth.events.filter((e) => !e.auto);
    assert.equal(planted.length, 1);
    const ev = planted[0]!;
    assert.deepEqual([ev.agent, ev.kind, ev.side, ev.userInitiated, ev.from, ev.to], ["codex", "effort", "you", true, "medium", "high"]);
    const split = dayString(c.truth.startDay, ev.day);

    // Codex states the effort on every turn_context, and records a settings change as an event.
    assert.ok(ref.filter((r) => r.day < split).every((r) => r.effort === "medium"));
    assert.ok(ref.filter((r) => r.day >= split).every((r) => r.effort === "high"));
    const settings = c.generated.files.filter((f) => f.path.startsWith("codex/") && String(f.data).includes('"type":"thread_settings_applied"'));
    assert.equal(settings.length, 1, "exactly one settings-applied event, for the user's change");
    assert.ok(ref.filter((r) => r.effort === "high").every((r) => r.t > ev.commandAt!), "no turn runs at the new effort before the settings change");
    assert.ok(String(settings[0]!.data).includes(`"timestamp":"${ev.commandAt}"`), "commandAt is the settings-applied record's own timestamp");

    recovered(est(ref, "codex", "outTok", split), 1.8, "outTok");
    detected(est(ref, "codex", "outTok", split), true, "outTok");
    recovered(est(ref, "codex", "toolCalls", split), 1.5, "toolCalls");
    detected(est(ref, "codex", "toolCalls", split), true, "toolCalls");
    unchanged(est(ref, "codex", "toolError", split), "toolError");
    unchanged(est(ref, "codex", "blindEdit", split), "blindEdit");

    // Both history modes occur (CLI versions below 0.146 write legacy rollouts) and Codex-only quirks are all there.
    const modes = codexModes(c);
    assert.ok(modes.legacy >= 5 && modes.paginated >= 100, JSON.stringify(modes));
    const t = c.truth.totals.codex!;
    assert.equal(t.rejections, 0);
    assert.equal(t.blocked, 0);
    assert.equal(t.apiErrors, 0);
    assert.equal(t.apiRetries, 0);
    const n = c.truth.noise.codex!;
    assert.ok(n.tokenSnapshotExtras > 100 && n.subagentThreads > 5 && n.execSessions > 5 && n.archivedMoved > 3);
    assert.ok(ref.some((r) => r.entrypoint === "exec" && r.humanPrompt === 0), "exec threads are automated, not human prompts");
  });
});

test("both-agents: a Claude effort drop and a Codex version regression, independent of each other", async () => {
  await withCorpus("both-agents", (c, ref) => {
    const planted = c.truth.events.filter((e) => !e.auto);
    const claude = planted.find((e) => e.agent === "claude-code")!;
    const codex = planted.find((e) => e.agent === "codex")!;
    assert.deepEqual([claude.kind, claude.side], ["effort", "you"]);
    assert.deepEqual([codex.kind, codex.side], ["version", "agent"]);
    assert.ok(codex.day - claude.day >= 7, "different weeks");
    const cs = dayString(c.truth.startDay, claude.day);
    const xs = dayString(c.truth.startDay, codex.day);

    // Claude: thinking depth, blind edits, pushback.
    for (const [m, f] of [["thinkDepth", 0.45], ["blindEdit", 2.5], ["pushback", 3]] as const) {
      const e = est(ref, "claude-code", m, cs);
      recovered(e, f, `claude ${m}`);
      detected(e, f > 1, `claude ${m}`);
    }
    // Codex: tool errors and interrupts.
    const err = est(ref, "codex", "toolError", xs);
    recovered(err, 2.5, "codex toolError");
    detected(err, true, "codex toolError");
    const intr = est(ref, "codex", "interrupt", xs);
    recovered(intr, 3, "codex interrupt");
    detected(intr, true, "codex interrupt");

    // Independence: each agent's other change leaves it alone.
    unchanged(est(ref, "claude-code", "toolError", xs), "claude toolError at the codex change");
    unchanged(est(ref, "claude-code", "toolCalls", xs), "claude toolCalls at the codex change");
    // Codex around the Claude change, using only days before Codex's own change.
    const codexRows = ref.filter((r) => r.agent === "codex");
    const win = rangeAssign(dayString(c.truth.startDay, Math.max(0, claude.day - 14)), cs, xs);
    unchanged(clusterRatio(codexRows, METRICS.toolError!, win), "codex toolError at the claude change");
    unchanged(clusterRatio(codexRows, METRICS.blindEdit!, win), "codex blindEdit at the claude change");

    // The right evidence for each: a /effort command only in Claude's logs; a version label change in Codex's.
    const cmdUuids = new Set<string>();
    for (const f of c.generated.files) {
      if (!f.path.startsWith("claude/projects/")) continue;
      for (const line of String(f.data).split("\n")) if (line.includes("<command-name>/effort</command-name>")) cmdUuids.add(String(JSON.parse(line).uuid));
    }
    assert.equal(cmdUuids.size, 1, "one /effort command record (a resumed session may replay it)");
    assert.ok(!c.generated.files.some((f) => f.path.startsWith("codex/") && String(f.data).includes("<command-name>")));
    const firstAfter = ref.filter((r) => r.agent === "codex" && r.day >= xs).sort((a, b) => (a.t < b.t ? -1 : 1))[0]!;
    assert.equal(firstAfter.version, codex.to);

    // Both agents are present with realistic quirks.
    assert.ok(c.truth.totals["claude-code"]!.exchanges! > 500 && c.truth.totals.codex!.exchanges! > 500);
    assert.ok(c.truth.noise.claude!.replayedRecords > 100 && c.truth.noise.codex!.forkReplayedTurns >= 0);
    const modes = codexModes(c);
    assert.ok(modes.legacy > 0 && modes.paginated > 0);
  });
});

test("tiny-both: the small fixture scenario covers the edge cases in a few hundred KB", async () => {
  await withCorpus("tiny-both", (c, ref) => {
    assert.ok(ref.length >= 25 && ref.length <= 60, `${ref.length} exchanges`);
    const n = c.truth.noise;
    assert.ok(n.claude!.replayedRecords > 0, "a resumed Claude session");
    assert.ok(n.claude!.subagentFiles > 0 && n.claude!.agentInitiatedExchanges > 0 && n.claude!.localCommandRecords === 3);
    assert.ok(n.claude!.legacyEraExchanges > 0 && n.claude!.legacyEraExchanges < c.truth.totals["claude-code"]!.exchanges!, "crosses the CLI-version era boundary");
    assert.ok(n.codex!.forkReplayedTurns > 0 && n.codex!.importedStubTurns > 0 && n.codex!.archivedMoved > 0 && n.codex!.archivedCopied > 0);
    assert.ok(n.codex!.legacySessions > 0 && n.codex!.subagentThreads > 0 && n.codex!.execSessions > 0);
    const total = c.generated.files.reduce((a, f) => a + Buffer.byteLength(f.data), 0);
    assert.ok(total < 1_500_000, `fixture is ${total} bytes`);
    assert.ok(ref.some((r) => r.compactions > 0) && ref.some((r) => r.interrupted === 1) && ref.some((r) => r.queuedMidTurn > 0));
  });
});
