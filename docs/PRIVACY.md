# Privacy: what wasitme reads, keeps and does

Your agent's session logs hold your prompts, your code, your paths and sometimes your secrets. wasitme reads them to count
things, and keeps only the counts. This page says exactly what is read, what is stored, what is never touched, and how to
remove all of it. The threat model and the way to report a problem are in [SECURITY.md](../SECURITY.md).

Every claim below links to the test or decision behind it. Where a claim is a design rule that no test covers yet, it says so.

## The short version

- **Network.** No network code. Only the installer downloads, and only when you run it.
  There is no account and no telemetry ([D3](DECISIONS.md)).
- **Read.** Your Claude Code and Codex session logs, a short list of each agent's configuration files, and, from Claude Code
  sessions only, a few fixed-name project files. Read-only.
- **Kept.** Counts, durations, short allow-listed labels and salted hashes. Never prompt or reply text, tool input or output,
  code, file paths, project names or secrets.
- **Never read.** `auth.json` and `.credentials.json`. Never executed: any hook, skill, MCP command or setting found in what it reads.
- **Delete everything.** See [How to delete everything](#how-to-delete-everything).

## The network, stated exactly

> wasitme has no network code. Only the installer downloads, and only when you run it. Anything you run inside Claude
> Code or Codex (/wasitme, /wasitme:report) becomes part of that conversation and is sent to Anthropic or OpenAI like any
> message. The report contains numbers only: no prompts, code or paths.

What that means in practice:

- **The engine, the Mac app and the Claude Code mod contain no networking code.** `node scripts/check-no-network.mjs` scans
  the engine, the plugin and the app on every CI run. It rejects network modules, `fetch`, `child_process`, `eval`,
  dynamic code loading, dependencies and install scripts. It is a tripwire, not a sandbox: it catches accidents and
  shortcuts, not a contributor determined to hide a call ([SECURITY.md](../SECURITY.md#known-limitations)).
- **The one step that downloads anything is installing or updating wasitme itself**, and only when you run it. In this
  version, updating means running the installer again with a newer release (`install.sh --update` does that keeping your
  parts). Only the `install.sh` published with a release carries a SHA-256, that of its own release tarball, and checks the
  download against it (that catches a corrupted download, not a compromised source). Every other copy has no checksum: the
  one in a source checkout, and the installed copy (`~/.wasitme/current/scripts/install.sh`), which the Mac app's Update
  button runs with `--update`. When one of those downloads, it fetches the latest release over HTTPS and relies on HTTPS
  alone, unless you name the tarball with `--url` and give its SHA-256 with `--sha256`.
  Adding or removing one part (`install.sh --add`, `uninstall.sh --only`) and `wasitme history clear` download nothing. Installing from a source checkout that has no
  prebuilt engine runs `npm ci --ignore-scripts`, which fetches the TypeScript compiler (a build tool that is not shipped)
  from the npm registry. Release tarballs ship a prebuilt engine and skip that step.
- **The Mac app has no networking code of ours, and its web view cannot navigate.** The Control Center is a web view
  (WKWebView) that loads only the app's own files under a strict content policy; every other load is denied
  ([D48](DECISIONS.md), `CanvasTests.swift`). The operating system still starts its own WebKit helper processes for that
  window; those are Apple's, not ours.
- **Anything run inside Claude Code or Codex goes to that vendor.** `/wasitme` and `/wasitme:report` print their output into
  your conversation, so the model reads it. The report is numbers only, but it is still part of the conversation. The
  report skill sets `disable-model-invocation: true`, so the model cannot run it on its own ([SKILL.md](../plugin/skills/report/SKILL.md)).
  If you paste a report into an issue or a chat, it goes where you paste it.

## What is read

| What | Where | How |
|---|---|---|
| Claude Code session logs | `~/.claude/projects/**/*.jsonl`, including subagent files (or the folder named by `CLAUDE_CONFIG_DIR`) | Read-only, streamed line by line, only files that changed since the last scan. `tool-results/*.txt` is never opened. |
| Codex session logs | `~/.codex/sessions/**/rollout-*.jsonl` and `archived_sessions/` (or `CODEX_HOME`) | Read-only, same way. |
| Claude Code configuration | `CLAUDE.md`, `settings.json`, `plugins/installed_plugins.json` and `skills/<name>/SKILL.md` (existence only) in the config folder; Claude Code's global state file, **top-level `mcpServers` only**: `~/.claude.json`, or `~/.claude-custom-oauth.json` when `CLAUDE_CODE_CUSTOM_OAUTH_URL` is set (inside `CLAUDE_CONFIG_DIR` when that is set; an older `.config.json` in the config folder takes precedence when present) | Fingerprinted: counts and salted hashes. Contents are not copied. Every other key of the state file, such as the per-project `projects` map, is skipped: never parsed into values, never kept. See the header of [`claude.ts`](../engine/src/extract/configsnap/claude.ts) and [`paths.ts`](../engine/src/extract/configsnap/paths.ts). |
| Codex configuration | `config.toml` (parsed as data), `AGENTS.override.md` or `AGENTS.md` (hash and size only), `skills/<name>/SKILL.md` (existence only) | Same. See [`codex.ts`](../engine/src/extract/configsnap/codex.ts). |
| Project files | In a Claude Code session folder, these fixed names only: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json` | **Only by the SessionStart hook**, never by a scan. Hashed and sized, then discarded. See below. |
| wasitme's own folder | `~/.wasitme/` | Its own state. |

Symlinks are not followed while listing log folders, whether they point at a directory or at a file
([D52f](DECISIONS.md), [`readers/fs.ts`](../engine/src/readers/fs.ts)). The configuration files listed above are the one place a
symlink is followed (many people keep `CLAUDE.md` in a dotfiles folder): one hop at a time, never into a macOS privacy-protected
folder, regular files only, and only to hash them ([`safefs.ts`](../engine/src/extract/configsnap/safefs.ts)).

**The project-file read.** When a Claude Code session starts, the plugin's hook asks wasitme to take a snapshot of that
project's instruction and settings files, so a change to your `CLAUDE.md` can appear on the timeline. The rules
([`session-start.ts`](../engine/src/hook/session-start.ts), [`hook.test.ts`](../engine/test/store/hook.test.ts)):

- The folder must be below your home folder, with no `..`, and its real path (symlinks resolved) must be below it too.
- Fixed file names only. Each must be a regular file (checked with `lstat`; a pipe would block), is opened without following
  symlinks, and is capped at 1 MiB. A file that changes while it is read counts as "unknown", not as a change.
- The bytes are hashed in the same process with your local salt. The salt never appears on a command line.
- If macOS refuses access, that is recorded as "not observed", and no permission prompt is meant to appear. The check
  that this holds on a protected folder is a live test still to be run.

## What is never read

- **`auth.json` and `.credentials.json`.** A test spies on file opens during a scan and fails if either is opened
  ([`hook.test.ts`](../engine/test/store/hook.test.ts), "auth.json and .credentials.json are never opened").
- Your shell history, browser data, and any project file not in the list above.
- The contents of skill files (only their existence is checked) and of the programs that hooks and MCP servers run. The hook
  and MCP entries in the configuration files above are read, but feed only counts, salted hashes and fixed-list labels:
  editing one shows as a change, and none of its text is kept. MCP environment and header values feed no item at all
  ([`privacy.test.ts`](../engine/test/configsnap/privacy.test.ts)).
- Global `settings.local.json`, and organisation-managed settings. (Not collected yet: [D60](DECISIONS.md).)
- Nothing read is ever executed, evaluated, opened as a URL or passed to a shell. Scanned hooks, skills and commands stay text.

## What is stored

Everything lives under `~/.wasitme/` (or `WASITME_HOME`). Folders are mode 0700 and files 0600, and every folder is checked with `lstat`:
a symlink or a folder owned by someone else is refused ([`home.ts`](../engine/src/store/home.ts)).

```
current -> versions/<v>        one link: engine and both plugins move together (the installer)
versions/<v>/                  the unpacked release, read-only (the installer)
glance.json  snapshot.json     the two output files (docs/FORMATS.md)
engine.json  engine.env        absolute paths to Node, the engine and the agent folders read, and whether the Node sandbox works
salt                           32 random bytes, 0600, created once with O_EXCL
history/index.json            the store's manifest: one entry per log ever seen (by salted id), the time zone, parser versions
history/shards/<id>.json       derived numbers, one file per log; survives deletion of the log
history/priors/<id>.json      salted record ids of a log, so re-reading a resumed session is cheap; pruned when the log goes
history/config.json           config snapshots over time, and the changes between them
history/projsnap.json         project snapshots from the SessionStart hook
state/                         scan.lock, exclude.json, decisions.json, projsnap/ (hook inbox)
state/last-action.json, .log   the last install, update or removal the Mac app started (--from-app): its result, and the
                               lines the installer printed, as a terminal would show them (see below)
logs/                          error kinds only; never paths, never text
install-manifest               what the installer added, so the uninstaller removes exactly that
```

`last-action.log` is the installer's own output: step names, wasitme's install locations and the agent settings files it
changed (for example `~/.claude/settings.json` and its backup's name), and, when `wasitme doctor` finds a problem, its
report. Like any installer output it has no prompt or reply text, code or project path. Both files are replaced by the
next action, and deleted after a full uninstall started from the app.

What goes into those files, and nothing else:

| Stored | Examples |
|---|---|
| Counts and sizes | steps, tool calls, tool errors, interrupts, reads, edits, tokens, cache reads, compactions; prompt length in characters |
| Durations and dates | per-exchange duration (never negative), a UTC time, a local calendar day |
| Allow-listed labels | agent version, model, effort, permission mode, entry point |
| Salted hashes | ids of sessions, projects, MCP servers, skills and plugins; fingerprints of config files |
| Results | the ratios, ranges and states computed from the above |

- **Ids are pseudonyms.** Each is HMAC-SHA256 keyed with your local salt, cut to 12 hex characters (48 bits)
  ([`util.ts`](../engine/src/util.ts)). The salt is never exported, so ids cannot be linked across machines or reversed
  without it. They are for grouping, not secrecy: anyone holding your salt could test guesses.
- **Labels are filtered by shape.** A version must have the shape `1.2.3`. Effort, permission mode and entry point must be on a
  fixed list. A model must be a lowercase id-like token (letters, digits and `. _ : -`, up to 64 characters, with at most a date,
  `latest` or `default` after an `@`). Anything else is stored as `other` when it comes from a log, or as a salted hash when it comes from
  a config file ([`readers/claude/labels.ts`](../engine/src/readers/claude/labels.ts),
  [`configsnap/labels.ts`](../engine/src/extract/configsnap/labels.ts)). Spaces, slashes, quotes, markup and e-mail shapes
  cannot get through. A shape is still not a promise about meaning: a hostile log could put a misleading id-like word in a
  model field. Treat a pasted report as untrusted text.
- **Prompt text exists only in memory.** It is used to measure length and to spot a pushback phrase, then dropped. File
  paths are used in memory for blind-edit and churn counts, then dropped. Instruction files are read only to be hashed.
- **History outlives the logs.** If Claude Code deletes old terminal transcripts (its default cleanup is 30 days, per its
  documentation; [research/03](research/03-claude-code-plugins-mods.md)), the derived numbers wasitme already kept stay.

**Never stored, printed or exported:** prompt or reply text; tool input or output; code; file paths or the working directory;
project names or git branches; titles; MCP arguments or environment; secrets or tokens; the content of any instruction or
configuration file. The only paths wasitme records are its own install locations.

Checks: [`store/privacy.test.ts`](../engine/test/store/privacy.test.ts) plants canary strings in a hostile log corpus, in
config files and in project files, then fails if any reaches the wasitme folder or the CLI output.
[`check-privacy.mjs`](../scripts/check-privacy.mjs) does the same for every output format.
The hostile corpus is synthetic ([CONTRIBUTING.md](../CONTRIBUTING.md#test-data-must-be-synthetic)).

## What a report reveals

A report is numbers: counts and ratios per window, day-level dates (no clock times, no time zone), the engine version, and
the fixed sentence "These indicators don't measure answer quality. Evidence, not proof." It has no prompts, code, paths,
project names or ids. It does reveal, so you can judge before sharing: roughly when you work and for how long, how many
prompts, tool calls and failures, and which agent versions, models and effort levels you used. Pasting it into a chat
assistant sends it to that vendor.

## The sandbox

Background scans, and the app's Scan now, run under `node --permission` when your Node supports it. The flag is feature-tested, not guessed from
the version, and the result is recorded in `engine.json` ([D49](DECISIONS.md), [`sandbox.test.ts`](../engine/test/store/sandbox.test.ts)).

- **Allowed:** read the log roots and `~/.wasitme`, write only under `~/.wasitme`, start no child process.
- **Not allowed:** network sockets (a connect fails with `ERR_ACCESS_DENIED` on Node 26.8.1, checked during the spike) and writes outside the wasitme folder.
- **It is defence in depth.** The no-follow rules, the label filters and the no-network check stay mandatory whether or not
  the sandbox is on. The Control Center's Sources page shows whether it was.

## The Claude Code mod and the hooks

A mod runs inside Claude Code with your permissions, so wasitme's is small. Claude Code's install screen shows only a
generic "Make sure you trust a plugin before installing" warning and says nothing specific about mods
([spike notes](spikes/2026-10-04-claude-plugin.md)), so the disclosure is here and in the README.

- **It may call only:** `clock.every`, `clock.now`, `command.register`, `fs.read`, `fs.stat`, `state.get`, `state.set`,
  `ui.close`, `ui.open`, `ui.resolve`. It reads one file, `~/.wasitme/glance.json`. It may not run processes, read the
  environment, make requests, write files, or watch your prompts and tool calls. CI searches the mod's source for those
  calls ([`check-mod-allowlist.mjs`](../scripts/check-mod-allowlist.mjs)). The exact list is held by
  [`plugin/tests/check-calls.mjs`](../plugin/tests/check-calls.mjs), which compares it with what `claude plugin validate`
  prints and so needs the `claude` command: it runs on a machine that has it, not in CI.
- **The hooks** (session start, session end) only ask macOS to run wasitme's own scan job and, at session start, take the
  project snapshot described above. They use absolute paths written at install time, never a name looked up on `PATH`, print
  nothing, and always exit 0 ([`plugin/README.md`](../plugin/README.md#layout)).
- **Codex gets no hooks.** The Codex integration is a skill only, and wasitme never touches Codex's `notify` setting.

## Backups the installer makes

Before editing a file of yours, the installer makes a byte copy next to it, named `<file>.wasitme-bak-<time>`: your Claude
Code `settings.json` when it adds a status line, and your shell profile if you let it add a `PATH` line. The uninstaller uses
the copy to restore the file, but only if the file still matches what wasitme wrote. **These copies hold whatever the original held**,
including any secret in it. They, and the previous status-line command that `wasitme statusline install --wrap` keeps in
`~/.wasitme/backups`, are the only places wasitme duplicates something of yours. Delete the copies once you are sure you
do not need them. The installer never edits a shell profile without asking.

Codex is different. Adding the Codex skill makes the Codex CLI itself rewrite its own `config.toml`; that is Codex's behaviour,
and wasitme makes no copy of that file then. At uninstall, wasitme runs `codex plugin remove` and `codex plugin marketplace
remove`. Only if the `codex` command is gone does it remove its own two tables from `config.toml` by hand. In that case it keeps
a mode-0600 byte copy of the file in a temporary working folder until the edit is verified, then deletes the copy (and
puts the original back if the edit does not check out).

## How to delete everything

1. **Remove the integrations and the app:** `sh ~/.wasitme/current/scripts/uninstall.sh`. It asks before each part (Claude
   Code plugin, status line, Codex skill, background scan and Mac app, `PATH` line, the `wasitme` command), restores your status line only
   if it is still wasitme's, and never touches your agent logs. Add `--dry-run` first to see what it would remove. To remove
   one part and keep the rest, add `--only PART` (`app`, `scan-agent`, `claude-plugin`, `codex-plugin`, `statusline`); it
   restores exactly what that part changed, by the same rules.
2. **Remove your saved numbers:** run it again with `--purge`, or delete the folder yourself: `rm -rf ~/.wasitme`. That removes the
   salt, so even a backup of the old history could not be matched to new ids. To delete the numbers but keep wasitme
   installed, run `wasitme history clear` (it asks first; `--yes` without a terminal). It deletes the results, `history/`,
   the saved decisions and the hook's pending project snapshots, and keeps the salt (your project exclusions match by salted
   id), the exclusions, `engine.json` and the install. The next scan starts over from the logs your agents still keep;
   numbers from logs that are gone do not come back.
3. **Remove the backup copies** the installer left next to `settings.json` and your shell profile (`*.wasitme-bak-*`), if any.
4. Your Claude Code and Codex logs are never modified by wasitme, install or uninstall.

To keep some of your work out of the analysis without uninstalling, `wasitme exclude` filters days, projects or entry points at read time. Excluded sessions are still scanned and their derived numbers are still stored; they are only left out of the comparisons ([`exclude.ts`](../engine/src/store/exclude.ts)). Changes to your setup still show on the timeline.

## Known limits

- Timing and volume patterns in derived data say something about how you work.
- Ids are 48-bit pseudonyms, and the salt sits in a 0600 file. Anything running as you can read both.
- Labels are filtered by shape, not by value ([above](#what-is-stored)).
- Sessions on other machines are not visible, and are not collected.
- Pushback detection reads prompt text in memory with a small English-only phrase list. It never keeps the text, and it
  supports a finding but never decides one ([D30](DECISIONS.md)).
