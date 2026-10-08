/**
 * Subagent transcripts. Their work is context for the exchange that spawned them (subToolCalls/subTokens) and,
 * since D62a, research work (subReads/subEdits/subBlindEdits) that the research metrics count with the main
 * thread's. They never create exchanges or add to main-thread counts.
 *
 * Attribution, most to least reliable:
 *  1. the main thread's Agent tool result names the subagent (`toolUseResult.agentId`);
 *  2. a Workflow tool result names the run folder (`runId` / `taskId` / transcriptDir basename);
 *  3. the subagent was spawned by another subagent → follow that chain;
 *  4. timestamp fallback: the exchange in progress when the subagent started.
 *
 * Copies of the main thread's own records inside a subagent transcript (a forked subagent may carry its parent's
 * context: same record uuid, tool_use id or response key) are never counted as the subagent's work; their files
 * still count as seen by the subagent (blind-edit rule: types.ts `subBlindEdits`).
 */
import { basename, dirname } from "node:path";
import type { FileStamp, ParseContext, ParseStats } from "../../types.js";
import { cleanTime, noteBadTime, obj, readJsonl } from "../../util.js";
import type { ExchangeAcc } from "./exchange.js";
import { blocks, str, stepKey, toolUse, type Rec } from "./records.js";
import { StepMerger, type TokenSink } from "./steps.js";
import { countUnknown, isKnownType } from "./kinds.js";

/** What the main thread of the same session logged (it is read before its subagents). */
export interface MainView {
  /** A record uuid the main transcript holds. */
  hasRecord(uuid: string): boolean;
  /** A tool_use id the main transcript holds. */
  hasToolUse(id: string): boolean;
  /** A model response (merge key) the main transcript holds. */
  hasStep(key: string): boolean;
}

const NO_MAIN: MainView = { hasRecord: () => false, hasToolUse: () => false, hasStep: () => false };

export interface SpawnLinks {
  agents: Map<string, ExchangeAcc>;
  runs: Map<string, ExchangeAcc>;
}

/** Keys a tool result offers for linking subagent transcripts (in memory only). */
export function spawnKeys(toolUseResult: unknown): { agents: string[]; runs: string[] } {
  const r = obj(toolUseResult);
  if (!r) return { agents: [], runs: [] };
  const agents = [str(r.agentId)].filter((x): x is string => !!x);
  const runs = [str(r.runId), str(r.taskId)].filter((x): x is string => !!x);
  const dir = str(r.transcriptDir);
  if (dir) runs.push(basename(dir.replace(/[\\/]+$/, "")));
  return { agents, runs };
}

export class SubagentAcc implements TokenSink {
  readonly agentId: string | undefined;
  /** Run folder name for workflow subagents (subagents/workflows/<run>/agent-*.jsonl). */
  readonly runDir: string | undefined;
  firstMs: number | undefined;
  toolCalls = 0;
  inTok = 0;
  outTok = 0;
  cacheRead = 0;
  cacheWrite = 0;
  /** Research work (D62a): read and edit calls, and the paths of modifying edits to files this subagent had not seen. */
  reads = 0;
  edits = 0;
  readonly unseenEdits: string[] = [];
  /** Files whose content this subagent has seen (paths in memory only, never stored). */
  private readonly seenPaths = new Set<string>();
  readonly spawnedAgents: string[] = [];
  readonly spawnedRuns: string[] = [];

  constructor(path: string) {
    const name = basename(path, ".jsonl");
    this.agentId = name.startsWith("agent-") ? name.slice(6) || undefined : undefined;
    const parent = dirname(path);
    this.runDir = basename(dirname(parent)) === "workflows" ? basename(parent) : undefined;
  }

  get tokens(): number {
    return this.inTok + this.outTok + this.cacheRead + this.cacheWrite;
  }

  /** One of the subagent's own tool calls. */
  tool(b: Rec): void {
    const t = toolUse(b);
    this.toolCalls++;
    if (t.isRead) this.reads++;
    if (t.isEdit) this.edits++;
    if (!t.path) return; // without a path blindness can't be judged (as on the main thread)
    if (t.modifies && !this.seenPaths.has(t.path)) this.unseenEdits.push(t.path);
    if (t.knows) this.seenPaths.add(t.path);
  }

  /** A tool call inherited from the main thread: not this subagent's work, but its file is known to the subagent. */
  inherited(b: Rec): void {
    const t = toolUse(b);
    if (t.path && t.knows) this.seenPaths.add(t.path);
  }
}

