# AGENTS.md

Rules for everyone who changes this repository: people and AI coding agents alike. [CONTRIBUTING.md](CONTRIBUTING.md) has
the long version for human contributors; this file is the short one an agent should read first. Claude Code reads it
through [CLAUDE.md](CLAUDE.md).

**What this is.** wasitme is a local tool that reads an AI coding agent's session logs and configuration (Claude Code and
Codex) and answers one question: did my setup change, or did the agent? It says so only when the evidence supports it, and
otherwise says "Too early to tell". It is free, MIT-licensed and offline.

## Rules that never bend

1. **Only derived numbers leave a session file.** Never store, print or export prompt or reply text, tool input or output,
   code, file paths, working directories, project names, git branches, MCP arguments or environment, secrets, or the
   contents of `CLAUDE.md` / `AGENTS.md`. Text may be used in memory (to measure its length, say) and then dropped.
2. **Never execute anything that was scanned:** no hooks, skills, MCP commands or settings from a log or a config file.
3. **The engine has zero runtime dependencies and no network code.** Node.js built-ins only. `node scripts/check-no-network.mjs`
   enforces it and CI runs it.
4. **Counts are indicators, not a quality score.** Show noise bands, never claim causation without evidence, and prefer
   "Too early to tell" or "No detectable change" to an invented cause.
5. **Timestamps can go backward** (people reset their clocks). Never assume log order and never produce a negative duration.
6. **Logs are hostile input and formats change without notice.** Parse defensively, count what you could not parse, and keep going.
   For Claude Code logs: deduplicate usage by `requestId` and include the subagent files.
7. **Test data is 100% synthetic.** Never copy, slice or "anonymise" a real log. Write fixtures from scratch.

## Safety rules for agents working in this repository

- **Never read the real agent folders** (`~/.claude`, `~/.codex`) or a real `~/.wasitme` while developing, and never paste
  real logs anywhere. (The tool itself reads them when a user runs it; you must not.) They are both the user's live setup
  and the data this tool measures. Tests and experiments use a temporary `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
  `WASITME_HOME`.
- **Never run `claude` or `codex` with a real login** to test something. If a task needs a login, stop and say so.
- **Do not touch the user's own setup:** no LaunchAgents, no editing of their agent settings or status line outside the
  installer's tested paths.
- **Do not push, tag, publish or release** (GitHub, npm, anything) and do not download or install software on your own
  initiative. Ask the maintainer first. The same goes for anything that spends money or has legal consequences.
- **Evidence over opinion.** A claim in the docs, a comment or a commit message is true only if you checked it: run the
  command, read the file, compute the number. Say plainly which statements are guesses.
- **Keep it small and reversible.** Commit at milestones, keep changes focused, and never weaken a test to make it pass.

## Working in the repository

You need Node.js 22 or newer.

```sh
npm ci                                  # dev-only tools (nothing ships at runtime)
npm run typecheck
npm test                                # builds the engine with tsc, then runs node:test
scripts/ci-local.sh --list              # every check CI runs, plus the Mac-only ones
scripts/ci-local.sh --keep-going        # run them all; the summary table says what passed, skipped or failed
```

- **Heavy jobs** (the full engine test run, Swift builds, the canvas build, the calibration run) go through
  `scripts/dev/heavy.sh <command>`, which runs one at a time at background priority so the machine stays usable. Keep worker
  threads and processes at one or two.
- **Layout:** `engine/` TypeScript engine and CLI, `macos/` the Swift menu bar app, `ui/` the Control Center canvas,
  `plugin/` and `plugin-codex/` the Claude Code and Codex plugins, `contract/` the JSON schemas and golden files the surfaces
  share, `design/` the design system, `scripts/` checks and the installer, `testdata/` synthetic fixtures, `changelog.d/`
  unreleased changelog entries, `docs/` the method, privacy, format and decision notes.
- **Docs map:** [README](README.md) (what it does), [docs/METHOD.md](docs/METHOD.md) (the statistics),
  [docs/PRIVACY.md](docs/PRIVACY.md) (what is read and kept), [docs/FORMATS.md](docs/FORMATS.md) (log formats, field names
  only), [docs/CONTRACT.md](docs/CONTRACT.md) (the shared data contract), [docs/DECISIONS.md](docs/DECISIONS.md) (numbered
  decisions, cited in code as `D##`), [docs/WORK-PACKAGES.md](docs/WORK-PACKAGES.md) (what the `WP-##` ids cited in code
  name), [SECURITY.md](SECURITY.md) (threat model).
- **Every user-visible change** adds one file to `changelog.d/` ([format](changelog.d/README.md)).
- **The shared contract** (`engine/src/types.ts` and `contract/`) changes only with the maintainer's agreement.

## Private notes

Per-checkout notes that must not be published (machine setup, usage limits, personal preferences) go in
`CLAUDE.local.md` or `docs/private/`. Both are gitignored, and `scripts/dev/export-public.sh` also refuses to ship them.
