# Contributing to wasitme

Thanks for helping. wasitme is a small, local-only tool with one job: read your own AI coding agent logs and say, with
honest uncertainty, whether **your setup changed or the agent did**. Contributions that make that answer more correct,
more honest or easier to trust are very welcome. By opening a pull request you agree to license your contribution under
the project's [MIT license](LICENSE); there is no CLA.

Out of scope: cost tracking, synthetic benchmarks, config linting, cloud features, accounts, telemetry and anything that
sends data off the machine.

Security problems go to [SECURITY.md](SECURITY.md), privately. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md). If an AI coding assistant helps you, point it at [AGENTS.md](AGENTS.md), the short version
of the rules below.

## Rules that never bend

1. **Only derived numbers leave a session file.** Never store, print or export prompt or response text, tool input or
   output, file paths, working directories, project names, git branches, MCP arguments or environment, secrets, or
   `CLAUDE.md`/`AGENTS.md` content. Text may be used in memory (for example to measure its length) and then dropped.
2. **Never execute anything that was scanned**: no hooks, skills, MCP commands or config from a log or settings file.
3. **Engine code has zero runtime dependencies and no network.** Node.js built-ins only; no `fetch`, `http` or `net`. Starting
   another program (`child_process`) is allowed only at the two marked spawns with fixed arguments that [SECURITY.md](SECURITY.md)
   lists; a new one needs the maintainer's agreement. `node scripts/check-no-network.mjs` enforces this and CI runs it.
4. **Counts are indicators, not a quality score.** Show the noise, never claim causation without evidence, and prefer
   "not enough data" or "no detectable change" over an invented cause.
5. **Timestamps can go backwards** (users reset their clocks). Never assume log order, and never produce a negative
   duration.
6. **Logs are hostile input and formats change without notice.** Parse defensively, count what you could not parse, and
   keep going.
7. **Test data is 100% synthetic** (see below).

## Getting set up

You need Node.js 22 or newer (CI runs 22, 24 and 26).

```sh
npm ci                                       # install the build and test tools (dev-only; nothing ships at runtime)
npm run typecheck
npm test                                     # compiles the engine with tsc, then runs node:test
node scripts/check-no-network.mjs            # the no-network / zero-dependency check
node scripts/assemble-changelog.mjs --check  # changelog fragments are well-formed
node scripts/check-privacy.mjs --self-test   # (also: check-no-network.mjs --self-test, assemble-changelog.mjs --self-test)
```

### Run everything

`scripts/ci-local.sh` runs every check CI runs, plus the ones that need a Mac (the Swift app, the Claude Code CLI):

```sh
scripts/ci-local.sh --list                   # the steps, in order
scripts/ci-local.sh --keep-going             # run them all; the table at the end says what passed, skipped or failed
scripts/ci-local.sh --only test,typecheck    # just these steps
scripts/ci-local.sh --only app-capture       # the Mac app's memory budgets (release build + offscreen capture, minutes)
```

A step that cannot run here (no Swift, no `claude` CLI, no `shellcheck`) is reported as skipped, never as passed. The heavy steps (the
engine tests, the Swift build and tests, the Control Center canvas build) go through `scripts/dev/heavy.sh`, which runs them one at a
time at background priority so your machine stays usable; `CI_LOCAL_NO_HEAVY=1` turns that off. One step is opt-in because it takes
minutes: `app-capture` builds the Mac app in release mode, runs its offscreen capture and fails when a memory budget is over (see
[macos/README.md](macos/README.md), "Offscreen capture"). Ask for it with `--capture`, `CI_LOCAL_CAPTURE=1` or `--only app-capture`;
otherwise, and on anything but macOS, it is reported as skipped. The installer's tests are
`sh scripts/test/run.sh`; the canvas tests are in `ui/test/`, the Swift tests in `macos/Tests/`.

### Repository layout

