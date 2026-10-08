/**
 * Builder for 100% SYNTHETIC Claude Code session logs (nothing here is copied or derived from real
 * logs). Shapes follow the field names a counts-only check of real logs found (names and enums only).
 * Tests write the records into a temp tree and point WASITME_CLAUDE_DIR at it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeReader } from "../../../src/readers/claude.js";
import type { ParseContext, ParseResult, Source } from "../../../src/types.js";
import { makeHash } from "../../../src/util.js";
import { tempDir } from "../temp.js";

export type Rec = Record<string, unknown>;

export const NOW = new Date("2026-10-04T12:00:00.000Z");
export const hash = makeHash("synthetic-test-salt");
export const ctx: ParseContext = { hash, now: NOW, timeZone: "UTC" };

export interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

export const text = (t: string): Rec => ({ type: "text", text: t });
export const thinking = (t: string, signature: string): Rec => ({ type: "thinking", thinking: t, signature });
export const toolUseBlock = (id: string, name: string, input: Rec = {}): Rec => ({ type: "tool_use", id, name, input });
export const image = (): Rec => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });

export class SessionBuilder {
  readonly records: Rec[] = [];
  private n = 0;
  private ms: number;
  private req = 0;
  version: string;
  cwd: string;
  entrypoint: string;

  constructor(readonly id: string, opts: { start?: string; version?: string; cwd?: string; entrypoint?: string } = {}) {
    this.ms = Date.parse(opts.start ?? "2026-09-01T10:00:00.000Z");
    this.version = opts.version ?? "2.1.250";
    this.cwd = opts.cwd ?? "/synthetic/home/project-alpha";
    this.entrypoint = opts.entrypoint ?? "cli";
  }

  /** Advance the clock by `sec` seconds (negative = clock went backward) and return the ISO time. */
  tick(sec = 1): string {
    this.ms += sec * 1000;
    return this.now();
  }
  now(): string {
    return new Date(this.ms).toISOString();
  }
  setTime(iso: string): void {
    this.ms = Date.parse(iso);
  }
  uuid(): string {
    return `${this.id}-u${String(++this.n).padStart(5, "0")}`;
  }

  private base(type: string, extra: Rec = {}): Rec {
    return {
      parentUuid: null, isSidechain: false, userType: "external", cwd: this.cwd, sessionId: this.id,
      version: this.version, entrypoint: this.entrypoint, gitBranch: "main", type, uuid: this.uuid(),
      timestamp: this.tick(), ...extra,
    };
  }

  push(r: Rec): Rec {
    this.records.push(r);
    return r;
  }

  /** A real human prompt (modern logs: origin.kind = "human"). */
  prompt(content: string | Rec[], extra: Rec = {}): Rec {
    return this.push(this.base("user", { message: { role: "user", content }, origin: { kind: "human" }, promptSource: "sdk", permissionMode: "default", ...extra }));
  }

  /** A user record without origin (pre-origin logs or Claude-injected text). */
  user(content: string | Rec[], extra: Rec = {}): Rec {
    return this.push(this.base("user", { message: { role: "user", content }, ...extra }));
  }

  toolResult(toolUseId: string, opts: { isError?: boolean; content?: string; denial?: string; toolUseResult?: unknown; extra?: Rec } = {}): Rec {
    const block: Rec = { type: "tool_result", tool_use_id: toolUseId, content: opts.content ?? "synthetic tool output" };
    if (opts.isError !== undefined) block.is_error = opts.isError;
    const extra: Rec = { toolUseResult: opts.toolUseResult ?? "synthetic", ...(opts.extra ?? {}) };
    if (opts.denial) extra.toolDenialKind = opts.denial;
    return this.push(this.base("user", { message: { role: "user", content: [block] }, ...extra }));
  }

  /** One model response written as one line per content block (Claude Code streaming split). */
  response(blocks: Rec[], opts: { model?: string; usage?: Usage; outPerLine?: number[]; requestId?: string | null; msgId?: string; effort?: string; extra?: Rec } = {}): string {
    const n = ++this.req;
    const requestId = opts.requestId === undefined ? `req_${this.id}_${n}` : opts.requestId;
    const msgId = opts.msgId ?? `msg_${this.id}_${n}`;
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, ...(opts.usage ?? {}) };
    const lines = blocks.length ? blocks : [text("ok")];
    lines.forEach((b, i) => {
      const out = opts.outPerLine?.[i] ?? usage.output_tokens;
      const rec = this.base("assistant", {
        message: { id: msgId, type: "message", role: "assistant", model: opts.model ?? "claude-sonnet-5", content: [b], stop_reason: null, usage: { ...usage, output_tokens: out } },
        effort: opts.effort ?? "high",
        ...(opts.extra ?? {}),
      });
      if (requestId !== null) rec.requestId = requestId;
      this.push(rec);
    });
    return msgId;
  }

  apiErrorMessage(textValue = "API Error: 529 overloaded", extra: Rec = {}): Rec {
    return this.push(this.base("assistant", {
      message: { id: `msg_err_${this.n}`, type: "message", role: "assistant", model: "<synthetic>", content: [text(textValue)], usage: { input_tokens: 0, output_tokens: 0 } },
      isApiErrorMessage: true, ...extra,
    }));
  }

  system(subtype: string, extra: Rec = {}): Rec {
    return this.push(this.base("system", { subtype, level: "info", ...extra }));
  }

  attachment(attachment: Rec, extra: Rec = {}): Rec {
    return this.push(this.base("attachment", { attachment, ...extra }));
  }

  queueOp(operation: string, content?: string, extra: Rec = {}): Rec {
    const r: Rec = { type: "queue-operation", operation, timestamp: this.tick(), sessionId: this.id, ...extra };
    if (content !== undefined) r.content = content;
    return this.push(r);
  }

  /** Metadata record without uuid/timestamp (ai-title, mode, permission-mode, relocated, …). */
  meta(type: string, extra: Rec = {}): Rec {
    return this.push({ type, sessionId: this.id, ...extra });
  }
}

