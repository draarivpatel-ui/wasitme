#!/bin/sh
# Failure injection: a failed or interrupted step must leave the machine as it was (engine) or undo only itself
# (optional components). Nothing here touches the real system.
# T_RC, T_OUT and T_ERR are set in this file and read by assert_rc, out and err in harness.sh. The linter looks at one file at a time
# and would call them unused (SC2034); this single directive, before the first command, covers the file.
# shellcheck disable=SC2034
. "$(dirname "$0")/harness.sh"

lock_down() { chmod 555 "$1"; }
unlock() { chmod 755 "$1"; }
# Failure injection through a read-only directory only works for non-root users.
if [ "$(id -u)" = 0 ]; then printf '%s: skipped (running as root)\n' "$T_NAME"; exit 0; fi

t_section "engine self-check fails before anything goes live"
sb_new
make_fixture "$SB_SRC" 0.1.0 fail
inst_from $CORE_ONLY
assert_rc 1 "a broken engine stops the install"
assert_contains "$(err)" "failed its self-check" "message names the self-check"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was left behind (even the folders it created are gone, read-only stage included)"
assert_eq "0" "$(ls -A "$SB/tmp" | wc -l | tr -d ' ')" "temp directories cleaned up"

sb_new
make_fixture "$SB_SRC" 0.1.0
printf 'console.log("totally different output");\n' >"$SB_SRC/engine/dist/src/cli/main.js"
inst_from $CORE_ONLY
assert_rc 1 "an engine whose --version does not mention its version is refused"
assert_contains "$(err)" "expected it to mention 0.1.0" "message explains"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was left behind"

sb_new
make_fixture "$SB_SRC" 0.1.0 noversion
inst_from $CORE_ONLY
assert_rc 0 "an engine without --version yet (the CLI before WP-30) is accepted when --help runs cleanly"
assert_contains "$(out)" "this engine has no --version yet, so it was checked with --help" "and the result says how it was checked"

t_section "a late engine step fails: full rollback of a fresh install"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.local/bin"
lock_down "$H/.local/bin"
BEFORE=$(tree_of "$H")
inst_from $CORE_ONLY
unlock "$H/.local/bin"
assert_rc 1 "an unwritable bin directory stops the install"
assert_contains "$(err)" "could not write" "message names the failed step"
assert_contains "$(err)" "undoing the changes" "the rollback announces itself"
assert_eq "$BEFORE" "$(tree_of "$H")" "the home is exactly as it was before the attempt"

t_section "a late engine step fails during an upgrade: the old version keeps working"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
inst_from $CORE_ONLY
assert_rc 0 "first install"
chmod u+w "$W/versions/0.1.0" && printf 'marker\n' >"$W/versions/0.1.0/extra.txt" && chmod a-w "$W/versions/0.1.0"
MANIFEST_BEFORE=$(cat "$W/install-manifest")
ENGINE_JSON_BEFORE=$(cat "$W/engine.json")
ENGINE_ENV_BEFORE=$(cat "$W/engine.env")
SHIM_BEFORE=$(cat "$H/.local/bin/wasitme")
make_fixture "$SB_SRC" 0.2.0
lock_down "$H/.local/bin"
inst_from $CORE_ONLY
unlock "$H/.local/bin"
assert_rc 1 "upgrade fails when the shim cannot be written"
assert_link "$W/current" "versions/0.1.0" "current flipped back to 0.1.0"
assert_missing "$W/versions/0.2.0" "the half-installed (read-only) 0.2.0 is gone"
assert_file "$W/versions/0.1.0/extra.txt" "0.1.0 is untouched"
assert_missing "$W/versions/.stage" "no staging left"
assert_missing "$W/versions/.parked" "no parked copy left"
assert_eq "wasitme 0.1.0" "$("$H/.local/bin/wasitme" --version)" "the command still runs 0.1.0"
assert_eq "$MANIFEST_BEFORE" "$(cat "$W/install-manifest")" "manifest unchanged"
assert_eq "$ENGINE_JSON_BEFORE" "$(cat "$W/engine.json")" "engine.json unchanged"
assert_eq "$ENGINE_ENV_BEFORE" "$(cat "$W/engine.env")" "engine.env unchanged"
assert_eq "$SHIM_BEFORE" "$(cat "$H/.local/bin/wasitme")" "shim unchanged"

