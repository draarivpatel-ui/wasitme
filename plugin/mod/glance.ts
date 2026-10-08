// Pure data layer of the wasitme mod: finds, parses, bounds and classifies the
// glance file (contract/glance.v1.schema.json, frozen; display rules in
// docs/CONTRACT.md). No `$`, no drawing, no copy: everything here is testable
// with plain values, and nothing in it is a visual choice (those live in
// theme.ts and render.ts).
//
// Posture: the glance file is local but not trusted. It is parsed defensively
// (wrong types are dropped, never thrown on), every string is stripped of
// control characters and bounded before it can reach a terminal, and a file
// that does not promise `privacy.containsText: false` is refused outright.

import type {
  GlanceAgent,
  GlanceCounts,
  GlanceEvent,
  GlanceFamily,
  GlanceFile,
  GlanceGate,
  GlanceKN,
  GlanceLead,
  GlanceLoad,
  GlanceMetric,
  GlanceMetricStatus,
  GlanceProblem,
  GlanceProgress,
  GlanceReason,
  GlanceRole,
  GlanceScanError,
  GlanceSide,
  GlanceSnapshot,
  GlanceStrength,
  GlanceStrip,
  GlanceVerdict,
} from '../types'

export const GLANCE_SCHEMA = 'wasitme.glance/1'

/** The contract says <= 16 KB; anything past four times that is not a glance. */
export const MAX_GLANCE_BYTES = 64 * 1024

/** The contract's default when a glance carries no `staleAfterSec` (2 hours). */
export const DEFAULT_STALE_AFTER_MS = 7_200_000

/** The `staleAfterSec` range the contract allows; anything else falls back to the default. */
const STALE_AFTER_SEC_MIN = 60
const STALE_AFTER_SEC_MAX = 604_800

/** A `generatedAt` further ahead of the clock than this means one of the clocks is wrong (contract: 300 s). */
export const FUTURE_SKEW_MS = 5 * 60_000

/** More agents than this are not drawn (the contract knows two). */
export const MAX_AGENTS = 4

/** Counts (exchanges, days, ...) beyond this are not believable and are dropped. */
export const MAX_COUNT = 1_000_000_000

// ---- bounding strings and numbers ----------------------------------------

// What is never drawn, because a terminal or the model reading command output could
// act on it, or because the person could not see it:
//   \p{Cc}  C0, DEL and C1 controls (ESC among them, so no escape sequence survives)
//   \p{Cf}  format characters: soft hyphen, zero-width and bidi controls, BOM, and the
//           tag characters (U+E0001, U+E0020-E007F) that can smuggle hidden text
//   \p{Cs}  lone surrogates (a well-formed pair is one code point and is not matched)
//   \p{Zl}\p{Zp}  line and paragraph separators
// plus ranges Unicode leaves unassigned or non-Cf but that hide or alter text: U+2060-206F
// (invisible operators, with the unassigned U+2065), the whole tag block U+E0000-E007F, and
// the variation selectors U+FE00-FE0F and U+E0100-E01EF.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u2060-\u206f\u{E0000}-\u{E007F}\ufe00-\ufe0f\u{E0100}-\u{E01EF}]/gu

/** A display-safe string: controls stripped, whitespace collapsed, at most `max` characters. */
export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // Cut by code point, never by UTF-16 unit, so a surrogate pair is not split in two.
  const head = Array.from(value).slice(0, max * 4).join('')
  const chars = Array.from(head.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim())
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…'
}

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function count(value: unknown): number | null {
  const n = finite(value)
  return n !== null && n >= 0 && n <= MAX_COUNT ? Math.floor(n) : null
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : []
}

// ---- time -----------------------------------------------------------------

// RFC 3339 `date-time`, which the contract requires: a date, `T`, a time, and an offset
// (`Z` or `+hh:mm`). `Date.parse` is not used on the raw text: it reads a timestamp with no
// offset as the local time of whoever is looking (hours off, in either direction), accepts
// non-ISO text, and rolls "February 30" over into March.
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/**
 * Milliseconds since the epoch for an RFC 3339 date-time, or null for anything else: no
 * offset, a date alone, an impossible date or time, stray text. A leap second (`:60`) counts
 * as `:59`. The glance's own timestamp is never guessed at: null makes the pane say it cannot
 * tell how old the scan is.
 */
