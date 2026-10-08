/**
 * An independent, deliberately simple reference counter for generated corpora.
 *
 * It re-derives per-exchange counts from the FILES ALONE (never from the generator's plan) with
 * straightforward rules, so comparing its output with synth-truth-exchanges.jsonl proves the planted
 * facts are recoverable from the bytes. It is not the product's reader: no caching, no tolerance for
 * hostile input beyond readJsonl's, no label hygiene. Hostile corpora are for the real readers.
 *
 * Rules (documented because every one of them is a decision a real reader must also make):
 *  Claude  - dedupe user/assistant/system/attachment records by uuid across files (earliest file wins);
 *            an exchange starts at a human prompt (origin.kind "human", or for records without origin:
 *            plain text not starting with "<" or "[", no isMeta/isCompactSummary/toolUseResult) and runs
 *            until the next one in the same file; steps = distinct requestId (max output_tokens wins);
 *            tools counted by tool_use id; errors = is_error tool_results without toolDenialKind;
 *            subagent files are attributed to the exchange running at their first timestamp.
 *  Codex   - paginated files count item_completed items, legacy files (no item_completed) count
 *            response_item calls classified by their paired events; steps = distinct response_id (last
 *            snapshot wins); injected "<...>" / "# AGENTS.md" user messages are not prompts; turns with no
 *            turn_context and no work are not exchanges; turns copied from a fork parent are skipped;
 *            archived rollouts whose basename exists live are ignored; subagent threads feed sub* counts.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { isPushback } from "../pushback.js";
import { isNearDuplicate } from "../similarity.js";
import { obj, readJsonl } from "../util.js";

export interface RefExchange {
  agent: "claude-code" | "codex";
  session: string;
  seq: number;
  t: string;
  day: string;
  version: string;
  model: string;
  effort: string;
  mode: string;
  entrypoint: string;
  afterCompaction: boolean;
  humanPrompt: 0 | 1;
  promptChars: number | null;
  interrupted: 0 | 1;
  pushback: 0 | 1;
  queuedMidTurn: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  rejections: number;
  blocked: number;
  reads: number;
  edits: number;
  blindEdits: number;
  churned: 0 | 1;
  outTok: number;
  inTok: number;
  cacheRead: number;
  cacheWrite: number;
  apiErrors: number;
  apiRetries: number;
  compactions: number;
  thinkBlocks: number | null;
  thinkRedacted: number | null;
  thinkSigMedian: number | null;
  /** Sum of thinking signature lengths (Claude), for pooled means. */
  thinkSigSum: number | null;
  subToolCalls: number;
  subOutTok: number;
  subInTok: number;
  subCacheRead: number;
  subCacheWrite: number;
  /** Prompt (or first record) to last activity record, clamped at 0. */
  durationMs: number;
}

type Rec = Record<string, unknown>;

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const COMMAND_PREFIXES = ["<local-command-caveat>", "<command-name>", "<local-command-stdout>"];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function load(path: string): Promise<Rec[]> {
  const out: Rec[] = [];
  for await (const r of readJsonl(path, { badLines: 0, truncatedTail: 0 })) out.push(r);
  return out;
}

