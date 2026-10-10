/**
 * Parse one Claude Code session (main transcript + its subagent transcripts) into exchanges and
 * change events. Prompt text, tool inputs and paths are inspected in memory only; the output holds
 * counts, allow-listed labels and salted hashes.
 */
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { promptEnglish } from "../../language.js";
import { isPushback } from "../../pushback.js";
import { isNearDuplicate } from "../../similarity.js";
import { emptyStats, type Exchange, type FileStamp, type ParseContext, type ParseResult, type ParseStats, type Source } from "../../types.js";
import { cleanTime, noteBadTime, obj, readJsonl } from "../../util.js";
import { ChangeTracker, shortHash } from "./events.js";
import { ExchangeAcc, RecentTools } from "./exchange.js";
import { SessionClassifier } from "./interactive.js";
import { countUnknown, isKnownType } from "./kinds.js";
import { entrypointLabel, isKnownLabel, modelLabel, modeLabel, versionLabel } from "./labels.js";
import { classify } from "./list.js";
import { priorsFor, rememberUuids, usePriorCache, type Priors } from "./priors.js";
import { originalFolder } from "./project.js";
import {
  ABORTED_PREFIX, blocks, effortOf, errorSide, humanPromptText, isInterruptRecord, localCommand, queuedHumanText,
  queueRemoveText, stepKey, str, textParts, toolResultKind, toolUse, type Rec,
} from "./records.js";
import { mcpServersIn, SeenSet, skillsIn, systemPromptText } from "./setup.js";
import { StepMerger, type TokenSink } from "./steps.js";
import { attributeSubagents, readSubagent, spawnKeys, type MainView, type SpawnLinks, type SubagentAcc } from "./subagents.js";

export async function parseSource(source: Source, ctx: ParseContext): Promise<ParseResult> {
  const stats = emptyStats();
  const files = classify(source.files);
  if (!files) return { exchanges: [], events: [], stats };
  // Sessions created earlier in the same project (none for the oldest): read for resume dedupe only (or their stored
  // record ids, when the store backs the index).
  usePriorCache(ctx.priorCache);
  const priors = await priorsFor(files.main);
  const main = new MainThread(source.key, files.main, ctx, stats, priors);
  stats.files++;
  try {
    await main.read();
    main.complete = true;
  } catch {
    stats.filesFailed++; // partial results are kept; the file's uuids are not memoised
  }
  const subs: SubagentAcc[] = [];
  for (const f of files.subagents) {
    stats.files++;
    try {
      subs.push(await readSubagent(f, ctx, stats, main.view));
    } catch {
      stats.filesFailed++;
    }
  }
  return main.finish(subs);
}

/** In-memory digest used only to match a queued prompt with its queue-operation record. */
function digest(text: string): string {
  return createHash("sha256").update(text).digest("base64");
}

/** A label that names a value: only these move setup state (an "other" label is reported, never tracked). */
function known(label: string | undefined): string | undefined {
  return isKnownLabel(label) ? label : undefined;
}

interface PendingRemove { key: string; x: ExchangeAcc | undefined; pushback: boolean }

/** A main-thread record that arrived before any exchange was open and did not open one itself. */
interface StretchStart { d: Rec; ts: string | undefined; t: string | undefined }

