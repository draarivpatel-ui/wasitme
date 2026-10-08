# shellcheck shell=sh
# wasitme installer: macOS pieces. Local Swift build (no Apple account, no download -> no quarantine),
# wasitme.app bundle in ~/Applications, ad-hoc codesign + verify, and two LaunchAgents:
#   dev.wasitme.scan      a sandboxed `wasitme scan --no-project-files` every 15 minutes (keeps history past the 30-day log cleanup)
#   dev.wasitme.menubar   the menu bar app; KeepAlive only on crash, so Quit stays quit
# Sourced after common.sh / engine.sh.

# ---- Toolchain detection (never touches xcode-select) --------------------------------------------------
dev_dir_ok() { [ -x "$1/usr/bin/swift" ]; }

# Sets TOOLCHAIN_OK (1/0), DEV_DIR (passed as DEVELOPER_DIR for the build only), TOOLCHAIN_WHY.
# Order: $DEVELOPER_DIR, the active xcode-select dir, then known Xcode locations, then Command Line Tools.
find_toolchain() {
  TOOLCHAIN_OK=0
  DEV_DIR=""
  TOOLCHAIN_WHY=""
  ft_pick=""
  if [ -n "${DEVELOPER_DIR:-}" ] && dev_dir_ok "$DEVELOPER_DIR"; then
    ft_pick=$DEVELOPER_DIR
  else
    ft_sel=$("${WASITME_XCODE_SELECT:-xcode-select}" -p 2>/dev/null || true)
    if [ -n "$ft_sel" ] && dev_dir_ok "$ft_sel"; then
      ft_pick=$ft_sel
    else
      ft_list=${WASITME_DEVELOPER_DIRS:-}
      if [ -z "$ft_list" ]; then
        ft_list="/Applications/Xcode.app/Contents/Developer:$HOME_DIR/Applications/Xcode.app/Contents/Developer"
        for ft_g in /Applications/Xcode*.app/Contents/Developer; do ft_list="$ft_list:$ft_g"; done
        ft_list="$ft_list:/Library/Developer/CommandLineTools"
      fi
      ft_ifs=$IFS
      IFS=:
      for ft_c in $ft_list; do
        if [ -n "$ft_c" ] && dev_dir_ok "$ft_c"; then ft_pick=$ft_c; break; fi
      done
      IFS=$ft_ifs
    fi
  fi
  if [ -n "$ft_pick" ]; then
    DEV_DIR=$ft_pick
    TOOLCHAIN_OK=1
  elif [ -n "${WASITME_SWIFT:-}" ] && [ -x "$WASITME_SWIFT" ]; then
    TOOLCHAIN_OK=1
  else
    TOOLCHAIN_WHY="no Swift toolchain found. Install Xcode from the App Store, or run 'xcode-select --install', then re-run this installer (the command line tool and plugins do not need it)"
  fi
}

# ---- LaunchAgent plists ----------------------------------------------------------------------------------
plist_open() {
  printf '<?xml version="1.0" encoding="UTF-8"?>\n'
  printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  printf '<!-- %s -->\n<plist version="1.0">\n<dict>\n' "$WASITME_MARKER"
}
plist_close() { printf '</dict>\n</plist>\n'; }
plist_str() { printf '  <key>%s</key>\n  <string>%s</string>\n' "$1" "$2"; }

# The background scan: node [sandbox flags, D49/D60] <cli> scan --no-project-files, every 15 minutes, at background
# priority. Its stdout (a one-line count summary) is dropped; errors (kinds only, never paths) go to logs/scan.log.
# When Claude Code or Codex keep their config somewhere other than the default, the engine is told the same folder the
# sandbox grants (the agent's own environment variables are not visible to launchd jobs).
scan_plist_content() {
  plist_open
  plist_str Label "$LABEL_SCAN"
  printf '  <key>ProgramArguments</key>\n  <array>\n'
  printf '    <string>%s</string>\n' "$NODE"
  if [ -n "$SCAN_NODE_ARGS" ]; then
    printf '%s\n' "$SCAN_NODE_ARGS" | while IFS= read -r sp_a; do
      [ -n "$sp_a" ] && printf '    <string>%s</string>\n' "$sp_a"
    done
  fi
  printf '    <string>%s</string>\n' "${ENGINE_CLI_SANDBOX:-$ENGINE_CLI}"
  for sp_a in $WASITME_SCAN_ARGS; do printf '    <string>%s</string>\n' "$sp_a"; done
  printf '  </array>\n'
  if [ "$CLAUDE_DIR" != "$HOME_DIR/.claude" ] || [ "$CODEX_DIR" != "$HOME_DIR/.codex" ]; then
    printf '  <key>EnvironmentVariables</key>\n  <dict>\n'
    if [ "$CLAUDE_DIR" != "$HOME_DIR/.claude" ]; then printf '    <key>WASITME_CLAUDE_DIR</key>\n    <string>%s</string>\n' "$CLAUDE_DIR"; fi
    if [ "$CODEX_DIR" != "$HOME_DIR/.codex" ]; then printf '    <key>WASITME_CODEX_DIR</key>\n    <string>%s</string>\n' "$CODEX_DIR"; fi
    printf '  </dict>\n'
  fi
  printf '  <key>StartInterval</key>\n  <integer>%s</integer>\n' "$WASITME_SCAN_INTERVAL"
  printf '  <key>RunAtLoad</key>\n  <true/>\n'
  plist_str ProcessType Background
  printf '  <key>Nice</key>\n  <integer>10</integer>\n'
  printf '  <key>LowPriorityIO</key>\n  <true/>\n'
  plist_str StandardOutPath /dev/null
  plist_str StandardErrorPath "$LOG_DIR/scan.log"
  plist_close
}