export function parseTimestamp(text: string): number | null {
  const match = RFC3339.exec(text)
  if (match === null) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ]
  const zone = match[8] ?? 'Z'
  const offsetHours = zone.length === 6 ? Number(zone.slice(1, 3)) : 0
  const offsetMinutes = zone.length === 6 ? Number(zone.slice(4, 6)) : 0
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 60 ||
    offsetHours > 23 || offsetMinutes > 59
  ) {
    return null
  }
  // Every field is checked, and the string is rebuilt in the one shape ECMAScript defines (four-digit
  // year, three-digit fraction, explicit offset), so Date.parse has nothing to guess at.
  const fraction = (match[7] ?? '').slice(0, 3).padEnd(3, '0')
  const pad = (n: number) => String(n).padStart(2, '0')
  const sign = zone === 'Z' || zone === 'z' ? '+' : zone.slice(0, 1)
  const iso =
    `${match[1]}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(Math.min(second, 59))}.${fraction}` +
    `${sign}${pad(offsetHours)}:${pad(offsetMinutes)}`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

// ---- parsing --------------------------------------------------------------

// The frozen vocabulary (D22). Anything else is `unclear` (the contract: "render
// unknown states as 'unclear'"); the pre-freeze names are not special-cased.
const STATES: readonly GlanceVerdict[] = ['insufficient', 'none', 'unclear', 'you', 'agent']
const REASONS: readonly GlanceReason[] = [
  'calibration_pending',
  'needs_data',
  'single_indicator',
  'mixed',
  'workload',
  'unknown_provenance',
  'both_sides',
  'nothing_recorded_on_your_side',
  'blind_spot',
  'by_elimination',
]
const SIDES: readonly GlanceSide[] = ['you', 'agent', 'unknown', 'meta']
const STRENGTHS: readonly GlanceStrength[] = ['strong', 'weak', 'routine']
const METRIC_STATUSES: readonly GlanceMetricStatus[] = ['worse', 'better', 'none', 'ineligible']
const FAMILIES: readonly GlanceFamily[] = ['errors', 'research', 'friction']
const ROLES: readonly GlanceRole[] = ['vote', 'support', 'context']
const SCAN_ERRORS: readonly GlanceScanError[] = ['permission_denied', 'write_failed', 'timeout', 'internal']
const LEADS: readonly GlanceLead[] = ['timeline', 'verdict']

function kn(raw: unknown): GlanceKN | null {
  if (!isObject(raw)) return null
  const k = count(raw.k)
  const n = count(raw.n)
  return k === null || n === null ? null : { k, n }
}

function parseMetric(raw: unknown): GlanceMetric | null {
  if (!isObject(raw)) return null
  const id = clean(raw.id, 32)
  if (id === '') return null
  const bounds = Array.isArray(raw.range) && raw.range.length === 2 ? raw.range : []
  const low = finite(bounds[0])
  const high = finite(bounds[1])
  return {
    id,
    label: clean(raw.label, 40) || id,
    unit: clean(raw.unit, 24),
    family: pick(raw.family, FAMILIES),
    role: pick(raw.role, ROLES),
    recent: kn(raw.recent),
    baseline: kn(raw.baseline),
    ratio: finite(raw.ratio),
    range: low !== null && high !== null && low <= high ? [low, high] : null,
    mde: finite(raw.mde),
    status: pick(raw.status, METRIC_STATUSES),
  }
}

function parseEvent(raw: unknown): GlanceEvent | null {
  if (!isObject(raw)) return null
  const label = clean(raw.label, 60)
  if (label === '') return null
  return {
    day: clean(raw.day, 12),
    kind: clean(raw.kind, 24),
    // An unknown side is `unknown`, never `agent`.
    side: pick(raw.side, SIDES) ?? 'unknown',
    strength: pick(raw.strength, STRENGTHS),
    label,
    isNew: raw.new === true,
  }
}

function parseStrip(raw: unknown): GlanceStrip | null {
  if (!isObject(raw)) return null
  const days = list(raw.days, 42).map(d =>
    isObject(d) ? { day: clean(d.d, 12), k: count(d.k), n: count(d.n) } : { day: '', k: null, n: null },
  )
  if (days.length === 0) return null
  const window = isObject(raw.window) ? raw.window : {}
  return {
    metric: clean(raw.metric, 32),
    days,
    ratio: finite(window.ratio),
    lo: finite(window.lo),
    hi: finite(window.hi),
    mde: finite(window.mde),
  }
}

function gate(raw: unknown): GlanceGate {
  const g = isObject(raw) ? raw : {}
  return { events: count(g.events), sessions: count(g.sessions), sessionDays: count(g.sessionDays) }
}

