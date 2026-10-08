#!/bin/sh
# One part at a time (the Control Center's Add and Remove buttons): `uninstall.sh --only PART` removes exactly that part
# the way the full uninstall removes it and leaves everything else byte for byte; `install.sh --add PART` puts one part
# back into the installed version. The install record (manifest), engine.json and engine.env stay consistent with what is
# really there. Temp homes and recording shims only (claude and codex are the stateful stand-ins of fake-agents.mjs).
# T_RC is set in this file and read by assert_rc in harness.sh. The linter looks at one file at a time
# and would call it unused (SC2034); this single directive, before the first command, covers the file.
# shellcheck disable=SC2034
. "$(dirname "$0")/harness.sh"

# inst_cur ARGS...: the installer of the INSTALLED copy (~/.wasitme/current/scripts/install.sh), as the app runs it.
inst_cur() {
  T_OUT="$SB/out.txt"
  T_ERR="$SB/err.txt"
  WASITME_TTY="$SB/no-tty" PATH="$SB/shims:$BASE_PATH" "$SH_BIN" "$SB_HOME/.wasitme/current/scripts/install.sh" --home "$SB_HOME" "$@" >"$T_OUT" 2>"$T_ERR" </dev/null
  T_RC=$?
}
mf_sorted() { sort "$SB_HOME/.wasitme/install-manifest"; }
mf_without() { sort "$SB/manifest.before" | awk -F '\t' -v k="$1" '$1 != k'; }   # mf_without KIND
mf_save() { cp "$SB_HOME/.wasitme/install-manifest" "$SB/manifest.before"; }
last_line() { tail -n 1 "$T_OUT"; }

t_section "--only codex-plugin: the Codex plugin goes; the manifest loses exactly its line; everything else stays"
sb_new
export SHIM_STATEFUL=1
H=$SB_HOME
W="$H/.wasitme"
mkdir -p "$H/.claude" "$H/.codex"
printf '{\n    "theme": "dark"\n}\n' >"$H/.claude/settings.json"
printf '# my codex config\nmodel = "gpt-x"\n' >"$H/.codex/config.toml"
cp "$H/.codex/config.toml" "$SB/config.seed"
make_fixture "$SB_SRC" 0.1.0
inst_from --yes --no-app --no-scan-agent --agents claude-code,codex --claude-plugin --codex-plugin --statusline
assert_rc 0 "install: both plugins and the status line"
mf_save
M0=$(mf_sorted)
cp "$W/engine.json" "$SB/engine.json.0"
cp "$W/engine.env" "$SB/engine.env.0"
fs_snapshot "$H/.claude" >"$SB/claude.0"
: >"$SHIM_LOG"
uninst --yes --only codex-plugin
assert_rc 0 "removed"
assert_eq "codex plugin remove wasitme@wasitme-codex
codex plugin marketplace remove wasitme-codex" "$(shimlog)" "the Codex plugin, then its marketplace (D49); nothing else is called"
assert_eq "Removed: Codex plugin. The rest of wasitme stays installed (to add a part back: sh $W/current/scripts/install.sh --add PART)." "$(last_line)" "one-line summary"
assert_eq "$(mf_without codex-plugin)" "$(mf_sorted)" "the manifest lost exactly the codex-plugin line"
assert_same_file "$SB/config.seed" "$H/.codex/config.toml" "config.toml is the seed again, byte for byte"
assert_same_file "$SB/engine.json.0" "$W/engine.json" "engine.json is untouched (it names no plugin)"
assert_same_file "$SB/engine.env.0" "$W/engine.env" "and so is engine.env"
fs_snapshot "$H/.claude" >"$SB/claude.1"
assert_same_file "$SB/claude.0" "$SB/claude.1" "Claude Code's folder (plugin, status line, settings) is byte-identical"
assert_link "$W/current" "versions/0.1.0" "the engine stays"
assert_file "$H/.local/bin/wasitme" "and so does the command"

