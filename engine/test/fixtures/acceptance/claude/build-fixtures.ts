/**
 * Deterministic generator for the Claude Code reader acceptance fixtures (see README.md here).
 *
 * Everything is 100% synthetic — written by hand from the field names/enums a counts-only check of
 * real logs found, never copied from real logs. Every free-text field
 * carries a privacy sentinel (TESTSECRET, /Users/alice/secret-project, sk-ant-TESTSECRET123) so the
 * privacy test can prove none of it reaches reader output.
 *
 * Regenerate (the drift test fails if the committed files differ from this script's output):
 *   npm run build -w engine && node engine/dist/test/fixtures/acceptance/claude/build-fixtures.js
 *
 * Importing this module has no side effects; it only writes when run as the main script.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------- sentinels

export const SECRET = "sk-ant-TESTSECRET123";
export const SECRET_DIR = "/Users/alice/secret-project";
const SECRET_BRANCH = "feature/TESTSECRET-branch";
const SECRET_SLUG = "secret-slug-TESTSECRET";
/** Substrings that must never appear anywhere in a reader's output. */
export const SENTINELS = ["TESTSECRET", "sk-ant-", "/Users/alice", "secret-project", "alice"];

// ---------------------------------------------------------------- scenario registry

const P_MAIN = "-Users-alice-secret-project";
const P_MODERN = "-Users-alice-secret-project-modern";
const P_TOOLS = "-Users-alice-secret-project-tools";
const P_USAGE = "-Users-alice-secret-project-usage";
const P_SUB = "-Users-alice-secret-project-subagents";
const P_RESUME = "-Users-alice-secret-project-resume";
const P_ROBUST = "-Users-alice-secret-project-robust";
const P_LABELS = "-Users-alice-secret-project-labels";

const sid = (n: number) => `c1a0de00-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Every main session file: project folder (encoded cwd) + session id (= file name). */
export const SCENARIOS = {
  basic: { project: P_MAIN, session: sid(1) },
  filters: { project: P_MAIN, session: sid(2) },
  modern: { project: P_MODERN, session: sid(3) },
  tools: { project: P_TOOLS, session: sid(4) },
  usage: { project: P_USAGE, session: sid(5) },
  subagents: { project: P_SUB, session: sid(6) },
  resumeA: { project: P_RESUME, session: sid(7) },
  resumeB: { project: P_RESUME, session: sid(8) },
  unicode: { project: P_ROBUST, session: sid(9) },
  damaged: { project: P_ROBUST, session: sid(10) },
  clock: { project: P_ROBUST, session: sid(11) },
  drift: { project: P_ROBUST, session: sid(12) },
  empty: { project: P_ROBUST, session: sid(13) },
  labels: { project: P_LABELS, session: sid(14) },
  labelsDirty: { project: P_LABELS, session: sid(15) },
} as const;
export type ScenarioName = keyof typeof SCENARIOS;

/** Subagent ids (file names are agent-<id>.jsonl). */
export const AGENT_DIRECT = "a1b2c3d4e5f60718";
export const AGENT_NESTED = "b5e6f7a8b9c0d1e2";

/** Prompt texts whose lengths tests assert (promptChars = JS string length of the prompt text). */
export const PROMPTS = {
  basic0: `Add input validation to the signup form in ${SECRET_DIR}/src/signup.ts — the API key ${SECRET} must never be logged`,
  basic1: "no, that broke the login page — the email check rejects valid addresses",
  basic2: "Now add a unit test for the signup validation",
  basic3: "Now add a unit test for the signup validation please",
  image1: "[Image #1] the header overlaps the logo on mobile, fix the CSS",
  modern1: "Deploy the staging build and report the URL",
  image2: "[Image #2] this chart's legend is cut off",
  unicode0: "Rename the helper then update every call site and rerun the tests",
  unicode1: "Update the README as well",
} as const;

// ---------------------------------------------------------------- record builders

const at = (day: string, hms: string) => `${day}T${hms}.000Z`;
const text = (t: string): Rec => ({ type: "text", text: t });
const thinking = (t: string, sigLen: number, ch: string): Rec => ({ type: "thinking", thinking: t, signature: ch.repeat(sigLen) });
const toolUse = (id: string, name: string, input: Rec): Rec => ({ type: "tool_use", id, name, input });
const image = (): Rec => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoTESTSECRETAAAA" } });

interface Usage { in: number; out: number; cr?: number; cw?: number }
const usage = (u: Usage): Rec => ({
  input_tokens: u.in,
  cache_creation_input_tokens: u.cw ?? 0,
  cache_read_input_tokens: u.cr ?? 0,
  cache_creation: { ephemeral_5m_input_tokens: u.cw ?? 0, ephemeral_1h_input_tokens: 0 },
  output_tokens: u.out,
  service_tier: "standard",
});

const LEGACY_REJECT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

interface SessionOpts {
  version: string;
  entrypoint: string;
  mode: string;
  model: string;
  /** undefined = legacy logs without an `effort` field. */
  effort?: string;
  /** Subagent transcript: every record isSidechain + agentId; the first record has parentUuid null. */
  agentId?: string;
}

interface AssistantOpts {
  /** requestId; null = record has no requestId (gateway / relay logs). */
  req: string | null;
  msg: string;
  content: Rec[];
  usage: Usage;
  stop?: string | null;
  model?: string;
  effort?: string;
  extra?: Rec;
}

class Session {
  readonly lines: string[] = [];
  private n = 0;
  private last: string | null = null;
  private tail = "";
  version: string;
  entrypoint: string;
  mode: string;
  model: string;
  effort: string | undefined;

  constructor(readonly id: string, private readonly tag: string, private readonly o: SessionOpts) {
    this.version = o.version;
    this.entrypoint = o.entrypoint;
    this.mode = o.mode;
    this.model = o.model;
    this.effort = o.effort;
  }

  /** Deterministic RFC-4122-shaped record uuid, unique per session tag. */
  private uuid(): string {
    this.n++;
    return `${this.tag}-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
  }

  get lastUuid(): string | null { return this.last; }
  chainFrom(uuid: string | null): void { this.last = uuid; }

  private base(type: string, t: string, extra: Rec): Rec {
    const uuid = this.uuid();
    const r: Rec = {
      parentUuid: this.last,
      isSidechain: this.o.agentId !== undefined,
      userType: "external",
      cwd: SECRET_DIR,
      sessionId: this.id,
      version: this.version,
      gitBranch: SECRET_BRANCH,
      slug: SECRET_SLUG,
      entrypoint: this.entrypoint,
      ...(this.o.agentId !== undefined ? { agentId: this.o.agentId } : {}),
      type,
      uuid,
      timestamp: t,
      ...extra,
    };
    this.last = uuid;
    return this.push(r);
  }

  push(r: Rec): Rec {
    this.lines.push(JSON.stringify(r));
    return r;
  }

  /** Any non-message record (summary, cost-state, queue-operation, …) written verbatim. */
  other(r: Rec): Rec { return this.push({ ...r, sessionId: r.sessionId ?? this.id }); }

  rawLine(s: string): void { this.lines.push(s); }

  /** Final line cut off mid-write: no trailing newline. */
  truncatedTail(s: string): void { this.tail = s; }

  /** A real human prompt. Legacy shape: string content, no origin. Modern: origin.kind human + text blocks. */
  prompt(t: string, body: string, o: { modern?: boolean; blocks?: Rec[]; extra?: Rec } = {}): Rec {
    const content = o.blocks ?? (o.modern ? [text(body)] : body);
    const modern = o.modern ? { origin: { kind: "human" }, promptSource: "typed", promptId: `${this.tag}-p${this.n + 1}-0000-4000-8000-000000000000` } : {};
    return this.base("user", t, { message: { role: "user", content }, ...modern, permissionMode: this.mode, ...o.extra });
  }

  /** Any other user record (meta, interrupts, notifications, command output, …). */
  user(t: string, content: unknown, extra: Rec = {}): Rec {
    return this.base("user", t, { message: { role: "user", content }, ...extra });
  }

  assistant(t: string, o: AssistantOpts): Rec {
    const effort = o.effort ?? this.effort;
    return this.base("assistant", t, {
      message: {
        id: o.msg,
        type: "message",
        role: "assistant",
        model: o.model ?? this.model,
        content: o.content,
        stop_reason: o.stop ?? null,
        stop_sequence: null,
        usage: usage(o.usage),
      },
      ...(o.req === null ? {} : { requestId: o.req }),
      ...(effort === undefined ? {} : { effort }),
      ...o.extra,
    });
  }

  toolResult(t: string, toolUseId: string, content: unknown, o: { isError?: boolean; denial?: string; tur?: unknown; extra?: Rec } = {}): Rec {
    const source = this.last;
    return this.base("user", t, {
      message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content, ...(o.isError ? { is_error: true } : {}) }] },
      toolUseResult: o.tur ?? (typeof content === "string" ? (o.isError ? `Error: ${content}` : content) : { status: "completed" }),
      ...(o.denial ? { toolDenialKind: o.denial } : {}),
      sourceToolAssistantUUID: source,
      ...o.extra,
    });
  }

  system(t: string, subtype: string, extra: Rec = {}): Rec {
    return this.base("system", t, { subtype, level: "info", ...extra });
  }

  attachment(t: string, attachment: Rec, extra: Rec = {}): Rec {
    return this.base("attachment", t, { attachment, ...extra });
  }

  /** Re-log an existing record (compaction / resume / sidechain replay) with overrides. */
  replay(r: Rec, overrides: Rec): Rec {
    const copy = { ...(JSON.parse(JSON.stringify(r)) as Rec), ...overrides };
    if (typeof copy.uuid === "string") this.last = copy.uuid;
    return this.push(copy);
  }

  /** Fresh uuid for a replay that gets a new identity. */
  newUuid(): string { return this.uuid(); }

  content(): string {
    return this.lines.map((l) => l + "\n").join("") + this.tail;
  }
}

