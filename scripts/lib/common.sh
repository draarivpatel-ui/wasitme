# shellcheck shell=sh
# wasitme installer: helpers shared by install.sh and uninstall.sh. Sourced, never executed.
#
# POSIX sh only: no `local`, no [[ ]], no arrays, no echo -e, no process substitution. `set -e` is NOT
# relied on for correctness (it is switched off inside `if` / `||` contexts), so every step that matters
# is checked explicitly. Everything that changes the system goes through run / run_* / write_file /
# swap_symlink / mkdir_track so --dry-run can print the plan instead of acting.
#
# The names this file sets (the constants below, and the paths and tool names that init_runtime and init_paths fill in)
# are read by install.sh, uninstall.sh and the other lib/*.sh files, never by this one. The linter looks at one file at
# a time, so it would call every one of them unused (SC2034); each was checked with grep to be read somewhere. This
# single directive, before the first command, covers the whole file.
# shellcheck disable=SC2034

# ---- Values other packages depend on (change them here and nowhere else) ----------------------------
WASITME_MIN_NODE_MAJOR=22            # D24: Node >= 22 everywhere, including this preflight
WASITME_LABEL_SCAN="dev.wasitme.scan"
WASITME_LABEL_APP="dev.wasitme.menubar"
WASITME_BUNDLE_ID="dev.wasitme.app"
WASITME_APP_BUNDLE="wasitme.app"
WASITME_APP_EXECUTABLE="WasitmeApp"       # executable product of macos/Package.swift (`.executable(name: "WasitmeApp")`)
WASITME_SCAN_INTERVAL=900                  # seconds: the background scan runs every 15 minutes (D46)
WASITME_SCAN_ARGS="scan --no-project-files"  # the LaunchAgent's engine arguments; its stdout goes to /dev/null (quiet)
WASITME_MIN_MACOS="14.0"                   # LSMinimumSystemVersion 14.0 (README: the app is built for 14 and up)
WASITME_STATUSLINE_SCRIPT="packaging/statusline.sh"  # the status line (WP-62): POSIX sh, no node, inside versions/<v>
WASITME_ENGINE_DEV_DIRS="synth analysis/calibration"  # engine/dist/src folders never installed (engine/package.json `files`)
WASITME_MARKER="managed by the wasitme installer"
WASITME_ENGINE_SCHEMA="wasitme.engine/1"   # engine.json schema id (macos EngineConfig parses it as a SchemaID)
# The mod's frozen capabilities (D25, D50/P-A): exactly plugin/tests/check-calls.mjs ALLOWED_CALLS, in that order.
# Setup prints them because Claude Code's install dialog shows only a generic trust warning. A test keeps the two equal.
WASITME_MOD_CALLS='$.clock.every, $.clock.now, $.command.register, $.fs.read, $.fs.stat, $.state.get, $.state.set, $.ui.close, $.ui.open, $.ui.resolve'

NL='
'
TAB=$(printf '\t')

# ---- Output -------------------------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
usage_die() { printf 'error: %s\n(run with --help for usage)\n' "$*" >&2; exit 2; }
step() { printf '\n==> %s\n' "$*"; }

# ---- Quoting and dry-run ---------------------------------------------------------------------------
quote_arg() {
  case $1 in
    '') printf "''" ;;
    *[!A-Za-z0-9_./:=@%+,-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

quote_argv() {
  qv_sep=""
  for qv_a in "$@"; do
    printf '%s' "$qv_sep"
    quote_arg "$qv_a"
    qv_sep=" "
  done
}

# run CMD ARGS...: execute, or print "[dry-run] CMD ARGS..." under --dry-run.
run() {
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] %s\n' "$(quote_argv "$@")"
    return 0
  fi
  "$@"
}

# run_in DIR CMD ARGS...: like run, from inside DIR.
run_in() {
  ri_dir=$1
  shift
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] (cd %s && %s)\n' "$(quote_arg "$ri_dir")" "$(quote_argv "$@")"
    return 0
  fi
  ( cd "$ri_dir" && "$@" )
}

# exec_cap CMD ARGS...: run with output captured; show the tail only if it fails. Needs WORK_DIR.
exec_cap() {
  "$@" >"$CAP_LOG" 2>&1 </dev/null && return 0   # never lets a child wait for input and hang the installer
  ec_rc=$?
  sed 's/^/    | /' "$CAP_LOG" | tail -n 25 >&2
  return "$ec_rc"
}

