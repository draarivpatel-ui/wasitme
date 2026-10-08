#!/bin/sh
# install.sh --update: a newer version with exactly the parts the install record lists, asking nothing. A running app is
# quit before its bundle is replaced and started again (by its LaunchAgent, or with `open -g` when launchd will not);
# an app the person quit stays quit. And --from-app, what the Mac app runs: the action is detached from the app, returns
# at once, and records how it ended in ~/.wasitme/state/last-action.json. Temp homes and recording shims only: launchctl,
# pkill, pgrep and open never touch the real launchd or a real app (SHIM_APP_STATE stands for the running app).
. "$(dirname "$0")/harness.sh"

# wait_action FILE: until last-action.json says the detached run ended (or the file is gone), at most ~30 s.
wait_action() {
  wa_n=0
  while [ "$wa_n" -lt 120 ]; do
    if [ ! -f "$1" ]; then
      # A full uninstall deletes the file when it is done; before the run writes it, it is missing too: give it a moment.
      [ "$wa_n" -gt 4 ] && return 0
    elif ! grep -q '"state": "running"' "$1"; then
      return 0
    fi
    wa_n=$((wa_n + 1))
    sleep 0.25 2>/dev/null || sleep 1
  done
  t_fail "the detached run did not finish in time: $1"
}

t_section "--update keeps exactly the installed parts and asks nothing"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
mkdir -p "$H/.claude"
printf '{"theme":"dark"}\n' >"$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --no-codex-plugin --agents claude-code,codex --statusline
assert_rc 0 "install: the Claude Code plugin and the status line, not the Codex plugin"
make_fixture "$SB_SRC" 0.2.0
: >"$SHIM_LOG"
inst_from --update
assert_rc 0 "update"
assert_link "$W/current" "versions/0.2.0" "current flipped"
assert_dir "$W/versions/0.1.0" "the previous version is kept for a rollback"
assert_contains "$(shimlog)" "claude plugin update wasitme@wasitme" "the Claude Code plugin is updated"
assert_not_contains "$(shimlog)" "codex" "the Codex plugin, which was not installed, is left alone"
assert_not_contains "$(out)" "turned off by a flag" "no part is reported as skipped by a flag"
assert_contains "$(out)" "Codex plugin        -> no (not installed, left as it is)" "the plan says a part that is not installed is left alone"
assert_eq "" "$(sed -n '/^==> Result/,$p' "$T_OUT" | grep 'Codex plugin')" "and the result does not list it"
assert_contains "$(out)" "status line          installed" "the status line is kept"
assert_eq "Updated wasitme 0.1.0 -> 0.2.0 (kept: Claude Code plugin, status line)." "$(tail -n 1 "$T_OUT")" "the last line says what happened, in one line"
assert_eq "0.2.0" "$(json_get "$W/engine.json" 'd.version')" "engine.json names the new version"
assert_eq '["claude-code","codex"]' "$(json_get "$W/engine.json" 'd.agents')" "and the same tracked agents"
assert_eq "0" "$(grep -c '^codex-plugin' "$W/install-manifest")" "the manifest still has no Codex plugin"
assert_eq "1" "$(grep -c '^claude-plugin' "$W/install-manifest")" "and still has the Claude Code plugin"
make_fixture "$SB_SRC" 0.2.0
inst_from --update
assert_rc 0 "an update to the version already installed"
assert_eq "Reinstalled wasitme 0.2.0 (kept: Claude Code plugin, status line)." "$(tail -n 1 "$T_OUT")" "says so"
assert_dir "$W/versions/0.1.0" "and keeps the rollback version (current did not move, so nothing is pruned)"

t_section "--update names an installed part it could not update"
make_fixture "$SB_SRC" 0.3.0
export WASITME_CLAUDE="$SB/nonexistent/claude"
inst_from --update
export WASITME_CLAUDE="$SB/shims/claude"
assert_rc 0 "update without a claude command"
assert_contains "$(out)" "the 'claude' command was not found, so Claude Code still records the previous version" "the result says why"
assert_eq "Updated wasitme 0.2.0 -> 0.3.0 (kept: status line). Not updated: Claude Code plugin (see above)." "$(tail -n 1 "$T_OUT")" "and the last line does not hide it"

