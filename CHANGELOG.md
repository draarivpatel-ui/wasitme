# Changelog

All notable changes to wasitme are recorded here, newest release first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

Unreleased changes are kept as one small file each in `changelog.d/` (see its README) and are folded in here when a
release is cut.

## 0.1.0 - 2026-10-08

### Added

- **The Mac app draws the agent's tag at its design size.** In the popover's and the desktop panel's evidence strip
  the agent's pointed tag is now the design system's 20 × 22 (it was drawn one point taller, 23), read from the shared
  size token instead of hand-written coordinates.
- **The Mac app's Control Center stops retrying a canvas that keeps stopping, and says so.** When the canvas's web
  content process stops before the page comes up, the app loads it again up to three times in a row; after that the
  window says the canvas isn't shown instead of staying blank while new processes are started over and over, and
  closing and reopening the window tries once more. A canvas that came up and was later reclaimed by the system is
  reloaded as before.
- **The Mac app finds a custom Claude Code or Codex folder even when you open it yourself.** If you keep an agent's
  files somewhere other than `~/.claude` or `~/.codex` (you set `CLAUDE_CONFIG_DIR` or `CODEX_HOME`), the installer
  records that folder in `~/.wasitme/engine.json`. The app now uses the recorded folder whenever it was started without
  those variables, which is the case when you open it from Finder or Spotlight instead of letting its login item start
  it; before, only the login-item copy knew about the folder and a scan started from a hand-opened app looked in the
  default folders. A value in the variables always wins, a recorded value that is not an absolute path is ignored, and
  nothing changes if you use the default folders.
- **The Mac app's Settings actions run from the app, each after a native confirmation.** Adding or removing a part
  (the Claude Code plugin, the status line, the Codex skill, the background scan, the menu bar app), clearing the saved
  history, uninstalling everything and updating now go through the installer, the uninstaller or the engine with a fixed
  command, and only after you say yes in a macOS sheet that names what happens and what is kept. Destructive ones are
  drawn as such, with Cancel as the default; uninstalling offers "Also delete my saved history", off by default. Removing
  the app or uninstalling quits the app once the change has started. Update stays unavailable until the first public
  release. Showing or hiding the desktop panel and "Show in Finder" for the saved history work without a sheet. The page
  is sent what is installed (from `install.sh --status --json`) so it can show each control's state.
- **The Mac app's own states have their own glyphs.** Loading, not set up, no agents, can't read the status file,
  update needed and not shown each change the menu-bar rule itself (three dots, empty brackets, a ticked rule, a rule
  and an exclamation mark, two rules out of step, a blacked-out rule) and never put a square above it or a triangle
  below it, so none of them can be read as a finding.
- **Who moved: the engine decides between your side, the agent's side, or "can't tell which".** When enough
  indicators shift together, it finds the days the shift began, lists the changes recorded around then, and works
  through a fixed 14-row table: a change you made by command or in settings points to your side; a model or effort
  switch the logs can't attribute (the Desktop picker, a launch flag) gives "can't tell which"; an agent update alone
  only counts when the shift shows up at that exact update in at least two projects on days wasitme fully observed.
  A finding on the glance only moves once two evaluations at least a day apart, with fresh data, agree. The
  experimental agent-side tripwires stay off.
- **Findings are on for Claude Code and for Codex.** wasitme's own tests passed for both agents, on synthetic logs only
  (`docs/calibration/2026-10-05.json`): in each of seven profiles, 1,000 users whose setup and agent did not change in
  effect were followed for 90 daily evaluations, and none ever saw a false change or a false agent-side finding (95%
  upper bound 0.37%, against limits of 6% and 2%). So a new install shows "Too early to tell", with what is still
  missing, rather than "Timeline only". Power is low for people with a few very long sessions, sparse failures, or
  Codex (a planted doubling was found in 7 to 10 of 40 runs, against 34 to 39 of 40 for many short sessions). Not yet
  measured: how often the rules misfire on real logs, the coverage of the printed range, and the attribution limits
  on the final decider (`docs/METHOD.md`).
