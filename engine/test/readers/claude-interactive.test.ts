// Labelled-day classifier check (METHOD.md §2; WP-10Δ): synthetic days whose sessions carry a hand label
// (interactive / scripted / unknown). Every session must be classified as labelled, and every exchange of a
// session carries its session's class. 100% synthetic; real-log counts are WP-24a's job.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { InteractiveClass } from "../../src/types.js";
import { makeRoot, pause, projectPath, scan, SessionBuilder, text, toolUseBlock, writeJsonl, writeSession } from "../fixtures/claude/builder.js";

interface Labelled {
  day: string;
  label: InteractiveClass;
  /** What the session is, in words (the label's justification). */
  what: string;
  project?: string;
  build: (s: SessionBuilder) => void;
  entrypoint?: string | null;
}

const human = (s: SessionBuilder, p: string, promptSource?: string) => {
  s.prompt(p, { promptSource });
  s.response([text("synthetic answer")]);
};

const DAYS: Labelled[] = [
  // Day 1: a Desktop user's shape (prompts delivered through the SDK) plus a background `claude -p` job.
  { day: "2026-09-01", label: "interactive", what: "Desktop app, prompts via SDK", entrypoint: "claude-desktop", build: (s) => { human(s, "fix the flaky test", "sdk"); human(s, "now the docs", "sdk"); } },
  { day: "2026-09-01", label: "scripted", what: "claude -p title job", entrypoint: "sdk-cli", build: (s) => human(s, "summarise this in five words", "sdk") },
  // Day 2: terminal and IDE by hand; an Agent SDK script.
  { day: "2026-09-02", label: "interactive", what: "CLI, typed", entrypoint: "cli", build: (s) => human(s, "explain the parser", "typed") },
  { day: "2026-09-02", label: "interactive", what: "VS Code extension", entrypoint: "claude-vscode", build: (s) => human(s, "rename this symbol", "sdk") },
  { day: "2026-09-02", label: "scripted", what: "TypeScript Agent SDK loop", entrypoint: "sdk-ts", build: (s) => { human(s, "task 1 of 3"); human(s, "task 2 of 3"); human(s, "task 3 of 3"); } },
  // Day 3: an old CLI log without origin/promptSource; a Python SDK run; Claude Code serving as an MCP tool.
  {
    day: "2026-09-03", label: "interactive", what: "legacy CLI log (no origin, no promptSource)", entrypoint: "cli",
    build: (s) => { s.user("please tidy the imports"); s.response([text("done")]); },
  },
  { day: "2026-09-03", label: "scripted", what: "Python Agent SDK", entrypoint: "sdk-py", build: (s) => human(s, "classify these files") },
  { day: "2026-09-03", label: "scripted", what: "claude mcp serve, driven by another agent", entrypoint: "mcp", build: (s) => human(s, "run the linter") },
  // Day 4: the entrypoint field is missing.
  { day: "2026-09-04", label: "interactive", what: "no entrypoint, prompt typed at a keyboard", entrypoint: null, build: (s) => human(s, "what changed here?", "typed") },
  { day: "2026-09-04", label: "unknown", what: "no entrypoint, no keyboard evidence", entrypoint: null, build: (s) => human(s, "what changed here?") },
  // Day 5: contradictory or unrecognised fields never guess.
  {
    day: "2026-09-05", label: "unknown", what: "interactive and programmatic surfaces in one file", entrypoint: "cli",
    build: (s) => { human(s, "first by hand", "typed"); s.entrypoint = "sdk-cli"; human(s, "then by script"); },
  },
  { day: "2026-09-05", label: "unknown", what: "programmatic surface but a typed prompt", entrypoint: "sdk-cli", build: (s) => human(s, "typed into -p?", "typed") },
  { day: "2026-09-05", label: "unknown", what: "unrecognised surface", entrypoint: "claude-future", build: (s) => human(s, "hello", "sdk") },
  {
    day: "2026-09-05", label: "unknown", what: "Desktop surface, driven only by a task notification (no human prompt)", entrypoint: "claude-desktop",
    build: (s) => {
      s.user("<task-notification>background build finished</task-notification>", { origin: { kind: "task-notification" }, promptSource: "system" });
      s.response([text("the build finished")]);
    },
  },
  // Day 6: evidence that must not count — a sidechain aside and a subagent transcript on a programmatic surface.
  {
    day: "2026-09-06", label: "interactive", what: "Desktop session with an aside whose records say sdk-cli", entrypoint: "claude-desktop",
    build: (s) => {
      human(s, "start", "sdk");
      s.user("btw what is this?", { isSidechain: true, origin: { kind: "human" }, entrypoint: "sdk-cli", promptSource: "typed" });
      s.response([text("aside")], { extra: { isSidechain: true, entrypoint: "sdk-cli" } });
      human(s, "continue", "sdk");
    },
  },
  {
    day: "2026-09-06", label: "interactive", what: "Desktop session whose metadata records carry other surface names", entrypoint: "claude-desktop",
    build: (s) => {
      s.meta("bridge-session", { entrypoint: "bridge" });
      s.attachment({ type: "date", date: "2026-09-06" }, { entrypoint: "sdk-cli" });
      s.system("turn_duration", { entrypoint: "claude-future" });
      human(s, "go on", "sdk");
    },
  },
];

