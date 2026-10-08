/**
 * The agent-neutral "script" of a synthetic session: what the user typed, what the agent did, what
 * went wrong. The planner draws it once; the Claude and Codex renderers each turn it into their own
 * log format, and the truth file is computed from the same script, so the planted facts and the
 * emitted bytes cannot drift apart.
 */
import type { AgentEnv, AgentName, EventKind, RateKey } from "./params.js";
import type { ConfigState } from "./schedule.js";

export interface Usage { in: number; out: number; cacheRead: number; cacheWrite: number }

export type CallClass = "read" | "edit" | "other" | "spawn";
export type Outcome = "ok" | "error" | "rejected" | "blocked";
export type Denial = "user-rejected" | "automode-blocked" | "permission-rule" | "automode-unavailable";
export type ParsedKind = "read" | "search" | "list_files" | "unknown";

export interface Call {
  /** Seed for the tool-use / call id (rendered per agent). */
  id: string;
  cls: CallClass;
  /** Claude tool name; Codex derives its item type from `cls`. */
  tool: string;
  /** Project-relative path for reads/edits that name one. */
  file?: string;
  blind?: boolean;
  outcome: Outcome;
  denial?: Denial;
  execMs: number;
  cmd?: string;
  /** Codex read-class calls: how the command parses. */
  parsed?: ParsedKind;
  /** Codex other-class calls: an MCP tool call instead of a shell command. */
  mcp?: boolean;
  sub?: SubPlan;
}

export interface SubStep { rid: string; latencyMs: number; calls: Call[]; usage: Usage; text?: string }

export interface SubPlan {
  agentId: string;
  prompt: string;
  resultText: string;
  steps: SubStep[];
  /** Claude: put the file under subagents/workflows/<id>/ (with a journal) instead of subagents/. */
  workflow?: string;
}

export interface Thinking { chars: number; redacted: boolean; text: string }

export interface Step {
  /** Seed for requestId / response_id (rendered per agent). */
  rid: string;
  latencyMs: number;
  thinking?: Thinking;
  text?: string;
  calls: Call[];
  usage: Usage;
  retries: { status: number; retryInMs: number }[];
  /** The request ultimately failed: no assistant content, an API error surfaced instead. */
  failed?: boolean;
  /** A background-task notification precedes this step (it is NOT a human prompt). */
  afterNotification?: boolean;
  /** Claude: the response hit max_tokens. */
  maxTokens?: boolean;
  /** Claude: a "[Your previous response had no ...]" meta record precedes this step. */
  metaContinue?: boolean;
}

export interface QueuedPrompt {
  text: string;
  /** Delivered after step `afterStep` finished (so there is always a later step). */
  afterStep: number;
}

export interface Compaction { atStep: number; preTokens: number; postTokens: number; trigger: "auto" | "manual" }

export interface UserCommand {
  kind: Extract<EventKind, "model" | "effort" | "mode">;
  to: string;
  /** The schedule event this command evidences (its `commandAt` in the truth file is when it was typed). */
  eventId: string;
}

export interface Exchange {
  agent: AgentName;
  sessionIdx: number;
  seq: number;
  /** Day offset from startDay. */
  day: number;
  date: string;
  /** Absolute start (UTC ms) once placed. */
  startMs: number;
  human: boolean;
  prompt: string;
  /** Claude: deliver the prompt as a block list instead of a plain string. */
  promptAsBlocks: boolean;
  pushback: "none" | "phrase" | "dup";
  env: AgentEnv;
  config: ConfigState;
  /** User-typed slash commands (/model, /effort ...) evidencing a "you" change right before this prompt. */
  commands: UserCommand[];
  steps: Step[];
  queued: QueuedPrompt[];
  interrupt?: "text" | "tool-use";
  compaction?: Compaction;
  /** Non-human queued/peer noise records. */
  peerNoise: boolean;
  hookSummary: boolean;
  /** Codex: aborted for a non-user reason (counts as no interrupt). */
  otherAbort: boolean;
  /** > 0: the final record's timestamp is shifted back by this many ms (a clock reset). */
  glitchShiftMs: number;
  afterCompaction: boolean;
  // Small random gaps (ms), drawn at plan time so layout() is a pure function.
  interruptDelayMs: number;
  compactMs: number;
  notifDelayMs: number;
  tailMs: number;
  promptLeadMs: number;
}

export interface Session {
  idx: number;
  agent: AgentName;
  id: string;
  projectIdx: number;
  kind: "main" | "exec";
  startDay: number;
  /** Labels frozen at session start (Codex records the CLI version once). */
  startEnv: AgentEnv;
  exchanges: Exchange[];
  /** Per-session random effects (log scale), keyed by rate. */
  u: Partial<Record<RateKey, number>>;
  resumeOf?: number;
  /** Claude: how many of the previous session's last exchanges are replayed. */
  resumeReplay: number;
  forkOf?: number;
  forkMode?: "replay" | "history-base";
  forkReplay: number;
  /** Number of the parent's exchanges that existed when the fork happened. */
  forkAt: number;
  importStubs: number;
  migrated: boolean;
  legacy: boolean;
  archive?: "moved" | "copied";
  /** Few-long: planned length. */
  target: number;
  closed: boolean;
}

export interface Project { name: string; cwd: string; encoded: string; branch: string }

export interface Plan {
  sessions: Session[];
  projects: Project[];
}
