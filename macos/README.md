# macos/ - the native app (Case File brand, WP-50)

Swift package, Swift 6 language mode, macOS 14+. Zero third-party dependencies, no network APIs of ours.

| Target | What it is |
|---|---|
| `WasitmeCore` (library) | Contract models, **display rules** (`Display/GlanceDisplay.swift`, `TextSanitizer`, `AppCopy`), file store, engine runner, panel placement, LaunchAgent plist, launch-at-login interface. Foundation + CoreGraphics + Observation + ServiceManagement only. |
| `WasitmeUI` (library) | The shell: status item, popover panel, desktop panel, Control Center (a standard Mac window: title bar, unified toolbar, native sidebar, main menu, and the locked-down WKWebView canvas showing only the page), single-instance guard, `--capture`, memory probe. AppKit + SwiftUI + WebKit. |
| `WasitmeApp` (executable) | `main.swift` (options, `--self-check`, then `AppMain.run`). |
| `WasitmeCoreTests`, `WasitmeUITests` | swift-testing (also with Command Line Tools alone, see below; XCTest is not needed). |

## The brand (design/system/, D44/D57)

- **`Sources/WasitmeUI/Theme/Generated/Tokens.swift`** is a byte copy of `design/system/generated/Tokens.swift`, written by
  `node macos/scripts/sync-design.mjs` (never by hand). It carries everything the app draws with: palette, type roles with
  PostScript names (`Tokens.TypeScale`), space, radii, strokes, sizes (`Tokens.Size`), chart constants, copy, the finding states
  (with chip edge styles) and the app states (`Tokens.AppState`), and every 16/18 px glyph as vector primitives
  (`Tokens.Glyphs`). Nothing is generated in macos/ any more (the old `DesignExtras.swift` moved upstream into the design
  generators). `WasitmeUITests/DesignSyncTests` fails when the copy drifts or `Generated/` holds anything else;
  `build-app.sh` runs `sync-design.mjs --check`.
- **`Theme/Theme.swift`** builds `Theme.current` from it: palette (appearance-aware), the type roles (IBM Plex, with the
  CSS line boxes), space, radii, strokes, sizes, the state chip styles and the app states' quiet chip. `Metrics.menuBarDimmedAlpha`
  is the one app-only value. `WasitmeUITests/ThemeTests` fails if a colour/font/symbol literal, `Font.custom` or an
  `NSBezierPath` appears anywhere else.
