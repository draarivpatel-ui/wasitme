/**
 * Attribution layer (WP-21, METHOD.md §9–§12): shared types. Pure data — derived numbers, opaque ids, allow-listed
 * labels and "YYYY-MM-DD" days only. Nothing here carries prompt text, paths or log content.
 */
import type { VerdictReason, VerdictState } from "../../contract/vocab.js";
import type { ChangeEvent, ChangeKind, ChangeSide, ChangeStrength } from "../../types.js";
import type { ChangedCall } from "../confounders/agreement.js";
import type { StratumDim } from "../confounders/strata.js";
import type { MetricId } from "../metrics/defs.js";
import type { DayRangeStrings, TierId } from "../metrics/windows.js";

/**
 * Tripwires: agent-side signals admitted as `agent · strong` only after the S11 / S-TRIP checks show them stable
 * (METHOD.md §9). Every one is OFF by default; while off, an event carrying it is context only (never decides, never
 * blocks a row).
 *  - served_model:   the served model differs from the requested one (`kind: "served-model"`);
 *  - vendor_template: a normalised vendor-template system-prompt hash changed (`kind: "system-prompt"`);
 *  - cache_miss:     cache_miss_reason system / tools_changed across sessions (`kind: "system-prompt"`).
 */
export type Tripwire = "served_model" | "vendor_template" | "cache_miss";

export interface TripwireOptions {
  servedModel: boolean;
  vendorTemplate: boolean;
  cacheMiss: boolean;
}

export const TRIPWIRES_OFF: Readonly<TripwireOptions> = Object.freeze({ servedModel: false, vendorTemplate: false, cacheMiss: false });

/**
 * A change event as attribution sees it: a reader/configsnap `ChangeEvent`, optionally marked as a tripwire or as
 * derived here from Exchange labels (between-session changes the readers cannot see, labels.ts). `types.ts` is
 * frozen, so the markers live on this local extension.
 */
export interface AttributionEvent extends ChangeEvent {
  tripwire?: Tripwire;
  /** Derived by this layer from Exchange labels (labels.ts) or a tripwire detector, not read from a log record. */
  derived?: boolean;
}

/**
 * How an event can count in the decision table (the side × strength table of METHOD.md §9):
 *  - you_strong:   decides (rows 6–7) unless ruled out (METHOD.md §10 step 5);
 *  - you_weak:     listed, never decides;
 *  - agent_strong: an ADMITTED tripwire (rows 6, 8);
 *  - agent_routine: a routine update (version bump, system prompt at the bump) — background only (METHOD.md §1);
 *  - unknown:      no command record and no settings diff (row 5); also any decisive event that cannot be dated;
 *  - context:      shown, never a candidate that decides or blocks (prompt hashes, tripwires that are off);
 *  - meta:         wasitme's own writes / parser changes — skipped.
 */
export type CandidateClass = "you_strong" | "you_weak" | "agent_strong" | "agent_routine" | "unknown" | "context" | "meta";

export interface EventClass {
  class: CandidateClass;
  tripwire: Tripwire | null;
  /** A tripwire whose option is on (only then can it be `agent_strong`). */
  admitted: boolean;
}

// ───────────────────────────── evidence (heavy, from exchanges) ─────────────────────────────

export interface OnsetOptions {
  /** Δ of METHOD.md §10 step 2: I = {d : Z(d) ≥ max Z − Δ}. Provisional default; WP-23's G-onset owns the value. */
  delta: number;
  /** I is at least ±halfWidth days around the peak (METHOD.md §10: ±2). */
  halfWidth: number;
  /** Extra guard days on each side (METHOD.md §10: 1). */
  guard: number;
  /** A split day qualifies with at least this many session-days on each side, for every counted metric (METHOD.md §10: 5). */
  minSessionDays: number;
}

export interface OnsetPoint {
  /** First day of the "after" segment. */
  d: string;
  /** Z(d) = Σ s_m·θ_m(d)/SE_m(d); null when d does not qualify. */
  z: number | null;
}

