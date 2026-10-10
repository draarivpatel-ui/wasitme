/**
 * D63 follow-ups on SYNTHETIC logs only:
 *  (i)  a /model or /effort typed as a session's FIRST prompt (before any response) is a you · strong · command event;
 *  (ii) a resumed session after a recorded /model switch adds no `unknown` model-change event (the command's
 *       attribution carries across the resume).
 * Hand-built fixtures for each mechanism, plus a seed sweep over generated corpora (resumes, agent-initiated starts,
 * several typed changes a day) checked against the generator's truth and against the between-session derivation
 * (attribution/labels.ts, read-only here) that turns an unexplained label move into an `unknown` event.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { labelChangeEvents } from "../../src/analysis/attribution/labels.js";
import { claudeReader } from "../../src/readers/claude.js";
import { clearPriorCache } from "../../src/readers/claude/priors.js";
import { generate } from "../../src/synth/generate.js";
import { makeParams, type ScheduleEvent, type SynthParams } from "../../src/synth/params.js";
import { writeTree } from "../../src/synth/write.js";
import type { ChangeEvent, Exchange, ParseContext } from "../../src/types.js";
import { makeHash } from "../../src/util.js";
import { hash, makeRoot, parseSession, replayInto, scan, SessionBuilder, text, withRoot, writeSession } from "../fixtures/claude/builder.js";

const P = "-synthetic-proj";
const cmd = (name: "model" | "effort", arg: string) =>
  `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${arg}</command-args>`;
const brief = (e: ChangeEvent) => [e.kind, e.side, e.strength, e.provenance, e.from, e.to, e.userInitiated === true];

// ───────────────────────────── (i) first prompt ─────────────────────────────

test("D63(i): /model and /effort typed before the session's first response are you · strong · command events", async () => {
  const s = new SessionBuilder("sess-first", { start: "2026-09-05T09:00:00.000Z" });
  s.user(cmd("model", "opus"));
  s.user("<local-command-stdout>Set model to opus</local-command-stdout>");
  s.system("local_command", { content: cmd("effort", "low") });
  s.prompt("first real prompt");
  s.response([text("hi")], { model: "claude-opus-5-5", effort: "low" });
  s.prompt("second");
  s.response([text("again")], { model: "claude-opus-5-5", effort: "low" });
  const r = await parseSession(s);
  assert.deepEqual(r.events.map(brief), [
    ["model", "you", "strong", "command", "unknown", "claude-opus-5-5", true],
    ["effort", "you", "strong", "command", "unknown", "low", true],
  ]);
  for (const e of r.events) assert.equal(e.day, "2026-09-05");
  // Each event names the session it was logged in (the exchanges' salted id), for the D65 re-pick rule (D81).
  const sessions = new Set(r.exchanges.map((x) => x.session));
  assert.equal(sessions.size, 1);
  for (const e of r.events) assert.equal(e.session, [...sessions][0]);
});

test("D63(i): without a command the first value is only a baseline; a command that changed nothing is not an event", async () => {
  const plain = new SessionBuilder("sess-plain");
  plain.prompt("hello"); plain.response([text("hi")], { model: "claude-opus-5-5" });
  assert.deepEqual((await parseSession(plain)).events, []);
  // /model after a response, choosing the model already in use: nothing moved, nothing reported.
  const same = new SessionBuilder("sess-same");
  same.prompt("hello"); same.response([text("hi")], { model: "claude-opus-5-5" });
  same.user(cmd("model", "opus"));
  same.prompt("again"); same.response([text("hi")], { model: "claude-opus-5-5" });
  assert.deepEqual((await parseSession(same)).events, []);
  // A first-prompt /model whose response failed (no model shown) carries to the first real response.
  const late = new SessionBuilder("sess-late");
  late.user(cmd("model", "sonnet"));
  late.prompt("go");
  late.apiErrorMessage();
  late.prompt("retry");
  late.response([text("ok")], { model: "claude-sonnet-5-5" });
  assert.deepEqual((await parseSession(late)).events.map(brief), [["model", "you", "strong", "command", "unknown", "claude-sonnet-5-5", true]]);
});

// ───────────────────────────── (ii) resume ─────────────────────────────

/** A: two exchanges on sonnet, then `/model opus`, then (optionally) an exchange on opus. */
function sessionA(withOpusExchange: boolean): SessionBuilder {
  const a = new SessionBuilder("sess-a", { start: "2026-09-05T09:00:00.000Z" });
  a.prompt("one"); a.response([text("1")], { model: "claude-sonnet-5-5" });
  a.prompt("two"); a.response([text("2")], { model: "claude-sonnet-5-5" });
  a.user(cmd("model", "opus"));
  a.user("<local-command-stdout>Set model to opus</local-command-stdout>");
  if (withOpusExchange) { a.prompt("three"); a.response([text("3")], { model: "claude-opus-5-5" }); }
  return a;
}

