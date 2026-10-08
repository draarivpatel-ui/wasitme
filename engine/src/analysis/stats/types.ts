/**
 * Types for the statistics module. Pure data, no I/O. Everything here is derived numbers plus
 * opaque keys (already-hashed session ids, "YYYY-MM-DD" days) — never prompt text or paths.
 */

/**
 * One metric's totals for one session on one local day — the finest grain the stats module needs.
 * `num`/`den` are a ratio-of-totals pair (e.g. tool errors / tool calls, interrupts / prompts).
 */
export interface Cell {
  /** Opaque (hashed) session id. */
  session: string;
  /** Local calendar day "YYYY-MM-DD". */
  day: string;
  num: number;
  den: number;
}

/**
 * A resampling unit. `id` is an abstract key chosen by the caller (a session, a session-day, …).
 * `parent` (optional) groups clusters for two-level resampling — e.g. id = session|day, parent = session.
 */
export interface Cluster {
  id: string;
  parent?: string;
  num: number;
  den: number;
}

/** How cells are grouped into resampling units. */
export type ClusterScheme = "session" | "session-day";

/** Confidence interval on the ratio scale (recent / baseline). Bounds may be 0 or Infinity when uninformative. */
export interface Interval {
  lo: number;
  hi: number;
}

export interface WindowTotals {
  num: number;
  den: number;
  /** num / den (ratio of totals, no pseudo-count); NaN when den is 0. */
  rate: number;
  /**
   * Resampling units after merging duplicate ids and folding zero-denominator clusters into a sibling
   * under the same parent (e.g. a session-day with events but no prompts joins another day of its session).
   */
  clusters: number;
  /** Top-level units used for the small-sample correction (parents when two-level, else clusters). */
  units: number;
}

/** Result of a stratified cluster bootstrap of log(rate_recent / rate_baseline). */
export interface RatioComparison {
  recent: WindowTotals;
  baseline: WindowTotals;
  /** log((num_r + c)/den_r) − log((num_b + c)/den_b), c = pseudo-count. */
  logRatio: number;
  /** exp(logRatio). */
  ratio: number;
  /** Raw bootstrap standard deviation of the log ratio (no small-sample inflation). */
  seBootstrap: number;
  /**
   * SE used by the t intervals: each window's bootstrap variance × its small-sample factor (CR2,
   * Bell–McCaffrey leverage correction, by default; U/(U−1) when `smallSample` is "count"), floored at
   * the Poisson/binomial variance of its event count, then summed over the two windows.
   */
  se: number;
  /**
   * Degrees of freedom for the t intervals: the two windows' df (Bell–McCaffrey by default, U−1 for
   * "count") combined Welch–Satterthwaite style.
   */
  df: number;
  /** Percentile intervals of the bootstrap distribution. */
  percentile95: Interval;
  percentile99: Interval;
  /** Small-sample t intervals: logRatio ± t(df) · se. */
  t95: Interval;
  t99: Interval;
  /** Two-sided p-value of logRatio / se against t(df) (for Holm across metrics). */
  pValue: number;
  /** False when the data cannot support an interval (e.g. < 2 units in a window); intervals are then (0, ∞). */
  ok: boolean;
  reason?: string;
  resamples: number;
  twoLevel: boolean;
  smallSample: SmallSampleCorrection;
  seed: string;
}

export type IntervalKind = "t95" | "t99" | "percentile95" | "percentile99";

/** Small-sample correction for t intervals: "count" = U/(U−1) & df U−1; "cr2" = Bell–McCaffrey. */
export type SmallSampleCorrection = "count" | "cr2";

/** A complete interval method: how to cluster, whether to resample two levels, which interval. */
export interface Method {
  clusters: ClusterScheme;
  /** Resample sessions, then days within each drawn session (uses session-day clusters). */
  twoLevel: boolean;
  interval: IntervalKind;
  smallSample: SmallSampleCorrection;
}