# Thin wrappers for the external tools. The displayed name is always the bare tool name; the real binary
# can be swapped through WASITME_<TOOL> (tests inject recording shims). Under --home, claude/codex are pinned to
# the sandbox's config dirs so a sandbox run can never write into the real ~/.claude or ~/.codex.
run_tool() {  # run_tool NAME BIN ARGS...
  rt_name=$1
  rt_bin=$2
  shift 2
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] %s\n' "$(quote_argv "$rt_name" "$@")"
    return 0
  fi
  if [ -n "$OPT_HOME" ]; then
    # A sandbox home: pin every config location so the tool can only ever see the sandbox. (Without --home the
    # tools run exactly as they would for the user; forcing CLAUDE_CONFIG_DIR there would change where Claude
    # Code keeps its global config.)
    exec_cap env "HOME=$HOME_DIR" "CLAUDE_CONFIG_DIR=$CLAUDE_DIR" "CODEX_HOME=$CODEX_DIR" "$rt_bin" "$@"
  else
    exec_cap "$rt_bin" "$@"
  fi
}
run_claude()    { run_tool claude "$CLAUDE_BIN" "$@"; }
run_codex()     { run_tool codex "$CODEX_BIN" "$@"; }

# tool_query NAME BIN ARGS...: like run_tool, but it also runs under --dry-run (a read-only query whose answer the
# installer needs, e.g. `claude plugin validate`), with the output on stdout. stdin is /dev/null.
tool_query() {
  shift   # the display name is not needed: nothing is printed for a query
  tq_bin=$1
  shift
  if [ -n "$OPT_HOME" ]; then
    env "HOME=$HOME_DIR" "CLAUDE_CONFIG_DIR=$CLAUDE_DIR" "CODEX_HOME=$CODEX_DIR" "$tq_bin" "$@" </dev/null 2>&1
  else
    "$tq_bin" "$@" </dev/null 2>&1
  fi
}

# run_tool_stdin NAME BIN TEXT ARGS...: run_tool with TEXT on stdin (claude plugin configure --values-stdin). The text
# is written to a 0600 file in the work dir first; under --dry-run it is printed with the command.
run_tool_stdin() {
  rs_name=$1
  rs_bin=$2
  rs_text=$3
  shift 3
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] printf %%s %s | %s\n' "$(quote_arg "$rs_text")" "$(quote_argv "$rs_name" "$@")"
    return 0
  fi
  rs_in="$WORK_DIR/stdin.$$"
  ( umask 077 && printf '%s' "$rs_text" >"$rs_in" ) || return 1
  if [ -n "$OPT_HOME" ]; then
    env "HOME=$HOME_DIR" "CLAUDE_CONFIG_DIR=$CLAUDE_DIR" "CODEX_HOME=$CODEX_DIR" "$rs_bin" "$@" >"$CAP_LOG" 2>&1 <"$rs_in" && { rm -f "$rs_in"; return 0; }
  else
    "$rs_bin" "$@" >"$CAP_LOG" 2>&1 <"$rs_in" && { rm -f "$rs_in"; return 0; }
  fi
  rs_rc=$?
  rm -f "$rs_in"
  sed 's/^/    | /' "$CAP_LOG" | tail -n 25 >&2
  return "$rs_rc"
}
run_codesign()  { run_tool codesign "$CODESIGN_BIN" "$@"; }
run_launchctl() { run_tool launchctl "$LAUNCHCTL_BIN" "$@"; }

# ---- Files, directories, symlinks -----------------------------------------------------------------
# write_file PATH MODE: content on stdin; atomic (temp file in the same directory, then rename).
write_file() {
  wf_path=$1
  wf_mode=$2
  if [ "$DRY" = 1 ]; then
    cat >/dev/null
    printf '[dry-run] write %s (mode %s)\n' "$(quote_arg "$wf_path")" "$wf_mode"
    return 0
  fi
  wf_tmp="$wf_path.tmp.$$"
  if ! cat >"$wf_tmp"; then rm -f "$wf_tmp"; return 1; fi
  if ! chmod "$wf_mode" "$wf_tmp"; then rm -f "$wf_tmp"; return 1; fi
  if ! mv -f "$wf_tmp" "$wf_path"; then rm -f "$wf_tmp"; return 1; fi
}

