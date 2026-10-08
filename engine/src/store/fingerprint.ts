/**
 * Source fingerprints (scan.ts steps 2-3).
 *
 * A source is re-parsed IN FULL whenever its fingerprint moves; the readers are not resumable, so the store never
 * continues from an old byte offset — a file that shrank, was truncated and rewritten in place (Claude Code ≤ 2.1.287
 * could do that during concurrent rewrites, research/08), or was replaced by another file is simply read again.
 * The fingerprint is a salted HMAC (never a plain hash: its input contains source keys, i.e. encoded project paths)
 * over, per file in order:
 *   device, inode   — a replaced file (rename over, restore from backup) is a different inode;
 *   size            — an append or a truncation;
 *   mtime (ns)      — any write;
 *   ctime (ns)      — any write or metadata change, and it cannot be set from user space: a rewrite that restores
 *                     the old mtime with utimes() still moves ctime (checked on APFS: a plain read moves neither);
 * plus the reader's `depKey` (D39: the files outside the source that its parse reads). Parser versions are kept next
 * to the fingerprint (manifest `pv`), so a version bump re-derives without being mistaken for a content change.
 */
import { createHmac } from "node:crypto";
import { statSync } from "node:fs";
import type { AgentId, Source } from "../types.js";

export interface FileId {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  /** Creation time in ms where the filesystem records it, else mtime (ms). */
  bornMs: number;
}

/** stat(2) of one listed file (bigint, so nanosecond times compare exactly), or undefined if it vanished. */
export function statId(path: string): FileId | undefined {
  try {
    const st = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!st || !st.isFile()) return undefined;
    const born = Number(st.birthtimeMs) > 0 ? Number(st.birthtimeMs) : Number(st.mtimeMs);
    return { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, bornMs: Math.round(born) };
  } catch {
    return undefined;
  }
}

/** Salted keyed digest (hex, 128 bits) for store-internal identities. */
export function keyed(salt: string, value: string): string {
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 32);
}

/** Salted id of a source: `src-` + 24 hex. The raw key (an encoded project path) is never stored. */
export function sourceId(salt: string, agent: AgentId, key: string): string {
  return `src-${keyed(salt, `source|${agent}|${key}`).slice(0, 24)}`;
}

/** Fingerprint of the source's OWN files. */
export function sourceFingerprint(salt: string, source: Source, ids: readonly (FileId | undefined)[]): string {
  const files = ids.map((id, i) => (id ? `${i}:${id.dev}:${id.ino}:${id.size}:${id.mtimeNs}:${id.ctimeNs}` : `${i}:gone`));
  return keyed(salt, `fp/1|${source.agent}|${source.key}|${files.join("|")}`);
}

/**
 * Fingerprint of the source's dependencies (the reader's depKey, D39), kept apart from `fp` so the store can tell
 * "my files changed" from "a file I depend on changed or disappeared" (scan.ts decides which re-parses). null: none.
 */
export function dependencyFingerprint(salt: string, source: Source): string | null {
  return source.depKey === undefined ? null : keyed(salt, `dep/1|${source.agent}|${source.key}|${source.depKey}`);
}

/**
 * Salted digests of the dependencies that exist now (Source.depParts), sorted and unique; null when the reader gives
 * none. The store re-parses a source when one of them is not among those of its last decision: a dependency changed
 * or appeared. One that only disappeared is simply missing from the new set.
 */
export function dependencyParts(salt: string, source: Source): string[] | null {
  if (source.depParts === undefined) return null;
  return [...new Set(source.depParts.map((part) => keyed(salt, `dep-part/1|${source.agent}|${part}`).slice(0, 20)))].sort();
}
