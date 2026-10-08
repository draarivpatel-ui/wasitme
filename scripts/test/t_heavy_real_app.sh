#!/bin/sh
# The REAL app through the installer: `install.sh --from <this repo>` builds macos/ itself (not the tiny fixture
# package t_heavy_app_build uses) with the genuine `swift build` and ad-hoc `codesign`, and must produce the same bundle
# macos/scripts/build-app.sh makes: the WasitmeApp executable named in Info.plist, the Control Center page, the bundled
# fonts, the icon and the current SDK stamp. This is the test that keeps the installer's executable name and resource
# list in step with the Swift package. Only launchctl is faked; everything lives in a temp home. run.sh runs this file
# through scripts/dev/heavy.sh (it compiles the whole app: a few minutes at low priority).
. "$(dirname "$0")/harness.sh"

if [ "$T_OS" != Darwin ]; then printf '%s: skipped (macOS only)\n' "$T_NAME"; exit 0; fi
if ! command -v swift >/dev/null 2>&1 || ! xcode-select -p >/dev/null 2>&1; then
  printf '%s: skipped (no Swift toolchain)\n' "$T_NAME"
  exit 0
fi
# The installer installs what the source has built: the engine (npm run build) and the Control Center page
# (node ui/scripts/build.mjs). A checkout without them is a skip, said loudly, not a pass.
for t_need in engine/dist/src/cli/main.js ui/dist/app.html; do
  if [ ! -f "$T_REPO/$t_need" ]; then
    printf '%s: skipped (%s is not built in this checkout: run npm run build and node ui/scripts/build.mjs)\n' "$T_NAME" "$t_need"
    exit 0
  fi
done

t_section "install.sh --from <repo>: the real macos/ package, built and assembled by the installer"
sb_new
H=$SB_HOME
APP="$H/Applications/wasitme.app"
unset WASITME_DEVELOPER_DIRS
export WASITME_XCODE_SELECT=/usr/bin/xcode-select WASITME_CODESIGN=/usr/bin/codesign
XS_BEFORE=$(/usr/bin/xcode-select -p)
: >"$SB/before-install"   # anything in the source tree newer than this was written by the install
inst --from "$T_REPO" --yes --app --no-scan-agent --no-claude-plugin --no-codex-plugin --no-statusline
assert_rc 0 "the default app build succeeds (no --app-executable needed)"
assert_contains "$(out)" "mac app              installed" "the app is reported installed"
assert_file "$APP/Contents/MacOS/WasitmeApp" "the WasitmeApp executable is in the bundle"
assert_eq "WasitmeApp" "$(plist_get "$APP/Contents/Info.plist" CFBundleExecutable)" "Info.plist names it"
assert_eq "dev.wasitme.app" "$(plist_get "$APP/Contents/Info.plist" CFBundleIdentifier)" "bundle id (WasitmeIdentity.bundleIdentifier)"
for f in app.html app.js app.css; do
  assert_same_file "$T_REPO/ui/dist/$f" "$APP/Contents/Resources/ui/$f" "the Control Center page: $f (CanvasRouter serves Contents/Resources/ui)"
done
assert_eq "$(count_glob "$T_REPO/ui/dist/fonts"/*.woff2)" "$(count_glob "$APP/Contents/Resources/ui/fonts"/*.woff2)" "every web font of the page"
assert_file "$APP/Contents/Resources/ui/fonts/OFL.txt" "with the font licence"
assert_eq "$(count_glob "$T_REPO/design/system/fonts/app"/*.ttf)" "$(count_glob "$APP/Contents/Resources/fonts"/*.ttf)" "every bundled IBM Plex face (FontRegistry)"
assert_file "$APP/Contents/Resources/fonts/OFL.txt" "with its licence"
# The icon is rendered from the design's SVG with sips, which renders SVG on current macOS; an older one may not, and
# then the app keeps the generic icon with a warning (as in t_install). Deliberately conditional, unlike the rest.
if [ -f "$APP/Contents/Resources/AppIcon.icns" ]; then
  t_pass
  assert_eq "AppIcon" "$(plist_get "$APP/Contents/Info.plist" CFBundleIconFile)" "the app icon is named in Info.plist"
else
  assert_contains "$(err)" "the app gets the generic icon" "no icon on this macOS: a warning, never a failure"
  assert_eq "" "$(plist_get "$APP/Contents/Info.plist" CFBundleIconFile)" "and no CFBundleIconFile pointing at nothing"
fi
SDK=$(xcrun --sdk macosx --show-sdk-version)
REC=$(otool -l "$APP/Contents/MacOS/WasitmeApp" | awk '/LC_BUILD_VERSION/ { f = 1 } f && $1 == "sdk" { print $2; exit }')
assert_eq "$SDK" "$REC" "the binary is stamped with the real SDK version (macOS 26 look), not the 14.0 deployment target"
if /usr/bin/codesign --verify --deep --strict "$APP" 2>"$SB/codesign.err"; then t_pass; else t_fail "codesign --verify --deep --strict passes" "$(cat "$SB/codesign.err")"; fi
# The app's headless self-check never reaches AppKit (no window, no status item). With `--engine doctor` it runs the
# engine the way the app does (engine.json's absolute node + cli), so it proves the installed binary runs and finds
# the engine this installer set up. HOME is the sandbox: the app hands HOME to the engine, which must never see the
# real ~/.wasitme.
SC=$(env HOME="$H" perl -e 'alarm 60; exec @ARGV' "$APP/Contents/MacOS/WasitmeApp" --self-check --home "$H/.wasitme" --engine doctor 2>&1)
SC_RC=$?
assert_eq "0" "$SC_RC" "the installed app's headless self-check exits 0 ($SC)"
assert_contains "$SC" "engine=doctor:ok:" "and the app ran the installed engine through engine.json"
# A checkout where build-app.sh ran already has macos/.build: what matters is that this install wrote nothing there.
assert_eq "" "$(find "$T_REPO/macos" "$T_REPO/ui" "$T_REPO/design" -newer "$SB/before-install" 2>/dev/null | head -5)" "the build wrote nothing into the source tree (it built a scratch copy)"
assert_eq "$XS_BEFORE" "$(/usr/bin/xcode-select -p)" "xcode-select is exactly as it was"

t_section "uninstall"
uninst --yes --purge   # the engine ran (doctor, the self-check) and left its data in the sandbox
assert_rc 0 "uninstall"
assert_missing "$APP" "app removed"
assert_eq "." "$(tree_of "$H")" "the home is empty again"

t_done
