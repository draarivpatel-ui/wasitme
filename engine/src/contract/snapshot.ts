/**
 * TypeScript shape of contract/snapshot.v1.schema.json (frozen; docs/CONTRACT.md): the glance plus detail.
 */

import type { ChangeSide } from "../types.js";
import type { GlanceAgent, KN, Range, StripDay } from "./glance.js";
import type {
  ChangeProvenance, ChangeStrength, IneligibleReason, Lead, MetricFamily, MetricRole, MetricStatus, ScanError,
} from "./vocab.js";

export interface Window {
  from: string;
  to: string;
  days: number;
  exchanges: number;
  sessions: number;
  sessionDays: number;
}

export interface SnapshotMetric {
  id: string;
  label: string;
  unit: string;
  family: MetricFamily | null;
  role: MetricRole;
  recent: KN;
  baseline: KN;
  ratio: number | null;
  range: Range | null;
  mde: number | null;
  status: MetricStatus;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
  /** Eligible with MDE ≤ 2×. */
  sensitive: boolean;
  /** Material per D23. */
  shifted: boolean;
  standardized: { ratio: number | null; range: Range | null } | null;
  series: StripDay[];
}

export interface TimelineEvent {
  id: string;
  t: string;
  day: string;
  kind: string;
  side: ChangeSide;
  strength: ChangeStrength;
  provenance: ChangeProvenance;
  label: string;
  from: string;
  to: string;
  new: boolean;
}

export interface Candidate {
  /** A timeline event id. */
  event: string;
  status: "open" | "ruled_out" | "background";
  test: "strata" | "version_boundary" | "routine" | null;
}

export type ConfounderId =
  | "prompt_length" | "long_context_share" | "mode_mix" | "entrypoint_mix" | "subagent_mix" | "interactive_mix"
  | "project_mix" | "no_overlap";

export interface Confounder { id: ConfounderId; moved: boolean | null; value: number | null }

export interface Observation { fullyObservedDays: number; partiallyObservedDays: number; note: string }

export interface TraceStep { row: number; matched: boolean; text: string }

export interface SnapshotAgent extends GlanceAgent {
  tier: 1 | 2 | 3 | null;
  windows: { recent: Window; baseline: Window } | null;
  metrics: SnapshotMetric[];
  onset: { from: string; to: string } | null;
  /** Every change event, oldest first. */
  timeline: TimelineEvent[];
  candidates: Candidate[];
  confounders: Confounder[];
  observation: Observation;
  /** Counts and allow-listed labels only. */
  setup: Record<string, string | number | boolean>;
  trace: TraceStep[];
  disclaimer: string | null;
}

export type SourceError = "not_found" | "permission_denied" | "protected_folder" | "unreadable";

export interface SourceHealth {
  agent: string;
  found: boolean;
  files: number;
  badLines: number;
  truncatedTail: number;
  duplicates: number;
  unknownTypes: Record<string, number>;
  firstDay: string | null;
  lastDay: string | null;
  error: SourceError | null;
}

export interface Paused {
  agent: string;
  metric: string;
  why: "unknown_records_in_family" | "unknown_records_over_2pct" | "parser_changed";
}

export interface Health {
  sources: SourceHealth[];
  parserVersions: Record<string, number>;
  sandbox: boolean;
  paused: Paused[];
}

export interface CalibrationAgent {
  agent: string;
  calibrated: boolean;
  sequences: number;
  falseChanged: number | null;
  falseAgent: number | null;
}

export interface Calibration {
  artifactDate: string | null;
  methodId: string | null;
  agents: CalibrationAgent[];
}

export interface Snapshot {
  schema: "wasitme.snapshot/1";
  engine: string;
  generatedAt: string;
  staleAfterSec: number;
  scanOk: boolean;
  scanError: ScanError | null;
  demo: boolean;
  lead: Lead;
  agents: SnapshotAgent[];
  health: Health;
  calibration: Calibration;
  privacy: { containsText: false };
}