class MainThread {
  private readonly session: string;
  /** Encoded project folder the file lives in now (the project id, unless the session was moved here: D62b). */
  private readonly folder: string;
  private readonly seen = new Set<string>();
  private readonly seenToolUse = new Set<string>();
  private readonly seenToolResult = new Set<string>();
  private readonly steps = new StepMerger<ExchangeAcc>();
  /** Sidechain responses in the main transcript; their tokens go to the exchange's sideTokens. */
  private readonly sideSteps = new StepMerger<TokenSink>();
  /**
   * Merge keys (requestId / message id) of replayed responses: counted in the session they came from, so a re-stamped
   * copy (new uuid, same response) in a fork subagent or an aside is a duplicate, never new tokens (AGENTS.md rule 6).
   */
  private readonly replayedSteps = new Set<string>();
  private readonly exchanges: ExchangeAcc[] = [];
  private readonly recent = new RecentTools();
  private readonly toolOwner = new Map<string, ExchangeAcc>();
  /** tool_use id → whether it runs a shell command (the tool-error split), for every tool_use seen. */
  private readonly toolCommand = new Map<string, boolean>();
  private readonly classifier = new SessionClassifier();
  /** Permission-mode label in effect (exchange labels); the tracker holds only named modes. */
  private modeNow: string | undefined;
  private readonly links: SpawnLinks = { agents: new Map(), runs: new Map() };
  private readonly queued = new Set<string>();
  private readonly removes: PendingRemove[] = [];
  private readonly tracker: ChangeTracker;
  private readonly mcpSeen = new SeenSet();
  private readonly skillsSeen = new SeenSet();
  private cur: ExchangeAcc | undefined;
  /**
   * Earliest non-prompt user record (e.g. a task notification) seen while no exchange is open. If
   * agent activity follows, it starts that agent-initiated exchange (t, id, clock); if a human prompt
   * comes first, it is dropped. On its own it never opens an exchange.
   */
  private pending: StretchStart | undefined;
  private lastTs: string | undefined;
  private compacted = false;
  private prevPrompt: string | undefined;
  /** Human prompts and model responses seen so far, replayed history included (settles setup baselines). */
  private promptsSeen = 0;
  private responsesSeen = 0;
  /** Set once the whole main file was read (only then is its uuid set worth memoising). */
  complete = false;
  /**
   * EnterWorktree / ExitWorktree move a session's transcript to the new working directory's project folder and append
   * a `relocated` record (D62b). The working directory of the file's first and latest records (in memory only) tells
   * where the session started, so a moved session keeps its original project id.
   */
  private moved = false;
  private firstCwd: string | undefined;
  private lastCwd: string | undefined;
  private movedTo: string | undefined;

  constructor(
    private readonly key: string,
    private readonly file: FileStamp,
    private readonly ctx: ParseContext,
    private readonly stats: ParseStats,
    private readonly priors: Priors,
  ) {
    this.session = ctx.hash(basename(file.path, ".jsonl"), "s-");
    this.folder = basename(dirname(file.path));
    this.tracker = new ChangeTracker(ctx, this.session);
  }

  async read(): Promise<void> {
    for await (const d of readJsonl(this.file.path, this.stats)) this.record(d);
  }

  /** The main transcript as its subagents see it (they are read after it). */
  get view(): MainView {
    return {
      hasRecord: (uuid) => this.seen.has(this.priors.id(uuid)),
      hasToolUse: (id) => this.seenToolUse.has(id),
      hasStep: (key) => this.steps.has(key) || this.sideSteps.has(key) || this.replayedSteps.has(key),
    };
  }

  /**
   * The session's project id: the folder it started in when a `relocated` record says the file was moved here and
   * the records' working directories establish that folder (project.ts originalFolder), else the folder it is in.
   */
  private projectId(): string {
    const from = this.moved ? originalFolder(this.folder, this.firstCwd, [this.lastCwd, this.movedTo]) : undefined;
    return this.ctx.hash(from ?? this.folder, "p-");
  }

  /**
   * A `relocated` record: `{ type, sessionId, relocatedCwd }` (the shape on real logs, D62c key-name probe: three string
   * keys, no uuid or timestamp). `relocatedCwd` is the working directory the transcript was moved for.
   */
  private relocation(d: Rec): void {
    this.moved = true;
    const to = str(d.relocatedCwd);
    if (to !== undefined) this.movedTo = to;
  }

