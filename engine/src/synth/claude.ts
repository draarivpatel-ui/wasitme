/**
 * Claude Code renderer: turns planned sessions into
 *   claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   claude/projects/<encoded-cwd>/<sessionId>/subagents/[workflows/<id>/]agent-<id>.jsonl (+ .meta.json, journal.jsonl)
 * following the field names real logs use (a counts-only check of field names and enums), and including
 * the quirks parsers must survive (docs/research/05, "Parser edge cases"): one API response split over several lines, resumed sessions replaying earlier uuids, queued_command
 * attachments, list-form interrupts, toolDenialKind, api_error retries, compactions, thinking
 * blocks with redaction, attachments carrying config evidence, version-era differences.
 */
import { Rng } from "./rng.js";
import { iso, joinLines, jsonLine, type OutFile } from "./emit.js";
import { commandOffsetMs, layoutExchange } from "./layout.js";
import type { Call, Exchange, Plan, Project, Session, SubPlan, Usage } from "./model.js";
import type { SynthParams } from "./params.js";
import { initialConfig, isClaudeModern, type ConfigState } from "./schedule.js";
import * as V from "./vocab.js";

type Rec = Record<string, unknown>;

export interface ClaudeNoise {
  /** Records copied into a resumed session's file (same uuid, new sessionId). */
  replayedRecords: number;
  replayedHumanPrompts: number;
  /** Assistant lines beyond the first per API response (streaming split). */
  streamingExtraLines: number;
  peerRecords: number;
  notificationRecords: number;
  metaContinueRecords: number;
  subagentFiles: number;
  workflowJournals: number;
  localCommandRecords: number;
  /** Exchanges written by a pre-"modern" CLI (no origin / permissionMode / effort fields). */
  legacyEraExchanges: number;
  agentInitiatedExchanges: number;
}

export interface ClaudeRender {
  files: OutFile[];
  sessionFile: Map<number, string>;
  noise: ClaudeNoise;
}

const SUB_MODEL = "claude-sonnet-5-5";

export function renderClaude(p: SynthParams, plan: Plan): ClaudeRender {
  const noise: ClaudeNoise = {
    replayedRecords: 0, replayedHumanPrompts: 0, streamingExtraLines: 0, peerRecords: 0, notificationRecords: 0,
    metaContinueRecords: 0, subagentFiles: 0, workflowJournals: 0, localCommandRecords: 0, legacyEraExchanges: 0,
    agentInitiatedExchanges: 0,
  };
  const files: OutFile[] = [];
  const sessionFile = new Map<number, string>();
  const writers = new Map<number, SessionWriter>();
  for (const s of plan.sessions) {
    if (s.agent !== "claude-code" || !s.exchanges.length) continue;
    const project = plan.projects[s.projectIdx]!;
    const w = new SessionWriter(p, s, project, noise, s.resumeOf !== undefined ? writers.get(s.resumeOf) : undefined);
    w.render();
    writers.set(s.idx, w);
    files.push(...w.files);
    sessionFile.set(s.idx, w.mainPath);
  }
  return { files, sessionFile, noise };
}

class SessionWriter {
  readonly files: OutFile[] = [];
  readonly mainPath: string;
  /** Conversation records per exchange (for replay into a resumed session). */
  readonly recs: Rec[][] = [];
  private lines: string[] = [];
  private parent: string | null = null;
  private rng: Rng;
  private slug: string;
  private lastConfig: ConfigState | undefined;
  private lastModel: string | undefined;
  private lastMode: string | undefined;
  private lastTs = 0;
  private toolIds = new Map<Call, string>();
  private toolRecUuid = new Map<Call, string>();
  private humanUuids = new Set<string>();

