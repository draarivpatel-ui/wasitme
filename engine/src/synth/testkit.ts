/**
 * Helpers for tests (and for other work packages' tests) that need synthetic corpora on disk and a
 * small, honest statistics toolkit: a seeded session-cluster bootstrap for before/after ratios.
 * Nothing here is used by the generator itself.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, type Generated, type TruthDoc } from "./generate.js";
import { Rng } from "./rng.js";
import { findScenario, type ScenarioOptions } from "./scenarios.js";
import { countCorpus, type RefExchange } from "./verify.js";
import { writeTree } from "./write.js";
import type { TruthExchange } from "./truth.js";

export interface Corpus {
  dir: string;
  generated: Generated;
  truth: TruthDoc;
  rows: TruthExchange[];
  cleanup(): void;
}

/** Generate a named scenario into a fresh temp directory. */
export function corpusOnDisk(name: string, opts: ScenarioOptions = {}): Corpus {
  const sc = findScenario(name);
  if (!sc) throw new Error(`unknown scenario ${name}`);
  const generated = generate(sc.build(opts), sc.name);
  const dir = mkdtempSync(join(tmpdir(), `wasitme-synth-${name}-`));
  writeTree(join(dir, "out"), generated.files);
  const root = join(dir, "out");
  return {
    dir: root, generated, truth: generated.truth, rows: generated.rows,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function referenceRows(dir: string): Promise<RefExchange[]> {
  return countCorpus(dir);
}

// ----------------------------------------------------------------------------- statistics

export interface RatioEstimate {
  before: number;
  after: number;
  ratio: number;
  /** Bootstrap interval of the ratio (resampling whole sessions). */
  lo: number;
  hi: number;
  /** Bootstrap standard error of log(ratio). */
  se: number;
  denBefore: number;
  denAfter: number;
}

export type Assign = (day: string) => "before" | "after" | null;

/** "before" = days < splitDay, "after" = days >= splitDay. */
export function splitAssign(splitDay: string): Assign {
  return (day) => (day < splitDay ? "before" : "after");
}

/** "before" = days in [from, split), "after" = days in [split, to); everything else is ignored. */
export function rangeAssign(from: string, split: string, to: string): Assign {
  return (day) => (day >= from && day < split ? "before" : day >= split && day < to ? "after" : null);
}

/** For each boundary day: `width` days before it vs `width` days from it, pooled across boundaries. */
export function windowAssign(boundaries: string[], width: number): Assign {
  const ms = (s: string): number => Date.parse(s + "T00:00:00Z");
  const bs = boundaries.map(ms);
  return (day) => {
    const t = ms(day);
    let side: "before" | "after" | null = null;
    for (const b of bs) {
      const dt = (t - b) / 86_400_000;
      if (dt >= 0 && dt < width) side = "after";
      else if (dt < 0 && dt >= -width && side === null) side = "before";
    }
    return side;
  };
}

/**
 * Ratio of pooled rates after/before with a CLUSTER bootstrap interval: whole sessions are resampled,
 * because exchanges within a session share a random effect (this is what makes few-long users hard,
 * and a day-level bootstrap would understate it). Seeded, so tests are deterministic.
 */
export function clusterRatio<T extends { day: string; session: string }>(
  rows: T[], f: (r: T) => [number, number], assign: Assign, level = 0.99, reps = 800, seed = 11,
): RatioEstimate {
  const byCluster = new Map<string, { nb: number; db: number; na: number; da: number }>();
  for (const r of rows) {
    const side = assign(r.day);
    if (!side) continue;
    const [n, d] = f(r);
    const c = byCluster.get(r.session) ?? { nb: 0, db: 0, na: 0, da: 0 };
    if (side === "before") { c.nb += n; c.db += d; } else { c.na += n; c.da += d; }
    byCluster.set(r.session, c);
  }
  const cs = [...byCluster.values()];
  const tot = (xs: typeof cs): { nb: number; db: number; na: number; da: number } =>
    xs.reduce((a, c) => ({ nb: a.nb + c.nb, db: a.db + c.db, na: a.na + c.na, da: a.da + c.da }), { nb: 0, db: 0, na: 0, da: 0 });
  const t0 = tot(cs);
  const rng = new Rng(seed, "cluster-bootstrap");
  const draws: number[] = [];
  for (let i = 0; i < reps && cs.length; i++) {
    const t = tot(Array.from({ length: cs.length }, () => cs[rng.int(0, cs.length - 1)]!));
    const r = (t.na / t.da) / (t.nb / t.db);
    if (Number.isFinite(r)) draws.push(r);
  }
  draws.sort((a, b) => a - b);
  const logs = draws.map((x) => Math.log(x));
  const mean = logs.reduce((a, b) => a + b, 0) / Math.max(1, logs.length);
  const se = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, logs.length - 1));
  const alpha = (1 - level) / 2;
  return {
    se,
    before: t0.nb / t0.db, after: t0.na / t0.da, ratio: t0.na / t0.da / (t0.nb / t0.db),
    lo: draws[Math.floor(alpha * draws.length)] ?? NaN,
    hi: draws[Math.min(draws.length - 1, Math.ceil((1 - alpha) * draws.length) - 1)] ?? NaN,
    denBefore: t0.db, denAfter: t0.da,
  };
}