: >"$SHIM_LOG"
uninst --yes --only codex-plugin
assert_rc 0 "removing it again is not an error"
assert_eq "Nothing to remove: wasitme's Codex plugin is not installed here." "$(last_line)" "and says why"
assert_eq "" "$(shimlog)" "nothing is called"

t_section "--add codex-plugin (from the installed copy): back as it was, nothing else changes"
: >"$SHIM_LOG"
inst_cur --add codex-plugin
assert_rc 0 "added"
assert_eq "Added: Codex plugin." "$(last_line)" "one-line summary"
assert_eq "$M0" "$(mf_sorted)" "the manifest is what the install wrote"
assert_same_file "$SB/engine.json.0" "$W/engine.json" "engine.json is byte-identical"
assert_contains "$(shimlog)" "codex plugin add wasitme@wasitme-codex" "Codex got the plugin"
assert_not_contains "$(shimlog)" "claude plugin" "Claude Code is not touched"
assert_eq "0.1.0" "$(ls "$W/versions")" "no new version folder"
fs_snapshot "$H/.claude" >"$SB/claude.2"
assert_same_file "$SB/claude.0" "$SB/claude.2" "Claude Code's folder is still byte-identical"
: >"$SHIM_LOG"
inst_cur --add codex-plugin
assert_rc 0 "adding it again"
assert_eq "Already installed: Codex plugin. Nothing was changed." "$(last_line)" "is a no-op that says so"
assert_eq "" "$(shimlog)" "and calls nothing"
assert_eq "$M0" "$(mf_sorted)" "the manifest is unchanged"

t_section "--only claude-plugin, then --add it back"
: >"$SHIM_LOG"
uninst --yes --only claude-plugin
assert_rc 0 "removed"
assert_eq "claude plugin uninstall wasitme@wasitme
claude plugin marketplace remove wasitme" "$(shimlog)" "the plugin, then its marketplace"
assert_eq "$(mf_without claude-plugin)" "$(mf_sorted)" "the manifest lost exactly the claude-plugin line"
assert_eq "$H/.local/bin/wasitme-statusline" "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')" "the status line stays"
assert_eq "gone" "$(node -e 'let d = {}; try { d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {} console.log(d["wasitme@wasitme"] === undefined ? "gone" : "there");' "$H/.claude/plugins/installed_plugins.json")" "Claude Code no longer has the plugin"
inst_cur --add claude-plugin
assert_rc 0 "added back"
assert_eq "$M0" "$(mf_sorted)" "the manifest is what the install wrote"
assert_eq "0.1.0" "$(json_get "$H/.claude/plugins/installed_plugins.json" 'd["wasitme@wasitme"].version')" "Claude Code has it again"
assert_eq "$W/glance.json" "$(json_get "$H/.claude/settings.json" 'd.pluginConfigs["wasitme@wasitme"].options.glancePath')" "configured as at install (D50)"

t_section "--only statusline, then --add it back"
uninst --yes --only statusline
assert_rc 0 "removed"
assert_eq "undefined" "$(json_get "$H/.claude/settings.json" 'd.statusLine')" "the statusLine key is gone"
assert_eq "dark" "$(json_get "$H/.claude/settings.json" 'd.theme')" "the rest of settings.json stays"
assert_contains "$(out)" "only that key was removed" "Claude Code wrote its plugin keys after the backup, so only our key goes (the checksum rule)"
assert_eq "$(mf_without statusline)" "$(mf_sorted)" "the manifest lost exactly the statusline line"
assert_file "$H/.local/bin/wasitme-statusline" "the status-line command stays with the engine"
inst_cur --add statusline
assert_rc 0 "added back"
assert_eq "$H/.local/bin/wasitme-statusline" "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')" "the status line is back"
assert_eq "1" "$(grep -c '^statusline' "$W/install-manifest")" "recorded once"

