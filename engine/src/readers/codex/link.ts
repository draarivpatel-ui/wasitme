/**
 * Subagent attribution. A subagent rollout (session_meta.parent_thread_id) whose parent thread has a file
 * produces no exchanges of its own; the nearest unlinked ancestor folds the descendant tree into
 * `subToolCalls` / `subTokens` (context only, never votes) and the research work `subReads` / `subEdits` /
 * `subBlindEdits` (D62a: counted by the research metrics) of the exchange that spawned it — but only on
 * evidence. A child's edit is blind when it changes an existing file that the child thread had not read earlier
 * (its own turns, in order) and the receiving exchange's own turns never read (types.ts `subBlindEdits`).
 * A child turn goes to a parent exchange when:
 *   (a) its `root_turn_id` (turn_context / token_usage_record) is one of that exchange's turns; else
 *   (b) a spawn item in that exchange names the child thread (CollabAgentToolCall receivers, SubAgentActivity
 *       agent_thread_id; transitively, a descendant turn attributed to the exchange that names a grandchild);
 *       several naming exchanges → the one whose span holds the child turn, else the latest that started
 *       before it, else the first; else
 *   (c) the child turn starts inside the exchange's active span (its prompt to its last record).
 * Otherwise it is left unattributed: an exchange that had already finished, and spawned nothing, never
 * receives a child's work just because it was the last one to start.
 *
 * Exactly-once invariant (both sides use the same ThreadIndex, and thread ids from its `meta`, never from
 * a full parse — the two can disagree when a file's leading line is torn):
 *   - a child returns [] iff its parent thread id resolves to a file in the index;
 *   - a thread may span several files ("pages": history_base continuations, resumes). Each child turn is
 *     owned by exactly one page, decided the same way on every page: the page holding its root turn, else
 *     the pages naming its thread (latest page start ≤ child time, else the earliest of them), else the page
 *     that owns its time (latest page start ≤ child time, else the earliest page). Only the owning page
 *     applies (a)–(c). Measured on real logs: one thread with three pages had each of its subagents counted
 *     three times before this rule.
 */
import type { Exchange, ParseStats } from "../../types.js";
import { emptyStats } from "../../types.js";
import type { ThreadParse, ToolEvent, Turn } from "./model.js";
import { parseRollout, type RolloutOptions } from "./rollout.js";
import type { Segmented } from "./segment.js";
import type { ThreadIndex } from "./threads.js";
import { samePath } from "./tools.js";

const MAX_DEPTH = 8;

interface Page { path: string; keys: Set<string>; start?: number }

function pageOf(path: string, thread: ThreadParse): Page {
  let start: number | undefined;
  for (const t of thread.turns) if (t.minTs !== undefined && (start === undefined || t.minTs < start)) start = t.minTs;
  return { path, keys: new Set(thread.turns.map((t) => t.key)), start };
}

/** Page owning a moment: latest start ≤ ts, else the earliest page (ties: first in index order). */
function ownerByTime(pages: Page[], ts: number | undefined): Page | undefined {
  const dated = pages.filter((p) => p.start !== undefined);
  if (!dated.length) return pages[0];
  if (ts !== undefined) {
    let best: Page | undefined;
    for (const p of dated) if (p.start! <= ts && (!best || p.start! > best.start!)) best = p;
    if (best) return best;
  }
  return dated.reduce((a, b) => (b.start! < a.start! ? b : a));
}

const turnTime = (turn: Turn): number | undefined => turn.firstTs ?? turn.minTs;

function pushOnce<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (!l) m.set(k, [v]);
  else if (!l.includes(v)) l.push(v);
}

/** Evidence gathered so far: which pages / exchanges (of this page) name a thread in a spawn item. */
interface Evidence {
  pages: Map<string, Page[]>;
  exchanges: Map<string, Exchange[]>;
}

function owner(turn: Turn, threadId: string | undefined, self: Page, all: Page[], ev: Evidence): Page | undefined {
  for (const r of turn.rootTurnIds) if (self.keys.has(r)) return self;
  for (const r of turn.rootTurnIds) for (const p of all) if (p.keys.has(r)) return p;
  const naming = threadId ? ev.pages.get(threadId) : undefined;
  if (naming?.length) return ownerByTime(naming, turnTime(turn));
  return all.length > 1 ? ownerByTime(all, turnTime(turn)) : self;
}

const inside = (seg: Segmented, ex: Exchange, ts: number): boolean => {
  const s = seg.spans.get(ex);
  return Boolean(s && s.lo <= ts && ts <= s.hi);
};