t_section "a same-version reinstall that fails puts the previous copy back"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
inst_from $CORE_ONLY
chmod u+w "$W/versions/0.1.0" && printf 'marker\n' >"$W/versions/0.1.0/extra.txt" && chmod a-w "$W/versions/0.1.0"
lock_down "$H/.local/bin"
inst_from $CORE_ONLY
unlock "$H/.local/bin"
assert_rc 1 "reinstall fails"
assert_file "$W/versions/0.1.0/extra.txt" "the previous 0.1.0 was parked and has been restored"
assert_link "$W/current" "versions/0.1.0" "current intact"
assert_missing "$W/versions/.parked" "nothing parked"
assert_missing "$W/versions/.stage" "no staging"

t_section "locking"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
mkdir -p "$W/.install.lock"
printf '999999\n' >"$W/.install.lock/pid"
inst_from $CORE_ONLY
assert_rc 0 "a lock left by a dead process is reclaimed"
assert_missing "$W/.install.lock" "lock released afterwards"
sleep 30 &
HOLDER=$!
mkdir -p "$W/.install.lock"
printf '%s\n' "$HOLDER" >"$W/.install.lock/pid"
mkdir -p "$W/versions/.stage/engine"   # the holder is mid-install: its staging folder exists
printf 'holder work\n' >"$W/versions/.stage/engine/file"
export WASITME_LOCK_WAIT=1
inst_from $CORE_ONLY
unset WASITME_LOCK_WAIT
kill "$HOLDER" 2>/dev/null
wait "$HOLDER" 2>/dev/null
assert_rc 1 "a lock held by a live process makes the second installer give up"
assert_contains "$(err)" "another wasitme install or uninstall is running" "message explains"
assert_file "$W/versions/.stage/engine/file" "an installer that never got the lock must not delete the lock holder's staging folder"
assert_dir "$W/.install.lock" "and it leaves the holder's lock alone"
rm -rf "$W/versions/.stage"
rm -rf "$W/.install.lock"

t_section "plugin failures undo only the plugin"
PLUGINS="--yes --no-app --no-scan-agent --no-statusline --agents claude-code,codex"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
CUR="$H/.wasitme/current"
export SHIM_FAIL_CLAUDE="plugin install"
inst_from $PLUGINS
unset SHIM_FAIL_CLAUDE
assert_rc 3 "exit code 3: engine installed, one component failed and was rolled back"
assert_eq "claude plugin marketplace add $CUR
claude plugin install wasitme@wasitme
claude plugin marketplace remove wasitme
codex plugin marketplace add $CUR/plugin-codex
codex plugin add wasitme@wasitme-codex" "$(shimlog)" "claude: add, failed install, marketplace removed again (a fresh install: nothing of yours existed); codex unaffected"
assert_contains "$(out)" "FAILED" "the result says what failed"
assert_contains "$(out)" "safe to fix the problem and run this installer again" "and that re-running is safe"
assert_file "$CUR/engine/dist/src/cli/main.js" "the engine stays installed"
assert_file_lacks "$H/.wasitme/install-manifest" "claude-plugin" "the failed plugin is not in the manifest"
assert_file_has "$H/.wasitme/install-manifest" "codex-plugin" "the working plugin is"

sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
export SHIM_FAIL_CLAUDE="plugin install" SHIM_FAIL_CODEX="plugin add"
inst_from $PLUGINS
unset SHIM_FAIL_CLAUDE SHIM_FAIL_CODEX
assert_rc 3 "both plugins failing"
assert_eq "codex plugin marketplace add $H/.wasitme/current/plugin-codex
codex plugin add wasitme@wasitme-codex
codex plugin marketplace remove wasitme-codex" "$(grep '^codex' "$SHIM_LOG")" "codex: add, failed plugin add, marketplace removed again"
assert_file_lacks "$H/.wasitme/install-manifest" "plugin" "no plugin entries in the manifest"
assert_file "$H/.wasitme/current/engine/dist/src/cli/main.js" "engine still installed"

sb_new
make_fixture "$SB_SRC" 0.1.0
export SHIM_FAIL_CLAUDE="marketplace add"
inst_from --yes --no-app --no-scan-agent --no-statusline --no-codex-plugin --agents claude-code
unset SHIM_FAIL_CLAUDE
assert_rc 3 "marketplace add failing"
assert_eq "claude plugin marketplace add $SB_HOME/.wasitme/current" "$(shimlog)" "no install and no remove after a failed add"
assert_contains "$(out)" "nothing of yours was changed" "the result says nothing of the user's was touched"