t_section "two parts in one call; then the full uninstall still converges"
: >"$SHIM_LOG"
uninst --yes --only codex-plugin,claude-plugin,codex-plugin
assert_rc 0 "removed both"
assert_eq "Removed: Codex plugin, Claude Code plugin. The rest of wasitme stays installed (to add a part back: sh $W/current/scripts/install.sh --add PART)." "$(last_line)" "each part once, in the order given"
assert_eq "0" "$(grep -c 'plugin' "$W/install-manifest")" "no plugin is recorded any more"
uninst --yes
assert_rc 0 "full uninstall"
assert_missing "$W/install-manifest" "the record is gone"
assert_missing "$W/versions" "and the versions"
assert_missing "$H/.local" "and the command"
assert_same_file "$SB/config.seed" "$H/.codex/config.toml" "config.toml is the seed"
assert_eq "undefined" "$(json_get "$H/.claude/settings.json" 'd.statusLine')" "no status line is left"
unset SHIM_STATEFUL

t_section "--only statusline follows the checksum rules: restored byte for byte when nothing else changed"
sb_new
H=$SB_HOME
W="$H/.wasitme"
make_fixture "$SB_SRC" 0.1.0
mkdir -p "$H/.claude"
printf '{\n    "theme": "dark"\n}\n' >"$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$SB/settings.orig"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code --statusline
assert_rc 0 "install the status line"
uninst --yes --only statusline
assert_rc 0 "removed"
assert_same_file "$SB/settings.orig" "$H/.claude/settings.json" "settings.json is restored byte for byte"
assert_eq "0" "$(count_glob "$H/.claude"/*wasitme-bak*)" "the backup was used up"
assert_contains "$(out)" "exactly as it was before wasitme" "and the restore is reported"
assert_eq "0" "$(grep -c '^statusline' "$W/install-manifest")" "no statusline line is left"

t_section "--only statusline: the person edited settings.json since, so only our key goes and the backup stays"
inst_cur --add statusline
assert_rc 0 "added back"
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.addedLater="keep me";fs.writeFileSync(f,JSON.stringify(d,null,4)+"\n")' "$H/.claude/settings.json"
uninst --yes --only statusline
assert_rc 0 "removed"
assert_eq "keep me|dark|undefined" "$(json_get "$H/.claude/settings.json" '[d.addedLater, d.theme, d.statusLine].map(String).join("|")')" "their edit and the original stay; only statusLine is gone"
assert_eq "1" "$(count_glob "$H/.claude"/*wasitme-bak*)" "the backup is kept (the file could not be restored exactly)"

t_section "--only statusline: a status line that is no longer ours is left alone"
rm -f "$H/.claude"/settings.json.wasitme-bak-*
printf '{"theme":"dark"}\n' >"$H/.claude/settings.json"
inst_cur --add statusline
assert_rc 0 "added back"
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.statusLine={type:"command",command:"my-own"};fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")' "$H/.claude/settings.json"
uninst --yes --only statusline
assert_rc 0 "done"
assert_eq "my-own" "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')" "their status line is untouched"
assert_contains "$(out)" "left $H/.claude/settings.json alone" "and they are told"
assert_eq "0" "$(grep -c '^statusline' "$W/install-manifest")" "the record no longer claims it"

t_section "--add statusline refuses when the person has their own (exit 1, nothing changed)"
cp "$H/.claude/settings.json" "$SB/settings.own"
cp "$W/install-manifest" "$SB/manifest.own"
inst_cur --add statusline
assert_rc 1 "refused"
assert_contains "$(err)" "you already have a status line (not touched)" "with the reason"
assert_same_file "$SB/settings.own" "$H/.claude/settings.json" "settings.json is untouched"
assert_same_file "$SB/manifest.own" "$W/install-manifest" "and so is the record"

