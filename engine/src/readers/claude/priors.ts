/**
 * Resume dedupe: was a record already logged by a session created earlier in the same project?
 *
 * A resumed session re-logs earlier records (same uuids) into a new file. One index per project
 * maps each uuid to the creation rank of the earliest file holding it, so a record in the file of
 * rank r is a replay iff first(uuid) < r — an O(1) check however many sessions the project has.
 *
 * The index is a pure per-process cache:
 *  - list() hands it the project's creation-ordered listing; parse() re-lists by stat only when the
 *    session is missing from it (e.g. parse without list in this process).
 *  - Files are loaded lazily in rank order, only as far as the session being parsed needs. Each
 *    file's uuids are kept, keyed by (mtime, size), so a re-listing re-reads only changed files, and a
 *    session that was just parsed hands its uuids over instead of being read again.
 *  - A re-listing keeps the loaded prefix that did not change. A view handed to a running parse
 *    stays consistent: later loads only add ranks it ignores, and truncation copies, never mutates.
 *  - Loads are serialised per project, so concurrent parses never interleave a load.
 *  - Bounded by total cached uuids across projects, least recently used project out. The project
 *    in use is never evicted: a session's dedupe needs every one of its priors.
 *  - Persisted when the store backs it (ParseContext.priorCache, WP-12 review): a file's complete id list is saved
 *    once read, and a fresh process (every hook and LaunchAgent scan is one) loads it instead of re-reading the log,
 *    so re-parsing one changed session costs what changed, not every earlier session of its project. The index then
 *    holds salted ids instead of uuids; it is reset whenever the id space (salt) changes.
 */
import { dirname } from "node:path";
import type { FileStamp, PriorCache } from "../../types.js";
import { readJsonl } from "../../util.js";
import { projectMains } from "./project.js";

/** Membership test for one session: was this uuid logged by a session created before it? */
export interface Priors {
  has(uuid: string): boolean;
  /** The id the index keys a uuid by (a salted digest when the store backs the index, else the uuid). */
  id(uuid: string): string;
  /** `has`, for an id from `id()`. */
  hasId(id: string): boolean;
  /**
   * The prior files (paths, creation order) that `has` has matched so far: the sessions this one actually replays.
   * Each match is credited to the EARLIEST file holding the uuid. Reported to the store (ParseResult.deps) so a
   * session is re-parsed when a session it replays changes — and not when an unrelated earlier session does.
   */
  matched(): string[];
}

/** Current id space: raw uuids unless the store backs the index (usePriorCache). */
let space = "raw";
let idOf: (uuid: string) => string = (u) => u;
let backing: PriorCache | undefined;

export const NO_PRIORS: Priors = { has: () => false, id: (u) => idOf(u), hasId: () => false, matched: () => [] };

const MAX_UUIDS = 1_000_000;
const MAX_PROJECTS = 4096;

interface Known { mtimeMs: number; size: number; uuids: readonly string[] }

interface State {
  readonly order: readonly FileStamp[];
  readonly rank: ReadonlyMap<string, number>;
  /** uuid → rank of the earliest loaded file holding it. */
  readonly first: Map<string, number>;
  /** Files order[0..loaded) are in `first`. */
  loaded: number;
}