function ms(v: unknown): number {
  return typeof v === "string" ? Date.parse(v) : NaN;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

class Tally {
  private m = new Map<string, number>();
  add(v: unknown): void { if (typeof v === "string" && v) this.m.set(v, (this.m.get(v) ?? 0) + 1); }
  top(): string | undefined {
    let best: string | undefined;
    let n = -1;
    for (const [k, c] of this.m) if (c > n) { best = k; n = c; }
    return best;
  }
}

function blank(agent: RefExchange["agent"], session: string, seq: number, t: number): RefExchange {
  return {
    agent, session, seq, t: new Date(t).toISOString(), day: new Date(t).toISOString().slice(0, 10), version: "unknown", model: "unknown",
    effort: "unknown", mode: "unknown", entrypoint: "unknown", afterCompaction: false, humanPrompt: 0, promptChars: null, interrupted: 0,
    pushback: 0, queuedMidTurn: 0, steps: 0, toolCalls: 0, toolErrors: 0, rejections: 0, blocked: 0, reads: 0, edits: 0, blindEdits: 0,
    churned: 0, outTok: 0, inTok: 0, cacheRead: 0, cacheWrite: 0, apiErrors: 0, apiRetries: 0, compactions: 0, thinkBlocks: null,
    thinkRedacted: null, thinkSigMedian: null, thinkSigSum: null, subToolCalls: 0, subOutTok: 0, subInTok: 0, subCacheRead: 0, subCacheWrite: 0, durationMs: 0,
  };
}

export async function countCorpus(root: string): Promise<RefExchange[]> {
  return [...(await countClaude(root)), ...(await countCodex(root))];
}

// ===================================================================================== Claude

interface CAcc {
  row: RefExchange;
  first: number;
  last: number;
  tally: { version: Tally; model: Tally; effort: Tally; mode: Tally; entrypoint: Tally };
  reqs: Map<string, { out: number; inT: number; cr: number; cw: number }>;
  toolIds: Set<string>;
  resultIds: Set<string>;
  editsByFile: Map<string, number>;
  readFiles: Set<string>;
  sigs: number[];
  thinkRedacted: number;
  prompt?: string;
}

function textOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    const o = obj(b);
    if (o?.type === "text" && typeof o.text === "string") out.push(o.text);
  }
  return out;
}

