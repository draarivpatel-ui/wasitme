// wasitme mod: the shapes the module passes around and its `$.state` contract.
// Every `$.state` key the hooks module names is declared at the bottom;
// `claude plugin validate` holds the module to it. State is plain JSON data,
// so absent values are `null`, never `undefined`.
//
// These are the module's own view of contract/glance.v1.schema.json (frozen,
// docs/CONTRACT.md): parsed, bounded and stripped of control characters (see
// mod/glance.ts), never the raw file.

/** D22 verdict states. Unknown input is mapped to `unclear`; `stale` is a display, not a state. */
export type GlanceVerdict = 'insufficient' | 'none' | 'unclear' | 'you' | 'agent'

/** Decision-table reasons (METHOD.md §11); an unknown reason is `null`. */
export type GlanceReason =
  | 'calibration_pending'
  | 'needs_data'
  | 'single_indicator'
  | 'mixed'
  | 'workload'
  | 'unknown_provenance'
  | 'both_sides'
  | 'nothing_recorded_on_your_side'
  | 'blind_spot'
  | 'by_elimination'

/** Who initiated a change. Unknown input is `unknown`, never `agent`. */
export type GlanceSide = 'you' | 'agent' | 'unknown' | 'meta'

export type GlanceStrength = 'strong' | 'weak' | 'routine'

export type GlanceMetricStatus = 'worse' | 'better' | 'none' | 'ineligible'

export type GlanceFamily = 'errors' | 'research' | 'friction'

export type GlanceRole = 'vote' | 'support' | 'context'

/** Why the last scan failed (an unknown kind reads as `internal`). */
export type GlanceScanError = 'permission_denied' | 'write_failed' | 'timeout' | 'internal'

export type GlanceLead = 'timeline' | 'verdict'

/** Integer totals for one window: k events over n opportunities. */
export type GlanceKN = { k: number; n: number }

export type GlanceMetric = {
  id: string
  label: string
  unit: string
  family: GlanceFamily | null
  role: GlanceRole | null
  recent: GlanceKN | null
  baseline: GlanceKN | null
  ratio: number | null
  /** The interval around `ratio`, printed as "range". */
  range: [number, number] | null
  /** Minimum detectable ratio. */
  mde: number | null
  status: GlanceMetricStatus | null
}

export type GlanceEvent = {
  day: string
  kind: string
  side: GlanceSide
  strength: GlanceStrength | null
  label: string
  isNew: boolean
}

export type GlanceStripDay = { day: string; k: number | null; n: number | null }

export type GlanceStrip = {
  metric: string
  days: GlanceStripDay[]
  ratio: number | null
  lo: number | null
  hi: number | null
  mde: number | null
}

export type GlanceGate = { events: number | null; sessions: number | null; sessionDays: number | null }

export type GlanceUnlock = { metric: string; family: GlanceFamily | null; have: GlanceGate; need: GlanceGate }

export type GlanceProgress = {
  tier: number | null
  /** YYYY-MM-DD, or '' when there is none. */
  etaDate: string
  notAtCurrentPace: boolean
  unlock: GlanceUnlock[]
}

export type GlanceCounts = {
  exchanges: number | null
  sessions: number | null
  sessionDays: number | null
  days: number | null
}

export type GlanceAgent = {
  /** `claude-code`, `codex`, or a future id (sanitized). */
  agent: string
  state: GlanceVerdict
  reason: GlanceReason | null
  /** A change waiting for a second agreeing evaluation; the state shown is the held one. */
  pending: boolean
  /** False: this agent's verdicts are off until its own calibration passes ("Timeline only"). */
  calibrated: boolean
  label: string
  headline: string
  because: string
  tryThis: string
  confidence: string
  /** The engine's band line; empty unless the engine says the band should speak. */
  band: string
  statusLine: string
  n: GlanceCounts
  progress: GlanceProgress | null
  metrics: GlanceMetric[]
  strip: GlanceStrip | null
  /** Newest first. */
  events: GlanceEvent[]
}

export type GlanceFile = {
  /** The engine's own timestamp string, sanitized. */
  generatedAt: string
  /** `generatedAt` as epoch milliseconds, or null when it does not parse. */
  generatedAtMs: number | null
  /** From the file's `staleAfterSec` (default 7,200 s). */
  staleAfterMs: number
  scanOk: boolean
  scanError: GlanceScanError | null
  demo: boolean
  lead: GlanceLead
  /** Engine order: the first agent is the one a single-line surface speaks for. */
  agents: GlanceAgent[]
}

/**
 * Why there is nothing to draw:
 * - `unlocated`: the module cannot work out where glance.json lives.
 * - `missing`: the file is not there (no scan has run).
 * - `unreadable`: it could not be read, is empty, too large, or not JSON.
 * - `invalid`: JSON, right schema id, but not shaped like a glance (or it
 *   does not promise it holds no text: the contract's "refused").
 * - `mismatch`: a different schema id (`found` says which).
 */
export type GlanceProblem = 'unlocated' | 'missing' | 'unreadable' | 'invalid' | 'mismatch'

export type GlanceLoad = { ok: true; glance: GlanceFile } | { ok: false; problem: GlanceProblem; found: string }

/** What one refresh produced. `nowMs` is the clock when it ran, so a drawing never reads the clock. */
export type GlanceSnapshot = {
  load: GlanceLoad
  /** The file's mtime/size at the last read, to skip re-reading an unchanged file. */
  mtimeMs: number | null
  size: number | null
  nowMs: number
}

declare module 'claude-code' {
  interface PluginState {
    wasitme: {
      snapshot: GlanceSnapshot | null
      isBandHidden: boolean
    }
  }
}
