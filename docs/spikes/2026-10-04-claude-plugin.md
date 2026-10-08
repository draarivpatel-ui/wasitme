# Claude plugin mini-spikes: S-INST, S-GIT, S-HK, S-ROWS (WP-03)

Run 2026-10-04 on Claude Code **2.1.289** (the version on the test Mac), macOS arm64. All four spikes are finished.
**Nothing needed a real login**, and none of them touched a real Claude config (see §2).

The build plan these spikes tested is an internal planning document and is not published; where this note quotes it,
the quote is the plan's wording at the time. The scripts and raw evidence under `spikes-tracked/` stayed in the
development tree and are not published either.

Evidence is the set of scrubbed transcripts in `spikes-tracked/claude-plugin/evidence/` (named `<spike>.txt` below),
produced by the scripts next to them (`spikes-tracked/claude-plugin/scripts/`, run with `run-all.sh`). Every claim carries
one of two tags:

- **[observed: file]** means it appears in that evidence file, from a run on 2.1.289.
- **[inferred]** means it comes from reading Claude Code's help text, type declarations or binary strings, and was not
  seen happening. These are listed again in §9.

## 1. Answers at a glance

| Spike | Answer | What it changes |
|---|---|---|
| **S-INST** trust text | The interactive install shows only the **generic** warning "Make sure you trust a plugin before installing…". No mod-specific warning appears anywhere, though the plugin has a mod. The CLI install prints no warning at all. | Plan, guided setup step 5: wasitme's own setup text and README must carry the mod disclosure. The plugin's `description` is the only wasitme text on the warning screen. |
| **S-INST** symlink flow | Re-run and now verified, including flip-without-update. Flipping `current` changes what runs; `claude plugin update` only updates Claude Code's bookkeeping. A live session sits in a mixed old-mod, new-hooks state until `/reload-plugins`. | Plan, update steps 6-7 stay, with the mixed-state window documented. |
| **S-INST** read-only dirs | Install, update, rollback and live sessions write nothing into the version dirs, writable or not. Only `--plugin-dir` (dev mode) writes `types/` and `tsconfig.json`, and it loads either way. | `chmod -R a-w` is safe. The "validate may write type files" premise did not reproduce. |
| **S-INST** switch from GitHub | `claude plugin marketplace add <path>` with the same name repoints in place and keeps the installed plugin and its saved options. Uninstall, `marketplace remove` and even `uninstall --keep-data` erase the options. | Switch by repointing, never by remove. Setup re-saves options after any reinstall. |
| **S-GIT** | Works. The CLI refuses a `file://` source, but a git source with a `file://` URL declared in `settings.json` is cloned when a session starts, and install and update then work. The `#tag` pin is recorded. Hooks run from the cache copy. | README install line is `claude plugin marketplace add draarivpatel-ui/wasitme`. |
| **S-HK** | `cwd` is in SessionStart stdin (always absolute). A **sync** SessionStart hook blocks the first submitted prompt; async does not. The SessionEnd hook is cut after about 1.5 s whatever the plugin's `timeout` says. In an interactive session SessionStart does not run until the folder is trusted. | Plan, hooks: SessionEnd `timeout: 10` is inert, SessionEnd must be near-instant, SessionStart stays async. |
| **S-ROWS** | Yes. `rows?: number` is typed and honored: frame height is `rows + 2`, up to what the layout spares. | Optional `rows` allowed. Buttons-first stays the design. |

## 2. Method, and what login would have added

Every `claude` process ran under `env -i` with a throwaway `HOME` and `CLAUDE_CONFIG_DIR` inside the session scratch
directory (`lib.sh`, `cc()`), so nothing inherited the orchestrating session's `CLAUDE_*` variables, the real
`~/.claude`, `~/.codex` or `~/Library`. Git "remotes" were bare repos in the scratch directory. Interactive runs used
detached tmux sessions (no window, no focus). Before and after, a read-only check found no `wasitme` entry in the real
`known_marketplaces.json` or `settings.json`.

**What login blocked: nothing.** Every interactive screen showed "Not logged in". The four questions are answered before
any model call: plugin install and update are local; hooks and the mod run at session start; the mod answers `/wasitme`
with no model call, even headless (`claude -p "/wasitme"` prints its text, a handy login-free proof that a mod loaded).
What an unauthenticated session cannot show, so it is **not verified**: whether a sync SessionStart hook also delays an
*authenticated* first model request (§5 measured the submit path up to the login error), and how a resumed session behaves
after a real model turn (§5 resumed a transcript that ended at the login error).