  private record(d: Rec): void {
    const type = typeof d.type === "string" ? d.type : undefined;
    const uuid = str(d.uuid);
    if (uuid !== undefined) {
      // Keyed by the index's id (a salted digest when the store backs it): one digest per record.
      const id = this.priors.id(uuid);
      const dup = this.seen.has(id) || this.priors.hasId(id);
      this.seen.add(id);
      if (dup) {
        this.stats.duplicates++;
        this.replayed(d, type);
        return;
      }
    }
    const cwd = str(d.cwd);
    if (cwd) {
      this.firstCwd ??= cwd;
      this.lastCwd = cwd;
    }
    let ts: string | undefined;
    if (d.timestamp !== undefined) {
      ts = cleanTime(d.timestamp, this.ctx.now);
      if (!ts) noteBadTime(this.stats, d.timestamp, this.ctx.now);
    }
    if (d.isSidechain === true) return this.sidechain(d, type);
    // The records that carry `entrypoint` in real logs (a counts-only check of field names; the same ones the entrypoint
    // label reads).
    if (type === "user" || type === "assistant") this.classifier.entrypoint(d.entrypoint);
    if (ts) this.lastTs = ts;
    switch (type) {
      case "user": return this.user(d, ts);
      case "assistant": return this.assistant(d, ts);
      case "system": return this.system(d, ts);
      case "attachment": return this.attachment(d, ts);
      case "queue-operation": return this.queueOperation(d);
      case "permission-mode": return this.mode(d.permissionMode, this.lastTs, false);
      case "relocated": return this.relocation(d);
      default:
        if (!isKnownType(type)) countUnknown(this.stats, type);
    }
  }

  /**
   * A record already counted (earlier in this file, or in an earlier session this one resumed).
   * Counters skip it, but it is still history: it moves setup state, compaction status, the
   * previous prompt and the recent-tools window, silently.
   */
  private replayed(d: Rec, type: string | undefined): void {
    const msg = obj(d.message);
    if (d.isSidechain === true) {
      // An aside's model/effort is not the session's setup; only its tool ids and response key are history.
      if (type === "assistant" && msg) {
        if (d.isApiErrorMessage !== true && msg.model !== "<synthetic>") this.replayedSteps.add(stepKey(d, msg));
        for (const b of blocks(msg.content)) if (b.type === "tool_use") this.markToolUse(toolUse(b));
      }
      return;
    }
    if (type === "user") {
      const text = humanPromptText(d);
      if (text !== undefined) {
        this.prevPrompt = text;
        this.promptsSeen++;
      }
      this.mode(d.permissionMode, undefined, true);
      this.tracker.observe("version", known(versionLabel(d.version)), undefined, { silent: true });
      const cmd = localCommand(d);
      if (cmd) this.tracker.command(cmd);
    } else if (type === "assistant" && msg && d.isApiErrorMessage !== true && msg.model !== "<synthetic>") {
      this.tracker.observe("version", known(versionLabel(d.version)), undefined, { silent: true });
      this.tracker.observe("model", known(modelLabel(msg.model)), undefined, { silent: true, replayed: true });
      this.tracker.observe("effort", known(effortOf(d)), undefined, { silent: true, replayed: true });
      this.tracker.responded();
      this.responsesSeen++;
      this.replayedSteps.add(stepKey(d, msg));
      for (const b of blocks(msg.content)) {
        if (b.type !== "tool_use") continue;
        const t = toolUse(b);
        this.markToolUse(t);
        this.recent.push(t);
      }
    } else if (type === "system") {
      if (d.subtype === "compact_boundary") this.compacted = true;
      const cmd = localCommand(d);
      if (cmd) this.tracker.command(cmd);
    } else if (type === "attachment") {
      const a = obj(d.attachment);
      if (!a) return;
      const q = queuedHumanText(d, a);
      if (q !== undefined) this.queued.add(digest(q));
      else this.setup(d, a, undefined, true);
    }
  }

  /**
   * The session's permission mode moved (or was restated). The label in effect ("other" for a value outside the
   * mode enum) feeds exchange labels; only a named mode moves the tracker's state and can become an event.
   */
  private mode(raw: unknown, t: string | undefined, silent: boolean): void {
    const label = modeLabel(raw);
    if (label === undefined) return;
    this.modeNow = label;
    this.tracker.observe("mode", known(label), t, { silent });
  }

