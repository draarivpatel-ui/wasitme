// The mod through the engine: hooks, state, drawing on the terminal and the
// desktop, timers, buttons. Everything beneath the mod (files, command
// registration, panes) is answered by this file's own hooks, so nothing touches
// a real disk; run with `claude plugin test plugin`.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { FIXTURES } from './fixtures/fixtures'
import type { FixtureName } from './fixtures/fixtures'
import { hasUnsafe } from './unsafe'

// The manifest's clock: thirty minutes after the fresh shared goldens were written.
const NOW = Date.parse('2026-10-04T18:30:00Z')

// The shared contract goldens (contract/fixtures/) this file draws.
const YOU = 'glance/you-verdict'
const NONE = 'glance/none-verdict'
const AGENT = 'glance/agent-verdict'
const TWO = 'glance/calibration_pending'
const MISMATCH = 'tamper/glance-schema-mismatch'
const HOSTILE = 'glance/hostile-labels'
const PATH = '/fake/home/.wasitme/glance.json'
const OPTS = { options: { glancePath: PATH, showBand: true } }
const SURFACES = ['terminal', 'desktop'] as const
const WIDTHS = [72, 40]

const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }

const PANE_PROPS = {
  title: 'wasitme',
  isFocused: false,
  bodyColumns: 72,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

type File = { text: string; mtimeMs: number; size?: number }

/** What happened beneath the mod, and the files it can see. */
type Seen = {
  files: Map<string, File>
  reads: string[]
  stats: string[]
  registered: string[]
  opened: string[]
  closed: string[]
  forbidden: string[]
  failNextReads: number
}

function seenWith(name: FixtureName | null, mtimeMs = 1000): Seen {
  const files = new Map<string, File>()
  if (name !== null) files.set(PATH, { text: FIXTURES[name], mtimeMs })
  return { files, reads: [], stats: [], registered: [], opened: [], closed: [], forbidden: [], failNextReads: 0 }
}

/** The world beneath the mod. Returns the mocked clock. */
function world(on: On, seen: Seen, now = NOW) {
  const clock = mock.clock(on, { now })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('fs.stat', (_$, e) => {
    seen.stats.push(e.path)
    const file = seen.files.get(e.path)
    if (file === undefined) return { deny: 'ENOENT: no such file or directory' }
    return { value: { kind: 'file' as const, size: file.size ?? file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    const file = seen.files.get(e.path)
    if (file === undefined) return { deny: 'ENOENT: no such file or directory' }
    if (seen.failNextReads > 0) {
      seen.failNextReads -= 1
      return { deny: 'EIO: i/o error' }
    }
    return { value: file.text }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  // The mod's calls are frozen to a short list; none of these may ever be reached.
  on('process.run', () => {
    seen.forbidden.push('process.run')
    return { deny: 'wasitme may not run processes' }
  })
  on('http.fetch', () => {
    seen.forbidden.push('http.fetch')
    return { deny: 'wasitme may not use the network' }
  })
  on('env.get', () => {
    seen.forbidden.push('env.get')
    return { deny: 'wasitme may not read the environment' }
  })
  on('fs.write', () => {
    seen.forbidden.push('fs.write')
    return { deny: 'wasitme may not write files' }
  })
  // What the engine draws above the prompt when the mod stays quiet.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return clock
}

async function mountPane($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 72) {
  return $.ui.mount({
    plugin: 'wasitme',
    surface,
    component: 'Pane',
    requestId: 'wasitme',
    props: { ...PANE_PROPS, bodyColumns },
  })
}

async function mountBand($: Engine, surface: (typeof SURFACES)[number], props: Partial<typeof BAND_PROPS> = {}) {
  return $.ui.mount({ plugin: 'wasitme', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, ...props } })
}

/** Every string a drawing shows. */
async function shown(ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

/** The glance fixture re-dated, as text. */
function generatedAt(name: FixtureName, iso: string): string {
  const raw = JSON.parse(FIXTURES[name]) as { generatedAt: string }
  raw.generatedAt = iso
  return JSON.stringify(raw)
}

describe('session start', () => {
  test('registers /wasitme and makes the first read of the glance file, nothing else', OPTS, async ($, on) => {
    const seen = seenWith(YOU)
    world(on, seen)
    await $.session.start(START)
    expect(seen.registered).toEqual(['wasitme'])
    expect(seen.stats).toEqual([PATH])
    expect(seen.reads).toEqual([PATH])
    expect(seen.opened).toEqual([])
    expect(seen.forbidden).toEqual([])
  })

  test('a missing glance file does not stop the command from registering', OPTS, async ($, on) => {
    const seen = seenWith(null)
    world(on, seen)
    await $.session.start(START)
    expect(seen.registered).toEqual(['wasitme'])
    expect(seen.reads).toEqual([])
  })
})

describe('/wasitme', () => {
  test('opens the pane and answers in one short line', OPTS, async ($, on) => {
    const seen = seenWith(YOU)
    world(on, seen)
    const out = await $.command.run({ ...RUN, command: 'wasitme', args: '' })
    expect(seen.opened).toEqual(['wasitme'])
    expect(out.text).toBe('wasitme pane opened. Claude Code: Your side. Your numbers moved around the time of your effort change (Sep 21).')
    expect(out.text).not.toContain('\n')
  })

  test('says what is wrong when there is nothing to show', OPTS, async ($, on) => {
    const seen = seenWith(null)
    world(on, seen)
    const out = await $.command.run({ ...RUN, command: 'wasitme', args: '' })
    expect(out.text).toBe('wasitme pane opened. No wasitme scan on this Mac yet.')
  })

  test('re-reads the file each time it is run', OPTS, async ($, on) => {
    const seen = seenWith(NONE)
    world(on, seen)
    await $.command.run({ ...RUN, command: 'wasitme', args: '' })
    seen.files.set(PATH, { text: FIXTURES[AGENT], mtimeMs: 1000 })
    const out = await $.command.run({ ...RUN, command: 'wasitme', args: '' })
    expect(seen.reads).toEqual([PATH, PATH])
    expect(out.text).toContain('Nothing recorded changed on your side; Claude Code served another model.')
  })
})

describe('the pane draws every state on every surface, wide and narrow', () => {
  const CASES: [string, FixtureName, RegExp[]][] = [
    [
      'insufficient, verdict-led: the finding, what is still missing (no date, D66), the signals, then what changed',
      'glance/insufficient-verdict',
      [
        /^Finding$/,
        /^ {2}·┄· $/,
        /^Too early to tell$/,
        /^wasitme can already rule out changes bigger than about ×2\.5 in tool errors\.$/,
        /^Only tool errors have enough data so far; reads per edit and edits without reading first need a few more sessions\.$/,
        /^Next to unlock: Reads per edit \(31 of 40 edits, 4 of 5 sessions, 9 of 10 session-days\), then Edits without reading first\.$/,
        /^Reads per edit: 31 of 40 edits $/,
        /^████████░░$/,
        /^No date yet: it depends on how your sessions go\.$/,
        /^Signals$/,
        /^Tool errors$/,
        /^88\/3,290 vs 201\/5,610 · ×0\.75, range ×0\.42–×1\.33 · under ×2\.5 won't show$/,
        /^ not detected$/,
        /^402\/96 vs 1,130\/233 · 31 of 40 edits needed$/,
        /^ not yet$/,
        /^ context$/,
        /^What changed$/,
        /^errors /,
        /^calls /,
        /^Oct 1 {2}Claude Code 2\.1\.277 → 2\.1\.281$/,
        /^agent side · routine update$/,
        /^Sep 27 {2}MCP server added$/,
        /^your side$/,
        /^Routine updates alone aren't evidence\.$/,
        /^Next: Keep working normally; wasitme checks every 15 minutes\.$/,
        /^Based on 214 exchanges over 19 session-days \(6 sessions\) on this Mac\. Sessions on other machines aren't visible\.$/,
        /^updated 30m ago · local only$/,
      ],
    ],
    [
      'insufficient, timeline-led: what changed comes first',
      'glance/insufficient-timeline',
      [/^What changed$/, /^Finding$/, /^Too early to tell$/, /^No date yet: it depends on how your sessions go\.$/],
    ],
    [
      'none: no detectable change, in the engine words',
      'glance/none-verdict',
      [/^ {2}─── $/, /^No detectable change$/, /^Changes bigger than about ×1\.9 in 3 indicators would have shown\.$/, /^ not detected$/, /updated 30m ago/],
    ],
    [
      'you: the finding on a canary sticker, its evidence, what to try, and the changes on the case line',
      'glance/you-verdict',
      [
        /^ {2}■── $/,
        /^ Your side $/,
        /^Your numbers moved around the time of your effort change \(Sep 21\)\.$/,
        /^Next: To check, set effort back to high\.$/,
        /^Sep 21 {2}Effort high → medium$/,
        /^Sep 27 {2}MCP server added$/,
        /^ moved, more$/,
        /^ moved, fewer$/,
        /^ 1 $/,
        /^ yours {2}$/,
        /^ Claude Code's$/,
      ],
    ],
    [
      'agent: the finding on a blue sticker, on the agent side',
      'glance/agent-verdict',
      [
        /^ {2}──▲ $/,
        /^ Agent side $/,
        /^Nothing recorded changed on your side; Claude Code served another model\.$/,
        /^Sep 30 {2}Served model differs from the one you picked$/,
        /^your side · new$/,
        /Some days weren't fully observed\./,
      ],
    ],
    [
      'unclear: a peer state, not a failure',
      'glance/unclear-verdict',
      [/^ {2}■─▲ $/, /^Can't tell which$/, /^Your numbers moved, but changes on both sides landed the same week\.$/, /^your side · new$/],
    ],
    [
      'unknown provenance: an unknown-side change says so, and is never given the agent\'s letter',
      'glance/unclear-unknown_provenance',
      [/^Can't tell which$/, /^Sep 22 {2}Model opus-5 → opus-5-5 \(no command recorded\)$/, /^origin unknown$/],
    ],
    ['pending: the held state, marked as confirming', 'glance/pending', [/^No detectable change$/, /^Possible shift — confirming$/]],
    ['demo: a ribbon says it is not the person\'s data', 'glance/demo', [/^DEMO DATA: not from your logs$/, /^Too early to tell$/]],
    [
      'two agents: engine order, each named, Codex timeline-only with its changes as a list',
      TWO,
      [
        /^Claude Code$/,
        /^Codex$/,
        /^ Your side $/,
        /^Timeline only$/,
        /^Findings for Codex are off until wasitme's tests pass for Codex logs\.$/,
        /^ {2}the last 30 days$/,
        /^Sep 29 {2}Codex 0\.158 → 0\.160$/,
        /^agent side · routine update · new$/,
        /^Sep 25 {2}AGENTS\.md changed$/,
      ],
    ],
    [
      'empty: a scan that found no sessions',
      'glance/empty',
      [/^No Claude Code or Codex logs found in ~\/\.claude or ~\/\.codex$/, /^Different place\? ~\/\.local\/bin\/wasitme doctor$/, /^updated 30m ago · local only$/],
    ],
    [
      'scan-failed: the engine says which kind of failure',
      'glance/scan-failed',
      [/^The last scan failed$/, /^wasitme was not allowed to read a session folder\.$/, /^Run ~\/\.local\/bin\/wasitme doctor to see why\.$/],
    ],
    [
      'schema-mismatch: says the parts are out of sync, names the version it found, draws none of it',
      MISMATCH,
      [/^wasitme parts are out of sync$/, /^Found: wasitme\.glance\/2$/, /^Run ~\/\.local\/bin\/wasitme update, then \/reload-plugins\.$/],
    ],
    [
      'contains-text: a file that does not promise it holds no text is refused',
      'tamper/glance-contains-text',
      [/The last scan is not in the shape this plugin expects/],
    ],
    [
      'stale: out of date under the struck rule, with the last result shown as history',
      'glance/stale',
      [/^─╱─ Out of date$/, /^Last scan 9h ago\.$/, /^Run ~\/\.local\/bin\/wasitme scan to refresh it\.$/, /^Last result:$/, /^■── Claude Code: Your side$/],
    ],
    [
      'future-dated: a clock that went backward is not trusted',
      'glance/stale-future-dated',
      [/The last scan has a timestamp from the future/, /Check the clock/],
    ],
  ]

  for (const [label, fixture, expected] of CASES) {
    test(label, OPTS, async ($, on) => {
      const seen = seenWith(fixture)
      world(on, seen)
      await $.session.start(START)
      for (const surface of SURFACES) {
        for (const width of WIDTHS) {
          const ui = await mountPane($, surface, width)
          for (const pattern of expected) {
            const found = await ui.find({ type: 'Text', text: pattern })
            if (found === undefined) throw new Error(`${surface} ${width} cols: no Text matches ${pattern}\n${(await shown(ui)).join('\n')}`)
          }
          // Nothing half-formatted, and no date projected (D66), ever reaches the screen.
          for (const text of await shown(ui)) {
            expect(text).not.toMatch(/NaN|undefined|null|\[object|Infinity|-\d+[mhd] ago|×\?/)
            expect(text).not.toMatch(/2026-10-10|Oct 10|Enough data around|at your pace|current pace/)
            expect(hasUnsafe(text)).toBe(false)
          }
          // Buttons first: the first Button comes before any finding text.
          expect(await ui.find({ key: 'refresh' })).toBeDefined()
          expect(await ui.find({ key: 'close' })).toBeDefined()
          await ui.unmount()
        }
      }
      expect(seen.forbidden).toEqual([])
    })
  }

  for (const [fixture, first] of [
    ['glance/insufficient-timeline', 'What changed'],
    ['glance/insufficient-verdict', 'Finding'],
  ] as const) {
    test(`the lead decides the order: ${fixture} opens on ${first}`, OPTS, async ($, on) => {
      world(on, seenWith(fixture))
      await $.session.start(START)
      const ui = await mountPane($, 'terminal', 64)
      const texts = await shown(ui)
      const what = texts.indexOf('What changed')
      const finding = texts.indexOf('Finding')
      expect(what).toBeGreaterThan(-1)
      expect(finding).toBeGreaterThan(-1)
      expect(first === 'What changed' ? what < finding : finding < what).toBe(true)
      await ui.unmount()
    })
  }

  /** The insufficient golden with its unlock list replaced (what an engine run with this shortfall writes). */
  function withUnlock(unlock: unknown[]): string {
    const raw = JSON.parse(FIXTURES['glance/insufficient-verdict']) as { agents: { progress: { unlock: unknown[] } }[] }
    raw.agents[0].progress.unlock = unlock
    return JSON.stringify(raw)
  }
  const rpe = (have: object, need: object) => ({ metric: 'readsPerEdit', family: 'research', have, need })

  test('Next to unlock shows the binding gate in its own unit, never a met count against another target', OPTS, async ($, on) => {
    // Thousands of events, too few session-days: 3,150 of 10 is met; 7 of 10 session-days is what keeps it locked.
    const seen = seenWith(null)
    seen.files.set(PATH, { text: withUnlock([rpe({ events: 3150, sessions: 7, sessionDays: 7 }, { events: 10, sessions: 5, sessionDays: 10 })]), mtimeMs: 1000 })
    world(on, seen)
    await $.session.start(START)
    const ui = await mountPane($, 'terminal', 72)
    const texts = await shown(ui)
    expect(texts).toContain('Next to unlock: Reads per edit (7 of 10 session-days).')
    expect(texts).toContain('Reads per edit: 7 of 10 session-days ')
    expect(texts).toContain('███████░░░')
    expect(texts).toContain('402/96 vs 1,130/233 · 7 of 10 session-days needed')
    for (const text of texts) expect(text).not.toMatch(/3,150|of 10 edits/)
    await ui.unmount()
  })

  test('with every pair met (one session dominating) there is no count and no bar', OPTS, async ($, on) => {
    const seen = seenWith(null)
    seen.files.set(PATH, { text: withUnlock([rpe({ events: 2100, sessions: 43, sessionDays: 56 }, { events: 40, sessions: 5, sessionDays: 10 })]), mtimeMs: 1000 })
    world(on, seen)
    await $.session.start(START)
    const ui = await mountPane($, 'terminal', 72)
    const texts = await shown(ui)
    for (const text of texts) {
      expect(text).not.toMatch(/\d of \d/)
      expect(text).not.toMatch(/[█░]{10}/)
    }
    await ui.unmount()
  })

  test('the case line at 64 columns is the mock-up\'s: 14 days, stickers above and below one rule', OPTS, async ($, on) => {
    world(on, seenWith(YOU))
    await $.session.start(START)
    const ui = await mountPane($, 'terminal', 64)
    const texts = await shown(ui)
    const rule = texts.find(t => t.startsWith('        ┄'))
    expect(rule).toBeDefined()
    expect(Array.from(rule ?? '').length).toBe(64)
    expect(rule).toContain('┴')
    expect(rule).toContain('┬')
    const you = await ui.find({ type: 'Text', text: /^ 1 $/ })
    expect(you?.props.backgroundColor).toBe('#F2C230')
    const agent = await ui.find({ type: 'Text', text: /^ A $/ })
    expect(agent?.props.backgroundColor).toBe('#8CC4F2')
    for (const text of texts) expect(Array.from(text).length).toBeLessThanOrEqual(400)
    await ui.unmount()
  })
})

describe('notices and hostile files', () => {
  test('a missing file says there is no scan yet and what to run', OPTS, async ($, on) => {
    world(on, seenWith(null))
    await $.session.start(START)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: /^No wasitme scan on this Mac yet$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Installed\? Run ~\/\.local\/bin\/wasitme scan\. Not installed\? One-off check: \/wasitme:report\.$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('without a glancePath, a plugin loaded outside a marketplace install says how to point it at the file', { options: {} }, async ($, on) => {
    const seen = seenWith(YOU)
    world(on, seen)
    await $.session.start(START)
    expect(seen.reads).toEqual([])
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Cannot find the wasitme data file/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Set "Glance file"/ })).toBeDefined()
    await ui.unmount()
  })

  test('a stale glance does not present the old verdict as current', OPTS, async ($, on) => {
    world(on, seenWith('glance/stale'))
    await $.session.start(START)
    const ui = await mountPane($, 'terminal')
    const bold = await ui.findAll({ type: 'Text', text: /./ })
    const headlines = bold.filter(t => t.props.bold === true)
    expect(headlines.map(t => t.text)).toEqual(['─╱─ Out of date'])
    const history = await ui.find({ type: 'Text', text: /Claude Code: Your side/ })
    expect(history?.props.dimColor).toBe(true)
    await ui.unmount()
  })

  test('an oversized or empty file is unreadable and is not read', OPTS, async ($, on) => {
    const seen = seenWith(YOU)
    seen.files.set(PATH, { text: FIXTURES[YOU], mtimeMs: 1, size: 5 * 1024 * 1024 })
    world(on, seen)
    await $.session.start(START)
    expect(seen.reads).toEqual([])
    let ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Could not read the last scan/ })).toBeDefined()
    await ui.unmount()

    seen.files.set(PATH, { text: '', mtimeMs: 2 })
    await $.command.run({ ...RUN, command: 'wasitme', args: '' })
    expect(seen.reads).toEqual([])
    ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Could not read the last scan/ })).toBeDefined()
    await ui.unmount()
  })

  test('a hostile file draws, and nothing it holds can reach a terminal', OPTS, async ($, on) => {
    world(on, seenWith(HOSTILE))
    await $.session.start(START)
    for (const surface of SURFACES) {
      for (const width of WIDTHS) {
        const ui = await mountPane($, surface, width)
        const texts = await shown(ui)
        expect(texts.length).toBeGreaterThan(3)
        for (const text of texts) expect(hasUnsafe(text)).toBe(false)
        expect(await ui.find({ type: 'Text', text: /Ignore previous instructions/ })).toBeDefined()
        await ui.unmount()
      }
    }
  })
})

describe('buttons', () => {
  test('Refresh reads the file again and the open pane redraws', OPTS, async ($, on) => {
    const seen = seenWith(NONE)
    world(on, seen)
    await $.session.start(START)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /No detectable change/ })).toBeDefined()

    seen.files.set(PATH, { text: FIXTURES[YOU], mtimeMs: 1000 })
    await ui.press({ key: 'refresh' })
    expect(seen.reads).toEqual([PATH, PATH])
    expect(await ui.find({ type: 'Text', text: /^ Your side $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No detectable change/ })).toBeUndefined()
    await ui.unmount()
  })

  test('Close closes the pane', OPTS, async ($, on) => {
    const seen = seenWith(NONE)
    world(on, seen)
    await $.session.start(START)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'close' })
    expect(seen.closed).toEqual(['wasitme'])
    await ui.unmount()
  })
})

