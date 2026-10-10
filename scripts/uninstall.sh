#!/bin/sh
# wasitme uninstaller: reverses what the installer created, and only that, using the install manifest at
# ~/.wasitme/install-manifest (README "Update and uninstall"). In this order: the Claude Code plugin and its marketplace, your
# status line (restored only if it is still wasitme's), the Codex plugin and its marketplace, the LaunchAgents, the app,
# the PATH line (if you let the installer add one), the command and ~/.wasitme/versions + current.
# Your history in ~/.wasitme is kept unless you choose to delete it (or pass --purge). Your agent logs are never touched.
#
#   sh ~/.wasitme/current/scripts/uninstall.sh [--dry-run] [--purge] [--yes]
#   sh ~/.wasitme/current/scripts/uninstall.sh --only codex-plugin[,statusline,...] [--yes]    one part; the rest stays
#
# Wrapped in main(), called on the last line, so the script can safely delete the folder it runs from.
set -eu
LC_ALL=C
export LC_ALL

usage() {
  cat <<'EOF'
wasitme uninstaller

Usage: sh uninstall.sh [options]
  --dry-run, -n   print what would be removed; changes nothing
  --purge         ALSO delete ~/.wasitme (your saved history and settings). Asks first unless --yes.
  --yes, -y       ask nothing: remove every part, keep the history (unless --purge)
  --only PARTS    remove only these parts and keep everything else installed (the engine and the command always stay):
                  app, scan-agent (or scan), claude-plugin, codex-plugin, statusline (comma-separated). Asks once on a
                  terminal unless --yes. `install.sh --add PART` puts a part back.
  --from-app      (with --yes; what the Mac app runs) start the run detached and return at once, so it survives the app
                  quitting; it waits for the app to quit before removing it. The result goes to
                  ~/.wasitme/state/last-action.json (deleted again after a full uninstall: nothing is left to read it)
  --prefix DIR    the same --prefix you installed with (default ~/.local)
  --home DIR      the same --home you installed with (tests, sandboxes)
  --help, -h
On a terminal it asks before each part (Enter = remove it) and whether to keep your history (Enter = keep).
A part you keep keeps the engine too, because it runs from it; run the uninstaller again to remove the rest.
Exit codes: 0 done (or nothing to remove), 1 something could not be removed (re-run to retry), 2 usage.
EOF
}

note_fail() { FAILURES=$((FAILURES + 1)); warn "$*"; }

# ---- Asking (each step asks unless --yes; README "Update and uninstall") -------------------------------------------
# Every question is asked BEFORE anything is removed, so running out of answers changes nothing.
ASKING=0
KEPT=""
has_kind() { manifest_lines "$1" | grep -q .; }
ask_part() {  # ask_part VAR LABEL KINDS QUESTION: sets VAR=1 (remove) or 0 (keep: remembered in KEPT and KEEP_KINDS)
  eval "$1=1"
  [ "$ASKING" = 1 ] || return 0
  ask_yn "$4" yes
  [ "$ASK_RESULT" = no ] || return 0
  eval "$1=0"
  KEPT="${KEPT:+$KEPT, }$2"
  KEEP_KINDS="$KEEP_KINDS $3"
}

plan_removals() {
  DO_CLAUDE=0; DO_STATUS=0; DO_CODEX=0; DO_BG=0; DO_RC=0
  if has_kind claude-plugin; then ask_part DO_CLAUDE "Claude Code plugin" claude-plugin "Remove the Claude Code plugin?"; fi
  if has_kind statusline; then ask_part DO_STATUS "status line" statusline "Restore your Claude Code status line (only if it is still wasitme's)?"; fi
  if has_kind codex-plugin; then ask_part DO_CODEX "Codex plugin" codex-plugin "Remove the Codex plugin?"; fi
  if has_kind launchagent || has_kind app; then ask_part DO_BG "background scan and app" "launchagent app" "Remove the background scan and the menu bar app?"; fi
  if has_kind rcline; then ask_part DO_RC "PATH line" rcline "Remove the PATH line wasitme added to your shell profile?"; fi
}

remove_statusline() {
  [ "$DO_STATUS" = 1 ] || return 0
  while IFS="$TAB" read -r us_kind us_settings us_backup us_sha us_cmd; do
    [ "$us_kind" = statusline ] || continue
    case $us_settings in
      */settings.json) ;;
      *) note_fail "ignoring a status line entry with an unexpected path"; continue ;;
    esac
    case $us_backup in
      -|"$us_settings".wasitme-bak-*) ;;
      *) note_fail "ignoring a status line entry with an unexpected backup path"; continue ;;
    esac
    if [ -z "$NODE" ]; then
      note_fail "node was not found, so $us_settings could not be restored. Your backup is at $us_backup"
      continue
    fi
    if [ "$DRY" = 1 ]; then
      run "$NODE" "$LIB_DIR/jsonutil.mjs" statusline-restore "$us_settings" "$us_backup" "$us_sha" "$us_cmd"
      continue
    fi
    if ! us_out=$(jsonutil statusline-restore "$us_settings" "$us_backup" "$us_sha" "$us_cmd"); then
      note_fail "could not restore $us_settings (it was not changed). Backup: $us_backup"
      continue
    fi
    case $us_out in
      restored) say "  restored $us_settings exactly as it was before wasitme" ;;
      removed) if [ "$us_backup" = - ]; then say "  removed wasitme's statusLine from $us_settings (the file changed after the install, so only that key was removed)"; else say "  removed wasitme's statusLine from $us_settings (the file changed after the install, by you or by Claude Code's own plugin settings, so only that key was removed; your file from before the install is kept at $us_backup)"; fi ;;
      absent) say "  $us_settings is already gone" ;;
      *) say "  left $us_settings alone: its statusLine is not the one wasitme added. Backup kept at $us_backup" ;;
    esac
  done <<EOF