function parseProgress(raw: unknown): GlanceProgress | null {
  if (!isObject(raw)) return null
  const tier = count(raw.tier)
  const notAtCurrentPace = raw.notAtCurrentPace === true
  return {
    tier: tier !== null && tier >= 1 && tier <= 3 ? tier : null,
    // A day count is never shown when the engine says no tier gets there at the current pace.
    etaDate: notAtCurrentPace ? '' : clean(raw.etaDate, 10),
    notAtCurrentPace,
    unlock: list(raw.unlock, 6).flatMap(u => {
      if (!isObject(u)) return []
      const metric = clean(u.metric, 32)
      // Interrupts never get a progress bar (METHOD.md §13: progress is for voting indicators).
      if (metric === '' || metric === 'interrupts') return []
      return [{ metric, family: pick(u.family, FAMILIES), have: gate(u.have), need: gate(u.need) }]
    }),
  }
}

function parseAgent(raw: unknown): GlanceAgent | null {
  if (!isObject(raw)) return null
  const agent = clean(raw.agent, 32)
  if (agent === '') return null
  const n = isObject(raw.n) ? raw.n : {}
  const counts: GlanceCounts = {
    exchanges: count(n.exchanges),
    sessions: count(n.sessions),
    sessionDays: count(n.sessionDays),
    days: count(n.days),
  }

  return {
    agent,
    state: pick(raw.state, STATES) ?? 'unclear',
    reason: pick(raw.reason, REASONS),
    pending: raw.pending === true,
    calibrated: raw.calibrated === true,
    label: clean(raw.label, 24),
    headline: clean(raw.headline, 80),
    because: clean(raw.because, 200),
    tryThis: clean(raw.tryThis, 160),
    confidence: clean(raw.confidence, 160),
    band: clean(raw.band, 100),
    statusLine: clean(raw.statusLine, 80),
    n: counts,
    progress: parseProgress(raw.progress),
    metrics: list(raw.topMetrics, 3).flatMap(m => parseMetric(m) ?? []),
    strip: parseStrip(raw.strip),
    events: list(raw.events, 5).flatMap(e => parseEvent(e) ?? []),
  }
}

function staleAfterMs(value: unknown): number {
  const sec = finite(value)
  return sec !== null && sec >= STALE_AFTER_SEC_MIN && sec <= STALE_AFTER_SEC_MAX ? sec * 1000 : DEFAULT_STALE_AFTER_MS
}

function fail(problem: GlanceProblem, found = ''): GlanceLoad {
  return { ok: false, problem, found }
}

/** Parses the text of glance.json. Never throws; says why when there is nothing to draw. */
export function parseGlance(text: string): GlanceLoad {
  if (text.length > MAX_GLANCE_BYTES) return fail('unreadable')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('unreadable')
  }
  if (!isObject(raw)) return fail('unreadable')

  if (typeof raw.schema !== 'string') return fail('invalid')
  if (raw.schema !== GLANCE_SCHEMA) return fail('mismatch', clean(raw.schema, 32))

  // The contract requires these. A glance that does not promise it holds no
  // text is not drawn: this pane sits next to the person's prompt.
  const privacy = raw.privacy
  if (
    !Array.isArray(raw.agents) ||
    typeof raw.scanOk !== 'boolean' ||
    typeof raw.generatedAt !== 'string' ||
    !isObject(privacy) ||
    privacy.containsText !== false
  ) {
    return fail('invalid')
  }

  const scanError =
    raw.scanError === null || raw.scanError === undefined ? null : (pick(raw.scanError, SCAN_ERRORS) ?? 'internal')
  return {
    ok: true,
    glance: {
      generatedAt: clean(raw.generatedAt, 40),
      generatedAtMs: typeof raw.generatedAt === 'string' ? parseTimestamp(raw.generatedAt) : null,
      staleAfterMs: staleAfterMs(raw.staleAfterSec),
      scanOk: raw.scanOk,
      scanError: raw.scanOk ? null : scanError,
      demo: raw.demo === true,
      lead: pick(raw.lead, LEADS) ?? 'timeline',
      agents: raw.agents.slice(0, 16).flatMap(a => parseAgent(a) ?? []),
    },
  }
}

// ---- where the file lives -------------------------------------------------