- **`Theme/GlyphRendering.swift`**: `CaseFileGlyphRenderer` draws every glyph (the six finding states, the six app states,
  the mark) from `Tokens.Glyphs` as template images on their own 16 / 18 px grids. The app states (loading, not set up, no
  agents, can't read, update needed, not shown) change the rule itself and never put a square above or a triangle below it
  (design/system/DESIGN.md §6).
- **Type**: `Theme/FontRegistry.swift` registers the six IBM Plex TTFs for the process at launch (CTFontManager), from
  `Contents/Resources/fonts/` (build-app.sh copies `design/system/fonts/app/*.ttf` + `OFL.txt`), or `design/system/fonts/app`
  for an unbundled binary. `Font.custom` falls back to the system font silently, so capture and the tests check it.
- **Surfaces**: the popover and the desktop panel are drawn after `design/system/screens/popover-*.png` and
  `desktop-panel-*.png`; the menu bar shows the template glyph plus "+n" new changes as text beside it. Right-click the status
  item for Check Again / Open wasitme / desktop panel / Quit (the designed popover has no room for them).
- **The canvas** (WP-41): `ui/dist/{app.html, app.js, app.css, fonts/}` is served from `<App>.app/Contents/Resources/ui/`
  (build-app.sh copies it), or from `--canvas DIR`; else a placeholder page compiled into the binary (`Canvas/PlaceholderCanvas.swift`,
  which documents the bridge contract). Data in: `render(snap, view)`, each ONE JSON string (D48); `view` carries `chrome:
  "content"` (the app draws the window chrome natively, the canvas only the page), `launchAtLogin`, `now`, `timeZone` and
  `settings` (codes only, UX-V2 §10.2: `version`, `installed`, `answered`, `integrations[{id, state, why?}]`, `desktopPanel`,
  `launchAtLogin` true/false/null, `update{available, why?}`, `canClearHistory`, `busy`; from `install.sh --status --json`).
  Data out: named actions only, each with exactly its keys: `setLaunchAtLogin` / `setDesktopPanel` + `enabled` (or `value`),
  `revealDataFolder`, and the Settings requests `removeIntegration` / `addIntegration` + `integration` (or `id`: `app`,
  `scan`, `claude-plugin`, `codex-plugin`, `statusline`; the app is never added from here), `clearHistory`, `uninstallAll`,
  `updateApp`. Those only ever reach a native NSAlert (`App/GuardedActions.swift`); a yes there is the only way to a
  `GuardedConsent`, and `App/SettingsPerformer.swift` runs it: `/bin/sh ~/.wasitme/current/scripts/{install,uninstall}.sh`
  with a fixed argv and `--from-app` (detached; followed through `state/last-action.json`), or the engine's
  `history clear --yes --json`. Removing the app or uninstalling quits the app once the run has started. Also `copyReport` and
  `openMarkdown` (`Canvas/ReportExporter.swift`: pasteboard, or a 0600 `.md` in `$TMPDIR/wasitme-reports/` opened in its default
  app; never a URL). The report's Markdown is the engine's own: `EngineReportSource` runs `report --md [--agent ID] --json` and
  takes its `markdown` field (WP-30, merged); if the engine can't produce one, the app says the report isn't available and copies
  or opens nothing. The canvas's Report page is a summary of that report in the same order, and says so.
- **App icon**: build-app.sh renders `design/system/glyphs/appicon-1024.svg` with `sips` into an iconset and `iconutil`
  makes `Contents/Resources/AppIcon.icns`.
- **One resource list**: build-app.sh and the installer (`scripts/lib/macos.sh`) both copy the page, the fonts and the
  icon through `scripts/lib/app_bundle.sh`, so a resource added there reaches both bundles.

## Offscreen capture (all visual verification)

```sh
macos/.build/debug/WasitmeApp --capture <dir> [--fixtures contract/fixtures] [--canvas ui/dist]
```

Activation policy `.prohibited`: no window is ordered in, no status item, no Dock icon, no focus change. For every entry in
`contract/fixtures/manifest.json`, at the manifest's `now`, in light and dark, it writes `<golden>--<view>--<appearance>.png`:
`menubar`, `popover`, `panel-small`, `panel-medium` for the 29 glance goldens (incl. tamper: mismatch/refused), and
`control-center` for all 34 (snapshot goldens feed the canvas, 1280×800, the page only: `chrome: "content"`), the same four views
plus `control-center` for the three app states no golden produces (`app-loading`, `app-not-set-up`, `app-unreadable`), plus
`glyphs--light|dark.png`, plus `<golden>--window--<page>--<appearance>.png`: the WHOLE Control Center window (title bar, window
buttons, unified toolbar, native sidebar, the page) for six golden/page cases (`CaptureRunner.windowCases`), built by
`ControlCenterWindow.make` and drawn from its frame view with `cacheDisplay`, the page composited from the web view's snapshot,
plus `sheet--<name>--light.png`: three Settings confirmation sheets (`CaptureRunner.sheetCases`, the real NSAlert from
`WindowAlertPresenter.alert(for:)`, checked for its buttons, Cancel default and checkbox; light only, because offscreen the
alert's material draws light under dark text) (347 PNGs). The window is never ordered in. Offscreen artefacts, not bugs: the window buttons come out grey (or coloured with
their hover glyphs), the toolbar icons draw as in an inactive window, and the sidebar's behind-window material is flat. There
is no flag that opens the window on screen for a screenshot, on purpose. Pass `--canvas ui/dist` from a .build binary, or it shows the placeholder page. AppKit/SwiftUI
views are drawn with `cacheDisplay`, the canvas with `WKWebView.takeSnapshot` (verified to work with no window at all). It also
checks that the IBM Plex faces registered, runs the S-WEB checks (app.js DOM marker; inline-script canary blocked by the CSP
*header*; remote fetch and image blocked; navigation denied; an unknown bridge action rejected; a destructive request only reaches
the native side as a request, which shows a native sheet and runs nothing; copyReport/openMarkdown arrive as named actions; chrome
"content" draws only the page), checks each window image's structure (the page below the toolbar, no full-size content view,
never shown), checks memory, and writes `index.json`.
Exit 0 = every check passed, 1 = a check failed, 2 = fixtures not found.