app_plist_content() {
  plist_open
  plist_str Label "$LABEL_APP"
  printf '  <key>ProgramArguments</key>\n  <array>\n'
  printf '    <string>%s</string>\n' "$APP_PATH/Contents/MacOS/$APP_EXE"
  printf '    <string>--supervised</string>\n'   # started by launchd with KeepAlive
  printf '  </array>\n'
  # The app runs the engine (Scan now, reports) with an environment built from nothing but a short allow-list that
  # includes CLAUDE_CONFIG_DIR and CODEX_HOME (macos EngineEnvironment). launchd jobs never see shell exports, so a
  # custom config folder is handed over here; otherwise the app's scans would read the default folders while the
  # background scan reads the configured ones. (An app opened from Finder or Spotlight has no such environment; it falls
  # back to the claudeDir / codexDir recorded in engine.json, and only for a non-default folder, like this block.)
  if [ "$CLAUDE_DIR" != "$HOME_DIR/.claude" ] || [ "$CODEX_DIR" != "$HOME_DIR/.codex" ]; then
    printf '  <key>EnvironmentVariables</key>\n  <dict>\n'
    if [ "$CLAUDE_DIR" != "$HOME_DIR/.claude" ]; then printf '    <key>CLAUDE_CONFIG_DIR</key>\n    <string>%s</string>\n' "$CLAUDE_DIR"; fi
    if [ "$CODEX_DIR" != "$HOME_DIR/.codex" ]; then printf '    <key>CODEX_HOME</key>\n    <string>%s</string>\n' "$CODEX_DIR"; fi
    printf '  </dict>\n'
  fi
  printf '  <key>RunAtLoad</key>\n  <true/>\n'
  printf '  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n'
  printf '  <key>ThrottleInterval</key>\n  <integer>30</integer>\n'
  plist_str ProcessType Interactive
  plist_str LimitLoadToSessionType Aqua
  plist_str StandardOutPath "$LOG_DIR/app.log"
  plist_str StandardErrorPath "$LOG_DIR/app.log"
  plist_close
}

info_plist_content() {
  plist_open
  plist_str CFBundleDevelopmentRegion en
  plist_str CFBundleName wasitme
  plist_str CFBundleDisplayName wasitme
  plist_str CFBundleIdentifier "$WASITME_BUNDLE_ID"
  plist_str CFBundleExecutable "$APP_EXE"
  plist_str CFBundlePackageType APPL
  plist_str CFBundleInfoDictionaryVersion 6.0
  plist_str CFBundleShortVersionString "$VERSION"
  plist_str CFBundleVersion "$VERSION"
  plist_str LSMinimumSystemVersion "$WASITME_MIN_MACOS"
  plist_str NSPrincipalClass NSApplication
  plist_str NSHumanReadableCopyright "MIT License"
  printf '  <key>LSUIElement</key>\n  <true/>\n'
  printf '  <key>NSHighResolutionCapable</key>\n  <true/>\n'
  if [ "${APP_ICON:-0}" = 1 ]; then plist_str CFBundleIconFile AppIcon; fi
  plist_close
}

