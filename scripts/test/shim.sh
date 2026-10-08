#!/bin/sh
# Recording stand-in for claude, codex, launchctl, codesign, xcode-select, npm, curl, pkill, pgrep, open and swift.
# Usage (through a wrapper that harness.sh writes): shim.sh NAME ARGS...
# Every call appends "NAME ARGS..." to $SHIM_LOG. Behaviour is steered by environment variables:
#   SHIM_FAIL_<NAME>=text     exit 1 when the arguments contain text
#   SHIM_FAIL_<NAME>_TIMES=N  with SHIM_FAIL_<NAME>: fail only the first N matching calls (e.g. the install, not the restore after it)
#   SHIM_SLEEP_<NAME>=text    sleep $SHIM_SLEEP_SECONDS (default 3) first when the arguments contain text
#   SHIM_LAUNCHCTL_PRINT_LOADED=N   `launchctl print gui/UID/LABEL` says "still loaded" (exit 0) for the first N calls with the
#                             same arguments, then "could not find service" (exit 113), like a job launchd finished tearing
#                             down. Unset: the job is already gone on the first poll.
#   SHIM_XCODE_P              what `xcode-select -p` prints (empty = prints nothing, exits 1, like "no tools selected")
#   SHIM_CURL_FILE            file the fake curl copies to its -o target
#   SHIM_CLI_FILE             file the fake npm build writes as engine/dist/src/cli/main.js
#   SHIM_APP_EXE              executable name the fake swift build produces (default WasitmeApp)
#   SHIM_STATEFUL=1           claude/codex model the real plugin bookkeeping (fake-agents.mjs) instead of only recording
#   SHIM_APP_STATE            a file standing for the running wasitme app: missing = not running, else "launchd" or "user"
#                             (who started it). pgrep finds it; pkill on a bundle path stops it (SHIM_APP_STUBBORN=1: only
#                             -KILL does); `open ... .app` starts it as "user"; `launchctl bootstrap` of a menubar plist
#                             starts it as "launchd" (RunAtLoad) and `launchctl bootout` of that label stops launchd's copy
# `claude plugin configure` also records its stdin in $SHIM_ENV_LOG as "claude-stdin <text>"; `claude plugin validate DIR`
# prints the calls listed in DIR/.fake-calls (a fixture file), like the real validate's `calls:` line.
name=$1
shift
{
  printf '%s' "$name"
  for a in "$@"; do printf ' %s' "$a"; done
  printf '\n'
} >>"$SHIM_LOG"

stdin_text=""
case $name in
  claude|codex)
    printf '%s CLAUDE_CONFIG_DIR=%s CODEX_HOME=%s HOME=%s\n' "$name" "${CLAUDE_CONFIG_DIR:-}" "${CODEX_HOME:-}" "${HOME:-}" >>"$SHIM_ENV_LOG"
    case "$*" in
      "plugin configure "*) stdin_text=$(cat); printf '%s-stdin %s\n' "$name" "$stdin_text" >>"$SHIM_ENV_LOG" ;;
    esac ;;
esac

upper=$(printf '%s' "$name" | tr 'a-z-' 'A-Z_')
eval "fail=\${SHIM_FAIL_$upper:-}"
eval "slp=\${SHIM_SLEEP_$upper:-}"
eval "times=\${SHIM_FAIL_${upper}_TIMES:-}"
args="$*"
if [ -n "$slp" ]; then
  case $args in *"$slp"*) sleep "${SHIM_SLEEP_SECONDS:-3}" ;; esac
fi
if [ -n "$fail" ]; then
  case $args in
    *"$fail"*)
      if [ -n "$times" ]; then n=$(grep -F -- "$name " "$SHIM_LOG" | grep -cF -- "$fail"); else n=0; times=1; fi
      if [ "$n" -le "$times" ]; then printf 'shim %s: injected failure\n' "$name" >&2; exit 1; fi ;;
  esac
fi

