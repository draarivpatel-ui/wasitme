# shellcheck shell=sh
# wasitme installer: the release payload. Stage -> verify -> growth check -> make read-only -> swap -> flip `current`
# -> shims, engine.json, engine.env -> record, with rollback.
#
# Layout it creates (DECISIONS D32/D46):
#   ~/.wasitme/versions/<v>/    VERSION, LICENSE, engine/{package.json,dist/src}, .claude-plugin/, plugin/, plugin-codex/,
#                               scripts/{install.sh,uninstall.sh,lib/}  -- chmod -R a-w, never changed after it is in place
#   ~/.wasitme/current          relative symlink -> versions/<v>, flipped atomically (new link + rename). The engine, the
#                               Claude Code marketplace (registered AT this symlink) and the Codex root all go through it.
#   PREFIX/bin/wasitme          sh shim: absolute node + ~/.wasitme/current/engine/... (PREFIX defaults to ~/.local)
#   ~/.wasitme/engine.json      0600. Absolute node + cli, the node permission flag and the background scan's node
#                               arguments, labels. The app and `wasitme doctor` read it.
#   ~/.wasitme/engine.env       0600. The same facts as key=value lines for the plugin hooks, which read it with sed and
#                               never source it.
# Sourced by install.sh after common.sh. Expects the globals set up by install_main.

# Make sure a built engine exists: use the source's own dist/ if present, otherwise build it in a scratch copy
# so the source tree (possibly a live checkout) is never written to. No lifecycle scripts run.
engine_prepare_dist() {
  if [ -f "$SRC/engine/$CLI_REL" ]; then
    ENGINE_DIST_SRC="$SRC/engine"
    if find "$SRC/engine/dist/src" -type l 2>/dev/null | grep -q .; then
      die "engine/dist/src contains symbolic links; refusing to install it"
    fi
    # A local checkout's dist/ can lag its sources (edited after the last build). The installer never writes to the
    # source tree, so it cannot rebuild in place; it says so instead of quietly installing the older build.
    if [ -d "$SRC/engine/src" ] && find "$SRC/engine/src" -type f -newer "$SRC/engine/$CLI_REL" 2>/dev/null | grep -q .; then
      warn "engine/src in $SRC has changes newer than its built engine/dist; this installs the OLDER build. Run 'npm run build' in $SRC first, then re-run the installer."
    fi
    return 0
  fi
  step "Building the engine (no prebuilt dist/ in this source)"
  say "This runs 'npm ci --ignore-scripts' once, which downloads TypeScript from the npm registry."
  say "Release tarballs ship a prebuilt engine and skip this step."
  have_cmd "$NPM_BIN" || die "npm was not found, and this source has no prebuilt engine/dist. Install Node.js with npm from https://nodejs.org/en/download, or use a release tarball."
  [ -f "$SRC/package.json" ] || die "unexpected source layout: no package.json at the top of $SRC"
  ENGINE_BUILD="$WORK_DIR/engine-build"
  run mkdir -p "$ENGINE_BUILD/engine" || die "could not create $ENGINE_BUILD"
  run cp "$SRC/package.json" "$ENGINE_BUILD/package.json" || die "copy failed"
  if [ -f "$SRC/package-lock.json" ]; then run cp "$SRC/package-lock.json" "$ENGINE_BUILD/package-lock.json" || die "copy failed"; fi
  for ep_item in package.json tsconfig.json src; do
    if [ -e "$SRC/engine/$ep_item" ] || [ "$DRY" = 1 ]; then
      run cp -R "$SRC/engine/$ep_item" "$ENGINE_BUILD/engine/$ep_item" || die "copy failed"
    fi
  done
  if [ -f "$SRC/package-lock.json" ]; then
    run_in "$ENGINE_BUILD" nice -n 10 "$NPM_BIN" ci --ignore-scripts --no-audit --no-fund || die "npm ci failed"
  else
    run_in "$ENGINE_BUILD" nice -n 10 "$NPM_BIN" install --ignore-scripts --no-audit --no-fund || die "npm install failed"
  fi
  run_in "$ENGINE_BUILD" nice -n 10 "$NPM_BIN" run build -w engine || die "building the engine failed"
  if [ "$DRY" != 1 ] && [ ! -f "$ENGINE_BUILD/engine/$CLI_REL" ]; then
    die "the build finished but did not produce engine/$CLI_REL"
  fi
  ENGINE_DIST_SRC="$ENGINE_BUILD/engine"
}