## 3. S-INST

### 3.1 The trust warning (exact text)

Typed `/plugin install wasitme@wasitme` in a live session, once for a marketplace registered at a symlink and once for a
git-hosted marketplace [observed: s-trust.txt]. Both showed this screen (the fixture's name, description and author line
are the only plugin-supplied text on it):

```text
  Plugin Details

  wasitme

  <plugin.json "description">

  By: <plugin.json author.name>

  Will install:
  · Components will be discovered at installation

  ⚠ Make sure you trust a plugin before installing, updating, or using it. Anthropic does not control what MCP servers, files, or other software are included in plugins and cannot verify that they will work as intended or that they won't change. See each plugin's homepage for more information.

  ❯ Install for you (user scope)
    Install for all collaborators on this repository (project scope)
    Install for you, in this repo only (local scope)
    Back to plugin list

   Enter to select · Esc to go back
```

The warning text is also a literal string in the binary [inferred, matches the screen]. What follows:

- **No mod-specific warning exists in this flow.** The plugin has a hooks module (a mod), yet the "Will install" line says
  "Components will be discovered at installation", the later screens list only hooks, and no screen mentions code running
  with the person's permissions. `docs/research/03` line 26 ("mod warning says it runs with your permissions, can read
  files/env/settings…") was **not observed** in any flow. A search of the binary's strings for that wording found it only in the dev-mods
  hot-reload prompt, which is a different feature [inferred from that search]. Correction noted there.