  /** Records a tool_use id (and whether it runs a command); false if the id was already seen. */
  private markToolUse(t: { id: string | undefined; isCommand: boolean }): boolean {
    const id = t.id;
    if (id === undefined) return true;
    if (this.seenToolUse.has(id)) return false;
    this.seenToolUse.add(id);
    this.toolCommand.set(id, t.isCommand);
    return true;
  }

  /**
   * A sidechain record in the main transcript: a /btw side question or other aside, which may also
   * re-log parent history (research #5, ccusage #913). Like a subagent's work, it is context for the
   * open exchange (subToolCalls/subTokens) and never a step, prompt, interrupt, tool outcome, label,
   * clock tick or setup change, and it never opens an exchange.
   */
  private sidechain(d: Rec, type: string | undefined): void {
    if (type === "assistant") this.sideAssistant(d);
    else if (type === "user") this.sideLinks(d);
    else if (!isKnownType(type)) countUnknown(this.stats, type);
  }

  private sideAssistant(d: Rec): void {
    const msg = obj(d.message);
    if (!msg || d.isApiErrorMessage === true || msg.model === "<synthetic>") return;
    const key = stepKey(d, msg);
    const x = this.cur;
    if (this.steps.has(key) || this.replayedSteps.has(key)) {
      this.stats.duplicates++; // a main-thread (or replayed) response re-logged inside the aside
    } else if (x && !this.sideSteps.observe(key, msg.usage, x.sideTokens)) {
      this.stats.duplicates++; // a later line of a streamed aside response
    }
    for (const b of blocks(msg.content)) {
      if (b.type !== "tool_use") continue;
      const t = toolUse(b);
      if (this.markToolUse(t) && x) x.sideTool(t);
    }
  }

  /** A subagent spawned from inside an aside is credited to the open exchange (unless already linked). */
  private sideLinks(d: Rec): void {
    const x = this.cur;
    if (!x) return;
    const keys = spawnKeys(d.toolUseResult);
    for (const a of keys.agents) if (!this.links.agents.has(a)) this.links.agents.set(a, x);
    for (const r of keys.runs) if (!this.links.runs.has(r)) this.links.runs.set(r, x);
  }

  /**
   * The open exchange, or a new agent-initiated one if activity arrives before any human prompt.
   * The new exchange starts at the held stretch start when there is one (contract: t is the first
   * record of an agent-initiated exchange, and the id derives from that record's uuid).
   */
  private ensure(ts: string | undefined, uuid: string | undefined): ExchangeAcc {
    if (!this.cur) {
      const p = this.pending;
      this.pending = undefined;
      const x = new ExchangeAcc({
        t: p?.t ?? ts ?? this.lastTs,
        firstId: (p && str(p.d.uuid)) ?? uuid,
        human: false,
        afterCompaction: this.compacted,
        mode: this.modeNow,
      });
      if (p) this.touch(x, p.d, p.ts);
      this.exchanges.push(x);
      this.cur = x;
    }
    return this.cur;
  }

  private touch(x: ExchangeAcc, d: Rec, ts: string | undefined): void {
    if (ts) x.tick(ts);
    x.labels.version.add(versionLabel(d.version));
    x.labels.entrypoint.add(entrypointLabel(d.entrypoint));
  }

  private user(d: Rec, ts: string | undefined): void {
    const uuid = str(d.uuid);
    const t = ts ?? this.lastTs;
    const cmd = localCommand(d);
    if (cmd) this.tracker.command(cmd);
    this.mode(d.permissionMode, t, false);
    this.tracker.observe("version", known(versionLabel(d.version)), t);

    const results = blocks(obj(d.message)?.content).filter((b) => b.type === "tool_result");
    if (results.length) {
      this.toolResults(d, results, ts, uuid);
      return;
    }
    if (isInterruptRecord(d)) {
      const x = this.ensure(ts, uuid);
      x.interrupted = 1;
      this.touch(x, d, ts);
      return;
    }
    const text = humanPromptText(d);
    if (text !== undefined) {
      const x = new ExchangeAcc({ t, firstId: uuid, human: true, afterCompaction: this.compacted, mode: this.modeNow });
      this.classifier.humanPrompt(d.promptSource);
      x.promptChars = text.length;
      x.promptEnglish = promptEnglish(text);
      if (isPushback(text) || isNearDuplicate(this.prevPrompt, text)) x.pushback = 1;
      this.prevPrompt = text;
      this.promptsSeen++;
      this.exchanges.push(x);
      this.cur = x;
      this.pending = undefined;
    } else if (!this.cur) {
      this.pending ??= { d, ts, t };
      return;
    }
    this.touch(this.cur, d, ts);
  }

