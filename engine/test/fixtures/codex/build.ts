/**
 * Synthetic Codex rollout builder for tests. Every record here is invented — nothing is copied or derived
 * from real session logs. Shapes follow the field names in docs/research/07 and those a counts-only check of
 * real logs found (names and enums only).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ParseContext, ParseStats } from "../../../src/types.js";
import { emptyStats } from "../../../src/types.js";
import { bump, makeHash } from "../../../src/util.js";
import { tempDir } from "../temp.js";

type Obj = Record<string, unknown>;

/** Deterministic fake uuid: uuid(1) → "00000000-0000-4000-8000-000000000001". */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export interface MetaOpts {
  id: string;
  cwd?: string;
  cli?: string;
  originator?: string;
  source?: unknown;
  threadSource?: string;
  parent?: string;
  forkedFrom?: string;
  startOrdinal?: number;
  historyBase?: Obj;
  baseInstructions?: string;
  dynamicTools?: unknown[];
  agentRole?: string;
  /** `model_provider` (default "openai"); `null` omits it. */
  provider?: string | null;
  /** Omit history_mode (legacy files). */
  legacy?: boolean;
  /** Payload keys to leave out entirely (e.g. "source", "originator"). */
  omit?: string[];
}

export interface UsageOpts { input: number; cached?: number; output: number; cacheWrite?: number; reasoning?: number }

export class Rollout {
  private lines: string[] = [];
  private ord = 0;
  private clock: number;

  constructor(start: string) { this.clock = Date.parse(start); }

  /** Set the clock (may go backward). */
  at(iso: string): this { this.clock = Date.parse(iso); return this; }
  /** Advance the clock by ms (negative = clock jumped back). */
  tick(ms = 1000): this { this.clock += ms; return this; }
  /** Next ordinal to be written. */
  get ordinal(): number { return this.ord; }

  /** Append one envelope. `ordinal: null` omits it; `timestamp` overrides the clock. */
  rec(type: string, payload: unknown, o: { timestamp?: unknown; ordinal?: number | null } = {}): this {
    const env: Obj = { timestamp: o.timestamp ?? new Date(this.clock).toISOString() };
    if (o.ordinal !== null) env.ordinal = o.ordinal ?? this.ord;
    env.type = type;
    env.payload = payload;
    this.ord = (typeof env.ordinal === "number" ? env.ordinal : this.ord) + 1;
    this.lines.push(JSON.stringify(env));
    return this;
  }
  rawLine(line: string): this { this.lines.push(line); return this; }

  meta(m: MetaOpts): this {
    const p: Obj = {
      id: m.id, session_id: m.id, timestamp: new Date(this.clock).toISOString(), cwd: m.cwd ?? "/synthetic/project",
      originator: m.originator ?? "Codex Desktop", cli_version: m.cli ?? "0.160.0", source: m.source ?? "vscode",
    };
    if (m.provider !== null) p.model_provider = m.provider ?? "openai";
    if (!m.legacy) p.history_mode = "paginated";
    if (m.threadSource) p.thread_source = m.threadSource;
    if (m.parent) p.parent_thread_id = m.parent;
    if (m.forkedFrom) p.forked_from_id = m.forkedFrom;
    if (m.startOrdinal !== undefined) p.subagent_history_start_ordinal = m.startOrdinal;
    if (m.historyBase) p.history_base = m.historyBase;
    if (m.agentRole) p.agent_role = m.agentRole;
    p.base_instructions = { text: m.baseInstructions ?? "You are a synthetic coding agent.", provenance: "default" };
    if (m.dynamicTools) p.dynamic_tools = m.dynamicTools;
    for (const k of m.omit ?? []) delete p[k];
    return this.rec("session_meta", p);
  }

  ctx(turnId: string | undefined, s: { model?: string; effort?: unknown; approval?: unknown; root?: string } = {}): this {
    const p: Obj = { model: s.model ?? "gpt-test-1", approval_policy: s.approval ?? "never", sandbox_policy: { type: "workspace-write" }, cwd: "/synthetic/project", summary: "auto" };
    if (turnId) p.turn_id = turnId;
    if (s.effort !== null) p.effort = s.effort ?? "high";
    if (s.root) p.root_turn_id = s.root;
    return this.rec("turn_context", p);
  }