- **Screen 2** (after choosing user scope) is the options form for `userConfig` ("Configure wasitme / Plugin options /
  Snapshot path / Show band / Save configuration"), showing each option's `title` and, for the focused one, its
  `description` [observed: s-trust.txt].
- **Screen 3** (`/plugins` → Installed → wasitme) shows "1 mod active · wasitme", "Installed components: ● Hooks:
  SessionStart, SessionEnd", and the version. The mod appears only in that count header [observed: s-trust.txt].
- **`claude plugin install` on the command line prints no warning**, only "Successfully installed plugin … (scope: user)"
  and "2 userConfig options not yet set" [observed: s-inst-ro.txt]. `claude plugin details` lists the component inventory
  (hooks 2, skills 0…) and no mod, which matches the plan's "details hides mods" [observed: s-inst-ro.txt].
- **Setting `homepage` in `plugin.json` adds one menu row, "Open homepage"** (the URL is not printed) [observed:
  s-trust-fields.txt]. `repository` adds nothing visible.

Consequence: the only wasitme-written words a person sees at the moment of trust are `description`, `author.name`, the
`userConfig` titles and descriptions, and an "Open homepage" row. The plan's guided setup, step 5, must not say "Claude Code says: <mod
warning>"; it should quote the generic text above and add wasitme's own disclosure (the `calls:` line and "runs inside
Claude Code with your permissions").

### 3.2 Symlink update flow, re-run

Setup: `<root>/versions/{0.1.0,0.2.0}`, each a marketplace root (`.claude-plugin/marketplace.json` plus `plugin/`);
`<root>/current -> versions/0.1.0` registered with `claude plugin marketplace add <root>/current`; `chmod -R a-w` on both
version dirs for the `ro` run [observed: s-inst-ro.txt; the `rw` run, s-inst-rw.txt, is identical apart from directory
modes]. Findings:

1. **Where the code comes from.** `claude plugin list --json` reports `readFromFolder: <root>/current/plugin` and a separate
   `installPath` in the plugin cache. Hooks and the mod run from `readFromFolder`: `CLAUDE_PLUGIN_ROOT` and `$.plugin.root`
   were both `<root>/current/plugin`, the symlink path, not its resolved target [observed: s-inst-ro.txt]. The cache copy is
   bookkeeping. (A git-installed plugin is different: its root is the cache dir, §4.)
2. **Flip only (no `plugin update`).** After `flip.sh` pointed `current` at 0.2.0, the very next `claude -p` ran the 0.2.0
   hook scripts and the 0.2.0 mod (`mod=0.2.0 ver=0.2.0`) while `plugin list` still said `version: 0.1.0, folderVersion:
   0.2.0` [observed: s-inst-ro.txt].
3. **`plugin update` after a flip** printed `updated from 0.1.0 to 0.2.0 … Restart to apply changes`, moved the recorded
   install to a new cache dir (the old one got an `.orphaned_at` marker, not deleted), kept the saved options, and a second
   update said "read from its folder … nothing to update". It works with no `marketplace update` first [observed:
   s-inst-ro.txt].
4. **Rollback** (flip back to 0.1.0, then `plugin update`) printed `updated from 0.2.0 to 0.1.0`; the update follows the
   folder's version in either direction [observed: s-inst-ro.txt].
5. **Live session, mixed state.** In one interactive session the mod printed what it runs and what it reads
   [observed: s-inst-tui.txt]:

   | Step | Mod's own version | `VERSION` file read via `$.plugin.root` | Hook processes started now |
   |---|---|---|---|
   | session start (0.1.0) | 0.1.0 | 0.1.0 | 0.1.0 |
   | `current` flipped to 0.2.0, nothing else | **0.1.0** | **0.2.0** | **0.2.0** (after `/clear`) |
   | `/reload-plugins` | 0.2.0 | 0.2.0 | not logged |
   | `plugin update`, `/reload-plugins` | 0.2.0 | 0.2.0 | not logged |
   | flip back, update, `/reload-plugins` | 0.1.0 | 0.1.0 | not logged |

   So between a flip and the next reload a running session has the old module and the new files. `/reload-plugins`
   reported "Reloaded: 1 plugin · … · 2 hooks". The `plugin update` message says to restart, but a reload was enough here.
6. The `flip.sh` rename trick matters: `mv -fh tmp current` (BSD `-h`) replaces the symlink itself instead of moving the
   temp link into the directory it points to. From Node, `symlink(tmp)` then `rename(tmp, current)` does the same
   atomically [inferred for Node; shell form observed].

### 3.3 Read-only version dirs

With both version dirs `chmod -R a-w`, marketplace add, install, configure, update, rollback and a full live session
completed, and a diff of each version dir against a fresh copy was empty [observed: s-inst-ro.txt, s-inst-tui.txt]. It was
also empty with writable dirs [observed: s-inst-rw.txt], so Claude Code's install path never writes into the folder. The
cache copies it makes are writable (`drwxr-xr-x`) even when the source is read-only.

Dev mode differs [observed: s-ro-plugindir.txt]: `claude --plugin-dir <writable copy>` creates
`.claude-plugin/types/` (three `index.d.ts` files for `claude-code`, `claude-code-mcp` and `claude-code-tools`, plus a
`tsconfig.json` and a `.gitignore`) and `plugin/tsconfig.json`; on a read-only copy
it creates nothing and the mod still loads (`/wasitme` answered, exit 0). `claude plugin validate` (writable copy, plain
and `--strict`) wrote **nothing** [observed: validate.txt], so the reason the plan's update journey (step 3) gives for validating a temporary
copy ("validate may write type files") did not reproduce on 2.1.289. The copy is still harmless.

### 3.4 Plugin options (`userConfig`)

- A default of `~/.wasitme/glance.json` is **not tilde-expanded**: with defaults the pane read "unreadable"; after
  `claude plugin configure … --values-stdin` with the absolute path, the same file read fine [observed: s-inst-tui.txt,
  steps 1-2]. Install prints "2 userConfig options not yet set" and writes no `pluginConfigs` until configured.
- `configure --values-stdin` takes a JSON object of single-line strings and **keeps keys it is not given** [observed:
  s-inst-ro.txt, EXTRA 3]. `claude plugin configure <id> --json` returns `configured` and `unconfigured` arrays, usable by
  `wasitme doctor`.
- **Uninstall erases the options.** After `claude plugin uninstall`, `pluginConfigs` was `{}` [observed: s-inst-ro.txt], and
  `--keep-data` (which keeps only `plugins/data/<id>/`) did not keep it either [observed: s-inst-ro.txt, EXTRA 2].
- **`marketplace remove` while the plugin is installed also uninstalls it** and says "The removal also deletes their saved
  options, secrets and data where it can" [observed: s-inst-ro.txt, EXTRA 1]. This confirms a reviewer note in the plan's update journey,
  and shows uninstall itself is just as destructive.
- `update` and the in-place repoint (§4.3) both keep the options.

### 3.5 `claude plugin validate` on the fixture

`--strict` exited 0 on both the plugin and the marketplace; the `calls:` line it prints is exactly the ten calls the plan lists,
with one annotation [observed: validate.txt]:

```text
./register.tsx hooks: session.start, command.run{command=wasitme}, ui.render{component=Pane, requestId=wasitme}
./register.tsx calls: $.clock.after, $.clock.every, $.clock.now (via load), $.command.register, $.fs.read, $.state.get, $.state.set, $.ui.close, $.ui.open, $.ui.resolve
```

Two things WP-60's CI check must know:

- A call made through a helper is printed with **` (via load)`** (the helper's name). The allow-list comparison has to
  strip that annotation.
- A function that receives `$` must be a top-level function declaration (or a const bound to one). Declared inside
  `register()`, it fails: "`$` is passed to "load", which is not a function declared at the top of this file" [observed in
  validate.txt, negative control; `negative/register-helper-inside.tsx` is that mod, and `fixture/plugin/hooks/register.tsx`
  carries the rule as a comment].

## 4. S-GIT

Fixture repo: tracked files only, tags `v0.1.0` and `v0.2.0`, in a bare repo under the scratch directory [observed:
s-git.txt].

### 4.1 What `marketplace add` accepts

| Source given | Result |
|---|---|
| `file://<bare>` | **Refused:** "Invalid marketplace source format. Try: owner/repo, https://..., or ./path" |
| `<bare path>` (no scheme) | Fails: no `.claude-plugin/marketplace.json` at that path (it is read as a folder, not cloned) |
| `spike/wasitme`, `https://github.com/spike/wasitme.git`, `git@github.com:spike/wasitme.git` | `marketplace add` succeeds for all three; install and hooks were verified for the shorthand. The clone reached the local bare repo through a `url.<base>.insteadOf` rewrite in the throwaway HOME's `.gitconfig`; nothing left the machine. |
| `spike/wasitme#v0.1.0` | Works; `known_marketplaces.json` records `"ref": "v0.1.0"` and the log says `(ref: v0.1.0)` |
| `settings.json` `extraKnownMarketplaces.wasitme.source = {source: "git", url: "file://<bare>"}` | **Works, but only after a session starts.** `marketplace list` and `plugin install` do not see it before; one `claude -p hi` later it lists as "Git (file://…)" and install succeeds |

The last row is the literal "install from a bare git repo (file://)" the plan's spike list asks for. The GitHub-shorthand rows used
`insteadOf` and prove the clone code path, not GitHub itself (no public repo exists yet, D15), so the real
`claude plugin marketplace add draarivpatel-ui/wasitme` is verified only up to the clone.

### 4.2 Install, hooks and update from git

- The cache copy holds **tracked files only** (`.gitignore`d and untracked files were absent) [observed: s-git.txt].
- A git-installed plugin runs from the cache dir: `CLAUDE_PLUGIN_ROOT=…/plugins/cache/wasitme/wasitme/<version>`; no
  `readFromFolder` field [observed: s-git.txt]. Hooks ran from there in a headless session.
- **`plugin update` alone does nothing** ("already at the latest version") until `claude plugin marketplace update wasitme`
  re-clones; then `update` reports `updated from 0.1.0 to 0.2.0`. Source A (the GitHub-shorthand clone) was tried both ways;
  source D (the `file://` declaration) was run with both steps [observed: s-git.txt].

### 4.3 Switching from a git marketplace to the local symlink marketplace

Both use the name `wasitme` [observed: s-git.txt, "SWITCH" sections]:

- **Repoint in place (recommended).** With the git plugin installed and configured, `claude plugin marketplace add
  <root>/current` prints "Marketplace 'wasitme' was already added from github:spike/wasitme and now points at
  dir:<root>/current. Plugins already installed from it now update from the new source." The plugin stays installed and
  `pluginConfigs` is kept; `plugin list` then shows `readFromFolder`, and the next `plugin update` moved the recorded
  version to the folder's (0.2.0 → 0.1.0 in the test, because the folder was older).
- **Remove and re-add.** `uninstall` + `marketplace remove` + `add` + `install` works but leaves `pluginConfigs: {}`, so
  setup must re-save the options.

## 5. S-HK

All timings are wall-clock on a Mac that was running other work at the time, so they are noisy: the no-plugin `-p` baseline took
0.48 s in the pass quoted here and 0.75 s in a second full pass, and one interactive run showed 1.13 s to first prompt where
the others showed 0.55 s. The conclusions below held in both passes; the exact seconds will not. Recorder hooks log entry, stdin, exit or SIGTERM [observed: s-hk.txt,
s-hk-end.txt, s-hk-tui.txt, s-hk-resume.txt, s-hk-trust.txt].

### 5.1 stdin and environment

| Event | stdin keys | Values seen |
|---|---|---|
| SessionStart | `cwd, hook_event_name, session_id, source, transcript_path`; plus `model` only on an interactive `startup` | `source`: `startup`, `clear`, `resume` (both `--continue` and `--resume <id>`, same session id) |
| SessionEnd | `cwd, hook_event_name, prompt_id, reason, session_id, transcript_path` (`prompt_id` absent after ctrl-c) | `reason`: `other` (`-p`), `clear`, `prompt_input_exit` (`/exit` and ctrl-c) |

`cwd` was an absolute path in every case, including resume. Hook environment names included `CLAUDE_PLUGIN_ROOT`,
`CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CONFIG_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_PID`, and
`CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`. Values were not recorded; the product hook must never log
its environment. `CLAUDE_CONFIG_DIR` tells a hook which config dir the session uses.

### 5.2 Timing and cancellation

| Case (`-p hi`, not logged in, so the turn ends fast) | Result |
|---|---|
| No plugin | 0.48 s wall |
| Async SessionStart, instant | 0.58 s (+0.10 s); hook began about 0.25 s after launch |
| Async SessionStart sleeping 4 s | 0.66 s; hook got **SIGTERM 0.04 s after it started**, when `-p` exited |
| **Sync** SessionStart sleeping 3 s | **3.84 s**; the headless run waited for it |
| SessionEnd sleeping 3 s, plugin `timeout: 10` | cut by SIGTERM **1.5 s** after it started; run took 2.09 s |
| SessionEnd sleeping 14 s, `timeout: 10` | cut at 1.5 s again |
| SessionEnd sleeping 3 s, no `timeout` | cut at 1.5 s |

Interactive (tmux) [observed: s-hk-tui.txt]:

- The prompt is drawn at about 0.55 s whatever the hooks do. **A sync SessionStart hook sleeping 6 s held the first
  submitted prompt: its login-error line appeared 5.56 s after submit, 0.2 s after the hook exited. With a non-sleeping
  sync hook, or an async 6 s hook, the same line appeared 0.45 s after submit.** The measurement ends at the login error,
  so it proves "waits for sync hooks" and cannot prove an authenticated request waits (§9).
- **Async SessionStart hooks outlive an interactive exit.** With an 8 s async hook running, `/clear` did not touch it, and
  `/exit` or ctrl-c twice left it running; it finished about 8 s after it began, after Claude had gone. (Under `-p` the same
  hook was killed.) A **sync** hook still running at `/exit` got SIGTERM.
- `/clear` fires SessionEnd (`reason=clear`) then SessionStart (`source=clear`).
- **Quitting waits for SessionEnd.** With a 3 s SessionEnd hook, `/exit` took 2.09 s to return (hook cut at 1.5 s); with
  instant hooks 0.53 s.
- ctrl-c twice runs SessionEnd with `reason=prompt_input_exit`.

### 5.3 What sets the SessionEnd cut-off [observed: s-hk-end.txt]

The binary has a 1500 ms default, a 60 000 ms ceiling, an environment override `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`,
and a loop over SessionEnd hooks' own `timeout` fields [inferred, strings]. Five `-p` runs, each with a recorder that
sleeps 3 s:

| Case | Result |
|---|---|
| E1 plugin hook via `--plugin-dir`, `timeout: 10` | **cut at 1.53 s** |
| E2 as E1 plus `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=10000` in claude's environment | ran the full 3 s |
| E3 the same script declared in `settings.json` with `timeout: 10`, no plugin | ran the full 3 s |
| E4 plugin installed from a directory marketplace, `timeout: 10` | **cut at 1.51 s** |
| E5 plugin hook plus an extra instant SessionEnd hook in `settings.json` with `timeout: 10` | ran the full 3 s |

So a `timeout` on a **plugin's** hook is ignored for the SessionEnd budget; one on a **settings.json** hook counts, and
(E5) lifts the shared budget for plugin hooks too. wasitme cannot set the person's settings, so its SessionEnd gets 1.5 s.
`docs/research/03` line 35 ("raised up to 60s if a hook sets `timeout`") holds only for settings-level hooks.
The plan's `timeout: 10` is therefore inert, though harmless.

### 5.4 Folder trust

In a folder the person has not trusted, Claude Code shows "Quick safety check: Is this a project you created or one you
trust?" with "No, exit" as the default. **No hook ran while that dialog was open (0 recorder lines, also 3 s later); after
"Yes, I trust this folder" the SessionStart hook began 0.18 s later.** Choosing "No, exit" ran no hooks at all, not even
SessionEnd [observed: s-hk-trust.txt, second phase]. In an interactive session the hook therefore
never reads a folder the person has not approved. Headless `claude -p` has no dialog, and its hooks ran at once in every
`-p` case above; Claude Desktop is untested (S-DESK).

## 6. S-ROWS

`PaneOpenArgs` in the declaration file Claude Code itself writes (`.claude-plugin/types/claude-code/index.d.ts`) has
`rows?: number`. Its doc comment says, in short: it is a request, not a grant (a size the person dragged or keyed wins);
it takes a positive whole number; left out, the pane gets a third of the layout; each open sets it anew [observed:
s-rows.txt, which prints the declaration lines].

- **Type check** with `tsc` against that file: the fixture, which passes `rows: wanted`, compiles (exit 0). Negative
  controls fail as they should: `rows: 'six'` gives TS2345 (string not assignable to number) and a made-up option gives
  TS2353 [observed: s-rows.txt].
- **Live** (detached tmux, a pane with 30 body lines so it is always taller than the request; frame height counts the top
  to bottom border):

  | `/wasitme N` | 200x50 terminal | 120x30 terminal |
  |---|---|---|
  | none (default) | 16 lines | 10 lines |
  | 6 | 8 | 8 |
  | 12 | 14 | 14 |
  | 20 | 22 | 19 |
  | 40 | 34 | 19 |

  Height is `rows + 2` until the layout's cap (34 and 19 here); the default is about a third of the terminal [observed:
  s-rows.txt]. The mod's `$.ui.open` call returned `placed=true` in the `rows=7` call of s-ro-plugindir.txt.

## 7. Edits this implies in the build plan and research

The build plan is the orchestrator's internal document, so these are listed, not applied.

1. **Guided setup, step 5**: replace "Claude Code says: <exact warning text, captured in S-INST>" with the generic text of
   §3.1, followed by wasitme's own sentence that the plugin includes a mod running inside Claude Code with the person's
   permissions, plus the `calls:` line.
2. **Update, step 3**: drop the claim that `validate` writes type files (it did not); `--plugin-dir` does. Keep the temp
   copy if desired.
3. **Update, steps 6-7**: add that flip alone takes effect for new hook processes immediately and for the mod at the next
   `/reload-plugins` or session; `plugin update` is bookkeeping; open sessions are in the mixed state until reloaded. The
   "inferred" flip-only note can become "[checked]".
4. **Update, "never runs marketplace remove"**: add that `uninstall` and `uninstall --keep-data` also erase options, so
   any reinstall path re-runs `configure --values-stdin`.
5. **Update, step 8, and the architecture section**: no `chmod` problem exists for Claude Code; its cache keeps superseded copies, marked `.orphaned_at`
   (how long they stay was not measured); wasitme should not delete inside Claude's cache.
6. **Privacy and security, Hooks, SessionEnd**: "`timeout: 10`" is ignored (§5.3). SessionEnd must finish in well under 1.5 s and trap TERM;
   it also delays quitting by its own runtime.
7. **Privacy and security, Hooks, SessionStart**: confirmed async-only. Add that interactive exit does not cancel it (so it can overlap the scan
   the SessionEnd hook kicks), `-p` exit does, and it never runs before folder trust.
8. **Privacy and security, Mod, Disclosure**: also state that `homepage` adds an "Open homepage" row and `description` is the only prose on the
   trust screen.
9. **Privacy and security, userConfig**: setup writes an absolute `snapshotPath`; `~` is not expanded.
10. **Spike list, S-GIT**: the literal `file://` bare-repo install is the settings.json declaration route of §4.1.
11. **`docs/research/03` lines 26 and 35**: corrected in place with pointers to this file.

## 8. Proposed DECISIONS lines

Numbers are the orchestrator's to assign; these are proposals, not recorded decisions.

- **P-A (trust text).** Claude Code's install dialog (2.1.289) shows only its generic "make sure you trust a plugin"
  warning, with no mod-specific text. wasitme's setup step 5 and README carry the mod disclosure themselves (the frozen
  `calls:` line and "runs inside Claude Code with your permissions"); `plugin.json` `description` states in one plain
  sentence what the plugin does (a pane that reads one local file, two hooks, no network), and `homepage` points at the
  privacy page.