# swap_symlink TARGET LINK: atomically (re)point LINK at TARGET without following an existing LINK.
swap_symlink() {
  ss_target=$1
  ss_link=$2
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] symlink %s -> %s\n' "$(quote_arg "$ss_link")" "$(quote_arg "$ss_target")"
    return 0
  fi
  ss_tmp="$ss_link.new.$$"
  rm -f "$ss_tmp"
  ln -s "$ss_target" "$ss_tmp" || return 1
  # Rename the new link over the old one WITHOUT following the old one if it points at a directory:
  # BSD/macOS mv has -h, GNU/busybox mv has -T. Whichever this system understands is atomic.
  if mv -f -h "$ss_tmp" "$ss_link" 2>/dev/null; then return 0; fi
  if mv -f -T "$ss_tmp" "$ss_link" 2>/dev/null; then return 0; fi
  rm -f "$ss_link" && mv "$ss_tmp" "$ss_link" && return 0   # last resort: not atomic, but still correct
  rm -f "$ss_tmp"
  return 1
}

# rm_tree PATH: remove a folder that may be read-only (version folders are `chmod -R a-w`, D46). Without the chmod,
# rm cannot unlink the entries of a read-only directory.
rm_tree() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] chmod -R u+w %s && rm -rf %s\n' "$(quote_arg "$1")" "$(quote_arg "$1")"
    return 0
  fi
  if [ -d "$1" ] && [ ! -L "$1" ]; then chmod -R u+w "$1" 2>/dev/null || true; fi
  rm -rf "$1"
}

# real_dir DIR: the directory's resolved spelling (symlinks and /tmp -> /private/tmp style aliases resolved), or nothing
# when it does not exist. Node's sandbox matches a grant on the SPELLING of a path, so both spellings get one (D49).
real_dir() { ( cd -P -- "$1" 2>/dev/null && pwd -P ); }

# Directories this run created, so a rollback or uninstall can remove exactly those (newest last).
NEW_DIRS=""
MKDIR_MODE=""
DRY_DIRS=""   # dry-run only: directories already announced, so each "mkdir" is printed once
mkdir_track() {
  mt_list=""
  mt_cur=$1
  while [ ! -d "$mt_cur" ]; do
    if [ "$DRY" = 1 ]; then
      case "$DRY_DIRS" in *"$NL$mt_cur$NL"*) break ;; esac
    fi
    mt_list="$mt_cur$NL$mt_list"
    mt_cur=$(dirname "$mt_cur")
  done
  while IFS= read -r mt_d; do
    [ -n "$mt_d" ] || continue
    if [ "$DRY" = 1 ]; then
      printf '[dry-run] mkdir %s\n' "$(quote_arg "$mt_d")"
      DRY_DIRS="$DRY_DIRS$NL$mt_d$NL"
      continue
    fi
    if [ -n "$MKDIR_MODE" ]; then mkdir -m "$MKDIR_MODE" "$mt_d" || return 1; else mkdir "$mt_d" || return 1; fi
    NEW_DIRS="$NEW_DIRS$mt_d$NL"
  done <<EOF
$mt_list
EOF
}

# ~/.wasitme holds the salt and the history; keep it private when we are the one creating it.
ensure_state_dir() {
  MKDIR_MODE=700
  mkdir_track "$STATE_DIR" || { MKDIR_MODE=""; return 1; }
  MKDIR_MODE=""
}

# Newest-first view of NEW_DIRS (awk keeps this portable: tail -r is BSD-only).
new_dirs_reversed() { printf '%s' "$NEW_DIRS" | awk '{ a[NR] = $0 } END { for (i = NR; i >= 1; i--) if (a[i] != "") print a[i] }'; }

rollback_dirs() {
  [ -n "$NEW_DIRS" ] || return 0
  new_dirs_reversed | while IFS= read -r rd_d; do rmdir "$rd_d" 2>/dev/null || true; done
  NEW_DIRS=""
}

commit_dirs() {
  [ -n "$NEW_DIRS" ] || return 0
  while IFS= read -r cd_d; do
    [ -n "$cd_d" ] || continue
    manifest_put createddir "$cd_d" || return 1
  done <<EOF
$NEW_DIRS
EOF
  NEW_DIRS=""
}

