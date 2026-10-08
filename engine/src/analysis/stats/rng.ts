/**
 * Seeded, deterministic pseudo-random numbers. Same seed string → same stream on every platform,
 * so a report can be reproduced exactly. Not cryptographic.
 *
 * Generator: SFC32 (Chris Doty-Humphrey's Small Fast Chaotic PRNG, public domain), state seeded
 * from a 128-bit FNV-1a/murmur-finalised hash of the seed string.
 */

/** 32-bit murmur3 finaliser: spreads every input bit across the output. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Four independent 32-bit hashes of a string (FNV-1a with distinct offsets, then fmix32). */
export function hashString(s: string): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    let h = (0x811c9dc5 ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= s.length;
    out[k] = fmix32(h);
  }
  return out;
}

/** Short hex digest of a string (for building readable derived seeds). */
export function hashHex(s: string): string {
  return hashString(s).map((w) => w.toString(16).padStart(8, "0")).join("");
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spareNormal: number | undefined;

  constructor(seed: string) {
    [this.a, this.b, this.c, this.d] = hashString(seed);
    if ((this.a | this.b | this.c | this.d) === 0) this.d = 1;
    for (let i = 0; i < 16; i++) this.next();
  }

  /** Uniform in [0, 1) with 32 bits of resolution. */
  next(): number {
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform in (0, 1): safe for logarithms. */
  open(): number {
    let u = this.next();
    while (u === 0) u = this.next();
    return u;
  }

  /** Standard normal (Marsaglia polar method). */
  normal(): number {
    if (this.spareNormal !== undefined) {
      const s = this.spareNormal;
      this.spareNormal = undefined;
      return s;
    }
    let u = 0, v = 0, q = 0;
    do {
      u = 2 * this.next() - 1;
      v = 2 * this.next() - 1;
      q = u * u + v * v;
    } while (q >= 1 || q === 0);
    const f = Math.sqrt((-2 * Math.log(q)) / q);
    this.spareNormal = v * f;
    return u * f;
  }

  /** Gamma(shape, scale=1) — Marsaglia & Tsang (2000); shape < 1 via the boost u^(1/shape). */
  gamma(shape: number): number {
    if (!(shape > 0)) return 0;
    if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.open(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x = 0, v = 0;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.open();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /** Poisson(lambda): multiplication method for small lambda, PTRS (Hörmann 1993) otherwise. */
  poisson(lambda: number): number {
    if (!(lambda > 0)) return 0;
    if (lambda < 10) {
      const L = Math.exp(-lambda);
      let k = 0;
      let p = this.next();
      while (p > L) {
        k++;
        p *= this.next();
      }
      return k;
    }
    const slam = Math.sqrt(lambda);
    const loglam = Math.log(lambda);
    const b = 0.931 + 2.53 * slam;
    const a = -0.059 + 0.02483 * b;
    const invalpha = 1.1239 + 1.1328 / (b - 3.4);
    const vr = 0.9277 - 3.6224 / (b - 2);
    for (;;) {
      const U = this.next() - 0.5;
      const V = this.open();
      const us = 0.5 - Math.abs(U);
      const k = Math.floor(((2 * a) / us + b) * U + lambda + 0.43);
      if (us >= 0.07 && V <= vr) return k;
      if (k < 0 || (us < 0.013 && V > us)) continue;
      if (Math.log(V) + Math.log(invalpha) - Math.log(a / (us * us) + b) <= -lambda + k * loglam - logFactorial(k)) return k;
    }
  }

  /** Binomial(n, p), exact: geometric waiting times, O(n·min(p, 1-p)) expected work. */
  binomial(n: number, p: number): number {
    n = Math.floor(n);
    if (!(n > 0) || !(p > 0)) return 0;
    if (p >= 1) return n;
    if (p > 0.5) return n - this.binomial(n, 1 - p);
    const logq = Math.log1p(-p);
    let k = 0;
    let pos = 0;
    for (;;) {
      pos += Math.floor(Math.log(this.open()) / logq) + 1;
      if (pos > n) return k;
      k++;
    }
  }

  /** Negative binomial with the given mean and size (dispersion): Poisson(Gamma(size, mean/size)). */
  negBinomial(mean: number, size: number): number {
    if (!(mean > 0)) return 0;
    if (!(size > 0) || !Number.isFinite(size)) return this.poisson(mean);
    return this.poisson((this.gamma(size) * mean) / size);
  }
}

const LOG_FACT_CACHE: number[] = [0, 0];
function logFactorial(k: number): number {
  if (k < 0) return 0;
  if (k < 256) {
    for (let i = LOG_FACT_CACHE.length; i <= k; i++) LOG_FACT_CACHE[i] = LOG_FACT_CACHE[i - 1]! + Math.log(i);
    return LOG_FACT_CACHE[k]!;
  }
  // Stirling series, accurate to ~1e-12 for k ≥ 256.
  const x = k + 1;
  return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * x) - 1 / (360 * x * x * x);
}
