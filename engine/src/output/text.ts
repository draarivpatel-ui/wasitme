/**
 * Text safety and layout helpers for everything the CLI prints (terminal output strips C0/C1 control characters;
 * SECURITY.md "Hostile input handling"). ORDER MATTERS: content is cleaned first and only then wrapped in the design
 * system's SGR codes, so the only escape sequences in any output are the ones `design-tokens.ts` writes
 * (`ESC [ … m`). ESC is itself a C0 character, so cleaning the final string would delete the colours; cleaning the
 * content never can.
 *
 * Widths: a terminal cell holds one code point, except East Asian wide and fullwidth characters (two cells) and
 * combining marks (none). `cols` and everything built on it use those widths, so a hostile or foreign-language label
 * cannot push the layout past its columns. (Everything the engine writes is ASCII plus a few typographic marks.)
 */
import { cachedFormat } from "../util.js";

/** Whitespace-like controls become a space, so hostile text cannot glue two words or start a new line. */
const BREAKERS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
/**
 * Everything else that can act on a terminal or hide text: the remaining C0 controls (including ESC and NUL), DEL, the
 * C1 block (0x80–0x9F: includes the single-byte CSI 0x9B and OSC 0x9D), soft hyphen, the Arabic letter mark, bidi
 * embeddings/overrides/isolates (U+202A–202E, U+2066–2069, LRM/RLM), zero-width and invisible format characters,
 * the BOM and the interlinear annotation marks.
 */
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

/** A lone surrogate half cannot be encoded as UTF-8; it becomes U+FFFD. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];
const MARKS: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
];

/** Terminal cells a code point takes: 0 for combining marks, 2 for wide and fullwidth characters, else 1. */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x300) return 1;
  for (const [lo, hi] of MARKS) if (cp >= lo && cp <= hi) return 0;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/** At most two combining marks in a row (stacked "zalgo" marks are cut back; ordinary accents are kept). */
function limitMarks(s: string): string {
  let out = "";
  let run = 0;
  for (const ch of s) {
    if (charWidth(ch.codePointAt(0)!) === 0) {
      if (++run > 2) continue;
    } else {
      run = 0;
    }
    out += ch;
  }
  return out;
}

/** `s` with every control, bidi and invisible character removed (never throws; non-strings give ""). */
export function clean(s: unknown): string {
  if (typeof s !== "string") return "";
  return limitMarks(s.replace(LONE_SURROGATE, "\uFFFD").replace(BREAKERS, " ").replace(UNSAFE, ""));
}

/** Terminal columns the text takes (see the file header). */
export function cols(s: string): number {
  let n = 0;
  for (const ch of s) n += charWidth(ch.codePointAt(0)!);
  return n;
}

/** The longest start of `s` that fits `max` columns; when something is cut it ends in "…" (never a silent cut). */
export function clip(s: string, max: number): string {
  if (cols(s) <= max) return s;
  if (max <= 1) return max === 1 ? "…" : "";
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** Greedy word wrap to `width` columns; a word longer than the width is hard-split. Empty input gives no lines. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/ +/)) {
    if (word === "") continue;
    let rest = word;
    while (cols(rest) > w) {
      if (line !== "") { lines.push(line); line = ""; }
      let head = "";
      let hw = 0;
      for (const ch of rest) {
        const cw = charWidth(ch.codePointAt(0)!);
        if (hw + cw > w) break;
        head += ch;
        hw += cw;
      }
      if (head === "") head = [...rest][0]!;
      lines.push(head);
      rest = rest.slice(head.length);
    }
    if (line === "") line = rest;
    else if (cols(line) + 1 + cols(rest) <= w) line += ` ${rest}`;
    else { lines.push(line); line = rest; }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Sentences of a paragraph (split after ". "), keeping the full stops. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?]) +/).filter((s) => s !== "");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Oct 4, 09:14" for an instant in an IANA zone (24-hour clock; no locale data, so the same bytes everywhere). */
export function stamp(ms: number, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  const make = (tz: string | undefined): Intl.DateTimeFormat => new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  try {
    parts = cachedFormat("stamp", timeZone, make).formatToParts(new Date(ms));
  } catch {
    parts = cachedFormat("stamp", "UTC", make).formatToParts(new Date(ms));
  }
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "0";
  const month = MONTHS[Number(get("month")) - 1] ?? "???";
  return `${month} ${Number(get("day"))}, ${get("hour").padStart(2, "0")}:${get("minute").padStart(2, "0")}`;
}
