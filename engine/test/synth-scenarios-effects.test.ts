/**
 * Scenarios with a planted change. For each, the effect the generator says it planted must be
 * recoverable from simple counts of the written files (a session-cluster bootstrap on the reference
 * counter's output), the evidence of WHO changed it must be in the logs, and metrics with no planted
 * effect must stay put.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayString } from "../src/synth/params.js";
import {
  METRICS, clusterRatio, corpusOnDisk, diffRows, referenceRows, splitAssign, zScore, type Corpus,
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

function est(ref: Ref, agent: string, metric: string, splitDay: string): ReturnType<typeof clusterRatio> {
  return clusterRatio(ref.filter((r) => r.agent === agent), METRICS[metric]!, splitAssign(splitDay));
}

/** The realised before/after ratio is consistent with the planted factor (|z| < 4). */
function recovered(e: ReturnType<typeof clusterRatio>, planted: number, label: string): void {
  assert.ok(Math.abs(zScore(e, planted)) < 4, `${label}: ratio ${e.ratio.toFixed(2)} vs planted ${planted} (z ${zScore(e, planted).toFixed(1)})`);
}

/** The change is unmistakable against "no change" (|z| > 3, right direction). */
function detected(e: ReturnType<typeof clusterRatio>, up: boolean, label: string): void {
  const z = zScore(e);
  assert.ok(up ? z > 3 : z < -3, `${label}: ratio ${e.ratio.toFixed(2)} z ${z.toFixed(1)}`);
}

function unchanged(e: ReturnType<typeof clusterRatio>, label: string): void {
  assert.ok(Math.abs(zScore(e)) < 4, `${label} should not move: ratio ${e.ratio.toFixed(2)} z ${zScore(e).toFixed(1)}`);
}

function fileText(c: Corpus, pathPrefix: string): { path: string; text: string }[] {
  return c.generated.files.filter((f) => f.path.startsWith(pathPrefix) && f.path.endsWith(".jsonl")).map((f) => ({ path: f.path, text: String(f.data) }));
}

function commandRecords(c: Corpus, cmd: string): { path: string; ts: string; line: string }[] {
  const out: { path: string; ts: string; line: string }[] = [];
  const seen = new Set<string>(); // a resumed session replays earlier records under the same uuid
  for (const f of fileText(c, "claude/projects/")) {
    for (const line of f.text.split("\n")) {
      if (!line.includes(`<command-name>/${cmd}</command-name>`)) continue;
      const rec = JSON.parse(line) as { uuid: string; timestamp: string };
      if (seen.has(rec.uuid)) continue;
      seen.add(rec.uuid);
      out.push({ path: f.path, ts: String(rec.timestamp), line });
    }
  }
  return out;
}

test("effort-drop-you: you lowered effort; the /effort command is in the log and the planted effects are recoverable", async () => {
  await withCorpus("effort-drop-you", (c, ref) => {
    const planted = c.truth.events.filter((e) => !e.auto);
    assert.equal(planted.length, 1);
    const ev = planted[0]!;
    assert.deepEqual([ev.kind, ev.side, ev.userInitiated, ev.from, ev.to, ev.day], ["effort", "you", true, "high", "medium", 28]);
    assert.deepEqual(ev.effect, { thinkDepth: 0.45, blindEdit: 2.5, pushback: 3 });
    const split = dayString(c.truth.startDay, ev.day);

    // Evidence of who: exactly one /effort command, typed on or just after the change day, with the new value.
    const cmds = commandRecords(c, "effort");
    assert.equal(cmds.length, 1);
    assert.match(cmds[0]!.line, /<command-args>medium<\/command-args>/);
    assert.equal(cmds[0]!.ts.slice(0, 10), split, "typed on the change day itself");
    assert.equal(cmds[0]!.ts, ev.commandAt, "the truth names the moment of the command");
    assert.equal(commandRecords(c, "model").length, 0);

    // The effort label on the assistant records flips with it (older CLI versions write none: "unknown").
    const before = ref.filter((r) => r.day < split && r.effort !== "unknown");
    const after = ref.filter((r) => r.day >= split && r.effort !== "unknown");
    assert.ok(before.length > 100 && before.every((r) => r.effort === "high"));
    assert.ok(after.length > 100 && after.every((r) => r.effort === "medium"));
    // ...and no exchange runs at the new effort before the command that changed it.
    assert.ok(ref.filter((r) => r.effort === "medium").every((r) => r.t > cmds[0]!.ts), "the first medium-effort exchange comes after the /effort command");

    for (const [m, f] of [["thinkDepth", 0.45], ["blindEdit", 2.5], ["pushback", 3]] as const) {
      const e = est(ref, "claude-code", m, split);
      recovered(e, f, m);
      detected(e, f > 1, m);
    }
    unchanged(est(ref, "claude-code", "toolError", split), "toolError");
    unchanged(est(ref, "claude-code", "toolCalls", split), "toolCalls");
    unchanged(est(ref, "claude-code", "interrupt", split), "interrupt");
  });
});

