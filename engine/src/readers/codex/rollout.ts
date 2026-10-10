/**
 * Single pass over one Codex rollout file → turns with resolved sources.
 *
 * Codex has written two history modes into the same envelope format:
 *  - paginated: canonical `event_msg/item_completed` TurnItems (UserMessage, CommandExecution, …) keyed
 *    by turn_id, plus per-response `token_usage_record`s;
 *  - legacy: response_item messages/calls, `user_message` / `*_end` events and cumulative `token_count` events.
 * Paginated turns also carry the legacy-shaped records, and a migrated file can hold legacy-only turns next
 * to canonical ones, so every source is collected separately and exactly one is chosen per turn at the end:
 *  - a turn with canonical items takes prompts and tools from its items (the legacy twins are dropped and
 *    counted as duplicates);
 *  - a turn without them takes prompts from `user_message` events and tools from `*_end` events; the
 *    response_item branch (prompts from response_item user messages, tools from response_item calls) runs only
 *    in files with no `item_completed` at all (spike: in paginated files those records are
 *    the model-facing transcript, incl. replayed context, and re-counted the first turn's calls);
 *  - usage comes from `token_usage_record`s when the turn has any, else from `token_count`.
 * Imported history (a counter turn id such as `external-import-turn-N`, or the import shape: a user message with
 * no turn_context, no model call and no tool work) is dropped and its records counted as duplicates.
 */
import type { InteractiveClass, ParseStats } from "../../types.js";
import { APPROVAL_POLICIES } from "../../extract/configsnap/vocab.js";
import { bump, cleanLabel, cleanTime, looksSecret, noteBadTime, num, obj, readJsonl, typeKey } from "../../util.js";
import { EFFORTS } from "../claude/labels.js";
import {
  ENVELOPES, EVENT_TYPES, IMPORTED_TURN_ID, ITEM_TYPES, RESPONSE_CALLS, RESPONSE_OUTPUTS, RESPONSE_TYPES, TOOL_ITEMS,
} from "./known.js";
import { isMarker, MarkerReplay, PrefixReplay, recordSig, type Replay, type Sig } from "./fork.js";
import type { CtxObservation, MetaObservation, Msg, ThreadParse, ToolEvent, Turn, Usage } from "./model.js";
import { providerOf, sessionFlags } from "./session.js";
import { classify, classifyParts } from "./text.js";
import { fromEndEvent, fromItem, fromResponseCall, outputFailed } from "./tools.js";

export { entrypointOf } from "./session.js";

export interface RolloutOptions {
  now: Date;
  /** Short salted hash for config fingerprints ("h:xxxxxxxx"). */
  shortHash: (value: string) => string;
  /**
   * Record signatures of a fork's parent file (see fork.ts), or undefined when the parent cannot be found.
   * Asked only for forks that copy their parent's history (no history_base, no start ordinal).
   */
  forkPrefix?: (forkedFromId: string) => Promise<Sig[] | undefined>;
}

type Rec = Record<string, unknown>;

/** One record after envelope decoding. */
interface Line { env: string; sub: string; p: Rec; ts?: number; rid: string }

interface Settings { model?: string; effort?: string; mode?: string }

/** A legacy-shaped prompt record: a response_item user message or a `user_message` event. */
interface LegacyMsg extends Msg { via: "resp" | "event" }

/** A legacy `*_end` tool event, with its call id for twin matching against canonical items. */
interface EndTool { ev: ToolEvent; callId?: string }

interface RawTurn {
  key: string;
  firstRecordId: string;
  explicit: boolean;
  firstTs?: number;
  minTs?: number;
  maxTs?: number;
  /** Every valid record time of the turn, with its dispatch position (file order): the exchange's SpanClock input. */
  stamps: number[];
  stampOrder: number[];
  records: number;
  hasContext: boolean;
  hasWork: boolean;
  /** Settings in effect when the turn opened (from the last turn_context, linked to this turn or not). */
  inherit?: Settings;
  versions: string[];
  models: string[];
  efforts: string[];
  modes: string[];
  /** item_completed records attached to this turn: > 0 makes it a canonical (paginated) turn. */
  items: number;
  itemIds: Set<string>;
  messages: Msg[];
  legacyMessages: LegacyMsg[];
  itemTools: ToolEvent[];
  endTools: EndTool[];
  respTools: ToolEvent[];
  recordUsage: Usage[];
  countUsage: Usage[];
  /** token_count events that repeated the previous cumulative total. */
  repeatedCounts: number;
  interrupted: boolean;
  abortTs?: number;
  errorEvents: number;
  completeErrors: number;
  retries: number;
  compactItems: number;
  compactedRecords: number;
  thinkBlocks: number;
  thinkRedacted: number;
  thinkSigs: number[];
  rootTurnIds: Set<string>;
  spawned: Set<string>;
}

