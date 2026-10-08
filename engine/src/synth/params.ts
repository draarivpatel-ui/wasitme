/**
 * Parameters of a synthetic user: how they work (shape, volume), how often things go wrong (base rates),
 * how sessions differ from each other (random effects) and what changes when (the event schedule).
 *
 * The generator writes raw logs only; it deliberately does not import the engine's `Exchange` contract.
 * The truth files it writes use the same field NAMES so reader tests can compare directly.
 */

export type AgentName = "claude-code" | "codex";
export type Shape = "few-long" | "many-short";

export type EventKind =
  | "version" | "model" | "effort" | "mode" | "entrypoint"
  | "config" | "instructions" | "mcp" | "skills" | "plugins" | "hooks" | "system-prompt";

/**
 * Rates that events can scale. Probabilities are per exchange / per tool call / per step as noted;
 * the rest are means. Events carry MULTIPLICATIVE factors, so "no effect" is simply "no factors".
 */
export const RATE_KEYS = [
  "interrupt",     // P(exchange is interrupted by the user)
  "pushback",      // P(prompt is pushback | not the first exchange of its session)
  "queued",        // mean queued mid-turn prompts per exchange
  "toolCalls",     // mean tool calls per exchange
  "toolError",     // P(tool call fails)
  "rejection",     // P(user rejects a tool call) - 0 while permissions are bypassed
  "blocked",       // P(auto-mode / permission rule blocks a tool call)
  "read",          // relative weight of read-type calls
  "edit",          // relative weight of edit-type calls
  "blindEdit",     // P(edit is "blind" | edit)
  "churn",         // P(exchange edits one file 3+ times)
  "apiRetry",      // P(step is preceded by api_error retries)
  "apiError",      // P(step ends in a final API failure)
  "compaction",    // P(exchange triggers a compaction | session has run a while)
  "thinkProb",     // P(step carries a thinking block)
  "thinkDepth",    // mean thinking signature length (chars)
  "thinkRedacted", // P(thinking block is redacted/empty)
  "outTok",        // mean output tokens per step
  "subagent",      // P(exchange spawns a subagent)
] as const;
export type RateKey = (typeof RATE_KEYS)[number];
export type RateSet = Record<RateKey, number>;

export const BASE_RATES: RateSet = {
  interrupt: 0.06,
  pushback: 0.10,
  queued: 0.10,
  toolCalls: 7,
  toolError: 0.05,
  rejection: 0.02,
  blocked: 0.01,
  read: 0.5,
  edit: 0.22,
  blindEdit: 0.15,
  churn: 0.07,
  apiRetry: 0.03,
  apiError: 0.004,
  compaction: 0.03,
  thinkProb: 0.7,
  thinkDepth: 500,
  thinkRedacted: 0.55,
  outTok: 350,
  subagent: 0.06,
};

/** Rates that are probabilities (clamped below 1 after scaling); the others are means/weights. */
export const PROBABILITY_KEYS: ReadonlySet<RateKey> = new Set<RateKey>([
  "interrupt", "pushback", "toolError", "rejection", "blocked", "blindEdit", "churn",
  "apiRetry", "apiError", "compaction", "thinkProb", "thinkRedacted", "subagent",
]);

export interface AgentEnv {
  version: string;
  model: string;
  effort: string;
  mode: string;
  entrypoint: string;
}

export interface ScheduleEvent {
  /**
   * 0-based day offset from `startDay`; effective from the start of that day. A change typed by "you"
   * (model / effort / mode) is the agent's first activity of that day (the planner guarantees a typed
   * prompt that day), so nothing shows the new setting before its command.
   */
  day: number;
  agent: AgentName | "both";
  kind: EventKind;
  /** New value. For `version`, "next" takes the next label in that agent's sequence. */
  to: string;
  /** Who made the change. "you" writes the slash-command / settings evidence; "agent" is silent. */
  by: "you" | "agent";
  /** Multiplicative factors on base rates, cumulative with earlier events. Omit for "no effect". */
  effect?: Partial<RateSet>;
  note?: string;
}