// The module finds the home directory from where the plugin lives, without reading
// the environment (`$.fs` does not expand `~`):
//   <home>/.claude*/plugins/...            a marketplace install's cache copy
//   <home>/.wasitme/current/plugin         the full install (D32: the marketplace is registered at
//                                          the `current` symlink and the plugin root resolves there)
//   <home>/.local/share/wasitme/...        the installer's default prefix layout
// A custom config directory, a custom prefix, or a plugin loaded with --plugin-dir has
// none of these shapes: the `glancePath` option covers those (setup always writes it).
const HOMES_OF_PLUGIN = [
  /^(.*?)\/\.claude[^/]*\/plugins\//,
  /^(.*?)\/\.wasitme\//,
  /^(.*?)\/\.local\/share\/wasitme\//,
]

/** The home directory implied by the plugin's own location, or null. */
export function deriveHome(pluginRoot: string): string | null {
  const path = pluginRoot.replace(/\\/g, '/')
  for (const pattern of HOMES_OF_PLUGIN) {
    const match = pattern.exec(path)
    if (match !== null) return match[1] ?? ''
  }
  return null
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Where glance.json is: the `glancePath` option (absolute, or `~/` expanded
 * against the derived home), else `<home>/.wasitme/glance.json`; null when
 * neither can be worked out.
 */
export function resolveGlancePath(option: unknown, pluginRoot: string): string | null {
  const home = deriveHome(pluginRoot)
  const given = typeof option === 'string' ? option.trim() : ''
  if (given !== '') {
    if (given.startsWith('~/')) return home === null ? null : `${home}/${given.slice(2)}`
    return isAbsolute(given) ? given : null
  }
  return home === null ? null : `${home}/.wasitme/glance.json`
}

// ---- what to show ---------------------------------------------------------

export type StaleReason = 'old' | 'clock' | 'unknown'

/** What the drawing shows, decided once from a snapshot. */
export type Display =
  | { kind: 'loading' }
  | { kind: 'problem'; problem: GlanceProblem; found: string }
  | { kind: 'scan-failed'; glance: GlanceFile; ageMs: number | null }
  | { kind: 'stale'; glance: GlanceFile; reason: StaleReason; ageMs: number | null }
  | { kind: 'empty'; glance: GlanceFile; ageMs: number | null }
  | { kind: 'ready'; glance: GlanceFile; ageMs: number | null }

/**
 * Milliseconds since the scan, never negative (clocks can go backward), or
 * null when the scan's timestamp did not parse.
 */
export function ageOf(glance: GlanceFile, nowMs: number): number | null {
  return glance.generatedAtMs === null ? null : Math.max(0, nowMs - glance.generatedAtMs)
}

/**
 * Why a glance cannot be trusted as current, or null when it can (contract display rule 3):
 * no parseable timestamp, older than the file's own `staleAfterSec`, or more than five minutes
 * in the future (a clock that went backward).
 */
export function staleReason(glance: GlanceFile, nowMs: number): StaleReason | null {
  if (glance.generatedAtMs === null) return 'unknown'
  if (glance.generatedAtMs - nowMs > FUTURE_SKEW_MS) return 'clock'
  return nowMs - glance.generatedAtMs > glance.staleAfterMs ? 'old' : null
}

/** Decides what to draw. Order matters: a problem beats a failed scan beats staleness beats emptiness. */
export function classify(snapshot: GlanceSnapshot | null): Display {
  if (snapshot === null) return { kind: 'loading' }
  const { load, nowMs } = snapshot
  if (!load.ok) return { kind: 'problem', problem: load.problem, found: load.found }

  const glance = load.glance
  const ageMs = ageOf(glance, nowMs)
  if (!glance.scanOk) return { kind: 'scan-failed', glance, ageMs }
  const reason = staleReason(glance, nowMs)
  if (reason !== null) return { kind: 'stale', glance, reason, ageMs }
  if (glance.agents.length === 0) return { kind: 'empty', glance, ageMs }
  return { kind: 'ready', glance, ageMs }
}

/** The agents to draw, in the engine's order (the first is the one a one-line surface speaks for), at most MAX_AGENTS. */
export function orderedAgents(glance: GlanceFile): GlanceAgent[] {
  return glance.agents.slice(0, MAX_AGENTS)
}

/**
 * The first agent the band may speak for: the engine wrote a band line, and the verdict is an
 * answer (your side, or the agent). Both must hold, so the band never speaks for "too early",
 * "no detectable change" or "unclear", whatever the file says.
 */
export function attentionAgent(glance: GlanceFile): GlanceAgent | null {
  return orderedAgents(glance).find(a => a.band !== '' && (a.state === 'you' || a.state === 'agent')) ?? null
}
