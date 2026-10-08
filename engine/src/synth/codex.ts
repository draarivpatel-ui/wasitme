/**
 * Codex renderer: planned sessions become rollout files
 *   codex/sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl      (live)
 *   codex/archived_sessions/rollout-<stamp>-<id>.jsonl        (moved or copied)
 * in two history modes. PAGINATED rollouts carry canonical `item_completed` items next to raw
 * response_item mirrors (a parser that counts both double-counts); LEGACY rollouts carry no
 * item_completed at all and keep tool events as exec_command_end / patch_apply_end / mcp_tool_call_end.
 * Also: forks (legacy copies the parent's history, paginated references it), imported stub turns,
 * migrated messages recorded twice, injected context messages, exec and subagent threads,
 * turn_aborted (user vs non-user reasons), streaming token_usage_record snapshots, repeated token_count.
 */
import { Rng } from "./rng.js";
import { iso, joinLines, jsonLine, rolloutStamp, type OutFile } from "./emit.js";
import { commandOffsetMs, layoutExchange } from "./layout.js";
import type { Call, Exchange, Plan, Project, Session, Step, SubPlan, Usage } from "./model.js";
import type { SynthParams } from "./params.js";
import * as V from "./vocab.js";

type Rec = Record<string, unknown>;
/** A record before ordinal assignment. */
interface Raw { timestamp: string; type: string; payload: Rec }

const CTX_WINDOW = 258_400;
const NICKS = ["Atlas", "Nova", "Echo", "Quill"] as const;

export interface CodexNoise {
  /** token_usage_record lines beyond the final one of a response. */
  tokenSnapshotExtras: number;
  tokenCountRecords: number;
  /** token_count records repeated byte-identically. */
  tokenCountRepeats: number;
  /** UserMessage items that are app-injected context, not people typing. */
  injectedMessages: number;
  /** Messages recorded both as a canonical item and a legacy user_message event. */
  migratedDuplicateMessages: number;
  importedStubTurns: number;
  /** Parent turns copied into a legacy fork's file. */
  forkReplayedTurns: number;
  archivedMoved: number;
  archivedCopied: number;
  subagentThreads: number;
  execSessions: number;
  legacySessions: number;
  abortReinjected: number;
}

export interface CodexRender {
  files: OutFile[];
  sessionFile: Map<number, string>;
  noise: CodexNoise;
}

export function renderCodex(p: SynthParams, plan: Plan): CodexRender {
  const noise: CodexNoise = {
    tokenSnapshotExtras: 0, tokenCountRecords: 0, tokenCountRepeats: 0, injectedMessages: 0, migratedDuplicateMessages: 0,
    importedStubTurns: 0, forkReplayedTurns: 0, archivedMoved: 0, archivedCopied: 0, subagentThreads: 0,
    execSessions: 0, legacySessions: 0, abortReinjected: 0,
  };
  const files: OutFile[] = [];
  const sessionFile = new Map<number, string>();
  const writers = new Map<number, CodexWriter>();
  for (const s of plan.sessions) {
    if (s.agent !== "codex" || !s.exchanges.length) continue;
    const project = plan.projects[s.projectIdx]!;
    const w = new CodexWriter(p, s, project, noise, s.forkOf !== undefined ? writers.get(s.forkOf) : undefined, plan.sessions);
    w.render();
    writers.set(s.idx, w);
    if (s.kind === "exec") noise.execSessions++;
    if (s.legacy) noise.legacySessions++;
    const name = w.fileName;
    const live = `codex/sessions/${w.datePath}/${name}`;
    const archived = `codex/archived_sessions/${name}`;
    const data = w.data();
    if (s.archive === "moved") {
      files.push({ path: archived, data, mtimeMs: w.lastTs });
      sessionFile.set(s.idx, archived);
      noise.archivedMoved++;
    } else {
      files.push({ path: live, data, mtimeMs: w.lastTs });
      sessionFile.set(s.idx, live);
      if (s.archive === "copied") {
        files.push({ path: archived, data, mtimeMs: w.lastTs });
        noise.archivedCopied++;
      }
    }
    files.push(...w.childFiles);
  }
  return { files, sessionFile, noise };
}

