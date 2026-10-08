/**
 * Glance persistence (METHOD.md §12), operationalised for the harness:
 *
 *   "What the glance shows changes only when two evaluations agree: at least 24 hours apart in data time, with the
 *    second recent window holding at least 30% new denominator and at least 2 new session-days." "Leaving a state
 *    uses the same rule."
 *
 * Read as:
 *  - The glance key is state + reason (what the glance shows). The glance starts at `insufficient:needs_data`.
 *  - An evaluation whose key equals the displayed one clears any pending change.
 *  - An evaluation with a different key K, when nothing (or another key) is pending, makes K pending and remembers
 *    the evaluation day t₁ and its recent-window denominator D₁.
 *  - An evaluation on day t₂ with the pending key K confirms it (the glance switches to K) when t₂ − t₁ ≥ 1 day and
 *    the denominator that arrived in its recent window since t₁ — days [max(t₁, its recent window's first day), t₂ − 1]
 *    — is ≥ 30% of D₁, with ≥ 2 session-days of it. Otherwise K stays pending (the first agreeing evaluation is kept).
 *  - "Denominator" is the voting tool-error construct's denominator (tool calls that ran — the broadest work unit
 *    all voting metrics are built from), in the selected tier's recent window (tier 1's when no tier is selected).
 */
import type { MetricCell } from "../metrics/cells.js";

export const PERSIST_NEW_SHARE = 0.3;
export const PERSIST_NEW_SESSION_DAYS = 2;
export const INITIAL_GLANCE = "insufficient:needs_data";

/** Per-day work totals of one metric's cells: denominator and session-days with a denominator. */
export class DailyWork {
  private den = new Map<number, number>();
  private sd = new Map<number, number>();
  constructor(cells: readonly MetricCell[], dayIdx: (day: string) => number) {
    for (const c of cells) {
      if (!(c.den > 0)) continue;
      const d = dayIdx(c.day);
      this.den.set(d, (this.den.get(d) ?? 0) + c.den);
      this.sd.set(d, (this.sd.get(d) ?? 0) + 1);
    }
  }
  /** Σ denominator and session-days over inclusive day indices [from, to]. */
  between(from: number, to: number): { den: number; sessionDays: number } {
    let den = 0, sessionDays = 0;
    for (let d = from; d <= to; d++) {
      den += this.den.get(d) ?? 0;
      sessionDays += this.sd.get(d) ?? 0;
    }
    return { den, sessionDays };
  }
}

export interface GlanceObservation {
  key: string;
  todayIdx: number;
  /** First day (index) of the recent window the observation's evaluation used. */
  recentFrom: number;
  /** That window's denominator. */
  recentDen: number;
}

export class Glance {
  displayed: string;
  private pending: { key: string; todayIdx: number; recentDen: number } | null = null;
  constructor(initial = INITIAL_GLANCE) {
    this.displayed = initial;
  }

  /** Feed one evaluation; returns the displayed key after it. `work` gives the new data since the pending one. */
  step(o: GlanceObservation, work: DailyWork): string {
    if (o.key === this.displayed) {
      this.pending = null;
      return this.displayed;
    }
    const p = this.pending;
    if (p !== null && p.key === o.key) {
      if (o.todayIdx - p.todayIdx >= 1) {
        const fresh = work.between(Math.max(p.todayIdx, o.recentFrom), o.todayIdx - 1);
        if (fresh.den >= PERSIST_NEW_SHARE * p.recentDen && fresh.sessionDays >= PERSIST_NEW_SESSION_DAYS) {
          this.displayed = o.key;
          this.pending = null;
        }
      }
      return this.displayed;
    }
    this.pending = { key: o.key, todayIdx: o.todayIdx, recentDen: o.recentDen };
    return this.displayed;
  }

  get pendingKey(): string | null {
    return this.pending?.key ?? null;
  }
}
