#!/bin/sh
# Uninstall reverses what the installer created and only that; user data and foreign files are left alone.
# T_RC is set in this file and read by assert_rc in harness.sh. The linter looks at one file at a time
# and would call it unused (SC2034); this single directive, before the first command, covers the file.
# shellcheck disable=SC2034
. "$(dirname "$0")/harness.sh"

t_section "full round trip (engine, plugins, status line)"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{\n    "theme": "dark"\n}\n' >"$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$SB/settings.orig"
PRE=$(tree_of "$H")
inst_from --yes --no-app --no-scan-agent --agents claude-code,codex
assert_rc 0 "install"
: >"$SHIM_LOG"
uninst
assert_rc 0 "uninstall succeeds"
assert_eq "claude plugin uninstall wasitme@wasitme
claude plugin marketplace remove wasitme
codex plugin remove wasitme@wasitme-codex
codex plugin marketplace remove wasitme-codex" "$(shimlog)" "order: Claude plugin, its marketplace, (status line), Codex plugin BEFORE its marketplace (D49)"
assert_same_file "$SB/settings.orig" "$H/.claude/settings.json" "settings.json is restored byte-for-byte"
assert_eq "$PRE" "$(tree_of "$H")" "the home is exactly as it was before the install (backup consumed, folders removed)"
assert_contains "$(out)" "restored" "the restore is reported"
assert_contains "$(out)" "wasitme has been removed" "final message"
assert_contains "$(out)" "Your agent logs were never modified." "and the closing line"

t_section "idempotent"
uninst
assert_rc 0 "second uninstall succeeds"
assert_contains "$(out)" "Nothing to uninstall" "says there is nothing to do"
assert_eq "$PRE" "$(tree_of "$H")" "and changes nothing"

t_section "history is kept; --purge deletes it"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $CORE_ONLY
printf 'history\n' >"$H/.wasitme/history.db"
printf 'salt\n' >"$H/.wasitme/salt"
mkdir -p "$H/.wasitme/snapshots"
printf '{}\n' >"$H/.wasitme/snapshots/a.json"
uninst
assert_rc 0 "uninstall keeps history"
assert_file "$H/.wasitme/history.db" "history.db kept"
assert_file "$H/.wasitme/salt" "salt kept"
assert_file "$H/.wasitme/snapshots/a.json" "snapshots kept"
assert_missing "$H/.wasitme/engine.json" "engine.json removed (the installer made it)"
assert_missing "$H/.wasitme/install-manifest" "manifest removed"
assert_missing "$H/.wasitme/versions" "pinned plugin copies removed"
assert_missing "$H/.local" "the engine, shim and the folders made for them are removed"
assert_contains "$(out)" "was kept" "output says the history was kept"
# The uninstaller just deleted itself (it lived in ~/.wasitme/current): the advice must be something that still works.
assert_contains "$(out)" "To delete it as well:  rm -rf $H/.wasitme" "the way to delete the history later is a plain command"
assert_not_contains "$(out)" "Add --purge" "not '--purge' for an uninstaller that no longer exists"
# The source tree's uninstaller can still purge what was kept: wasitme's own data, no installed code left.
uninst --purge
assert_rc 2 "a leftover-history purge without a terminal and without --yes is refused"
assert_file "$H/.wasitme/history.db" "nothing was deleted"
uninst --purge --yes --dry-run
assert_rc 0 "dry run of the leftover purge"
assert_file "$H/.wasitme/history.db" "the dry run deleted nothing"
uninst --purge --yes
assert_rc 0 "--purge --yes on the history an uninstall kept"
assert_contains "$(out)" "the history an earlier uninstall kept" "says what it deleted"
assert_missing "$H/.wasitme" "the kept history is gone"
mkdir -p "$H/.wasitme/versions"
printf 'salt\n' >"$H/.wasitme/salt"
uninst --purge --yes
assert_rc 0 "no manifest but installed code: not purged"
assert_file "$H/.wasitme/salt" "a folder that still holds installed code is never purged without its manifest"
rm -rf "$H/.wasitme"
mkdir -p "$H/.wasitme"
printf 'unrelated\n' >"$H/.wasitme/notes.txt"
uninst --purge --yes
assert_file "$H/.wasitme/notes.txt" "a folder without wasitme's data is not purged"
assert_contains "$(out)" "does not look like history" "and the reason is given"

sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $CORE_ONLY
printf 'history\n' >"$H/.wasitme/history.db"
uninst --purge
assert_rc 2 "--purge without a terminal and without --yes is refused"
assert_contains "$(err)" "add --yes" "message explains"
assert_file "$H/.wasitme/history.db" "nothing was deleted"
assert_file "$H/.local/bin/wasitme" "nothing was uninstalled either"
uninst --purge --yes
assert_rc 0 "--purge --yes"
assert_missing "$H/.wasitme" "the whole ~/.wasitme is gone"
assert_missing "$H/.local" "and the install"

t_section "--purge asks a human first"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $CORE_ONLY
printf 'history\n' >"$H/.wasitme/history.db"
printf 'n\n' >"$SB/answers.txt"
export WASITME_TTY="$SB/answers.txt"
uninst --purge
assert_rc 0 "answering no cancels"
assert_contains "$(out)" "permanently delete" "the question says what will be deleted"
assert_contains "$(out)" "Nothing was changed" "and that nothing happened"
assert_file "$H/.wasitme/history.db" "history kept"
assert_file "$H/.local/bin/wasitme" "install kept"
printf 'y\n' >"$SB/answers.txt"
uninst --purge
assert_rc 0 "answering yes proceeds"
assert_missing "$H/.wasitme" "history deleted"
assert_missing "$H/.local" "install removed"
unset WASITME_TTY

t_section "dry run"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{"theme":"dark"}\n' >"$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --agents claude-code,codex
BEFORE=$(tree_of "$H")
SUM=$(shasum "$H/.claude/settings.json")
: >"$SHIM_LOG"
uninst --dry-run
assert_rc 0 "uninstall --dry-run"
assert_eq "$BEFORE" "$(tree_of "$H")" "nothing was removed"
assert_eq "$SUM" "$(shasum "$H/.claude/settings.json")" "settings.json untouched"
assert_eq "0" "$(count_lines "$SHIM_LOG")" "no tool was run"
assert_contains "$(out)" "[dry-run] chmod -R u+w $H/.wasitme/versions/0.1.0 && rm -rf $H/.wasitme/versions/0.1.0" "the (read-only) version directory removal is planned"
assert_contains "$(out)" "[dry-run] claude plugin uninstall wasitme@wasitme" "the plugin removal is planned"
assert_contains "$(out)" "[dry-run] codex plugin remove wasitme@wasitme-codex" "the codex removal is planned"
assert_contains "$(out)" "statusline-restore" "the settings.json restore is planned"
assert_contains "$(out)" "Dry run: nothing was removed" "says so"

t_section "the user edited settings.json after the install"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{\n    "theme": "dark"\n}\n' >"$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.addedLater="keep me";fs.writeFileSync(f,JSON.stringify(d,null,4)+"\n")' "$H/.claude/settings.json"
uninst
assert_rc 0 "uninstall succeeds"
assert_eq "keep me" "$(json_get "$H/.claude/settings.json" 'd.addedLater')" "the user's later edit survives"
assert_eq "dark" "$(json_get "$H/.claude/settings.json" 'd.theme')" "and the original content"
assert_eq "undefined" "$(json_get "$H/.claude/settings.json" 'd.statusLine')" "only our statusLine was removed"
assert_contains "$(out)" "the file changed after the install" "the user is told why it was a surgical removal"
assert_eq "1" "$(count_glob "$H/.claude"/*wasitme-bak*)" "the backup is kept because the file could not be restored exactly"

t_section "the user replaced our status line"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{"theme":"dark"}\n' >"$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.statusLine={type:"command",command:"my-own"};fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")' "$H/.claude/settings.json"
uninst
assert_rc 0 "uninstall succeeds"
assert_eq "my-own" "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')" "their status line is left alone"
assert_contains "$(out)" "left $H/.claude/settings.json alone" "and the user is told"
assert_eq "" "$(grep 'statusline uninstall' "$SHIM_ENGINE_LOG" 2>/dev/null)" "the engine is not asked to undo a status line that is not wasitme's"

t_section "a status line that 'wasitme statusline install' wrapped is handed back to the engine before it goes"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{"statusLine":{"type":"command","command":"ccstatusline"}}\n' >"$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "install leaves the user's status line alone"
# What the engine's `wasitme statusline install` does (it also keeps the old command in ~/.wasitme/backups): the edit
# is not in the install manifest.
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.statusLine={type:"command",command:process.argv[2],padding:0};fs.writeFileSync(f,JSON.stringify(d)+"\n")' "$H/.claude/settings.json" "$H/.local/bin/wasitme-statusline"
uninst --dry-run
assert_contains "$(out)" "statusline uninstall --script $H/.local/bin/wasitme-statusline --claude-dir $H/.claude" "the dry run shows the engine call"
uninst --yes
assert_rc 0 "uninstall succeeds"
assert_contains "$(cat "$SHIM_ENGINE_LOG")" "engine statusline uninstall --script $H/.local/bin/wasitme-statusline --claude-dir $H/.claude" "the engine undid its own edit while it was still installed"
assert_missing "$H/.local/bin/wasitme-statusline" "then the shim went"

