#!/bin/sh
# Tests for the plugin's hook scripts (plugin/scripts/session-{start,end}.sh). POSIX sh, no dependencies but node.
#
#   sh plugin/tests/hooks.sh
#
# Every case runs with a throwaway HOME, so the real ~/.wasitme is never read. Cases that would reach launchctl use
# WASITME_HOOK_DRY_RUN=1 (print, don't run), except one that kicks a label that cannot exist, to prove the real path
# stays silent. One case runs a real `node --permission` against a stand-in engine to prove the grants the hook passes
# let it read the project and write ~/.wasitme, and nothing else. On a non-macOS host every case must be a silent
# no-op (exit 0, no output), which CI checks on Linux.
set -u
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(dirname "$here")
start="$plugin/scripts/session-start.sh"
end="$plugin/scripts/session-end.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-hooks.XXXXXX")
tmp=$(cd -P "$tmp" && pwd -P)   # canonical spelling (/private/var/...), like a real home folder
trap 'chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT INT TERM
fails=0
cases=0
darwin=0
[ "$(uname -s)" = Darwin ] && darwin=1
uid=$(id -u)
NODE=$(command -v node || true)

fail() { echo "FAIL: $1"; fails=$((fails + 1)); }

# run NAME SCRIPT HOME [env...]: prints the script's combined output; fails the case on a non-zero exit. stdin is
# $PAYLOAD when set (the hook's JSON), else /dev/null.
PAYLOAD=""
run() {
  name=$1 script=$2 h=$3
  shift 3
  if [ -n "$PAYLOAD" ]; then
    out=$(printf '%s' "$PAYLOAD" | env -i PATH="$tmp/evil-bin:.:/usr/bin:/bin" HOME="$h" "$@" /bin/sh "$script" 2>&1)
  else
    out=$(env -i PATH="$tmp/evil-bin:.:/usr/bin:/bin" HOME="$h" "$@" /bin/sh "$script" 2>&1 </dev/null)
  fi
  rc=$?
  [ "$rc" = 0 ] || fail "$name: exit $rc"
  printf '%s' "$out"
}

# expect_silent NAME SCRIPT HOME [env...]
expect_silent() {
  cases=$((cases + 1))
  got=$(run "$@")
  [ -z "$got" ] || fail "$1: expected no output, got: $got"
}

# expect_out NAME SCRIPT HOME WANT: on macOS the dry run prints exactly WANT; elsewhere it is silent.
expect_out() {
  cases=$((cases + 1))
  name=$1 script=$2 h=$3 want=$4
  got=$(run "$name" "$script" "$h" WASITME_HOOK_DRY_RUN=1)
  if [ "$darwin" = 1 ]; then
    [ "$got" = "$want" ] || fail "$name: expected '$want', got '$got'"
  else
    [ -z "$got" ] || fail "$name: expected a silent no-op off macOS, got: $got"
  fi
}
expect_kick() { expect_out "$1" "$2" "$3" "/bin/launchctl kickstart gui/$uid/$4"; }

# home NAME LABEL [MODE] [NODE] [PERMISSION]: a fresh HOME whose engine.env carries this scan label (empty = no scan
# agent), a node and cli that exist, and the permission flag the installer recorded.
home() {
  h="$tmp/$1"
  mkdir -p "$h/.wasitme/current/engine/dist/src/cli" "$h/projects/app"
  printf 'console.log("stand-in")\n' >"$h/.wasitme/current/engine/dist/src/cli/main.js"
  {
    printf '# wasitme engine.env, managed by the wasitme installer. Read with sed by the plugin hooks; never sourced.\n'
    printf 'version=0.1.0\n'
    printf 'node=%s\n' "${4:-/bin/sh}"
    printf 'cli=%s\n' "$h/.wasitme/current/engine/dist/src/cli/main.js"
    printf 'permission=%s\n' "${5---permission}"
    printf 'home=%s\n' "$h/.wasitme"
    printf 'home_real=%s\n' "$h/.wasitme"
    printf 'scan_label=%s\n' "$2"
  } >"$h/.wasitme/engine.env"
  chmod "${3:-600}" "$h/.wasitme/engine.env"
  printf '%s' "$h"
}