$(manifest_lines statusline)
EOF
}

# `wasitme statusline install [--wrap]` (the engine) can also point Claude Code's status line at the status-line shim,
# wrapping (with --wrap) a status line the person already had; that edit is not in the install manifest. Before the engine and the shim go,
# let the engine undo its own edit (it puts the old status line back byte for byte, only if it is still wasitme's).
engine_cli_path() {  # the installed engine's cli from engine.json (one key per line), else the default under `current`
  ec_cli=$(sed -n 's/^[[:space:]]*"cli":[[:space:]]*"\([^"]*\)"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p' "$STATE_DIR/engine.json" 2>/dev/null | head -n 1)
  [ -n "$ec_cli" ] || ec_cli="$CURRENT_LINK/engine/dist/src/cli/main.js"
  printf '%s\n' "$ec_cli"
}

remove_wrapped_statusline() {
  [ -f "$CLAUDE_SETTINGS" ] || return 0
  [ -n "$NODE" ] || return 0
  # A dry run that plans to restore settings.json from the manifest (the real run does it first, after which the line is no
  # longer ours and the engine is never called) must not plan the engine call as well.
  if [ "$DRY" = 1 ] && [ "$DO_STATUS" = 1 ] && has_kind statusline; then return 0; fi
  rw_state=$(statusline_state_of "$CLAUDE_SETTINGS" "$SL_SHIM") || return 0
  [ "$rw_state" = ours ] || return 0
  rw_cli=$(engine_cli_path)
  if [ ! -f "$rw_cli" ]; then
    note_fail "Claude Code's status line in $CLAUDE_SETTINGS still runs $SL_SHIM, and the engine that would restore your previous one is gone. Remove the statusLine entry there (or set it back) yourself"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    run "$NODE" "$rw_cli" statusline uninstall --script "$SL_SHIM" --claude-dir "$CLAUDE_DIR"
    return 0
  fi
  if rw_out=$("$NODE" "$rw_cli" statusline uninstall --script "$SL_SHIM" --claude-dir "$CLAUDE_DIR" 2>&1 </dev/null); then
    say "  $rw_out"
  else
    note_fail "could not take wasitme out of the status line in $CLAUDE_SETTINGS: $rw_out"
  fi
}

valid_id() {  # plugin ids / marketplace names / launchd labels: boring characters, never option-like
  case $1 in
    ''|-*|*[!A-Za-z0-9._@-]*) return 1 ;;
  esac
  return 0
}

# `claude plugin uninstall` then `claude plugin marketplace remove` (this erases the plugin's saved options,
# which is what an uninstall should do).
remove_claude_plugin() {
  [ "$DO_CLAUDE" = 1 ] || return 0
  while IFS="$TAB" read -r up_kind up_id up_mkt _; do
    [ "$up_kind" = claude-plugin ] || continue
    if ! valid_id "$up_id" || ! valid_id "$up_mkt"; then note_fail "ignoring a $up_kind entry with an unexpected name"; continue; fi
    if have_cmd "$CLAUDE_BIN"; then
      run_claude plugin uninstall "$up_id" || note_fail "claude plugin uninstall $up_id failed (run it yourself)"
      run_claude plugin marketplace remove "$up_mkt" || note_fail "claude plugin marketplace remove $up_mkt failed (run it yourself)"
    else
      # Without the CLI there is nothing to clean in it, so this is a note, not a failure (no dead end).
      warn "the 'claude' command was not found, so its plugin was not removed. If you reinstall Claude Code later, run: claude plugin uninstall $up_id; claude plugin marketplace remove $up_mkt"
    fi
  done <<EOF
$(manifest_lines claude-plugin)
EOF
}

# When the `codex` command is gone, remove exactly wasitme's two tables from config.toml (PRIVACY.md "Backups the installer makes"), keeping a
# 0600 byte copy until the edit is verified.
codex_toml_fallback() {  # codex_toml_fallback ID MARKETPLACE
  ct_file="$CODEX_DIR/config.toml"
  if [ ! -f "$ct_file" ] || ! grep -qF -e "[plugins.\"$1\"]" -e "[marketplaces.$2]" "$ct_file" 2>/dev/null; then return 0; fi
  if [ -z "$NODE" ]; then note_fail "node was not found, so wasitme's entries in $ct_file were left there"; return 0; fi
  if [ "$DRY" = 1 ]; then
    run "$NODE" "$LIB_DIR/jsonutil.mjs" toml-remove "$ct_file" "plugins.\"$1\"" "marketplaces.$2"
    return 0
  fi
  ct_bak="$WORK_DIR/config.toml.copy"
  ( umask 077 && cp "$ct_file" "$ct_bak" ) || { note_fail "could not copy $ct_file before editing it; left it alone"; return 0; }
  if ! jsonutil toml-remove "$ct_file" "plugins.\"$1\"" "marketplaces.$2" >/dev/null; then
    cp "$ct_bak" "$ct_file" 2>/dev/null || true
    note_fail "could not remove wasitme's entries from $ct_file (it was put back as it was)"
    return 0
  fi
  if grep -qF -e "[plugins.\"$1\"]" -e "[marketplaces.$2]" "$ct_file" 2>/dev/null; then
    cp "$ct_bak" "$ct_file" 2>/dev/null || true
    note_fail "wasitme's entries were still in $ct_file after the edit; it was put back as it was"
    return 0
  fi
  rm -f "$ct_bak"
  say "  removed wasitme's [plugins.\"$1\"] and [marketplaces.$2] tables from $ct_file (the codex command was not found)"
}