sb_new
make_fixture "$SB_SRC" 0.1.0
export SHIM_FAIL_CLAUDE="plugin configure"
inst_from --yes --no-app --no-scan-agent --no-statusline --no-codex-plugin --agents claude-code
unset SHIM_FAIL_CLAUDE
assert_rc 0 "the glancePath option failing to save is a warning, not a failure (the mod finds the file on its own)"
assert_contains "$(err)" "could not save the plugin's glancePath option" "but it is reported"
assert_contains "$(out)" "glancePath not saved" "and noted in the result"

t_section "a failed update never removes the Claude plugin (D50)"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
MF="$W/install-manifest"
inst_from $PLUGINS
make_fixture "$SB_SRC" 0.2.0
: >"$SHIM_LOG"
export SHIM_FAIL_CLAUDE="plugin update"
inst_from $PLUGINS
unset SHIM_FAIL_CLAUDE
assert_rc 3 "claude plugin update fails"
assert_not_contains "$(shimlog)" "claude plugin uninstall" "no uninstall"
assert_not_contains "$(shimlog)" "claude plugin marketplace" "no marketplace remove or add"
assert_contains "$(out)" "Claude Code's record of it is stale until: claude plugin update wasitme@wasitme" "the result says exactly what is stale and the fix"
assert_link "$W/current" "versions/0.2.0" "the update itself stands (one flip moved everything)"
assert_file_has "$MF" "$(printf 'claude-plugin\twasitme@wasitme\twasitme\t%s' "$W/current")" "the plugin is still recorded"

t_section "a failed Codex re-registration puts the previous registration back (D49)"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
MF="$W/install-manifest"
inst_from $PLUGINS
V1R=$(cd -P "$W/versions/0.1.0" && pwd -P)
make_fixture "$SB_SRC" 0.2.0
: >"$SHIM_LOG"
export SHIM_FAIL_CODEX="marketplace add $W/current" SHIM_FAIL_CODEX_TIMES=1
inst_from $PLUGINS
unset SHIM_FAIL_CODEX SHIM_FAIL_CODEX_TIMES
assert_rc 3 "codex marketplace add fails after the old one was removed"
assert_eq "codex plugin marketplace remove wasitme-codex
codex plugin marketplace add $W/current/plugin-codex
codex plugin marketplace add $V1R/plugin-codex
codex plugin add wasitme@wasitme-codex" "$(grep '^codex' "$SHIM_LOG")" "the old version's root is registered again and its plugin re-added"
assert_file_has "$MF" "$(printf 'codex-plugin\twasitme@wasitme-codex\twasitme-codex\t%s/plugin-codex' "$V1R")" "the manifest still describes the registration that works"
assert_contains "$(err)" "the Codex plugin you had before was put back" "the user is told it was put back"
assert_contains "$(out)" "was rolled back on its own" "the summary is accurate"
assert_dir "$W/versions/0.1.0" "the folder Codex still uses is kept"

: >"$SHIM_LOG"
make_fixture "$SB_SRC" 0.3.0
export SHIM_FAIL_CODEX="plugin add" SHIM_FAIL_CODEX_TIMES=1
inst_from $PLUGINS
unset SHIM_FAIL_CODEX SHIM_FAIL_CODEX_TIMES
assert_rc 3 "codex plugin add fails after the new root was registered"
assert_eq "codex plugin marketplace remove wasitme-codex
codex plugin marketplace add $W/current/plugin-codex
codex plugin add wasitme@wasitme-codex
codex plugin marketplace remove wasitme-codex
codex plugin marketplace add $V1R/plugin-codex
codex plugin add wasitme@wasitme-codex" "$(grep '^codex' "$SHIM_LOG")" "the new registration is removed and the one that worked comes back"
assert_dir "$W/versions/0.1.0" "0.1.0 is kept even though it is two versions old: the manifest says Codex uses it"

sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
MF="$W/install-manifest"
inst_from --yes --no-app --no-scan-agent --no-statusline --no-claude-plugin --agents codex
make_fixture "$SB_SRC" 0.2.0
export SHIM_FAIL_CODEX="marketplace add"
inst_from --yes --no-app --no-scan-agent --no-statusline --no-claude-plugin --agents codex
unset SHIM_FAIL_CODEX
assert_rc 3 "the restore fails too"
assert_contains "$(err)" "could not put the previous Codex plugin back" "the failure to restore is reported, not hidden"
assert_contains "$(out)" "could not be put back automatically" "and so is the summary"
assert_not_contains "$(out)" "was rolled back on its own" "which no longer claims everything is fine"
assert_file_lacks "$MF" "codex-plugin" "the plugin is no longer recorded as installed"
: >"$SHIM_LOG"
inst_from --yes --no-app --no-scan-agent --no-statusline --no-claude-plugin --agents codex
assert_rc 0 "re-running after the cause is fixed"
assert_eq "codex plugin marketplace add $W/current/plugin-codex
codex plugin add wasitme@wasitme-codex" "$(shimlog)" "registers it afresh (it is not mistaken for up to date)"

t_section "an interrupt in the middle of a Codex re-registration puts the previous one back"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
inst_from --yes --no-app --no-scan-agent --no-statusline --no-claude-plugin --agents codex
assert_rc 0 "first install"
V1R=$(cd -P "$W/versions/0.1.0" && pwd -P)
make_fixture "$SB_SRC" 0.2.0
: >"$SHIM_LOG"
export SHIM_SLEEP_CODEX="plugin add" SHIM_SLEEP_SECONDS=2
PATH="$SB/shims:$BASE_PATH" "$SH_BIN" "$T_REPO/scripts/install.sh" --home "$H" --from "$SB_SRC" --yes --no-app --no-scan-agent --no-statusline --no-claude-plugin --agents codex >"$SB/out.txt" 2>"$SB/err.txt" </dev/null &
PID=$!
n=0
while [ "$n" -lt 100 ] && ! grep -q 'codex plugin add' "$SHIM_LOG"; do sleep 0.1; n=$((n + 1)); done
kill -TERM "$PID"
wait "$PID"
T_RC=$?
unset SHIM_SLEEP_CODEX SHIM_SLEEP_SECONDS
assert_eq "143" "$T_RC" "SIGTERM exits 143"
assert_eq "codex plugin marketplace remove wasitme-codex
codex plugin marketplace add $W/current/plugin-codex
codex plugin add wasitme@wasitme-codex
codex plugin marketplace remove wasitme-codex
codex plugin marketplace add $V1R/plugin-codex
codex plugin add wasitme@wasitme-codex" "$(shimlog)" "the half-done re-registration is undone and the old one comes back"
assert_file_has "$W/install-manifest" "$(printf 'codex-plugin\twasitme@wasitme-codex\twasitme-codex\t%s/plugin-codex' "$V1R")" "the manifest still describes the plugin that works"

t_section "an interrupt in the middle of a plugin install undoes it"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
export SHIM_SLEEP_CLAUDE="plugin install" SHIM_SLEEP_SECONDS=3
PATH="$SB/shims:$BASE_PATH" "$SH_BIN" "$T_REPO/scripts/install.sh" --home "$H" --from "$SB_SRC" --yes --no-app --no-scan-agent --no-statusline --no-codex-plugin --agents claude-code >"$SB/out.txt" 2>"$SB/err.txt" </dev/null &
PID=$!
n=0
while [ "$n" -lt 100 ] && ! grep -q 'plugin install' "$SHIM_LOG"; do sleep 0.1; n=$((n + 1)); done
kill -TERM "$PID"
wait "$PID"
T_RC=$?
unset SHIM_SLEEP_CLAUDE SHIM_SLEEP_SECONDS
T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
assert_eq "143" "$T_RC" "SIGTERM exits 143"
assert_contains "$(shimlog)" "claude plugin marketplace remove wasitme" "the half-done marketplace add was undone"
assert_file_lacks "$H/.wasitme/install-manifest" "claude-plugin" "nothing recorded for the interrupted plugin"
assert_file "$H/.wasitme/current/engine/dist/src/cli/main.js" "the engine, finished before the interrupt, stays"
assert_missing "$H/.wasitme/.install.lock" "lock released"
assert_eq "0" "$(ls -A "$SB/tmp" | wc -l | tr -d ' ')" "temp directories cleaned up"

