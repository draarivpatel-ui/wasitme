// Every visual and wording choice of the wasitme mod, in one place, built from the
// design system (design/system, D57 "Case File"). The values come from
// design-tokens.ts, a byte-for-byte copy of design/system/generated/tokens.ts
// (tests/fixtures/sync.mjs --check holds the copy to the source); nothing here
// invents a colour or a glyph.
//
// The glyph grammar (D57): one rule. Your side is a square above it (■──), the
// agent a triangle below it (──▲), no detectable change the bare rule (───),
// can't tell which both shapes (■─▲), too early to tell a dashed rule with specks
// (·┄·), out of date the struck rule (─╱─). On the case line your changes are
// canary stickers numbered 1, 2, 3 above the rule and the agent's are blue
// stickers lettered A, B, C below it, so party is carried four ways: colour,
// shape, numeral vs letter, above vs below. No red, no green: `you` and `agent`
// are answers, not good or bad.
//
// The engine owns every finding word (label, headline, because, tryThis,
// confidence, band, event and metric labels). The words here are only what the
// engine cannot say: notices about the file itself, section names, the ledger's
// short status words (the CLI's), and fallbacks for an empty field.

import { modSticker, tokens } from './design-tokens'
import type { GlanceProblem, GlanceScanError, GlanceVerdict } from '../types'

export type Party = 'you' | 'agent'

// Which Claude Code theme is on is not visible to the mod: only `$.config.list`
// would say, and that call is outside the frozen allow-list (D25). So the
// stickers use one fixed fill + ink pair (the tokens' dark family). A sticker
// carries its own background and text colour, so it reads the same on a light
// or a dark theme; on a 16-colour terminal Claude Code maps the fill to the
// nearest palette colour (the risk DESIGN.md §5 records for the mod pane), and
// the numeral vs letter and above vs below still carry the party there. The
// Desktop Code tab's colours are assumed, not captured (D57).
const STICKER_THEME = 'dark'

const sticker: Record<Party, { color: string; backgroundColor: string }> = {
  you: modSticker('you', STICKER_THEME),
  agent: modSticker('agent', STICKER_THEME),
}

/** The three-cell text glyph of a state; `stale` is a display, not a state. */
function glyph(state: GlanceVerdict | 'stale'): string {
  return tokens.states[state].textGlyph
}

/** The design system's state label, used only when the engine's own label is empty. */
function label(state: GlanceVerdict | 'stale'): string {
  return tokens.states[state].label
}

/** What the person sees when there is no finding to draw. */
const problemCopy: Record<GlanceProblem, { title: string; help: string }> = {
  unlocated: {
    title: 'Cannot find the wasitme data file',
    help: 'Set "Glance file" in this plugin\'s options to the absolute path of glance.json, then run ~/.local/bin/wasitme scan.',
  },
  missing: {
    title: 'No wasitme scan on this Mac yet',
    help: 'Installed? Run ~/.local/bin/wasitme scan. Not installed? One-off check: /wasitme:report.',
  },
  unreadable: { title: 'Could not read the last scan', help: 'Run ~/.local/bin/wasitme scan to write it again.' },
  invalid: {
    title: 'The last scan is not in the shape this plugin expects',
    help: 'Run ~/.local/bin/wasitme scan to write it again.',
  },
  mismatch: {
    title: 'wasitme parts are out of sync',
    help: 'Run ~/.local/bin/wasitme update, then /reload-plugins.',
  },
}

/** The scan error kinds (the contract carries a kind, never text). */
const scanErrorCopy: Record<GlanceScanError, string> = {
  permission_denied: 'wasitme was not allowed to read a session folder.',
  write_failed: 'wasitme could not write its results.',
  timeout: 'The scan took too long and was stopped.',
  internal: 'Something went wrong inside the scan.',
}

