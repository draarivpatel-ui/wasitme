/**
 * Minimal, tolerant TOML reader for ~/.codex/config.toml. It only builds a data tree — it never
 * evaluates, expands, includes or executes anything (TOML has no such features, and we add none).
 *
 * Scope: tables `[a.b]`, arrays of tables `[[a]]`, dotted and quoted keys, basic/literal strings
 * (single- and multi-line), booleans, integers, floats, dates/times (kept as strings), arrays and
 * inline tables (multi-line allowed). Any structural problem (unterminated string, missing `=`,
 * duplicate key, redefined table, bad header …) is counted in `errors` and the statement skipped;
 * callers treat `errors > 0` as "malformed: state unknown" rather than trusting a partial tree.
 *
 * Hostile input: all tables are prototype-less (a `__proto__` key is just a key), nesting is bounded,
 * recursion depth is bounded, and error messages never contain input text.
 */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [key: string]: TomlValue }

export interface TomlResult {
  root: TomlTable;
  errors: number;
}

const MAX_DEPTH = 32;
const MAX_ERRORS = 50;

class TomlError extends Error {
  constructor() { super("toml"); }
}

function newTable(): TomlTable {
  return Object.create(null) as TomlTable;
}

export function isTable(v: unknown): v is TomlTable {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const DATETIME = /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/y;
const TIME = /\d{2}:\d{2}:\d{2}(?:\.\d+)?/y;
const INT = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
const FLOAT = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/;
const RADIX = /^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/;
const SPECIAL = /^[+-]?(?:inf|nan)$/;

export function parseToml(src: string): TomlResult {
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const root = newTable();
  const explicit = new WeakSet<object>();
  const arrayTables = new WeakSet<object>();
  let errors = 0;

  const fail = (): never => { throw new TomlError(); };

  const skipInlineWs = (): void => {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9) i++;
      else break;
    }
  };
  const skipComment = (): void => {
    if (src.charCodeAt(i) === 35) {
      while (i < n && src.charCodeAt(i) !== 10) i++;
    }
  };
  const skipTrivia = (): void => {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else if (c === 35) skipComment();
      else break;
    }
  };
  const expectEol = (): void => {
    skipInlineWs();
    skipComment();
    if (i >= n) return;
    if (src.charCodeAt(i) === 13 && src.charCodeAt(i + 1) === 10) i++;
    if (src.charCodeAt(i) !== 10) fail();
    i++;
  };

  const hex = (len: number): string => {
    const h = src.slice(i, i + len);
    if (h.length !== len || !/^[0-9A-Fa-f]+$/.test(h)) fail();
    const cp = parseInt(h, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail();
    i += len;
    return String.fromCodePoint(cp);
  };

  /** After a backslash inside a basic string. */
  const escape = (multiline: boolean): string => {
    const c = src[i++];
    switch (c) {
      case "b": return "\b";
      case "t": return "\t";
      case "n": return "\n";
      case "f": return "\f";
      case "r": return "\r";
      case '"': return '"';
      case "\\": return "\\";
      case "e": return "\u001b"; // TOML 1.1
      case "x": return hex(2); // TOML 1.1
      case "u": return hex(4);
      case "U": return hex(8);
      default:
        if (multiline && (c === " " || c === "\t" || c === "\n" || c === "\r")) {
          // line-ending backslash: swallow whitespace up to and including the newline, and any whitespace after it
          i--;
          let j = i;
          while (j < n && (src[j] === " " || src[j] === "\t")) j++;
          if (src[j] === "\r" && src[j + 1] === "\n") j++;
          if (src[j] !== "\n") fail();
          j++;
          while (j < n && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j++;
          i = j;
          return "";
        }
        return fail();
    }
  };

  const basicString = (): string => {
    // at opening quote
    if (src.startsWith('"""', i)) {
      i += 3;
      if (src[i] === "\r" && src[i + 1] === "\n") i += 2;
      else if (src[i] === "\n") i++;
      let out = "";
      for (;;) {
        if (i >= n) fail();
        const ch = src[i]!;
        if (ch === '"') {
          let q = 0;
          while (src[i + q] === '"') q++;
          if (q >= 3) {
            if (q > 5) fail();
            out += '"'.repeat(q - 3);
            i += q;
            return out;
          }
          out += ch;
          i++;
        } else if (ch === "\\") {
          i++;
          out += escape(true);
        } else {
          out += ch;
          i++;
        }
      }
    }
    i++;
    let out = "";
    for (;;) {
      if (i >= n) fail();
      const ch = src[i]!;
      if (ch === '"') { i++; return out; }
      if (ch === "\n") fail();
      if (ch === "\\") { i++; out += escape(false); continue; }
      out += ch;
      i++;
    }
  };

  const literalString = (): string => {
    if (src.startsWith("'''", i)) {
      i += 3;
      if (src[i] === "\r" && src[i + 1] === "\n") i += 2;
      else if (src[i] === "\n") i++;
      const end = src.indexOf("'''", i);
      if (end < 0) fail();
      let close = end;
      while (src[close + 3] === "'" && close - end < 2) close++;
      const out = src.slice(i, close);
      i = close + 3;
      return out;
    }
    i++;
    const start = i;
    while (i < n && src[i] !== "'" && src[i] !== "\n") i++;
    if (src[i] !== "'") fail();
    const out = src.slice(start, i);
    i++;
    return out;
  };

  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipInlineWs();
      const c = src[i];
      if (c === '"') {
        if (src.startsWith('"""', i)) fail();
        parts.push(basicString());
      } else if (c === "'") {
        if (src.startsWith("'''", i)) fail();
        parts.push(literalString());
      } else {
        const start = i;
        while (i < n && /[A-Za-z0-9_-]/.test(src[i]!)) i++;
        if (i === start) fail();
        parts.push(src.slice(start, i));
      }
      skipInlineWs();
      if (src[i] === ".") { i++; continue; }
      return parts;
    }
  };

  const value = (depth: number): TomlValue => {
    if (depth > MAX_DEPTH) fail();
    const c = src[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === "[") {
      i++;
      const arr: TomlValue[] = [];
      for (;;) {
        skipTrivia();
        if (src[i] === "]") { i++; return arr; }
        arr.push(value(depth + 1));
        skipTrivia();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "]") { i++; return arr; }
        fail();
      }
    }
    if (c === "{") {
      i++;
      const t = newTable();
      for (;;) {
        skipTrivia();
        if (src[i] === "}") { i++; return t; }
        const k = key();
        skipInlineWs();
        if (src[i] !== "=") fail();
        i++;
        skipInlineWs();
        setPath(t, k, value(depth + 1));
        skipTrivia();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "}") { i++; return t; }
        fail();
      }
    }
    return scalar();
  };

  const scalar = (): TomlValue => {
    DATETIME.lastIndex = i;
    const d = DATETIME.exec(src);
    if (d) { i += d[0].length; return d[0]; }
    TIME.lastIndex = i;
    const t = TIME.exec(src);
    if (t) { i += t[0].length; return t[0]; }
    const start = i;
    while (i < n && !/[,\]}\s#]/.test(src[i]!)) i++;
    const tok = src.slice(start, i);
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (INT.test(tok) || FLOAT.test(tok) || RADIX.test(tok)) {
      const num = Number(tok.replace(/_/g, ""));
      return Number.isFinite(num) ? num : 0;
    }
    if (SPECIAL.test(tok)) return 0;
    return fail();
  };

  /** Descend through `keys` (creating implicit tables); arrays of tables resolve to their last element. */
  const descend = (from: TomlTable, keys: string[]): TomlTable => {
    let cur = from;
    for (const k of keys) {
      const child = cur[k];
      if (child === undefined) {
        const t = newTable();
        cur[k] = t;
        cur = t;
      } else if (isTable(child)) {
        cur = child;
      } else if (Array.isArray(child) && arrayTables.has(child) && isTable(child[child.length - 1])) {
        cur = child[child.length - 1] as TomlTable;
      } else {
        fail();
      }
    }
    return cur;
  };

  const setPath = (table: TomlTable, keys: string[], v: TomlValue): void => {
    const parent = descend(table, keys.slice(0, -1));
    const last = keys[keys.length - 1]!;
    if (last in parent) fail();
    parent[last] = v;
  };

  const openTable = (keys: string[]): TomlTable => {
    const parent = descend(root, keys.slice(0, -1));
    const last = keys[keys.length - 1]!;
    const existing = parent[last];
    if (existing === undefined) {
      const t = newTable();
      parent[last] = t;
      explicit.add(t);
      return t;
    }
    if (isTable(existing) && !explicit.has(existing)) {
      explicit.add(existing);
      return existing;
    }
    return fail();
  };

  const appendArrayTable = (keys: string[]): TomlTable => {
    const parent = descend(root, keys.slice(0, -1));
    const last = keys[keys.length - 1]!;
    let arr = parent[last];
    if (arr === undefined) {
      const fresh: TomlValue[] = [];
      arrayTables.add(fresh);
      parent[last] = fresh;
      arr = fresh;
    }
    if (!Array.isArray(arr) || !arrayTables.has(arr)) return fail();
    const t = newTable();
    explicit.add(t);
    arr.push(t);
    return t;
  };

  let current = root;
  while (errors < MAX_ERRORS) {
    skipTrivia();
    if (i >= n) break;
    const stmtStart = i;
    try {
      if (src[i] === "[") {
        const isArr = src[i + 1] === "[";
        i += isArr ? 2 : 1;
        const keys = key();
        skipInlineWs();
        if (src[i] !== "]") fail();
        i++;
        if (isArr) {
          if (src[i] !== "]") fail();
          i++;
        }
        expectEol();
        current = isArr ? appendArrayTable(keys) : openTable(keys);
      } else {
        const k = key();
        skipInlineWs();
        if (src[i] !== "=") fail();
        i++;
        skipInlineWs();
        const v = value(0);
        expectEol();
        setPath(current, k, v);
      }
    } catch (e) {
      if (!(e instanceof TomlError)) throw e;
      errors++;
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      if (i <= stmtStart) i = stmtStart + 1;
    }
  }
  if (errors >= MAX_ERRORS && i < n) errors++;
  return { root, errors };
}