  constructor(
    private p: SynthParams, private s: Session, private project: Project, private noise: ClaudeNoise,
    private resumed: SessionWriter | undefined,
  ) {
    this.rng = new Rng(p.seed, `claude/${s.idx}`);
    this.slug = `${this.rng.pick(V.ADJECTIVES)}-${this.rng.pick(V.NOUNS)}-${this.rng.pick(V.MODULES)}`;
    this.mainPath = `claude/projects/${project.encoded}/${s.id}.jsonl`;
  }

  render(): void {
    if (this.resumed && this.s.resumeReplay > 0) this.replay();
    this.s.exchanges.forEach((ex, i) => this.renderExchange(ex, i));
    this.finish();
  }

  // ------------------------------------------------------------------ plumbing

  private touch(ms: number): void {
    if (ms > this.lastTs) this.lastTs = ms;
  }

  private tail(ex: Exchange): Rec {
    return {
      userType: "external", entrypoint: ex.env.entrypoint, cwd: this.project.cwd, sessionId: this.s.id,
      version: ex.env.version, gitBranch: this.project.branch, slug: this.slug,
    };
  }

  /** Append a conversation record (has uuid, chained to the previous one). */
  private conv(exRecs: Rec[], ex: Exchange, type: string, tsMs: number, lead: Rec, body: Rec, extra: Rec = {}): Rec {
    const uuid = this.rng.uuid();
    const rec: Rec = {
      parentUuid: this.parent, isSidechain: false, ...lead, type, ...body, uuid, timestamp: iso(tsMs), ...extra, ...this.tail(ex),
    };
    this.parent = uuid;
    this.lines.push(jsonLine(rec));
    exRecs.push(rec);
    this.touch(tsMs);
    return rec;
  }

  /** Append a bookkeeping record (no uuid / not part of the chain). */
  private meta(rec: Rec): void {
    this.lines.push(jsonLine(rec));
  }

  private replay(): void {
    const src = this.resumed!;
    const from = Math.max(0, src.recs.length - this.s.resumeReplay);
    for (let i = from; i < src.recs.length; i++) {
      for (const rec of src.recs[i]!) {
        // Replayed records keep the ORIGINAL sessionId: same uuid, a sessionId that is not this file's own.
        const copy: Rec = { ...rec };
        this.lines.push(jsonLine(copy));
        this.parent = String(copy.uuid);
        this.noise.replayedRecords++;
        if (src.humanUuids.has(String(copy.uuid))) {
          this.noise.replayedHumanPrompts++;
          this.humanUuids.add(String(copy.uuid));
        }
        const ts = Date.parse(String(copy.timestamp));
        if (Number.isFinite(ts)) this.touch(ts);
      }
    }
  }

  private finish(): void {
    const last = [...this.s.exchanges].reverse().find((e) => e.human);
    if (last) this.meta({ type: "last-prompt", lastPrompt: last.prompt, sessionId: this.s.id });
    const lastEx = this.s.exchanges[this.s.exchanges.length - 1]!;
    const total = this.s.exchanges.reduce((a, e) => a + layoutExchange(e).endOff, 0);
    this.meta({
      type: "cost-state", sessionId: this.s.id,
      costState: { modelUsage: { [lastEx.env.model]: { inputTokens: 1000, outputTokens: 500, costUSD: 1 } }, totalLinesAdded: 10, totalLinesRemoved: 4, totalDuration: total },
    });
    this.files.unshift({ path: this.mainPath, data: joinLines(this.lines), mtimeMs: this.lastTs });
  }

  // ------------------------------------------------------------------ exchange

