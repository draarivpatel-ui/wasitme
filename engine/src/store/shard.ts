/**
 * Per-source shards (D60; scan.ts steps 3 and 6): the derived exchanges, change events and parse statistics of ONE
 * source, stored as `history/shards/<sid>.json`. A shard is history: it stays when its source log is deleted, so the
 * analysis keeps seeing that past (PRIVACY.md "What is stored": history outlives the logs).
 *
 * Contents are derived numbers, allow-listed labels and salted ids only (the readers' contract); the source key,
 * file paths and the depKey never enter a shard. Serialisation is canonical (fixed key order, `undefined` dropped),
 * so the same derived data always gives the same bytes and an unchanged shard is never rewritten.
 */
import { createHash } from "node:crypto";
import type { AgentId, ChangeEvent, Exchange, ParseResult, ParseStats } from "../types.js";
import { emptyStats } from "../types.js";
import { bump, localDay, typeKey } from "../util.js";
import { readOwnJson } from "./atomic.js";
import { EVENTS_FAMILY, EXCHANGE_FIELDS, STRUCTURAL_FAMILY, sortKeys, type FamilyVersions } from "./versions.js";

export const SHARD_SCHEMA = "wasitme.shard/1";
const MAX_SHARD_BYTES = 256 << 20;

export interface Shard {
  schema: typeof SHARD_SCHEMA;
  agent: AgentId;
  sid: string;
  /** Fingerprint of the source's own files when it was last parsed. */
  fp: string;
  /** Fingerprint of its dependencies (depKey) as last seen; null when it has none. */
  dep: string | null;
  /** Salted ids of the other sources its parse actually used (ParseResult.deps), sorted. */
  uses: string[];
  /** Parser versions per family the stored fields were derived with. */
  pv: Record<string, number>;
  /** Time zone the `day` fields were computed in. */
  tz: string;
  /** Creation time (ms) of the source's first file: "the earliest copy wins" in the global dedupe. */
  born: number;
  exchanges: Exchange[];
  /** Same length as `exchanges`: the cross-file identity of each exchange, or null. */
  origins: (string | null)[];
  events: ChangeEvent[];
  stats: ParseStats;
}

const EVENT_FIELDS: readonly (keyof ChangeEvent)[] = [
  "id", "t", "day", "agent", "kind", "side", "strength", "provenance", "from", "to", "evidence", "userInitiated", "note",
];
const STATS_FIELDS: readonly (keyof ParseStats)[] = ["files", "filesFailed", "badLines", "truncatedTail", "unknownTypes", "duplicates", "badTimestamps", "futureMin"];

function pick<T extends object>(o: T, fields: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = o[f];
    if (v !== undefined) out[f as string] = v;
  }
  return out;
}

/** Key an out-of-shape record type is stored under (the readers' own fallbacks). */
const TYPE_FALLBACK: Readonly<Record<AgentId, string>> = { "claude-code": "other", codex: "codex:unrecognised" };

function canonicalStats(s: ParseStats, agent: AgentId): Record<string, unknown> {
  const out = pick(s, STATS_FIELDS);
  // History never keeps a raw key that is not identifier-shaped (util.ts typeKey); colliding keys are summed.
  const folded: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.unknownTypes ?? {})) if (typeof v === "number" && Number.isFinite(v)) bump(folded, typeKey(k, TYPE_FALLBACK[agent]), v);
  const ut: Record<string, number> = {};
  for (const k of Object.keys(folded).sort()) bump(ut, k, folded[k]!);
  out.unknownTypes = ut;
  return out;
}

/** Canonical bytes of a shard (stable key order; undefined fields dropped). */
export function serializeShard(s: Shard): string {
  const doc = {
    schema: s.schema,
    agent: s.agent,
    sid: s.sid,
    fp: s.fp,
    dep: s.dep,
    uses: s.uses,
    pv: sortKeys(s.pv),
    tz: s.tz,
    born: s.born,
    exchanges: s.exchanges.map((x) => pick(x, EXCHANGE_FIELDS)),
    origins: s.origins,
    events: s.events.map((e) => pick(e, EVENT_FIELDS)),
    stats: canonicalStats(s.stats, s.agent),
  };
  return `${JSON.stringify(doc)}\n`;
}

/** Digest of a shard's canonical bytes (manifest `h`): any change to the stored history moves it. */
export function shardDigest(s: Shard, bytes = serializeShard(s)): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function alignedOrigins(r: ParseResult): (string | null)[] {
  const o = r.origins;
  return r.exchanges.map((_, i) => (o && typeof o[i] === "string" ? o[i]! : null));
}