/** Short deterministic ids: req_011C<TAG><n>, msg_01<TAG><n>, toolu_01<TAG><n>. */
const ids = (tag: string) => ({
  req: (n: number) => `req_011C${tag}${String(n).padStart(4, "0")}`,
  msg: (n: number) => `msg_01${tag}${String(n).padStart(4, "0")}`,
  tool: (n: number) => `toolu_01${tag}${String(n).padStart(4, "0")}`,
});

// ---------------------------------------------------------------- scenarios

/** basic — the happy path: 4 exchanges, constant labels, no edge cases. */
function basic(): Session {
  const s = new Session(SCENARIOS.basic.session, "e0000001", { version: "2.1.288", entrypoint: "claude-desktop", mode: "default", model: "claude-opus-5-5", effort: "high" });
  const { req, msg, tool } = ids("BAS");
  const D = "2026-09-15";
  const F = `${SECRET_DIR}/src/signup.ts`;
  // E0: Read F, Edit F (not blind: read earlier in the exchange)
  s.prompt(at(D, "10:00:00"), PROMPTS.basic0);
  s.assistant(at(D, "10:00:05"), { req: req(1), msg: msg(1), content: [text("I'll read the form first."), toolUse(tool(1), "Read", { file_path: F })], usage: { in: 1200, out: 80, cr: 5000, cw: 300 }, stop: "tool_use" });
  s.toolResult(at(D, "10:00:06"), tool(1), `export function signup(form) {\n  const key = "${SECRET}";\n}`);
  s.assistant(at(D, "10:00:20"), { req: req(2), msg: msg(2), content: [toolUse(tool(2), "Edit", { file_path: F, old_string: `const key = "${SECRET}";`, new_string: "// key removed" })], usage: { in: 50, out: 200, cr: 6200, cw: 0 }, stop: "tool_use" });
  s.toolResult(at(D, "10:00:21"), tool(2), `The file ${F} has been updated.`);
  s.assistant(at(D, "10:00:30"), { req: req(3), msg: msg(3), content: [text("Done — validation added and the key is no longer logged.")], usage: { in: 20, out: 60, cr: 6400, cw: 100 }, stop: "end_turn" });
  // E1: pushback prompt; Grep, Read F, Edit F
  s.prompt(at(D, "10:05:00"), PROMPTS.basic1);
  s.assistant(at(D, "10:05:04"), { req: req(4), msg: msg(4), content: [toolUse(tool(3), "Grep", { pattern: "validateEmail", path: `${SECRET_DIR}/src` })], usage: { in: 30, out: 40, cr: 7000, cw: 200 }, stop: "tool_use" });
  s.toolResult(at(D, "10:05:05"), tool(3), `${F}:12:export function validateEmail(`);
  s.assistant(at(D, "10:05:08"), { req: req(5), msg: msg(5), content: [toolUse(tool(4), "Read", { file_path: F })], usage: { in: 20, out: 35, cr: 7200, cw: 0 }, stop: "tool_use" });
  s.toolResult(at(D, "10:05:09"), tool(4), "export function validateEmail(s) { return /^\\S+$/.test(s); }");
  s.assistant(at(D, "10:05:15"), { req: req(6), msg: msg(6), content: [toolUse(tool(5), "Edit", { file_path: F, old_string: "/^\\S+$/", new_string: "/^[^@\\s]+@[^@\\s]+$/" })], usage: { in: 30, out: 150, cr: 7300, cw: 0 }, stop: "tool_use" });
  s.toolResult(at(D, "10:05:16"), tool(5), `The file ${F} has been updated.`);
  s.assistant(at(D, "10:05:25"), { req: req(7), msg: msg(7), content: [text("Fixed: the regex now accepts plus-addressing.")], usage: { in: 10, out: 30, cr: 7500, cw: 0 }, stop: "end_turn" });
  // E2: neutral prompt; Bash
  s.prompt(at(D, "10:10:00"), PROMPTS.basic2);
  s.assistant(at(D, "10:10:08"), { req: req(8), msg: msg(8), content: [toolUse(tool(6), "Bash", { command: `cd ${SECRET_DIR} && npm test -- signup`, description: "Run signup tests" })], usage: { in: 40, out: 90, cr: 7600, cw: 0 }, stop: "tool_use" });
  s.toolResult(at(D, "10:10:20"), tool(6), "Tests: 12 passed, 12 total");
  s.assistant(at(D, "10:10:26"), { req: req(9), msg: msg(9), content: [text("All 12 signup tests pass.")], usage: { in: 10, out: 50, cr: 7700, cw: 0 }, stop: "end_turn" });
  // E3: near-duplicate of E2's prompt (implicit pushback), no tools
  s.prompt(at(D, "10:15:00"), PROMPTS.basic3);
  s.assistant(at(D, "10:15:09"), { req: req(10), msg: msg(10), content: [text("Added test/signup.test.ts with three cases.")], usage: { in: 15, out: 70, cr: 7800, cw: 0 }, stop: "end_turn" });
  return s;
}