  private toolResults(d: Rec, results: Rec[], ts: string | undefined, uuid: string | undefined): void {
    let owner: ExchangeAcc | undefined;
    for (const b of results) {
      const id = str(b.tool_use_id);
      if (id !== undefined) {
        if (this.seenToolResult.has(id)) { this.stats.duplicates++; continue; }
        this.seenToolResult.add(id);
      }
      const x = (id !== undefined ? this.toolOwner.get(id) : undefined) ?? this.ensure(ts, uuid);
      owner ??= x;
      const isCommand = id !== undefined ? this.toolCommand.get(id) : undefined;
      switch (toolResultKind(d, b)) {
        case "error": x.toolError(errorSide(b, isCommand)); break;
        case "rejected": x.rejections++; if (isCommand) x.commandNotRun(); break;
        case "blocked": x.blocked++; if (isCommand) x.commandNotRun(); break;
        case "interrupt": x.interrupted = 1; break;
        case "ok": break;
      }
    }
    const x = owner ?? this.ensure(ts, uuid);
    this.touch(x, d, ts);
    const keys = spawnKeys(d.toolUseResult);
    for (const a of keys.agents) this.links.agents.set(a, x);
    for (const r of keys.runs) this.links.runs.set(r, x);
  }

  private assistant(d: Rec, ts: string | undefined): void {
    const msg = obj(d.message);
    if (!msg) return;
    const t = ts ?? this.lastTs;
    const x = this.ensure(ts, str(d.uuid));
    this.touch(x, d, ts);
    this.tracker.observe("version", known(versionLabel(d.version)), t);
    if (d.isApiErrorMessage === true) {
      const text = textParts(msg.content).join("\n").trimStart();
      if (text.startsWith(ABORTED_PREFIX)) x.interrupted = 1;
      else x.apiErrors++;
      return;
    }
    if (msg.model === "<synthetic>") return;

    const model = modelLabel(msg.model);
    const effort = effortOf(d);
    this.tracker.observe("model", known(model), t);
    this.tracker.observe("effort", known(effort), t);
    this.tracker.responded();
    this.responsesSeen++;
    if (this.steps.observe(stepKey(d, msg), msg.usage, x)) {
      x.steps++;
      x.labels.model.add(model);
      x.labels.effort.add(effort);
      x.labels.mode.add(this.modeNow);
    } else {
      this.stats.duplicates++; // a later line of a streamed response
    }

    for (const b of blocks(msg.content)) {
      if (b.type === "tool_use") {
        const tool = toolUse(b);
        if (!this.markToolUse(tool)) continue;
        if (tool.id !== undefined) this.toolOwner.set(tool.id, x);
        x.tool(tool, this.recent);
      } else if (b.type === "thinking") {
        x.thinking(str(b.signature), (str(b.thinking) ?? "").trim() === "");
      } else if (b.type === "redacted_thinking") {
        x.thinking(undefined, true);
      }
    }
  }

  private system(d: Rec, ts: string | undefined): void {
    if (d.subtype === "api_error") {
      this.ensure(ts, str(d.uuid)).apiRetries++;
    } else if (d.subtype === "compact_boundary") {
      this.ensure(ts, str(d.uuid)).compactions++;
      this.compacted = true;
    } else {
      const cmd = localCommand(d);
      if (cmd) this.tracker.command(cmd);
    }
  }