engine_undo() {
  if [ "$E_SHIM_DONE" = 1 ]; then
    if [ -f "$WORK_DIR/undo.shim" ]; then cp -p "$WORK_DIR/undo.shim" "$SHIM" 2>/dev/null || true; else rm -f "$SHIM"; fi
  fi
  if [ "$E_SL_SHIM_DONE" = 1 ]; then
    if [ -f "$WORK_DIR/undo.slshim" ]; then cp -p "$WORK_DIR/undo.slshim" "$SL_SHIM" 2>/dev/null || true; else rm -f "$SL_SHIM"; fi
  fi
  if [ "$E_JSON_DONE" = 1 ]; then
    if [ -f "$WORK_DIR/undo.engine.json" ]; then cp -p "$WORK_DIR/undo.engine.json" "$ENGINE_JSON" 2>/dev/null || true; else rm -f "$ENGINE_JSON"; fi
  fi
  if [ "$E_ENV_DONE" = 1 ]; then
    if [ -f "$WORK_DIR/undo.engine.env" ]; then cp -p "$WORK_DIR/undo.engine.env" "$ENGINE_ENV" 2>/dev/null || true; else rm -f "$ENGINE_ENV"; fi
  fi
  if [ "$E_LINKED" = 1 ]; then
    if [ -n "$E_PREV_LINK" ]; then swap_symlink "$E_PREV_LINK" "$CURRENT_LINK" || true; else rm -f "$CURRENT_LINK"; fi
  fi
  if [ "$E_MOVED" = 1 ]; then rm_tree "$E_FINAL"; fi
  if [ "$E_PARKED" = 1 ]; then mv "$E_PARK" "$E_FINAL" 2>/dev/null || true; fi
  if [ "$E_LOCKED" = 1 ]; then rm_tree "$E_STAGE"; fi
  release_lock   # the lock lives inside STATE_DIR, so it must go before STATE_DIR can be removed
  rollback_dirs
}

shim_content() {
  printf '#!/bin/sh\n'
  printf '# wasitme shim: %s. Safe to delete (uninstall removes it).\n' "$WASITME_MARKER"
  printf 'exec %s %s "$@"\n' "$(quote_arg "$NODE")" "$(quote_arg "$ENGINE_CLI")"
}

# The status-line command Claude Code runs on every refresh (`~/.local/bin/wasitme-statusline`, the path the
# engine's `wasitme statusline install|show|uninstall` expect). It runs the shipped packaging/statusline.sh in this same
# shell (sourced: one process, sh built-ins only, no node) through `current`, so an update moves it with everything else.
# Because no node starts, NODE_OPTIONS and friends in Claude Code's environment have nothing to act on.
sl_shim_content() {
  printf '#!/bin/sh\n'
  printf '# wasitme status line: %s. Safe to delete (uninstall removes it).\n' "$WASITME_MARKER"
  printf 'wasitme_statusline=%s\n' "$(quote_arg "$CURRENT_LINK/$WASITME_STATUSLINE_SCRIPT")"
  printf '[ -f "$wasitme_statusline" ] && . "$wasitme_statusline"\n'
  printf 'exit 0\n'
}

# shim_put PATH CONTENT-FUNCTION UNDO-TAG: writes a shim unless something we did not create is already at PATH (returns 2
# then, and leaves it alone).
shim_put() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    if [ -L "$1" ] || ! grep -q "$WASITME_MARKER" "$1" 2>/dev/null; then return 2; fi
    if [ "$DRY" != 1 ] && [ ! -f "$WORK_DIR/undo.$3" ]; then cp -p "$1" "$WORK_DIR/undo.$3" || return 1; fi
  fi
  "$2" | write_file "$1" 755 || return 1
}

