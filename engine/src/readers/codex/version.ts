/**
 * Codex parser versions, per metric family (METHOD.md §9 "Format drift"). WP-12 stores these with
 * history and re-derives a family from the source logs when its number moves (and pauses the family's metrics with
 * `parser_changed` only where the history predates the oldest source log). Bump a family whenever what the reader
 * writes for it changes meaning — never for refactors that keep every output identical.
 *
 * The family NAMES are the same in both readers (WP-12 alignment, D51): exchanges, toolErrors, research, friction,
 * context, labels, interactive, events — so `snapshot.health.parserVersions` (one map, keys
 * ^[A-Za-z][A-Za-z0-9]{0,31}$) can speak for both agents. Which fields each family owns is CODEX_FIELD_FAMILY:
 *  - exchanges: what one exchange is (real human prompt vs injected context / imports / automation triggers),
 *    `humanPrompt`, `seq`, `t`, `day`, ids — a change here moves every metric (re-derive everything);
 *  - toolErrors: `toolCalls`, `toolErrors`, `toolErrorsCmd`, `toolErrorsEdit`, `cmdCalls`, `rejections`, `blocked`;
 *  - research: `reads`, `edits`, `blindEdits`, `churned`, and the attributed subagents' `subReads`, `subEdits`,
 *    `subBlindEdits` (D62a);
 *  - friction: `interrupted`, `pushback`, `queuedMidTurn`, `promptEnglish`;
 *  - context: steps, tokens, compactions, thinking, API errors/retries, `sub*`, `durationMs`;
 *  - labels: version / model / effort / mode / entrypoint / provider labels;
 *  - interactive: the session classifier (`interactiveClass`, METHOD.md §2);
 *  - events: ChangeEvent kinds, sides, strengths and provenance.
 * All start at 1: nothing was persisted before WP-12.
 */
import type { Exchange } from "../../types.js";

export const CODEX_PARSER_VERSIONS = Object.freeze({
  exchanges: 1,
  toolErrors: 1,
  // 2 (D62a): child threads attributed with evidence (D39) also fill subReads / subEdits / subBlindEdits, which the
  // research metrics count with the main thread's reads / edits.
  research: 2,
  // 2 (0.1.1 bug-hunt): promptEnglish ignores sentence punctuation at the end of a word, so a one-word prompt like
  // "Continue." is English instead of unknown. Stored shards re-derive the family from the logs that still exist.
  friction: 2,
  // 2 (0.1.1 bug hunt): `durationMs` is measured over the exchange's records in file order with the Claude reader's
  // SpanClock, so a clock reset or a corrected excursion mid-exchange no longer counts as time (it was max minus min).
  context: 2,
  // 2 (WP-12 review): id-shaped model labels, effort and approval-policy enums, semver-like versions; event
  // from/to carry the same labels. Stored shards re-derive both families from the logs that still exist.
  labels: 2,
  interactive: 1,
  // 3 (0.1.1 bug hunt): a provider switch is dated and ordered by the session's first start time no later than now + 1
  // day (session_meta, else the leading records after it), so a session_meta stamped with the clock set ahead no
  // longer dates a you · strong switch in the future or hides the real switches around it.
  // 4 (0.1.1, same release): kept equal to the Claude reader's events version (4, D81) so the snapshot's
  // health.parserVersions reports one "events" key; it re-derives exactly what 3 would have.
  events: 4,
} as const);

export type CodexParserFamily = keyof typeof CODEX_PARSER_VERSIONS;

/** Which family owns each Exchange field (every field exactly once; `events` owns no Exchange field). */
export const CODEX_FIELD_FAMILY: Readonly<Record<keyof Exchange, CodexParserFamily>> = Object.freeze({
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
  provider: "labels",
  interactiveClass: "interactive",
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