t_section "--update refuses what it cannot do, and says why"
inst_from --update --no-app
assert_rc 2 "--update with a part flag"
assert_contains "$(err)" "--update keeps the parts you have installed" "explains"
for t_args in "--update --repair" "--update --add codex-plugin" "--update --guided" "--update --agents codex"; do
  inst_from $t_args
  assert_rc 2 "$t_args is a usage error"
done
inst --update
# The public export fills in the owner; the placeholder is spelled in two pieces so the export leaves this check alone.
if grep -q -F "OWNER""/wasitme" "$T_REPO/scripts/install.sh"; then
  assert_rc 1 "--update without a source falls back to the release URL, which does not exist yet"
  assert_contains "$(err)" "no published release URL yet" "and says so"
else
  assert_rc 1 "--update without a source falls back to the release URL (the fake download is empty)"
  assert_contains "$(shimlog)" "/wasitme/releases/latest/download/wasitme.tar.gz" "and asks GitHub for the latest release"
fi
sb_new
make_fixture "$SB_SRC" 0.2.0
inst_from --update
assert_rc 1 "--update with nothing installed"
assert_contains "$(err)" "--update needs an existing install" "says what is missing"
assert_missing "$SB_HOME/.wasitme/versions" "and installs nothing"

t_section "--update stops for a plugin that asks for more: exit 4, nothing changed"
sb_new
make_fixture "$SB_SRC" 0.1.0
W="$SB_HOME/.wasitme"
inst_from --yes --no-app --no-scan-agent --no-statusline --agents claude-code,codex
make_fixture "$SB_SRC" 0.2.0
printf '$.clock.now, $.fs.read, $.process.run (via load)\n' >"$SB_SRC/plugin/.fake-calls"
inst_from --update
assert_rc 4 "stopped, waiting for a yes"
assert_link "$W/current" "versions/0.1.0" "current did not move"
assert_missing "$W/versions/.stage" "no staged copy is left behind"
assert_missing "$W/versions/0.2.0" "nor the new version"
assert_missing "$W/.install.lock" "and the install lock was released"
inst_from --update --accept-plugin-changes
assert_rc 0 "--accept-plugin-changes lets it through"
assert_link "$W/current" "versions/0.2.0" "current moved"

t_section "--from-app: detached, returns at once, records the result"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
LA_JSON="$W/state/last-action.json"
inst_from --yes --no-app --no-scan-agent --no-statusline --agents claude-code,codex
assert_rc 0 "install"
make_fixture "$SB_SRC" 0.2.0
export SHIM_SLEEP_CLAUDE="plugin update" SHIM_SLEEP_SECONDS=2
inst_from --update --from-app
unset SHIM_SLEEP_CLAUDE SHIM_SLEEP_SECONDS
assert_rc 0 "the call returns as soon as the run has started"
assert_contains "$(out)" "Started in the background" "and says so"
assert_eq "running" "$(json_get "$LA_JSON" 'd.state')" "the result file says running straight away"
FA_PID=""
fa_n=0
while [ -z "$FA_PID" ] && [ "$fa_n" -lt 40 ]; do
  FA_PID=$(json_get "$LA_JSON" 'd.pid === null ? "" : d.pid' 2>/dev/null)
  [ -n "$FA_PID" ] || { fa_n=$((fa_n + 1)); sleep 0.25 2>/dev/null || sleep 1; }
done
if [ -n "$FA_PID" ]; then
  # setsid: the detached run leads its own session and process group, so launchd's clean-up of the app's process group
  # (and the app's own exit) cannot reach it.
  assert_eq "$FA_PID" "$(ps -o pgid= -p "$FA_PID" 2>/dev/null | tr -d ' ')" "the detached run leads its own process group (setsid)"
  assert_not_contains " $(ps -o pgid= -p $$ | tr -d ' ') " " $FA_PID " "which is not the caller's"
else
  t_fail "the running result never named the detached run's pid"
