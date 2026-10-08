import { createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import type { HashFn, ParseStats } from "./types.js";

/** Salted HMAC-SHA256 id factory. The salt lives only in ~/.wasitme/salt and is never exported. */
export function makeHash(salt: string): HashFn {
  return (value: string, prefix: string) =>
    prefix + createHmac("sha256", salt).update(value).digest("hex").slice(0, 12);
}

/**
 * Identifiers that end up in outputs (versions, model names, effort, modes) come from log files.
 * Keep them to a safe charset and length so nothing unexpected (ANSI, HTML, bidi, paths, prose)
 * can ride along into a report.
 */
export function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const s = String(value).trim();
  if (!s || s.length > 60 || !/^[A-Za-z0-9._\-\[\]:+@ ]+$/.test(s)) return undefined;
  return s;
}

/** Token-shaped strings that must never be shown as a "label", even though they would pass cleanLabel. */
const SECRET_PREFIX = /^(sk[-_]|pk[-_]|rk[-_]|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|nvapi-|eyJ|ya29\.|bearer )/i;
const LONG_TOKEN = /[A-Za-z0-9]{28,}/;

export function looksSecret(s: string): boolean {
  return SECRET_PREFIX.test(s) || LONG_TOKEN.test(s);
}

/**
 * Shape of a log-derived record-type key (ParseStats.unknownTypes, shards, snapshot health): one identifier — letters,
 * digits, `_ . -` — under an optional Codex family prefix. Never spaces (prose), `@` (addresses), `/` (paths) or a
 * token-shaped string. A strict subset of the contract's key pattern. (Codex item types are PascalCase, and keys like
 * `__proto__` are counted as data, so case and a leading underscore are allowed.)
 */
const TYPE_KEY = /^(?:codex:(?:(?:event_msg|item|response_item):)?)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,40}$/;

/** `key` when it has the record-type key shape, else `fallback` ("other", "codex:unrecognised"). */
export function typeKey(key: string, fallback: string): string {
  return TYPE_KEY.test(key) && !looksSecret(key) ? key : fallback;
}

const MIN_TIME = Date.parse("2020-01-01T00:00:00Z");

/**
 * Valid ISO timestamp within [2020-01-01, now + 1 day], else undefined.
 * Clocks can jump backward (people reset their clocks) — never assume ordering.
 */
export function cleanTime(value: unknown, now: Date = new Date()): string | undefined {
  const ms = timeMs(value);
  if (ms === undefined || ms < MIN_TIME || ms > now.getTime() + FUTURE_SLACK_MS) return undefined;
  return new Date(ms).toISOString();
}

/** How far past `now` a timestamp may be and still be accepted (cleanTime). */
export const FUTURE_SLACK_MS = 86_400_000;

