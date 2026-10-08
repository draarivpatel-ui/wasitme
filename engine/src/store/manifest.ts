/**
 * The store's manifest, `history/index.json` (schema-versioned): one entry per source ever seen, keyed by its salted
 * id, with the fingerprint and parser versions of its shard and whether the source is still on disk. It also records
 * the time zone the stored days are in and the digest of the inputs of the last analysis (so an unchanged scan can
 * reuse the last outputs). Nothing in it is a path, a source key or a timestamp of the run itself: scanning twice
 * with nothing changed leaves it byte-identical.
 *
 * A missing or damaged manifest is rebuilt from the shards' own headers (every shard is self-describing), so a
 * damaged index never loses history.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../types.js";
import { readOwnJson, writeIfChanged } from "./atomic.js";
import type { HomePaths } from "./home.js";
import { readShard, shardDigest } from "./shard.js";
import { sortKeys } from "./versions.js";

export const MANIFEST_SCHEMA = "wasitme.history/1";

export interface SourceEntry {
  agent: AgentId;
  /** Own-files fingerprint of the stored shard. */
  fp: string;
  /** Dependency fingerprint last seen (null: none). */
  dep: string | null;
  /** Salted digests of the dependencies present when last decided (fingerprint.ts dependencyParts); null: unknown. */
  deps: string[] | null;
  /** Salted ids of the other sources its parse actually used (re-parse when one of them changes). */
  uses: string[];
  /** Digest of the shard's bytes (any change to the stored history changes the analysis inputs). */
  h: string;
  pv: Record<string, number>;
  /** Listed by its reader in the latest scan (false: the source log is gone; its shard is history). */
  present: boolean;
  born: number;
  /** Exchanges in the shard, and its first/last local day (for health and the parser_changed pause). */
  n: number;
  first: string | null;
  last: string | null;
  /**
   * Earliest timestamp (epoch ms) its last parse rejected as later than that parse's now + 1 day (ParseStats.futureMin),
   * or null. The parse's clock is an input of the shard: once the scan's clock reaches this, the unchanged source is
   * re-parsed (a scan run while the clock was set backward must not lose those records for good).
   */
  fut: number | null;
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  tz: string | null;
  sources: Record<string, SourceEntry>;
  /** Digest of everything the last written outputs were computed from (null: none written yet). */
  inputs: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SID_RE = /^src-[0-9a-f]{24}$/;
const DEP_RE = /^[0-9a-f]{20}$/;

export function emptyManifest(): Manifest {
  return { schema: MANIFEST_SCHEMA, tz: null, sources: {}, inputs: null };
}

function validEntry(v: unknown): v is SourceEntry {
  return isObj(v) && (v.agent === "claude-code" || v.agent === "codex") && typeof v.fp === "string" && isObj(v.pv)
    && typeof v.present === "boolean" && typeof v.born === "number" && typeof v.n === "number";
}

/** Load the manifest; rebuild it from shard headers when missing or damaged. */
export function loadManifest(p: HomePaths): { manifest: Manifest; rebuilt: boolean } {
  const v = readOwnJson(p.index, 64 << 20);
  if (isObj(v) && v.schema === MANIFEST_SCHEMA && isObj(v.sources)) {
    const m = emptyManifest();
    m.tz = typeof v.tz === "string" ? v.tz : null;
    m.inputs = typeof v.inputs === "string" ? v.inputs : null;
    for (const [sid, e] of Object.entries(v.sources)) {
      if (SID_RE.test(sid) && validEntry(e)) m.sources[sid] = { ...e, h: typeof e.h === "string" ? e.h : "", dep: typeof e.dep === "string" ? e.dep : null, uses: Array.isArray(e.uses) ? e.uses.filter((u): u is string => typeof u === "string" && SID_RE.test(u)) : [], first: e.first ?? null, last: e.last ?? null, fut: typeof e.fut === "number" && Number.isFinite(e.fut) ? e.fut : null, deps: Array.isArray(e.deps) && e.deps.every((d) => typeof d === "string" && DEP_RE.test(d)) ? (e.deps as string[]) : null };
    }
    return { manifest: m, rebuilt: false };
  }
  return { manifest: rebuildFromShards(p), rebuilt: true };
}

function rebuildFromShards(p: HomePaths): Manifest {
  const m = emptyManifest();
  let names: string[] = [];
  try { names = readdirSync(p.shards); } catch { return m; }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const sid = name.slice(0, -5);
    if (!SID_RE.test(sid)) continue;
    const s = readShard(join(p.shards, name), { sid });
    if (!s) continue;
    const days = s.exchanges.map((x) => x.day).sort();
    // present: true = "was on disk at the last scan" (unknown after a rebuild; assuming it makes a source that is
    // gone now count as a deletion, so its dependents keep their shards instead of re-parsing without it).
    m.sources[sid] = { agent: s.agent, fp: s.fp, h: shardDigest(s), dep: s.dep, uses: s.uses, pv: s.pv, present: true, born: s.born, n: s.exchanges.length, first: days[0] ?? null, last: days[days.length - 1] ?? null, fut: s.stats.futureMin ?? null, deps: null };
    m.tz ??= s.tz;
  }
  return m;
}

export function serializeManifest(m: Manifest): string {
  const sources: Record<string, unknown> = {};
  for (const sid of Object.keys(m.sources).sort()) {
    const e = m.sources[sid]!;
    sources[sid] = { agent: e.agent, fp: e.fp, h: e.h, dep: e.dep, uses: e.uses, pv: sortKeys(e.pv), present: e.present, born: e.born, n: e.n, first: e.first, last: e.last, fut: e.fut, deps: e.deps };
  }
  return `${JSON.stringify({ schema: m.schema, tz: m.tz, inputs: m.inputs, sources })}\n`;
}

export function saveManifest(p: HomePaths, m: Manifest): boolean {
  return writeIfChanged(p.index, serializeManifest(m));
}
