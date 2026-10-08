#!/bin/sh
# The real thing, end to end, with a tiny dummy Swift package (scripts/test/fixtures/app-pkg): the installer runs a
# genuine `swift build`, assembles wasitme.app, and signs it with the genuine ad-hoc `codesign`. Only launchctl is
# faked (a recording shim), and everything lives in a temp home. run.sh runs this file through scripts/dev/heavy.sh.
. "$(dirname "$0")/harness.sh"

if [ "$T_OS" != Darwin ]; then printf '%s: skipped (macOS only)\n' "$T_NAME"; exit 0; fi
if ! command -v swift >/dev/null 2>&1 || ! xcode-select -p >/dev/null 2>&1; then
  printf '%s: skipped (no Swift toolchain)\n' "$T_NAME"
  exit 0
fi

t_section "real swift build, real ad-hoc codesign"
sb_new
make_fixture "$SB_SRC" 0.1.0 macos-real
H=$SB_HOME
APP="$H/Applications/wasitme.app"
# Use the real developer tools and the real codesign (the shims directory shadows them on PATH otherwise).
unset WASITME_DEVELOPER_DIRS
export WASITME_XCODE_SELECT=/usr/bin/xcode-select WASITME_CODESIGN=/usr/bin/codesign
XS_BEFORE=$(/usr/bin/xcode-select -p)

inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
assert_rc 0 "install with a real build"
assert_dir "$APP" "wasitme.app was assembled"
assert_file "$APP/Contents/MacOS/WasitmeApp" "the built executable is in the bundle"
assert_eq "wasitme dummy app ok" "$("$APP/Contents/MacOS/WasitmeApp")" "the built executable runs"
assert_eq "OK" "$(plutil -lint "$APP/Contents/Info.plist" | sed 's/^.*: //')" "Info.plist is valid"
assert_eq "true" "$(plist_get "$APP/Contents/Info.plist" LSUIElement)" "LSUIElement: menu bar app, no Dock icon"
assert_eq "dev.wasitme.app" "$(plist_get "$APP/Contents/Info.plist" CFBundleIdentifier)" "bundle identifier"
FOUND=$(find "$APP/Contents/Resources" -name hello.txt | head -1)
assert_eq "hello.txt" "$(basename "${FOUND:-none}")" "the SwiftPM resource bundle was copied into Resources"

if /usr/bin/codesign --verify --deep --strict "$APP" 2>"$SB/codesign.err"; then t_pass; else t_fail "codesign --verify --deep --strict passes on the installed app" "$(cat "$SB/codesign.err")"; fi
assert_contains "$(/usr/bin/codesign -dv "$APP" 2>&1)" "Signature=adhoc" "the signature is ad-hoc (no Apple account)"

assert_missing "$SB_SRC/macos/.build" "swift build did not write .build into the source tree (scratch path)"
assert_missing "$SB_SRC/macos/Package.resolved" "nor a Package.resolved"
assert_eq "$XS_BEFORE" "$(/usr/bin/xcode-select -p)" "xcode-select is exactly as it was"
# swift itself leaves TemporaryDirectory.* and *.lock files in TMPDIR; what must be gone is the installer's own work directory.
assert_eq "0" "$(find "$SB/tmp" -maxdepth 1 -type d -name 'wasitme-install.*' | wc -l | tr -d ' ')" "the installer's build scratch space was removed"
assert_missing "$H/Applications/.wasitme.app.stage" "no stage left behind"
assert_contains "$(shimlog)" "launchctl bootstrap gui/$T_UID $H/Library/LaunchAgents/$LABEL_APP.plist" "the app's LaunchAgent went to the (fake) launchctl only"

t_section "re-install over a real signed app, then uninstall"
inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
assert_rc 0 "second install replaces the app"
if /usr/bin/codesign --verify --deep --strict "$APP" 2>"$SB/codesign.err"; then t_pass; else t_fail "still verifies after the replace" "$(cat "$SB/codesign.err")"; fi
uninst
assert_rc 0 "uninstall"
assert_missing "$APP" "app removed"
assert_eq "." "$(tree_of "$H")" "the home is empty again"

t_done