- **P-B (options).** Setup writes `snapshotPath` as an absolute path via `claude plugin configure wasitme@wasitme
  --values-stdin` straight after install; `wasitme doctor` checks `configure --json` for `unconfigured`.
- **P-C (never remove).** wasitme never runs `claude plugin uninstall` or `marketplace remove` during update or switch, since
  both erase saved options (`--keep-data` does not help). Switching from a GitHub-registered marketplace repoints with
  `claude plugin marketplace add ~/.wasitme/current` and then `claude plugin update wasitme@wasitme`. `wasitme uninstall`
  accepts that the options go.
- **P-D (update order).** Update = atomic flip of `current` (symlink + rename) → `claude plugin update wasitme@wasitme` →
  tell the person to run `/reload-plugins` or restart open sessions. The contract-version check covers the mixed old-mod,
  new-files window.
- **P-E (SessionEnd).** The SessionEnd hook finishes in well under 1.5 s (a `launchctl kickstart` and nothing else), traps
  TERM, and does not rely on `timeout`; the `"timeout": 10` line is dropped or kept only as inert documentation.
- **P-F (SessionStart).** The SessionStart hook stays async (sync blocks the first prompt for its whole runtime). Ingest
  stays idempotent: `-p` exit kills the hook, interactive exit does not, and a surviving hook can overlap the scan.