# ---- Install manifest: what this installer created, so uninstall can reverse exactly that -----------
# Tab-separated lines "KIND<TAB>KEY[<TAB>EXTRA...]"; fields are never empty ("-" stands in).
manifest_init() {
  if [ "$DRY" = 1 ]; then return 0; fi
  ensure_state_dir || return 1
  if [ ! -f "$MANIFEST" ]; then
    ( umask 077 && printf 'format%s1\n' "$TAB" >"$MANIFEST" ) || return 1   # 0600 like every file in ~/.wasitme (PRIVACY.md)
  fi
}

manifest_put() {  # manifest_put KIND KEY [EXTRA...]: replaces the line with the same KIND and KEY, or appends
  if [ "$DRY" = 1 ]; then return 0; fi
  mp_kind=$1
  mp_key=$2
  shift 2
  mp_line="$mp_kind$TAB$mp_key"
  for mp_x in "$@"; do mp_line="$mp_line$TAB$mp_x"; done
  manifest_init || return 1
  mp_tmp="$MANIFEST.tmp.$$"
  # Replace the line in place if there is one (stable order), otherwise append.
  awk -F '\t' -v k="$mp_kind" -v key="$mp_key" -v line="$mp_line" '
    $1 == k && $2 == key { if (!done) { print line; done = 1 }; next }
    { print }
    END { if (!done) print line }' "$MANIFEST" >"$mp_tmp" || { rm -f "$mp_tmp"; return 1; }
  chmod 600 "$mp_tmp" 2>/dev/null || true
  mv -f "$mp_tmp" "$MANIFEST" || { rm -f "$mp_tmp"; return 1; }
}

manifest_drop() {  # manifest_drop KIND KEY: forget the line with that KIND and KEY (nothing to do if there is none)
  if [ "$DRY" = 1 ]; then return 0; fi
  [ -f "$MANIFEST" ] || return 0
  md_tmp="$MANIFEST.tmp.$$"
  awk -F '\t' -v k="$1" -v key="$2" '!($1 == k && $2 == key) { print }' "$MANIFEST" >"$md_tmp" || { rm -f "$md_tmp"; return 1; }
  chmod 600 "$md_tmp" 2>/dev/null || true
  mv -f "$md_tmp" "$MANIFEST" || { rm -f "$md_tmp"; return 1; }
}

manifest_has() {  # manifest_has KIND KEY
  [ -f "$MANIFEST" ] || return 1
  awk -F '\t' -v k="$1" -v key="$2" '$1 == k && $2 == key { found = 1 } END { exit !found }' "$MANIFEST"
}

manifest_field() {  # manifest_field KIND KEY N: field N (1 = the kind) of the first matching line; empty if none
  [ -f "$MANIFEST" ] || return 0
  awk -F '\t' -v k="$1" -v key="$2" -v n="$3" '$1 == k && $2 == key { print $n; exit }' "$MANIFEST"
}

manifest_lines() {  # manifest_lines KIND: prints the matching lines in file order
  [ -f "$MANIFEST" ] || return 0
  awk -F '\t' -v k="$1" '$1 == k' "$MANIFEST"
}

