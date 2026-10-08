#!/usr/bin/env node
/**
 * Deterministic generator for the Codex reader acceptance fixtures (see README.md).
 *
 * 100% synthetic: every record below is invented. Shapes mirror field names / enums observed in
 * aggregate (counts only) on real Codex 0.142–0.160 rollouts, plus legacy shapes taken from
 * docs/research/07 (marked "constructed" in the README). Nothing is copied from any real log.
 *
 * Usage: node generate.mjs            → rewrites ./home
 *        import { generate } …        → generate(outDir) writes the same tree elsewhere (freshness test)
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const at = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString();
const secs = (t) => Math.floor(t / 1000);
const plus = (t, s) => t + s * 1000;

/** Deterministic UUID-shaped ids. Every one of them must stay out of reader output. */
export function uuid(n) {
  const h = n.toString(16).padStart(4, "0");
  return `0199f2c4-${h}-7a1e-8b3d-5c0d${h}0f1e`;
}

export const THREAD = {
  main: uuid(1),        // A: paginated main session (parent of subagents and of the history_base child)
  sub: uuid(2),         // B: subagent thread (parent_thread_id)
  subFork: uuid(3),     // C: forked subagent (forked_from_id == parent_thread_id, copied parent records)
  legacy: uuid(4),      // D: legacy history (exec_command_end / patch_apply_end / mcp_tool_call_end)
  legacyFork: uuid(5),  // E: legacy fork of D with copied history
  migrated: uuid(6),    // F: mixed migration duplicates
  historyBase: uuid(7), // G: history_base child of A (no copies)
  exec: uuid(8),        // H: codex exec session (+ byte-identical archived duplicate)
  imported: uuid(9),    // I: external-import-turn-N history + one real turn
  messy: uuid(10),      // J: clock reset, U+2028, malformed lines, unknown types, bad timestamps, bad label
  automation: uuid(11), // K: heartbeat-started session + absorbed task-notification / scheduled-task turns
  live: uuid(12),       // L: live session ending mid-turn with a truncated final line
  archivedOnly: uuid(13), // N: only in archived_sessions/
  empty: uuid(14),      // O: 0-byte rollout
  steering: uuid(15),   // M: second user message inside a running turn
  relative: uuid(16),   // R: read paths relative to the turn cwd (the common real-world shape)
};

const turnId = (n) => uuid(0x100 + n);

const CWD = {
  alpha: "/Users/synthetic-dev/work/canary-project-alpha",
  beta: "/Users/synthetic-dev/work/canary-project-beta",
  gamma: "/Users/synthetic-dev/work/canary-project-gamma",
  delta: "/Users/synthetic-dev/work/canary-project-delta",
  epsilon: "/Users/synthetic-dev/work/canary-project-epsilon",
  zeta: "/Users/synthetic-dev/work/canary-project-zeta",
};

const SECRET_OUTPUT =
  "OPENAI_API_KEY=sk-live-CANARY0123456789abcdefABCDEF\nAWS_ACCESS_KEY_ID=AKIACANARY0000000000\nGITHUB_TOKEN=ghp_CANARYtoken0123456789abcdef";

const RATE_LIMITS = {
  limit_id: "codex",
  primary: { used_percent: 7, window_minutes: 300, resets_at: 1790000000 },
  secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1790500000 },
  plan_type: "pro",
};

const ZERO = { I: 0, C: 0, W: 0, O: 0, R: 0 };

function usageObj(u, legacy) {
  const o = {
    input_tokens: u.I,
    cached_input_tokens: u.C,
    ...(legacy ? {} : { cache_write_input_tokens: u.W ?? 0 }),
    output_tokens: u.O,
    reasoning_output_tokens: u.R,
    total_tokens: u.I + u.O,
  };
  return o;
}
const addU = (a, b) => ({ I: a.I + b.I, C: a.C + b.C, W: (a.W ?? 0) + (b.W ?? 0), O: a.O + b.O, R: a.R + b.R });

// ---------------------------------------------------------------------------------------------
// Rollout builder
// ---------------------------------------------------------------------------------------------

class Rollout {
  /**
   * @param {object} o
   * @param {string} o.thread       thread id written into item_completed / token_usage_record
   * @param {boolean} [o.legacy]    legacy envelopes: no `ordinal`, legacy usage objects
   * @param {number} [o.firstOrdinal]
   */
  constructor(o) {
    this.thread = o.thread;
    this.root = o.root ?? o.thread;
    this.legacy = !!o.legacy;
    this.ordinal = o.firstOrdinal ?? 0;
    this.records = []; // { env } | { raw }
    this.total = { ...ZERO };
    this.turnTotal = new Map();
    this.tail = undefined;
    this.counter = 0;
  }

  id(prefix) { return `${prefix}_canary_${this.thread.slice(9, 13)}_${++this.counter}`; }

  push(t, type, payload, extra = {}) {
    const env = { timestamp: typeof t === "string" ? t : iso(t) };
    if (!this.legacy) env.ordinal = this.ordinal++;
    env.type = type;
    env.payload = payload;
    if (extra.metadata) env.metadata = extra.metadata;
    this.records.push({ env });
    return env;
  }

  raw(line) { this.records.push({ raw: line }); }

  /** Re-append records of another rollout with new timestamps (fork copy). */
  copyFrom(recs, t, extra = {}) {
    for (const r of recs) {
      if (!r.env) continue;
      const env = { timestamp: iso(t) };
      if (!this.legacy) env.ordinal = this.ordinal++;
      env.type = r.env.type;
      env.payload = r.env.payload;
      const md = extra.metadataFor?.(r.env);
      if (md) env.metadata = md;
      this.records.push({ env });
    }
  }

  meta(t, payload) { return this.push(t, "session_meta", payload); }

  event(t, payload) { return this.push(t, "event_msg", payload); }

  item(t, turn, item, startedMs) {
    const p = { type: "item_completed", thread_id: this.thread, turn_id: turn, item };
    if (startedMs !== undefined) p.started_at_ms = startedMs;
    p.completed_at_ms = typeof t === "number" ? t : at(t);
    return this.event(t, p);
  }

  // ----- turn lifecycle -----

  turnStart(t, o) {
    // Observed order: task_started → (first turn only: injected context, world_state) → turn_context
    // → user response_item → item_completed UserMessage.
    this.event(t, {
      type: "task_started",
      turn_id: o.turn,
      started_at: secs(t),
      model_context_window: this.legacy ? undefined : 272000,
      collaboration_mode_kind: this.legacy ? undefined : "default",
    });
    if (o.initial) o.initial();
    const tc = {
      turn_id: o.turn,
      cwd: o.cwd,
      current_date: iso(t).slice(0, 10),
      timezone: "America/Chicago",
      approval_policy: o.approval ?? "never",
      sandbox_policy: { type: o.sandbox ?? "danger-full-access" },
      model: o.model,
      effort: o.effort,
      summary: o.summary ?? "auto",
    };
    if (!this.legacy) {
      Object.assign(tc, {
        root_turn_id: o.turn,
        workspace_roots: [o.cwd],
        approvals_reviewer: "user",
        personality: "pragmatic",
        collaboration_mode: { mode: "default", settings: { model: o.model, reasoning_effort: o.effort, developer_instructions: null } },
        realtime_active: false,
        multi_agent_version: "v2",
      });
    }
    this.push(t, "turn_context", tc);
  }

  /** Legacy turn start: no task metadata beyond turn_id. */
  legacyTurnStart(t, o) {
    this.push(t, "turn_context", {
      cwd: o.cwd,
      approval_policy: o.approval ?? "on-request",
      sandbox_policy: { type: "workspace-write", writable_roots: [o.cwd], network_access: false },
      model: o.model,
      effort: o.effort,
      summary: "auto",
    });
    this.event(t, { type: "task_started", turn_id: o.turn, model_context_window: 200000 });
  }

  complete(t, turn, startT) {
    this.event(t, {
      type: "task_complete",
      turn_id: turn,
      last_agent_message: null,
      started_at: secs(startT),
      completed_at: secs(t),
      duration_ms: t - startT,
      time_to_first_token_ms: 900,
    });
  }

  legacyComplete(t, turn) {
    this.event(t, { type: "task_complete", turn_id: turn, last_agent_message: "Done (canary last message)." });
  }

  aborted(t, turn, startT) {
    this.event(t, { type: "turn_aborted", turn_id: turn, reason: "interrupted", started_at: secs(startT), completed_at: secs(t), duration_ms: t - startT });
  }

  // ----- user / injected messages -----

