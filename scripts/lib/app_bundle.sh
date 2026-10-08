# shellcheck shell=sh
# The app bundle's contents besides the executable and Info.plist, in ONE place. Two scripts assemble the app and both
# source this file, so their resource lists cannot drift apart:
#   macos/scripts/build-app.sh   the developer build: macos/dist/WasitmeApp.app
#   scripts/lib/macos.sh         the installer (app_assemble): ~/Applications/wasitme.app
# Plain POSIX sh with no dependency on the installer's common.sh: these functions only copy and render, and report a
# failure through their exit status. Each caller decides what a failure means (build-app.sh stops; the installer rolls
# back, or for the icon only warns).
#
#   Contents/Resources/*.bundle      SwiftPM resource bundles from the build's bin directory, if the package has any.
#   Contents/Resources/ui/           the Control Center page (WP-41): ui/dist/{app.html,app.js,app.css}, the web fonts
#                                    ui/dist/fonts/*.woff2 and their licence files. CanvasRouter serves it; without it
#                                    the app shows its built-in placeholder page. ui/dist/shots (test screenshots) is
#                                    never copied.
#   Contents/Resources/fonts/        design/system/fonts/app/*.ttf + design/system/fonts/OFL.txt, registered at launch
#                                    by FontRegistry (D57). Without them the app silently uses the system font.
#   Contents/Resources/AppIcon.icns  rendered from design/system/glyphs/appicon-1024.svg with sips + iconutil.

APP_UI_FILES="app.html app.js app.css"            # ui/dist -> Contents/Resources/ui/ (required)
APP_UI_FONT_LICENCES="OFL.txt MODIFICATIONS.txt"  # ui/dist/fonts -> Contents/Resources/ui/fonts/ with the *.woff2
APP_ICON_SIZES="16 32 128 256 512"                # each also at @2x; 512@2x is the 1024 render itself

# app_ui_dist_ok DIR: DIR holds a built Control Center page (the three files, the font licence, at least one web font).
app_ui_dist_ok() {
  for au_f in $APP_UI_FILES; do [ -f "$1/$au_f" ] || return 1; done
  [ -f "$1/fonts/OFL.txt" ] || return 1
  for au_f in "$1"/fonts/*.woff2; do [ -f "$au_f" ] && return 0; done
  return 1
}

# app_fonts_ok DIR: DIR (design/system/fonts) holds the bundled faces (app/*.ttf) and their licence (OFL.txt).
app_fonts_ok() {
  [ -f "$1/OFL.txt" ] || return 1
  for af_f in "$1"/app/*.ttf; do [ -f "$af_f" ] && return 0; done
  return 1
}

# app_bundle_resources BIN_DIR UI_DIST FONT_DIR RESOURCES: copies the resource bundles, the page and the fonts into
# RESOURCES (an app's Contents/Resources). Returns 1 on the first copy that fails.
app_bundle_resources() {
  abr_bin=$1 abr_ui=$2 abr_fonts=$3 abr_res=$4
  mkdir -p "$abr_res/ui/fonts" "$abr_res/fonts" || return 1
  for abr_f in "$abr_bin"/*.bundle; do
    [ -d "$abr_f" ] || continue
    cp -R "$abr_f" "$abr_res/" || return 1
  done
  for abr_f in $APP_UI_FILES; do cp "$abr_ui/$abr_f" "$abr_res/ui/$abr_f" || return 1; done
  for abr_f in "$abr_ui"/fonts/*.woff2; do
    [ -f "$abr_f" ] || continue
    cp "$abr_f" "$abr_res/ui/fonts/" || return 1
  done
  for abr_f in $APP_UI_FONT_LICENCES; do
    [ -f "$abr_ui/fonts/$abr_f" ] || continue
    cp "$abr_ui/fonts/$abr_f" "$abr_res/ui/fonts/" || return 1
  done
  for abr_f in "$abr_fonts"/app/*.ttf "$abr_fonts/OFL.txt"; do
    [ -f "$abr_f" ] || continue
    cp "$abr_f" "$abr_res/fonts/" || return 1
  done
  return 0
}

# app_bundle_icon SVG ICNS ICONSET [SIPS] [ICONUTIL]: renders SVG into every iconset size in the directory ICONSET (its
# name must end in .iconset; created if missing, left for the caller to remove), then writes ICNS with iconutil.
# Returns 1 when the first render fails, 2 when a resize fails, 3 when iconutil fails (ICNS is then removed). The
# tools' normal output is discarded; their errors stay on stderr for the caller to show or drop.
app_bundle_icon() {
  abi_svg=$1 abi_icns=$2 abi_set=$3 abi_sips=${4:-sips} abi_iconutil=${5:-iconutil}
  mkdir -p "$abi_set" || return 1
  "$abi_sips" -s format png "$abi_svg" --out "$abi_set/icon_512x512@2x.png" >/dev/null </dev/null || return 1
  for abi_s in $APP_ICON_SIZES; do
    "$abi_sips" -z "$abi_s" "$abi_s" "$abi_set/icon_512x512@2x.png" --out "$abi_set/icon_${abi_s}x${abi_s}.png" >/dev/null </dev/null || return 2
    abi_d=$((abi_s * 2))
    if [ "$abi_s" != 512 ]; then
      "$abi_sips" -z "$abi_d" "$abi_d" "$abi_set/icon_512x512@2x.png" --out "$abi_set/icon_${abi_s}x${abi_s}@2x.png" >/dev/null </dev/null || return 2
    fi
  done
  if ! "$abi_iconutil" -c icns "$abi_set" -o "$abi_icns" >/dev/null </dev/null; then
    rm -f "$abi_icns"
    return 3
  fi
  return 0
}