**Memory (D48, RSS):** capture probes the process before anything is drawn (idle: ≤60 MiB RSS) and
after opening the canvas on the first shown snapshot golden, settled 3 s, before any native PNG or `takeSnapshot` (Control
Center open: app + WebContent ≤180 MB RSS). Every report carries RSS (`ri_resident_size`) and `phys_footprint`. A release
build (`swift build -c release`) fails the capture on a budget that is over; a debug build prints PASS/OVER only. Measured
2026-10-05, release: idle 33.6 MiB; Control Center 116.1 MiB (app 67.7 + WebContent). The probes after the QA drawing are
labelled QA-only (takeSnapshot inflates both processes; D48 keeps it out of the shipping path). The capture process has no
status item or file store, so the live hook is the real idle check: `--memory-report <file> [--memory-report-after <sec>]`
writes the running app's RSS and footprint (plus WebKit helpers started since launch) after that many seconds, labelled
`idle` or `control-center-open`.

`scripts/ci-local.sh --only app-capture` (or `--capture` / `CI_LOCAL_CAPTURE=1` on a full run) does the release build and
this capture with `--fixtures contract/fixtures --canvas ui/dist` (building `ui/dist` if it is missing), both through
`scripts/dev/heavy.sh`. It fails on a budget line that says OVER, on any failed capture check, and when no enforced budget was
reported. It is opt-in and macOS-only; `CI_LOCAL_KEEP_LOGS=1` keeps the PNGs and `index.json`.

## Build, test, assemble

Heavy jobs go through the repo serializer (one at a time, low priority):

```sh
scripts/dev/heavy.sh swift build --package-path macos
scripts/dev/heavy.sh swift test  --package-path macos
scripts/dev/heavy.sh macos/scripts/build-app.sh          # release build -> macos/dist/WasitmeApp.app, ad-hoc signed, NOT launched
```

Command Line Tools only (no Xcode): prefix with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`
and add `--scratch-path macos/.build-clt` so the two toolchains do not share a build directory.
`swift build` then works as is. `swift test` needs three extra pointers, because SwiftPM does not pass
the swift-testing macro plugin or framework paths for this toolchain (verified 2026-10-04: without them
the compile fails with "plugin for module 'TestingMacros' not found"; with them all tests pass):

```sh
CLT=/Library/Developer/CommandLineTools
DEVELOPER_DIR=$CLT scripts/dev/heavy.sh swift test --package-path macos --scratch-path macos/.build-clt \
  -Xswiftc -plugin-path -Xswiftc $CLT/usr/lib/swift/host/plugins/testing \
  -Xswiftc -F -Xswiftc $CLT/Library/Developer/Frameworks \
  -Xlinker -F -Xlinker $CLT/Library/Developer/Frameworks -Xlinker -rpath -Xlinker $CLT/Library/Developer/Frameworks