# D49: `codex plugin remove` FIRST, then `codex plugin marketplace remove`. The other order leaves the plugin
# enabled with its skill still offered to the model (S-CX 2.6).
remove_codex_plugin() {
  [ "$DO_CODEX" = 1 ] || return 0
  while IFS="$TAB" read -r up_kind up_id up_mkt _; do
    [ "$up_kind" = codex-plugin ] || continue
    if ! valid_id "$up_id" || ! valid_id "$up_mkt"; then note_fail "ignoring a $up_kind entry with an unexpected name"; continue; fi
    if have_cmd "$CODEX_BIN"; then
      run_codex plugin remove "$up_id" || note_fail "codex plugin remove $up_id failed (run it yourself)"
      run_codex plugin marketplace remove "$up_mkt" || note_fail "codex plugin marketplace remove $up_mkt failed (run it yourself)"
    else
      codex_toml_fallback "$up_id" "$up_mkt"
    fi
  done <<EOF
$(manifest_lines codex-plugin)
EOF
}

# Every LaunchAgent wasitme installed, or with a LABEL-BASE only that one (its label is LABEL-BASE, or LABEL-BASE.<suffix>
# for a sandbox or test install).
remove_agents() {  # remove_agents [LABEL-BASE]
  ra_base=${1:-}
  while IFS="$TAB" read -r ua_kind ua_label ua_plist; do
    [ "$ua_kind" = launchagent ] || continue
    if [ -n "$ra_base" ]; then case $ua_label in "$ra_base"|"$ra_base".*) ;; *) continue ;; esac; fi
    if ! valid_id "$ua_label" || ! safe_path "$ua_plist"; then note_fail "ignoring a LaunchAgent entry with an unexpected label or path"; continue; fi
    if [ "$LAUNCHCTL_ON" = 1 ]; then run_launchctl bootout "gui/$UID_NUM/$ua_label" || true; fi
    if [ -f "$ua_plist" ]; then
      if grep -q "$WASITME_MARKER" "$ua_plist" 2>/dev/null; then
        run rm -f "$ua_plist" || note_fail "could not remove $ua_plist"
      else
        note_fail "$ua_plist is no longer the file wasitme wrote; left it alone"
      fi
    fi
  done <<EOF
$(manifest_lines launchagent)
EOF
  # What the agents wrote (they are stopped now). The folder itself is removed below if we created it.
  case $ra_base in
    '') run rm -f "$LOG_DIR/scan.log" "$LOG_DIR/app.log" || true ;;
    "$WASITME_LABEL_SCAN") run rm -f "$LOG_DIR/scan.log" || true ;;
    "$WASITME_LABEL_APP") run rm -f "$LOG_DIR/app.log" || true ;;
  esac
}

remove_apps() {
  while IFS="$TAB" read -r uv_kind uv_path; do
    [ "$uv_kind" = app ] || continue
    if ! safe_path "$uv_path"; then note_fail "ignoring an app entry with an unexpected path"; continue; fi
    if [ ! -e "$uv_path" ]; then continue; fi
    if app_is_ours "$uv_path"; then
      # Quit a copy the person opened themselves (the LaunchAgent's copy stopped with its bootout): only processes of
      # this user whose executable lives inside this exact bundle. launchd's gui domain is never touched under --home
      # without an injected launchctl, and the same goes for this.
      if [ "$LAUNCHCTL_ON" = 1 ]; then run_tool pkill "$PKILL_BIN" -U "$UID_NUM" -f "$uv_path/Contents/MacOS/" || true; fi
      run rm -rf "$uv_path" || note_fail "could not remove $uv_path"
    else
      note_fail "$uv_path is not the wasitme app any more; left it alone"
    fi
  done <<EOF
$(manifest_lines app)
EOF
}

remove_background() {
  [ "$DO_BG" = 1 ] || return 0
  remove_agents
  remove_apps
}

# The PATH line the installer added to a shell profile after you said yes (README "Install").
remove_rclines() {
  [ "$DO_RC" = 1 ] || return 0
  while IFS="$TAB" read -r ur_kind ur_file ur_backup ur_sha ur_line; do
    [ "$ur_kind" = rcline ] || continue
    if ! safe_path "$ur_file"; then note_fail "ignoring a PATH line entry with an unexpected path"; continue; fi
    case $ur_backup in
      -|"$ur_file".wasitme-bak-*) ;;
      *) note_fail "ignoring a PATH line entry with an unexpected backup path"; continue ;;
    esac
    if [ -z "$NODE" ]; then note_fail "node was not found, so the wasitme PATH line in $ur_file was left there"; continue; fi
    if [ "$DRY" = 1 ]; then
      run "$NODE" "$LIB_DIR/jsonutil.mjs" rc-remove "$ur_file" "$ur_backup" "$ur_sha" "$ur_line"
      continue
    fi
    if ! ur_out=$(jsonutil rc-remove "$ur_file" "$ur_backup" "$ur_sha" "$ur_line"); then
      note_fail "could not edit $ur_file (it was not changed)"
      continue
    fi
    case $ur_out in
      restored) say "  restored $ur_file exactly as it was before wasitme" ;;
      removed) say "  removed the two wasitme lines from $ur_file" ;;
      absent) ;;
      *) say "  $ur_file no longer has the wasitme lines; left it alone" ;;
    esac
  done <<EOF
