/**
 * The planner: draws sessions and exchanges (agent-neutral scripts) from the parameters, the event
 * schedule and per-session random effects. Pure function of (params, schedule) - all randomness comes
 * from forked seeded streams.
 */
import { Rng, clamp, shiftOdds } from "./rng.js";
import {
  PROBABILITY_KEYS, RATE_KEYS, dayMs, dayString, weekday,
  type AgentEnv, type AgentName, type RateKey, type SynthParams,
} from "./params.js";
import { codexMinor, type ResolvedEvent, type Schedule } from "./schedule.js";
import type { Call, Compaction, Denial, Exchange, ParsedKind, Plan, Project, Session, Step, SubPlan, SubStep, Usage, UserCommand } from "./model.js";
import { layoutExchange } from "./layout.js";
import * as V from "./vocab.js";

const HOUR = 3_600_000;
const DAY_START_MS = 9 * HOUR;
const DAY_END_MS = 21.5 * HOUR;
const OTHER_WEIGHT = 0.28;

function mkProject(name: string, branch: string): Project {
  const cwd = `/Users/syn-user/code/${name}`;
  return { name, cwd, encoded: cwd.replace(/[/.]/g, "-"), branch };
}
export const PROJECTS: Project[] = [
  mkProject("app-a", "main"),
  mkProject("app-b", "feature-synth-one"),
  mkProject("lib-c", "main"),
  mkProject("tool-d", "synth-fixes"),
];
const PROJECT_WEIGHTS = [0.5, 0.25, 0.15, 0.1];

const CLAUDE_READ_TOOLS = ["Read", "Grep", "Glob", "LS"] as const;
const CLAUDE_READ_WEIGHTS = [0.6, 0.25, 0.1, 0.05];
const CLAUDE_EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;
const CLAUDE_EDIT_WEIGHTS = [0.7, 0.15, 0.1, 0.05];
const CLAUDE_OTHER_TOOLS = ["Bash", "WebFetch", "TodoWrite"] as const;
const CLAUDE_OTHER_WEIGHTS = [0.75, 0.1, 0.15];

/** Mutable per-session bookkeeping used while planning (not part of the model). */
interface SessState {
  callCounter: number;
  fileLastRead: Map<string, number>;
  known: string[];
  fresh: number;
  lastPrompt?: string;
  lastTemplate: number;
  compacted: boolean;
  prevEnv?: AgentEnv;
  prevDay?: number;
}

export function buildPlan(p: SynthParams, schedule: Schedule): Plan {
  const root = new Rng(p.seed, "plan");
  const sessions: Session[] = [];
  const builder = new Builder(p, schedule, sessions);
  for (const agent of p.agents) builder.planAgent(agent, root.fork(agent));
  builder.assignArchives(root.fork("archive"));
  return { sessions, projects: PROJECTS };
}

class Builder {
  private states = new Map<number, SessState>();

  constructor(private p: SynthParams, private schedule: Schedule, private sessions: Session[]) {}

  // ---------------------------------------------------------------- sessions

  private newSession(agent: AgentName, day: number, kind: "main" | "exec", rng: Rng, projectIdx: number): Session {
    const ds = this.schedule.days[agent][day]!;
    const legacy = agent === "codex" && codexMinor(ds.env.version) < this.p.noise.codexLegacyBelow;
    const sd = this.p.sessionEffectSd;
    const shared = rng.normal();
    const u: Partial<Record<RateKey, number>> = {};
    for (const k of RATE_KEYS) u[k] = sd * (0.6 * shared + 0.8 * rng.normal());
    const startEnv: AgentEnv = kind === "exec" ? { ...ds.env, entrypoint: "exec" } : { ...ds.env };
    const s: Session = {
      idx: this.sessions.length, agent, id: rng.uuid(), projectIdx, kind, startDay: day, startEnv,
      exchanges: [], u, resumeReplay: 0, forkReplay: 0, forkAt: 0, importStubs: 0, migrated: false, legacy,
      target: clamp(Math.round(rng.lognormal(30, 0.6)), 8, 150), closed: false,
    };
    if (kind === "main") {
      const prev = this.latestSession(agent, projectIdx);
      if (agent === "claude-code" && prev && prev.closedForResume(day) && rng.chance(this.p.noise.resumeRate)) {
        s.resumeOf = prev.s.idx;
        s.resumeReplay = Math.min(prev.s.exchanges.length, rng.int(1, 2));
      }
      if (agent === "codex") {
        if (prev && rng.chance(this.p.noise.codexForkRate)) {
          s.forkOf = prev.s.idx;
          s.forkMode = legacy ? "replay" : "history-base";
          s.forkReplay = Math.min(prev.s.exchanges.length, rng.int(1, 3));
          s.forkAt = prev.s.exchanges.length;
        } else if (!legacy && rng.chance(this.p.noise.codexImportStubRate)) {
          s.importStubs = rng.int(1, 3);
        }
        s.migrated = !legacy && rng.chance(this.p.noise.codexMigratedRate);
      }
    }
    this.sessions.push(s);
    this.states.set(s.idx, { callCounter: 0, fileLastRead: new Map(), known: [], fresh: 0, lastTemplate: -1, compacted: false });
    return s;
  }

