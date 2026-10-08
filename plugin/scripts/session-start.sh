#!/bin/sh
# wasitme plugin hook: SessionStart (and SessionEnd, via session-end.sh). DECISIONS D25/D32/D49/D50/D60.
#
# SessionStart (async):
#   1. Reads the hook payload (JSON on stdin, at most 256 KiB; nothing when stdin is a terminal) and takes `cwd` and
#      `session_id` out of it with bounded sed patterns. The cwd must be absolute, strictly under $HOME (its resolved
#      path too), and free of `..`, `*` (a wildcard in a sandbox grant), quotes and backslash escapes.
#   2. Takes the project snapshot in-process under node's permission sandbox (the engine reads fixed file names only,
#      HMACs them with the salt and writes one record under ~/.wasitme):
#        <node> <--permission | --experimental-permission>
#               --allow-fs-read=<~/.wasitme> --allow-fs-read=<cwd> --allow-fs-write=<~/.wasitme>
#               <cli> hook session-start --cwd <cwd> [--session <id>]
#      One flag per path, plus one more for each path's resolved spelling when it differs: a grant covers only the
#      spelling it was given, and the engine reads the project through its real path (S-NODEPERM 3.9).
#   3. Asks launchd to run wasitme's scan LaunchAgent now (`launchctl kickstart`, never `-k`, so a running scan is left
#      alone).
# SessionEnd: step 3 only. Claude Code gives it about 1.5 s whatever `timeout` says (D50), so TERM is trapped.
#
# Everything it runs comes from ~/.wasitme/engine.env, written by the installer: key=value lines, read with sed and never
# sourced. The file must be a regular file (not a symlink), owned by this user, mode 0600. It never runs a
# PATH-resolved `wasitme` (a repo can put one on a relative PATH entry), and prints nothing (a SessionStart hook's
# stdout would reach the model's context). Off macOS it is a silent no-op (Linux has no LaunchAgent; README platform table).
#
# Every guard failing means: skip that step, exit 0, no output. The scan label must be exactly dev.wasitme.scan or
# dev.wasitme.scan.<suffix>, so engine.env can never be used to start some other service.
# WASITME_HOOK_DRY_RUN=1 prints the commands instead of running them (tests only).

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
# Node reads these from the environment before the engine runs: `NODE_OPTIONS=--require <file>` would run a project's
# code in the hook's node, and `--allow-fs-*` in it would widen the permission sandbox below. The session's environment
# is the project's to set, so none of them gets through. (env -i is not an option: the engine needs HOME, TZ, LANG,
# CLAUDE_CONFIG_DIR and CODEX_HOME.)
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE NODE_EXTRA_CA_CERTS NODE_ICU_DATA NODE_REDIRECT_WARNINGS NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_PRESERVE_SYMLINKS NODE_PRESERVE_SYMLINKS_MAIN NODE_PENDING_DEPRECATION NODE_DEBUG NODE_DEBUG_NATIVE NODE_TLS_REJECT_UNAUTHORIZED
# Node's OpenSSL reads its configuration file from OPENSSL_CONF at startup as well (checked on Node 26.8: a config that
# names a provider module aborts node before any JavaScript runs, and a module that exists would be loaded as native
# code, outside the permission sandbox). OPENSSL_MODULES and OPENSSL_ENGINES say where such modules come from.
unset OPENSSL_CONF OPENSSL_MODULES OPENSSL_ENGINES CDPATH
trap 'exit 0' TERM INT HUP

mode=start
[ "${1:-}" = --session-end ] && mode=end

[ "$(/usr/bin/uname -s 2>/dev/null)" = Darwin ] || exit 0

home=${HOME:-}
case $home in
  /?*) ;;
  *) exit 0 ;;
esac
home=${home%/}

file="$home/.wasitme/engine.env"
[ -f "$file" ] || exit 0
[ -L "$file" ] && exit 0
uid=$(/usr/bin/id -u 2>/dev/null) || exit 0
owner=$(/usr/bin/stat -f %u "$file" 2>/dev/null) || exit 0
[ "$owner" = "$uid" ] || exit 0
perm=$(/usr/bin/stat -f %Lp "$file" 2>/dev/null) || exit 0
[ "$perm" = 600 ] || exit 0