```

Headless wiring check (no window, no status item, no focus change):

```sh
macos/.build/debug/WasitmeApp --self-check --home <dir> [--engine scan|report|compare|statusline|doctor]
```

## Files the engine and the app exchange (`~/.wasitme`, or `--home <dir>`)

| File | Writer | Reader | Contract |
|---|---|---|---|
| `glance.json` | engine (atomic rename) | app | `contract/glance.v1.schema.json` |
| `snapshot.json` | engine (atomic rename) | app | `contract/snapshot.v1.schema.json` |
| `engine.json` | installer | app | below (no schema in `contract/`; `EngineConfigLoader` is its reader) |

`engine.json` - how the app finds the engine, written 0600 by the installer (D46). Absolute paths only (`~` is not
expanded; a GUI app has no useful `PATH`). The fields the app reads (the installer writes a few more, for doctor):

```json
{ "schema": "wasitme.engine/1", "version": "0.1.0", "node": "/opt/homebrew/bin/node",
  "cli": "/Users/me/.wasitme/current/engine/dist/src/cli/main.js",
  "scanArgs": ["--permission", "--allow-fs-read=/Users/me/.claude*", "--allow-fs-read=/Users/me/.codex*",
               "--allow-fs-read=/Users/me/.wasitme", "--allow-fs-write=/Users/me/.wasitme"],
  "scanCli": "/Users/me/.wasitme/current/engine/dist/src/cli/main.js",
  "claudeDir": "/Users/me/.claude", "codexDir": "/Users/me/.codex" }
```

The app runs `node <cli> <action> --json` (action in scan, report, compare, statusline, doctor), with no shell, an
environment built from nothing, a 60 s timeout, 8 MB output cap and a process-tree kill. A **scan** ("Scan now",
`--self-check --engine scan`) is `node [scanArgs] <scanCli> scan --no-project-files --json`: the same Node sandbox and
grants as the background scan, and never project files (SECURITY.md). `scanCli` is the CLI spelled through the resolved
`~/.wasitme` (under the sandbox, node must not need a stat on a symlinked folder above the grants). `scanArgs` is
allow-listed by form: exactly one `--permission` / `--experimental-permission` plus `--allow-fs-read=` /
`--allow-fs-write=` grants on single absolute paths, with every write grant on wasitme's own folder (compared by
realpath). An absent key (an older engine.json) or `[]` (this node has no permission model) means an unsandboxed scan;
any other value makes engine.json unusable rather than silently dropping the sandbox. The sandbox is checked against a
real node in `EngineRunnerTests` (the scan writes its folder, can't read /etc, can't start processes). The grants are
the folders the installer saw (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` at install time, else `~/.claude*` / `~/.codex*`),
and the installer records those same folders in `engine.json` (`claudeDir`, `codexDir`), in the same write as `scanArgs`,
so the folder the app tells the engine to read and the folder the sandbox lets it read come from one place. A GUI app
doesn't inherit shell exports, so the engine's `CLAUDE_CONFIG_DIR` / `CODEX_HOME` are chosen like this
(`EngineEnvironment.make`), each variable on its own:

1. the app's own environment, when it has a non-blank value: the installer's LaunchAgent sets them for a custom folder
   (`scripts/lib/macos.sh`), and a shell sets them if the app was started from one;
2. otherwise the folder recorded in `engine.json`, which is what an app opened from Finder or Spotlight gets (it has
   neither a shell nor the LaunchAgent environment);
3. otherwise nothing, and the engine uses `~/.claude` / `~/.codex`.

A recorded folder must be an absolute path with no control characters and at most 4096 characters (`~` is not
expanded), the same rule as every other path in `engine.json`. One that fails is ignored rather than making
`engine.json` unusable. The default folders (`<HOME>/.claude`, `<HOME>/.codex`) are never passed on, exactly as the
installer never sets the variables for them: setting `CLAUDE_CONFIG_DIR` to the default would make the engine look for
Claude Code's global state file inside it (`~/.claude/.claude.json`) instead of at `~/.claude.json`. Known gap, now
narrower: the app's own environment wins (rule 1), so an app started from a shell whose `CLAUDE_CONFIG_DIR` /
`CODEX_HOME` name a folder other than the one the installer saw still reads that folder, and the sandboxed scan can't
read it (re-run the installer after changing them).