class CodexWriter {
  readonly childFiles: OutFile[] = [];
  /** Records per exchange, for replay into a legacy fork. */
  readonly recs: Raw[][] = [];
  lastTs = 0;
  fileName = "";
  datePath = "";
  private head: Raw[] = [];
  private rng: Rng;
  private totals = { input: 0, cached: 0, write: 0, output: 0, reasoning: 0 };
  private prevAborted?: { prompt: string };
  private metaMs = 0;

  constructor(
    private p: SynthParams, private s: Session, private project: Project, private noise: CodexNoise,
    private parent: CodexWriter | undefined, private all: Session[],
  ) {
    this.rng = new Rng(p.seed, `codex/${s.idx}`);
  }

  private get legacy(): boolean { return this.s.legacy; }

  // ------------------------------------------------------------------ assembly

  render(): void {
    const first = this.s.exchanges[0]!;
    this.metaMs = first.startMs - 70_000;
    this.fileName = `rollout-${rolloutStamp(this.metaMs)}-${this.s.id}.jsonl`;
    this.datePath = iso(this.metaMs).slice(0, 10).replace(/-/g, "/");
    this.head.push(this.sessionMeta(first));
    this.stubs();
    this.forkReplay();
    this.s.exchanges.forEach((ex, i) => { this.recs[i] = this.exchange(ex); });
  }

  data(): string {
    const all = [...this.head, ...this.recs.flat()];
    let max = 0;
    const lines = all.map((r, i) => {
      const t = Date.parse(r.timestamp);
      if (t > max) max = t;
      return jsonLine(this.legacy ? { timestamp: r.timestamp, type: r.type, payload: r.payload } : { timestamp: r.timestamp, ordinal: i, type: r.type, payload: r.payload });
    });
    this.lastTs = Math.max(this.lastTs, max);
    return joinLines(lines);
  }

  private raw(ms: number, type: string, payload: Rec): Raw {
    if (ms > this.lastTs) this.lastTs = ms;
    return { timestamp: iso(ms), type, payload };
  }

  // ------------------------------------------------------------------ session header

  private sessionMeta(first: Exchange): Raw {
    const s = this.s;
    const c = first.config;
    const src = s.startEnv.entrypoint;
    const originator = src === "vscode" ? "Codex Desktop" : src === "exec" ? "codex_exec" : "codex-tui";
    const payload: Rec = {
      ...(this.legacy ? { id: s.id } : { session_id: s.id }),
      timestamp: iso(this.metaMs), cwd: this.project.cwd, originator, cli_version: s.startEnv.version, source: src,
      model_provider: "openai",
      git: { commit_hash: this.rng.hex(40), branch: this.project.branch },
    };
    const instructions = V.fill(V.SYSTEM_PROMPT_TEXT, this.rng, { rev: String(c.systemPromptRev) });
    if (this.legacy) payload.instructions = instructions;
    else {
      payload.base_instructions = { text: instructions };
      payload.dynamic_tools = c.mcp.flatMap((sv) => [`mcp__${sv.replace(/-/g, "_")}__search`, `mcp__${sv.replace(/-/g, "_")}__read`]).map((name) => ({ name, description: "synthetic tool" }));
    }
    if (s.forkOf !== undefined) {
      payload.forked_from_id = this.all[s.forkOf]!.id;
      if (s.forkMode === "history-base") payload.history_base = { parent_session_id: this.all[s.forkOf]!.id, ordinals: s.forkAt };
    }
    return this.raw(this.metaMs, "session_meta", payload);
  }

