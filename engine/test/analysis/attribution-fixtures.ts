/** Synthetic workloads for the attribution tests. Numbers and opaque labels only — no text, paths or real data. */
import type { AttributionEvent } from "../../src/analysis/attribution/index.js";
import { G0_FALLBACK_ERRORS_VOTE } from "../../src/analysis/gates/evaluate.js";
import type { MetricExchange } from "../../src/analysis/metrics/defs.js";
import { addDays, ex } from "./helpers.js";

export const TODAY = "2026-10-04";
export const NOW = new Date(`${TODAY}T12:00:00Z`);
/** D47(d): until G0 decides, the fallback construct is passed explicitly. */
export const BASE = { agent: "claude-code", now: NOW, timeZone: "UTC", errorsVote: G0_FALLBACK_ERRORS_VOTE, resamples: 400 } as const;

/** Per-session variation that keeps each day's mean (so cluster variance is not degenerate). */
const WIGGLE = [-1, 1, 0, 0];

export interface Scenario {
  /** Days of history before today (default 60). */
  days?: number;
  sessionsPerDay?: number;
  /** Project of session i (default alternating p-A / p-B). */
  project?: (i: number, after: boolean) => string;
  /** The change starts on TODAY − onset (inclusive); undefined → no change. */
  onset?: number;
  /** Tool errors per session (of 50 calls), before / after. */
  errors?: [number, number];
  /** Blind edits per session (of 20 edits), before / after. */
  blind?: [number, number];
  /** Reads per session (20 edits), before / after. */
  reads?: [number, number];
  /** Label / field overrides per exchange. */
  label?: (after: boolean, i: number, k: number) => Partial<MetricExchange>;
}

export function scenario(s: Scenario): MetricExchange[] {
  const days = s.days ?? 60, spd = s.sessionsPerDay ?? 4;
  const errors = s.errors ?? [2, 2], blind = s.blind ?? [2, 2], reads = s.reads ?? [40, 40];
  const project = s.project ?? ((i: number) => (i % 2 === 0 ? "p-A" : "p-B"));
  const xs: MetricExchange[] = [];
  for (let k = 1; k <= days; k++) {
    const day = addDays(TODAY, -k);
    const after = s.onset !== undefined && k <= s.onset;
    for (let i = 0; i < spd; i++) {
      const w = WIGGLE[i % WIGGLE.length]!;
      const e = Math.max(0, (after ? errors[1] : errors[0]) + w);
      const b = Math.max(0, (after ? blind[1] : blind[0]) + w);
      xs.push(ex({
        session: `s${i}-${day}`, day, project: project(i, after),
        t: `${day}T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
        toolCalls: 50, cmdCalls: 0, toolErrors: e, toolErrorsEdit: e, toolErrorsCmd: 0,
        edits: 20, reads: after ? reads[1] : reads[0], blindEdits: b, steps: 4,
        ...(s.label ? s.label(after, i, k) : {}),
      }));
    }
  }
  return xs;
}

/** A recorded (reader/configsnap) event. */
export function recorded(over: Partial<AttributionEvent> & Pick<AttributionEvent, "id" | "kind" | "side" | "from" | "to" | "day">): AttributionEvent {
  return {
    t: `${over.day}T09:00:00.000Z`, agent: "claude-code", evidence: "log", strength: "strong", provenance: "command", ...over,
  };
}

/** Every day from TODAY − n to yesterday. */
export function daysBack(n: number): string[] {
  const out: string[] = [];
  for (let k = n; k >= 1; k--) out.push(addDays(TODAY, -k));
  return out;
}
