#!/bin/sh
# The parts around the install itself: the node permission-flag feature test (D49/D60), `wasitme doctor --repair`
# hook-up, install.sh --repair, going back to an older version, and the Linux CLI-only path (the README platform table).
# T_RC and INST_PATH_EXTRA are set in this file and read by assert_rc and inst in harness.sh. The linter looks at one file at a time
# and would call them unused (SC2034); this single directive, before the first command, covers the file.
# shellcheck disable=SC2034
. "$(dirname "$0")/harness.sh"

NODE=$(command -v node)
PLUGINS="--yes --no-app --no-scan-agent --no-statusline --agents claude-code,codex"

# fake_node DIR MODE: a `node` that forwards to the real one. old = like Node 22.12: rejects --permission (exit 9) and
# knows only --experimental-permission (passed on as --permission: Node 26 itself rejects the old name); none = neither.
fake_node() {
  mkdir -p "$1"
  case $2 in
    old) printf '#!/bin/sh\nfor a do\n  shift\n  case $a in\n    --permission) echo "node: bad option: --permission" >&2; exit 9 ;;\n    --experimental-permission) set -- "$@" --permission ;;\n    *) set -- "$@" "$a" ;;\n  esac\ndone\nexec "%s" "$@"\n' "$NODE" >"$1/node" ;;
    none) printf '#!/bin/sh\nfor a in "$@"; do case $a in --permission|--experimental-permission) echo "node: bad option: $a" >&2; exit 9 ;; esac; done\nexec "%s" "$@"\n' "$NODE" >"$1/node" ;;
  esac
  chmod +x "$1/node"
}

t_section "the permission flag is feature-tested, not inferred from the version (D49)"
sb_new
make_fixture "$SB_SRC" 0.1.0 macos-fake
H=$SB_HOME
# The scan agent is a LaunchAgent, so macOS only; elsewhere the installer refuses it, and the flag test runs without it.
SCAN_PART=--no-scan-agent
[ "$T_OS" = Darwin ] && SCAN_PART=--scan-agent
fake_node "$SB/n22" old
INST_PATH_EXTRA="$SB/n22"
inst_from --yes --no-app --no-claude-plugin --no-codex-plugin --no-statusline $SCAN_PART
assert_rc 0 "install with a node that only knows --experimental-permission (like Node 22.12)"
assert_eq "--experimental-permission" "$(json_get "$H/.wasitme/engine.json" 'd.permission')" "engine.json records the flag that worked"
assert_line "$H/.wasitme/engine.env" "permission=--experimental-permission" "and engine.env, for the hook"
if [ "$T_OS" = Darwin ]; then
  assert_eq "--experimental-permission" "$(plist_get "$H/Library/LaunchAgents/$LABEL_SCAN.plist" ProgramArguments.1)" "the scan agent uses it"
fi
fake_node "$SB/nnone" none
INST_PATH_EXTRA="$SB/nnone"
inst_from --yes --no-app --no-claude-plugin --no-codex-plugin --no-statusline $SCAN_PART
assert_rc 0 "a node with no permission flag at all still installs"
assert_eq "null" "$(json_get "$H/.wasitme/engine.json" 'd.permission')" "engine.json: permission null"
assert_eq "[]" "$(json_get "$H/.wasitme/engine.json" 'd.scanArgs')" "no sandbox arguments"
assert_contains "$(out)" "sandbox              off" "the result says the sandbox is off, plainly"
assert_line "$H/.wasitme/engine.env" "permission=" "engine.env: empty, so the hook takes no snapshot (fails closed)"
if [ "$T_OS" = Darwin ]; then
  assert_eq "$H/.wasitme" "$(plist_get "$H/Library/LaunchAgents/$LABEL_SCAN.plist" ProgramArguments.1 | sed 's|/current/.*||; s|^/private||')" "the scan agent runs the engine without flags"
  PAYLOAD=$(printf '{"cwd":"%s/proj"}' "$H")
  mkdir -p "$H/proj"
  OUTH=$(printf '%s' "$PAYLOAD" | env -i PATH=/usr/bin:/bin HOME="$H" WASITME_HOOK_DRY_RUN=1 /bin/sh "$T_REPO/plugin/scripts/session-start.sh" 2>&1)
  assert_eq "/bin/launchctl kickstart gui/$T_UID/$LABEL_SCAN" "$OUTH" "the hook only kicks the scan: no unsandboxed snapshot"
