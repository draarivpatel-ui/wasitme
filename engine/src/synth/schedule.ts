/**
 * Turns the event list into a per-day, per-agent state: which labels are in force, what the global
 * config looks like, and the cumulative rate factors planted so far. Also auto-generates the CLI
 * version bumps that carry NO effect (the null hypothesis the product must not flag).
 */
import { Rng } from "./rng.js";
import {
  dayString, type AgentEnv, type AgentName, type EventKind, type RateKey, type RateSet, type SynthParams,
} from "./params.js";

export interface ConfigState {
  skills: number;
  mcp: string[];
  instructionsRev: number;
  systemPromptRev: number;
  hooks: number;
  plugins: number;
  configRev: number;
}

export interface DayState {
  env: AgentEnv;
  config: ConfigState;
  /** Cumulative multiplicative factors from all events up to and including this day. */
  factors: Partial<RateSet>;
}

export interface ResolvedEvent {
  id: string;
  day: number;
  date: string;
  agent: AgentName;
  kind: EventKind;
  side: "you" | "agent";
  from: string;
  to: string;
  userInitiated: boolean;
  /** Multiplicative factors planted by this event (null = none; it must be a no-op for the metrics). */
  effect: Partial<RateSet> | null;
  /** True for the generated no-effect version bumps. */
  auto: boolean;
  note?: string;
}

export interface Segment {
  agent: AgentName;
  fromDay: number;
  /** Inclusive. */
  toDay: number;
  factors: Partial<RateSet>;
  env: AgentEnv;
}

export interface Schedule {
  events: ResolvedEvent[];
  days: Record<AgentName, DayState[]>;
  segments: Segment[];
}

export function initialConfig(): ConfigState {
  return { skills: 8, mcp: ["synth-docs"], instructionsRev: 1, systemPromptRev: 1, hooks: 1, plugins: 1, configRev: 1 };
}

export function nextVersion(agent: AgentName, v: string, rng: Rng): string {
  const parts = v.split(".").map((x) => Number(x));
  const [a = 0, b = 0, c = 0] = parts;
  return agent === "claude-code" ? `${a}.${b}.${c + rng.int(1, 5)}` : `${a}.${b + 1}.0`;
}

/** Minor version of a Codex label like "0.146.0". */
export function codexMinor(version: string): number {
  return Number(version.split(".")[1] ?? 0);
}

/** Patch number of a Claude label like "2.1.250". */
export function claudePatch(version: string): number {
  return Number(version.split(".")[2] ?? 0);
}

/** First Claude patch that writes `origin`, `permissionMode` on user records and `effort` on assistant records. */
export const CLAUDE_MODERN_FROM = 248;

export function isClaudeModern(version: string): boolean {
  return claudePatch(version) >= CLAUDE_MODERN_FROM;
}

interface Pending {
  day: number;
  order: number;
  kind: EventKind;
  to: string;
  by: "you" | "agent";
  effect?: Partial<RateSet>;
  auto: boolean;
  note?: string;
}

