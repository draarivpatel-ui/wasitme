/**
 * Ground truth. Everything here is computed from the planned script (the same object the renderers
 * serialise), so it is what was planted - not what some parser later recovers.
 *
 * Row field names mirror the engine's `Exchange` contract so reader tests can diff directly, but this
 * module does not import it. `null` means "implementation-defined: do not assert" (e.g. thinking
 * metrics for Codex, prompt length of agent-initiated exchanges).
 */
import { layoutExchange } from "./layout.js";
import type { Call, Exchange, Project, Session } from "./model.js";
import type { AgentName, SynthParams } from "./params.js";
import { isClaudeModern } from "./schedule.js";

export interface ExchangeMetrics {
  humanPrompt: 0 | 1;
  promptChars: number | null;
  interrupted: 0 | 1;
  pushback: 0 | 1;
  pushbackKind: "none" | "phrase" | "dup";
  queuedMidTurn: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  rejections: number;
  blocked: number;
  reads: number;
  edits: number;
  blindEdits: number;
  churned: 0 | 1;
  outTok: number;
  inTok: number;
  cacheRead: number;
  cacheWrite: number;
  apiErrors: number;
  apiRetries: number;
  compactions: number;
  thinkBlocks: number | null;
  thinkRedacted: number | null;
  thinkSigMedian: number | null;
  /** Sum of thinking signature lengths (Claude only) - lets tests compute pooled means. */
  thinkSigSum: number | null;
  subToolCalls: number;
  subOutTok: number;
  subInTok: number;
  subCacheRead: number;
  subCacheWrite: number;
  /** Prompt (or first record) to last activity record. Excludes slash-command bookkeeping. */
  durationMs: number;
  /** True when the last record carries a timestamp from before the prompt (a clock reset). */
  clockGlitch: boolean;
  /** Codex turn aborted for a non-user reason (not an interrupt). */
  otherAbort: boolean;
}

