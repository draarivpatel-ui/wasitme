#!/bin/sh
# Build the macOS app locally: swift build (release) -> assemble WasitmeApp.app -> ad-hoc sign -> verify.
# No Apple Developer account (D7). NEVER launches the app. This is a heavy job; run it through the
# repo's serializer so the machine stays responsive:
#
#   scripts/dev/heavy.sh macos/scripts/build-app.sh
#
# Toolchain: whatever DEVELOPER_DIR / xcode-select points at (this script never changes xcode-select).
#   DEVELOPER_DIR=/Library/Developer/CommandLineTools macos/scripts/build-app.sh   # Command Line Tools only
# Output: macos/dist/WasitmeApp.app   (override with DIST=...; SwiftPM scratch dir with SCRATCH_PATH=...)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
DIST="${DIST:-$ROOT/dist}"
NAME=WasitmeApp
BUNDLE_ID="${BUNDLE_ID:-dev.wasitme.app}"     # keep in sync with WasitmeIdentity.bundleIdentifier
APP="$DIST/$NAME.app"
SCRATCH="${SCRATCH_PATH:-$ROOT/.build}"

echo "== toolchain: ${DEVELOPER_DIR:-$(xcode-select -p)}"
swift --version 2>&1 | head -1

# The design tokens and glyphs the package compiles in must be what design/system says today (WP-50).
DESIGN="$ROOT/../design/system"
# What the bundle carries besides the executable: one list, shared with the installer (scripts/lib/macos.sh).
# shellcheck source=../../scripts/lib/app_bundle.sh
. "$ROOT/../scripts/lib/app_bundle.sh"
command -v node >/dev/null 2>&1 || { echo "build-app.sh: node is needed (design sync check, canvas build)" >&2; exit 1; }
node "$ROOT/scripts/sync-design.mjs" --check

start=$(date +%s)
swift build -c release --package-path "$ROOT" --scratch-path "$SCRATCH" --product "$NAME"
BIN=$(swift build -c release --package-path "$ROOT" --scratch-path "$SCRATCH" --show-bin-path)
echo "== swift build (release): $(( $(date +%s) - start ))s"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/$NAME" "$APP/Contents/MacOS/$NAME"

# SwiftPM's default backend records the DEPLOYMENT target (14.0) as the SDK version in
# LC_BUILD_VERSION. AppKit keys "linked on or after" behaviour on that number, so an app stamped 14.0
# renders with the old pre-macOS-26 look. Re-stamp the real SDK version (spike finding; re-signed below).
sdk_ver=$(xcrun --sdk macosx --show-sdk-version)
rec_sdk=$(otool -l "$APP/Contents/MacOS/$NAME" | awk '/LC_BUILD_VERSION/{f=1} f&&$1=="sdk"{print $2; exit}')
if [ "$rec_sdk" != "$sdk_ver" ]; then
  vtool -set-build-version macos 14.0 "$sdk_ver" -replace \
    -output "$APP/Contents/MacOS/$NAME.tmp" "$APP/Contents/MacOS/$NAME" 2>/dev/null
  mv "$APP/Contents/MacOS/$NAME.tmp" "$APP/Contents/MacOS/$NAME"
  chmod +x "$APP/Contents/MacOS/$NAME"
  echo "== LC_BUILD_VERSION sdk $rec_sdk -> $sdk_ver"
fi

# The Control Center canvas (WP-41): build ui/ into ui/dist and ship it as plain files in Contents/Resources/ui/,
# where CanvasAssetSource.resolve finds it (served by the wasitme-app:// scheme handler under the CSP header), and the
# bundled type (D57): the six upstream IBM Plex files plus their licence, registered at launch by FontRegistry. Copied
# before codesign so the resources are sealed. SKIP_UI_BUILD=1 reuses an existing ui/dist (e.g. when ui/ was just
# built); the copy itself is never skipped. The file list is app_bundle_resources, in scripts/lib/app_bundle.sh.
UI_DIR="$ROOT/../ui"
if [ "${SKIP_UI_BUILD:-0}" != 1 ]; then
  node "$UI_DIR/scripts/build.mjs"
fi
app_ui_dist_ok "$UI_DIR/dist" || { echo "build-app.sh: ui/dist is incomplete: it needs $APP_UI_FILES, fonts/OFL.txt and the web fonts (node ui/scripts/build.mjs)" >&2; exit 1; }
app_fonts_ok "$DESIGN/fonts" || { echo "build-app.sh: design/system/fonts needs app/*.ttf and OFL.txt" >&2; exit 1; }
app_bundle_resources "$BIN" "$UI_DIR/dist" "$DESIGN/fonts" "$APP/Contents/Resources" || { echo "build-app.sh: copying the app's resources failed" >&2; exit 1; }
echo "== canvas: Contents/Resources/ui ($(du -sh "$APP/Contents/Resources/ui" | cut -f1))"
bundled_faces=0
for face in "$APP/Contents/Resources/fonts"/*.ttf; do
  if [ -e "$face" ]; then bundled_faces=$((bundled_faces + 1)); fi
done
echo "== fonts: $bundled_faces faces + OFL.txt"

# The app icon, from the design's 1024 SVG (sips renders SVG on this macOS): every iconset size, then iconutil.
ICONSET=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-icon.XXXXXX")/AppIcon.iconset
app_bundle_icon "$DESIGN/glyphs/appicon-1024.svg" "$APP/Contents/Resources/AppIcon.icns" "$ICONSET" || { echo "build-app.sh: rendering the app icon failed (step $?: 1 sips render, 2 sips resize, 3 iconutil)" >&2; exit 1; }
rm -rf "$(dirname "$ICONSET")"
echo "== icon: Contents/Resources/AppIcon.icns ($(du -h "$APP/Contents/Resources/AppIcon.icns" | cut -f1))"

sed -e "s/__EXEC__/$NAME/g" -e "s/__BUNDLE_ID__/$BUNDLE_ID/g" \
  "$ROOT/support/Info.plist.template" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint "$APP/Contents/Info.plist"

# Ad-hoc signature: required on Apple Silicon, free, and a locally built app is never quarantined.
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "== $NAME.app: $(du -sh "$APP" | cut -f1) (binary $(du -h "$APP/Contents/MacOS/$NAME" | cut -f1))"
echo "== done in $(( $(date +%s) - start ))s (not launched)"