t_section "--only statusline: a settings.json (and ~/.claude) the installer created go again; --add records them anew"
sb_new
H=$SB_HOME
W="$H/.wasitme"
make_fixture "$SB_SRC" 0.1.0
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code --statusline
assert_rc 0 "install (creates ~/.claude/settings.json)"
assert_eq "1" "$(grep -c "^createddir	$H/.claude\$" "$W/install-manifest")" "the install recorded that it made ~/.claude"
uninst --yes --only statusline
assert_rc 0 "removed"
assert_missing "$H/.claude" "the file and the folder it made are gone (an empty ~/.claude would look like Claude Code is installed)"
assert_eq "0" "$(grep -c "^createddir	$H/.claude\$" "$W/install-manifest")" "and the record forgets the folder"
assert_dir "$W/versions/0.1.0" "the engine stays"
inst_cur --add statusline
assert_rc 0 "added back"
assert_file "$H/.claude/settings.json" "settings.json is created again"
assert_eq "1" "$(grep -c "^createddir	$H/.claude\$" "$W/install-manifest")" "and the folder is recorded again"
uninst --yes
assert_rc 0 "full uninstall"
assert_missing "$H/.claude" "leaves no ~/.claude behind"

t_section "--only statusline hands a status line 'wasitme statusline install' made back to the engine"
sb_new
H=$SB_HOME
W="$H/.wasitme"
make_fixture "$SB_SRC" 0.1.0
mkdir -p "$H/.claude"
printf '{"statusLine":{"type":"command","command":"ccstatusline"}}\n' >"$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "install leaves their status line alone"
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.statusLine={type:"command",command:process.argv[2],padding:0};fs.writeFileSync(f,JSON.stringify(d)+"\n")' "$H/.claude/settings.json" "$H/.local/bin/wasitme-statusline"
inst_cur --add statusline
assert_rc 0 "--add statusline"
assert_eq "Already installed: status line. Nothing was changed." "$(last_line)" "sees the engine's status line as ours already"
uninst --yes --only statusline
assert_rc 0 "removed"
assert_contains "$(cat "$SHIM_ENGINE_LOG")" "engine statusline uninstall --script $H/.local/bin/wasitme-statusline --claude-dir $H/.claude" "the engine undid its own edit"
assert_file "$H/.local/bin/wasitme-statusline" "the engine and its status-line command stay"

t_section "usage and refusals"
sb_new
H=$SB_HOME
W="$H/.wasitme"
make_fixture "$SB_SRC" 0.1.0
uninst --yes --only codex-plugin
assert_rc 0 "--only with nothing installed"
assert_contains "$(out)" "Nothing to uninstall" "says so"
inst_from --yes --no-app --no-scan-agent --no-statusline --agents claude-code,codex --claude-plugin --codex-plugin
assert_rc 0 "install both plugins"
for t_args in "--only" "--only bogus" "--only codex-plugin --purge"; do
  uninst --yes $t_args
  assert_rc 2 "uninstall.sh $t_args is a usage error"
done
for t_args in "--add" "--add bogus" "--add codex-plugin --no-app" "--add codex-plugin --repair" "--add codex-plugin --agents codex" "--update --no-relaunch --add codex-plugin" "--no-relaunch"; do
  inst_cur $t_args
  assert_rc 2 "install.sh $t_args is a usage error"
done
printf 'n\n' >"$SB/answers.txt"
export WASITME_TTY="$SB/answers.txt"
fs_snapshot "$H" >"$SB/home.before"
uninst --only codex-plugin
assert_rc 0 "on a terminal it asks once; no keeps everything"
assert_contains "$(out)" "Remove the Codex plugin? The rest of wasitme stays installed. [Y/n]" "the question names the part"
assert_contains "$(last_line)" "Nothing was changed." "and says so"
fs_snapshot "$H" >"$SB/home.after"
assert_same_file "$SB/home.before" "$SB/home.after" "nothing changed"
unset WASITME_TTY
uninst --yes --only codex-plugin --dry-run
assert_rc 0 "a dry run"
assert_contains "$(out)" "[dry-run]" "prints what it would do"
fs_snapshot "$H" >"$SB/home.after"
assert_same_file "$SB/home.before" "$SB/home.after" "and changes nothing"
uninst --yes --only codex-plugin
assert_rc 0 "remove the Codex plugin"
export WASITME_CODEX="$SB/nonexistent/codex"
fs_snapshot "$H" >"$SB/home.before"
inst_cur --add codex-plugin
assert_rc 1 "--add codex-plugin without a codex command"
assert_contains "$(err)" "Codex plugin was requested but is not possible here: the 'codex' command was not found" "says why"
fs_snapshot "$H" >"$SB/home.after"
assert_same_file "$SB/home.before" "$SB/home.after" "and changes nothing"
export WASITME_CODEX="$SB/shims/codex"
make_fixture "$SB_SRC" 0.2.0
inst_from --add codex-plugin
assert_rc 1 "--add from a source of another version"
assert_contains "$(err)" "Update first (install.sh --update with this source), then add the part." "says what to do"
assert_link "$W/current" "versions/0.1.0" "and changed nothing"

