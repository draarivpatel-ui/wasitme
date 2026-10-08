# shellcheck shell=sh
# wasitme installer: the install flow. Sourced by install.sh once a source tree is known (--from DIR).
# Order: parse -> preflight -> detect -> choose (flags or guided) -> engine (transactional) -> components.
# Exit codes: 0 done (skips are fine), 1 failed (the engine step is rolled back), 2 usage, 3 engine installed
# but an optional component failed and was rolled back on its own, 4 stopped before changing anything because the new
# Claude Code plugin asks for more than the installed one (re-run with --accept-plugin-changes to accept it).
#
# Modes besides a plain install: --repair (re-apply the installed version), --update (a newer version, keeping the parts
# the manifest lists), --add PART (one more part into the installed version).

# One line per component, shown in a fixed order at the end.
RESULTS=""
RESULT_SEQ=0
result_rank() {
  case $1 in
    engine) printf 1 ;; sandbox) printf 2 ;; command) printf 3 ;; "scan agent") printf 4 ;; "mac app") printf 5 ;;
    "Claude Code plugin") printf 6 ;; "Codex plugin") printf 7 ;; "status line") printf 8 ;; doctor) printf 9 ;; *) printf 9 ;;
  esac
}
result() {
  RESULT_SEQ=$((RESULT_SEQ + 1))
  RESULTS="$RESULTS$(printf '%s%02d' "$(result_rank "$1")" "$RESULT_SEQ")$TAB$(printf '  %-20s %-10s %s' "$1" "$2" "$3")$NL"
}
print_results() { printf '%s' "$RESULTS" | sort -n | cut -f2-; }

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --from) [ $# -ge 2 ] || usage_die "--from needs a directory"; OPT_FROM=$2; shift ;;
      --prefix) [ $# -ge 2 ] || usage_die "--prefix needs a directory"; OPT_PREFIX=$2; shift ;;
      --home) [ $# -ge 2 ] || usage_die "--home needs a directory"; OPT_HOME=$2; shift ;;
      --agents) [ $# -ge 2 ] || usage_die "--agents needs a list like claude-code,codex"; OPT_AGENTS=$2; OPT_AGENTS_SET=1; shift ;;
      --app-executable) [ $# -ge 2 ] || usage_die "--app-executable needs a name"; OPT_APP_EXECUTABLE=$2; shift ;;
      --yes|-y) ASSUME_YES=1 ;;
      --guided) GUIDED=1 ;;
      --repair) REPAIR=1 ;;
      --update) UPDATE=1 ;;
      --no-relaunch) NO_RELAUNCH=1 ;;
      --status) STATUS=1 ;;
      --json) STATUS_JSON=1 ;;
      --from-app) ;;   # handled by install.sh (the detached run arrives here as a plain non-interactive run)
      --add) [ $# -ge 2 ] || usage_die "--add needs a part, such as --add codex-plugin"; OPT_ADD="${OPT_ADD:+$OPT_ADD,}$2"; shift ;;
      --accept-plugin-changes) OPT_ACCEPT_GROWTH=1 ;;
      --dry-run|-n) DRY=1 ;;
      --allow-root) OPT_ALLOW_ROOT=1 ;;
      --app) [ "$OPT_APP" != no ] || usage_die "--app and --no-app contradict each other"; OPT_APP=yes ;;
      --no-app) [ "$OPT_APP" != yes ] || usage_die "--app and --no-app contradict each other"; OPT_APP=no ;;
      --scan-agent) [ "$OPT_SCAN" != no ] || usage_die "--scan-agent and --no-scan-agent contradict each other"; OPT_SCAN=yes ;;
      --no-scan-agent) [ "$OPT_SCAN" != yes ] || usage_die "--scan-agent and --no-scan-agent contradict each other"; OPT_SCAN=no ;;
      --claude-plugin) [ "$OPT_CLAUDE_PLUGIN" != no ] || usage_die "--claude-plugin and --no-claude-plugin contradict each other"; OPT_CLAUDE_PLUGIN=yes ;;
      --no-claude-plugin) [ "$OPT_CLAUDE_PLUGIN" != yes ] || usage_die "--claude-plugin and --no-claude-plugin contradict each other"; OPT_CLAUDE_PLUGIN=no ;;
      --codex-plugin) [ "$OPT_CODEX_PLUGIN" != no ] || usage_die "--codex-plugin and --no-codex-plugin contradict each other"; OPT_CODEX_PLUGIN=yes ;;
      --no-codex-plugin) [ "$OPT_CODEX_PLUGIN" != yes ] || usage_die "--codex-plugin and --no-codex-plugin contradict each other"; OPT_CODEX_PLUGIN=no ;;
      --statusline) [ "$OPT_STATUSLINE" != no ] || usage_die "--statusline and --no-statusline contradict each other"; OPT_STATUSLINE=yes ;;
      --no-statusline) [ "$OPT_STATUSLINE" != yes ] || usage_die "--statusline and --no-statusline contradict each other"; OPT_STATUSLINE=no ;;
      *) usage_die "unknown option: $1" ;;
    esac
    shift
  done
  if [ "$GUIDED" = 1 ] && [ "$ASSUME_YES" = 1 ]; then usage_die "--guided and --yes contradict each other"; fi
  if [ "$REPAIR" = 1 ] && [ "$GUIDED" = 1 ]; then usage_die "--repair asks nothing; it cannot be --guided"; fi
  pa_parts_set=0
  for pa_o in "$OPT_APP" "$OPT_SCAN" "$OPT_CLAUDE_PLUGIN" "$OPT_CODEX_PLUGIN" "$OPT_STATUSLINE"; do [ "$pa_o" = auto ] || pa_parts_set=1; done
  if [ "$STATUS_JSON" = 1 ] && [ "$STATUS" = 0 ]; then usage_die "--json belongs to --status"; fi
  if [ "$STATUS" = 1 ]; then
    for pa_o in "$OPT_APP" "$OPT_SCAN" "$OPT_CLAUDE_PLUGIN" "$OPT_CODEX_PLUGIN" "$OPT_STATUSLINE"; do [ "$pa_o" = auto ] || usage_die "--status only reads; it takes no part flags"; done
    if [ "$UPDATE$REPAIR$GUIDED$DRY$ASSUME_YES$NO_RELAUNCH$OPT_ACCEPT_GROWTH" != 0000000 ] || [ -n "$OPT_ADD$OPT_FROM" ] || [ "$OPT_AGENTS_SET" = 1 ]; then
      usage_die "--status only reads; it takes no other option but --json, --home and --prefix"
    fi
  fi
  if [ "$NO_RELAUNCH" = 1 ] && [ "$UPDATE" = 0 ]; then usage_die "--no-relaunch belongs to --update (a running app is quit for the update and left closed)"; fi
  if [ "$UPDATE" = 1 ]; then
    [ "$REPAIR" = 0 ] || usage_die "--update installs a newer version and --repair re-applies the installed one; use one of them"
    [ -z "$OPT_ADD" ] || usage_die "--update keeps the parts you have; add a part afterwards with --add PART"
    [ "$GUIDED" = 0 ] || usage_die "--update asks nothing; it cannot be --guided"
    [ "$pa_parts_set" = 0 ] || usage_die "--update keeps the parts you have installed. Add one with --add PART, remove one with uninstall.sh --only PART"
    [ "$OPT_AGENTS_SET" = 0 ] || usage_die "--update keeps the agents you track; it takes no --agents"
  fi
  if [ -n "$OPT_ADD" ]; then
    [ "$REPAIR" = 0 ] || usage_die "--add and --repair cannot be combined"
    [ "$GUIDED" = 0 ] || usage_die "--add asks nothing; it cannot be --guided"
    [ "$pa_parts_set" = 0 ] || usage_die "--add names the part to add; leave out the other part flags"
    [ "$OPT_AGENTS_SET" = 0 ] || usage_die "--add takes no --agents (adding a plugin starts tracking its agent)"
    # `scan` is the Control Center's name for the scan agent. Each part once, in the order given.
    pa_list=""
    for pa_p in $(printf '%s' "$OPT_ADD" | tr ',' ' '); do
      case $pa_p in
        scan) pa_p=scan-agent ;;
        app|scan-agent|claude-plugin|codex-plugin|statusline) ;;
        *) usage_die "--add knows app, scan-agent, claude-plugin, codex-plugin and statusline, not '$pa_p'" ;;
      esac
      case ",$pa_list," in *",$pa_p,"*) ;; *) pa_list="${pa_list:+$pa_list,}$pa_p" ;; esac
    done
    [ -n "$pa_list" ] || usage_die "--add needs a part, such as --add codex-plugin"
    OPT_ADD=$pa_list
  fi
  if [ -n "$OPT_HOME" ]; then
    case $OPT_HOME in /*) ;; *) usage_die "--home must be an absolute path" ;; esac
  fi
  if [ -n "$OPT_PREFIX" ]; then
    case $OPT_PREFIX in /*) ;; *) usage_die "--prefix must be an absolute path" ;; esac
  fi
  case $OPT_APP_EXECUTABLE in
    ''|*[!A-Za-z0-9._-]*) usage_die "--app-executable must be a plain file name" ;;
  esac
}

node_hint() {
  cat >&2 <<EOF
wasitme needs Node.js $WASITME_MIN_NODE_MAJOR or newer, and $1.
Install it, then run this installer again:
  macOS (Homebrew):   brew install node
  macOS and Linux:    use nvm (https://github.com/nvm-sh/nvm), then: nvm install $WASITME_MIN_NODE_MAJOR
  Any system:         https://nodejs.org/en/download
EOF
}

preflight() {
  case $OS in
    Darwin|Linux) ;;
    *) die "this installer supports macOS and Linux, not '$OS'. On other systems run the engine with node directly." ;;
  esac
  if [ "$UID_NUM" = 0 ] && [ "$OPT_ALLOW_ROOT" != 1 ]; then
    die "do not run this installer with sudo or as root; it installs into your home directory. (--allow-root overrides this, e.g. inside a container.)"
  fi
  for pf_t in tar cp mv rm mkdir ln readlink sed awk grep cat dirname mktemp tr head cksum; do
    have_cmd "$pf_t" || die "required tool '$pf_t' was not found on PATH"
  done
  NODE=$(command -v node 2>/dev/null || true)
  if [ -z "$NODE" ]; then node_hint "no 'node' was found on your PATH"; exit 1; fi
  case $NODE in
    /*) ;;
    *) NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")" ;;
  esac
  if ! NODE_VERSION=$("$NODE" -p 'process.versions.node' 2>/dev/null); then
    die "found node at $NODE but it did not run"
  fi
  NODE_MAJOR=${NODE_VERSION%%.*}
  case $NODE_MAJOR in
    ''|*[!0-9]*) die "could not read the Node.js version from '$NODE_VERSION'" ;;
  esac
  if [ "$NODE_MAJOR" -lt "$WASITME_MIN_NODE_MAJOR" ]; then node_hint "your node ($NODE_VERSION at $NODE) is too old"; exit 1; fi
  check_path_chars "node path" "$NODE"
}

# ~/.wasitme must be a real folder owned by you. The engine and the plugin hooks refuse a symlinked or foreign one
# (engine/src/store/home.ts: the salt and the history must not be redirectable), so installing into one would report
# success and then every scan and report would fail with permission_denied.
check_state_dir() {
  [ -e "$STATE_DIR" ] || [ -L "$STATE_DIR" ] || return 0
  if [ -L "$STATE_DIR" ]; then
    cs_to=$(readlink "$STATE_DIR" 2>/dev/null || true)
    die "$STATE_DIR is a symbolic link (to ${cs_to:-somewhere else}). wasitme only uses a real folder there: its history and salt must not be redirectable, so every scan would fail. Move the real folder into place (rm '$STATE_DIR', then mv '${cs_to:-<the target>}' '$STATE_DIR'), then re-run this installer."
  fi
  [ -d "$STATE_DIR" ] || die "$STATE_DIR exists but is not a folder; move it out of the way, then re-run this installer"
  cs_owner=$(ls -ldn "$STATE_DIR" 2>/dev/null | awk '{ print $3 }')
  if [ "$cs_owner" != "$UID_NUM" ]; then
    die "$STATE_DIR belongs to another user (uid ${cs_owner:-unknown}), so wasitme would refuse to use it. Fix its owner (or move it away), then re-run this installer."
  fi
}

read_meta() {
  [ -f "$SRC/engine/package.json" ] || die "$SRC is not a wasitme source tree (no engine/package.json)"
  [ -f "$SRC/scripts/install.sh" ] && [ -f "$SRC/scripts/uninstall.sh" ] && [ -d "$SRC/scripts/lib" ] || die "$SRC has no scripts/install.sh, scripts/uninstall.sh and scripts/lib; refusing to install without an uninstaller (and --repair)"
  meta_out=$(jsonutil package "$SRC/engine/package.json") || die "engine/package.json is not usable (see above)"
  VERSION=$(printf '%s\n' "$meta_out" | sed -n 's/^version=//p')
  CLI_REL=$(printf '%s\n' "$meta_out" | sed -n 's/^bin=//p')
  ENGINE_DEPS=$(printf '%s\n' "$meta_out" | sed -n 's/^deps=//p')
  if [ "$ENGINE_DEPS" != 0 ]; then
    die "engine/package.json lists runtime dependencies; this installer never runs npm install for them. The engine must stay dependency-free."
  fi
  ENGINE_CLI="$CURRENT_LINK/engine/$CLI_REL"
}

detect_env() {
  CLAUDE_FOUND=0; CODEX_FOUND=0
  if [ -d "$CLAUDE_DIR" ]; then CLAUDE_FOUND=1; fi
  if [ -d "$CODEX_DIR" ]; then CODEX_FOUND=1; fi
  CLAUDE_CLI=0; CODEX_CLI=0
  if have_cmd "$CLAUDE_BIN"; then CLAUDE_CLI=1; fi
  if have_cmd "$CODEX_BIN"; then CODEX_CLI=1; fi
  if [ "$OPT_AGENTS_SET" = 1 ]; then
    WANT_AGENTS=""
    for da_a in $(printf '%s' "$OPT_AGENTS" | tr ',' ' '); do
      case $da_a in
        claude-code|codex) case " $WANT_AGENTS " in *" $da_a "*) ;; *) WANT_AGENTS="${WANT_AGENTS:+$WANT_AGENTS }$da_a" ;; esac ;;
        *) usage_die "--agents knows claude-code and codex, not '$da_a'" ;;
      esac
    done
    [ -n "$WANT_AGENTS" ] || usage_die "--agents needs at least one agent"
  else
    WANT_AGENTS=""
    if [ "$CLAUDE_FOUND" = 1 ]; then WANT_AGENTS="claude-code"; fi
    if [ "$CODEX_FOUND" = 1 ]; then WANT_AGENTS="${WANT_AGENTS:+$WANT_AGENTS }codex"; fi
    [ -n "$WANT_AGENTS" ] || WANT_AGENTS="claude-code codex"
  fi
  read_marketplace
  read_codex_root
  TOOLCHAIN_OK=0; TOOLCHAIN_WHY="only on macOS"
  if [ "$OS" = Darwin ] && [ -f "$SRC/macos/Package.swift" ]; then
    find_toolchain
  elif [ "$OS" = Darwin ]; then
    TOOLCHAIN_WHY="this source has no macos/ folder"
  fi
}

tracked() { case " $WANT_AGENTS " in *" $1 "*) return 0 ;; esac; return 1; }

# Works out what is possible given the chosen agents. CAN_x is 1/0, WHY_x says why not.
compute_capabilities() {
  CAN_SCAN=0; WHY_SCAN="macOS only"
  if [ "$OS" = Darwin ]; then CAN_SCAN=1; WHY_SCAN=""; fi
  CAN_APP=$TOOLCHAIN_OK; WHY_APP=$TOOLCHAIN_WHY

  CAN_CLAUDE_PLUGIN=1; WHY_CLAUDE_PLUGIN=""
  if ! tracked claude-code; then CAN_CLAUDE_PLUGIN=0; WHY_CLAUDE_PLUGIN="Claude Code is not one of the tracked agents"
  elif [ "$CLAUDE_CLI" != 1 ] && [ "$UPDATE" = 1 ]; then
    CAN_CLAUDE_PLUGIN=0
    WHY_CLAUDE_PLUGIN="the 'claude' command was not found, so Claude Code still records the previous version (the new code already runs from $CURRENT_LINK); later: claude plugin update ${PLUGIN_ID:-wasitme@wasitme}"
  elif [ "$CLAUDE_CLI" != 1 ]; then CAN_CLAUDE_PLUGIN=0; WHY_CLAUDE_PLUGIN="the 'claude' command was not found; later: claude plugin marketplace add $CURRENT_LINK, then claude plugin install ${PLUGIN_ID:-wasitme@wasitme}"
  elif [ "$PLUGIN_POSSIBLE" != 1 ]; then CAN_CLAUDE_PLUGIN=0; WHY_CLAUDE_PLUGIN=$PLUGIN_WHY
  fi
  CAN_CODEX_PLUGIN=1; WHY_CODEX_PLUGIN=""
  if ! tracked codex; then CAN_CODEX_PLUGIN=0; WHY_CODEX_PLUGIN="Codex is not one of the tracked agents"
  elif [ "$CX_POSSIBLE" != 1 ]; then CAN_CODEX_PLUGIN=0; WHY_CODEX_PLUGIN=$CX_WHY
  elif [ "$CODEX_CLI" != 1 ]; then CAN_CODEX_PLUGIN=0; WHY_CODEX_PLUGIN="the 'codex' command was not found; later: codex plugin marketplace add $CURRENT_LINK/plugin-codex, then codex plugin add $CX_ID"
  fi

  CAN_STATUSLINE=1; WHY_STATUSLINE=""
  statusline_detect
  if ! tracked claude-code; then CAN_STATUSLINE=0; WHY_STATUSLINE="Claude Code is not one of the tracked agents"
  elif [ ! -f "$SRC/$WASITME_STATUSLINE_SCRIPT" ]; then CAN_STATUSLINE=0; WHY_STATUSLINE="this source has no $WASITME_STATUSLINE_SCRIPT"
  elif { [ -e "$SL_SHIM" ] || [ -L "$SL_SHIM" ]; } && { [ -L "$SL_SHIM" ] || ! grep -q "$WASITME_MARKER" "$SL_SHIM" 2>/dev/null; }; then
    CAN_STATUSLINE=0; WHY_STATUSLINE="$SL_SHIM already exists and belongs to something else (not touched)"
  else
    case $SL_STATE in
      present) CAN_STATUSLINE=0; WHY_STATUSLINE="you already have a status line (not touched). To show wasitme next to it: $(statusline_wrap_hint)" ;;
      invalid) CAN_STATUSLINE=0; WHY_STATUSLINE="$CLAUDE_SETTINGS is not valid JSON (not touched)" ;;
    esac
  fi
}

# decide NAME OPT CAN WHY -> DECISION=yes|no|ask  (explicit flags beat guided answers; impossible + explicit is an error).
# OPT keep (--update and --add): leave that part exactly as it is, and say nothing about it.
decide() {
  case $2 in
    keep) DECISION=no ;;
    yes)
      if [ "$3" = 1 ]; then DECISION=yes; else die "$1 was requested but is not possible here: $4"; fi ;;
    no)
      DECISION=no
      result "$1" "skipped" "turned off by a flag" ;;
    *)
      if [ "$3" = 1 ]; then DECISION=ask; else DECISION=no; result "$1" "skipped" "$4"; fi ;;
  esac
}

# ask_or_default NAME QUESTION -> sets DECISION to yes|no for an 'ask' decision
settle() {
  if [ "$DECISION" != ask ]; then return 0; fi
  if [ "$GUIDED" = 1 ]; then
    printf '\n'
    ask_yn "$2" yes
    DECISION=$ASK_RESULT
    if [ "$DECISION" = no ]; then result "$1" "skipped" "you chose no"; fi
  else
    DECISION=yes
  fi
}

choose_components() {
  if [ "$GUIDED" = 1 ]; then
    guided_intro
    ask_agents
  fi
  compute_capabilities

  decide "scan agent" "$OPT_SCAN" "$CAN_SCAN" "$WHY_SCAN"
  settle "scan agent" "Run a quiet background scan every $((WASITME_SCAN_INTERVAL / 60)) minutes (sandboxed, starts at login), so your history survives the agents' 30-day log cleanup? macOS will show a \"Background Items Added\" notice for it."
  WANT_SCAN=$DECISION

  decide "mac app" "$OPT_APP" "$CAN_APP" "$WHY_APP"
  settle "mac app" "Install the menu bar app? It is built on this Mac from source (a minute or two), signed locally, with no Apple account and no download."
  WANT_APP=$DECISION

  decide "Claude Code plugin" "$OPT_CLAUDE_PLUGIN" "$CAN_CLAUDE_PLUGIN" "$WHY_CLAUDE_PLUGIN"
  if [ "$DECISION" = ask ] && [ "$GUIDED" = 1 ]; then printf '\n'; mod_disclosure; fi
  settle "Claude Code plugin" "Add the wasitme plugin to Claude Code?"
  WANT_CLAUDE_PLUGIN=$DECISION

  decide "Codex plugin" "$OPT_CODEX_PLUGIN" "$CAN_CODEX_PLUGIN" "$WHY_CODEX_PLUGIN"
  settle "Codex plugin" "Add the wasitme report skill to Codex? (Skills only: no hooks, and your notify setting is never touched.)"
  WANT_CODEX_PLUGIN=$DECISION

  if [ "$CAN_STATUSLINE" = 1 ] && [ "$SL_STATE" = stale ] && [ "$OPT_STATUSLINE" != no ] && [ "$OPT_STATUSLINE" != keep ]; then
    # Our own status line, pointing at a node or engine path that has since moved: keep it working, no question asked.
    DECISION=yes
  elif [ "$CAN_STATUSLINE" = 1 ] && [ "$OPT_STATUSLINE" = auto ] && [ "$CLAUDE_FOUND" != 1 ] && [ "$CLAUDE_CLI" != 1 ]; then
    # Claude Code is neither installed nor configured here (the agent list only defaulted to it): do not create
    # ~/.claude and a settings.json on its behalf. An explicit --statusline still does.
    DECISION=no
    result "status line" "skipped" "Claude Code was not found on this Mac (no 'claude' command and no $CLAUDE_DIR folder); --statusline adds it anyway"
  else
    decide "status line" "$OPT_STATUSLINE" "$CAN_STATUSLINE" "$WHY_STATUSLINE"
    settle "status line" "Show wasitme in Claude Code's status line? You have none today; your settings.json is backed up first."
  fi
  WANT_STATUSLINE=$DECISION
}

show_plan() {
  step "Plan"
  say "  $(printf '%-19s' "wasitme $VERSION") -> $VERSIONS_DIR/$VERSION ($CURRENT_LINK -> versions/$VERSION), command at $SHIM"
  say "  $(printf '%-19s' tracking) -> $WANT_AGENTS"
  if [ -n "$OPT_ADD" ]; then
    say "  $(printf '%-19s' adding) -> $(part_labels "$OPT_ADD")"
    return 0
  fi
  # name:decision:option. An --update leaves a part that is not installed alone ("keep") and says so.
  for sp_pair in "scan agent:$WANT_SCAN:$OPT_SCAN" "mac app:$WANT_APP:$OPT_APP" "Claude Code plugin:$WANT_CLAUDE_PLUGIN:$OPT_CLAUDE_PLUGIN" \
    "Codex plugin:$WANT_CODEX_PLUGIN:$OPT_CODEX_PLUGIN" "status line:$WANT_STATUSLINE:$OPT_STATUSLINE"; do
    sp_want=${sp_pair#*:}
    sp_opt=${sp_want#*:}
    sp_want=${sp_want%%:*}
    if [ "$sp_want" = no ] && [ "$sp_opt" = keep ]; then sp_want="no (not installed, left as it is)"; fi
    say "  $(printf '%-19s' "${sp_pair%%:*}") -> $sp_want"
  done
}

# --repair (what `wasitme doctor --repair` runs): re-apply the installed version from ~/.wasitme/current with the node
# found now. It touches only what the manifest says is installed (the app is never rebuilt), and asks nothing.
repair_prepare() {
  [ -f "$MANIFEST" ] && [ -L "$CURRENT_LINK" ] && [ -d "$CURRENT_LINK/" ] || die "--repair needs an existing install (no $MANIFEST or $CURRENT_LINK); run the installer normally"
  OPT_FROM=$CURRENT_LINK
  ASSUME_YES=1
  OPT_APP=no
  if manifest_has launchagent "$LABEL_SCAN"; then OPT_SCAN=auto; else OPT_SCAN=no; fi
  agents_from_install
}

repair_components() {  # after detect_env: only components the manifest lists
  if [ -n "$PLUGIN_ID" ] && manifest_has claude-plugin "$PLUGIN_ID"; then OPT_CLAUDE_PLUGIN=auto; else OPT_CLAUDE_PLUGIN=${1:-no}; fi
  if [ -n "$CX_ID" ] && manifest_has codex-plugin "$CX_ID"; then OPT_CODEX_PLUGIN=auto; else OPT_CODEX_PLUGIN=${1:-no}; fi
  if manifest_lines statusline | grep -q .; then OPT_STATUSLINE=auto; else OPT_STATUSLINE=${1:-no}; fi
}

# The agents engine.json says this install tracks (one line, as engine_json_write writes it), unless --agents was given.
agents_from_install() {
  if [ "$OPT_AGENTS_SET" = 0 ] && [ -f "$ENGINE_JSON" ]; then
    ai_agents=$(sed -n 's/^[[:space:]]*"agents":[[:space:]]*\[\(.*\)\][[:space:]]*,\{0,1\}$/\1/p' "$ENGINE_JSON" | tr -d '" ' )
    if [ -n "$ai_agents" ]; then OPT_AGENTS=$ai_agents; OPT_AGENTS_SET=1; fi
  fi
}

installed_version() {  # the version `current` points at (versions/<v>), or nothing
  iv_link=$(readlink "$CURRENT_LINK" 2>/dev/null || true)
  case $iv_link in versions/?*) printf '%s\n' "${iv_link#versions/}" ;; esac
}

need_install() {  # need_install FLAG
  [ -f "$MANIFEST" ] && [ -L "$CURRENT_LINK" ] && [ -d "$CURRENT_LINK/" ] || die "$1 needs an existing install (no $MANIFEST or $CURRENT_LINK); run the installer without $1 first"
  INSTALLED_VERSION=$(installed_version)
  adopt_prefix
}

# --update, --add and --status act on the install as it is, so a --prefix chosen at install time is used again (the
# newest one the manifest records) unless another is given. Inside HOME it is adopted; outside, it must be named (the
# uninstaller's rule), because the installer only writes outside HOME when told to.
adopt_prefix() {
  [ -z "$OPT_PREFIX" ] || return 0
  ap_prefix=$(manifest_lines prefix | awk -F '\t' 'END { print $2 }')
  [ -n "$ap_prefix" ] && [ "$ap_prefix" != "$PREFIX" ] || return 0
  case $ap_prefix in
    "$HOME_DIR"/*) OPT_PREFIX=$ap_prefix; init_paths ;;
    *) die "this install used --prefix $ap_prefix; run again with --prefix $ap_prefix" ;;
  esac
}

# ---- --status (what the Control Center's Settings page shows) -----------------------------------------------------------
# Read-only: prints one JSON document about the installed parts and changes nothing (no lock, no write, no download).
# Every value is a fixed word or the installed version, so nothing needs escaping, and no path is printed.
#   { "schema": "wasitme.install-status/1", "installed": bool, "version": "<v>" | null,
#     "integrations": [ { "id": "app" | "claude-plugin" | "statusline" | "codex-plugin" | "scan",
#                         "state": "on" | "off" | "own" | "unavailable" | "unknown", "why": "<code>" (some states) } ],
#     "launchAtLogin": null, "update": { "available": bool, "why": "no_release" (when false) } }
# why: agent_missing (that agent's command, or for the status line its folder too, is not here), not_supported (not on
# this system, or this install cannot add it: a status-line command or settings file in the way, a source without it),
# no_install_record (nothing installed). "own": the person's own status line, which wasitme leaves alone. The ids are
# the Control Center's (scan = the scan agent). launchAtLogin is null until the installer can set it.
status_item() {  # status_item ID STATE [WHY]
  if [ -n "${3:-}" ]; then printf '    { "id": "%s", "state": "%s", "why": "%s" }' "$1" "$2" "$3"
  else printf '    { "id": "%s", "state": "%s" }' "$1" "$2"; fi
}

status_update() {
  case ${WASITME_DEFAULT_URL:-} in
    https://*OWNER*|'') printf '{ "available": false, "why": "no_release" }' ;;
    *) printf '{ "available": true }' ;;
  esac
}

status_print() {  # status_print INSTALLED VERSION APP CLAUDE-PLUGIN STATUSLINE CODEX-PLUGIN SCAN (each state "STATE[ WHY]")
  printf '{\n  "schema": "wasitme.install-status/1",\n  "installed": %s,\n' "$1"
  if [ -n "$2" ]; then printf '  "version": "%s",\n' "$2"; else printf '  "version": null,\n'; fi
  printf '  "integrations": [\n'
  # shellcheck disable=SC2086  # each state splits into STATE and WHY on purpose
  { status_item app $3; printf ',\n'; status_item claude-plugin $4; printf ',\n'; status_item statusline $5; printf ',\n'
    status_item codex-plugin $6; printf ',\n'; status_item scan $7; printf '\n'; }
  printf '  ],\n  "launchAtLogin": null,\n  "update": %s\n}\n' "$(status_update)"
}

status_main() {
  if [ ! -f "$MANIFEST" ] || [ ! -L "$CURRENT_LINK" ] || [ ! -d "$CURRENT_LINK/" ]; then
    sm_u="unknown no_install_record"
    status_print false "" "$sm_u" "$sm_u" "$sm_u" "$sm_u" "$sm_u"
    exit 0
  fi
  adopt_prefix
  SRC=$(cd "$CURRENT_LINK" 2>/dev/null && pwd) || die "could not read $CURRENT_LINK"
  VERSION=$(installed_version)
  case $VERSION in *[!A-Za-z0-9._+-]*) VERSION="" ;; esac
  read_marketplace
  read_codex_root
  CLAUDE_FOUND=0; CLAUDE_CLI=0; CODEX_CLI=0
  if [ -d "$CLAUDE_DIR" ]; then CLAUDE_FOUND=1; fi
  if have_cmd "$CLAUDE_BIN"; then CLAUDE_CLI=1; fi
  if have_cmd "$CODEX_BIN"; then CODEX_CLI=1; fi

  if [ "$OS" != Darwin ]; then sm_app="unavailable not_supported"
  elif manifest_has app "$APP_PATH" && [ -e "$APP_PATH" ]; then sm_app=on
  else sm_app=off; fi

  if [ "$OS" != Darwin ]; then sm_scan="unavailable not_supported"
  elif manifest_has launchagent "$LABEL_SCAN"; then sm_scan=on
  else sm_scan=off; fi

  if [ -n "$PLUGIN_ID" ] && manifest_has claude-plugin "$PLUGIN_ID"; then sm_cp=on
  elif [ "$CLAUDE_CLI" != 1 ]; then sm_cp="unavailable agent_missing"
  elif [ "$PLUGIN_POSSIBLE" != 1 ]; then sm_cp="unavailable not_supported"
  else sm_cp=off; fi

  if [ -n "$CX_ID" ] && manifest_has codex-plugin "$CX_ID"; then sm_cx=on
  elif [ "$CODEX_CLI" != 1 ]; then sm_cx="unavailable agent_missing"
  elif [ "$CX_POSSIBLE" != 1 ]; then sm_cx="unavailable not_supported"
  else sm_cx=off; fi

  # The status line as Claude Code's settings.json has it now (the manifest alone cannot tell "ours" from "replaced").
  statusline_detect
  case $SL_STATE in
    ours|stale) sm_sl=on ;;
    present) sm_sl=own ;;
    invalid) sm_sl="unavailable not_supported" ;;
    *)
      if [ "$CLAUDE_FOUND" != 1 ] && [ "$CLAUDE_CLI" != 1 ]; then sm_sl="unavailable agent_missing"
      elif [ ! -f "$SRC/$WASITME_STATUSLINE_SCRIPT" ]; then sm_sl="unavailable not_supported"
      elif { [ -e "$SL_SHIM" ] || [ -L "$SL_SHIM" ]; } && { [ -L "$SL_SHIM" ] || ! grep -q "$WASITME_MARKER" "$SL_SHIM" 2>/dev/null; }; then sm_sl="unavailable not_supported"
      else sm_sl=off; fi ;;
  esac
  status_print true "$VERSION" "$sm_app" "$sm_cp" "$sm_sl" "$sm_cx" "$sm_scan"
  exit 0
}

part_label() {
  case $1 in
    app) printf 'mac app' ;; scan-agent) printf 'scan agent' ;; claude-plugin) printf 'Claude Code plugin' ;;
    codex-plugin) printf 'Codex plugin' ;; statusline) printf 'status line' ;;
  esac
}
part_labels() {  # part_labels "a,b" -> "mac app, Codex plugin"
  pl_out=""
  for pl_p in $(printf '%s' "$1" | tr ',' ' '); do pl_out="${pl_out:+$pl_out, }$(part_label "$pl_p")"; done
  printf '%s' "$pl_out"
}

# --update: a newer version with exactly the parts the manifest lists (asks nothing). The scan agent and the app are
# decided here, the plugins and the status line after detect_env (update_components). A part that is not installed is
# left alone ("keep"), and the app is rebuilt only when it is installed.
update_prepare() {
  need_install --update
  ASSUME_YES=1
  if manifest_has launchagent "$LABEL_SCAN"; then OPT_SCAN=auto; else OPT_SCAN=keep; fi
  if manifest_has app "$APP_PATH"; then OPT_APP=auto; else OPT_APP=keep; fi
  agents_from_install
}

# --add PART: one more part into the installed version. It runs from the installed copy unless a source of the same
# version is given (the app needs one: the installed copy has no app sources). Everything else is kept as it is.
add_prepare() {
  need_install --add
  [ -n "$INSTALLED_VERSION" ] || die "--add could not read which version is installed ($CURRENT_LINK); run: wasitme doctor --repair"
  [ -n "$OPT_FROM" ] || OPT_FROM=$CURRENT_LINK
  ASSUME_YES=1
  agents_from_install
  OPT_APP=keep; OPT_SCAN=keep; OPT_CLAUDE_PLUGIN=keep; OPT_CODEX_PLUGIN=keep; OPT_STATUSLINE=keep
  for ap_p in $(printf '%s' "$OPT_ADD" | tr ',' ' '); do
    case $ap_p in
      app) OPT_APP=yes ;;
      scan-agent) OPT_SCAN=yes ;;
      claude-plugin) OPT_CLAUDE_PLUGIN=yes; ap_agent=claude-code ;;
      codex-plugin) OPT_CODEX_PLUGIN=yes; ap_agent=codex ;;
      statusline) OPT_STATUSLINE=yes; ap_agent=claude-code ;;
    esac
    # Adding a plugin (or the status line) starts tracking its agent, so the part is possible and engine.json says so.
    case $ap_p in
      claude-plugin|codex-plugin|statusline)
        if [ "$OPT_AGENTS_SET" = 1 ]; then
          case ",$OPT_AGENTS," in *",$ap_agent,"*) ;; *) OPT_AGENTS="$OPT_AGENTS,$ap_agent" ;; esac
        fi ;;
    esac
  done
}

# A part that is already installed is not installed again (to re-apply what is there: install.sh --repair). Needs
# detect_env (the plugin ids). Sets ADD_ALREADY; when nothing is left to add, says so and exits 0 having changed nothing.
part_installed() {  # part_installed PART
  case $1 in
    app) manifest_has app "$APP_PATH" ;;
    scan-agent) manifest_has launchagent "$LABEL_SCAN" ;;
    claude-plugin) [ -n "$PLUGIN_ID" ] && manifest_has claude-plugin "$PLUGIN_ID" ;;
    codex-plugin) [ -n "$CX_ID" ] && manifest_has codex-plugin "$CX_ID" ;;
    statusline)
      manifest_lines statusline | grep -q . && return 0
      statusline_detect
      [ "$SL_STATE" = ours ] ;;   # put there by `wasitme statusline install`
    *) return 1 ;;
  esac
}

add_filter_installed() {
  ADD_ALREADY=""
  af_todo=""
  for af_p in $(printf '%s' "$OPT_ADD" | tr ',' ' '); do
    if part_installed "$af_p"; then
      ADD_ALREADY="${ADD_ALREADY:+$ADD_ALREADY,}$af_p"
      case $af_p in
        app) OPT_APP=keep ;; scan-agent) OPT_SCAN=keep ;; claude-plugin) OPT_CLAUDE_PLUGIN=keep ;;
        codex-plugin) OPT_CODEX_PLUGIN=keep ;; statusline) OPT_STATUSLINE=keep ;;
      esac
    else
      af_todo="${af_todo:+$af_todo,}$af_p"
    fi
  done
  if [ -z "$af_todo" ]; then
    say "Already installed: $(part_labels "$ADD_ALREADY"). Nothing was changed."
    exit 0
  fi
  OPT_ADD=$af_todo
}

add_check_source() {  # after read_meta and detect_env
  [ "$VERSION" = "$INSTALLED_VERSION" ] || die "--add puts a part into the installed version ($INSTALLED_VERSION), and this source is $VERSION. Update first (install.sh --update with this source), then add the part."
  case ",$OPT_ADD," in
    *,app,*)
      if [ "$OS" = Darwin ] && [ ! -f "$SRC/macos/Package.swift" ]; then
        die "the Mac app is built on this Mac from its sources, and $SRC has none (an installed copy never does). Add it from the release you installed or a checkout of the same version: sh install.sh --from DIR --add app (or --tarball FILE --add app)"
      fi ;;
  esac
}

# ---- PATH check: never edits a shell file without a [y/N] yes, and backs it up first -------------------------------
path_check() {
  ON_PATH=false
  case ":$PATH:" in *":$BIN_DIR:"*) ON_PATH=true ;; esac
  [ "$SHIM_SKIPPED" = 0 ] || return 0
  [ "$ON_PATH" = false ] || return 0
  case $BIN_DIR in
    "$HOME_DIR"/*) pc_line="export PATH=\"\$HOME/${BIN_DIR#"$HOME_DIR"/}:\$PATH\"" ;;
    *) pc_line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  case ${SHELL:-} in
    */zsh) pc_rc="$HOME_DIR/.zprofile" ;;
    */bash) if [ "$OS" = Darwin ]; then pc_rc="$HOME_DIR/.bash_profile"; else pc_rc="$HOME_DIR/.profile"; fi ;;
    *) pc_rc="$HOME_DIR/.profile" ;;
  esac
  say ""
  if manifest_has rcline "$pc_rc"; then
    say "$BIN_DIR is on your PATH in new terminal windows (the installer added it to $pc_rc earlier)."
    return 0
  fi
  say "$BIN_DIR is not on your PATH yet, so 'wasitme' will not be found. Add it with:"
  say "  echo '$pc_line' >> $pc_rc"
  say "Until then, run it as: $SHIM"
  [ "$GUIDED" = 1 ] && [ "$DRY" = 0 ] || return 0
  ASK_SOFT=1   # everything else is installed by now: no answer means the default (no), not an abort
  ask_yn "Add that line to $pc_rc for you? (It is backed up first, and the uninstaller removes the line again.)" no
  ASK_SOFT=0
  [ "$ASK_RESULT" = yes ] || return 0
  pc_bak="$pc_rc.wasitme-bak-$(date +%Y%m%d%H%M%S)"
  if ! pc_out=$(jsonutil rc-add "$pc_rc" "$pc_line" "$pc_bak"); then
    warn "could not edit $pc_rc (it was not changed)"
    return 0
  fi
  pc_b=$(printf '%s\n' "$pc_out" | sed -n 's/^backup=//p')
  pc_s=$(printf '%s\n' "$pc_out" | sed -n 's/^sha=//p')
  manifest_put rcline "$pc_rc" "${pc_b:--}" "${pc_s:--}" "$pc_line" || warn "could not record the edit of $pc_rc; remove the wasitme lines from it by hand when you uninstall"
  say "Added. Open a new terminal window (or run: . $pc_rc) and 'wasitme' works."
}

