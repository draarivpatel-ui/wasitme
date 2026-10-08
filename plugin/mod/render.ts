// The wasitme mod's drawings: layout only, built from theme.ts (the design
// system's tokens and the mod's few own words) and a display decided by
// glance.ts. No `$` in here: register.ts resolves the element table and passes
// it in with the handlers and the width, so every function below is a plain
// function of its arguments.
//
// The pane follows design/system/screens/text-*.png (64 × 18 cells): buttons
// first (an 80-column inline pane must never clip them), then, per agent, the
// sections the CLI prints, in the engine's lead (D28/D61; timeline-led is the
// default):
//   timeline-led:  What changed · Finding · Signals · Next
//   verdict-led:   Finding · Signals · What changed · Next
// "What changed" is the case line: your changes numbered above a dashed rule,
// the agent's lettered below it, one column per day, with that day's k/n under
// it. No projected dates anywhere (D66).

import type { Elements, RenderElement } from 'claude-code'

import type { GlanceAgent, GlanceEvent, GlanceFile, GlanceMetric, GlanceStrip, GlanceStripDay, GlanceUnlock } from '../types'
import { attentionAgent, orderedAgents } from './glance'
import type { Display } from './glance'
import { theme } from './theme'
import type { Party } from './theme'

/** The elements every surface's table has: all this mod draws with. */
export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

type Props = Record<string, unknown>
type Child = RenderElement | null

const { copy, layout } = theme

// ---- small builders -------------------------------------------------------

// Props are plain data: an `undefined` is left out, not passed.
function defined(props: Props): Props {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined))
}

function text(kit: Kit, content: string, props: Props = {}): RenderElement {
  return h(kit.Text, defined({ wrap: 'wrap', ...props }), content) as RenderElement
}

function dim(kit: Kit, content: string, props: Props = {}): RenderElement {
  return text(kit, content, { ...theme.secondary, ...props })
}

function strong(kit: Kit, content: string, props: Props = {}): RenderElement {
  return text(kit, content, { ...theme.emphasis, ...props })
}

/** One cell-exact row of the case line: never wraps. */
function cells(kit: Kit, content: string, props: Props = {}): RenderElement {
  return text(kit, content, { wrap: 'truncate-end', ...props })
}

function sticker(kit: Kit, party: Party, mark: string, props: Props = {}): RenderElement {
  return cells(kit, ` ${mark} `, { ...theme.sticker[party], ...props })
}

function box(kit: Kit, props: Props, children: readonly Child[]): RenderElement {
  return h(kit.Box, props, ...children.filter(child => child !== null)) as RenderElement
}

function column(kit: Kit, children: readonly Child[], props: Props = {}): RenderElement {
  return box(kit, { flexDirection: 'column', ...props }, children)
}

function row(kit: Kit, children: readonly Child[], props: Props = {}): RenderElement {
  return box(kit, { flexDirection: 'row', ...props }, children)
}

function section(kit: Kit, children: readonly Child[], props: Props = {}): RenderElement {
  return column(kit, children, { marginTop: 1, ...props })
}

function spacer(kit: Kit): RenderElement {
  return box(kit, { flexGrow: 1 }, [])
}

// ---- formatting (the engine's own rules, words/format.ts) ------------------