describe('refreshing once a minute', () => {
  test('an unchanged file is not read again, but the age keeps moving', OPTS, async ($, on) => {
    const seen = seenWith(NONE)
    const clock = world(on, seen)
    await $.session.start(START)
    expect(seen.reads).toHaveLength(1)

    await clock.advance(60_000)
    await clock.advance(60_000)
    expect(seen.stats).toHaveLength(3)
    expect(seen.reads).toHaveLength(1)

    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /updated 32m ago/ })).toBeDefined()
    await ui.unmount()
  })

  test('a changed file is picked up on the next minute without any command', OPTS, async ($, on) => {
    const seen = seenWith(NONE, 1000)
    const clock = world(on, seen)
    await $.session.start(START)

    seen.files.set(PATH, { text: FIXTURES[AGENT], mtimeMs: 2000 })
    await clock.advance(59_000)
    expect(seen.reads).toHaveLength(1)
    await clock.advance(1_000)
    expect(seen.reads).toHaveLength(2)

    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /^ Agent side $/ })).toBeDefined()
    await ui.unmount()
  })

  test('a file that appears after a "no scan yet" start is found', OPTS, async ($, on) => {
    const seen = seenWith(null)
    const clock = world(on, seen)
    await $.session.start(START)
    seen.files.set(PATH, { text: FIXTURES[YOU], mtimeMs: 5 })
    await clock.advance(60_000)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /^ Your side $/ })).toBeDefined()
    await ui.unmount()
  })

  test('a fresh scan turns stale as the clock moves, with no new read', OPTS, async ($, on) => {
    const seen = seenWith(null)
    seen.files.set(PATH, { text: generatedAt(NONE, new Date(NOW - 1.5 * 3_600_000).toISOString()), mtimeMs: 1 })
    const clock = world(on, seen)
    await $.session.start(START)
    let ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /No detectable change/ })).toBeDefined()
    await ui.unmount()

    await clock.advance(3_600_000)
    expect(seen.reads).toHaveLength(1)
    ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Out of date/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Last scan 2h ago\./ })).toBeDefined()
    await ui.unmount()
  })

  test('a read error is retried next minute; a bad file is not re-read until it changes', OPTS, async ($, on) => {
    const seen = seenWith(YOU)
    seen.failNextReads = 1
    const clock = world(on, seen)
    await $.session.start(START)
    let ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Could not read the last scan/ })).toBeDefined()
    await ui.unmount()

    await clock.advance(60_000)
    expect(seen.reads).toHaveLength(2)
    ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /^ Your side $/ })).toBeDefined()
    await ui.unmount()

    seen.files.set(PATH, { text: FIXTURES[MISMATCH], mtimeMs: 9 })
    await clock.advance(60_000)
    expect(seen.reads).toHaveLength(3)
    await clock.advance(60_000)
    await clock.advance(60_000)
    expect(seen.reads).toHaveLength(3)
  })

  test('a clock that went backward shows a notice, never a negative age', OPTS, async ($, on) => {
    const seen = seenWith(YOU)
    world(on, seen, Date.parse('2026-10-04T17:00:00Z'))
    await $.session.start(START)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /timestamp from the future/ })).toBeDefined()
    for (const text of await shown(ui)) expect(text).not.toMatch(/-\d/)
    await ui.unmount()
    const band = await mountBand($, 'terminal')
    expect(await band.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    await band.unmount()
  })
})

