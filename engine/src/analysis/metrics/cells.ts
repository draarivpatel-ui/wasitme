/**
 * Exchange[] → per-metric cells: one cell per (session, local day) holding that metric's totals. Cells are
 * the stats module's unit (`Cell`); the stats module groups them into session or session-day clusters (with
 * the session as parent for two-level resampling).
 *
 * Pure and deterministic: the output never depends on input order (duplicates by `id` are resolved by a
 * canonical rule, cells are sorted by session then day). No I/O.
 *
 * Which exchanges count:
 *  - one agent only (agents are never pooled);
 *  - a valid "YYYY-MM-DD" `day` (the reader's local day; this layer never re-derives it, so the pipeline
 *    must pass the same time zone it gave the reader) strictly before `today` — today and any future-dated
 *    exchange (a clock that jumped) are excluded and counted;
 *  - interactive sessions only (METHOD.md §2), see `classifyInteractive` below;
 *  - per metric: the unit rule in defs.ts (work vs real human prompts) and the metric's required fields.
 *
 * History (`firstDay`/`lastDay`) counts only exchanges that pass every filter above except the per-metric
 * one: an automation-only stretch never makes a tier look older than the interactive data behind it.
 *
 * Interactive sessions (METHOD.md §2, D47(a)). The readers do not set `interactiveClass` yet (WP-10/11 still owe it: Codex from
 * `thread.automated` / `session_meta.source`, Claude from `promptSource` / `entrypoint` / `origin.kind`). Until
 * they do, an INTERIM classifier derives the class from fields every Exchange already carries:
 *  1. an exchange whose reader set `interactiveClass` to "interactive" or "scripted" follows it (the reader's
 *     classification wins); "unknown" (the reader's fields were missing or contradictory) falls through to 2–3;
 *  2. otherwise an exchange whose `entrypoint` names an automation client is not interactive — Codex
 *     `exec`, `mcp`, `subagent` (the D39 `session_meta.source` enum) and `codex_exec` (the label older Codex
 *     readers took from `originator`); Claude `sdk` / `sdk-*` (print mode and the Agent SDK) and `mcp`;
 *  3. otherwise a session with no real human prompt (`humanPrompt` 1) on any complete day before today is not
 *     interactive: its work was started by something other than a person (spawned or agent-created threads,
 *     scheduled runs). Agent-initiated stretches inside a session that does have a human prompt still count.
 * Unknown / other entrypoints are kept. Each exclusion is counted by its rule.
 */
import type { Cell } from "../stats/types.js";
import { dayIndex, dayString } from "../stats/ratio.js";
import { hasFields, METRICS, type MetricDef, type MetricExchange, type MetricId } from "./defs.js";

/** One metric's totals for one session on one day, plus data-quality counters. */
export interface MetricCell extends Cell {
  /** Exchanges that contributed (num or den). */
  exchanges: number;
  /** Eligible exchanges that lacked a field this metric needs (contributed nothing). */
  missing: number;
  /** Exchanges whose numerator exceeded the denominator of a proportion metric (clamped to it). */
  clamped: number;
}

export interface CellCounts {
  /** Exchanges passed in. */
  input: number;
  /** Exchanges of another agent (ignored). */
  otherAgent: number;
  /** Extra copies of an exchange id (one copy kept). */
  duplicates: number;
  /** Exchanges with an invalid `day`. */
  invalidDay: number;
  /** Exchanges dated today (incomplete day, METHOD.md §2). */
  today: number;
  /** Exchanges dated after today (clock jumped forward, or a time-zone mismatch). */
  future: number;
  /** Exchanges classified as not interactive (excluded); the sum of the three rule counts below. */
  nonInteractive: number;
  /** …because the reader's `interactiveClass` says so. */
  nonInteractiveReader: number;
  /** …because the entrypoint names an automation client (interim rule 2). */
  nonInteractiveEntrypoint: number;
  /** …because the session has no real human prompt before today (interim rule 3). */
  nonInteractiveNoPrompt: number;
  /** Exchanges carrying an `interactiveClass` at all (0 → the readers' classifier is not wired yet). */
  classified: number;
  /** Exchanges used (complete days, interactive). */
  used: number;
  /** Of those, real human prompts. */
  prompts: number;
  /** Prompts carrying `promptEnglish`, and how many of them are English. */
  languageKnown: number;
  english: number;
}