## Decisions worth knowing

- **Directory watch, not file watch**: the engine replaces files atomically, which orphans a watch on
  the file's own inode. `GlanceStore` watches the directory and also polls every 60 s.
- **Stale** = glance older than its `staleAfterSec` (default 2 h) or more than 5 min in the future (clock set
  back); ages are never negative. The last known state is shown dimmed, never as current.
- **Display rules** (docs/CONTRACT.md) are applied once, in `GlanceDisplay.make`, and every surface renders
  that value: mismatch (not a JSON object, or not the EXACT id `wasitme.glance/1`: minor ids like `/1.2` are
  reserved and a mismatch, D45) → "Update needed." + "This version can't read the status file's format. Run
  `wasitme update` in Terminal." (commands are drawn in the mono face, never with backticks); refused
  (`SourceStatus.refused`, also drops the last good glance); stale; empty (own glyph, not `unclear`); ok. `scanOk: false`
  keeps the state glyph, drawn dimmed, with "Last scan failed (…)." and a "See Sources" button that opens Sources in the
  Control Center. `.invalid` now means only an OS-level read problem (too
  large, not a regular file); its last good glance is shown as "last known". Unknown verdict states decode as `unclear`.
- **Every engine string is plain text**: `TextSanitizer` strips whole escape sequences, bidi/invisible/control/
  private-use characters, caps combining marks and bounds length; views use `Text(verbatim:)`.
- **Canvas lockdown** (D48): `wasitme-app://canvas/` scheme handler with the CSP as a response header
  (enforced for custom schemes, verified), non-persistent data store, Safe Browsing off, a content rule list
  blocking http(s)/ws(s)/ftp/file (compiled into a temp store, nothing under ~/Library), navigation/new
  windows/JS dialogs denied, one constant render script with data in `arguments`, named actions only;
  destructive actions are not wired in v1 (WP-70): the canvas offers none (Settings names the Terminal uninstaller
  instead), and a request that still arrives only shows a native sheet with that command; nothing asks to confirm an
  action it can't run.
- **Single instance**: `flock` on `$TMPDIR/wasitme-<hash(bundle id + home)>.lock` plus
  `NSRunningApplication` by bundle id; a second launch posts `dev.wasitme.app.reopen` (the first opens its
  popover) and exits.
- **LaunchAgent vs. login item**: pick one. `LaunchAgentPlist` (KeepAlive on crash only) is the
  dogfooding path; `LaunchAtLoginControlling` (SMAppService) is the end-user path and is stubbed.
- **Privacy gate fails closed**: a glance or snapshot is read only if it says `privacy.containsText: false`
  (a boolean). A missing block, a missing field and a wrongly typed value (the string `"false"`) are
  refused exactly like `true`.
- **Process runs are bounded on a monotonic clock** (never `Date`, so a stepped clock cannot give a
  negative duration or stretch a grace period): the child's lifetime by the timeout (SIGTERM, then
  SIGKILL after the grace), and its pipes after it exited by at most one further second (never past the
  timeout, apart from a 0.1 s floor so buffered output is still collected). A grandchild that inherited
  the pipes, silent or chatty, cannot hold a run open. After a clean exit the result is still the child's
  own: its status and the output read so far. The read ends are then closed, so the grandchild's next
  write fails.
- **Toolchain traps** (from the spikes): avoid SwiftUI `@State` / `@Entry` / `#Preview` macros (they need
  full Xcode); `@Observable` + `@Bindable` are fine. SwiftPM stamps the deployment target as the SDK
  version, which makes AppKit use the old look: `build-app.sh` re-stamps it with `vtool`.