# ---- LaunchAgent install / undo -----------------------------------------------------------------------
# launchd can still be tearing a job down when `launchctl bootout` returns, and a `bootstrap` issued straight away can
# then fail with "Bootstrap failed: 5: Input/output error". So after every bootout that a bootstrap may follow, poll
# `launchctl print` (it exits non-zero once the job is gone): up to WASITME_AGENT_WAIT_TRIES x 0.5 s, 10 by default.
# This is deliberately not run_launchctl: a non-zero exit is the answer we are waiting for, not an error to display.
agent_wait_gone() {  # agent_wait_gone LABEL
  [ "$LAUNCHCTL_ON" = 1 ] || return 0
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] (wait until launchd has unloaded %s)\n' "$1"
    return 0
  fi
  aw_max=${WASITME_AGENT_WAIT_TRIES:-10}
  case $aw_max in ''|*[!0-9]*) aw_max=10 ;; esac
  aw_n=0
  while [ "$aw_n" -lt "$aw_max" ]; do
    if ! "$LAUNCHCTL_BIN" print "gui/$UID_NUM/$1" >/dev/null 2>&1 </dev/null; then return 0; fi
    aw_n=$((aw_n + 1))
    sleep 0.5 2>/dev/null || sleep 1   # fractional sleep is not POSIX, but macOS (the only place this runs) and GNU have it
  done
  warn "launchd still lists $1 after waiting; trying to load it anyway"
  return 0
}

# Unload one of our agents and wait until launchd has really let go of it.
agent_bootout() {  # agent_bootout LABEL
  run_launchctl bootout "gui/$UID_NUM/$1" || true
  agent_wait_gone "$1"
}

# State for the agent currently being installed (agents are installed one after another).
AG_LABEL=""; AG_PLIST=""; AG_TAG=""; AG_LOADED=0; AG_WROTE=0; AG_WAS_OURS=0; AG_NOLOAD=0

agent_undo() {
  if [ "$LAUNCHCTL_ON" = 1 ] && [ "$AG_LOADED" = 1 ]; then run_launchctl bootout "gui/$UID_NUM/$AG_LABEL" || true; fi
  if [ "$AG_WROTE" = 1 ]; then
    if [ -f "$WORK_DIR/undo.$AG_TAG" ]; then
      cp -p "$WORK_DIR/undo.$AG_TAG" "$AG_PLIST" 2>/dev/null || true
      if [ "$LAUNCHCTL_ON" = 1 ] && [ "$AG_WAS_OURS" = 1 ] && [ "$AG_NOLOAD" != 1 ]; then
        if [ "$AG_LOADED" = 1 ]; then agent_wait_gone "$AG_LABEL"; fi
        run_launchctl bootstrap "gui/$UID_NUM" "$AG_PLIST" || true
      fi
    else
      rm -f "$AG_PLIST"
    fi
  fi
  rollback_dirs
}

# agent_install TAG LABEL CONTENT_FUNCTION [ALREADY_UNLOADED] [NO_LOAD]: write the plist, lint it, (re)load it. Returns 1
# on failure after undoing its own changes. A launchctl load failure is only a warning: the plist loads at next login.
# NO_LOAD=1 writes the plist and leaves launchd alone (an --update of an app the person quit: loading it would start it).
agent_install() {
  AG_TAG=$1; AG_LABEL=$2; AG_UNLOADED_ALREADY=${4:-0}; AG_NOLOAD=${5:-0}
  AG_PLIST="$AGENTS_DIR/$AG_LABEL.plist"
  AG_LOADED=0; AG_WROTE=0; AG_WAS_OURS=0
  if manifest_has launchagent "$AG_LABEL"; then AG_WAS_OURS=1; fi
  if [ -f "$AG_PLIST" ]; then
    if grep -q "$WASITME_MARKER" "$AG_PLIST" 2>/dev/null; then
      AG_WAS_OURS=1
    else
      warn "$AG_PLIST exists and was not created by this installer; leaving it alone"
      return 1
    fi
    if [ "$DRY" != 1 ]; then cp -p "$AG_PLIST" "$WORK_DIR/undo.$AG_TAG" || return 1; fi
  fi
  txn_begin agent_undo
  mkdir_track "$AGENTS_DIR" || { warn "could not create $AGENTS_DIR"; txn_abort; return 1; }
  MKDIR_MODE=700
  mkdir_track "$LOG_DIR" || { MKDIR_MODE=""; warn "could not create $LOG_DIR"; txn_abort; return 1; }
  MKDIR_MODE=""
  if ! "$3" | write_file "$AG_PLIST" 644; then warn "could not write $AG_PLIST"; txn_abort; return 1; fi
  AG_WROTE=1
  if [ "$DRY" != 1 ] && have_cmd plutil; then
    if ! exec_cap plutil -lint "$AG_PLIST"; then warn "generated an invalid plist: $AG_PLIST"; txn_abort; return 1; fi
  fi
  if [ "$LAUNCHCTL_ON" = 1 ] && [ "$AG_NOLOAD" = 1 ]; then
    :   # launchd keeps the idle job it has (the same program path); this plist is what it loads at the next login
  elif [ "$LAUNCHCTL_ON" = 1 ]; then
    if [ "$AG_WAS_OURS" = 1 ] && [ "$AG_UNLOADED_ALREADY" != 1 ]; then agent_bootout "$AG_LABEL"; fi
    if run_launchctl bootstrap "gui/$UID_NUM" "$AG_PLIST"; then
      AG_LOADED=1
    else
      warn "launchctl could not load $AG_LABEL now; it will load at your next login"
    fi
  else
    say "  (launchctl skipped: custom --home and no WASITME_LAUNCHCTL)"
  fi
  manifest_put launchagent "$AG_LABEL" "$AG_PLIST" || { warn "could not write the install manifest"; txn_abort; return 1; }
  commit_dirs || { warn "could not write the install manifest"; txn_abort; return 1; }
  txn_commit
  return 0
}