# Writes the command shim, and the status-line shim when the payload has the script, unless a file we did not create is
# already there.
shim_write() {
  SHIM_SKIPPED=0
  SL_SHIM_SKIPPED=1
  sw_rc=0
  shim_put "$SHIM" shim_content shim || sw_rc=$?
  case $sw_rc in
    0) E_SHIM_DONE=1 ;;
    2) warn "$SHIM already exists and was not created by this installer; leaving it alone. Use '$ENGINE_CLI' through node, or move that file and re-run."
       SHIM_SKIPPED=1 ;;
    *) return 1 ;;
  esac
  [ -f "$SRC/$WASITME_STATUSLINE_SCRIPT" ] || return 0
  sw_rc=0
  shim_put "$SL_SHIM" sl_shim_content slshim || sw_rc=$?
  case $sw_rc in
    0) E_SL_SHIM_DONE=1; SL_SHIM_SKIPPED=0 ;;
    2) warn "$SL_SHIM already exists and was not created by this installer; leaving it alone, so wasitme cannot add a status line" ;;
    *) return 1 ;;
  esac
}

json_agents() {  # prints "a", "b" for the chosen agents
  ja_sep=""
  for ja_a in $WANT_AGENTS; do
    printf '%s"%s"' "$ja_sep" "$ja_a"
    ja_sep=", "
  done
}

json_nullable() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }

json_lines_array() {  # newline-separated values (already free of quotes and backslashes) -> "a", "b"
  jl_sep=""
  while IFS= read -r jl_v; do
    [ -n "$jl_v" ] || continue
    printf '%s"%s"' "$jl_sep" "$jl_v"
    jl_sep=", "
  done <<EOF
$1
EOF
}

# ---- Node sandbox (D49/D60) --------------------------------------------------------------------------------
# Feature-tests the permission flag once, unsandboxed, here in setup: `--permission` (Node >= 22.13-ish and 23+), else
# the older `--experimental-permission` (Node 22.12 has only that one), else none. A version check would be wrong: the
# flag's name changed inside the 22 line. Sets PERM_FLAG ("" = no sandbox available) and PERM_NET (true when this node
# also knows --allow-net, i.e. network access is denied under --permission; only then may anyone claim that).
perm_probe() {
  PERM_FLAG=""
  PERM_NET=false
  if "$NODE" --permission -e 0 >/dev/null 2>&1 </dev/null; then
    PERM_FLAG="--permission"
  elif "$NODE" --experimental-permission -e 0 >/dev/null 2>&1 </dev/null; then
    PERM_FLAG="--experimental-permission"
  fi
  if [ -n "$PERM_FLAG" ] && "$NODE" --help 2>/dev/null </dev/null | grep -q -- '--allow-net'; then PERM_NET=true; fi
}

# grant FLAG PATH [SUFFIX]: one --allow-fs-* flag for PATH (+SUFFIX), and one more for its resolved spelling when that
# differs (a grant covers only the spelling it was given: a symlinked ~/.claude, or /var -> /private/var).
grant() {
  printf '%s=%s%s\n' "$1" "$2" "${3:-}"
  gr_real=$(real_dir "$2") || gr_real=""
  if [ -n "$gr_real" ] && [ "$gr_real" != "$2" ]; then
    case $gr_real in
      *[!A-Za-z0-9_./\ @+:,=~-]*) warn "the resolved path of $2 has unusual characters; granting only $2" ;;
      *) printf '%s=%s%s\n' "$1" "$gr_real" "${3:-}" ;;
    esac
  fi
}

# The node arguments that go before the CLI for a background scan, one per line (empty when no sandbox is available).
# Reads: the log roots and their sibling state files through ONE prefix wildcard each (`~/.claude*`, `~/.codex*`: a
# separate `~/.claude` + `~/.claude.json` pair makes the directory itself unreadable, S-NODEPERM), and ~/.wasitme.
# Writes: ~/.wasitme only. ~/.wasitme exists before this runs (a grant on a missing folder does not cover children
# created later, D60). No child processes, no workers; no network where Node enforces it.
scan_node_args() {
  [ -n "$PERM_FLAG" ] || return 0
  printf '%s\n' "$PERM_FLAG"
  grant --allow-fs-read "$CLAUDE_DIR" '*'
  grant --allow-fs-read "$CODEX_DIR" '*'
  grant --allow-fs-read "$STATE_DIR"
  grant --allow-fs-write "$STATE_DIR"
}

