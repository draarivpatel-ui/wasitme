/**
 * Ordering invariants of the generated logs, checked on the bytes that were written (not on the plan):
 *
 *  1. A change the USER makes (a /model, /effort or mode command in Claude Code, thread_settings_applied
 *     in Codex) is typed BEFORE the new setting shows up anywhere. A reader must never see a label flip
 *     (which looks like the agent's doing) hours before the user's own command.
 *  2. A tool-use interrupt ends on the user-rejected call: nothing is launched after it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, type Generated } from "../src/synth/generate.js";
import { BASE_RATES, makeParams, type ScheduleEvent, type SynthParams } from "../src/synth/params.js";
import { SCENARIOS } from "../src/synth/scenarios.js";
import * as V from "../src/synth/vocab.js";

type Field = "model" | "effort" | "mode";
const FIELDS: Field[] = ["model", "effort", "mode"];

interface Label { ts: number; field: Field; value: string }
interface Command { ts: number; field: Field; value: string }
interface Evidence { labels: Label[]; commands: Command[] }

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function records(g: Generated, pathRe: RegExp): { path: string; rec: Rec }[] {
  const out: { path: string; rec: Rec }[] = [];
  for (const f of g.files) {
    if (!pathRe.test(f.path)) continue;
    for (const line of String(f.data).split("\n")) {
      if (!line) continue;
      out.push({ path: f.path, rec: JSON.parse(line) as Rec });
    }
  }
  return out;
}

const ts = (s: unknown): number | undefined => (typeof s === "string" && Number.isFinite(Date.parse(s)) ? Date.parse(s) : undefined);

/** Main (non-subagent) Claude session files: claude/projects/<project>/<session>.jsonl */
function claudeEvidence(g: Generated): Evidence {
  const ev: Evidence = { labels: [], commands: [] };
  for (const { rec } of records(g, /^claude\/projects\/[^/]+\/[^/]+\.jsonl$/)) {
    if (rec.isSidechain === true) continue;
    const t = ts(rec.timestamp);
    if (t === undefined) continue;
    if (rec.type === "assistant" && rec.message?.model !== "<synthetic>") {
      if (typeof rec.message?.model === "string") ev.labels.push({ ts: t, field: "model", value: rec.message.model });
      if (typeof rec.effort === "string") ev.labels.push({ ts: t, field: "effort", value: rec.effort });
    } else if (rec.type === "attachment" && rec.attachment?.type === "environment" && typeof rec.attachment.model === "string") {
      ev.labels.push({ ts: t, field: "model", value: rec.attachment.model });
    } else if (rec.type === "user") {
      if (typeof rec.permissionMode === "string") ev.labels.push({ ts: t, field: "mode", value: rec.permissionMode });
      const c = rec.message?.content;
      const m = typeof c === "string" ? /<command-name>\/(model|effort|mode)<\/command-name>[\s\S]*<command-args>(.*)<\/command-args>/.exec(c) : null;
      if (m) ev.commands.push({ ts: t, field: m[1] as Field, value: m[2]! });
    }
  }
  return ev;
}

/** Live and archived rollouts, parent and subagent threads alike. */
function codexEvidence(g: Generated): Evidence {
  const ev: Evidence = { labels: [], commands: [] };
  for (const { rec } of records(g, /^codex\/(sessions\/.+|archived_sessions\/[^/]+)\.jsonl$/)) {
    const t = ts(rec.timestamp);
    if (t === undefined) continue;
    if (rec.type === "turn_context") {
      ev.labels.push({ ts: t, field: "model", value: rec.payload.model });
      ev.labels.push({ ts: t, field: "effort", value: rec.payload.effort });
      ev.labels.push({ ts: t, field: "mode", value: rec.payload.approval_policy });
    } else if (rec.type === "event_msg" && rec.payload?.type === "thread_settings_applied") {
      const s = rec.payload.settings as Rec;
      ev.commands.push({ ts: t, field: "model", value: s.model });
      ev.commands.push({ ts: t, field: "effort", value: s.effort });
      ev.commands.push({ ts: t, field: "mode", value: s.approval_policy });
    }
  }
  return ev;
}

/**
 * Check every user-initiated model/effort/mode event of `g`. Returns how many of them had at least one
 * record carrying the new value (older Claude CLIs write no effort / mode, so some legitimately have none).
 *
 * "Before the command" means: since the previous change of the same setting on the same agent (a change
 * back to an earlier value, e.g. sonnet -> opus, is not "seen early" just because opus was in use long ago).
 */