# ---- Transactions: undo functions run newest-first on failure or interrupt --------------------------
TXN_STACK=""
txn_begin()  { TXN_STACK="$1$NL$TXN_STACK"; }
txn_commit() { TXN_STACK=${TXN_STACK#*"$NL"}; }
# Under --dry-run nothing real was done (run/write_file only print, yet they set the same "done" flags a real run
# does), so there is nothing to undo, and an undo function would act on the person's real files. Pop and skip.
txn_abort()  { ta_fn=${TXN_STACK%%"$NL"*}; TXN_STACK=${TXN_STACK#*"$NL"}; [ "$DRY" = 1 ] || "$ta_fn" || true; }

# A component (app, plugins, ...) may open several transactions; on failure it unwinds back to its mark.
COMP_MARK=""
comp_mark() { COMP_MARK=$TXN_STACK; }
comp_unwind() {
  while [ -n "$TXN_STACK" ] && [ "$TXN_STACK" != "$COMP_MARK" ]; do
    txn_abort
  done
}

# ---- Process lifecycle: temp dirs, lock, exit handling --------------------------------------------
WORK_DIR=""
BOOT_TMP=""
LOCK_DIR=""
CAP_LOG=""

make_work_dir() {
  mw_tmp=${TMPDIR:-/tmp}
  mw_tmp=${mw_tmp%/}   # macOS TMPDIR ends in a slash
  if [ "$DRY" = 1 ]; then
    WORK_DIR="$mw_tmp/wasitme-install.XXXXXX"   # symbolic: nothing is created under --dry-run
    return 0
  fi
  WORK_DIR=$(mktemp -d "$mw_tmp/wasitme-install.XXXXXX") || die "could not create a temp directory"
  CAP_LOG="$WORK_DIR/cap.log"
}

acquire_lock() {  # the lock lives in STATE_DIR (which must exist) and is shared with uninstall
  if [ "$DRY" = 1 ]; then return 0; fi
  al_dir="$STATE_DIR/.install.lock"
  al_tries=0
  while ! mkdir "$al_dir" 2>/dev/null; do
    al_holder=$(cat "$al_dir/pid" 2>/dev/null || true)
    if [ -n "$al_holder" ] && ! kill -0 "$al_holder" 2>/dev/null; then
      rm -rf "$al_dir"   # its holder died
      continue
    fi
    al_tries=$((al_tries + 1))
    if [ "$al_tries" -gt "${WASITME_LOCK_WAIT:-30}" ]; then die "another wasitme install or uninstall is running (lock: $al_dir)"; fi
    sleep 1
  done
  printf '%s\n' "$$" >"$al_dir/pid"
  LOCK_DIR=$al_dir
}

release_lock() {
  [ -n "$LOCK_DIR" ] || return 0
  rm -rf "$LOCK_DIR"
  LOCK_DIR=""
}

run_rollbacks() {
  while [ -n "$TXN_STACK" ]; do
    txn_abort
  done
}

on_exit() {
  oe_rc=$?
  trap - EXIT INT TERM HUP
  if [ "$oe_rc" -ne 0 ] && [ -n "$TXN_STACK" ]; then
    printf 'error: stopped early (exit %s); undoing the changes made so far\n' "$oe_rc" >&2
    run_rollbacks
  fi
  [ -z "$WORK_DIR" ] || [ "$DRY" = 1 ] || rm -rf "$WORK_DIR"
  [ -z "$BOOT_TMP" ] || rm -rf "$BOOT_TMP"
  release_lock
  exit "$oe_rc"
}

setup_traps() {
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
}

# ---- Validation ---------------------------------------------------------------------------------------
# Paths end up in plists, a shell shim, JSON and a settings.json command line. Keeping them to a boring
# character set removes every quoting and injection question in one place.
check_path_chars() {  # check_path_chars LABEL PATH
  case $2 in
    /*) ;;
    *) die "$1 must be an absolute path (got '$2')" ;;
  esac
  case $2 in
    *[!A-Za-z0-9_./\ @+:,=~-]*)
      die "$1 ('$2') contains characters this installer does not support. Allowed: letters, digits, space and _ . / @ + : , = ~ -" ;;
  esac
  case $2 in
    */../*|*/..) die "$1 ('$2') must not contain '..'" ;;
  esac
}

# A manifest entry is only removed when it sits strictly inside HOME or the prefix.
safe_path() {  # safe_path PATH
  case $1 in
    "$HOME_DIR"|"$PREFIX"|"$HOME_DIR/"|"$PREFIX/"|""|/) return 1 ;;
    */../*|*/..) return 1 ;;
    "$HOME_DIR"/*|"$PREFIX"/*) return 0 ;;
  esac
  return 1
}

# createddir entries are removed with a plain rmdir, which can only ever delete an EMPTY directory, so the
# rule is looser: absolute, normalised, and not the filesystem root.
safe_rmdir_path() {
  case $1 in
    /|'') return 1 ;;
    /*) ;;
    *) return 1 ;;
  esac
  case $1 in
    */../*|*/..) return 1 ;;
  esac
  return 0
}