- **The Control Center's keyboard focus ring shows on every control, and dimmed markers stay readable in dark mode.**
  The focus ring on the sidebar's page buttons and on the agent switcher was clipped by the sidebar (only its top and
  bottom, or one side, showed); it is now drawn inside those buttons, light on the selected segment. In the stale
  "last known" state on the dark theme, a marker's letter was near-black on a dark tint (1.2:1); it is now muted ink
  (5.0:1 or better in both themes). The wordmark is read as one word, "wasitme". `ui/test/a11y.mjs` checks the
  accessibility tree Chrome exposes, the contrast of every text run as rendered, the focus ring's pixels and motion.
- **Charts keep change badges apart, however often you change your setup.** On each side of the case line, several
  changes on one day, or on days too close for separate badges, are grouped into one range badge ("18–21", "X–Z") over
  the days it covers. The change that lines up with the shift keeps its own numbered badge. Changes of unknown origin
  are a faint tick on the line. The menu bar popover and the desktop panel group the same way. At the narrowest window
  the chart scales down, so its badges get small, but they never overlap. The change lists, the hover tips, the
  chart's text description, the report and the terminal name every change with its own number or letter.
- **`scripts/ci-local.sh` can check the Mac app's memory budgets.** The new `app-capture` step builds the app in release
  mode, runs its offscreen capture against the contract fixtures and the canvas, and fails when a memory budget is over,
  when a capture check fails, or when no enforced budget was reported. It takes minutes, so it is opt-in (`--capture`,
  `CI_LOCAL_CAPTURE=1` or `--only app-capture`) and macOS-only; otherwise it is listed as skipped.
- **The Claude Code plugin draws the design system's case line, and `/wasitme:report` runs the installed engine.**
  `/wasitme` opens a pane with the buttons first, then (timeline-led by default) what changed: your changes on numbered
  canary stickers above a dashed rule, the agent's on lettered blue stickers below it, with each day's counts under
  it; then the Finding with its state glyph, what is still missing (never a projected date) and the signals. The
  report skill runs the plugin's own `scripts/run.sh`, which uses only the absolute engine the installer recorded
  (never a `wasitme` found on PATH) and prints one plain line when wasitme is not installed. The mod's frozen list of
  calls is fixed at ten.
