#!/bin/sh
# Tests for plugin/scripts/run.sh, the report skill's entry point. POSIX sh, no dependencies beyond a Node 22+.
#
#   sh plugin/tests/run-sh.sh
#
# Every case runs under `env -i` with a throwaway HOME, so the real ~/.wasitme is never read, and the "engine" is a
# stand-in script that prints what it was given. The session's folder (the cwd) holds a hostile `node` and `wasitme`
# reachable only through a relative PATH entry: neither may ever run. No output may carry a path.
set -u
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(dirname "$here")
runsh="$plugin/scripts/run.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-runsh.XXXXXX")
tmp=$(cd "$tmp" && pwd -P)
trap 'chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT INT TERM
fails=0
cases=0

fail() { echo "FAIL: $1"; fails=$((fails + 1)); }

# A real Node 22+ for the stand-in engine, by absolute path.
real_node=""
for candidate in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  case $candidate in /*) ;; *) continue ;; esac
  if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
    real_node=$candidate
    break
  fi
done
if [ -z "$real_node" ]; then
  echo "SKIP: no Node 22+ found for the stand-in engine"
  exit 0
fi
mkdir -p "$tmp/nodebin"
ln -s "$real_node" "$tmp/nodebin/node"

# The stand-in engine: what it was asked, from where, a line on stderr, and the exit status it is told to use.
cat > "$tmp/fake.mjs" <<'EOF'
// FAKE_SAY=noresults|failed: answer only with the engine's own one-line message, like `wasitme status` with no
// results yet (exit 1) or a crash the CLI reports by kind.
if (process.env.FAKE_SAY === "noresults") { console.log("wasitme: no results yet; run: wasitme scan"); process.exit(1); }
if (process.env.FAKE_SAY === "failed") { console.error("wasitme: report failed (permission_denied)."); process.exit(1); }
console.log("argv=" + process.argv.slice(2).join(" "));
console.log("cwd=" + process.cwd());
console.log("home=" + (process.env.WASITME_HOME ?? "unset"));
console.log("claudedir=" + (process.env.WASITME_CLAUDE_DIR ?? "unset") + " codexdir=" + (process.env.WASITME_CODEX_DIR ?? "unset"));
console.log("claudecfg=" + (process.env.CLAUDE_CONFIG_DIR ?? "unset") + " codexhome=" + (process.env.CODEX_HOME ?? "unset"));
console.error("stderr-line");
process.exit(Number(process.env.FAKE_EXIT ?? "0"));
EOF

# The session's folder: a hostile node and wasitme that only a relative PATH entry would reach.
mkdir -p "$tmp/repo"
for evil in node wasitme; do
  printf '#!/bin/sh\ntouch "%s/EVIL-%s"\necho evil\n' "$tmp" "$evil" > "$tmp/repo/$evil"
  chmod +x "$tmp/repo/$evil"
done

# home NAME: a fresh HOME with an empty ~/.wasitme.
home() {
  mkdir -p "$tmp/$1/.wasitme"
  printf '%s' "$tmp/$1"
}

# engine_json HOME NODE CLI [MODE]
engine_json() {
  {
    printf '{\n'
    printf '  "schema": 1,\n'
    printf '  "version": "0.1.0",\n'
    printf '  "node": "%s",\n' "$2"
    printf '  "cli": "%s",\n' "$3"
    printf '  "scanLabel": null\n'
    printf '}\n'
  } > "$1/.wasitme/engine.json"
  chmod "${4:-600}" "$1/.wasitme/engine.json"
}

# cli_in HOME NAME [MODE]: a copy of the stand-in inside that HOME.
cli_in() {
  mkdir -p "$1/.wasitme/versions/0.1.0/engine/dist/src/cli"
  cp "$tmp/fake.mjs" "$1/.wasitme/versions/0.1.0/engine/dist/src/cli/$2"
  chmod "${3:-444}" "$1/.wasitme/versions/0.1.0/engine/dist/src/cli/$2"
  printf '%s' "$1/.wasitme/versions/0.1.0/engine/dist/src/cli/$2"
}

# run HOME [VAR=value ...] -- ARGS...: run.sh's combined output; the exit status is left in $rc.
run() {
  r_home=$1
  shift
  r_env=""
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    r_env="$r_env $1"
    shift
  done
  [ $# -gt 0 ] && shift
  # shellcheck disable=SC2086 # r_env is a list of VAR=value words built above
  out=$(cd "$tmp/repo" && env -i PATH=".:$tmp/nodebin:/usr/bin:/bin" ${r_home:+HOME="$r_home"} $r_env /bin/sh "$runsh" "$@" 2>&1)
  rc=$?
}

# expect NAME WANT_RC PATTERN: the last run exited WANT_RC and its output contains PATTERN; never a path.
expect() {
  cases=$((cases + 1))
  [ "$rc" = "$2" ] || fail "$1: exit $rc, expected $2 (output: $out)"
  case $out in
    *"$3"*) ;;
    *) fail "$1: output lacks '$3': $out" ;;
  esac
  case $out in
    *"$tmp"*) fail "$1: output carries a path: $out" ;;
  esac
}

# expect_not NAME PATTERN: the last run's output does not contain PATTERN.
expect_not() {
  cases=$((cases + 1))
  case $out in
    *"$2"*) fail "$1: output should not contain '$2': $out" ;;
  esac
}

# --- commands it will not run
h=$(home h-cmd)
run "$h" -- scan
expect "a scan is not run from here" 2 "only runs 'report' or 'status'"
run "$h" --
expect "no command at all" 2 "only runs 'report' or 'status'"
run "$h" -- doctor --repair
expect "doctor is not run from here" 2 "only runs 'report' or 'status'"

# --- nothing installed
run "" -- report --md
expect "no HOME" 0 "HOME is not set"
h=$(home h-empty)
run "$h" -- report --md
expect "nothing installed says so, with no path" 0 "isn't set up on this machine"

# --- engine.json (the installer's record)
h=$(home h-json)
cli=$(cli_in "$h" main.js)
engine_json "$h" "$real_node" "$cli" 600
run "$h" -- report --md
expect "engine.json 0600: runs its cli with the arguments" 0 "argv=report --md"
expect "the engine runs from /, never the session's folder" 0 "cwd=/"
expect "the engine's stderr reaches the person" 0 "stderr-line"
# A project's settings can set WASITME_HOME for its sessions; the engine's data folder stays the install's (`report`
# scans and writes its results into that folder, which must never be one the project chose).
run "$h" "WASITME_HOME=$tmp/repo/wasitme-data" -- report --md
expect "WASITME_HOME from the session's environment never reaches the engine" 0 "home=unset"
# The folders `report` scans are the install's too: a session's environment (a project's settings) must not aim the scan at
# a log folder of its own, because the results are written into ~/.wasitme and the foreign sessions would stay in the
# history. Without a recorded folder the WASITME_*_DIR overrides are dropped; with one (engine.json's claudeDir/codexDir,
# recorded by the installer) it is what the engine sees, whatever the session says. The paths here are not under $tmp: the
# output must never carry one of ours, and these are only names.
run "$h" WASITME_CLAUDE_DIR=/evil/claude WASITME_CODEX_DIR=/evil/codex -- report --md
expect "WASITME_CLAUDE_DIR and WASITME_CODEX_DIR from the session never reach the engine" 0 "claudedir=unset codexdir=unset"
h3=$(home h-json-dirs)
cli=$(cli_in "$h3" main.js)
{
  printf '{\n  "schema": 1,\n  "version": "0.1.0",\n  "node": "%s",\n  "cli": "%s",\n' "$real_node" "$cli"
  printf '  "claudeDir": "/recorded/claude",\n  "codexDir": "/recorded/codex",\n  "scanLabel": null\n}\n'
} > "$h3/.wasitme/engine.json"
chmod 600 "$h3/.wasitme/engine.json"
run "$h3" -- report --md
expect "the folders the installer recorded are the ones the engine scans" 0 "claudedir=/recorded/claude codexdir=/recorded/codex"
run "$h3" WASITME_CLAUDE_DIR=/evil/claude WASITME_CODEX_DIR=/evil/codex CLAUDE_CONFIG_DIR=/evil/cfg CODEX_HOME=/evil/home -- report --md
expect "a session cannot override them, by any of the four variables" 0 "claudedir=/recorded/claude codexdir=/recorded/codex"
run "$h3" WASITME_CLAUDE_DIR=/evil/claude WASITME_CODEX_DIR=/evil/codex -- status
expect "status gets the same folders" 0 "claudedir=/recorded/claude codexdir=/recorded/codex"
run "$h" -- report --md --agent codex
expect "the Codex skill's arguments pass through" 0 "argv=report --md --agent codex"
run "$h" -- status
expect "status runs too" 0 "argv=status"
chmod 644 "$h/.wasitme/engine.json"
run "$h" -- report --md
expect "engine.json 0644 (today's installer) is accepted" 0 "argv=report --md"
run "$h" FAKE_EXIT=3 -- report --md
expect "an engine failure is one plain line, exit 0" 0 "stopped with exit status 3"
expect "an engine failure still shows what the engine said" 0 "argv=report --md"
run "$h" FAKE_SAY=noresults -- status
expect "status with no results yet shows the engine's own line" 0 "wasitme: no results yet; run: wasitme scan"
expect_not "no results yet is a state, not a failure: no extra line" "stopped with exit status"
expect_not "no results yet: nothing about doctor" "doctor"
run "$h" FAKE_SAY=failed -- report --md
expect "a failure the engine names by kind is shown" 0 "wasitme: report failed (permission_denied)."
expect "and gets the one line saying where to look" 0 "for details, run in a terminal"
expect_not "but not the exit status line on top" "stopped with exit status"

# --- NODE_OPTIONS and friends from the session's environment never reach node (a project can set them)
printf 'require("fs").writeFileSync(%s, "pwned");\n' "\"$tmp/PWNED-require\"" > "$tmp/evil.cjs"
cases=$((cases + 1))
env -i PATH=/usr/bin:/bin NODE_OPTIONS="--require=$tmp/evil.cjs" "$real_node" -e 0 >/dev/null 2>&1
if [ -e "$tmp/PWNED-require" ]; then rm -f "$tmp/PWNED-require"; else fail "control: NODE_OPTIONS=--require should run the file in a plain node"; fi
run "$h" "NODE_OPTIONS=--require=$tmp/evil.cjs" -- report --md
expect "with NODE_OPTIONS set, the report still runs" 0 "argv=report --md"
cases=$((cases + 1))
[ -e "$tmp/PWNED-require" ] && fail "NODE_OPTIONS=--require ran a file inside run.sh's node (version probe or engine)"
h2=$(home h-nodeopts-moved)
cli=$(cli_in "$h2" main.js)
engine_json "$h2" "/nonexistent/node" "$cli" 600
run "$h2" "NODE_OPTIONS=--require=$tmp/evil.cjs" -- report --md
expect "NODE_OPTIONS with the fallback node search" 0 "argv=report --md"
cases=$((cases + 1))
[ -e "$tmp/PWNED-require" ] && fail "NODE_OPTIONS=--require ran a file during the node search (node_ok probe)"

# --- OPENSSL_CONF: node's OpenSSL reads its configuration file from the environment at startup, before any JavaScript.
# A configuration that does not parse stops node (exit 100 on Node 26.8); one naming a provider module would load native
# code. Neither may reach run.sh's node (the version probe included). The control shows this node honours the variable;
# a node that ignores it has nothing to prove here and says so.
printf '[[[\n' > "$tmp/bad.cnf"
if env -i PATH=/usr/bin:/bin OPENSSL_CONF="$tmp/bad.cnf" "$real_node" -e 0 >/dev/null 2>&1; then
  echo "run.sh: this node ignores OPENSSL_CONF; the OPENSSL_CONF cases were skipped"
else
  run "$h" "OPENSSL_CONF=$tmp/bad.cnf" -- report --md
  expect "with OPENSSL_CONF set, the report still runs" 0 "argv=report --md"
  expect_not "with OPENSSL_CONF set, node does not stop" "stopped with exit status"
  run "$h2" "OPENSSL_CONF=$tmp/bad.cnf" -- report --md
  expect "OPENSSL_CONF with the fallback node search (node_ok probe)" 0 "argv=report --md"
fi

h=$(home h-json-gw)
cli=$(cli_in "$h" main.js)
engine_json "$h" "$real_node" "$cli" 664
run "$h" -- report --md
expect "a group-writable engine.json is ignored" 0 "isn't set up on this machine"
expect_not "a group-writable engine.json is ignored (no run)" "argv="

h=$(home h-json-link)
cli=$(cli_in "$h" main.js)
engine_json "$h" "$real_node" "$cli" 600
mv "$h/.wasitme/engine.json" "$h/.wasitme/engine.real.json"
ln -s engine.real.json "$h/.wasitme/engine.json"
run "$h" -- report --md
expect "a symlinked engine.json is ignored" 0 "isn't set up on this machine"

h=$(home h-cli-gw)
cli=$(cli_in "$h" main.js 664)
engine_json "$h" "$real_node" "$cli" 600
run "$h" -- report --md
expect "a group-writable cli is never run" 0 "isn't where it was"
expect_not "a group-writable cli is never run (no run)" "argv="

h=$(home h-cli-link)
cli=$(cli_in "$h" real.js)
ln -s real.js "$(dirname "$cli")/main.js"
engine_json "$h" "$real_node" "$(dirname "$cli")/main.js" 600
run "$h" -- report --md
expect "a symlinked cli is never run" 0 "isn't where it was"

h=$(home h-cli-rel)
cli_in "$h" main.js >/dev/null
engine_json "$h" "$real_node" "main.js" 600
run "$h" -- report --md
expect "a relative cli is never run" 0 "isn't where it was"

h=$(home h-cli-dotdot)
cli=$(cli_in "$h" main.js)
engine_json "$h" "$real_node" "$h/.wasitme/versions/../versions/0.1.0/engine/dist/src/cli/main.js" 600
run "$h" -- report --md
expect "a cli path with .. is never run" 0 "isn't where it was"

h=$(home h-node-moved)
cli=$(cli_in "$h" main.js)
engine_json "$h" "/nonexistent/node" "$cli" 600
run "$h" -- report --md
expect "a node that moved falls back to a known one" 0 "argv=report --md"

h=$(home h-node-rel)
cli=$(cli_in "$h" main.js)
engine_json "$h" "node" "$cli" 600
run "$h" -- report --md
expect "a relative node in engine.json is never run from the session's folder" 0 "argv=report --md"

# --- the installed engine behind `current` (D32), no engine.json
h=$(home h-current)
mkdir -p "$h/.wasitme/versions/0.1.0/engine/dist/src/cli"
cp "$tmp/fake.mjs" "$h/.wasitme/versions/0.1.0/engine/dist/src/cli/main.js"
chmod -R a-w "$h/.wasitme/versions/0.1.0"
ln -s versions/0.1.0 "$h/.wasitme/current"
run "$h" -- report --md
expect "current/engine runs with a known node" 0 "argv=report --md"
expect_not "current/engine is the installed engine, not the read-only bundle" "--read-only"

# --- the bundled engine (plugin only, no install): run read-only
mkdir -p "$tmp/plugcopy/scripts"
cp "$runsh" "$tmp/plugcopy/scripts/run.sh"
cp "$tmp/fake.mjs" "$tmp/plugcopy/scripts/wasitme.mjs"
h=$(home h-bundled)
cases=$((cases + 1))
out=$(cd "$tmp/repo" && env -i PATH=".:$tmp/nodebin:/usr/bin:/bin" HOME="$h" /bin/sh "$tmp/plugcopy/scripts/run.sh" report --md 2>&1)
rc=$?
expect "the bundled engine runs read-only" 0 "argv=report --md --read-only"
out=$(cd "$tmp/repo" && env -i PATH=".:$tmp/nodebin:/usr/bin:/bin" HOME="$h" /bin/sh "$tmp/plugcopy/scripts/run.sh" status 2>&1)
rc=$?
expect "status on the bundled engine runs without --read-only (status rejects unknown options)" 0 "argv=status"
expect_not "status on the bundled engine: no --read-only" "--read-only"
chmod 664 "$tmp/plugcopy/scripts/wasitme.mjs"
out=$(cd "$tmp/repo" && env -i PATH=".:$tmp/nodebin:/usr/bin:/bin" HOME="$h" /bin/sh "$tmp/plugcopy/scripts/run.sh" report --md 2>&1)
rc=$?
expect "a group-writable bundle is never run" 0 "isn't set up on this machine"

# --- the PATH search never takes a node from inside the session's folder, absolute entry or not. (A copy of run.sh whose
# two well-known node locations are made not to exist, so the PATH search runs on any machine.)
mkdir -p "$tmp/pathcopy/scripts" "$tmp/repo/bin" "$tmp/elsewhere-bin"
sed 's|for fn_candidate in /opt/homebrew/bin/node /usr/local/bin/node; do|for fn_candidate in /nonexistent/a/node /nonexistent/b/node; do|' "$runsh" >"$tmp/pathcopy/scripts/run.sh"
cases=$((cases + 1))
grep -q '/nonexistent/a/node' "$tmp/pathcopy/scripts/run.sh" || fail "the PATH-search copy did not take (run.sh's known-node line changed)"
printf '#!/bin/sh\ntouch "%s/EVIL-abs-node"\necho evil\n' "$tmp" >"$tmp/repo/bin/node"
printf '#!/bin/sh\ntouch "%s/USED-elsewhere-node"\nexec "%s" "$@"\n' "$tmp" "$real_node" >"$tmp/elsewhere-bin/node"
chmod +x "$tmp/repo/bin/node" "$tmp/elsewhere-bin/node"
h=$(home h-pathsearch)
cli=$(cli_in "$h" main.js)
engine_json "$h" "/nonexistent/node" "$cli" 600
cases=$((cases + 1))
out=$(cd "$tmp/repo" && env -i PATH="$tmp/repo/bin:$tmp/elsewhere-bin:/usr/bin:/bin" HOME="$h" /bin/sh "$tmp/pathcopy/scripts/run.sh" report --md 2>&1)
rc=$?
expect "an absolute PATH entry inside the session's folder is skipped; the next one is used" 0 "argv=report --md"
[ -e "$tmp/USED-elsewhere-node" ] || fail "control: the node outside the session's folder should have been found on PATH"
out=$(cd "$tmp/repo" && env -i PATH="$tmp/repo/bin:/usr/bin:/bin" HOME="$h" /bin/sh "$tmp/pathcopy/scripts/run.sh" report --md 2>&1)
rc=$?
expect "with only the session folder's node on PATH, nothing runs" 0 "isn't where it was"
ln -s "$tmp/repo/bin" "$tmp/repo-bin-link"
out=$(cd "$tmp/repo" && env -i PATH="$tmp/repo-bin-link:/usr/bin:/bin" HOME="$h" /bin/sh "$tmp/pathcopy/scripts/run.sh" report --md 2>&1)
rc=$?
expect "nor through a link that resolves into the session's folder" 0 "isn't where it was"
cases=$((cases + 1))
[ -e "$tmp/EVIL-abs-node" ] && fail "a node inside the session's folder was run from an absolute PATH entry"

# --- a session started in HOME (or above it) has no project of its own to protect against, so a per-user node (nvm, fnm,
# volta, asdf all live under HOME) is accepted there; from a project folder inside HOME the guard still applies.
hh=$(home h-homesession)
mkdir -p "$hh/.nvm/bin"
printf '#!/bin/sh\ntouch "%s/USED-home-node"\nexec "%s" "$@"\n' "$tmp" "$real_node" >"$hh/.nvm/bin/node"
chmod +x "$hh/.nvm/bin/node"
cli=$(cli_in "$hh" main.js)
engine_json "$hh" "/nonexistent/node" "$cli" 600
cases=$((cases + 1))
out=$(cd "$hh" && env -i PATH="$hh/.nvm/bin:/usr/bin:/bin" HOME="$hh" /bin/sh "$tmp/pathcopy/scripts/run.sh" report --md 2>&1)
rc=$?
expect "a session started in HOME may use a node under HOME" 0 "argv=report --md"
out=$(cd "$tmp" && env -i PATH="$hh/.nvm/bin:/usr/bin:/bin" HOME="$hh" /bin/sh "$tmp/pathcopy/scripts/run.sh" report --md 2>&1)
rc=$?
expect "and so may a session started in a folder above HOME" 0 "argv=report --md"
mkdir -p "$hh/proj"
rm -f "$tmp/USED-home-node"
out=$(cd "$hh/proj" && env -i PATH="$hh/proj/bin:/usr/bin:/bin" HOME="$hh" /bin/sh "$tmp/pathcopy/scripts/run.sh" report --md 2>&1)
rc=$?
expect "a node inside the project folder is still refused (the session in a folder under HOME)" 0 "isn't where it was"
cases=$((cases + 1))
[ -e "$tmp/USED-home-node" ] && fail "control: no node under the project folder was on PATH, so the home node must not have run"

# --- the hint for a terminal names the command, never a fixed path (the installer's --prefix puts it elsewhere)
h=$(home h-hint)
cli=$(cli_in "$h" main.js)
engine_json "$h" "$real_node" "/nonexistent/cli.js" 600
run "$h" -- report --md
expect "a missing engine says what to run in a terminal" 0 "wasitme doctor --repair"
expect_not "without pointing at one fixed install location as the command" "Run ~/.local/bin/wasitme"
engine_json "$h" "$real_node" "$cli" 600
run "$h" FAKE_SAY=failed -- report --md
expect "a failed report says what to run in a terminal" 0 "run in a terminal: wasitme doctor"
expect_not "and does not start the command with a fixed path" "terminal: ~/.local/bin/wasitme"

# --- nothing hostile ever ran
cases=$((cases + 1))
for evil in node wasitme; do
  [ -e "$tmp/EVIL-$evil" ] && fail "the session folder's $evil was run"
done

if [ "$fails" -gt 0 ]; then
  echo "run.sh: $fails of $cases checks FAILED"
  exit 1
fi
echo "run.sh: all $cases checks passed"