# A PATH-resolved `wasitme` (and `uname`, `launchctl`, ...) planted where a hostile repo would put one: never run.
mkdir -p "$tmp/evil-bin"
for tool in wasitme uname launchctl sed stat id head node tr; do
  printf '#!/bin/sh\ntouch "%s/ran-%s"\necho hijacked\n' "$tmp" "$tool" >"$tmp/evil-bin/$tool"
  chmod +x "$tmp/evil-bin/$tool"
done

# ---- kickstart guards (no payload: only the kick runs) -----------------------------------------------------------
expect_silent "no ~/.wasitme" "$start" "$tmp/empty-home"
expect_silent "relative HOME" "$start" "relative/home"
h=$(home good dev.wasitme.scan)
expect_kick "the installed label" "$start" "$h" dev.wasitme.scan
expect_kick "SessionEnd kicks the same way" "$end" "$h" dev.wasitme.scan
h=$(home suffixed dev.wasitme.scan.t123-ab_c)
expect_kick "a test-suffixed label" "$start" "$h" dev.wasitme.scan.t123-ab_c
h=$(home null '')
expect_silent "no scan agent installed (empty label)" "$start" "$h" WASITME_HOOK_DRY_RUN=1
h=$(home other com.apple.Finder)
expect_silent "a label outside dev.wasitme.scan" "$start" "$h" WASITME_HOOK_DRY_RUN=1
h=$(home prefix dev.wasitme.scanner)
expect_silent "a label that only starts like ours" "$start" "$h" WASITME_HOOK_DRY_RUN=1
h=$(home bare dev.wasitme.scan.)
expect_silent "an empty suffix" "$start" "$h" WASITME_HOOK_DRY_RUN=1
h=$(home dots dev.wasitme.scan..x)
expect_silent "a dotted-dot suffix" "$start" "$h" WASITME_HOOK_DRY_RUN=1
h=$(home inject 'dev.wasitme.scan$(touch INJECTED)')
expect_silent "shell syntax in the label" "$start" "$h" WASITME_HOOK_DRY_RUN=1
h=$(home world dev.wasitme.scan 644)
expect_silent "engine.env readable by others (must be 0600)" "$start" "$h" WASITME_HOOK_DRY_RUN=1
h=$(home groupw dev.wasitme.scan 660)
expect_silent "engine.env writable by the group" "$start" "$h" WASITME_HOOK_DRY_RUN=1

h="$tmp/linked"
mkdir -p "$h/.wasitme"
ln -s "$tmp/good/.wasitme/engine.env" "$h/.wasitme/engine.env"
expect_silent "engine.env is a symlink" "$start" "$h" WASITME_HOOK_DRY_RUN=1

h="$tmp/dir"
mkdir -p "$h/.wasitme/engine.env"
expect_silent "engine.env is a directory" "$start" "$h" WASITME_HOOK_DRY_RUN=1

# The real path (no dry run) with a label that cannot exist: launchctl fails, the hook still says nothing.
h=$(home real "dev.wasitme.scan.hooktest-$$-nonexistent")
expect_silent "a real kickstart of a missing service is silent" "$start" "$h"

# ---- the sandboxed project snapshot (D60) --------------------------------------------------------------------------
h=$(home snap dev.wasitme.scan)
W="$h/.wasitme"
CLI="$W/current/engine/dist/src/cli/main.js"
GRANTS="--allow-fs-read=$W --allow-fs-read=$h/projects/app --allow-fs-write=$W"
PAYLOAD="{\"session_id\":\"abc-123\",\"transcript_path\":\"$h/.claude/x.jsonl\",\"cwd\":\"$h/projects/app\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}"
expect_out "SessionStart: snapshot under --permission with one grant per path, then the kick" "$start" "$h" \
  "/bin/sh --permission $GRANTS $CLI hook session-start --cwd $h/projects/app --session abc-123