$(manifest_lines rcline)
EOF
}

# Prefixes this install used (one `prefix` line per --prefix ever installed with), newest last.
RECORDED_PREFIXES=""

# A version folder is one of ours when it sits under ~/.wasitme/versions, or (installers before D46) under
# <any recorded prefix>/share/wasitme.
dir_in_install_locations() {  # dir_in_install_locations PATH
  case $1 in "$LEGACY_DATA_DIR"/*|"$VERSIONS_DIR"/*) return 0 ;; esac
  while IFS= read -r di_p; do
    [ -n "$di_p" ] || continue
    case $1 in "${di_p%/}"/share/wasitme/*) return 0 ;; esac
  done <<EOF
$RECORDED_PREFIXES
EOF
  return 1
}

# Why an entry was not touched. A prefix outside HOME is only trusted when the user names it, so say exactly how.
note_bad_path() {  # note_bad_path WHAT PATH
  nb_hint=""
  while IFS= read -r nb_p; do
    [ -n "$nb_p" ] || continue
    case $2 in "${nb_p%/}"/*) nb_hint=${nb_p%/}; break ;; esac
  done <<EOF
$RECORDED_PREFIXES
EOF
  if [ -n "$nb_hint" ]; then
    note_fail "$2 was installed with --prefix $nb_hint; run the uninstaller again with --prefix $nb_hint"
  else
    note_fail "ignoring $1 with an unexpected path"
  fi
}

remove_engine() {
  RECORDED_PREFIXES=$(manifest_lines prefix | awk -F '\t' '{ print $2 }')
  while IFS="$TAB" read -r ue_kind ue_path; do
    case $ue_kind in shim|symlink|dir|file) ;; *) continue ;; esac
    # Already gone (an earlier run, or by hand): nothing to remove and nothing to complain about, so a re-run converges.
    if [ ! -e "$ue_path" ] && [ ! -L "$ue_path" ]; then continue; fi
    case $ue_kind in
      shim)
        if ! safe_path "$ue_path"; then note_bad_path "a command entry" "$ue_path"; continue; fi
        if grep -q "$WASITME_MARKER" "$ue_path" 2>/dev/null; then
          run rm -f "$ue_path" || note_fail "could not remove $ue_path"
        else
          note_fail "$ue_path is not the file wasitme wrote; left it alone"
        fi ;;
      symlink)
        if ! safe_path "$ue_path"; then note_bad_path "a symlink entry" "$ue_path"; continue; fi
        if [ -L "$ue_path" ]; then
          run rm -f "$ue_path" || note_fail "could not remove $ue_path"
        else
          note_fail "$ue_path is not a symlink any more; left it alone"
        fi ;;
      dir)
        if ! dir_in_install_locations "$ue_path"; then note_fail "ignoring a folder entry outside the install locations"; continue; fi
        if ! safe_path "$ue_path"; then note_bad_path "a folder entry" "$ue_path"; continue; fi
        rm_tree "$ue_path" || note_fail "could not remove $ue_path" ;;   # version folders are read-only (a-w)
      file)
        case $ue_path in
          "$STATE_DIR"/*) ;;
          *) note_fail "ignoring a file entry outside $STATE_DIR"; continue ;;
        esac
        if ! safe_path "$ue_path"; then note_fail "ignoring a file entry with an unexpected path"; continue; fi
        run rm -f "$ue_path" || note_fail "could not remove $ue_path" ;;
    esac
  done <<EOF
$(manifest_lines shim)
$(manifest_lines symlink)
$(manifest_lines dir)
$(manifest_lines file)
EOF
  # Leftovers of an interrupted install.
  for re_left in "$LEGACY_DATA_DIR/.stage" "$LEGACY_DATA_DIR/.parked" "$VERSIONS_DIR/.stage" "$VERSIONS_DIR/.parked"; do
    rm_tree "$re_left" || true
  done
  run rm -rf "$APPS_DIR/.wasitme.app.stage" "$APPS_DIR/.wasitme.app.prev" || true
}

# Keep only the manifest lines of the parts that stay, plus everything the engine needs, so a later run removes the rest.
manifest_keep() {  # manifest_keep "KIND KIND ..."
  [ "$DRY" = 1 ] && return 0
  mk_tmp="$MANIFEST.tmp.$$"
  awk -F '\t' -v keep=" format prefix dir symlink file shim createddir $1 " 'index(keep, " " $1 " ") > 0' "$MANIFEST" >"$mk_tmp" || { rm -f "$mk_tmp"; return 1; }
  chmod 600 "$mk_tmp" 2>/dev/null || true
  mv -f "$mk_tmp" "$MANIFEST" || { rm -f "$mk_tmp"; return 1; }
}

# ~/.wasitme as an uninstall leaves it when the history is kept: a real folder of this user's, holding wasitme's data
# (its salt, or history, glance and snapshot files) and no installed code (no versions/, no current, no manifest).
leftover_history() {
  [ -d "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] || return 1
  [ "$(ls -ldn "$STATE_DIR" 2>/dev/null | awk '{ print $3 }')" = "$UID_NUM" ] || return 1
  [ ! -e "$VERSIONS_DIR" ] && [ ! -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ] && [ ! -e "$MANIFEST" ] || return 1
  [ -f "$STATE_DIR/salt" ] || [ -e "$STATE_DIR/history" ] || [ -f "$GLANCE_PATH" ] || [ -f "$STATE_DIR/snapshot.json" ]
}

purge_leftover() {
  safe_path "$STATE_DIR" || die "refusing to delete $STATE_DIR"
  if [ "$DRY" = 1 ]; then
    rm_tree "$STATE_DIR"
    say "Dry run: nothing was removed."
    return 0
  fi
  if [ "$ASSUME_YES" = 0 ]; then
    if tty_open; then
      ask_yn "Permanently delete $STATE_DIR (your saved wasitme history, $(history_size))?" no
      if [ "$ASK_RESULT" = no ]; then say "Nothing was changed."; return 0; fi
    else
      usage_die "--purge deletes your saved history and there is no terminal to confirm on; add --yes to proceed"
    fi
  fi
  rm_tree "$STATE_DIR" || die "could not remove $STATE_DIR"
  say "Deleted $STATE_DIR (the history an earlier uninstall kept). Your agent logs were never modified."
}

history_size() {  # e.g. "1.2 MB" for the history the uninstaller would keep (not the code in versions/), or ""
  [ -d "$STATE_DIR" ] || return 0
  find "$STATE_DIR" -path "$VERSIONS_DIR" -prune -o -type f -exec cat {} + 2>/dev/null | wc -c |
    awk '{ b = $1; if (b >= 1048576) printf "%.1f MB", b / 1048576; else if (b >= 1024) printf "%.0f KB", b / 1024; else printf "%d bytes", b }'
}

# ---- One part at a time (--only; the Control Center's "Remove" buttons) ----------------------------------------------
ONLY_PARTS="app scan-agent claude-plugin codex-plugin statusline"

part_label() {
  case $1 in
    app) printf 'Mac app' ;; scan-agent) printf 'background scan' ;; claude-plugin) printf 'Claude Code plugin' ;;
    codex-plugin) printf 'Codex plugin' ;; statusline) printf 'status line' ;;
  esac
}

has_agent() {  # has_agent LABEL-BASE: the manifest lists a LaunchAgent with that label (or LABEL-BASE.<suffix>)
  manifest_lines launchagent | awk -F '\t' -v b="$1" '$2 == b || index($2, b ".") == 1 { f = 1 } END { exit !f }'
}

manifest_drop_kind() {  # manifest_drop_kind KIND: forget every line of that kind
  [ "$DRY" = 1 ] && return 0
  md_tmp="$MANIFEST.tmp.$$"
  awk -F '\t' -v k="$1" '$1 != k { print }' "$MANIFEST" >"$md_tmp" || { rm -f "$md_tmp"; return 1; }
  chmod 600 "$md_tmp" 2>/dev/null || true
  mv -f "$md_tmp" "$MANIFEST" || { rm -f "$md_tmp"; return 1; }
}

manifest_drop_agents() {  # manifest_drop_agents LABEL-BASE
  manifest_lines launchagent | awk -F '\t' -v b="$1" '$2 == b || index($2, b ".") == 1 { print $2 }' | while IFS= read -r da_l; do
    manifest_drop launchagent "$da_l" || exit 1
  done
}

# Sets the named engine.json keys to null (and engine.env's scan_label to empty with scanLabel), so the app, `wasitme
# doctor` and the plugin hooks stop naming a part that is gone (the hooks kickstart engine.env's scan_label). engine.json is
# the installer's own file, one key per line; the edit keeps that layout and must still parse before it replaces the file.
engine_state_null() {  # engine_state_null KEY...
  [ -f "$ENGINE_JSON" ] || return 0
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] set %s to null in %s\n' "$*" "$(quote_arg "$ENGINE_JSON")"
    return 0
  fi
  en_tmp="$ENGINE_JSON.tmp.$$"
  ( umask 077 && awk -v keys=" $* " '
    {
      line = $0
      if (match(line, /^[ \t]*"[A-Za-z]+":/)) {
        lead = line; sub(/".*/, "", lead)
        k = substr(line, RSTART, RLENGTH); sub(/^[ \t]*"/, "", k); sub(/":$/, "", k)
        if (index(keys, " " k " ") > 0) line = lead "\"" k "\": null" ((line ~ /,[ \t]*$/) ? "," : "")
      }
      print line
    }' "$ENGINE_JSON" >"$en_tmp" ) || { rm -f "$en_tmp"; note_fail "could not update $ENGINE_JSON"; return 0; }
  if [ -n "$NODE" ] && ! "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$en_tmp" >/dev/null 2>&1 </dev/null; then
    rm -f "$en_tmp"
    note_fail "could not update $ENGINE_JSON (the edit did not parse; the file was left as it was)"
    return 0
  fi
  mv -f "$en_tmp" "$ENGINE_JSON" || { rm -f "$en_tmp"; note_fail "could not update $ENGINE_JSON"; return 0; }
  case " $* " in
    *" scanLabel "*)
      [ -f "$ENGINE_ENV" ] || return 0
      en_tmp="$ENGINE_ENV.tmp.$$"
      if ( umask 077 && sed 's/^scan_label=.*/scan_label=/' "$ENGINE_ENV" >"$en_tmp" ) && mv -f "$en_tmp" "$ENGINE_ENV"; then :; else
        rm -f "$en_tmp"
        note_fail "could not update $ENGINE_ENV"
      fi ;;
  esac
}