export function buildSchedule(p: SynthParams): Schedule {
  const root = new Rng(p.seed, "schedule");
  const days = {} as Record<AgentName, DayState[]>;
  const events: ResolvedEvent[] = [];
  const segments: Segment[] = [];

  for (const agent of p.agents) {
    const rng = root.fork(agent);
    const pending: Pending[] = [];
    p.events.forEach((e, i) => {
      if (e.agent === agent || e.agent === "both") {
        pending.push({ day: e.day, order: i, kind: e.kind, to: e.to, by: e.by, effect: e.effect, auto: false, note: e.note });
      }
    });
    if (p.versionBumpEveryDays > 0) {
      const taken = pending.filter((e) => e.kind === "version").map((e) => e.day);
      let d = rng.int(1, p.versionBumpEveryDays);
      let n = 0;
      while (d < p.days) {
        if (!taken.some((t) => Math.abs(t - d) <= 1)) {
          pending.push({ day: d, order: 10_000 + n++, kind: "version", to: "next", by: "agent", auto: true });
        }
        d += Math.max(1, p.versionBumpEveryDays + rng.int(-1, 1));
      }
    }
    pending.sort((a, b) => a.day - b.day || a.order - b.order);

    let env: AgentEnv = { ...p.initial[agent] };
    let config = initialConfig();
    let factors: Partial<RateSet> = {};
    const out: DayState[] = [];
    let k = 0;
    for (let d = 0; d < p.days; d++) {
      while (k < pending.length && pending[k]!.day <= d) {
        const e = pending[k++]!;
        const from = labelOf(e.kind, env, config);
        if (e.kind === "version") env = { ...env, version: e.to === "next" ? nextVersion(agent, env.version, rng) : e.to };
        else if (e.kind === "model") env = { ...env, model: e.to };
        else if (e.kind === "effort") env = { ...env, effort: e.to };
        else if (e.kind === "mode") env = { ...env, mode: e.to };
        else if (e.kind === "entrypoint") env = { ...env, entrypoint: e.to };
        else config = applyConfig(config, e.kind, e.to);
        if (e.effect) {
          factors = { ...factors };
          for (const key of Object.keys(e.effect) as RateKey[]) factors[key] = (factors[key] ?? 1) * (e.effect[key] ?? 1);
        }
        events.push({
          id: `ev-${agent}-${String(e.day).padStart(3, "0")}-${e.kind}-${k}`,
          day: e.day,
          date: dayString(p.startDay, e.day),
          agent,
          kind: e.kind,
          side: e.by,
          from,
          to: labelOf(e.kind, env, config),
          userInitiated: e.by === "you",
          effect: e.effect ?? null,
          auto: e.auto,
          ...(e.note ? { note: e.note } : {}),
        });
      }
      out.push({ env: { ...env }, config: { ...config, mcp: [...config.mcp] }, factors: { ...factors } });
    }
    days[agent] = out;

    // Segments: runs of days with identical factors AND env.
    let start = 0;
    for (let d = 1; d <= out.length; d++) {
      const same = d < out.length && JSON.stringify(out[d]!.factors) === JSON.stringify(out[start]!.factors)
        && JSON.stringify(out[d]!.env) === JSON.stringify(out[start]!.env);
      if (!same) {
        segments.push({ agent, fromDay: start, toDay: d - 1, factors: out[start]!.factors, env: out[start]!.env });
        start = d;
      }
    }
  }
  events.sort((a, b) => a.day - b.day || a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id));
  return { events, days, segments };
}

function labelOf(kind: EventKind, env: AgentEnv, c: ConfigState): string {
  switch (kind) {
    case "version": return env.version;
    case "model": return env.model;
    case "effort": return env.effort;
    case "mode": return env.mode;
    case "entrypoint": return env.entrypoint;
    case "skills": return String(c.skills);
    case "mcp": return c.mcp.join(",");
    case "instructions": return `r${c.instructionsRev}`;
    case "system-prompt": return `r${c.systemPromptRev}`;
    case "hooks": return String(c.hooks);
    case "plugins": return String(c.plugins);
    case "config": return `r${c.configRev}`;
  }
}

function applyConfig(c: ConfigState, kind: EventKind, to: string): ConfigState {
  const n = (cur: number): number => (to === "next" ? cur + 1 : Math.max(0, Number(to) || 0));
  switch (kind) {
    case "skills": return { ...c, skills: n(c.skills) };
    case "mcp": return { ...c, mcp: to ? to.split(",") : [] };
    case "instructions": return { ...c, instructionsRev: n(c.instructionsRev) };
    case "system-prompt": return { ...c, systemPromptRev: n(c.systemPromptRev) };
    case "hooks": return { ...c, hooks: n(c.hooks) };
    case "plugins": return { ...c, plugins: n(c.plugins) };
    case "config": return { ...c, configRev: n(c.configRev) };
    default: return c;
  }
}