/bin/launchctl kickstart gui/$uid/dev.wasitme.scan"
expect_kick "SessionEnd never takes a snapshot (about 1.5 s budget)" "$end" "$h" dev.wasitme.scan
PAYLOAD="{\"cwd\":\"$h/projects/app\",\"hook_event_name\":\"SessionStart\"}"
expect_out "no session id: --session is left out" "$start" "$h" \
  "/bin/sh --permission $GRANTS $CLI hook session-start --cwd $h/projects/app
/bin/launchctl kickstart gui/$uid/dev.wasitme.scan"
PAYLOAD="{
  \"session_id\": \"s1\",
  \"cwd\": \"$h/projects/app\"
}"
expect_out "a pretty-printed payload works too" "$start" "$h" \
  "/bin/sh --permission $GRANTS $CLI hook session-start --cwd $h/projects/app --session s1
/bin/launchctl kickstart gui/$uid/dev.wasitme.scan"
ln -s "$h/projects/app" "$h/linkapp"
PAYLOAD="{\"cwd\":\"$h/linkapp\",\"session_id\":\"s2\"}"
expect_out "a symlinked project folder: both spellings are granted" "$start" "$h" \
  "/bin/sh --permission --allow-fs-read=$W --allow-fs-read=$h/linkapp --allow-fs-read=$h/projects/app --allow-fs-write=$W $CLI hook session-start --cwd $h/linkapp --session s2
/bin/launchctl kickstart gui/$uid/dev.wasitme.scan"

KICK="/bin/launchctl kickstart gui/$uid/dev.wasitme.scan"
for bad in "/etc" "$h" "$tmp" "$h/projects/../../x" "$h/projects/*" "relative/path" "$h/projects/a\\\"b" "$h/missing-folder"; do
  PAYLOAD="{\"cwd\":\"$bad\",\"session_id\":\"s\"}"
  expect_out "cwd '$bad' is refused: no snapshot, still the kick" "$start" "$h" "$KICK"
done
ln -s / "$h/rootlink"
PAYLOAD="{\"cwd\":\"$h/rootlink\"}"
expect_out "a project folder that resolves outside the home is never granted" "$start" "$h" "$KICK"
PAYLOAD="{\"cwd\":\"$h/projects/app\",\"session_id\":\"\$(touch INJECTED)\"}"
expect_out "a hostile session id is dropped" "$start" "$h" \
  "/bin/sh --permission $GRANTS $CLI hook session-start --cwd $h/projects/app
$KICK"
PAYLOAD="{\"note\":\"\\\"cwd\\\":\\\"/etc\\\"\",\"x\":1}"
expect_out "a cwd smuggled inside another value is not taken" "$start" "$h" "$KICK"

h=$(home nosandbox dev.wasitme.scan 600 /bin/sh '')
PAYLOAD="{\"cwd\":\"$h/projects/app\"}"
expect_out "no permission flag recorded: no snapshot (fail closed), still the kick" "$start" "$h" "$KICK"
h=$(home oddflag dev.wasitme.scan 600 /bin/sh '--allow-everything')
expect_out "an unknown permission flag: no snapshot" "$start" "$h" "$KICK"
h=$(home nonode dev.wasitme.scan 600 /nonexistent/node)
expect_out "node is gone: no snapshot" "$start" "$h" "$KICK"
PAYLOAD=""

# ---- a real node --permission run with the hook's own grants ---------------------------------------------------------
if [ "$darwin" = 1 ] && [ -n "$NODE" ]; then
  flag=""
  if "$NODE" --permission -e 0 >/dev/null 2>&1; then flag=--permission; elif "$NODE" --experimental-permission -e 0 >/dev/null 2>&1; then flag=--experimental-permission; fi
  if [ -n "$flag" ]; then
    h=$(home realnode '' 600 "$NODE" "$flag")
    mkdir -p "$h/secret"
    printf 'project instructions\n' >"$h/projects/app/CLAUDE.md"
    printf 'not for the hook\n' >"$h/secret/key.txt"
    # A stand-in engine: does exactly what the real one may (read the project, write ~/.wasitme) and then tries what the
    # sandbox must refuse; it records the outcome of each.
    cat >"$h/.wasitme/current/engine/dist/src/cli/main.js" <<'EOF'