fi
wait_action "$LA_JSON"
assert_eq "done 0" "$(json_get "$LA_JSON" 'd.state + " " + d.code')" "it finished: done, exit 0"
assert_eq "Updated wasitme 0.1.0 -> 0.2.0 (kept: Claude Code plugin, Codex plugin)." "$(json_get "$LA_JSON" 'd.summary')" "the summary is the run's last line"
assert_eq "null" "$(json_get "$LA_JSON" 'd.pid')" "no pid once it is over"
assert_link "$W/current" "versions/0.2.0" "and the update really happened"
assert_eq "-rw-------" "$(ls -l "$LA_JSON" | cut -c1-10)" "the result is private (0600)"
assert_eq "-rw-------" "$(ls -l "$W/state/last-action.log" | cut -c1-10)" "and so is the log"
assert_file_has "$W/state/last-action.log" "==> Installing wasitme 0.2.0" "the log holds the run's output"
assert_eq "drwx------" "$(ls -ld "$W/state" | cut -c1-10)" "state/ is private (0700)"

# A second action while one is still running is refused, so its result file is never overwritten mid-run.
cp "$LA_JSON" "$SB/la.done"
printf '{ "schema": "wasitme.action/1", "action": "update", "state": "running", "code": null, "summary": "", "pid": %s, "started": "2026-10-06T12:00:00.000Z", "finished": null }\n' "$$" >"$LA_JSON"
cp "$LA_JSON" "$SB/la.running"
inst_from --update --from-app
assert_rc 1 "refused while another action runs (its pid is alive)"
assert_contains "$(err)" "another wasitme action started from the app is still running; nothing was started" "says so"
assert_same_file "$SB/la.running" "$LA_JSON" "the running action's result file is untouched"
printf '{ "schema": "wasitme.action/1", "action": "update", "state": "running", "code": null, "summary": "", "pid": 999999, "started": "2026-10-06T12:00:00.000Z", "finished": null }\n' >"$LA_JSON"
uninst --yes --only codex-plugin --from-app
assert_rc 0 "a running result whose pid is gone (cut short) does not block the next action"
wait_action "$LA_JSON"
assert_eq "remove done" "$(json_get "$LA_JSON" 'd.action + " " + d.state')" "which runs"
inst_from --add codex-plugin
assert_rc 0 "(put the Codex plugin back)"

# A failure, and a stop for consent, are recorded as such.
make_fixture "$SB_SRC" 0.3.0 fail
inst_from --update --from-app
assert_rc 0 "started"
wait_action "$LA_JSON"
assert_eq "failed 1" "$(json_get "$LA_JSON" 'd.state + " " + d.code')" "a failed update is recorded as failed"
assert_contains "$(json_get "$LA_JSON" 'd.summary')" "error: the new engine failed its self-check" "with the error as its summary (not the 'undoing' note after it)"
assert_link "$W/current" "versions/0.2.0" "and nothing changed"
make_fixture "$SB_SRC" 0.3.0
printf '$.clock.now, $.fs.read, $.process.run (via load)\n' >"$SB_SRC/plugin/.fake-calls"
inst_from --update --from-app
wait_action "$LA_JSON"
assert_eq "stopped 4" "$(json_get "$LA_JSON" 'd.state + " " + d.code')" "a growth stop is recorded as stopped (exit 4), so the app can ask"

# --add and --only from the app.
uninst --yes --only codex-plugin --from-app
assert_rc 0 "an --only removal from the app starts"
wait_action "$LA_JSON"
assert_eq "remove done" "$(json_get "$LA_JSON" 'd.action + " " + d.state')" "recorded as a removal"
assert_contains "$(json_get "$LA_JSON" 'd.summary')" "Removed: Codex plugin." "with its summary"
"$SH_BIN" "$W/current/scripts/install.sh" --home "$H" --add codex-plugin --from-app >"$SB/out.txt" 2>"$SB/err.txt" </dev/null
assert_eq "0" "$?" "an --add from the installed copy starts"
wait_action "$LA_JSON"
assert_eq "add done Added: Codex plugin." "$(json_get "$LA_JSON" 'd.action + " " + d.state + " " + d.summary')" "and is recorded"
assert_eq "1" "$(grep -c '^codex-plugin' "$W/install-manifest")" "the Codex plugin is back"

