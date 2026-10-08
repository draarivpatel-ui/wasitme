/**
 * Turns → exchanges.
 *
 * Boundary rule (one exchange per real human prompt, until the next real human prompt — types.ts `Exchange`):
 *  - the first non-injected message of a turn decides: a human prompt opens a human exchange;
 *  - further human messages inside the same turn were typed while the agent worked → queuedMidTurn;
 *  - a heartbeat / scheduled-task trigger opens an agent-initiated exchange (humanPrompt 0) only when no
 *    exchange is open yet (work before the first prompt); later ones are absorbed like any injected context;
 *  - turns started by other injected context (subagent/task notifications, turn_aborted markers) or by no
 *    message at all continue the current exchange.
 * Threads driven by another agent (subagents, agent-created) use the same boundaries but never carry
 * human-prompt signals. `codex exec` runs do: their prompt is real. Whether an exchange votes is its session's
 * `interactiveClass` (session.ts); interrupts are recorded as logged in every thread (an orphaned subagent's
 * interrupt is kept as context — its `scripted` class keeps it out of the vote — never zeroed).
 */
import { promptEnglish } from "../../language.js";
import { isPushback } from "../../pushback.js";
import { isNearDuplicate } from "../../similarity.js";
import type { Exchange, HashFn } from "../../types.js";
import { localDay, median, Tally } from "../../util.js";
import type { Msg, ThreadParse, ToolEvent, Turn } from "./model.js";
import { samePath } from "./tools.js";

export interface SegmentContext {
  hash: HashFn;
  timeZone?: string;
  /** Source key (stable across rescans and archiving). */
  sourceKey: string;
  session: string;
  project: string;
}

