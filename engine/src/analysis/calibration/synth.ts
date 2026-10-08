/**
 * Synthetic users for the WP-23 calibration harness, built on the synth generator (`src/synth/**`): the same
 * schedule + planner that writes the JSONL test corpora, without rendering any log. Every exchange's numbers are
 * the planner's own script (`exchangeMetrics`), so the harness sees exactly what a reader would recover from the
 * rendered files (the synth's own tests check that equality).
 *
 * Synthetic only: nothing here reads a file, the clock or the environment.
 *
 * A SEQUENCE is one synthetic user over PRE_DAYS + EVAL_DAYS days (plan days 0 … 119). The harness evaluates it
 * daily, as the product would, on "today" = plan days PRE_DAYS + 1 … PRE_DAYS + EVAL_DAYS (today's own data is
 * always excluded, METHOD.md §2). With 30 pre-days (the terminal 30-day cleanup cap, and the "first run replays 30 days"
 * rule) tier 1 (42 days) first unlocks on evaluation day 12, tier 2 (63) on day 33 and tier 3 (84) on day 54, so
 * every sequence exercises the tiers and the extension rule.
 *
 * Profiles (few-long, many-short and Codex, plus the research/08 and WP-23 shapes; METHOD.md §14 lists the seven):
 *   few-long        few very long sessions (the D11 shape, ~22 sessions per 72 days)
 *   few-long-hd     few-long with the per-session effect SD doubled to 0.5 (the stats branch's few-long shape uses a
 *                   session SD of 0.5; the synth default is 0.25): a dispersion stress profile, judged like the others
 *   many-short      many one-day sessions
 *   single-project  many-short, every session in one project (the projects rule never applies)
 *   multi-project   many-short at higher volume, sessions spread evenly over 4 projects (the projects rule bites)
 *   sparse-failures many-short with tool errors at 1.2% and blind edits at 5% (few events: the +0.5 pseudo-count
 *                   and the event-count gates matter)
 *   codex           the Codex agent: few long human sessions plus non-interactive exec threads (excluded from voting)
 *
 * Tool-error split (METHOD.md §3; the D47(d) fallback vote `toolErrorsNonCmd` needs it): a COMMAND call is Claude's
 * `Bash` or Codex's `exec` (shell commands, read-class ones included — Codex reads run as commands); MCP calls,
 * edits (Edit/Write/apply_patch), other tools and subagent spawns are non-command. `toolErrorsCmd` / `toolErrorsEdit`
 * count the failed calls of each kind (they sum to `toolErrors`); `cmdCalls` counts command calls that ran (not
 * rejected, not blocked).
 */
import type { AgentId, ChangeEvent, ChangeKind, Exchange } from "../../types.js";
import { makeParams, type AgentName, type EventKind, type NoiseParams, type RateSet, type ScheduleEvent, type SynthParams } from "../../synth/params.js";
import { buildSchedule, type ResolvedEvent } from "../../synth/schedule.js";
import { buildPlan } from "../../synth/plan.js";
import { truthRow } from "../../synth/truth.js";
import type { Call, Exchange as PlanExchange } from "../../synth/model.js";
import { hashString } from "../stats/rng.js";
import { dayIndex } from "../stats/ratio.js";

export const PRE_DAYS = 30;
export const EVAL_DAYS = 90;
export const PLAN_DAYS = PRE_DAYS + EVAL_DAYS;
/** A Monday, so weekends fall the same way in every sequence. */
export const START_DAY = "2026-03-02";

export type ProfileId = "few-long" | "few-long-hd" | "many-short" | "single-project" | "multi-project" | "sparse-failures" | "codex";

export interface Profile {
  id: ProfileId;
  agent: AgentId;
  shape: "few-long" | "many-short";
  exchangesPerDay: number;
  rates?: Partial<RateSet>;
  noise?: Partial<NoiseParams>;
  /** Per-session random-effect SD (log scale / log-odds); default the synth's 0.25. */
  sessionEffectSd?: number;
  /** How the planner's projects are mapped: kept, all one project, or even over 4 projects (by session). */
  projects: "as-generated" | "single" | "even4";
  description: string;
}