fi
INST_PATH_EXTRA=""

t_section "wasitme doctor --repair runs after the install, guarded"
sb_new
make_fixture "$SB_SRC" 0.1.0 doctor
inst_from $CORE_ONLY
assert_rc 0 "install"
assert_eq "engine doctor --repair WASITME_INSTALLER_ACTIVE=1" "$(cat "$SHIM_ENGINE_LOG")" "the installed engine's doctor --repair ran once, told it was started by the installer"
assert_contains "$(out)" "doctor               ok" "and the result says so"
export SHIM_DOCTOR_FAIL=1
inst_from $CORE_ONLY
unset SHIM_DOCTOR_FAIL
assert_rc 0 "a doctor that finds problems does not fail the install"
assert_contains "$(out)" "doctor               attention  wasitme doctor --repair exited 1" "but the result says to look"
assert_contains "$(out)" "doctor: 1 problem" "with doctor's own output shown"
export SHIM_DOCTOR_PROBLEMS=1
inst_from $CORE_ONLY
unset SHIM_DOCTOR_PROBLEMS
assert_rc 0 "a doctor report that lists problems (exit 1, as the engine's doctor does) does not fail the install"
assert_contains "$(out)" "doctor               attention  wasitme doctor --repair found problems it cannot fix" "and the result names them as problems, not as a failed run"
assert_contains "$(out)" "No results yet. Run: wasitme scan" "with doctor's own problems shown"
: >"$SHIM_ENGINE_LOG"
WASITME_INSTALLER_ACTIVE=1 inst_from $CORE_ONLY
assert_rc 0 "an install started by doctor itself"
assert_eq "" "$(cat "$SHIM_ENGINE_LOG")" "never calls doctor back (no loop)"

t_section "install.sh --repair"
sb_new
make_fixture "$SB_SRC" 0.1.0 doctor
H=$SB_HOME
T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
PATH="$SB/shims:$BASE_PATH" "$SH_BIN" "$SB_SRC/scripts/install.sh" --repair --home "$H" >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 1 "--repair with nothing installed"
assert_contains "$(err)" "needs an existing install" "says so"
assert_eq "." "$(tree_of "$H")" "and changes nothing"
inst --repair --from "$SB_SRC"
assert_rc 2 "--repair does not take a source"
inst_from $PLUGINS
assert_rc 0 "install with both plugins"
: >"$SHIM_LOG"
: >"$SHIM_ENGINE_LOG"
PATH="$SB/shims:$BASE_PATH" "$SH_BIN" "$H/.wasitme/current/scripts/install.sh" --repair --home "$H" >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 0 "--repair from the installed copy"
assert_eq "" "$(shimlog)" "nothing changed, so neither CLI is touched"
assert_eq "" "$(cat "$SHIM_ENGINE_LOG")" "and doctor is not called back"
export WASITME_CLAUDE="$SB/nonexistent/claude"
PATH="$SB/shims:$BASE_PATH" "$SH_BIN" "$H/.wasitme/current/scripts/install.sh" --repair --home "$H" >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
unset WASITME_CLAUDE
assert_rc 0 "--repair after Claude Code was removed: a clear skip, not an error"
assert_contains "$(out)" "the 'claude' command was not found" "with the reason"

t_section "going back to a version whose folder still exists records it in Claude Code too"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $PLUGINS
make_fixture "$SB_SRC" 0.2.0
inst_from $PLUGINS
assert_rc 0 "update to 0.2.0"
make_fixture "$SB_SRC" 0.1.0
: >"$SHIM_LOG"
inst_from $PLUGINS
assert_rc 0 "install 0.1.0 again (its folder is still there)"
assert_link "$H/.wasitme/current" "versions/0.1.0" "current flipped back"
assert_contains "$(shimlog)" "claude plugin update wasitme@wasitme" "claude plugin update ran (the folder was unchanged, but current moved)"
assert_contains "$(shimlog)" "codex plugin marketplace add $H/.wasitme/current/plugin-codex" "and Codex was re-registered"
assert_contains "$(out)" "already in place, updated from 0.2.0" "the result says what happened"