val() { /usr/bin/sed -n "s/^$1=//p" "$file" 2>/dev/null | /usr/bin/head -n 1; }
dry=${WASITME_HOOK_DRY_RUN:-}

# ---- 1 + 2: the project snapshot (SessionStart only) ------------------------------------------------------------
snapshot() {
  node=$(val node)
  cli=$(val cli)
  flag=$(val permission)
  wh=$(val home)
  wh_real=$(val home_real)
  case $flag in --permission | --experimental-permission) ;; *) return 0 ;; esac   # no sandbox, no snapshot
  case $node in /*) ;; *) return 0 ;; esac
  case $cli in /*) ;; *) return 0 ;; esac
  [ -x "$node" ] && [ -f "$cli" ] || return 0
  [ "$wh" = "$home/.wasitme" ] || return 0
  case $wh_real in /?*) ;; *) wh_real=$wh ;; esac

  [ -t 0 ] && return 0
  payload=$(/usr/bin/head -c 262144 2>/dev/null | /usr/bin/tr '\n\r' '  ')
  cwd=$(printf '%s\n' "$payload" | /usr/bin/sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p' | /usr/bin/head -n 1)
  sid=$(printf '%s\n' "$payload" | /usr/bin/sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._-]*\)".*/\1/p' | /usr/bin/head -n 1)
  [ "${#sid}" -le 128 ] || sid=""
  case $cwd in
    "$home"/?*) ;;
    *) return 0 ;;
  esac
  case $cwd in
    *'*'* | */../* | */.. | *'
'*) return 0 ;;
  esac
  [ "${#cwd}" -le 4096 ] || return 0
  cwd_real=$(cd -P -- "$cwd" 2>/dev/null && pwd -P) || return 0
  home_real=$(cd -P -- "$home" 2>/dev/null && pwd -P) || home_real=$home
  case $cwd_real in
    "$home"/?* | "$home_real"/?*) ;;
    *) return 0 ;;   # a project that resolves outside the home folder is never granted
  esac
  case $cwd_real in *'*'*) return 0 ;; esac

  set -- "$node" "$flag" "--allow-fs-read=$wh"
  [ "$wh_real" != "$wh" ] && set -- "$@" "--allow-fs-read=$wh_real"
  set -- "$@" "--allow-fs-read=$cwd"
  [ "$cwd_real" != "$cwd" ] && set -- "$@" "--allow-fs-read=$cwd_real"
  set -- "$@" "--allow-fs-write=$wh"
  [ "$wh_real" != "$wh" ] && set -- "$@" "--allow-fs-write=$wh_real"
  set -- "$@" "$cli" hook session-start --cwd "$cwd"
  [ -n "$sid" ] && set -- "$@" --session "$sid"
  if [ "$dry" = 1 ]; then
    printf '%s\n' "$*"
    return 0
  fi
  "$@" </dev/null >/dev/null 2>&1
  [ $? = 9 ] || return 0
  # Exit 9 is node's "bad option": the recorded flag no longer exists in this node (Node 26 dropped
  # --experimental-permission; Node 22.12 lacks --permission). Retry once with the other spelling.
  case $flag in --permission) other=--experimental-permission ;; *) other=--permission ;; esac
  shift 2
  "$node" "$other" "$@" </dev/null >/dev/null 2>&1
  return 0
}

[ "$mode" = start ] && snapshot

# ---- 3: kick the scan ------------------------------------------------------------------------------------------
label=$(val scan_label)
case $label in
  dev.wasitme.scan | dev.wasitme.scan.?*) ;;
  *) exit 0 ;;
esac
case $label in
  *[!A-Za-z0-9._-]* | *..*) exit 0 ;;
esac

if [ "$dry" = 1 ]; then
  printf '%s\n' "/bin/launchctl kickstart gui/$uid/$label"
  exit 0
fi
/bin/launchctl kickstart "gui/$uid/$label" >/dev/null 2>&1 </dev/null
exit 0
