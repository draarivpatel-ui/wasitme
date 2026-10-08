import type { AgentId, HashFn } from "../../types.js";
import { shortHash } from "./labels.js";
import { listMarkedChildren } from "./safefs.js";
import type { ReadOutcome } from "./safefs.js";
import type { Ctx, Diagnostic, FileState, Items, SourceId } from "./types.js";

/** Per-group cap on hashed names kept in a snapshot (the count is always exact). */
export const MAX_NAMES = 200;

export interface AgentCollect {
  found: boolean;
  items: Items;
  diagnostics: Diagnostic[];
}

/** Accumulates one agent's items and per-source diagnostics. A source is recorded as a whole or not at all. */
export class Collector {
  readonly items: Items = {};
  readonly diagnostics: Diagnostic[] = [];
  readonly hash: HashFn;

  constructor(readonly agent: AgentId, readonly ctx: Ctx) {
    this.hash = ctx.hash;
  }

  note(source: SourceId, state: FileState): void {
    this.diagnostics.push({ agent: this.agent, source, state });
  }

  put(items: Items): void {
    Object.assign(this.items, items);
  }

  /** CLAUDE.md / AGENTS.md: hash + size + lines (see instructionItems). */
  instructions(out: ReadOutcome): void {
    const r = instructionItems(out, this.hash);
    if (r.items) this.put(r.items);
    this.note("instructions", r.state);
  }

  /** `<dir>/<name>/SKILL.md` directories → skills.{count,name.*}. A missing directory is a definitive zero. */
  skills(dir: string): void {
    const sk = listMarkedChildren(dir, "SKILL.md", this.ctx.guard);
    if (sk.access === "missing") {
      this.put(nameItems("skills", [], this.hash));
      this.note("skills", "missing");
    } else if (sk.access !== "ok") {
      this.note("skills", sk.access);
    } else {
      this.put(nameItems("skills", sk.names, this.hash));
      this.note("skills", sk.partial ? "partial" : "ok");
    }
  }

  done(found: boolean): AgentCollect {
    return { found, items: this.items, diagnostics: this.diagnostics };
  }
}

export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

/**
 * Items for an instructions file (CLAUDE.md / AGENTS.md): salted hash of the bytes read, real size,
 * line count. Content never leaves this function. Returns no items when the state is unknown.
 */
export function instructionItems(out: ReadOutcome, hash: HashFn): { items?: Items; state: FileState } {
  if (out.access === "missing") return { items: { "instructions.present": false }, state: "missing" };
  if (out.access !== "ok" || !out.buf) return { state: out.access };
  const items: Items = {
    "instructions.present": true,
    // latin1 maps bytes 1:1 to code points, so every distinct byte sequence hashes differently.
    "instructions.hash": shortHash(hash, out.buf.toString("latin1")),
    "instructions.bytes": out.size,
  };
  if (out.capped) items["instructions.capped"] = true;
  else items["instructions.lines"] = countLines(out.buf);
  return { items, state: out.capped ? "capped" : "ok" };
}

/** `<prefix>.count` (exact) and `<prefix>.name.<h:hash>` = true for up to MAX_NAMES hashed names. */
export function nameItems(prefix: string, names: Iterable<string>, hash: HashFn): Items {
  const uniq = [...new Set(names)];
  const hashed = [...new Set(uniq.map((n) => shortHash(hash, n)))].sort().slice(0, MAX_NAMES);
  const items: Items = { [`${prefix}.count`]: uniq.length };
  for (const h of hashed) items[`${prefix}.name.${h}`] = true;
  return items;
}

/** Decode config text. A UTF-8 BOM is dropped (JSON.parse rejects it). */
export function decodeText(buf: Buffer): string {
  const s = buf.toString("utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** JSON.parse that returns undefined instead of throwing (malformed, or nested deeply enough to exhaust the stack). */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
