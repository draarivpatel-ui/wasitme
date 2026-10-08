/**
 * Per-family parser versions for the Claude Code reader (METHOD.md §9 "Format drift"), for WP-12's
 * fingerprints and re-derivation and the snapshot's `health.parserVersions`.
 *
 * Bump a family's number whenever the same log bytes would produce different values for any field in that family
 * (a definition change, a bug fix, a new record shape). WP-12 re-derives that family's fields from the source logs
 * where they still exist, and emits a `meta` comparability break only for history that predates them.
 *
 * Families (keys match the snapshot schema's `^[A-Za-z][A-Za-z0-9]{0,31}$`):
 *  - exchanges: what one exchange is (prompt filter, agent-initiated stretches, resume dedupe, ids). A bump here
 *    changes every family's denominators: re-derive everything.
 *  - toolErrors: tool calls and their outcomes, incl. the edit/command split (METHOD.md §3 errors family + cmdFailures).
 *  - research: reads, edits, blind edits, churn, and the attributed subagents' reads / edits / blind edits
 *    (METHOD.md §3 research family; D62a).
 *  - friction: interrupts, pushback, queued prompts (METHOD.md §3 friction family).
 *  - context: steps, tokens, API errors/retries, compactions, thinking, subagent context, duration.
 *  - labels: version/model/effort/mode/entrypoint labels (per-field shapes).
 *  - interactive: the session classifier (METHOD.md §2).
 *  - events: in-log ChangeEvents (side, strength, provenance, timing).
 */
import type { Exchange } from "../../types.js";

export const CLAUDE_PARSER_VERSIONS = Object.freeze({
  // 2 (D62b): a session that EnterWorktree moved (`relocated` records) keeps its ORIGINAL project id; `relocated` is
  // a known record type.
  exchanges: 2,
  toolErrors: 1,
  // 2 (D62a): attributed subagent work fills subReads / subEdits / subBlindEdits (counted by the research metrics).
  research: 2,
  friction: 1,
  // 2 (D62a): a subagent transcript's copies of main-thread records (fork-mode context) are no longer counted as
  // subagent work (subToolCalls / subTokens); orphaned subagent folders of a moved session are attached to it.
  context: 2,
  // 2 (WP-12 review): model ids accept only a Vertex date / @latest / @default suffix (Codex: id-shaped labels,
  // effort and approval-policy enums, semver-like versions); event from/to carry the same labels. Stored shards
  // re-derive both families from the logs that still exist.
  labels: 2,
  interactive: 1,
  // 3 (D63): a /model or /effort typed before the session's first response is a you · strong · command event (from
  // "unknown"). A resumed session whose first live model / effort differs from its replayed history starts on that
  // value (a between-session move: attribution/labels.ts derives it and ties it to the recorded command wherever it
  // was typed) — no in-session `unknown` event — unless a command in this file or at the end of the replay explains it;
  // such a command is a change even when it re-picks the replayed value (from "unknown").
  events: 3,
});

export type ClaudeParserFamily = keyof typeof CLAUDE_PARSER_VERSIONS;

/** Which family owns each Exchange field (every field exactly once; `events` owns no Exchange field). */
export const CLAUDE_FIELD_FAMILY: Readonly<Record<keyof Exchange, ClaudeParserFamily>> = Object.freeze({
  v: "exchanges",
  agent: "exchanges",
  id: "exchanges",
  session: "exchanges",
  project: "exchanges",
  t: "exchanges",
  day: "exchanges",
  seq: "exchanges",
  afterCompaction: "exchanges",
  promptChars: "exchanges",
  humanPrompt: "exchanges",
  version: "labels",
  model: "labels",
  servedModel: "labels",
  effort: "labels",
  mode: "labels",
  entrypoint: "labels",
  interactiveClass: "interactive",
  provider: "labels",
  interrupted: "friction",
  pushback: "friction",
  promptEnglish: "friction",
  queuedMidTurn: "friction",
  toolCalls: "toolErrors",
  toolErrors: "toolErrors",
  toolErrorsEdit: "toolErrors",
  toolErrorsCmd: "toolErrors",
  cmdCalls: "toolErrors",
  rejections: "toolErrors",
  blocked: "toolErrors",
  reads: "research",
  edits: "research",
  blindEdits: "research",
  churned: "research",
  subReads: "research",
  subEdits: "research",
  subBlindEdits: "research",
  steps: "context",
  outTok: "context",
  inTok: "context",
  cacheRead: "context",
  cacheWrite: "context",
  apiErrors: "context",
  apiRetries: "context",
  compactions: "context",
  thinkBlocks: "context",
  thinkRedacted: "context",
  thinkSigMedian: "context",
  subToolCalls: "context",
  subTokens: "context",
  durationMs: "context",
});
