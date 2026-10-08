/**
 * Fork replay. A fork with neither `history_base` nor `subagent_history_start_ordinal` (legacy forks) copies
 * its parent's history into its own file after its own session_meta. Those copied records must not count
 * again. When the parent's file is in the index, the fork's leading records that repeat the parent's records
 * in order are skipped (`PrefixReplay`); otherwise the old heuristic applies (`MarkerReplay`: skip until the
 * first turn marker) and the reader records `codex:fork-unresolved` so the guess is visible in doctor.
 *
 * Record identity is (envelope type, payload type, payload digest). The envelope timestamp and ordinal are
 * left out: whether Codex re-stamps a copy is unverified (no legacy fork has been seen on real logs), and
 * timestamps cannot be trusted to be ordered anyway.
 */
import { createHash } from "node:crypto";
import { emptyStats } from "../../types.js";
import { obj, readJsonl } from "../../util.js";
import { ENVELOPES } from "./known.js";
import type { ThreadIndex } from "./threads.js";

export type Sig = string;

/** Identity of a record for copy detection. Same function on the fork and the parent side. */
export function recordSig(env: string, payload: unknown): Sig {
  const p = obj(payload);
  const sub = typeof p?.type === "string" ? p.type : "";
  return `${env}|${sub}|${createHash("sha256").update(JSON.stringify(payload ?? null)).digest("base64").slice(0, 22)}`;
}

/**
 * Records that take part in matching: known envelopes except session_meta (a copied parent session_meta is
 * recognised by its foreign id instead, and a fork may or may not copy it).
 */
export const matchable = (env: string): boolean => ENVELOPES.has(env) && env !== "session_meta";

/**
 * Legacy turn markers. They carry no turn id, so their payloads repeat from turn to turn whenever the
 * settings did not change.
 */
export const isMarker = (env: string, sub: string): boolean =>
  env === "turn_context" || (env === "event_msg" && (sub === "task_started" || sub === "turn_started"));

/** Signatures of a rollout's matchable records, in file order. Parse problems are not counted here. */
export async function prefixOf(path: string): Promise<Sig[]> {
  const out: Sig[] = [];
  for await (const d of readJsonl(path, emptyStats())) {
    const env = typeof d.type === "string" ? d.type : "";
    if (matchable(env)) out.push(recordSig(env, d.payload));
  }
  return out;
}

/** Parent prefix for a fork, or undefined when the parent thread has no readable file in the index. */
export async function parentPrefix(index: ThreadIndex, forkedFrom: string): Promise<Sig[] | undefined> {
  const path = index.pages.get(forkedFrom)?.[0];
  if (!path) return undefined;
  try { return await prefixOf(path); } catch { return undefined; }
}

export interface Offer<T> {
  /** Records to process normally, in file order. */
  process: T[];
  /** Records now known to be copies (count as duplicates; may still update cumulative baselines). */
  copied: T[];
}

export interface Replay<T> {
  readonly done: boolean;
  offer(sig: Sig, marker: boolean, rec: T): Offer<T>;
  /** End of file: records still held back, to process normally. */
  flush(): T[];
}

/**
 * Skip the fork's leading records that repeat the parent's records in order; stop at the first mismatch.
 * Matched markers are held back and only counted as copies once a following non-marker record also
 * matches — otherwise the fork's own first task_started / turn_context (identical to the parent's next
 * ones when the settings did not change) would be swallowed and its first exchange would lose its model,
 * effort and approval mode. On a mismatch the held markers are processed normally.
 */
export class PrefixReplay<T> implements Replay<T> {
  private at = 0;
  private held: T[] = [];
  done = false;

  constructor(private readonly prefix: readonly Sig[]) {}

  offer(sig: Sig, marker: boolean, rec: T): Offer<T> {
    if (this.done) return { process: [rec], copied: [] };
    if (this.at < this.prefix.length && this.prefix[this.at] === sig) {
      this.at++;
      if (marker) { this.held.push(rec); return { process: [], copied: [] }; }
      const copied = [...this.held, rec];
      this.held = [];
      return { process: [], copied };
    }
    this.done = true;
    const process = [...this.held, rec];
    this.held = [];
    return { process, copied: [] };
  }

  flush(): T[] {
    this.done = true;
    const out = this.held;
    this.held = [];
    return out;
  }
}

/** Fallback when the parent file is missing: skip everything before the first turn marker (heuristic). */
export class MarkerReplay<T> implements Replay<T> {
  done = false;

  offer(_sig: Sig, marker: boolean, rec: T): Offer<T> {
    if (this.done) return { process: [rec], copied: [] };
    if (!marker) return { process: [], copied: [rec] };
    this.done = true;
    return { process: [rec], copied: [] };
  }

  flush(): T[] { this.done = true; return []; }
}