  private attachment(d: Rec, ts: string | undefined): void {
    const a = obj(d.attachment);
    if (!a) return;
    const q = queuedHumanText(d, a);
    if (q !== undefined) {
      this.queued.add(digest(q));
      this.classifier.humanPrompt(d.promptSource ?? a.promptSource);
      const x = this.ensure(ts, str(d.uuid));
      x.queuedMidTurn++;
      if (isPushback(q)) x.pushback = 1;
      return;
    }
    this.setup(d, a, ts ?? this.lastTs, false);
  }

  /**
   * Setup state carried by attachments: model identity, MCP servers, skills, system prompt.
   * MCP servers and skills are grow-only "seen in this session" sets: startup announcements and
   * the first exchange form the baseline; afterwards a never-seen server or skill is a change.
   */
  private setup(d: Rec, a: Rec, t: string | undefined, silent: boolean): void {
    if (a.type === "model") {
      this.tracker.observe("model", known(modelLabel(obj(a.identity)?.modelId)), t, { silent, replayed: silent, provenance: "attachment" });
      return;
    }
    const settled = this.promptsSeen >= 2 && this.responsesSeen > 0;
    const quiet = silent || !settled;
    const servers = mcpServersIn(a);
    if (servers) {
      const before = this.mcpSeen.size;
      const added = this.mcpSeen.add(servers);
      if (added || before === 0) {
        const note = `+${added} (${before}->${this.mcpSeen.size} servers)`;
        this.tracker.observe("mcp", shortHash(this.ctx, this.mcpSeen.key()), t, { silent: quiet, note });
      }
      return;
    }
    const skills = skillsIn(a);
    if (skills) {
      this.skillsSeen.add(skills);
      this.tracker.observe("skills", String(this.skillsSeen.size), t, { silent: quiet });
      return;
    }
    if (a.type === "prompt_snapshot") {
      const sp = systemPromptText(a, str(d.cwd));
      if (sp !== undefined) this.tracker.observe("system-prompt", shortHash(this.ctx, sp), t, { silent, version: known(versionLabel(d.version)) });
    }
  }

  /** Legacy mid-turn prompt delivery; deduplicated against queued_command attachments at the end. */
  private queueOperation(d: Rec): void {
    const text = queueRemoveText(d);
    if (text === undefined) return;
    this.removes.push({ key: digest(text), x: this.cur, pushback: isPushback(text) });
  }

  finish(subs: readonly SubagentAcc[]): ParseResult {
    for (const r of this.removes) {
      if (!r.x || this.queued.has(r.key)) continue;
      r.x.queuedMidTurn++;
      if (r.pushback) r.x.pushback = 1;
    }
    const kept = this.exchanges.filter((x) => x.t !== undefined && (x.meaningful || x.compactions > 0));
    attributeSubagents(subs, this.links, kept);
    const exchanges: Exchange[] = [];
    // Cross-file identity for the store's global dedupe: the opening record's uuid (a resumed session that
    // replays it from another project folder, where priors cannot see it, carries the same uuid).
    const origins: (string | null)[] = [];
    const cls = this.classifier.value;
    const project = this.projectId();
    for (const x of kept) {
      const seq = exchanges.length;
      const id = this.ctx.hash(`claude-code|${this.key}|${x.firstId ?? `${x.t}#${seq}`}`, "x-");
      const ex = x.finish({ id, session: this.session, project }, seq, this.ctx.timeZone, cls);
      if (!ex) continue;
      exchanges.push(ex);
      origins.push(x.firstId !== undefined ? this.ctx.hash(`claude-code|record|${x.firstId}`, "o-") : null);
    }
    if (this.complete) rememberUuids(this.file, this.seen);
    // The sessions this one replays (resume dedupe hits): salted ids of their source keys "<project folder>/<file>"
    // (list.ts). Never the key itself: it is an encoded project path.
    const deps = this.priors.matched().map((p) => this.ctx.hash(`${basename(dirname(p))}/${basename(p)}`, "k-"));
    return { exchanges, events: this.tracker.events, stats: this.stats, origins, deps };
  }
}
