# testdata

Synthetic Claude Code and Codex session logs, plus the ground truth of what was planted in them.
**Everything here is generated. No byte comes from a real log**; the generator (`engine/src/synth/`) cannot read one.

## Generate

```sh
npm run build -w engine
node engine/dist/src/synth/cli.js --list
node engine/dist/src/synth/cli.js --scenario <name> --out <dir> [--seed N] [--days N] [--scale X] [--replace]
```

`--out` must be a new or empty directory (or one this tool created earlier, with `--replace`). The generator never
deletes anything it did not create. It refuses to write anywhere inside a real agent directory: any path with a `.claude`
or `.codex` folder in it (at any depth, any letter case, and after following symlinks, so a typo like `--out ~/.codex/sessions/x`
or a link into one is caught). The one exception is `.claude/worktrees/<name>`, where Claude Code keeps git checkouts of a
project (they hold code, not session logs), so fixtures can be regenerated from inside a worktree.
Large corpora (30-45 MB each) go under `testdata/generated/`, which is git-ignored:

```sh
node engine/dist/src/synth/cli.js --scenario effort-drop-you --out testdata/generated/effort-drop-you
CLAUDE_CONFIG_DIR=testdata/generated/effort-drop-you/claude CODEX_HOME=testdata/generated/effort-drop-you/codex  wasitme ...
```

| Scenario | What is planted |
|---|---|
| `null-few-long` | few very long sessions (about 18 over 56 days); CLI version bump every ~3 days, **no effect** |
| `null-many-short` | hundreds of short sessions; version bumps, **no effect** |
| `effort-drop-you` | you lower effort high to medium (a `/effort` command is in the log): thinking depth x0.45, edits without reading first x2.5, pushback x3 |
| `version-regression-agent` | a version bump, no user action: tool errors x2.5, interrupts x3, edits without reading first x3 (few-long user: noisy) |
| `confounded-same-week` | model, instructions, effort and version all change in one week, three with effects: cause unclear |
| `insufficient-new-user` | six days, ~16 exchanges, a version bump and a model change, nothing planted |
| `codex-only` | Codex only; you raise effort: output tokens x1.8, tool calls x1.5; legacy and paginated rollouts both occur |
| `both-agents` | Claude effort drop (you) in one week, Codex version regression (vendor) in another |
| `tiny-both` | not one of the eight: a week of both agents, edge cases turned up, ~0.9 MB. Committed as `seed/tiny-both` |
| `hostile`, `hostile-full` | see below |

Deterministic: the same scenario and seed always give the same bytes (file contents and mtimes).
`testdata/seed/golden.json` holds one SHA-256 per scenario at its default seed and length; a test recomputes them.

## Layout of a generated corpus

```
<out>/claude/projects/<encoded-cwd>/<session>.jsonl          CLAUDE_CONFIG_DIR=<out>/claude
<out>/claude/projects/<encoded-cwd>/<session>/subagents/[workflows/<id>/]agent-*.jsonl (+ .meta.json, journal.jsonl)
<out>/codex/sessions/YYYY/MM/DD/rollout-*.jsonl              CODEX_HOME=<out>/codex
<out>/codex/archived_sessions/rollout-*.jsonl
<out>/synth-truth.json                what was planted: params, events, segments, per-agent totals, per-day sums, noise counts
<out>/synth-truth-exchanges.jsonl     one row per exchange, field names mirroring the engine's Exchange contract
```

Reader tests should set the time zone to UTC: truth days are UTC calendar days and all activity falls between 09:00 and
21:30 UTC. `null` in a truth row means "implementation-defined, do not assert" (Codex thinking metrics, prompt length of
agent-initiated exchanges). Rows flagged `clockGlitch` end with a record stamped before their own prompt, so a reader must
clamp the duration. See `notes` in `synth-truth.json` for the counting rules (what an exchange is, what is not one).

A change the user types (model, effort, mode) is evidenced by a command in the log: Claude's `/model`, `/effort`, `/mode`
`<command-name>` record, or Codex's `thread_settings_applied`. Its event in `synth-truth.json` carries `commandAt`, the instant of
that record. The command is typed before the new setting shows up in any record, and its exchange is the agent's first of that
day (labels and planted effect factors switch at the start of the event day, so day-level before/after splits are exact; the
day always has at least one typed prompt). Changes by the agent, such as version bumps, have no command and are in force from
the first record of the day. A reader that attributes a label change to "you" must find the command first; the tests in
`engine/test/synth-ordering.test.ts` check this on the bytes for every scenario.

The planted facts are checked against the files by an independent reference counter (`engine/src/synth/verify.ts`, used by
the tests): every field of every exchange row is recovered exactly from the bytes.

## Hostile corpus

`testdata/hostile/` (committed, ~180 KB) and `hostile-full` (generated, never committed):

- secrets in prompts, tool inputs and outputs, `cwd`, project folder names, branches, slugs, attachments, queue records, titles
  (`sk-ant-...`, `sk-proj-...`, `ghp_...`, `AKIA...`, e-mail addresses, a private-key body)
- ANSI escapes, bidi overrides, zero-width marks and HTML / script tags in label fields (version, model, effort, entrypoint, mode, branch, slug) and text
- malformed, truncated and non-object lines, NUL bytes, invalid UTF-8, BOM + CRLF, odd or missing timestamps, unknown record types,
  duplicate uuids, raw U+2028 / U+2029 inside strings, a record nested 3,000 deep, binary garbage, zero-byte and blank files,
  a directory named like a session, an orphan subagent file, an archived duplicate, a fork of nothing, a legacy-format rollout
- full tier only: a valid 25 MB line (canaries at both ends), a 1.2 MB line, a record nested 200,000 deep, a symlink loop,
  a mutual symlink pair, and a symlink to a directory outside the scanned tree (its records carry version 9.9.9)

Generate the full tier on demand (needs a filesystem that allows symlinks; ~100 MB; git-ignored):

```sh
node engine/dist/src/synth/cli.js --scenario hostile-full --out testdata/generated/hostile-full
```

It writes its **own** `CANARIES.txt` and `HOSTILE-MANIFEST.json`, with two extra sentinels (the 25 MB line, the outside-tree
session) that the committed small-tier files do not have: scan a full-tier run against the generated list, not the committed one.

`CANARIES.txt` lists every planted sentinel string (one per line; each contains `SYNTHCANARY` plus five digits). **No output of
the engine may contain any of them**; also scan for the shapes in `HOSTILE-MANIFEST.json` (`patterns`) and for the raw poison
strings (`poison[].escaped`, JSON-escaped there). The manifest also records, per file, the bad lines and truncated tail that
`readJsonl` must report. Control characters and bidi marks are JSON-escaped on disk so the fixtures are safe to view.

The secret-shaped strings are deliberately off-spec (wrong length, no checksum). They still look like keys to a naive scanner,
so a secret scanner on the public repo (GitHub push protection, gitleaks) may flag `testdata/hostile`; allow-list the folder if so.

## Regenerate the committed fixtures

After an intentional generator change (the determinism and fixture tests will fail until you do):

```sh
npm run build -w engine
node engine/dist/src/synth/cli.js --scenario tiny-both --out testdata/seed/tiny-both --replace
node engine/dist/src/synth/cli.js --scenario hostile --out testdata/hostile --replace
node engine/dist/src/synth/cli.js --golden testdata/seed/golden.json
```