export interface Segmented {
  exchanges: Exchange[];
  /** Turn key → exchange it belongs to (subagent attribution by root_turn_id). */
  byTurn: Map<string, Exchange>;
  /** Active span of each exchange: from its prompt (or first record) to its last record, epoch ms. */
  spans: Map<Exchange, { lo: number; hi: number }>;
  /** Files each exchange's own turns read (memory only): a child edit of one of them is not blind (D62a). */
  readPaths: Map<Exchange, string[]>;
  /** Re-emitted prompts dropped as duplicates. */
  duplicates: number;
  /**
   * Cross-file identity per exchange (types.ts ParseResult.origins): the opening turn's id, salted, only for an
   * exchange opened by a human prompt whose turn id is UUID-shaped. Counter / legacy ids are per-thread and a
   * turn can continue in another page, so anything else is null (never deduped across files).
   */
  origins: (string | null)[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The provider (`h:` short hash) in effect at `ts`: the latest own session_meta at or before it, else the first known. */
function providerAt(thread: ThreadParse, ts: number): string | undefined {
  let best: string | undefined, first: string | undefined;
  for (const m of thread.metas) {
    if (m.provider === undefined) continue;
    first ??= m.provider;
    if (m.ts === undefined || m.ts <= ts) best = m.provider;
  }
  return best ?? first;
}

interface Draft {
  turns: Turn[];
  human: boolean;
  prompt?: Msg;
  queued: number;
  pushback: boolean;
}

/** Re-emitted prompt: identical to the previous prompt and logged within this window after an interrupt. */
const REEMIT_MS = 2000;
/** Read-before-edit look-back across exchange boundaries (issue #42796 definition, research/05). */
const READ_WINDOW = 10;

function active(t: Turn): boolean {
  return t.usage.length > 0 || t.tools.length > 0 || t.thinkBlocks > 0 || t.compactions > 0 || t.apiErrors > 0
    || t.apiRetries > 0 || t.interrupted;
}

function drafts(thread: ThreadParse): { list: Draft[]; duplicates: number } {
  const list: Draft[] = [];
  let cur: Draft | undefined;
  let prevText: string | undefined;
  let lastAbort: number | undefined;
  let duplicates = 0;
  const openDraft = (d: Draft): Draft => { list.push(d); return d; };
  for (const turn of thread.turns) {
    let opened = false;
    for (const m of turn.messages) {
      if (m.trigger === "continuation") continue;
      if (m.trigger === "automation") {
        if (!opened && !cur) { cur = openDraft({ turns: [], human: false, queued: 0, pushback: false }); opened = true; }
        continue;
      }
      if (lastAbort !== undefined && m.ts !== undefined && m.text === prevText && m.ts - lastAbort >= 0 && m.ts - lastAbort <= REEMIT_MS) {
        duplicates++;
        continue;
      }
      if (!opened) {
        const human = !thread.automated;
        const pushback = human && (isPushback(m.text) || isNearDuplicate(prevText, m.text));
        cur = openDraft({ turns: [], human, prompt: m, queued: 0, pushback });
        opened = true;
      } else if (cur && !thread.automated) {
        cur.queued++;
      }
      prevText = m.text;
      lastAbort = undefined;
    }
    if (!opened && !active(turn)) continue;
    cur ??= openDraft({ turns: [], human: false, queued: 0, pushback: false });
    cur.turns.push(turn);
    if (turn.interrupted && turn.abortTs !== undefined) lastAbort = turn.abortTs;
  }
  return { list, duplicates };
}

function majority(lists: string[][], fallback: string | undefined): string {
  const t = new Tally();
  for (const l of lists) for (const v of l) t.add(v);
  return t.top() ?? fallback ?? "unknown";
}

export function segment(thread: ThreadParse, ctx: SegmentContext): Segmented {
  const { list, duplicates } = drafts(thread);
  const exchanges: Exchange[] = [];
  const byTurn = new Map<string, Exchange>();
  const spans = new Map<Exchange, { lo: number; hi: number }>();
  const readPaths = new Map<Exchange, string[]>();
  const window: ToolEvent[] = [];
  const last: { model?: string; effort?: string; mode?: string; version?: string } = {};
  const origins: (string | null)[] = [];
  let compactionsBefore = 0;
  let lastT: number | undefined;

  for (const d of list) {
    const turns = d.turns;
    const first = turns[0];
    let start = d.prompt?.ts ?? first?.firstTs;
    if (start === undefined) for (const t of turns) if (t.minTs !== undefined) { start = t.minTs; break; }
    start ??= lastT;
    if (start === undefined || !first) continue; // nothing datable
    lastT = start;

    let lo = start, hi = start;
    let steps = 0, toolCalls = 0, toolErrors = 0, toolErrorsCmd = 0, cmdCalls = 0, rejections = 0, reads = 0, edits = 0, blindEdits = 0;
    let outTok = 0, inTok = 0, cacheRead = 0, cacheWrite = 0, apiErrors = 0, apiRetries = 0, compactions = 0;
    let thinkBlocks = 0, thinkRedacted = 0, interrupted = false;
    const sigs: number[] = [];
    const readsHere: string[] = [];
    const editsPerFile = new Map<string, number>();

    for (const t of turns) {
      if (t.minTs !== undefined && t.minTs < lo) lo = t.minTs;
      if (t.maxTs !== undefined && t.maxTs > hi) hi = t.maxTs;
      steps += t.usage.length;
      for (const u of t.usage) { inTok += u.inTok; cacheRead += u.cacheRead; cacheWrite += u.cacheWrite; outTok += u.outTok; }
      for (const ev of t.tools) {
        toolCalls++;
        if (ev.rejected) rejections++;
        else if (ev.failed) { toolErrors++; if (ev.kind === "cmd") toolErrorsCmd++; }
        if (ev.kind === "cmd" && !ev.rejected) cmdCalls++; // cmdFailures' denominator: commands that ran
        if (ev.read) reads++;
        for (const e of ev.edits) {
          edits++;
          if (!e.path) continue;
          editsPerFile.set(e.path, (editsPerFile.get(e.path) ?? 0) + 1);
          const seen = readsHere.some((r) => samePath(r, e.path)) || window.some((w) => w.readPaths.some((r) => samePath(r, e.path)));
          if (!e.isNew && !seen) blindEdits++;
        }
        readsHere.push(...ev.readPaths);
        window.push(ev);
        if (window.length > READ_WINDOW) window.shift();
      }
      compactions += t.compactions;
      apiErrors += t.apiErrors;
      apiRetries += t.apiRetries;
      thinkBlocks += t.thinkBlocks;
      thinkRedacted += t.thinkRedacted;
      sigs.push(...t.thinkSigs);
      if (t.interrupted) interrupted = true;
    }

    const human = d.human;
    const model = majority(turns.map((t) => t.models), last.model);
    const ex: Exchange = {
      v: 1,
      agent: "codex",
      id: ctx.hash(`codex|${ctx.sourceKey}|${first.firstRecordId}`, "x-"),
      session: ctx.session,
      project: ctx.project,
      t: new Date(start).toISOString(),
      day: localDay(new Date(start).toISOString(), ctx.timeZone),
      version: majority(turns.map((t) => t.versions), last.version),
      model,
      servedModel: model, // Codex logs only the requested model
      effort: majority(turns.map((t) => t.efforts), last.effort),
      mode: majority(turns.map((t) => t.modes), last.mode),
      entrypoint: thread.entrypoint,
      interactiveClass: thread.interactiveClass,
      provider: providerAt(thread, start),
      seq: exchanges.length,
      afterCompaction: compactionsBefore > 0,
      promptChars: human ? d.prompt?.text.length ?? 0 : 0,
      humanPrompt: human ? 1 : 0,
      promptEnglish: human && d.prompt ? promptEnglish(d.prompt.text) : undefined,
      interrupted: interrupted ? 1 : 0,
      pushback: d.pushback ? 1 : 0,
      queuedMidTurn: d.queued,
      steps, toolCalls, toolErrors, toolErrorsEdit: toolErrors - toolErrorsCmd, toolErrorsCmd, cmdCalls,
      rejections, blocked: 0, reads, edits, blindEdits,
      churned: [...editsPerFile.values()].some((n) => n >= 3) ? 1 : 0,
      outTok, inTok, cacheRead, cacheWrite, apiErrors, apiRetries, compactions,
      thinkBlocks, thinkRedacted, thinkSigMedian: median(sigs),
      subToolCalls: 0, subTokens: 0, subReads: 0, subEdits: 0, subBlindEdits: 0,
      durationMs: Math.max(0, hi - lo),
    };
    for (const k of ["model", "effort", "mode", "version"] as const) if (ex[k] !== "unknown") last[k] = ex[k];
    compactionsBefore += compactions;
    exchanges.push(ex);
    origins.push(human && d.prompt && UUID_RE.test(first.firstRecordId) ? ctx.hash(`codex|turn|${first.firstRecordId.toLowerCase()}`, "o-") : null);
    spans.set(ex, { lo: start, hi });
    readPaths.set(ex, readsHere);
    for (const t of turns) byTurn.set(t.key, ex);
  }
  return { exchanges, byTurn, spans, readPaths, duplicates, origins };
}