comp_scan_agent() {
  step "Background scan (every $((WASITME_SCAN_INTERVAL / 60)) minutes)"
  if agent_install scan "$LABEL_SCAN" scan_plist_content; then
    result "scan agent" "installed" "$AG_PLIST"
    return 0
  fi
  result "scan agent" "FAILED" "see the warning above; nothing was changed"
  return 1
}

# ---- The app -------------------------------------------------------------------------------------------
run_swift() {
  if [ "$DRY" = 1 ]; then
    if [ -n "$DEV_DIR" ]; then
      printf '[dry-run] %s\n' "$(quote_argv env "DEVELOPER_DIR=$DEV_DIR" nice -n 10 "$APP_SWIFT" "$@")"
    else
      printf '[dry-run] %s\n' "$(quote_argv nice -n 10 "$APP_SWIFT" "$@")"
    fi
    return 0
  fi
  if [ -n "$DEV_DIR" ]; then
    exec_cap env "DEVELOPER_DIR=$DEV_DIR" nice -n 10 "$APP_SWIFT" "$@"
  else
    exec_cap nice -n 10 "$APP_SWIFT" "$@"
  fi
}

swift_bin_path() {
  if [ -n "$DEV_DIR" ]; then
    env "DEVELOPER_DIR=$DEV_DIR" "$APP_SWIFT" build -c release --package-path "$APP_PKG" --scratch-path "$APP_SCRATCH" --show-bin-path 2>/dev/null
  else
    "$APP_SWIFT" build -c release --package-path "$APP_PKG" --scratch-path "$APP_SCRATCH" --show-bin-path 2>/dev/null
  fi
}

# Builds a scratch COPY of macos/: SwiftPM writes into the package directory (.build/index-build even with
# --scratch-path, and Package.resolved when there are dependencies), and the source tree must stay pristine.
# DEVELOPER_DIR is set only for the swift child process; xcode-select is never changed.
app_build() {
  APP_SWIFT=${WASITME_SWIFT:-$DEV_DIR/usr/bin/swift}
  APP_PKG="$WORK_DIR/macos-src"
  APP_SCRATCH="$WORK_DIR/swift-scratch"
  say "Building at low priority. The first build takes a minute or two."
  if [ -n "$DEV_DIR" ]; then say "Using the developer tools at $DEV_DIR (xcode-select is left as it is)."; fi
  run mkdir -p "$APP_PKG" || { APP_WHY="could not create $APP_PKG"; return 1; }
  run tar -cf "$WORK_DIR/macos.tar" --exclude .build --exclude .swiftpm -C "$SRC/macos" . || { APP_WHY="could not copy macos/ for the build"; return 1; }
  run tar -xf "$WORK_DIR/macos.tar" -C "$APP_PKG" || { APP_WHY="could not copy macos/ for the build"; return 1; }
  run_swift build -c release --package-path "$APP_PKG" --scratch-path "$APP_SCRATCH" || {
    APP_WHY="swift build failed (the last lines are above). If it mentions the Xcode license, run 'sudo xcodebuild -license' once yourself, then re-run this installer"
    return 1
  }
  if [ "$DRY" = 1 ]; then
    APP_BIN_PATH="<swift-bin-path>"
  else
    APP_BIN_PATH=$(swift_bin_path) || APP_BIN_PATH=""
    if [ -z "$APP_BIN_PATH" ] || [ ! -d "$APP_BIN_PATH" ]; then APP_WHY="could not find the build output directory"; return 1; fi
    if [ ! -x "$APP_BIN_PATH/$APP_EXE" ]; then
      APP_WHY="the build succeeded but produced no executable named '$APP_EXE' (found: $(ls "$APP_BIN_PATH" | tr '\n' ' ')). macos/Package.swift must expose an executable product with that name, or pass --app-executable NAME"
      return 1
    fi
  fi
  return 0
}

# ---- The app's resources: the set lives in app_bundle.sh, shared with macos/scripts/build-app.sh ----------------------
# The page (Contents/Resources/ui/) and the bundled fonts (Contents/Resources/fonts/) are required: without them the app
# shows its placeholder page or the system font. The icon is optional (a warning): macos/Resources/AppIcon.icns when the
# source has one, else rendered from design/system/glyphs/appicon-1024.svg.
APP_UI_DIR=""; APP_FONT_DIR=""; APP_ICON=0

