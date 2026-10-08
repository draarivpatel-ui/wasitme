/**
 * Claude Code reader: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl plus subagent transcripts.
 * Root: WASITME_CLAUDE_DIR, else CLAUDE_CONFIG_DIR, else ~/.claude (empty values count as unset).
 * Implementation lives in ./claude/ (listing, record classifiers, dedupe, subagents, events).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Reader } from "../types.js";
import { listSources } from "./claude/list.js";
import { parseSource } from "./claude/parse.js";

export { CLAUDE_FIELD_FAMILY, CLAUDE_PARSER_VERSIONS, type ClaudeParserFamily } from "./claude/versions.js";

function envDir(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v : undefined;
}

export function claudeRoot(): string {
  return envDir("WASITME_CLAUDE_DIR") ?? envDir("CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude");
}

export const claudeReader: Reader = {
  agent: "claude-code",
  root: () => join(claudeRoot(), "projects"),
  list: () => listSources(join(claudeRoot(), "projects")),
  parse: (source, ctx) => parseSource(source, ctx),
};