test("version-regression-agent: a vendor version bump (no user action) worsens tool errors, interrupts and blind edits", async () => {
  await withCorpus("version-regression-agent", (c, ref) => {
    const planted = c.truth.events.filter((e) => !e.auto);
    assert.equal(planted.length, 1);
    const ev = planted[0]!;
    assert.deepEqual([ev.kind, ev.side, ev.userInitiated, ev.day], ["version", "agent", false, 31]);
    assert.notEqual(ev.from, ev.to);
    assert.deepEqual(ev.effect, { toolError: 2.5, interrupt: 3, blindEdit: 3 });
    const split = dayString(c.truth.startDay, ev.day);

    // No evidence of a user action anywhere: no slash commands at all.
    assert.equal(commandRecords(c, "effort").length + commandRecords(c, "model").length, 0);
    for (const f of fileText(c, "claude/projects/")) assert.ok(!f.text.includes("<command-name>"), f.path);

    // The first exchange on/after the change day already runs the new version.
    const firstAfter = ref.filter((r) => r.day >= split).sort((a, b) => (a.t < b.t ? -1 : 1))[0]!;
    assert.equal(firstAfter.version, ev.to);
    assert.ok(ref.filter((r) => r.day < split).every((r) => r.version !== ev.to));

    const toolError = est(ref, "claude-code", "toolError", split);
    recovered(toolError, 2.5, "toolError");
    detected(toolError, true, "toolError");
    // Sparse metrics: right direction and the right order of magnitude (few-long users are noisy by design).
    for (const [m, f] of [["interrupt", 3], ["blindEdit", 3]] as const) {
      const e = est(ref, "claude-code", m, split);
      assert.ok(e.ratio > 1.4 && e.ratio < f * 2.5, `${m}: ratio ${e.ratio.toFixed(2)} (planted ${f})`);
      assert.ok(Math.abs(zScore(e, f)) < 4, `${m} consistent with planted ${f}: z ${zScore(e, f).toFixed(1)}`);
    }
    unchanged(est(ref, "claude-code", "toolCalls", split), "toolCalls");
    unchanged(est(ref, "claude-code", "thinkDepth", split), "thinkDepth");
    unchanged(est(ref, "claude-code", "pushback", split), "pushback");
  });
});

test("confounded-same-week: model, instructions, effort and version all change within a week", async () => {
  await withCorpus("confounded-same-week", (c, ref) => {
    const planted = c.truth.events.filter((e) => !e.auto);
    assert.deepEqual(planted.map((e) => e.kind), ["model", "instructions", "effort", "version"]);
    assert.deepEqual(planted.map((e) => e.side), ["you", "you", "you", "agent"]);
    const days = planted.map((e) => e.day);
    assert.ok(days[3]! - days[0]! <= 7, `all four changes inside one week: ${days.join(",")}`);
    assert.deepEqual(planted.map((e) => Boolean(e.effect)), [true, false, true, true], "the config edit is a no-op for the metrics");

    // Evidence: /model and /effort commands, a new model label, a new instructions revision.
    const model = commandRecords(c, "model");
    assert.equal(model.length, 1);
    assert.match(model[0]!.line, /claude-sonnet-5-5/);
    assert.equal(commandRecords(c, "effort").length, 1);
    const split = dayString(c.truth.startDay, days[0]!);
    assert.ok(ref.filter((r) => r.day >= split && r.model !== "unknown").every((r) => r.model === "claude-sonnet-5-5"));
    assert.ok(ref.filter((r) => r.day < split && r.model !== "unknown").every((r) => r.model === "claude-opus-5-5"));
    assert.ok(ref.filter((r) => r.model === "claude-sonnet-5-5").every((r) => r.t > model[0]!.ts), "no exchange runs on the new model before the /model command");
    const rev2 = fileText(c, "claude/projects/").some((f) => f.text.includes("Synthetic project instructions revision 2"));
    assert.ok(rev2, "an instructions attachment with revision 2 exists");

    // Effects planted at the first change are recoverable...
    recovered(est(ref, "claude-code", "toolError", split), 1.5, "toolError");
    recovered(est(ref, "claude-code", "thinkDepth", split), 0.7, "thinkDepth");
    // ...but the same split also "sees" the blind-edit rise planted by the effort change two days later:
    // a before/after contrast cannot say which of the four changes did it.
    const blind = est(ref, "claude-code", "blindEdit", split);
    assert.ok(blind.ratio > 1.4, `blindEdit rises at the model-change split too: ${blind.ratio.toFixed(2)}`);
    const effortSplit = dayString(c.truth.startDay, days[2]!);
    recovered(est(ref, "claude-code", "blindEdit", effortSplit), 1.8, "blindEdit at the effort change");
  });
});

test("insufficient-new-user: a handful of exchanges, far below any sane minimum", async () => {
  await withCorpus("insufficient-new-user", (c, ref) => {
    assert.equal(c.truth.days, 6);
    assert.ok(ref.length >= 8 && ref.length <= 40, `${ref.length} exchanges`);
    const eligible = ref.filter((r) => r.humanPrompt && r.seq > 0).length;
    assert.ok(eligible < 25, `${eligible} pushback-eligible exchanges`);
    assert.ok(c.truth.events.every((e) => !e.effect), "nothing is planted");
    assert.ok(c.truth.events.some((e) => e.auto), "a version bump happens");
    assert.ok(c.truth.events.some((e) => e.kind === "model"), "and a model change");
    assert.ok(new Set(ref.map((r) => r.session)).size <= 14);
    const calls = ref.reduce((a, r) => a + r.toolCalls, 0);
    assert.ok(calls < 250, `${calls} tool calls`);
    const days = new Set(ref.map((r) => r.day));
    assert.ok(days.size <= 6);
  });
});