export interface Onset {
  /** False when no split day qualifies (I is then the whole span — a fallback that should not occur after "changed"). */
  localized: boolean;
  /** The tier's span (baseline start … recent end). */
  span: DayRangeStrings;
  /** Split day with the largest Z (earliest on ties); null when not localized. */
  peak: string | null;
  maxZ: number | null;
  delta: number;
  /** Hull of {d : Z(d) ≥ max Z − Δ}, before widening; null when not localized. */
  core: DayRangeStrings | null;
  /** The onset interval I (core ∪ peak ± halfWidth, plus the guard, clipped to the span). */
  interval: DayRangeStrings;
  /** Metrics in the split score (the counted shifted metrics) and their signs. */
  metrics: { metric: MetricId; sign: 1 | -1 }[];
  profile: OnsetPoint[];
}

/** An Exchange field a you-candidate's dimension can be held on (METHOD.md §10 step 5). */
export type HoldDimension = "model" | "effort" | "mode" | "entrypoint";

export type RuleOutReason =
  | "ruled_out"          // the shift still shows (changed, same side) with the dimension held at its old value
  | "shift_not_shown"    // restricted run lost the shift (proves nothing: stays open)
  | "not_holdable"       // no Exchange field for this kind (instructions, mcp, skills, plugins, hooks, config…)
  | "old_value_unknown"; // the event's old value is not a usable label

export interface RuleOutResult {
  /** Event id. */
  event: string;
  kind: ChangeKind;
  dimension: HoldDimension | null;
  /** The value the dimension was held at (the event's `from`), when attempted. */
  held: string | null;
  attempted: boolean;
  ruledOut: boolean;
  reason: RuleOutReason;
  /** The restricted run's "changed" call (null when not attempted). */
  changed: ChangedCall | null;
}

export type BoundaryReason =
  | "passes" | "no_boundary" | "several_boundaries" | "shift_not_shown" | "projects" | "not_observed";

export interface BoundaryProjects {
  metric: MetricId;
  qualifying: number;
  agreeing: number;
  /** ≥ 2 qualifying projects agree, and agreeing ≥ ⅔ of qualifying. */
  holds: boolean;
}

/** METHOD.md §10 step 6 (D33): required for `agent` by elimination (row 9). */
export interface BoundaryTest {
  /** The version event tested (the earliest one for the boundary's new version), else null. */
  event: string | null;
  /** Boundary day b (first day on the new version), else null. */
  boundary: string | null;
  /** Distinct version boundaries inside I. */
  boundaries: number;
  pre: DayRangeStrings | null;
  post: DayRangeStrings | null;
  /** "changed" on the pre/post comparison (same gates, same df floor), else null. */
  shift: ChangedCall | null;
  projects: BoundaryProjects[];
  /** Every day of pre ∪ post (before today) is fully observed. */
  observed: boolean;
  passes: boolean;
  reason: BoundaryReason;
}

export interface DailyPersistence {
  d: string;
  /** Distinct sessions with a voting-metric denominator that day. */
  sessionDays: number;
  /** Per voting metric: that day's denominator. */
  den: Partial<Record<MetricId, number>>;
}

/** What persistence needs from the data (METHOD.md §12). */
export interface PersistenceData {
  /** The recent window the "new denominator" rule refers to (the selected tier's, else tier 1's). */
  recent: DayRangeStrings;
  /** Per voting metric: the recent window's denominator. */
  den: Partial<Record<MetricId, number>>;
  /** The last 28 complete days, ascending. */
  daily: DailyPersistence[];
}

export interface AttributionEvidence {
  agent: string;
  today: string;
  tier: TierId | null;
  /** changedOf on the selected tier's metrics (20b, the single source; D53c). Tests below run only when true. */
  changed: boolean;
  /** Evidence was gathered for a calibrated agent (false → only `persistence` is filled). */
  calibrated: boolean;
  onset: Onset | null;
  /** One row per dated you·strong event in I. */
  ruleOut: RuleOutResult[];
  boundary: BoundaryTest | null;
  /** Strata dimensions the workload test must use (D53a): STRATUM_DIMS minus the dropped ones. */
  dims: StratumDim[];
  dropped: { dim: StratumDim; events: string[] }[];
  /** Fully observed local days (input, sorted, unique). */
  fullyObservedDays: string[];
  /** Codex: partially observed by design (METHOD.md §9), whatever the input says. */
  partialByDesign: boolean;
  persistence: PersistenceData;
}

