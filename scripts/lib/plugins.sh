# shellcheck shell=sh
# wasitme installer: Claude Code plugin, Codex plugin, Claude Code status line.
#
# Both plugins live in the version folder and are registered THROUGH ~/.wasitme/current (D32), never at a version
# folder and never from the source checkout (D25):
#   Claude Code  marketplace `wasitme` at ~/.wasitme/current (stored unresolved, so a flip of `current` moves the code
#                at once). Update = flip -> `claude plugin update` -> /reload-plugins. Never `plugin uninstall` or
#                `marketplace remove` on the update path: both erase the plugin's saved options (D50, S-INST 3.4).
#   Codex        marketplace `wasitme-codex` at ~/.wasitme/current/plugin-codex (skills only). Codex stores the RESOLVED
#                path, so an update re-registers it: marketplace remove -> add -> plugin add (D49, S-CX 2.5).
# Sourced after common.sh / engine.sh.

# Reads the Claude marketplace manifest. Sets PLUGIN_POSSIBLE (1/0), PLUGIN_WHY, MKT_NAME, PLUGIN_NAME, PLUGIN_ID.
read_marketplace() {
  PLUGIN_POSSIBLE=0
  PLUGIN_WHY=""
  MKT_NAME=""; PLUGIN_NAME=""; PLUGIN_ID=""
  rm_file="$SRC/.claude-plugin/marketplace.json"
  if [ ! -f "$rm_file" ]; then
    PLUGIN_WHY="this source has no .claude-plugin/marketplace.json"
    return 0
  fi
  if ! rm_out=$(jsonutil marketplace "$rm_file" 2>&1); then
    PLUGIN_WHY="marketplace.json is not usable: $rm_out"
    return 0
  fi
  MKT_NAME=$(printf '%s\n' "$rm_out" | sed -n 's/^name=//p' | head -n 1)
  PLUGIN_NAME=$(printf '%s\n' "$rm_out" | sed -n 's/^plugin=//p' | head -n 1)
  PLUGIN_ID="$PLUGIN_NAME@$MKT_NAME"
  # Every local plugin source must exist in the payload that goes into the version folder.
  for rm_src in $(printf '%s\n' "$rm_out" | sed -n 's/^source=//p'); do
    rm_rel=${rm_src#./}
    case $rm_rel in
      .|'') PLUGIN_WHY="a marketplace source of './' (the whole repository) is not supported; expected a plugin/ subfolder"; return 0 ;;
    esac
    case $rm_rel in
      plugin|plugin/*) ;;
      *) PLUGIN_WHY="marketplace source '$rm_src' is outside plugin/, the folder the installer copies"; return 0 ;;
    esac
    if [ ! -d "$SRC/$rm_rel" ]; then PLUGIN_WHY="marketplace source '$rm_src' does not exist in this source"; return 0; fi
  done
  PLUGIN_POSSIBLE=1
}

# Reads plugin-codex/ (the separate Codex marketplace root, D32/D49). Sets CX_POSSIBLE, CX_WHY, CX_MKT, CX_ID.
read_codex_root() {
  CX_POSSIBLE=0; CX_WHY=""; CX_MKT=""; CX_ID=""
  if [ ! -d "$SRC/plugin-codex" ]; then
    CX_WHY="this source has no plugin-codex/ folder (the Codex plugin root)"
    return 0
  fi
  if ! rc_out=$(jsonutil codex-root "$SRC/plugin-codex" "$VERSION" 2>&1); then
    CX_WHY="plugin-codex/ is not usable: $rc_out"
    return 0
  fi
  CX_MKT=$(printf '%s\n' "$rc_out" | sed -n 's/^name=//p' | head -n 1)
  CX_ID="$(printf '%s\n' "$rc_out" | sed -n 's/^plugin=//p' | head -n 1)@$CX_MKT"
  CX_POSSIBLE=1
}

ROLLBACK_INCOMPLETE=0

# ---- Growth check (README "Update and uninstall") ----------------------------------------------------------------------
# An update must not quietly widen what the Claude Code mod and hooks can do: if the new plugin hooks or calls anything
# the installed one did not, show the difference and continue only on a yes (guided) or --accept-plugin-changes.
# Hooks come from hooks.json; calls from `claude plugin validate --strict` on temporary copies (a read-only query).
# Runs whenever our Claude Code plugin is installed, whatever the flags say: one flip of `current` moves its code.
set_difference() { awk 'NR == FNR { seen[$0] = 1; next } !($0 in seen)' "$1" "$2"; }   # lines of $2 not in $1

growth_check() {
  manifest_lines claude-plugin | grep -q . || return 0
  [ -n "$PREV_DIR" ] && [ -d "$PREV_DIR/plugin" ] && [ -d "$SRC/plugin" ] || return 0
  # The same plugin files (the tests and spike copies are never installed): nothing can have grown.
  if have_cmd diff && diff -r -x tests -x reference "$PREV_DIR/plugin" "$SRC/plugin" >/dev/null 2>&1; then return 0; fi
  gc_dir="$WORK_DIR/growth"
  if [ "$DRY" = 1 ]; then gc_dir=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-growth.XXXXXX") || return 0; fi
  mkdir -p "$gc_dir/old" "$gc_dir/new" || die "could not create $gc_dir"
  for gc_side in old new; do
    if [ "$gc_side" = old ]; then gc_from="$PREV_DIR/plugin"; else gc_from="$SRC/plugin"; fi
    if [ -f "$gc_from/hooks/hooks.json" ]; then
      jsonutil hooks-list "$gc_from/hooks/hooks.json" >"$gc_dir/$gc_side.hooks" 2>"$gc_dir/$gc_side.err" || printf 'unreadable hooks.json\n' >"$gc_dir/$gc_side.hooks"
    else
      : >"$gc_dir/$gc_side.hooks"
    fi
  done
  GC_HOOKS=$(set_difference "$gc_dir/old.hooks" "$gc_dir/new.hooks")
  GC_CALLS=""
  GC_UNKNOWN=""
  if have_cmd "$CLAUDE_BIN"; then
    for gc_side in old new; do
      if [ "$gc_side" = old ]; then gc_from="$PREV_DIR/plugin"; else gc_from="$SRC/plugin"; fi
      cp -R "$gc_from" "$gc_dir/$gc_side/plugin" 2>/dev/null && chmod -R u+w "$gc_dir/$gc_side/plugin" 2>/dev/null
      if tool_query claude "$CLAUDE_BIN" plugin validate --strict "$gc_dir/$gc_side/plugin" >"$gc_dir/$gc_side.validate"; then
        jsonutil validate-calls "$gc_dir/$gc_side.validate" >"$gc_dir/$gc_side.calls" 2>/dev/null || GC_UNKNOWN=1
      else
        GC_UNKNOWN=1
      fi
    done
    if [ -z "$GC_UNKNOWN" ]; then GC_CALLS=$(set_difference "$gc_dir/old.calls" "$gc_dir/new.calls"); fi
  fi
  if [ "$DRY" = 1 ]; then rm -rf "$gc_dir"; fi
  if [ -z "$GC_HOOKS" ] && [ -z "$GC_CALLS" ] && [ -z "$GC_UNKNOWN" ]; then return 0; fi

  step "The new Claude Code plugin asks for more than the installed one"
  if [ -n "$GC_HOOKS" ]; then
    say "  New hooks or mod modules:"
    printf '%s\n' "$GC_HOOKS" | tr '\t' ' ' | sed 's/^/    + /'
  fi
  if [ -n "$GC_CALLS" ]; then
    say "  New mod calls:"
    printf '%s\n' "$GC_CALLS" | sed 's/^/    + /'
  fi
  if [ -n "$GC_UNKNOWN" ]; then
    say "  'claude plugin validate --strict' could not list the mod's calls, so they could not be compared."
  fi
  if [ "$OPT_ACCEPT_GROWTH" = 1 ]; then
    say "  Accepted (--accept-plugin-changes)."
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    say "  [dry-run] a real run stops here and asks (or needs --accept-plugin-changes)."
    return 0
  fi
  if [ "$GUIDED" = 1 ]; then
    printf '\n'
    ask_yn "Update anyway? The plugin runs inside Claude Code with your permissions." no
    if [ "$ASK_RESULT" = yes ]; then return 0; fi
  fi
  # Exit 4, not 1: nothing failed, the update waits for a yes (the app offers "Update anyway", which re-runs it with the flag).
  printf 'error: %s\n' "update stopped: the new plugin asks for more than the installed one (listed above); nothing was changed. Re-run with --accept-plugin-changes to accept it." >&2
  exit 4
}

# ---- Claude Code ----------------------------------------------------------------------------------------
# The mod disclosure (D50, P-A): Claude Code's install dialog shows only its generic "make sure you trust a plugin"
# warning and no CLI install prints any warning, so wasitme says what its mod is and can do. Printed in every mode.
MOD_DISCLOSED=0
mod_disclosure() {
  [ "$MOD_DISCLOSED" = 0 ] || return 0
  MOD_DISCLOSED=1
  say "  The wasitme plugin adds /wasitme, a one-line band above the prompt, a report skill and two session hooks."
  say "  Its in-session part (a \"mod\") runs inside Claude Code with your permissions. Claude Code itself shows only a"
  say "  generic \"make sure you trust a plugin\" warning, so here is exactly what the mod may call:"
  say "    calls: $WASITME_MOD_CALLS"
  say "  It reads one file ($GLANCE_PATH) and has no network, process or environment access. The SessionStart hook"
  say "  records numbers about the project's config files (sandboxed, fixed file names only) and starts the scan."
}

CP_ADDED=0; CP_INSTALLED=0; CP_RELOAD_NOTE=0

cp_undo() {  # only ever undoes a FRESH install (nothing of the person's existed before it)
  if [ "$CP_INSTALLED" = 1 ]; then run_claude plugin uninstall "$PLUGIN_ID" || true; fi
  if [ "$CP_ADDED" = 1 ]; then run_claude plugin marketplace remove "$MKT_NAME" || true; fi
}

cp_failed() {  # cp_failed DETAIL
  comp_unwind
  result "Claude Code plugin" "FAILED" "$1"
  return 1
}

# The mod option (D45: `glancePath`), as an absolute path: Claude Code does not expand `~` in options (S-INST 3.4).
# `--values-stdin` takes a JSON object of strings and keeps keys it is not given, so showBand is left as the person set it.
cp_configure() {
  if run_tool_stdin claude "$CLAUDE_BIN" "{\"glancePath\":\"$GLANCE_PATH\"}" plugin configure "$PLUGIN_ID" --values-stdin; then
    CP_CONFIG_NOTE=""
    return 0
  fi
  warn "could not save the plugin's glancePath option; the mod still finds $GLANCE_PATH on its own. To set it: claude plugin configure $PLUGIN_ID"
  CP_CONFIG_NOTE="; glancePath not saved"
  return 1
}

cp_record() {
  if ! manifest_put claude-plugin "$PLUGIN_ID" "$MKT_NAME" "$CURRENT_LINK"; then
    result "Claude Code plugin" "FAILED" "could not write the install manifest"
    return 1
  fi
  return 0
}

# Our own earlier install, registered at ~/.wasitme/current: the flip already moved the code; record it (D50).
cp_update() {
  # Up to date only when the version folder is unchanged AND `current` did not move: going back to a version whose
  # folder still exists (a reinstall, a downgrade) flips `current`, and Claude Code must record that version.
  if [ "$PAYLOAD_SAME" = 1 ] && [ "$E_LINKED" = 0 ]; then
    result "Claude Code plugin" "installed" "$PLUGIN_ID (already up to date)"
    return 0
  fi
  if ! run_claude plugin update "$PLUGIN_ID"; then
    result "Claude Code plugin" "FAILED" "claude plugin update failed (the new version already runs from $CURRENT_LINK; Claude Code's record of it is stale until: claude plugin update $PLUGIN_ID)"
    return 1
  fi
  CP_CONFIG_NOTE=""
  cp_configure || true
  CP_RELOAD_NOTE=1
  result "Claude Code plugin" "updated" "$PLUGIN_ID$CP_CONFIG_NOTE (run /reload-plugins in open Claude Code sessions)"
  return 0
}

# A `wasitme` marketplace registered some other way (the GitHub "plugin only" install, or an installer from before
# D46 that registered a version folder): `marketplace add` with the same name re-points it in place and keeps the
# installed plugin and its options (S-GIT 4.3). Then update (or install, if it was only the marketplace) and configure.
cp_repoint() {
  if ! run_claude plugin marketplace add "$CURRENT_LINK"; then
    result "Claude Code plugin" "FAILED" "claude plugin marketplace add failed; your existing '$MKT_NAME' marketplace was left as it was"
    return 1
  fi
  if ! run_claude plugin update "$PLUGIN_ID"; then
    if ! run_claude plugin install "$PLUGIN_ID"; then
      result "Claude Code plugin" "FAILED" "the '$MKT_NAME' marketplace now points at $CURRENT_LINK, but neither update nor install worked; run: claude plugin install $PLUGIN_ID"
      return 1
    fi
  fi
  CP_CONFIG_NOTE=""
  cp_configure || true
  cp_record || return 1
  CP_RELOAD_NOTE=1
  result "Claude Code plugin" "installed" "$PLUGIN_ID, switched to the local copy at $CURRENT_LINK$CP_CONFIG_NOTE (run /reload-plugins in open sessions)"
  return 0
}

comp_claude_plugin() {
  say "Claude Code plugin $PLUGIN_ID"
  mod_disclosure
  CP_ADDED=0; CP_INSTALLED=0
  comp_mark
  if manifest_has claude-plugin "$PLUGIN_ID"; then
    if [ "$(manifest_field claude-plugin "$PLUGIN_ID" 4)" = "$CURRENT_LINK" ]; then cp_update; return $?; fi
    cp_repoint
    return $?
  fi
  if [ "$(jsonutil known-marketplace "$CLAUDE_DIR/plugins/known_marketplaces.json" "$MKT_NAME" 2>/dev/null)" = present ]; then
    say "  Claude Code already has a marketplace named '$MKT_NAME' (for example from the GitHub plugin-only install)."
    cp_switch=yes
    if [ "$GUIDED" = 1 ]; then
      ASK_SOFT=1   # asked after the engine is in place: no answer means the recommended default, not an abort
      ask_yn "  Switch it to this local copy (recommended: plugin and engine then update together; your plugin settings are kept)?" yes
      ASK_SOFT=0
      cp_switch=$ASK_RESULT
    fi
    if [ "$cp_switch" = yes ]; then cp_repoint; return $?; fi
    CP_CONFIG_NOTE=""
    cp_configure || true
    result "Claude Code plugin" "skipped" "kept your own '$MKT_NAME' marketplace; only its glancePath option was set"
    return 0
  fi
  txn_begin cp_undo
  if ! run_claude plugin marketplace add "$CURRENT_LINK"; then
    cp_failed "claude plugin marketplace add failed; nothing of yours was changed"
    return 1
  fi
  CP_ADDED=1
  if ! run_claude plugin install "$PLUGIN_ID"; then
    cp_failed "claude plugin install failed; the marketplace was removed again"
    return 1
  fi
  CP_INSTALLED=1
  CP_CONFIG_NOTE=""
  cp_configure || true
  cp_record || { comp_unwind; return 1; }
  txn_commit
  CP_RELOAD_NOTE=1
  result "Claude Code plugin" "installed" "$PLUGIN_ID$CP_CONFIG_NOTE (run /reload-plugins in open Claude Code sessions)"
  return 0
}

# ---- Codex -----------------------------------------------------------------------------------------------
# The root is registered as ~/.wasitme/current/plugin-codex; Codex resolves and stores the versioned path, which is what
# the manifest records (field 4) and what retention checks before pruning.
CX_ADDED=0; CX_PLUGIN_ADDED=0; CX_MKT_REMOVED=0; CX_OLD_DIR=""; CX_RESTORE=""

cx_restore_old() {
  CX_RESTORE=ok
  if [ -z "$CX_OLD_DIR" ] || [ "$CX_OLD_DIR" = "-" ] || [ ! -d "$CX_OLD_DIR" ]; then
    CX_RESTORE=failed
  elif ! run_codex plugin marketplace add "$CX_OLD_DIR" || ! run_codex plugin add "$CX_ID"; then
    CX_RESTORE=failed
  fi
  if [ "$CX_RESTORE" = failed ]; then
    ROLLBACK_INCOMPLETE=1
    warn "could not put the previous Codex plugin back. Re-run this installer once the cause is fixed; it registers the plugin again."
    manifest_drop codex-plugin "$CX_ID" || true
  fi
}

cx_undo() {
  if [ "$CX_PLUGIN_ADDED" = 1 ] && [ "$CX_MKT_REMOVED" = 0 ]; then run_codex plugin remove "$CX_ID" || true; fi
  if [ "$CX_ADDED" = 1 ]; then run_codex plugin marketplace remove "$CX_MKT" || true; fi
  if [ "$CX_MKT_REMOVED" = 1 ]; then cx_restore_old; fi
}

cx_failed() {
  comp_unwind
  if [ "$CX_RESTORE" = ok ]; then warn "the Codex plugin you had before was put back, so it works as it did."; fi
  result "Codex plugin" "FAILED" "$1"
  return 1
}

comp_codex_plugin() {
  say "Codex plugin $CX_ID (skills only: no hooks, and your notify setting is never touched)"
  CX_ADDED=0; CX_PLUGIN_ADDED=0; CX_MKT_REMOVED=0; CX_OLD_DIR=""; CX_RESTORE=""
  cx_root="$CURRENT_LINK/plugin-codex"
  cx_resolved="$VERSIONS_DIR/$VERSION/plugin-codex"
  cx_r=$(real_dir "$cx_resolved") && [ -n "$cx_r" ] && cx_resolved=$cx_r
  comp_mark
  txn_begin cx_undo
  if manifest_has codex-plugin "$CX_ID"; then
    CX_OLD_DIR=$(manifest_field codex-plugin "$CX_ID" 4)
    if [ "$CX_OLD_DIR" = "$cx_resolved" ]; then
      if [ "$PAYLOAD_SAME" = 1 ]; then
        txn_commit
        result "Codex plugin" "installed" "$CX_ID (already up to date)"
        return 0
      fi
      # Same folder, new files (a same-version re-install): `plugin add` re-reads the registered root (S-CX 2.5).
      if ! run_codex plugin add "$CX_ID"; then cx_failed "codex plugin add failed"; return 1; fi
      txn_commit
      result "Codex plugin" "installed" "$CX_ID (refreshed)"
      return 0
    fi
    # D49 update: Codex keeps the resolved path of the OLD version, so re-register through `current`.
    if ! run_codex plugin marketplace remove "$CX_MKT"; then cx_failed "codex plugin marketplace remove failed; nothing was changed"; return 1; fi
    CX_MKT_REMOVED=1
  fi
  if ! run_codex plugin marketplace add "$cx_root"; then
    cx_failed "codex plugin marketplace add failed"
    return 1
  fi
  CX_ADDED=1
  if ! run_codex plugin add "$CX_ID"; then
    cx_failed "codex plugin add failed"
    return 1
  fi
  CX_PLUGIN_ADDED=1
  if ! manifest_put codex-plugin "$CX_ID" "$CX_MKT" "$cx_resolved"; then
    cx_failed "could not write the install manifest"
    return 1
  fi
  txn_commit
  if [ "$CX_MKT_REMOVED" = 1 ]; then
    result "Codex plugin" "updated" "$CX_ID -> $VERSION"
  else
    result "Codex plugin" "installed" "$CX_ID"
  fi
  return 0
}

comp_plugins() {
  step "Plugins"
  pl_failed=0
  if [ "$WANT_CLAUDE_PLUGIN" = yes ]; then comp_claude_plugin || pl_failed=1; fi
  if [ "$WANT_CODEX_PLUGIN" = yes ]; then comp_codex_plugin || pl_failed=1; fi
  return "$pl_failed"
}

# ---- Claude Code status line ------------------------------------------------------------------------------
sl_undo() { rollback_dirs; }

# The engine command that wraps an existing status line. It needs `--wrap` (without it the engine leaves an existing
# status line alone); it keeps the old command in ~/.wasitme/backups and runs it first, and `wasitme statusline
# uninstall` puts it back. The engine looks for ~/.local/bin/wasitme-statusline by default.
statusline_wrap_hint() {
  sw_cmd="wasitme"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) sw_cmd=$(quote_arg "$SHIM") ;; esac
  if [ "$SL_SHIM" = "$HOME_DIR/.local/bin/wasitme-statusline" ]; then
    printf '%s statusline install --wrap' "$sw_cmd"
  else
    printf '%s statusline install --wrap --script %s' "$sw_cmd" "$(quote_arg "$SL_SHIM")"
  fi
}

# Sets SL_STATE: absent-file | none | ours | stale | present | invalid (and SL_CMD, SL_OLD_CMD).
# SL_CMD is the status-line shim's absolute path, which runs packaging/statusline.sh: no node on a refresh.
# "stale" is OUR status line (the command the manifest says we wrote) that is not the current command any more: an
# install from before the shim (`<node> <cli> status`), or a --prefix that moved. It gets rewritten instead of being
# reported as the user's own.
statusline_detect() {
  SL_CMD=$(quote_arg "$SL_SHIM")
  SL_OLD_CMD=""
  SL_STATE=$(jsonutil statusline-state "$CLAUDE_SETTINGS" "$SL_CMD" 2>/dev/null) || SL_STATE=invalid
  if [ "$SL_STATE" = present ]; then
    sd_old=$(manifest_field statusline "$CLAUDE_SETTINGS" 5)
    if [ -n "$sd_old" ] && [ "$sd_old" != "$SL_CMD" ]; then
      sd_st=$(jsonutil statusline-state "$CLAUDE_SETTINGS" "$sd_old" 2>/dev/null) || sd_st=invalid
      if [ "$sd_st" = ours ]; then SL_STATE=stale; SL_OLD_CMD=$sd_old; fi
    fi
  fi
}

SL_REPLACED=0
sl_refresh_undo() {
  if [ "$SL_REPLACED" = 1 ]; then jsonutil statusline-replace "$CLAUDE_SETTINGS" "$SL_CMD" "$SL_OLD_CMD" >/dev/null 2>&1 || true; fi
}

# Points our own status line at the current node/engine. The backup and everything else in settings.json stay as they are.
comp_statusline_refresh() {
  say "The wasitme status line in $CLAUDE_SETTINGS points at a command that has moved; updating only that."
  if [ "$DRY" = 1 ]; then
    run "$NODE" "$LIB_DIR/jsonutil.mjs" statusline-replace "$CLAUDE_SETTINGS" "$SL_OLD_CMD" "$SL_CMD"
    return 0
  fi
  sr_backup=$(manifest_field statusline "$CLAUDE_SETTINGS" 3)
  # The recorded checksum means "nothing but our edit happened to this file since the backup", and the uninstaller
  # restores the backup byte for byte (or deletes a file we created) when it still matches. Anything written since the
  # install (Claude Code's plugin keys, a theme change) must not be stamped as ours now: when the file already differs
  # from the recorded checksum, record "-" so the uninstaller can only ever remove our statusLine key.
  sr_recorded=$(manifest_field statusline "$CLAUDE_SETTINGS" 4)
  sr_before=$(jsonutil sha256 "$CLAUDE_SETTINGS" 2>/dev/null) || sr_before=""
  SL_REPLACED=0
  comp_mark
  txn_begin sl_refresh_undo
  sr_rc=0
  sr_out=$(jsonutil statusline-replace "$CLAUDE_SETTINGS" "$SL_OLD_CMD" "$SL_CMD") || sr_rc=$?
  case $sr_rc in
    0) SL_REPLACED=1 ;;
    10) comp_unwind; result "status line" "skipped" "the status line changed meanwhile (not touched)"; return 0 ;;
    12) comp_unwind; result "status line" "skipped" "$CLAUDE_SETTINGS is not valid JSON"; return 0 ;;
    *) comp_unwind; result "status line" "FAILED" "could not update $CLAUDE_SETTINGS (it was not changed)"; return 1 ;;
  esac
  sr_sha=$(printf '%s\n' "$sr_out" | sed -n 's/^sha=//p')
  if [ -z "$sr_recorded" ] || [ "$sr_recorded" = "-" ] || [ -z "$sr_before" ] || [ "$sr_before" != "$sr_recorded" ]; then sr_sha="-"; fi
  if ! manifest_put statusline "$CLAUDE_SETTINGS" "${sr_backup:--}" "${sr_sha:--}" "$SL_CMD"; then
    comp_unwind   # puts the old command back
    result "status line" "FAILED" "could not write the install manifest; settings restored"
    return 1
  fi
  txn_commit
  result "status line" "installed" "updated to the current command in $CLAUDE_SETTINGS"
  return 0
}

comp_statusline() {
  step "Claude Code status line"
  case $SL_STATE in
    ours) result "status line" "installed" "already set in $CLAUDE_SETTINGS"; return 0 ;;
    stale) comp_statusline_refresh; return $? ;;
    present)
      say "You already have a status line; leaving it exactly as it is."
      say "To show wasitme next to it (yours keeps running, wasitme's part is added after it):  $(statusline_wrap_hint)"
      result "status line" "skipped" "you already have one (not touched)"
      return 0 ;;
    invalid)
      warn "$CLAUDE_SETTINGS is not valid JSON; leaving it untouched"
      result "status line" "skipped" "$CLAUDE_SETTINGS is not valid JSON"
      return 0 ;;
  esac
  sl_bak="$CLAUDE_SETTINGS.wasitme-bak-$(date +%Y%m%d%H%M%S)"
  comp_mark
  txn_begin sl_undo
  mkdir_track "$CLAUDE_DIR" || { comp_unwind; result "status line" "FAILED" "could not create $CLAUDE_DIR"; return 1; }
  if [ "$DRY" = 1 ]; then
    say "  (would back up $CLAUDE_SETTINGS first, then add the statusLine entry)"
    run "$NODE" "$LIB_DIR/jsonutil.mjs" statusline-add "$CLAUDE_SETTINGS" "$SL_CMD" "$sl_bak"
    txn_commit
    return 0
  fi
  sl_rc=0
  sl_out=$(jsonutil statusline-add "$CLAUDE_SETTINGS" "$SL_CMD" "$sl_bak") || sl_rc=$?
  case $sl_rc in
    0) ;;
    10) comp_unwind; result "status line" "skipped" "a status line appeared meanwhile (not touched)"; return 0 ;;
    12) comp_unwind; result "status line" "skipped" "$CLAUDE_SETTINGS is not valid JSON"; return 0 ;;
    *) comp_unwind; result "status line" "FAILED" "could not update $CLAUDE_SETTINGS (it was not changed)"; return 1 ;;
  esac
  sl_backup=$(printf '%s\n' "$sl_out" | sed -n 's/^backup=//p')
  sl_sha=$(printf '%s\n' "$sl_out" | sed -n 's/^sha=//p')
  if ! manifest_put statusline "$CLAUDE_SETTINGS" "${sl_backup:--}" "${sl_sha:--}" "$SL_CMD"; then
    # Put the settings back rather than leave an edit uninstall cannot find.
    jsonutil statusline-restore "$CLAUDE_SETTINGS" "${sl_backup:--}" "${sl_sha:--}" "$SL_CMD" >/dev/null 2>&1 || true
    comp_unwind
    result "status line" "FAILED" "could not write the install manifest; settings restored"
    return 1
  fi
  commit_dirs || warn "could not record created folders in the install manifest"
  txn_commit
  if [ "$sl_backup" != "-" ]; then
    result "status line" "installed" "added to $CLAUDE_SETTINGS (backup: $sl_backup)"
  else
    result "status line" "installed" "created $CLAUDE_SETTINGS"
  fi
  return 0
}