/** A whole count with thousands separators; `–` for none. */
export function count(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return '–'
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** A count in at most 3 cells, for one day under the case line ("88", "3k"). */
export function shortCount(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return '–'
  const v = Math.round(n)
  if (v < 1000) return String(v)
  if (v < 99_500) return `${Math.round(v / 1000)}k`
  return '99k'
}

/** A ratio, two decimals ("×0.75"). */
export function ratio2(r: number): string {
  return Number.isFinite(r) && r > 0 ? `×${r.toFixed(2)}` : '×?'
}

/** A range rounded outward, so it is never printed narrower than it is ("×0.42–×1.33"). */
export function rangeText(lo: number, hi: number): string {
  const l = Math.floor(lo * 100 + 1e-9) / 100
  const u = Math.ceil(hi * 100 - 1e-9) / 100
  return `×${l.toFixed(2)}–×${u.toFixed(2)}`
}

/** A minimum detectable change in prose, one decimal ("×2.5"). */
export function mdeText(m: number): string {
  return Number.isFinite(m) && m > 0 ? `×${m.toFixed(1)}` : '×?'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Sep 21" from YYYY-MM-DD, with the year when it is not `today`'s; '' for anything else. */
export function dayLabel(d: string, today = ''): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  if (m === null) return ''
  const month = MONTHS[Number(m[2]) - 1]
  if (month === undefined) return ''
  const base = `${month} ${Number(m[3])}`
  const year = /^(\d{4})-/.exec(today)?.[1]
  return year !== undefined && year !== m[1] ? `${base}, ${m[1]}` : base
}

/** "6h ago", never negative; the caller passes an age already clamped at zero. */
export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return copy.unknownAge
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return copy.justNow
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function agentName(id: string): string {
  return Object.hasOwn(theme.agentName, id) ? (theme.agentName[id] ?? id) : id
}

export function progressBar(have: number, need: number): string {
  const { full, empty, cells: width } = theme.bar
  const filled = need > 0 ? Math.min(width, Math.max(0, Math.round((have / need) * width))) : 0
  return full.repeat(filled) + empty.repeat(width - filled)
}

function today(glance: GlanceFile): string {
  return glance.generatedAtMs === null ? '' : new Date(glance.generatedAtMs).toISOString().slice(0, 10)
}

function metricName(agent: GlanceAgent, id: string): string {
  const own = agent.metrics.find(m => m.id === id)?.label ?? ''
  if (own !== '') return own
  return Object.hasOwn(theme.metricName, id) ? (theme.metricName[id] ?? id) : id
}

function eventNoun(id: string): string {
  return Object.hasOwn(theme.eventNoun, id) ? (theme.eventNoun[id] ?? 'events') : 'events'
}

export type GateUnit = 'sessions' | 'sessionDays' | 'events'
/** The one pair an unlock counter shows: its unit, count, target and what the unit is called. */
export type GatePair = { unit: GateUnit; have: number; need: number; noun: string }
const GATE_UNITS: readonly GateUnit[] = ['sessions', 'sessionDays', 'events']

/**
 * The unlock counter (docs/CONTRACT.md#display-rules; the engine's contract/display.ts bindingGate is the reference):
 * of the units still short of their target, the one furthest from it by have / need, a tie going to the earlier of
 * sessions, session-days, events. The count, its noun and the bar all come from this pair, so a count is never set
 * against another quantity's target ("3,150 of 10"). Null when no unit is short (only one session dominating).
 */
export function bindingGate(u: GlanceUnlock | undefined): GatePair | null {
  if (u === undefined) return null
  let best: GatePair | null = null
  for (const unit of GATE_UNITS) {
    const have = u.have[unit]
    const need = u.need[unit]
    if (have === null || need === null || !(have >= 0) || !(need > 0) || !(have < need) || !Number.isFinite(need)) continue
    if (best === null || have / need < best.have / best.need) {
      best = { unit, have, need, noun: unit === 'sessions' ? 'sessions' : unit === 'sessionDays' ? 'session-days' : eventNoun(u.metric) }
    }
  }
  return best
}

/** The ledger's status word (the CLI's statusWord, from what a glance carries). */
export function statusWord(metric: GlanceMetric): string {
  if (metric.role === 'context') return theme.status.context
  if (metric.status === 'ineligible' || metric.status === null) {
    return metric.family === 'friction' ? theme.status.context : theme.status.notYet
  }
  if (metric.status === 'worse' || metric.status === 'better') {
    return metric.ratio !== null && metric.ratio < 1 ? theme.status.fewer : theme.status.more
  }
  return theme.status.notDetected
}

// ---- the case line (pure, so the tests can read it cell by cell) -----------

/** The changes a person can act on, oldest first (the glance lists them newest first). */
export function visibleEvents(agent: GlanceAgent): GlanceEvent[] {
  return agent.events.filter(e => e.side !== 'meta' && e.kind !== 'system-prompt').slice().reverse()
}

/** How many days fit on the case line at this width. */
export function daySlots(columns: number): number {
  const fit = Math.floor((columns - layout.laneLeft) / layout.pitch)
  return Math.max(layout.minDays, Math.min(layout.maxDays, fit))
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Markers for changes, oldest first: yours numbered (1, 2, ...), the agent's lettered (A, B, ...), one per day and
 * side; a change of unknown origin is "?" and is never given the agent's letter.
 */
export function markers(events: readonly GlanceEvent[]): string[] {
  const groups = new Map<string, string>()
  let n = 0
  let l = 0
  return events.map(e => {
    if (e.side !== 'you' && e.side !== 'agent') return '?'
    const key = `${e.day}|${e.side}`
    let mark = groups.get(key)
    if (mark === undefined) {
      if (e.side === 'you') mark = n < 99 ? String(++n) : '+'
      else mark = l < ALPHABET.length ? (ALPHABET[l++] ?? '+') : '+'
      groups.set(key, mark)
    }
    return mark
  })
}

/** One run of a lane row: plain cells, or a sticker. */
export type Run = { text: string; party: Party | null }

export type CaseLine = {
  days: GlanceStripDay[]
  /** The changes on the drawn days, oldest first, with their markers. */
  inView: { event: GlanceEvent; mark: string }[]
  yours: Run[]
  rule: string
  agent: Run[]
  dates: string
  kRow: string
  nRow: string
  labels: readonly [string, string]
}

function put(chars: string[], at: number, value: string): void {
  Array.from(value).forEach((c, i) => {
    if (at + i >= 0 && at + i < chars.length) chars[at + i] = c
  })
}

function lane(width: number, label: string, stickers: Map<number, string>, party: Party): Run[] {
  const runs: Run[] = []
  let plain = label.padEnd(layout.laneLeft, ' ')
  for (let x = layout.laneLeft; x < width; ) {
    const mark = stickers.get(x)
    if (mark !== undefined) {
      runs.push({ text: plain, party: null })
      runs.push({ text: ` ${mark} `, party })
      plain = ''
      x += 3
    } else {
      plain += ' '
      x += 1
    }
  }
  if (plain.trim() !== '' || runs.length === 0) runs.push({ text: plain.trimEnd(), party: null })
  return runs.filter(r => r.text !== '')
}

/** The case line for the last `slots` days of the strip, or null when there is no strip to draw. */
export function caseLine(strip: GlanceStrip | null, events: readonly GlanceEvent[], slots: number, today = ''): CaseLine | null {
  if (strip === null || strip.days.length === 0) return null
  const days = strip.days.slice(-slots)
  const first = days[0]?.day ?? ''
  const last = days[days.length - 1]?.day ?? ''
  const index = new Map(days.map((d, i) => [d.day, i]))
  const inViewEvents = events.filter(e => e.day !== '' && e.day >= first && e.day <= last && index.has(e.day))
  const marks = markers(inViewEvents)
  const inView = inViewEvents.map((event, i) => ({ event, mark: marks[i] ?? '?' }))

  const width = layout.laneLeft + days.length * layout.pitch
  const rule = Array.from({ length: days.length * layout.pitch }, () => theme.caseLine.rule)
  const you = new Map<number, string>()
  const agent = new Map<number, string>()
  for (const { event, mark } of inView) {
    const i = index.get(event.day)
    if (i === undefined) continue
    const x = layout.laneLeft + i * layout.pitch
    if (event.side === 'you') {
      if (!you.has(x)) you.set(x, mark)
      rule[i * layout.pitch + 1] = theme.caseLine.you
    } else if (event.side === 'agent') {
      if (!agent.has(x)) agent.set(x, mark)
      rule[i * layout.pitch + 1] = theme.caseLine.agent
    } else if (rule[i * layout.pitch + 1] === theme.caseLine.rule) {
      rule[i * layout.pitch + 1] = theme.caseLine.unknown
    }
  }

  // Date labels: the first day, a week in, two weeks in, and the last (right-aligned to the line).
  const dates = Array.from({ length: width }, () => ' ')
  const lastLabel = dayLabel(last, today).replace(/, \d{4}$/, '')
  const lastAt = width - 1 - Array.from(lastLabel).length
  for (const i of [0, 7, 14]) {
    const d = days[i]
    if (d === undefined || i >= days.length - 2) continue
    const label = dayLabel(d.day, today).replace(/, \d{4}$/, '')
    const at = layout.laneLeft + i * layout.pitch
    if (at + Array.from(label).length < lastAt) put(dates, at, label)
  }
  put(dates, lastAt, lastLabel)

  const labels = Object.hasOwn(theme.stripRows, strip.metric)
    ? (theme.stripRows[strip.metric] ?? theme.stripRowsFallback)
    : theme.stripRowsFallback
  const kRow = Array.from({ length: width }, () => ' ')
  const nRow = Array.from({ length: width }, () => ' ')
  put(kRow, 0, labels[0])
  put(nRow, 0, labels[1])
  days.forEach((d, i) => {
    const k = d.n === 0 || d.n === null ? '–' : shortCount(d.k)
    const n = shortCount(d.n)
    const x = layout.laneLeft + i * layout.pitch
    put(kRow, x + 3 - Array.from(k).length, k)
    put(nRow, x + 3 - Array.from(n).length, n)
  })

  return {
    days,
    inView,
    yours: lane(width, copy.yours, you, 'you'),
    rule: ' '.repeat(layout.laneLeft) + rule.join(''),
    agent: lane(width, copy.agentLane, agent, 'agent'),
    dates: dates.join('').trimEnd(),
    kRow: kRow.join('').trimEnd(),
    nRow: nRow.join('').trimEnd(),
    labels,
  }
}

// ---- what a notice says ---------------------------------------------------

type Notice = { glyph: string; title: string; help: string; extra: string[] }

/** The words for every display that is not a finding; null for `ready`. */
export function noticeOf(display: Display): Notice | null {
  switch (display.kind) {
    case 'ready':
      return null
    case 'loading':
      return { glyph: '', title: copy.loading, help: '', extra: [] }
    case 'problem': {
      const words = copy.problem[display.problem]
      const found = display.problem === 'mismatch' && display.found !== '' ? [`Found: ${display.found}`] : []
      return { glyph: '', title: words.title, help: words.help, extra: found }
    }
    case 'scan-failed':
      return {
        glyph: '',
        title: copy.scanFailed.title,
        help: copy.scanFailed.help,
        extra: [copy.scanError[display.glance.scanError ?? 'internal']],
      }
    case 'stale': {
      const words =
        display.reason === 'old' ? copy.staleOld : display.reason === 'clock' ? copy.staleClock : copy.staleUnknown
      const when = display.reason === 'old' ? [`Last scan ${formatAge(display.ageMs)}.`] : []
      return { glyph: theme.glyph('stale'), title: words.title, help: words.help, extra: when }
    }
    case 'empty':
      return { glyph: '', title: copy.empty.title, help: copy.empty.help, extra: [] }
  }
}

/** The engine's state label ("Too early to tell", "Timeline only"), or the design system's. */
export function labelOf(agent: GlanceAgent): string {
  return agent.label === '' ? theme.label(agent.state) : agent.label
}

/** The one-line text `/wasitme` answers with; the model reads command output, so it carries derived words only. */
export function commandSummary(display: Display, isPlaced: boolean): string {
  const opened = isPlaced ? copy.commandOpened : copy.commandWaiting
  if (display.kind === 'ready') {
    const first = orderedAgents(display.glance)[0]
    if (first === undefined) return opened
    const deck = first.headline === '' ? '' : ` ${first.headline}`
    return `${opened} ${agentName(first.agent)}: ${labelOf(first)}.${deck}`
  }
  const notice = noticeOf(display)
  return notice === null ? opened : `${opened} ${notice.title}.`
}

// ---- the pane: one agent ----------------------------------------------------

type View = { kit: Kit; glance: GlanceFile; agent: GlanceAgent; index: number; showName: boolean; slots: number; today: string }

function partyOf(state: GlanceAgent['state']): Party | null {
  return state === 'you' ? 'you' : state === 'agent' ? 'agent' : null
}

function sideWords(event: GlanceEvent): string {
  const side = event.side === 'you' ? copy.yourSide : event.side === 'agent' ? copy.agentSide : copy.unknownSide
  const tags = [...(event.strength === 'routine' ? [copy.routine] : []), ...(event.isNew ? [copy.isNew] : [])]
  return [side, ...tags].join(layout.separator)
}

function runs(kit: Kit, parts: readonly { text: string; party: Party | null }[], key: string): RenderElement {
  return row(
    kit,
    parts.map((part, i) => (part.party === null ? cells(kit, part.text, { key: `${key}-${i}` }) : sticker(kit, part.party, part.text.trim(), { key: `${key}-${i}` }))),
    { key },
  )
}

/** One change: its marker (or a blank cell), the day, what changed, and on which side. */
function eventRow(v: View, event: GlanceEvent, mark: string | null, key: string, pad = false): RenderElement {
  const { kit } = v
  const party = event.side === 'you' ? 'you' : event.side === 'agent' ? 'agent' : null
  const markCell =
    mark === null
      ? pad
        ? cells(kit, '   ')
        : null
      : party !== null && mark !== '?'
        ? sticker(kit, party, mark)
        : cells(kit, ` ${mark} `)
  const when = dayLabel(event.day, v.today)
  return row(
    kit,
    [
      markCell === null ? null : box(kit, { flexShrink: 0, marginRight: 1 }, [markCell]),
      box(kit, { flexShrink: 1, flexGrow: 1, flexDirection: 'column' }, [
        text(kit, when === '' ? event.label : `${when}  ${event.label}`),
        box(kit, { paddingLeft: layout.indent.length }, [dim(kit, sideWords(event))]),
      ]),
    ],
    { key },
  )
}

function whatChanged(v: View): RenderElement {
  const { kit, agent } = v
  const all = visibleEvents(agent)
  const line = caseLine(agent.strip, all, v.slots, v.today)
  const heading = strong(kit, copy.whatChanged)

  if (line === null) {
    // Timeline only (no comparison ran): the changes of the last 30 days, as a list.
    const from = v.today === '' ? '' : new Date(Date.parse(`${v.today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10)
    const recent = all.filter(e => from === '' || e.day >= from)
    const shown = recent.slice(-layout.maxEvents)
    return section(kit, [
      row(kit, [heading, dim(kit, `  ${copy.lastDays}`)]),
      ...(shown.length === 0 ? [dim(kit, copy.noChanges)] : shown.map((e, i) => eventRow(v, e, null, `ev-${v.index}-${i}`))),
      recent.length > shown.length ? dim(kit, copy.earlier(recent.length - shown.length)) : null,
      shown.some(e => e.strength === 'routine') ? dim(kit, copy.routineNote) : null,
    ])
  }

  // Listed: every change over the whole strip, so a narrow pane that draws fewer days still names them; only the ones
  // on the drawn days carry a marker.
  const stripDays = agent.strip?.days ?? []
  const from = stripDays[0]?.day ?? ''
  const to = stripDays[stripDays.length - 1]?.day ?? ''
  const markOf = new Map(line.inView.map(x => [x.event, x.mark]))
  const listed = all.filter(e => e.day !== '' && e.day >= from && e.day <= to).map(event => ({ event, mark: markOf.get(event) ?? null }))
  const shown = listed.slice(-layout.maxEvents)
  const hidden = listed.length - shown.length
  const marked = shown.some(x => x.mark !== null)
  const hasYou = line.inView.some(x => x.event.side === 'you')
  const hasAgent = line.inView.some(x => x.event.side === 'agent')
  const legend =
    hasYou || hasAgent
      ? row(kit, [
          hasYou ? sticker(kit, 'you', '1') : null,
          hasYou ? cells(kit, ` ${copy.yours}  `) : null,
          hasAgent ? sticker(kit, 'agent', 'A') : null,
          hasAgent ? cells(kit, ` ${agentName(agent.agent)}'s`) : null,
        ])
      : null
  return section(kit, [
    heading,
    runs(kit, line.yours, `you-${v.index}`),
    cells(kit, line.rule, theme.rule),
    runs(kit, line.agent, `agent-${v.index}`),
    dim(kit, line.dates, { wrap: 'truncate-end' }),
    cells(kit, line.kRow),
    dim(kit, line.nRow, { wrap: 'truncate-end' }),
    legend === null ? null : box(kit, { marginTop: 1 }, [legend]),
    shown.length === 0
      ? null
      : column(kit, [
          hidden > 0 ? dim(kit, copy.earlier(hidden)) : null,
          ...shown.map(({ event, mark }, i) => eventRow(v, event, mark, `ev-${v.index}-${i}`, marked)),
          shown.some(x => x.event.strength === 'routine') ? dim(kit, copy.routineNote) : null,
        ], { marginTop: 1 }),
  ])
}

/** "Next to unlock": what an unqualified comparison is still missing, and never a date (D66). */
function progressLines(v: View): Child[] {
  const { kit, agent } = v
  const p = agent.progress
  if (p === null || agent.state !== 'insufficient' || agent.reason === 'calibration_pending') return []
  const waiting = p.unlock
    .map((u: GlanceUnlock) => {
      const parts: string[] = []
      const gap = (have: number | null, need: number | null, noun: string) => {
        if (have !== null && need !== null && need > have) parts.push(`${count(have)} of ${count(need)} ${noun}`)
      }
      gap(u.have.events, u.need.events, eventNoun(u.metric))
      gap(u.have.sessions, u.need.sessions, 'sessions')
      gap(u.have.sessionDays, u.need.sessionDays, 'session-days')
      return { u, name: metricName(agent, u.metric), parts }
    })
    .filter(x => x.parts.length > 0)
  const first = waiting[0]
  if (first === undefined) return []
  const others = waiting.slice(1).map(x => x.name)
  const then = others.length > 0 ? `, then ${others.join(' and ')}` : ''
  // The bar and its count are the one binding pair (bindingGate), never the events pair when another unit is short.
  const g = bindingGate(first.u)
  // The name already says what is counted when the indicator counts its own events ("Edits without reading first:
  // 7 of 10"); otherwise the noun says it ("Reads per edit: 31 of 40 edits", "Tool errors: 7 of 10 session-days").
  const unit = g === null || g.noun.toLowerCase() === first.name.toLowerCase() ? '' : ` ${g.noun}`
  const bar =
    g !== null
      ? row(kit, [cells(kit, `${first.name}: ${count(g.have)} of ${count(g.need)}${unit} `), cells(kit, progressBar(g.have, g.need))], { key: `bar-${v.index}` })
      : null
  return [
    text(kit, `${copy.nextToUnlock} ${first.name} (${first.parts.join(', ')})${then}.`),
    bar,
    dim(kit, copy.noDate),
  ]
}

function finding(v: View): RenderElement {
  const { kit, agent } = v
  const party = partyOf(agent.state)
  const label = labelOf(agent)
  return section(kit, [
    row(kit, [
      strong(kit, copy.finding, { wrap: 'truncate-end' }),
      cells(kit, `  ${theme.glyph(agent.state)} `),
      party === null ? strong(kit, label, { wrap: 'truncate-end' }) : cells(kit, ` ${label} `, theme.sticker[party]),
    ]),
    agent.pending ? text(kit, copy.confirming) : null,
    agent.headline === '' ? null : text(kit, agent.headline),
    agent.because === '' ? null : dim(kit, agent.because),
    ...progressLines(v),
  ])
}

function signals(v: View): RenderElement | null {
  const { kit, agent } = v
  const metrics = agent.metrics.filter(m => m.recent !== null || m.baseline !== null).slice(0, 8)
  if (metrics.length === 0) return null
  return section(kit, [
    strong(kit, copy.signals),
    ...metrics.map((m, i) => {
      const kn = (x: GlanceMetric['recent']) => (x === null ? '–' : `${count(x.k)}/${count(x.n)}`)
      const facts = [`${kn(m.recent)} ${copy.vs} ${kn(m.baseline)}`]
      const eligible = m.status !== 'ineligible' && m.status !== null
      if (eligible && m.ratio !== null) {
        facts.push(m.range === null ? ratio2(m.ratio) : `${ratio2(m.ratio)}, ${copy.range} ${rangeText(m.range[0], m.range[1])}`)
        if (m.mde !== null) facts.push(copy.wontShow(mdeText(m.mde)))
      } else {
        const g = bindingGate(agent.progress?.unlock.find(x => x.metric === m.id))
        if (g !== null) facts.push(`${count(g.have)} of ${count(g.need)} ${g.noun} needed`)
      }
      return column(
        kit,
        [
          row(kit, [text(kit, m.label === '' ? metricName(agent, m.id) : m.label), spacer(kit), dim(kit, ` ${statusWord(m)}`, { wrap: 'truncate-end' })]),
          box(kit, { paddingLeft: layout.indent.length }, [dim(kit, facts.join(layout.separator))]),
        ],
        { key: `m-${v.index}-${i}` },
      )
    }),
  ])
}

function nextBlock(v: View): RenderElement | null {
  const { kit, agent } = v
  const lines: Child[] = [
    agent.tryThis === '' ? null : text(kit, `${copy.next}: ${agent.tryThis}`),
    agent.confidence === '' ? null : dim(kit, agent.confidence),
  ]
  return lines.every(l => l === null) ? null : section(kit, lines)
}

function agentBlock(v: View): RenderElement {
  const { kit, glance } = v
  // The engine decides the order (D28); anything but an explicit verdict lead is timeline-led (D61's default).
  const body =
    glance.lead === 'verdict'
      ? [finding(v), signals(v), whatChanged(v), nextBlock(v)]
      : [whatChanged(v), finding(v), signals(v), nextBlock(v)]
  return column(kit, [v.showName ? strong(kit, agentName(v.agent.agent)) : null, ...body], {
    key: `agent-${v.index}`,
    marginTop: v.index === 0 ? 0 : 1,
  })
}

// ---- the pane ---------------------------------------------------------------

export type PaneActions = { onRefresh: () => void; onClose: () => void }

export type PaneContext = { actions: PaneActions; columns?: number }

/** Buttons first, so an 80-column inline pane never clips them; the wordmark at the right. */
function topBar(kit: Kit, actions: PaneActions | null): RenderElement {
  return row(kit, [
    actions === null
      ? null
      : box(kit, { flexDirection: 'row', gap: 1, flexShrink: 0 }, [
          h(kit.Button, { key: 'refresh', label: theme.button.refresh, hotkey: 'r', onPress: actions.onRefresh }) as RenderElement,
          h(kit.Button, { key: 'close', label: theme.button.close, role: 'dismiss', onPress: actions.onClose }) as RenderElement,
        ]),
    spacer(kit),
    box(kit, { flexDirection: 'row', flexShrink: 0 }, [cells(kit, 'wasit'), cells(kit, 'me', { underline: true })]),
  ])
}

function noticeBlock(kit: Kit, notice: Notice): RenderElement {
  return section(kit, [
    strong(kit, notice.glyph === '' ? notice.title : `${notice.glyph} ${notice.title}`),
    ...notice.extra.map(line => text(kit, line)),
    notice.help === '' ? null : text(kit, notice.help),
  ])
}

/** What an out-of-date or failed scan last said, one line per agent: history, never presented as current. */
function lastKnown(kit: Kit, display: Display): RenderElement | null {
  if (display.kind !== 'stale' && display.kind !== 'scan-failed') return null
  const agents = orderedAgents(display.glance)
  if (agents.length === 0) return null
  return section(kit, [
    dim(kit, copy.lastKnown),
    ...agents.map((agent, i) => dim(kit, `${theme.glyph(agent.state)} ${agentName(agent.agent)}: ${labelOf(agent)}`, { key: `last-${i}` })),
  ])
}

function footer(kit: Kit, display: Display): RenderElement {
  const age = display.kind === 'ready' || display.kind === 'empty' ? `${copy.updated} ${formatAge(display.ageMs)}${layout.separator}` : ''
  return section(kit, [dim(kit, `${age}${copy.privacy}`)])
}

/** The wasitme pane body for any display. */
export function renderPane(kit: Kit, display: Display, context: PaneContext): RenderElement {
  const columns = context.columns ?? layout.columns
  const notice = noticeOf(display)
  if (notice !== null) {
    return column(kit, [
      topBar(kit, display.kind === 'loading' ? null : context.actions),
      noticeBlock(kit, notice),
      lastKnown(kit, display),
      footer(kit, display),
    ])
  }
  if (display.kind !== 'ready') return column(kit, [])

  const glance = display.glance
  const agents = orderedAgents(glance)
  const slots = daySlots(columns)
  const day = today(glance)
  return column(kit, [
    topBar(kit, context.actions),
    glance.demo ? box(kit, { marginTop: 1 }, [strong(kit, copy.demo)]) : null,
    ...agents.map((agent, index) =>
      agentBlock({ kit, glance, agent, index, showName: agents.length > 1, slots, today: day }),
    ),
    footer(kit, display),
  ])
}

// ---- the band -------------------------------------------------------------

export type BandActions = { onHide: () => void }

export type BandContext = { columns: number; actions: BandActions }

/**
 * The quiet one-line band: only for a fresh scan whose finding is "your side" or
 * "agent side" AND for which the engine wrote a band line (the engine decides
 * band eligibility; the state check is a second lock). Everything else (too
 * early, no detectable change, can't tell which, out of date, errors) returns
 * null and draws nothing.
 */
export function renderBand(kit: Kit, display: Display, context: BandContext): RenderElement | null {
  if (display.kind !== 'ready') return null
  const agent = attentionAgent(display.glance)
  if (agent === null) return null

  const who = context.columns < layout.bandCompactBelow ? '' : `${agentName(agent.agent)}: `
  return box(kit, {}, [
    box(kit, { flexShrink: 1, flexGrow: 1 }, [
      text(kit, `${theme.glyph(agent.state)} ${copy.bandTag}${layout.separator}${who}${agent.band} `, {
        ...theme.emphasis,
        wrap: 'truncate-end',
      }),
    ]),
    box(kit, { flexShrink: 0 }, [dim(kit, `${copy.bandHint} `, { wrap: 'truncate-end' })]),
    h(kit.Button, { key: 'hide', label: theme.button.hide, onPress: context.actions.onHide }) as RenderElement,
  ])
}