# Our status line, whichever way it was added: the installer's (in the manifest) or `wasitme statusline install [--wrap]`.
statusline_ours() {
  has_kind statusline && return 0
  [ -f "$CLAUDE_SETTINGS" ] && [ -n "$NODE" ] || return 1
  [ "$(statusline_state_of "$CLAUDE_SETTINGS" "$SL_SHIM")" = ours ]
}

# The app quits itself after it starts an uninstall (--from-app); give it a moment before its bundle goes, so it is not
# killed halfway through its own shutdown. A copy that is still running after that is stopped by remove_agents/remove_apps.
wait_app_quit() {
  [ "$FROM_APP" = 1 ] && [ "$LAUNCHCTL_ON" = 1 ] && [ "$DRY" = 0 ] || return 0
  wq_n=0
  wq_max=${WASITME_APP_QUIT_WAIT:-20}
  case $wq_max in ''|*[!0-9]*) wq_max=20 ;; esac
  while [ "$wq_n" -lt "$wq_max" ]; do
    "$PGREP_BIN" -U "$UID_NUM" -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1 </dev/null || return 0
    wq_n=$((wq_n + 1))
    sleep 0.5 2>/dev/null || sleep 1
  done
  return 0
}

# Folders the installer created that a removed part has left empty (~/.claude it made for the status line,
# ~/Applications, ~/Library/LaunchAgents) go too, newest first, and leave the manifest; a later --add creates and records
# them again. rmdir removes nothing but an empty folder. The log folder stays while a LaunchAgent remains (launchd writes
# that agent's log there and does not create the folder).
only_prune_dirs() {
  op_agents=0
  if has_kind launchagent; then op_agents=1; fi
  # The list is held in a variable, not a file in WORK_DIR: a dry run creates no work folder, so a file there cannot be written.
  op_list=$(manifest_lines createddir | awk -F '\t' '{ a[NR] = $2 } END { for (i = NR; i >= 1; i--) print a[i] }') || return 0
  while IFS= read -r op_d; do
    [ -n "$op_d" ] && [ -d "$op_d" ] && [ ! -L "$op_d" ] || continue
    safe_rmdir_path "$op_d" || continue
    if [ "$op_d" = "$LOG_DIR" ] && [ "$op_agents" = 1 ]; then continue; fi
    # A dry run removed nothing, so the folder is still full of what the parts would have taken out: plan the rmdir
    # (it only ever removes an empty folder), as the full uninstall's plan does, instead of testing for empty.
    if [ "$DRY" = 1 ]; then printf '[dry-run] rmdir %s (only if empty)\n' "$(quote_arg "$op_d")"; continue; fi
    [ -z "$(ls -A "$op_d" 2>/dev/null)" ] || continue
    if rmdir "$op_d" 2>/dev/null; then manifest_drop createddir "$op_d" || true; fi
  done <<EOF
$op_list
EOF
}

