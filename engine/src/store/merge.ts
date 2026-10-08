/**
 * Global merge of the shards (scan.ts step 6): one exchange list and one event list per agent, deduplicated
 * across files.
 *
 * What is deduplicated where:
 *  - Inside one source, the readers already drop repeated items: streamed lines of one response (requestId +
 *    message.id, keeping each usage field's maximum), resumed-session replays against the sessions created before it
 *    in the same project (uuids, via depKey-tracked priors), legacy fork copies of a parent thread (fork.ts) and
 *    imported counter-id turns (rollout.ts).
 *  - Across sources, here: an exchange whose opening record also opened an exchange in another source (same
 *    `origins` id — a Claude record uuid, or a UUID-shaped Codex turn id on a human prompt) is a copy; the EARLIEST
 *    copy wins: the earlier exchange time, then the source created first, then the smaller ids. This catches what no
 *    single parse can see: a session resumed from another project folder, a fork whose parent's log is gone but
 *    whose history is still stored. Change events are deduplicated by their (content-derived) id.
 *  - Not caught (stated, not hidden): a partial replay whose opening record was not replayed, and Codex turns with
 *    counter ids (per-thread, never comparable across files).
 */
import type { AgentId, ChangeEvent, Exchange, ParseStats } from "../types.js";
import { emptyStats } from "../types.js";
import { bump } from "../util.js";
import type { Shard } from "./shard.js";

export interface AgentMerge {
  agent: AgentId;
  exchanges: Exchange[];
  events: ChangeEvent[];
  /** Exchanges dropped as cross-file copies. */
  crossFileDuplicates: number;
  /** Parse statistics summed over sources still on disk. */
  stats: ParseStats;
  /** Sources on disk / shards kept only as history. */
  present: number;
  historyOnly: number;
}

interface Candidate { x: Exchange; born: number; sid: string; agent: AgentId }

/**
 * "Earliest copy": the earlier exchange time first (a fork's copy carries fresh timestamps; a resume replay keeps
 * them, a tie), then the source created first (birth time is a tie-break only: a copied or restored tree has every
 * birth time at the copy), then the smaller ids — deterministic whatever the file order.
 */
function earlier(a: Candidate, b: Candidate): boolean {
  const ta = Date.parse(a.x.t), tb = Date.parse(b.x.t);
  if (ta !== tb) return ta < tb;
  if (a.born !== b.born) return a.born < b.born;
  if (a.sid !== b.sid) return a.sid < b.sid;
  return a.x.seq < b.x.seq;
}

function addStats(into: ParseStats, s: ParseStats): void {
  into.files += s.files ?? 0;
  into.filesFailed += s.filesFailed ?? 0;
  into.badLines += s.badLines ?? 0;
  into.truncatedTail += s.truncatedTail ?? 0;
  into.duplicates += s.duplicates ?? 0;
  into.badTimestamps += s.badTimestamps ?? 0;
  for (const [k, v] of Object.entries(s.unknownTypes ?? {})) if (typeof v === "number") bump(into.unknownTypes, k, v);
}

const byTime = <T extends { t: string; id: string }>(a: T, b: T): number => {
  const ta = Date.parse(a.t), tb = Date.parse(b.t);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function mergeShards(shards: readonly Shard[], present: ReadonlySet<string>): Map<AgentId, AgentMerge> {
  const out = new Map<AgentId, AgentMerge>();
  const winners = new Map<string, Candidate>();
  const loose: Candidate[] = [];
  const events = new Map<AgentId, Map<string, ChangeEvent>>();
  const agentOf = (a: AgentId): AgentMerge => {
    let m = out.get(a);
    if (!m) {
      m = { agent: a, exchanges: [], events: [], crossFileDuplicates: 0, stats: emptyStats(), present: 0, historyOnly: 0 };
      out.set(a, m);
      events.set(a, new Map());
    }
    return m;
  };
  for (const s of shards) {
    const m = agentOf(s.agent);
    if (present.has(s.sid)) { m.present++; addStats(m.stats, s.stats); } else m.historyOnly++;
    s.exchanges.forEach((x, i) => {
      const c: Candidate = { x, born: s.born, sid: s.sid, agent: s.agent };
      const origin = s.origins[i];
      if (typeof origin !== "string") { loose.push(c); return; }
      const key = `${s.agent}|${origin}`;
      const prev = winners.get(key);
      if (!prev) winners.set(key, c);
      else {
        m.crossFileDuplicates++;
        if (earlier(c, prev)) winners.set(key, c);
      }
    });
    const ev = events.get(s.agent)!;
    for (const e of s.events) {
      const prev = ev.get(e.id);
      if (!prev || byTime(e, prev) < 0) ev.set(e.id, e);
    }
  }
  for (const c of [...loose, ...winners.values()]) agentOf(c.agent).exchanges.push(c.x);
  for (const m of out.values()) {
    m.exchanges.sort(byTime);
    m.events = [...events.get(m.agent)!.values()].sort(byTime);
  }
  return out;
}