/** filters — legacy-shaped records (no origin field): every non-prompt user record kind from research/05 #7, #9, #10. */
function filters(): Session {
  const s = new Session(SCENARIOS.filters.session, "e0000002", { version: "2.1.205", entrypoint: "cli", mode: "default", model: "claude-sonnet-5" });
  const { req, msg, tool } = ids("FLT");
  const D = "2026-09-18";
  const CSS = `${SECRET_DIR}/styles/header.css`;
  s.user(at(D, "09:00:00"), "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>", { isMeta: true });
  s.user(at(D, "09:00:01"), "<local-command-stdout>Logged in as alice@example.com (TESTSECRET org)</local-command-stdout>");
  // E0: legacy "[Image #1] …" prompt (text + image block), list-form interrupt
  s.prompt(at(D, "09:01:00"), PROMPTS.image1, { blocks: [text(PROMPTS.image1), image()], extra: { imagePasteIds: [1] } });
  s.assistant(at(D, "09:01:05"), { req: req(1), msg: msg(1), content: [toolUse(tool(1), "Read", { file_path: CSS })], usage: { in: 900, out: 60, cr: 0, cw: 4000 }, stop: "tool_use" });
  s.toolResult(at(D, "09:01:06"), tool(1), ".header { position: absolute; } /* TESTSECRET */");
  s.user(at(D, "09:01:20"), [text("[Request interrupted by user]")]);
  // Claude Code's local stub after an interrupt: model <synthetic>, no requestId, NOT an API error — not a response.
  s.assistant(at(D, "09:01:21"), { req: null, msg: "8d2c1f0e-4b3a-4c5d-8e9f-0a1b2c3d4e5f", model: "<synthetic>", content: [text("No response requested.")], usage: { in: 0, out: 0 }, stop: "stop_sequence" });
  s.user(at(D, "09:02:00"), `This session is being continued from a previous conversation that ran out of context. The conversation is summarized below: alice was fixing ${CSS} (TESTSECRET).`);
  // E1: skill expansion (isMeta), legacy text-only rejection, string-form "for tool use" interrupt, then injected non-prompts
  s.prompt(at(D, "09:03:00"), "Use flexbox for the header instead");
  s.user(at(D, "09:03:01"), `Base directory for this skill: ${SECRET_DIR}/.claude/skills/css-helper\n\n# CSS helper (TESTSECRET)\nAlways prefer flexbox.`, { isMeta: true });
  s.assistant(at(D, "09:03:04"), { req: req(2), msg: msg(2), content: [toolUse(tool(2), "Edit", { file_path: CSS, old_string: "position: absolute;", new_string: "display: flex;" })], usage: { in: 50, out: 90, cr: 4000, cw: 0 }, stop: "tool_use" });
  s.toolResult(at(D, "09:03:08"), tool(2), LEGACY_REJECT, { isError: true });
  s.user(at(D, "09:03:10"), "[Request interrupted by user for tool use]");
  s.user(at(D, "09:03:30"), "<task-notification>\n<task-id>bash_7</task-id>\n<status>completed</status>\n<summary>Background command \"npm run dev\" completed (exit code 0) TESTSECRET</summary>\n</task-notification>");
  s.user(at(D, "09:03:31"), `Stop hook feedback:\n- [eslint]: ${CSS}: 2 problems`);
  s.user(at(D, "09:03:32"), "<system-reminder>\nThe TodoWrite tool hasn't been used recently. TESTSECRET\n</system-reminder>");
  s.user(at(D, "09:03:33"), `<ide_opened_file>The user opened the file ${CSS} in the IDE. This may or may not be related to the current task.</ide_opened_file>`);
  // E2: pushback prompt; legacy string-content tool-result carrier; two list-form interrupts (flag stays 1)
  s.prompt(at(D, "09:04:00"), "Why did you stop? Keep going with the flexbox change");
  s.assistant(at(D, "09:04:05"), { req: req(3), msg: msg(3), content: [toolUse(tool(3), "LS", { path: `${SECRET_DIR}/styles` })], usage: { in: 40, out: 30, cr: 4100, cw: 0 }, stop: "tool_use" });
  s.user(at(D, "09:04:06"), `- ${SECRET_DIR}/styles/\n  - header.css\n  - TESTSECRET.css`, { toolUseResult: { stdout: `- ${SECRET_DIR}/styles/`, stderr: "", interrupted: false, isImage: false } });
  s.user(at(D, "09:04:07"), [text("[Request interrupted by user]")]);
  s.assistant(at(D, "09:04:08"), { req: req(4), msg: msg(4), content: [text("Stopping as requested.")], usage: { in: 10, out: 12, cr: 4200, cw: 0 }, stop: null });
  s.user(at(D, "09:04:09"), [text("[Request interrupted by user]")]);
  return s;
}

/** modern — origin.kind shapes: agent-initiated start, queued_command (string + blocks, + queue-operation twins), peer, [Image, interrupt with origin human. */
function modern(): Session {
  const s = new Session(SCENARIOS.modern.session, "e0000003", { version: "2.1.289", entrypoint: "claude-desktop", mode: "auto", model: "claude-opus-5-5", effort: "medium" });
  const { req, msg, tool } = ids("MOD");
  const D = "2026-09-20";
  // X0: agent-initiated stretch (task notification → assistant work) before any human prompt
  s.user(at(D, "08:00:00"), [text("<task-notification>\n<task-id>bg_9</task-id>\n<status>completed</status>\n<summary>Build finished TESTSECRET</summary>\n</task-notification>")], { origin: { kind: "task-notification" }, promptSource: "system" });
  s.assistant(at(D, "08:00:05"), { req: req(1), msg: msg(1), content: [text("The background build finished; here is the summary.")], usage: { in: 100, out: 50, cr: 2000, cw: 0 }, stop: "end_turn" });
  // E1: two real queued prompts (string, blocks) each with queue-operation twins; one isMeta and one peer queued_command (skip)
  s.prompt(at(D, "08:10:00"), PROMPTS.modern1, { modern: true });
  s.assistant(at(D, "08:10:05"), { req: req(2), msg: msg(2), content: [toolUse(tool(1), "Bash", { command: `./deploy.sh staging --token ${SECRET}` })], usage: { in: 200, out: 100, cr: 3000, cw: 100 }, stop: "tool_use" });
  s.other({ type: "queue-operation", operation: "enqueue", timestamp: at(D, "08:10:06"), content: "also bump the version number" });
  s.attachment(at(D, "08:10:06"), { type: "queued_command", prompt: "also bump the version number" });
  s.other({ type: "queue-operation", operation: "dequeue", timestamp: at(D, "08:10:06") });
  s.toolResult(at(D, "08:10:08"), tool(1), "Deployed to https://staging.TESTSECRET.example.com");
  s.other({ type: "queue-operation", operation: "enqueue", timestamp: at(D, "08:10:09"), content: "and post the URL in the channel" });
  s.attachment(at(D, "08:10:09"), { type: "queued_command", prompt: [text("and post the URL in the channel")] });
  s.other({ type: "queue-operation", operation: "dequeue", timestamp: at(D, "08:10:09") });
  s.attachment(at(D, "08:10:10"), { type: "queued_command", prompt: "<system-reminder>internal TESTSECRET</system-reminder>" }, { isMeta: true });
  s.attachment(at(D, "08:10:11"), { type: "queued_command", prompt: "message relayed from the planner agent TESTSECRET", origin: { kind: "peer" } }, { origin: { kind: "peer" } });
  s.assistant(at(D, "08:10:20"), { req: req(3), msg: msg(3), content: [text("Deployed; bumped the version and posted the URL.")], usage: { in: 50, out: 80, cr: 3200, cw: 0 }, stop: "end_turn" });
  // a peer message (another agent) is not a human prompt; the reply stays in E1
  s.user(at(D, "08:15:00"), [text("<peer-message from=\"planner\">handoff: TESTSECRET plan ready</peer-message>")], { origin: { kind: "peer" } });
  s.assistant(at(D, "08:15:05"), { req: req(4), msg: msg(4), content: [text("Acknowledged the planner's handoff.")], usage: { in: 30, out: 20, cr: 3300, cw: 0 }, stop: "end_turn" });
  // E2: modern "[Image #2] …" prompt; interrupt record that also carries origin.kind human
  s.prompt(at(D, "08:20:00"), PROMPTS.image2, { modern: true, blocks: [text(PROMPTS.image2), image()], extra: { imagePasteIds: [2] } });
  s.assistant(at(D, "08:20:04"), { req: req(5), msg: msg(5), content: [text("Looking at the legend layout")], usage: { in: 400, out: 45, cr: 3400, cw: 1500 }, stop: null });
  s.user(at(D, "08:20:05"), [text("[Request interrupted by user]")], { origin: { kind: "human" } });
  // E3: IDE selection block + typed text in one human prompt
  s.prompt(at(D, "08:21:00"), "wrap the legend instead", { modern: true, blocks: [text(`<ide_selection>The user selected the lines 1 to 4 from ${SECRET_DIR}/chart.ts:\nlegend: { position: 'right' }\n</ide_selection>`), text("wrap the legend instead")] });
  s.assistant(at(D, "08:21:05"), { req: req(6), msg: msg(6), content: [text("Done: the legend now wraps.")], usage: { in: 20, out: 25, cr: 5000, cw: 0 }, stop: "end_turn" });
  return s;
}

