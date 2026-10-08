import { num, obj } from "../../util.js";

/** Anything that accumulates token usage (a main-thread exchange or a subagent file). */
export interface TokenSink {
  inTok: number;
  outTok: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Group<T extends TokenSink> {
  owner: T;
  inTok: number;
  outTok: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Merges the lines of one streamed model response (same merge key) into a single step.
 * Usage is repeated on every line and output_tokens grows on later lines, so each field keeps its
 * MAXIMUM — never the first line (ccusage #888) and never the sum. Tokens are credited to the sink
 * that owned the response's first line, even if later lines arrive after other records.
 */
export class StepMerger<T extends TokenSink> {
  private groups = new Map<string, Group<T>>();

  /** True if a line with this merge key was already observed. */
  has(key: string): boolean {
    return this.groups.has(key);
  }

  /** Returns true if this line starts a new step, false if it was merged into an earlier one. */
  observe(key: string, usage: unknown, owner: T): boolean {
    let g = this.groups.get(key);
    const isNew = !g;
    if (!g) {
      g = { owner, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 };
      this.groups.set(key, g);
    }
    const u = obj(usage);
    if (u) {
      raise(g, "inTok", num(u.input_tokens));
      raise(g, "outTok", num(u.output_tokens));
      raise(g, "cacheRead", num(u.cache_read_input_tokens));
      raise(g, "cacheWrite", num(u.cache_creation_input_tokens));
    }
    return isNew;
  }
}

function raise<T extends TokenSink>(g: Group<T>, field: keyof TokenSink, value: number): void {
  if (value > g[field]) {
    g.owner[field] += value - g[field];
    g[field] = value;
  }
}