t_section "--add keeps the version an update kept for a rollback"
inst_from --update
assert_rc 0 "update to 0.2.0"
assert_dir "$W/versions/0.1.0" "0.1.0 is kept for a rollback"
inst_cur --add codex-plugin
assert_rc 0 "add the Codex plugin into 0.2.0"
assert_dir "$W/versions/0.1.0" "0.1.0 is still there"
assert_contains "$(grep '^codex-plugin' "$W/install-manifest")" "versions/0.2.0/plugin-codex" "Codex is registered at the current version"

t_section "--status: what is installed and what could be added, as JSON; reads only"
# st_get EXPR: a value from the last --status output (d = the document; i(id) = that integration as "state[/why]").
st_get() {
  node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const i = (id) => { const x = d.integrations.find((e) => e.id === id); return x.state + (x.why ? "/" + x.why : ""); };
    console.log(String(eval(process.argv[2])));' "$T_OUT" "$1"
}
sb_new
H=$SB_HOME
W="$H/.wasitme"
make_fixture "$SB_SRC" 0.1.0
inst --status
assert_rc 0 "nothing installed"
assert_eq "wasitme.install-status/1 false null" "$(st_get '[d.schema, d.installed, d.version].map(String).join(" ")')" "says so"
assert_eq "unknown/no_install_record" "$(st_get '[...new Set(d.integrations.map((e) => i(e.id)))].join(",")')" "every part is unknown: no install record"
assert_eq "app,claude-plugin,statusline,codex-plugin,scan" "$(st_get 'd.integrations.map((e) => e.id).join(",")')" "the Control Center's ids, in its order"
# The public export fills in the owner, which gives the installer a release URL (placeholder spelled in two pieces).
if grep -q -F "OWNER""/wasitme" "$T_REPO/scripts/install.sh"; then
  assert_eq "false/no_release|null" "$(st_get '[d.update.available + "/" + d.update.why, d.launchAtLogin].map(String).join("|")')" "no release to update from; launch-at-login is not set by the installer yet"
else
  assert_eq "true/undefined|null" "$(st_get '[d.update.available + "/" + d.update.why, d.launchAtLogin].map(String).join("|")')" "a release URL to update from; launch-at-login is not set by the installer yet"
fi
assert_missing "$W" "and nothing was created"
mkdir -p "$H/.claude"
printf '{"theme":"dark"}\n' >"$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --no-codex-plugin --agents claude-code,codex --claude-plugin --statusline
assert_rc 0 "install the Claude Code plugin and the status line"
fs_snapshot "$H" >"$SB/home.before"
: >"$SHIM_LOG"
inst_cur --status --json
assert_rc 0 "--status from the installed copy"
assert_eq "true 0.1.0" "$(st_get '[d.installed, d.version].join(" ")')" "installed, and which version"
assert_eq "on on off" "$(st_get '[i("claude-plugin"), i("statusline"), i("codex-plugin")].join(" ")')" "plugin and status line on; the Codex skill could be added"
if [ "$T_OS" = Darwin ]; then
  assert_eq "off off" "$(st_get '[i("app"), i("scan")].join(" ")')" "macOS: the app and the scan agent are off"