  /**
   * A message with role user.
   * o.item: also emit the canonical item_completed UserMessage (paginated history)
   * o.legacyEvent: also emit the legacy event_msg user_message
   * o.response: emit the response_item twin (default true)
   */
  user(t, turn, text, o = {}) {
    if (o.response !== false) this.push(t, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }, { metadata: o.metadata });
    if (o.legacyEvent) this.event(t, { type: "user_message", message: text, images: [], local_images: [], text_elements: [] });
    if (o.item) this.item(t, turn, { type: "UserMessage", id: this.id("um"), content: [{ type: "text", text, text_elements: [] }] });
  }

  developer(t, text) {
    this.push(t, "response_item", { type: "message", role: "developer", content: [{ type: "input_text", text }] });
  }

  /** Injected context at session start (AGENTS.md, environment_context) — response_items only. */
  initialContext(t, cwd, worldState = true) {
    this.developer(t, "<permissions instructions>\nFilesystem sandboxing: danger-full-access. Approval policy: never. canary-permissions\n</permissions instructions>");
    this.user(t, null, `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nAlways run the canary-agents-md checks before committing.\n</INSTRUCTIONS>`);
    this.user(t, null, `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-09-27</current_date>\n</environment_context>`);
    if (worldState) this.push(t, "world_state", { full: true, state: { environments: [{ id: "local", cwd }], model: { slug: "gpt-6-luna" } } });
  }

  // ----- model responses -----

  /**
   * One model response (= one API request).
   * spec.usage    {I,C,W,O,R} — final usage for this response
   * spec.snapshots  earlier streaming snapshots for the same response_id (token_usage_record only)
   * spec.tool     tool invoked by this response (executed after the response completes)
   * spec.message  final assistant text
   * spec.repeatTokenCount  emit a byte-identical second token_count (same payload & timestamp)
   * spec.noTur    skip token_usage_record (legacy files never have it)
   * spec.dupLegacy  migration: emit both canonical item and legacy *_end event for the tool
   * spec.legacyTool  legacy: emit only the legacy *_end event
   */
  response(t, turn, spec) {
    const rid = spec.rid ?? this.id("resp");
    const legacyTool = this.legacy || spec.legacyTool;
    const tool = spec.tool;
    const reasoningId = this.id("rs");
    this.push(t, "response_item", {
      type: "reasoning",
      id: reasoningId,
      summary: [{ type: "summary_text", text: "**Planning** canary-reasoning-summary" }],
      content: null,
      encrypted_content: "gAAAAB-canary-encrypted-reasoning-0123456789",
    });
    if (!this.legacy && !spec.legacyOnly) {
      this.item(t, turn, { type: "Reasoning", id: reasoningId, summary_text: ["**Planning** canary-reasoning-summary"], raw_content: [] });
    }
    if (tool) this.toolCall(t, tool);
    if (spec.message !== undefined) {
      this.push(t, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: spec.message }], ...(this.legacy ? {} : { phase: "final_answer" }) });
      if (this.legacy || spec.legacyOnly) this.event(spec.messageTs ?? t, { type: "agent_message", message: spec.message });
      else this.item(spec.messageTs ?? t, turn, { type: "AgentMessage", id: this.id("msg"), content: [{ type: "Text", text: spec.message }], phase: "final_answer" });
    }
    this.tokens(t, turn, rid, spec);
    if (tool) this.toolResult(plus(t, 1), turn, tool, { legacy: legacyTool, dup: spec.dupLegacy });
  }

  tokens(t, turn, rid, spec) {
    const u = spec.usage;
    const turnBefore = this.turnTotal.get(turn) ?? { ...ZERO };
    if (!this.legacy && !spec.noTur) {
      for (const s of spec.snapshots ?? []) {
        this.push(t, "token_usage_record", this.turPayload(rid, turn, s, addU(turnBefore, s), addU(this.total, s)));
      }
      this.push(t, "token_usage_record", this.turPayload(rid, turn, u, addU(turnBefore, u), addU(this.total, u)));
    }
    this.turnTotal.set(turn, addU(turnBefore, u));
    this.total = addU(this.total, u);
    const tc = {
      type: "token_count",
      info: { total_token_usage: usageObj(this.total, this.legacy), last_token_usage: usageObj(u, this.legacy), model_context_window: this.legacy ? 200000 : 272000 },
      rate_limits: RATE_LIMITS,
    };
    this.event(t, tc);
    if (spec.repeatTokenCount) this.event(t, tc);
  }

  turPayload(rid, turn, u, turnU, threadU) {
    return {
      response_id: rid,
      turn_id: turn,
      root_turn_id: turn,
      session_id: this.root,
      thread_id: this.thread,
      usage: usageObj(u, false),
      turn_token_usage: usageObj(turnU, false),
      thread_token_usage: usageObj(threadU, false),
    };
  }

  /** Seed the cumulative token total (forks inherit the parent's running total). */
  seedTotal(u) { this.total = addU(this.total, u); }

  toolCall(t, tool) {
    switch (tool.kind) {
      case "exec":
        if (this.legacy) this.push(t, "response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", tool.cmd], workdir: tool.cwd }), call_id: tool.id });
        else this.push(t, "response_item", { type: "custom_tool_call", id: this.id("ctc"), call_id: tool.id, name: "exec", input: `await tools.exec_command({ cmd: ${JSON.stringify(tool.cmd)} })`, status: "completed" });
        break;
      case "patch":
        if (this.legacy) this.push(t, "response_item", { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: `*** Begin Patch\n*** Update File: ${tool.path}\n${tool.diff}\n*** End Patch` }), call_id: tool.id });
        else this.push(t, "response_item", { type: "custom_tool_call", id: this.id("ctc"), call_id: tool.id, name: "apply_patch", input: `*** Begin Patch\n*** Update File: ${tool.path}\n${tool.diff}\n*** End Patch`, status: "completed" });
        break;
      case "mcp":
        this.push(t, "response_item", { type: "function_call", id: this.id("fc"), name: this.legacy ? `${tool.server}__${tool.tool}` : tool.tool, ...(this.legacy ? {} : { namespace: `mcp__${tool.server}` }), arguments: JSON.stringify(tool.args), call_id: tool.id });
        break;
      case "collab":
        this.push(t, "response_item", { type: "function_call", id: this.id("fc"), name: tool.tool, arguments: JSON.stringify({ message: "canary collab arguments" }), call_id: tool.id });
        break;
      default:
        throw new Error(`unknown tool kind ${tool.kind}`);
    }
  }

  toolResult(t, turn, tool, o) {
    const canonical = !o.legacy;
    const legacyEvent = o.legacy || o.dup;
    switch (tool.kind) {
      case "exec": {
        const failed = (tool.exit ?? 0) !== 0;
        const out = tool.output ?? `${SECRET_OUTPUT}\n(canary command output for ${tool.cmd})`;
        if (canonical) {
          this.item(t, turn, {
            type: "CommandExecution",
            id: tool.id,
            command: ["/bin/zsh", "-lc", tool.cmd],
            cwd: tool.cwd,
            process_id: "61234",
            source: "unified_exec_startup",
            status: failed ? "failed" : "completed",
            exit_code: tool.exit ?? 0,
            duration: { secs: 1, nanos: 250000000 },
            parsed_cmd: tool.parsed,
            aggregated_output: out,
            stdout: out,
            stderr: failed ? "canary stderr: command failed" : "",
            formatted_output: out,
          }, t - 1000);
        }
        if (legacyEvent) {
          this.event(t, {
            type: "exec_command_end",
            call_id: tool.id,
            turn_id: turn,
            command: ["bash", "-lc", tool.cmd],
            cwd: tool.cwd,
            parsed_cmd: tool.parsed,
            source: "agent",
            stdout: out,
            stderr: failed ? "canary stderr: command failed" : "",
            aggregated_output: out,
            exit_code: tool.exit ?? 0,
            duration: { secs: 1, nanos: 250000000 },
            formatted_output: out,
          });
        }
        this.push(t, "response_item", this.legacy
          ? { type: "function_call_output", call_id: tool.id, output: JSON.stringify({ output: out, metadata: { exit_code: tool.exit ?? 0, duration_seconds: 1.25 } }) }
          : { type: "custom_tool_call_output", call_id: tool.id, output: [{ type: "input_text", text: `Process exited with code ${tool.exit ?? 0}\n${out}` }] });
        break;
      }
      case "patch": {
        const change = { type: "update", unified_diff: tool.diff, move_path: null };
        if (canonical) {
          this.item(t, turn, { type: "FileChange", id: tool.id, changes: { [tool.path]: change }, status: "completed", stdout: `Success. Updated the following files:\nM ${tool.path}\n`, stderr: "" });
        }
        if (legacyEvent) {
          this.event(t, { type: "patch_apply_end", call_id: tool.id, turn_id: turn, stdout: `Success. Updated the following files:\nM ${tool.path}\n`, stderr: "", success: true, changes: { [tool.path]: change } });
        }
        this.push(t, "response_item", this.legacy
          ? { type: "function_call_output", call_id: tool.id, output: JSON.stringify({ output: `Success. Updated the following files:\nM ${tool.path}\n`, metadata: { exit_code: 0, duration_seconds: 0.1 } }) }
          : { type: "custom_tool_call_output", call_id: tool.id, output: [{ type: "input_text", text: `Success. Updated the following files:\nM ${tool.path}\n` }] });
        break;
      }
      case "mcp": {
        const text = tool.isError ? "canary mcp error: upstream returned 500" : "canary mcp result text";
        if (canonical) {
          this.item(t, turn, {
            type: "McpToolCall",
            id: tool.id,
            server: tool.server,
            tool: tool.tool,
            arguments: tool.args,
            status: tool.isError ? "failed" : "completed",
            result: { content: [{ type: "text", text }], isError: !!tool.isError },
            duration: { secs: 0, nanos: 420000000 },
          }, t - 500);
        }
        if (legacyEvent) {
          this.event(t, {
            type: "mcp_tool_call_end",
            call_id: tool.id,
            invocation: { server: tool.server, tool: tool.tool, arguments: tool.args },
            duration: { secs: 0, nanos: 420000000 },
            result: tool.isError ? { Err: text } : { Ok: { content: [{ type: "text", text }], isError: false } },
          });
        }
        this.push(t, "response_item", { type: "function_call_output", call_id: tool.id, output: text });
        break;
      }
      case "collab": {
        this.item(t, turn, {
          type: "CollabAgentToolCall",
          id: tool.id,
          tool: tool.tool,
          status: "completed",
          sender_thread_id: this.thread,
          receiver_thread_ids: tool.receivers,
          receiver_agents: tool.receivers.map(() => ({ agent_nickname: "canary-nick-euler", agent_role: "worker" })),
          agents_states: {},
          ...(tool.tool === "spawn_agent" ? { prompt: "Investigate the canary email regex edge cases", model: "gpt-6-luna-mini", reasoning_effort: "medium" } : {}),
        });
        for (const r of tool.receivers) {
          this.item(t, turn, { type: "SubAgentActivity", id: this.id("sa"), kind: tool.tool === "spawn_agent" ? "started" : "completed", agent_thread_id: r, agent_path: "/root/canary-worker" });
        }
        this.push(t, "response_item", { type: "function_call_output", call_id: tool.id, output: tool.tool === "spawn_agent" ? "{\"agent_id\":\"canary-agent\"}" : "{\"status\":\"completed\"}" });
        break;
      }
    }
  }

  serialize() {
    const lines = this.records.map((r) => (r.raw !== undefined ? r.raw : JSON.stringify(r.env)));
    return lines.join("\n") + "\n" + (this.tail ?? "");
  }
}