async function resumed(a: SessionBuilder, replay: (a: SessionBuilder) => readonly Record<string, unknown>[]): Promise<{ a: ChangeEvent[]; b: ChangeEvent[] }> {
  const root = makeRoot();
  writeSession(root, P, a);
  await new Promise((r) => setTimeout(r, 20));
  const b = new SessionBuilder("sess-b", { start: "2026-09-06T09:00:00.000Z" });
  replayInto(b, replay(a));
  b.prompt("resumed"); b.response([text("r")], { model: "claude-opus-5-5" });
  writeSession(root, P, b);
  const all = await scan(root);
  return { a: all.get(`${P}/sess-a.jsonl`)!.result.events, b: all.get(`${P}/sess-b.jsonl`)!.result.events };
}

test("D63(ii): /model as the LAST thing before the resume: the resumed session's first response is the you · strong change", async () => {
  const { a, b } = await resumed(sessionA(false), (x) => x.records);
  assert.deepEqual(a.map(brief), [], "A never showed the new model");
  assert.deepEqual(b.map(brief), [["model", "you", "strong", "command", "claude-sonnet-5-5", "claude-opus-5-5", true]]);
});

test("D63(ii): the switch happened in A; B replays it (whole history, or only the part after it): no event in B, never unknown", async () => {
  for (const [label, replay] of [
    ["whole history", (x: SessionBuilder) => x.records],
    ["after the switch only", (x: SessionBuilder) => x.records.slice(-2)],
    ["the command and later", (x: SessionBuilder) => x.records.slice(-4)],
  ] as const) {
    const { a, b } = await resumed(sessionA(true), replay);
    assert.deepEqual(a.map(brief), [["model", "you", "strong", "command", "claude-sonnet-5-5", "claude-opus-5-5", true]], label);
    assert.deepEqual(b.map(brief), [], label);
  }
});

test("D63(ii): /model typed in ANOTHER session, then an older session resumed on the new model: no unknown event, the command explains it", async () => {
  const root = makeRoot();
  const a = new SessionBuilder("sess-old", { start: "2026-09-05T09:00:00.000Z" });
  a.prompt("one"); a.response([text("1")], { model: "claude-sonnet-5-5" });
  a.prompt("two"); a.response([text("2")], { model: "claude-sonnet-5-5" });
  writeSession(root, P, a);
  await new Promise((r) => setTimeout(r, 20));
  const c = new SessionBuilder("sess-cmd", { start: "2026-09-06T09:00:00.000Z" });
  c.user(cmd("model", "opus")); // typed as this session's first prompt (persists as the default model)
  c.prompt("go"); c.response([text("ok")], { model: "claude-opus-5-5" });
  writeSession(root, P, c);
  await new Promise((r) => setTimeout(r, 20));
  const b = new SessionBuilder("sess-resumed", { start: "2026-09-06T10:00:00.000Z" });
  replayInto(b, a.records); // resumes the OLD session: its history is on sonnet, its first response on opus
  b.prompt("continue"); b.response([text("ok")], { model: "claude-opus-5-5" });
  b.prompt("more"); b.response([text("ok")], { model: "claude-opus-5-5" });
  writeSession(root, P, b);
  const all = await scan(root);
  const ev = (k: string) => all.get(`${P}/${k}.jsonl`)!.result.events;
  assert.deepEqual(ev("sess-old"), []);
  assert.deepEqual(ev("sess-cmd").map(brief), [["model", "you", "strong", "command", "unknown", "claude-opus-5-5", true]]);
  assert.deepEqual(ev("sess-resumed"), [], "the resumed session's starting model is a between-session move, not an unknown in-session change");
  // Between sessions, attribution derives the move and the recorded command explains it: nothing is left unknown.
  const xs = [...all.values()].flatMap((s) => s.result.exchanges);
  const recorded = [...all.values()].flatMap((s) => s.result.events);
  assert.deepEqual(labelChangeEvents("claude-code", xs, recorded).filter((e) => e.kind === "model"), []);
  // Without the command anywhere, the same move stays visible — as a derived unknown, never silently dropped.
  const noCmd = xs.filter((x) => x.session !== hash("sess-cmd", "s-"));
  const derived = labelChangeEvents("claude-code", noCmd, []);
  assert.deepEqual(derived.filter((e) => e.kind === "model").map((e) => [e.side, e.from, e.to]), [["unknown", "claude-sonnet-5-5", "claude-opus-5-5"]]);
});