function checkCommandsPrecedeLabels(g: Generated, label: string): { events: number; witnessed: number } {
  const evidence = { "claude-code": claudeEvidence(g), codex: codexEvidence(g) };
  const lastChange = new Map<string, number>();
  let events = 0;
  let witnessed = 0;
  for (const e of g.truth.events) {
    if (!FIELDS.includes(e.kind as Field)) continue;
    const field = e.kind as Field;
    const key = `${e.agent}/${field}`;
    const since = lastChange.get(key) ?? -Infinity;
    lastChange.set(key, e.commandAt ? Date.parse(e.commandAt) : Date.parse(`${e.date}T00:00:00Z`));
    if (!e.userInitiated) continue;
    events++;
    const mine = evidence[e.agent];
    const where = `${label}: ${e.agent} ${field} ${e.from} -> ${e.to} on ${e.date}`;

    // The truth names the moment the command was typed, and the log has that command at exactly that moment.
    assert.ok(e.commandAt, `${where}: truth carries commandAt`);
    const at = Date.parse(e.commandAt!);
    assert.ok(Number.isFinite(at), where);
    assert.equal(e.commandAt!.slice(0, 10), e.date, `${where}: the command is typed on the event's own day`);
    assert.ok(mine.commands.some((c) => c.field === field && c.value === e.to && c.ts === at), `${where}: a command record at ${e.commandAt}`);

    // No record carries the new value before that moment (since the setting last changed).
    const seen = mine.labels.filter((l) => l.field === field && l.value === e.to);
    if (seen.some((l) => l.ts >= at)) witnessed++;
    const early = seen.filter((l) => l.ts >= since && l.ts < at);
    if (early.length) assert.fail(`${where}: ${early.length} records show the new ${field} before the command (earliest ${new Date(Math.min(...early.map((l) => l.ts))).toISOString()}, command ${e.commandAt})`);
  }
  return { events, witnessed };
}

/**
 * The planner makes the command's exchange the first thing the agent does on the event day, so the
 * day-level truth (labels and planted effects switch at the event day) stays exact.
 */
function checkCommandIsFirstOfTheDay(g: Generated, label: string): void {
  for (const e of g.truth.events) {
    if (!e.userInitiated || !FIELDS.includes(e.kind as Field)) continue;
    const day = g.rows.filter((r) => r.agent === e.agent && r.day === e.date);
    const first = day.reduce((a, b) => (b.t < a.t ? b : a));
    assert.ok(Date.parse(e.commandAt!) < Date.parse(first.t), `${label}: ${e.agent} ${e.date}: the command precedes the day's first exchange`);
    assert.ok(first.humanPrompt === 1 && !first.automated, `${label}: ${e.agent} ${e.date}: the day's first exchange is a typed prompt`);
  }
}

test("user-typed changes precede every record that shows the new setting (every scenario, default seed and length)", () => {
  let events = 0;
  let witnessed = 0;
  for (const sc of SCENARIOS) {
    const g = generate(sc.build({}), sc.name);
    const r = checkCommandsPrecedeLabels(g, sc.name);
    checkCommandIsFirstOfTheDay(g, sc.name);
    events += r.events;
    witnessed += r.witnessed;
  }
  assert.ok(events >= 8, `${events} user-initiated events checked`);
  assert.ok(witnessed >= events - 2, `the new value is visible in the logs for ${witnessed} of ${events} events (a vacuous check proves nothing)`);
});

test("user-typed changes precede every record that shows the new setting (seed sweep over the scenarios that plant one)", () => {
  let events = 0;
  for (const name of ["effort-drop-you", "confounded-same-week", "codex-only", "both-agents", "insufficient-new-user", "tiny-both"]) {
    const sc = SCENARIOS.find((s) => s.name === name)!;
    for (let k = 1; k <= 4; k++) {
      const g = generate(sc.build({ seed: sc.defaultSeed + 1000 * k, days: sc.defaultDays > 14 ? 21 : sc.defaultDays }), name);
      events += checkCommandsPrecedeLabels(g, `${name}/seed+${1000 * k}`).events;
      checkCommandIsFirstOfTheDay(g, `${name}/seed+${1000 * k}`);
    }
  }
  assert.ok(events >= 24, `${events} events checked`);
});