t_section "--from-app usage"
inst_from --from-app
assert_rc 2 "--from-app is only for --update and --add"
uninst --from-app
assert_rc 2 "the uninstaller wants --yes with it"
uninst --yes --from-app --dry-run
assert_rc 2 "and no dry run"

t_section "--from-app uninstall: survives a closed output, waits for the app, leaves no result behind"
printf 'history\n' >"$W/history.db"
# The caller stops reading at once (a pipe into `true`): the run is not tied to it.
"$SH_BIN" "$T_REPO/scripts/uninstall.sh" --home "$H" --yes --from-app 2>&1 </dev/null | true
wait_action "$LA_JSON"
fa_n=0
while [ -f "$W/install-manifest" ] && [ "$fa_n" -lt 120 ]; do fa_n=$((fa_n + 1)); sleep 0.25 2>/dev/null || sleep 1; done
assert_missing "$W/install-manifest" "the uninstall finished"
assert_missing "$H/.local/bin/wasitme" "the command is gone"
assert_file "$W/history.db" "the history is kept"
assert_missing "$W/state/last-action.json" "no result is left for an app that is gone"
assert_missing "$W/state/last-action.log" "nor its log"

if [ "$T_OS" = Darwin ]; then
  t_section "macOS --update: launchd's running copy is restarted by its LaunchAgent, nothing else is launched"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  W="$H/.wasitme"
  APP="$H/Applications/wasitme.app"
  LA="$H/Library/LaunchAgents"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "install the app and the scan agent"
  assert_eq "launchd" "$(cat "$SHIM_APP_STATE")" "the app runs (launchd started it: RunAtLoad)"
  make_fixture "$SB_SRC" 0.2.0 macos-fake
  : >"$SHIM_LOG"
  inst_from --update
  assert_rc 0 "update"
  assert_contains "$(shimlog)" "swift build -c release" "the app is rebuilt"
  assert_eq "0.2.0" "$(plist_get "$APP/Contents/Info.plist" CFBundleShortVersionString)" "the new app is in place"
  assert_eq "launchctl bootout gui/$T_UID/$LABEL_SCAN