/** Prefix of turn keys invented for legacy records without turn ids (never a real Codex id). */
const SYNTHETIC = "~legacy-";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined);

/**
 * Shape of an id-like label (PRIVACY.md "What is stored"; same as the config collector's free labels): letters, digits,
 * `. _ : -`, an optional `[1m]`-style suffix and one Vertex-style `@<yyyymmdd>` / `@latest` / `@default`. Never spaces
 * (prose), an `@` address, a path or a token-shaped string: cleanLabel alone let prose through (WP-12 review).
 */
const ID_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(\[[0-9A-Za-z]{1,8}\])?(@(?:\d{8}|latest|default))?$/;
const VERSION_LABEL = /^\d+\.\d+\.\d+([-+.][0-9A-Za-z.]+)?$/;

/** Id-shaped label, "other" when present but out of shape, undefined when absent. */
export function label(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const o = obj(v);
  const s = cleanLabel(o ? Object.keys(o)[0] : v); // e.g. approval_policy: {granular: {...}}
  return s !== undefined && ID_LABEL.test(s) && !looksSecret(s) ? s : "other";
}

/** A label that must also be one of `allowed` (effort, approval policy): anything else is "other". */
function enumLabel(v: unknown, allowed: ReadonlySet<string>): string | undefined {
  const l = label(v);
  return l === undefined || l === "other" || allowed.has(l) ? l : "other";
}

/** CLI version: semver-like, else "other". */
function versionLabel(v: unknown): string | undefined {
  const l = label(v);
  return l === undefined || l === "other" || VERSION_LABEL.test(l) ? l : "other";
}

function usageOf(u: Rec | undefined): Usage | undefined {
  if (!u) return undefined;
  const input = num(u.input_tokens);
  const cached = num(u.cached_input_tokens);
  return { inTok: Math.max(0, input - cached), cacheRead: cached, cacheWrite: num(u.cache_write_input_tokens), outTok: num(u.output_tokens) };
}

function deltaUsage(total: Rec, prev: Rec): Usage {
  // A cumulative counter that went down was restarted (e.g. a fork counting from zero): it is all new.
  if (num(total.input_tokens) < num(prev.input_tokens) || num(total.output_tokens) < num(prev.output_tokens)) return usageOf(total)!;
  const d = (k: string) => Math.max(0, num(total[k]) - num(prev[k]));
  const cached = d("cached_input_tokens");
  return { inTok: Math.max(0, d("input_tokens") - cached), cacheRead: cached, cacheWrite: d("cache_write_input_tokens"), outTok: d("output_tokens") };
}

/** Identity of a cumulative token total (re-emitted counts repeat it exactly). */
function totalSig(total: Rec): string {
  return JSON.stringify(["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"].map((k) => total[k]));
}

const twinKey = (m: Msg): string => `${m.trigger}\u0000${m.text}`;

/** Multiset of twin keys of the non-continuation messages in `list`. */
function keyCounts(list: Msg[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of list) if (x.trigger !== "continuation") m.set(twinKey(x), (m.get(twinKey(x)) ?? 0) + 1);
  return m;
}

/** Take one `key` from a multiset; true if it was there. */
function take(m: Map<string, number>, key: string): boolean {
  const n = m.get(key) ?? 0;
  if (n <= 0) return false;
  m.set(key, n - 1);
  return true;
}

const plain = ({ ts, trigger, text, images }: Msg): Msg => ({ ts, trigger, text, images });

