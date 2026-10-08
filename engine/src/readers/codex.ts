/**
 * Codex reader: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (+ archived_sessions/).
 *
 * One Source per rollout file, keyed by basename (stable when Codex archives a file). Parsing:
 *   rollout.ts  — one pass → turns, with exactly one source per signal for each turn's history mode
 *   segment.ts  — turns → exchanges (one per real human prompt)
 *   session.ts  — entrypoint label and interactive/scripted class from the session's own session_meta
 *   events.ts   — model / effort / approval / version / instructions / provider changes (main threads only)
 *   link.ts     — subagent threads folded into the spawning exchange's sub* fields (on evidence only)
 *   fork.ts     — copied parent history in legacy forks is skipped
 *   version.ts  — per-family parser versions (CODEX_PARSER_VERSIONS) for re-derivation
 *
 * Cross-file decisions (is this a linked subagent? which page attributes which child? what did a fork
 * copy? did the provider switch since the previous session?) all read one ThreadIndex per scan: built on the
 * first parse() (or depKeys()) after list(), shared by the rest. depKeys() records, per rollout, a digest of
 * exactly those cross-file inputs (D39), so the store's cache re-parses a file when one of them changes.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { FileStamp, ParseContext, ParseResult, Reader, Source } from "../types.js";
import { emptyStats } from "../types.js";
import { changeEvents, emitsEvents, providerEvent } from "./codex/events.js";
import { parentPrefix } from "./codex/fork.js";
import { attributeDescendants } from "./codex/link.js";
import { parseRollout, type RolloutOptions } from "./codex/rollout.js";
import { segment } from "./codex/segment.js";
import { rolloutFiles, rootOf, ScanIndex, type ThreadIndex } from "./codex/threads.js";
import { identity, stamp } from "./fs.js";

export { CODEX_FIELD_FAMILY, CODEX_PARSER_VERSIONS, type CodexParserFamily } from "./codex/version.js";

/** Same bound as link.ts: descendants deeper than this are never read by a parse. */
const DEP_DEPTH = 8;

/**
 * Everything outside `path` that parse(path) reads through the index: whether its parent thread has a file (a
 * linked subagent reports nothing), the fork parent's first page (copied-prefix detection), the thread's other
 * pages and every descendant page (subagent attribution), and the provider switch decided from other sessions'
 * heads. Memory only: it hashes paths and raw provider names; the store keeps only a salted fingerprint of it.
 * `key` is that digest; `present` lists the dependencies that exist now (Source.depParts), one part each.
 */
export function codexDeps(
  index: ThreadIndex, path: string, stampOf: (p: string) => FileStamp | undefined, idOf: (p: string) => string | undefined = () => "",
): { key: string | undefined; present: string[] } {
  const parts: string[] = [];
  const present: string[] = [];
  // Each dependency by its stamp AND its strong identity (inode, ctime: idOf), as the store fingerprints a source's own
  // files, so a dependency rewritten in place at the same size with its mtime restored, or replaced by rename, moves it.
  const at = (tag: string, p: string | undefined): void => {
    const st = p === undefined ? undefined : stampOf(p);
    const part = st ? `${tag}\t${p}\t${st.mtimeMs}\t${st.size}\t${idOf(p!) ?? "-"}` : `${tag}\t${p ?? "-"}\t-`;
    parts.push(part);
    if (st) present.push(part);
  };
  const meta = index.meta.get(path) ?? {};
  if (meta.parentThreadId) at("link", index.pages.get(meta.parentThreadId)?.[0]);
  if (meta.forkedFrom) at("fork", index.pages.get(meta.forkedFrom)?.[0]);
  if (meta.threadId) {
    for (const p of index.pages.get(meta.threadId) ?? []) if (p !== path) at("page", p);
    const seen = new Set([meta.threadId]);
    let frontier = [meta.threadId];
    for (let depth = 0; depth < DEP_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const child of index.children.get(id) ?? []) {
          at("child", child);
          const cid = index.meta.get(child)?.threadId;
          if (cid && !seen.has(cid)) { seen.add(cid); next.push(cid); }
        }
      }
      frontier = next;
    }
  }
  const sw = index.providerSwitch.get(path);
  if (sw) {
    const part = `provider\t${sw.from}\t${sw.to}\t${sw.ts}`;
    parts.push(part);
    present.push(part);
  }
  return { key: parts.length ? createHash("sha256").update(parts.join("\n")).digest("hex") : undefined, present };
}

