# Security policy and threat model

wasitme reads the session logs of your AI coding agents, which hold your prompts, your code, your file paths and,
sometimes, your secrets. Security here mostly means one thing: **what is read stays on your machine, and only derived
numbers ever leave a session file.** This document says exactly what that means, what is checked automatically, and what
is not.

## Reporting a vulnerability

Please report privately, not in a public issue:

- **GitHub private vulnerability reporting:** <https://github.com/draarivpatel-ui/wasitme/security/advisories/new>

Please include the wasitme version, what you expected and what happened, and a **synthetic** reproduction (a tiny
made-up log file). Do not attach real session logs, configuration files or screenshots of them.

What to expect: wasitme is a free, MIT-licensed project with a single maintainer. **There is no response-time or patch
SLA.** Reports are read and answered as time allows, fixes land in the next release, and only the latest release is
supported. Please give the maintainer a reasonable chance to fix a problem before disclosing it, and you will be
credited in the advisory if you want to be.

Good reports are about any path where **text, paths or secrets from your logs reach an output, the stored data or the
network**; code or command execution triggered by log content; reading or writing outside the agent directories and
wasitme's own folder; the installer or release pipeline; and the Claude Code mod doing more than its allow-list. Wrong or
noisy findings are not vulnerabilities; open a normal issue for those.

## How wasitme is built, in security terms

wasitme is a local, offline program that runs as you. There is no server, no account, no telemetry and no update check
inside the engine.

```
  UNTRUSTED INPUT             WASITME (runs as your user)             OUTPUT
  agent session logs   -->    readers: parse, count, hash   -->       ~/.wasitme/ derived store
  agent config                (log content is data, never             reports, status line,
  (hashes + counts only)       executed)                              menu bar app, Claude Code mod

  Never: any network access, or running / evaluating anything that came from a log.
```

## Threat model

### What is worth protecting

1. **Your session logs.** Prompts, model replies, tool input and output, file contents, paths, project names, git branches.
2. **Your agent configuration.** Instruction files such as `CLAUDE.md`/`AGENTS.md`, MCP server definitions (which can
   hold tokens in arguments or environment), hooks, skills.
3. **Your machine.** wasitme must not become a way to run code or reach the network on your behalf.
4. **wasitme's own state**, including the random salt that makes its ids unguessable.

### Who and what we defend against

| Threat | Example | Main defences |
|---|---|---|
| **Hostile or malformed log content** | A transcript committed to a shared repository, text injected by a prompt-injected agent, a tool writing odd records, a corrupted or truncated file | Logs are data, never instructions; strict parsing and bounded sizes; labels and numbers pass allow-list filters; nothing from a log is executed |
| **Accidental disclosure through outputs** | A report pasted into a GitHub issue or an AI chat; a screenshot | Only derived numbers, allow-listed labels and salted ids are ever stored or printed; a canary corpus checks every output format |
| **Supply chain** | A malicious dependency, a tampered release, a poisoned CI action | Zero runtime dependencies; pinned CI actions; releases built only from green CI on a tag and published as a human-reviewed draft with checksums and provenance |
| **Over-privileged integrations** | The Claude Code mod or a hook doing more than it should | A frozen mod capability allow-list checked in CI; hooks only start wasitme's own scan by absolute path |

### Out of scope

- **Anyone who already runs code as your user, or as root.** They can read your logs directly; wasitme adds nothing.
- Other programs on your machine reading `~/.wasitme/` (it holds derived data and the salt, protected only by ordinary
  file permissions).
- Bugs in Claude Code, Codex, Node.js, macOS or Xcode themselves.
- A fake "wasitme" distributed by someone else. The only legitimate sources are this repository and its releases.

## What wasitme reads

