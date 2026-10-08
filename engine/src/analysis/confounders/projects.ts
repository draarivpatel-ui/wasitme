/**
 * The projects rule (METHOD.md §8 "Projects", from r/05; D53(b)): if at least 2 projects qualify, each shifted metric
 * must agree in at least ⅔ of them; otherwise the result is `unclear (workload)`.
 *
 * Implemented as:
 *  - a project QUALIFIES for a metric when that metric, restricted to the project's cells, passes the same D23 gate
 *    as the full comparison in BOTH windows (events, session-days, sessions, largest-session share, the metric's own
 *    denominator floor). r/05 says "projects with enough data both sides" and the version-boundary test (METHOD.md
 *    §10 step 6) says "under the same gates", so the same gate it is (D53(b) ratified this reading);
 *  - a qualifying project AGREES when its own rate moved the same way as the shift: recent rate > baseline rate for
 *    an upward shift, < for a downward one (ratio of totals, no pseudo-count — the gate guarantees ≥ 10 events per
 *    window, and a pseudo-count would tilt the sign towards the window with fewer events). Equal rates do not agree;
 *  - the rule APPLIES only when ≥ 2 projects qualify; it then HOLDS when agreeing ≥ ⅔ × qualifying, compared in
 *    integers (3·agreeing ≥ 2·qualifying). "Otherwise" is read as "if the agreement test fails": a user with fewer
 *    than two qualifying projects is not made permanently `unclear` by this rule (r/05's "≥ 2/3 of projects with
 *    enough data"); `applies: false` is reported so WP-21 can see it was not tested.
 */
import { countWindow, evaluateD23Gate, type GateParams } from "../gates/d23.js";
import type { StratumCell } from "../metrics/cells.js";
import type { Direction, MetricDef, MetricId } from "../metrics/defs.js";
import { stratumParts } from "./strata.js";

/** ≥ 2 qualifying projects for the rule to apply. */
export const MIN_QUALIFYING_PROJECTS = 2;
/** Agreement share: at least 2/3 of qualifying projects (integer comparison 3·agree ≥ 2·qualifying). */
export const PROJECT_AGREEMENT = Object.freeze({ num: 2, den: 3 });

export interface ProjectRow {
  /** Project HMAC. */
  project: string;
  qualifies: boolean;
  recentRate: number | null;
  baselineRate: number | null;
  /** Null when the project does not qualify. */
  agrees: boolean | null;
}

export interface ProjectRule {
  metric: MetricId;
  direction: Direction;
  /** Projects with a denominator in either window. */
  projects: number;
  qualifying: number;
  agreeing: number;
  /** ≥ 2 projects qualify. */
  applies: boolean;
  /** True when the rule does not apply, else 3·agreeing ≥ 2·qualifying. */
  holds: boolean;
  /** One row per project, sorted by project. */
  rows: ProjectRow[];
}

/** The rule itself, on counts. Pure. */
export function projectAgreement(qualifying: number, agreeing: number): { applies: boolean; holds: boolean } {
  const applies = qualifying >= MIN_QUALIFYING_PROJECTS;
  return { applies, holds: !applies || PROJECT_AGREEMENT.den * agreeing >= PROJECT_AGREEMENT.num * qualifying };
}

function byProject(cells: readonly StratumCell[]): Map<string, StratumCell[]> {
  const out = new Map<string, StratumCell[]>();
  for (const c of cells) {
    const p = stratumParts(c.stratum).project;
    const g = out.get(p);
    if (g) g.push(c);
    else out.set(p, [c]);
  }
  return out;
}

/**
 * The projects rule for one shifted metric. Stratum cells carry FULL stratum keys (`fullStratumKey`) and are
 * already cut to the evaluation's windows; `direction` is the raw shift's direction.
 */
export function projectRule(
  def: MetricDef,
  recent: readonly StratumCell[],
  baseline: readonly StratumCell[],
  direction: Direction,
  gate: GateParams,
): ProjectRule {
  const r = byProject(recent), b = byProject(baseline);
  const projects = [...new Set([...r.keys(), ...b.keys()])].sort();
  const rows: ProjectRow[] = [];
  let qualifying = 0, agreeing = 0;
  for (const p of projects) {
    const rc = countWindow(r.get(p) ?? []), bc = countWindow(b.get(p) ?? []);
    if (!(rc.denominator > 0) && !(bc.denominator > 0)) continue;
    const recentRate = rc.denominator > 0 ? rc.events / rc.denominator : null;
    const baselineRate = bc.denominator > 0 ? bc.events / bc.denominator : null;
    const qualifies = evaluateD23Gate(rc, bc, def.minDenominator, gate).pass;
    let agrees: boolean | null = null;
    if (qualifies) {
      qualifying++;
      agrees = direction === "up" ? recentRate! > baselineRate! : recentRate! < baselineRate!;
      if (agrees) agreeing++;
    }
    rows.push({ project: p, qualifies, recentRate, baselineRate, agrees });
  }
  return { metric: def.id, direction, projects: rows.length, qualifying, agreeing, ...projectAgreement(qualifying, agreeing), rows };
}