  private renderExchange(ex: Exchange, exIdx: number): void {
    const modern = isClaudeModern(ex.env.version);
    if (!modern) this.noise.legacyEraExchanges++;
    if (!ex.human) this.noise.agentInitiatedExchanges++;
    const exRecs: Rec[] = [];
    this.recs[exIdx] = exRecs;
    const L = layoutExchange(ex);
    const t0 = ex.startMs;
    const T = (off: number): number => t0 + off;
    const first = ex.seq === 0;

    // ---- before the prompt
    if (modern && (first || this.lastMode !== ex.env.mode)) {
      this.meta({ type: "permission-mode", permissionMode: ex.env.mode, sessionId: this.s.id });
    }
    ex.commands.forEach((cmd, i) => {
      // The record carrying <command-name> is at commandOffsetMs; the caveat precedes it and the stdout follows.
      const base = t0 + commandOffsetMs("claude-code", i) - 1;
      const label = cmd.kind;
      this.conv(exRecs, ex, "user", base, {}, { message: { role: "user", content: `<local-command-caveat>${V.LOCAL_COMMAND_CAVEAT}</local-command-caveat>` } }, { isMeta: true });
      this.conv(exRecs, ex, "user", base + 1, {}, { message: { role: "user", content: V.fill(V.COMMAND_TEXT, this.rng, { cmd: label, arg: cmd.to }) } });
      this.conv(exRecs, ex, "user", base + 2, {}, { message: { role: "user", content: V.fill(V.COMMAND_STDOUT, this.rng, { cmd: label, arg: cmd.to }) } });
      this.noise.localCommandRecords += 3;
    });

    // ---- the prompt
    if (ex.human) {
      const promptId = this.rng.uuid();
      if (modern) {
        this.meta({
          type: "file-history-snapshot", messageId: promptId,
          snapshot: { messageId: promptId, trackedFileBackups: {}, timestamp: iso(t0) }, isSnapshotUpdate: false,
        });
      }
      const content = ex.promptAsBlocks ? [{ type: "text", text: ex.prompt }] : ex.prompt;
      const rec = this.conv(exRecs, ex, "user", T(0), modern ? { promptId } : {}, { message: { role: "user", content } },
        modern ? { permissionMode: ex.env.mode, promptSource: "typed", origin: { kind: "human" } } : {});
      this.humanUuids.add(String(rec.uuid));
    } else {
      this.notification(exRecs, ex, T(0), modern);
    }
    this.attach(exRecs, ex, T(1), first, modern);
    if (ex.peerNoise && modern) this.peerRecord(exRecs, ex, T(30));

    // ---- model responses
    ex.steps.forEach((step, i) => {
      const sl = L.steps[i]!;
      if (step.afterNotification && i > 0) this.notification(exRecs, ex, T(sl.notifOff ?? 0), modern);
      if (ex.compaction && ex.compaction.atStep === i) this.compact(exRecs, ex, T(sl.compactOff ?? 0), modern);
      if (step.metaContinue) {
        this.conv(exRecs, ex, "user", T(sl.metaOff ?? 0), {}, { message: { role: "user", content: V.META_CONTINUE_TEXT } },
          modern ? { isMeta: true, origin: { kind: "system" }, promptSource: "system" } : { isMeta: true });
        this.noise.metaContinueRecords++;
      }
      step.retries.forEach((r, k) => {
        this.conv(exRecs, ex, "system", T(sl.retryOffs[k]!), {}, {
          subtype: "api_error", level: "error",
          error: { status: r.status, requestID: `req_011C${this.rng.base62(20)}`, error: { type: "error", error: { type: "overloaded_error", message: V.API_ERROR_RETRY } } },
          retryInMs: r.retryInMs, retryAttempt: k + 1, maxRetries: Math.max(step.retries.length, 5),
        }, { isMeta: false });
      });
      if (step.failed) {
        this.conv(exRecs, ex, "assistant", T(sl.startOff), {}, {
          message: {
            id: `msg_01${this.rng.base62(22)}`, type: "message", role: "assistant", model: "<synthetic>",
            content: [{ type: "text", text: V.API_ERROR_TEXT }], stop_reason: "stop_sequence", stop_sequence: "",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }, { error: "rate_limit", isApiErrorMessage: true, apiErrorStatus: 529 });
        return;
      }
      this.assistantStep(exRecs, ex, step, sl.startOff, sl.endOff, T, modern);

      // tool results
      step.calls.forEach((call, j) => {
        this.toolResult(exRecs, ex, call, T(sl.resultOffs[j]!), T(sl.endOff), modern);
      });
      // queued prompts typed during this step
      ex.queued.forEach((q, qi) => {
        if (q.afterStep !== i) return;
        const ql = L.queued[qi]!;
        this.meta({ type: "queue-operation", operation: "enqueue", timestamp: iso(T(ql.enqOff)), sessionId: this.s.id, content: q.text });
        const asBlocks = this.rng.chance(0.25);
        this.conv(exRecs, ex, "attachment", T(ql.deliverOff), {}, {
          attachment: { type: "queued_command", prompt: asBlocks ? [{ type: "text", text: q.text }] : q.text, commandMode: "prompt", ...(modern ? { origin: { kind: "human" } } : {}) },
        });
        this.meta({ type: "queue-operation", operation: "remove", timestamp: iso(T(ql.deliverOff)), sessionId: this.s.id });
      });
    });

    // ---- interrupt
    if (ex.interrupt) {
      const text = ex.interrupt === "tool-use" ? V.INTERRUPT_TOOL_TEXT : V.INTERRUPT_TEXT;
      const asString = modern ? this.rng.chance(0.1) : this.rng.chance(0.5);
      this.conv(exRecs, ex, "user", T(L.interruptOff!), {}, {
        message: { role: "user", content: asString ? text : [{ type: "text", text }] },
      }, modern ? { origin: { kind: "human" } } : {});
    }

    // ---- end of turn
    const endTs = ex.glitchShiftMs > 0 ? T(L.endOff) - ex.glitchShiftMs : T(L.endOff);
    if (ex.hookSummary) {
      this.conv(exRecs, ex, "system", T(L.endOff), {}, {
        subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: V.STOP_HOOK_COMMAND }], hookErrors: [],
        preventedContinuation: false, stopReason: "", hasOutput: false, level: "suggestion", toolUseID: `toolu_01${this.rng.base62(22)}`,
      }, { isMeta: false });
    }
    this.conv(exRecs, ex, "system", endTs, {}, {
      subtype: "turn_duration", durationMs: L.endOff, messageCount: ex.steps.length * 2,
    }, { isMeta: false });