async function countClaude(root: string): Promise<RefExchange[]> {
  const projects = join(root, "claude", "projects");
  const mains: string[] = [];
  const subs: string[] = [];
  for (const p of walk(projects)) {
    if (!p.endsWith(".jsonl")) continue;
    const rel = p.slice(projects.length + 1).split("/");
    if (rel.length === 2) mains.push(p);
    else if (basename(p).startsWith("agent-") && rel.includes("subagents")) subs.push(p);
  }
  const loaded = new Map<string, Rec[]>();
  for (const f of mains) loaded.set(f, await load(f));
  const firstTs = (f: string): number => {
    for (const r of loaded.get(f)!) { const t = ms(r.timestamp); if (Number.isFinite(t)) return t; }
    return Infinity;
  };
  // Earliest first record wins; on a tie the file whose first record carries its own sessionId (the original,
  // not a resumed copy replaying someone else's history) goes first.
  const foreignFirst = (f: string): number => {
    const first = loaded.get(f)!.find((r) => typeof r.uuid === "string");
    return first && first.sessionId !== basename(f, ".jsonl") ? 1 : 0;
  };
  const order = [...mains].sort((a, b) => firstTs(a) - firstTs(b) || foreignFirst(a) - foreignFirst(b) || (a < b ? -1 : 1));
  const seen = new Set<string>();
  const out: RefExchange[] = [];
  const bySession = new Map<string, CAcc[]>();

  for (const file of order) {
    const sessionKey = "claude/projects/" + file.slice(projects.length + 1);
    const sid = basename(file, ".jsonl");
    const accs: CAcc[] = [];
    bySession.set(sid, accs);
    let cur: CAcc | undefined;
    let prevPrompt: string | undefined;
    let compacted = false;
    const window: (string | undefined)[] = [];

    const open = (t: number, human: boolean): CAcc => {
      if (cur) closeAcc(cur);
      const row = blank("claude-code", sessionKey, accs.length, t);
      row.humanPrompt = human ? 1 : 0;
      row.afterCompaction = compacted;
      const a: CAcc = {
        row, first: t, last: t, reqs: new Map(), toolIds: new Set(), resultIds: new Set(), editsByFile: new Map(), readFiles: new Set(),
        sigs: [], thinkRedacted: 0,
        tally: { version: new Tally(), model: new Tally(), effort: new Tally(), mode: new Tally(), entrypoint: new Tally() },
      };
      accs.push(a);
      cur = a;
      return a;
    };
    const closeAcc = (a: CAcc): void => {
      const r = a.row;
      for (const q of a.reqs.values()) { r.steps++; r.outTok += q.out; r.inTok += q.inT; r.cacheRead += q.cr; r.cacheWrite += q.cw; }
      r.churned = [...a.editsByFile.values()].some((n) => n >= 3) ? 1 : 0;
      r.version = a.tally.version.top() ?? "unknown";
      r.model = a.tally.model.top() ?? "unknown";
      r.effort = a.tally.effort.top() ?? "unknown";
      r.mode = a.tally.mode.top() ?? "unknown";
      r.entrypoint = a.tally.entrypoint.top() ?? "unknown";
      r.thinkBlocks = a.sigs.length;
      r.thinkRedacted = a.thinkRedacted;
      r.thinkSigMedian = median(a.sigs);
      r.thinkSigSum = a.sigs.reduce((x, y) => x + y, 0);
      r.durationMs = Math.max(0, a.last - a.first);
      if (r.compactions > 0) compacted = true;
    };

    for (const rec of loaded.get(file)!) {
      const type = typeof rec.type === "string" ? rec.type : "";
      if (["user", "assistant", "system", "attachment"].includes(type)) {
        const u = typeof rec.uuid === "string" ? rec.uuid : undefined;
        if (u) { if (seen.has(u)) continue; seen.add(u); }
      } else continue;
      const ts = ms(rec.timestamp);
      const msg = obj(rec.message);

      if (type === "user") {
        const content = msg?.content;
        const texts = textOf(content);
        const joined = texts.join("\n");
        const blocks = Array.isArray(content) ? content.map((b) => obj(b)) : [];
        const isCommand = COMMAND_PREFIXES.some((p) => joined.trimStart().startsWith(p));
        if (isCommand) continue;
        if (texts.some((x) => x.trimStart().startsWith("[Request interrupted by user"))) {
          if (cur) { cur.row.interrupted = 1; cur.last = ts; }
          continue;
        }
        const origin = obj(rec.origin);
        const hasToolResult = blocks.some((b) => b?.type === "tool_result");
        let human: boolean;
        if (origin) human = origin.kind === "human";
        else human = rec.isMeta !== true && rec.isCompactSummary !== true && rec.isSidechain !== true && rec.toolUseResult === undefined && !hasToolResult && joined.trim().length > 0 && !joined.trimStart().startsWith("<") && !joined.trimStart().startsWith("[");
        if (human) {
          const a = open(ts, true);
          a.row.promptChars = joined.length;
          a.prompt = joined;
          a.row.pushback = isPushback(joined) || isNearDuplicate(prevPrompt, joined) ? 1 : 0;
          prevPrompt = joined;
          a.tally.version.add(rec.version);
          a.tally.mode.add(rec.permissionMode);
          a.tally.entrypoint.add(rec.entrypoint);
          continue;
        }
        const isNotification = origin?.kind === "task-notification" || joined.trimStart().startsWith("<task-notification>");
        if (!cur && isNotification) open(ts, false);
        if (!cur) continue;
        cur.last = ts;
        cur.tally.version.add(rec.version);
        cur.tally.mode.add(rec.permissionMode);
        cur.tally.entrypoint.add(rec.entrypoint);
        for (const b of blocks) {
          if (b?.type !== "tool_result") continue;
          const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
          if (id) { if (cur.resultIds.has(id)) continue; cur.resultIds.add(id); }
          const denial = typeof rec.toolDenialKind === "string" ? rec.toolDenialKind : undefined;
          if (denial === "user-rejected") cur.row.rejections++;
          else if (denial) cur.row.blocked++;
          else if (b.is_error === true) cur.row.toolErrors++;
        }
      } else if (type === "assistant") {
        if (!cur) open(ts, false);
        const a = cur!;
        a.last = ts;
        if (rec.isApiErrorMessage === true) { a.row.apiErrors++; continue; }
        a.tally.version.add(rec.version);
        a.tally.entrypoint.add(rec.entrypoint);
        const model = msg?.model;
        if (model !== "<synthetic>") a.tally.model.add(model);
        a.tally.effort.add(rec.effort);
        const req = typeof rec.requestId === "string" ? rec.requestId : String(rec.uuid);
        const usage = obj(msg?.usage);
        if (usage) {
          const out = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
          const prev = a.reqs.get(req);
          if (!prev || out > prev.out) {
            a.reqs.set(req, {
              out, inT: Number(usage.input_tokens ?? 0), cr: Number(usage.cache_read_input_tokens ?? 0), cw: Number(usage.cache_creation_input_tokens ?? 0),
            });
          }
        }
        for (const b of Array.isArray(msg?.content) ? msg.content : []) {
          const o = obj(b);
          if (o?.type === "thinking") {
            a.sigs.push(typeof o.signature === "string" ? o.signature.length : 0);
            if (typeof o.thinking !== "string" || o.thinking.trim() === "") a.thinkRedacted++;
          } else if (o?.type === "tool_use") {
            const id = typeof o.id === "string" ? o.id : "";
            if (id) { if (a.toolIds.has(id)) continue; a.toolIds.add(id); }
            a.row.toolCalls++;
            const name = typeof o.name === "string" ? o.name : "";
            const input = obj(o.input);
            const file = typeof input?.file_path === "string" ? input.file_path : typeof input?.notebook_path === "string" ? input.notebook_path : undefined;
            if (READ_TOOLS.has(name)) {
              a.row.reads++;
              if (name === "Read" && file) a.readFiles.add(file);
            } else if (EDIT_TOOLS.has(name)) {
              a.row.edits++;
              if (file) {
                a.editsByFile.set(file, (a.editsByFile.get(file) ?? 0) + 1);
                if (!a.readFiles.has(file) && !window.includes(file)) a.row.blindEdits++;
              }
            }
            window.push(name === "Read" ? file : undefined);
            if (window.length > 10) window.shift();
          }
        }
      } else if (type === "system") {
        if (!cur) continue;
        cur.last = ts;
        if (rec.subtype === "api_error") cur.row.apiRetries++;
        else if (rec.subtype === "compact_boundary") cur.row.compactions++;
      } else if (type === "attachment") {
        if (!cur) continue;
        cur.last = ts;
        const at = obj(rec.attachment);
        if (at?.type === "queued_command" && rec.isMeta !== true && rec.isSidechain !== true) {
          const kind = obj(at.origin)?.kind;
          if (kind === undefined || kind === "human") cur.row.queuedMidTurn++;
        }
      }
    }
    if (cur) closeAcc(cur);
  }

  // Subagent files: attribute to the exchange running at the file's first timestamp.
  for (const f of subs) {
    const parts = f.slice(projects.length + 1).split("/");
    const sid = parts[1]!;
    const accs = bySession.get(sid);
    if (!accs?.length) continue;
    const recs = await load(f);
    const t0 = ms(recs.find((r) => Number.isFinite(ms(r.timestamp)))?.timestamp);
    let target = accs[0]!;
    for (const a of accs) if (a.first <= t0) target = a;
    const ids = new Set<string>();
    const reqs = new Map<string, { out: number; inT: number; cr: number; cw: number }>();
    for (const r of recs) {
      if (r.type !== "assistant") continue;
      const m = obj(r.message);
      const req = typeof r.requestId === "string" ? r.requestId : String(r.uuid);
      const u = obj(m?.usage);
      if (u) {
        const o = Number(u.output_tokens ?? 0);
        const p = reqs.get(req);
        if (!p || o > p.out) reqs.set(req, { out: o, inT: Number(u.input_tokens ?? 0), cr: Number(u.cache_read_input_tokens ?? 0), cw: Number(u.cache_creation_input_tokens ?? 0) });
      }
      for (const b of Array.isArray(m?.content) ? m.content : []) {
        const o = obj(b);
        if (o?.type === "tool_use" && typeof o.id === "string") ids.add(o.id);
      }
    }
    target.row.subToolCalls += ids.size;
    for (const q of reqs.values()) { target.row.subOutTok += q.out; target.row.subInTok += q.inT; target.row.subCacheRead += q.cr; target.row.subCacheWrite += q.cw; }
  }

  for (const accs of bySession.values()) for (const a of accs) out.push(a.row);
  return out;
}

