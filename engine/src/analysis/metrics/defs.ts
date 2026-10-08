/**
 * Metric definitions (METHOD.md §3): one row per metric, each a ratio of totals Σnum / Σden over a window.
 *
 * Units and eligibility (who contributes to a metric):
 *  - Tool-call metrics (tool errors and their split variants, reads per edit, blind edits) count the work
 *    of every main-thread exchange in a session, including agent-initiated / resumed stretches
 *    (`humanPrompt` 0): that work really ran.
 *  - Exchange metrics (interrupts, pushback, churn, steps, prompt length, …) count only real human
 *    prompts (`humanPrompt` 1) — METHOD.md §2 defines an exchange as one real human prompt — in both the
 *    numerator and the denominator, so a stretch without a prompt can never push a rate above 100%.
 *
 * Research metrics (reads per edit, blind edits) count the exchange's whole work: its main thread plus the work of
 * the subagents attributed to it (`subReads`, `subEdits`, `subBlindEdits`; D62a), so a vendor change in how much
 * work is delegated can't pass for a change in how carefully the agent works. Logs parsed before those fields
 * existed carry none (counted as 0); their history is re-derived or paused by the research parser version.
 *
 * Tool errors exclude user rejections and permission/auto-mode blocks from BOTH sides: the readers count
 * every tool_use in `toolCalls` (rejected and blocked ones included), so the denominator is the calls that
 * actually ran, `toolCalls − rejections − blocked`.
 *
 * The tool-error split (the construct check behind D47(d) and D61) needs fields that land at the contract freeze
 * (`toolErrorsEdit`, `toolErrorsCmd`) plus one this work package proposes (`cmdCalls`, command calls that
 * ran). Until a reader supplies them, the split variants are ineligible with reason "fields_missing" —
 * never guessed.
 *
 * "1 pt" (`point`, in rate units) is the absolute floor for materiality: 0.01 for percentage metrics
 * (1 percentage point), 1.0 for reads per edit, null where METHOD.md §3 defines none (churn, context).
 */
import type { Exchange } from "../../types.js";
import type { VarianceFloor } from "../stats/bootstrap.js";

/** Kept as an alias: the optional metric fields (`cmdCalls`, `promptEnglish`, the split, the class) now live on Exchange. */
export type MetricExchange = Exchange;

export type MetricId =
  | "toolErrors" | "toolErrorsNonCmd" | "cmdFailures"
  | "readsPerEdit" | "blindEdits"
  | "interrupts" | "pushback"
  | "churn"
  | "steps" | "outTokPerStep" | "cacheHit" | "apiRetries" | "apiErrors" | "compactions"
  | "thinkRedacted" | "promptChars" | "durationMs";

export type Family = "errors" | "research" | "friction" | "context";
export type Role = "vote" | "support" | "context";
export type Direction = "up" | "down";

/** Voting families (D30: friction supports but never decides). */
export const VOTING_FAMILIES: readonly Family[] = Object.freeze(["errors", "research"]);

/** Which tool-error construct votes for the errors family (D47(d), D61). */
export type ToolErrorVariant = "toolErrors" | "toolErrorsNonCmd" | "cmdFailures";
export const TOOL_ERROR_VARIANTS: readonly ToolErrorVariant[] = Object.freeze(["toolErrors", "toolErrorsNonCmd", "cmdFailures"]);

export interface Contribution {
  num: number;
  den: number;
}

export interface MetricDef {
  id: MetricId;
  family: Family;
  /** Role unless overridden (the tool-error variant choice decides which errors metric votes). */
  role: Role;
  /** Which direction counts as "worse" (an assumption, not validated quality); null = no direction. */
  worse: Direction | null;
  /** Display multiplier for the rate (100 → "per 100 …"). */
  scale: number;
  /** Short unit text for engineering output; user-facing words belong to WP-22. */
  unit: string;
  /** Materiality floor in rate units ("1 pt"); null = no absolute floor. */
  point: number | null;
  /** Variance floor kind: "binomial" when num ≤ den per exchange, else "poisson". */
  floor: VarianceFloor;
  /** True when num ≤ den holds per exchange; contributions are clamped (and counted) otherwise. */
  proportion: boolean;
  /** Extra per-window denominator gate (readsPerEdit: 40 edits). */
  minDenominator: number;
  /** Which exchanges count: all main-thread work, or real human prompts only. */
  unitOf: "work" | "prompt";
  /** Fields that must be present (finite numbers) on the exchange for this metric to be computed. */
  requires: readonly (keyof MetricExchange)[];
  /** Raw (unclamped) contribution of one eligible exchange. */
  extract(x: MetricExchange): Contribution;
}