const fs = require("fs");
const a = process.argv.slice(2);
const cwd = a[a.indexOf("--cwd") + 1];
const home = process.env.HOME;
const r = [];
const t = (name, f) => { try { f(); r.push(name + "=ok"); } catch (e) { r.push(name + "=" + (e.code || "error")); } };
t("readProject", () => fs.readFileSync(cwd + "/CLAUDE.md"));
t("readOutside", () => fs.readFileSync(home + "/secret/key.txt"));
t("writeOutside", () => fs.writeFileSync(home + "/projects/app/x.txt", "x"));
t("spawn", () => require("child_process").execFileSync("/bin/echo", ["x"]));
fs.mkdirSync(home + "/.wasitme/state", { recursive: true });
fs.writeFileSync(home + "/.wasitme/state/hook-result", a.join(" ") + "\n" + r.join(" ") + "\n");
EOF
    PAYLOAD="{\"cwd\":\"$h/projects/app\",\"session_id\":\"real-1\"}"
    cases=$((cases + 1))
    got=$(run "real node" "$start" "$h")
    [ -z "$got" ] || fail "real node: expected no output, got: $got"
    res=$(cat "$h/.wasitme/state/hook-result" 2>/dev/null || echo "no result file: the engine did not run or could not write ~/.wasitme")
    case $res in
      *"hook session-start --cwd $h/projects/app --session real-1"*) ;;
      *) fail "real node: the engine got the wrong arguments: $res" ;;
    esac
    case $res in
      *"readProject=ok readOutside=ERR_ACCESS_DENIED writeOutside=ERR_ACCESS_DENIED spawn=ERR_ACCESS_DENIED"*) ;;
      *) fail "real node: the sandbox should allow the project read and ~/.wasitme write only; got: $res" ;;
    esac
    [ -e "$h/projects/app/x.txt" ] && fail "real node: the stand-in wrote into the project"
    # A project can set environment variables for its sessions. NODE_OPTIONS must not run the project's code inside the
    # hook's node, nor widen its sandbox (an --allow-fs-* grant in NODE_OPTIONS is honoured by node itself).
    printf 'require("fs").writeFileSync(process.env.HOME + "/.wasitme/pwned.txt", "pwned");\n' >"$h/projects/app/evil.cjs"
    rm -f "$h/.wasitme/state/hook-result"
    PAYLOAD="{\"cwd\":\"$h/projects/app\",\"session_id\":\"real-2\"}"
    cases=$((cases + 1))
    got=$(run "NODE_OPTIONS" "$start" "$h" "NODE_OPTIONS=--require=$h/projects/app/evil.cjs --allow-fs-write=*")
    [ -z "$got" ] || fail "NODE_OPTIONS: expected no output, got: $got"
    [ -e "$h/.wasitme/pwned.txt" ] && fail "NODE_OPTIONS=--require ran the project's file inside the hook's node"
    case $(cat "$h/.wasitme/state/hook-result" 2>/dev/null) in
      *"readOutside=ERR_ACCESS_DENIED writeOutside=ERR_ACCESS_DENIED"*) ;;
      *) fail "NODE_OPTIONS: the snapshot must still run, with the sandbox as narrow as before; got: $(cat "$h/.wasitme/state/hook-result" 2>/dev/null)" ;;
    esac
    [ -e "$h/projects/app/x.txt" ] && fail "NODE_OPTIONS=--allow-fs-write widened the sandbox: the stand-in wrote into the project"
    # OPENSSL_CONF: node's OpenSSL reads its configuration file from the environment at startup, before any JavaScript
    # and outside the permission sandbox. A configuration naming a provider module makes node load it as native code (here
    # the module does not exist, so node stops instead: an abort on Node 26.8). The control shows this node honours the
    # variable; a node that ignores it has nothing to prove here and says so.
    printf 'nodejs_conf = nodejs_init\n[nodejs_init]\nproviders = provider_sect\n[provider_sect]\nevil = evil_sect\n[evil_sect]\nmodule = %s/projects/app/evil.dylib\nactivate = 1\n' "$h" >"$h/projects/app/evil.cnf"
    # (In a subshell that outlives node: the abort would otherwise be reported by this shell as a stray "Abort trap" line.)
    if (env -i PATH=/usr/bin:/bin OPENSSL_CONF="$h/projects/app/evil.cnf" "$NODE" -e 0; exit $?) >/dev/null 2>&1; then
      echo "hooks: this node ignores OPENSSL_CONF; the OPENSSL_CONF case was skipped"
    else
      rm -f "$h/.wasitme/state/hook-result"
      PAYLOAD="{\"cwd\":\"$h/projects/app\",\"session_id\":\"real-3\"}"
      cases=$((cases + 1))
      got=$(run "OPENSSL_CONF" "$start" "$h" "OPENSSL_CONF=$h/projects/app/evil.cnf")
      [ -z "$got" ] || fail "OPENSSL_CONF: expected no output, got: $got"
      case $(cat "$h/.wasitme/state/hook-result" 2>/dev/null) in
        *"--session real-3"*"readProject=ok readOutside=ERR_ACCESS_DENIED"*) ;;
        *) fail "OPENSSL_CONF: the snapshot must still run, sandboxed; got: $(cat "$h/.wasitme/state/hook-result" 2>/dev/null)" ;;
      esac
    fi
    # The recorded flag went stale (recorded on an old Node 22, then Node was upgraded): node exits 9, the hook retries
    # once with the other spelling.
    if [ "$flag" = --permission ] && ! "$NODE" --experimental-permission -e 0 >/dev/null 2>&1; then
      h2=$(home stale '' 600 "$NODE" --experimental-permission)
      printf 'project instructions\n' >"$h2/projects/app/CLAUDE.md"
      cp "$h/.wasitme/current/engine/dist/src/cli/main.js" "$h2/.wasitme/current/engine/dist/src/cli/main.js"
      PAYLOAD="{\"cwd\":\"$h2/projects/app\",\"session_id\":\"stale-1\"}"
      cases=$((cases + 1))
      got=$(run "stale flag" "$start" "$h2")
      [ -z "$got" ] || fail "stale flag: expected no output, got: $got"
      case $(cat "$h2/.wasitme/state/hook-result" 2>/dev/null) in
        *"readProject=ok readOutside=ERR_ACCESS_DENIED"*) ;;
        *) fail "stale flag: the retry with --permission did not run the snapshot sandboxed" ;;
      esac
    fi
    PAYLOAD=""
  else
    echo "hooks: this node has no permission flag; the real-node case was skipped"
  fi
fi

for f in "$tmp"/ran-* "$tmp"/INJECTED "$plugin"/INJECTED "$plugin"/scripts/INJECTED; do
  [ -e "$f" ] && fail "a hostile tool or injected command ran: $f"
done

# The hook command lines run only these two scripts, by absolute path, and never `wasitme` itself.
cases=$((cases + 1))
hooks="$plugin/hooks/hooks.json"
grep -q '"/bin/sh \\"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh\\""' "$hooks" || fail "hooks.json: SessionStart command line changed"
grep -q '"/bin/sh \\"${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh\\""' "$hooks" || fail "hooks.json: SessionEnd command line changed"
grep -q 'wasitme scan\|PATH' "$hooks" && fail "hooks.json: a hook resolves wasitme on PATH"

if [ "$fails" -gt 0 ]; then
  echo "hooks: $fails failure(s) in $cases cases"
  exit 1
fi
echo "hooks ok: $cases cases ($([ "$darwin" = 1 ] && echo macOS || echo 'non-macOS: all silent no-ops'))"