/**
 * Prompts of a legacy turn: response_item user messages and `user_message` events carry the same prompt
 * twice. Each record that repeats an earlier record of the other kind (same trigger and stripped text) is a
 * twin: dropped and counted. Injected context (continuation) is kept as is.
 * Without the response_item branch (`withResp` false: the file has canonical items), only prompts a `user_message`
 * event carries survive — a response_item prompt whose event twin came later still counts, through that twin.
 */
function legacyPrompts(list: LegacyMsg[], withResp: boolean): { messages: Msg[]; twins: number } {
  const open = { resp: new Map<string, number[]>(), event: new Map<string, number[]>() };
  const kept: { m: Msg; event: boolean }[] = [];
  let twins = 0;
  for (const m of list) {
    if (m.trigger !== "continuation") {
      const key = twinKey(m);
      const other = open[m.via === "resp" ? "event" : "resp"].get(key);
      if (other?.length) { kept[other.shift()!]!.event = true; twins++; continue; }
      const mine = open[m.via];
      const at = mine.get(key);
      if (at) at.push(kept.length); else mine.set(key, [kept.length]);
    }
    kept.push({ m: plain(m), event: m.via === "event" });
  }
  return { messages: kept.filter((k) => withResp || k.event).map((k) => k.m), twins };
}

/** Legacy prompt records in a canonical turn that repeat one of its UserMessage items (per record kind). */
function promptTwins(legacy: LegacyMsg[], items: Msg[]): number {
  let twins = 0;
  for (const via of ["resp", "event"] as const) {
    const pool = keyCounts(items);
    for (const m of legacy) if (m.via === via && m.trigger !== "continuation" && take(pool, twinKey(m))) twins++;
  }
  return twins;
}

const hasImages = (p: Rec): boolean =>
  (Array.isArray(p.images) && p.images.length > 0) || (Array.isArray(p.local_images) && p.local_images.length > 0);

function settingsOf(p: Rec): Settings {
  const collab = obj(obj(p.collaboration_mode)?.settings);
  return {
    model: label(p.model) ?? label(collab?.model),
    effort: enumLabel(p.effort, EFFORTS) ?? enumLabel(p.reasoning_effort, EFFORTS) ?? enumLabel(collab?.reasoning_effort, EFFORTS),
    mode: enumLabel(p.approval_policy, APPROVAL_POLICIES),
  };
}

export class RolloutParser {
  private turns: RawTurn[] = [];
  private byId = new Map<string, RawTurn>();
  private cur: RawTurn | undefined;
  private synthetic = 0;

  private ownMeta = false;
  private ownId: string | undefined;
  private parentId: string | undefined;
  private cwd: string | undefined;
  private entrypoint = "unknown";
  private automated = false;
  private scripted = false;
  /** No own session_meta → the classifier fields are missing. */
  private interactiveClass: InteractiveClass = "unknown";
  /** Settings of the last turn_context: in effect for turns that open without one of their own. */
  private inEffect: Settings | undefined;
  private version = "unknown";
  /** Fork with copied parent history: skip records whose ordinal is below this. */
  private skipBelow: number | undefined;
  /** Fork without a start ordinal or history_base, waiting for its parent's prefix (see resolveFork). */
  private pendingFork: string | undefined;
  /** Copied parent history being skipped (fork.ts). */
  private replay: Replay<Line> | undefined;

  private paginated = false;
  private sawEndEvents = false;
  private respUsage = new Map<string, { turn: RawTurn; usage: Usage }>();
  private dupResponses = 0;
  private prevTotal: Rec | undefined;
  private prevTotalSig: string | undefined;
  private execBegin = new Map<string, Rec>();
  private patchBegin = new Map<string, Rec>();
  private respCalls = new Map<string, ToolEvent>();
  private observations: CtxObservation[] = [];
  private pendingSettings: CtxObservation["settings"] = [];
  private metas: MetaObservation[] = [];
  private index = 0;
  /** Position of the next touched record in dispatch (file) order. */
  private touches = 0;

  constructor(private readonly stats: ParseStats, private readonly opts: RolloutOptions) {}

  /** Count an unrecognised record kind; only an identifier-shaped name is kept as the key (util.ts typeKey). */
  private unknown(kind: string): void {
    bump(this.stats.unknownTypes, typeKey(kind, "codex:unrecognised"));
  }

