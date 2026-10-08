/**
 * D64: the ETA product rule — when the "Next to unlock" progress counts as ready, and when its projected date is shown.
 * Pure, no I/O. The projection itself (METHOD.md §13) is progress.ts; this module decides what of it is SHOWN, from
 * today's evaluation and the per-agent records of the previous daily evaluations (persisted by the store next to the
 * decisions, store/decisions.ts).
 *
 *  (a) Ready = the gate and sensitivity hold (a tier with its history met has an eligible, sensitive voting metric in
 *      every voting family) on today's evaluation AND on the previous daily evaluation. The ETA a projection reports
 *      is therefore the second of two consecutive projected-ready days (progress.ts `hold` = READY_HOLD).
 *  (b) A projected date is shown only when
 *        1. it is stable: today's and the two previous daily evaluations all projected a date, all in the same tier,
 *           and each earlier projected target date lies within ±20% of today's remaining days of today's target
 *           date (|date_j − date_today| ≤ 0.2 × etaDays_today; target dates are compared, so a projection that
 *           holds still while the days pass counts as stable);
 *        2. no single session dominates it: in every voting family some metric that is sensitive on the ETA day has
 *           a projected largest-session share below 0.35 in both windows;
 *        3. Codex only: that metric's projection is calibrated to a MEASURED comparison (a probe or no anchor is not
 *           enough), so Codex never shows a date until it has a measured anchor.
 *      Otherwise no date is shown (reason "no_date"; the words say there is no date yet because it depends on how
 *      sessions go) — the progress counter is shown either way.
 *      Extension beyond D64: "not at your current pace" is shown only when today's and the two previous daily
 *      evaluations all projected it; otherwise it is "no_date" too.
 *  D66: v1's words show neither (words/facts.ts `SHOW_DATES = false`); this rule still runs and calibration measures it.
 *
 * "Daily evaluations" are the per-day records: one per local day, the latest evaluation of a day replacing earlier
 * ones (a scan runs every 15 minutes; today's data never enters the evaluation, so same-day repeats agree), and the
 * previous evaluations are the most recent records of EARLIER days, whatever the gap. A record dated today or later
 * (a clock that went backward) is ignored and replaced. No record → nothing held, nothing stable: a first evaluation
 * is never "ready" for progress and never shows a date.
 */
import { dayIndex } from "../stats/ratio.js";
import type { TierId } from "../metrics/windows.js";
import type { ProjectedMetric } from "./progress.js";

/** (a): consecutive daily evaluations the gate and sensitivity must hold on. */
export const READY_HOLD = 2;
/** (b)1: consecutive daily evaluations a projection must agree on. */
export const STABLE_EVALUATIONS = 3;
/** (b)1: target dates within ±20% of today's remaining days. */
export const STABLE_TOLERANCE = 0.2;
/** (b)2: the projected window's largest-session share must stay below this for a date. */
export const MAX_DATED_SESSION_SHARE = 0.35;
/** Records kept per agent (today's and the ones the rules look back on). */
export const ETA_HISTORY_KEEP = Math.max(READY_HOLD, STABLE_EVALUATIONS);

/** One daily evaluation, as the next ones need it. Raw values (before the rule), never the shown ones. */
export interface EtaRecord {
  /** Local day of the evaluation (YYYY-MM-DD). */
  day: string;
  /** Today's gate + sensitivity, before the hold. */
  ready: boolean;
  /** Projected tier and target date (hold-aware); null when no date was projected. */
  tier: TierId | null;
  eta: string | null;
  /** The projection said no tier gets there at the current pace. */
  notAtPace: boolean;
}

export type DateWithheld = "unstable" | "dominant_session" | "no_measured_anchor";

const byDay = (a: EtaRecord, b: EtaRecord) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);

/** Records of days before `today`, oldest first, one per day (the last one given for a day wins). */
export function priorRecords(history: readonly EtaRecord[] | null | undefined, today: string): EtaRecord[] {
  const perDay = new Map<string, EtaRecord>();
  for (const r of history ?? []) if (r.day < today) perDay.set(r.day, r);
  return [...perDay.values()].sort(byDay);
}

/** (a): ready today and on the previous daily evaluation. */
export function heldReady(readyToday: boolean, prior: readonly EtaRecord[]): boolean {
  return readyToday && prior.length > 0 && prior[prior.length - 1]!.ready;
}

/** The history to keep after today's evaluation: earlier days, then today's record, at most ETA_HISTORY_KEEP. */
export function nextHistory(history: readonly EtaRecord[] | null | undefined, record: EtaRecord): EtaRecord[] {
  return [...priorRecords(history, record.day), record].slice(-ETA_HISTORY_KEEP);
}

/** (b)1 for a projected date: the previous STABLE_EVALUATIONS − 1 records agree with today's (see the header). */
export function stableDate(today: EtaRecord, prior: readonly EtaRecord[], etaDays: number): boolean {
  const back = prior.slice(-(STABLE_EVALUATIONS - 1));
  const t = today.eta === null ? undefined : dayIndex(today.eta);
  if (back.length < STABLE_EVALUATIONS - 1 || today.tier === null || t === undefined || !(etaDays > 0)) return false;
  return back.every((r) => {
    const j = r.eta === null ? undefined : dayIndex(r.eta);
    return r.tier === today.tier && j !== undefined && Math.abs(j - t) <= STABLE_TOLERANCE * etaDays + 1e-9;
  });
}

/** The not-at-pace extension: today's and the previous STABLE_EVALUATIONS − 1 records all said so. */
export function stableNotAtPace(today: EtaRecord, prior: readonly EtaRecord[]): boolean {
  const back = prior.slice(-(STABLE_EVALUATIONS - 1));
  return today.notAtPace && back.length === STABLE_EVALUATIONS - 1 && back.every((r) => r.notAtPace);
}

/** Largest-session share of one projected metric: the larger of its two windows. */
const shareOf = (m: ProjectedMetric) => Math.max(m.recent.maxSessionShare, m.baseline.maxSessionShare);

/**
 * (b)2–3 on the ETA day's projected metrics. `share`: per family the smallest share among its sensitive metrics, the
 * largest of those over the families (null without any). `withheld`: null when every family has a sensitive metric
 * with share < 0.35 (and, for Codex, calibrated to a measured anchor).
 */
export function dateGate(at: readonly ProjectedMetric[], families: readonly string[], agent: string): { share: number | null; withheld: DateWithheld | null } {
  let share: number | null = null;
  let dominant = false, unanchored = false;
  for (const f of families) {
    // On the ETA day every family has a sensitive metric (that is what "projected ready" means); none → no date.
    const sensitive = at.filter((m) => m.family === f && m.sensitive);
    if (sensitive.length === 0) {
      dominant = true;
      continue;
    }
    const best = Math.min(...sensitive.map(shareOf));
    share = share === null ? best : Math.max(share, best);
    const small = sensitive.filter((m) => shareOf(m) < MAX_DATED_SESSION_SHARE);
    if (small.length === 0) dominant = true;
    else if (agent === "codex" && !small.some((m) => m.calibration?.source === "measured")) unanchored = true;
  }
  return { share, withheld: dominant ? "dominant_session" : unanchored ? "no_measured_anchor" : null };
}