- **P-G (rows).** `rows` is allowed on `$.ui.open` (typed, honored up to the layout cap, default a third); buttons-first
  remains the design.
- **P-H (test harness).** Plugin-install tests use throwaway `HOME` + `CLAUDE_CONFIG_DIR` under `env -i`; a git
  marketplace is tested by declaring a `file://` git source in the throwaway `settings.json` and starting one session
  (`marketplace add` rejects `file://`). End-user docs use `claude plugin marketplace add draarivpatel-ui/wasitme`.
- **P-I (validate in CI).** The CI `calls:` comparison strips the ` (via <helper>)` annotation; helpers that receive `$`
  must be top-level function declarations.

## 9. Not verified, and limits

- **Authenticated behaviour.** Whether a sync SessionStart hook delays an authenticated model request; behaviour after a real
  model turn (resume was tested on a transcript that ended at the login error); the `compact` source and the Stop hook.
- **Real GitHub.** Clones were redirected to local bare repos (`insteadOf` or a `file://` URL). No repo is public (D15), so
  the GitHub round trip itself, including `gh` and attestation steps, is untested.
- **Claude Desktop.** Everything here is the terminal CLI 2.1.289. Whether the Desktop Code tab loads CLI-installed plugins,
  runs the same hooks, or shows the same trust screen is S-DESK (needs the maintainer).