export interface TruthExchange extends ExchangeMetrics {
  agent: AgentName;
  /** Output-relative path of the session file. */
  session: string;
  sessionId: string;
  project: string;
  seq: number;
  /** ISO timestamp of the prompt (or first record). */
  t: string;
  /** UTC calendar day. */
  day: string;
  version: string;
  model: string;
  servedModel: string;
  effort: string;
  mode: string;
  entrypoint: string;
  afterCompaction: boolean;
  /** Non-interactive Codex `exec` thread (prompt supplied by a script, not typed). */
  automated: boolean;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function exchangeMetrics(ex: Exchange): ExchangeMetrics {
  const calls: Call[] = ex.steps.flatMap((s) => s.calls);
  const live = ex.steps.filter((s) => !s.failed);
  const edits = new Map<string, number>();
  for (const c of calls) if (c.cls === "edit" && c.file) edits.set(c.file, (edits.get(c.file) ?? 0) + 1);

  let sub = { calls: 0, out: 0, in: 0, cr: 0, cw: 0 };
  for (const c of calls) {
    if (!c.sub) continue;
    for (const st of c.sub.steps) {
      sub = {
        calls: sub.calls + st.calls.length, out: sub.out + st.usage.out, in: sub.in + st.usage.in,
        cr: sub.cr + st.usage.cacheRead, cw: sub.cw + st.usage.cacheWrite,
      };
    }
  }

  const claude = ex.agent === "claude-code";
  const blocks = live.flatMap((s) => (s.thinking ? [s.thinking] : []));
  const human = ex.human;
  const layout = layoutExchange(ex);

  return {
    humanPrompt: human ? 1 : 0,
    promptChars: human ? ex.prompt.length : null,
    interrupted: ex.interrupt ? 1 : 0,
    pushback: ex.pushback === "none" ? 0 : 1,
    pushbackKind: ex.pushback,
    queuedMidTurn: ex.queued.length,
    steps: live.length,
    toolCalls: calls.length,
    toolErrors: calls.filter((c) => c.outcome === "error").length,
    rejections: calls.filter((c) => c.outcome === "rejected").length,
    blocked: calls.filter((c) => c.outcome === "blocked").length,
    reads: calls.filter((c) => c.cls === "read").length,
    edits: calls.filter((c) => c.cls === "edit").length,
    blindEdits: calls.filter((c) => c.cls === "edit" && c.blind).length,
    churned: [...edits.values()].some((n) => n >= 3) ? 1 : 0,
    outTok: live.reduce((a, s) => a + s.usage.out, 0),
    inTok: live.reduce((a, s) => a + s.usage.in, 0),
    cacheRead: live.reduce((a, s) => a + s.usage.cacheRead, 0),
    cacheWrite: live.reduce((a, s) => a + s.usage.cacheWrite, 0),
    apiErrors: ex.steps.filter((s) => s.failed).length,
    apiRetries: ex.steps.reduce((a, s) => a + s.retries.length, 0),
    compactions: ex.compaction ? 1 : 0,
    thinkBlocks: claude ? blocks.length : null,
    thinkRedacted: claude ? blocks.filter((b) => b.redacted).length : null,
    thinkSigMedian: claude ? median(blocks.map((b) => b.chars)) : null,
    thinkSigSum: claude ? blocks.reduce((a, b) => a + b.chars, 0) : null,
    subToolCalls: sub.calls,
    subOutTok: sub.out,
    subInTok: sub.in,
    subCacheRead: sub.cr,
    subCacheWrite: sub.cw,
    durationMs: layout.endOff,
    clockGlitch: ex.glitchShiftMs > 0,
    otherAbort: ex.otherAbort,
  };
}

export function truthRow(ex: Exchange, session: Session, fileKey: string, project: Project): TruthExchange {
  const m = exchangeMetrics(ex);
  // Claude writes effort / permissionMode only from the "modern" CLI versions on; effort lives on real
  // assistant records (none in an exchange whose only request failed) and the mode on the human prompt.
  const claude = ex.agent === "claude-code";
  const modern = !claude || isClaudeModern(ex.env.version);
  const hasLive = m.steps > 0;
  return {
    ...m,
    agent: ex.agent,
    session: fileKey,
    sessionId: session.id,
    project: project.name,
    seq: ex.seq,
    t: new Date(ex.startMs).toISOString(),
    day: ex.date,
    version: ex.env.version,
    model: !claude || hasLive ? ex.env.model : "unknown",
    servedModel: !claude || hasLive ? ex.env.model : "unknown",
    effort: modern && (!claude || hasLive) ? ex.env.effort : "unknown",
    mode: modern && (!claude || ex.human) ? ex.env.mode : "unknown",
    entrypoint: ex.env.entrypoint,
    afterCompaction: ex.afterCompaction,
    automated: session.kind === "exec",
  };
}

export const SUMMED_KEYS = [
  "humanPrompt", "interrupted", "pushback", "queuedMidTurn", "steps", "toolCalls", "toolErrors", "rejections",
  "blocked", "reads", "edits", "blindEdits", "churned", "outTok", "inTok", "cacheRead", "cacheWrite", "apiErrors",
  "apiRetries", "compactions", "subToolCalls", "subOutTok",
] as const;

export interface DayAggregate {
  day: string;
  exchanges: number;
  /** Exchanges that are human-prompted and not the first of their session (pushback denominator). */
  pushbackEligible: number;
  thinkBlocks: number;
  thinkRedacted: number;
  thinkSigSum: number;
  version: string;
  model: string;
  effort: string;
  mode: string;
  sums: Record<(typeof SUMMED_KEYS)[number], number>;
}

/** Per-day sums of the truth rows (UTC days), one row per day with at least one exchange. */
export function perDay(rows: TruthExchange[], agent: AgentName): DayAggregate[] {
  const byDay = new Map<string, DayAggregate>();
  for (const r of rows) {
    if (r.agent !== agent) continue;
    let d = byDay.get(r.day);
    if (!d) {
      d = {
        day: r.day, exchanges: 0, pushbackEligible: 0, thinkBlocks: 0, thinkRedacted: 0, thinkSigSum: 0,
        version: r.version, model: r.model, effort: r.effort, mode: r.mode,
        sums: Object.fromEntries(SUMMED_KEYS.map((k) => [k, 0])) as DayAggregate["sums"],
      };
      byDay.set(r.day, d);
    }
    d.exchanges++;
    if (r.humanPrompt && r.seq > 0) d.pushbackEligible++;
    d.thinkBlocks += r.thinkBlocks ?? 0;
    d.thinkRedacted += r.thinkRedacted ?? 0;
    d.thinkSigSum += r.thinkSigSum ?? 0;
    for (const k of SUMMED_KEYS) d.sums[k] += r[k];
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function describeParams(p: SynthParams): Record<string, unknown> {
  return JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
}
