/**
 * Setup state visible in Claude Code attachments: MCP servers, skills, system prompt.
 * Names and prompt text live in memory only; callers export salted hashes and counts.
 */
import { obj } from "../../util.js";
import { str, type Rec } from "./records.js";

/** Claude Code's MCP tool-name normalisation, so "claude.ai Gmail" and "claude_ai_Gmail" match. */
function norm(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function serverNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const n = typeof x === "string" ? x : str(obj(x)?.name);
    if (n) out.push(norm(n));
  }
  return out;
}

/** "mcp__<server>__<tool>" → "<server>". */
function serverOfTool(tool: string): string | undefined {
  if (!tool.startsWith("mcp__")) return undefined;
  const rest = tool.slice(5);
  const end = rest.indexOf("__");
  const server = end === -1 ? rest : rest.slice(0, end);
  return server ? norm(server) : undefined;
}

/**
 * MCP servers an attachment shows as configured — connected (it announces their tools), still
 * connecting, needing auth, failed, or carrying instructions. Undefined for other attachments.
 * Removals are deliberately not returned: inside a session a server dropping out is
 * indistinguishable from a disconnect, which real logs show constantly.
 */
export function mcpServersIn(a: Rec): string[] | undefined {
  if (a.type === "deferred_tools_delta") {
    const out = [...serverNames(a.pendingMcpServers), ...serverNames(a.needsAuthMcpServers), ...serverNames(a.failedMcpServers)];
    for (const t of [...strings(a.addedNames), ...strings(a.readdedNames)]) {
      const s = serverOfTool(t);
      if (s) out.push(s);
    }
    return out;
  }
  if (a.type === "mcp_instructions_delta") return serverNames(a.addedNames);
  return undefined;
}

/** Skill names a `skill_listing` attachment announces (initial listing or later additions). */
export function skillsIn(a: Rec): string[] | undefined {
  if (a.type !== "skill_listing" || !Array.isArray(a.names)) return undefined;
  return strings(a.names);
}

/** A set that only grows (everything seen so far in the session). */
export class SeenSet {
  private items = new Set<string>();
  get size(): number {
    return this.items.size;
  }
  /** Adds names; returns how many were new. */
  add(names: readonly string[]): number {
    let added = 0;
    for (const n of names) {
      if (!this.items.has(n)) {
        this.items.add(n);
        added++;
      }
    }
    return added;
  }
  /** Stable text form for hashing (in memory only). */
  key(): string {
    return [...this.items].sort().join("\n");
  }
}

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

/**
 * Normalised system prompt text from a `prompt_snapshot` attachment, for hashing in memory.
 * The working directory and calendar dates are masked so a new day or project folder is not
 * mistaken for a system-prompt change.
 */
export function systemPromptText(a: Rec, cwd: string | undefined): string | undefined {
  if (a.type !== "prompt_snapshot" || !Array.isArray(a.systemPrompt)) return undefined;
  const parts: string[] = [];
  for (const p of a.systemPrompt) {
    const t = typeof p === "string" ? p : str(obj(p)?.text);
    if (t === undefined) continue;
    let s = cwd ? t.split(cwd).join("<cwd>") : t;
    s = s.replace(ISO_DATE, "<date>");
    parts.push(s);
  }
  return parts.length ? parts.join("\u0001") : undefined;
}