# A node_modules folder with TypeScript in it (ui/scripts/build.mjs compiles with the repo's own tsc): the one the engine
# build just installed in the work directory, else the source checkout's own.
ui_typescript_dir() {
  for ut_d in "${ENGINE_BUILD:+$ENGINE_BUILD/node_modules}" "$SRC/node_modules"; do
    [ -n "$ut_d" ] || continue
    if [ -f "$ut_d/typescript/bin/tsc" ]; then printf '%s\n' "$ut_d"; return 0; fi
  done
  return 1
}

# Sets APP_UI_DIR to a built Control Center page and APP_FONT_DIR to the bundled faces. A source without a built page
# (a checkout where `node ui/scripts/build.mjs` was never run) gets one built in a scratch copy when TypeScript is at
# hand; the source tree itself is never written to. Returns 1 with APP_WHY set otherwise. Runs before the Swift build,
# so a missing piece is reported in a second, not after a minute of compiling.
app_prepare_resources() {
  APP_FONT_DIR="$SRC/design/system/fonts"
  if ! app_fonts_ok "$APP_FONT_DIR"; then
    APP_WHY="this source has no bundled fonts (design/system/fonts/app/*.ttf and OFL.txt); the app would fall back to the system font. Use a release tarball or a complete checkout"
    return 1
  fi
  if app_ui_dist_ok "$SRC/ui/dist"; then
    APP_UI_DIR="$SRC/ui/dist"
    if [ -d "$SRC/ui/src" ] && find "$SRC/ui/src" "$SRC/ui/static" -type f -newer "$SRC/ui/dist/app.js" 2>/dev/null | grep -q .; then
      warn "ui/ in $SRC has changes newer than its built ui/dist; the app gets the OLDER Control Center page. Run 'node ui/scripts/build.mjs' in $SRC first, then re-run the installer."
    fi
    return 0
  fi
  if [ ! -f "$SRC/ui/scripts/build.mjs" ] || [ ! -f "$SRC/design/system/tokens.json" ]; then
    APP_WHY="this source has no built Control Center page (ui/dist) and no ui/ sources to build one from; use a release tarball"
    return 1
  fi
  if ! ar_nm=$(ui_typescript_dir); then
    APP_WHY="this source has no built Control Center page (ui/dist), and TypeScript is not installed next to it to build one. In $SRC run 'npm ci' and then 'node ui/scripts/build.mjs', and re-run this installer (release tarballs ship it built)"
    return 1
  fi
  say "Building the Control Center page (ui/) in a scratch copy; the source folder is not written to."
  ar_b="$WORK_DIR/ui-build"
  APP_UI_DIR="$ar_b/ui/dist"
  run mkdir -p "$ar_b/ui" "$ar_b/design/system/screens" || { APP_WHY="could not create $ar_b"; return 1; }
  run tar -cf "$WORK_DIR/ui.tar" --exclude ./dist --exclude ./build --exclude ./node_modules -C "$SRC/ui" . || { APP_WHY="could not copy ui/ for the build"; return 1; }
  run tar -xf "$WORK_DIR/ui.tar" -C "$ar_b/ui" || { APP_WHY="could not copy ui/ for the build"; return 1; }
  for ar_x in tokens.json glyphs generated fonts; do
    run cp -R "$SRC/design/system/$ar_x" "$ar_b/design/system/$ar_x" || { APP_WHY="could not copy design/system/$ar_x for the build"; return 1; }
  done
  run cp "$SRC/design/system/screens/components.css" "$ar_b/design/system/screens/components.css" || { APP_WHY="could not copy the design components for the build"; return 1; }
  run ln -s "$ar_nm" "$ar_b/node_modules" || { APP_WHY="could not link TypeScript for the build"; return 1; }
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] %s\n' "$(quote_argv nice -n 10 "$NODE" "$ar_b/ui/scripts/build.mjs")"
    return 0
  fi
  exec_cap nice -n 10 "$NODE" "$ar_b/ui/scripts/build.mjs" || { APP_WHY="building the Control Center page failed (the last lines are above)"; return 1; }
  app_ui_dist_ok "$APP_UI_DIR" || { APP_WHY="the Control Center build finished but did not produce ui/dist"; return 1; }
  return 0
}

# The developer tool NAME from the toolchain the build used, found through that toolchain's own xcrun (DEVELOPER_DIR set
# for this one call). Never the /usr/bin stubs on their own: without a developer directory they open the "install the
# command line developer tools" dialog, which this installer never triggers.
dev_tool() {  # dev_tool NAME ARGS...
  [ -n "$DEV_DIR" ] && [ -d "$DEV_DIR" ] || return 1
  env "DEVELOPER_DIR=$DEV_DIR" xcrun "$@" </dev/null 2>/dev/null
}