// Tool spec helpers -------------------------------------------------------------------------

let callSeq = 0;
const callId = (tag) => `call_canary_${tag}_${++callSeq}`;

const readCmd = (cwd, rel, tag) => ({
  kind: "exec",
  id: callId(tag),
  cmd: `sed -n 1,200p ${rel}`,
  cwd,
  parsed: [{ type: "read", cmd: `sed -n 1,200p ${rel}`, name: rel.split("/").pop(), path: `${cwd}/${rel}` }],
});
const searchCmd = (cwd, query, tag) => ({
  kind: "exec",
  id: callId(tag),
  cmd: `rg -n ${query} src`,
  cwd,
  parsed: [{ type: "search", cmd: `rg -n ${query} src`, query, path: "src" }],
});
const listCmd = (cwd, tag) => ({
  kind: "exec",
  id: callId(tag),
  cmd: "ls src",
  cwd,
  parsed: [{ type: "list_files", cmd: "ls src", path: "src" }],
});
const runCmd = (cwd, cmd, exit, tag) => ({
  kind: "exec",
  id: callId(tag),
  cmd,
  cwd,
  exit,
  parsed: [{ type: "unknown", cmd }],
});
const patch = (cwd, rel, tag) => ({
  kind: "patch",
  id: callId(tag),
  path: `${cwd}/${rel}`,
  diff: `@@ -1,3 +1,4 @@\n-const canaryOld = 1;\n+const canaryNew = 2; // CANARY-DIFF ${rel}\n`,
});
const mcp = (tag, isError) => ({ kind: "mcp", id: callId(tag), server: "docs", tool: "search_docs", args: { query: "canary mcp query" }, isError });
const collab = (tag, tool, receivers) => ({ kind: "collab", id: callId(tag), tool, receivers });

function sessionMeta(t, o) {
  const p = {
    id: o.id,
    session_id: o.id,
    timestamp: iso(t),
    cwd: o.cwd,
    originator: o.originator ?? "Codex Desktop",
    cli_version: o.version ?? "0.160.0",
    source: o.source ?? "vscode",
    model_provider: "openai",
    base_instructions: { text: "You are Codex. canary-base-instructions" },
    git: { branch: "canary-branch-name", commit_hash: "c0ffee0000000000000000000000000000canary" },
    history_mode: "paginated",
    runtime_workspace_roots: [o.cwd],
  };
  if (o.threadSource !== null) p.thread_source = o.threadSource ?? "user";
  return Object.assign(p, o.extra ?? {});
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

/** A — paginated main session: tools, errors, reads, blind edits, churn, MCP, subagent spawn, compaction,
 *  streaming snapshot, model/effort change, interrupt, injected context. */
function mainSession() {
  const r = new Rollout({ thread: THREAD.main });
  const cwd = CWD.alpha;
  const t0 = at("2026-09-27T14:00:00.000Z");
  r.meta(t0, sessionMeta(t0, { id: THREAD.main, cwd }));

  const luna = { model: "gpt-6-luna", effort: "high" };
  const sol = { model: "gpt-6.1-sol", effort: "xhigh" };

  // A1 — 14:00:05 → 14:01:00
  let T = at("2026-09-27T14:00:05.000Z");
  const a1 = turnId(1);
  r.turnStart(T, { turn: a1, cwd, ...luna, initial: () => r.initialContext(T, cwd) });
  r.user(T, a1, "Add input validation to the signup form PROMPT-CANARY-A1", { item: true });
  r.response(at("2026-09-27T14:00:08.000Z"), a1, { usage: { I: 12000, C: 8000, W: 0, O: 300, R: 120 }, tool: readCmd(cwd, "src/signup.ts", "a1") });
  r.response(at("2026-09-27T14:00:12.000Z"), a1, { usage: { I: 12600, C: 12000, W: 0, O: 200, R: 50 }, tool: searchCmd(cwd, "validate", "a1") });
  r.response(at("2026-09-27T14:00:20.000Z"), a1, { usage: { I: 13000, C: 12500, W: 0, O: 900, R: 300 }, tool: patch(cwd, "src/signup.ts", "a1") });
  r.response(at("2026-09-27T14:00:30.000Z"), a1, { usage: { I: 14000, C: 13000, W: 0, O: 150, R: 40 }, tool: runCmd(cwd, "npm test -- CANARY-CMD", 1, "a1") });
  r.response(at("2026-09-27T14:00:40.000Z"), a1, { usage: { I: 14500, C: 14000, W: 0, O: 400, R: 100 }, tool: patch(cwd, "src/signup.ts", "a1") });
  r.response(at("2026-09-27T14:00:50.000Z"), a1, { usage: { I: 15000, C: 14500, W: 0, O: 120, R: 30 }, tool: runCmd(cwd, "npm test -- CANARY-CMD", 0, "a1") });
  r.response(at("2026-09-27T14:00:58.000Z"), a1, { usage: { I: 15500, C: 15000, W: 0, O: 250, R: 60 }, message: "Validation added (canary-agent-message).", repeatTokenCount: true });
  r.complete(at("2026-09-27T14:01:00.000Z"), a1, T);

  // A2 — 14:05:00 → 14:07:00 (pushback by phrase; MCP ok/failed; blind edit; spawn + wait subagent)
  T = at("2026-09-27T14:05:00.000Z");
  const a2 = turnId(2);
  r.turnStart(T, { turn: a2, cwd, ...luna });
  r.user(T, a2, "No, the email check should also reject plus-addresses PROMPT-CANARY-A2", { item: true });
  r.response(at("2026-09-27T14:05:05.000Z"), a2, { usage: { I: 16000, C: 15500, W: 0, O: 180, R: 60 }, tool: mcp("a2", false) });
  r.response(at("2026-09-27T14:05:10.000Z"), a2, { usage: { I: 16400, C: 16000, W: 0, O: 90, R: 20 }, tool: mcp("a2", true) });
  r.response(at("2026-09-27T14:05:20.000Z"), a2, { usage: { I: 17000, C: 16400, W: 0, O: 600, R: 200 }, tool: patch(cwd, "src/email.ts", "a2") });
  r.response(at("2026-09-27T14:05:30.000Z"), a2, { usage: { I: 17500, C: 17000, W: 0, O: 220, R: 80 }, tool: collab("a2", "spawn_agent", [THREAD.sub]) });
  r.response(at("2026-09-27T14:05:40.000Z"), a2, { usage: { I: 18200, C: 17500, W: 0, O: 140, R: 40 }, tool: collab("a2", "wait", [THREAD.sub]) });
  T = at("2026-09-27T14:06:40.000Z");
  r.push(T, "inter_agent_communication_metadata", { trigger_turn: false });
  r.push(T, "response_item", { type: "agent_message", id: r.id("am"), author: "/root/canary-worker", recipient: "/root", content: [{ type: "input_text", text: "canary inter-agent report" }] });
  r.user(T, null, "<subagent_notification>\n{\"agent_path\":\"/root/canary-worker\",\"status\":\"completed\"}\n</subagent_notification>");
  r.response(at("2026-09-27T14:06:50.000Z"), a2, { usage: { I: 18600, C: 18200, W: 0, O: 300, R: 90 }, message: "Plus-addresses are now rejected (canary)." });
  r.complete(at("2026-09-27T14:07:00.000Z"), a2, at("2026-09-27T14:05:00.000Z"));

  // A3 — 14:10:00 → 14:12:00 (compaction mid-turn)
  T = at("2026-09-27T14:10:00.000Z");
  const a3 = turnId(3);
  r.turnStart(T, { turn: a3, cwd, ...luna });
  r.user(T, a3, "Now add tests for the email rules PROMPT-CANARY-A3", { item: true });
  r.response(at("2026-09-27T14:10:05.000Z"), a3, { usage: { I: 19000, C: 18600, W: 0, O: 100, R: 30 }, tool: readCmd(cwd, "tests/email.test.ts", "a3") });
  const tc = at("2026-09-27T14:10:30.000Z");
  r.push(tc, "compacted", {
    message: "",
    replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "canary compaction summary of earlier work" }] }],
    window_id: "win_canary_2",
    window_number: 2,
    previous_window_id: "win_canary_1",
    first_window_id: "win_canary_1",
    compaction_response_id: "resp_canary_compaction",
    retained_context: {},
    latest_token_usage_record: null,
  });
  r.item(tc, a3, { type: "ContextCompaction", id: r.id("cc") });
  r.response(at("2026-09-27T14:11:00.000Z"), a3, { usage: { I: 6000, C: 2000, W: 0, O: 700, R: 250 }, tool: patch(cwd, "tests/email.test.ts", "a3") });
  r.response(at("2026-09-27T14:11:20.000Z"), a3, { usage: { I: 6800, C: 6000, W: 0, O: 90, R: 20 }, tool: runCmd(cwd, "npm test", 0, "a3") });
  r.response(at("2026-09-27T14:11:50.000Z"), a3, { usage: { I: 7000, C: 6800, W: 0, O: 200, R: 50 }, message: "Tests added (canary)." });
  r.complete(at("2026-09-27T14:12:00.000Z"), a3, T);

  // A4 — 14:20:00 → 14:21:00 (near-duplicate prompt; model+effort change; churn; snapshot; cache write)
  T = at("2026-09-27T14:20:00.000Z");
  const a4 = turnId(4);
  r.event(T, { type: "thread_settings_applied", thread_id: THREAD.main, thread_settings: { model: "gpt-6.1-sol", reasoning_effort: "xhigh" } });
  r.turnStart(T, { turn: a4, cwd, ...sol });
  r.user(T, a4, "Now add more tests for the email rules PROMPT-CANARY-A3", { item: true });
  r.response(at("2026-09-27T14:20:10.000Z"), a4, { usage: { I: 8000, C: 7000, W: 1000, O: 500, R: 100 }, tool: patch(cwd, "tests/email.test.ts", "a4") });
  r.response(at("2026-09-27T14:20:20.000Z"), a4, {
    usage: { I: 8600, C: 8000, W: 0, O: 450, R: 100 },
    snapshots: [{ I: 8600, C: 8000, W: 0, O: 200, R: 50 }],
    tool: patch(cwd, "tests/email.test.ts", "a4"),
  });
  r.response(at("2026-09-27T14:20:30.000Z"), a4, { usage: { I: 9200, C: 8600, W: 0, O: 400, R: 90 }, tool: patch(cwd, "tests/email.test.ts", "a4") });
  r.response(at("2026-09-27T14:20:50.000Z"), a4, { usage: { I: 9500, C: 9200, W: 0, O: 150, R: 30 }, message: "More tests added (canary)." });
  r.complete(at("2026-09-27T14:21:00.000Z"), a4, T);

  // A5 — 14:30:00 → interrupted at 14:30:20
  T = at("2026-09-27T14:30:00.000Z");
  const a5 = turnId(5);
  r.turnStart(T, { turn: a5, cwd, ...sol });
  r.user(T, a5, "Refactor the validators into a module PROMPT-CANARY-A5", { item: true });
  r.response(at("2026-09-27T14:30:05.000Z"), a5, { usage: { I: 10000, C: 9500, W: 0, O: 120, R: 30 }, tool: readCmd(cwd, "src/validators.ts", "a5") });
  const ta = at("2026-09-27T14:30:20.000Z");
  r.aborted(ta, a5, T);
  r.user(ta, null, "<turn_aborted>\nThe user interrupted the previous turn on purpose. canary-abort-note\n</turn_aborted>");

  // A6 — 14:32:00 → 14:32:10
  T = at("2026-09-27T14:32:00.000Z");
  const a6 = turnId(6);
  r.turnStart(T, { turn: a6, cwd, ...sol });
  r.user(T, a6, "Continue but keep the old exports PROMPT-CANARY-A6", { item: true });
  r.response(at("2026-09-27T14:32:08.000Z"), a6, { usage: { I: 10500, C: 10000, W: 0, O: 80, R: 10 }, message: "Kept the old exports (canary)." });
  r.complete(at("2026-09-27T14:32:10.000Z"), a6, T);
  return r;
}