case $name in
  claude|codex)
    # SHIM_STATEFUL=1: model the real CLIs' plugin bookkeeping (scripts/test/fake-agents.mjs).
    if [ "${SHIM_STATEFUL:-0}" = 1 ]; then
      printf '%s' "$stdin_text" | node "$(dirname "$0")/fake-agents.mjs" "$name" "$@"
      exit $?
    fi
    if [ "$name" = claude ] && [ "${1:-} ${2:-}" = "plugin validate" ]; then
      for d in "$@"; do last=$d; done
      [ -f "$last/.fake-calls" ] && printf './register.tsx calls: %s\n' "$(cat "$last/.fake-calls")"
    fi ;;
  pgrep)
    if [ -n "${SHIM_APP_STATE:-}" ] && [ -s "$SHIM_APP_STATE" ]; then printf '4242\n'; exit 0; fi
    exit 1 ;;
  pkill)
    case $args in
      *"/Contents/MacOS/"*)
        if [ -n "${SHIM_APP_STATE:-}" ] && [ -s "$SHIM_APP_STATE" ]; then
          case "${SHIM_APP_STUBBORN:-0} $args" in "1 "*-KILL*|0*) rm -f "$SHIM_APP_STATE" ;; esac
          exit 0
        fi ;;
    esac
    exit 1 ;;
  open)
    case $args in *".app"*) if [ -n "${SHIM_APP_STATE:-}" ] && [ ! -s "$SHIM_APP_STATE" ]; then printf 'user\n' >"$SHIM_APP_STATE"; fi ;; esac
    exit 0 ;;
  launchctl)
    if [ -n "${SHIM_APP_STATE:-}" ]; then
      case "${1:-} ${2:-} ${3:-}" in
        "bootout "*dev.wasitme.menubar*) if [ "$(cat "$SHIM_APP_STATE" 2>/dev/null)" = launchd ]; then rm -f "$SHIM_APP_STATE"; fi ;;
        "bootstrap "*dev.wasitme.menubar*) if [ ! -s "$SHIM_APP_STATE" ]; then printf 'launchd\n' >"$SHIM_APP_STATE"; fi ;;
      esac
    fi
    if [ "${1:-}" = print ]; then
      n=$(grep -cxF "launchctl $args" "$SHIM_LOG")   # the current call is already in the log
      if [ "$n" -le "${SHIM_LAUNCHCTL_PRINT_LOADED:-0}" ]; then exit 0; fi
      printf 'Could not find service in domain\n' >&2
      exit 113
    fi ;;
  xcode-select)
    if [ "${1:-}" = "-p" ] && [ -n "${SHIM_XCODE_P:-}" ]; then printf '%s\n' "$SHIM_XCODE_P"; exit 0; fi
    exit 1 ;;
  curl)
    out=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "-o" ]; then out=$2; shift; fi
      shift
    done
    [ -n "$out" ] && cp "$SHIM_CURL_FILE" "$out" ;;
  npm)
    printf 'npm-cwd %s\n' "$PWD" >>"$SHIM_ENV_LOG"
    case $args in
      *"run build"*)
        mkdir -p "$PWD/engine/dist/src/cli"
        cp "$SHIM_CLI_FILE" "$PWD/engine/dist/src/cli/main.js" ;;
    esac ;;
  swift)
    printf 'swift-env DEVELOPER_DIR=%s\n' "${DEVELOPER_DIR:-}" >>"$SHIM_ENV_LOG"
    scratch=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--scratch-path" ]; then scratch=$2; shift; fi
      shift
    done
    bin="$scratch/arm64-apple-macosx/release"
    mkdir -p "$bin"
    case $args in
      *"--show-bin-path"*) printf '%s\n' "$bin" ;;
      *)
        exe="${SHIM_APP_EXE:-WasitmeApp}"
        printf '#!/bin/sh\necho fake app\n' >"$bin/$exe"
        chmod +x "$bin/$exe"
        mkdir -p "$bin/fake.bundle"
        printf 'resource\n' >"$bin/fake.bundle/hello.txt" ;;
    esac ;;
esac
exit 0