/** tools — tool outcomes (error / user-rejected / automode-blocked / permission-rule), reads, edits, blind edits, churn. */
function tools(): Session {
  const s = new Session(SCENARIOS.tools.session, "e0000004", { version: "2.1.289", entrypoint: "claude-desktop", mode: "auto", model: "claude-opus-5-5", effort: "high" });
  const { req, msg, tool } = ids("TLS");
  const D = "2026-09-22";
  const f = (n: string) => `${SECRET_DIR}/src/pay/${n}.ts`;
  const u: Usage = { in: 10, out: 20, cr: 1000, cw: 0 };
  let r = 0;
  let k = 0;
  /** One response with one tool call at hh:mm:ss, its result one second later. */
  const call = (hms: string, hmsResult: string, name: string, input: Rec, result: string, o: { isError?: boolean; denial?: string } = {}) => {
    r++; k++;
    s.assistant(at(D, hms), { req: req(r), msg: msg(r), content: [toolUse(tool(k), name, input)], usage: u, stop: "tool_use" });
    s.toolResult(at(D, hmsResult), tool(k), result, o);
  };
  const ok = "ok";
  // E0
  s.prompt(at(D, "14:00:00"), "Refactor the payment module to use the new client");
  call("14:00:10", "14:00:11", "Read", { file_path: f("a") }, `// ${SECRET}`);                                  // #1 read a
  call("14:00:20", "14:00:21", "Edit", { file_path: f("a"), old_string: "x", new_string: "y" }, ok);           // #2 edit a
  call("14:00:30", "14:00:31", "Edit", { file_path: f("b"), old_string: "x", new_string: "y" }, ok);           // #3 edit b — BLIND
  call("14:00:40", "14:00:41", "Bash", { command: "npm test" }, "Exit code 1\nFAIL test/pay.test.ts\n  ● charges TESTSECRET card", { isError: true }); // #4 tool error
  call("14:00:50", "14:00:51", "Edit", { file_path: f("a"), old_string: "y", new_string: "z" }, ok);           // #5 edit a (2nd)
  call("14:01:00", "14:01:01", "Edit", { file_path: f("a"), old_string: "z", new_string: "w" }, ok);           // #6 edit a (3rd → churn)
  call("14:01:10", "14:01:11", "Read", { file_path: f("c") }, ok);                                              // #7 read c
  call("14:01:20", "14:01:21", "Edit", { file_path: f("c"), old_string: "x", new_string: "y" }, LEGACY_REJECT, { isError: true, denial: "user-rejected" }); // #8 rejection
  call("14:01:30", "14:01:31", "Bash", { command: "rm -rf build" }, "Permission for this action has been denied. Reason: the auto mode classifier flagged a destructive command.", { isError: true, denial: "automode-blocked" }); // #9 blocked
  call("14:01:40", "14:01:41", "WebFetch", { url: "https://TESTSECRET.example.com/api", prompt: "read it" }, `Permission to use WebFetch has been denied because of a permission rule in ${SECRET_DIR}/.claude/settings.json`, { isError: true, denial: "permission-rule" }); // #10 blocked
  // #11 + #12: one response streamed as two lines (same requestId/message.id, identical usage), two tool_use blocks
  r++;
  s.assistant(at(D, "14:01:50"), { req: req(r), msg: msg(r), content: [toolUse(tool(11), "Glob", { pattern: "src/pay/**/*.ts" })], usage: u, stop: null });
  s.assistant(at(D, "14:01:51"), { req: req(r), msg: msg(r), content: [toolUse(tool(12), "Grep", { pattern: "charge\\(", path: `${SECRET_DIR}/src/pay` })], usage: u, stop: "tool_use" });
  s.toolResult(at(D, "14:01:52"), tool(11), `${f("a")}\n${f("c")}`);
  s.toolResult(at(D, "14:01:53"), tool(12), `${f("c")}:3: charge(`);
  k = 12;
  call("14:02:00", "14:02:01", "MultiEdit", { file_path: f("c"), edits: [{ old_string: "x", new_string: "y" }] }, ok); // #13 edit c (read at #7)
  call("14:02:10", "14:02:11", "Edit", { file_path: f("e"), old_string: "x", new_string: "y" }, ok);           // #14 edit e — BLIND
  call("14:02:20", "14:02:21", "Read", { file_path: f("f") }, ok);                                              // #15 read f
  r++;
  s.assistant(at(D, "14:02:30"), { req: req(r), msg: msg(r), content: [text("Refactor done.")], usage: u, stop: "end_turn" });
  // E1
  s.prompt(at(D, "14:30:00"), "Also fix the refund path");
  call("14:30:10", "14:30:11", "Edit", { file_path: f("f"), old_string: "x", new_string: "y" }, ok);           // read f was the previous tool call → not blind
  call("14:30:20", "14:30:21", "Edit", { file_path: f("a"), old_string: "w", new_string: "v" }, ok);           // read a was 15 calls ago, previous exchange → BLIND
  call("14:30:30", "14:30:31", "Read", { file_path: f("g") }, ok);
  call("14:30:40", "14:30:41", "Edit", { file_path: f("g"), old_string: "x", new_string: "y" }, ok);
  r++;
  s.assistant(at(D, "14:30:50"), { req: req(r), msg: msg(r), content: [text("Refund path fixed.")], usage: u, stop: "end_turn" });
  return s;
}