launchctl print gui/$T_UID/$LABEL_SCAN
launchctl bootstrap gui/$T_UID $LA/$LABEL_SCAN.plist
launchctl bootout gui/$T_UID/$LABEL_APP
launchctl print gui/$T_UID/$LABEL_APP
launchctl bootstrap gui/$T_UID $LA/$LABEL_APP.plist" "$(grep '^launchctl' "$SHIM_LOG")" "the app's agent is unloaded for the swap and loaded again (which starts the new copy)"
  assert_not_contains "$(shimlog)" "open " "nothing is opened: launchd starts it"
  assert_not_contains "$(shimlog)" "pkill" "and nothing needed killing"
  assert_eq "launchd" "$(cat "$SHIM_APP_STATE")" "the new app runs"
  assert_eq "Updated wasitme 0.1.0 -> 0.2.0 (kept: scan agent, mac app). The app was restarted." "$(tail -n 1 "$T_OUT")" "the last line says so"
  assert_contains "$(out)" "$APP (restarted)" "and so does the result table"

  t_section "macOS --update: a copy the person opened is quit, and launchd starts the new one"
  printf 'user\n' >"$SHIM_APP_STATE"
  make_fixture "$SB_SRC" 0.3.0 macos-fake
  : >"$SHIM_LOG"
  inst_from --update
  assert_rc 0 "update"
  assert_contains "$(shimlog)" "pkill -U $T_UID -f $APP/Contents/MacOS/" "the opened copy is quit (only processes inside this exact bundle)"
  assert_eq "launchd" "$(cat "$SHIM_APP_STATE")" "one copy runs again, started by its LaunchAgent"
  assert_not_contains "$(shimlog)" "open " "so nothing is opened"

  t_section "macOS --update: when launchd does not start it, open -g does (background: focus never moves)"
  printf 'user\n' >"$SHIM_APP_STATE"
  make_fixture "$SB_SRC" 0.4.0 macos-fake
  : >"$SHIM_LOG"
  export SHIM_FAIL_LAUNCHCTL="bootstrap gui/$T_UID $LA/$LABEL_APP.plist"
  inst_from --update
  unset SHIM_FAIL_LAUNCHCTL
  assert_rc 0 "update (launchd's load fails: only a warning, it loads at the next login)"
  assert_contains "$(shimlog)" "open -g $APP" "the app is started with open -g"
  assert_eq "user" "$(cat "$SHIM_APP_STATE")" "and runs"
  assert_eq "The app was restarted." "$(tail -n 1 "$T_OUT" | sed 's/^.*\. The app/The app/')" "the last line says so"

  t_section "macOS --update: an app the person quit stays quit"
  rm -f "$SHIM_APP_STATE"
  make_fixture "$SB_SRC" 0.5.0 macos-fake
  : >"$SHIM_LOG"
  inst_from --update
  assert_rc 0 "update"
  assert_eq "0.5.0" "$(plist_get "$APP/Contents/Info.plist" CFBundleShortVersionString)" "the bundle is replaced"
  assert_eq "" "$(grep "^launchctl.*$LABEL_APP" "$SHIM_LOG")" "the app's agent is neither unloaded nor loaded (loading would start it)"
  assert_not_contains "$(shimlog)" "open " "nothing is opened"
  assert_not_contains "$(shimlog)" "pkill" "nothing is killed"
  assert_missing "$SHIM_APP_STATE" "the app is still not running"
  assert_contains "$(out)" "it was not running, so it was not started" "the result says why"
  assert_eq "Updated wasitme 0.4.0 -> 0.5.0 (kept: scan agent, mac app)." "$(tail -n 1 "$T_OUT")" "no restart is claimed"
  assert_file "$LA/$LABEL_APP.plist" "its LaunchAgent is still there (it starts at the next login)"
  assert_eq "$LABEL_APP" "$(json_get "$W/engine.json" 'd.appLabel')" "and engine.json still names it"

  t_section "macOS --update: an app that ignores TERM is stopped with KILL after the wait"
  printf 'user\n' >"$SHIM_APP_STATE"
  make_fixture "$SB_SRC" 0.6.0 macos-fake
  : >"$SHIM_LOG"
  export SHIM_APP_STUBBORN=1 WASITME_APP_QUIT_WAIT=2
  inst_from --update
  unset SHIM_APP_STUBBORN WASITME_APP_QUIT_WAIT
  assert_rc 0 "update"
  assert_contains "$(shimlog)" "pkill -KILL -U $T_UID -f $APP/Contents/MacOS/" "KILL after TERM did not do it"
  assert_contains "$(err)" "did not quit within 1 seconds" "said plainly"
  assert_eq "launchd" "$(cat "$SHIM_APP_STATE")" "and the new copy runs"

  t_section "macOS --update: a failure after the swap puts the old app back and starts it again"
  printf 'previous\n' >"$APP/Contents/marker.txt"
  make_fixture "$SB_SRC" 0.7.0 macos-fake
  : >"$SHIM_LOG"
  export SHIM_FAIL_CODESIGN="Applications/wasitme.app"
  inst_from --update
  unset SHIM_FAIL_CODESIGN
  assert_rc 3 "the app part fails; the rest is updated"
  assert_file "$APP/Contents/marker.txt" "the previous app is back"
  assert_eq "launchd" "$(cat "$SHIM_APP_STATE")" "and running (its LaunchAgent was loaded again)"
  assert_contains "$(tail -n 1 "$T_OUT")" "but a part failed and was rolled back" "the last line says so"
  assert_contains "$(tail -n 1 "$T_OUT")" "The app was restarted." "and that the app runs again"

  t_section "macOS --update --no-relaunch: launchd's running copy is quit and its agent is not loaded again"
  rm -f "$APP/Contents/marker.txt"
  printf 'launchd\n' >"$SHIM_APP_STATE"
  make_fixture "$SB_SRC" 0.8.0 macos-fake
  : >"$SHIM_LOG"
  inst_from --update --no-relaunch
  assert_rc 0 "update"
  assert_eq "0.8.0" "$(plist_get "$APP/Contents/Info.plist" CFBundleShortVersionString)" "the new app is in place"
  assert_contains "$(shimlog)" "launchctl bootout gui/$T_UID/$LABEL_APP" "the running copy is stopped for the swap"
  assert_not_contains "$(shimlog)" "launchctl bootstrap gui/$T_UID $LA/$LABEL_APP.plist" "its agent is not loaded again (that would start it)"
  assert_not_contains "$(shimlog)" "open " "nothing is opened"
  assert_missing "$SHIM_APP_STATE" "the app is not running"
  assert_file_has "$LA/$LABEL_APP.plist" "$APP/Contents/MacOS/" "its LaunchAgent is in place for the next login"
  assert_eq "$LABEL_APP" "$(json_get "$W/engine.json" 'd.appLabel')" "and engine.json still names it"
  assert_contains "$(out)" "left closed: --no-relaunch" "the result says so"
  assert_eq "Updated wasitme 0.7.0 -> 0.8.0 (kept: scan agent, mac app). The app was quit for the update and left closed (--no-relaunch); open it from $H/Applications when you want it." "$(tail -n 1 "$T_OUT")" "and so does the last line"

  t_section "macOS --update --no-relaunch: a copy the person opened is quit and not opened again"
  printf 'user\n' >"$SHIM_APP_STATE"
  make_fixture "$SB_SRC" 0.9.0 macos-fake
  : >"$SHIM_LOG"
  inst_from --update --no-relaunch
  assert_rc 0 "update"
  assert_contains "$(shimlog)" "pkill -U $T_UID -f $APP/Contents/MacOS/" "the opened copy is quit"
  assert_not_contains "$(shimlog)" "launchctl bootstrap gui/$T_UID $LA/$LABEL_APP.plist" "launchd is not asked to start it"
  assert_not_contains "$(shimlog)" "open " "and nothing is opened"
  assert_missing "$SHIM_APP_STATE" "the app is not running"

  t_section "macOS --update --no-relaunch: a failure after the swap puts the old app back without starting it"
  printf 'launchd\n' >"$SHIM_APP_STATE"
  printf 'previous\n' >"$APP/Contents/marker.txt"
  make_fixture "$SB_SRC" 0.10.0 macos-fake
  : >"$SHIM_LOG"
  export SHIM_FAIL_CODESIGN="Applications/wasitme.app"
  inst_from --update --no-relaunch
  unset SHIM_FAIL_CODESIGN
  assert_rc 3 "the app part fails"
  assert_file "$APP/Contents/marker.txt" "the previous app is back"
  assert_not_contains "$(shimlog)" "launchctl bootstrap gui/$T_UID $LA/$LABEL_APP.plist" "its agent is not loaded again"
  assert_not_contains "$(shimlog)" "open " "nothing is opened"
  assert_missing "$SHIM_APP_STATE" "the app stays closed"
  rm -f "$APP/Contents/marker.txt"

  t_section "macOS --from-app uninstall: waits for the app to quit, then removes it"
  printf 'launchd\n' >"$SHIM_APP_STATE"
  : >"$SHIM_LOG"
  export WASITME_APP_QUIT_WAIT=2
  uninst --yes --from-app
  assert_rc 0 "started"
  wait_action "$W/state/last-action.json"
  fa_n=0
  while [ -f "$W/install-manifest" ] && [ "$fa_n" -lt 120 ]; do fa_n=$((fa_n + 1)); sleep 0.25 2>/dev/null || sleep 1; done
  unset WASITME_APP_QUIT_WAIT
  assert_missing "$APP" "the app is gone"
  assert_eq "pgrep
pgrep
launchctl bootout" "$(grep -E '^(pgrep|launchctl bootout|pkill)' "$SHIM_LOG" | head -n 3 | cut -d' ' -f1-2 | sed 's/ -U$//')" "it asked whether the app was still running (twice: WASITME_APP_QUIT_WAIT=2) before unloading anything"
  assert_missing "$SHIM_APP_STATE" "and the app is not running"
fi

t_done
