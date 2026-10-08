/**
 * Small-sample corrections for the variance of one window's ratio-of-totals, R = Σn_k / Σd_k, with
 * independent units k (sessions, or session-days).
 *
 * A cluster bootstrap estimates Var(R) ≈ Σ e_k² / D² with e_k = n_k − R·d_k (the "CR0" sandwich). That
 * is biased low with few units, and badly so when unit sizes are unequal, because a big unit pulls R
 * toward itself and shrinks its own residual. Two corrections:
 *
 *  - "count": multiply by U/(U−1), use df = U−1. Exact for equal-size units; what the spike used.
 *  - "cr2": Bell & McCaffrey (2002) bias-reduced linearisation. Each unit's squared residual is divided
 *    by (1 − h_k), where h_k = d_k / D is its leverage on R, and df is the Satterthwaite approximation
 *    for that variance estimator under a working model of independent, equal-variance unit means
 *    (Imbens & Kolesár 2016). With equal sizes it reduces exactly to "count" (factor U/(U−1), df U−1);
 *    with one dominant session it inflates more and drops df toward the effective number of units.
 *
 * Both return a multiplicative factor (applied to the bootstrap variance) and the window's df.
 */

import type { SmallSampleCorrection } from "./types.js";

export type { SmallSampleCorrection };

export interface Correction {
  factor: number;
  df: number;
}

export function countCorrection(units: number): Correction {
  return units >= 2 ? { factor: units / (units - 1), df: units - 1 } : { factor: Infinity, df: 0 };
}

/**
 * CR2 factor and Bell–McCaffrey df for a ratio of totals over units with numerators `n` and
 * denominators `d`. Units with no denominator have zero leverage. Returns factor Infinity when a single
 * unit holds (essentially) the whole denominator — there is then no between-unit information.
 */
export function cr2Correction(n: ArrayLike<number>, d: ArrayLike<number>): Correction {
  const U = n.length;
  if (U < 2) return { factor: Infinity, df: 0 };
  let N = 0, D = 0;
  for (let k = 0; k < U; k++) {
    N += n[k]!;
    D += d[k]!;
  }
  if (!(D > 0)) return { factor: Infinity, df: 0 };
  const R = N / D;
  // a_k = c_k² / (1 − h_k) with c_k = h_k = d_k / D (influence weight and leverage coincide here).
  let sumE2 = 0, sumE2Adj = 0, sumC2 = 0, sumC2Adj = 0;
  let s = 0, sumAC = 0, sumA2 = 0, sumA2C = 0, sumCC = 0;
  const a = new Float64Array(U);
  for (let k = 0; k < U; k++) {
    const c = d[k]! / D;
    const one = 1 - c;
    if (one <= 1e-9) return { factor: Infinity, df: 0 };
    const e = n[k]! - R * d[k]!;
    sumE2 += e * e;
    sumE2Adj += (e * e) / one;
    sumC2 += c * c;
    sumC2Adj += (c * c) / one;
    const ak = (c * c) / one;
    a[k] = ak;
    s += ak;
    sumAC += ak * c;
    sumA2 += ak * ak;
    sumA2C += ak * ak * c;
    sumCC += c * c;
  }
  // Residual-weighted factor (CR2 / CR0); with no residual variation fall back to the design weights.
  const factor = sumE2 > 0 ? sumE2Adj / sumE2 : sumC2 > 0 ? sumC2Adj / sumC2 : U / (U - 1);

  // Satterthwaite df of εᵀBε, B = (I − c1ᵀ) A (I − 1cᵀ), working model ε ~ N(0, I):
  // with g = s·c − a,  tr(B) = Σa − 2Σac + sΣc²,
  // tr(B²) = Σa² − 2Σa²c + 2Σc·a·g + (aᵀc)² + (cᵀg)² − 2(aᵀg)(cᵀc).
  let sumCAG = 0, aTg = 0, cTg = 0;
  for (let k = 0; k < U; k++) {
    const c = d[k]! / D;
    const g = s * c - a[k]!;
    sumCAG += c * a[k]! * g;
    aTg += a[k]! * g;
    cTg += c * g;
  }
  const trB = s - 2 * sumAC + s * sumCC;
  const trB2 = sumA2 - 2 * sumA2C + 2 * sumCAG + sumAC * sumAC + cTg * cTg - 2 * aTg * sumCC;
  let df = trB2 > 0 ? (trB * trB) / trB2 : U - 1;
  if (!Number.isFinite(df)) df = U - 1;
  // Satterthwaite df never exceeds U − 1 for this estimator; clamp numerical noise. Keep ≥ 1.
  df = Math.min(U - 1, Math.max(1, df));
  return { factor: Math.max(1, factor), df };
}