t_section "uninstalling when claude and codex are gone does not dead-end"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from --yes --no-app --no-scan-agent --no-statusline --agents claude-code,codex
assert_rc 0 "install with both plugins"
export WASITME_CLAUDE="$SB/nonexistent/claude" WASITME_CODEX="$SB/nonexistent/codex"
uninst
assert_rc 0 "uninstall still completes"
assert_contains "$(err)" "claude plugin uninstall wasitme@wasitme" "the manual claude commands are printed"
assert_missing "$H/.local" "everything else was removed"
assert_missing "$H/.wasitme" "including ~/.wasitme (no history existed)"

t_section "no codex command: wasitme's two config.toml tables are removed exactly (the PRIVACY.md fallback)"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.codex"
printf '# my codex config
model = "x"
notify = ["say"] # keep

[mcp_servers.demo]
command = "demo"
env = { A = "1" }
' >"$H/.codex/config.toml"
chmod 600 "$H/.codex/config.toml"
cp "$H/.codex/config.toml" "$SB/config.orig"
inst_from --yes --no-app --no-scan-agent --no-statusline --no-claude-plugin --agents codex
assert_rc 0 "install with the codex plugin"
VR=$(cd -P "$H/.wasitme/versions/0.1.0" && pwd -P)
printf '
[marketplaces.wasitme-codex]
source_type = "local"
source = "%s/plugin-codex"

[plugins."wasitme@wasitme-codex"]
enabled = true
' "$VR" >>"$H/.codex/config.toml"
printf '
[profiles.mine]
model = "y"
' >>"$H/.codex/config.toml"
export WASITME_CODEX="$SB/nonexistent/codex"
uninst
assert_rc 0 "uninstall without the codex command"
assert_eq "$(cat "$SB/config.orig")

[profiles.mine]
model = \"y\"" "$(cat "$H/.codex/config.toml")" "exactly wasitme's two tables are gone; every other line is kept"
assert_eq "-rw-------" "$(ls -l "$H/.codex/config.toml" | cut -c1-10)" "the file keeps its mode"
assert_contains "$(out)" "removed wasitme's" "the edit is reported"
assert_eq "0" "$(ls -A "$SB/tmp" | wc -l | tr -d ' ')" "the byte copy kept during the edit is gone"

t_section "a settings.json that we created is deleted again"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --statusline --agents claude-code
assert_file "$H/.claude/settings.json" "created by the install"
uninst
assert_rc 0 "uninstall"
assert_missing "$H/.claude" "the file and the folder we created are gone"

t_section "things that are not ours are left alone"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $CORE_ONLY
printf '#!/bin/sh\necho mine\n' >"$H/.local/bin/wasitme"      # the user replaced our shim afterwards
uninst
assert_rc 1 "uninstall reports it could not remove the command"
assert_eq "mine" "$("$H/.local/bin/wasitme")" "the replaced command is untouched"
assert_contains "$(err)" "is not the file wasitme wrote" "and why"
assert_file "$H/.wasitme/install-manifest" "the manifest is kept so a re-run can finish the job"
assert_missing "$H/.wasitme/versions/0.1.0" "everything else was still removed"
rm "$H/.local/bin/wasitme"
uninst
assert_rc 0 "re-run after the user removed it finishes the job"
assert_missing "$H/.local" "all gone"