/** B — subagent thread spawned by A2 (parent_thread_id, no copies). Must yield zero exchanges. */
function subagentSession() {
  const r = new Rollout({ thread: THREAD.sub, root: THREAD.main });
  const cwd = CWD.alpha;
  const t0 = at("2026-09-27T14:05:31.000Z");
  r.meta(t0, sessionMeta(t0, {
    id: THREAD.sub,
    cwd,
    threadSource: "subagent",
    extra: {
      source: { subagent: { thread_spawn: { parent_thread_id: THREAD.main, depth: 1 } } },
      parent_thread_id: THREAD.main,
      agent_nickname: "canary-nick-euler",
      agent_role: "worker",
      agent_path: "/root/canary-worker",
    },
  }));
  const s1 = turnId(20);
  r.turnStart(t0, { turn: s1, cwd, model: "gpt-6-luna-mini", effort: "medium", initial: () => r.initialContext(t0, cwd) });
  r.user(t0, s1, "Investigate the email regex edge cases PROMPT-CANARY-SUB", { item: true });
  r.response(at("2026-09-27T14:05:40.000Z"), s1, { usage: { I: 5000, C: 0, W: 0, O: 400, R: 100 }, tool: readCmd(cwd, "src/email.ts", "s1") });
  r.response(at("2026-09-27T14:05:50.000Z"), s1, { usage: { I: 6000, C: 5000, W: 0, O: 300, R: 80 }, tool: patch(cwd, "src/email.ts", "s1") });
  r.response(at("2026-09-27T14:06:20.000Z"), s1, { usage: { I: 6500, C: 6000, W: 0, O: 250, R: 50 }, message: "Found two edge cases (canary sub result)." });
  r.complete(at("2026-09-27T14:06:30.000Z"), s1, t0);
  return r;
}

/** C — forked subagent: own session_meta, copied parent session_meta + parent records, then
 *  thread_settings_applied at subagent_history_start_ordinal, then its own turn. Zero exchanges. */
function forkedSubagentSession(parent) {
  const r = new Rollout({ thread: THREAD.subFork, root: THREAD.main });
  const cwd = CWD.alpha;
  const t0 = at("2026-09-27T14:25:00.000Z");
  const parentRecs = parent.records.filter((x) => x.env);
  const parentMeta = parentRecs[0];
  // Copy: parent's session_meta + the parent's injected context + A1..A2 response_item messages.
  const copied = [parentMeta, ...parentRecs.filter((x) => x.env.type === "response_item" && x.env.payload.type === "message").slice(0, 8)];
  const startOrdinal = 1 + copied.length;
  r.meta(t0, sessionMeta(t0, {
    id: THREAD.subFork,
    cwd,
    threadSource: "subagent",
    extra: {
      source: { subagent: { thread_spawn: { parent_thread_id: THREAD.main, depth: 1 } } },
      forked_from_id: THREAD.main,
      parent_thread_id: THREAD.main,
      agent_nickname: "canary-nick-noether",
      agent_role: "explorer",
      agent_path: "/root/canary-explorer",
      subagent_history_start_ordinal: startOrdinal,
    },
  }));
  r.copyFrom(copied, plus(t0, 0.004), {
    metadataFor: (env) => (env.type === "response_item" && env.payload.role !== "developer" ? { inherited_user_message: true } : undefined),
  });
  const t1 = plus(t0, 1);
  r.event(t1, { type: "thread_settings_applied", thread_id: THREAD.subFork, thread_settings: { model: "gpt-6-luna-mini", reasoning_effort: "low" } });
  const s2 = turnId(21);
  r.turnStart(t1, { turn: s2, cwd, model: "gpt-6-luna-mini", effort: "low" });
  r.user(t1, s2, "Map which modules import the validators PROMPT-CANARY-SUBFORK", { item: true });
  r.response(at("2026-09-27T14:25:10.000Z"), s2, { usage: { I: 30000, C: 25000, W: 0, O: 350, R: 90 }, tool: searchCmd(cwd, "validators", "s2") });
  r.response(at("2026-09-27T14:25:30.000Z"), s2, { usage: { I: 30800, C: 30000, W: 0, O: 280, R: 60 }, message: "Three modules import it (canary)." });
  r.complete(at("2026-09-27T14:25:40.000Z"), s2, t1);
  return r;
}

/** D — legacy history mode: tool events are exec_command_end / patch_apply_end / mcp_tool_call_end,
 *  prompts are event_msg user_message, tokens only in token_count. Constructed (not seen locally). */