# ---- engine.json / engine.env --------------------------------------------------------------------------------
# What is installed right now: the manifest says we installed it AND it is still on disk. engine.json mirrors this
# (null = not installed), so a re-run that does not repeat a component never makes the file forget it, and a
# component that failed and rolled back is never advertised.
engine_active_state() {
  ACTIVE_SCAN_LABEL=""; ACTIVE_APP_LABEL=""; ACTIVE_APP_PATH=""
  # A label is advertised only when launchd was really asked to load it. Under a custom --home without a launchctl
  # replacement the plist is written but never loaded, and the plugin hooks kickstart whatever engine.env names: a
  # sandbox must never send them to a real user-domain job.
  if [ "$LAUNCHCTL_ON" = 1 ]; then
    if manifest_has launchagent "$LABEL_SCAN" && [ -f "$AGENTS_DIR/$LABEL_SCAN.plist" ]; then ACTIVE_SCAN_LABEL=$LABEL_SCAN; fi
    if manifest_has launchagent "$LABEL_APP" && [ -f "$AGENTS_DIR/$LABEL_APP.plist" ]; then ACTIVE_APP_LABEL=$LABEL_APP; fi
  fi
  if manifest_has app "$APP_PATH" && [ -e "$APP_PATH" ]; then ACTIVE_APP_PATH=$APP_PATH; fi
}

# engine.json is what the app and `wasitme doctor` read to find the engine (D25): absolute paths only, 0600 (D46).
# Every value was checked by check_path_chars, so none holds a quote or a backslash.
engine_json_write() {
  if [ "$DRY" != 1 ] && [ -f "$ENGINE_JSON" ] && [ ! -f "$WORK_DIR/undo.engine.json" ]; then
    cp -p "$ENGINE_JSON" "$WORK_DIR/undo.engine.json" || return 1
  fi
  ensure_state_dir || return 1
  {
    printf '{\n'
    printf '  "schema": "%s",\n' "$WASITME_ENGINE_SCHEMA"
    printf '  "version": "%s",\n' "$VERSION"
    printf '  "node": "%s",\n' "$NODE"
    printf '  "cli": "%s",\n' "$ENGINE_CLI"
    printf '  "home": "%s",\n' "$STATE_DIR"
    printf '  "claudeDir": "%s",\n' "$CLAUDE_DIR"   # the config folders this install tracks, from the same variables as the scanArgs grants; an app opened from Finder (no LaunchAgent environment) takes them from here (macos EngineEnvironment)
    printf '  "codexDir": "%s",\n' "$CODEX_DIR"
    printf '  "onPath": %s,\n' "${ON_PATH:-false}"
    printf '  "agents": [%s],\n' "$(json_agents)"
    printf '  "permission": %s,\n' "$(json_nullable "$PERM_FLAG")"
    printf '  "permissionNet": %s,\n' "$PERM_NET"
    printf '  "scanArgs": [%s],\n' "$(json_lines_array "$SCAN_NODE_ARGS")"
    printf '  "scanCli": "%s",\n' "${ENGINE_CLI_SANDBOX:-$ENGINE_CLI}"
    printf '  "scanLabel": %s,\n' "$(json_nullable "$ACTIVE_SCAN_LABEL")"
    printf '  "appLabel": %s,\n' "$(json_nullable "$ACTIVE_APP_LABEL")"
    printf '  "app": %s\n' "$(json_nullable "$ACTIVE_APP_PATH")"
    printf '}\n'
  } | write_file "$ENGINE_JSON" 600 || return 1
  E_JSON_DONE=1
}

# engine.env: key=value, one per line, for the plugin hooks (read with sed, never sourced; owner + 0600 checked).
engine_env_write() {
  if [ "$DRY" != 1 ] && [ -f "$ENGINE_ENV" ] && [ ! -f "$WORK_DIR/undo.engine.env" ]; then
    cp -p "$ENGINE_ENV" "$WORK_DIR/undo.engine.env" || return 1
  fi
  ee_real=$(real_dir "$STATE_DIR") || ee_real=""
  case $ee_real in *[!A-Za-z0-9_./\ @+:,=~-]*) ee_real="" ;; esac
  {
    printf '# wasitme engine.env, %s. Read with sed by the plugin hooks; never sourced.\n' "$WASITME_MARKER"
    printf 'version=%s\n' "$VERSION"
    printf 'node=%s\n' "$NODE"
    printf 'cli=%s\n' "${ENGINE_CLI_SANDBOX:-$ENGINE_CLI}"
    printf 'permission=%s\n' "$PERM_FLAG"
    printf 'home=%s\n' "$STATE_DIR"
    printf 'home_real=%s\n' "${ee_real:-$STATE_DIR}"
    printf 'scan_label=%s\n' "$ACTIVE_SCAN_LABEL"
  } | write_file "$ENGINE_ENV" 600 || return 1
  E_ENV_DONE=1
}