# ---- `wasitme doctor --repair` (the CLI is WP-30) -------------------------------------------------------------------
# The installed engine checks what the installer just did. Guarded: an engine whose usage does not list `doctor` yet is
# skipped and the result says so. WASITME_INSTALLER_ACTIVE=1 tells the CLI not to call back into install.sh --repair,
# and --repair runs (which doctor starts) never call doctor, so the two can never loop.
run_doctor() {
  if [ "$REPAIR" = 1 ] || [ "${WASITME_INSTALLER_ACTIVE:-0}" = 1 ]; then return 0; fi
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] %s\n' "$(quote_argv env WASITME_INSTALLER_ACTIVE=1 "$NODE" "$ENGINE_CLI" doctor --repair) (only if this engine has 'doctor')"
    return 0
  fi
  if ! "$NODE" "$ENGINE_CLI" --help 2>&1 </dev/null | grep -q 'doctor'; then
    result "doctor" "skipped" "this engine has no 'wasitme doctor' yet; nothing was checked"
    return 0
  fi
  step "Checking the install (wasitme doctor --repair)"
  # doctor exits 1 when its report lists problems (older engines exited 0 and only printed them), so its "Problems:"
  # heading is what counts; any other non-zero exit means the report itself did not run.
  rd_rc=0
  env WASITME_INSTALLER_ACTIVE=1 "$NODE" "$ENGINE_CLI" doctor --repair >"$CAP_LOG" 2>&1 </dev/null || rd_rc=$?
  if [ "$rd_rc" -le 1 ] && grep -q '^Problems:' "$CAP_LOG"; then
    sed 's/^/    | /' "$CAP_LOG" | tail -n 25
    result "doctor" "attention" "wasitme doctor --repair found problems it cannot fix (listed above)"
  elif [ "$rd_rc" = 0 ]; then
    result "doctor" "ok" "wasitme doctor --repair found nothing left to fix"
  else
    sed 's/^/    | /' "$CAP_LOG" | tail -n 25
    result "doctor" "attention" "wasitme doctor --repair exited $rd_rc (its output is above)"
  fi
}