export const theme = {
  glyph,
  label,
  sticker,

  /** Secondary text and rules: Claude Code's own dim (tokens modPane.secondary / modPane.rule). */
  secondary: tokens.modPane.secondary,
  rule: tokens.modPane.rule,
  emphasis: tokens.modPane.emphasis,

  /** The case line: a dashed rule, a tick up where your change sits, a tick down where the agent's does. */
  caseLine: { rule: '┄', you: '┴', agent: '┬', unknown: '?' },

  agentName: { 'claude-code': 'Claude Code', codex: 'Codex' } as Record<string, string>,

  /** Metric names when the glance carries an unlock row for a metric it lists no label for: the engine's labels
   *  (engine/src/words/names.ts), so an indicator has one name on every surface. */
  metricName: {
    toolErrors: 'Tool errors',
    toolErrorsNonCmd: 'Tool errors (excl. commands)',
    cmdFailures: 'Command failures',
    readsPerEdit: 'Reads per edit',
    blindEdits: 'Edits without reading first',
    interrupts: 'Interruptions',
    pushback: 'Pushback prompts',
    churn: 'Files edited 3+ times',
  } as Record<string, string>,

  /** What a metric's "events" are, for "31 of 40 edits" (the CLI's nouns). */
  eventNoun: {
    toolErrors: 'errors',
    toolErrorsNonCmd: 'errors',
    cmdFailures: 'failures',
    readsPerEdit: 'edits',
    blindEdits: 'edits without reading first',
    interrupts: 'interruptions',
    pushback: 'pushback prompts',
    churn: 'files edited 3+ times',
  } as Record<string, string>,

  /** Row labels under the case line (events, then opportunities), at most 6 cells, so a long name is shortened to what
   *  it counts ("unread" edits for edits without reading first, "3+" for files edited 3+ times). */
  stripRows: {
    toolErrors: ['errors', 'calls'],
    toolErrorsNonCmd: ['errors', 'calls'],
    cmdFailures: ['fails', 'cmds'],
    readsPerEdit: ['reads', 'edits'],
    blindEdits: ['unread', 'edits'],
    interrupts: ['stops', 'turns'],
    pushback: ['pushes', 'turns'],
    churn: ['3+', 'edits'],
  } as Record<string, readonly [string, string]>,
  stripRowsFallback: ['events', 'of'] as const,

  /** The ledger's short status words (the CLI's): never worse or better. */
  status: {
    context: 'context',
    notYet: 'not yet',
    more: 'moved, more',
    fewer: 'moved, fewer',
    notDetected: 'not detected',
  },

  bar: { full: '█', empty: '░', cells: 10 },

  copy: {
    problem: problemCopy,
    scanError: scanErrorCopy,
    loading: 'Reading the last scan…',
    scanFailed: { title: 'The last scan failed', help: 'Run ~/.local/bin/wasitme doctor to see why.' },
    staleOld: { title: 'Out of date', help: 'Run ~/.local/bin/wasitme scan to refresh it.' },
    staleClock: { title: 'The last scan has a timestamp from the future', help: 'Check the clock, then run ~/.local/bin/wasitme scan.' },
    staleUnknown: { title: 'Cannot tell how old the last scan is', help: 'Run ~/.local/bin/wasitme scan to refresh it.' },
    lastKnown: 'Last result:',
    empty: {
      title: 'No Claude Code or Codex logs found in ~/.claude or ~/.codex',
      help: 'Different place? ~/.local/bin/wasitme doctor',
    },
    demo: 'DEMO DATA: not from your logs',
    whatChanged: 'What changed',
    finding: 'Finding',
    signals: 'Signals',
    next: 'Next',
    lastDays: 'the last 30 days',
    noChanges: 'No changes recorded.',
    yours: 'yours',
    agentLane: 'agent',
    yourSide: 'your side',
    agentSide: 'agent side',
    unknownSide: 'origin unknown',
    routine: 'routine update',
    isNew: 'new',
    earlier: (n: number) => `${n} earlier ${n === 1 ? 'change' : 'changes'} not shown; /wasitme:report lists them all`,
    routineNote: "Routine updates alone aren't evidence.",
    confirming: 'Possible shift — confirming',
    nextToUnlock: 'Next to unlock:',
    noDate: 'No date yet: it depends on how your sessions go.',
    vs: 'vs',
    range: 'range',
    wontShow: (mde: string) => `under ${mde} won't show`,
    updated: 'updated',
    justNow: 'just now',
    unknownAge: 'at an unknown time',
    privacy: tokens.copy.privacyShort,
    bandTag: 'wasitme',
    bandHint: '/wasitme',
    commandOpened: 'wasitme pane opened.',
    commandWaiting: 'wasitme pane is waiting for a surface that can draw it.',
  },

  button: { refresh: 'Check again', close: 'Hide', hide: 'Hide' },

  layout: {
    /** The pane is drawn for about 64 columns (DESIGN.md §9) and shrinks to what it is given. */
    columns: 64,
    /** Label column of the case line and the rows under it. */
    laneLeft: 8,
    /** Cells per day on the case line. */
    pitch: 4,
    minDays: 4,
    maxDays: 21,
    /** At most this many changes are listed under the case line. */
    maxEvents: 8,
    /** The band drops its agent name below this many columns. */
    bandCompactBelow: 64,
    indent: '  ',
    separator: ' · ',
  },
}