export const PROFILES: readonly Profile[] = Object.freeze([
  { id: "few-long", agent: "claude-code", shape: "few-long", exchangesPerDay: 14, projects: "as-generated", description: "few very long sessions (FL)" },
  { id: "few-long-hd", agent: "claude-code", shape: "few-long", exchangesPerDay: 14, sessionEffectSd: 0.5, projects: "as-generated", description: "few-long, session effect SD 0.5 (dispersion stress)" },
  { id: "many-short", agent: "claude-code", shape: "many-short", exchangesPerDay: 16, projects: "as-generated", description: "many one-day sessions (MS)" },
  { id: "single-project", agent: "claude-code", shape: "many-short", exchangesPerDay: 14, projects: "single", description: "many-short, one project" },
  { id: "multi-project", agent: "claude-code", shape: "many-short", exchangesPerDay: 22, projects: "even4", description: "many-short, 4 projects evenly" },
  { id: "sparse-failures", agent: "claude-code", shape: "many-short", exchangesPerDay: 16, rates: { toolError: 0.012, blindEdit: 0.05 }, projects: "as-generated", description: "tool errors 1.2%, blind edits 5%" },
  { id: "codex", agent: "codex", shape: "few-long", exchangesPerDay: 12, noise: { codexExecPerDay: 2 }, projects: "as-generated", description: "Codex: few human sessions + exec threads (CX)" },
] as Profile[]);

export function profileOf(id: string): Profile {
  const p = PROFILES.find((x) => x.id === id);
  if (!p) throw new RangeError(`unknown calibration profile ${id}`);
  return p;
}

/** Planted change: synth event fields; `day` is a plan day (0-based). */
export type PlantedEvent = ScheduleEvent;

export interface SequenceSpec {
  profile: ProfileId;
  /** Free-form seed key; every random choice of the sequence derives from it. */
  seed: string;
  /** Events planted on top of the null background (none for a null sequence). */
  planted?: readonly PlantedEvent[];
  /**
   * Null background: a no-effect `you` effort change (p = 0.5) and a no-effect `unknown` model change (p = 0.3) at
   * random days, on top of the generated no-effect version bumps. Default true.
   */
  background?: boolean;
  /**
   * A profile that is not registered in PROFILES, used instead of looking `profile` up (WP-24a G0: shapes matched to
   * real counts). `profile` then only labels results. A plain value: the same object gives the same sequence.
   */
  custom?: Profile;
}

/** The profile a spec runs: its `custom` profile when given, else the registered one. */
export function specProfile(spec: SequenceSpec): Profile {
  return spec.custom ?? profileOf(spec.profile);
}

export interface Sequence {
  spec: SequenceSpec;
  profile: Profile;
  agent: AgentId;
  /** Engine exchanges, one per synthetic exchange, sorted by (day, t, session, seq). */
  exchanges: Exchange[];
  /**
   * The change events the readers and configsnap would RECORD (see `recordedEvents`), labelled per METHOD.md §9. Changes
   * they cannot see (a version bump or a picker switch between sessions) are left to WP-21's label derivation, as in the
   * product.
   */
  events: ChangeEvent[];
  /** The synth's resolved events (truth), for scenario bookkeeping. */
  truth: ResolvedEvent[];
}

/** 31-bit integer seed from a string (the synth generator takes a number). */
export function intSeed(key: string): number {
  return hashString(key)[0] & 0x7fffffff;
}

