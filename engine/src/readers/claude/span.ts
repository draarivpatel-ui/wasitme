/**
 * Wall-clock span of a stretch of records whose timestamps may be out of order or may jump
 * (people reset their clocks). Only forward progress past the highest time seen so far counts,
 * so small write-order shuffles never inflate the span.
 *
 * A large backward jump is held as a candidate clock reset: if the next record continues from the
 * new, lower time the clock re-bases there (adding nothing for the jump); if it returns above the
 * old high-water mark, the low record was a stray and is ignored.
 *
 * Large forward jumps are counted (a long tool run is real time) but remembered. When a confirmed
 * reset lands at or above the point where such a jump started, the drop undoes it — a stray late
 * record, or a clock excursion that was corrected (real time only moves on, so a correction lands
 * there) — and the overlap is refunded, across several correction steps if need be. A reset that
 * lands below every jump is a genuine reset and says nothing about the jumps, which stay counted.
 * Residual ambiguity: a genuine long gap followed by a small genuine reset is undercounted; a jump
 * back on the very last record cannot be confirmed, so it refunds nothing. Never negative.
 */
export const RESET_MS = 5 * 60_000;

export class SpanClock {
  private hi: number | undefined;
  private candidate: number | undefined;
  private total = 0;
  /** Forward jumps larger than RESET_MS not yet refunded by a confirmed reset. */
  private bigForward = 0;
  /** Where the earliest of those jumps started. */
  private jumpFrom = 0;

  add(ms: number): void {
    if (!Number.isFinite(ms)) return;
    if (this.hi === undefined) { this.hi = ms; return; }
    if (this.candidate !== undefined) {
      const c = this.candidate;
      this.candidate = undefined;
      if (ms < this.hi && ms >= c) this.reset(c);
    }
    if (ms > this.hi) {
      const step = ms - this.hi;
      if (step > RESET_MS) {
        if (this.bigForward === 0) this.jumpFrom = this.hi;
        this.bigForward += step;
      }
      this.total += step;
      this.hi = ms;
    } else if (this.hi - ms > RESET_MS) {
      this.candidate = ms;
    }
  }

  /** The clock really did go back to `c`: refund the forward jumps it undoes, continue from `c`. */
  private reset(c: number): void {
    if (this.bigForward > 0 && c >= this.jumpFrom) {
      const refund = Math.min(this.hi! - c, this.bigForward);
      this.total = Math.max(0, this.total - refund);
      this.bigForward -= refund;
    } else {
      this.bigForward = 0;
    }
    this.hi = c;
  }

  get ms(): number {
    return Math.max(0, Math.round(this.total));
  }
}
