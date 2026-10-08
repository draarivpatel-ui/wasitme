# wasitme plugin (Claude Code mod + report skill + hooks)

The plugin includes a **mod**: code that runs inside Claude Code with your permissions. Claude Code's install screen
shows only its generic "make sure you trust a plugin" warning (DECISIONS D50), so this is the disclosure. What the mod
may call is frozen (D25), and `claude plugin validate` prints it:

```text
calls: $.clock.every, $.clock.now, $.command.register, $.fs.read, $.fs.stat, $.state.get, $.state.set, $.ui.close, $.ui.open, $.ui.resolve
```

It reads one file, `~/.wasitme/glance.json`, and never runs a program, reads the environment, writes a file or uses
the network. To find that file it also reads `$.plugin.root`, the plugin's own folder: a value the host hands the mod,
not a call, so `calls:` does not list it ([below](#how-the-mod-finds-the-glance-file)).

wasitme is an independent project, not affiliated with or endorsed by Anthropic or OpenAI.

## Layout

| Path | What |
| --- | --- |
| `.claude-plugin/plugin.json` | Manifest. Its `version` is the engine's, written by `scripts/plugin-manifests.mjs` (one source for every plugin manifest, D49); a bump is what moves an install forward, because third-party auto-update is off (D25). |
| `hooks/hooks.json` | The mod module, plus two command hooks that run `scripts/session-start.sh` / `scripts/session-end.sh` by absolute path. |
| `scripts/session-start.sh`, `scripts/session-end.sh` | SessionStart: the sandboxed project snapshot, then kick the scan LaunchAgent. SessionEnd: the kick only. Everything comes from `~/.wasitme/engine.env`. |
| `scripts/run.sh` | The report skill's entry point (and the Codex skill's): finds the installed engine and runs `report` or `status` (below). |
| `mod/register.ts` | Wiring only: `/wasitme`, the pane, the quiet band, the once-a-minute re-check. |
| `mod/glance.ts` | Pure: find, parse, bound and classify `~/.wasitme/glance.json` (contract `wasitme.glance/1`, frozen). |
| `mod/theme.ts`, `mod/render.ts` | Everything visual: theme.ts maps the design system onto the mod, render.ts lays it out. The engine owns every finding word; the mod only maps fields. |
| `mod/design-tokens.ts` | `design/system/generated/tokens.ts`, byte for byte (a mod can only import files inside its plugin folder). |
| `types/index.d.ts` | `$.state` contract and the parsed glance shapes. Shipped, with `tsconfig.json`. |
| `skills/report/SKILL.md` | `/wasitme:report`: runs `scripts/run.sh report --md` and presents the report honestly. |
| `tests/` | `claude plugin test plugin` (the mod), `sh tests/hooks.sh` (the hook scripts), `sh tests/run-sh.sh` (run.sh). The goldens are the shared `contract/fixtures/`, embedded by `tests/fixtures/sync.mjs`; there are no plugin-private fixtures. |

An earlier release allow-list named `hooks/register.tsx`; the mod actually lives in `mod/*.ts` (`hooks.json` points at
`../mod/register.ts`), so the release step ships `mod/`.

## How the mod finds the glance file

`$.fs` does not expand `~`, and the mod may not read the environment. So it derives the home directory from where
the plugin lives: `<home>/.claude*/plugins/...` (a marketplace install's cache copy), `<home>/.wasitme/...` (the full
install, whose plugin root is `~/.wasitme/current/plugin`), or `<home>/.local/share/wasitme/...`, and reads
`<home>/.wasitme/glance.json`. Setup writes the `glancePath` option anyway; a plugin loaded some other way
(`--plugin-dir`, a custom config directory or prefix) needs it (absolute, or `~/...`). If neither works, the pane says
so and how to fix it.

## What the mod shows

The pane follows the design system's mod-pane screens (`design/system/screens/text-*.png`, about 64 × 18 cells):

- **Buttons first** (Check again, Hide), so an 80-column inline pane never clips them, and the wordmark at the right.
- Per agent, the CLI's sections in the engine's lead (D28): **timeline-led** (the default, D61) opens on *What changed*,
  then *Finding*, *Signals*, *Next*; verdict-led opens on *Finding*. The UI says "Finding" (D57); the engine and the
  contract keep "verdict".
- **What changed** is the case line: your changes on canary stickers numbered 1, 2, 3 above a dashed rule, the agent's
  on blue stickers lettered A, B, C below it, one column per day with that day's k / n under it, and every change of
  the strip's window listed with its side. The pane's width decides how many days fit (14 at 64 columns).
- **Finding** is the state glyph (·┄· too early to tell, ─── no detectable change, ■─▲ can't tell which, ■── your
  side, ──▲ the agent; ─╱─ out of date), the engine's label (on its sticker for your side or the agent), the deck
  (`headline`) and the note (`because`). When it is too early to tell it says what is still missing, and never a date
  (D66): "No date yet: it depends on how your sessions go."
- The sticker colours are the tokens' fixed fill and ink: the mod cannot see which Claude Code theme is on without a
  call outside its frozen list, and a sticker carries its own background and text colour. The Desktop Code tab's
  colours are assumed, not captured (D57).

The display rules are the contract's (docs/CONTRACT.md#display-rules): a different schema id is "wasitme parts are out
of sync", a file that does not promise `privacy.containsText: false` is refused, a glance older than its own
`staleAfterSec` (default 2 hours) or more than 5 minutes in the future is out of date, and an unknown state is
`unclear`. The band speaks only when the engine wrote a band line and the finding is your side or the agent's.

## Hooks

Both hooks run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh"` (or `session-end.sh`). The command lines
stay byte-identical across versions. Everything the script runs comes from `~/.wasitme/engine.env`, which the
installer writes: `key=value` lines read with `sed`, never sourced. It never runs a PATH-resolved `wasitme`
(hooks run in the session's folder, so a repo that ships its own `wasitme` behind a relative PATH entry must never be
reached), sets its own `PATH` and calls system tools by absolute path, drops `NODE_OPTIONS`, `NODE_PATH` and the other
variables node reads at startup (a project can set environment variables for its sessions, and `NODE_OPTIONS` could
otherwise load the project's code into the hook's node or widen its sandbox), drops `OPENSSL_CONF`, `OPENSSL_MODULES`
and `OPENSSL_ENGINES` (node's OpenSSL reads its configuration file from `OPENSSL_CONF` before any JavaScript runs and
outside the permission sandbox; a configuration can name a provider module to load as native code, or simply stop node),
and prints nothing (a SessionStart hook's stdout would reach the model's context). `scripts/run.sh`, the report skill's
entry point, drops the same variables.
- **SessionStart** (async, `startup|resume`; D32/D60):
  1. takes `cwd` and `session_id` from the hook payload on stdin (at most 256 KiB, bounded `sed` patterns). The cwd
     must be absolute and strictly under `$HOME` (its resolved path too), with no `..`, `*`, quote or escape;
  2. runs the engine's project snapshot under node's permission sandbox:
     `<node> <flag> --allow-fs-read=<~/.wasitme> --allow-fs-read=<cwd> --allow-fs-write=<~/.wasitme> <cli> hook
     session-start --cwd <cwd> [--session <id>]`, one flag per path plus one for each path's resolved spelling when it
     differs (a grant covers only the spelling it is given). `<flag>` is the one the installer feature-tested
     (`--permission` or `--experimental-permission`); if node rejects it (exit 9, e.g. after a Node upgrade) the hook
     retries once with the other. No recorded flag means no snapshot (fail closed);
  3. kicks the scan LaunchAgent (`/bin/launchctl kickstart gui/<uid>/<label>`, never `-k`).
- **SessionEnd** (`prompt_input_exit|logout|other`, so `/clear` and `/resume` do not scan): the kick only. Claude Code
  gives a plugin's SessionEnd about 1.5 s whatever `timeout` says (D50), so the script traps TERM.
Every step is a silent no-op unless its guards hold: macOS; `engine.env` is a regular file, not a symlink, owned by
the user, mode 0600; `node` and `cli` are absolute and exist; the label is `dev.wasitme.scan` or
`dev.wasitme.scan.<suffix>`. `sh tests/hooks.sh` covers each guard, and runs the snapshot command once with the real
`node --permission` against a stand-in engine (project readable, the rest of the home and child processes denied).

## The report skill and run.sh

`/wasitme:report` runs `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" report --md` before the model sees the skill.
The skill's `allowed-tools` allows only that command (`run.sh report` and its flags): without it, Claude Code does not
run the step (checked on 2.1.289 with a throwaway config).

`run.sh` never uses a PATH-resolved `wasitme` (D46). It takes the absolute `node` and `cli` from
`~/.wasitme/engine.json` (a regular file owned by you, not writable by group or others), else the installed engine
behind `~/.wasitme/current`, else the engine bundled with the plugin (`scripts/wasitme.mjs`, a release step) with
`--read-only`. Every file it would run must pass the same ownership check; node is the recorded one, or
`/opt/homebrew/bin/node`, `/usr/local/bin/node`, or an absolute entry of your PATH outside the session's folder, and
must be 22 or newer. It runs only `report` or `status`, from `/`, and drops `WASITME_HOME` before the engine starts (a
project's settings can set environment variables for a session; `report` scans and writes its results into the engine's
data folder, which stays the install's `~/.wasitme`). With the bundled engine only `report` gets `--read-only`; `status`
reads what is there. When something is missing it prints one plain line and exits 0, because a failed skill step makes
Claude Code print the plugin's absolute path into the conversation.

## Codex (`plugin-codex/`, D32/D49)

Codex gets its own marketplace root, `plugin-codex/` (marketplace `wasitme-codex`, plugin `wasitme@wasitme-codex`):
skills only, never a `hooks/` folder. It holds exactly `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`,
`plugin.json` and `skills/report/SKILL.md`, because Codex copies the whole root into its cache. The three JSON files
come from `scripts/plugin-manifests.mjs` (one source; Codex installs the root `plugin.json`'s version when the two
disagree). The skill tells Codex to run `/bin/sh "$HOME/.wasitme/current/plugin/scripts/run.sh" report --md --agent
codex`, so it needs the full install.

Codex stores the resolved marketplace path, so the `current` symlink never carries an update to it. The order (D49):

- install: `codex plugin marketplace add ~/.wasitme/current/plugin-codex`, then `codex plugin add wasitme@wasitme-codex`;
- update: `codex plugin marketplace remove wasitme-codex`, add it again at `~/.wasitme/current/plugin-codex`, then
  `codex plugin add wasitme@wasitme-codex`;
- uninstall: `codex plugin remove wasitme@wasitme-codex`, then `codex plugin marketplace remove wasitme-codex`;
- never prune a version dir Codex's config still points at.

`scripts/test/plugin-codex.test.mjs` runs that order against a codex stand-in (`scripts/test/fixtures/codex-standin.mjs`)
in a temp `CODEX_HOME`; the real codex is never started. How a person invokes the skill in Codex is documented only
after a live check with a real Codex login (D49).

## What the mod may call

`node tests/check-calls.mjs` runs `claude plugin validate` (with a throwaway HOME and `CLAUDE_CONFIG_DIR`, so the real
`~/.claude` is never touched) and fails if the `hooks:` or `calls:` lines leave the allow-list in that file (no
`http.fetch`, `process.run`, `env.get`, `fs.write`, no hooks on `tool.call` or `prompt.submit`).

## Reports from the plugin alone leave out your configuration history

When no installed engine is found, `scripts/run.sh` falls back to the engine bundled with the plugin and runs it with `--read-only`.
Read-only runs, and every `--until` run, do not load the saved history of instruction-file, MCP, skill and hook changes or the project
snapshots. So a plugin-only report can differ from what the app and the plain command line show, and it cannot call a change "Agent
side" by elimination, which needs days wasitme fully observed.

## Working on it

```sh
node tests/fixtures/sync.mjs             # re-embed contract/fixtures/ and re-copy the design tokens
node tests/fixtures/sync.mjs --check     # fail if either is out of date
node ../scripts/plugin-manifests.mjs     # write every plugin manifest from engine/package.json (--check to verify)
node tests/check-calls.mjs               # hold hooks/calls to the allow-list
sh tests/hooks.sh                        # the hook scripts, with a throwaway HOME
sh tests/run-sh.sh                       # run.sh, with a throwaway HOME and a stand-in engine
claude plugin test plugin                # the mod's tests (run it with a throwaway CLAUDE_CONFIG_DIR)
```

Type-checking needs the mod API declarations, which Claude Code writes into `.claude-plugin/types/` when it loads this
folder in dev mode (`claude --plugin-dir plugin`), or `/plugin-types` into `.claude/types/`; both are ignored by git.
Then `tsc -p tsconfig.json` from this folder.