function backgroundEvents(key: string, agent: AgentName): ScheduleEvent[] {
  const [a, b, c, d] = hashString(`bg|${key}`);
  const u = (x: number) => x / 2 ** 32;
  const out: ScheduleEvent[] = [];
  const dayOf = (x: number) => PRE_DAYS + Math.floor(u(x) * EVAL_DAYS);
  if (u(a) < 0.5) out.push({ day: dayOf(b), agent, kind: "effort", to: agent === "codex" ? "high" : "medium", by: "you", note: "background: no-effect effort change" });
  if (u(c) < 0.3) out.push({ day: dayOf(d), agent, kind: "model", to: agent === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5-5", by: "agent", note: "background: no-effect model change without a command (unknown)" });
  return out;
}

export function sequenceParams(spec: SequenceSpec): SynthParams {
  const p = specProfile(spec);
  const agent: AgentName = p.agent;
  const events = [...(spec.background === false ? [] : backgroundEvents(spec.seed, agent)), ...(spec.planted ?? [])];
  const base = makeParams({ seed: intSeed(spec.seed), shape: p.shape, agents: [agent] });
  return {
    ...base,
    startDay: START_DAY,
    days: PLAN_DAYS,
    exchangesPerDay: { "claude-code": p.exchangesPerDay, codex: p.exchangesPerDay },
    rates: { ...base.rates, ...(p.rates ?? {}) },
    noise: { ...base.noise, ...(p.noise ?? {}) },
    ...(p.sessionEffectSd !== undefined ? { sessionEffectSd: p.sessionEffectSd } : {}),
    events: events.sort((x, y) => x.day - y.day),
  };
}

function isCommand(agent: AgentName, c: Call): boolean {
  return agent === "claude-code" ? c.tool === "Bash" : c.tool === "exec";
}

/** The tool-error split of one planned exchange (main-thread calls only, like `toolCalls`). */
export function toolErrorSplit(ex: PlanExchange): { toolErrorsEdit: number; toolErrorsCmd: number; cmdCalls: number } {
  let edit = 0, cmd = 0, cmdCalls = 0;
  for (const s of ex.steps) {
    for (const c of s.calls) {
      const command = isCommand(ex.agent, c);
      if (c.outcome === "error") {
        if (command) cmd++;
        else edit++;
      }
      if (command && c.outcome !== "rejected" && c.outcome !== "blocked") cmdCalls++;
    }
  }
  return { toolErrorsEdit: edit, toolErrorsCmd: cmd, cmdCalls };
}

const KIND_MAP: Record<EventKind, ChangeKind> = {
  version: "version", model: "model", effort: "effort", mode: "mode", entrypoint: "entrypoint", config: "config",
  instructions: "instructions", mcp: "mcp", skills: "skills", plugins: "plugins", hooks: "hooks", "system-prompt": "system-prompt",
};

/**
 * METHOD.md §9 labels for a synth event:
 *  - version bump (no user action)                                → agent · routine · log_field
 *  - system-prompt change                                         → agent · routine · log_field (context only)
 *  - model / effort / mode typed by you (a command is in the log)   → you · strong · command
 *  - model / effort / mode / entrypoint moved with no command        → unknown · weak · log_field (Desktop picker etc.)
 *  - instructions / MCP / skills / plugins / hooks / config by you   → you · strong · settings_snapshot
 */
export function changeEventOf(e: ResolvedEvent, agent: AgentId): ChangeEvent {
  const base = { id: `ev:${e.id}`, t: `${e.date}T09:00:00.000Z`, day: e.date, agent, kind: KIND_MAP[e.kind], from: e.from, to: e.to };
  if (e.kind === "version" || e.kind === "system-prompt") {
    return { ...base, side: "agent", evidence: "log", strength: "routine", provenance: "log_field", userInitiated: false };
  }
  if (e.kind === "model" || e.kind === "effort" || e.kind === "mode" || e.kind === "entrypoint") {
    if (e.userInitiated && e.kind !== "entrypoint") {
      return { ...base, side: "you", evidence: "log", strength: "strong", provenance: "command", userInitiated: true };
    }
    return { ...base, side: "unknown", evidence: "log", strength: "weak", provenance: "log_field", userInitiated: false };
  }
  return { ...base, side: "you", evidence: "snapshot", strength: "strong", provenance: "settings_snapshot", userInitiated: e.userInitiated };
}

/** Generate one sequence (pure function of its spec). */
export function generateSequence(spec: SequenceSpec): Sequence {
  const profile = specProfile(spec);
  const params = sequenceParams(spec);
  const schedule = buildSchedule(params);
  const plan = buildPlan(params, schedule);
  const agent: AgentId = profile.agent;
  const projectKey = (sessionIdx: number, projectIdx: number): string => {
    if (profile.projects === "single") return "p-0";
    if (profile.projects === "even4") return `p-${hashString(`${spec.seed}|proj|${sessionIdx}`)[1] % 4}`;
    return `p-${projectIdx}`;
  };
  const exchanges: Exchange[] = [];
  for (const s of plan.sessions) {
    const project = plan.projects[s.projectIdx]!;
    for (const ex of s.exchanges) {
      const r = truthRow(ex, s, `s${s.idx}`, project);
      const split = toolErrorSplit(ex);
      exchanges.push({
        v: 1,
        agent,
        id: `x:${s.idx}:${ex.seq}`,
        session: `s-${s.idx}`,
        project: projectKey(s.idx, s.projectIdx),
        t: r.t,
        day: r.day,
        version: r.version,
        model: r.model,
        servedModel: r.servedModel,
        effort: r.effort,
        mode: r.mode,
        entrypoint: r.entrypoint,
        seq: r.seq,
        afterCompaction: r.afterCompaction,
        promptChars: r.promptChars ?? 0,
        humanPrompt: r.humanPrompt,
        ...(r.humanPrompt === 1 ? { promptEnglish: 1 as const } : {}),
        interrupted: r.interrupted,
        pushback: r.pushback,
        queuedMidTurn: r.queuedMidTurn,
        steps: r.steps,
        toolCalls: r.toolCalls,
        toolErrors: r.toolErrors,
        toolErrorsEdit: split.toolErrorsEdit,
        toolErrorsCmd: split.toolErrorsCmd,
        cmdCalls: split.cmdCalls,
        rejections: r.rejections,
        blocked: r.blocked,
        reads: r.reads,
        edits: r.edits,
        blindEdits: r.blindEdits,
        churned: r.churned,
        outTok: r.outTok,
        inTok: r.inTok,
        cacheRead: r.cacheRead,
        cacheWrite: r.cacheWrite,
        apiErrors: r.apiErrors,
        apiRetries: r.apiRetries,
        compactions: r.compactions,
        thinkBlocks: r.thinkBlocks ?? 0,
        thinkRedacted: r.thinkRedacted ?? 0,
        thinkSigMedian: r.thinkSigMedian ?? 0,
        subToolCalls: r.subToolCalls,
        subTokens: r.subOutTok + r.subInTok + r.subCacheRead + r.subCacheWrite,
        durationMs: r.clockGlitch ? 0 : Math.max(0, r.durationMs),
      });
    }
  }
  exchanges.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : a.session < b.session ? -1 : a.session > b.session ? 1 : a.seq - b.seq));
  const truth = schedule.events.filter((e) => e.agent === profile.agent);
  return { spec, profile, agent, exchanges, events: recordedEvents(truth, exchanges, agent), truth };
}