else
  assert_eq "unavailable/not_supported unavailable/not_supported" "$(st_get '[i("app"), i("scan")].join(" ")')" "elsewhere: not supported"
fi
assert_not_contains "$(out)" "$H" "no path is printed"
assert_eq "" "$(shimlog)" "no tool is run (only looked up)"
fs_snapshot "$H" >"$SB/home.after"
assert_same_file "$SB/home.before" "$SB/home.after" "and nothing changes"
export WASITME_CODEX="$SB/nonexistent/codex"
inst_cur --status
assert_eq "unavailable/agent_missing" "$(st_get 'i("codex-plugin")')" "no codex command: the Codex skill is unavailable"
export WASITME_CODEX="$SB/shims/codex"
uninst --yes --only statusline
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.statusLine={type:"command",command:"my-own"};fs.writeFileSync(f,JSON.stringify(d)+"\n")' "$H/.claude/settings.json"
inst_cur --status
assert_eq "own" "$(st_get 'i("statusline")')" "the person's own status line is 'own'"
printf '{ not json\n' >"$H/.claude/settings.json"
inst_cur --status
assert_eq "unavailable/not_supported" "$(st_get 'i("statusline")')" "a settings.json that does not parse: unavailable"
rm -f "$H/.claude/settings.json"
inst_cur --status
assert_eq "off" "$(st_get 'i("statusline")')" "no settings file: it could be added"
for t_args in "--status --yes" "--status --no-app" "--json" "--status --dry-run"; do
  inst_cur $t_args
  assert_rc 2 "install.sh $t_args is a usage error"
done
inst_from --status
assert_rc 2 "--status takes no source"

t_section "--add and --status use the --prefix the install recorded"
sb_new
H=$SB_HOME
W="$H/.wasitme"
make_fixture "$SB_SRC" 0.1.0
inst_from --yes --no-app --no-scan-agent --no-statusline --no-codex-plugin --agents claude-code,codex --claude-plugin --prefix "$H/opt"
assert_rc 0 "install with --prefix"
inst_cur --add codex-plugin
assert_rc 0 "--add without --prefix"
assert_missing "$H/.local" "no second command appears under the default prefix"
assert_file "$H/opt/bin/wasitme" "the command stays where it was installed"
inst_from --update
assert_rc 0 "--update without --prefix"
assert_missing "$H/.local" "the update keeps it there too"
assert_eq "1" "$(grep -c '^prefix' "$W/install-manifest")" "one prefix recorded"
inst_from --yes --no-app --no-scan-agent --no-statusline --no-codex-plugin --agents claude-code,codex --prefix "$SB/outside"
assert_rc 0 "an install that moved the command outside the home"
inst_cur --add statusline
assert_rc 1 "--add then needs that prefix named"
assert_contains "$(err)" "this install used --prefix $SB/outside; run again with --prefix $SB/outside" "and says so"