  private open(key: string, firstRecordId: string, explicit: boolean): RawTurn {
    const t: RawTurn = {
      key, firstRecordId, explicit, stamps: [], stampOrder: [], records: 0, hasContext: false, hasWork: false, inherit: this.inEffect,
      versions: [this.version], models: [], efforts: [], modes: [], items: 0, itemIds: new Set(),
      messages: [], legacyMessages: [], itemTools: [], endTools: [], respTools: [], recordUsage: [], countUsage: [], repeatedCounts: 0,
      interrupted: false, errorEvents: 0, completeErrors: 0, retries: 0, compactItems: 0, compactedRecords: 0,
      thinkBlocks: 0, thinkRedacted: 0, thinkSigs: [], rootTurnIds: new Set(), spawned: new Set(),
    };
    this.turns.push(t);
    this.cur = t;
    return t;
  }

  private syntheticKey(): string { return `${SYNTHETIC}${this.synthetic++}`; }

  /**
   * Turn for a record. `start` = task_started/turn_started, `context` = turn_context, `attach` = anything else.
   * Records with an id attach to that turn; id-less (legacy) records attach to the current turn, and
   * legacy markers open a new turn unless the current one has not started any work yet.
   */
  private turnFor(id: string | undefined, kind: "start" | "context" | "attach", rid: string): RawTurn {
    if (id) {
      let t = this.byId.get(id);
      if (!t) { t = this.open(id, id, kind === "start"); this.byId.set(id, t); }
      if (kind === "start") t.explicit = true;
      if (kind !== "attach") this.cur = t;
      return t;
    }
    const c = this.cur;
    if (kind === "start") {
      if (c && !c.explicit && !c.hasWork && !c.legacyMessages.length && !c.messages.length) { c.explicit = true; return c; }
      return this.open(this.syntheticKey(), rid, true);
    }
    if (kind === "context") {
      if (c && !c.hasContext && !c.hasWork) return c;
      return this.open(this.syntheticKey(), rid, false);
    }
    return c ?? this.open(this.syntheticKey(), rid, false);
  }

  private touch(t: RawTurn, ts: number | undefined): void {
    t.records++;
    if (ts === undefined) return;
    t.stamps.push(ts);
    t.stampOrder.push(this.touches++);
    if (t.firstTs === undefined) t.firstTs = ts;
    if (t.minTs === undefined || ts < t.minTs) t.minTs = ts;
    if (t.maxTs === undefined || ts > t.maxTs) t.maxTs = ts;
  }

  /** Fork whose parent prefix is needed before the next record (parseRollout awaits it). */
  get awaitingFork(): string | undefined { return this.pendingFork; }

  /** Start skipping copied history: by the parent's records when known, else by the marker heuristic. */
  resolveFork(prefix: Sig[] | undefined): void {
    if (this.pendingFork === undefined) return;
    this.pendingFork = undefined;
    if (prefix) { this.replay = new PrefixReplay<Line>(prefix); return; }
    this.replay = new MarkerReplay<Line>();
    this.unknown("codex:fork-unresolved");
  }

  feed(d: Rec): void {
    if (this.pendingFork !== undefined) this.resolveFork(undefined); // fed directly, nobody resolved it
    const index = this.index++;
    const env = typeof d.type === "string" ? d.type : "";
    let ts: number | undefined;
    if (d.timestamp !== undefined) {
      const iso = cleanTime(d.timestamp, this.opts.now);
      if (iso) ts = Date.parse(iso); else noteBadTime(this.stats, d.timestamp, this.opts.now);
    }
    const ord = typeof d.ordinal === "number" && Number.isFinite(d.ordinal) ? d.ordinal : undefined;
    const rid = ord !== undefined ? `o:${ord}` : `i:${index}`;
    const p = obj(d.payload) ?? {};
    const sub = typeof p.type === "string" ? p.type : "";

    if (!ENVELOPES.has(env)) { this.unknown(env ? `codex:${env}` : "codex:untyped"); return; }

    if (env === "session_meta") { this.sessionMeta(p, ts); return; }

    if (this.skipBelow !== undefined && ord !== undefined && ord < this.skipBelow) { this.stats.duplicates++; return; }
    const line: Line = { env, sub, p, ts, rid };
    if (this.replay && !this.replay.done) {
      const r = this.replay.offer(recordSig(env, d.payload), isMarker(env, sub), line);
      this.copied(r.copied);
      for (const x of r.process) this.dispatch(x);
      return;
    }
    this.dispatch(line);
  }

