/**
 * The frozen contract vocabulary (DECISIONS D22, docs/CONTRACT.md). One source for the engine; the Swift app and
 * the Claude Code mod mirror these lists and are held to them by the shared goldens in contract/fixtures/.
 */

import type { ChangeProvenance as TypesProvenance, ChangeSide, ChangeStrength as TypesStrength } from "../types.js";

export const GLANCE_SCHEMA_ID = "wasitme.glance/1" as const;
export const SNAPSHOT_SCHEMA_ID = "wasitme.snapshot/1" as const;

/** The engine writes compact JSON; these are the CI-gated ceilings (FORMATS.md, the "Size" row). */
export const GLANCE_MAX_BYTES = 16 * 1024;
export const SNAPSHOT_MAX_BYTES = 512 * 1024;

/** Consumers show `stale` once now − generatedAt exceeds staleAfterSec; this is the default when absent. */
export const DEFAULT_STALE_AFTER_SEC = 7200;
/** A generatedAt further than this in the future is not trusted as current (clocks go backward). */
export const FUTURE_TOLERANCE_SEC = 300;

/** D22 verdict states, in display order (expected frequency). */
export const VERDICT_STATES = ["insufficient", "none", "unclear", "you", "agent"] as const;
export type VerdictState = (typeof VERDICT_STATES)[number];

/** A surface's display state: a verdict state, or `stale` (computed by the consumer, never written). */
export type DisplayState = VerdictState | "stale";

/** Decision-table reasons (METHOD.md §11). `needs_data` names rows 2 and 14 ("insufficient, with progress"). */
export const VERDICT_REASONS = [
  "calibration_pending",
  "needs_data",
  "single_indicator",
  "mixed",
  "workload",
  "unknown_provenance",
  "both_sides",
  "nothing_recorded_on_your_side",
  "blind_spot",
  "by_elimination",
] as const;
export type VerdictReason = (typeof VERDICT_REASONS)[number];

/** Which reasons each state may carry; `null` = the state needs none. */
export const REASONS_BY_STATE: Readonly<Record<VerdictState, readonly (VerdictReason | null)[]>> = {
  insufficient: ["calibration_pending", "needs_data", "single_indicator"],
  none: [null],
  unclear: ["mixed", "workload", "unknown_provenance", "both_sides", "nothing_recorded_on_your_side", "blind_spot"],
  you: [null],
  agent: [null, "by_elimination"],
};

export const CHANGE_SIDES = ["you", "agent", "unknown", "meta"] as const satisfies readonly ChangeSide[];
export const CHANGE_STRENGTHS = ["strong", "weak", "routine"] as const satisfies readonly TypesStrength[];
export type ChangeStrength = (typeof CHANGE_STRENGTHS)[number];
export const CHANGE_PROVENANCES = ["command", "settings_snapshot", "project_snapshot", "org_settings", "log_field", "attachment"] as const satisfies readonly TypesProvenance[];
export type ChangeProvenance = (typeof CHANGE_PROVENANCES)[number];

export const SCAN_ERRORS = ["permission_denied", "write_failed", "timeout", "internal"] as const;
export type ScanError = (typeof SCAN_ERRORS)[number];

export const LEADS = ["timeline", "verdict"] as const;
export type Lead = (typeof LEADS)[number];

export const METRIC_FAMILIES = ["errors", "research", "friction"] as const;
export type MetricFamily = (typeof METRIC_FAMILIES)[number];
export const METRIC_ROLES = ["vote", "support", "context"] as const;
export type MetricRole = (typeof METRIC_ROLES)[number];
export const METRIC_STATUSES = ["worse", "better", "none", "ineligible"] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

export const INELIGIBLE_REASONS = [
  "too_few_events",
  "too_few_session_days",
  "too_few_sessions",
  "one_session_dominates",
  "too_few_edits",
  "paused_format_drift",
  "not_english",
  "no_data",
] as const;
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

function member<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** The contract's tolerance rule: any state this version doesn't know renders as `unclear`. */
export function decodeState(raw: unknown): VerdictState {
  return member(VERDICT_STATES, raw) ? raw : "unclear";
}

/** An unknown reason makes no claim. */
export function decodeReason(raw: unknown): VerdictReason | null {
  return member(VERDICT_REASONS, raw) ? raw : null;
}

/** An unknown side is `unknown` — never `agent`. */
export function decodeSide(raw: unknown): ChangeSide {
  return member(CHANGE_SIDES, raw) ? raw : "unknown";
}

export function decodeLead(raw: unknown): Lead {
  return member(LEADS, raw) ? raw : "timeline";
}

export function decodeScanError(raw: unknown): ScanError | null {
  if (raw === null || raw === undefined) return null;
  return member(SCAN_ERRORS, raw) ? raw : "internal";
}