  private latestSession(agent: AgentName, projectIdx: number): { s: Session; closedForResume: (day: number) => boolean } | undefined {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i]!;
      if (s.agent === agent && s.kind === "main" && s.projectIdx === projectIdx && s.exchanges.length > 0) {
        return {
          s,
          closedForResume: (day) => s.closed || s.exchanges[s.exchanges.length - 1]!.day < day,
        };
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- per agent

  planAgent(agent: AgentName, rng: Rng): void {
    // Changes the user types (/model, /effort, mode; Codex thread settings). The schedule keeps them in event order.
    const typedChanges = this.schedule.events.filter((e) => e.agent === agent && e.userInitiated && (e.kind === "model" || e.kind === "effort" || e.kind === "mode"));
    let nextChange = 0;
    const open: Session[] = [];
    for (let d = 0; d < this.p.days; d++) {
      const drng = rng.fork(`day${d}`);
      const dow = weekday(this.p.startDay, d);
      const weekendFactor = dow === 0 || dow === 6 ? 0.35 : 1;
      const offDay = drng.chance(0.05);
      const lambda = this.p.exchangesPerDay[agent] * weekendFactor * drng.lognormal(1, 0.3);
      // A change that takes effect today needs somebody typing it: the agent always has at least one human
      // exchange on such a day (an off day or a Poisson zero is overridden), and that exchange carries the command.
      const typed: ResolvedEvent[] = [];
      while (nextChange < typedChanges.length && typedChanges[nextChange]!.day <= d) typed.push(typedChanges[nextChange++]!);
      const active = !offDay || typed.length > 0;
      const n = active ? Math.max(typed.length > 0 ? 1 : 0, drng.poisson(lambda)) : 0;
      const blocks: { s: Session; count: number }[] = [];

      if (this.p.shape === "few-long") {
        let remaining = n;
        const blockCount = n >= 6 && drng.chance(0.4) ? 2 : 1;
        for (let b = 0; b < blockCount && remaining > 0; b++) {
          if (open.length <= b) {
            const taken = new Set(open.map((s) => s.projectIdx));
            const free = PROJECTS.map((_, i) => i).filter((i) => !taken.has(i));
            const pi = free.length ? drng.pick(free) : drng.weighted(PROJECTS.map((_, i) => i), PROJECT_WEIGHTS);
            open.push(this.newSession(agent, d, "main", drng.fork(`s${b}`), pi));
          }
          const count = b === blockCount - 1 ? remaining : Math.max(1, Math.round(remaining * 0.6));
          blocks.push({ s: open[b]!, count });
          remaining -= count;
        }
      } else {
        let remaining = n;
        let b = 0;
        while (remaining > 0) {
          const size = Math.min(remaining, drng.geometric(3.2));
          const pi = drng.weighted(PROJECTS.map((_, i) => i), PROJECT_WEIGHTS);
          blocks.push({ s: this.newSession(agent, d, "main", drng.fork(`m${b++}`), pi), count: size });
          remaining -= size;
        }
      }
      if (agent === "codex") {
        const execs = active ? drng.poisson(this.p.noise.codexExecPerDay * weekendFactor) : 0;
        for (let e = 0; e < execs; e++) {
          const pi = drng.weighted(PROJECTS.map((_, i) => i), PROJECT_WEIGHTS);
          blocks.push({ s: this.newSession(agent, d, "exec", drng.fork(`x${e}`), pi), count: 1 });
        }
      }

      // Block 0 is always a main (typed) session: n >= 1 above, and the exec threads are appended after the main blocks.
      const placed = blocks.map(({ s, count }, bi) => this.fillBlock(s, d, count, drng.fork(`block${bi}`), bi === 0 && typed.length > 0 ? typed : undefined));
      if (typed.length > 0) this.startDayWith(placed[0]!, placed.slice(1).flat(), d, drng.fork("first"));

      for (let i = open.length - 1; i >= 0; i--) {
        const s = open[i]!;
        if (s.exchanges.length >= s.target) { s.closed = true; open.splice(i, 1); }
      }
    }
  }

  /**
   * Plan the exchanges of one session-day block and place them in time. `typed`: the user-typed changes
   * that take effect today; this block's first exchange carries their commands (so it is a human one).
   */
  private fillBlock(s: Session, day: number, count: number, rng: Rng, typed?: ResolvedEvent[]): Exchange[] {
    const st = this.states.get(s.idx)!;
    const exs: Exchange[] = [];
    for (let i = 0; i < count; i++) {
      const first = s.exchanges.length === 0;
      const exec = s.kind === "exec";
      const carrier = typed !== undefined && i === 0;
      const agentStart = first && s.agent === "claude-code" && !exec && rng.chance(this.p.noise.agentInitiatedRate) && !carrier;
      const commands: UserCommand[] = carrier ? typed!.map((e) => ({ kind: e.kind as UserCommand["kind"], to: e.to, eventId: e.id })) : [];
      const ex = this.planExchange(s, st, day, !agentStart && !exec, rng.fork(`e${i}`), agentStart, commands);
      s.exchanges.push(ex);
      exs.push(ex);
    }
    // Place the exchanges of this session-day block in time.
    const durs = exs.map((e) => layoutExchange(e).endOff);
    let gaps = exs.map(() => clamp(Math.round(rng.lognormal(150_000, 0.9)), 20_000, 3_600_000));
    const span = DAY_END_MS - DAY_START_MS;
    const durSum = durs.reduce((a, b) => a + b, 0);
    const gapSum = gaps.reduce((a, b) => a + b, 0);
    if (durSum + gapSum > span) {
      const room = Math.max(0, span - durSum);
      gaps = gaps.map((g) => Math.max(1000, Math.floor((g * room) / Math.max(1, gapSum))));
    }
    const total = durs.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
    let cursor = dayMs(this.p.startDay, day) + DAY_START_MS + rng.int(0, Math.max(0, span - total));
    exs.forEach((e, i) => {
      e.startMs = cursor;
      cursor += durs[i]! + gaps[i]!;
    });
    // Clock-reset glitch: the last record of the exchange lands before its prompt.
    for (const e of exs) {
      if (e.glitchShiftMs > 0) e.glitchShiftMs += layoutExchange(e).endOff;
    }
    return exs;
  }

  /**
   * Make `carrier` (the block whose first exchange carries today's typed changes) the first activity of
   * the day: if any of `others` starts earlier, the whole carrier block slides earlier, to a random
   * moment before them. Everything the agent does today then happens after the command, so the new
   * labels and the planted effect factors (which switch at the start of the day) never show up before
   * the user typed the change, and no exchange has to be planned twice.
   */
  private startDayWith(carrier: Exchange[], others: Exchange[], day: number, rng: Rng): void {
    const first = carrier[0]!;
    const earliestOther = others.reduce((m, e) => Math.min(m, e.startMs), Infinity);
    if (first.startMs <= earliestOther) return;
    const dayStart = dayMs(this.p.startDay, day) + DAY_START_MS;
    const shift = dayStart + rng.int(0, Math.max(0, earliestOther - dayStart)) - first.startMs;
    for (const e of carrier) e.startMs += shift;
  }

  assignArchives(rng: Rng): void {
    const last = this.p.days - Math.min(14, Math.floor(this.p.days / 3));
    for (const s of this.sessions) {
      if (s.agent !== "codex" || s.startDay >= last) continue;
      if (rng.chance(this.p.noise.codexArchiveRate)) s.archive = rng.chance(2 / 3) ? "moved" : "copied";
    }
  }

  // ---------------------------------------------------------------- rates

  private rate(s: Session, factors: Partial<Record<RateKey, number>>, key: RateKey, env: AgentEnv): number {
    const base = this.p.rates[key] * (factors[key] ?? 1);
    if (key === "rejection" && (env.mode === "bypassPermissions" || s.agent === "codex")) return 0;
    if (key === "blocked" && s.agent === "codex") return 0;
    if ((key === "apiRetry" || key === "apiError") && s.agent === "codex") return 0;
    const u = s.u[key] ?? 0;
    if (PROBABILITY_KEYS.has(key)) {
      const q = clamp(base, 0, 0.97);
      return q === 0 ? 0 : shiftOdds(q, u);
    }
    return base * Math.exp(u);
  }

  // ---------------------------------------------------------------- exchanges

  private planExchange(s: Session, st: SessState, day: number, human: boolean, rng: Rng, agentStart: boolean, commands: UserCommand[]): Exchange {
    const agent = s.agent;
    const ds = this.schedule.days[agent][day]!;
    const env: AgentEnv = agent === "codex"
      ? { ...ds.env, version: s.startEnv.version, entrypoint: s.startEnv.entrypoint }
      : { ...ds.env };
    const R = (k: RateKey): number => this.rate(s, ds.factors, k, env);
    const seq = s.exchanges.length;

    // ---- prompt
    let prompt = "";
    let pushback: Exchange["pushback"] = "none";
    if (human || s.kind === "exec") {
      if (human && seq > 0 && st.lastPrompt && rng.chance(R("pushback"))) {
        pushback = rng.chance(0.25) && st.lastPrompt.length >= 40 ? "dup" : "phrase";
      }
      if (pushback === "dup") {
        prompt = st.lastPrompt!.replace(/[.?!]+$/, "") + rng.pick(V.DUPLICATE_SUFFIXES);
      } else if (pushback === "phrase") {
        const cont = V.fill(rng.pick(V.PUSHBACK_CONTINUATIONS), rng);
        prompt = V.fill(rng.pick(V.PUSHBACKS), rng, { cont });
      } else {
        let t = rng.int(0, V.PROMPTS.length - 1);
        if (t === st.lastTemplate) t = (t + 1 + rng.int(0, V.PROMPTS.length - 2)) % V.PROMPTS.length;
        st.lastTemplate = t;
        prompt = V.fill(V.PROMPTS[t]!, rng);
        if (rng.chance(0.4)) prompt += " " + V.fill(rng.pick(V.PROMPT_TAILS), rng);
      }
      if (human) st.lastPrompt = prompt;
    }

    // `commands` (slash commands evidencing a user-initiated change) are typed by a human, in a main session.
    if (commands.length > 0 && !(human && s.kind === "main")) throw new Error("planner invariant: a command needs a typed prompt in a main session");

    // ---- tool calls
    const calls = this.planCalls(st, rng.fork("calls"), R, agent);

    // ---- steps
    const steps = this.groupSteps(calls, rng.fork("steps"), R, seq, prompt.length, agentStart);

    const ex: Exchange = {
      agent, sessionIdx: s.idx, seq, day, date: dayString(this.p.startDay, day), startMs: 0, human,
      prompt, promptAsBlocks: human && agent === "claude-code" && rng.chance(0.15), pushback, env,
      config: { ...ds.config, mcp: [...ds.config.mcp] }, commands, steps, queued: [], peerNoise: false,
      hookSummary: false, otherAbort: false, glitchShiftMs: 0, afterCompaction: st.compacted,
      interruptDelayMs: rng.int(400, 5000), compactMs: rng.int(4000, 20_000), notifDelayMs: rng.int(3000, 60_000),
      tailMs: rng.int(20, 400), promptLeadMs: rng.int(150, 900),
    };
    this.shapeOutcome(ex, agent, rng.fork("outcome"), R);

    // ---- bookkeeping for the next exchange
    const finalCalls = ex.steps.flatMap((x) => x.calls);
    finalCalls.forEach((c, i) => {
      if (c.cls === "read" && c.file && c.parsed !== "search" && c.parsed !== "list_files") st.fileLastRead.set(c.file, st.callCounter + i);
      if (c.file && !st.known.includes(c.file)) st.known.push(c.file);
    });
    st.callCounter += finalCalls.length;
    if (ex.compaction) st.compacted = true;
    st.prevEnv = env;
    st.prevDay = day;
    return ex;
  }

  // ---- tool calls with read/edit/blind/churn bookkeeping

  private planCalls(st: SessState, rng: Rng, R: (k: RateKey) => number, agent: AgentName): Call[] {
    let n = clamp(Math.round(rng.lognormal(R("toolCalls") / 1.5, 0.9)), 0, 60);
    let churnFile: string | undefined;
    if (rng.chance(R("churn"))) {
      churnFile = this.newFile(st, rng);
      n = Math.max(n, 3);
    }
    const slots = Array.from({ length: n }, () => "free" as "free" | "churn");
    if (churnFile) {
      const idx = rng.shuffled(slots.map((_, i) => i)).slice(0, rng.int(3, Math.min(n, 4)));
      for (const i of idx) slots[i] = "churn";
    }
    const calls: Call[] = [];
    const readAt = new Map<string, number>();
    const edits = new Map<string, number>();
    const abs = (): number => st.callCounter + calls.length;

    const addRead = (file?: string): void => {
      const parsed = agent === "codex" ? (file ? "read" : rng.weighted(["search", "list_files"] as const, [0.7, 0.3])) : undefined;
      const tool = agent === "claude-code" ? (file ? "Read" : rng.weighted(["Grep", "Glob", "LS"], [0.55, 0.3, 0.15])) : "exec";
      const c = this.baseCall(rng, "read", tool, R, file);
      if (parsed) c.parsed = parsed as ParsedKind;
      if (file) readAt.set(file, calls.length);
      calls.push(c);
    };
    const addEdit = (file: string, blind: boolean, fresh: boolean): void => {
      const tool = agent === "claude-code"
        ? (fresh && blind ? "Write" : rng.weighted(CLAUDE_EDIT_TOOLS, CLAUDE_EDIT_WEIGHTS))
        : "apply_patch";
      const c = this.baseCall(rng, "edit", tool, R, file);
      c.blind = blind;
      edits.set(file, (edits.get(file) ?? 0) + 1);
      calls.push(c);
    };
    const needRead = (file: string): void => {
      const at = readAt.get(file);
      if (at === undefined || calls.length - at > 8) addRead(file);
    };

    for (const slot of slots) {
      if (slot === "churn") {
        needRead(churnFile!);
        addEdit(churnFile!, false, false);
        continue;
      }
      const cls = rng.weighted(["read", "edit", "other"] as const, [R("read"), R("edit"), OTHER_WEIGHT]);
      if (cls === "read") {
        const known = st.known.filter((f) => f !== churnFile);
        const file = rng.chance(0.65) ? (known.length && rng.chance(0.6) ? rng.pick(known) : this.newFile(st, rng)) : undefined;
        addRead(file);
      } else if (cls === "edit") {
        const blind = rng.chance(R("blindEdit"));
        const editable = (f: string): boolean => f !== churnFile && (edits.get(f) ?? 0) < 2;
        if (blind) {
          const stale = st.known.filter((f) => editable(f) && !readAt.has(f) && abs() - (st.fileLastRead.get(f) ?? -1000) > 12);
          if (stale.length && rng.chance(0.6)) addEdit(rng.pick(stale), true, false);
          else addEdit(this.newFile(st, rng), true, true);
        } else {
          const here = [...readAt.keys()].filter(editable);
          const pool = st.known.filter(editable);
          const file = here.length && rng.chance(0.7) ? rng.pick(here) : pool.length && rng.chance(0.5) ? rng.pick(pool) : this.newFile(st, rng);
          needRead(file);
          addEdit(file, false, false);
        }
      } else {
        const c = agent === "claude-code"
          ? this.baseCall(rng, "other", rng.weighted(CLAUDE_OTHER_TOOLS, CLAUDE_OTHER_WEIGHTS), R)
          : this.baseCall(rng, "other", "exec", R);
        if (agent === "codex" && rng.chance(0.2)) { c.mcp = true; c.tool = "mcp"; }
        if (c.tool === "Bash" || c.tool === "exec") c.cmd = V.fill(rng.pick(V.BASH_COMMANDS), rng);
        if (agent === "codex") c.parsed = "unknown";
        calls.push(c);
      }
    }
    return calls;
  }

  private newFile(st: SessState, rng: Rng): string {
    st.fresh++;
    return V.fill(`src/{module}/{noun}-${st.fresh}.{ext}`, rng);
  }

  private baseCall(rng: Rng, cls: Call["cls"], tool: string, R: (k: RateKey) => number, file?: string): Call {
    const pBlocked = R("blocked");
    const pRej = R("rejection");
    const pErr = R("toolError");
    const u = rng.next();
    let outcome: Call["outcome"] = "ok";
    let denial: Denial | undefined;
    if (u < pBlocked) {
      outcome = "blocked";
      denial = rng.weighted(["permission-rule", "automode-blocked", "automode-unavailable"] as const, [0.5, 0.3, 0.2]);
    } else if (u < pBlocked + pRej) {
      outcome = "rejected";
      denial = "user-rejected";
    } else if (u < pBlocked + pRej + pErr) {
      outcome = "error";
    }
    const execMs = cls === "read" ? rng.int(120, 1800) : cls === "edit" ? rng.int(200, 2500) : clamp(Math.round(rng.lognormal(2200, 1)), 150, 90_000);
    const c: Call = { id: rng.hex(16), cls, tool, outcome, execMs };
    if (file) c.file = file;
    if (denial) c.denial = denial;
    return c;
  }

  // ---- group calls into model responses

  private groupSteps(calls: Call[], rng: Rng, R: (k: RateKey) => number, seq: number, promptChars: number, agentStart: boolean): Step[] {
    const groups: Call[][] = [];
    let cur: Call[] = [];
    let target = rng.weighted([1, 2, 3], [0.72, 0.2, 0.08]);
    const readInGroup = new Set<string>();
    for (const c of calls) {
      const conflict = c.cls === "edit" && c.file !== undefined && readInGroup.has(c.file);
      if (cur.length && (cur.length >= target || conflict)) {
        groups.push(cur);
        cur = [];
        readInGroup.clear();
        target = rng.weighted([1, 2, 3], [0.72, 0.2, 0.08]);
      }
      cur.push(c);
      if (c.cls === "read" && c.file) readInGroup.add(c.file);
    }
    if (cur.length) groups.push(cur);
    groups.push([]); // final answer

    return groups.map((g, i) => {
      const last = i === groups.length - 1;
      const step = this.makeStep(rng, R, seq, i, promptChars, g, last);
      if (i === 0 && agentStart) step.afterNotification = true;
      return step;
    });
  }

  private makeStep(rng: Rng, R: (k: RateKey) => number, seq: number, idx: number, promptChars: number, calls: Call[], last: boolean): Step {
    let thinking: Step["thinking"];
    if (rng.chance(R("thinkProb"))) {
      const redacted = rng.chance(R("thinkRedacted"));
      const chars = Math.max(40, Math.round(R("thinkDepth") * rng.lognormal(1, 0.35)));
      thinking = { chars, redacted, text: redacted ? "" : V.fill(rng.pick(V.THINKING), rng) };
    }
    let text: string | undefined;
    if (last) text = V.fill(rng.pick(V.AGENT_SUMMARIES), rng);
    else if (rng.chance(0.4)) text = V.fill(rng.pick(idx === 0 ? V.AGENT_PLANS : V.AGENT_MIDWAY), rng);
    // The outTok factor scales ALL output tokens of a step (answer + thinking), so it is recoverable from token counts.
    const outScale = R("outTok") / this.p.rates.outTok;
    const out = Math.max(5, Math.round(outScale * (rng.lognormal(this.p.rates.outTok * 0.8, 0.7) + (thinking ? thinking.chars * 0.25 : 0))));
    const usage: Usage = {
      in: idx === 0 ? Math.max(1, Math.round(promptChars / 4)) : rng.int(2, 30),
      out,
      cacheRead: Math.round(rng.lognormal(30_000 + Math.min(seq, 60) * 1200 + idx * 800, 0.2)),
      cacheWrite: Math.round(rng.lognormal(1500, 0.8)),
    };
    const latencyMs = clamp(Math.round(rng.lognormal(5000, 0.7)), 600, 80_000) + (thinking ? Math.round(thinking.chars * 1.5) : 0);
    const step: Step = { rid: rng.hex(20), latencyMs, calls, usage, retries: [] };
    if (thinking) step.thinking = thinking;
    if (text) step.text = text;
    if (rng.chance(R("apiRetry"))) {
      const k = rng.int(1, 3);
      for (let i = 0; i < k; i++) step.retries.push({ status: rng.pick([429, 500, 529]), retryInMs: 500 * 2 ** i });
    }
    if (rng.chance(0.01)) step.metaContinue = true;
    if (rng.chance(0.01)) step.maxTokens = true;
    return step;
  }

  // ---- interrupts, failures, queueing, compaction, subagents

  private shapeOutcome(ex: Exchange, agent: AgentName, rng: Rng, R: (k: RateKey) => number): void {
    const steps = ex.steps;

    // Final API failure (Claude only; Codex rates are 0).
    const pFail = 1 - (1 - R("apiError")) ** steps.length;
    let failed = false;
    if (pFail > 0 && rng.chance(pFail)) {
      const f = rng.int(0, steps.length - 1);
      steps.length = f;
      const n = rng.int(3, 5);
      const retries = Array.from({ length: n }, (_, i) => ({ status: 529, retryInMs: 500 * 2 ** i }));
      steps.push({ rid: rng.hex(20), latencyMs: 0, calls: [], usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, retries, failed: true });
      failed = true;
    }

    // Interrupt (or a non-user abort for Codex).
    if (!failed) {
      const wantInterrupt = rng.chance(R("interrupt"));
      const wantOther = agent === "codex" && !wantInterrupt && rng.chance(this.p.noise.codexOtherAbortRate);
      if (wantInterrupt || wantOther) {
        const kind: "text" | "tool-use" = agent === "claude-code" && wantInterrupt && rng.chance(0.2) ? "tool-use" : "text";
        if (kind === "tool-use") {
          const withCalls = steps.map((x, i) => (x.calls.length ? i : -1)).filter((i) => i >= 0);
          const at = withCalls.length ? rng.pick(withCalls) : steps.length - 1;
          steps.length = at + 1;
          const step = steps[at]!;
          if (!step.calls.length) {
            step.calls.push({ id: rng.hex(16), cls: "other", tool: "Bash", outcome: "ok", execMs: rng.int(150, 2000), cmd: V.fill(rng.pick(V.BASH_COMMANDS), rng) });
          }
          const lastCall = step.calls[step.calls.length - 1]!;
          lastCall.outcome = "rejected";
          lastCall.denial = "user-rejected";
          ex.interrupt = "tool-use";
        } else {
          const at = rng.int(0, steps.length - 1);
          steps.length = at + 1;
          const step = steps[at]!;
          step.calls = [];
          if (!step.text) step.text = V.fill(rng.pick(V.AGENT_MIDWAY), rng);
          if (wantInterrupt) ex.interrupt = "text";
          else ex.otherAbort = true;
        }
      }
    }
    const closed = failed || ex.interrupt !== undefined || ex.otherAbort;

    // Background-task notification wakes the agent after the answer (Claude only).
    if (!closed && agent === "claude-code" && rng.chance(this.p.noise.notificationRate) && !steps[0]!.afterNotification) {
      const extra = this.makeStep(rng.fork("notif"), R, ex.seq, steps.length, 0, [], true);
      extra.afterNotification = true;
      steps.push(extra);
    }

    // Subagent spawn: attached to a step that already runs tools.
    if (rng.chance(R("subagent"))) {
      let withCalls = steps.map((x, i) => (x.calls.length && !x.failed ? i : -1)).filter((i) => i >= 0);
      // A tool-use interrupt ends on the rejected call: nothing is launched after it, so the interrupted step is off limits.
      if (ex.interrupt === "tool-use") withCalls = withCalls.filter((i) => i !== steps.length - 1);
      if (withCalls.length) {
        const sub = this.planSub(rng.fork("sub"), R, agent);
        const call: Call = {
          id: rng.hex(16), cls: "spawn", tool: agent === "claude-code" ? "Task" : "collab",
          outcome: rng.chance(R("toolError")) ? "error" : "ok",
          execMs: sub.steps.reduce((a, x) => a + x.latencyMs + x.calls.reduce((m, c) => Math.max(m, c.execMs), 0), 0) + rng.int(200, 1500),
          sub,
        };
        steps[rng.pick(withCalls)]!.calls.push(call);
      }
    }

    // Prompts typed mid-turn (delivered before a later step).
    const nq = steps.length >= 2 ? rng.poisson(R("queued")) : 0;
    for (let i = 0; i < nq; i++) {
      const afterStep = rng.int(0, steps.length - 2);
      if (steps[afterStep]!.failed) continue;
      ex.queued.push({ text: V.fill(rng.pick(V.QUEUED), rng), afterStep });
    }
    ex.queued.sort((a, b) => a.afterStep - b.afterStep);

    // Compaction before a step, once the session has run a while.
    if (ex.seq >= 4 && rng.chance(R("compaction"))) {
      const live = steps.map((x, i) => (x.failed ? -1 : i)).filter((i) => i >= 0);
      if (live.length) {
        const c: Compaction = {
          atStep: rng.pick(live), preTokens: rng.int(150_000, 190_000), postTokens: rng.int(6000, 14_000),
          trigger: rng.chance(0.85) ? "auto" : "manual",
        };
        ex.compaction = c;
      }
    }

    // Side records.
    ex.peerNoise = agent === "claude-code" && rng.chance(this.p.noise.peerNoiseRate);
    ex.hookSummary = agent === "claude-code" && ex.config.hooks > 0 && rng.chance(this.p.noise.hookSummaryRate);
    if (rng.chance(this.p.noise.clockGlitchRate)) ex.glitchShiftMs = rng.int(60_000, 3 * HOUR);
  }

  private planSub(rng: Rng, R: (k: RateKey) => number, agent: AgentName): SubPlan {
    const n = rng.int(2, 5);
    const steps: SubStep[] = [];
    for (let i = 0; i < n; i++) {
      const calls: Call[] = [];
      if (i < n - 1) {
        const k = rng.int(1, 3);
        for (let j = 0; j < k; j++) {
          const read = rng.chance(0.6);
          const tool = agent === "claude-code" ? (read ? rng.weighted(CLAUDE_READ_TOOLS, CLAUDE_READ_WEIGHTS) : "Bash") : "exec";
          const c = this.baseCall(rng, read ? "read" : "other", tool, (key) => (key === "rejection" || key === "blocked" ? 0 : R(key)));
          if (read && tool === "Read") c.file = V.fill("src/{module}/{noun}.{ext}", rng);
          if (!read) c.cmd = V.fill(rng.pick(V.BASH_COMMANDS), rng);
          if (agent === "codex") c.parsed = read ? "search" : "unknown";
          calls.push(c);
        }
      }
      steps.push({
        rid: rng.hex(20), latencyMs: clamp(Math.round(rng.lognormal(3500, 0.6)), 500, 40_000), calls,
        usage: {
          in: rng.int(2, 40), out: Math.max(5, Math.round(rng.lognormal(220, 0.7))),
          cacheRead: Math.round(rng.lognormal(18_000, 0.3)), cacheWrite: Math.round(rng.lognormal(1200, 0.7)),
        },
        ...(i === n - 1 ? { text: V.fill(rng.pick(V.SUBAGENT_RESULTS), rng) } : {}),
      });
    }
    const sub: SubPlan = {
      agentId: rng.hex(17), prompt: V.fill(rng.pick(V.SUBAGENT_PROMPTS), rng), resultText: V.fill(rng.pick(V.SUBAGENT_RESULTS), rng), steps,
    };
    if (agent === "claude-code" && rng.chance(0.25)) sub.workflow = rng.hex(8);
    return sub;
  }
}