  /** Copied parent records: counted as duplicates; cumulative token totals still move the baseline. */
  private copied(lines: Line[]): void {
    for (const { env, sub, p } of lines) {
      this.stats.duplicates++;
      if (env === "event_msg" && sub === "token_count") {
        const total = obj(obj(p.info)?.total_token_usage);
        if (total) { this.prevTotal = total; this.prevTotalSig = totalSig(total); }
      }
    }
  }

  private dispatch({ env, sub, p, ts, rid }: Line): void {
    switch (env) {
      case "turn_context": return this.turnContext(p, ts, rid);
      case "token_usage_record": return this.usageRecord(p, ts, rid);
      case "compacted": { const t = this.turnFor(undefined, "attach", rid); this.touch(t, ts); t.compactedRecords++; return; }
      case "event_msg": return this.event(sub, p, ts, rid);
      case "response_item": return this.responseItem(sub, p, ts, rid);
      default: return; // world_state, inter_agent_communication_metadata: context only
    }
  }

  private sessionMeta(p: Rec, ts: number | undefined): void {
    const id = str(p.id) ?? str(p.session_id);
    if (this.ownMeta && id && this.ownId && id !== this.ownId) { this.stats.duplicates++; return; } // copied parent meta
    if (!this.ownMeta) {
      this.ownMeta = true;
      this.ownId = id;
      this.parentId = str(p.parent_thread_id);
      this.cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : undefined;
      // Another agent drives the thread (automated: its "prompts" are instructions, not a person typing);
      // `codex exec` (scripted: a real prompt, but the script's settings). The originator is only read in
      // memory, as a classifier input; it never becomes a label.
      const f = sessionFlags(p);
      this.entrypoint = f.entrypoint;
      this.automated = f.automated;
      this.scripted = f.scripted;
      this.interactiveClass = f.interactiveClass;
      const forked = str(p.forked_from_id);
      const start = typeof p.subagent_history_start_ordinal === "number" ? p.subagent_history_start_ordinal : undefined;
      if (forked && forked !== id && !obj(p.history_base)) {
        if (start !== undefined) this.skipBelow = start;
        else this.pendingFork = forked;
      }
    }
    this.version = versionLabel(p.cli_version) ?? this.version;
    const bi = p.base_instructions ?? p.instructions;
    const text = typeof bi === "string" ? bi : typeof obj(bi)?.text === "string" ? (obj(bi)!.text as string) : undefined;
    const provider = providerOf(p);
    this.metas.push({
      ts,
      version: this.version,
      instructions: text ? this.opts.shortHash(text) : undefined,
      tools: Array.isArray(p.dynamic_tools) ? this.opts.shortHash(JSON.stringify(p.dynamic_tools)) : undefined,
      provider: provider !== undefined ? this.opts.shortHash(provider) : undefined,
    });
  }

  private turnContext(p: Rec, ts: number | undefined, rid: string): void {
    const t = this.turnFor(str(p.turn_id), "context", rid);
    this.touch(t, ts);
    t.hasContext = true;
    const s = settingsOf(p);
    if (s.model) t.models.push(s.model);
    if (s.effort) t.efforts.push(s.effort);
    if (s.mode) t.modes.push(s.mode);
    // A turn_context stays in effect for later turns until the next one, whether or not a turn id links it
    // to the turn that follows (legacy files write it before an id-carrying task_started).
    const prev = this.inEffect;
    if (s.model || s.effort || s.mode) this.inEffect = { model: s.model ?? prev?.model, effort: s.effort ?? prev?.effort, mode: s.mode ?? prev?.mode };
    const root = str(p.root_turn_id);
    if (root) t.rootTurnIds.add(root);
    this.observations.push({ turnKey: t.key, ts, version: this.version, ...s, settings: this.pendingSettings });
    this.pendingSettings = [];
  }

