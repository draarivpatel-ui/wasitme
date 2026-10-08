/** Synthetic exchanges for the metrics/gates tests. Numbers only — no text, paths or real data. */
import type { MetricExchange } from "../../src/analysis/metrics/defs.js";
import { dayIndex, dayString } from "../../src/analysis/stats/ratio.js";

let counter = 0;

export function ex(over: Partial<MetricExchange> & { session: string; day: string }): MetricExchange {
  counter++;
  const base: MetricExchange = {
    v: 1,
    agent: "claude-code",
    id: `x-${over.session}-${over.day}-${counter}`,
    session: over.session,
    project: "p-test",
    t: `${over.day}T12:00:00.000Z`,
    day: over.day,
    version: "1.0.0",
    model: "m",
    servedModel: "m",
    effort: "high",
    mode: "default",
    entrypoint: "cli",
    seq: 0,
    afterCompaction: false,
    promptChars: 0,
    humanPrompt: 1,
    interrupted: 0,
    pushback: 0,
    queuedMidTurn: 0,
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    rejections: 0,
    blocked: 0,
    reads: 0,
    edits: 0,
    blindEdits: 0,
    churned: 0,
    outTok: 0,
    inTok: 0,
    cacheRead: 0,
    cacheWrite: 0,
    apiErrors: 0,
    apiRetries: 0,
    compactions: 0,
    thinkBlocks: 0,
    thinkRedacted: 0,
    thinkSigMedian: 0,
    subToolCalls: 0,
    subTokens: 0,
    durationMs: 0,
  };
  return { ...base, ...over };
}

/** Day string `offset` days from `day` (negative = earlier). */
export function addDays(day: string, offset: number): string {
  const i = dayIndex(day);
  if (i === undefined) throw new Error(`bad day ${day}`);
  return dayString(i + offset);
}

/** Deterministic Fisher–Yates shuffle (mulberry32). */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