/** usage — streaming splits (MAX output), missing requestId, synthetic API errors vs retries, thinking, compaction + replay. */
function usageScenario(): Session {
  const s = new Session(SCENARIOS.usage.session, "e0000005", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-opus-5-5", effort: "high" });
  const { req, msg, tool } = ids("USG");
  const D = "2026-09-25";
  const W = `${SECRET_DIR}/warmer.ts`;
  // E0: response 1 streamed over 3 lines (out 12, 12, 310); response 2 over 3 lines (out 25, 520, 515 — MAX is not last); response 3 single line
  s.prompt(at(D, "09:00:00"), "Explain why the cache warmer is slow");
  s.assistant(at(D, "09:00:04"), { req: req(1), msg: msg(1), content: [thinking("", 400, "S")], usage: { in: 3000, out: 12, cr: 0, cw: 9000 }, stop: null });
  s.assistant(at(D, "09:00:06"), { req: req(1), msg: msg(1), content: [text("Looking at the warmer loop in the TESTSECRET service.")], usage: { in: 3000, out: 12, cr: 0, cw: 9000 }, stop: null });
  s.assistant(at(D, "09:00:09"), { req: req(1), msg: msg(1), content: [toolUse(tool(1), "Read", { file_path: W })], usage: { in: 3000, out: 310, cr: 0, cw: 9000 }, stop: "tool_use" });
  s.toolResult(at(D, "09:00:10"), tool(1), "for (const k of keys) await refetch(k)");
  s.assistant(at(D, "09:00:15"), { req: req(2), msg: msg(2), content: [thinking(`Considering the TTL path for ${SECRET} keys`, 1000, "T")], usage: { in: 40, out: 25, cr: 12000, cw: 0 }, stop: null });
  s.assistant(at(D, "09:00:18"), { req: req(2), msg: msg(2), content: [text("The warmer refetches every key on each tick.")], usage: { in: 40, out: 520, cr: 12000, cw: 0 }, stop: null });
  s.assistant(at(D, "09:00:19"), { req: req(2), msg: msg(2), content: [text("Batching would fix it.")], usage: { in: 40, out: 515, cr: 12000, cw: 0 }, stop: null });
  s.assistant(at(D, "09:00:30"), { req: req(3), msg: msg(3), content: [thinking("", 600, "U"), text("Summary: batch the refetches.")], usage: { in: 10, out: 90, cr: 12500, cw: 0 }, stop: "end_turn" });
  // E1: three retries, then a final synthetic API error stub
  s.prompt(at(D, "09:05:00"), "Try the fix with a shorter TTL");
  for (const [n, hms] of [[1, "09:05:02"], [2, "09:05:03"], [3, "09:05:05"]] as const) {
    s.system(at(D, hms), "api_error", { level: "error", error: { status: 529, error: { type: "overloaded_error", message: "Overloaded" } }, retryInMs: 1000 * n, retryAttempt: n, maxRetries: 10 });
  }
  s.assistant(at(D, "09:05:09"), {
    req: null, msg: "5f1e0b7a-3c2d-4e8f-9a6b-1c0d2e3f4a5b", model: "<synthetic>",
    content: [text("API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}")],
    usage: { in: 0, out: 0, cr: 0, cw: 0 }, stop: "stop_sequence",
    extra: { isApiErrorMessage: true, apiErrorStatus: 529, error: "unknown" },
  });
  // E2: two retries that then succeed
  s.prompt(at(D, "09:10:00"), "Run the benchmark again");
  s.system(at(D, "09:10:02"), "api_error", { level: "error", error: { status: 429 }, retryInMs: 500, retryAttempt: 1, maxRetries: 10 });
  s.system(at(D, "09:10:04"), "api_error", { level: "error", error: { status: 429 }, retryInMs: 1000, retryAttempt: 2, maxRetries: 10 });
  s.assistant(at(D, "09:10:08"), { req: req(4), msg: msg(4), content: [text("Benchmark: 41ms p50.")], usage: { in: 20, out: 60, cr: 13000, cw: 0 }, stop: "end_turn" });
  // E3: gateway logs — no requestId; two DIFFERENT responses share one message.id (distinct timestamps/usage)
  s.prompt(at(D, "09:15:00"), "Continue the refactor");
  s.assistant(at(D, "09:15:05"), { req: null, msg: "msg_01USGRELAY", content: [toolUse(tool(2), "Bash", { command: "npm run build" })], usage: { in: 100, out: 30, cr: 0, cw: 0 }, stop: "tool_use" });
  s.toolResult(at(D, "09:15:10"), tool(2), "built");
  s.assistant(at(D, "09:15:20"), { req: null, msg: "msg_01USGRELAY", content: [toolUse(tool(3), "Bash", { command: "npm run lint" })], usage: { in: 110, out: 45, cr: 0, cw: 0 }, stop: "tool_use" });
  s.toolResult(at(D, "09:15:25"), tool(3), "clean");
  s.assistant(at(D, "09:15:30"), { req: null, msg: msg(5), content: [text("All parts done.")], usage: { in: 120, out: 50, cr: 0, cw: 0 }, stop: "end_turn" });
  // E4: auto-compaction mid-exchange; the last assistant + tool_result are re-logged with NEW uuids (same parentUuid/timestamp)
  s.prompt(at(D, "09:20:00"), "Summarize what changed");
  const a6 = s.assistant(at(D, "09:20:05"), { req: req(6), msg: msg(6), content: [toolUse(tool(4), "Read", { file_path: W })], usage: { in: 30, out: 40, cr: 14000, cw: 0 }, stop: "tool_use" });
  const r6 = s.toolResult(at(D, "09:20:06"), tool(4), "batched()");
  s.system(at(D, "09:20:10"), "compact_boundary", { content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 160000 } });
  s.user(at(D, "09:20:11"), `This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\nalice asked about ${W} (${SECRET}).`, { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  s.replay(a6, { uuid: s.newUuid() });
  s.replay(r6, { uuid: s.newUuid() });
  s.assistant(at(D, "09:20:30"), { req: req(7), msg: msg(7), content: [text("Changed: batching in the warmer.")], usage: { in: 8000, out: 120, cr: 0, cw: 7000 }, stop: "end_turn" });
  // E5: after compaction
  s.prompt(at(D, "09:30:00"), "Thanks, now run the linter");
  s.assistant(at(D, "09:30:05"), { req: req(8), msg: msg(8), content: [text("Lint is clean.")], usage: { in: 15, out: 35, cr: 8000, cw: 0 }, stop: "end_turn" });
  return s;
}

/** subagents — main thread + direct subagent + nested workflow subagent + inline /btw sidechain; decoy files around them. */
function subagents(): { main: Session; direct: Session; nested: Session; journal: string } {
  const S = SCENARIOS.subagents.session;
  const main = new Session(S, "e0000006", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-opus-5-5", effort: "high" });
  const { req, msg, tool } = ids("SUB");
  const D = "2026-09-28";
  // E0
  const p0 = main.prompt(at(D, "11:00:00"), "List the services in the monorepo");
  const a1 = main.assistant(at(D, "11:00:05"), { req: req(1), msg: msg(1), content: [text("api, billing, web.")], usage: { in: 50, out: 40, cr: 1000, cw: 0 }, stop: "end_turn" });
  // E1: spawns the direct subagent (runs 11:05:05–11:06:00)
  main.prompt(at(D, "11:05:00"), "Audit every service for unused dependencies");
  main.assistant(at(D, "11:05:04"), { req: req(2), msg: msg(2), content: [toolUse(tool(1), "Task", { description: "Audit deps", prompt: `Check ${SECRET_DIR}/services for unused deps`, subagent_type: "general-purpose" })], usage: { in: 60, out: 120, cr: 1500, cw: 0 }, stop: "tool_use" });
  main.toolResult(at(D, "11:06:05"), tool(1), [text("Found 3 unused dependencies (TESTSECRET report).")], { tur: { status: "completed", agentId: AGENT_DIRECT, content: [text("Found 3 unused dependencies (TESTSECRET report).")] } });
  main.assistant(at(D, "11:06:10"), { req: req(3), msg: msg(3), content: [text("Three unused dependencies found.")], usage: { in: 30, out: 90, cr: 1700, cw: 0 }, stop: "end_turn" });
  // E2: spawns the nested workflow subagent (runs 11:10:04–11:11:00)
  main.prompt(at(D, "11:10:00"), "Run the release workflow");
  main.assistant(at(D, "11:10:03"), { req: req(4), msg: msg(4), content: [toolUse(tool(2), "Task", { description: "Release workflow", prompt: "Run the release checklist", subagent_type: "workflow" })], usage: { in: 40, out: 70, cr: 1800, cw: 0 }, stop: "tool_use" });
  main.toolResult(at(D, "11:11:05"), tool(2), [text("Release checklist complete.")], { tur: { status: "completed", agentId: AGENT_NESTED, content: [text("Release checklist complete.")] } });
  main.assistant(at(D, "11:11:10"), { req: req(5), msg: msg(5), content: [text("Released.")], usage: { in: 20, out: 50, cr: 1900, cw: 0 }, stop: "end_turn" });
  // E3: main reply, then an inline /btw aside (isSidechain) that re-logs parent history and asks its own question
  main.prompt(at(D, "11:15:00"), "What's left to do?");
  const a6 = main.assistant(at(D, "11:15:05"), { req: req(6), msg: msg(6), content: [text("Only the changelog.")], usage: { in: 25, out: 45, cr: 2000, cw: 0 }, stop: "end_turn" });
  main.replay(p0, { uuid: main.newUuid(), parentUuid: a6.uuid, isSidechain: true, timestamp: at(D, "11:15:10") });
  main.replay(a1, { uuid: main.newUuid(), isSidechain: true, timestamp: at(D, "11:15:10") });
  main.user(at(D, "11:15:12"), "how long did the audit take?", { isSidechain: true });
  main.assistant(at(D, "11:15:15"), { req: req(7), msg: msg(7), content: [text("About a minute.")], usage: { in: 0, out: 35, cr: 0, cw: 0 }, stop: "end_turn", extra: { isSidechain: true } });

  // Direct subagent: different model/effort (must not leak into the main exchange's labels). Usage is
  // output-only on purpose so `subTokens` is the same under any definition (out / in+out / all four).
  const direct = new Session(S, "e0000016", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-sonnet-5", effort: "low", agentId: AGENT_DIRECT });
  const sa = ids("SA1");
  direct.user(at(D, "11:05:05"), `Check ${SECRET_DIR}/services for unused deps`);
  direct.assistant(at(D, "11:05:10"), { req: sa.req(1), msg: sa.msg(1), content: [text("Scanning services")], usage: { in: 0, out: 100 }, stop: null });
  direct.assistant(at(D, "11:05:11"), { req: sa.req(1), msg: sa.msg(1), content: [toolUse(sa.tool(1), "Glob", { pattern: "services/*/package.json" })], usage: { in: 0, out: 260 }, stop: "tool_use" });
  direct.toolResult(at(D, "11:05:15"), sa.tool(1), `${SECRET_DIR}/services/api/package.json`);
  direct.assistant(at(D, "11:05:20"), { req: sa.req(2), msg: sa.msg(2), content: [toolUse(sa.tool(2), "Read", { file_path: `${SECRET_DIR}/services/api/package.json` })], usage: { in: 0, out: 80 }, stop: "tool_use" });
  direct.toolResult(at(D, "11:05:21"), sa.tool(2), "{\"dependencies\":{\"lodash\":\"4\"}}");
  direct.assistant(at(D, "11:05:30"), { req: sa.req(3), msg: sa.msg(3), content: [toolUse(sa.tool(3), "Grep", { pattern: "lodash", path: `${SECRET_DIR}/services` })], usage: { in: 0, out: 70 }, stop: "tool_use" });
  direct.toolResult(at(D, "11:05:31"), sa.tool(3), "no matches");
  direct.assistant(at(D, "11:06:00"), { req: sa.req(4), msg: sa.msg(4), content: [text("Found 3 unused deps.")], usage: { in: 0, out: 150 }, stop: "end_turn" });

  const nested = new Session(S, "e0000017", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-sonnet-5", effort: "low", agentId: AGENT_NESTED });
  const sb = ids("SB2");
  nested.user(at(D, "11:10:04"), "Run the release checklist");
  nested.assistant(at(D, "11:10:20"), { req: sb.req(1), msg: sb.msg(1), content: [toolUse(sb.tool(1), "Edit", { file_path: `${SECRET_DIR}/CHANGELOG.md`, old_string: "## Unreleased", new_string: "## 1.2.0" })], usage: { in: 0, out: 200 }, stop: "tool_use" });
  nested.toolResult(at(D, "11:10:21"), sb.tool(1), "updated");
  nested.assistant(at(D, "11:10:40"), { req: sb.req(2), msg: sb.msg(2), content: [toolUse(sb.tool(2), "Bash", { command: "npm version patch" })], usage: { in: 0, out: 90 }, stop: "tool_use" });
  nested.toolResult(at(D, "11:10:41"), sb.tool(2), "v1.2.0");
  nested.assistant(at(D, "11:11:00"), { req: sb.req(3), msg: sb.msg(3), content: [text("Release checklist complete.")], usage: { in: 0, out: 110 }, stop: "end_turn" });

  // Decoy: workflow journal next to the nested agent file. It is not a transcript; if a reader parsed it,
  // E2's subagent numbers would jump by 99,999 tokens / 1 tool call.
  const journal = [
    { type: "assistant", sessionId: S, uuid: "e0000018-0000-4000-8000-000000000001", timestamp: at(D, "11:10:30"), requestId: "req_011CJRNL0001", message: { id: "msg_01JRNL0001", role: "assistant", model: "claude-sonnet-5", content: [toolUse("toolu_01JRNL0001", "Bash", { command: "echo TESTSECRET" })], usage: usage({ in: 0, out: 99999 }) } },
    { type: "user", sessionId: S, uuid: "e0000018-0000-4000-8000-000000000002", timestamp: at(D, "11:10:31"), message: { role: "user", content: `journal entry for ${SECRET_DIR}` } },
  ].map((r) => JSON.stringify(r) + "\n").join("");
  return { main, direct, nested, journal };
}

/** resume — session A, then session B (resumed next day) that replays all of A's records (same uuids/timestamps/requestIds, sessionId B). */
function resume(): { a: Session; b: Session } {
  const a = new Session(SCENARIOS.resumeA.session, "e0000007", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-opus-5-5", effort: "high" });
  const { req, msg, tool } = ids("RES");
  const D1 = "2026-09-29";
  const D2 = "2026-09-30";
  const recs: Rec[] = [];
  recs.push(a.prompt(at(D1, "16:00:00"), "Set up the CI pipeline"));
  recs.push(a.assistant(at(D1, "16:00:05"), { req: req(1), msg: msg(1), content: [toolUse(tool(1), "Bash", { command: `cd ${SECRET_DIR} && gh workflow init` })], usage: { in: 100, out: 50, cr: 0, cw: 2000 }, stop: "tool_use" }));
  recs.push(a.toolResult(at(D1, "16:00:06"), tool(1), "created .github/workflows/ci.yml"));
  recs.push(a.assistant(at(D1, "16:00:10"), { req: req(2), msg: msg(2), content: [text("CI pipeline created.")], usage: { in: 10, out: 30, cr: 2000, cw: 0 }, stop: "end_turn" }));
  recs.push(a.prompt(at(D1, "16:05:00"), "Add caching to the pipeline"));
  recs.push(a.assistant(at(D1, "16:05:08"), { req: req(3), msg: msg(3), content: [text("Added actions/cache.")], usage: { in: 20, out: 70, cr: 2100, cw: 100 }, stop: "end_turn" }));

  const b = new Session(SCENARIOS.resumeB.session, "e0000008", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-opus-5-5", effort: "high" });
  b.other({ type: "summary", summary: "CI pipeline setup for TESTSECRET", leafUuid: a.lastUuid });
  for (const r of recs) b.replay(r, { sessionId: SCENARIOS.resumeB.session });
  b.prompt(at(D2, "09:00:00"), "Now deploy it to staging");
  b.assistant(at(D2, "09:00:05"), { req: req(4), msg: msg(4), content: [toolUse(tool(2), "Bash", { command: "./deploy.sh staging" })], usage: { in: 300, out: 60, cr: 0, cw: 2500 }, stop: "tool_use" });
  b.toolResult(at(D2, "09:00:07"), tool(2), "deployed");
  b.assistant(at(D2, "09:00:12"), { req: req(5), msg: msg(5), content: [text("Deployed to staging.")], usage: { in: 15, out: 40, cr: 2500, cw: 0 }, stop: "end_turn" });
  return { a, b };
}

/** unicode — raw U+2028 / U+2029 inside JSON strings (JSON.stringify leaves them unescaped). */
function unicode(): Session {
  const s = new Session(SCENARIOS.unicode.session, "e0000009", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-opus-5-5", effort: "high" });
  const { req, msg, tool } = ids("UNI");
  const D = "2026-10-01";
  s.prompt(at(D, "10:00:00"), PROMPTS.unicode0);
  s.assistant(at(D, "10:00:05"), { req: req(1), msg: msg(1), content: [text("Renamed. Updating call sites."), toolUse(tool(1), "Edit", { file_path: `${SECRET_DIR}/lib/helper.ts`, old_string: "a b", new_string: "c d" })], usage: { in: 10, out: 20 }, stop: "tool_use" });
  s.toolResult(at(D, "10:00:06"), tool(1), "ok done");
  s.assistant(at(D, "10:00:10"), { req: req(2), msg: msg(2), content: [text("Done. ")], usage: { in: 5, out: 15 }, stop: "end_turn" });
  s.prompt(at(D, "10:01:00"), PROMPTS.unicode1);
  s.assistant(at(D, "10:01:05"), { req: req(3), msg: msg(3), content: [text("README updated.")], usage: { in: 5, out: 25 }, stop: "end_turn" });
  return s;
}

/** damaged — 4 bad lines (bad JSON, array, string, mid-file partial record) and a truncated final line. */
function damaged(): Session {
  const s = new Session(SCENARIOS.damaged.session, "e0000010", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-opus-5-5", effort: "high" });
  const { req, msg, tool } = ids("DMG");
  const D = "2026-10-01";
  s.prompt(at(D, "11:00:00"), "Profile the slow query");
  s.rawLine("{not json");
  s.assistant(at(D, "11:00:05"), { req: req(1), msg: msg(1), content: [toolUse(tool(1), "Bash", { command: "psql -c 'explain analyze select 1'" })], usage: { in: 40, out: 50 }, stop: "tool_use" });
  s.rawLine("[1,2,3]");
  s.toolResult(at(D, "11:00:06"), tool(1), "Seq Scan on orders");
  s.rawLine("\"just a string\"");
  s.assistant(at(D, "11:00:10"), { req: req(2), msg: msg(2), content: [text("Sequential scan on orders.")], usage: { in: 10, out: 30 }, stop: "end_turn" });
  s.rawLine(`{"type":"assistant","timestamp":"${at(D, "11:00:12")}","requestId":"req_011CDMGPART","message":{"id":"msg_01DMGPART","content":[{"type":"text","text":"cut her`);
  s.prompt(at(D, "11:05:00"), "Add an index on created_at");
  s.assistant(at(D, "11:05:04"), { req: req(3), msg: msg(3), content: [toolUse(tool(2), "Edit", { file_path: `${SECRET_DIR}/db/schema.sql`, old_string: "-- indexes", new_string: "create index on orders(created_at);" })], usage: { in: 20, out: 60 }, stop: "tool_use" });
  // The session was still being written: the final record is cut off mid-string, no trailing newline.
  const full = JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", uuid: "e0000010-0000-4000-8000-0000000000ff", timestamp: at(D, "11:05:09"), requestId: req(4), message: { id: msg(4), type: "message", role: "assistant", model: "claude-opus-5-5", content: [text("Index added; the query now uses an index scan on TESTSECRET.")], usage: usage({ in: 5, out: 999 }) } });
  s.truncatedTail(full.slice(0, Math.floor(full.length * 0.6)));
  return s;
}

/** clock — the user reset the clock between exchanges and once mid-exchange; two out-of-range timestamps. */
function clock(): Session {
  const s = new Session(SCENARIOS.clock.session, "e0000011", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-opus-5-5", effort: "high" });
  const { req, msg, tool } = ids("CLK");
  const D = "2026-10-02";
  const u: Usage = { in: 10, out: 10 };
  // E0 15:00:00 → 15:05:00
  s.prompt(at(D, "15:00:00"), "Migrate the settings page to the new form library");
  s.assistant(at(D, "15:01:00"), { req: req(1), msg: msg(1), content: [toolUse(tool(1), "Read", { file_path: `${SECRET_DIR}/settings.tsx` })], usage: u, stop: "tool_use" });
  s.toolResult(at(D, "15:01:01"), tool(1), "export default Settings");
  s.assistant(at(D, "15:05:00"), { req: req(2), msg: msg(2), content: [text("Settings page migrated.")], usage: u, stop: "end_turn" });
  // E1: clock reset 6 h back. Two tool results carry out-of-range timestamps (2019, 2035).
  s.prompt(at(D, "09:00:00"), "Now migrate the profile page as well");
  s.assistant(at(D, "09:00:10"), { req: req(3), msg: msg(3), content: [toolUse(tool(2), "Bash", { command: "npm run codemod profile" })], usage: u, stop: "tool_use" });
  s.toolResult("2019-06-01T00:00:00.000Z", tool(2), "done");
  s.assistant(at(D, "09:00:20"), { req: req(4), msg: msg(4), content: [toolUse(tool(3), "Bash", { command: "npm run typecheck" })], usage: u, stop: "tool_use" });
  s.toolResult("2035-01-01T00:00:00.000Z", tool(3), "0 errors");
  s.assistant(at(D, "09:00:40"), { req: req(5), msg: msg(5), content: [text("Profile page migrated.")], usage: u, stop: "end_turn" });
  // E2: clock jumps back again in the middle of the exchange
  s.prompt(at(D, "09:10:00"), "Run the e2e suite");
  s.assistant(at(D, "09:10:30"), { req: req(6), msg: msg(6), content: [toolUse(tool(4), "Bash", { command: "npm run e2e -- --shard 1" })], usage: u, stop: "tool_use" });
  s.toolResult(at(D, "09:10:31"), tool(4), "shard 1 ok");
  s.assistant(at(D, "08:55:00"), { req: req(7), msg: msg(7), content: [toolUse(tool(5), "Bash", { command: "npm run e2e -- --shard 2" })], usage: u, stop: "tool_use" });
  s.toolResult(at(D, "08:55:01"), tool(5), "shard 2 ok");
  s.assistant(at(D, "08:56:00"), { req: req(8), msg: msg(8), content: [text("E2E suite green.")], usage: u, stop: "end_turn" });
  return s;
}

/**
 * Record types a counts-only check of real logs found that carry nothing a reader measures. None may be reported as
 * unknown.
 */
export const KNOWN_IGNORABLE_TYPES = [
  "summary", "file-history-snapshot", "agent-name", "agent-setting", "ai-title", "atis-latch", "bridge-session", "cost-state",
  "custom-title", "file-history-delta", "frame-link", "last-prompt", "mode", "permission-mode", "queue-operation", "started",
  "artifact-update",
];

/** drift — every documented non-message record type, 'relocated' ×2 (known since D62b), an unknown path-shaped type ×1, malformed shapes. */
function drift(): Session {
  const s = new Session(SCENARIOS.drift.session, "e0000012", { version: "2.1.289", entrypoint: "claude-desktop", mode: "default", model: "claude-opus-5-5", effort: "high" });
  const { req, msg } = ids("DRF");
  const D = "2026-10-03";
  const L = `${SECRET_DIR}/src/login.ts`;
  s.other({ type: "summary", summary: "Fix login redirect TESTSECRET", leafUuid: "e0000012-0000-4000-8000-0000000000aa" });
  s.other({ type: "file-history-snapshot", messageId: "e0000012-0000-4000-8000-0000000000ab", snapshot: { messageId: "e0000012-0000-4000-8000-0000000000ab", trackedFileBackups: { [L]: { backupFileName: "TESTSECRET@v1", version: 1, backupTime: at(D, "12:59:59") } }, timestamp: at(D, "12:59:59") }, isSnapshotUpdate: false });
  // E0
  s.prompt(at(D, "13:00:00"), "Fix the login redirect loop");
  const t1 = at(D, "13:00:01");
  s.other({ type: "agent-name", agentName: "TESTSECRET helper", timestamp: t1 });
  s.other({ type: "agent-setting", agentSetting: "default", timestamp: t1 });
  s.other({ type: "ai-title", aiTitle: "Fixing alice's TESTSECRET login", timestamp: t1 });
  s.other({ type: "atis-latch", latched: true, timestamp: t1 });
  s.other({ type: "bridge-session", bridgeSessionId: "bridge-TESTSECRET-0001", timestamp: t1 });
  s.other({ type: "cost-state", timestamp: t1, modelUsage: { "claude-opus-5-5": { inputTokens: 5000000, outputTokens: 4000000, cacheReadInputTokens: 9000000, cacheCreationInputTokens: 800000, costUSD: 123.45, thinkingTokens: 1000 } }, totalLinesAdded: 10, totalLinesRemoved: 2, totalDuration: 60000 });
  s.other({ type: "custom-title", customTitle: "alice TESTSECRET", timestamp: t1 });
  s.other({ type: "file-history-delta", delta: { [L]: "+1 -1" }, timestamp: t1 });
  s.other({ type: "frame-link", url: "https://TESTSECRET.example.com/frame", timestamp: t1 });
  s.other({ type: "last-prompt", lastPrompt: "Fix the login redirect loop TESTSECRET", timestamp: t1 });
  s.other({ type: "mode", mode: "default", timestamp: t1 });
  s.other({ type: "permission-mode", permissionMode: "default", timestamp: t1 });
  s.other({ type: "queue-operation", operation: "enqueue", content: "TESTSECRET queued", timestamp: t1 });
  s.other({ type: "queue-operation", operation: "dequeue", timestamp: t1 });
  s.other({ type: "started", timestamp: t1 });
  s.other({ type: "artifact-update", artifactId: "art-TESTSECRET", title: "secret-project report", timestamp: t1 });
  s.attachment(at(D, "13:00:02"), { type: "total_tokens_reminder", used: 120000, total: 200000 });
  s.attachment(at(D, "13:00:02"), { type: "task_reminder", content: [{ content: "TESTSECRET todo", status: "pending" }] });
  s.attachment(at(D, "13:00:02"), { type: "environment", systemPrompt: "You are Claude Code. TESTSECRET", mcpServers: ["secret-mcp-TESTSECRET"], skills: ["alice-TESTSECRET-skill"], identity: { modelId: "claude-opus-5-5", marketingName: "Claude Opus 5.5", knowledgeCutoff: "2026-06" } });
  s.attachment(at(D, "13:00:02"), { type: "batching_reminder_sent" });
  s.attachment(at(D, "13:00:02"), { type: "deferred_tools_delta", added: ["mcp__secret_TESTSECRET__query"], removed: [] });
  s.system(at(D, "13:00:03"), "stop_hook_summary", { hookCount: 1, hookInfos: [{ command: `${SECRET_DIR}/hooks/TESTSECRET.sh` }], hookErrors: [], preventedContinuation: false });
  s.system(at(D, "13:00:03"), "turn_duration", { durationMs: 12000 });
  s.system(at(D, "13:00:03"), "away_summary", { content: "While you were away (TESTSECRET) the build finished." });
  s.system(at(D, "13:00:03"), "local_command", { content: "<command-name>/cost</command-name>\n<command-message>cost</command-message>\n<command-args></command-args>" });
  s.assistant(at(D, "13:00:10"), { req: req(1), msg: msg(1), content: [text("Fixed the redirect loop.")], usage: { in: 10, out: 20 }, stop: "end_turn" });
  s.other({ type: "relocated", from: SECRET_DIR, to: `${SECRET_DIR}-moved`, timestamp: at(D, "13:00:11") });
  s.other({ type: "relocated", from: `${SECRET_DIR}-moved`, to: SECRET_DIR, timestamp: at(D, "13:00:12") });
  s.other({ type: `${SECRET_DIR}/${SECRET}`, timestamp: at(D, "13:00:13") });
  // E1: malformed-but-valid-JSON records of known types must not crash or produce negative/NaN numbers
  s.prompt(at(D, "13:05:00"), "Check the session cookie flags");
  s.other({ type: "assistant", uuid: "e0000012-0000-4000-8000-0000000000b1", timestamp: at(D, "13:05:05"), requestId: req(2), message: "not an object" });
  s.other({ type: "assistant", uuid: "e0000012-0000-4000-8000-0000000000b2", timestamp: at(D, "13:05:06"), requestId: req(3), message: { id: msg(3), model: "claude-opus-5-5", content: "string-not-array", usage: { input_tokens: "1000", output_tokens: -50, cache_read_input_tokens: null } } });
  s.other({ type: "user", uuid: "e0000012-0000-4000-8000-0000000000b3", timestamp: at(D, "13:05:07"), message: { role: "user", content: 42 } });
  s.other({ type: "user", uuid: "e0000012-0000-4000-8000-0000000000b4", timestamp: at(D, "13:05:08"), message: null });
  s.other({ type: "user", uuid: "e0000012-0000-4000-8000-0000000000b5", timestamp: at(D, "13:05:08") });
  s.assistant(at(D, "13:05:10"), { req: req(4), msg: msg(4), content: [text("Cookie flags look correct.")], usage: { in: 5, out: 15 }, stop: "end_turn" });
  return s;
}

/** labels — version auto-update, /model command (+ effort change), permission-mode change. Entrypoint constant. */
function labels(): Session {
  const s = new Session(SCENARIOS.labels.session, "e0000014", { version: "2.1.287", entrypoint: "cli", mode: "default", model: "claude-sonnet-5", effort: "medium" });
  const { req, msg, tool } = ids("LBL");
  const D = "2026-10-03";
  const u: Usage = { in: 10, out: 20 };
  s.prompt(at(D, "08:00:00"), "Start the dependency upgrade");
  s.assistant(at(D, "08:00:05"), { req: req(1), msg: msg(1), content: [toolUse(tool(1), "Bash", { command: "npm outdated" })], usage: u, stop: "tool_use" });
  s.toolResult(at(D, "08:00:06"), tool(1), "react 18 → 19");
  s.assistant(at(D, "08:00:10"), { req: req(2), msg: msg(2), content: [text("Two packages are outdated.")], usage: u, stop: "end_turn" });
  s.version = "2.1.288"; // auto-update between exchanges
  s.prompt(at(D, "08:10:00"), "Continue with the lockfile");
  s.assistant(at(D, "08:10:05"), { req: req(3), msg: msg(3), content: [toolUse(tool(2), "Bash", { command: "npm install" })], usage: u, stop: "tool_use" });
  s.toolResult(at(D, "08:10:06"), tool(2), "added 2 packages");
  s.assistant(at(D, "08:10:10"), { req: req(4), msg: msg(4), content: [text("Lockfile updated.")], usage: u, stop: "end_turn" });
  s.user(at(D, "08:15:00"), "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>", { isMeta: true, permissionMode: "default" });
  s.user(at(D, "08:15:01"), "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>", { permissionMode: "default" });
  s.user(at(D, "08:15:02"), "<local-command-stdout>Set model to \u001b[1mclaude-opus-5-5\u001b[22m</local-command-stdout>", { permissionMode: "default" });
  s.mode = "bypassPermissions";
  s.model = "claude-opus-5-5";
  s.effort = "high";
  s.prompt(at(D, "08:20:00"), "Now upgrade the test runner");
  s.assistant(at(D, "08:20:05"), { req: req(5), msg: msg(5), content: [toolUse(tool(3), "Bash", { command: "npm i -D vitest@latest" })], usage: u, stop: "tool_use" });
  s.toolResult(at(D, "08:20:06"), tool(3), "added vitest");
  s.assistant(at(D, "08:20:10"), { req: req(6), msg: msg(6), content: [text("Test runner upgraded.")], usage: u, stop: "end_turn" });
  return s;
}

/** labelsDirty — labels that must be rejected by cleanLabel (path, ANSI, HTML, too long) and a 3-vs-1 version majority. */
function labelsDirty(): Session {
  const s = new Session(SCENARIOS.labelsDirty.session, "e0000015", { version: "2.1.288", entrypoint: "claude-vscode", mode: "default", model: "claude-opus-5-5", effort: "low" });
  const { req, msg } = ids("LBD");
  const D = "2026-10-03";
  const u: Usage = { in: 10, out: 20 };
  s.prompt(at(D, "09:00:00"), "Check the CI logs");
  s.assistant(at(D, "09:00:05"), { req: req(1), msg: msg(1), model: `${SECRET_DIR}/model`, effort: "\u001b[31mhigh", content: [text("Reading the logs.")], usage: u, stop: null });
  s.assistant(at(D, "09:00:10"), { req: req(2), msg: msg(2), model: "m".repeat(80), effort: "<b>high</b>", content: [text("Two jobs failed.")], usage: u, stop: "end_turn" });
  s.prompt(at(D, "09:10:00"), "Summarize the failures");
  s.assistant(at(D, "09:10:05"), { req: req(3), msg: msg(3), content: [text("Job 1: flaky test.")], usage: u, stop: null });
  s.assistant(at(D, "09:10:10"), { req: req(4), msg: msg(4), content: [text("Job 2: lint.")], usage: u, stop: null });
  s.assistant(at(D, "09:10:15"), { req: req(5), msg: msg(5), content: [text("Both are fixable.")], usage: u, stop: "end_turn", extra: { version: "2.1.289" } });
  return s;
}

// ---------------------------------------------------------------- assembly

const sessionFile = (name: ScenarioName) => `home/projects/${SCENARIOS[name].project}/${SCENARIOS[name].session}.jsonl`;

/** Every fixture file, keyed by path relative to this folder. Pure and deterministic. */
export function buildAll(): Map<string, string> {
  const out = new Map<string, string>();
  const put = (name: ScenarioName, s: Session) => out.set(sessionFile(name), s.content());
  put("basic", basic());
  put("filters", filters());
  put("modern", modern());
  put("tools", tools());
  put("usage", usageScenario());
  const sub = subagents();
  put("subagents", sub.main);
  const subDir = `home/projects/${SCENARIOS.subagents.project}/${SCENARIOS.subagents.session}`;
  out.set(`${subDir}/subagents/agent-${AGENT_DIRECT}.jsonl`, sub.direct.content());
  out.set(`${subDir}/subagents/workflows/wf-7/agent-${AGENT_NESTED}.jsonl`, sub.nested.content());
  out.set(`${subDir}/subagents/workflows/wf-7/journal.jsonl`, sub.journal);
  out.set(`${subDir}/subagents/notes.txt`, "decoy: not a transcript (TESTSECRET)\n");
  out.set(`${subDir}/tool-results/toolu_01SUB0001.txt`, `decoy tool output for ${SECRET_DIR}\n`);
  const r = resume();
  put("resumeA", r.a);
  put("resumeB", r.b);
  put("unicode", unicode());
  put("damaged", damaged());
  put("clock", clock());
  put("drift", drift());
  out.set(sessionFile("empty"), "");
  put("labels", labels());
  put("labelsDirty", labelsDirty());
  // Decoy outside projects/: Claude Code's prompt history. A reader must never list it.
  out.set("home/history.jsonl", JSON.stringify({ display: PROMPTS.basic0, pastedContents: {}, timestamp: 1757930400000, project: SECRET_DIR }) + "\n");
  return out;
}

/** The engine package root (directory whose package.json is named "wasitme"), from src or dist. */
export function findEngineRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  for (let d = from; ; d = dirname(d)) {
    const p = join(d, "package.json");
    if (existsSync(p)) {
      try { if ((JSON.parse(readFileSync(p, "utf8")) as { name?: string }).name === "wasitme") return d; } catch { /* keep walking */ }
    }
    if (dirname(d) === d) throw new Error(`engine package root not found above ${from}`);
  }
}

export const FIXTURE_DIR = join(findEngineRoot(), "test", "fixtures", "acceptance", "claude");

function writeAll(): void {
  rmSync(join(FIXTURE_DIR, "home"), { recursive: true, force: true });
  for (const [rel, content] of buildAll()) {
    const p = join(FIXTURE_DIR, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  console.log(`wrote ${buildAll().size} fixture files under ${join(FIXTURE_DIR, "home")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeAll();