t_section "growth check: an update whose plugin asks for more stops, changing nothing"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
inst_from $PLUGINS
assert_rc 0 "first install"
make_fixture "$SB_SRC" 0.2.0
printf '$.clock.now, $.fs.read, $.process.run (via load)\n' >"$SB_SRC/plugin/.fake-calls"
BEFORE=$(cd "$H" && find . | sort)
MF_BEFORE=$(cat "$W/install-manifest")
: >"$SHIM_LOG"
inst_from $PLUGINS
assert_rc 4 "--yes refuses an update that widens the mod's calls (exit 4: stopped for a yes, nothing failed)"
assert_contains "$(out)" "New mod calls:" "the difference is shown"
assert_contains "$(out)" "+ \$.process.run" "exactly the new call, without its (via ...) note"
assert_not_contains "$(out)" "+ \$.fs.read" "calls it already had are not listed"
assert_contains "$(err)" "--accept-plugin-changes" "the way to accept it is named"
assert_link "$W/current" "versions/0.1.0" "current did not move"
assert_eq "$BEFORE" "$(cd "$H" && find . | sort)" "nothing was added or removed"
assert_eq "$MF_BEFORE" "$(cat "$W/install-manifest")" "manifest unchanged"
assert_not_contains "$(shimlog)" "plugin update" "no plugin command ran beyond the read-only validate"
inst_from $PLUGINS --accept-plugin-changes
assert_rc 0 "--accept-plugin-changes lets it through"
assert_link "$W/current" "versions/0.2.0" "current moved"
make_fixture "$SB_SRC" 0.3.0
printf '$.clock.now, $.fs.read, $.process.run (via load)\n' >"$SB_SRC/plugin/.fake-calls"
printf '{ "hooks": { "SessionStart": [ { "matcher": "startup|resume", "hooks": [ { "type": "command", "command": "/bin/sh \\"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh\\"", "async": true } ] } ], "PreToolUse": [ { "hooks": [ { "type": "command", "command": "/bin/sh x.sh" } ] } ] } }\n' >"$SB_SRC/plugin/hooks/hooks.json"
inst_from $PLUGINS
assert_rc 4 "a new hook is growth too"
assert_contains "$(out)" "New hooks or mod modules:" "listed"
assert_contains "$(out)" "+ hook PreToolUse * command /bin/sh x.sh" "with its event and command"
printf 'a\ny\n' >"$SB/answers.txt"
export WASITME_TTY="$SB/answers.txt"
inst_from --guided --no-app --no-scan-agent --no-statusline --no-claude-plugin --no-codex-plugin --agents claude-code,codex
unset WASITME_TTY
assert_rc 1 "guided: the growth question defaults to no; running out of answers stops it"
printf 'a\ny\ny\n' >"$SB/answers.txt"
export WASITME_TTY="$SB/answers.txt"
inst_from --guided --no-app --no-scan-agent --no-statusline --no-claude-plugin --no-codex-plugin --agents claude-code,codex
unset WASITME_TTY
assert_rc 0 "guided: a yes lets it through"
assert_contains "$(out)" "Update anyway?" "after asking"
assert_link "$W/current" "versions/0.3.0" "current moved"

t_section "status line failure restores settings.json"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{"theme":"dark"}\n' >"$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$SB/settings.orig"
lock_down "$H/.claude"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
unlock "$H/.claude"
assert_rc 3 "an unwritable ~/.claude: status line fails, engine stays"
assert_same_file "$SB/settings.orig" "$H/.claude/settings.json" "settings.json is exactly as it was"
assert_eq "0" "$(count_glob "$H/.claude"/*wasitme-bak*)" "no stray backup file"
assert_file_lacks "$H/.wasitme/install-manifest" "$(printf 'statusline\t')" "nothing recorded"

