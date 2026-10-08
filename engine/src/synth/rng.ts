/**
 * Deterministic randomness for the synthetic log generator.
 *
 * Everything the generator emits must be a pure function of (scenario, seed): no Math.random,
 * no clock, no environment. `fork(label)` derives an independent stream from the root seed and a
 * label WITHOUT consuming this stream, so adding a draw in one place never shifts bytes elsewhere.
 */

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function splitmix32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

const HEX = "0123456789abcdef";
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const B64 = B62 + "+/";

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(readonly seed: number, readonly label: string = "") {
    const sm = splitmix32(hash32(`${seed}|${label}`));
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm() || 1;
  }

  /** Independent stream for `label`; does not advance this stream. */
  fork(label: string): Rng {
    return new Rng(this.seed, `${this.label}/${label}`);
  }

  /** xoshiro128** step, uniform in [0, 2^32). */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error("pick from empty list");
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Pick by weight. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let x = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      x -= weights[i]!;
      if (x < 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }

  /** Approximately standard normal (Irwin–Hall, pure arithmetic: no transcendental functions). */
  normal(): number {
    let s = 0;
    for (let i = 0; i < 12; i++) s += this.next();
    return s - 6;
  }

  /** Log-normal with the given median. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }

  /** Geometric number of trials >= 1 with the given mean. */
  geometric(mean: number): number {
    if (mean <= 1) return 1;
    const p = 1 / mean;
    let n = 1;
    while (!this.chance(p) && n < 10_000) n++;
    return n;
  }

  /** Shuffle a copy (Fisher–Yates). */
  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  private chars(alphabet: string, n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += alphabet[this.nextU32() % alphabet.length];
    return out;
  }

  hex(n: number): string { return this.chars(HEX, n); }
  base62(n: number): string { return this.chars(B62, n); }
  /** Base64 alphabet without padding. */
  base64(n: number): string { return this.chars(B64, n); }

  /** RFC-4122-shaped (version 4) id drawn from this stream. */
  uuid(): string {
    const h = this.hex(32).split("");
    h[12] = "4";
    h[16] = HEX[8 + (this.nextU32() & 3)]!;
    const s = h.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }

  /** Raw bytes (for the binary-garbage hostile fixture). */
  bytes(n: number): Buffer {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = this.nextU32() & 0xff;
    return b;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Probability with a log-odds shift (per-session random effect). */
export function shiftOdds(p: number, u: number): number {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  const logit = Math.log(q / (1 - q)) + u;
  return 1 / (1 + Math.exp(-logit));
}