- **Session logs**, read-only: Claude Code's `~/.claude/projects/**/*.jsonl` including subagent files, and Codex's
  `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/`. The agents' own environment overrides
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) are respected.
- **The agents' global configuration**, to notice when your setup changes: instruction files, settings, and the lists
  of MCP servers, plugins, skills and hooks. These are fingerprinted (hashed and counted); their contents are never
  copied anywhere. From Claude Code's global state file (`~/.claude.json`, or `~/.claude-custom-oauth.json` when
  `CLAUDE_CODE_CUSTOM_OAUTH_URL` is set) only the top-level `mcpServers` entry is read; every other key is skipped
  ([PRIVACY.md](docs/PRIVACY.md#what-is-read) has the exact list of files).
- **Project files, from one hook only.** When a Claude Code session starts, the plugin's SessionStart hook reads six fixed names in
  that project folder: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` and
  `.mcp.json`. Each must be a regular file inside a folder strictly below your home folder (symlinks are not followed), is capped at
  1 MiB, and is hashed in memory with your salt and dropped. The hook runs under Node's permission sandbox, which grants read access to
  that project folder and `~/.wasitme`, write access to `~/.wasitme`, and nothing else. A scan never reads project files.
- wasitme's own folder, `~/.wasitme/`.

It is built not to look anywhere else: not other files in your projects, not your shell history, not credential or token files
(`auth.json` and `.credentials.json` are never opened), not browser data. wasitme never asks the agent, the vendor or any service anything.

## What is stored, and what never is

Only these leave a session file, and only these are written to disk or shown:

| Stored (derived) | Examples |
|---|---|
| **Counts and sizes** | steps, tool calls, tool errors, rejections, interrupts, reads, edits, tokens, cache reads, compactions; prompt *length in characters* |
| **Durations and timestamps** | per-exchange duration (never negative), UTC time, local calendar day |
| **Allow-listed labels** | agent version, model, effort, permission mode, entry point: short strings that pass a character allow-list |
| **Salted hashes** | ids for sessions, projects and exchanges: HMAC-SHA256 with a per-install random salt, truncated to 12 hex characters |
| **Fingerprints of configuration** | short hashes and counts, never contents |
| **Findings and statistics** | the numbers, intervals and states computed from the above |

**Never stored, printed or exported:**

- prompt text and model response text
- tool input and output (commands, file contents, search results)
- file paths and the working directory
- project names and git branches
- MCP server arguments and environment
- secrets, tokens and keys
- `CLAUDE.md` / `AGENTS.md` or any other configuration content

The only paths wasitme records are its own install locations (so its hooks can find the engine) and the agent folders
it reads (in `~/.wasitme/engine.json` and the background scan's job file, so the sandbox can grant them), never a path
taken from a log or a project.

What a report **does** reveal, so you can judge before sharing one: when you work and for how long, how many prompts,
tool calls and failures, which agent versions, models and effort levels you used, and pseudonymous session and project
ids that group numbers together without naming anything.

## No network

- The engine uses only Node.js built-in modules, has **zero runtime dependencies**, and contains no code that opens a
  connection or loads code dynamically. It starts another program in exactly two places, each marked
  `wasitme:allow-child_process` for the no-network check, each with a fixed argument list, no input from any log, and a timeout:
  the feature test of Node's permission flag (`<this node> --permission -e 0`, empty environment, 5 seconds, run only outside the
  sandbox and only when `engine.json` has no result for this Node), and `wasitme doctor --toolchain` on a Mac (`xcode-select -p` and
  `swift --version`, minimal `PATH`, 10 seconds).
- It does not phone home, collect analytics, check for updates or send crash reports.
- The one component that downloads anything is the installer (running it again with a newer release is the update; `--update`
  does it keeping your parts), and only when you run it: it fetches wasitme itself from GitHub over HTTPS, and only when it
  is given no local source (`--from`, `--tarball`). Only the `install.sh` published with a release checks a SHA-256
  without being given one (install step 1 below). Adding or removing a part (`install.sh --add`, `uninstall.sh --only`) works from the
  installed copy and downloads nothing. A source checkout without a prebuilt engine also runs `npm ci --ignore-scripts`,
  which fetches the TypeScript compiler (a build tool that is not shipped). After installation nothing in wasitme talks to a network.
- The macOS app and menu bar item talk only to the local engine (its output files or its command line); the Claude Code
  mod is not allowed any network call (see below).

## Hostile input handling

Session logs are untrusted: they contain whatever your agent, your tools and the web put into them. The engine
therefore treats every field as hostile:

- **Parsing:** logs are split on `\n` only (Node's line reader also splits on U+2028/U+2029, which would silently
  corrupt records). A line over 20 MB is dropped and counted. Malformed lines are counted, not fatal; a half-written
  last line is recognised as normal for a live session. Unknown record types are counted and surfaced as a
  format-drift warning, never guessed at.
- **Labels:** any string that ends up in an output (version, model, effort, mode, entry point) must match its field's
  shape: fixed lists for effort, mode and entry point, a version pattern, and a lowercase id pattern for model names
  (one Vertex-style `@<version>` suffix allowed). Anything else becomes `other` and never counts as a change. Slashes
  (so paths and full URLs), quotes, angle brackets, ANSI escapes and bidirectional controls can never pass.
- **Numbers and time:** counts must be finite and non-negative; timestamps must fall between 2020-01-01 and one day
  from now; durations are never negative. Clocks can go backwards, so order is never assumed.
- **Files:** symlinks (to directories or files) inside log folders are never followed and directory depth is bounded;
  unreadable directories and files are skipped rather than crashing a scan. The one place a link is followed is the configuration
  reader, because many people keep `CLAUDE.md` or `settings.json` in a dotfiles folder: one hop at a time, regular files only, never
  into a macOS privacy-protected folder, and only to fingerprint the file.
- **Never executed:** nothing read from a log or configuration file is run, evaluated, spawned, opened as a URL or
  passed to a shell: not hooks, not skills, not MCP commands, not "commands" mentioned in transcripts. For the engine
  this is enforced by the no-network check, which rejects `eval` and dynamic code loading, and rejects `child_process` except at
  the two marked spawns above (fixed arguments, nothing from a log).
- **Required of every output, as each one lands:** labels are rendered as plain data, escaped for their format
  (terminal, Markdown, HTML, JSON), never as markup, and counts keyed by log-supplied strings use maps or
  null-prototype objects so a hostile key such as `__proto__` is just a key.

## Hashes and labels: what they protect, and what they don't

- Ids are **pseudonyms, not anonymity.** The salt lives only in `~/.wasitme/salt` and is never exported, so ids cannot
  be linked across machines or reversed without it. Truncating to 12 hex characters (48 bits) keeps them short, which
  also means they are for grouping, not for secrecy: anyone holding your salt could test guesses.
- `cleanLabel` is a character filter, **not** a list of known-good values. A hostile log can still put up to 60
  characters of plain words into a label field that has no stricter pattern of its own, and that text could reach a report
  (a model id has one: lowercase, no spaces, up to 64 characters plus one version suffix). Such a label cannot
  carry slashes (so no paths or full URLs), quotes, markup or control characters, but it can carry misleading prose, a
  bare domain name, or something shaped like an email address (`@` and `.` are allowed). Treat any report pasted into an
  AI assistant as untrusted text, as you would any web page.

## Claude Code mod and hooks: capability allow-list

A Claude Code mod runs inside Claude Code with your permissions, so wasitme's mod is deliberately tiny. It may read
wasitme's own derived summary file, draw its pane, band and status text, and register its own command. It may **not**:

- run processes (`$.process.*`), read environment variables (`$.env.*`), make requests (`$.http.*`) or write files
  (`$.fs.write`);
- subscribe to tool calls or prompt submission (`tool.call`, `prompt.submit`) or read the session's messages
  (`$.session.messages`).

The host derives a mod's `calls:` from the literal text of its source, so CI searches the plugin source for exactly
these calls and for indirect access to them (aliasing `$.process`, `$["env"]`, bare `$.fs`), and fails the build on any
hit. The plugin's README prints the exact `calls:` line that `claude plugin validate` reports, so you can compare
it with what you are asked to approve.

Plugin hooks do little (the session-start hook runs asynchronously; the session-end hook is given a few seconds): they ask macOS to run
wasitme's own scan job (and, at session start, take the project snapshot described above), using absolute paths that were recorded when wasitme was installed, never a name
looked up on `PATH`, and never building a command from hook input such as transcript paths. The plugin is installed from an
immutable, versioned copy under `~/.wasitme/`.

## Installing, signing and updating on macOS

There is no Apple Developer ID and no notarization (this is a free project with no budget for either). The macOS app is
therefore **built on your own Mac from source**:

The install flow:

1. The installer fetches the release tarball from GitHub over HTTPS. The `install.sh` published with a release has that
   release's tarball URL and SHA-256 stamped into it, and refuses a download from that URL that does not match. No other
   copy carries a checksum: the one in the repository and the one inside the tarball (which is the copy installed under
   `~/.wasitme`) fetch the latest release and rely on HTTPS alone, unless you name the tarball with `--url` and give its
   SHA-256 from the release's `SHA256SUMS` with `--sha256`. Read the script before piping it to `sh`, and prefer a pinned
   release over a branch.
2. The tarball carries the engine already built (plain JavaScript, so installing it runs no `npm`). The installer builds
   the app locally from the Swift sources in the tarball, signs it **ad hoc** (`codesign --sign -`) and checks it with
   `codesign --verify --deep --strict`.
3. Because the app is built here and never downloaded, macOS does not quarantine it and Gatekeeper does not assess it.
   (A locally built, ad-hoc-signed menu bar app was launched this way on macOS 27 with no prompt; that is a single
   observation on one machine, not a guarantee for every macOS version.)

What that means for trust: the ad-hoc signature identifies no publisher and Apple has not scanned the app. Your trust
rests on the source you build, the installer you ran, and your own Xcode toolchain. **No prebuilt macOS binary is
published, so never run a "wasitme.app" downloaded from anywhere.** Releases are set up to ship the tarball the installer
downloads (the prebuilt engine and Control Center page plus the app's Swift sources), the stamped `install.sh`, the npm
package tarball, a `SHA256SUMS` file and a GitHub build-provenance attestation; once a release exists you can check
a download with `gh attestation verify <file> --repo draarivpatel-ui/wasitme`. Everything runs as your user, with nothing
needing `sudo`.

Updating, and changing one part:

- `install.sh --update` installs the parts the install record lists, no new ones and none dropped, and asks nothing. It
  rebuilds the app the same way as above. Run from the installed copy (as the Mac app's Update button does), it has no
  checksum to compare the download with (step 1). A running copy is quit before its bundle is replaced: launchd's copy by
  unloading its LaunchAgent, any other copy with `pkill` limited to your processes whose executable lies inside that exact bundle
  (the uninstaller's rule). It is started again only if it was running (by its LaunchAgent, or `open -g`, which does not
  take focus), and not at all with `--no-relaunch`. Under a custom `--home` none of this touches launchd or a real app
  unless a replacement for `launchctl` (and `open`) is injected.
- `uninstall.sh --only PART` removes one part by the full uninstall's rules (status line restored only if it is still
  wasitme's, files that are not ours left alone) and updates the install record, `engine.json` and `engine.env` so nothing
  names a part that is gone. `install.sh --add PART` installs one part from the installed, read-only copy.
  `install.sh --status --json` only reads (the install record and whether `claude`, `codex` and a status line are
  there), runs nothing, and prints fixed words and the version, never a path.
- `--from-app` (what the Mac app's buttons are meant to run) starts the same command detached in a new session, so it
  survives the app quitting or being unloaded, with no terminal and stdin from `/dev/null`. It writes its result to
  `~/.wasitme/state/last-action.json` (folder 0700, file 0600; a symlinked or foreign folder is refused), starts only one
  action at a time, and runs exactly the command it was given.
- `wasitme history clear` deletes derived data only (PRIVACY.md lists it) while holding the scan lock, renames folders aside
  before deleting them, follows no symlink, and needs `--yes` when there is no terminal to ask on.

## How these claims are checked

| Claim | Check | Status |
|---|---|---|
| The engine, the plugin's mod and hook scripts, and the macOS app import no network module and call no network API; only the two marked spawns start a program | `scripts/check-no-network.mjs` in CI and in `scripts/ci-local.sh` | Enforced in CI |
| The engine declares no runtime dependencies or install-time scripts | same script (reads `engine/package.json`) | Enforced in CI |
| No canary string from the hostile corpus appears in any output | `scripts/check-privacy.mjs`; the canary list `testdata/hostile/CANARIES.txt`; the privacy tests in `engine/test/store/` and `engine/test/configsnap/` | Enforced in CI |
| The mod stays inside its allow-list | CI source search for the forbidden calls and hooks (`scripts/check-mod-allowlist.mjs`), plus `claude plugin validate` where the CLI is installed; the exact list of calls is held by `plugin/tests/check-calls.mjs`, which needs the `claude` CLI and is run by hand | The source search is enforced in CI; the `validate` step is skipped on runners without the CLI, and `check-calls.mjs` is not run in CI |
| Parsers survive hostile input without crashing, hanging or leaking | Engine reader tests and the hostile corpus (`testdata/hostile/`) | Enforced in CI |
| Readers open only files under the agent directories and `~/.wasitme` | Reader and store tests that point `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at temporary directories, a test that spies on file opens (`auth.json` and `.credentials.json` are never opened); code review | Enforced in CI |
| Outputs escape log-derived labels for their format; hostile keys cannot hijack counts | Hostile corpus through every output (`engine/test/output/`), then `check-privacy.mjs` | Enforced in CI |
| Releases come only from green CI on a tag that matches the version, and stay drafts | `.github/workflows/release.yml` | Written; has not run on GitHub yet |
| State files are owner-only and written atomically | Store tests (`engine/test/store/`) | Enforced in CI |
| The installer extracts without running lifecycle scripts and verifies its build | Installer tests (`scripts/test/`) | Enforced in CI |
| No home path, forbidden e-mail address, remote asset or string-built JavaScript reaches the repository | `scripts/check-repo.mjs --strict` | Enforced in CI; the e-mail rule needs a repository secret |

Several of these checks are tripwires, not proofs. The next section says where they stop.

## Known limitations

- The no-network check is a **tripwire, not a sandbox**: it catches accidents and shortcuts, not a contributor who is
  determined to hide a call. Code review and zero dependencies are the real defence. One accidental route it cannot see
  in Swift: a remote URL built from a variable (or `URLComponents`) and passed to `Data(contentsOf:)`, because the app
  reads local files the same way.
- Labels are filtered by character set, not by value (see above).
- Ids are 48-bit pseudonyms (see above).
- Symbolic links are never followed inside the agent log directories. The configuration reader does follow a link to a regular file
  (one hop at a time, never into a privacy-protected folder, to fingerprint it), so a link planted there can make wasitme read a
  file you did not expect; only a hash, a size and a line count come out of it.
- There is no hard cap on the number of log files or on scan time; a directory with millions of files makes a scan slow.
- Timing and volume patterns in derived data say something about how you work.
- Pushback detection is a small English-only heuristic. It is an indicator, not a security control.
- No notarization, no Developer ID, no patch SLA.
