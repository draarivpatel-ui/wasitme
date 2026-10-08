/**
 * One call from parameters to a complete corpus: schedule -> plan -> Claude/Codex renderers -> truth.
 * Pure: returns the files in memory; `write.ts` puts them on disk.
 */
import { buildPlan } from "./plan.js";
import { buildSchedule, type ResolvedEvent, type Segment } from "./schedule.js";
import { renderClaude, type ClaudeNoise } from "./claude.js";
import { renderCodex, type CodexNoise } from "./codex.js";
import { iso, joinLines, jsonLine, type OutFile } from "./emit.js";
import { commandOffsetMs } from "./layout.js";
import { SUMMED_KEYS, describeParams, perDay, truthRow, type DayAggregate, type TruthExchange } from "./truth.js";
import { dayMs, type AgentName, type SynthParams } from "./params.js";

export const TRUTH_FILE = "synth-truth.json";
export const TRUTH_EXCHANGES_FILE = "synth-truth-exchanges.jsonl";

/** A schedule event as the truth file reports it. */
export interface TruthEvent extends ResolvedEvent {
  /**
   * Only for user-typed model / effort / mode changes: the moment the command is in the log (Claude's
   * `<command-name>` record, Codex's `thread_settings_applied`). No record carries the new setting
   * before it, and it is the agent's first activity of the day (see `notes`).
   */
  commandAt?: string;
}

export interface TruthDoc {
  formatVersion: 1;
  generator: "wasitme-synth";
  scenario: string;
  seed: number;
  startDay: string;
  days: number;
  /** Days in this file are UTC calendar days; all activity is between 09:00 and 21:30 UTC. */
  timezone: "UTC";
  roots: { claudeConfigDir: "claude"; codexHome: "codex" };
  params: Record<string, unknown>;
  events: TruthEvent[];
  segments: Segment[];
  totals: Record<string, Record<string, number>>;
  perDay: Record<string, DayAggregate[]>;
  noise: { claude?: ClaudeNoise; codex?: CodexNoise };
  exchangesFile: typeof TRUTH_EXCHANGES_FILE;
  notes: string[];
}

export interface Generated {
  files: OutFile[];
  rows: TruthExchange[];
  truth: TruthDoc;
}

const NOTES = [
  "Row fields mirror the engine Exchange contract by name; null means implementation-defined (do not assert).",
  "Exchanges are human prompts plus agent work until the next human prompt in the same session file. Agent-initiated stretches (a Claude session that starts with a background-task notification) are humanPrompt 0; so are Codex exec threads (automated: true).",
  "Resumed Claude sessions replay the previous session's tail with identical uuids; replayed records are NOT exchanges of the resumed session. Legacy Codex forks copy parent turns (same turn ids, fresh timestamps); imported stub turns have no turn_context. Neither produces exchanges.",
  "pushback counts the starting prompt only. Queued mid-turn prompts are never pushback-like and never near-duplicates, so they cannot change the pushback truth.",
  "durationMs runs from the prompt (or first record) to the last activity record; slash-command bookkeeping is excluded. Rows with clockGlitch true end with a record stamped before the prompt: a reader must clamp, not trust, that span.",
  "A tool-use interrupt ends on a user-rejected call, so interrupted and rejections both count it. Codex has no rejections, blocks, api errors or retries in this corpus (all 0).",
  "Claude writes effort / permissionMode only from CLI patch 248 on; earlier exchanges have effort and mode 'unknown'. Codex records the CLI version once per rollout, so long sessions keep their start version.",
  "A user-typed change (model / effort / mode) is typed before the new setting shows up in any record: its event carries commandAt, the command's own record is at that instant, and the command's exchange is the agent's first of the day (labels and planted effect factors switch at the start of the event day, so day-level before/after splits stay exact). That day always has at least one typed prompt. Changes made by the agent (version bumps) have no command and take effect from the first record of the day.",
  "subTokens is not provided as a single number (implementation-defined); the parts subOutTok / subInTok / subCacheRead / subCacheWrite are.",
];

export function generate(params: SynthParams, scenario: string): Generated {
  const schedule = buildSchedule(params);
  const plan = buildPlan(params, schedule);
  const claude = params.agents.includes("claude-code") ? renderClaude(params, plan) : undefined;
  const codex = params.agents.includes("codex") ? renderCodex(params, plan) : undefined;

  const rows: TruthExchange[] = [];
  for (const s of plan.sessions) {
    const key = (s.agent === "claude-code" ? claude : codex)?.sessionFile.get(s.idx);
    if (!key) continue;
    for (const ex of s.exchanges) rows.push(truthRow(ex, s, key, plan.projects[s.projectIdx]!));
  }
  rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.session < b.session ? -1 : a.session > b.session ? 1 : a.seq - b.seq));

  const files: OutFile[] = [...(claude?.files ?? []), ...(codex?.files ?? [])];

  const totals: Record<string, Record<string, number>> = {};
  const days: Record<string, DayAggregate[]> = {};
  for (const agent of params.agents) {
    const mine = rows.filter((r) => r.agent === agent);
    const t: Record<string, number> = {
      sessions: new Set(mine.map((r) => r.sessionId)).size,
      exchanges: mine.length,
      pushbackEligible: mine.filter((r) => r.humanPrompt && r.seq > 0).length,
    };
    for (const k of SUMMED_KEYS) t[k] = mine.reduce((a, r) => a + r[k], 0);
    totals[agent] = t;
    days[agent] = perDay(rows, agent as AgentName);
  }

  // When each typed change was typed: the command record's instant, from the same layout the renderers use.
  const commandAt = new Map<string, string>();
  for (const s of plan.sessions) {
    for (const ex of s.exchanges) ex.commands.forEach((c, i) => commandAt.set(c.eventId, iso(ex.startMs + commandOffsetMs(ex.agent, i))));
  }
  const events: TruthEvent[] = schedule.events.map((e) => (commandAt.has(e.id) ? { ...e, commandAt: commandAt.get(e.id)! } : e));

  const truth: TruthDoc = {
    formatVersion: 1, generator: "wasitme-synth", scenario, seed: params.seed, startDay: params.startDay, days: params.days,
    timezone: "UTC", roots: { claudeConfigDir: "claude", codexHome: "codex" }, params: describeParams(params),
    events, segments: schedule.segments, totals, perDay: days,
    noise: { ...(claude ? { claude: claude.noise } : {}), ...(codex ? { codex: codex.noise } : {}) },
    exchangesFile: TRUTH_EXCHANGES_FILE, notes: NOTES,
  };
  const endOfRun = dayMs(params.startDay, params.days);
  files.push({ path: TRUTH_FILE, data: JSON.stringify(truth, null, 2) + "\n", mtimeMs: endOfRun });
  files.push({ path: TRUTH_EXCHANGES_FILE, data: joinLines(rows.map(jsonLine)), mtimeMs: endOfRun });
  return { files, rows, truth };
}