// ───────────────────────────── decision ─────────────────────────────

export type ConditionId =
  | "not_calibrated"
  | "family_without_eligible_metric"
  | "mixed"
  | "changed"
  | "workload"
  | "unknown_candidate"
  | "you_strong_open"
  | "agent_strong"
  | "no_agent_strong"
  | "no_you_strong_open"
  | "only_routine_or_weak"
  | "fully_observed"
  | "partially_observed"
  | "version_boundary"
  | "not_changed"
  | "single_indicator"
  | "no_material"
  | "sensitive_each_family"
  | "otherwise";

/** One condition of a decision-table row, as checked (structured; WP-22 writes the words). */
export interface TraceCondition {
  id: ConditionId;
  holds: boolean;
  /** Event ids the condition is about (candidates), when any. */
  events?: string[];
  /** Metrics the condition is about, when any. */
  metrics?: MetricId[];
  /** Small structured facts (counts, days, reasons, families); never text from a log. */
  detail?: Record<string, string | number | boolean | null | string[]>;
}

export interface TraceRow {
  /** Decision-table row (METHOD.md §11), 1–14. */
  row: number;
  matched: boolean;
  /** Conditions in table order, up to and including the first that failed (all of them when matched). */
  conditions: TraceCondition[];
}

export type CandidateStatus = "open" | "ruled_out" | "background";
export type CandidateTest = "strata" | "version_boundary" | "routine" | null;

/** An event inside the onset interval I (or a decisive event that cannot be dated). */
export interface Candidate {
  event: string;
  kind: ChangeKind;
  side: ChangeSide;
  strength: ChangeStrength | null;
  /** The event's day, or null when it has neither a valid day nor a parseable time. */
  day: string | null;
  class: CandidateClass;
  tripwire: Tripwire | null;
  admitted: boolean;
  status: CandidateStatus;
  /** Maps to snapshot `candidates[].test`. */
  test: CandidateTest;
  undated: boolean;
}

export interface Observation {
  /** "onset": counted over I; "none": no onset (counts 0). */
  scope: "onset" | "none";
  fullyObservedDays: number;
  partiallyObservedDays: number;
  partialByDesign: boolean;
}

/** One table outcome. */
export interface Verdict {
  state: VerdictState;
  reason: VerdictReason | null;
  /** The decision-table row that fired. */
  row: number;
  /** Rows checked, in order, ending at the row that fired (the only matched one). */
  trace: TraceRow[];
  onset: DayRangeStrings | null;
  /** Events in I (and undated decisive events), oldest first. Empty without an onset. */
  candidates: Candidate[];
  /** Row 8 on partially observed days, and row 11: the blind-spot line (METHOD.md §11). */
  blindSpot: boolean;
  observation: Observation;
  /** Row 12: the metric the headline names. */
  singleIndicator: { metric: MetricId; ratio: number; range: { lo: number; hi: number } } | null;
}

/** The data the persistence rule compares two evaluations by (data time). */
export interface Fingerprint {
  /** ISO time of the evaluation (`now`, passed in). */
  now: string;
  today: string;
  recent: DayRangeStrings;
  den: Partial<Record<MetricId, number>>;
}

export interface PendingCandidate {
  state: VerdictState;
  reason: VerdictReason | null;
  row: number;
  /** The evaluation that first produced it (the anchor the second evaluation is measured from). */
  since: Fingerprint;
}

/** The displayed outcome (after persistence) plus this evaluation's own. */
export interface Decision extends Verdict {
  /** A different outcome is waiting for its confirming evaluation (glance holds its state; "Possible shift — confirming"). */
  pending: boolean;
  /** This evaluation's own table outcome (equal to the displayed one unless pending). */
  raw: Verdict;
  persistence: {
    fingerprint: Fingerprint;
    candidate: PendingCandidate | null;
    /** Why the displayed outcome is what it is. */
    rule: "first" | "bypass_calibration" | "disabled" | "same" | "confirmed" | "confirmed_quiet" | "pending" | "pending_reanchored";
  };
}
