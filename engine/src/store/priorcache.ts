/**
 * The store's side of the Claude reader's resume-dedupe index (ParseContext.priorCache, WP-12 review). Every hook and
 * LaunchAgent scan is a fresh process, and re-parsing one session needs the record ids of every earlier session of
 * its project; without this, each such scan re-read all of them (cost ∝ the project's history, not the change).
 *
 * Per source: `history/priors/<sid>.json` = { schema, fid, ids } — the salted ids of every record of its main
 * transcript, and a salted digest of the file's identity (device, inode, size, mtime ns, ctime ns: the same identity
 * as the source fingerprint) when they were read. An entry is used only while that identity holds, and saved only when
 * the file still matches the stamp the reader listed (so the ids read are all of it). Contents are salted digests only:
 * never a uuid, a path or text. Not history: entries of sources that are no longer listed are pruned.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileStamp, PriorCache } from "../types.js";
import { readOwnJson, removeQuietly, writeIfChanged } from "./atomic.js";
import { keyed, statId } from "./fingerprint.js";
import { ensureDir } from "./home.js";

export const PRIORS_SCHEMA = "wasitme.priors/1";
const SID_RE = /^src-[0-9a-f]{24}$/;
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const MAX_BYTES = 256 << 20;

function fileId(salt: string, path: string): string | undefined {
  const id = statId(path);
  return id ? keyed(salt, `prior-file|${id.dev}:${id.ino}:${id.size}:${id.mtimeNs}:${id.ctimeNs}`) : undefined;
}

/**
 * A PriorCache over `dir`. `sidOf` maps a listed source's first (main) file path to its salted source id (memory only;
 * filled by the scan's listing before any parse). Ids are 96-bit salted SHA-256 digests of the uuid.
 */
export function storePriorCache(salt: string, dir: string, sidOf: ReadonlyMap<string, string>): PriorCache {
  const base = createHash("sha256").update(`wasitme.prior-id|${salt}|`);
  return {
    space: keyed(salt, "prior-space").slice(0, 16),
    id: (uuid) => base.copy().update(uuid).digest("base64url").slice(0, 16),
    load(f: FileStamp) {
      const sid = sidOf.get(f.path);
      if (!sid) return undefined;
      const v = readOwnJson(join(dir, `${sid}.json`), MAX_BYTES) as { schema?: unknown; fid?: unknown; ids?: unknown } | undefined;
      if (!v || v.schema !== PRIORS_SCHEMA || typeof v.fid !== "string" || !Array.isArray(v.ids)) return undefined;
      if (v.fid !== fileId(salt, f.path)) return undefined;
      const ids = v.ids as unknown[];
      return ids.every((x) => typeof x === "string" && ID_RE.test(x)) ? (ids as string[]) : undefined;
    },
    save(f: FileStamp, ids: readonly string[]) {
      const sid = sidOf.get(f.path);
      if (!sid) return;
      let st;
      try { st = statSync(f.path); } catch { return; }
      if (!st.isFile() || st.size !== f.size || Math.round(st.mtimeMs) !== f.mtimeMs) return; // changed since listed
      const fid = fileId(salt, f.path);
      if (!fid || !ids.every((x) => ID_RE.test(x))) return;
      ensureDir(dir);
      writeIfChanged(join(dir, `${sid}.json`), `${JSON.stringify({ schema: PRIORS_SCHEMA, fid, ids })}\n`, MAX_BYTES, { fsync: false });
    },
  };
}

/** Remove the cached ids of sources that are not listed any more (their files can no longer be anyone's prior). */
export function prunePriorCache(dir: string, present: ReadonlySet<string>): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const sid = n.slice(0, -5);
    if (SID_RE.test(sid) && !present.has(sid)) removeQuietly(join(dir, n));
  }
}