# SwiftPM records the deployment target (14.0) as the SDK version in LC_BUILD_VERSION, and AppKit keys its "linked on or
# after" behaviour on that number: an app stamped 14.0 renders with the pre-macOS-26 look. Re-stamp the real SDK version
# (as build-app.sh does), before the signature. A binary with no LC_BUILD_VERSION is left alone.
app_restamp() {  # app_restamp EXECUTABLE
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] vtool -set-build-version macos %s <sdk> -replace %s (only when the recorded SDK differs)\n' "$WASITME_MIN_MACOS" "$(quote_arg "$1")"
    return 0
  fi
  rs_rec=$(dev_tool otool -l "$1" | awk '/LC_BUILD_VERSION/ { f = 1 } f && $1 == "sdk" { print $2; exit }') || rs_rec=""
  [ -n "$rs_rec" ] || return 0
  rs_sdk=$(dev_tool --sdk macosx --show-sdk-version) || rs_sdk=""
  case $rs_sdk in
    ''|*[!0-9.]*) warn "could not read the macOS SDK version; the app keeps its build stamp ($rs_rec) and may look older"; return 0 ;;
  esac
  [ "$rs_rec" != "$rs_sdk" ] || return 0
  if dev_tool vtool -set-build-version macos "$WASITME_MIN_MACOS" "$rs_sdk" -replace -output "$1.restamp" "$1" >/dev/null &&
     mv -f "$1.restamp" "$1" && chmod 755 "$1"; then
    say "  build stamp: sdk $rs_rec -> $rs_sdk"
  else
    rm -f "$1.restamp"
    warn "could not re-stamp the app's SDK version ($rs_rec -> $rs_sdk); it works, but may look older"
  fi
  return 0
}

# Sets APP_ICON=1 when Contents/Resources/AppIcon.icns was written.
app_icon() {
  APP_ICON=0
  ai_dst="$A_STAGE/Contents/Resources/AppIcon.icns"
  if [ -f "$SRC/macos/Resources/AppIcon.icns" ]; then
    run cp "$SRC/macos/Resources/AppIcon.icns" "$ai_dst" || return 1
    APP_ICON=1
    return 0
  fi
  ai_svg="$SRC/design/system/glyphs/appicon-1024.svg"
  [ -f "$ai_svg" ] || return 0
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] sips + iconutil: %s -> %s\n' "$(quote_arg "$ai_svg")" "$(quote_arg "$ai_dst")"
    APP_ICON=1
    return 0
  fi
  ai_sips=${WASITME_SIPS:-sips}
  ai_iconutil=${WASITME_ICONUTIL:-iconutil}
  if ! have_cmd "$ai_sips" || ! have_cmd "$ai_iconutil"; then warn "sips or iconutil is missing; the app gets the generic icon"; return 0; fi
  ai_set="$WORK_DIR/AppIcon.iconset"
  rm -rf "$ai_set" || return 0
  ai_rc=0
  app_bundle_icon "$ai_svg" "$ai_dst" "$ai_set" "$ai_sips" "$ai_iconutil" 2>/dev/null || ai_rc=$?
  case $ai_rc in
    0) APP_ICON=1 ;;
    1) warn "could not render the app icon from $ai_svg; the app gets the generic icon" ;;
    2) warn "could not render the app icon; the app gets the generic icon" ;;
    *) warn "iconutil could not make the app icon; the app gets the generic icon" ;;
  esac
  return 0
}

