// Shared helpers for the token generators. Zero dependencies; deterministic (no clocks, no randomness).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const loadTokens = () => JSON.parse(readFileSync(join(ROOT, 'tokens.json'), 'utf8'));
export const MODES = ['light', 'dark'];

export const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Walk the colour tree of one mode, yielding [path, hex] for every leaf hex string. */
export function* colorLeaves(node, prefix = '') {
  for (const k of Object.keys(node)) {
    const v = node[k], p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v)) yield [p, v.toUpperCase()];
    else if (Array.isArray(v)) { let i = 1; for (const x of v) if (/^#[0-9A-Fa-f]{6}$/.test(x)) yield [`${p}.${i++}`, x.toUpperCase()]; }
    else if (v && typeof v === 'object') yield* colorLeaves(v, p);
  }
}

// ---------- colour math ----------
export const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const unlin = c => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; };
export const toLinear = h => hexToRgb(h).map(lin);
export const luminance = h => { const [r, g, b] = toLinear(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
export const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
export function simulate(hex, kind) {
  if (kind === 'normal') return toLinear(hex);
  const m = CVD[kind], v = toLinear(hex);
  return m.map(r => Math.min(1, Math.max(0, r[0] * v[0] + r[1] * v[1] + r[2] * v[2])));
}
export function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
/** OKLab distance x100 between two hex colours under a vision type. */
export const deltaE = (a, b, kind = 'normal') => {
  const p = oklab(simulate(a, kind)), q = oklab(simulate(b, kind));
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};
export const simHex = (hex, kind) => '#' + simulate(hex, kind).map(c => Math.round(unlin(c) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

// ---------- naming ----------
export const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/\./g, '-').toLowerCase();
export const camel = s => s.replace(/[.-](\w)/g, (_, c) => c.toUpperCase());
/** CSS custom-property name for a colour path ("party.you.fill" -> "--you-fill"). */
export const cssColorVar = path => '--' + kebab(path.replace(/^party\./, ''));

export const fmt = (n, d = 2) => n.toFixed(d);
export const HEADER = 'GENERATED from design/system/tokens.json by design/system/gen/build.mjs. Do not edit by hand.';

// ---------- sizes ----------
/** tokens.json size, flattened: [{ name, value }] for single numbers ("chipHeight", 26) and [{ name, w, h }] for a
 *  {width, height} pair ("popover"). Names are camelCase; CSS uses kebab(name). */
export function sizeEntries(t) {
  const out = [];
  for (const [k, v] of Object.entries(t.size)) {
    if (k.startsWith('$')) continue;
    if (typeof v === 'number') out.push({ name: k, value: v });
    else if (Object.keys(v).length === 2 && typeof v.width === 'number' && typeof v.height === 'number') out.push({ name: k, w: v.width, h: v.height });
    else for (const [k2, v2] of Object.entries(v)) {
      if (typeof v2 !== 'number') throw new Error(`size.${k}.${k2} is not a number`);
      out.push({ name: k + k2[0].toUpperCase() + k2.slice(1), value: v2 });
    }
  }
  for (const e of out) for (const n of [e.value, e.w, e.h]) if (n !== undefined && !(Number.isFinite(n) && n > 0)) throw new Error(`size.${e.name}: ${n}`);
  return out;
}

// ---------- glyph files ----------
/** "notSetUp", 16 -> "app-not-set-up-16" (the file name without .svg; also the key the Swift and canvas tables use). */
export const appGlyphKey = (s, px) => `app-${kebab(s)}-${px}`;
/** Every 16/18 px template glyph tokens.json names, as [key, relative file]: state-<s>-<px>, app-<s>-<px>, mark-<px>.
 *  Keys are the file names without ".svg"; the order is tokens order (states, app states, mark), so output is stable. */
export function glyphFiles(t) {
  const out = [];
  for (const s of [...t.states.order, ...t.states.displayOnly]) for (const px of ['16', '18']) out.push([`state-${s}-${px}`, t.states[s].files[px]]);
  for (const s of t.appStates.order) for (const px of ['16', '18']) out.push([appGlyphKey(s, px), t.appStates[s].files[px]]);
  for (const px of ['16', '18']) out.push([`mark-${px}`, t.mark.files[`mono${px}`]]);
  for (const [key, rel] of out) if (!rel || !rel.endsWith(`/${key}.svg`)) throw new Error(`tokens.json names ${rel} for glyph ${key}`);
  return out;
}

const attrsOf = tag => Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
function pathPoints(d, file) {
  const toks = d.trim().split(/\s+/), pts = [];
  let closed = false;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === 'Z' || toks[i] === 'z') { closed = true; continue; }
    const m = /^([ML])(-?[\d.]+)$/.exec(toks[i]);
    if (!m) throw new Error(`${file}: unsupported path token "${toks[i]}" in "${d}"`);
    pts.push([Number(m[2]), Number(toks[++i])]);
  }
  return { pts, closed };
}
/** One hand-written template glyph -> { size, prims }. Only what the glyph files use: <rect x y width height>, a filled
 *  closed <path d="M.. L.. Z">, and a stroked open <path d="M.. L.." fill="none" stroke-width="..">. Anything else
 *  (curves, transforms, rounded rects, opacity) fails loudly instead of being guessed: every consumer (Swift, canvas,
 *  screens) draws exactly these three primitives. */
export function parseGlyph(svg, file) {
  const size = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!size || size[1] !== size[2]) throw new Error(`${file}: square viewBox expected`);
  const prims = [];
  const body = svg.replace(/<title>[^<]*<\/title>/, '');
  for (const m of body.matchAll(/<(rect|path)\b([^>]*)\/>/g)) {
    const a = attrsOf(m[2]);
    if (m[1] === 'rect') {
      if (a.rx || a.transform) throw new Error(`${file}: rounded or transformed rect not supported`);
      prims.push({ kind: 'rect', x: Number(a.x ?? 0), y: Number(a.y ?? 0), w: Number(a.width), h: Number(a.height) });
    } else {
      const { pts, closed } = pathPoints(a.d, file);
      if (a.fill === 'none') {
        if (!a['stroke-width'] || closed) throw new Error(`${file}: a stroked path needs stroke-width and no Z`);
        prims.push({ kind: 'stroke', pts, width: Number(a['stroke-width']) });
      } else {
        if (!closed) throw new Error(`${file}: a filled path must be closed`);
        prims.push({ kind: 'fill', pts });
      }
    }
  }
  const leftovers = body.replace(/<(rect|path)\b[^>]*\/>/g, '').replace(/<svg\b[^>]*>|<\/svg>/g, '').trim();
  if (leftovers) throw new Error(`${file}: unsupported content: ${leftovers.slice(0, 60)}`);
  if (!prims.length) throw new Error(`${file}: no shapes`);
  for (const p of prims) for (const v of p.kind === 'rect' ? [p.x, p.y, p.w, p.h] : [...p.pts.flat(), ...(p.width ? [p.width] : [])])
    if (!Number.isFinite(v)) throw new Error(`${file}: not a finite number in a shape`);
  return { size: Number(size[1]), prims };
}
/** Every glyph tokens.json names, parsed: [[key, { size, prims }], ...] in glyphFiles order. */
export const loadGlyphs = t => glyphFiles(t).map(([key, rel]) => [key, parseGlyph(readFileSync(join(ROOT, rel), 'utf8'), rel)]);