/**
 * Entrypoint labels of automation clients (interim rule 2), compared lower-case. `sdk-…` matches by prefix.
 * Codex: the D39 `session_meta.source` enum values for non-human clients, plus the pre-D39 originator label.
 * Claude: print mode / Agent SDK entrypoints and Claude Code running as an MCP server.
 */
export const AUTOMATION_ENTRYPOINTS: readonly string[] = Object.freeze(["exec", "codex_exec", "mcp", "subagent", "sdk"]);

/** True when `entrypoint` names an automation client (interim rule 2). */
export function isAutomationEntrypoint(entrypoint: unknown): boolean {
  if (typeof entrypoint !== "string") return false;
  const e = entrypoint.trim().toLowerCase();
  return AUTOMATION_ENTRYPOINTS.includes(e) || e.startsWith("sdk-");
}

export type InteractiveVerdict = "interactive" | "reader" | "entrypoint" | "noPrompt";

/**
 * Interactive class of one exchange (see the file header): "interactive", or the rule that excluded it.
 * `promptedSessions` holds the sessions with a real human prompt on a complete day before today.
 */
export function classifyInteractive(x: MetricExchange, promptedSessions: ReadonlySet<string>): InteractiveVerdict {
  if (x.interactiveClass === "interactive") return "interactive";
  if (x.interactiveClass === "scripted") return "reader";
  if (isAutomationEntrypoint(x.entrypoint)) return "entrypoint";
  if (!promptedSessions.has(String(x.session))) return "noPrompt";
  return "interactive";
}

/** One session-day's prompts (`den`) and how many of them are known to be English (`num`). */
export type LanguageCell = Cell;

export interface CellBuild {
  agent: string;
  /** Local day the analysis runs on (excluded). */
  today: string;
  /** Earliest / latest valid day of this agent's exchanges strictly before today (history), else null. */
  firstDay: string | null;
  lastDay: string | null;
  counts: CellCounts;
  /** Cells per metric, sorted by session then day. Cells with no num, no den and no missing are dropped. */
  cells: Record<MetricId, MetricCell[]>;
  /**
   * Per session-day: real human prompts (den) and those known to be English (num). A prompt without
   * `promptEnglish` counts as not English, so a window's share is over ALL its prompts (pushback's 70% rule).
   */
  language: LanguageCell[];
  /** Only when `stratumOf` was given: cells per metric split by stratum (sorted by session, day, stratum). */
  strata?: Record<MetricId, StratumCell[]>;
}

/** A metric cell for one (session, day, stratum). */
export interface StratumCell extends MetricCell {
  stratum: string;
}

const SEP = "\u001f";