export function shardFromParse(
  agent: AgentId, sid: string, fp: string, dep: string | null, uses: string[], pv: FamilyVersions, tz: string, born: number, r: ParseResult,
): Shard {
  return {
    schema: SHARD_SCHEMA, agent, sid, fp, dep, uses, pv: { ...pv }, tz, born,
    exchanges: r.exchanges, origins: alignedOrigins(r), events: r.events, stats: r.stats ?? emptyStats(),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read and structurally check a shard; undefined when missing, foreign or damaged (the source is then re-parsed). */
export function readShard(path: string, expect: { sid: string; agent?: AgentId }): Shard | undefined {
  const v = readOwnJson(path, MAX_SHARD_BYTES);
  if (!isObj(v) || v.schema !== SHARD_SCHEMA || v.sid !== expect.sid) return undefined;
  if (v.agent !== "claude-code" && v.agent !== "codex") return undefined;
  if (expect.agent && v.agent !== expect.agent) return undefined;
  if (typeof v.fp !== "string" || typeof v.tz !== "string" || !isObj(v.pv) || typeof v.born !== "number") return undefined;
  if (v.dep !== null && typeof v.dep !== "string") return undefined;
  if (!Array.isArray(v.uses) || !v.uses.every((u) => typeof u === "string" && /^src-[0-9a-f]{24}$/.test(u))) return undefined;
  if (!Array.isArray(v.exchanges) || !Array.isArray(v.events) || !Array.isArray(v.origins) || !isObj(v.stats)) return undefined;
  if (v.origins.length !== v.exchanges.length) return undefined;
  if (!v.exchanges.every((x) => isObj(x) && typeof x.id === "string" && typeof x.t === "string")) return undefined;
  if (!v.events.every((e) => isObj(e) && typeof e.id === "string" && typeof e.t === "string")) return undefined;
  const stats: ParseStats = { ...emptyStats(), ...(v.stats as Partial<ParseStats>) };
  if (!isObj(stats.unknownTypes)) stats.unknownTypes = {};
  if (stats.futureMin !== undefined && !Number.isFinite(stats.futureMin)) delete stats.futureMin;
  return { ...(v as unknown as Shard), stats };
}

/**
 * Re-derive `families` of a stored shard from a fresh parse of the same (unchanged) source. Only the named families'
 * fields (and the events, for `events`) are taken from the fresh parse; everything else stays as stored. When the
 * structural family moved, or the fresh parse no longer has the same exchanges (same ids, same order), the fresh
 * parse replaces the shard as a whole.
 */
export function rederive(
  old: Shard, fresh: ParseResult, families: readonly string[], fieldFamily: Readonly<Record<string, string>>, pv: FamilyVersions,
): { shard: Shard; mode: "partial" | "full" } {
  const freshShard = (): Shard => ({ ...old, pv: { ...pv }, exchanges: fresh.exchanges, origins: alignedOrigins(fresh), events: fresh.events, stats: fresh.stats });
  const fam = new Set(families);
  if (fam.has(STRUCTURAL_FAMILY)) return { shard: freshShard(), mode: "full" };
  const sameSet = old.exchanges.length === fresh.exchanges.length && old.exchanges.every((x, i) => x.id === fresh.exchanges[i]!.id);
  if (!sameSet) return { shard: freshShard(), mode: "full" };
  const fields = EXCHANGE_FIELDS.filter((f) => fam.has(fieldFamily[f] ?? ""));
  const exchanges = old.exchanges.map((x, i) => {
    const y = fresh.exchanges[i]!;
    const z: Record<string, unknown> = { ...x };
    for (const f of fields) {
      const v = (y as unknown as Record<string, unknown>)[f];
      if (v === undefined) delete z[f];
      else z[f] = v;
    }
    return z as unknown as Exchange;
  });
  return {
    shard: {
      ...old,
      pv: { ...pv },
      exchanges,
      events: fam.has(EVENTS_FAMILY) ? fresh.events : old.events,
      // Parse statistics are health, not history: always the latest parse's.
      stats: fresh.stats,
    },
    mode: "partial",
  };
}

/** Recompute every stored `day` in a new time zone (`t` is UTC and stored, so no re-parse is needed). */
export function retz(s: Shard, tz: string): Shard {
  if (s.tz === tz) return s;
  return {
    ...s,
    tz,
    exchanges: s.exchanges.map((x) => ({ ...x, day: localDay(x.t, tz) })),
    events: s.events.map((e) => ({ ...e, day: localDay(e.t, tz) })),
  };
}