engine_files_write() {
  engine_json_write || return 1
  engine_env_write || return 1
}

# ---- Staging the version folder ---------------------------------------------------------------------------------
stage_copy() {  # stage_copy REL: $SRC/REL -> stage/REL when it exists; symlinks are refused (they could point anywhere)
  [ -e "$SRC/$1" ] || return 0
  if find "$SRC/$1" -type l 2>/dev/null | grep -q .; then die "$1 contains symbolic links; refusing to install it"; fi
  run mkdir -p "$(dirname "$E_STAGE/$1")" || die "could not create the staging folder"
  run cp -R "$SRC/$1" "$E_STAGE/$1" || die "could not copy $1"
}

stage_payload() {
  rm_tree "$E_STAGE" || die "could not clear old staging"
  rm_tree "$E_PARK" || die "could not clear an old parked copy"
  run mkdir -p "$E_STAGE/engine/dist" "$E_STAGE/scripts" || die "could not create $E_STAGE"
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] write %s (%s)\n' "$(quote_arg "$E_STAGE/VERSION")" "$VERSION"
  else
    printf '%s\n' "$VERSION" >"$E_STAGE/VERSION" || die "could not write VERSION"
  fi
  run cp -R "$ENGINE_DIST_SRC/dist/src" "$E_STAGE/engine/dist/src" || die "could not copy the engine"
  # The same exclusions as the npm package's `files` (engine/package.json): the synthetic-data generator and the
  # calibration harness are development tools, and nothing the CLI runs imports them.
  for sp_dev in $WASITME_ENGINE_DEV_DIRS; do run rm -rf "$E_STAGE/engine/dist/src/$sp_dev" || die "could not trim the engine copy"; done
  # Everything else goes through stage_copy, which refuses symbolic links: the install scripts in particular are run
  # again later (the uninstaller, --repair), so a link in them must never reach the version folder. read_meta already
  # required package.json, uninstall.sh and lib/ to exist; install.sh is what brought us here.
  for sp_item in engine/package.json LICENSE scripts/install.sh scripts/uninstall.sh scripts/lib; do stage_copy "$sp_item"; done
  # The plugins travel with the engine in the same folder, so one flip of `current` moves all three together; so does
  # the status-line script (plain sh, no node on each refresh).
  for sp_item in .claude-plugin plugin plugin-codex "$WASITME_STATUSLINE_SCRIPT"; do stage_copy "$sp_item"; done
  # Not shipped: the plugin's tests and spike reference copies.
  run rm -rf "$E_STAGE/plugin/tests" "$E_STAGE/plugin/reference" || die "could not trim the plugin copy"
}

# The staged engine must run before anything live changes. `--version` must print this version; an engine that does not
# have `--version` yet (the CLI is still growing, WP-30) must at least run `--help` cleanly.
engine_self_check() {
  es_cli="$E_STAGE/engine/$CLI_REL"
  ENGINE_NO_VERSION_FLAG=0
  if [ "$DRY" = 1 ]; then
    run "$NODE" "$es_cli" --version
    return 0
  fi
  if es_out=$("$NODE" "$es_cli" --version 2>&1 </dev/null); then
    case $es_out in
      *"$VERSION"*) return 0 ;;
      *) die "the new engine's self-check printed '$es_out'; expected it to mention $VERSION" ;;
    esac
  fi
  if "$NODE" "$es_cli" --help >/dev/null 2>&1 </dev/null; then
    ENGINE_NO_VERSION_FLAG=1
    return 0
  fi
  die "the new engine failed its self-check ('node $CLI_REL --version' and '--help'): $es_out"
}

