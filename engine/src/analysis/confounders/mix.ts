/**
 * The "also flagged" workload-mix moves (METHOD.md §8, "Flagged, never decisive"): a prompt-length ratio outside
 * [0.67, 1.5]; a 15 pp move in the share of >100k-context starts; a 20 pp move in mode, entrypoint, subagent mix, or
 * Codex's interactive vs scripted mix.
 *
 * INFORMATIONAL ONLY: these are shown as flags ("your work changed too") and never change a state; they do not
 * feed the `unclear (workload)` condition (only the standardised ratio and the projects rules do).
 *
 * Definitions (per window, over the agent's deduplicated exchanges on complete days in that window):
 *  - prompt length: mean characters per real human prompt of interactive exchanges, recent ÷ baseline; flagged
 *    when the ratio is < 0.67 or > 1.5;
 *  - mode / entrypoint: each label's share of interactive exchanges; the move is the largest |Δ share| over labels;
 *  - subagent: share of interactive exchanges that spawned subagent work (`subToolCalls` > 0);
 *  - subagent work: share of the interactive exchanges' edits made by attributed subagents (`subEdits` over
 *    `edits` + `subEdits`; D62a — the research metrics count both, so a move in delegation is flagged here);
 *  - interactive vs scripted (Codex only): share of exchanges NOT classified interactive (metrics/cells.ts classifier);
 *  - a move of ≥ 20 pp is flagged;
 *  - >100k-context starts: no Exchange field records the context size at an exchange's start, so this is reported
 *    as unavailable ("fields_missing"), never guessed.
 * A window with no exchanges gives no share and no flag.
 */
import type { InteractiveVerdict } from "../metrics/cells.js";
import type { MetricExchange } from "../metrics/defs.js";
import type { DayRange } from "../metrics/windows.js";
import { dayIndex } from "../stats/ratio.js";

export const PROMPT_LENGTH_BAND = Object.freeze({ lo: 0.67, hi: 1.5 });
export const MIX_MOVE = 0.2;
export const CONTEXT_START_MOVE = 0.15;

const EPS = 1e-12;

export interface ShareMove {
  recent: Record<string, number> | null;
  baseline: Record<string, number> | null;
  /** Largest |Δ share| over labels (fraction, 0.2 = 20 pp); null without data in a window. */
  move: number | null;
  flagged: boolean;
}

export interface MixFlags {
  promptLength: { recent: number | null; baseline: number | null; ratio: number | null; flagged: boolean };
  contextStarts: { available: false; reason: "fields_missing"; flagged: false };
  mode: ShareMove;
  entrypoint: ShareMove;
  subagent: ShareMove;
  /** Main-thread vs subagent share of the edits (D62a); no share in a window without edits. */
  subagentWork: ShareMove;
  /** Codex only; null for other agents. */
  interactive: ShareMove | null;
  anyFlagged: boolean;
}

interface WindowTally {
  used: number;
  prompts: number;
  promptChars: number;
  mode: Map<string, number>;
  entrypoint: Map<string, number>;
  subagent: number;
  mainEdits: number;
  subEdits: number;
  all: number;
  nonInteractive: number;
}

const tally = (): WindowTally => ({
  used: 0, prompts: 0, promptChars: 0, mode: new Map(), entrypoint: new Map(), subagent: 0, mainEdits: 0, subEdits: 0, all: 0, nonInteractive: 0,
});

function nn(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Collects window tallies from `buildCells`'s `onExchange` observer. */
export class MixCollector {
  readonly recent = tally();
  readonly baseline = tally();
  constructor(private readonly windows: { recent: DayRange; baseline: DayRange }) {}

  readonly observe = (x: MetricExchange, verdict: InteractiveVerdict): void => {
    const i = dayIndex(x.day);
    if (i === undefined) return;
    const w = i >= this.windows.recent.from && i <= this.windows.recent.to ? this.recent
      : i >= this.windows.baseline.from && i <= this.windows.baseline.to ? this.baseline : null;
    if (w === null) return;
    w.all++;
    if (verdict !== "interactive") {
      w.nonInteractive++;
      return;
    }
    w.used++;
    const mode = String(x.mode), entry = String(x.entrypoint);
    w.mode.set(mode, (w.mode.get(mode) ?? 0) + 1);
    w.entrypoint.set(entry, (w.entrypoint.get(entry) ?? 0) + 1);
    if (nn(x.subToolCalls) > 0) w.subagent++;
    w.mainEdits += nn(x.edits);
    w.subEdits += nn(x.subEdits);
    if (x.humanPrompt === 1) {
      w.prompts++;
      w.promptChars += nn(x.promptChars);
    }
  };
}

function shares(counts: Map<string, number>, total: number): Record<string, number> | null {
  if (!(total > 0)) return null;
  const out: Record<string, number> = {};
  for (const k of [...counts.keys()].sort()) out[k] = counts.get(k)! / total;
  return out;
}

/** Largest |Δ share| over the union of labels; flagged at ≥ `limit`. Pure. */
export function shareMove(recent: Record<string, number> | null, baseline: Record<string, number> | null, limit = MIX_MOVE): ShareMove {
  if (recent === null || baseline === null) return { recent, baseline, move: null, flagged: false };
  let move = 0;
  for (const k of new Set([...Object.keys(recent), ...Object.keys(baseline)])) {
    move = Math.max(move, Math.abs((recent[k] ?? 0) - (baseline[k] ?? 0)));
  }
  return { recent, baseline, move, flagged: move >= limit - EPS };
}

/** Prompt-length ratio flag: outside [0.67, 1.5]. Pure. */
export function promptLengthFlag(recent: number | null, baseline: number | null): MixFlags["promptLength"] {
  const ratio = recent !== null && baseline !== null && baseline > 0 ? recent / baseline : null;
  return { recent, baseline, ratio, flagged: ratio !== null && (ratio < PROMPT_LENGTH_BAND.lo || ratio > PROMPT_LENGTH_BAND.hi) };
}

/** The flags from collected tallies. */
export function mixFlags(c: MixCollector, agent: string): MixFlags {
  const r = c.recent, b = c.baseline;
  const promptLength = promptLengthFlag(r.prompts > 0 ? r.promptChars / r.prompts : null, b.prompts > 0 ? b.promptChars / b.prompts : null);
  const binary = (n: number, total: number) => (total > 0 ? { yes: n / total, no: 1 - n / total } : null);
  const mode = shareMove(shares(r.mode, r.used), shares(b.mode, b.used));
  const entrypoint = shareMove(shares(r.entrypoint, r.used), shares(b.entrypoint, b.used));
  const subagent = shareMove(binary(r.subagent, r.used), binary(b.subagent, b.used));
  const work = (t: WindowTally) => {
    const all = t.mainEdits + t.subEdits;
    return all > 0 ? { main: t.mainEdits / all, subagent: t.subEdits / all } : null;
  };
  const subagentWork = shareMove(work(r), work(b));
  const interactive = agent === "codex"
    ? shareMove(
      r.all > 0 ? { interactive: 1 - r.nonInteractive / r.all, scripted: r.nonInteractive / r.all } : null,
      b.all > 0 ? { interactive: 1 - b.nonInteractive / b.all, scripted: b.nonInteractive / b.all } : null,
    )
    : null;
  return {
    promptLength,
    contextStarts: { available: false, reason: "fields_missing", flagged: false },
    mode,
    entrypoint,
    subagent,
    subagentWork,
    interactive,
    anyFlagged: promptLength.flagged || mode.flagged || entrypoint.flagged || subagent.flagged || subagentWork.flagged || interactive?.flagged === true,
  };
}