function session(l: Labelled, i: number): SessionBuilder {
  const s = new SessionBuilder(`sess-label-${String(i).padStart(2, "0")}`, { start: `${l.day}T09:00:00.000Z`, entrypoint: l.entrypoint ?? "cli" });
  if (l.entrypoint === null) (s as { entrypoint: string | undefined }).entrypoint = undefined; // field absent from every record
  l.build(s);
  return s;
}

test("labelled days: every synthetic session is classified as labelled; each exchange carries its session's class", async () => {
  const root = makeRoot();
  const P = "-synthetic-labelled";
  const built = DAYS.map((l, i) => ({ l, s: session(l, i) }));
  for (const { s } of built) writeSession(root, P, s);
  // A subagent transcript on a programmatic surface never classifies its parent session.
  const parent = built.find(({ l }) => l.day === "2026-09-01" && l.label === "interactive")!.s;
  const sub = new SessionBuilder("deadbeef", { start: "2026-09-01T09:00:05.000Z", entrypoint: "sdk-cli" });
  sub.response([toolUseBlock("s1", "Read", {})]);
  writeJsonl(join(projectPath(root, P), parent.id, "subagents", "agent-deadbeef.jsonl"), sub.records);

  const results = await scan(root);
  const confusion = new Map<string, number>();
  const days = new Map<string, { ok: number; all: number }>();
  for (const { l, s } of built) {
    const r = results.get(`${P}/${s.id}.jsonl`)!.result;
    assert.ok(r.exchanges.length > 0, `${l.what}: has exchanges`);
    const classes = new Set(r.exchanges.map((x) => x.interactiveClass));
    assert.equal(classes.size, 1, `${l.what}: one class per session`);
    const got = [...classes][0]!;
    confusion.set(`${l.label}->${got}`, (confusion.get(`${l.label}->${got}`) ?? 0) + 1);
    const d = days.get(l.day) ?? { ok: 0, all: 0 };
    d.all++;
    if (got === l.label) d.ok++;
    days.set(l.day, d);
    assert.equal(got, l.label, `${l.day} ${l.what}`);
  }
  assert.deepEqual([...confusion.keys()].filter((k) => k.split("->")[0] !== k.split("->")[1]), [], "confusion matrix is diagonal");
  assert.deepEqual([...days.values()].map((d) => d.ok === d.all), [true, true, true, true, true, true], "every labelled day fully correct");
  assert.deepEqual(
    Object.fromEntries(["interactive", "scripted", "unknown"].map((c) => [c, confusion.get(`${c}->${c}`) ?? 0])),
    { interactive: 7, scripted: 4, unknown: 5 },
  );
});

test("resume by script: the replayed interactive history never classifies the resumed file", async () => {
  const root = makeRoot();
  const P = "-synthetic-resume-class";
  const a = new SessionBuilder("sess-ra", { entrypoint: "claude-desktop" });
  human(a, "build the feature", "sdk");
  writeSession(root, P, a);
  await pause();
  // `claude -p --resume`: the new file replays A (same uuids), then a programmatic prompt.
  const b = new SessionBuilder("sess-rb", { start: "2026-09-02T10:00:00.000Z", entrypoint: "sdk-cli" });
  for (const r of a.records) b.push({ ...r, sessionId: b.id });
  human(b, "continue the build", "sdk");
  writeSession(root, P, b);
  const r = await scan(root);
  assert.deepEqual(r.get(`${P}/sess-ra.jsonl`)!.result.exchanges.map((x) => x.interactiveClass), ["interactive"]);
  assert.deepEqual(r.get(`${P}/sess-rb.jsonl`)!.result.exchanges.map((x) => x.interactiveClass), ["scripted"]);
});

test("queued mid-turn prompts are human evidence: an IDE session whose only typed input arrived mid-turn", async () => {
  const s = new SessionBuilder("sess-queued-only", { entrypoint: "claude-vscode" });
  s.user("<task-notification>tests finished</task-notification>", { origin: { kind: "task-notification" } });
  s.response([toolUseBlock("t1", "Bash", {})]);
  s.attachment({ type: "queued_command", prompt: "also fix the lint", commandMode: "prompt", origin: { kind: "human" } });
  s.toolResult("t1");
  s.response([text("done")]);
  const root = makeRoot();
  writeSession(root, "-synthetic-queued", s);
  const r = [...(await scan(root)).values()][0]!.result;
  assert.deepEqual(r.exchanges.map((x) => [x.humanPrompt, x.queuedMidTurn, x.interactiveClass]), [[0, 1, "interactive"]]);
});