/** z-score of the realised ratio against a target ratio (1 = "no change"), on the log scale. */
export function zScore(e: RatioEstimate, target = 1): number {
  return (Math.log(e.ratio) - Math.log(target)) / e.se;
}

/** The metrics used by recovery tests: name -> (numerator, denominator) per reference row. */
export const METRICS: Record<string, (r: RefExchange & { thinkSigSum?: number | null }) => [number, number]> = {
  interrupt: (r) => [r.interrupted, 1],
  pushback: (r) => [r.pushback, r.humanPrompt && r.seq > 0 ? 1 : 0],
  toolError: (r) => [r.toolErrors, r.toolCalls],
  blindEdit: (r) => [r.blindEdits, r.edits],
  toolCalls: (r) => [r.toolCalls, 1],
  outTok: (r) => [r.outTok, r.steps],
  thinkDepth: (r) => [r.thinkSigSum ?? 0, r.thinkBlocks ?? 0],
};

export interface TreeEntry { size: number; mtimeMs: number; sha256: string; link?: string }

/** Every file under `dir` (relative path -> size, mtime, content hash); symlinks are listed, not followed. */
export function readTree(dir: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const visit = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = join(dir, r);
      if (e.isSymbolicLink()) out.set(r, { size: 0, mtimeMs: 0, sha256: "", link: readlinkSync(p) });
      else if (e.isDirectory()) visit(r);
      else if (e.isFile()) {
        const st = statSync(p);
        out.set(r, { size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: createHash("sha256").update(readFileSync(p)).digest("hex") });
      }
    }
  };
  visit("");
  return out;
}

/** Pooled rate (sum numerator / sum denominator) over rows. */
export function pooledRate<T>(rows: T[], f: (r: T) => [number, number]): number {
  let n = 0;
  let d = 0;
  for (const r of rows) {
    const [a, b] = f(r);
    n += a;
    d += b;
  }
  return n / d;
}

const COMPARED: (keyof RefExchange)[] = [
  "t", "day", "version", "model", "effort", "mode", "entrypoint", "afterCompaction", "humanPrompt", "promptChars", "interrupted", "pushback",
  "queuedMidTurn", "steps", "toolCalls", "toolErrors", "rejections", "blocked", "reads", "edits", "blindEdits", "churned", "outTok", "inTok",
  "cacheRead", "cacheWrite", "apiErrors", "apiRetries", "compactions", "thinkBlocks", "thinkRedacted", "thinkSigMedian", "thinkSigSum",
  "subToolCalls", "subOutTok", "subInTok", "subCacheRead", "subCacheWrite", "durationMs",
];

/**
 * Compare truth rows with the reference counter's rows field by field. Returns human-readable
 * mismatches (empty = the planted facts are exactly recoverable from the files). Null truth values
 * are "implementation-defined" and skipped; a clock-glitched exchange must come out as duration 0.
 */
export function diffRows(truth: TruthExchange[], ref: RefExchange[]): string[] {
  const key = (r: { session: string; seq: number }): string => `${r.session}#${r.seq}`;
  const refMap = new Map(ref.map((r) => [key(r), r]));
  const truthKeys = new Set(truth.map(key));
  const out: string[] = [];
  for (const t of truth) {
    const r = refMap.get(key(t));
    if (!r) { out.push(`missing from reference: ${key(t)}`); continue; }
    for (const f of COMPARED) {
      const tv = (t as unknown as Record<string, unknown>)[f];
      const rv = r[f];
      if (tv === null || tv === undefined) continue;
      if (f === "durationMs" && t.clockGlitch) { if (rv !== 0) out.push(`${key(t)} glitched duration ${String(rv)} (want 0)`); continue; }
      if (tv !== rv) out.push(`${key(t)} ${f}: truth ${String(tv)} vs counted ${String(rv)}`);
    }
  }
  for (const r of ref) if (!truthKeys.has(key(r))) out.push(`extra in reference: ${key(r)}`);
  return out;
}