/** WASITME_CODEX_DIR ?? CODEX_HOME ?? ~/.codex — read at call time so tests can point it elsewhere. */
export function codexRoot(): string {
  return process.env.WASITME_CODEX_DIR || process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** The current scan's thread index (exported for tests: `builds` counts index builds). */
export const codexScanIndex = new ScanIndex();

export const codexReader: Reader = {
  agent: "codex",
  root: () => codexRoot(),

  list(): Source[] {
    codexScanIndex.reset(); // a new scan: the next parse() builds a fresh index
    const out: Source[] = [];
    for (const path of rolloutFiles(codexRoot())) {
      const st = stamp(path);
      if (st) out.push({ agent: "codex", key: `codex:${basename(path)}`, files: [st] });
    }
    return out;
  },

  depKeys(sources: Source[]): void {
    const stamps = new Map<string, FileStamp>();
    for (const s of sources) for (const f of s.files) stamps.set(f.path, f);
    const stampOf = (p: string): FileStamp | undefined => stamps.get(p) ?? stamp(p);
    for (const s of sources) {
      const file = s.files[0];
      if (!file) continue;
      const dep = codexDeps(codexScanIndex.get(rootOf(file.path) ?? codexRoot()), file.path, stampOf, identity);
      if (dep.key === undefined) {
        delete s.depKey;
        delete s.depParts;
      } else {
        s.depKey = dep.key;
        s.depParts = dep.present;
      }
    }
  },

  async parse(source: Source, ctx: ParseContext): Promise<ParseResult> {
    const stats = emptyStats();
    const file = source.files[0];
    if (!file) return { exchanges: [], events: [], stats };
    stats.files = 1;
    const index = codexScanIndex.get(rootOf(file.path) ?? codexRoot());
    const opts: RolloutOptions = {
      now: ctx.now,
      shortHash: (v) => ctx.hash(v, "h:").slice(0, 10),
      forkPrefix: (forkedFrom) => parentPrefix(index, forkedFrom),
    };

    let thread;
    try {
      thread = await parseRollout(file.path, stats, opts);
    } catch {
      stats.filesFailed = 1;
      return { exchanges: [], events: [], stats };
    }

    // Linked or not is decided from the index's view of this file (the same view the parent's attribution
    // uses), never from the full parse: they differ when a leading line is torn.
    const meta = index.meta.get(file.path) ?? {};
    const parentPath = meta.parentThreadId ? index.pages.get(meta.parentThreadId)?.[0] : undefined;
    if (parentPath && parentPath !== file.path) {
      // Linked subagent: its work is reported on the parent's exchanges (see link.ts).
      return { exchanges: [], events: [], stats };
    }

    const seg = segment(thread, {
      hash: ctx.hash,
      timeZone: ctx.timeZone,
      sourceKey: source.key,
      session: ctx.hash(thread.threadId ?? basename(file.path), "s-"),
      project: ctx.hash(thread.cwd ?? "unknown", "p-"),
    });
    stats.duplicates += seg.duplicates;
    await attributeDescendants(meta.threadId, thread, file.path, index, seg, opts, stats);
    const ectx = { hash: ctx.hash, timeZone: ctx.timeZone };
    const events = changeEvents(thread, ectx);
    // A provider switch since the previous session (no Exchange label carries it). Decided from the index's view
    // of both files, like linking, so every scan emits it exactly once: on the later session.
    const sw = index.providerSwitch.get(file.path);
    if (sw && emitsEvents(thread)) events.unshift(providerEvent(ectx, opts.shortHash(sw.from), opts.shortHash(sw.to), sw.ts));
    return { exchanges: seg.exchanges, events, stats, origins: seg.origins };
  },
};
