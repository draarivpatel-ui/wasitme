/** Test harness: run the Codex reader over a synthetic tree (never the real ~/.codex). */
import { codexReader } from "../../../src/readers/codex.js";
import type { ChangeEvent, Exchange, ParseResult } from "../../../src/types.js";
import { emptyRoot, mergeStats, testCtx } from "./build.js";

// Guard: from the moment any Codex test imports this harness, the reader points at an empty temp dir.
process.env.WASITME_CODEX_DIR = emptyRoot();
delete process.env.CODEX_HOME;

export interface Scan {
  exchanges: Exchange[];
  events: ChangeEvent[];
  stats: ParseResult["stats"];
  /** Result per thread id (matched against the source key's file name). */
  byThread: Map<string, ParseResult>;
}

/** List + parse every source under `root` with WASITME_CODEX_DIR pointed at it. */
export async function scan(root: string, ids: string[] = []): Promise<Scan> {
  const prev = process.env.WASITME_CODEX_DIR;
  process.env.WASITME_CODEX_DIR = root;
  try {
    const results: ParseResult[] = [];
    const byThread = new Map<string, ParseResult>();
    for (const source of codexReader.list()) {
      const r = await codexReader.parse(source, testCtx());
      results.push(r);
      for (const id of ids) if (source.key.includes(id)) byThread.set(id, r);
    }
    return {
      exchanges: results.flatMap((r) => r.exchanges),
      events: results.flatMap((r) => r.events),
      stats: mergeStats(results.map((r) => r.stats)),
      byThread,
    };
  } finally {
    process.env.WASITME_CODEX_DIR = prev;
  }
}

/** Sum a numeric Exchange field. */
export function sum(xs: Exchange[], k: keyof Exchange): number {
  return xs.reduce((n, x) => n + (typeof x[k] === "number" ? (x[k] as number) : 0), 0);
}