function timeMs(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Count a timestamp cleanTime rejected (`stats.badTimestamps`). One rejected only for being later than now + 1 day
 * also lowers `stats.futureMin`: such a record is not garbage when the scan's clock was set back, and the store
 * re-parses the (unchanged) file once its clock reaches it. Pre-2020 and unparseable timestamps never do.
 */
export function noteBadTime(stats: ParseStats, value: unknown, now: Date): void {
  stats.badTimestamps++;
  const ms = timeMs(value);
  if (ms === undefined || ms <= now.getTime() + FUTURE_SLACK_MS) return;
  const t = Math.floor(ms);
  if (stats.futureMin === undefined || t < stats.futureMin) stats.futureMin = t;
}

/**
 * One formatter per (kind, IANA zone), built on first use: constructing an Intl.DateTimeFormat costs ~13x a format
 * call, and the readers and the analysis ask for a local day per exchange and event. An unnamed zone (the process
 * default, which `process.env.TZ` can change) is never cached; a zone that does not exist throws on construction,
 * as before, and is never cached either. Bounded: a run sees one or two zones.
 */
const FORMATS = new Map<string, Intl.DateTimeFormat>();
export function cachedFormat(kind: string, timeZone: string | undefined, make: (timeZone: string | undefined) => Intl.DateTimeFormat): Intl.DateTimeFormat {
  if (timeZone === undefined) return make(undefined);
  const key = `${kind}\u0000${timeZone}`;
  let f = FORMATS.get(key);
  if (f === undefined) {
    f = make(timeZone);
    if (FORMATS.size < 256) FORMATS.set(key, f);
  }
  return f;
}

const dayFormat = (timeZone: string | undefined): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

/** Local calendar day "YYYY-MM-DD" for an ISO timestamp. */
export function localDay(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  const parts = cachedFormat("day", timeZone, dayFormat).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export class Tally {
  private counts = new Map<string, number>();
  add(key: string | undefined, n = 1): void {
    if (!key) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }
  top(): string | undefined {
    let best: string | undefined;
    let bestN = -1;
    for (const [k, n] of this.counts) if (n > bestN) { best = k; bestN = n; }
    return best;
  }
  keys(): string[] { return [...this.counts.keys()]; }
  get size(): number { return this.counts.size; }
}

/**
 * Adds `n` to `counts[key]` for a log-derived key, safely: an own-property read (so "constructor" or "toString"
 * start at 0 instead of an inherited function) and a defined property (so "__proto__" is a count, not a prototype
 * swap). Keeps the plain-object shape the contract serialises.
 */
export function bump(counts: Record<string, number>, key: string, n = 1): void {
  const prev = Object.hasOwn(counts, key) ? counts[key]! : 0;
  Object.defineProperty(counts, key, { value: prev + n, enumerable: true, writable: true, configurable: true });
}

const MAX_LINE = 20 * 1024 * 1024;

export interface JsonlStats { badLines: number; truncatedTail: number }

/**
 * Stream a JSONL file, yielding parsed objects. Splits on "\n" ONLY — Node's readline also splits on
 * U+2028/U+2029, which JSON.stringify does not escape, silently corrupting records (spike bug #1).
 * A final line without a trailing newline that fails to parse is a partial write (truncatedTail),
 * not a bad line.
 *
 * Lines are split on the byte 0x0A and each line is decoded from UTF-8 once. That is exact: 0x0A never occurs inside a
 * UTF-8 multi-byte sequence (every continuation and lead byte is ≥ 0x80), and U+2028/U+2029 (E2 80 A8/A9) contain no
 * 0x0A. It keeps no growing string buffer, so a long session costs ~20% less memory than re-slicing one.
 *
 * A line longer than MAX_LINE bytes is skipped up to its newline and counted ONCE as a bad line, however many chunks
 * it spans; one still open at the end of the file is that same bad line, never a second record or a cut-off ending.
 */
export async function* readJsonl(path: string, stats: JsonlStats): AsyncGenerator<Record<string, unknown>> {
  /** Pieces of the line still being read (it began in an earlier chunk). */
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let skipping = false;
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
      if (skipping) skipping = false;
      else {
        const line = pendingBytes === 0 ? chunk.toString("utf8", start, nl) : Buffer.concat([...pending, chunk.subarray(start, nl)]).toString("utf8");
        const parsed = parseLine(line, stats);
        if (parsed) yield parsed;
      }
      pending = [];
      pendingBytes = 0;
      start = nl + 1;
    }
    if (skipping || start >= chunk.length) continue;
    pending.push(chunk.subarray(start));
    pendingBytes += chunk.length - start;
    if (pendingBytes > MAX_LINE) {
      stats.badLines++;
      pending = [];
      pendingBytes = 0;
      skipping = true;
    }
  }
  if (skipping || pendingBytes === 0) return;
  const tail = Buffer.concat(pending).toString("utf8");
  if (tail.trim()) {
    try {
      const v: unknown = JSON.parse(tail);
      if (v && typeof v === "object" && !Array.isArray(v)) yield v as Record<string, unknown>;
      else stats.badLines++;
    } catch {
      stats.truncatedTail++;
    }
  }
}

function parseLine(line: string, stats: JsonlStats): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const v: unknown = JSON.parse(line);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  stats.badLines++;
  return undefined;
}

export function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