  event(type: string, extra: Obj = {}): this { return this.rec("event_msg", { type, ...extra }); }
  started(turnId?: string, alias = false): this { return this.event(alias ? "turn_started" : "task_started", turnId ? { turn_id: turnId } : {}); }
  complete(turnId?: string, extra: Obj = {}, alias = false): this {
    return this.event(alias ? "turn_complete" : "task_complete", { ...(turnId ? { turn_id: turnId } : {}), last_agent_message: "synthetic reply", ...extra });
  }
  aborted(turnId?: string, reason: string | undefined = "interrupted"): this {
    const p: Obj = {};
    if (turnId) p.turn_id = turnId;
    if (reason !== undefined) p.reason = reason;
    return this.event("turn_aborted", p);
  }
  settings(s: { model?: string; reasoning_effort?: string; approval_policy?: string }): this {
    return this.event("thread_settings_applied", { thread_settings: s });
  }

  item(turnId: string, item: Obj): this { return this.event("item_completed", { turn_id: turnId, thread_id: "synthetic", item }); }
  user(turnId: string, text: string | null, o: { images?: number } = {}): this {
    const content: Obj[] = [];
    if (text !== null) content.push({ type: "text", text });
    for (let i = 0; i < (o.images ?? 0); i++) content.push({ type: "local_image", path: `/synthetic/img-${i}.png` });
    return this.item(turnId, { type: "UserMessage", id: `um-${this.ord}`, content });
  }
  agent(turnId: string): this { return this.item(turnId, { type: "AgentMessage", id: `am-${this.ord}`, content: [{ type: "Text", text: "synthetic answer" }] }); }
  reasoningItem(turnId: string): this { return this.item(turnId, { type: "Reasoning", id: `r-${this.ord}`, summary_text: [], raw_content: [] }); }
  cmd(turnId: string, o: { status?: string; parsed?: { type: string; path?: string }[]; exit?: number; stdout?: string; command?: string } = {}): this {
    return this.item(turnId, {
      type: "CommandExecution", id: `c-${this.ord}`, command: o.command ?? "synthetic --cmd", cwd: "/synthetic/project",
      status: o.status ?? "completed", exit_code: o.exit ?? (o.status === "failed" ? 1 : 0), duration: { secs: 0, nanos: 1 },
      aggregated_output: o.stdout ?? "ok", stdout: o.stdout ?? "ok", stderr: "", formatted_output: "ok", source: "agent",
      parsed_cmd: (o.parsed ?? [{ type: "unknown" }]).map((x) => ({ cmd: "synthetic", name: x.path?.split("/").pop(), ...x })),
    });
  }
  fileChange(turnId: string, changes: Record<string, "add" | "update" | "delete">, status = "completed"): this {
    const c: Obj = {};
    for (const [path, type] of Object.entries(changes)) c[path] = type === "add" ? { type, content: "synthetic" } : { type, unified_diff: "@@ synthetic", move_path: null };
    return this.item(turnId, { type: "FileChange", id: `f-${this.ord}`, changes: c, status, stdout: "", stderr: "" });
  }
  mcp(turnId: string, status = "completed"): this {
    return this.item(turnId, { type: "McpToolCall", id: `m-${this.ord}`, server: "synthetic", tool: "lookup", arguments: {}, status, duration: { secs: 0, nanos: 1 } });
  }
  collab(turnId: string, status = "completed"): this {
    return this.item(turnId, { type: "CollabAgentToolCall", id: `k-${this.ord}`, tool: "spawn_agent", status, sender_thread_id: "x", receiver_thread_ids: [], receiver_agents: [], agents_states: {} });
  }
  extension(turnId: string, kind = "web.search", status?: string): this {
    const it: Obj = { type: "Extension", id: `e-${this.ord}`, kind };
    if (status) it.status = status;
    return this.item(turnId, it);
  }
  imageView(turnId: string): this { return this.item(turnId, { type: "ImageView", id: `i-${this.ord}`, path: "/synthetic/screen.png" }); }
  subActivity(turnId: string, childId: string): this { return this.item(turnId, { type: "SubAgentActivity", id: `s-${this.ord}`, kind: "started", agent_thread_id: childId, agent_path: "a" }); }
  compaction(turnId: string): this {
    this.rec("compacted", { message: "synthetic summary", replacement_history: [], window_id: "w", window_number: 1 });
    return this.item(turnId, { type: "ContextCompaction", id: `cc-${this.ord}` });
  }
  usage(turnId: string, responseId: string | undefined, u: UsageOpts, root?: string): this {
    const usage = { input_tokens: u.input, cached_input_tokens: u.cached ?? 0, cache_write_input_tokens: u.cacheWrite ?? 0, output_tokens: u.output, reasoning_output_tokens: u.reasoning ?? 0, total_tokens: u.input + u.output };
    const p: Obj = { turn_id: turnId, root_turn_id: root ?? turnId, thread_id: "synthetic", session_id: "synthetic", usage, turn_token_usage: usage, thread_token_usage: usage };
    if (responseId) p.response_id = responseId;
    return this.rec("token_usage_record", p);
  }
  tokenCount(total: UsageOpts | null, last?: UsageOpts): this {
    const u = (x: UsageOpts) => ({ input_tokens: x.input, cached_input_tokens: x.cached ?? 0, output_tokens: x.output, reasoning_output_tokens: x.reasoning ?? 0, total_tokens: x.input + x.output });
    const info = total ? { total_token_usage: u(total), ...(last ? { last_token_usage: u(last) } : {}), model_context_window: 200000 } : null;
    return this.event("token_count", { info, rate_limits: { primary: null } });
  }