/** Canonical JSON (sorted keys) used only to pick one copy among duplicates deterministically. */
function canonical(x: MetricExchange): string {
  const o = x as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Among copies with the same id keep the earliest `t`, then the lowest `seq`, then the canonical-JSON minimum. */
function preferred(a: MetricExchange, b: MetricExchange): MetricExchange {
  const ta = String(a.t), tb = String(b.t);
  if (ta !== tb) return ta < tb ? a : b;
  const sa = Number(a.seq), sb = Number(b.seq);
  if (sa !== sb && Number.isFinite(sa) && Number.isFinite(sb)) return sa < sb ? a : b;
  return canonical(a) <= canonical(b) ? a : b;
}

export interface BuildCellsOptions {
  agent: string;
  /** Local day of the analysis ("YYYY-MM-DD"), from `todayFor(now, timeZone)`. */
  today: string;
  /**
   * Optional stratum key of an exchange (the confounder layer uses project × model × entrypoint). When set, the
   * build also returns `strata`: the same cells split by (session, day, stratum), under exactly the same filters,
   * so they sum to `cells`. Absent → no `strata` (and nothing else changes).
   */
  stratumOf?: (x: MetricExchange) => string;
  /**
   * Optional observer, called once for every deduplicated exchange of this agent on a complete past day, with its
   * interactive verdict (before the non-interactive ones are dropped). Read-only use (mix statistics).
   */
  onExchange?: (x: MetricExchange, verdict: InteractiveVerdict) => void;
  /**
   * Build cells for these metrics only (default: every metric). The others come back as empty lists, so a caller that
   * reads only these metrics gets exactly the cells a full build gives, for a fraction of the work (the per-day
   * evaluation and the attribution pipeline read 4–5 of the 17 metrics). Counts, history and language cells are
   * unaffected.
   */
  metrics?: readonly MetricId[];
}

/** Add one exchange's contribution to a metric cell (created on first use), with the missing-field and clamp rules. */
function accumulate<T extends MetricCell>(map: Map<string, T>, key: string, make: () => T, m: MetricDef, x: MetricExchange): void {
  let cell = map.get(key);
  const ensure = (): T => {
    if (!cell) {
      cell = make();
      map.set(key, cell);
    }
    return cell;
  };
  if (!hasFields(m, x)) {
    ensure().missing++;
    return;
  }
  let { num, den } = m.extract(x);
  if (num === 0 && den === 0) return;
  const c = ensure();
  if (m.proportion && num > den) {
    num = den;
    c.clamped++;
  }
  c.num += num;
  c.den += den;
  c.exchanges++;
}

function byStratumCell(a: StratumCell, b: StratumCell): number {
  return bySessionDay(a, b) || (a.stratum < b.stratum ? -1 : a.stratum > b.stratum ? 1 : 0);
}

export function buildCells(exchanges: readonly MetricExchange[], opts: BuildCellsOptions): CellBuild {
  const todayIdx = dayIndex(opts.today);
  if (todayIdx === undefined) throw new RangeError(`today must be a valid YYYY-MM-DD day (got ${String(opts.today)})`);
  const counts: CellCounts = {
    input: exchanges.length, otherAgent: 0, duplicates: 0, invalidDay: 0, today: 0, future: 0,
    nonInteractive: 0, nonInteractiveReader: 0, nonInteractiveEntrypoint: 0, nonInteractiveNoPrompt: 0,
    classified: 0, used: 0, prompts: 0, languageKnown: 0, english: 0,
  };

  // Dedupe by id (canonical choice, so input order never matters).
  const byId = new Map<string, MetricExchange>();
  for (const x of exchanges) {
    if (!x || typeof x !== "object") continue;
    if (x.agent !== opts.agent) {
      counts.otherAgent++;
      continue;
    }
    const id = String(x.id);
    const prev = byId.get(id);
    if (prev) {
      counts.duplicates++;
      byId.set(id, preferred(prev, x));
    } else byId.set(id, x);
  }

  const acc = new Map<MetricId, Map<string, MetricCell>>();
  for (const m of METRICS) acc.set(m.id, new Map());
  const lang = new Map<string, LanguageCell>();
  let first: number | undefined, last: number | undefined;

  // Complete past days only (today and the future never decide anything, METHOD.md §2).
  const past: MetricExchange[] = [];
  for (const x of byId.values()) {
    const di = dayIndex(x.day);
    if (di === undefined) counts.invalidDay++;
    else if (di === todayIdx) counts.today++;
    else if (di > todayIdx) counts.future++;
    else past.push(x);
  }
  const promptedSessions = new Set<string>();
  for (const x of past) if (x.humanPrompt === 1) promptedSessions.add(String(x.session));

  const { stratumOf, onExchange } = opts;
  const wanted = opts.metrics === undefined ? METRICS : METRICS.filter((m) => opts.metrics!.includes(m.id));
  const accStrata = new Map<MetricId, Map<string, StratumCell>>();
  if (stratumOf !== undefined) for (const m of METRICS) accStrata.set(m.id, new Map());

  for (const x of past) {
    const di = dayIndex(x.day)!;
    if (x.interactiveClass !== undefined) counts.classified++;
    const verdict = classifyInteractive(x, promptedSessions);
    if (onExchange !== undefined) onExchange(x, verdict);
    if (verdict !== "interactive") {
      counts.nonInteractive++;
      if (verdict === "reader") counts.nonInteractiveReader++;
      else if (verdict === "entrypoint") counts.nonInteractiveEntrypoint++;
      else counts.nonInteractiveNoPrompt++;
      continue;
    }
    if (first === undefined || di < first) first = di;
    if (last === undefined || di > last) last = di;
    counts.used++;
    const session = String(x.session);
    const key = session + SEP + x.day;
    const prompt = x.humanPrompt === 1;
    if (prompt) {
      counts.prompts++;
      let lc = lang.get(key);
      if (!lc) lang.set(key, (lc = { session, day: x.day, num: 0, den: 0 }));
      lc.den++;
      if (x.promptEnglish === 0 || x.promptEnglish === 1) {
        counts.languageKnown++;
        if (x.promptEnglish === 1) {
          counts.english++;
          lc.num++;
        }
      }
    }
    const stratum = stratumOf === undefined ? undefined : String(stratumOf(x));
    for (const m of wanted) {
      if (m.unitOf === "prompt" && !prompt) continue;
      accumulate(acc.get(m.id)!, key, () => ({ session, day: x.day, num: 0, den: 0, exchanges: 0, missing: 0, clamped: 0 }), m, x);
      if (stratum !== undefined) {
        accumulate(accStrata.get(m.id)!, key + SEP + stratum, () => ({ session, day: x.day, stratum, num: 0, den: 0, exchanges: 0, missing: 0, clamped: 0 }), m, x);
      }
    }
  }

  const cells = {} as Record<MetricId, MetricCell[]>;
  for (const m of METRICS) {
    cells[m.id] = [...acc.get(m.id)!.values()].sort(bySessionDay);
  }
  const dayStr = (i: number | undefined) => (i === undefined ? null : dayString(i));
  const language = [...lang.values()].sort(bySessionDay);
  const out: CellBuild = { agent: opts.agent, today: opts.today, firstDay: dayStr(first), lastDay: dayStr(last), counts, cells, language };
  if (stratumOf !== undefined) {
    const strata = {} as Record<MetricId, StratumCell[]>;
    for (const m of METRICS) strata[m.id] = [...accStrata.get(m.id)!.values()].sort(byStratumCell);
    out.strata = strata;
  }
  return out;
}

export function bySessionDay(a: Cell, b: Cell): number {
  if (a.session !== b.session) return a.session < b.session ? -1 : 1;
  return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
}

/** Cells whose day lies in [from, to] (inclusive day indices). */
export function cellsBetween<T extends Cell>(cells: readonly T[], from: number, to: number): T[] {
  return cells.filter((c) => {
    const i = dayIndex(c.day);
    return i !== undefined && i >= from && i <= to;
  });
}

/** Daily integer k/n over [from, to] (inclusive day indices), one entry per day (zeros included). */
export function dailyTotals(cells: readonly Cell[], from: number, to: number): { d: string; k: number; n: number }[] {
  const byDay = new Map<number, { k: number; n: number }>();
  for (const c of cells) {
    const i = dayIndex(c.day);
    if (i === undefined || i < from || i > to) continue;
    const t = byDay.get(i) ?? { k: 0, n: 0 };
    t.k += c.num;
    t.n += c.den;
    byDay.set(i, t);
  }
  const out: { d: string; k: number; n: number }[] = [];
  for (let i = from; i <= to; i++) {
    const t = byDay.get(i) ?? { k: 0, n: 0 };
    out.push({ d: dayString(i), k: t.k, n: t.n });
  }
  return out;
}