if [ "$T_OS" = Darwin ]; then
  t_section "macOS: swift build fails"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  export SHIM_FAIL_SWIFT="build -c release --package-path"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 3 "build failure: partial success"
  assert_contains "$(out)" "swift build failed" "the reason is shown"
  assert_contains "$(out)" "sudo xcodebuild -license" "the license hint is shown"
  assert_missing "$H/Applications" "no app folder left behind"
  assert_file "$H/Library/LaunchAgents/$LABEL_SCAN.plist" "the scan agent (a separate component) is installed"
  assert_file "$H/.wasitme/current/engine/dist/src/cli/main.js" "the engine is installed"
  assert_eq "0" "$(grep -c "$LABEL_APP" "$H/.wasitme/install-manifest")" "no app agent recorded"

  t_section "macOS: the build produces no executable by the expected name"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  export SHIM_APP_EXE=other-name
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 3 "wrong executable name"
  assert_contains "$(out)" "produced no executable named 'WasitmeApp'" "the expected name is stated"
  assert_contains "$(out)" "other-name" "what was found is listed"
  assert_contains "$(out)" "--app-executable" "the fix is named"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent --app-executable other-name
  assert_rc 0 "--app-executable fixes it"
  assert_file "$SB_HOME/Applications/wasitme.app/Contents/MacOS/other-name" "bundle uses that executable"
  assert_eq "other-name" "$(plist_get "$SB_HOME/Applications/wasitme.app/Contents/Info.plist" CFBundleExecutable)" "CFBundleExecutable matches"

  t_section "macOS: codesign fails on the staged bundle"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  export SHIM_FAIL_CODESIGN="--verify --deep --strict $H/Applications/.wasitme.app.stage"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 3 "unverifiable signature"
  assert_missing "$H/Applications" "stage and the folder made for it are removed"
  assert_eq "0" "$(grep -c '^launchctl' "$SHIM_LOG")" "no agent was loaded for an app that did not install"
  assert_eq "0" "$(grep -c 'app\b' "$H/.wasitme/install-manifest")" "no app in the manifest"

  t_section "macOS: the signature fails to verify after the swap: the previous app returns"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  LA="$H/Library/LaunchAgents"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 0 "first app install"
  printf 'previous\n' >"$H/Applications/wasitme.app/Contents/marker.txt"
  : >"$SHIM_LOG"
  export SHIM_FAIL_CODESIGN="Applications/wasitme.app"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 3 "second install fails at the final verification"
  assert_file "$H/Applications/wasitme.app/Contents/marker.txt" "the previous app bundle is back"
  assert_missing "$H/Applications/.wasitme.app.prev" "nothing left parked"
  assert_missing "$H/Applications/.wasitme.app.stage" "no stage left"
  assert_eq "launchctl bootout gui/$T_UID/$LABEL_APP
launchctl print gui/$T_UID/$LABEL_APP
launchctl bootstrap gui/$T_UID $LA/$LABEL_APP.plist" "$(grep '^launchctl' "$SHIM_LOG")" "the old agent was stopped for the swap (and launchd waited on) and started again on rollback"
  assert_file_has "$H/.wasitme/install-manifest" "$(printf 'app\t%s' "$H/Applications/wasitme.app")" "the manifest still has the previous app"

  t_section "macOS: things we did not create are never overwritten"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  LA="$H/Library/LaunchAgents"
  mkdir -p "$LA" "$H/Applications/wasitme.app/Contents"
  printf '<plist>not ours</plist>\n' >"$LA/$LABEL_SCAN.plist"
  printf '<plist>not wasitme</plist>\n' >"$H/Applications/wasitme.app/Contents/Info.plist"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 3 "both components refuse"
  assert_eq "<plist>not ours</plist>" "$(cat "$LA/$LABEL_SCAN.plist")" "the foreign LaunchAgent plist is untouched"
  assert_eq "<plist>not wasitme</plist>" "$(cat "$H/Applications/wasitme.app/Contents/Info.plist")" "the foreign app is untouched"
  assert_contains "$(err)" "was not created by this installer" "the agent warning explains"
  assert_contains "$(out)" "is not the wasitme app" "the app message explains"
  assert_eq "0" "$(grep -c '^launchctl' "$SHIM_LOG")" "launchctl was not touched for foreign agents"

  t_section "macOS: a wasitme.app with no Info.plist is not ours either"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  mkdir -p "$H/Applications/wasitme.app/Contents"
  printf 'my notes\n' >"$H/Applications/wasitme.app/Contents/notes.txt"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 3 "the app component refuses"
  assert_file "$H/Applications/wasitme.app/Contents/notes.txt" "the user's files are still there"
  assert_eq "my notes" "$(cat "$H/Applications/wasitme.app/Contents/notes.txt")" "unchanged"
  assert_missing "$H/Applications/.wasitme.app.prev" "nothing was parked, nothing was deleted"
  assert_missing "$H/Applications/.wasitme.app.stage" "no stage left"
  assert_contains "$(out)" "is not the wasitme app" "the message explains"
  assert_eq "0" "$(grep -c '^swift' "$SHIM_LOG")" "and no Swift build was wasted on it"
  assert_eq "0" "$(grep -c '^launchctl' "$SHIM_LOG")" "launchctl was not touched"
  mkdir -p "$SB/lnk-target"
  rm -rf "$H/Applications/wasitme.app"
  ln -s "$SB/lnk-target" "$H/Applications/wasitme.app"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 3 "a symlink in that place is not ours either"
  assert_link "$H/Applications/wasitme.app" "$SB/lnk-target" "it is left as it is"
fi

t_done