# --only PARTS: remove exactly those parts, the way the full uninstall removes them, and keep the manifest, engine.json and
# engine.env consistent with what is left. A part that fails keeps its manifest lines, so a re-run retries it.
only_main() {
  om_todo=""; om_none=""
  for om_p in $(printf '%s' "$OPT_ONLY" | tr ',' ' '); do
    case " $om_todo " in *" $om_p "*) continue ;; esac
    om_has=0
    case $om_p in
      app) if has_kind app || has_agent "$WASITME_LABEL_APP"; then om_has=1; fi ;;
      scan-agent) if has_agent "$WASITME_LABEL_SCAN"; then om_has=1; fi ;;
      claude-plugin) if has_kind claude-plugin; then om_has=1; fi ;;
      codex-plugin) if has_kind codex-plugin; then om_has=1; fi ;;
      statusline) if statusline_ours; then om_has=1; fi ;;
    esac
    if [ "$om_has" = 1 ]; then om_todo="$om_todo $om_p"; else om_none="${om_none:+$om_none, }$(part_label "$om_p")"; fi
  done
  om_todo=${om_todo# }
  if [ -z "$om_todo" ]; then
    say "Nothing to remove: wasitme's $om_none is not installed here."
    exit 0
  fi
  om_labels=""
  for om_p in $om_todo; do om_labels="${om_labels:+$om_labels, }$(part_label "$om_p")"; done
  if [ "$ASSUME_YES" = 0 ] && [ "$DRY" = 0 ] && tty_open; then
    ask_yn "Remove the $om_labels? The rest of wasitme stays installed." yes
    if [ "$ASK_RESULT" = no ]; then say "Nothing was changed."; exit 0; fi
  fi

  make_work_dir
  setup_traps
  if [ -d "$STATE_DIR" ]; then acquire_lock; fi
  step "Removing the $om_labels"
  DO_CLAUDE=0; DO_STATUS=0; DO_CODEX=0
  om_done=""; om_failed=""
  for om_p in $om_todo; do
    om_f0=$FAILURES
    case $om_p in
      claude-plugin) DO_CLAUDE=1; remove_claude_plugin ;;
      codex-plugin) DO_CODEX=1; remove_codex_plugin ;;
      statusline) DO_STATUS=1; remove_statusline; remove_wrapped_statusline ;;
      scan-agent) remove_agents "$WASITME_LABEL_SCAN" ;;
      app) wait_app_quit; remove_agents "$WASITME_LABEL_APP"; remove_apps ;;
    esac
    if [ "$FAILURES" != "$om_f0" ]; then om_failed="${om_failed:+$om_failed, }$(part_label "$om_p")"; continue; fi
    om_ok=1
    case $om_p in
      claude-plugin|codex-plugin|statusline) manifest_drop_kind "$om_p" || om_ok=0 ;;
      scan-agent) manifest_drop_agents "$WASITME_LABEL_SCAN" || om_ok=0; engine_state_null scanLabel ;;
      app) { manifest_drop_agents "$WASITME_LABEL_APP" && manifest_drop_kind app; } || om_ok=0; engine_state_null appLabel app ;;
    esac
    if [ "$om_ok" = 0 ]; then note_fail "could not update $MANIFEST"; fi
    if [ "$FAILURES" != "$om_f0" ]; then om_failed="${om_failed:+$om_failed, }$(part_label "$om_p")"; continue; fi
    om_done="${om_done:+$om_done, }$(part_label "$om_p")"
  done
  if [ -n "$om_done" ]; then only_prune_dirs; fi
  release_lock
  say ""
  if [ "$DRY" = 1 ]; then
    say "Dry run: nothing was removed. The [dry-run] lines above are exactly what a real run would do."
    exit 0
  fi
  if [ -n "$om_failed" ]; then
    say "Not removed: $om_failed (see the warnings above). Re-run to retry.${om_done:+ Removed: $om_done.}"
    exit 1
  fi
  say "Removed: $om_done. The rest of wasitme stays installed (to add a part back: sh $CURRENT_LINK/scripts/install.sh --add PART)."
  exit 0
}