  private stubs(): void {
    for (let i = 0; i < this.s.importStubs; i++) {
      const turn = this.rng.uuid();
      const ts = this.metaMs + 10 + i * 10;
      const text = V.fill(this.rng.pick(V.PROMPTS), this.rng);
      this.head.push(this.raw(ts, "event_msg", { type: "task_started", turn_id: turn, model_context_window: CTX_WINDOW }));
      this.head.push(this.raw(ts, "event_msg", { type: "item_completed", turn_id: turn, item: { type: "UserMessage", id: `item_${this.rng.hex(24)}`, content: [{ type: "text", text, text_elements: [] }] } }));
      this.head.push(this.raw(ts, "event_msg", { type: "item_completed", turn_id: turn, item: { type: "AgentMessage", id: `item_${this.rng.hex(24)}`, content: [{ type: "Text", text: V.CODEX_STUB_AGENT }] } }));
      this.head.push(this.raw(ts, "event_msg", { type: "task_complete", turn_id: turn, last_agent_message: V.CODEX_STUB_AGENT, duration_ms: 0, error: null }));
      this.noise.importedStubTurns++;
    }
  }

  /** Legacy forks copy the parent's recent history under fresh timestamps (same turn ids). */
  private forkReplay(): void {
    const s = this.s;
    if (s.forkOf === undefined || s.forkMode !== "replay" || !this.parent) return;
    const from = Math.max(0, s.forkAt - s.forkReplay);
    let k = 0;
    for (let i = from; i < s.forkAt && i < this.parent.recs.length; i++) {
      for (const r of this.parent.recs[i]!) {
        this.head.push(this.raw(this.metaMs + 100 + k++, r.type, r.payload));
      }
      this.noise.forkReplayedTurns++;
    }
  }

  // ------------------------------------------------------------------ one exchange (= one turn)