/**
 * Which planted changes a reader or configsnap would record (WP-21 R7: readers emit only changes they see INSIDE one
 * session; configsnap exists from install on):
 *  - a change typed by you (/model, /effort, mode; Codex thread settings): always — the command record is in the log;
 *  - a version bump: only for Claude, and only when some session has exchanges on both sides of the bump day (Codex
 *    records the CLI version once per rollout, so it never shows inside a session);
 *  - a model / effort / mode / entrypoint / system-prompt move with no command: only when some session spans the day;
 *  - instructions / MCP / skills / plugins / hooks / config: from snapshots, i.e. only from the install day
 *    (plan day PRE_DAYS) on.
 * Everything else is left to the attribution layer's derivation from Exchange labels.
 */
export function recordedEvents(truth: readonly ResolvedEvent[], exchanges: readonly Exchange[], agent: AgentId): ChangeEvent[] {
  const spans = new Map<string, { first: string; last: string }>();
  for (const x of exchanges) {
    const sp = spans.get(x.session);
    if (!sp) spans.set(x.session, { first: x.day, last: x.day });
    else {
      if (x.day < sp.first) sp.first = x.day;
      if (x.day > sp.last) sp.last = x.day;
    }
  }
  const spanned = (day: string) => [...spans.values()].some((sp) => sp.first < day && sp.last >= day);
  const installDay = new Date(planDayIndex(PRE_DAYS) * 86_400_000).toISOString().slice(0, 10);
  const out: ChangeEvent[] = [];
  for (const e of truth) {
    let recorded: boolean;
    if ((e.kind === "model" || e.kind === "effort" || e.kind === "mode") && e.userInitiated) recorded = true;
    else if (e.kind === "version") recorded = agent === "claude-code" && spanned(e.date);
    else if (e.kind === "model" || e.kind === "effort" || e.kind === "mode" || e.kind === "entrypoint" || e.kind === "system-prompt") recorded = spanned(e.date);
    else recorded = e.date >= installDay;
    if (recorded) out.push(changeEventOf(e, agent));
  }
  return out;
}

// ───────────────────────────── session-day aggregation (the harness's fast path) ─────────────────────────────

/** Numeric Exchange fields that are summed when aggregating. */
const SUMMED = [
  "promptChars", "queuedMidTurn", "steps", "toolCalls", "toolErrors", "toolErrorsEdit", "toolErrorsCmd", "cmdCalls",
  "rejections", "blocked", "reads", "edits", "blindEdits", "outTok", "inTok", "cacheRead", "cacheWrite", "apiErrors",
  "apiRetries", "compactions", "thinkBlocks", "thinkRedacted", "subToolCalls", "subTokens", "durationMs",
] as const satisfies readonly (keyof Exchange)[];

/**
 * One row per (session, day, project, requested model, entrypoint): work-unit fields summed, `humanPrompt` = 1 when
 * any member is a real human prompt, 0/1 flags OR-ed, labels of the earliest member. EXACT for every work-unit
 * metric (the voting metrics, the tool-error split, `cmdFailures`) and for the confounders' stratum cells, because
 * cells are already sums per (session, day) and the stratum key is part of the row key; the interactive classifier
 * (entrypoint per row, "a human prompt in the session before today" per session) sees the same facts. NOT exact for
 * prompt-unit metrics (interrupts, pushback, churn, steps per exchange …), which never vote and which the harness
 * does not evaluate. `test/calibration/harness.test.ts` checks the equality on generated sequences.
 */