# ---- Environment: OS, tools, paths ---------------------------------------------------------------------
init_runtime() {
  OS=${WASITME_OS:-$(uname -s)}
  UID_NUM=$(id -u)
  CLAUDE_BIN=${WASITME_CLAUDE:-claude}
  CODEX_BIN=${WASITME_CODEX:-codex}
  CODESIGN_BIN=${WASITME_CODESIGN:-codesign}
  LAUNCHCTL_BIN=${WASITME_LAUNCHCTL:-launchctl}
  NPM_BIN=${WASITME_NPM:-npm}
  PKILL_BIN=${WASITME_PKILL:-pkill}
  PGREP_BIN=${WASITME_PGREP:-pgrep}
  OPEN_BIN=${WASITME_OPEN:-open}
  # launchd's gui domain is global and cannot be redirected, so a custom --home never touches it unless
  # a launchctl replacement was injected explicitly. The running app is treated the same way (it is quit and started
  # again only when launchd may be touched), and `open` additionally needs its own replacement under --home: a sandbox
  # must never launch a real app.
  LAUNCHCTL_ON=1
  if [ -n "$OPT_HOME" ] && [ -z "${WASITME_LAUNCHCTL:-}" ]; then LAUNCHCTL_ON=0; fi
  OPEN_ON=$LAUNCHCTL_ON
  if [ -n "$OPT_HOME" ] && [ -z "${WASITME_OPEN:-}" ]; then OPEN_ON=0; fi
  LABEL_SUFFIX=${WASITME_LABEL_SUFFIX:-}
  case $LABEL_SUFFIX in
    *[!A-Za-z0-9._-]*) die "WASITME_LABEL_SUFFIX may only contain letters, digits, . _ -" ;;
  esac
  LABEL_SCAN=$WASITME_LABEL_SCAN
  LABEL_APP=$WASITME_LABEL_APP
  if [ -n "$LABEL_SUFFIX" ]; then
    LABEL_SCAN="$LABEL_SCAN.$LABEL_SUFFIX"
    LABEL_APP="$LABEL_APP.$LABEL_SUFFIX"
  fi
}

init_paths() {
  if [ -n "$OPT_HOME" ]; then
    HOME_DIR=${OPT_HOME%/}
    HOME=$HOME_DIR
    export HOME
    CLAUDE_DIR="$HOME_DIR/.claude"   # a sandbox home never inherits the real config dirs
    CODEX_DIR="$HOME_DIR/.codex"
  else
    HOME_DIR=${HOME:-}
    [ -n "$HOME_DIR" ] || die "HOME is not set"
    HOME_DIR=${HOME_DIR%/}
    CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME_DIR/.claude}
    CODEX_DIR=${CODEX_HOME:-$HOME_DIR/.codex}
  fi
  PREFIX=${OPT_PREFIX:-$HOME_DIR/.local}
  PREFIX=${PREFIX%/}
  # A sandbox home never carries the real LaunchAgent labels (dev.wasitme.scan is a real install's job): without an
  # explicit WASITME_LABEL_SUFFIX it gets one derived from its path, the same on every run, so install, update and
  # uninstall all agree on it.
  if [ -n "$OPT_HOME" ] && [ -z "$LABEL_SUFFIX" ]; then
    LABEL_SUFFIX="home-$(printf '%s' "$HOME_DIR" | cksum | awk '{ print $1 }')"
    LABEL_SCAN="$WASITME_LABEL_SCAN.$LABEL_SUFFIX"
    LABEL_APP="$WASITME_LABEL_APP.$LABEL_SUFFIX"
  fi
  check_path_chars "home directory" "$HOME_DIR"
  check_path_chars "prefix" "$PREFIX"
  check_path_chars "Claude Code config directory" "$CLAUDE_DIR"
  check_path_chars "Codex config directory" "$CODEX_DIR"
  # Layout (D32/D46): immutable ~/.wasitme/versions/<v> plus ONE `current` symlink that the engine, the
  # Claude marketplace and the Codex marketplace root all go through. --prefix only moves the command (bin/).
  LEGACY_DATA_DIR="$PREFIX/share/wasitme"   # where installers before D46 put the engine; only the uninstaller looks
  BIN_DIR="$PREFIX/bin"
  SHIM="$BIN_DIR/wasitme"
  SL_SHIM="$BIN_DIR/wasitme-statusline"
  STATE_DIR="$HOME_DIR/.wasitme"
  VERSIONS_DIR="$STATE_DIR/versions"
  CURRENT_LINK="$STATE_DIR/current"
  LOG_DIR="$STATE_DIR/logs"
  MANIFEST="$STATE_DIR/install-manifest"
  ENGINE_JSON="$STATE_DIR/engine.json"
  ENGINE_ENV="$STATE_DIR/engine.env"
  GLANCE_PATH="$STATE_DIR/glance.json"
  APPS_DIR="$HOME_DIR/Applications"
  APP_PATH="$APPS_DIR/$WASITME_APP_BUNDLE"
  AGENTS_DIR="$HOME_DIR/Library/LaunchAgents"
  CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# ---- --from-app (the Mac app's Update, Add and Remove buttons) ---------------------------------------------------------