function makeState(order: readonly FileStamp[], first: Map<string, number>, loaded: number): State {
  return { order, rank: new Map(order.map((f, i) => [f.path, i])), first, loaded };
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean => a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;

let cachedUuids = 0;
let diskReads = 0;
const indexes = new Map<string, ProjectIndex>();

class ProjectIndex {
  state: State = makeState([], new Map(), 0);
  private readonly known = new Map<string, Known>();
  private uuidCount = 0;
  private evicted = false;
  private queue: Promise<unknown> = Promise.resolve();

  /** Forget every loaded id (the id space changed); the listing is kept. */
  resetIds(): void {
    cachedUuids -= this.uuidCount;
    this.uuidCount = 0;
    this.known.clear();
    this.state = makeState(this.state.order, new Map(), 0);
  }

  /** Adopt a fresh listing (creation order), keeping whatever loaded prefix is unchanged. */
  setOrder(order: readonly FileStamp[]): void {
    const old = this.state;
    if (old.order.length === order.length && order.every((f, i) => sameStamp(f, old.order[i]!))) return;
    let keep = 0;
    while (keep < old.loaded && keep < order.length && sameStamp(old.order[keep]!, order[keep]!)) keep++;
    const first = keep === old.loaded ? old.first : prefixOf(old.first, keep);
    this.state = makeState(order, first, keep);
    for (const path of [...this.known.keys()]) if (!this.state.rank.has(path)) this.forget(path);
  }

  /** Dedupe view for the session at `path`: loads its priors first (serialised per project). */
  view(path: string): Promise<Priors> {
    const run = async (): Promise<Priors> => {
      for (;;) {
        const s = this.state;
        const r = s.rank.get(path);
        if (r === undefined || r === 0) return NO_PRIORS;
        while (s.loaded < r && this.state === s) {
          const i = s.loaded;
          const uuids = await this.uuidsOf(s.order[i]!);
          if (this.state !== s) break; // re-listed meanwhile: start over on the new listing
          for (const u of uuids) if (!s.first.has(u)) s.first.set(u, i);
          s.loaded = i + 1;
        }
        if (this.state !== s) continue;
        const first = s.first;
        const order = s.order;
        const hits = new Set<number>();
        const idf = idOf; // the space `first` was filled in (a space change replaces the state, not this map)
        const hasId = (id: string): boolean => {
          const f = first.get(id);
          if (f === undefined || f >= r) return false;
          hits.add(f);
          return true;
        };
        return {
          has: (uuid) => hasId(idf(uuid)),
          id: idf,
          hasId,
          matched: () => [...hits].sort((a, b) => a - b).map((i) => order[i]!.path),
        };
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Remember the complete id list of a file at the given stamp (and persist it when the store backs the index). */
  remember(f: FileStamp, uuids: readonly string[], persist = true): void {
    if (persist && backing) {
      try { backing.save(f, uuids); } catch { /* the cache is an optimisation */ }
    }
    if (this.evicted) return;
    this.forget(f.path);
    this.known.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, uuids });
    this.uuidCount += uuids.length;
    cachedUuids += uuids.length;
  }

  evict(): void {
    cachedUuids -= this.uuidCount;
    this.uuidCount = 0;
    this.known.clear();
    this.evicted = true;
  }

  private forget(path: string): void {
    const k = this.known.get(path);
    if (!k) return;
    this.known.delete(path);
    this.uuidCount -= k.uuids.length;
    cachedUuids -= k.uuids.length;
  }

  /** Ids of every record in `f`. An unreadable file yields what was read (nothing to dedupe against). */
  private async uuidsOf(f: FileStamp): Promise<readonly string[]> {
    const hit = this.known.get(f.path);
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) return hit.uuids;
    let stored: readonly string[] | undefined;
    try { stored = backing?.load(f); } catch { stored = undefined; }
    if (stored) {
      this.remember(f, stored, false);
      evict();
      return stored;
    }
    const idf = idOf;
    const uuids: string[] = [];
    diskReads++;
    try {
      // Throwaway stats: a prior's bad lines are reported when that session itself is parsed.
      for await (const d of readJsonl(f.path, { badLines: 0, truncatedTail: 0 })) {
        if (typeof d.uuid === "string") uuids.push(idf(d.uuid));
      }
    } catch {
      return uuids;
    }
    if (idf === idOf) {
      this.remember(f, uuids);
      evict();
    }
    return uuids;
  }
}

function prefixOf(first: ReadonlyMap<string, number>, keep: number): Map<string, number> {
  const out = new Map<string, number>();
  if (keep > 0) for (const [u, r] of first) if (r < keep) out.set(u, r);
  return out;
}

/** The project's index, marked most recently used. */
function indexFor(projectDir: string): ProjectIndex {
  let idx = indexes.get(projectDir);
  if (idx) indexes.delete(projectDir);
  else idx = new ProjectIndex();
  indexes.set(projectDir, idx);
  return idx;
}

/** Evict least recently used projects while over budget; the most recently used one always stays. */
function evict(): void {
  while (indexes.size > 1 && (indexes.size > MAX_PROJECTS || cachedUuids > MAX_UUIDS)) {
    const oldest = indexes.keys().next().value;
    if (oldest === undefined) break;
    indexes.get(oldest)?.evict();
    indexes.delete(oldest);
  }
}

/** Called by list(): the project's main transcripts in creation order. */
export function rememberListing(projectDir: string, order: readonly FileStamp[]): void {
  indexFor(projectDir).setOrder(order);
  evict();
}

/** Dedupe view for one session's main transcript, against every session created before it. */
export async function priorsFor(main: FileStamp): Promise<Priors> {
  const dir = dirname(main.path);
  const idx = indexFor(dir);
  if (!idx.state.rank.has(main.path)) idx.setOrder(projectMains(dir).map((m) => m.stamp));
  evict();
  return idx.view(main.path);
}

/** Hand over the complete id set (Priors.id of each record uuid) of a session file that was just read in full. */
export function rememberUuids(f: FileStamp, uuids: Iterable<string>): void {
  indexFor(dirname(f.path)).remember(f, [...uuids]);
  evict();
}

/**
 * Back the index with the store's cache for the parses that follow (undefined: memory only, raw uuids). A different
 * id space (another salt) forgets every loaded id first: ids from two spaces never meet in one index.
 */
export function usePriorCache(c: PriorCache | undefined): void {
  const next = c?.space ?? "raw";
  if (next !== space) for (const idx of indexes.values()) idx.resetIds();
  space = next;
  idOf = c ? (u) => c.id(u) : (u) => u;
  backing = c;
}

/** Test hook: forget all cached listings and uuids, the store backing, and reset the read counter (a fresh process). */
export function clearPriorCache(): void {
  for (const idx of indexes.values()) idx.evict();
  indexes.clear();
  cachedUuids = 0;
  diskReads = 0;
  space = "raw";
  idOf = (u) => u;
  backing = undefined;
}

/** Test hook: prior files read from disk since the last clearPriorCache(). */
export function priorDiskReads(): number {
  return diskReads;
}