  // response_item shapes (legacy files; also present but ignored in paginated files)
  respUser(text: string, o: { image?: boolean } = {}): this {
    const content: Obj[] = [{ type: "input_text", text }];
    if (o.image) content.push({ type: "input_image", image_url: "data:synthetic" });
    return this.rec("response_item", { type: "message", role: "user", content });
  }
  respAssistant(): this { return this.rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "synthetic answer" }] }); }
  respReasoning(encLen: number, summary = ""): this {
    return this.rec("response_item", { type: "reasoning", summary: summary ? [{ type: "summary_text", text: summary }] : [], content: null, encrypted_content: "e".repeat(encLen) });
  }
  fnCall(callId: string, name = "shell", input?: string): this {
    if (name === "apply_patch") return this.rec("response_item", { type: "custom_tool_call", call_id: callId, name, input: input ?? "" });
    return this.rec("response_item", { type: "function_call", call_id: callId, name, arguments: JSON.stringify({ command: ["synthetic"] }) });
  }
  fnOutput(callId: string, output: string, custom = false): this {
    return this.rec("response_item", { type: custom ? "custom_tool_call_output" : "function_call_output", call_id: callId, output });
  }

  text(): string { return this.lines.join("\n") + "\n"; }
}

export interface TreeFile { dir?: "sessions" | "archived_sessions"; date?: string; id: string; stamp?: string; content: string }

/** Rollout file name for a thread id, e.g. rollout-2026-09-01T10-00-00-<id>.jsonl. */
export function rolloutName(id: string, stamp = "2026-09-01T10-00-00"): string { return `rollout-${stamp}-${id}.jsonl`; }

/** Write a synthetic CODEX_HOME tree; returns its root and the path of each file by thread id. */
export function writeTree(files: TreeFile[], root = tempDir("wasitme-codex-")): { root: string; paths: Map<string, string> } {
  const paths = new Map<string, string>();
  for (const f of files) {
    const dir = f.dir ?? "sessions";
    const rel = dir === "sessions" ? join(dir, f.date ?? "2026/09/01", rolloutName(f.id, f.stamp)) : join(dir, rolloutName(f.id, f.stamp));
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    if (!paths.has(f.id)) paths.set(f.id, p);
  }
  return { root, paths };
}

/** An empty temp dir to point WASITME_CODEX_DIR at, so nothing can fall back to the real ~/.codex. */
export function emptyRoot(): string { return tempDir("wasitme-codex-empty-"); }

export const NOW = new Date("2026-10-04T12:00:00Z");
export function testCtx(): ParseContext { return { hash: makeHash("synthetic-test-salt"), now: NOW, timeZone: "UTC" }; }

export function mergeStats(all: ParseStats[]): ParseStats {
  const s = emptyStats();
  for (const x of all) {
    s.files += x.files; s.filesFailed += x.filesFailed; s.badLines += x.badLines; s.truncatedTail += x.truncatedTail;
    s.duplicates += x.duplicates; s.badTimestamps += x.badTimestamps;
    for (const [k, n] of Object.entries(x.unknownTypes)) bump(s.unknownTypes, k, n); // log-derived keys: never obj[k] = …
  }
  return s;
}