  private exchange(ex: Exchange): Raw[] {
    const out: Raw[] = [];
    const L = layoutExchange(ex);
    const t0 = ex.startMs;
    const T = (off: number): number => t0 + off;
    const turn = this.rng.uuid();
    const push = (ms: number, type: string, payload: Rec): void => { out.push(this.raw(ms, type, payload)); };
    const event = (ms: number, payload: Rec): void => push(ms, "event_msg", payload);
    const item = (ms: number, it: Rec): void => event(ms, { type: "item_completed", turn_id: turn, item: it });

    if (ex.commands.length) {
      event(t0 + commandOffsetMs("codex", 0), { type: "thread_settings_applied", settings: { model: ex.env.model, effort: ex.env.effort, approval_policy: ex.env.mode } });
    }
    event(T(0), { type: "task_started", turn_id: turn, model_context_window: CTX_WINDOW, collaboration_mode_kind: "default" });
    push(T(0), "turn_context", {
      turn_id: turn, cwd: this.project.cwd, approval_policy: ex.env.mode, sandbox_policy: { type: "workspace-write", network_access: false },
      model: ex.env.model, personality: "pragmatic", effort: ex.env.effort, summary: "auto",
      collaboration_mode: { mode: "default", settings: { model: ex.env.model, reasoning_effort: ex.env.effort } },
    });

    const message = (ms: number, text: string, kind: "human" | "injected"): void => {
      push(ms, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
      if (!this.legacy) {
        item(ms, { type: "UserMessage", id: `item_${this.rng.hex(24)}`, content: [{ type: "text", text, text_elements: [] }] });
        if (kind === "human" && this.s.migrated) {
          event(ms, { type: "user_message", message: text, images: [], local_images: [], text_elements: [] });
          this.noise.migratedDuplicateMessages++;
        }
      } else if (kind === "human") {
        event(ms, { type: "user_message", message: text, kind: "plain" });
      }
      if (kind === "injected") this.noise.injectedMessages++;
    };

    if (ex.seq === 0) {
      message(T(0), V.fill(V.CODEX_ENV_CONTEXT, this.rng, { cwd: this.project.cwd, approval: ex.env.mode }), "injected");
      message(T(0), V.fill(V.CODEX_AGENTS_MD, this.rng, { cwd: this.project.cwd, instructions: V.fill(V.INSTRUCTIONS_TEXT, this.rng, { rev: String(ex.config.instructionsRev) }) }), "injected");
    }
    if (this.prevAborted && this.rng.chance(0.5)) {
      message(T(0), V.fill(V.CODEX_TURN_ABORTED, this.rng, { prompt: this.prevAborted.prompt }), "injected");
      this.noise.abortReinjected++;
    }
    this.prevAborted = undefined;
    if (ex.human || this.s.kind === "exec") message(T(0), ex.prompt, "human");

    ex.steps.forEach((step, i) => {
      const sl = L.steps[i]!;
      if (ex.compaction && ex.compaction.atStep === i) {
        push(T(sl.compactOff ?? 0), "compacted", { message: "", replacement_history: [] });
        if (!this.legacy) item(T(sl.compactOff ?? 0), { type: "ContextCompaction", id: `item_${this.rng.hex(24)}` });
      }
      this.step(ex, turn, step, T, sl.startOff, sl.endOff, sl.resultOffs, item, event, push);
      ex.queued.forEach((q, qi) => {
        if (q.afterStep === i) message(T(L.queued[qi]!.deliverOff), q.text, "human");
      });
    });

    // ---- end of turn
    const endMs = ex.glitchShiftMs > 0 ? T(L.endOff) - ex.glitchShiftMs : T(L.endOff);
    if (ex.interrupt || ex.otherAbort) {
      event(endMs, { type: "turn_aborted", turn_id: turn, reason: ex.interrupt ? "interrupted" : "replaced", duration_ms: L.endOff });
      if (ex.interrupt) this.prevAborted = { prompt: ex.prompt };
    } else {
      const lastText = [...ex.steps].reverse().find((x) => x.text)?.text ?? null;
      event(endMs, { type: "task_complete", turn_id: turn, last_agent_message: lastText, duration_ms: L.endOff, time_to_first_token_ms: ex.steps[0]?.latencyMs ?? 0, error: null });
    }
    return out;
  }

  private usageOf(u: Usage, out: number, reasoning: number): Rec {
    return {
      input_tokens: u.in + u.cacheRead, cached_input_tokens: u.cacheRead, cache_write_input_tokens: u.cacheWrite,
      output_tokens: out, reasoning_output_tokens: Math.min(reasoning, out), total_tokens: u.in + u.cacheRead + out,
    };
  }

  private step(
    ex: Exchange, turn: string, step: Step, T: (off: number) => number, startOff: number, endOff: number,
    resultOffs: number[], item: (ms: number, it: Rec) => void, event: (ms: number, p: Rec) => void,
    push: (ms: number, type: string, payload: Rec) => void,
  ): void {
    const rng = this.rng;
    const lat = endOff - startOff;
    if (step.thinking) {
      const th = step.thinking;
      const summary = th.redacted ? [] : [{ type: "summary_text", text: th.text }];
      push(T(startOff + Math.round(lat * 0.3)), "response_item", { type: "reasoning", summary, content: null, encrypted_content: rng.base64(th.chars) });
      if (!this.legacy) item(T(startOff + Math.round(lat * 0.3)), { type: "Reasoning", id: `item_${rng.hex(24)}`, summary_text: th.redacted ? [] : [th.text], raw_content: [] });
    }
    if (step.text) {
      const at = T(startOff + Math.round(lat * 0.7));
      push(at, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: step.text }] });
      if (!this.legacy) item(at, { type: "AgentMessage", id: `item_${rng.hex(24)}`, content: [{ type: "Text", text: step.text }] });
      else event(at, { type: "agent_message", message: step.text });
    }
    const ids = step.calls.map((c) => ({ call: c, callId: `call_${c.id}${rng.base62(8)}`, itemId: `item_${rng.hex(24)}` }));
    for (const { call, callId } of ids) this.callRecord(push, T(endOff), call, callId);

    // token_usage_record snapshots (streaming) + cumulative token_count
    const reasoning = step.thinking ? Math.round(step.thinking.chars * 0.25) : 0;
    const snaps = 1 + (rng.chance(0.25) ? 1 : 0) + (rng.chance(0.1) ? 1 : 0);
    const responseId = `resp_${step.rid}${rng.hex(20)}`;
    this.totals.input += step.usage.in + step.usage.cacheRead;
    this.totals.cached += step.usage.cacheRead;
    this.totals.write += step.usage.cacheWrite;
    this.totals.output += step.usage.out;
    this.totals.reasoning += reasoning;
    for (let k = 0; k < snaps; k++) {
      const last = k === snaps - 1;
      const o = last ? step.usage.out : Math.max(1, Math.floor((step.usage.out * (k + 1)) / (snaps + 1)));
      push(T(endOff), "token_usage_record", {
        response_id: responseId, turn_id: turn, usage: this.usageOf(step.usage, o, reasoning),
        turn_token_usage: this.usageOf(step.usage, o, reasoning),
      });
      if (!last) this.noise.tokenSnapshotExtras++;
    }
    const tc = {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: this.totals.input, cached_input_tokens: this.totals.cached, output_tokens: this.totals.output, reasoning_output_tokens: this.totals.reasoning, total_tokens: this.totals.input + this.totals.output },
        last_token_usage: this.usageOf(step.usage, step.usage.out, reasoning), model_context_window: CTX_WINDOW,
      },
      rate_limits: { primary: { used_percent: rng.int(1, 60), window_minutes: 300, resets_at: 1_800_000_000 }, secondary: { used_percent: rng.int(1, 30), window_minutes: 10_080, resets_at: 1_800_500_000 } },
    };
    event(T(endOff), tc);
    this.noise.tokenCountRecords++;
    if (rng.chance(0.3)) { event(T(endOff), tc); this.noise.tokenCountRepeats++; }

    ids.forEach(({ call, callId, itemId }, j) => this.resultRecords(push, item, event, ex, turn, call, callId, itemId, T(resultOffs[j]!), T(endOff)));
  }

  // ------------------------------------------------------------------ calls

  private commandOf(call: Call): string {
    const rng = this.rng;
    if (call.cls === "read") {
      if (call.parsed === "read") return V.fill(V.CODEX_READ_CMD, rng, { path: call.file ?? "src/index.ts" });
      return call.parsed === "list_files" ? V.fill(V.CODEX_LIST_CMD, rng) : V.fill(V.CODEX_SEARCH_CMD, rng);
    }
    return call.cmd ?? "ls";
  }

  private parsedCmd(call: Call, cmd: string): Rec[] {
    if (call.cls === "read") {
      if (call.parsed === "read") return [{ type: "read", cmd, name: (call.file ?? "").split("/").pop(), path: call.file }];
      if (call.parsed === "list_files") return [{ type: "list_files", cmd, path: "src" }];
      return [{ type: "search", cmd, query: "synthetic", path: "src" }];
    }
    return [{ type: "unknown", cmd }];
  }

  private callRecord(push: (ms: number, type: string, payload: Rec) => void, ms: number, call: Call, callId: string): void {
    const rng = this.rng;
    if (call.cls === "edit") {
      const patch = V.fill(V.CODEX_PATCH, rng, { path: call.file ?? "src/index.ts" });
      push(ms, "response_item", { type: "custom_tool_call", status: "completed", call_id: callId, name: "apply_patch", input: patch });
    } else if (call.cls === "spawn") {
      push(ms, "response_item", { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ message: call.sub!.prompt }), call_id: callId });
    } else if (call.mcp) {
      push(ms, "response_item", { type: "function_call", name: "mcp__synth_docs__search", arguments: JSON.stringify({ query: rng.pick(V.NOUNS) }), call_id: callId });
    } else {
      push(ms, "response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", this.commandOf(call)], workdir: this.project.cwd }), call_id: callId });
    }
  }

  private resultRecords(
    push: (ms: number, type: string, payload: Rec) => void, item: (ms: number, it: Rec) => void,
    event: (ms: number, p: Rec) => void, ex: Exchange, turn: string, call: Call, callId: string, itemId: string,
    ms: number, callMs: number,
  ): void {
    const rng = this.rng;
    const failed = call.outcome !== "ok";
    const cwd = this.project.cwd;
    if (call.cls === "edit") {
      const file = call.file ?? "src/index.ts";
      const text = failed ? V.CODEX_PATCH_FAIL : V.fill(V.CODEX_PATCH_OK, rng, { path: file });
      push(ms, "response_item", { type: "custom_tool_call_output", call_id: callId, output: JSON.stringify({ output: text, metadata: { exit_code: failed ? 1 : 0, duration_seconds: 0.1 } }) });
      const changes = [{ path: file, kind: { type: "update" }, diff: V.EDIT_NEW }];
      if (!this.legacy) item(ms, { type: "FileChange", id: itemId, call_id: callId, changes, status: failed ? "failed" : "completed" });
      else event(ms, { type: "patch_apply_end", call_id: callId, turn_id: turn, stdout: failed ? "" : text, stderr: failed ? text : "", success: !failed, changes: { [file]: { type: "update", unified_diff: V.EDIT_NEW } } });
    } else if (call.cls === "spawn") {
      const sub = call.sub!;
      const nick = rng.pick(NICKS);
      const childId = rng.uuid();
      push(ms, "response_item", { type: "function_call_output", call_id: callId, output: failed ? V.ERROR_OUTPUTS.Task : JSON.stringify({ agent_id: childId, nickname: nick }) });
      if (!this.legacy) item(ms, { type: "CollabAgentToolCall", id: itemId, call_id: callId, tool: "spawn_agent", status: failed ? "failed" : "completed", sender_thread_id: this.s.id, receiver_thread_ids: [childId], prompt: sub.prompt });
      this.child(ex, sub, childId, nick, callMs + 100);
      const text = V.fill(V.CODEX_SUBAGENT_NOTIFICATION, rng, { nick });
      push(ms + 1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
      if (!this.legacy) item(ms + 1, { type: "UserMessage", id: `item_${rng.hex(24)}`, content: [{ type: "text", text, text_elements: [] }] });
      this.noise.injectedMessages++;
    } else if (call.mcp) {
      const text = failed ? V.fill(V.ERROR_OUTPUTS.default, rng) : V.fill(V.GENERIC_OUTPUT_OK, rng);
      push(ms, "response_item", { type: "function_call_output", call_id: callId, output: JSON.stringify({ content: [{ type: "text", text }], is_error: failed }) });
      if (!this.legacy) item(ms, { type: "McpToolCall", id: itemId, call_id: callId, server: "synth-docs", tool: "search", status: failed ? "failed" : "completed", arguments: {}, ...(failed ? { error: { message: text } } : { result: { content: [{ type: "text", text }] } }) });
      else event(ms, { type: "mcp_tool_call_end", call_id: callId, invocation: { server: "synth-docs", tool: "search", arguments: {} }, duration: { secs: 0, nanos: 100_000_000 }, result: failed ? { Err: text } : { Ok: { content: [{ type: "text", text }], is_error: false } } });
    } else {
      const cmd = this.commandOf(call);
      const parsed = this.parsedCmd(call, cmd);
      const body = failed ? V.fill(V.ERROR_OUTPUTS.default, rng) : V.fill(V.BASH_OUTPUT_OK, rng);
      const text = V.fill(V.CODEX_EXEC_OUTPUT, rng, { code: failed ? "1" : "0", secs: "0.3", out: body });
      push(ms, "response_item", { type: "function_call_output", call_id: callId, output: text });
      if (!this.legacy) {
        item(ms, { type: "CommandExecution", id: itemId, call_id: callId, command: cmd, cwd, parsed_cmd: parsed, status: failed ? "failed" : "completed", exit_code: failed ? 1 : 0, aggregated_output: body, duration: { secs: 0, nanos: 300_000_000 } });
      } else {
        event(ms, { type: "exec_command_end", call_id: callId, turn_id: turn, command: ["bash", "-lc", cmd], cwd, parsed_cmd: parsed, aggregated_output: body, exit_code: failed ? 1 : 0, duration: { secs: 0, nanos: 300_000_000 } });
      }
    }
  }

  // ------------------------------------------------------------------ subagent thread

  private child(ex: Exchange, sub: SubPlan, childId: string, nick: string, base: number): void {
    const rng = this.rng;
    const recs: Raw[] = [];
    const push = (ms: number, type: string, payload: Rec): void => { recs.push(this.raw(ms, type, payload)); };
    const turn = rng.uuid();
    push(base, "session_meta", {
      ...(this.legacy ? { id: childId } : { session_id: childId }), timestamp: iso(base), cwd: this.project.cwd, originator: "Codex Desktop",
      cli_version: this.s.startEnv.version,
      source: { subagent: { thread_spawn: { parent_thread_id: this.s.id, depth: 1 } } }, model_provider: "openai",
      parent_thread_id: this.s.id, agent_role: "explorer", agent_nickname: nick, agent_path: `/root/${nick.toLowerCase()}`,
      git: { commit_hash: rng.hex(40), branch: this.project.branch },
      ...(this.legacy ? { instructions: V.fill(V.SYSTEM_PROMPT_TEXT, rng, { rev: String(ex.config.systemPromptRev) }) } : { base_instructions: { text: V.fill(V.SYSTEM_PROMPT_TEXT, rng, { rev: String(ex.config.systemPromptRev) }) } }),
    });
    push(base + 1, "event_msg", { type: "task_started", turn_id: turn, model_context_window: CTX_WINDOW });
    push(base + 1, "turn_context", {
      turn_id: turn, cwd: this.project.cwd, approval_policy: ex.env.mode, sandbox_policy: { type: "workspace-write", network_access: false },
      model: ex.env.model, personality: "pragmatic", effort: ex.env.effort, summary: "auto",
    });
    push(base + 2, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: sub.prompt }] });
    if (!this.legacy) push(base + 2, "event_msg", { type: "item_completed", turn_id: turn, item: { type: "UserMessage", id: `item_${rng.hex(24)}`, content: [{ type: "text", text: sub.prompt, text_elements: [] }] } });
    let cursor = base + 200;
    for (const st of sub.steps) {
      const end = cursor + st.latencyMs;
      let res = end;
      for (const c of st.calls) {
        res = Math.max(res, end + c.execMs);
        const callId = `call_${c.id}${rng.base62(8)}`;
        const cmd = this.commandOf(c);
        const failed = c.outcome !== "ok";
        push(end, "response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", cmd] }), call_id: callId });
        const body = failed ? V.fill(V.ERROR_OUTPUTS.default, rng) : V.fill(V.BASH_OUTPUT_OK, rng);
        push(res, "response_item", { type: "function_call_output", call_id: callId, output: V.fill(V.CODEX_EXEC_OUTPUT, rng, { code: failed ? "1" : "0", secs: "0.2", out: body }) });
        if (!this.legacy) {
          push(res, "event_msg", { type: "item_completed", turn_id: turn, item: { type: "CommandExecution", id: `item_${rng.hex(24)}`, call_id: callId, command: cmd, cwd: this.project.cwd, parsed_cmd: this.parsedCmd(c, cmd), status: failed ? "failed" : "completed", exit_code: failed ? 1 : 0, aggregated_output: body } });
        } else {
          push(res, "event_msg", { type: "exec_command_end", call_id: callId, turn_id: turn, command: ["bash", "-lc", cmd], cwd: this.project.cwd, parsed_cmd: this.parsedCmd(c, cmd), aggregated_output: body, exit_code: failed ? 1 : 0 });
        }
      }
      push(end, "token_usage_record", {
        response_id: `resp_${st.rid}${rng.hex(20)}`, turn_id: turn, usage: this.usageOf(st.usage, st.usage.out, 0), turn_token_usage: this.usageOf(st.usage, st.usage.out, 0),
      });
      cursor = res;
    }
    push(cursor + 5, "event_msg", { type: "task_complete", turn_id: turn, last_agent_message: sub.resultText, duration_ms: cursor - base, error: null });
    const lines = recs.map((r, i) => jsonLine(this.legacy ? { timestamp: r.timestamp, type: r.type, payload: r.payload } : { timestamp: r.timestamp, ordinal: i, type: r.type, payload: r.payload }));
    const name = `rollout-${rolloutStamp(base)}-${childId}.jsonl`;
    this.childFiles.push({ path: `codex/sessions/${iso(base).slice(0, 10).replace(/-/g, "/")}/${name}`, data: joinLines(lines), mtimeMs: cursor + 5 });
    this.noise.subagentThreads++;
  }
}