    this.lastConfig = ex.config;
    this.lastModel = ex.env.model;
    this.lastMode = ex.env.mode;
    if (ex.seq === 0) {
      this.meta({ type: "ai-title", aiTitle: V.fill(this.rng.pick(V.AI_TITLES), this.rng), sessionId: this.s.id });
    }
  }

  // ------------------------------------------------------------------ attachments

  private attach(exRecs: Rec[], ex: Exchange, ts: number, first: boolean, modern: boolean): void {
    const out: Rec[] = [];
    const c = ex.config;
    const prev = this.lastConfig;
    if (first || this.lastModel !== ex.env.model) {
      out.push({ type: "environment", platform: "darwin", shell: "zsh", osVersion: "Darwin 27.0.0", model: ex.env.model });
      if (modern) out.push({ type: "identity", modelId: ex.env.model, marketingName: marketing(ex.env.model), knowledgeCutoff: "2026-01" });
    }
    if (first || prev!.skills !== c.skills) {
      out.push({ type: "skill_listing", skillCount: c.skills, skills: Array.from({ length: c.skills }, (_, i) => `synth-skill-${i + 1}`) });
    }
    if (first || prev!.mcp.join() !== c.mcp.join()) {
      const names = (servers: string[]): string[] => servers.flatMap((sv) => [`mcp__${sv}__search`, `mcp__${sv}__read`]);
      const before = first ? [] : prev!.mcp;
      out.push({
        type: "deferred_tools_delta",
        addedNames: names(c.mcp.filter((x) => !before.includes(x))),
        removedNames: names(before.filter((x) => !c.mcp.includes(x))),
      });
    }
    if (first || prev!.instructionsRev !== c.instructionsRev) {
      out.push({ type: "instructions", path: `${this.project.cwd}/CLAUDE.md`, content: V.fill(V.INSTRUCTIONS_TEXT, this.rng, { rev: String(c.instructionsRev) }) });
    }
    if (first || prev!.systemPromptRev !== c.systemPromptRev) {
      out.push({ type: "system_prompt", systemPrompt: V.fill(V.SYSTEM_PROMPT_TEXT, this.rng, { rev: String(c.systemPromptRev) }) });
    }
    // Hook / plugin / settings listings only show up once they differ from the stock configuration.
    const stock = initialConfig();
    if (first ? c.hooks !== stock.hooks : prev!.hooks !== c.hooks) out.push({ type: "hook_listing", hookCount: c.hooks });
    if (first ? c.plugins !== stock.plugins : prev!.plugins !== c.plugins) out.push({ type: "plugin_listing", pluginCount: c.plugins });
    if (first ? c.configRev !== stock.configRev : prev!.configRev !== c.configRev) out.push({ type: "settings_revision", revision: c.configRev });
    if (this.rng.chance(0.3)) out.push({ type: "total_tokens_reminder", usedTokens: this.rng.int(10_000, 150_000), totalTokens: 200_000 });
    out.forEach((a, i) => this.conv(exRecs, ex, "attachment", ts + i, {}, { attachment: a }));
  }

  private notification(exRecs: Rec[], ex: Exchange, ts: number, modern: boolean): void {
    this.conv(exRecs, ex, "user", ts, {}, {
      message: { role: "user", content: V.fill(V.TASK_NOTIFICATION, this.rng, { id: this.rng.hex(8) }) },
    }, modern ? { origin: { kind: "task-notification" }, isMeta: false } : {});
    this.noise.notificationRecords++;
  }

  private peerRecord(exRecs: Rec[], ex: Exchange, ts: number): void {
    const peer = this.rng.chance(0.5);
    const text = peer ? V.fill(V.PEER_MESSAGE, this.rng) : V.fill(V.TASK_NOTIFICATION, this.rng, { id: this.rng.hex(8) });
    this.conv(exRecs, ex, "attachment", ts, {}, {
      attachment: { type: "queued_command", prompt: text, commandMode: "prompt", origin: { kind: peer ? "peer" : "task-notification" } },
    }, peer ? {} : { isMeta: true });
    this.noise.peerRecords++;
  }

  private compact(exRecs: Rec[], ex: Exchange, ts: number, modern: boolean): void {
    const c = ex.compaction!;
    this.conv(exRecs, ex, "system", ts, {}, {
      subtype: "compact_boundary", content: V.COMPACT_CONTENT, level: "info",
      compactMetadata: { trigger: c.trigger, preTokens: c.preTokens, postTokens: c.postTokens },
    }, { isMeta: false });
    this.conv(exRecs, ex, "user", ts + 1, {}, {
      message: { role: "user", content: V.fill(V.COMPACT_SUMMARY, this.rng) },
    }, { isMeta: false, isCompactSummary: true, isVisibleInTranscriptOnly: true, ...(modern ? { origin: { kind: "system" } } : {}) });
  }

  // ------------------------------------------------------------------ assistant

  private assistantStep(
    exRecs: Rec[], ex: Exchange, step: Exchange["steps"][number], startOff: number, endOff: number,
    T: (off: number) => number, modern: boolean,
  ): void {
    const blocks: Rec[] = [];
    if (step.thinking) blocks.push({ type: "thinking", thinking: step.thinking.text, signature: this.rng.base64(step.thinking.chars) });
    if (step.text) blocks.push({ type: "text", text: step.text });
    for (const call of step.calls) {
      const id = `toolu_01${call.id}${this.rng.base62(6)}`;
      this.toolIds.set(call, id);
      blocks.push({ type: "tool_use", id, name: call.tool, input: this.toolInput(call) });
    }
    const msgId = `msg_01${this.rng.base62(22)}`;
    const requestId = `req_011C${this.rng.base62(20)}`;
    const n = blocks.length;
    const interrupted = ex.steps[ex.steps.length - 1] === step && (ex.interrupt === "text" || ex.otherAbort);
    const finalStop = step.maxTokens ? "max_tokens" : step.calls.length ? "tool_use" : interrupted ? null : "end_turn";
    const lastNull = this.rng.chance(0.03);
    const model = ex.env.model;
    blocks.forEach((block, k) => {
      const last = k === n - 1;
      const out = last ? step.usage.out : Math.max(1, Math.min(step.usage.out - 1, Math.floor((step.usage.out * (k + 1)) / n)));
      const ts = startOff + Math.round(((endOff - startOff) * (k + 1)) / n);
      const rec = this.conv(exRecs, ex, "assistant", T(ts), {}, {
        message: {
          model, id: msgId, type: "message", role: "assistant", content: [block],
          stop_reason: last && !lastNull ? finalStop : null, stop_sequence: null, usage: this.usage(step.usage, out, modern, step.thinking ? Math.round(step.thinking.chars * 0.25) : 0),
        },
        requestId,
      }, modern ? { effort: ex.env.effort } : {});
      if (k > 0) this.noise.streamingExtraLines++;
      if (block.type === "tool_use") {
        const call = step.calls.find((c) => this.toolIds.get(c) === block.id);
        if (call) this.toolRecUuid.set(call, String(rec.uuid));
      }
    });
  }

  private usage(u: Usage, out: number, modern: boolean, thinkingTokens: number): Rec {
    const write5 = Math.floor(u.cacheWrite / 2);
    const o: Rec = {
      input_tokens: u.in, cache_creation_input_tokens: u.cacheWrite, cache_read_input_tokens: u.cacheRead,
      cache_creation: { ephemeral_5m_input_tokens: write5, ephemeral_1h_input_tokens: u.cacheWrite - write5 },
      output_tokens: out, service_tier: "standard",
    };
    if (modern) {
      o.speed = "standard";
      o.output_tokens_details = { thinking_tokens: thinkingTokens };
    }
    return o;
  }

  private toolInput(call: Call): Rec {
    const f = call.file ? `${this.project.cwd}/${call.file}` : undefined;
    switch (call.tool) {
      case "Read": return { file_path: f };
      case "Grep": return { pattern: this.rng.pick(V.NOUNS), path: `${this.project.cwd}/src` };
      case "Glob": return { pattern: "src/**/*.ts" };
      case "LS": return { path: `${this.project.cwd}/src` };
      case "Edit": return { file_path: f, old_string: V.EDIT_OLD, new_string: V.EDIT_NEW };
      case "Write": return { file_path: f, content: V.WRITE_CONTENT };
      case "MultiEdit": return { file_path: f, edits: [{ old_string: V.EDIT_OLD, new_string: V.EDIT_NEW }] };
      case "NotebookEdit": return { notebook_path: f, new_source: V.EDIT_NEW, edit_mode: "replace" };
      case "Bash": return { command: call.cmd ?? "ls", description: V.fill(this.rng.pick(V.BASH_DESCRIPTIONS), this.rng) };
      case "WebFetch": return { url: "https://example.invalid/docs", prompt: V.fill(V.WEBFETCH_PROMPT, this.rng) };
      case "TodoWrite": return { todos: [{ content: V.fill(V.TODO_CONTENT, this.rng), status: "pending", activeForm: V.fill(V.TODO_ACTIVE, this.rng) }] };
      case "Task": return { description: V.fill(this.rng.pick(V.SUBAGENT_DESCRIPTIONS), this.rng), prompt: call.sub!.prompt, subagent_type: "general-purpose" };
      default: return {};
    }
  }

  private resultText(call: Call): string {
    const rng = this.rng;
    const slots = { path: call.file ? `${this.project.cwd}/${call.file}` : this.project.cwd, tool: call.tool };
    if (call.outcome === "rejected") return V.REJECTION_OUTPUT;
    if (call.outcome === "blocked") return V.fill(V.BLOCKED_OUTPUT[call.denial as keyof typeof V.BLOCKED_OUTPUT], rng, slots);
    if (call.outcome === "error") {
      const t = (V.ERROR_OUTPUTS as Record<string, string>)[call.tool] ?? V.ERROR_OUTPUTS.default;
      return V.fill(t, rng);
    }
    switch (call.tool) {
      case "Read": return [1, 2, 3].map((i) => `     ${i}\t${V.fill(V.READ_OUTPUT.replace("{n}\t", ""), rng)}`).join("\n");
      case "Grep": case "Glob": case "LS": return V.fill(V.GREP_OUTPUT, rng);
      case "Edit": case "MultiEdit": case "NotebookEdit": return V.fill(V.EDIT_OUTPUT_OK, rng, slots);
      case "Write": return V.fill(V.WRITE_OUTPUT_OK, rng, slots);
      case "Bash": return V.fill(V.BASH_OUTPUT_OK, rng);
      case "Task": return call.sub!.resultText;
      default: return V.fill(V.GENERIC_OUTPUT_OK, rng);
    }
  }

  private toolResult(exRecs: Rec[], ex: Exchange, call: Call, ts: number, stepEndTs: number, modern: boolean): void {
    const content = this.resultText(call);
    const isErr = call.outcome !== "ok";
    const block: Rec = { tool_use_id: this.toolIds.get(call), type: "tool_result", content };
    if (isErr) block.is_error = true;
    const extra: Rec = {
      toolUseResult: call.outcome === "rejected" ? V.REJECTION_RESULT : isErr ? content : call.sub ? { status: "completed", agentId: call.sub.agentId, content: [{ type: "text", text: content }] } : content,
      sourceToolAssistantUUID: this.toolRecUuid.get(call),
    };
    if (call.denial) extra.toolDenialKind = call.denial;
    this.conv(exRecs, ex, "user", ts, {}, { message: { role: "user", content: [block] } }, extra);
    if (call.sub) this.subagent(ex, call, stepEndTs + 100, modern);
  }

  // ------------------------------------------------------------------ subagents

  private subagent(ex: Exchange, call: Call, base: number, modern: boolean): void {
    const sub: SubPlan = call.sub!;
    const dir = `claude/projects/${this.project.encoded}/${this.s.id}/subagents${sub.workflow ? `/workflows/${sub.workflow}` : ""}`;
    const path = `${dir}/agent-${sub.agentId}.jsonl`;
    const lines: string[] = [];
    let parent: string | null = null;
    let last = base;
    const tail = (): Rec => ({ userType: "external", cwd: this.project.cwd, sessionId: this.s.id, version: ex.env.version, gitBranch: this.project.branch, agentId: sub.agentId, slug: this.slug });
    const put = (type: string, ts: number, body: Rec, extra: Rec = {}): Rec => {
      const uuid = this.rng.uuid();
      const rec: Rec = { parentUuid: parent, isSidechain: true, type, ...body, uuid, timestamp: iso(ts), ...extra, ...tail() };
      parent = uuid;
      lines.push(jsonLine(rec));
      last = Math.max(last, ts);
      return rec;
    };
    put("user", base, { message: { role: "user", content: sub.prompt } }, modern ? { promptSource: "system", origin: { kind: "system" } } : {});
    let cursor = base + 200;
    for (const st of sub.steps) {
      const blocks: Rec[] = [];
      const ids = new Map<Call, string>();
      if (st.text) blocks.push({ type: "text", text: st.text });
      for (const c of st.calls) {
        const id = `toolu_01${c.id}${this.rng.base62(6)}`;
        ids.set(c, id);
        blocks.push({ type: "tool_use", id, name: c.tool, input: this.subToolInput(c) });
      }
      if (!blocks.length) blocks.push({ type: "text", text: sub.resultText });
      const msgId = `msg_01${this.rng.base62(22)}`;
      const requestId = `req_011C${this.rng.base62(20)}`;
      const end = cursor + st.latencyMs;
      const uuids = new Map<Call, string>();
      blocks.forEach((block, k) => {
        const lastBlock = k === blocks.length - 1;
        const out = lastBlock ? st.usage.out : Math.max(1, Math.min(st.usage.out - 1, Math.floor((st.usage.out * (k + 1)) / blocks.length)));
        const rec = put("assistant", cursor + Math.round(((end - cursor) * (k + 1)) / blocks.length), {
          message: {
            model: SUB_MODEL, id: msgId, type: "message", role: "assistant", content: [block],
            stop_reason: lastBlock ? (st.calls.length ? "tool_use" : "end_turn") : null, stop_sequence: null,
            usage: this.usage(st.usage, out, modern, 0),
          },
          requestId,
        });
        if (block.type === "tool_use") {
          const c = st.calls.find((x) => ids.get(x) === block.id);
          if (c) uuids.set(c, String(rec.uuid));
        }
        if (k > 0) this.noise.streamingExtraLines++;
      });
      cursor = end;
      let res = end;
      for (const c of st.calls) {
        res = Math.max(res, end + c.execMs);
        const isErr = c.outcome !== "ok";
        const content = isErr ? V.fill(V.ERROR_OUTPUTS.default, this.rng) : V.fill(V.GENERIC_OUTPUT_OK, this.rng);
        const blockRes: Rec = { tool_use_id: ids.get(c), type: "tool_result", content };
        if (isErr) blockRes.is_error = true;
        put("user", res, { message: { role: "user", content: [blockRes] } }, { toolUseResult: content, sourceToolAssistantUUID: uuids.get(c) });
      }
      cursor = res;
    }
    this.files.push({ path, data: joinLines(lines), mtimeMs: last });
    this.files.push({
      path: `${dir}/agent-${sub.agentId}.meta.json`,
      data: JSON.stringify({ agentType: "general-purpose", description: V.fill(this.rng.pick(V.SUBAGENT_DESCRIPTIONS), this.rng) }) + "\n",
      mtimeMs: last,
    });
    this.noise.subagentFiles++;
    this.touch(last);
    if (sub.workflow) {
      const journal = [
        { type: "workflow_event", event: "step_started", timestamp: iso(base) },
        { type: "workflow_event", event: "step_finished", timestamp: iso(last) },
      ].map(jsonLine);
      this.files.push({ path: `${dir}/journal.jsonl`, data: joinLines(journal), mtimeMs: last });
      this.noise.workflowJournals++;
    }
  }

  private subToolInput(c: Call): Rec {
    switch (c.tool) {
      case "Read": return { file_path: `${this.project.cwd}/${c.file ?? "src/index.ts"}` };
      case "Grep": return { pattern: this.rng.pick(V.NOUNS), path: `${this.project.cwd}/src` };
      case "Glob": return { pattern: "src/**/*.ts" };
      case "LS": return { path: `${this.project.cwd}/src` };
      default: return { command: c.cmd ?? "ls", description: V.fill(this.rng.pick(V.BASH_DESCRIPTIONS), this.rng) };
    }
  }
}

function marketing(model: string): string {
  const parts = model.replace(/^claude-/, "").split("-");
  const name = parts[0] ?? "model";
  return `${name[0]?.toUpperCase() ?? ""}${name.slice(1)} ${parts.slice(1).join(".")}`.trim();
}