main() {
  here=""
  if [ -f "$0" ]; then here=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || here=""; fi
  [ -n "$here" ] && [ -f "$here/lib/common.sh" ] || { printf 'error: cannot find lib/common.sh next to %s\n' "$0" >&2; exit 1; }
  LIB_DIR="$here/lib"
  # shellcheck source=lib/common.sh
  . "$LIB_DIR/common.sh"
  # shellcheck source=lib/guided.sh
  . "$LIB_DIR/guided.sh"   # loaded now: this script may delete the folder it runs from

  DRY=0; ASSUME_YES=0; PURGE=0; OPT_HOME=""; OPT_PREFIX=""; FAILURES=0; KEEP_KINDS=""; OPT_ONLY=""; FROM_APP=0
  UN_ARGS=$(quote_argv "$@")
  while [ $# -gt 0 ]; do
    case $1 in
      --dry-run|-n) DRY=1 ;;
      --purge) PURGE=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      --only) [ $# -ge 2 ] || usage_die "--only needs a part, such as --only codex-plugin"; OPT_ONLY="${OPT_ONLY:+$OPT_ONLY,}$2"; shift ;;
      --from-app) FROM_APP=1 ;;
      --prefix) [ $# -ge 2 ] || usage_die "--prefix needs a directory"; OPT_PREFIX=$2; shift ;;
      --home) [ $# -ge 2 ] || usage_die "--home needs a directory"; OPT_HOME=$2; shift ;;
      --help|-h) usage; exit 0 ;;
      *) usage_die "unknown option: $1" ;;
    esac
    shift
  done
  if [ -n "$OPT_HOME" ]; then case $OPT_HOME in /*) ;; *) usage_die "--home must be an absolute path" ;; esac; fi
  if [ -n "$OPT_PREFIX" ]; then case $OPT_PREFIX in /*) ;; *) usage_die "--prefix must be an absolute path" ;; esac; fi
  if [ -n "$OPT_ONLY" ]; then
    [ "$PURGE" = 0 ] || usage_die "--only removes single parts and keeps your history; --purge belongs to a full uninstall"
    # `scan` is the Control Center's name for the scan agent.
    om_list=""
    for om_p in $(printf '%s' "$OPT_ONLY" | tr ',' ' '); do
      if [ "$om_p" = scan ]; then om_p=scan-agent; fi
      case " $ONLY_PARTS " in *" $om_p "*) ;; *) usage_die "--only knows app, scan-agent, claude-plugin, codex-plugin and statusline, not '$om_p'" ;; esac
      case ",$om_list," in *",$om_p,"*) ;; *) om_list="${om_list:+$om_list,}$om_p" ;; esac
    done
    [ -n "$om_list" ] || usage_die "--only needs a part, such as --only codex-plugin"
    OPT_ONLY=$om_list
  fi

  if [ "$FROM_APP" = 1 ]; then
    [ "$ASSUME_YES" = 1 ] || usage_die "--from-app runs without a terminal to ask on; add --yes"
    [ "$DRY" = 0 ] || usage_die "--from-app cannot be a dry run"
  fi

  init_runtime
  init_paths
  if [ "$FROM_APP" = 1 ] && [ "${WASITME_FROM_APP_STAGE:-}" != inner ]; then
    eval "set -- $UN_ARGS"
    if [ -n "$OPT_ONLY" ]; then un_action=remove; else un_action=uninstall; fi
    from_app_launch "$un_action" "$STATE_DIR" "$HOME_DIR" "$here/$(basename "$0")" "$@"
  fi
  NODE=$(command -v node 2>/dev/null || true)

  if [ ! -f "$MANIFEST" ]; then
    # What an earlier uninstall kept: only wasitme's own data, no installed code. --purge may delete that on its own.
    if [ "$PURGE" = 1 ] && leftover_history; then purge_leftover; exit 0; fi
    say "Nothing to uninstall: no install record at $MANIFEST."
    say "(If you installed with --home or --prefix, pass the same options here.)"
    if [ "$PURGE" = 1 ] && [ -d "$STATE_DIR" ]; then say "Nothing was purged either: $STATE_DIR does not look like history a wasitme uninstall left behind."; fi
    exit 0
  fi

  # A prefix chosen at install time is remembered. Adopt it when it is inside HOME; outside HOME, ask for it explicitly.
  if [ -z "$OPT_PREFIX" ]; then
    un_prefix=$(manifest_lines prefix | awk -F '\t' 'NR == 1 { print $2 }')
    if [ -n "$un_prefix" ] && [ "$un_prefix" != "$PREFIX" ]; then
      case $un_prefix in
        "$HOME_DIR"/*) OPT_PREFIX=$un_prefix; init_paths ;;
        *) die "this install used --prefix $un_prefix; run the uninstaller again with --prefix $un_prefix" ;;
      esac
    fi
  fi

  if [ -n "$OPT_ONLY" ]; then only_main; fi

  # On a terminal (and without --yes) every part is asked about, and so is the history.
  if [ "$ASSUME_YES" = 0 ] && [ "$DRY" = 0 ] && tty_open; then ASKING=1; fi

  # --purge deletes the user's history: confirm with a human, or require --yes.
  if [ "$PURGE" = 1 ] && [ "$ASSUME_YES" = 0 ] && [ "$DRY" = 0 ]; then
    if [ "$ASKING" = 1 ]; then
      ask_yn "--purge will permanently delete $STATE_DIR (your saved wasitme history). Continue?" no
      if [ "$ASK_RESULT" = no ]; then say "Nothing was changed."; exit 0; fi
    else
      usage_die "--purge deletes your saved history and there is no terminal to confirm on; add --yes to proceed"
    fi
  fi

  plan_removals
  if [ "$ASKING" = 1 ] && [ "$PURGE" = 0 ] && [ -z "$KEPT" ]; then
    hs=$(history_size)
    ah_tries=0
    while :; do
      printf 'History (%s of numbers in %s): [k]eep (default) / [d]elete permanently ' "${hs:-a few bytes}" "$STATE_DIR"
      read_answer
      case $ANSWER in
        ''|[Kk]|[Kk][Ee][Ee][Pp]) break ;;
        [Dd]|[Dd][Ee][Ll][Ee][Tt][Ee]) PURGE=1; break ;;
      esac
      ah_tries=$((ah_tries + 1))
      if [ "$ah_tries" -ge 3 ]; then say "Keeping it."; break; fi
      say "Please answer k or d."
    done
  fi

  make_work_dir
  setup_traps
  if [ -d "$STATE_DIR" ]; then acquire_lock; fi

  step "Removing what wasitme installed"
  if [ "$DO_BG" = 1 ]; then wait_app_quit; fi
  remove_claude_plugin
  remove_statusline
  remove_codex_plugin
  remove_background
  remove_rclines

  if [ -n "$KEPT" ]; then
    # Something stays, and it runs from the engine: keep the engine and the record of what is left.
    release_lock
    if [ "$FAILURES" -gt 0 ]; then
      say ""
      say "Some steps need your attention (see the warnings above). Re-run this uninstaller to retry."
      exit 1
    fi
    manifest_keep "$KEEP_KINDS" || { warn "could not update $MANIFEST"; exit 1; }
    say ""
    say "Kept: $KEPT. The engine and the wasitme command stay too, because they use them."
    say "Run this uninstaller again to remove the rest. Your agent logs were never modified."
    exit 0
  fi

  remove_wrapped_statusline
  remove_engine

  CREATED_DIRS=$(manifest_lines createddir | awk -F '\t' '{ print $2 }' | awk '{ a[NR] = $0 } END { for (i = NR; i >= 1; i--) print a[i] }')
  release_lock

  if [ "$FAILURES" -gt 0 ]; then
    say ""
    say "Some steps need your attention (see the warnings above). The install record was kept, so re-run this uninstaller to retry."
    exit 1
  fi

  run rm -f "$MANIFEST" || { warn "could not remove $MANIFEST"; exit 1; }
  while IFS= read -r ud_dir; do
    [ -n "$ud_dir" ] || continue
    if safe_rmdir_path "$ud_dir"; then
      if [ "$DRY" = 1 ]; then printf '[dry-run] rmdir %s (only if empty)\n' "$(quote_arg "$ud_dir")"; else rmdir "$ud_dir" 2>/dev/null || true; fi
    fi
  done <<EOF
$CREATED_DIRS
EOF

  if [ "$PURGE" = 1 ]; then
    if safe_path "$STATE_DIR"; then rm_tree "$STATE_DIR" || { warn "could not remove $STATE_DIR"; exit 1; }; fi
  fi

  say ""
  if [ "$DRY" = 1 ]; then
    say "Dry run: nothing was removed. The [dry-run] lines above are exactly what a real run would do."
  else
    say "wasitme has been removed."
    # This uninstaller has just deleted itself (it lived in ~/.wasitme/current), so the way to delete the history later
    # is a plain command, not "--purge".
    if [ "$PURGE" = 1 ]; then say "Your saved history was deleted too."; elif [ -d "$STATE_DIR" ]; then say "Your saved history in $STATE_DIR was kept. To delete it as well:  rm -rf $(quote_arg "$STATE_DIR")"; fi
    say "Your agent logs were never modified."
  fi
  exit 0
}

main "$@"