function legacySession() {
  const r = new Rollout({ thread: THREAD.legacy, legacy: true });
  const cwd = CWD.beta;
  const t0 = at("2026-09-28T10:00:00.000Z");
  r.meta(t0, {
    id: THREAD.legacy,
    timestamp: iso(t0),
    cwd,
    originator: "codex_cli_rs",
    cli_version: "0.98.0",
    instructions: "canary legacy instructions placed in session_meta",
    source: "cli",
    model_provider: "openai",
    git: { commit_hash: "beefcafe00000000000000000000000000canary", branch: "canary-branch-beta", repository_url: "git@example.invalid:canary/beta.git" },
  });
  r.user(t0, null, `<environment_context>\n  <cwd>${cwd}</cwd>\n  <approval_policy>on-request</approval_policy>\n</environment_context>`);
  r.event(t0, { type: "token_count", info: null, rate_limits: RATE_LIMITS });
  const m = { model: "gpt-5.6-luna", effort: "medium", approval: "on-request" };

  // D1 — 10:00:05 → 10:02:00
  let T = at("2026-09-28T10:00:05.000Z");
  const d1 = turnId(30);
  r.legacyTurnStart(T, { turn: d1, cwd, ...m });
  r.user(T, d1, "Fix the README build badge and lint errors PROMPT-CANARY-D1", { legacyEvent: true });
  r.response(at("2026-09-28T10:00:10.000Z"), d1, { usage: { I: 9000, C: 4000, O: 250, R: 100 }, tool: readCmd(cwd, "README.md", "d1") });
  r.response(at("2026-09-28T10:00:20.000Z"), d1, { usage: { I: 9800, C: 9000, O: 500, R: 150 }, tool: patch(cwd, "README.md", "d1") });
  r.response(at("2026-09-28T10:00:40.000Z"), d1, { usage: { I: 10200, C: 9800, O: 120, R: 20 }, tool: runCmd(cwd, "npm run lint", 2, "d1"), repeatTokenCount: true });
  r.response(at("2026-09-28T10:01:00.000Z"), d1, { usage: { I: 10600, C: 10200, O: 90, R: 10 }, tool: { ...mcp("d1", false), server: "github", tool: "get_issue", args: { issue: 42, repo: "canary/beta" } } });
  r.response(at("2026-09-28T10:01:20.000Z"), d1, { usage: { I: 10900, C: 10600, O: 60, R: 10 }, tool: { ...mcp("d1", true), server: "github", tool: "get_issue", args: { issue: 43, repo: "canary/beta" } } });
  r.response(at("2026-09-28T10:01:50.000Z"), d1, { usage: { I: 11200, C: 10900, O: 200, R: 40 }, message: "Fixed the badge; lint still reports one rule (canary)." });
  r.legacyComplete(at("2026-09-28T10:02:00.000Z"), d1);

  // D2 — 10:10:00 → 10:11:00 (pushback by phrase)
  T = at("2026-09-28T10:10:00.000Z");
  const d2 = turnId(31);
  r.legacyTurnStart(T, { turn: d2, cwd, ...m });
  r.user(T, d2, "It still doesn't work when the list is empty PROMPT-CANARY-D2", { legacyEvent: true });
  r.response(at("2026-09-28T10:10:10.000Z"), d2, { usage: { I: 11800, C: 11200, O: 150, R: 30 }, tool: readCmd(cwd, "src/list.ts", "d2") });
  r.response(at("2026-09-28T10:10:20.000Z"), d2, { usage: { I: 12300, C: 11800, O: 400, R: 100 }, tool: runCmd(cwd, "npm test", 1, "d2") });
  r.response(at("2026-09-28T10:10:30.000Z"), d2, { usage: { I: 12900, C: 12300, O: 380, R: 90 }, tool: patch(cwd, "src/list.ts", "d2") });
  r.response(at("2026-09-28T10:10:50.000Z"), d2, { usage: { I: 13200, C: 12900, O: 100, R: 20 }, message: "Empty lists handled (canary)." });
  r.legacyComplete(at("2026-09-28T10:11:00.000Z"), d2);
  const forkPoint = r.records.length; // the legacy fork (E) copies everything up to here

  // D3 — 10:20:00 → interrupted 10:20:15
  T = at("2026-09-28T10:20:00.000Z");
  const d3 = turnId(32);
  r.legacyTurnStart(T, { turn: d3, cwd, ...m });
  r.user(T, d3, "Also handle null entries PROMPT-CANARY-D3", { legacyEvent: true });
  r.response(at("2026-09-28T10:20:05.000Z"), d3, { usage: { I: 13500, C: 13200, O: 80, R: 10 }, tool: readCmd(cwd, "src/list.ts", "d3") });
  const ta = at("2026-09-28T10:20:15.000Z");
  r.event(ta, { type: "turn_aborted", turn_id: d3, reason: "interrupted" });
  r.user(ta, null, "<turn_aborted>\nThe user interrupted the previous turn. canary-legacy-abort\n</turn_aborted>");
  r.forkPoint = forkPoint;
  return r;
}

/** E — legacy fork of D: forked_from_id, D's session_meta and D1+D2 records copied with new
 *  timestamps (all stamped at the fork moment), then the fork's own turn. One exchange. */
function legacyForkSession(parent) {
  const r = new Rollout({ thread: THREAD.legacyFork, legacy: true });
  const cwd = CWD.beta;
  const t0 = at("2026-09-28T11:00:00.000Z");
  r.meta(t0, {
    id: THREAD.legacyFork,
    forked_from_id: THREAD.legacy,
    timestamp: iso(t0),
    cwd,
    originator: "codex_cli_rs",
    cli_version: "0.98.0",
    instructions: "canary legacy instructions placed in session_meta",
    source: "cli",
    model_provider: "openai",
  });
  r.copyFrom(parent.records.slice(0, parent.forkPoint), t0);
  r.seedTotal(parent.totalAtFork);
  r.user(t0, null, `<environment_context>\n  <cwd>${cwd}</cwd>\n  <approval_policy>on-request</approval_policy>\n</environment_context>`);
  const m = { model: "gpt-5.6-luna", effort: "medium", approval: "on-request" };
  const T = at("2026-09-28T11:05:00.000Z");
  const e1 = turnId(40);
  r.legacyTurnStart(T, { turn: e1, cwd, ...m });
  r.user(T, e1, "Try a different approach using a Set PROMPT-CANARY-E1", { legacyEvent: true });
  r.response(at("2026-09-28T11:05:10.000Z"), e1, { usage: { I: 14000, C: 13000, O: 200, R: 50 }, tool: readCmd(cwd, "src/list.ts", "e1") });
  r.response(at("2026-09-28T11:05:20.000Z"), e1, { usage: { I: 14500, C: 14000, O: 350, R: 80 }, tool: patch(cwd, "src/list.ts", "e1") });
  r.response(at("2026-09-28T11:05:40.000Z"), e1, { usage: { I: 14800, C: 14500, O: 90, R: 10 }, message: "Switched to a Set (canary)." });
  r.legacyComplete(at("2026-09-28T11:06:00.000Z"), e1);
  return r;
}

/** F — migrated rollout: F1 legacy-only records, F2 every message/tool twice (canonical item +
 *  legacy event, same ids/text), F3 canonical-only. */
function migratedSession() {
  const r = new Rollout({ thread: THREAD.migrated });
  const cwd = CWD.gamma;
  const t0 = at("2026-09-29T16:00:00.000Z");
  r.meta(t0, sessionMeta(t0, { id: THREAD.migrated, cwd, version: "0.150.0" }));
  const m = { model: "gpt-6-luna", effort: "medium" };

  // F1 — legacy-only (pre-migration): user_message event, exec_command_end, token_count only.
  let T = at("2026-09-29T16:00:05.000Z");
  const f1 = turnId(50);
  r.turnStart(T, { turn: f1, cwd, ...m, initial: () => r.initialContext(T, cwd) });
  r.user(T, f1, "Explain the cache layer PROMPT-CANARY-F1", { legacyEvent: true });
  r.response(at("2026-09-29T16:00:10.000Z"), f1, { usage: { I: 7000, C: 3000, W: 0, O: 200, R: 50 }, tool: readCmd(cwd, "src/cache.ts", "f1"), noTur: true, legacyTool: true, legacyOnly: true });
  r.response(at("2026-09-29T16:00:30.000Z"), f1, { usage: { I: 7400, C: 7000, W: 0, O: 300, R: 60 }, message: "The cache layer wraps an LRU (canary).", noTur: true, legacyOnly: true });
  r.complete(at("2026-09-29T16:00:40.000Z"), f1, T);

  // F2 — both forms for the same message and tool calls.
  T = at("2026-09-29T16:10:00.000Z");
  const f2 = turnId(51);
  r.turnStart(T, { turn: f2, cwd, ...m });
  r.user(T, f2, "Make the cache TTL configurable PROMPT-CANARY-F2", { legacyEvent: true, item: true });
  r.response(at("2026-09-29T16:10:10.000Z"), f2, { usage: { I: 8000, C: 7400, W: 0, O: 150, R: 40 }, tool: readCmd(cwd, "src/config.ts", "f2"), dupLegacy: true });
  r.response(at("2026-09-29T16:10:20.000Z"), f2, { usage: { I: 8500, C: 8000, W: 0, O: 500, R: 120 }, tool: patch(cwd, "src/config.ts", "f2"), dupLegacy: true });
  r.response(at("2026-09-29T16:10:30.000Z"), f2, { usage: { I: 8800, C: 8500, W: 0, O: 80, R: 10 }, tool: mcp("f2", true), dupLegacy: true });
  r.response(at("2026-09-29T16:10:50.000Z"), f2, { usage: { I: 9000, C: 8800, W: 0, O: 200, R: 40 }, message: "TTL is configurable now (canary)." });
  r.complete(at("2026-09-29T16:11:00.000Z"), f2, T);

  // F3 — canonical-only.
  T = at("2026-09-29T16:20:00.000Z");
  const f3 = turnId(52);
  r.turnStart(T, { turn: f3, cwd, ...m });
  r.user(T, f3, "Thanks, now update the README PROMPT-CANARY-F3", { item: true });
  r.response(at("2026-09-29T16:20:10.000Z"), f3, { usage: { I: 9500, C: 9000, W: 0, O: 400, R: 100 }, tool: patch(cwd, "README.md", "f3") });
  r.response(at("2026-09-29T16:20:30.000Z"), f3, { usage: { I: 9700, C: 9500, W: 0, O: 100, R: 20 }, message: "README updated (canary)." });
  r.complete(at("2026-09-29T16:20:40.000Z"), f3, T);
  return r;
}