path_append() { [ -d "$1" ] || return 0; case ":$PATH:" in *":$1:"*) ;; *) PATH="${PATH:+$PATH:}$1" ;; esac; }

# The app starts actions with a short PATH. Appended (whatever the caller's PATH has comes first): the system folders,
# node's own folder from engine.json when no node is on PATH, and the usual places of the claude and codex commands.
from_app_path() {  # from_app_path WASITME_HOME USER_HOME
  for fp_d in /usr/bin /bin /usr/sbin /sbin; do path_append "$fp_d"; done
  if ! command -v node >/dev/null 2>&1; then
    fp_node=$(sed -n 's/^[[:space:]]*"node":[[:space:]]*"\([^"]*\)"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p' "$1/engine.json" 2>/dev/null | head -n 1)
    case $fp_node in /*) if [ -x "$fp_node" ]; then path_append "$(dirname "$fp_node")"; fi ;; esac
  fi
  for fp_d in "$2/.local/bin" /opt/homebrew/bin /usr/local/bin; do path_append "$fp_d"; done
  export PATH
}

# from_app_launch ACTION WASITME_HOME USER_HOME SCRIPT ARGS...: hand the same command to lib/from-app.mjs, which runs it
# detached from the app (a new session, output in WASITME_HOME/state/last-action.log) and records how it ended in
# WASITME_HOME/state/last-action.json. Returns at once (exit 0 once started). Needs LIB_DIR.
from_app_launch() {
  fl_action=$1 fl_home=$2 fl_user=$3 fl_script=$4
  shift 4
  [ -d "$fl_home" ] && [ ! -L "$fl_home" ] || die "--from-app needs an installed wasitme ($fl_home is not there)"
  [ -f "$LIB_DIR/from-app.mjs" ] || die "--from-app runs from an installed copy (lib/from-app.mjs is missing next to this script)"
  from_app_path "$fl_home" "$fl_user"
  fl_node=$(command -v node 2>/dev/null) || die "node was not found on PATH or in $fl_home/engine.json"
  exec "$fl_node" "$LIB_DIR/from-app.mjs" "$fl_action" "$fl_home" -- "${WASITME_SH:-sh}" "$fl_script" "$@"
}

# An app bundle is ours only when its Info.plist carries our bundle id. A folder without one (a partial copy, someone
# else's app) is never ours. The installer (before replacing) and the uninstaller (before deleting) use this same rule.
app_is_ours() { [ -f "$1/Contents/Info.plist" ] && grep -q "$WASITME_BUNDLE_ID" "$1/Contents/Info.plist" 2>/dev/null; }

# node helper for JSON work (settings.json, package.json, marketplace.json). Node is guaranteed by preflight.
jsonutil() { "$NODE" "$LIB_DIR/jsonutil.mjs" "$@"; }

# statusline_state_of SETTINGS SHIM: jsonutil's statusline-state for the status-line shim, matching either spelling of its
# command. The installer writes it shell-quoted (quote_arg: a path with a space or ~ gets quotes, and Claude Code runs the
# command through a shell), while `wasitme statusline install` writes the raw path. Both are wasitme's, so "ours" wins if
# either matches; a failure of the first call (no node, unreadable file) is returned as-is.
statusline_state_of() {
  sso_q=$(quote_arg "$2")
  sso_st=$(jsonutil statusline-state "$1" "$sso_q" 2>/dev/null) || return 1
  if [ "$sso_st" = present ] && [ "$sso_q" != "$2" ]; then
    sso_raw=$(jsonutil statusline-state "$1" "$2" 2>/dev/null) || sso_raw=""
    [ "$sso_raw" != ours ] || sso_st=ours
  fi
  printf '%s\n' "$sso_st"
}
