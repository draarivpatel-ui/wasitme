/**
 * Sequence specs the harness runs: null users, planted regressions (power, G-onset) and the G-attr scenarios.
 * Every spec is a pure function of (run seed, kind, profile, index), so results never depend on worker count/order.
 */
import type { AgentName, RateSet, ScheduleEvent } from "../../synth/params.js";
import { PRE_DAYS, profileOf, type ProfileId, type SequenceSpec } from "./synth.js";

/** Planted changes land on plan day PRE_DAYS + 45: evaluation day 46 is the first to see them (45 days to detect). */
export const ONSET_PLAN_DAY = PRE_DAYS + 45;

export function nullSpec(runSeed: string, profile: ProfileId, index: number): SequenceSpec {
  return { profile, seed: `${runSeed}|null|${profile}|${index}` };
}

/** A regression shipped with a version bump: tool errors and blind edits × m, the read weight ÷ m (reads per edit fall). */
export function regression(m: number): Partial<RateSet> {
  return { toolError: m, blindEdit: m, read: 1 / m };
}

export function effectSpec(runSeed: string, profile: ProfileId, index: number, m: number): SequenceSpec {
  const agent: AgentName = profileOf(profile).agent;
  return {
    profile,
    seed: `${runSeed}|effect${m}|${profile}|${index}`,
    planted: [{ day: ONSET_PLAN_DAY, agent, kind: "version", to: "next", by: "agent", effect: regression(m), note: `planted regression x${m}` }],
  };
}

export interface AttrCondition {
  /** Glance state (or state:reason prefix) whose rate is bounded. */
  state: string;
  max: number | null;
}

/** G-attr rows (METHOD.md §14) the synth generator can express (scaffolding: filled once WP-21's decider emits attribution). */
export interface AttrScenario {
  id: string;
  /** The G-attr row it implements. */
  row: string;
  /** What actually changed. */
  truth: "you" | "agent_routine" | "unknown" | "friction" | "both" | "agent_routine_with_far_you" | "agent_routine_with_noeffect_you";
  conditions: AttrCondition[];
  planted(agent: AgentName): ScheduleEvent[];
}

const EFFECT = regression(2);

export const ATTR_SCENARIOS: readonly AttrScenario[] = Object.freeze([
  {
    id: "you-effect", row: "a you-event effect → agent ≤ 2%", truth: "you",
    conditions: [{ state: "agent", max: 0.02 }],
    planted: (agent: AgentName) => [{ day: ONSET_PLAN_DAY, agent, kind: "effort", to: agent === "codex" ? "high" : "medium", by: "you", effect: EFFECT }],
  },
  {
    id: "routine-update-effect", row: "a server-side change (routine update), fully observed → you ≤ 5%", truth: "agent_routine",
    conditions: [{ state: "you", max: 0.05 }],
    planted: (agent: AgentName) => [{ day: ONSET_PLAN_DAY, agent, kind: "version", to: "next", by: "agent", effect: EFFECT }],
  },
  {
    id: "desktop-picker-effect", row: "a Desktop picker, flag or env change with no command and no settings diff → agent ≤ 2%", truth: "unknown",
    conditions: [{ state: "agent", max: 0.02 }],
    planted: (agent: AgentName) => [{ day: ONSET_PLAN_DAY, agent, kind: "model", to: agent === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5-5", by: "agent", effect: EFFECT }],
  },
  {
    id: "friction-only", row: "a friction-only shift → agent ≤ 2%, you ≤ 5%", truth: "friction",
    conditions: [{ state: "agent", max: 0.02 }, { state: "you", max: 0.05 }],
    planted: (agent: AgentName) => [{ day: ONSET_PLAN_DAY, agent, kind: "version", to: "next", by: "agent", effect: { interrupt: 3, pushback: 3 } }],
  },
  {
    id: "both-same-day", row: "both sides on the same day → you ≤ 10%, agent ≤ 10%", truth: "both",
    conditions: [{ state: "you", max: 0.1 }, { state: "agent", max: 0.1 }],
    planted: (agent: AgentName) => [
      { day: ONSET_PLAN_DAY, agent, kind: "effort", to: agent === "codex" ? "high" : "medium", by: "you", effect: { toolError: 1.5, blindEdit: 1.5 } },
      { day: ONSET_PLAN_DAY, agent, kind: "version", to: "next", by: "agent", effect: { toolError: 1.4, blindEdit: 1.4, read: 0.6 } },
    ],
  },
  {
    id: "you-event-far-from-onset", row: "a you-event ≥ 7 days from the onset → you ≤ 10%", truth: "agent_routine_with_far_you",
    conditions: [{ state: "you", max: 0.1 }],
    planted: (agent: AgentName) => [
      { day: ONSET_PLAN_DAY - 10, agent, kind: "effort", to: agent === "codex" ? "high" : "medium", by: "you" },
      { day: ONSET_PLAN_DAY, agent, kind: "version", to: "next", by: "agent", effect: EFFECT },
    ],
  },
  {
    id: "routine-plus-noeffect-you", row: "a routine bump + a no-effect you-event → the you rate is published", truth: "agent_routine_with_noeffect_you",
    conditions: [{ state: "you", max: null }],
    planted: (agent: AgentName) => [
      { day: ONSET_PLAN_DAY, agent, kind: "version", to: "next", by: "agent", effect: EFFECT },
      { day: ONSET_PLAN_DAY + 2, agent, kind: "effort", to: agent === "codex" ? "high" : "medium", by: "you" },
    ],
  },
] as AttrScenario[]);

/** G-attr rows the synth cannot express yet (reported as such in the artifact). */
export const ATTR_NOT_EXPRESSIBLE: readonly string[] = Object.freeze([
  "an agent-strong effect (served ≠ requested model) → you ≤ 5% — the synth has no served-model divergence",
  "workload only → you/agent ≤ 5% — synth rates do not depend on project or mix",
  "a single-project workload shift with a routine bump in I → agent ≤ 2% — as above",
  "a pre-install settings edit, then a restart into a bump → never agent — the synth has no install/snapshot timeline",
  "a small stratum never flips to you — as above",
  "mixed never gives none — covered by the interim decider's unit tests, not by a planted scenario",
]);

export function attrSpec(runSeed: string, profile: ProfileId, index: number, scenario: AttrScenario): SequenceSpec {
  return { profile, seed: `${runSeed}|attr|${scenario.id}|${profile}|${index}`, background: false, planted: scenario.planted(profileOf(profile).agent) };
}