- **Version drift.** Strings, flags and screens can change in a later release. The evidence files name the version; re-run
  `run-all.sh` after any Claude Code update that matters.
- **[inferred] items.** The SessionEnd budget mechanism (read from binary strings, then confirmed by the five cases of §5.3,
  which measure behaviour but not the source), the warning string being a literal in the binary, the Node form of the
  atomic flip, and the repoint-before-update hook root (not captured). The `--keep-data`, `--values-stdin` and `--json`
  flags were read from `--help` and then run.
- **Timing noise.** The numbers in §5.2 are single runs on a shared Mac. Use them for order of magnitude (0.2 s versus 1.5 s
  versus the hook's full length), not as benchmarks.
- **Not tested at all.** `claude plugin test`, `claude plugin tag`, auto-update settings for third-party marketplaces, and
  managed-settings restrictions such as `allowManagedModsOnly`.

## 10. Reproduce

`sh spikes-tracked/claude-plugin/scripts/run-all.sh <scratch-dir> <evidence-dir>`, about 10 minutes; see
`spikes-tracked/claude-plugin/README.md` for the script table and the isolation rules. The evidence files are from
`run-all.sh` passes on 2026-10-04 with Claude Code 2.1.289 (a few spikes were re-run on their own after script fixes). A final
full pass in a fresh scratch directory matched them line for line once timings, process ids and dates were masked, and gave
the same headline numbers: SessionEnd cut at 1.5 s, a sync SessionStart hook holding the first prompt for 5.4 s against
0.5 s for the controls, and the same pane heights.
