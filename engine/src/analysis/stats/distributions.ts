/**
 * Normal and Student-t distribution functions, accurate to ~1e-10, real-valued (fractional)
 * degrees of freedom supported — Welch–Satterthwaite df are rarely integers.
 */

/** Standard normal CDF (Marsaglia 2004 Taylor series; |x| > 8.3 saturates to 0/1). */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < -8.3) return 0;
  if (x > 8.3) return 1;
  let s = x, t = 0, b = x;
  const q = x * x;
  for (let i = 1; s !== t; i += 2) {
    t = s;
    b *= q / (i + 2);
    s = t + b;
  }
  return 0.5 + s * Math.exp(-0.5 * q - 0.91893853320467274178);
}

/** Standard normal quantile (Wichura 1988, AS 241 PPND16; ~1e-16 relative accuracy). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * (((((((r * 2509.0809287301226727 + 33430.575583588128105) * r + 67265.770927008700853) * r +
      45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r + 133.14166789178437745) * r +
      3.387132872796366608)) /
      (((((((r * 5226.495278852545925 + 28729.085735721942674) * r + 39307.89580009271061) * r + 21213.794301586595867) * r +
        5394.1960214247511077) * r + 687.1870074920579083) * r + 42.313330701600911252) * r + 1);
  }
  let r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  let val: number;
  if (r <= 5) {
    r -= 1.6;
    val = (((((((r * 7.7454501427834140764e-4 + 0.0227238449892691845833) * r + 0.24178072517745061177) * r +
      1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r + 4.6303378461565452959) * r +
      1.42343711074968357734) /
      (((((((r * 1.05075007164441684324e-9 + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r +
        0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r + 2.05319162663775882187) * r + 1);
  } else {
    r -= 5;
    val = (((((((r * 2.01033439929228813265e-7 + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r +
      0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r + 5.4637849111641143699) * r +
      6.6579046435011037772) /
      (((((((r * 2.04426310338993978564e-15 + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r +
        7.868691311456132591e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r + 0.59983220655588793769) * r + 1);
  }
  return q < 0 ? -val : val;
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Γ(x) for x > 0 (Lanczos, g = 7). */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betaCf(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (!(x > 0)) return 0;
  if (!(x < 1)) return 1;
  const lnFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(lnFront) * betaCf(x, a, b)) / a;
  return 1 - (Math.exp(lnFront) * betaCf(1 - x, b, a)) / b;
}

/** Above this many degrees of freedom the t distribution is treated as normal (error < 1e-6). */
const NORMAL_DF = 1e7;

/** Student-t CDF with real df > 0. */
export function studentTCdf(t: number, df: number): number {
  if (Number.isNaN(t) || !(df > 0)) return NaN;
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  if (df >= NORMAL_DF) return normalCdf(t);
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** Student-t quantile with real df > 0 (bracketed bisection on the CDF, polished by Newton). */
export function studentTQuantile(p: number, df: number): number {
  if (!(df > 0) || Number.isNaN(p)) return NaN;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (df >= NORMAL_DF) return normalQuantile(p);
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  // Closed forms for df = 1 and 2.
  if (df === 1) return Math.tan(Math.PI * (p - 0.5));
  if (df === 2) {
    const a = 4 * p * (1 - p);
    return (2 * (p - 0.5)) * Math.sqrt(2 / a);
  }
  let lo = 0;
  let hi = Math.max(1, normalQuantile(p));
  while (studentTCdf(hi, df) < p) {
    lo = hi;
    hi *= 2;
    if (hi > 1e12) return hi;
  }
  for (let i = 0; i < 200 && hi - lo > 1e-12 * Math.max(1, hi); i++) {
    const mid = 0.5 * (lo + hi);
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Two-sided p-value for a t statistic. */
export function twoSidedP(t: number, df: number): number {
  if (Number.isNaN(t) || !(df > 0)) return NaN;
  const a = Math.abs(t);
  if (!Number.isFinite(a)) return 0;
  if (df >= NORMAL_DF) return Math.min(1, 2 * normalCdf(-a));
  // Both tails directly (no 1 - CDF cancellation): P(|T| ≥ a) = I_{df/(df+a²)}(df/2, 1/2).
  return Math.min(1, incompleteBeta(df / (df + a * a), df / 2, 0.5));
}
