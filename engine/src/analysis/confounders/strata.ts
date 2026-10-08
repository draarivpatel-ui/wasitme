/**
 * Strata for the confounder checks (METHOD.md §8): project × requested model × entrypoint.
 *
 * Every stratum cell carries the FULL key (all three dimensions); the standardisation can regroup to fewer
 * dimensions, and the projects rule groups by the project part alone, all from one cell build.
 *
 * Model is the REQUESTED model (`Exchange.model`), never `servedModel`: a served-model switch is the agent-side
 * signal METHOD.md §9 looks for, so standardising on it would standardise that signal away.
 *
 * Keys are opaque: projects are HMACs and labels are allow-listed (`cleanLabel`) by the readers; nothing here is
 * text from a log.
 */
import type { StratumCell } from "../metrics/cells.js";
import type { MetricExchange } from "../metrics/defs.js";

export type StratumDim = "project" | "model" | "entrypoint";

/** METHOD.md §8: the baseline is reweighted to the recent window's project × model × entrypoint mix. */
export const STRATUM_DIMS: readonly StratumDim[] = Object.freeze(["project", "model", "entrypoint"]);

/** Separates the parts of a stratum key; HMACs and allow-listed labels never contain it. */
const PART_SEP = "\u001e";
const SEP = "\u001f";

function part(v: unknown): string {
  return typeof v === "string" ? v.split(PART_SEP).join("") : String(v ?? "");
}

/** Full stratum key of an exchange (project, requested model, entrypoint). Pass to `buildCells` as `stratumOf`. */
export function fullStratumKey(x: MetricExchange): string {
  return [part(x.project), part(x.model), part(x.entrypoint)].join(PART_SEP);
}

/** The parts of a full stratum key. */
export function stratumParts(key: string): Record<StratumDim, string> {
  const [project = "", model = "", entrypoint = ""] = key.split(PART_SEP);
  return { project, model, entrypoint };
}

/** Validates a dimension list: a subset of project/model/entrypoint, no duplicates (order is normalised). */
export function checkDims(dims: readonly StratumDim[]): StratumDim[] {
  const out: StratumDim[] = [];
  for (const d of dims) {
    if (!(STRATUM_DIMS as readonly string[]).includes(d)) throw new RangeError(`unknown stratum dimension ${String(d)}`);
    if (out.includes(d)) throw new RangeError(`duplicate stratum dimension ${d}`);
    out.push(d);
  }
  return STRATUM_DIMS.filter((d) => out.includes(d));
}

/** Key of a full stratum key restricted to `dims` (all three → unchanged; none → one stratum ""). */
export function keyFor(fullKey: string, dims: readonly StratumDim[]): string {
  if (dims.length === STRATUM_DIMS.length) return fullKey;
  const p = stratumParts(fullKey);
  return dims.map((d) => p[d]).join(PART_SEP);
}

/**
 * Cells re-keyed to `dims`, merging cells that share (session, day, new key). Sorted by session, day, stratum, so
 * the output never depends on input order.
 */
export function regroup(cells: readonly StratumCell[], dims: readonly StratumDim[]): StratumCell[] {
  const ds = checkDims(dims);
  const map = new Map<string, StratumCell>();
  for (const c of cells) {
    const stratum = keyFor(c.stratum, ds);
    const k = c.session + SEP + c.day + SEP + stratum;
    const m = map.get(k);
    if (m) {
      m.num += c.num;
      m.den += c.den;
      m.exchanges += c.exchanges;
      m.missing += c.missing;
      m.clamped += c.clamped;
    } else map.set(k, { ...c, stratum });
  }
  return [...map.values()].sort(byCell);
}

function byCell(a: StratumCell, b: StratumCell): number {
  if (a.session !== b.session) return a.session < b.session ? -1 : 1;
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return a.stratum < b.stratum ? -1 : a.stratum > b.stratum ? 1 : 0;
}

export interface Totals {
  num: number;
  den: number;
}

/** Σ num and Σ den per stratum (non-finite or negative counts count as 0). */
export function totalsByStratum(cells: readonly StratumCell[]): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const c of cells) {
    const t = out.get(c.stratum) ?? { num: 0, den: 0 };
    t.num += nonNeg(c.num);
    t.den += nonNeg(c.den);
    out.set(c.stratum, t);
  }
  return out;
}

export function nonNeg(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
}