/** G — paginated child that references A's prefix through history_base (no copied records). */
function historyBaseSession(parent, parentText) {
  const endOrdinal = parent.ordinalAfterA3;
  const endByte = Buffer.byteLength(parentText.split("\n").slice(0, endOrdinal).join("\n") + "\n");
  const r = new Rollout({ thread: THREAD.historyBase, firstOrdinal: endOrdinal });
  const cwd = CWD.alpha;
  const t0 = at("2026-09-30T09:00:00.000Z");
  r.meta(t0, sessionMeta(t0, {
    id: THREAD.historyBase,
    cwd,
    extra: { history_base: { thread_id: THREAD.main, end_ordinal_exclusive: endOrdinal, end_byte_offset: endByte } },
  }));
  const T = at("2026-09-30T09:00:05.000Z");
  const g1 = turnId(60);
  r.turnStart(T, { turn: g1, cwd, model: "gpt-6-luna", effort: "high" });
  r.user(T, g1, "Summarize what changed on this branch PROMPT-CANARY-G1", { item: true });
  r.response(at("2026-09-30T09:00:15.000Z"), g1, { usage: { I: 20000, C: 15000, W: 0, O: 300, R: 100 }, tool: runCmd(cwd, "git diff --stat main", 0, "g1") });
  r.response(at("2026-09-30T09:00:45.000Z"), g1, { usage: { I: 20500, C: 20000, W: 0, O: 400, R: 80 }, message: "Validation and tests changed (canary)." });
  r.complete(at("2026-09-30T09:01:00.000Z"), g1, T);
  return r;
}

/** H — codex exec session (source exec / originator codex_exec). */
function execSession() {
  const r = new Rollout({ thread: THREAD.exec });
  const cwd = CWD.delta;
  const t0 = at("2026-10-01T06:00:00.000Z");
  r.meta(t0, sessionMeta(t0, { id: THREAD.exec, cwd, source: "exec", originator: "codex_exec" }));
  const T = at("2026-10-01T06:00:01.000Z");
  const h1 = turnId(70);
  r.turnStart(T, { turn: h1, cwd, model: "gpt-6-luna", effort: "low", initial: () => r.initialContext(T, cwd) });
  r.user(T, h1, "Write a haiku about rust lifetimes PROMPT-CANARY-H1", { item: true });
  r.response(at("2026-10-01T06:00:09.000Z"), h1, { usage: { I: 3000, C: 0, W: 0, O: 60, R: 0 }, message: "Borrowed for a while (canary haiku)." });
  r.complete(at("2026-10-01T06:00:10.000Z"), h1, T);
  return r;
}

/** I — imported history: external-import-turn-1..3 stamped at one moment (no turn_context, no
 *  token records; started_at keeps the original time), then one real turn. One exchange. */
function importedSession() {
  const r = new Rollout({ thread: THREAD.imported });
  const cwd = CWD.zeta;
  const t0 = at("2026-10-01T08:00:00.000Z");
  r.meta(t0, sessionMeta(t0, { id: THREAD.imported, cwd, threadSource: null }));
  const ti = at("2026-10-01T08:00:02.000Z");
  const imported = [
    ["Set up the monorepo tooling PROMPT-CANARY-IMPORT-1", "Monorepo tooling ready (imported canary).", "2026-08-15T10:00:00Z"],
    ["<task-notification>\n<task-id>canary-imported-task</task-id>\n<status>completed</status>\n</task-notification>", "Background task finished (imported canary).", "2026-08-15T10:20:00Z"],
    ["Now wire the lint step into CI PROMPT-CANARY-IMPORT-3", "Lint step wired (imported canary).", "2026-08-15T10:40:00Z"],
  ];
  imported.forEach(([prompt, answer, orig], i) => {
    const tid = `external-import-turn-${i + 1}`;
    r.event(ti, { type: "task_started", turn_id: tid, started_at: secs(at(orig)), model_context_window: null, collaboration_mode_kind: "default" });
    r.user(ti, tid, prompt, { item: true });
    r.push(ti, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] });
    r.item(ti, tid, { type: "AgentMessage", id: `item-${i * 2 + 2}`, content: [{ type: "Text", text: answer }] });
    if (i === 1) r.event(ti, { type: "token_count", info: { total_token_usage: usageObj(ZERO, false), last_token_usage: usageObj(ZERO, false), model_context_window: 272000 }, rate_limits: RATE_LIMITS });
    r.event(ti, { type: "task_complete", turn_id: tid, last_agent_message: null, started_at: secs(at(orig)), completed_at: secs(at(orig)) + 60 });
  });
  r.event(plus(ti, 1), { type: "thread_settings_applied", thread_id: THREAD.imported, thread_settings: { model: "gpt-6-luna", reasoning_effort: "high" } });
  const T = at("2026-10-01T08:05:00.000Z");
  const i4 = turnId(80);
  r.turnStart(T, { turn: i4, cwd, model: "gpt-6-luna", effort: "high", initial: () => r.initialContext(T, cwd) });
  r.user(T, i4, "Pick up where the imported session left off PROMPT-CANARY-I4", { item: true });
  r.response(at("2026-10-01T08:05:10.000Z"), i4, { usage: { I: 9000, C: 0, W: 0, O: 200, R: 50 }, tool: readCmd(cwd, ".github/workflows/ci.yml", "i4") });
  r.response(at("2026-10-01T08:05:30.000Z"), i4, { usage: { I: 9400, C: 9000, W: 0, O: 150, R: 30 }, message: "CI already runs lint (canary)." });
  r.complete(at("2026-10-01T08:05:40.000Z"), i4, T);
  return r;
}

/** J — messy: U+2028/U+2029 in strings, malformed lines, unknown envelope types (one path-like),
 *  out-of-range timestamps, a clock reset backward, and an unsafe model label. */
function messySession() {
  const r = new Rollout({ thread: THREAD.messy });
  const cwd = CWD.epsilon;
  const t0 = at("2026-10-02T14:59:50.000Z");
  r.meta(t0, sessionMeta(t0, { id: THREAD.messy, cwd }));
  const bad = "\u001b[31m/Users/synthetic-dev/canary-model-path";

  // J1 — 15:00:00 → 15:00:30
  let T = at("2026-10-02T15:00:00.000Z");
  const j1 = turnId(90);
  r.turnStart(T, { turn: j1, cwd, model: "gpt-6-luna", effort: "high", initial: () => r.initialContext(T, cwd) });
  r.user(T, j1, "Rename the helper\u2028then update the docs\u2029PROMPT-CANARY-J1", { item: true });
  r.raw('{"timestamp":"2026-10-02T15:00:01.000Z","ordinal":999,"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExe');
  r.response(at("2026-10-02T15:00:05.000Z"), j1, { usage: { I: 5000, C: 1000, W: 0, O: 100, R: 20 }, tool: { ...readCmd(cwd, "src/helper.ts", "j1"), output: "line one\u2028line two\u2029canary-u2028-output" } });
  r.raw('["not","an","object","canary-array-line"]');
  r.push(at("2026-10-02T15:00:06.000Z"), "future_record_kind", { canary: "canary-unknown-payload" });
  r.push(at("2026-10-02T15:00:06.000Z"), "/Users/synthetic-dev/canary-path-type/secret.txt", { canary: "canary-path-type-payload" });
  r.event(at("2026-10-02T15:00:06.000Z"), { type: "future_event_kind", canary: "canary-unknown-event" });
  r.raw("42");
  r.response(at("2026-10-02T15:00:20.000Z"), j1, { usage: { I: 5300, C: 5000, W: 0, O: 150, R: 30 }, message: "Renamed\u2028and documented (canary).", messageTs: "1970-01-01T00:00:00.000Z" });
  r.complete(at("2026-10-02T15:00:30.000Z"), j1, T);

  // J2 — clock reset: 09:00:00 (six hours BEFORE J1); its last records are earlier still.
  T = at("2026-10-02T09:00:00.000Z");
  const j2 = turnId(91);
  r.turnStart(T, { turn: j2, cwd, model: bad, effort: "high" });
  r.user(T, j2, "Why did you rename the public API PROMPT-CANARY-J2", { item: true });
  r.response(at("2026-10-02T09:00:10.000Z"), j2, { usage: { I: 6000, C: 5300, W: 0, O: 120, R: 20 }, tool: patch(cwd, "docs/api.md", "j2") });
  r.response(at("2026-10-02T08:59:50.000Z"), j2, { usage: { I: 6200, C: 6000, W: 0, O: 90, R: 10 }, message: "Restored the public name (canary).", messageTs: "2099-01-01T00:00:00.000Z" });
  r.complete(at("2026-10-02T08:59:55.000Z"), j2, at("2026-10-02T08:59:40.000Z"));

  // J3 — 09:10:00 → 09:10:05
  T = at("2026-10-02T09:10:00.000Z");
  const j3 = turnId(92);
  r.turnStart(T, { turn: j3, cwd, model: bad, effort: "high" });
  r.user(T, j3, "Thanks PROMPT-CANARY-J3 looks good", { item: true });
  r.response(at("2026-10-02T09:10:04.000Z"), j3, { usage: { I: 6400, C: 6200, W: 0, O: 50, R: 0 }, message: "Great (canary)." });
  r.complete(at("2026-10-02T09:10:05.000Z"), j3, T);
  return r;
}