  private usageRecord(p: Rec, ts: number | undefined, rid: string): void {
    const t = this.turnFor(str(p.turn_id), "attach", rid);
    this.touch(t, ts);
    const root = str(p.root_turn_id);
    if (root) t.rootTurnIds.add(root);
    const u = usageOf(obj(p.usage));
    if (!u) return;
    t.hasWork = true;
    const response = str(p.response_id);
    if (!response) { t.recordUsage.push(u); return; }
    const prev = this.respUsage.get(response);
    if (prev) this.dupResponses++; // streaming snapshot of the same response: keep the last one
    this.respUsage.set(response, { turn: prev?.turn ?? t, usage: u });
  }

  private tokenCount(p: Rec, ts: number | undefined, rid: string): void {
    const info = obj(p.info);
    if (!info) return; // rate-limit-only update
    const total = obj(info.total_token_usage);
    const last = obj(info.last_token_usage);
    const sig = total ? totalSig(total) : undefined;
    if (sig !== undefined && sig === this.prevTotalSig) { // re-emitted cumulative count
      if (this.cur) this.cur.repeatedCounts++; else this.stats.duplicates++;
      return;
    }
    const u = last ? usageOf(last) : total ? (this.prevTotal ? deltaUsage(total, this.prevTotal) : usageOf(total)) : undefined;
    if (total) { this.prevTotal = total; this.prevTotalSig = sig; }
    if (!u) return;
    const t = this.turnFor(undefined, "attach", rid);
    this.touch(t, ts);
    t.hasWork = true;
    t.countUsage.push(u);
  }

  private event(sub: string, p: Rec, ts: number | undefined, rid: string): void {
    if (!EVENT_TYPES.has(sub)) { this.unknown(`codex:event_msg:${sub || "untyped"}`); return; }
    const id = str(p.turn_id);
    switch (sub) {
      case "task_started": case "turn_started": { this.touch(this.turnFor(id, "start", rid), ts); return; }
      case "task_complete": case "turn_complete": {
        const t = this.turnFor(id, "attach", rid);
        this.touch(t, ts);
        if (obj(p.error) || (typeof p.error === "string" && p.error)) t.completeErrors++;
        return;
      }
      case "turn_aborted": {
        const t = this.turnFor(id, "attach", rid);
        this.touch(t, ts);
        if (p.reason === undefined || p.reason === null || p.reason === "interrupted") { t.interrupted = true; t.abortTs = ts; }
        return;
      }
      case "item_completed": return this.item(p, ts, rid);
      case "token_count": return this.tokenCount(p, ts, rid);
      case "thread_settings_applied": { this.pendingSettings.push(settingsOf(obj(p.thread_settings) ?? {})); return; }
      case "error": { const t = this.turnFor(id, "attach", rid); this.touch(t, ts); t.errorEvents++; return; }
      case "stream_error": { const t = this.turnFor(id, "attach", rid); this.touch(t, ts); t.retries++; return; }
      case "exec_command_begin": { const c = str(p.call_id); if (c) this.execBegin.set(c, p); return; }
      case "patch_apply_begin": { const c = str(p.call_id); if (c) this.patchBegin.set(c, p); return; }
      case "exec_command_end": case "patch_apply_end": case "mcp_tool_call_end": case "web_search_end": case "view_image_tool_call": {
        if (sub.endsWith("_end")) this.sawEndEvents = true;
        const c = str(p.call_id);
        const begins = sub === "exec_command_end" ? this.execBegin : sub === "patch_apply_end" ? this.patchBegin : undefined;
        const begin = c && begins ? begins.get(c) : undefined;
        const t = this.turnFor(id, "attach", rid);
        this.touch(t, ts);
        t.hasWork = true;
        t.endTools.push({ ev: fromEndEvent(sub, p, begin), callId: c });
        return;
      }
      case "agent_message": { const t = this.turnFor(id, "attach", rid); this.touch(t, ts); t.hasWork = true; return; }
      case "user_message": {
        const m: Msg = { ts, ...classifyParts(typeof p.message === "string" ? p.message : "", hasImages(p)) };
        this.touch(this.legacyPromptTurn(id, m, "event", rid), ts);
        return;
      }
      default: return;
    }
  }