t_section "a tampered manifest cannot delete anything outside the install locations"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $CORE_ONLY
mkdir -p "$SB/outside/precious"
printf 'keep\n' >"$SB/outside/precious/file.txt"
printf 'keep\n' >"$SB/outside/loose.txt"
{
  printf 'dir\t%s\n' "$SB/outside/precious"
  printf 'dir\t%s\n' "$H/.local/share/wasitme/../../../outside/precious"
  printf 'dir\t%s\n' "$H"
  printf 'dir\t/\n'
  printf 'file\t%s\n' "$SB/outside/loose.txt"
  printf 'shim\t%s\n' "$SB/outside/loose.txt"
  printf 'symlink\t%s\n' "$SB/outside/loose.txt"
  printf 'app\t%s\n' "$SB/outside/precious"
  printf 'launchagent\t--evil\t%s\n' "$SB/outside/loose.txt"
  printf 'claude-plugin\t--evil@x\twasitme\n'
  printf 'statusline\t%s\t-\tdeadbeef\tcmd\n' "$SB/outside/loose.txt"
} >>"$H/.wasitme/install-manifest"
: >"$SHIM_LOG"
uninst
assert_rc 1 "tampered entries make the uninstaller report a problem"
assert_file "$SB/outside/precious/file.txt" "a directory outside HOME/prefix was not deleted"
assert_file "$SB/outside/loose.txt" "a file outside ~/.wasitme was not deleted"
assert_dir "$H" "HOME itself was not deleted"
assert_eq "0" "$(count_lines "$SHIM_LOG")" "no tool was run with a tampered argument"
assert_contains "$(err)" "ignoring" "the ignored entries are reported"

t_section "an install made with two different prefixes inside the home"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
PRE=$(tree_of "$H")
inst_from $CORE_ONLY
assert_rc 0 "install with the default prefix"
inst_from $CORE_ONLY --prefix "$H/pfx2"
assert_rc 0 "install again with --prefix inside the home"
assert_file "$H/pfx2/bin/wasitme" "both commands exist"
assert_file "$H/.local/bin/wasitme" "(the first one too)"
uninst
assert_rc 0 "one uninstall removes both (the manifest has a prefix line for each)"
assert_eq "" "$(err)" "without a single warning"
assert_eq "$PRE" "$(tree_of "$H")" "the home is exactly as it was"
assert_missing "$H/.wasitme/install-manifest" "the record is gone, so nothing is left to retry"

t_section "an install made with two different prefixes outside the home"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $CORE_ONLY --prefix "$SB/pfxA"
inst_from $CORE_ONLY --prefix "$SB/pfxB"
assert_rc 0 "second install"
uninst --prefix "$SB/pfxA"
assert_rc 1 "naming one prefix cannot remove the other (outside the home is only trusted when named)"
assert_contains "$(err)" "run the uninstaller again with --prefix $SB/pfxB" "and the message says exactly what to type"
assert_missing "$SB/pfxA/bin/wasitme" "the named prefix's command was removed"
assert_file "$SB/pfxB/bin/wasitme" "the other one is untouched"
uninst --prefix "$SB/pfxB"
assert_rc 0 "naming the other finishes the job; the entries already removed are not an error"
assert_missing "$SB/pfxB" "both are gone"
assert_missing "$H/.wasitme/install-manifest" "and so is the record"

t_section "a manifest from an installer before D46 (~/.local/share/wasitme) is still uninstalled"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
PRE=$(tree_of "$H")
inst_from $CORE_ONLY
L="$H/.local/share/wasitme"
mkdir -p "$L/0.0.9/dist/src/cli"
printf 'old\n' >"$L/0.0.9/dist/src/cli/main.js"
ln -s 0.0.9 "$L/current"
{
  printf 'createddir\t%s\n' "$H/.local/share"
  printf 'createddir\t%s\n' "$L"
  printf 'dir\t%s\n' "$L/0.0.9"
  printf 'symlink\t%s\n' "$L/current"
} >>"$H/.wasitme/install-manifest"
uninst
assert_rc 0 "uninstall"
assert_eq "$PRE" "$(tree_of "$H")" "the old layout's folders and the new one are all gone"