/** K — session started by an automation heartbeat (agent-initiated exchange), then a human prompt
 *  whose exchange absorbs later <task-notification> and <scheduled-task> turns. */
function automationSession() {
  const r = new Rollout({ thread: THREAD.automation });
  const cwd = CWD.delta;
  const t0 = at("2026-10-03T07:00:01.000Z"); // = first turn: an agent-initiated exchange has one candidate t
  r.meta(t0, sessionMeta(t0, { id: THREAD.automation, cwd }));
  const m = { model: "gpt-6-luna", effort: "medium" };

  // K1 — heartbeat turn (agent-initiated): 07:00:01 → 07:00:30
  let T = at("2026-10-03T07:00:01.000Z");
  const k1 = turnId(100);
  r.turnStart(T, { turn: k1, cwd, ...m, initial: () => r.initialContext(T, cwd) });
  r.user(T, k1, "<heartbeat>\n<automation id=\"canary-automation-7\">Check whether CI is green</automation>\n</heartbeat>", { item: true });
  r.response(at("2026-10-03T07:00:10.000Z"), k1, { usage: { I: 4000, C: 0, W: 0, O: 100, R: 20 }, tool: runCmd(cwd, "gh run list --limit 5", 0, "k1") });
  r.response(at("2026-10-03T07:00:25.000Z"), k1, { usage: { I: 4300, C: 4000, W: 0, O: 200, R: 40 }, message: "CI is red on lint (canary)." });
  r.complete(at("2026-10-03T07:00:30.000Z"), k1, T);

  // K2 — human prompt: 07:05:00 → 07:06:00
  T = at("2026-10-03T07:05:00.000Z");
  const k2 = turnId(101);
  r.turnStart(T, { turn: k2, cwd, ...m });
  r.user(T, k2, "Fix the failing lint job PROMPT-CANARY-K2", { item: true });
  r.response(at("2026-10-03T07:05:10.000Z"), k2, { usage: { I: 4800, C: 4300, W: 0, O: 80, R: 10 }, tool: runCmd(cwd, "npm run lint", 1, "k2") });
  r.response(at("2026-10-03T07:05:30.000Z"), k2, { usage: { I: 5200, C: 4800, W: 0, O: 300, R: 60 }, tool: patch(cwd, ".eslintrc.json", "k2") });
  r.response(at("2026-10-03T07:05:50.000Z"), k2, { usage: { I: 5400, C: 5200, W: 0, O: 100, R: 20 }, message: "Lint config fixed (canary)." });
  r.complete(at("2026-10-03T07:06:00.000Z"), k2, T);

  // K3 — <task-notification> turn: 07:20:00 → 07:20:30 (absorbed into K2's exchange)
  T = at("2026-10-03T07:20:00.000Z");
  const k3 = turnId(102);
  r.turnStart(T, { turn: k3, cwd, ...m });
  r.user(T, k3, "<task-notification>\n<task-id>canary-task-9</task-id>\n<status>completed</status>\n<summary>npm run lint finished</summary>\n</task-notification>", { item: true });
  r.response(at("2026-10-03T07:20:10.000Z"), k3, { usage: { I: 5600, C: 5400, W: 0, O: 60, R: 10 }, tool: readCmd(cwd, "lint.log", "k3") });
  r.response(at("2026-10-03T07:20:25.000Z"), k3, { usage: { I: 5800, C: 5600, W: 0, O: 90, R: 10 }, message: "Lint is clean now (canary)." });
  r.complete(at("2026-10-03T07:20:30.000Z"), k3, T);

  // K4 — <scheduled-task> turn: 07:30:00 → 07:30:10 (absorbed into K2's exchange)
  T = at("2026-10-03T07:30:00.000Z");
  const k4 = turnId(103);
  r.turnStart(T, { turn: k4, cwd, ...m });
  r.user(T, k4, "<scheduled-task name=\"canary-nightly\">\nRun the nightly checks\n</scheduled-task>", { item: true });
  r.response(at("2026-10-03T07:30:08.000Z"), k4, { usage: { I: 6000, C: 5800, W: 0, O: 40, R: 0 }, message: "Nightly checks queued (canary)." });
  r.complete(at("2026-10-03T07:30:10.000Z"), k4, T);
  return r;
}

/** M — steering: a second UserMessage arrives inside the running turn (queued mid-turn). */
function steeringSession() {
  const r = new Rollout({ thread: THREAD.steering });
  const cwd = CWD.gamma;
  const t0 = at("2026-10-03T13:00:00.000Z");
  r.meta(t0, sessionMeta(t0, { id: THREAD.steering, cwd }));
  const m = { model: "gpt-6-luna", effort: "high" };
  let T = at("2026-10-03T13:00:05.000Z");
  const m1 = turnId(110);
  r.turnStart(T, { turn: m1, cwd, ...m, initial: () => r.initialContext(T, cwd) });
  r.user(T, m1, "Migrate the config loader to TOML PROMPT-CANARY-M1", { item: true });
  r.response(at("2026-10-03T13:00:15.000Z"), m1, { usage: { I: 7000, C: 2000, W: 0, O: 150, R: 40 }, tool: readCmd(cwd, "src/config.ts", "m1") });
  r.user(at("2026-10-03T13:00:20.000Z"), m1, "also keep JSON support for one release PROMPT-CANARY-M1-STEER", { item: true });
  r.response(at("2026-10-03T13:00:30.000Z"), m1, { usage: { I: 7600, C: 7000, W: 0, O: 600, R: 150 }, tool: patch(cwd, "src/config.ts", "m1") });
  r.response(at("2026-10-03T13:00:50.000Z"), m1, { usage: { I: 8000, C: 7600, W: 0, O: 120, R: 20 }, message: "TOML first, JSON kept (canary)." });
  r.complete(at("2026-10-03T13:01:00.000Z"), m1, T);
  T = at("2026-10-03T13:10:00.000Z");
  const m2 = turnId(111);
  r.turnStart(T, { turn: m2, cwd, ...m });
  r.user(T, m2, "Add a deprecation warning for JSON configs PROMPT-CANARY-M2", { item: true });
  r.response(at("2026-10-03T13:10:20.000Z"), m2, { usage: { I: 8500, C: 8000, W: 0, O: 300, R: 60 }, tool: patch(cwd, "src/config.ts", "m2") });
  r.response(at("2026-10-03T13:10:40.000Z"), m2, { usage: { I: 8800, C: 8500, W: 0, O: 90, R: 10 }, message: "Warning added (canary)." });
  r.complete(at("2026-10-03T13:10:50.000Z"), m2, T);
  return r;
}

