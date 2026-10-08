/**
 * TypeScript shape of contract/glance.v1.schema.json (frozen; docs/CONTRACT.md). The schema is the source of
 * truth; engine/test/contract holds this file, the schema and the goldens together.
 */

import type { ChangeSide } from "../types.js";
import type {
  ChangeStrength, Lead, MetricFamily, MetricRole, MetricStatus, ScanError, VerdictReason, VerdictState,
} from "./vocab.js";

/** Integer totals for one window: k events over n opportunities (readsPerEdit: k reads over n edits). */
export interface KN { k: number; n: number }

/** [low, high] around a ratio, printed as "range" (D31). */
export type Range = [number, number];

export interface GlanceMetric {
  id: string;
  /** ≤40 */
  label: string;
  /** ≤24 */
  unit: string;
  family: MetricFamily | null;
  role: MetricRole;
  recent: KN;
  baseline: KN;
  ratio: number | null;
  range: Range | null;
  /** Minimum detectable ratio (≥1). */
  mde: number | null;
  status: MetricStatus;
}

export interface StripDay { d: string; k: number; n: number }

export interface Strip {
  metric: string;
  /** ≤42 days, oldest first. */
  days: StripDay[];
  window: { ratio: number | null; lo: number | null; hi: number | null; mde: number | null };
}

export interface GlanceEvent {
  day: string;
  kind: string;
  side: ChangeSide;
  strength: ChangeStrength;
  /** ≤60 */
  label: string;
  new: boolean;
}

export interface GateCounts { events: number; sessions: number; sessionDays: number }

export interface Unlock {
  metric: string;
  family: MetricFamily | null;
  have: GateCounts;
  need: GateCounts;
}

export interface Progress {
  tier: 1 | 2 | 3;
  etaDate: string | null;
  notAtCurrentPace: boolean;
  unlock: Unlock[];
}

export interface SampleCounts { exchanges: number; sessions: number; sessionDays: number; days: number }

export interface GlanceAgent {
  agent: string;
  state: VerdictState;
  reason: VerdictReason | null;
  pending: boolean;
  calibrated: boolean;
  /** ≤24 */
  label: string;
  /** ≤80 */
  headline: string;
  /** ≤200 */
  because: string;
  /** ≤160 */
  tryThis: string;
  /** ≤160 */
  confidence: string;
  /** ≤100; empty unless band-eligible. */
  band: string;
  /** ≤80, plain. */
  statusLine: string;
  n: SampleCounts;
  progress: Progress | null;
  /** ≤3 */
  topMetrics: GlanceMetric[];
  strip: Strip | null;
  /** ≤5, newest first. */
  events: GlanceEvent[];
}

export interface Glance {
  schema: "wasitme.glance/1";
  engine: string;
  generatedAt: string;
  staleAfterSec: number;
  scanOk: boolean;
  scanError: ScanError | null;
  demo: boolean;
  lead: Lead;
  /** Engine-ordered; single-glyph surfaces speak for agents[0]. */
  agents: GlanceAgent[];
  privacy: { containsText: false };
}
