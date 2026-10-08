/**
 * Minimum detectable change (MDC): the smallest true multiplicative change that a two-sided test at
 * level alpha would detect with the given power, given the standard error of the log ratio.
 *
 *   log-scale effect Δ = (z_{1−α/2} + z_{power}) · SE · (1 + optimism)
 *   detectable increase = exp(Δ) − 1,  detectable decrease = 1 − exp(−Δ)
 *
 * With df supplied, t quantiles replace z (small-sample intervals need bigger effects).
 *
 * Optimism correction (default +10% on the log scale): in an early spike on real logs, the plain
 * exp(z·SE) − 1 formula came out ~10% optimistic against simulated 80% power (SE itself is estimated,
 * and the log ratio is skewed with few events). The calibration harness (calibrate.ts, `mdcCheck`)
 * confirms it on synthetic users: for the recommended method, simulated power at the predicted MDC
 * was 67–92% without the correction and 76–98% with it (lowest for high-count metrics with few long
 * sessions, highest for rare events, where the variance floor makes intervals conservative).
 */
import { normalQuantile, studentTQuantile } from "./distributions.js";

export const DEFAULT_MDC_OPTIMISM = 0.1;

export interface MdcOptions {
  /** Two-sided test level (default 0.05). */
  alpha?: number;
  /** Target power (default 0.8). */
  power?: number;
  /** Degrees of freedom; when given, t quantiles are used instead of z. */
  df?: number;
  /** Override the quantile sum entirely (default z_{1−α/2} + z_power ≈ 2.80). */
  zSum?: number;
  /** Log-scale inflation for known optimism (default 0.10). */
  optimism?: number;
}

export interface Mdc {
  /** Detectable effect on the log scale. */
  logDelta: number;
  /** Smallest detectable relative increase (0.5 = +50%). */
  increase: number;
  /** Smallest detectable relative decrease (0.33 = −33%). */
  decrease: number;
  zSum: number;
}

export function minimumDetectableChange(se: number, opts: MdcOptions = {}): Mdc {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  const optimism = opts.optimism ?? DEFAULT_MDC_OPTIMISM;
  let zSum = opts.zSum;
  if (zSum === undefined) {
    const df = opts.df;
    const q = (p: number) => (df !== undefined && df > 0 && Number.isFinite(df) ? studentTQuantile(p, df) : normalQuantile(p));
    zSum = q(1 - alpha / 2) + q(power);
  }
  if (!(se >= 0) || !Number.isFinite(se)) return { logDelta: Infinity, increase: Infinity, decrease: 1, zSum };
  const logDelta = zSum * se * (1 + optimism);
  return { logDelta, increase: Math.expm1(logDelta), decrease: -Math.expm1(-logDelta), zSum };
}