  private item(p: Rec, ts: number | undefined, rid: string): void {
    this.paginated = true;
    const item = obj(p.item);
    if (!item) return;
    const type = typeof item.type === "string" ? item.type : "";
    if (!ITEM_TYPES.has(type)) this.unknown(`codex:item:${type || "untyped"}`);
    const t = this.turnFor(str(p.turn_id), "attach", rid);
    this.touch(t, ts);
    t.items++;
    const itemId = str(item.id);
    if (itemId) t.itemIds.add(itemId);
    if (type === "CollabAgentToolCall" && Array.isArray(item.receiver_thread_ids)) {
      for (const r of item.receiver_thread_ids) { const x = str(r); if (x) t.spawned.add(x); }
    }
    if (type === "SubAgentActivity") { const x = str(item.agent_thread_id); if (x) t.spawned.add(x); }
    if (type === "UserMessage") t.messages.push({ ts, ...classify(item.content) });
    else if (TOOL_ITEMS.has(type)) { t.itemTools.push(fromItem(item)); t.hasWork = true; }
    else if (type === "ContextCompaction") t.compactItems++;
    else if (type === "AgentMessage" || type === "Reasoning") t.hasWork = true;
  }

  private responseItem(sub: string, p: Rec, ts: number | undefined, rid: string): void {
    if (!RESPONSE_TYPES.has(sub)) { this.unknown(`codex:response_item:${sub || "untyped"}`); return; }
    if (sub === "message") {
      if (p.role === "user") {
        this.touch(this.legacyPromptTurn(undefined, { ts, ...classify(p.content) }, "resp", rid), ts);
      } else if (p.role === "assistant") {
        const t = this.turnFor(undefined, "attach", rid);
        this.touch(t, ts);
        t.hasWork = true;
      }
      return;
    }
    if (sub === "reasoning") {
      const t = this.turnFor(undefined, "attach", rid);
      this.touch(t, ts);
      t.hasWork = true;
      t.thinkBlocks++;
      if (typeof p.encrypted_content === "string" && p.encrypted_content) t.thinkSigs.push(p.encrypted_content.length);
      const visible = (v: unknown) => Array.isArray(v) && v.some((x) => typeof obj(x)?.text === "string" && (obj(x)!.text as string).trim());
      if (!visible(p.summary) && !visible(p.content)) t.thinkRedacted++;
      return;
    }
    if (RESPONSE_CALLS.has(sub)) {
      const t = this.turnFor(undefined, "attach", rid);
      this.touch(t, ts);
      t.hasWork = true;
      const ev = fromResponseCall(p);
      t.respTools.push(ev);
      const c = str(p.call_id) ?? str(p.id);
      if (c) this.respCalls.set(c, ev);
      return;
    }
    if (RESPONSE_OUTPUTS.has(sub)) {
      const c = str(p.call_id);
      const ev = c ? this.respCalls.get(c) : undefined;
      if (ev && outputFailed(p)) ev.failed = true;
    }
  }

  /**
   * Turn for a legacy prompt record (response_item user message or `user_message` event), which is added to
   * it. Legacy files without turn markers: each typed prompt starts its own (implicit) turn. Only records of
   * the same kind are compared, so a prompt's twin of the other kind never opens a turn of its own.
   */
  private legacyPromptTurn(id: string | undefined, m: Msg, via: LegacyMsg["via"], rid: string): RawTurn {
    let t = this.turnFor(id, "attach", rid);
    if (!id && m.trigger === "human" && !t.explicit && t.key.startsWith(SYNTHETIC)
      && t.legacyMessages.some((x) => x.via === via && x.trigger === "human")) {
      t = this.open(this.syntheticKey(), rid, false);
    }
    t.legacyMessages.push({ ...m, via });
    return t;
  }

