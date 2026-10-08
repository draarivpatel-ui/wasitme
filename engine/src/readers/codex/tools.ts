/**
 * Tool calls from the three shapes Codex has used: paginated `item_completed` items, legacy
 * `*_end` events, and (oldest) bare response_item calls. Paths are normalised for read-before-edit
 * matching and kept in memory only.
 *
 * Tool-error split (METHOD.md §3): a call is `cmd` when it runs a shell command (CommandExecution, exec_command_end,
 * local_shell_call, shell-type function calls) and its failure is a non-zero exit; every other call is `other`
 * (FileChange / patch apply, McpToolCall, collab, extensions, …). A user-declined call is a rejection, never an error.
 */
import { obj } from "../../util.js";
import { COMMAND_FUNCTIONS, DECLINED, READ_CMDS } from "./known.js";
import type { EditPath, ToolEvent } from "./model.js";

export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Did a read of `read` (absolute, or relative to some cwd) cover the edited absolute/relative `edit` path? */
export function samePath(read: string, edit: string): boolean {
  if (!read || !edit) return false;
  if (read === edit) return true;
  if (read.startsWith("/") || /^[A-Za-z]:\//.test(read)) return false;
  return edit.endsWith("/" + read);
}

function parsedCmd(v: unknown): { read: boolean; readPaths: string[] } {
  if (!Array.isArray(v) || v.length === 0) return { read: false, readPaths: [] };
  const readPaths: string[] = [];
  let allRead = true;
  for (const c of v) {
    const o = obj(c);
    const t = typeof o?.type === "string" ? o.type : "";
    if (!READ_CMDS.has(t)) allRead = false;
    if (t === "read" && typeof o?.path === "string") readPaths.push(normPath(o.path));
  }
  return { read: allRead, readPaths };
}

/** `changes` map ({path: {type: add|update|delete, …}}) of FileChange items / patch events. */
function changeMap(v: unknown): EditPath[] {
  const m = obj(v);
  if (!m) return [];
  const out: EditPath[] = [];
  for (const [path, change] of Object.entries(m)) {
    const c = obj(change);
    const kind = typeof c?.type === "string" ? c.type : c ? Object.keys(c)[0] : undefined;
    out.push({ path: normPath(path), isNew: kind === "add" });
  }
  return out;
}

const empty = (kind: ToolEvent["kind"] = "other"): ToolEvent => ({ kind, failed: false, rejected: false, read: false, readPaths: [], edits: [] });

const nonZeroExit = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v !== 0;

function statusOf(v: unknown): Pick<ToolEvent, "failed" | "rejected"> {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (DECLINED.has(s)) return { failed: false, rejected: true };
  return { failed: s === "failed" || s === "error", rejected: false };
}

/** A paginated tool item (CommandExecution, FileChange, McpToolCall, …). */
export function fromItem(item: Record<string, unknown>): ToolEvent {
  const ev: ToolEvent = { ...empty(), ...statusOf(item.status) };
  if (item.type === "CommandExecution") {
    ev.kind = "cmd";
    Object.assign(ev, parsedCmd(item.parsed_cmd));
    // A command failure is a non-zero exit, whatever status the client wrote next to it.
    if (!ev.rejected && nonZeroExit(item.exit_code)) ev.failed = true;
  }
  if (item.type === "FileChange") {
    ev.edits = changeMap(item.changes);
    if (!ev.edits.length) ev.edits = [{ path: "", isNew: false }];
  }
  return ev;
}

/** Legacy `*_end` events; `begin` is the matching `*_begin` payload (by call_id), if any. */
export function fromEndEvent(sub: string, p: Record<string, unknown>, begin?: Record<string, unknown>): ToolEvent {
  const ev = empty();
  if (sub === "exec_command_end") {
    ev.kind = "cmd";
    Object.assign(ev, parsedCmd(p.parsed_cmd ?? begin?.parsed_cmd));
    ev.failed = nonZeroExit(p.exit_code);
  } else if (sub === "patch_apply_end") {
    ev.edits = changeMap(p.changes ?? begin?.changes);
    if (!ev.edits.length) ev.edits = [{ path: "", isNew: false }];
    ev.failed = p.success === false;
  } else if (sub === "mcp_tool_call_end") {
    const r = obj(p.result);
    ev.failed = Boolean(r && (Object.hasOwn(r, "Err") || obj(r.Ok)?.isError === true || obj(r.Ok)?.is_error === true));
  }
  return ev;
}

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
const FAILED_OUTPUT = /Script failed|Process exited with code [1-9]|Exit code: [1-9]|"exit_code":\s*[1-9]/;

/** Oldest legacy shape: a response_item call (outputs are matched later by call_id). */
export function fromResponseCall(p: Record<string, unknown>): ToolEvent {
  const name = typeof p.name === "string" ? p.name : "";
  const ev = empty(p.type === "local_shell_call" || COMMAND_FUNCTIONS.has(name) ? "cmd" : "other");
  if (name === "apply_patch") {
    const input = typeof p.input === "string" ? p.input : typeof p.arguments === "string" ? p.arguments : "";
    for (const m of input.matchAll(PATCH_FILE)) ev.edits.push({ path: normPath(m[2]!.trim()), isNew: m[1] === "Add" });
    if (!ev.edits.length) ev.edits = [{ path: "", isNew: false }];
  }
  return ev;
}

/** Does a response_item call output read like a failure? (Looks at the first 2,000 chars, in memory.) */
export function outputFailed(p: Record<string, unknown>): boolean {
  const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
  return FAILED_OUTPUT.test(out.slice(0, 2000));
}
