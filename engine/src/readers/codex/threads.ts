/**
 * Rollout discovery and the thread index (thread id → file, parent → children) used to attribute
 * subagent threads to the exchange that spawned them.
 *
 * The index reads only each file's leading session_meta and caches it by path + mtime + size, so a
 * full scan reads each file's first lines once per process; the index itself is built once per scan.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FUTURE_SLACK_MS, obj } from "../../util.js";
import { stamp, walkFiles } from "../fs.js";
import { emitsEvents } from "./events.js";
import { providerOf, sessionFlags } from "./session.js";

const DIRS = ["sessions", "archived_sessions"] as const;
const isRollout = (name: string) => name.startsWith("rollout-") && name.endsWith(".jsonl");

/**
 * Rollout files under a Codex root: live sessions first, then archived copies whose basename is not
 * also live (archiving moves a file; a copy in both places is the same thread). Sorted for determinism.
 */
export function rolloutFiles(root: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of DIRS) {
    for (const p of walkFiles(join(root, dir), isRollout).sort()) {
      const name = basename(p);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(p);
    }
  }
  return out;
}

/** Codex root a rollout path lives under (parent of its sessions/ or archived_sessions/ ancestor). */
export function rootOf(path: string): string | undefined {
  let dir = dirname(path);
  for (let i = 0; i < 16; i++) {
    const name = basename(dir);
    if (name === "sessions" || name === "archived_sessions") return dirname(dir);
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

const LINE_MAX = 8 * 1024 * 1024;
/** Leading lines searched for the session_meta (a corrupt or partial first write may precede it). */
const LEAD_LINES = 4;

/** Up to `maxLines` leading lines of a file (without newlines). Stops early at EOF or at a line over 8 MiB. */
export function readLeadingLines(path: string, maxLines: number): string[] {
  const lines: string[] = [];
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(64 * 1024);
    let chunks: Buffer[] = [];
    let size = 0;
    while (lines.length < maxLines) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      let data = buf.subarray(0, n);
      let nl: number;
      while (lines.length < maxLines && (nl = data.indexOf(10)) >= 0) {
        chunks.push(Buffer.from(data.subarray(0, nl)));
        lines.push(Buffer.concat(chunks).toString("utf8"));
        chunks = [];
        size = 0;
        data = data.subarray(nl + 1);
      }
      if (lines.length >= maxLines) break;
      chunks.push(Buffer.from(data));
      size += data.length;
      if (size > LINE_MAX) return lines;
    }
    if (lines.length < maxLines && size > 0) lines.push(Buffer.concat(chunks).toString("utf8")); // last line, no newline
    return lines;
  } catch {
    return lines;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export interface ThreadMeta {
  threadId?: string;
  parentThreadId?: string;
  /** session_meta.forked_from_id (≠ the own id): the parse may read that thread's first page (fork.ts). */
  forkedFrom?: string;
}

/**
 * What the leading session_meta says about the session itself (memory only): used to find a `model_provider`
 * switch between sessions, which no Exchange label carries (events.ts).
 */
export interface SessionHead {
  /**
   * Candidate session start times, epoch ms, best first: the session_meta's envelope timestamp, its payload timestamp,
   * then the timestamps of the leading lines after it. Not bounded by `now` here (the cache outlives a clock change);
   * providerSwitches takes the first one no later than now + FUTURE_SLACK_MS, like cleanTime.
   */
  times: number[];
  /** Raw `model_provider` (memory only; hashed when an event is emitted). */
  provider?: string;
  /** `session_meta.source` entrypoint enum (session.ts). */
  entrypoint: string;
  /** Emits change events: not driven by another agent, not a `codex exec` run (events.ts `emitsEvents`). */
  main: boolean;
}

const metaCache = new Map<string, { mtimeMs: number; size: number; meta: ThreadMeta; head?: SessionHead }>();

const MIN_TIME = Date.parse("2020-01-01T00:00:00Z");
function timeOf(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms >= MIN_TIME ? ms : undefined;
}
const pushTime = (out: number[], v: unknown): void => { const ms = timeOf(v); if (ms !== undefined) out.push(ms); };

/**
 * Ids and head of a rollout's leading session_meta (cached by path + mtime + size). The first of the leading lines
 * that parses as a JSON object decides: a session_meta gives the ids, anything else gives none. Unparseable leading
 * lines (a torn first write) are skipped.
 */
function leadingMeta(path: string): { meta: ThreadMeta; head?: SessionHead } {
  const st = stamp(path);
  if (!st) return { meta: {} };
  const hit = metaCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let meta: ThreadMeta = {};
  let head: SessionHead | undefined;
  let decided = false;
  for (const line of readLeadingLines(path, LEAD_LINES)) {
    let d: Record<string, unknown> | undefined;
    try { d = obj(JSON.parse(line)); } catch { continue; }
    if (!d) continue;
    if (decided) {
      // Later leading lines only add fallback times: a session_meta stamped while the clock was ahead (then corrected)
      // is still placed among the other sessions by the records written right after it.
      if (head) pushTime(head.times, d.timestamp);
      continue;
    }
    decided = true;
    const p = obj(d.payload);
    if (d.type === "session_meta" && p) {
      const id = typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? p.session_id : undefined;
      meta = { threadId: id || undefined, parentThreadId: typeof p.parent_thread_id === "string" && p.parent_thread_id ? p.parent_thread_id : undefined };
      if (typeof p.forked_from_id === "string" && p.forked_from_id && p.forked_from_id !== id) meta.forkedFrom = p.forked_from_id;
      const f = sessionFlags(p);
      const times: number[] = [];
      pushTime(times, d.timestamp);
      pushTime(times, p.timestamp);
      head = { times, provider: providerOf(p), entrypoint: f.entrypoint, main: emitsEvents(f) };
    } else break;
  }
  const entry = { mtimeMs: st.mtimeMs, size: st.size, meta, head };
  metaCache.set(path, entry);
  return entry;
}

/** Thread ids from a rollout's leading session_meta (see leadingMeta). */
export function threadMeta(path: string): ThreadMeta {
  return leadingMeta(path).meta;
}

export interface ThreadIndex {
  /**
   * Thread id → every rollout file whose session_meta carries that id, in rolloutFiles order. Usually one;
   * paginated threads can continue in further files (session_meta.history_base), resumed threads too.
   */
  pages: Map<string, string[]>;
  /** Parent thread id → child rollout paths. */
  children: Map<string, string[]>;
  /**
   * Rollout path → the ids the index used for it. Linking decisions in parse() read this (never the full
   * parse) so a child is skipped exactly when its parent's attribution can see it.
   */
  meta: Map<string, ThreadMeta>;
  /**
   * Rollout path → the provider switch at the start of that session, if any: its own head and the previous
   * session's provider. "Previous" = the latest earlier main session (by session_meta time, then file order) with
   * the same entrypoint and a known provider, so a CLI profile and the Desktop app using different providers are
   * compared each with themselves, not with each other at every alternation.
   */
  providerSwitch: Map<string, { from: string; to: string; ts: number }>;
}

const push = (m: Map<string, string[]>, k: string, v: string) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

/**
 * A session's start time for ordering and dating a provider switch: its first candidate time no later than
 * now + FUTURE_SLACK_MS (util.ts cleanTime's bound). A session_meta stamped while the clock was set ahead would
 * otherwise date a "you · strong" switch in the future, and, sorted last, hide the real switches around it.
 */
function headTime(head: SessionHead, now: Date): number | undefined {
  const limit = now.getTime() + FUTURE_SLACK_MS;
  return head.times.find((t) => t <= limit);
}

function providerSwitches(heads: { path: string; head: SessionHead }[], now: Date): Map<string, { from: string; to: string; ts: number }> {
  const out = new Map<string, { from: string; to: string; ts: number }>();
  const byEntry = new Map<string, { path: string; ts: number; provider: string; order: number }[]>();
  heads.forEach(({ path, head }, order) => {
    const ts = headTime(head, now);
    if (!head.main || head.provider === undefined || ts === undefined) return;
    const l = byEntry.get(head.entrypoint);
    const row = { path, ts, provider: head.provider, order };
    if (l) l.push(row); else byEntry.set(head.entrypoint, [row]);
  });
  for (const rows of byEntry.values()) {
    rows.sort((a, b) => a.ts - b.ts || a.order - b.order);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!, b = rows[i]!;
      if (a.provider !== b.provider) out.set(b.path, { from: a.provider, to: b.provider, ts: b.ts });
    }
  }
  return out;
}

/** `now` bounds session start times (headTime); a scan passes its own clock. */
export function threadIndex(root: string, now: Date = new Date()): ThreadIndex {
  const pages = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const meta = new Map<string, ThreadMeta>();
  const heads: { path: string; head: SessionHead }[] = [];
  for (const path of rolloutFiles(root)) {
    const { meta: m, head } = leadingMeta(path);
    meta.set(path, m);
    if (head) heads.push({ path, head });
    if (m.threadId) push(pages, m.threadId, path);
    if (m.parentThreadId && m.parentThreadId !== m.threadId) push(children, m.parentThreadId, path);
  }
  return { pages, children, meta, providerSwitch: providerSwitches(heads, now) };
}

/**
 * One ThreadIndex per scan. A scan is one `list()` followed by `parse()` calls: `reset()` at list time,
 * `get()` builds lazily on the first parse and every later parse in that scan sees the same index.
 * Deliberately no TTL / mtime invalidation: the exactly-once rule in link.ts needs a single snapshot
 * per scan (building per parse also made a scan O(files²): 2,000 files took 11 s). The same holds for `now`: the
 * first get() of a scan builds the index with its clock (depKeys passes the wall clock, parse() the scan's ctx.now,
 * normally the same moment) and every later get() of that scan reuses it.
 */
export class ScanIndex {
  /** Number of index builds (tests assert one per scan). */
  builds = 0;
  private readonly byRoot = new Map<string, ThreadIndex>();

  reset(): void { this.byRoot.clear(); }

  get(root: string, now: Date = new Date()): ThreadIndex {
    let index = this.byRoot.get(root);
    if (!index) {
      index = threadIndex(root, now);
      this.builds++;
      this.byRoot.set(root, index);
    }
    return index;
  }
}