app_assemble() {
  run rm -rf "$A_STAGE" "$A_PARK" || return 1
  run mkdir -p "$A_STAGE/Contents/MacOS" "$A_STAGE/Contents/Resources/ui/fonts" "$A_STAGE/Contents/Resources/fonts" || return 1
  run cp "$APP_BIN_PATH/$APP_EXE" "$A_STAGE/Contents/MacOS/$APP_EXE" || return 1
  app_restamp "$A_STAGE/Contents/MacOS/$APP_EXE"
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] cp -R %s/*.bundle %s/Contents/Resources/ (resource bundles, if any)\n' "$APP_BIN_PATH" "$(quote_arg "$A_STAGE")"
    printf '[dry-run] cp %s/{%s} + fonts/*.woff2, %s -> %s/Contents/Resources/ui/\n' "$(quote_arg "$APP_UI_DIR")" "$(printf '%s' "$APP_UI_FILES" | tr ' ' ',')" "$(printf '%s' "$APP_UI_FONT_LICENCES" | sed 's/ /, /g')" "$(quote_arg "$A_STAGE")"
    printf '[dry-run] cp %s/app/*.ttf %s/OFL.txt -> %s/Contents/Resources/fonts/\n' "$(quote_arg "$APP_FONT_DIR")" "$(quote_arg "$APP_FONT_DIR")" "$(quote_arg "$A_STAGE")"
  else
    app_bundle_resources "$APP_BIN_PATH" "$APP_UI_DIR" "$APP_FONT_DIR" "$A_STAGE/Contents/Resources" || return 1
  fi
  app_icon || return 1
  info_plist_content | write_file "$A_STAGE/Contents/Info.plist" 644 || return 1
  printf 'APPL????' | write_file "$A_STAGE/Contents/PkgInfo" 644 || return 1
  if [ "$DRY" != 1 ] && have_cmd plutil; then
    exec_cap plutil -lint "$A_STAGE/Contents/Info.plist" || return 1
  fi
  # Ad-hoc signature: required on Apple Silicon, needs no Apple account, and a locally built app is never quarantined.
  # It seals everything above, so it comes last.
  run_codesign --force --sign - "$A_STAGE" || return 1
  run_codesign --verify --deep --strict "$A_STAGE" || return 1
  return 0
}

app_undo() {
  if [ "$A_MOVED" = 1 ]; then rm -rf "$APP_PATH"; fi
  if [ "$A_PARKED" = 1 ]; then mv "$A_PARK" "$APP_PATH" 2>/dev/null || true; fi
  rm -rf "$A_STAGE"
  # --no-relaunch: the previous app is put back but not started (loading its agent would start it: RunAtLoad).
  if [ "$A_UNLOADED" = 1 ] && [ "$LAUNCHCTL_ON" = 1 ] && [ "${NO_RELAUNCH:-0}" != 1 ] && [ -f "$AGENTS_DIR/$LABEL_APP.plist" ]; then
    if run_launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/$LABEL_APP.plist"; then APP_STARTED=1; fi   # RunAtLoad starts it
  fi
  rollback_dirs
}

# ---- The running app (D46: KeepAlive only on a crash, so Quit stays quit) ----------------------------------------------
# A copy runs when a process of this user has its executable inside this exact bundle (the uninstaller's pkill rule).
# Never under a custom --home without an injected launchctl: a sandbox never touches a real app. Not asked in a dry run.
app_running() {
  [ "$LAUNCHCTL_ON" = 1 ] && [ "$DRY" != 1 ] || return 1
  "$PGREP_BIN" -U "$UID_NUM" -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1 </dev/null
}

# Quit the copies launchd does not manage (one the person opened from Finder; launchd's own copy stopped with its
# bootout): TERM, up to WASITME_APP_QUIT_WAIT x 0.5 s (10 by default) for them to go, then KILL.
app_quit_others() {
  app_running || return 0
  run_tool pkill "$PKILL_BIN" -U "$UID_NUM" -f "$APP_PATH/Contents/MacOS/" || true
  aq_n=0
  aq_max=${WASITME_APP_QUIT_WAIT:-10}
  case $aq_max in ''|*[!0-9]*) aq_max=10 ;; esac
  while [ "$aq_n" -lt "$aq_max" ]; do
    app_running || return 0
    aq_n=$((aq_n + 1))
    sleep 0.5 2>/dev/null || sleep 1
  done
  warn "the app did not quit within $((aq_max / 2)) seconds; stopping it"
  run_tool pkill "$PKILL_BIN" -KILL -U "$UID_NUM" -f "$APP_PATH/Contents/MacOS/" || true
}

# A copy that was running before is started again: launchd does it when the LaunchAgent was loaded again (RunAtLoad);
# otherwise `open -g` starts it in the background, so focus never moves. Never when it was not running, and never with
# --no-relaunch (the person asked for the app to stay closed).
app_open_again() {
  [ "${NO_RELAUNCH:-0}" != 1 ] || return 0
  [ "$APP_STOPPED" = 1 ] && [ "$APP_STARTED" = 0 ] || return 0
  [ "$OPEN_ON" = 1 ] && [ -e "$APP_PATH" ] || return 0
  if run_tool open "$OPEN_BIN" -g "$APP_PATH"; then APP_STARTED=1; else warn "could not start the app again; open it from $APPS_DIR"; fi
}

comp_app_fail() {
  APP_WHY=${1:-$APP_WHY}
  comp_unwind
  app_open_again
  result "mac app" "FAILED" "$APP_WHY"
  return 1
}

comp_app() {
  step "Mac menu bar app"
  APP_WHY=""
  APP_EXE=$OPT_APP_EXECUTABLE
  A_STAGE="$APPS_DIR/.wasitme.app.stage"
  A_PARK="$APPS_DIR/.wasitme.app.prev"
  A_PARKED=0; A_MOVED=0; A_UNLOADED=0; A_NOLOAD=0
  APP_WAS_RUNNING=0; APP_STOPPED=0; APP_STARTED=0
  comp_mark
  # Refuse early, before a minute of Swift build: something that is not our app already sits at the final path.
  if { [ -e "$APP_PATH" ] || [ -L "$APP_PATH" ]; } && ! app_is_ours "$APP_PATH"; then
    comp_app_fail "$APP_PATH exists and is not the wasitme app; leaving it alone"
    return 1
  fi
  app_prepare_resources || { comp_app_fail; return 1; }
  app_build || { comp_app_fail; return 1; }

  txn_begin app_undo
  mkdir_track "$APPS_DIR" || { comp_app_fail "could not create $APPS_DIR"; return 1; }
  app_assemble || { comp_app_fail "could not assemble or sign the app bundle (details above)"; return 1; }

  # Stop the old copy (only if we installed it), swap the bundle, verify the signature at the final path.
  # Check ownership again first: the build above took a while, and the old app must not be stopped for nothing.
  if { [ -e "$APP_PATH" ] || [ -L "$APP_PATH" ]; } && ! app_is_ours "$APP_PATH"; then
    comp_app_fail "$APP_PATH exists and is not the wasitme app; leaving it alone"
    return 1
  fi
  # A running copy is quit before its bundle is replaced and started again after (app_open_again). An --update leaves
  # an app the person quit alone: the bundle is swapped under its idle LaunchAgent and nothing is loaded, because
  # loading it would start the app (RunAtLoad); it starts at the next login, as it would have.
  # --no-relaunch (an --update run for someone who does not want the app opened for them): a running copy is quit all
  # the same, and its agent is written without being loaded again, so nothing starts it before the next login.
  if app_running; then APP_WAS_RUNNING=1; fi
  if [ "$UPDATE" = 1 ] && [ "$APP_WAS_RUNNING" = 0 ] && manifest_has app "$APP_PATH"; then A_NOLOAD=1; fi
  A_AGENT_NOLOAD=$A_NOLOAD
  if [ "${NO_RELAUNCH:-0}" = 1 ]; then A_AGENT_NOLOAD=1; fi
  if [ "$DRY" = 1 ] && [ -e "$APP_PATH" ]; then
    if [ "${NO_RELAUNCH:-0}" = 1 ]; then printf '[dry-run] (a running wasitme app is quit before the swap and left closed: --no-relaunch)\n'
    else printf '[dry-run] (a running wasitme app is quit before the swap and started again after it)\n'; fi
  fi
  if [ "$A_NOLOAD" = 0 ] && [ "$LAUNCHCTL_ON" = 1 ] && manifest_has launchagent "$LABEL_APP"; then
    agent_bootout "$LABEL_APP"
    A_UNLOADED=1
  fi
  if [ "$APP_WAS_RUNNING" = 1 ]; then
    app_quit_others
    APP_STOPPED=1
  fi
  if [ -e "$APP_PATH" ] || [ -L "$APP_PATH" ]; then
    run mv "$APP_PATH" "$A_PARK" || { comp_app_fail "could not move the previous app aside"; return 1; }
    A_PARKED=1
  fi
  run mv "$A_STAGE" "$APP_PATH" || { comp_app_fail "could not move the new app into place"; return 1; }
  A_MOVED=1
  run_codesign --verify --deep --strict "$APP_PATH" || { comp_app_fail "the signature did not verify after install"; return 1; }

  if ! agent_install app "$LABEL_APP" app_plist_content "$A_UNLOADED" "$A_AGENT_NOLOAD"; then
    comp_app_fail "could not install the app's LaunchAgent"
    return 1
  fi
  if [ "$AG_LOADED" = 1 ]; then APP_STARTED=1; fi   # RunAtLoad: launchd starts the new copy
  manifest_put app "$APP_PATH" || { comp_app_fail "could not write the install manifest"; return 1; }
  commit_dirs || { comp_app_fail "could not write the install manifest"; return 1; }
  txn_commit
  run rm -rf "$A_PARK" || true
  app_open_again
  ca_note=""
  if [ "$APP_WAS_RUNNING" = 1 ] && [ "$APP_STARTED" = 1 ]; then ca_note=" (restarted)"; fi
  if [ "$A_NOLOAD" = 1 ]; then ca_note=" (it was not running, so it was not started; it starts at your next login)"
  elif [ "$APP_WAS_RUNNING" = 1 ] && [ "${NO_RELAUNCH:-0}" = 1 ]; then ca_note=" (quit for the update and left closed: --no-relaunch; it starts at your next login)"; fi
  result "mac app" "installed" "$APP_PATH$ca_note"
  return 0
}