// ===================================================================================== Codex

interface XTurn {
  id: string;
  row: RefExchange;
  first: number;
  last: number;
  hasContext: boolean;
  tools: number;
  resp: Map<string, { out: number; inT: number; cr: number; cw: number }>;
  typed: string[];
  tally: { model: Tally; effort: Tally; mode: Tally };
  editsByFile: Map<string, number>;
  readFiles: Set<string>;
  calls: Map<string, { kind: "exec" | "patch" | "mcp" | "spawn"; file?: string; failed?: boolean; parsed?: Rec[] }>;
  compactions: number;
}

const INJECTED = /^(<|# AGENTS\.md)/;

function userText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((c) => obj(c)).filter((c) => c && (c.type === "text" || c.type === "input_text") && typeof c.text === "string").map((c) => c!.text as string).join("\n");
}

async function countCodex(root: string): Promise<RefExchange[]> {
  const codex = join(root, "codex");
  const isRollout = (p: string): boolean => basename(p).startsWith("rollout-") && p.endsWith(".jsonl");
  const live = walk(join(codex, "sessions")).filter(isRollout);
  const liveNames = new Set(live.map((p) => basename(p)));
  const archived = walk(join(codex, "archived_sessions")).filter(isRollout).filter((p) => !liveNames.has(basename(p)));
  const files = [...live, ...archived];

  const loaded = new Map<string, Rec[]>();
  const metaOf = new Map<string, Rec>();
  const turnIds = new Map<string, Set<string>>();
  for (const f of files) {
    const recs = await load(f);
    loaded.set(f, recs);
    const meta = obj(recs.find((r) => r.type === "session_meta")?.payload) ?? {};
    metaOf.set(f, meta);
    const sid = String(meta.session_id ?? meta.id ?? "");
    const ids = new Set<string>();
    for (const r of recs) { const p = obj(r.payload); if (p?.type === "task_started" && typeof p.turn_id === "string") ids.add(p.turn_id); }
    turnIds.set(sid, ids);
  }
  const sessionIdOf = (f: string): string => String(metaOf.get(f)!.session_id ?? metaOf.get(f)!.id ?? "");
  const isSub = (f: string): boolean => { const m = metaOf.get(f)!; return Boolean(m.parent_thread_id || m.agent_role); };

  const exchangesBySession = new Map<string, XTurn[]>();
  const rows: RefExchange[] = [];
  const mainFiles = files.filter((f) => !isSub(f)).sort((a, b) => (ms(metaOf.get(a)!.timestamp) - ms(metaOf.get(b)!.timestamp)) || (a < b ? -1 : 1));

  for (const f of mainFiles) {
    const recs = loaded.get(f)!;
    const meta = metaOf.get(f)!;
    const sid = sessionIdOf(f);
    const paginated = recs.some((r) => obj(r.payload)?.type === "item_completed");
    const exec = meta.source === "exec";
    const parentTurns = meta.forked_from_id ? turnIds.get(String(meta.forked_from_id)) : undefined;
    const sessionKey = "codex/" + f.slice(codex.length + 1);
    const turns: XTurn[] = [];
    let cur: XTurn | undefined;
    const byId = new Map<string, XTurn>();

    for (const r of recs) {
      const env = String(r.type);
      const p = obj(r.payload) ?? {};
      const sub = typeof p.type === "string" ? p.type : "";
      const ts = ms(r.timestamp);
      if (env === "event_msg" && sub === "task_started") {
        const id = String(p.turn_id);
        const row = blank("codex", sessionKey, 0, ts);
        cur = {
          id, row, first: ts, last: ts, hasContext: false, tools: 0, resp: new Map(), typed: [], editsByFile: new Map(), readFiles: new Set(),
          calls: new Map(), compactions: 0, tally: { model: new Tally(), effort: new Tally(), mode: new Tally() },
        };
        turns.push(cur);
        byId.set(id, cur);
        continue;
      }
      if (!cur) continue;
      if (env === "event_msg" && sub === "thread_settings_applied") continue;
      cur.last = ts;
      if (env === "turn_context") {
        cur.hasContext = true;
        cur.tally.model.add(p.model); cur.tally.effort.add(p.effort); cur.tally.mode.add(p.approval_policy);
      } else if (env === "token_usage_record") {
        const rid = String(p.response_id);
        const u = obj(p.usage) ?? {};
        const cached = Number(u.cached_input_tokens ?? 0);
        cur.resp.set(rid, { out: Number(u.output_tokens ?? 0), inT: Number(u.input_tokens ?? 0) - cached, cr: cached, cw: Number(u.cache_write_input_tokens ?? 0) });
      } else if (env === "compacted") {
        if (!paginated) cur.compactions++;
      } else if (env === "event_msg") {
        if (sub === "turn_aborted") {
          if (p.reason === undefined || p.reason === "interrupted") cur.row.interrupted = 1;
        } else if (paginated && sub === "item_completed") {
          const it = obj(p.item) ?? {};
          const kind = String(it.type);
          if (kind === "UserMessage") {
            const text = userText(it.content);
            if (!INJECTED.test(text.trimStart())) cur.typed.push(text);
          } else if (kind === "ContextCompaction") cur.compactions++;
          else if (kind === "CommandExecution") {
            cur.tools++;
            if (it.status === "failed") cur.row.toolErrors++;
            codexExec(cur, Array.isArray(it.parsed_cmd) ? it.parsed_cmd.map((x) => obj(x) ?? {}) : []);
          } else if (kind === "FileChange") {
            cur.tools++;
            if (it.status === "failed") cur.row.toolErrors++;
            const ch = Array.isArray(it.changes) ? obj(it.changes[0]) : undefined;
            codexEdit(cur, typeof ch?.path === "string" ? ch.path : undefined);
          } else if (kind === "McpToolCall" || kind === "CollabAgentToolCall") {
            cur.tools++;
            if (it.status === "failed") cur.row.toolErrors++;
          }
        } else if (!paginated && sub === "user_message") {
          cur.typed.push(String(p.message ?? ""));
        } else if (!paginated && sub === "exec_command_end") {
          const c = cur.calls.get(String(p.call_id));
          if (c) { c.parsed = Array.isArray(p.parsed_cmd) ? p.parsed_cmd.map((x) => obj(x) ?? {}) : []; c.failed = p.exit_code !== 0; }
        } else if (!paginated && sub === "patch_apply_end") {
          const c = cur.calls.get(String(p.call_id));
          if (c) c.failed = p.success === false;
        } else if (!paginated && sub === "mcp_tool_call_end") {
          const c = cur.calls.get(String(p.call_id));
          if (c) c.failed = obj(p.result)?.Err !== undefined;
        }
      } else if (env === "response_item" && !paginated) {
        if (sub === "function_call" || sub === "custom_tool_call") {
          const name = String(p.name);
          const id = String(p.call_id);
          let kind: "exec" | "patch" | "mcp" | "spawn" = "exec";
          let file: string | undefined;
          if (sub === "custom_tool_call") {
            kind = "patch";
            const m = /\*\*\* Update File: (\S+)/.exec(String(p.input));
            file = m?.[1];
          } else if (name === "spawn_agent") kind = "spawn";
          else if (name.startsWith("mcp__")) kind = "mcp";
          cur.calls.set(id, { kind, file });
          cur.tools++;
        } else if (sub === "function_call_output") {
          const c = cur.calls.get(String(p.call_id));
          if (c?.kind === "spawn" && String(p.output).startsWith("Error")) c.failed = true;
        }
      }
    }

    // Finalise turns of this file.
    let seq = 0;
    let prevPrompt: string | undefined;
    let compacted = false;
    const kept: XTurn[] = [];
    for (const t of turns) {
      if (parentTurns?.has(t.id) && meta.forked_from_id) continue; // copied from the fork parent
      const work = t.tools > 0 || t.resp.size > 0;
      if (!t.hasContext && !work) continue; // imported stub
      const r = t.row;
      if (!paginated) legacyFinish(t);
      r.seq = seq++;
      r.afterCompaction = compacted;
      r.compactions = t.compactions;
      if (t.compactions > 0) compacted = true;
      r.version = String(meta.cli_version ?? "unknown");
      r.entrypoint = typeof meta.source === "string" ? meta.source : "unknown";
      r.model = t.tally.model.top() ?? "unknown";
      r.effort = t.tally.effort.top() ?? "unknown";
      r.mode = t.tally.mode.top() ?? "unknown";
      const first = t.typed[0];
      if (first !== undefined) {
        r.humanPrompt = exec ? 0 : 1;
        r.promptChars = exec ? null : first.length;
        r.queuedMidTurn = t.typed.length - 1;
        if (!exec) {
          r.pushback = isPushback(first) || isNearDuplicate(prevPrompt, first) ? 1 : 0;
          prevPrompt = first;
        }
      }
      for (const q of t.resp.values()) { r.steps++; r.outTok += q.out; r.inTok += q.inT; r.cacheRead += q.cr; r.cacheWrite += q.cw; }
      r.toolCalls = t.tools;
      r.churned = [...t.editsByFile.values()].some((n) => n >= 3) ? 1 : 0;
      r.durationMs = Math.max(0, t.last - t.first);
      kept.push(t);
      rows.push(r);
    }
    exchangesBySession.set(sid, kept);
  }

  // Subagent threads: attribute to the parent exchange running at their first timestamp.
  for (const f of files.filter(isSub)) {
    const meta = metaOf.get(f)!;
    const kept = exchangesBySession.get(String(meta.parent_thread_id));
    if (!kept?.length) continue;
    const recs = loaded.get(f)!;
    const paginated = recs.some((r) => obj(r.payload)?.type === "item_completed");
    const t0 = ms(recs[0]!.timestamp);
    let target = kept[0]!;
    for (const k of kept) if (k.first <= t0) target = k;
    const resp = new Map<string, { out: number; inT: number; cr: number; cw: number }>();
    let tools = 0;
    for (const r of recs) {
      const p = obj(r.payload) ?? {};
      if (r.type === "token_usage_record") {
        const u = obj(p.usage) ?? {};
        const cached = Number(u.cached_input_tokens ?? 0);
        resp.set(String(p.response_id), { out: Number(u.output_tokens ?? 0), inT: Number(u.input_tokens ?? 0) - cached, cr: cached, cw: Number(u.cache_write_input_tokens ?? 0) });
      } else if (paginated && p.type === "item_completed") {
        const k = String(obj(p.item)?.type);
        if (k === "CommandExecution" || k === "FileChange" || k === "McpToolCall" || k === "CollabAgentToolCall") tools++;
      } else if (!paginated && r.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) tools++;
    }
    target.row.subToolCalls += tools;
    for (const q of resp.values()) { target.row.subOutTok += q.out; target.row.subInTok += q.inT; target.row.subCacheRead += q.cr; target.row.subCacheWrite += q.cw; }
  }
  return rows;
}

function codexExec(t: XTurn, parsed: Rec[]): void {
  const kinds = parsed.map((x) => x.type);
  if (kinds.length && kinds.every((k) => k === "read" || k === "search" || k === "list_files")) t.row.reads++;
  for (const x of parsed) if (x.type === "read" && typeof x.path === "string") t.readFiles.add(x.path);
}

function codexEdit(t: XTurn, file: string | undefined): void {
  t.row.edits++;
  if (!file) return;
  if (!t.readFiles.has(file)) t.row.blindEdits++;
  t.editsByFile.set(file, (t.editsByFile.get(file) ?? 0) + 1);
}

/** Legacy rollouts: classify the response_item calls by their paired events (exec parsed_cmd, patch success, mcp result). */
function legacyFinish(t: XTurn): void {
  for (const c of t.calls.values()) {
    if (c.failed) t.row.toolErrors++;
    if (c.kind === "exec") codexExec(t, c.parsed ?? []);
    else if (c.kind === "patch") codexEdit(t, c.file);
  }
}