t_section "a 'wasitme' marketplace added some other way is re-pointed in place, keeping the person's options (S-GIT 4.3)"
sb_new
make_fixture "$SB_SRC" 0.2.0
H=$SB_HOME
export SHIM_STATEFUL=1
# As if the person had run `/plugin marketplace add draarivpatel-ui/wasitme` + install earlier and set showBand off.
mkdir -p "$SB/gh-clone/.claude-plugin" "$SB/gh-clone/plugin/.claude-plugin" "$H/.claude/plugins"
printf '{ "name": "wasitme", "plugins": [ { "name": "wasitme", "source": "./plugin" } ] }\n' >"$SB/gh-clone/.claude-plugin/marketplace.json"
printf '{ "name": "wasitme", "version": "0.1.0" }\n' >"$SB/gh-clone/plugin/.claude-plugin/plugin.json"
env CLAUDE_CONFIG_DIR="$H/.claude" HOME="$H" node "$T_DIR/fake-agents.mjs" claude plugin marketplace add "$SB/gh-clone" >/dev/null
env CLAUDE_CONFIG_DIR="$H/.claude" HOME="$H" node "$T_DIR/fake-agents.mjs" claude plugin install wasitme@wasitme >/dev/null
printf '{"showBand":"false"}' | env CLAUDE_CONFIG_DIR="$H/.claude" HOME="$H" node "$T_DIR/fake-agents.mjs" claude plugin configure wasitme@wasitme --values-stdin >/dev/null
: >"$SHIM_LOG"
inst_from --yes --no-app --no-scan-agent --no-statusline --no-codex-plugin --agents claude-code
unset SHIM_STATEFUL
assert_rc 0 "install over an existing wasitme marketplace"
assert_contains "$(out)" "already has a marketplace named 'wasitme'" "the existing one is noticed"
assert_eq "claude plugin marketplace add $H/.wasitme/current
claude plugin update wasitme@wasitme
claude plugin configure wasitme@wasitme --values-stdin" "$(shimlog)" "re-pointed with marketplace add, then update + configure: never uninstall or marketplace remove"
assert_eq "$H/.wasitme/current" "$(json_get "$H/.claude/plugins/known_marketplaces.json" 'd.wasitme.path')" "the marketplace now points at current"
assert_eq "0.2.0" "$(json_get "$H/.claude/plugins/installed_plugins.json" 'd["wasitme@wasitme"].version')" "and the plugin runs this version"
assert_eq "false" "$(json_get "$H/.claude/settings.json" 'd.pluginConfigs["wasitme@wasitme"].options.showBand')" "the person's own option is kept"
assert_eq "$H/.wasitme/glance.json" "$(json_get "$H/.claude/settings.json" 'd.pluginConfigs["wasitme@wasitme"].options.glancePath')" "and glancePath is set"
assert_file_has "$H/.wasitme/install-manifest" "$(printf 'claude-plugin\twasitme@wasitme\twasitme\t%s' "$H/.wasitme/current")" "it is ours from now on"

t_section "Linux: the CLI and plugins, no LaunchAgent, no app (the README platform table)"
sb_new
make_fixture "$SB_SRC" 0.1.0 macos-fake
H=$SB_HOME
export WASITME_OS=Linux
inst_from --yes --agents claude-code,codex
unset WASITME_OS
assert_rc 0 "--yes on Linux"
assert_contains "$(out)" "scan agent           skipped    macOS only" "no background scan: it scans on demand"
assert_contains "$(out)" "mac app              skipped    only on macOS" "no app"
assert_contains "$(shimlog)" "claude plugin install wasitme@wasitme" "the Claude Code plugin is still offered"
assert_contains "$(shimlog)" "codex plugin add wasitme@wasitme-codex" "and so is Codex's"
assert_not_contains "$(shimlog)" "launchctl" "launchctl is never run"
assert_not_contains "$(shimlog)" "swift" "nothing is built"
assert_missing "$H/Library" "no ~/Library is created"
assert_missing "$H/Applications" "no ~/Applications"
assert_eq "null" "$(json_get "$H/.wasitme/engine.json" 'd.scanLabel')" "engine.json: no scan label"
assert_line "$H/.wasitme/engine.env" "scan_label=" "engine.env: none for the hook either"
assert_link "$H/.wasitme/current" "versions/0.1.0" "the same versions/ + current layout"
export WASITME_OS=Linux
uninst --yes
unset WASITME_OS
assert_rc 0 "uninstall on Linux"
assert_missing "$H/.wasitme" "everything removed"
assert_missing "$H/.local" "including the command"

t_done