/** Exchange of this page a child turn belongs to, by (a) root turn, (b) naming spawn item, (c) span. */
function target(turn: Turn, threadId: string | undefined, seg: Segmented, ev: Evidence): Exchange | undefined {
  for (const r of turn.rootTurnIds) { const ex = seg.byTurn.get(r); if (ex) return ex; }
  const ts = turnTime(turn);
  const named = threadId ? ev.exchanges.get(threadId) : undefined;
  if (named?.length) {
    if (ts === undefined) return named[0];
    let latest: Exchange | undefined;
    for (const ex of named) {
      if (inside(seg, ex, ts)) return ex;
      if (Date.parse(ex.t) <= ts && (!latest || Date.parse(ex.t) >= Date.parse(latest.t))) latest = ex;
    }
    return latest ?? named[0];
  }
  if (ts === undefined) return undefined;
  let hit: Exchange | undefined;
  for (const ex of seg.exchanges) if (inside(seg, ex, ts)) hit = ex;
  return hit;
}

/** Research work of one attributed child turn (D62a). `childReads`: files the child thread read before this turn. */
function delegate(ex: Exchange, tools: readonly ToolEvent[], childReads: string[], parentReads: readonly string[]): void {
  let reads = 0, edits = 0, blind = 0;
  for (const ev of tools) {
    if (ev.read) reads++;
    for (const e of ev.edits) {
      edits++;
      if (!e.path || e.isNew) continue;
      const seen = childReads.some((r) => samePath(r, e.path)) || parentReads.some((r) => samePath(r, e.path));
      if (!seen) blind++;
    }
    childReads.push(...ev.readPaths);
  }
  ex.subReads = (ex.subReads ?? 0) + reads;
  ex.subEdits = (ex.subEdits ?? 0) + edits;
  ex.subBlindEdits = (ex.subBlindEdits ?? 0) + blind;
}

/**
 * Fold every descendant thread of `threadId` (the index's id for `selfPath`, parsed as `thread`) into `seg`.
 * Child files and sibling pages are parsed with throwaway stats so per-file ParseStats stay counted once
 * (in their own parse) — except `futureMin`, which is folded into `stats`: records this parse dropped as
 * future-dated, wherever they were read, make it worth re-running once the clock reaches them.
 */
export async function attributeDescendants(
  threadId: string | undefined, thread: ThreadParse, selfPath: string, index: ThreadIndex, seg: Segmented, opts: RolloutOptions,
  stats?: ParseStats,
): Promise<void> {
  const throwaway = (): ParseStats => emptyStats();
  const fold = (s: ParseStats): void => {
    if (stats && s.futureMin !== undefined && (stats.futureMin === undefined || s.futureMin < stats.futureMin)) stats.futureMin = s.futureMin;
  };
  if (!threadId || !seg.exchanges.length || !index.children.has(threadId)) return;
  const self = pageOf(selfPath, thread);
  const all: Page[] = [self];
  const ev: Evidence = { pages: new Map(), exchanges: new Map() };
  const name = (turn: Turn, page: Page, ex: Exchange | undefined) => {
    for (const id of turn.spawned) {
      pushOnce(ev.pages, id, page);
      if (ex) pushOnce(ev.exchanges, id, ex);
    }
  };
  for (const t of thread.turns) name(t, self, seg.byTurn.get(t.key));
  for (const path of index.pages.get(threadId) ?? []) {
    if (path === selfPath) continue;
    let other: ThreadParse;
    const os = throwaway();
    try { other = await parseRollout(path, os, opts); } catch { continue; } // unreadable page: ignore
    fold(os);
    const page = pageOf(path, other);
    all.push(page);
    for (const t of other.turns) name(t, page, undefined);
  }

  const visitedIds = new Set([threadId]);
  const visitedPaths = new Set([selfPath]);
  let frontier = [threadId];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const path of index.children.get(id) ?? []) {
        if (visitedPaths.has(path)) continue;
        visitedPaths.add(path);
        let child: ThreadParse;
        const cs = throwaway();
        try { child = await parseRollout(path, cs, opts); } catch { continue; }
        fold(cs);
        const childId = index.meta.get(path)?.threadId;
        const childReads: string[] = [];
        for (const turn of child.turns) {
          const page = owner(turn, childId, self, all, ev);
          const ex = page === self ? target(turn, childId, seg, ev) : undefined;
          if (page) name(turn, page, ex); // grandchildren named by this turn follow it
          if (!ex) {
            for (const t of turn.tools) childReads.push(...t.readPaths); // still read by the child
            continue;
          }
          let tokens = 0;
          for (const u of turn.usage) tokens += u.inTok + u.cacheRead + u.outTok;
          ex.subToolCalls += turn.tools.length;
          ex.subTokens += tokens;
          delegate(ex, turn.tools, childReads, seg.readPaths.get(ex) ?? []);
        }
        if (childId && !visitedIds.has(childId)) { visitedIds.add(childId); next.push(childId); }
      }
    }
    frontier = next;
  }
}