// ---------- statistics for the analytic demo data (same formulas as the engine, METHOD.md §6) ----------
function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const FPMIN = 1e-300; let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}
/** Regularized incomplete beta I_x(a, b). */
function betaInc(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
/** Student t CDF and quantile (bisection; deterministic, 1e-12 tolerance). */
export const studentTCdf = (t, df) => { const p = 0.5 * betaInc(df / 2, 0.5, df / (df + t * t)); return t >= 0 ? 1 - p : p; };
export function studentTQuantile(p, df) {
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  let lo = 0, hi = 1000;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) { const mid = (lo + hi) / 2; if (studentTCdf(mid, df) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
/** METHOD.md §6 / engine gates/evaluate.ts: range = exp(theta +- t_{.995}(df) SE); MDE = exp((t_{.995} + t_{.80})(df) SE 1.1). */
export const LEVEL = 0.99, MDE_POWER = 0.8, MDE_OPTIMISM = 0.1;
export function rangeAndMde(ratio, se, df) {
  const tl = studentTQuantile(1 - (1 - LEVEL) / 2, df), tp = studentTQuantile(MDE_POWER, df);
  return { range: [ratio * Math.exp(-tl * se), ratio * Math.exp(tl * se)], mde: Math.exp((tl + tp) * se * (1 + MDE_OPTIMISM)), tl, tp };
}
/** SE that gives a target MDE at df (the demo data hand-sets the MDE it wants to print, then derives SE and range). */
export const seForMde = (mde, df) => Math.log(mde) / ((studentTQuantile(1 - (1 - LEVEL) / 2, df) + studentTQuantile(MDE_POWER, df)) * (1 + MDE_OPTIMISM));
/** Welch-Satterthwaite df for two windows of session-day clusters, variance weight 1/events per window. */
export const wsDf = (eventsR, daysR, eventsB, daysB) => {
  const vr = 1 / eventsR, vb = 1 / eventsB;
  return (vr + vb) ** 2 / (vr ** 2 / (daysR - 1) + vb ** 2 / (daysB - 1));
};
