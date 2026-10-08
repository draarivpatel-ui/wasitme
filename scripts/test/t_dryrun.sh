#!/bin/sh
# --dry-run: prints every command and write that a real run would do, and changes nothing at all.
. "$(dirname "$0")/harness.sh"

t_section "full plan"
sb_new
make_fixture "$SB_SRC" 0.1.0 macos-fake
mkdir -p "$SB_HOME/.claude" "$SB_HOME/.codex"
printf '{ "theme": "dark" }\n' >"$SB_HOME/.claude/settings.json"
BEFORE=$(tree_of "$SB_HOME")
SETTINGS_SUM=$(shasum "$SB_HOME/.claude/settings.json")

H=$SB_HOME
S=$SB_SRC
W="$H/.wasitme"
V="$W/versions/0.1.0"
ST="$W/versions/.stage"
NODE=$(command -v node)
LA="$H/Library/LaunchAgents"

inst_from --dry-run --yes
assert_rc 0 "dry run succeeds"
OUTF=$T_OUT
assert_eq "$BEFORE" "$(tree_of "$SB_HOME")" "dry run created or removed nothing in the home"
assert_eq "$SETTINGS_SUM" "$(shasum "$SB_HOME/.claude/settings.json")" "dry run left settings.json untouched"
assert_eq "0" "$(ls -A "$SB/tmp" | wc -l | tr -d ' ')" "dry run left no temp directories behind"
assert_contains "$(out)" "Dry run: nothing was changed" "dry run says so"

# Only read-only probing may run for real: xcode-select -p. No installer tool is ever executed.
if [ "$T_OS" = Darwin ]; then
  assert_eq "xcode-select -p" "$(shimlog)" "dry run executed nothing but the read-only 'xcode-select -p'"
else
  assert_eq "0" "$(count_lines "$SHIM_LOG")" "dry run executed no tools at all"
fi

t_section "engine commands"
assert_line "$OUTF" "[dry-run] mkdir $W" "~/.wasitme is created first (before any sandboxed run, D60)"
assert_line "$OUTF" "[dry-run] cp -R $S/engine/dist/src $ST/engine/dist/src" "engine copied into the staged version (dist/src only)"
assert_line "$OUTF" "[dry-run] cp -R $S/engine/package.json $ST/engine/package.json" "package.json copied (through stage_copy, which refuses symlinks)"
assert_line "$OUTF" "[dry-run] cp -R $S/scripts/lib $ST/scripts/lib" "installer libs copied for the uninstaller"
assert_line "$OUTF" "[dry-run] cp -R $S/plugin $ST/plugin" "the Claude Code plugin travels in the same version folder"
assert_line "$OUTF" "[dry-run] cp -R $S/plugin-codex $ST/plugin-codex" "and so does the Codex root"
assert_line "$OUTF" "[dry-run] $NODE $ST/engine/dist/src/cli/main.js --version" "staged engine is self-checked before anything goes live"
assert_line "$OUTF" "[dry-run] chmod -R a-w $ST" "the version is made read-only before it goes in"
assert_line "$OUTF" "[dry-run] mv $ST $V" "stage swapped into place"
assert_line "$OUTF" "[dry-run] symlink $W/current -> versions/0.1.0" "current re-pointed (relative link, atomic)"
assert_line "$OUTF" "[dry-run] write $H/.local/bin/wasitme (mode 755)" "shim written"
assert_line "$OUTF" "[dry-run] write $W/engine.json (mode 600)" "engine.json written 0600 (D46)"
assert_line "$OUTF" "[dry-run] write $W/engine.env (mode 600)" "engine.env written 0600"
assert_no_line "$OUTF" "[dry-run] sudo" "no sudo"
assert_not_contains "$(out)" "xcode-select -s" "xcode-select is never switched"
assert_not_contains "$(out)" "--switch" "xcode-select is never switched (long form)"

# Order: self-check, then read-only, then swap, then symlink, then shim, then engine.json.
order=$(grep -n -e 'main.js --version' -e 'chmod -R a-w' -e "mv $ST $V" -e 'symlink' -e 'wasitme (mode 755)' -e 'engine.json (mode 600)' "$OUTF" | cut -d: -f1 | head -6 | tr '\n' ' ')
sorted=$(printf '%s\n' $order | sort -n | tr '\n' ' ')
assert_eq "$sorted" "$order" "stage -> verify -> read-only -> swap -> symlink -> shim -> engine.json, in that order"

