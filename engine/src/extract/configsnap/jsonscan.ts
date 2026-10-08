/**
 * Top-level key extractor for large JSON objects (notably ~/.claude.json, whose `projects` map can
 * run to megabytes and whose nested keys are filesystem paths we must never look at).
 *
 * Walks the top-level object only, skipping every value it was not asked for without building it.
 * Tolerates truncation: if the text ends (or is malformed) before the object closes, whatever wanted
 * values were already fully read are still returned and `complete` is false — so the caller can tell
 * "key is genuinely absent" (complete, not found) from "we ran out of file" (incomplete, not found).
 *
 * Iterative (no recursion), so hostile nesting cannot overflow the stack.
 */
export interface TopLevelScan {
  /** Raw JSON text of each wanted top-level value that was fully read. */
  found: Map<string, string>;
  /** True only if the top-level object was read through to its closing brace. */
  complete: boolean;
}

export function scanTopLevel(text: string, wanted: ReadonlySet<string>): TopLevelScan {
  const found = new Map<string, string>();
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const out = (complete: boolean): TopLevelScan => ({ found, complete });

  ws();
  if (text[i] !== "{") return out(false);
  i++;
  ws();
  if (text[i] === "}") return out(true);

  for (;;) {
    ws();
    if (text[i] !== '"') return out(false);
    const keyEnd = skipString(text, i);
    if (keyEnd < 0) return out(false);
    const keyRaw = text.slice(i, keyEnd);
    i = keyEnd;
    ws();
    if (text[i] !== ":") return out(false);
    i++;
    ws();
    const start = i;
    const end = skipValue(text, i);
    if (end < 0) return out(false);
    i = end;
    if (keyRaw.length <= 1000) {
      const key = decodeKey(keyRaw);
      if (key !== undefined && wanted.has(key)) found.set(key, text.slice(start, end));
    }
    ws();
    const c = text[i];
    if (c === ",") { i++; continue; }
    return out(c === "}");
  }
}

function decodeKey(raw: string): string | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Index just past the closing quote of the string starting at `i`, or -1 if unterminated. */
function skipString(text: string, i: number): number {
  let j = i + 1;
  for (;;) {
    const q = text.indexOf('"', j);
    if (q < 0) return -1;
    let b = q - 1;
    while (b >= j && text.charCodeAt(b) === 92) b--;
    if ((q - 1 - b) % 2 === 0) return q + 1;
    j = q + 1;
  }
}

/** Index just past the value starting at `i`, or -1 if it is cut off / empty. */
function skipValue(text: string, i: number): number {
  const n = text.length;
  const c = text.charCodeAt(i);
  if (c === 34) return skipString(text, i);
  if (c === 123 || c === 91) {
    let depth = 0;
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 34) {
        j = skipString(text, j);
        if (j < 0) return -1;
        continue;
      }
      if (d === 123 || d === 91) depth++;
      else if (d === 125 || d === 93) {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return -1;
  }
  let j = i;
  while (j < n) {
    const d = text.charCodeAt(j);
    if (d === 44 || d === 125 || d === 93 || d === 32 || d === 9 || d === 10 || d === 13) break;
    j++;
  }
  // A scalar that runs into the end of the text may itself be cut off (e.g. `12` of `123`).
  return j > i && j < n ? j : -1;
}
