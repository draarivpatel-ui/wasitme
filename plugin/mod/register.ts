// wasitme mod: wiring only. It reads the glance file the wasitme CLI keeps
// fresh, keeps what it learned in $.state, and draws it through render.ts.
//
// What it does: registers a bare /wasitme command that opens a pane, draws that
// pane, and draws an optional quiet band above the prompt.
//
// What it may call on `$` (kept minimal; `claude plugin validate` prints the
// list as `calls:` and tests/check-calls.mjs holds it to an allow-list):
//   fs.stat, fs.read    the glance file only; never written
//   clock.now/every     staleness, and the once-a-minute cheap re-check
//   command.register    /wasitme
//   ui.open/close/resolve  the pane and the elements it draws with
//   state.get/set       (through atom/read/update) what the last refresh found
// Not used, on purpose: http.fetch, process.run, env.get, fs.write, tool.call
// or prompt.submit hooks. Every `$.noun.method` is spelled literally because the
// host reads them off this source.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GlanceLoad, GlanceSnapshot } from '../types'
import { MAX_GLANCE_BYTES, classify, parseGlance, resolveGlancePath } from './glance'
import { commandSummary, renderBand, renderPane } from './render'

const PANE = 'wasitme'
const REFRESH_MS = 60_000

const snapshot = atom({ plugin: 'wasitme', key: 'snapshot' } as const, null as GlanceSnapshot | null)
const isBandHidden = atom({ plugin: 'wasitme', key: 'isBandHidden' } as const, false)

function failed(problem: 'unlocated' | 'missing' | 'unreadable'): GlanceLoad {
  return { ok: false, problem, found: '' }
}

// A re-read of an unchanged file gives the same answer, except after a read
// error, which is worth retrying.
function isDeterministic(previous: GlanceSnapshot): boolean {
  return previous.load.ok || previous.load.problem === 'invalid' || previous.load.problem === 'mismatch'
}

// Top-level on purpose: the host follows `$` only into functions declared at
// the top of this file. Never throws on the file's account: whatever goes wrong
// becomes a `problem` for the drawing to explain, and the error text (which
// carries paths) is dropped.
async function refresh($: EngineInterface, glancePath: unknown, force: boolean): Promise<void> {
  const nowMs = await $.clock.now()
  const path = resolveGlancePath(glancePath, $.plugin.root)
  if (path === null) {
    await update($, snapshot, () => ({ load: failed('unlocated'), mtimeMs: null, size: null, nowMs }))
    return
  }

  let stat
  try {
    stat = await $.fs.stat(path)
  } catch (err) {
    const isMissing = /ENOENT|no such file/i.test(err instanceof Error ? err.message : String(err))
    await update($, snapshot, () => ({
      load: failed(isMissing ? 'missing' : 'unreadable'),
      mtimeMs: null,
      size: null,
      nowMs,
    }))
    return
  }

  if (stat.kind !== 'file' || stat.size === 0 || stat.size > MAX_GLANCE_BYTES) {
    await update($, snapshot, () => ({ load: failed('unreadable'), mtimeMs: stat.mtimeMs, size: stat.size, nowMs }))
    return
  }

  // Unchanged file: keep what was parsed, only move the clock (staleness and
  // "updated 6h ago" depend on it). The file is small; this saves a read a minute.
  const previous = await read($, snapshot)
  if (!force && previous !== null && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size && isDeterministic(previous)) {
    await update($, snapshot, () => ({ ...previous, nowMs }))
    return
  }

  let load: GlanceLoad
  try {
    load = parseGlance(await $.fs.read(path))
  } catch {
    load = failed('unreadable')
  }
  await update($, snapshot, () => ({ load, mtimeMs: stat.mtimeMs, size: stat.size, nowMs }))
}

export const register: Register = (on, options) => {
  const glancePath = options.glancePath
  const showBand = options.showBand !== false
  let isTicking = false

  on('session.start', async ($, e, next) => {
    // A failed registration must not take the band down with it.
    await $.command
      .register({
        name: 'wasitme',
        description: 'Was it me, or the agent? Open the wasitme pane',
        immediate: true,
      })
      .catch(() => undefined)

    await refresh($, glancePath, true).catch(() => undefined)
    if (!isTicking) {
      isTicking = true
      $.clock.every(REFRESH_MS, () => void refresh($, glancePath, false).catch(() => undefined))
    }
    return next(e)
  })

  on('command.run', { command: 'wasitme' }, async $ => {
    await refresh($, glancePath, true).catch(() => undefined)
    const opened = await $.ui.open({ id: PANE, title: 'wasitme' })
    const display = classify(await read($, snapshot))
    // Short on purpose: the model reads command output too.
    return { text: commandSummary(display, opened.isPlaced) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const display = classify(await read($, snapshot))
    return renderPane(kit, display, {
      columns: e.props.bodyColumns,
      actions: {
        onRefresh: () => void refresh($, glancePath, true).catch(() => undefined),
        onClose: () => void $.ui.close({ id: PANE }),
      },
    })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Yield to a survey, and stay out of the way when the person hid the band.
    if (!showBand || e.props.hasSurvey || (await read($, isBandHidden))) return next(e)

    const display = classify(await read($, snapshot))
    const kit = $.ui.resolve(e)
    const band = renderBand(kit, display, {
      columns: e.props.bodyColumns,
      actions: { onHide: () => void update($, isBandHidden, () => true) },
    })
    return band ?? next(e)
  })
}