engine_install() {
  step "Installing wasitme $VERSION"
  E_STAGE="$VERSIONS_DIR/.stage"
  E_PARK="$VERSIONS_DIR/.parked"
  E_FINAL="$VERSIONS_DIR/$VERSION"
  E_PREV_LINK=""
  E_PARKED=0; E_MOVED=0; E_LINKED=0; E_SHIM_DONE=0; E_SL_SHIM_DONE=0; E_JSON_DONE=0; E_ENV_DONE=0; E_LOCKED=0
  PAYLOAD_SAME=0
  ENGINE_CLI="$CURRENT_LINK/engine/$CLI_REL"
  engine_active_state

  txn_begin engine_undo
  ensure_state_dir || die "could not create $STATE_DIR"   # before any sandboxed run (D60)
  mkdir_track "$VERSIONS_DIR" || die "could not create $VERSIONS_DIR"
  mkdir_track "$BIN_DIR" || die "could not create $BIN_DIR"
  acquire_lock
  E_LOCKED=1   # only from here is versions/.stage ours; a run that gave up waiting must not delete the holder's

  # 1. Stage next to the final location (same filesystem, so the renames below are atomic), then verify it.
  stage_payload
  engine_self_check
  E_PREV_LINK=$(readlink "$CURRENT_LINK" 2>/dev/null || true)
  PREV_DIR=""
  case $E_PREV_LINK in
    '') ;;
    /*) PREV_DIR=$E_PREV_LINK ;;
    *) PREV_DIR="$STATE_DIR/$E_PREV_LINK" ;;
  esac
  # 2. An update whose Claude Code mod would hook or call more than the installed one stops here unless you agree.
  growth_check
  # 3. Read-only from here on: nothing (not even Claude Code) writes into a version folder (S-INST 3.3).
  run chmod -R a-w "$E_STAGE" || die "could not make the new version read-only"

  # 4. Swap: an identical same-version folder stays; a changed one is parked and replaced; then flip `current`.
  if [ -e "$E_FINAL" ] || [ -L "$E_FINAL" ]; then
    if [ "$DRY" != 1 ] && have_cmd diff && diff -r "$E_FINAL" "$E_STAGE" >/dev/null 2>&1; then
      PAYLOAD_SAME=1
      rm_tree "$E_STAGE"
    else
      run mv "$E_FINAL" "$E_PARK" || die "could not move the previous $VERSION aside"
      E_PARKED=1
    fi
  fi
  if [ "$PAYLOAD_SAME" = 0 ]; then
    run mv "$E_STAGE" "$E_FINAL" || die "could not move the new version into place"
    E_MOVED=1
  fi
  if [ "$E_PREV_LINK" != "versions/$VERSION" ]; then
    swap_symlink "versions/$VERSION" "$CURRENT_LINK" || die "could not point $CURRENT_LINK at versions/$VERSION"
    E_LINKED=1
  fi

  # 5. Sandbox facts, shim, engine.json, engine.env.
  perm_probe
  SCAN_NODE_ARGS=$(scan_node_args)
  # Sandboxed runs name the engine through the RESOLVED spelling of ~/.wasitme: node resolves its entry script's real
  # path and is refused a stat on a symlinked folder above the grants (a home reached through a symlink, /var ->
  # /private/var). Checked in t_lifecycle by running the plist's exact command with the real node.
  ENGINE_CLI_SANDBOX=$ENGINE_CLI
  ec_real=$(real_dir "$STATE_DIR") || ec_real=""
  case $ec_real in
    ""|*[!A-Za-z0-9_./\ @+:,=~-]*) ;;
    *) ENGINE_CLI_SANDBOX="$ec_real/current/engine/$CLI_REL" ;;
  esac
  shim_write || die "could not write $SHIM"
  engine_files_write || die "could not write $ENGINE_JSON / $ENGINE_ENV"

  # 6. Record what was created, then commit (nothing below can undo the engine).
  manifest_put prefix "$PREFIX" || die "could not write the install manifest"
  manifest_put dir "$E_FINAL" || die "could not write the install manifest"
  manifest_put symlink "$CURRENT_LINK" || die "could not write the install manifest"
  manifest_put file "$ENGINE_JSON" || die "could not write the install manifest"
  manifest_put file "$ENGINE_ENV" || die "could not write the install manifest"
  if [ "$SHIM_SKIPPED" = 0 ]; then manifest_put shim "$SHIM" || die "could not write the install manifest"; fi
  if [ "$SL_SHIM_SKIPPED" = 0 ]; then manifest_put shim "$SL_SHIM" || die "could not write the install manifest"; fi
  commit_dirs || die "could not write the install manifest"
  txn_commit
  rm_tree "$E_PARK" || true
  if [ "$SHIM_SKIPPED" = 0 ]; then result "command" "installed" "$SHIM"; else result "command" "skipped" "$SHIM belongs to something else"; fi
  ei_note=""
  if [ "$PAYLOAD_SAME" = 1 ]; then ei_note=", already in place"; fi
  if [ -n "$PREV_DIR" ] && [ "$E_PREV_LINK" != "versions/$VERSION" ]; then ei_note="$ei_note, updated from ${E_PREV_LINK#versions/}"; fi
  if [ "$ENGINE_NO_VERSION_FLAG" = 1 ]; then ei_note="$ei_note; this engine has no --version yet, so it was checked with --help"; fi
  result "engine" "installed" "$E_FINAL (current -> $VERSION$ei_note)"
  if [ -n "$PERM_FLAG" ]; then
    result "sandbox" "on" "background scans run under node $PERM_FLAG"
  else
    result "sandbox" "off" "this node has no permission flag; background scans run without it (wasitme doctor reports this)"
  fi
  case $NODE in
    */.nvm/*) warn "node comes from nvm ($NODE). After 'nvm use' switches versions, run: wasitme doctor --repair" ;;
  esac
}

# ---- Retention (D49) -----------------------------------------------------------------------------------------------
# Keeps `current` and the version it replaced (for a rollback); removes older version folders this installer created.
# Never removes a folder Codex's config.toml still names: Codex stores the RESOLVED marketplace path, so pruning it
# would break `codex plugin list` (S-CX 2.6). `wasitme doctor --repair` re-registers Codex and the next update prunes it.
codex_config_names() {  # codex_config_names DIR: is DIR (either spelling) Codex's registered root, per config.toml or our record?
  cc_real=$(real_dir "$1") || cc_real=""
  # Our own record of where Codex was registered (the resolved root, manifest field 4).
  if manifest_lines codex-plugin | awk -F '\t' -v a="$1/" -v b="${cc_real:-//}/" 'index($4 "/", a) == 1 || index($4 "/", b) == 1 { f = 1 } END { exit !f }'; then return 0; fi
  [ -f "$CODEX_DIR/config.toml" ] || return 1
  grep -qF -- "$1" "$CODEX_DIR/config.toml" 2>/dev/null && return 0
  [ -n "$cc_real" ] && grep -qF -- "$cc_real" "$CODEX_DIR/config.toml" 2>/dev/null
}

prune_versions() {
  [ "$DRY" = 1 ] && return 0
  # Only after `current` moved. A run that keeps the version (--repair, --add, a same-version re-run) must not take away
  # the version the last update kept for a rollback: `current` is both the version to keep and the "previous" one then.
  [ "$E_LINKED" = 1 ] || return 0
  pv_keep_cur="$VERSIONS_DIR/$VERSION"
  pv_keep_prev=$PREV_DIR
  manifest_lines dir | awk -F '\t' '{ print $2 }' >"$WORK_DIR/dirs" || return 0
  while IFS= read -r pv_d; do
    case $pv_d in "$VERSIONS_DIR"/*) ;; *) continue ;; esac
    case ${pv_d#"$VERSIONS_DIR"/} in */*|.*|'') continue ;; esac
    if [ "$pv_d" = "$pv_keep_cur" ] || [ "$pv_d" = "$pv_keep_prev" ]; then continue; fi
    if codex_config_names "$pv_d"; then
      say "  kept $pv_d: Codex's config still points at it (wasitme doctor --repair moves Codex to the current version)"
      continue
    fi
    if rm_tree "$pv_d"; then
      manifest_drop dir "$pv_d" || true
      say "  removed an old version: $pv_d"
    else
      warn "could not remove the old version $pv_d"
    fi
  done <"$WORK_DIR/dirs"
}