  /** Resolve each turn to exactly one source per signal and drop replayed history. */
  finish(): ThreadParse {
    if (this.replay) for (const x of this.replay.flush()) this.dispatch(x);
    for (const { turn, usage } of this.respUsage.values()) turn.recordUsage.push(usage);
    // Streaming snapshots of one response: per-response records always win where present.
    this.stats.duplicates += this.dupResponses;
    // The response_item branch runs only in files without canonical items (see the header).
    const withResp = !this.paginated;
    // Within legacy turns, `*_end` events are the tool source whenever the file has any (response_item calls
    // also cover non-tool functions such as plan updates); only legacy files without them fall back to the calls.
    const legacyTools = this.sawEndEvents ? "end" : withResp ? "resp" : "none";

    const turns: Turn[] = [];
    const kept = new Set<string>();
    for (const r of this.turns) {
      const canonical = r.items > 0;
      const tools = canonical ? r.itemTools
        : legacyTools === "end" ? r.endTools.map((e) => e.ev) : legacyTools === "resp" ? r.respTools : [];
      const legacy = canonical ? undefined : legacyPrompts(r.legacyMessages, withResp);
      const messages = legacy ? legacy.messages : r.messages;
      // Imported / replayed history: a counter turn id (Codex Desktop "external-import-turn-N", whatever the turn
      // holds), or the import shape — a user message with no turn_context, no model call and no tool work.
      // Not an exchange — the original lives elsewhere. Only per-response usage records prove a model call:
      // cumulative token_count events are also written at import time (17 imported turns on real logs carried
      // one), so they don't count here.
      if (IMPORTED_TURN_ID.test(r.key)
        || (canonical && !r.hasContext && !r.recordUsage.length && !tools.length && messages.length)) {
        this.stats.duplicates += r.records + r.repeatedCounts;
        continue;
      }
      const usesRecords = r.recordUsage.length > 0;
      const usage = usesRecords ? r.recordUsage : r.countUsage;
      // Twins of the chosen source: every usage-bearing token_count of a turn with per-response records,
      // re-emitted cumulative counts, legacy prompt twins, and `*_end` events whose call is a canonical item.
      this.stats.duplicates += (usesRecords ? r.countUsage.length : 0) + r.repeatedCounts;
      if (legacy) this.stats.duplicates += legacy.twins;
      else {
        this.stats.duplicates += promptTwins(r.legacyMessages, r.messages);
        this.stats.duplicates += r.endTools.filter((e) => e.callId !== undefined && r.itemIds.has(e.callId)).length;
      }
      kept.add(r.key);
      const inherit = (own: string[], v: string | undefined): string[] => (own.length || !v ? own : [v]);
      turns.push({
        key: r.key, firstRecordId: r.firstRecordId, firstTs: r.firstTs, minTs: r.minTs, maxTs: r.maxTs,
        stamps: r.stamps, stampOrder: r.stampOrder,
        versions: r.versions,
        models: inherit(r.models, r.inherit?.model), efforts: inherit(r.efforts, r.inherit?.effort), modes: inherit(r.modes, r.inherit?.mode),
        messages, tools, usage,
        compactions: canonical ? r.compactItems : r.compactedRecords,
        interrupted: r.interrupted, abortTs: r.abortTs,
        apiErrors: Math.max(r.errorEvents, r.completeErrors), apiRetries: r.retries,
        thinkBlocks: r.thinkBlocks, thinkRedacted: r.thinkRedacted, thinkSigs: r.thinkSigs, rootTurnIds: r.rootTurnIds,
        spawned: r.spawned,
      });
    }
    return {
      threadId: this.ownId, parentThreadId: this.parentId, cwd: this.cwd, entrypoint: this.entrypoint,
      automated: this.automated, scripted: this.scripted, interactiveClass: this.interactiveClass, paginated: this.paginated, turns,
      observations: this.observations.filter((o) => kept.has(o.turnKey)), metas: this.metas,
    };
  }
}

/** Parse one rollout file. Throws only if the file cannot be read at all. */
export async function parseRollout(path: string, stats: ParseStats, opts: RolloutOptions): Promise<ThreadParse> {
  const parser = new RolloutParser(stats, opts);
  for await (const d of readJsonl(path, stats)) {
    parser.feed(d);
    const fork = parser.awaitingFork;
    if (fork !== undefined) parser.resolveFork(opts.forkPrefix ? await opts.forkPrefix(fork) : undefined);
  }
  return parser.finish();
}