/** L — live session: second turn still running, file ends with a partial line (no newline). */
function liveSession() {
  const r = new Rollout({ thread: THREAD.live });
  const cwd = CWD.zeta;
  const t0 = at("2026-10-04T11:00:00.000Z");
  r.meta(t0, sessionMeta(t0, { id: THREAD.live, cwd }));
  const m = { model: "gpt-6-luna", effort: "high" };
  let T = at("2026-10-04T11:00:05.000Z");
  const l1 = turnId(120);
  r.turnStart(T, { turn: l1, cwd, ...m, initial: () => r.initialContext(T, cwd) });
  r.user(T, l1, "Set up the CI workflow PROMPT-CANARY-L1", { item: true });
  r.response(at("2026-10-04T11:00:30.000Z"), l1, { usage: { I: 3000, C: 0, W: 0, O: 500, R: 100 }, tool: patch(cwd, ".github/workflows/ci.yml", "l1") });
  r.response(at("2026-10-04T11:00:50.000Z"), l1, { usage: { I: 3600, C: 3000, W: 0, O: 100, R: 20 }, message: "CI workflow added (canary)." });
  r.complete(at("2026-10-04T11:01:00.000Z"), l1, T);
  T = at("2026-10-04T11:10:00.000Z");
  const l2 = turnId(121);
  r.turnStart(T, { turn: l2, cwd, ...m });
  r.user(T, l2, "Now add a release job PROMPT-CANARY-L2", { item: true });
  r.response(at("2026-10-04T11:10:08.000Z"), l2, { usage: { I: 4000, C: 3600, W: 0, O: 90, R: 20 }, tool: readCmd(cwd, ".github/workflows/ci.yml", "l2") });
  r.tail = `{"timestamp":"2026-10-04T11:10:12.000Z","ordinal":${r.ordinal},"type":"event_msg","payload":{"type":"item_completed","thread_id":"${THREAD.live}","turn_id":"${l2}","item":{"type":"AgentMessage","id":"msg_canary_partial","content":[{"type":"Text","text":"Adding the release job (canary partial wri`;
  return r;
}

/** R — reads logged with paths relative to the turn cwd (92% of real read paths are relative),
 *  edits logged with absolute paths (100% of real FileChange keys). */
function relativeReadsSession() {
  const r = new Rollout({ thread: THREAD.relative });
  const cwd = CWD.epsilon;
  const t0 = at("2026-10-03T16:00:00.000Z");
  r.meta(t0, sessionMeta(t0, { id: THREAD.relative, cwd }));
  const T = at("2026-10-03T16:00:05.000Z");
  const r1 = turnId(140);
  r.turnStart(T, { turn: r1, cwd, model: "gpt-6-luna", effort: "high", initial: () => r.initialContext(T, cwd) });
  r.user(T, r1, "Split the routes file into two modules PROMPT-CANARY-R1", { item: true });
  const relRead = { ...readCmd(cwd, "src/routes.ts", "r1") };
  relRead.parsed = [{ ...relRead.parsed[0], path: "src/routes.ts" }];
  r.response(at("2026-10-03T16:00:10.000Z"), r1, { usage: { I: 6000, C: 2000, W: 0, O: 150, R: 30 }, tool: relRead });
  r.response(at("2026-10-03T16:00:20.000Z"), r1, { usage: { I: 6500, C: 6000, W: 0, O: 500, R: 120 }, tool: patch(cwd, "src/routes.ts", "r1") });
  r.response(at("2026-10-03T16:00:30.000Z"), r1, { usage: { I: 7000, C: 6500, W: 0, O: 450, R: 100 }, tool: patch(cwd, "src/routes-admin.ts", "r1") });
  r.response(at("2026-10-03T16:00:45.000Z"), r1, { usage: { I: 7300, C: 7000, W: 0, O: 120, R: 20 }, message: "Routes split (canary)." });
  r.complete(at("2026-10-03T16:00:50.000Z"), r1, T);
  return r;
}

/** N — a session that only exists in archived_sessions/. */
function archivedOnlySession() {
  const r = new Rollout({ thread: THREAD.archivedOnly });
  const cwd = CWD.gamma;
  const t0 = at("2026-09-20T18:00:00.000Z");
  r.meta(t0, sessionMeta(t0, { id: THREAD.archivedOnly, cwd, version: "0.142.0" }));
  const T = at("2026-09-20T18:00:05.000Z");
  const n1 = turnId(130);
  r.turnStart(T, { turn: n1, cwd, model: "gpt-6-luna", effort: "medium", initial: () => r.initialContext(T, cwd) });
  r.user(T, n1, "What does the retry helper do PROMPT-CANARY-N1", { item: true });
  r.response(at("2026-09-20T18:00:15.000Z"), n1, { usage: { I: 2500, C: 0, W: 0, O: 180, R: 40 }, tool: listCmd(cwd, "n1") });
  r.response(at("2026-09-20T18:00:25.000Z"), n1, { usage: { I: 2800, C: 2500, W: 0, O: 220, R: 30 }, message: "It retries with backoff (canary)." });
  r.complete(at("2026-09-20T18:00:30.000Z"), n1, T);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------------------------

const rolloutName = (stamp, id) => `rollout-${stamp}-${id}.jsonl`;

export const FILES = {
  main: `sessions/2026/09/27/${rolloutName("2026-09-27T14-00-00", THREAD.main)}`,
  sub: `sessions/2026/09/27/${rolloutName("2026-09-27T14-05-31", THREAD.sub)}`,
  subFork: `sessions/2026/09/27/${rolloutName("2026-09-27T14-25-00", THREAD.subFork)}`,
  legacy: `sessions/2026/09/28/${rolloutName("2026-09-28T10-00-00", THREAD.legacy)}`,
  legacyFork: `sessions/2026/09/28/${rolloutName("2026-09-28T11-00-00", THREAD.legacyFork)}`,
  migrated: `sessions/2026/09/29/${rolloutName("2026-09-29T16-00-00", THREAD.migrated)}`,
  historyBase: `sessions/2026/09/30/${rolloutName("2026-09-30T09-00-00", THREAD.historyBase)}`,
  exec: `sessions/2026/10/01/${rolloutName("2026-10-01T06-00-00", THREAD.exec)}`,
  execArchived: `archived_sessions/${rolloutName("2026-10-01T06-00-00", THREAD.exec)}`,
  imported: `sessions/2026/10/01/${rolloutName("2026-10-01T08-00-00", THREAD.imported)}`,
  messy: `sessions/2026/10/02/${rolloutName("2026-10-02T14-59-50", THREAD.messy)}`,
  automation: `sessions/2026/10/03/${rolloutName("2026-10-03T07-00-00", THREAD.automation)}`,
  steering: `sessions/2026/10/03/${rolloutName("2026-10-03T13-00-00", THREAD.steering)}`,
  relative: `sessions/2026/10/03/${rolloutName("2026-10-03T16-00-00", THREAD.relative)}`,
  live: `sessions/2026/10/04/${rolloutName("2026-10-04T11-00-00", THREAD.live)}`,
  empty: `sessions/2026/10/04/${rolloutName("2026-10-04T11-30-00", THREAD.empty)}`,
  archivedOnly: `archived_sessions/${rolloutName("2026-09-20T18-00-00", THREAD.archivedOnly)}`,
  strayNotes: "sessions/2026/10/01/notes.txt",
  decoyHistory: "history.jsonl",
};

/** Build every fixture file as { relativePath: contents }. */
export function build() {
  callSeq = 0;
  const main = mainSession();
  // Record where A3 ends (A's prefix that G references via history_base).
  const a3End = main.records.findIndex((x) => x.env?.type === "event_msg" && x.env.payload.type === "task_complete" && x.env.payload.turn_id === turnId(3));
  main.ordinalAfterA3 = main.records[a3End].env.ordinal + 1;
  const mainText = main.serialize();

  const legacy = legacySession();
  // Running total at the fork point (the fork's token_count totals continue from it).
  const forkRecs = legacy.records.slice(0, legacy.forkPoint).filter((x) => x.env?.payload?.type === "token_count" && x.env.payload.info);
  const lastTotal = forkRecs[forkRecs.length - 1].env.payload.info.total_token_usage;
  legacy.totalAtFork = { I: lastTotal.input_tokens, C: lastTotal.cached_input_tokens, W: 0, O: lastTotal.output_tokens, R: lastTotal.reasoning_output_tokens };

  const exec = execSession().serialize();
  const out = {
    [FILES.main]: mainText,
    [FILES.sub]: subagentSession().serialize(),
    [FILES.subFork]: forkedSubagentSession(main).serialize(),
    [FILES.legacy]: legacy.serialize(),
    [FILES.legacyFork]: legacyForkSession(legacy).serialize(),
    [FILES.migrated]: migratedSession().serialize(),
    [FILES.historyBase]: historyBaseSession(main, mainText).serialize(),
    [FILES.exec]: exec,
    [FILES.execArchived]: exec,
    [FILES.imported]: importedSession().serialize(),
    [FILES.messy]: messySession().serialize(),
    [FILES.automation]: automationSession().serialize(),
    [FILES.steering]: steeringSession().serialize(),
    [FILES.relative]: relativeReadsSession().serialize(),
    [FILES.live]: liveSession().serialize(),
    [FILES.empty]: "",
    [FILES.archivedOnly]: archivedOnlySession().serialize(),
    [FILES.strayNotes]: "canary stray notes file: PROMPT-CANARY-NOTES /Users/synthetic-dev/work/canary-notes\n",
    [FILES.decoyHistory]: JSON.stringify({ session_id: THREAD.main, ts: 1790000000, text: "PROMPT-CANARY-HISTORY decoy prompt history" }) + "\n",
  };
  return out;
}

/** Write the fixture tree into `outDir` (wiped first). Returns the relative paths written. */
export function generate(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  const files = build();
  for (const [rel, text] of Object.entries(files)) {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return Object.keys(files).sort();
}

const HOME = fileURLToPath(new URL("./home/", import.meta.url));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = generate(HOME);
  console.log(`wrote ${written.length} files under ${HOME}`);
}