test("D63(ii): a resumed session whose /model re-picks its replayed history's model is still the user's change (from unknown)", async () => {
  // Found by the seed sweep: the old session ran on sonnet; meanwhile the default moved to opus elsewhere; the user
  // resumes the old session and types /model sonnet first. In-session nothing moves (sonnet → sonnet), but the
  // command chose the model this session runs on.
  const root = makeRoot();
  const a = new SessionBuilder("sess-stale", { start: "2026-09-05T09:00:00.000Z" });
  a.prompt("one"); a.response([text("1")], { model: "claude-sonnet-5-5" });
  writeSession(root, P, a);
  await new Promise((r) => setTimeout(r, 20));
  const b = new SessionBuilder("sess-repick", { start: "2026-09-08T09:00:00.000Z" });
  replayInto(b, a.records);
  b.user(cmd("model", "sonnet"));
  b.prompt("continue"); b.response([text("ok")], { model: "claude-sonnet-5-5" });
  b.prompt("more"); b.response([text("ok")], { model: "claude-sonnet-5-5" });
  writeSession(root, P, b);
  const all = await scan(root);
  assert.deepEqual(all.get(`${P}/sess-repick.jsonl`)!.result.events.map(brief), [["model", "you", "strong", "command", "unknown", "claude-sonnet-5-5", true]]);
  // Without the command, the same resume reports nothing (a between-session matter, as for a new session).
  const root2 = makeRoot();
  writeSession(root2, P, a);
  await new Promise((r) => setTimeout(r, 20));
  const c = new SessionBuilder("sess-plain-resume", { start: "2026-09-08T09:00:00.000Z" });
  replayInto(c, a.records);
  c.prompt("continue"); c.response([text("ok")], { model: "claude-sonnet-5-5" });
  writeSession(root2, P, c);
  assert.deepEqual((await scan(root2)).get(`${P}/sess-plain-resume.jsonl`)!.result.events, []);
});

// ───────────────────────────── seed sweep against the generator's truth ─────────────────────────────

const HASH = makeHash("d63-sweep-salt");

function sweepParams(seed: number, agentInitiatedRate: number): SynthParams {
  const you = (day: number, kind: "model" | "effort", to: string): ScheduleEvent => ({ day, agent: "claude-code", kind, to, by: "you" });
  return makeParams({
    // many-short: a session lives one day (a new or resumed one the next day); a few-long session stays open across days
    // and the generator moves it to the new model without a command, which the reader rightly reads as unknown.
    seed, days: 24, agents: ["claude-code"], shape: "many-short",
    exchangesPerDay: { "claude-code": seed % 3 === 0 ? 1.2 : 6, codex: 0 },
    initial: {
      "claude-code": { version: "2.1.250", model: "claude-opus-5-5", effort: "high", mode: "default", entrypoint: "cli" },
      codex: { version: "0.150.0", model: "gpt-6-luna", effort: "medium", mode: "on-request", entrypoint: "cli" },
    },
    noise: { ...makeParams({ seed: 0 }).noise, agentInitiatedRate, resumeRate: 0.6 },
    events: [
      you(2, "effort", "medium"), you(2, "model", "claude-sonnet-5-5"),
      you(6, "effort", "low"), you(7, "model", "claude-opus-5-5"),
      you(11, "model", "claude-sonnet-5-5"), you(13, "effort", "high"),
      you(17, "model", "claude-opus-5-5"), you(20, "effort", "medium"), you(20, "model", "claude-sonnet-5-5"),
    ],
  });
}

interface Miss { seed: string; date: string; kind: string; to: string; why: string }

test("D63 seed sweep: every typed /model and /effort has its you · strong event; no unknown model/effort event, recorded or derived", async () => {
  const misses: Miss[] = [];
  const extras: string[] = [];
  let checked = 0;
  for (const air of [0, 0.9]) {
    for (let seed = 1; seed <= 8; seed++) {
      const tag = `seed ${seed} / agent-initiated ${air}`;
      const g = generate(sweepParams(seed, air), `d63-${seed}`);
      const dir = mkdtempSync(join(tmpdir(), "wasitme-d63-"));
      try {
        writeTree(join(dir, "out"), g.files);
        clearPriorCache();
        const ctx: ParseContext = { hash: HASH, now: new Date("2026-12-01T00:00:00Z"), timeZone: "UTC" };
        const events: ChangeEvent[] = [];
        const exchanges: Exchange[] = [];
        await withRoot(join(dir, "out", "claude"), async () => {
          for (const src of claudeReader.list()) {
            const r = await claudeReader.parse(src, ctx);
            events.push(...r.events);
            exchanges.push(...r.exchanges);
          }
        });
        for (const e of g.truth.events) {
          if (e.agent !== "claude-code" || !e.userInitiated || (e.kind !== "model" && e.kind !== "effort")) continue;
          checked++;
          const hit = events.some((x) => x.kind === e.kind && x.side === "you" && x.strength === "strong" && x.to === e.to && x.day === e.date);
          if (!hit) {
            const same = events.filter((x) => x.kind === e.kind && x.to === e.to).map((x) => `${x.day}:${x.side}:${x.from}`);
            misses.push({ seed: tag, date: e.date, kind: e.kind, to: e.to, why: same.join(",") || "no event with that value" });
          }
        }
        for (const x of events) if ((x.kind === "model" || x.kind === "effort") && x.side === "unknown") extras.push(`${tag}: recorded ${x.kind} ${x.from}→${x.to} on ${x.day}`);
        const derived = labelChangeEvents("claude-code", exchanges, events);
        for (const x of derived) if (x.side === "unknown") extras.push(`${tag}: derived ${x.kind} ${x.from}→${x.to} on ${x.day}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  clearPriorCache();
  assert.ok(checked >= 16 * 9, `${checked} typed changes checked`);
  assert.deepEqual(misses, [], `typed changes without a you · strong event:\n${misses.map((m) => JSON.stringify(m)).join("\n")}`);
  assert.deepEqual(extras, [], `unknown model/effort events:\n${extras.join("\n")}`);
});
