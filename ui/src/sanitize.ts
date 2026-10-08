/**
 * Every string in a snapshot is engine-owned text that the canvas renders as plain text (docs/CONTRACT.md
 * #display-rules): never HTML, Markdown or escapes, with control, bidi and invisible characters stripped and the
 * length bounded. A port of the app's `TextSanitizer` (macos/Sources/WasitmeCore/Display/TextSanitizer.swift), so the
 * native chrome and the canvas clean text the same way:
 *  1. whole terminal escape sequences go (CSI, OSC/DCS/SOS/PM/APC strings, their C1 forms), not just the ESC byte;
 *  2. C0/C1 controls, bidi controls, zero-width/invisible, tag and private-use characters are dropped; line breaks,
 *     tabs and other separators become a space;
 *  3. whitespace runs collapse to one space, ends trimmed;
 *  4. stacked combining marks are capped at 3 per base character;
 *  5. the result is bounded to `max` user-perceived characters, ending in "…" when cut.
 * The text is then only ever written with textContent / createTextNode (dom.ts).
 */

export const MAX_COMBINING_MARKS = 3;

type Kind = 0 | 1 | 2 | 3; // keep, drop, space, mark
const KEEP: Kind = 0, DROP: Kind = 1, SPACE: Kind = 2, MARK: Kind = 3;

const RE_WHITE = /\p{White_Space}/u;
const RE_MARK = /\p{M}/u;
const RE_DROP_CAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Co}\p{Zl}\p{Zp}]/u;

function classify(cp: number, ch: string): Kind {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d || cp === 0x85 || cp === 0x2028 || cp === 0x2029) return SPACE;
  if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return DROP;
  if (cp === 0x00ad || cp === 0x034f || cp === 0x061c || cp === 0x115f || cp === 0x1160 || cp === 0x17b4 || cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) || cp === 0x3164 || cp === 0xfeff || cp === 0xffa0 || (cp >= 0xfff9 && cp <= 0xfffb) ||
    (cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a)) return DROP;
  if ((cp >= 0xe0000 && cp <= 0xe007f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return DROP;
  if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd)) return DROP;
  if (RE_WHITE.test(ch)) return SPACE;
  if (RE_MARK.test(ch)) return MARK;
  if (RE_DROP_CAT.test(ch)) return DROP;
  return KEEP;
}

/** Removes ANSI/ECMA-48 sequences whole. Unterminated strings run to the end of the text. */
function stripEscapes(cps: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  const skipCSI = (start: number): number => {
    let j = start;
    while (j < cps.length && cps[j]! >= 0x20 && cps[j]! <= 0x3f) j++;
    if (j < cps.length && cps[j]! >= 0x40 && cps[j]! <= 0x7e) j++;
    return j;
  };
  const skipString = (start: number): number => {
    let j = start;
    while (j < cps.length) {
      const c = cps[j]!;
      if (c === 0x07 || c === 0x9c) return j + 1;
      if (c === 0x1b && j + 1 < cps.length && cps[j + 1] === 0x5c) return j + 2;
      j++;
    }
    return j;
  };
  while (i < cps.length) {
    const c = cps[i]!;
    if (c === 0x1b) {
      if (i + 1 >= cps.length) { i++; continue; }
      const n = cps[i + 1]!;
      if (n === 0x5b) i = skipCSI(i + 2);                                              // ESC [
      else if (n === 0x5d || n === 0x50 || n === 0x58 || n === 0x5e || n === 0x5f) i = skipString(i + 2); // ] P X ^ _
      else i += 2;                                                                       // two-character escape
      continue;
    }
    if (c === 0x9b) { i = skipCSI(i + 1); continue; }
    if (c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) { i = skipString(i + 1); continue; }
    out.push(c);
    i++;
  }
  return out;
}

let segmenter: Intl.Segmenter | null | undefined;
function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    try { segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null; } catch { segmenter = null; }
  }
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s);
}

/** Cuts to at most `max` user-perceived characters, with a trailing ellipsis when cut. */
export function bound(s: string, max: number): string {
  if (max <= 0) return "";
  const g = graphemes(s);
  if (g.length <= max) return s;
  return g.slice(0, max - 1).join("").trimEnd() + "…";
}

/** Cleans one engine string. Anything that is not a string becomes "". */
export function clean(raw: unknown, max: number): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const cps: number[] = [];
  for (const ch of raw) cps.push(ch.codePointAt(0)!);
  const kept = stripEscapes(cps);
  let out = "";
  let pendingSpace = false;
  let marks = 0;
  for (const cp of kept) {
    const ch = String.fromCodePoint(cp);
    switch (classify(cp, ch)) {
      case DROP: break;
      case SPACE: pendingSpace = out.length > 0; marks = 0; break;
      case MARK:
        if (out.length === 0 || pendingSpace) break;      // a mark with no base is dropped
        marks++;
        if (marks <= MAX_COMBINING_MARKS) out += ch;
        break;
      default:
        if (pendingSpace) { out += " "; pendingSpace = false; }
        out += ch;
        marks = 0;
    }
  }
  return bound(out, max);
}

/** True when a string is safe to send back to native as an agent id (BridgePolicy's own check). */
export function isBridgeId(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(raw);
}