describe('the quiet band', () => {
  for (const [fixture, pattern] of [
    [YOU, /■── wasitme · Claude Code: Your side: your numbers moved around your effort change \(Sep 21\)\./],
    [AGENT, /──▲ wasitme · Claude Code: Agent side: Claude Code served a different model than you picked \(Sep 30\)\./],
    ['glance/agent-by_elimination', /──▲ wasitme · Claude Code: Agent side: tool errors rose at the Claude Code 2\.1\.281 update/],
    [TWO, /■── wasitme · Claude Code: Your side/],
  ] as const) {
    test(`speaks up for ${fixture}`, OPTS, async ($, on) => {
      world(on, seenWith(fixture))
      await $.session.start(START)
      for (const surface of SURFACES) {
        const ui = await mountBand($, surface)
        expect(await ui.find({ type: 'Text', text: pattern })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /\/wasitme/ })).toBeDefined()
        expect(await ui.find({ key: 'hide' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeUndefined()
        await ui.unmount()
      }
    })
  }

  for (const fixture of [
    'glance/insufficient-verdict',
    'glance/insufficient-single_indicator',
    NONE,
    'glance/pending',
    'glance/unclear-verdict',
    'glance/unclear-nothing_recorded_on_your_side',
    'glance/stale',
    'glance/empty',
    'glance/scan-failed',
    MISMATCH,
  ] as const) {
    test(`stays quiet for ${fixture}`, OPTS, async ($, on) => {
      world(on, seenWith(fixture))
      await $.session.start(START)
      for (const surface of SURFACES) {
        const ui = await mountBand($, surface)
        expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
        expect(await ui.find({ key: 'hide' })).toBeUndefined()
        await ui.unmount()
      }
    })
  }

  test('a hostile file can still raise it, but only with bounded, printable text', OPTS, async ($, on) => {
    world(on, seenWith(HOSTILE))
    await $.session.start(START)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      expect(await ui.find({ type: 'Text', text: /■── wasitme · .*BAND/ })).toBeDefined()
      for (const text of await shown(ui)) expect(hasUnsafe(text)).toBe(false)
      await ui.unmount()
    }
  })

  test('stays quiet with no scan yet, or no way to find it', OPTS, async ($, on) => {
    world(on, seenWith(null))
    await $.session.start(START)
    const ui = await mountBand($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    await ui.unmount()
  })

  test('hiding it hands the band back to the engine', OPTS, async ($, on) => {
    world(on, seenWith(YOU))
    await $.session.start(START)
    const ui = await mountBand($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /wasitme ·/ })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /wasitme ·/ })).toBeUndefined()
    await ui.unmount()
  })

  test('yields to a survey', OPTS, async ($, on) => {
    world(on, seenWith(YOU))
    await $.session.start(START)
    const ui = await mountBand($, 'terminal', { hasSurvey: true })
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    await ui.unmount()
  })

  test('the showBand option turns it off', { options: { glancePath: PATH, showBand: false } }, async ($, on) => {
    world(on, seenWith(YOU))
    await $.session.start(START)
    const ui = await mountBand($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    await ui.unmount()
  })

  test('drops the agent name when the band is narrow', OPTS, async ($, on) => {
    world(on, seenWith(YOU))
    await $.session.start(START)
    const ui = await mountBand($, 'terminal', { bodyColumns: 50 })
    expect(await ui.find({ type: 'Text', text: /■── wasitme · Your side: your numbers moved/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude Code/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a scan that turns into an answer shows the band without a restart', OPTS, async ($, on) => {
    const seen = seenWith(NONE, 1)
    const clock = world(on, seen)
    await $.session.start(START)
    const ui = await mountBand($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    seen.files.set(PATH, { text: FIXTURES[AGENT], mtimeMs: 2 })
    await clock.advance(60_000)
    expect(await ui.find({ type: 'Text', text: /──▲ wasitme · Claude Code: Agent side: Claude Code served a different model/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('what the mod is allowed to do', () => {
  test('across start, command, pane, band, buttons and timers it never runs a process, fetches, reads the environment or writes', OPTS, async ($, on) => {
    const seen = seenWith(YOU)
    const clock = world(on, seen)
    await $.session.start(START)
    await $.command.run({ ...RUN, command: 'wasitme', args: '' })
    const pane = await mountPane($, 'terminal')
    await pane.press({ key: 'refresh' })
    await clock.advance(120_000)
    const band = await mountBand($, 'terminal')
    await band.press({ key: 'hide' })
    await pane.press({ key: 'close' })
    await pane.unmount()
    await band.unmount()
    expect(seen.forbidden).toEqual([])
    expect(new Set(seen.reads)).toEqual(new Set([PATH]))
    expect(new Set(seen.stats)).toEqual(new Set([PATH]))
  })
})