export interface NoiseParams {
  /** Claude: P(a new session resumes the previous session of its project, replaying its tail). */
  resumeRate: number;
  /** Per exchange: P(trailing records carry a timestamp from before the prompt - a clock reset). */
  clockGlitchRate: number;
  /** Claude: P(session starts with an agent-initiated stretch, no human prompt). */
  agentInitiatedRate: number;
  /** Per exchange: P(a background-task notification wakes the agent after the answer). */
  notificationRate: number;
  /** Per exchange: P(a non-human queued command / peer message sits in the log). */
  peerNoiseRate: number;
  /** Per Claude exchange: P(a stop-hook summary record is written). */
  hookSummaryRate: number;
  /** Codex rollouts with a minor version below this are legacy (no item_completed). */
  codexLegacyBelow: number;
  /** Codex: P(a new session is a fork of the project's previous one). */
  codexForkRate: number;
  /** Codex: mean non-interactive `exec` threads per day. */
  codexExecPerDay: number;
  /** Codex: P(an old rollout is archived (2/3 moved, 1/3 also left in place)). */
  codexArchiveRate: number;
  /** Codex paginated: P(a message is recorded both canonically and as a legacy event (migration)). */
  codexMigratedRate: number;
  /** Codex: P(a session starts with imported, model-less stub turns). */
  codexImportStubRate: number;
  /** Codex: P(an aborted turn has a non-user reason, e.g. "replaced"). */
  codexOtherAbortRate: number;
}

export interface SynthParams {
  seed: number;
  /** First day, "YYYY-MM-DD" (UTC). All activity is scheduled 09:00-21:30 UTC. */
  startDay: string;
  days: number;
  agents: AgentName[];
  shape: Shape;
  /** Mean exchanges per weekday, per agent. */
  exchangesPerDay: Record<AgentName, number>;
  rates: RateSet;
  /** Std-dev of the per-session random effect (log scale / log-odds). */
  sessionEffectSd: number;
  /** Auto-generated CLI version bumps with NO effect (0 = none). */
  versionBumpEveryDays: number;
  events: ScheduleEvent[];
  initial: Record<AgentName, AgentEnv>;
  noise: NoiseParams;
}

export const DEFAULT_NOISE: NoiseParams = {
  resumeRate: 0.10,
  clockGlitchRate: 0.01,
  agentInitiatedRate: 0.04,
  notificationRate: 0.04,
  peerNoiseRate: 0.05,
  hookSummaryRate: 0.5,
  codexLegacyBelow: 146,
  codexForkRate: 0.06,
  codexExecPerDay: 0.4,
  codexArchiveRate: 0.2,
  codexMigratedRate: 0.15,
  codexImportStubRate: 0.05,
  codexOtherAbortRate: 0.01,
};

export function defaultInitial(shape: Shape): Record<AgentName, AgentEnv> {
  return {
    "claude-code": {
      version: "2.1.244", model: "claude-opus-5-5", effort: "high", mode: "default",
      entrypoint: shape === "few-long" ? "claude-desktop" : "cli",
    },
    codex: {
      version: "0.142.0", model: "gpt-6-luna", effort: "medium", mode: "on-request",
      entrypoint: shape === "few-long" ? "vscode" : "cli",
    },
  };
}

export function makeParams(over: Partial<SynthParams> & { seed: number }): SynthParams {
  const shape = over.shape ?? "many-short";
  return {
    startDay: "2026-07-01",
    days: 56,
    agents: ["claude-code"],
    shape,
    exchangesPerDay: { "claude-code": 15, codex: 12 },
    rates: { ...BASE_RATES },
    sessionEffectSd: 0.25,
    versionBumpEveryDays: 3,
    events: [],
    initial: defaultInitial(shape),
    noise: { ...DEFAULT_NOISE },
    ...over,
  };
}

export const MS_PER_DAY = 86_400_000;

export function dayMs(startDay: string, offset: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDay);
  if (!m) throw new Error(`bad startDay ${startDay}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + offset * MS_PER_DAY;
}

export function dayString(startDay: string, offset: number): string {
  return new Date(dayMs(startDay, offset)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday (UTC). */
export function weekday(startDay: string, offset: number): number {
  return new Date(dayMs(startDay, offset)).getUTCDay();
}