| Folder | What |
|---|---|
| `engine/` | The TypeScript engine and the `wasitme` command line (the npm package) |
| `macos/` | The Swift menu bar app and desktop panel (built on the user's Mac, never shipped as a binary) |
| `ui/` | The Control Center canvas (the web page the app shows in a locked-down web view) |
| `plugin/`, `plugin-codex/` | The Claude Code plugin (mod, report skill, hooks) and the Codex skill |
| `contract/` | JSON schemas and golden files shared by the engine, the app, the canvas and the plugins |
| `design/` | The design system: tokens, fonts, glyphs, mockups made from clearly labelled demo data |
| `packaging/` | The status line script |
| `scripts/` | Repository checks, the installer and uninstaller, and their tests (`scripts/test/`) |
| `testdata/` | Synthetic logs and the hostile corpus; no real data |
| `changelog.d/` | Unreleased changelog entries |
| `docs/` | Method, privacy, formats, contract, decisions, research notes and spike write-ups |

Code style: TypeScript in strict mode, ES modules, small readable modules, comments that explain why rather than what.
Comments cite decisions as `D##` ([docs/DECISIONS.md](docs/DECISIONS.md)) and the part of the code they belong to as
`WP-##`; [docs/WORK-PACKAGES.md](docs/WORK-PACKAGES.md) says what each `WP-##` id names.
Tests use `node:test` and `node:assert`. Do not weaken a test to make it pass; fix the code or explain in the pull
request why the test was wrong. `.editorconfig` has the whitespace rules.

## Adding a reader for a new agent

A reader turns one agent's session logs into the engine's neutral records. Start with the "Support for another coding
agent" issue form: describe where the history lives and which fields exist, using field names only.

1. **Agent id.** Agent ids are the `AgentId` union in `engine/src/types.ts`. That file is the shared contract between
   the engine, the app and the plugin and is changed by the maintainer, so propose the new id in your issue instead of
   editing the file in your pull request.
2. **Implement `Reader`** (also in `engine/src/types.ts`):
   - `root()` returns the directory to scan and honours the agent's own environment override (the way `CODEX_HOME` or
     `CLAUDE_CONFIG_DIR` work), so tests can point it at a temporary directory. Never scan outside the agent's folder.
   - `list()` is cheap: it only stats files and returns one `Source` per session, with a `FileStamp` per file, so
     unchanged sessions are skipped via their fingerprint. Use the helpers in `engine/src/readers/fs.ts` (`entries`,
     `walkFiles`, `stamp`, `fingerprint`); they never follow directory symlinks and bound the depth.
   - `parse(source, ctx)` returns a `ParseResult` (`exchanges`, `events`, `stats`). Take the clock from `ctx.now` and
     the day boundary from `ctx.timeZone`, and make ids with `ctx.hash`, never with raw values.
3. **Build `Exchange`s the way the contract describes:** one real human prompt plus everything the agent did until the
   next real human prompt in the main thread. Subagent work is attributed to the exchange that started it and never
   creates one. Do not count machine-written text as a prompt: summaries, injected context, notifications, tool
   results.
4. **Deduplicate** whatever the agent repeats: a response streamed over several records, resumed or forked sessions that
   replay earlier history, repeated token snapshots. Count what you dropped in `stats.duplicates`.
5. **Keep it private.** Use `readJsonl` for JSONL, `cleanLabel` for every label, `cleanTime` for every timestamp and
   `num` for every number from a log (all in `engine/src/util.ts`). `isPushback` (`engine/src/pushback.ts`) and
   `isNearDuplicate` (`engine/src/similarity.ts`) may look at prompt text in memory; the text itself is never kept.
6. **Make drift visible.** Count unknown record types in `stats.unknownTypes`, and keep `badLines`, `truncatedTail`,
   `badTimestamps` and `filesFailed` honest. A field that is missing must never crash a scan.
7. **Findings stay off** for a new agent until its own null-data calibration passes ([docs/METHOD.md](docs/METHOD.md)); until then it
   reports descriptive numbers only (the timeline).
8. **Tests** with synthetic fixtures: a normal session; each dedupe case; a truncated last line; malformed lines;
   timestamps out of order or in the future (no negative durations); unknown record types; hostile strings in every label
   field (ANSI escapes, bidirectional controls, path-like text, very long text); and counts checked against a hand
   count. Point the reader at a temporary directory, never at the real `~/.claude` or `~/.codex`.
9. Register the reader next to the existing ones in `engine/src/readers/`, document the log format in `docs/` (field
   names only), and add a changelog fragment.

## Test data must be synthetic

Never copy, slice, trim or "anonymise" anything from real session logs, yours or anyone else's. An anonymised log still
carries the shape, order, sizes and timing that identify its owner, and a single missed field leaks a secret into a
public repository. Write fixtures from scratch (by hand or with a small generator), and make planted secrets obviously
fake.

For privacy tests, plant unique **canary** strings (for example `CANARY-` plus random characters) in hostile fixtures
and list them one per line in `testdata/hostile/CANARIES.txt`. Then run every output format through
`node scripts/check-privacy.mjs <output files>`: it fails if any canary appears, in plain text or after common
re-encoding (JSON escapes, URL or HTML encoding, re-wrapping). If the file were ever missing the check would report "SKIPPED";
`--require-canaries` (used by `scripts/ci-local.sh --prepublish`) makes that an error.

Never point tests, or your own experiments, at your real agent directories, and never paste real logs into an AI
assistant to debug wasitme.

## Changelog fragments

Every user-visible change adds one small file to `changelog.d/`, named `<short-slug>.<category>.md`, so pull requests
never conflict on a shared changelog. The format and the rules are in [changelog.d/README.md](changelog.d/README.md),
and `node scripts/assemble-changelog.mjs --check` validates them.

## Pull requests

Keep them small and focused, fill in the checklist in the pull request template, and describe how you tested the
change. If you used an AI assistant to write code, you are still the author and are responsible for every line.