export function aggregateSessionDays(exchanges: readonly Exchange[]): Exchange[] {
  const groups = new Map<string, Exchange>();
  const order: string[] = [];
  for (const x of exchanges) {
    const key = `${x.session}\u001f${x.day}\u001f${x.project}\u001f${x.model}\u001f${x.entrypoint}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...x, id: `agg:${order.length}` });
      order.push(key);
      continue;
    }
    for (const f of SUMMED) (g as unknown as Record<string, number>)[f] = ((g[f] as number | undefined) ?? 0) + ((x[f] as number | undefined) ?? 0);
    if (x.humanPrompt === 1) g.humanPrompt = 1;
    if (x.interrupted === 1) g.interrupted = 1;
    if (x.pushback === 1) g.pushback = 1;
    if (x.churned === 1) g.churned = 1;
    if (x.afterCompaction) g.afterCompaction = true;
    if (x.promptEnglish === 1) g.promptEnglish = 1;
    if (x.t < g.t) g.t = x.t;
  }
  return order.map((k) => groups.get(k)!);
}

/** A session-day row standing for `n` exchanges that share every label (`aggregateLabelRows`). */
export type LabelRow = Exchange & { n: number };

/** Exchange fields that are labels: a label row never mixes two values of any of them. */
const LABELS = ["session", "day", "project", "version", "model", "servedModel", "effort", "mode", "entrypoint", "interactiveClass", "provider"] as const satisfies readonly (keyof Exchange)[];

/**
 * The WP-21 decider's fast input (D58): `aggregateSessionDays`, but one row per (session, day) AND every label —
 * project, version, requested and served model, effort, mode, entrypoint, interactive class, provider — with `n` = the
 * exchanges it stands for. What the attribution pipeline reads from exchanges is then unchanged:
 *  - cells and stratum cells are per-(session, day[, stratum]) sums (as for `aggregateSessionDays`);
 *  - the interactive classifier sees the same entrypoints and the same "a human prompt in this session before today";
 *  - the label derivation (attribution/labels.ts) counts `n` per row (`exchangeWeight`), so its day majorities are the
 *    exchange-count ones — a Codex session keeps its start version, and on a bump day the old sessions' exchanges, not
 *    their rows, must be counted; the derived event's `t` is the earliest member's;
 *  - the strata rule-out (METHOD.md §10 step 5) filters by model / effort / mode / entrypoint, all uniform within a row.
 * Not exact (and not read by the decision): exchange counts (`counts`, `MetricCell.exchanges`), prompt-unit metrics and
 * the informational mix flags; the served-model tripwire's run lengths when a session alternates served models within
 * a day (the synth's served model is the requested one or "unknown", so it never fires; tripwires are off, METHOD.md §9).
 * `test/calibration/attr-rows.test.ts` checks decisions, derived events and evidence against the raw exchanges.
 */
export function aggregateLabelRows(exchanges: readonly Exchange[]): LabelRow[] {
  const groups = new Map<string, LabelRow>();
  const order: string[] = [];
  for (const x of exchanges) {
    const key = LABELS.map((f) => String(x[f] ?? "")).join("\u001f");
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...x, id: `row:${order.length}`, n: 1 });
      order.push(key);
      continue;
    }
    g.n++;
    for (const f of SUMMED) (g as unknown as Record<string, number>)[f] = ((g[f] as number | undefined) ?? 0) + ((x[f] as number | undefined) ?? 0);
    if (x.humanPrompt === 1) g.humanPrompt = 1;
    if (x.interrupted === 1) g.interrupted = 1;
    if (x.pushback === 1) g.pushback = 1;
    if (x.churned === 1) g.churned = 1;
    if (x.afterCompaction) g.afterCompaction = true;
    if (x.promptEnglish === 1) g.promptEnglish = 1;
    if (x.t < g.t) g.t = x.t;
    if (x.seq < g.seq) g.seq = x.seq;
  }
  return order.map((k) => groups.get(k)!);
}

/** Day index of each row (rows must be sorted by day). */
export function dayIndices(rows: readonly { day: string }[]): Int32Array {
  return Int32Array.from(rows, (r) => dayIndex(r.day) ?? -1);
}

/** Plan day → engine day index. */
export function planDayIndex(planDay: number): number {
  return dayIndex(START_DAY)! + planDay;
}