test("sparse, busy and multi-change days: every kind of change on both agents, many days with little or no activity", () => {
  const you = (day: number, agent: "claude-code" | "codex", kind: Field, to: string): ScheduleEvent => ({ day, agent, kind, to, by: "you", effect: kind === "effort" ? { toolError: 1.4 } : undefined });
  let events = 0;
  let sundayOrOff = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const p: SynthParams = makeParams({
      seed, days: 24, agents: ["claude-code", "codex"], shape: seed % 2 ? "few-long" : "many-short",
      // Under two exchanges a day: Poisson-zero days, weekends and off days are common, which is where a change would otherwise land on a day with nobody typing.
      exchangesPerDay: { "claude-code": 1.2, codex: 1.2 },
      initial: {
        "claude-code": { version: "2.1.250", model: "claude-opus-5-5", effort: "high", mode: "default", entrypoint: "cli" },
        codex: { version: "0.150.0", model: "gpt-6-luna", effort: "medium", mode: "on-request", entrypoint: "cli" },
      },
      noise: { ...makeParams({ seed: 0 }).noise, agentInitiatedRate: 0.9, codexExecPerDay: 2, codexForkRate: 0.3, resumeRate: 0.5 },
      events: [
        // several changes on one day (one command exchange carries all of them)
        you(2, "claude-code", "effort", "medium"), you(2, "claude-code", "model", "claude-sonnet-5-5"), you(2, "claude-code", "mode", "acceptEdits"),
        you(3, "codex", "effort", "high"), you(3, "codex", "model", "gpt-6.1-sol"), you(3, "codex", "mode", "never"),
        you(6, "claude-code", "effort", "low"), you(7, "claude-code", "model", "claude-opus-5-5"), // 6 and 7 are Sunday/Monday for 2026-07-01 + 5/6 days
        you(10, "codex", "effort", "low"), you(11, "claude-code", "mode", "plan"),
        you(13, "claude-code", "effort", "high"), you(13, "codex", "model", "gpt-6-luna"),
        you(20, "claude-code", "model", "claude-sonnet-5-5"), you(20, "codex", "effort", "medium"),
      ],
    });
    const g = generate(p, `sparse-${seed}`);
    checkCommandsPrecedeLabels(g, `sparse seed ${seed}`);
    checkCommandIsFirstOfTheDay(g, `sparse seed ${seed}`);
    events += g.truth.events.filter((e) => e.userInitiated).length;
    // The plan does not shrink the day: a typed change always has a typist.
    for (const e of g.truth.events.filter((x) => x.userInitiated)) {
      const dow = new Date(`${e.date}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) sundayOrOff++;
    }
  }
  assert.ok(events >= 12 * 14, `${events} events`);
  assert.ok(sundayOrOff > 0, "some changes land on weekends");
});

// ------------------------------------------------------------------ tool-use interrupts

const TOOL_USE_INTERRUPT_TEXTS = new Set([V.INTERRUPT_TOOL_TEXT]);

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") return String(content[0].text);
  return undefined;
}

test("a tool-use interrupt ends on a user-rejected call: no tool call is launched after it", () => {
  // Interrupts and subagents turned way up so the old failure (a Task call placed after the rejected call) shows up quickly.
  const rates = { ...BASE_RATES, interrupt: 0.5, subagent: 0.6, toolCalls: 6, rejection: 0.05 };
  let interrupts = 0;
  let withSubagent = 0;
  const corpora: [string, Generated][] = [];
  for (let seed = 1; seed <= 6; seed++) corpora.push([`dense seed ${seed}`, generate(makeParams({ seed, days: 14, rates, shape: seed % 2 ? "few-long" : "many-short" }), "dense")]);
  for (const sc of SCENARIOS.filter((s) => s.name !== "codex-only")) corpora.push([sc.name, generate(sc.build({ days: 14 }), sc.name)]);

  for (const [label, g] of corpora) {
    for (const f of g.files) {
      if (!/^claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(f.path)) continue;
      const lines = String(f.data).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
      // Walk the main conversation in file order: the last tool_use seen so far, and what happened to each call.
      const denial = new Map<string, string | undefined>();
      const callsOfMessage = new Map<string, string[]>();
      let lastUse: { id: string; message: string } | undefined;
      for (const rec of lines) {
        if (rec.isSidechain === true) continue;
        if (rec.type === "assistant") {
          for (const b of rec.message.content as Rec[]) {
            if (b.type !== "tool_use") continue;
            lastUse = { id: b.id, message: rec.message.id };
            callsOfMessage.set(rec.message.id, [...(callsOfMessage.get(rec.message.id) ?? []), b.id]);
          }
        } else if (rec.type === "user" && Array.isArray(rec.message?.content)) {
          for (const b of rec.message.content as Rec[]) if (b.type === "tool_result") denial.set(b.tool_use_id, rec.toolDenialKind);
        }
        const text = rec.type === "user" ? textOf(rec.message?.content) : undefined;
        if (text === undefined || !TOOL_USE_INTERRUPT_TEXTS.has(text)) continue;
        interrupts++;
        assert.ok(lastUse, `${label} ${f.path}: a tool-use interrupt follows a tool call`);
        assert.equal(denial.get(lastUse!.id), "user-rejected", `${label} ${f.path}: the last tool_use before a tool-use interrupt is the rejected call (it carries toolDenialKind user-rejected)`);
        const calls = callsOfMessage.get(lastUse!.message)!;
        assert.equal(calls[calls.length - 1], lastUse!.id);
        // ...and it is the only rejected call of its response: earlier calls in the same response ran.
        for (const id of calls.slice(0, -1)) assert.notEqual(denial.get(id), "user-rejected", `${label} ${f.path}: only the last call of the interrupted response is rejected`);
        if (calls.length > 1) withSubagent++;
      }
    }
  }
  assert.ok(interrupts >= 40, `${interrupts} tool-use interrupts checked`);
  assert.ok(withSubagent >= 1, "some interrupted responses ran several calls");
});