if [ "$T_OS" = Darwin ]; then
  t_section "macOS --only scan (the scan agent): its LaunchAgent goes, the app's stays; engine.json and engine.env follow"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  W="$H/.wasitme"
  LA="$H/Library/LaunchAgents"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "install the app and the scan agent"
  assert_eq "launchd" "$(cat "$SHIM_APP_STATE")" "the app runs"
  mf_save
  M0=$(mf_sorted)
  cp "$LA/$LABEL_APP.plist" "$SB/app.plist"
  : >"$SHIM_LOG"
  uninst --yes --only scan
  assert_rc 0 "removed"
  assert_eq "launchctl bootout gui/$T_UID/$LABEL_SCAN" "$(shimlog)" "only the scan agent is unloaded"
  assert_missing "$LA/$LABEL_SCAN.plist" "its plist is gone"
  assert_same_file "$SB/app.plist" "$LA/$LABEL_APP.plist" "the app's plist is untouched"
  assert_eq "launchd" "$(cat "$SHIM_APP_STATE")" "the app still runs"
  assert_eq "null|$LABEL_APP|$H/Applications/wasitme.app" "$(json_get "$W/engine.json" '[d.scanLabel, d.appLabel, d.app].map(String).join("|")')" "engine.json: no scan label, the app as before"
  assert_line "$W/engine.env" "scan_label=" "engine.env: the plugin hooks no longer kickstart a job that is gone"
  assert_eq "$({ mf_without launchagent; grep "^launchagent	$LABEL_APP" "$SB/manifest.before"; } | sort)" "$(mf_sorted)" "the manifest lost exactly the scan agent's line"
  assert_dir "$W/logs" "the log folder stays (the app's agent writes there)"
  : >"$SHIM_LOG"
  inst_cur --add scan
  assert_rc 0 "--add scan (the Control Center's name) adds the scan agent"
  assert_contains "$(shimlog)" "launchctl bootstrap gui/$T_UID $LA/$LABEL_SCAN.plist" "loaded"
  assert_not_contains "$(shimlog)" "$LABEL_APP" "the app's agent is not touched"
  assert_eq "$M0" "$(mf_sorted)" "the manifest is what the install wrote"
  assert_eq "$LABEL_SCAN" "$(json_get "$W/engine.json" 'd.scanLabel')" "engine.json names it again"
  assert_line "$W/engine.env" "scan_label=$LABEL_SCAN" "and so does engine.env"
  inst_cur --status
  assert_eq "on on" "$(st_get '[i("app"), i("scan")].join(" ")')" "--status: the app and the scan agent are on"

  t_section "macOS --only app: the app quits and goes; the scan agent stays; empty folders it made go"
  cp "$LA/$LABEL_SCAN.plist" "$SB/scan.plist"
  : >"$SHIM_LOG"
  uninst --yes --only app
  assert_rc 0 "removed"
  assert_eq "launchctl bootout gui/$T_UID/$LABEL_APP
pkill -U $T_UID -f $H/Applications/wasitme.app/Contents/MacOS/" "$(shimlog)" "its agent is unloaded, then a copy the person opened is quit"
  assert_missing "$SHIM_APP_STATE" "the app is not running"
  assert_missing "$H/Applications" "the app and the Applications folder the install made are gone"
  assert_missing "$LA/$LABEL_APP.plist" "its plist is gone"
  assert_same_file "$SB/scan.plist" "$LA/$LABEL_SCAN.plist" "the scan agent is untouched"
  assert_eq "$LABEL_SCAN|null|null" "$(json_get "$W/engine.json" '[d.scanLabel, d.appLabel, d.app].map(String).join("|")')" "engine.json: no app"
  assert_eq "0" "$(grep -c -e '^app	' -e "^launchagent	$LABEL_APP" -e "^createddir	$H/Applications\$" "$W/install-manifest")" "the manifest forgets the app, its agent and its folder"
  inst_cur --status
  assert_eq "off on" "$(st_get '[i("app"), i("scan")].join(" ")')" "--status: the app is off, the scan agent on"
  inst_cur --add app
  assert_rc 1 "--add app from the installed copy"
  assert_contains "$(err)" "an installed copy never does" "explains that the app needs its sources"
  assert_missing "$H/Applications" "and changed nothing"
  : >"$SHIM_LOG"
  inst_from --add app
  assert_rc 0 "--add app with the sources of the installed version"
  assert_contains "$(shimlog)" "swift build -c release" "the app is built"
  assert_contains "$(shimlog)" "launchctl bootstrap gui/$T_UID $LA/$LABEL_APP.plist" "its agent is loaded"
  assert_eq "launchd" "$(cat "$SHIM_APP_STATE")" "which starts it"
  assert_eq "$M0" "$(mf_sorted)" "the manifest is what the install wrote"
  assert_eq "Added: mac app." "$(last_line)" "one-line summary"

  t_section "macOS: after parts came and went, the full uninstall leaves an empty home"
  uninst --yes
  assert_rc 0 "uninstall"
  assert_eq "." "$(tree_of "$H")" "the home is empty again"
fi

t_done