t_section "plugin and status line commands"
assert_line "$OUTF" "[dry-run] claude plugin marketplace add $W/current" "claude marketplace registered at the current symlink (D32), never a version folder"
assert_line "$OUTF" "[dry-run] claude plugin install wasitme@wasitme" "claude plugin installed"
assert_line "$OUTF" "[dry-run] printf %s '{\"glancePath\":\"$W/glance.json\"}' | claude plugin configure wasitme@wasitme --values-stdin" "glancePath set as an absolute path (D50)"
assert_line "$OUTF" "[dry-run] codex plugin marketplace add $W/current/plugin-codex" "codex marketplace: its own root through current"
assert_line "$OUTF" "[dry-run] codex plugin add wasitme@wasitme-codex" "codex plugin added under its own marketplace name"
assert_contains "$(out)" "calls: \$.clock.every" "the mod disclosure is printed (D50, P-A)"
assert_contains "$(out)" "[dry-run] $NODE $T_REPO/scripts/lib/jsonutil.mjs statusline-add $H/.claude/settings.json " "status line edit planned through the node helper"
assert_contains "$(out)" "would back up $H/.claude/settings.json first" "backup announced before the edit"
assert_contains "$(out)" ".claude/settings.json.wasitme-bak-" "backup path shown"
assert_contains "$(out)" "doctor --repair (only if this engine has 'doctor')" "the doctor check is planned"

if [ "$T_OS" = Darwin ]; then
  t_section "macOS commands"
  WORK="$SB/tmp/wasitme-install.XXXXXX"
  SCRATCH="$WORK/swift-scratch"
  APPS="$H/Applications"
  assert_line "$OUTF" "[dry-run] env DEVELOPER_DIR=$DEV_DIR nice -n 10 $DEV_DIR/usr/bin/swift build -c release --package-path $WORK/macos-src --scratch-path $SCRATCH" "swift build: DEVELOPER_DIR for this command only, low priority, on a scratch copy of macos/ (the source stays pristine)"
  assert_line "$OUTF" "[dry-run] tar -cf $WORK/macos.tar --exclude .build --exclude .swiftpm -C $S/macos ." "macos/ is copied without .build/.swiftpm"
  assert_line "$OUTF" "[dry-run] codesign --force --sign - $APPS/.wasitme.app.stage" "ad-hoc signature on the staged bundle"
  assert_line "$OUTF" "[dry-run] codesign --verify --deep --strict $APPS/.wasitme.app.stage" "signature verified on the staged bundle"
  assert_line "$OUTF" "[dry-run] mv $APPS/.wasitme.app.stage $APPS/wasitme.app" "bundle swapped into place"
  assert_line "$OUTF" "[dry-run] codesign --verify --deep --strict $APPS/wasitme.app" "signature verified again at the final path"
  assert_line "$OUTF" "[dry-run] write $APPS/.wasitme.app.stage/Contents/Info.plist (mode 644)" "Info.plist written"
  assert_line "$OUTF" "[dry-run] launchctl bootstrap gui/$T_UID $LA/$LABEL_SCAN.plist" "scan agent loaded"
  assert_line "$OUTF" "[dry-run] launchctl bootstrap gui/$T_UID $LA/$LABEL_APP.plist" "menu bar agent loaded"
  assert_line "$OUTF" "[dry-run] write $LA/$LABEL_SCAN.plist (mode 644)" "scan plist planned"
  assert_line "$OUTF" "[dry-run] write $LA/$LABEL_APP.plist (mode 644)" "app plist planned"
  swift_line=$(grep -n 'swift build' "$OUTF" | head -1 | cut -d: -f1)
  engine_line=$(grep -n "mv $ST $V" "$OUTF" | head -1 | cut -d: -f1)
  assert_eq "yes" "$( [ "$engine_line" -lt "$swift_line" ] && echo yes || echo no )" "the engine goes in before the long Swift build"
fi

t_section "determinism"
first=$(sed 's/wasitme-bak-[0-9]*/wasitme-bak-N/' "$OUTF")
inst_from --dry-run --yes
second=$(sed 's/wasitme-bak-[0-9]*/wasitme-bak-N/' "$T_OUT")
assert_eq "$first" "$second" "dry run output is stable (apart from the backup timestamp)"

t_section "dry run with nothing available"
sb_new
make_fixture "$SB_SRC" 0.1.0 macos-fake
export WASITME_DEVELOPER_DIRS=/nonexistent
inst_from --dry-run --yes --agents claude-code
unset WASITME_DEVELOPER_DIRS
assert_rc 0 "dry run works without a Swift toolchain"
if [ "$T_OS" = Darwin ]; then
  assert_contains "$(out)" "no Swift toolchain found" "missing toolchain is reported in the plan"
fi

t_section "remote dry run does not download"
sb_new
inst --dry-run --yes --url https://example.test/wasitme.tar.gz
assert_rc 0 "dry run with --url succeeds"
assert_contains "$(out)" "[dry-run] download https://example.test/wasitme.tar.gz" "download is planned, not performed"
assert_eq "0" "$(count_lines "$SHIM_LOG")" "the fake curl was never called"

t_done
