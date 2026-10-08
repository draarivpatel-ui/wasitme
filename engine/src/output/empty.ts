/**
 * What to say when there is nothing to show: one sentence that names the actual reason (no results file yet, a
 * damaged or other-version file, logs not found, logs not readable) and the one command that helps. Shared by the
 * terminal report, `wasitme report` and `wasitme status`, so every surface gives the same answer as `wasitme doctor`.
 *
 * Log locations are named the way the user configures them — "~/.claude", or the environment variable that moved it
 * ("CLAUDE_CONFIG_DIR") — never as a path.
 */
import type { ReportDoc } from "./doc.js";

/** How each agent's log folder is named in messages: its default ("~/.claude") or the variable that set it. */
export interface RootLabels { claude: string; codex: string }

export const DEFAULT_ROOTS: Readonly<RootLabels> = Object.freeze({ claude: "~/.claude", codex: "~/.codex" });

const set = (v: string | undefined): boolean => typeof v === "string" && v.trim() !== "";

/**
 * The readers' own precedence (readers/claude.ts, readers/codex.ts), as names only: "~/.claude", or "$CLAUDE_CONFIG_DIR"
 * (the folder that variable names) when it moved the logs.
 */
export function rootLabels(env: Readonly<Record<string, string | undefined>>): RootLabels {
  return {
    claude: set(env.WASITME_CLAUDE_DIR) ? "$WASITME_CLAUDE_DIR" : set(env.CLAUDE_CONFIG_DIR) ? "$CLAUDE_CONFIG_DIR" : DEFAULT_ROOTS.claude,
    codex: set(env.WASITME_CODEX_DIR) ? "$WASITME_CODEX_DIR" : set(env.CODEX_HOME) ? "$CODEX_HOME" : DEFAULT_ROOTS.codex,
  };
}

const AGENT: Readonly<Record<string, { name: string; root: keyof RootLabels }>> = {
  "claude-code": { name: "Claude Code", root: "claude" },
  codex: { name: "Codex", root: "codex" },
};

const PROBLEM: Readonly<Record<string, string>> = {
  permission_denied: "permission denied",
  protected_folder: "macOS privacy protection",
  unreadable: "unreadable",
};

/** Why an empty document is empty, as `kind` (for scripts) and one sentence (for people). */
export function emptyReason(doc: ReportDoc, roots: RootLabels = DEFAULT_ROOTS): { kind: "mismatch" | "refused" | "no_results" | "damaged" | "unreadable_logs" | "no_logs"; text: string } {
  if (doc.display === "mismatch") {
    return { kind: "mismatch", text: "The results file was written by a different version of wasitme. Run: wasitme scan. If this comes back, parts of wasitme are out of sync: update it so every part is the same version (wasitme update shows how)." };
  }
  if (doc.display === "refused") return { kind: "refused", text: "This file does not promise that it holds numbers only, so wasitme will not show it." };
  if (doc.file === "missing") return { kind: "no_results", text: "No results yet. Run: wasitme scan" };
  if (doc.file === "damaged") return { kind: "damaged", text: "The results file is damaged. Run: wasitme scan (wasitme doctor shows what is wrong)." };
  const unreadable = doc.sources.filter((s) => s.error !== null && s.error !== "not_found" && AGENT[s.agent] !== undefined);
  if (unreadable.length > 0) {
    const parts = unreadable.map((s) => `${AGENT[s.agent]!.name} logs in ${roots[AGENT[s.agent]!.root]} (${PROBLEM[s.error!] ?? "unreadable"})`);
    return { kind: "unreadable_logs", text: `wasitme could not read ${parts.join(" or ")}. Run: wasitme doctor` };
  }
  return {
    kind: "no_logs",
    text: `No Claude Code or Codex logs found in ${roots.claude} or ${roots.codex}. Logs somewhere else? Set CLAUDE_CONFIG_DIR or CODEX_HOME to their folder, or run: wasitme doctor`,
  };
}

/**
 * Why one known agent is missing from results that hold another (the Codex skill asks for `report --agent codex` on a
 * machine whose results hold only Claude Code, say): one sentence naming where wasitme looks for that agent's logs and
 * the one command that helps. Undefined for an id wasitme does not know (that stays a usage error).
 */
export function agentMissingReason(doc: ReportDoc, agent: string, roots: RootLabels = DEFAULT_ROOTS): string | undefined {
  if (!Object.hasOwn(AGENT, agent)) return undefined;
  const { name, root } = AGENT[agent]!;
  const problem = doc.sources.find((s) => s.agent === agent && s.error !== null && s.error !== "not_found");
  if (problem !== undefined) return `wasitme could not read ${name} logs in ${roots[root]} (${PROBLEM[problem.error!] ?? "unreadable"}). Run: wasitme doctor`;
  const variable = root === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  return `No ${name} sessions in the results yet, so there is nothing to show for ${name}. wasitme looks for ${name} logs in ${roots[root]}. Logs somewhere else? Set ${variable} to their folder, or run: wasitme doctor`;
}