- **`wasitme` shows the findings, and there is a shareable report.** `wasitme` prints a 100-column terminal report for each agent (timeline-led by default, `--lead` switches to the finding first; colour follows NO_COLOR, pipes and the terminal's own capabilities), `wasitme status` prints the one-line state, `wasitme report` writes the numbers-only evidence report as Markdown or as one self-contained HTML file (no script, a CSP that names the style hash), `wasitme report --format json` gives the local snapshot (exact times and local ids: for your own tools, not share-safe), `wasitme demo` shows engine output over the design system's demo data with a DEMO marker, `wasitme doctor [--redacted|--toolchain|--repair]` says what state wasitme is in without printing a path, `wasitme exclude add|list|remove` keeps days, projects or entry points out of the analysis, and `wasitme update` says how to update (it downloads nothing: the newer release's installer does). When there is nothing to show, every surface says why (no results yet, no logs found, logs not readable, a damaged or other-version results file) and names the one command that helps; `wasitme status` and `wasitme doctor` then exit 1, so a script can tell. Every command accepts a trailing `--json`; `report --md --json` returns `{"markdown": "…"}`, which is what the Mac app reads. `compare` is not in this build.
- **`--help` works after any command, and usage errors say what to type instead.** `wasitme report --help` (or `-h`,
  after any command) prints the usage and exits 0 instead of failing as an unknown option; `-v` prints the version like
  `--version`; an unknown command is named when it is a plain word (`unknown command "repot"`); `--agent` with an agent
  that is not in the results lists the ones that are; and `statusline install` without the status-line script says that
  the installer puts it in place.
- **A skills-only Codex plugin, `wasitme@wasitme-codex`.** It lives in its own marketplace root (`plugin-codex/`) with
  no hooks, and its one skill runs the installed wasitme's report for Codex. It needs the full install. Both of its
  manifests are generated from one source with the engine's version, and updates re-register the marketplace, because
  Codex records the resolved folder rather than the `current` link.
- **The Codex report says plainly when wasitme has no Codex sessions yet.** `wasitme report --agent codex` (what the
  Codex skill runs) on results that hold only Claude Code used to stop with a usage error and the whole help text; it
  now prints one line saying the results hold no Codex sessions yet, where wasitme looks for Codex logs, and that
  `wasitme doctor` helps. An agent id wasitme does not know is still a usage error. The Codex skill now tells a report
  from a message by the report's "wasitme report:" heading, and says first when a report is out of date.
- **The contract's example documents carry no projected date, like the engine.** Every golden in `contract/fixtures`
  has `etaDate: null` and never says "not at your current pace", which is exactly what this version writes, so a
  consumer built against the examples sees what real files contain. While it is too early to tell, the Control
  Center, the Claude Code pane and the command line say "No date yet: it depends on how your sessions go." next to
  the counts still missing; the menu bar popover shows the counts alone. The design mock-ups show the same.
- **The Control Center's pages are calmer: one title, one sentence and one chart each, with the rest one click
  away.** Every page now opens with its answer, then folds the evidence into sections you open when you want them
  (Details, What wasitme compared, Daily counts, How wasitme decided, All changes, and so on). Nothing was removed:
  every count, ratio, range and full version is still on the page, in a section, a hover tip or the chart's
  screen-reader description. The Finding page keeps the noise band visible above its chart, and opens Details by
  itself when the finding is on the agent's side. Changes are drawn the same way everywhere: a rounded square for
  yours, a rounded tag for the agent's (filled when the shift lines up with it), a dashed circle when the origin is
  unknown, with versions shortened ("Codex 0.144 → 0.145", full version on hover) and no "(update)" on every row. The
  page no longer draws its own window dots, toolbar or footer inside the app, demo data is marked by a banner at the
  top of every page, and text uses six sizes. Settings is now buttons and switches (Remove…, Add…, Turn Off…,
  Update…, Show in Finder, Clear History…, Uninstall…, Launch at login, Desktop panel) instead of Terminal
  instructions. The page only asks: the app confirms anything that changes your setup in its own sheet before it runs,
  and a control that cannot run right now is greyed out with the reason (for example "Updates arrive with the first
  public release.", or "Not read yet; open Settings again to retry." while the app has not heard back from the
  installer).
- **`wasitme demo` shows each agent's own installed version on the Setup page.** The Codex demo said "Codex 2.1.281",
  a Claude Code version, while its own timeline ends at Codex 0.95. Each demo case now takes the version its timeline
  last moved to, and the Codex demo no longer lists hooks, which wasitme does not read for Codex.
- **The public documents say what the code does.** A fresh-eyes pass checked every command, path, number and rule in the
  README, METHOD, PRIVACY, FORMATS, CONTRACT, SECURITY and CONTRIBUTING against the engine, the installer and the
  calibration artifact. Corrected: a log-format change counts the unknown records and shows them on the Sources page
  (this version raises only the `parser_changed` pause); the hook's sandbox also grants write access to `~/.wasitme`;
  the session-end hook is not asynchronous; a model id may end in `@default`; the store also holds `history/index.json`
  and `history/priors/`; the installer sets only `glancePath` and leaves `showBand` alone; `staleAfterSec` is required;
  the largest example glance is about 7 KB; and the menu item is "Quit wasitme".
- **The glance and snapshot file formats are version 1.** Findings use one vocabulary everywhere: `you`, `agent`,
  `none`, `insufficient` and `unclear`, with `stale` worked out by each surface from the file's age. Each finding
  carries its reason, whether it is still being confirmed, and whether that agent's findings are calibrated yet.
  Shared example files for every state test the engine, the Mac app and the Claude Code pane against the same rules.
- **The finding's three lines say different things.** The big title says the state, the sentence under it says what
  was found, and the small note gives the evidence: the numbers, the window, and what was ruled out or is still
  missing. A test forbids one line from repeating another.
- **`wasitme history clear` deletes your saved history without uninstalling.** It removes the results and everything
  wasitme derived from your logs (`history/`, `glance.json`, `snapshot.json`, the saved decisions and pending project
  snapshots) and keeps the salt, your exclusions, `engine.json`, the backups, the logs and the install, so the next scan
  starts fresh from the logs your agents still keep. It asks first on a terminal; without one it needs `--yes`
  (exit 2 otherwise), and it waits for a running scan instead of racing it.
- **The installer and uninstaller handle the edge cases.** A symlinked or foreign `~/.wasitme` is refused up front with
  the fix (the engine refuses it too, so an install there could never scan); `wasitme doctor` problems found right after
  an install are reported, not hidden behind "ok"; a custom `CLAUDE_CONFIG_DIR` or `CODEX_HOME` reaches the menu bar
  app's scans as well as the background scan; a `--home` sandbox install never names the real LaunchAgent, so the
  plugin's hooks cannot kick it; and after an uninstall that keeps your history, the last line gives a command that
  works (`--purge` from a source checkout also deletes such leftover history). The report skill answers "no results
  yet" without an extra "exit status 1" line, and the installed engine leaves out the development-only folders the npm
  package leaves out.
- **`--from-app` runs an update, an add, a removal or a full uninstall detached from the Mac app.** With it,
  `install.sh --update`, `install.sh --add`, `uninstall.sh --yes --only` and `uninstall.sh --yes` return at once and carry
  on in their own session, so quitting or unloading the app cannot cut them short, and the uninstaller waits for the app
  to quit before removing it. The result (running, done, partial, stopped or failed, with the exit code and a one-line
  summary) is written to `~/.wasitme/state/last-action.json` and the output to `last-action.log`, both private; only one
  such action runs at a time. After a full uninstall both files are deleted.
- **The installer builds the whole Mac app.** It builds the app package's `WasitmeApp` executable and assembles a bundle
  with what `macos/scripts/build-app.sh` ships: the Control Center page, the bundled IBM Plex fonts and their licence,
  the app icon and the current SDK stamp (for the macOS 26 look). A source without a built Control Center page gets one
  built in a scratch copy when TypeScript is there; otherwise the app step stops with the fix instead of installing an
  app that only shows a placeholder.
- The installer's "download failed" message now says how to install from a checkout (`--from DIR`) or a local tarball (`--tarball FILE`) when no release is published yet.
- **Add or remove one part without reinstalling: `install.sh --add PART` and `uninstall.sh --only PART`.** The parts
  are `app`, `scan-agent` (or `scan`), `claude-plugin`, `codex-plugin` and `statusline`. `--only` removes a part by the
  full uninstall's rules (your status line is restored only if it is still wasitme's) and keeps the install record,
  `engine.json` and `engine.env` in step, so nothing still names a part that is gone; folders the installer made that the
  part leaves empty go too. `--add` installs a part into the installed version from its own read-only copy, with no
  download; the app needs its sources (`--from DIR` of the same version). A part that is already there is left alone,
  and one that cannot be installed here stops the run with the reason and nothing changed.
- **The installer refuses symbolic links in every file it copies into a version folder.** The plugin folders were
  already checked; the install scripts (`scripts/install.sh`, `scripts/uninstall.sh`, `scripts/lib/`), `LICENSE` and
  `engine/package.json` were copied as they came. A link there would have been run again later by the uninstaller or
  `--repair`, pointing wherever the source said. Now the install stops before anything is written.
- **The installed status line runs in plain shell, not Node.** The installer ships `packaging/statusline.sh` and points
  Claude Code at `~/.local/bin/wasitme-statusline`, a small shim that runs it in plain shell (measured faster than Node
  can even start). That is the path `wasitme statusline install|show|uninstall` expect, so they work on an installed
  copy. If you already have a status line, the installer leaves it alone and names the command that wraps it, and the
  uninstaller hands a wrapped status line back to the engine before removing it.
- **`install.sh --status --json` says which parts are installed and which could be added here.** Run from the
  installed copy, it prints one JSON document (`wasitme.install-status/1`): the installed version and, for the app, the
  Claude Code plugin, the status line, the Codex skill and the scan agent, `on`, `off`, `own` (your own status line,
  which wasitme leaves alone), `unavailable` with a reason code (`agent_missing`, `not_supported`) or `unknown` when
  nothing is installed. It only reads, prints no path and exits 0. `--update`, `--add` and `--status` also reuse the
  `--prefix` the install recorded, so the command is never written to a second place.
- **Refreshing a stale wasitme status line no longer puts later edits to `settings.json` at risk.** When the installer
  moved its own status line to the current command (an update from an older installer, or a moved `--prefix`), it
  re-recorded the file's checksum as if nothing else had changed since the first install. An uninstall then restored the
  original backup over everything written in between (Claude Code's own plugin keys, a theme change), or deleted a
  `settings.json` the installer had created. The refresh now records that the file changed, so the uninstaller only ever
  removes wasitme's `statusLine` key in that case; a file untouched otherwise is still restored byte for byte.
- **`install.sh --update` installs a newer version with exactly the parts you have, asking nothing.** It reads the
  install record, updates those parts and adds none, rebuilds the Mac app when it is installed, and keeps the previous
  version for a rollback. A running app is quit before its bundle is replaced and started again in the background (by
  its LaunchAgent, or `open -g`, which does not take focus); an app you had quit stays quit, and `--no-relaunch` leaves
  a running one closed too. The last line says what happened in one sentence and names any installed part it could not
  update. If the new Claude Code plugin would hook or call more than the installed one, the update stops before
  changing anything, with exit 4, until you add `--accept-plugin-changes`. To update from a checkout, run
  that checkout's installer: `sh DIR/scripts/install.sh --from DIR --update`.
- **The installer's download URL comes from `--url` or its stamped release, never from the environment.** An
  undocumented `WASITME_TARBALL_URL` variable could point a released `install.sh` at another tarball, which then skipped
  the stamped SHA-256 check without a word. The variable is gone, and `--url` without `--sha256` on a released installer
  now says that no checksum is being checked and how to pass one.
- **The installer keeps each version in its own read-only folder and switches with one link.** wasitme installs
  into `~/.wasitme/versions/<version>` and points `~/.wasitme/current` at it; the command, the Claude Code plugin
  (registered at `current`) and the Codex plugin all go through that link, so an update or a rollback moves them
  together. Updating the Claude Code plugin never uninstalls it (your plugin options survive): run `/reload-plugins` in
  open sessions afterwards. The background scan runs every 15 minutes under Node's permission sandbox, setup writes the
  plugin's glance path for you and shows exactly what the in-session part may call, `engine.json` is private to you
  (0600), and Linux gets the command and plugins without a background scan. Installing from a local checkout
  (`npm run build && sh scripts/install.sh --from .`) warns when the checkout's built engine is older than its
  sources.
- **`--lead finding` puts the finding first.** `wasitme --lead timeline|finding` (and `wasitme demo --lead …`)
  chooses what the terminal report starts with; `--lead verdict` still works as an older spelling. `wasitme help`
  also says that `report --format json` is for your own tools: it has exact times and local ids, so keep it local.
- **The change that lines up with the shift keeps its words on a crowded chart.** In the Control Center, its short
  label ("effort", "2.1.285") is placed before its neighbours' labels. When its day is so crowded that the label has no
  room beside the badge, the legend under the chart names it with its own badge ("26 effort: lines up with the
  shift"), so the change the headline names can be found on the chart.
- **The report works inside sandboxes that block reading the system uptime.** In Codex's macOS workspace-write
  sandbox the scan lock used to fail with "report failed (internal)"; it now judges a leftover lock by its holder's
  process alone when uptime is unavailable.
- **METHOD.md now states four decider rules exactly as the code applies them.** Row 13 ("No detectable change") requires
  each voting family's sensitive indicator to have at least 4 degrees of freedom; row 2 tests eligibility, not the df floor;
  row 5 also counts an undated recorded change; the onset split needs 5 session-days on each side for every counted
  indicator; and persistence asks for 30% new denominator per voting indicator and confirms a move to "Too early to tell"
  on time alone when an agent went quiet. No behaviour changed; the engine already did all of this and its tests pin it.
- **Metrics and minimum-data gates for the health check.** The engine turns exchanges into per-session-day
  totals for every indicator (tool errors, reads per edit, edits without reading first, interruptions, pushback and
  context counts), compares the last two, three or four weeks of complete days with the weeks before, and only
  reports a comparison when both windows hold enough independent evidence. Only sessions you drive yourself count:
  scripted runs (`codex exec`, print mode, the Agent SDK) and threads another agent started are left out. When
  there is not enough data yet, it says what is still missing as counts ("31 of 40 edits so far") and gives no
  date: its date estimates failed their own accuracy test for people with a few very long sessions.
- **A `/model` or `/effort` typed at the very start of a session counts as your change.** It is recorded as a command
  you ran, not as "no command recorded". Resuming an older session after switching the model elsewhere does not add
  an extra "no command recorded" model change either.
- **Re-picking the model or effort you already use is not a change.** A `/model` or `/effort` typed at the start of a
  session, or after resuming one, that selects the value already in effect (the session's earlier exchanges, else the
  previous day's usual value) is ignored and does not show up as your change.
- **The Control Center is a normal Mac window.** It has a standard title bar you can drag (double-click zooms or
  minimizes as System Settings says), a toolbar with Check Again (⌘R), Open as Markdown and Copy Report (⇧⌘C), and a
  native sidebar with the pages, an agent picker and "Local only · updated …"; the page itself fills the rest, with no
  painted window buttons. While it is open the app has a full menu bar: About wasitme, Settings… (⌘,), Hide and Quit;
  File, Edit (Copy and Select All work in the page), View (pages ⌘1–⌘7, Show Sidebar ⌃⌘S, Enter Full Screen), Window
  and Help (opens the README that comes with the installed version, or says where it is; nothing is downloaded). Full
  screen works, the size and sidebar width are remembered, and Reduce Motion turns off the window and sidebar
  animations. Escape now closes the menu bar popover whatever has focus in it. Clicking the app in Finder or Spotlight
  opens the Control Center. The app can also start at login (`SMAppService`) from the Launch at login switch in
  Settings; it never adds a login item while the installer's LaunchAgent already starts it. Notifications are not part of this;
  they will be opt-in later.
- **"Next to unlock" names every indicator by its label, never by its internal id.** The Control Center's Finding page
  for the Codex demo printed "toolErrors 8 of 10 session-days": its unlock item named an indicator the document had no
  row for, and the page fell back to the id. The Control Center, the Mac app and the Claude Code pane now fall back to
  the engine's own label ("Tool errors"), and an indicator this version does not know is named by its words, never its
  id. The Codex demo also carries the tool errors row a real run has, so its popover and Compare page show it.
- **Before the first comparison, the signals table says why it is empty once.** With not enough history yet, the
  terminal report, `wasitme report --md` and `--html` list each indicator with its counts and status only, and one
  line under the table says "Change and range show once there is enough history to compare." instead of repeating
  "needs more history" on every row.
- **A project cannot choose what Node runs inside the plugin's hooks and report skill.** A project can set environment
  variables for its Claude Code sessions, so both scripts drop the variables Node reads at startup (`NODE_OPTIONS`,
  `NODE_PATH` and the rest) before Node starts: a `--require <file>` there never runs inside wasitme's Node, and an
  `--allow-fs-write` there never widens the hook's sandbox. When the recorded Node has moved, the report skill never
  takes a `node` from inside the session's folder on `PATH`.
- **Each indicator has one name everywhere.** The findings, the signals table, the report, the Control Center, the
  menu bar app and the Claude Code pane all say "edits without reading first" (never "blind edits") and "files
  edited 3+ times" (never "repeat edits"). "How wasitme decided" names the indicators that lack data ("Reads per
  edit and edits without reading first don't have enough data yet.") instead of an internal group name. Where a
  daily chart row has room for only a word or two, it counts "unread edits" out of "edits" ("unread" in the pane).
- **When one session holds most of the work, wasitme says so instead of guessing a number of sessions.** An
  indicator is compared only when no single session holds half or more of a window's work. When that is what holds an
  indicator back, "Next to unlock" says which window and what is counted ("tool errors; one session holds most of the
  recent tool calls, so more sessions are needed"), with no estimate of how many sessions it would take: that depends
  on how long the next sessions are. When every indicator waits only for that, the note under the headline says so
  too, rather than listing minimums the user already meets.
- **Open-source repository files and automated checks.** MIT `LICENSE`, `SECURITY.md` (a real threat model and how to
  report a vulnerability), `CONTRIBUTING.md`, `AGENTS.md` (the short rules for contributors and AI coding agents), a Code
  of Conduct, third-party credits, issue and pull-request templates, and GitHub Actions workflows for CI and a
  draft-only release. Dependency-free scripts guard the project's promises: `check-no-network` (engine code cannot use
  the network or pull in dependencies, and may start another program only at two marked places with fixed arguments),
  `check-privacy` (fails if a planted canary string leaks into any output), `check-repo` (home paths, forbidden
  e-mail addresses, remote assets) and `assemble-changelog` (the changelog-fragment system you are reading).
  `scripts/dev/export-public.sh` builds the public tree as one fresh commit with a noreply identity, and with `--onto`
  adds a later version as one ordinary commit on top of a clone of the public repository, so its history is never
  rewritten.
- **A project cannot hand Node an OpenSSL configuration inside the plugin's hooks and report skill.** Node's OpenSSL
  reads its configuration file from the `OPENSSL_CONF` environment variable before any JavaScript runs and outside the
  permission sandbox; a configuration can name a provider module to load as native code, or simply stop Node. A project
  can set environment variables for its Claude Code sessions, so both scripts now drop `OPENSSL_CONF`,
  `OPENSSL_MODULES` and `OPENSSL_ENGINES`, as they already drop `NODE_OPTIONS` and the other variables Node reads at
  startup.
- **The menu bar popover's demo-data line is no longer cut off.** It read "demo data (wasitme demo) — not from your
  lo…", one character too wide for the popover. It now says "Demo data, not from your logs.", the report's own words
  from the design tokens, and a test measures it against the popover's width.
- **The menu bar popover and the desktop panel name every indicator and show their lines whole.** Tool errors
  excluding commands, the tool-error indicator wasitme compares by, has its own words on the Mac: the desktop panel's
  chart reads "errors per day" and a locked indicator counts "errors so far". The popover's chart title always fits
  with both of its dates: a name too long for the strip is shortened ("tool errors per day, Sep 20 – Oct 3", "unread
  edits per day, Sep 20 – Oct 3") and the full title stays in the chart's accessibility label. A locked indicator's
  row fits beside its status in every unit ("unread edits so far", "session-days so far").
- **Changes to a project's own files say so.** The timeline reads "Project settings changed" or "Project
  CLAUDE.md changed" for a project's files, and keeps "Settings changed" for your global setup.
- **Plugin-only and `--until` reports are read-only and leave out your configuration history.** They do not load the
  saved history of instruction-file, MCP, skill and hook changes or the project snapshots, so they can differ from the
  app and the plain command line, and they cannot call a change "Agent side" by elimination.
- **The README opens with a picture of the Control Center.** It shows the canvas rendering `wasitme demo` ("Too early
  to tell", marked as demo data on the page), in light or dark to match the reader's setting. `ui/scripts/hero.mjs`
  makes both images again from the engine's own demo output.
- **Install and update with one command.** The README's install command pipes the latest release's `install.sh` to
  `sh` (or download the installer, read it, then run it); ending the same command with `| sh -s -- --update` updates and
  keeps the parts you have. Each release's `SHA256SUMS` lists every file it ships, and `gh attestation verify` checks
  that the release workflow built a file.
- **Release assets that match what the installer downloads.** `scripts/release.sh` builds `wasitme-<version>.tgz` from a
  commit with the engine and the Control Center page already built (installing it runs no npm and downloads nothing),
  writes the same bytes as `wasitme.tar.gz` (the name `install.sh` downloads by default), an `install.sh` asset with
  that tarball's address and SHA-256 built in, and `SHA256SUMS`. It refuses a tarball with anything outside the
  published file list, a home path or a private address in it, then installs it into a throwaway home, uses it and
  uninstalls it again. It never publishes anything; the release workflow runs it with `--strict`.
- **The report skill's engine always uses the install's own data folder.** `/wasitme:report` (and the Codex skill) run
  the engine through the plugin's `run.sh`, which already refused to take its code from a folder the session's
  environment named. It now drops `WASITME_HOME` as well, so a project cannot point the report's scan at a data folder
  of its own choosing: the results are written to the install's `~/.wasitme`, as the hooks and the installed command
  do. The bundled read-only engine now runs `status` without `--read-only`, which `status` does not accept.
- **Copied or restored Claude Code logs keep their resume order on Linux.** To skip the records a resumed session
  copies from an earlier one, wasitme orders a project's sessions by when each file was created. A copy or a restore
  that keeps the files' modification times gives them new creation times on Linux, in whatever order the copy went,
  so a typed /model or /effort could be reported as a change with no known cause. When a file's modification time was
  set back after the file was created, that modification time now stands in for the creation time, which is what
  macOS already reports for the same copy.
- **`wasitme scan` writes findings.** Each scan runs the attribution table and the engine's own words for every agent
  and writes glance.json and snapshot.json from them, in the layout set by `lead` in engine.json (timeline first unless
  it says `verdict`). An agent whose calibration did not pass would show "Timeline only", without the numbers on the
  snapshot. A new outcome is held until a later scan with fresh data confirms it; that state lives in
  `~/.wasitme/state/decisions.json` (numbers and ids only). If the finished files would break the published format,
  nothing is written and the last good files stay, marked as a failed scan.
- **A showcase site, published to GitHub Pages from `site/`.** One static page at
  https://draarivpatel-ui.github.io/wasitme/ with the film (and the film as text), the case line filed day by day from
  `wasitme demo` output, real renders of the Mac app and the terminal, what wasitme reads and keeps, and the install command.
  It has no build step, no framework and no remote loads (fonts, images and scripts are served from the site itself,
  under a strict Content-Security-Policy), and every product image is marked as demo data.
  `.github/workflows/pages.yml` deploys it on every push to `main` that touches `site/`; set the repository's Pages
  source to "GitHub Actions" once.
- **A status line for Claude Code.** `packaging/statusline.sh` prints `wasitme: <state>[ +n]` from `glance.json` in a few milliseconds of plain shell (no Node), says "out of date" by the contract's rule, never reads Claude Code's stdin, and, with `wasitme statusline install --wrap`, wraps a status line you already have (yours first, ours appended to its last line). `wasitme statusline install|uninstall|show` edits exactly one key of Claude Code's `settings.json` as text, keeps a backup, and puts your old line back byte for byte.
- **Work your agent hands to subagents counts in "reads per edit" and "edits without reading first".** Both are
  counted over the main conversation and its subagents together, and a big move of edits into or out of subagents is
  flagged as a change in your work mix instead of passing for a change in care. Older history is re-read from your
  logs where they still exist.
- **"Next to unlock" counts what is actually missing.** For each indicator still locked, the Control Center, the menu
  bar popover, the Claude Code pane and the terminal report show the requirement furthest from its target, in its own
  unit ("7 of 10 session-days", "3 of 5 sessions", "31 of 40 edits"), and draw the progress bar from the same numbers.
  Every count is set against its own target: an indicator with thousands of edits but too few session-days reads "7 of
  10 session-days". The one-line summary in the terminal and the Claude Code pane lists every requirement still short,
  each in its own unit. Reads per edit counts edits against its 40-edit floor. An indicator that is only waiting for
  more days of history shows no count of its own (the progress line counts the days, "30 of 42 days of history"), and
  neither does one where a single session dominates the data.
- **A public glossary of the `WP-##` ids that code comments cite.** `docs/WORK-PACKAGES.md` has one row per work-package
  id a shipped file mentions, saying in plain words which part of the code it names (the store and scan pipeline, the
  attribution layer, the installer, and so on), linked from `CONTRIBUTING.md` and `AGENTS.md`. A repository test keeps
  it complete: every id cited in a shipped file must have a row, and every row must still be cited.
- **Sessions moved into a git worktree stay with their project.** When Claude Code moves a session's log into a
  worktree's folder, wasitme keeps counting it under the project it started in, counts the work from before the move
  once, and does not report the move's marker as an unknown log format.