t_section "on a terminal it asks before each part, then about the history"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{"theme":"dark"}\n' >"$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --agents claude-code,codex
printf 'history\n' >"$H/.wasitme/history.db"
printf 'n\ny\ny\n' >"$SB/answers.txt"
export WASITME_TTY="$SB/answers.txt"
: >"$SHIM_LOG"
uninst
assert_rc 0 "keeping the Claude Code plugin"
assert_contains "$(out)" "Remove the Claude Code plugin?" "asked about the Claude plugin"
assert_contains "$(out)" "Restore your Claude Code status line" "the status line"
assert_contains "$(out)" "Remove the Codex plugin?" "and the Codex plugin"
assert_not_contains "$(shimlog)" "claude plugin" "the kept plugin was not touched"
assert_contains "$(shimlog)" "codex plugin remove wasitme@wasitme-codex" "the others were removed"
assert_eq "undefined" "$(json_get "$H/.claude/settings.json" 'd.statusLine')" "the status line was restored"
assert_contains "$(out)" "Kept: Claude Code plugin" "the summary names what was kept"
assert_file "$H/.wasitme/current/engine/dist/src/cli/main.js" "the engine stays, because the kept plugin runs from it"
assert_file_has "$H/.wasitme/install-manifest" "claude-plugin" "the manifest still lists the kept plugin"
assert_file_lacks "$H/.wasitme/install-manifest" "codex-plugin" "and no longer the removed one"
assert_file_lacks "$H/.wasitme/install-manifest" "$(printf 'statusline\t')" "nor the restored status line"
assert_not_contains "$(out)" "History (" "no history question while something stays"
printf 'y\nd\n' >"$SB/answers.txt"
: >"$SHIM_LOG"
uninst
assert_rc 0 "second run: remove the rest, delete the history"
assert_eq "claude plugin uninstall wasitme@wasitme
claude plugin marketplace remove wasitme" "$(shimlog)" "now the Claude plugin goes"
assert_contains "$(out)" "[k]eep (default) / [d]elete permanently" "the history question"
assert_missing "$H/.wasitme" "d deletes the history"
assert_missing "$H/.local" "and everything else is gone"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $CORE_ONLY
printf 'history\n' >"$H/.wasitme/history.db"
printf '\n' >"$SB/answers.txt"
export WASITME_TTY="$SB/answers.txt"
uninst
assert_rc 0 "Enter keeps the history"
assert_file "$H/.wasitme/history.db" "kept"
printf '' >"$SB/answers.txt"
inst_from $CORE_ONLY
mkdir -p "$H/.claude"
inst_from --yes --no-app --no-scan-agent --no-codex-plugin --agents claude-code
uninst
assert_rc 1 "running out of answers stops before anything is removed"
assert_file "$H/.wasitme/current/engine/dist/src/cli/main.js" "nothing was removed"
unset WASITME_TTY

t_section "run from the installed copy, which deletes the folder it runs from"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $CORE_ONLY
T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
WASITME_TTY="$SB/no-tty" PATH="$SB/shims:$BASE_PATH" "$SH_BIN" "$H/.wasitme/current/scripts/uninstall.sh" --home "$H" >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 0 "uninstall.sh from the installed copy works"
assert_missing "$H/.local" "and removed the command"
assert_missing "$H/.wasitme" "and the read-only copy it was running from"
assert_contains "$(out)" "wasitme has been removed" "and finished cleanly"

if [ "$T_OS" = Darwin ]; then
  t_section "macOS: app, agents, logs"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  LA="$H/Library/LaunchAgents"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "install with app and agents"
  mkdir -p "$H/.wasitme"
  printf 'log\n' >"$H/.wasitme/logs/scan.log"
  printf 'log\n' >"$H/.wasitme/logs/app.log"
  : >"$SHIM_LOG"
  uninst
  assert_rc 0 "uninstall"
  assert_eq "launchctl bootout gui/$T_UID/$LABEL_SCAN
launchctl bootout gui/$T_UID/$LABEL_APP
pkill -U $T_UID -f $H/Applications/wasitme.app/Contents/MacOS/" "$(shimlog)" "both agents are unloaded, then a copy the person opened is quit (only processes inside this exact bundle)"
  assert_missing "$LA/$LABEL_SCAN.plist" "scan plist removed"
  assert_missing "$LA/$LABEL_APP.plist" "app plist removed"
  assert_missing "$H/Applications" "the app and the Applications folder we made are removed"
  assert_missing "$H/Library" "the Library/LaunchAgents folders we made are removed"
  assert_missing "$H/.wasitme" "logs and the private folder we made are removed (no history existed)"
  assert_missing "$H/.local" "engine removed"
  assert_eq "." "$(tree_of "$H")" "the home is empty again"

  t_section "macOS: pre-existing Applications and LaunchAgents folders survive"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  mkdir -p "$H/Applications/Other.app" "$H/Library/LaunchAgents"
  printf 'x\n' >"$H/Library/LaunchAgents/com.other.plist"
  PRE=$(tree_of "$H")
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "install"
  uninst
  assert_rc 0 "uninstall"
  assert_eq "$PRE" "$(tree_of "$H")" "other apps and agents, and the folders that held them, are untouched"

  t_section "macOS: an app that is no longer ours is left alone"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  printf '<plist>replaced</plist>\n' >"$H/Applications/wasitme.app/Contents/Info.plist"
  uninst
  assert_rc 1 "reported"
  assert_contains "$(err)" "is not the wasitme app any more" "message explains"
  assert_dir "$H/Applications/wasitme.app" "the app is still there"
fi

t_done