# The last line of an --update or --add run: what happened, in one line (the app shows it after an update it started).
final_line() {
  if [ "$UPDATE" = 1 ]; then
    fl_parts=""
    for fl_pair in "scan agent:$WANT_SCAN" "mac app:$WANT_APP" "Claude Code plugin:$WANT_CLAUDE_PLUGIN" "Codex plugin:$WANT_CODEX_PLUGIN" "status line:$WANT_STATUSLINE"; do
      [ "${fl_pair#*:}" = yes ] && fl_parts="${fl_parts:+$fl_parts, }${fl_pair%%:*}"
    done
    if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" != "$VERSION" ]; then fl_what="Updated wasitme $INSTALLED_VERSION -> $VERSION"; else fl_what="Reinstalled wasitme $VERSION"; fi
    # An installed part this run could not update (its tool is missing, say) is named, so "kept" never hides it.
    fl_behind=""
    for fl_pair in "scan agent:$WANT_SCAN:$OPT_SCAN" "mac app:$WANT_APP:$OPT_APP" "Claude Code plugin:$WANT_CLAUDE_PLUGIN:$OPT_CLAUDE_PLUGIN" \
      "Codex plugin:$WANT_CODEX_PLUGIN:$OPT_CODEX_PLUGIN" "status line:$WANT_STATUSLINE:$OPT_STATUSLINE"; do
      fl_rest=${fl_pair#*:}
      if [ "${fl_rest%%:*}" = no ] && [ "${fl_rest#*:}" = auto ]; then fl_behind="${fl_behind:+$fl_behind, }${fl_pair%%:*}"; fi
    done
    fl_app=""
    if [ "$APP_WAS_RUNNING" = 1 ]; then
      if [ "$APP_STARTED" = 1 ]; then fl_app=" The app was restarted."
      elif [ "$NO_RELAUNCH" = 1 ]; then fl_app=" The app was quit for the update and left closed (--no-relaunch); open it from $APPS_DIR when you want it."
      else fl_app=" The app is not running; open it from $APPS_DIR."; fi
    fi
    fl_note=""
    if [ -n "$fl_behind" ]; then fl_note=" Not updated: $fl_behind (see above)."; fi
    if [ "$FAILED" = 1 ]; then
      say "$fl_what, but a part failed and was rolled back (see above); everything else is installed.$fl_note$fl_app"
    else
      say "$fl_what${fl_parts:+ (kept: $fl_parts)}.$fl_note$fl_app"
    fi
  elif [ -n "$OPT_ADD" ]; then
    fl_already=""
    if [ -n "$ADD_ALREADY" ]; then fl_already=" Already installed: $(part_labels "$ADD_ALREADY")."; fi
    if [ "$FAILED" = 1 ]; then say "Could not add the $(part_labels "$OPT_ADD") (see above); nothing else changed.$fl_already"
    else say "Added: $(part_labels "$OPT_ADD").$fl_already"; fi
  fi
}

summary() {
  if [ "$DRY" = 1 ]; then
    if print_results | grep -Eq '^  .{20} skipped '; then
      step "Not planned"
      print_results | grep -E '^  .{20} skipped '
    fi
    say ""
    say "Dry run: nothing was changed. The [dry-run] lines above are exactly what a real run would do."
    return 0
  fi
  step "Result"
  print_results
  if [ "$SHIM_SKIPPED" = 0 ]; then
    say ""
    if [ "$ON_PATH" = true ]; then say "Try it:  wasitme"; else say "Try it:  $SHIM"; fi
  else
    say ""
    say "Try it:  $(quote_arg "$NODE") $(quote_arg "$ENGINE_CLI")"
  fi
  if [ "$CP_RELOAD_NOTE" = 1 ]; then
    say ""
    say "Claude Code: run /reload-plugins in any open session (new sessions pick the plugin up on their own)."
  fi
  if [ "$FAILED" = 1 ]; then
    say ""
    if [ "$ROLLBACK_INCOMPLETE" = 1 ]; then
      say "Something above FAILED, and a plugin you had before could not be put back automatically (see the warnings)."
      say "The rest is installed and working. Fix the problem and run this installer again: it installs that plugin afresh."
    else
      say "Something above FAILED and was rolled back on its own. Everything else is installed and working."
      say "It is safe to fix the problem and run this installer again."
    fi
  fi
  say ""
  say "To remove everything this installer added:  sh $CURRENT_LINK/scripts/uninstall.sh"
  say "(your history in $STATE_DIR is kept unless you add --purge)"
  if [ "$UPDATE" = 1 ] || [ -n "$OPT_ADD" ]; then
    say ""
    final_line
  fi
}

install_main() {
  DRY=0; ASSUME_YES=0; GUIDED=0; REPAIR=0; UPDATE=0; NO_RELAUNCH=0; STATUS=0; STATUS_JSON=0; OPT_ADD=""; ADD_ALREADY=""; INSTALLED_VERSION=""; OPT_ACCEPT_GROWTH=0
  APP_WAS_RUNNING=0; APP_STOPPED=0; APP_STARTED=0
  OPT_HOME=""; OPT_PREFIX=""; OPT_FROM=""; OPT_AGENTS=""; OPT_AGENTS_SET=0; OPT_ALLOW_ROOT=0
  OPT_APP=auto; OPT_SCAN=auto; OPT_CLAUDE_PLUGIN=auto; OPT_CODEX_PLUGIN=auto; OPT_STATUSLINE=auto
  OPT_APP_EXECUTABLE=$WASITME_APP_EXECUTABLE
  SHIM_SKIPPED=0
  ON_PATH=false
  PERM_FLAG=""; PERM_NET=false; SCAN_NODE_ARGS=""; PREV_DIR=""
  parse_args "$@"

  init_runtime
  if [ "$STATUS" = 1 ]; then
    # The app runs this with a short PATH: add the usual places of node and of the claude and codex commands (appended,
    # so the caller's own PATH wins). Then only reads.
    init_paths
    from_app_path "$STATE_DIR" "$HOME_DIR"
    preflight
    status_main
  fi
  preflight
  init_paths
  check_state_dir
  setup_traps
  if [ "$REPAIR" = 1 ]; then repair_prepare; fi
  if [ "$UPDATE" = 1 ]; then update_prepare; fi
  if [ -n "$OPT_ADD" ]; then add_prepare; fi

  [ -n "$OPT_FROM" ] || die "internal: no source directory (install.sh passes --from)"
  SRC=$(cd "$OPT_FROM" 2>/dev/null && pwd) || die "--from: no such directory: $OPT_FROM"
  read_meta
  detect_env
  if [ "$REPAIR" = 1 ]; then repair_components; fi
  if [ "$UPDATE" = 1 ]; then repair_components keep; fi
  if [ -n "$OPT_ADD" ]; then add_filter_installed; add_check_source; fi

  # Interactive only when asked or when there is a real terminal; never hang, never guess consent.
  if [ "$GUIDED" = 0 ] && [ "$ASSUME_YES" = 0 ] && [ "$DRY" = 0 ]; then
    if [ -t 1 ] && tty_open; then
      GUIDED=1
    else
      usage_die "no terminal to ask questions on. Re-run with --yes to accept the defaults, or pass flags (--no-app, --no-claude-plugin, --no-codex-plugin, --no-statusline, --no-scan-agent, --agents ...)."
    fi
  elif [ "$GUIDED" = 1 ]; then
    tty_open || usage_die "--guided needs a terminal (/dev/tty), and none is available"
  fi

  choose_components
  show_plan
  if [ "$GUIDED" = 1 ]; then
    printf '\n'
    ask_yn "Go ahead?" yes
    if [ "$ASK_RESULT" = no ]; then say "Nothing was changed."; exit 0; fi
  fi

  make_work_dir
  engine_prepare_dist
  engine_install

  FAILED=0
  # The status line goes first: its settings.json backup must be the person's own file, taken before Claude Code
  # itself writes its plugin keys (enabledPlugins, extraKnownMarketplaces, pluginConfigs) into the same file.
  if [ "$WANT_STATUSLINE" = yes ]; then comp_statusline || FAILED=1; fi
  if [ "$WANT_CLAUDE_PLUGIN" = yes ] || [ "$WANT_CODEX_PLUGIN" = yes ]; then comp_plugins || FAILED=1; fi
  if [ "$WANT_SCAN" = yes ]; then comp_scan_agent || FAILED=1; fi
  if [ "$WANT_APP" = yes ]; then comp_app || FAILED=1; fi
  prune_versions
  path_check

  # engine.json / engine.env mirror what really exists now (null = not installed), whichever components this run touched.
  if [ "$DRY" != 1 ]; then
    engine_active_state
    engine_files_write || warn "could not refresh $ENGINE_JSON / $ENGINE_ENV; they still point at the engine correctly"
  fi
  run_doctor

  summary
  release_lock
  if [ "$FAILED" = 1 ]; then exit 3; fi
  exit 0
}