export async function readSubagent(f: FileStamp, ctx: ParseContext, stats: ParseStats, main: MainView = NO_MAIN): Promise<SubagentAcc> {
  const acc = new SubagentAcc(f.path);
  const seen = new Set<string>();
  const seenTools = new Set<string>();
  const steps = new StepMerger<SubagentAcc>();
  for await (const d of readJsonl(f.path, stats)) {
    const type = typeof d.type === "string" ? d.type : undefined;
    const uuid = str(d.uuid);
    if (uuid !== undefined) {
      if (seen.has(uuid)) { stats.duplicates++; continue; }
      seen.add(uuid);
      if (main.hasRecord(uuid)) {
        // A copy of a main-thread record (forked context): counted there; only its files become known here.
        stats.duplicates++;
        if (type === "assistant") for (const b of blocks(obj(d.message)?.content)) if (b.type === "tool_use") acc.inherited(b);
        continue;
      }
    }
    if (d.timestamp !== undefined) {
      const ts = cleanTime(d.timestamp, ctx.now);
      if (!ts) noteBadTime(stats, d.timestamp, ctx.now);
      else if (acc.firstMs === undefined) acc.firstMs = Date.parse(ts);
    }
    if (type === "assistant") assistant(d, acc, steps, seenTools, stats, main);
    else if (type === "user") {
      const keys = spawnKeys(d.toolUseResult);
      acc.spawnedAgents.push(...keys.agents);
      acc.spawnedRuns.push(...keys.runs);
    } else if (!isKnownType(type)) countUnknown(stats, type);
  }
  return acc;
}

function assistant(d: Rec, acc: SubagentAcc, steps: StepMerger<SubagentAcc>, seenTools: Set<string>, stats: ParseStats, main: MainView): void {
  const msg = obj(d.message);
  if (!msg || d.isApiErrorMessage === true || msg.model === "<synthetic>") return;
  const key = stepKey(d, msg);
  if (main.hasStep(key)) stats.duplicates++; // a main-thread response re-logged here: its tokens are counted there
  else if (!steps.observe(key, msg.usage, acc)) stats.duplicates++;
  for (const b of blocks(msg.content)) {
    if (b.type !== "tool_use") continue;
    const id = str(b.id);
    if (id !== undefined) {
      if (seenTools.has(id)) continue;
      seenTools.add(id);
      if (main.hasToolUse(id)) { acc.inherited(b); continue; }
    }
    acc.tool(b);
  }
}

/** Credit each subagent's work to the exchange that spawned it. */
export function attributeSubagents(subs: readonly SubagentAcc[], links: SpawnLinks, exchanges: readonly ExchangeAcc[]): void {
  if (!exchanges.length) return;
  const kept = new Set(exchanges);
  const parentByAgent = new Map<string, SubagentAcc>();
  const parentByRun = new Map<string, SubagentAcc>();
  for (const s of subs) {
    for (const a of s.spawnedAgents) if (!parentByAgent.has(a)) parentByAgent.set(a, s);
    for (const r of s.spawnedRuns) if (!parentByRun.has(r)) parentByRun.set(r, s);
  }
  const starts = exchanges.map((x) => (x.t ? Date.parse(x.t) : NaN));

  const byTime = (ms: number | undefined): ExchangeAcc => {
    if (ms === undefined) return exchanges[exchanges.length - 1]!;
    let best = -1;
    for (let i = 0; i < exchanges.length; i++) {
      const s = starts[i]!;
      if (s <= ms && (best === -1 || s >= starts[best]!)) best = i;
    }
    if (best !== -1) return exchanges[best]!;
    // Clock skew: nothing started before it; the nearest start is the best guess.
    let near = 0;
    for (let i = 1; i < exchanges.length; i++) if (Math.abs(starts[i]! - ms) < Math.abs(starts[near]! - ms)) near = i;
    return exchanges[near]!;
  };

  const resolve = (s: SubagentAcc, depth: number): ExchangeAcc => {
    const direct = (s.agentId !== undefined ? links.agents.get(s.agentId) : undefined) ?? (s.runDir !== undefined ? links.runs.get(s.runDir) : undefined);
    if (direct && kept.has(direct)) return direct;
    const parent = (s.agentId !== undefined ? parentByAgent.get(s.agentId) : undefined) ?? (s.runDir !== undefined ? parentByRun.get(s.runDir) : undefined);
    if (parent && parent !== s && depth < 16) return resolve(parent, depth + 1);
    return byTime(s.firstMs);
  };

  for (const s of subs) {
    const x = resolve(s, 0);
    x.subToolCalls += s.toolCalls;
    x.subTokens += s.tokens;
    x.delegated(s.reads, s.edits, s.unseenEdits);
  }
}