/** Finite, non-negative number or 0 (inputs come from parsed logs). */
export function nn(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Reads of the exchange's whole work: main thread + attributed subagents (D62a). */
export function allReads(x: Exchange): number {
  return nn(x.reads) + nn(x.subReads);
}

/** Edits of the exchange's whole work: main thread + attributed subagents (D62a). */
export function allEdits(x: Exchange): number {
  return nn(x.edits) + nn(x.subEdits);
}

/** Blind edits of the exchange's whole work: main thread + attributed subagents (D62a). */
export function allBlindEdits(x: Exchange): number {
  return nn(x.blindEdits) + nn(x.subBlindEdits);
}

/** Tool calls that actually ran: rejections and permission/auto-mode blocks never ran. */
export function executedCalls(x: Exchange): number {
  return Math.max(0, nn(x.toolCalls) - nn(x.rejections) - nn(x.blocked));
}

const PCT = 0.01;

function def(d: Omit<MetricDef, "minDenominator" | "requires" | "proportion"> & Partial<Pick<MetricDef, "minDenominator" | "requires" | "proportion">>): MetricDef {
  return Object.freeze({
    minDenominator: 0,
    requires: [],
    proportion: d.floor === "binomial",
    ...d,
  });
}

/** Every metric, in display order (voting → support → context). */
export const METRICS: readonly MetricDef[] = Object.freeze([
  def({
    id: "toolErrors", family: "errors", role: "vote", worse: "up", scale: 100, unit: "per 100 tool calls",
    point: PCT, floor: "binomial", unitOf: "work",
    extract: (x) => ({ num: nn(x.toolErrors), den: executedCalls(x) }),
  }),
  def({
    id: "toolErrorsNonCmd", family: "errors", role: "context", worse: "up", scale: 100, unit: "per 100 non-command tool calls",
    point: PCT, floor: "binomial", unitOf: "work", requires: ["toolErrorsEdit", "cmdCalls"],
    extract: (x) => ({ num: nn(x.toolErrorsEdit), den: Math.max(0, executedCalls(x) - nn(x.cmdCalls)) }),
  }),
  def({
    id: "cmdFailures", family: "errors", role: "context", worse: "up", scale: 100, unit: "per 100 command calls",
    point: PCT, floor: "binomial", unitOf: "work", requires: ["toolErrorsCmd", "cmdCalls"],
    extract: (x) => ({ num: nn(x.toolErrorsCmd), den: nn(x.cmdCalls) }),
  }),
  def({
    id: "readsPerEdit", family: "research", role: "vote", worse: "down", scale: 1, unit: "reads per edit",
    point: 1, floor: "poisson", unitOf: "work", minDenominator: 40,
    extract: (x) => ({ num: allReads(x), den: allEdits(x) }),
  }),
  def({
    id: "blindEdits", family: "research", role: "vote", worse: "up", scale: 100, unit: "per 100 edits",
    point: PCT, floor: "binomial", unitOf: "work",
    extract: (x) => ({ num: allBlindEdits(x), den: allEdits(x) }),
  }),
  def({
    id: "interrupts", family: "friction", role: "support", worse: "up", scale: 100, unit: "per 100 exchanges",
    point: PCT, floor: "binomial", unitOf: "prompt",
    extract: (x) => ({ num: x.interrupted === 1 ? 1 : 0, den: 1 }),
  }),
  def({
    id: "pushback", family: "friction", role: "support", worse: "up", scale: 100, unit: "per 100 prompts",
    point: PCT, floor: "binomial", unitOf: "prompt",
    extract: (x) => ({ num: x.pushback === 1 ? 1 : 0, den: 1 }),
  }),
  def({
    id: "churn", family: "context", role: "context", worse: "up", scale: 100, unit: "per 100 exchanges with edits",
    point: null, floor: "binomial", unitOf: "prompt",
    extract: (x) => (nn(x.edits) > 0 ? { num: x.churned === 1 ? 1 : 0, den: 1 } : { num: 0, den: 0 }),
  }),
  def({
    id: "steps", family: "context", role: "context", worse: null, scale: 1, unit: "model responses per exchange",
    point: null, floor: "poisson", unitOf: "prompt",
    extract: (x) => ({ num: nn(x.steps), den: 1 }),
  }),
  def({
    id: "outTokPerStep", family: "context", role: "context", worse: null, scale: 1, unit: "output tokens per response",
    point: null, floor: "poisson", unitOf: "prompt",
    extract: (x) => ({ num: nn(x.outTok), den: nn(x.steps) }),
  }),
  def({
    id: "cacheHit", family: "context", role: "context", worse: "down", scale: 100, unit: "per 100 input tokens",
    point: null, floor: "binomial", unitOf: "prompt",
    extract: (x) => ({ num: nn(x.cacheRead), den: nn(x.cacheRead) + nn(x.inTok) + nn(x.cacheWrite) }),
  }),
  def({
    id: "apiRetries", family: "context", role: "context", worse: "up", scale: 100, unit: "per 100 exchanges",
    point: null, floor: "poisson", unitOf: "prompt",
    extract: (x) => ({ num: nn(x.apiRetries), den: 1 }),
  }),
  def({
    id: "apiErrors", family: "context", role: "context", worse: "up", scale: 100, unit: "per 100 exchanges",
    point: null, floor: "poisson", unitOf: "prompt",
    extract: (x) => ({ num: nn(x.apiErrors), den: 1 }),
  }),
  def({
    id: "compactions", family: "context", role: "context", worse: null, scale: 100, unit: "per 100 exchanges",
    point: null, floor: "poisson", unitOf: "prompt",
    extract: (x) => ({ num: nn(x.compactions), den: 1 }),
  }),
  def({
    id: "thinkRedacted", family: "context", role: "context", worse: null, scale: 100, unit: "per 100 thinking blocks",
    point: null, floor: "binomial", unitOf: "prompt",
    extract: (x) => ({ num: nn(x.thinkRedacted), den: nn(x.thinkBlocks) }),
  }),
  def({
    id: "promptChars", family: "context", role: "context", worse: null, scale: 1, unit: "characters per prompt",
    point: null, floor: "poisson", unitOf: "prompt",
    extract: (x) => ({ num: nn(x.promptChars), den: 1 }),
  }),
  def({
    id: "durationMs", family: "context", role: "context", worse: null, scale: 1, unit: "ms per exchange",
    point: null, floor: "poisson", unitOf: "prompt",
    extract: (x) => ({ num: nn(x.durationMs), den: 1 }),
  }),
]);

const BY_ID = new Map<MetricId, MetricDef>(METRICS.map((m) => [m.id, m]));

export function metricDef(id: MetricId): MetricDef {
  const d = BY_ID.get(id);
  if (!d) throw new RangeError(`unknown metric ${String(id)}`);
  return d;
}

/**
 * Role of each metric once the voting tool-error variant is chosen: exactly one of the three tool-error
 * constructs votes; the other two are context. Every other metric keeps its table role.
 */
export function roleOf(id: MetricId, errorsVote: ToolErrorVariant): Role {
  const d = metricDef(id);
  if ((TOOL_ERROR_VARIANTS as readonly string[]).includes(id)) return id === errorsVote ? "vote" : "context";
  return d.role;
}

/** True when every field the metric needs is a finite number on this exchange. */
export function hasFields(d: MetricDef, x: MetricExchange): boolean {
  for (const f of d.requires) {
    const v = x[f];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}