/** Copy records as a resumed session would replay them: same uuid/timestamp, sessionId rewritten. */
export function replayInto(target: SessionBuilder, records: readonly Rec[]): void {
  for (const r of records) target.push({ ...r, sessionId: target.id });
}

export function makeRoot(): string {
  return tempDir("wasitme-claude-");
}

export function writeJsonl(path: string, records: readonly (Rec | string)[], trailingNewline = true): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
  writeFileSync(path, body + (trailingNewline && records.length ? "\n" : ""));
  return path;
}

export function projectPath(root: string, project: string): string {
  return join(root, "projects", project);
}

/** Write a session's main transcript at <root>/projects/<project>/<id>.jsonl. */
export function writeSession(root: string, project: string, s: SessionBuilder): string {
  return writeJsonl(join(projectPath(root, project), `${s.id}.jsonl`), s.records);
}

/** Run `fn` with WASITME_CLAUDE_DIR pointing at `root` (never the real ~/.claude). */
export async function withRoot<T>(root: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.WASITME_CLAUDE_DIR;
  process.env.WASITME_CLAUDE_DIR = root;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.WASITME_CLAUDE_DIR;
    else process.env.WASITME_CLAUDE_DIR = prev;
  }
}

/** Sleep briefly so consecutive files get distinct creation times. */
export function pause(ms = 15): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface Scanned { key: string; source: Source; result: ParseResult }

/** list() + parse() every source under `root`, keyed by "<project>/<session>.jsonl". */
export async function scan(root: string): Promise<Map<string, Scanned>> {
  return withRoot(root, async () => {
    const out = new Map<string, Scanned>();
    for (const source of claudeReader.list()) out.set(source.key, { key: source.key, source, result: await claudeReader.parse(source, ctx) });
    return out;
  });
}

/** Scan a root holding exactly one session and return its result. */
export async function scanOne(root: string): Promise<ParseResult> {
  const all = [...(await scan(root)).values()];
  if (all.length !== 1) throw new Error(`expected one source, found ${all.length}`);
  return all[0]!.result;
}

/** Write a single session into a fresh root and parse it. */
export async function parseSession(s: SessionBuilder, project = "-synthetic-home-project-alpha"): Promise<ParseResult> {
  const root = makeRoot();
  writeSession(root, project, s);
  return scanOne(root);
}
