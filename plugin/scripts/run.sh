#!/bin/sh
# wasitme plugin: the entry point of the report skill (/wasitme:report) and of the Codex skill
# (DECISIONS D25/D32/D46). It finds the engine the installer put on this machine and runs one read-only command.
#
#   /bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" report --md
#   /bin/sh "$HOME/.wasitme/current/plugin/scripts/run.sh" report --md --agent codex
#
# Which engine, in order (every file it would run must be a regular file, not a symlink, owned by this user and not
# writable by group or others):
#   1. the absolute `node` and `cli` the installer recorded in ~/.wasitme/engine.json (D25), read with sed, never
#      sourced; if that node is gone (a `brew upgrade`, `nvm use`), the same cli with a known node;
#   2. the installed engine behind ~/.wasitme/current (D32), with a known node;
#   3. the engine bundled with the plugin (scripts/wasitme.mjs, a release step), run with --read-only.
# A known node is /opt/homebrew/bin/node, /usr/local/bin/node, then the first `node` on the caller's PATH, searching
# absolute entries only and never one inside the session's folder (a relative entry, or a project that puts its own
# bin/ on PATH, would reach the project's code); and only Node 22 or newer.
# Like the hooks, it looks only under $HOME/.wasitme and drops WASITME_HOME before the engine starts: a project's own
# settings can set environment variables for a session, and must not be able to point this at code of their choosing,
# nor at a data folder of their choosing (`report` scans and writes its results into the engine's home).
#
# What it never does: run a PATH-resolved `wasitme` (the skill runs in the session's folder, so a repo that ships its
# own `wasitme` must never be reached), source a file, run anything but `report` or `status`, or print a path (the
# model reads this output; errors are said by kind). The engine runs from `/`, never from the session's folder.
#
# Exit status: 0 whenever there is something to show, failures included (one line saying what to do), and 2 only for a
# command this wrapper does not run. A skill whose `!` shell step exits non-zero is aborted, and Claude Code then shows
# "Shell command failed for pattern ..." with the plugin's absolute path in it (observed on 2.1.289), which the model
# would read; a plain line from here is clearer and carries no path. The engine's stderr is folded into stdout so its
# own message (an error kind, never a path) reaches the person too.

caller_path=${PATH:-}
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
session_dir=$(pwd -P 2>/dev/null) || session_dir=""
# Node reads these from the environment before it runs a single line of ours: `NODE_OPTIONS=--require <file>` would run
# a project's code inside every node started here (the version probe included), and `--allow-fs-*` in it would widen a
# permission sandbox. A session's environment is the project's to set, so none of them gets through.
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE NODE_EXTRA_CA_CERTS NODE_ICU_DATA NODE_REDIRECT_WARNINGS NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_PRESERVE_SYMLINKS NODE_PRESERVE_SYMLINKS_MAIN NODE_PENDING_DEPRECATION NODE_DEBUG NODE_DEBUG_NATIVE NODE_TLS_REJECT_UNAUTHORIZED
# Node's OpenSSL reads its configuration file from OPENSSL_CONF at startup too (checked on Node 26.8: a config naming a
# provider module aborts node before any JavaScript runs, a config with a syntax error exits 100, and a provider that
# does exist would be loaded as native code). OPENSSL_MODULES and OPENSSL_ENGINES say where such modules come from.
unset OPENSSL_CONF OPENSSL_MODULES OPENSSL_ENGINES
# The engine's data folder is the install's (~/.wasitme, the `home` the installer recorded), never one a session's
# environment names: `report` scans and writes its results there, and a project must not be able to point that at a
# folder of its own. CDPATH would make a relative `cd` print the folder it chose to stdout.
unset WASITME_HOME CDPATH

say() { printf '%s\n' "$1"; }

case ${1:-} in
  report | status) ;;
  *)
    say "wasitme: this wrapper only runs 'report' or 'status'."
    exit 2
    ;;
esac

home=${HOME:-}
case $home in
  /*) ;;
  *)
    say "wasitme: HOME is not set, so the wasitme folder cannot be found."
    exit 0
    ;;
esac
wh="$home/.wasitme"

uid=$(id -u 2>/dev/null) || uid=""

if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
  owner_of() { stat -f %u "$1" 2>/dev/null; }
  mode_of() { stat -f %Lp "$1" 2>/dev/null; }
else
  owner_of() { stat -c %u "$1" 2>/dev/null; }
  mode_of() { stat -c %a "$1" 2>/dev/null; }
fi

# trusted FILE: a regular file, not a symlink, owned by this user, not writable by group or others.
trusted() {
  [ -n "$uid" ] || return 1
  [ -f "$1" ] || return 1
  [ -L "$1" ] && return 1
  [ "$(owner_of "$1")" = "$uid" ] || return 1
  t_mode=$(mode_of "$1") || return 1
  case $t_mode in
    '' | *[!0-7]*) return 1 ;;
    *[2367]? | *[2367]) return 1 ;; # writable by group or others
  esac
  return 0
}

# absolute PATH: an absolute path with no backslash, quote or `..` segment.
absolute() {
  case $1 in
    /*) ;;
    *) return 1 ;;
  esac
  case $1 in
    *\\* | *\"* | */../* | */..) return 1 ;;
  esac
  return 0
}

