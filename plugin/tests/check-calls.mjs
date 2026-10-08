#!/usr/bin/env node
// Freezes what the wasitme mod may hook and call. Zero dependencies; needs the `claude` CLI.
//
//   node plugin/tests/check-calls.mjs [plugin-folder]
//
// It runs `claude plugin validate plugin`, reads the `hooks:` and `calls:` lines it prints for the
// mod (the host reads them off the module's source), and fails on anything outside the lists below.
// `claude` runs with a throwaway HOME and CLAUDE_CONFIG_DIR and nothing else from the environment but a
// fixed PATH, so this check never reads or writes the person's real ~/.claude (validate needs no login).
// Widening a list is a deliberate act: it changes what the install-time trust warning has to cover.
//
// Never allowed, on purpose: http.fetch, process.run, env.get, fs.write, and hooks on tool.call or
// prompt.submit (the mod would see every tool call and every prompt).

import { execFileSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWED_CALLS = [
  'clock.every', // the once-a-minute cheap re-check
  'clock.now', // staleness
  'command.register', // bare /wasitme
  'fs.read', // glance.json only
  'fs.stat', // its mtime and size
  'state.get', // atom/read: what the last refresh found
  'state.set', // atom/update
  'ui.close',
  'ui.open',
  'ui.resolve',
]
const ALLOWED_HOOKS = ['session.start', 'command.run', 'ui.render']

// An optional path lets the check itself be tested against a plugin that breaks the rules.
const pluginDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))

// The claude on the caller's PATH (absolute entries only), run with a scrubbed environment.
const claude = (process.env.PATH ?? '')
  .split(delimiter)
  .filter(dir => isAbsolute(dir))
  .map(dir => join(dir, 'claude'))
  .find(path => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
if (claude === undefined) {
  console.error('the claude CLI is not on PATH')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'wasitme-check-calls-'))
let output
try {
  output = execFileSync(claude, ['plugin', 'validate', pluginDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: scratch,
    env: { PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(claude)}`, HOME: scratch, CLAUDE_CONFIG_DIR: join(scratch, 'claude'), LANG: 'en_US.UTF-8' },
  })
} catch (err) {
  console.error('claude plugin validate failed:\n' + (err.stdout ?? '') + (err.stderr ?? ''))
  process.exit(1)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const lineFor = label => output.split('\n').find(line => line.includes(`${label}:`) && line.includes('register'))
const hooksLine = lineFor('hooks')
const callsLine = lineFor('calls')
if (!hooksLine || !callsLine) {
  console.error('could not find the hooks:/calls: lines in the validate output:\n' + output)
  process.exit(1)
}
console.log(hooksLine.trim())
console.log(callsLine.trim())

// "$.fs.read (via refresh), $.ui.open" -> ["fs.read", "ui.open"]
const calls = callsLine
  .slice(callsLine.indexOf('calls:') + 'calls:'.length)
  .split(',')
  .map(item => item.replace(/\(.*?\)/, '').trim().replace(/^\$\./, ''))
  .filter(Boolean)
// "session.start, command.run{command=wasitme}, ui.render{...}" -> ["session.start", "command.run", "ui.render"]
const hooks = hooksLine
  .slice(hooksLine.indexOf('hooks:') + 'hooks:'.length)
  .replace(/\{[^}]*\}/g, '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean)

const problems = [
  ...calls.filter(name => !ALLOWED_CALLS.includes(name)).map(name => `call not allowed: $.${name}`),
  ...hooks.filter(name => !ALLOWED_HOOKS.includes(name)).map(name => `hook not allowed: ${name}`),
]
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`calls ok: ${calls.length} calls, ${hooks.length} hooks, all on the allow-list`)