# json_key KEY FILE: the string value of `"KEY": "..."` on a line of its own (the installer writes one key per line).
json_key() {
  sed -n "s/^[[:space:]]*\"$1\":[[:space:]]*\"\\([^\"]*\\)\"[[:space:]]*,\\{0,1\\}[[:space:]]*\$/\\1/p" "$2" 2>/dev/null | head -n 1
}

# node_ok NODE: an absolute, executable node that is version 22 or newer.
node_ok() {
  absolute "$1" || return 1
  [ -f "$1" ] && [ -x "$1" ] || return 1
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' </dev/null >/dev/null 2>&1
}

find_node() {
  for fn_candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if node_ok "$fn_candidate"; then
      printf '%s\n' "$fn_candidate"
      return 0
    fi
  done
  fn_ifs=$IFS
  IFS=:
  for fn_dir in $caller_path; do
    case $fn_dir in
      /*) ;;
      *) continue ;;
    esac
    # Never a node inside the session's folder, by either spelling of the entry.
    if [ -n "$session_dir" ] && [ "$session_dir" != / ]; then
      fn_real=$(cd -P -- "$fn_dir" 2>/dev/null && pwd -P) || continue
      case $fn_dir/ in "$session_dir"/*) continue ;; esac
      case $fn_real/ in "$session_dir"/*) continue ;; esac
    fi
    if node_ok "$fn_dir/node"; then
      IFS=$fn_ifs
      printf '%s\n' "$fn_dir/node"
      return 0
    fi
  done
  IFS=$fn_ifs
  return 1
}

node=""
cli=""
extra=""
installed=0

# 1. engine.json
ej="$wh/engine.json"
if trusted "$ej"; then
  installed=1
  ej_node=$(json_key node "$ej")
  ej_cli=$(json_key cli "$ej")
  if absolute "$ej_cli" && trusted "$ej_cli"; then
    if node_ok "$ej_node"; then
      node=$ej_node
      cli=$ej_cli
    elif found=$(find_node); then
      node=$found
      cli=$ej_cli
    fi
  fi
fi

# 2. the installed engine behind the `current` symlink
if [ -z "$cli" ] && trusted "$wh/current/engine/dist/src/cli/main.js"; then
  installed=1
  if found=$(find_node); then
    node=$found
    cli="$wh/current/engine/dist/src/cli/main.js"
  else
    say "wasitme needs Node 22+: brew install node"
    exit 0
  fi
fi

# 3. the engine bundled with the plugin, read-only
if [ -z "$cli" ]; then
  here=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || here=""
  if [ -n "$here" ] && trusted "$here/wasitme.mjs"; then
    if found=$(find_node); then
      node=$found
      cli="$here/wasitme.mjs"
      # Only `report` scans, so only it takes --read-only; `status` reads what is there and rejects unknown options.
      [ "$1" = report ] && extra="--read-only"
    else
      say "wasitme needs Node 22+: brew install node"
      exit 0
    fi
  fi
fi

if [ -z "$cli" ]; then
  if [ "$installed" = 1 ]; then
    say "wasitme's engine isn't where it was (Node may have moved). Run ~/.local/bin/wasitme doctor --repair."
  else
    say "wasitme isn't set up on this machine, so there is no report to show. Install wasitme, then run this again."
  fi
  exit 0
fi

cd / || exit 0
if [ -n "$extra" ]; then
  out=$("$node" "$cli" "$@" "$extra" 2>&1)
else
  out=$("$node" "$cli" "$@" 2>&1)
fi
status=$?
[ -z "$out" ] || printf '%s\n' "$out"
# A non-zero exit that ends with the engine's own "wasitme: ..." line already says what happened and what to do
# (`status` with no results yet exits 1: a state, not a failure). Only the engine's generic "<command> failed (<kind>)"
# line, or no message at all, gets one more line saying where to look.
if [ "$status" -ne 0 ]; then
  last=${out##*"
"}
  case $last in
    'wasitme: '*' failed ('*) say "wasitme: for details, run in a terminal: ~/.local/bin/wasitme doctor" ;;
    'wasitme: '?*) ;;
    *) say "wasitme: the $1 command stopped with exit status $status. For details, run in a terminal: ~/.local/bin/wasitme doctor" ;;
  esac
fi
exit 0
