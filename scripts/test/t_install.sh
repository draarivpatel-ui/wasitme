#!/bin/sh
# Real installs into a throw-away home, with recording shims for claude/codex/launchctl/codesign/swift.
. "$(dirname "$0")/harness.sh"

NODE=$(command -v node)

t_section "core install"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
V="$W/versions/0.1.0"
CUR="$W/current"
inst_from $CORE_ONLY
assert_rc 0 "core install succeeds"
assert_file "$V/engine/dist/src/cli/main.js" "engine installed under ~/.wasitme/versions/<version> (D46)"
assert_file "$V/engine/package.json" "package.json installed"
assert_file "$V/LICENSE" "LICENSE installed"
assert_eq "0.1.0" "$(cat "$V/VERSION")" "VERSION file"
assert_missing "$V/engine/dist/test" "test output is not installed (dist/src only)"
assert_missing "$V/node_modules" "no node_modules (zero runtime dependencies)"
assert_file "$V/scripts/uninstall.sh" "uninstaller shipped inside the install"
assert_file "$V/scripts/lib/jsonutil.mjs" "uninstaller helpers shipped inside the install"
assert_file "$V/plugin/hooks/hooks.json" "the Claude Code plugin is in the same version folder"
assert_missing "$V/plugin/tests" "the plugin's tests are not shipped"
assert_file "$V/plugin-codex/.agents/plugins/marketplace.json" "the Codex root is in the same version folder"
assert_file "$V/packaging/statusline.sh" "the status-line script is in the same version folder"
assert_missing "$V/engine/dist/src/synth" "the synthetic-data generator is not installed (npm files exclude it too)"
assert_missing "$V/engine/dist/src/analysis/calibration" "nor the calibration harness"
assert_link "$CUR" "versions/0.1.0" "current is a relative symlink to the version"
assert_eq "" "$(find "$V" -perm -u+w | head -3)" "the version folder is read-only (nothing in it is writable, D46)"
assert_missing "$H/.local/share" "nothing under ~/.local/share any more (D46)"
assert_missing "$W/versions/.stage" "no staging left behind"
assert_missing "$W/versions/.parked" "no parked copy left behind"
assert_missing "$W/.install.lock" "lock released"
assert_eq "0" "$(ls -A "$SB/tmp" | wc -l | tr -d ' ')" "no temp directories left behind"

SHIM="$H/.local/bin/wasitme"
assert_file "$SHIM" "shim installed"
assert_eq "-rwxr-xr-x" "$(ls -l "$SHIM" | cut -c1-10)" "shim is executable"
assert_file_has "$SHIM" "managed by the wasitme installer" "shim carries the ownership marker"
assert_file_has "$SHIM" "$NODE" "shim embeds the absolute node path"
assert_file_has "$SHIM" "$CUR/engine/dist/src/cli/main.js" "shim points at the stable current/ path"
assert_eq "wasitme 0.1.0" "$("$SHIM" --version)" "the shim runs the engine"
assert_eq "fake wasitme scan --quiet" "$("$SHIM" scan --quiet)" "the shim passes arguments through"

EJ="$W/engine.json"
EE="$W/engine.env"
assert_file "$EJ" "engine.json written"
assert_eq "-rw-------" "$(ls -l "$EJ" | cut -c1-10)" "engine.json is 0600 (D46)"
assert_eq "-rw-------" "$(ls -l "$EE" | cut -c1-10)" "engine.env is 0600 (the hooks refuse anything else)"
assert_eq "wasitme.engine/1" "$(json_get "$EJ" 'd.schema')" "engine.json: the schema id the app parses"
assert_eq "$NODE" "$(json_get "$EJ" 'd.node')" "engine.json: absolute node"
assert_eq "$CUR/engine/dist/src/cli/main.js" "$(json_get "$EJ" 'd.cli')" "engine.json: absolute cli through current/"
assert_eq "0.1.0" "$(json_get "$EJ" 'd.version')" "engine.json: version"
assert_eq "$W" "$(json_get "$EJ" 'd.home')" "engine.json: home"
assert_eq "$H/.claude" "$(json_get "$EJ" 'd.claudeDir')" "engine.json: the Claude Code config folder this install tracks"
assert_eq "$H/.codex" "$(json_get "$EJ" 'd.codexDir')" "engine.json: the Codex config folder this install tracks"
SLS="$H/.local/bin/wasitme-statusline"
assert_file "$SLS" "the status-line shim is installed (~/.local/bin/wasitme-statusline)"
assert_eq "-rwxr-xr-x" "$(ls -l "$SLS" | cut -c1-10)" "the status-line shim is executable"
assert_file_has "$SLS" "managed by the wasitme installer" "the status-line shim carries the ownership marker"
assert_eq "false" "$(json_get "$EJ" 'd.onPath')" "engine.json: onPath false (the sandbox bin is not on PATH)"
PERM=""
if node --permission -e 0 >/dev/null 2>&1; then PERM=--permission; elif node --experimental-permission -e 0 >/dev/null 2>&1; then PERM=--experimental-permission; fi
assert_eq "${PERM:-null}" "$(json_get "$EJ" 'd.permission')" "engine.json: the permission flag this node accepts (feature-tested, D49)"
assert_eq "null" "$(json_get "$EJ" 'd.scanLabel')" "engine.json: no scan agent installed -> null"
assert_line "$EE" "node=$NODE" "engine.env: node"
assert_line "$EE" "cli=$(cd -P "$W" && pwd -P)/current/engine/dist/src/cli/main.js" "engine.env: cli, through the resolved spelling of ~/.wasitme (what node needs under the sandbox)"
assert_line "$EE" "permission=$PERM" "engine.env: the permission flag"
assert_line "$EE" "home=$W" "engine.env: home"
assert_line "$EE" "scan_label=" "engine.env: no scan label"
assert_eq "" "$(env -i PATH=/usr/bin:/bin HOME="$H" WASITME_HOOK_DRY_RUN=1 /bin/sh "$T_REPO/plugin/scripts/session-start.sh" 2>&1 </dev/null)" "no scan agent: the plugin's hook is a silent no-op"
assert_eq "null" "$(json_get "$EJ" 'd.app')" "engine.json: no app installed -> null"
assert_eq "drwx------" "$(ls -ld "$W" | cut -c1-10)" "~/.wasitme is private (700)"

MF="$W/install-manifest"
assert_file "$MF" "install manifest written"
assert_eq "-rw-------" "$(ls -l "$MF" | cut -c1-10)" "the manifest is 0600"
assert_file_has "$MF" "$(printf 'dir\t%s' "$V")" "manifest: version dir"
assert_file_has "$MF" "$(printf 'symlink\t%s' "$CUR")" "manifest: current symlink"
assert_file_has "$MF" "$(printf 'shim\t%s' "$SHIM")" "manifest: shim"
assert_file_has "$MF" "$(printf 'file\t%s' "$EJ")" "manifest: engine.json"
assert_file_has "$MF" "$(printf 'file\t%s' "$EE")" "manifest: engine.env"
assert_file_has "$MF" "$(printf 'createddir\t%s' "$H/.local/bin")" "manifest: created directories are recorded"

assert_contains "$(out)" "is not on your PATH yet" "PATH hint printed"
assert_contains "$(out)" "echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> " "PATH hint is the exact line to add"
assert_contains "$(out)" "Try it:  $SHIM" "until PATH is fixed, messages use the full path"
for rc in .zshrc .bashrc .profile .bash_profile .zprofile .zshenv; do assert_missing "$H/$rc" "$rc was not created or edited"; done
assert_eq "0" "$(count_lines "$SHIM_LOG")" "no tool was run when every component is off"
assert_contains "$(out)" "$CUR/scripts/uninstall.sh" "output tells how to uninstall"
assert_contains "$(out)" "doctor               skipped    this engine has no 'wasitme doctor' yet" "an engine without doctor: the check is skipped and the result says so"

t_section "idempotent re-run"
snap() { ( cd "$H" && find . -type f -o -type l | sort | while IFS= read -r f; do printf '%s ' "$f"; if [ -L "$f" ]; then readlink "$f"; else shasum "$f" | cut -d' ' -f1; fi; done ); }
before=$(snap)
inst_from $CORE_ONLY
assert_rc 0 "second run succeeds"
assert_eq "$before" "$(snap)" "second run leaves every file and link exactly as it was"
assert_missing "$W/versions/.parked" "second run leaves no parked copy"
assert_contains "$(out)" "already in place" "the identical version is kept, not replaced"
assert_eq "$(sort "$MF" | uniq -d | wc -l | tr -d ' ')" "0" "manifest has no duplicate lines"

t_section "upgrade: one flip of current; the previous version is kept, older ones are removed"
make_fixture "$SB_SRC" 0.2.0
inst_from $CORE_ONLY
assert_rc 0 "upgrade succeeds"
assert_link "$CUR" "versions/0.2.0" "current moved to 0.2.0"
assert_file "$V/engine/dist/src/cli/main.js" "the previous version stays on disk (for a rollback)"
assert_file "$W/versions/0.2.0/engine/dist/src/cli/main.js" "the new version is installed"
assert_eq "wasitme 0.2.0" "$("$SHIM" --version)" "the shim now runs 0.2.0 (it goes through current/)"
assert_eq "0.2.0" "$(json_get "$EJ" 'd.version')" "engine.json reports 0.2.0"
assert_contains "$(out)" "updated from 0.1.0" "the result says it was an update"
assert_file_has "$MF" "$(printf 'dir\t%s' "$V")" "manifest still lists 0.1.0"
assert_file_has "$MF" "$(printf 'dir\t%s' "$W/versions/0.2.0")" "manifest lists 0.2.0"
make_fixture "$SB_SRC" 0.3.0
inst_from $CORE_ONLY
assert_rc 0 "a second upgrade"
assert_link "$CUR" "versions/0.3.0" "current moved to 0.3.0"
assert_missing "$V" "0.1.0 was removed (read-only folders are made writable first)"
assert_dir "$W/versions/0.2.0" "0.2.0 is kept as the previous version"
assert_file_lacks "$MF" "$(printf 'dir\t%s' "$V")" "and 0.1.0 left the manifest"
assert_contains "$(out)" "removed an old version: $V" "the removal is reported"

t_section "a shim we did not create is never overwritten"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.local/bin"
printf '#!/bin/sh\necho someone elses wasitme\n' >"$H/.local/bin/wasitme"
chmod +x "$H/.local/bin/wasitme"
inst_from $CORE_ONLY
assert_rc 0 "install still succeeds"
assert_eq "someone elses wasitme" "$("$H/.local/bin/wasitme")" "the foreign file is untouched"
assert_contains "$(err)" "was not created by this installer" "a warning explains"
assert_contains "$(out)" "belongs to something else" "result says the command was skipped"
assert_file "$H/.wasitme/current/engine/dist/src/cli/main.js" "the engine itself is installed"
assert_no_line "$H/.wasitme/install-manifest" "$(printf 'shim\t%s' "$H/.local/bin/wasitme")" "the foreign file is not in the manifest"
assert_file_has "$H/.wasitme/install-manifest" "$(printf 'shim\t%s' "$H/.local/bin/wasitme-statusline")" "the status-line shim is ours and recorded"
assert_not_contains "$(out)" "is not on your PATH yet" "no PATH hint when there is no shim"
assert_eq "-rw-------" "$(ls -l "$H/.wasitme/engine.json" | cut -c1-10)" "engine.json is still written 0600"
assert_contains "$(out)" "Try it:  $NODE" "tells how to run the engine directly"

t_section "a path with a space"
sb_new "my home"
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from $CORE_ONLY
assert_rc 0 "install into a home with a space succeeds"
assert_eq "wasitme 0.1.0" "$("$H/.local/bin/wasitme" --version)" "the shim works despite the space"
assert_eq "$H/.wasitme/current/engine/dist/src/cli/main.js" "$(json_get "$H/.wasitme/engine.json" 'd.cli')" "engine.json keeps the space"
uninst
assert_rc 0 "uninstall from a home with a space"
assert_missing "$H/.local" "everything removed"
assert_missing "$H/.wasitme" "including the read-only version folder"

t_section "custom prefix"
sb_new
make_fixture "$SB_SRC" 0.1.0
inst_from $CORE_ONLY --prefix "$SB/pfx"
assert_rc 0 "install with --prefix succeeds"
assert_file "$SB_HOME/.wasitme/versions/0.1.0/engine/dist/src/cli/main.js" "the engine lives in ~/.wasitme whatever the prefix (D46)"
assert_missing "$SB/pfx/share" "nothing under the prefix's share/"
assert_file "$SB/pfx/bin/wasitme" "shim under the prefix"
assert_missing "$SB_HOME/.local" "nothing under ~/.local"
assert_file "$SB_HOME/.wasitme/engine.json" "engine.json still lives in ~/.wasitme"
uninst --prefix "$SB/pfx"
assert_rc 0 "uninstall with the same --prefix"
assert_missing "$SB/pfx" "prefix directories created by the installer are removed"

t_section "the uninstaller remembers the prefix"
sb_new
make_fixture "$SB_SRC" 0.1.0
inst_from $CORE_ONLY --prefix "$SB_HOME/tools"
assert_rc 0 "install with a prefix inside the home"
uninst
assert_rc 0 "uninstall without repeating --prefix adopts the recorded prefix"
assert_missing "$SB_HOME/tools" "and removes what was installed there"
sb_new
make_fixture "$SB_SRC" 0.1.0
inst_from $CORE_ONLY --prefix "$SB/pfx"
uninst
assert_rc 1 "a prefix outside the home must be repeated explicitly"
assert_contains "$(err)" "run the uninstaller again with --prefix $SB/pfx" "the message says exactly what to type"
assert_file "$SB/pfx/bin/wasitme" "nothing was removed in the meantime"

t_section "PATH shims work without env injection"
sb_new
make_fixture "$SB_SRC" 0.1.0
unset WASITME_CLAUDE WASITME_CODEX
inst_from --yes --no-app --no-scan-agent --no-statusline
assert_rc 0 "install with claude/codex found on PATH"
assert_contains "$(shimlog)" "claude plugin install wasitme@wasitme" "claude found through PATH"
assert_contains "$(shimlog)" "codex plugin add wasitme@wasitme-codex" "codex found through PATH"
H=$SB_HOME
assert_contains "$(shimenv)" "claude CLAUDE_CONFIG_DIR=$H/.claude CODEX_HOME=$H/.codex HOME=$H" "claude runs against the sandbox config dir, not the real one"
assert_contains "$(shimenv)" "codex CLAUDE_CONFIG_DIR=$H/.claude CODEX_HOME=$H/.codex HOME=$H" "codex runs against the sandbox config dir, not the real one"

t_section "plugins and status line"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
W="$H/.wasitme"
CUR="$W/current"
V="$W/versions/0.1.0"
mkdir -p "$H/.claude"
printf '{\n    "theme": "dark",\n    "env": { "A": "1" }\n}\n' >"$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$SB/settings.orig"
inst_from --yes --no-app --no-scan-agent --agents claude-code,codex
assert_rc 0 "install with plugins and status line"
VR=$(cd -P "$V" && pwd -P)
assert_eq "claude plugin marketplace add $CUR
claude plugin install wasitme@wasitme
claude plugin configure wasitme@wasitme --values-stdin
codex plugin marketplace add $CUR/plugin-codex
codex plugin add wasitme@wasitme-codex" "$(shimlog)" "exactly these commands ran, in this order: Claude at the current symlink, Codex at its own root"
assert_contains "$(shimenv)" "claude-stdin {\"glancePath\":\"$W/glance.json\"}" "the mod option glancePath is saved as an absolute path (D45/D50)"
assert_contains "$(out)" "runs inside Claude Code with your permissions" "the mod disclosure is printed even with --yes (D50, P-A)"
assert_contains "$(out)" "calls: \$.clock.every, \$.clock.now, \$.command.register, \$.fs.read" "with the frozen calls line"
assert_file "$V/.claude-plugin/marketplace.json" "the version folder has the marketplace manifest"
assert_file "$V/plugin/hooks/hooks.json" "and the plugin"
assert_contains "$(shimenv)" "claude CLAUDE_CONFIG_DIR=$H/.claude CODEX_HOME=$H/.codex HOME=$H" "claude was pointed at the sandbox"
assert_eq "dark" "$(json_get "$H/.claude/settings.json" 'd.theme')" "settings.json keeps its other keys"
assert_eq "command" "$(json_get "$H/.claude/settings.json" 'd.statusLine.type')" "statusLine added"
SLS="$H/.local/bin/wasitme-statusline"
assert_eq "$SLS" "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')" "statusLine runs the absolute status-line shim, not node"
assert_eq "0" "$(json_get "$H/.claude/settings.json" 'd.statusLine.padding')" "with padding 0"
assert_file_lacks "$SLS" "node" "the status-line shim never starts node"
assert_file_has "$SLS" "$CUR/packaging/statusline.sh" "it runs the shipped sh script through current/"
# The installed status line, end to end: a synthetic glance in, one segment out (no node anywhere on this path).
printf '%s\n' '{"schema":"wasitme.glance/1","generatedAt":"2026-10-05T12:00:00Z","staleAfterSec":7200,"agents":[{"id":"claude-code","state":"none","statusLine":"wasitme: no detectable change","n":{}}],"privacy":{"containsText":false}}' >"$W/glance.json"
chmod 600 "$W/glance.json"
assert_eq "wasitme: no detectable change" "$(printf '{}' | env -i PATH=/usr/bin:/bin HOME="$H" WASITME_STATUSLINE_NOW=1791201700 "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')")" "the installed status-line command prints the glance's segment"
rm -f "$W/glance.json"
assert_eq "" "$(printf '{}' | env -i PATH=/usr/bin:/bin HOME="$H" "$SLS"; echo "rc=$?" | grep -v 'rc=0')" "with no glance it prints nothing and exits 0"
# Speed (budget: the status line's own part is <= 10 ms). An absolute bound would flake on a busy machine (these
# tests run at background priority), so the check is relative: the installed command must beat a bare `node -e ''`,
# which no node-based status line can.
SL_MS=$(node -e '
  const { spawnSync } = require("child_process");
  const med = (cmd, args) => { const t = []; for (let i = 0; i < 15; i++) { const s = process.hrtime.bigint(); spawnSync(cmd, args, { input: "{}", env: { PATH: "/usr/bin:/bin", HOME: process.argv[2] } }); t.push(Number(process.hrtime.bigint() - s) / 1e6); } t.sort((a, b) => a - b); return t[7]; };
  const sl = med(process.argv[1], []), nd = med(process.execPath, ["-e", ""]);
  console.log(sl < nd ? "faster" : "slower", sl.toFixed(1), nd.toFixed(1));
' "$SLS" "$H")
assert_contains "$SL_MS" "faster" "the status line (median of 15 runs) is faster than starting node at all: $SL_MS ms (status line, bare node)"
assert_file_has "$W/install-manifest" "$(printf 'shim\t%s' "$SLS")" "manifest: the status-line shim"
assert_file_has "$H/.claude/settings.json" '    "theme": "dark"' "indentation preserved"
BAK=$(ls "$H/.claude"/settings.json.wasitme-bak-* | head -1)
assert_same_file "$SB/settings.orig" "$BAK" "backup of settings.json is byte-identical to the original"
assert_eq "1" "$(ls "$H/.claude"/settings.json.wasitme-bak-* | wc -l | tr -d ' ')" "exactly one backup"
MF="$W/install-manifest"
assert_file_has "$MF" "$(printf 'claude-plugin\twasitme@wasitme\twasitme\t%s' "$CUR")" "manifest: claude plugin, registered at current"
assert_file_has "$MF" "$(printf 'codex-plugin\twasitme@wasitme-codex\twasitme-codex\t%s/plugin-codex' "$VR")" "manifest: codex plugin, with the RESOLVED root Codex stores (D49)"
assert_file_has "$MF" "$(printf 'statusline\t%s\t%s' "$H/.claude/settings.json" "$BAK")" "manifest: status line + backup"
assert_not_contains "$(out)" "/hooks" "no Codex hook review: the Codex plugin is skills only"
assert_contains "$(out)" "/reload-plugins" "Claude Code reload hint"

BAK1=$BAK
: >"$SHIM_LOG"
inst_from --yes --no-app --no-scan-agent --agents claude-code,codex
assert_rc 0 "re-run succeeds"
assert_eq "" "$(shimlog)" "an identical re-run touches neither CLI (no update, no validate, nothing removed)"
assert_contains "$(out)" "already up to date" "and says so"
assert_file_has "$MF" "$(printf 'claude-plugin\twasitme@wasitme\twasitme\t%s' "$CUR")" "the manifest line is intact"
assert_eq "1" "$(ls "$H/.claude"/settings.json.wasitme-bak-* | wc -l | tr -d ' ')" "a re-run makes no second backup (status line already ours)"
assert_contains "$(out)" "already set" "status line reported as already set"

t_section "same version, different files: refreshed without removing anything (D50)"
printf '{ "changed": true }\n' >"$SB_SRC/plugin/hooks/extra.json"
: >"$SHIM_LOG"
inst_from --yes --no-app --no-scan-agent --agents claude-code,codex
assert_rc 0 "refresh succeeds"
assert_eq "claude plugin validate --strict WORK/growth/old/plugin
claude plugin validate --strict WORK/growth/new/plugin
claude plugin update wasitme@wasitme
claude plugin configure wasitme@wasitme --values-stdin
codex plugin add wasitme@wasitme-codex" "$(sed "s|$SB/tmp/wasitme-install\.[A-Za-z0-9]*|WORK|" "$SHIM_LOG")" "growth check, then update + configure; Codex re-reads the same root; never uninstall or marketplace remove"
assert_file "$V/plugin/hooks/extra.json" "the version folder has the new file"
assert_link "$CUR" "versions/0.1.0" "current still points at 0.1.0"

t_section "upgrade: flip current, then claude plugin update; Codex is re-registered (D49/D50)"
rm -f "$SB_SRC/plugin/hooks/extra.json"
make_fixture "$SB_SRC" 0.2.0
V2="$W/versions/0.2.0"
: >"$SHIM_LOG"
inst_from --yes --no-app --no-scan-agent --agents claude-code,codex
assert_rc 0 "upgrade with plugins succeeds"
V2R=$(cd -P "$V2" && pwd -P)
assert_eq "claude plugin update wasitme@wasitme
claude plugin configure wasitme@wasitme --values-stdin
codex plugin marketplace remove wasitme-codex
codex plugin marketplace add $CUR/plugin-codex
codex plugin add wasitme@wasitme-codex" "$(grep -v 'plugin validate' "$SHIM_LOG")" "Claude: update only (it already runs from current); Codex: marketplace remove -> add -> plugin add"
assert_not_contains "$(shimlog)" "plugin uninstall" "the Claude plugin is never uninstalled on update (it would erase its options)"
assert_not_contains "$(shimlog)" "claude plugin marketplace remove" "nor its marketplace removed"
assert_link "$CUR" "versions/0.2.0" "current flipped to 0.2.0"
assert_file_has "$MF" "$(printf 'claude-plugin\twasitme@wasitme\twasitme\t%s' "$CUR")" "manifest: claude plugin still registered at current"
assert_file_has "$MF" "$(printf 'codex-plugin\twasitme@wasitme-codex\twasitme-codex\t%s/plugin-codex' "$V2R")" "manifest: codex now records the new resolved root"
assert_dir "$V" "the previous version stays (rollback)"
assert_contains "$(out)" "/reload-plugins" "the person is told to /reload-plugins"
assert_eq "1" "$(ls "$H/.claude"/settings.json.wasitme-bak-* | wc -l | tr -d ' ')" "still exactly one settings backup"
assert_same_file "$SB/settings.orig" "$BAK1" "and it is still the original settings.json"

t_section "an older installer's status line (node + cli + status) moves to the sh shim; a node move changes nothing"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
SLS="$H/.local/bin/wasitme-statusline"
mkdir -p "$H/.claude" "$SB/node2"
printf '{\n  "theme": "dark"\n}\n' >"$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$SB/settings.orig"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "install with the status line"
BAK=$(ls "$H/.claude"/settings.json.wasitme-bak-* | head -1)
CLI="$H/.wasitme/current/engine/dist/src/cli/main.js"
# Rewind to what an installer from before the shim wrote: settings.json and the manifest both say `<node> <cli> status`.
OLDCMD="$NODE $CLI status"
node -e 'const fs = require("fs"), f = process.argv[1], d = JSON.parse(fs.readFileSync(f, "utf8")); d.statusLine = { type: "command", command: process.argv[2] }; fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");' "$H/.claude/settings.json" "$OLDCMD"
OLDSHA=$(node "$T_REPO/scripts/lib/jsonutil.mjs" sha256 "$H/.claude/settings.json")
awk -F '\t' -v OFS='\t' -v sha="$OLDSHA" -v cmd="$OLDCMD" '$1 == "statusline" { $4 = sha; $5 = cmd } { print }' "$H/.wasitme/install-manifest" >"$SB/mf" && cat "$SB/mf" >"$H/.wasitme/install-manifest"
cp "$H/.claude/settings.json" "$SB/settings.v1"
inst_from --dry-run --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "dry run"
assert_contains "$(out)" "statusline-replace $H/.claude/settings.json" "the planned edit is a replace, not an add"
assert_same_file "$SB/settings.v1" "$H/.claude/settings.json" "a dry run does not touch settings.json"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --no-statusline --agents claude-code
assert_rc 0 "--no-statusline"
assert_same_file "$SB/settings.v1" "$H/.claude/settings.json" "--no-statusline leaves it alone, even when it is stale"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "re-run"
assert_eq "$SLS" "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')" "the old node command became the status-line shim"
assert_eq "dark" "$(json_get "$H/.claude/settings.json" 'd.theme')" "everything else in settings.json is kept"
assert_not_contains "$(out)" "you already have a status line" "our own status line is not reported as the user's"
assert_contains "$(out)" "updated to the current command" "the update is reported"
assert_eq "1" "$(ls "$H/.claude"/settings.json.wasitme-bak-* | wc -l | tr -d ' ')" "no second backup"
assert_same_file "$SB/settings.orig" "$BAK" "the backup is still the original file"
NEWSHA=$(node "$T_REPO/scripts/lib/jsonutil.mjs" sha256 "$H/.claude/settings.json")
assert_file_has "$H/.wasitme/install-manifest" "$(printf 'statusline\t%s\t%s\t%s\t%s' "$H/.claude/settings.json" "$BAK" "$NEWSHA" "$SLS")" "manifest: same backup, the new checksum and the new command"
# node moves (brew upgrade, nvm use): the command shim follows it; the status line never named node, so it stays put.
printf '#!/bin/sh\nexec "%s" "$@"\n' "$NODE" >"$SB/node2/node"
chmod +x "$SB/node2/node"
INST_PATH_EXTRA="$SB/node2"
cp "$H/.claude/settings.json" "$SB/settings.v2"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "re-run with node at a different path"
assert_same_file "$SB/settings.v2" "$H/.claude/settings.json" "settings.json is not touched when node moves"
assert_contains "$(out)" "already set" "the status line is reported as already set"
assert_contains "$("$H/.local/bin/wasitme" --version)" "wasitme 0.1.0" "the command shim moved to the new node"
assert_file_has "$H/.local/bin/wasitme" "$SB/node2/node" "shim runs the new node"
INST_PATH_EXTRA=""
uninst
assert_rc 0 "uninstall after the move"
assert_same_file "$SB/settings.orig" "$H/.claude/settings.json" "settings.json is restored byte-for-byte"
assert_missing "$SLS" "the status-line shim is removed"

t_section "a stale status line refresh never records edits made since the install as ours (uninstall would undo them)"
# Between the first install and the refresh, Claude Code wrote its plugin keys and the person changed the theme. The
# refresh must not re-stamp the file as "untouched since we edited it": the uninstaller would then restore the original
# backup over those edits. Two cases: a settings.json that existed before (backup kept) and one the installer created
# (backup "-": an exact restore DELETES the file).
rewind_statusline() {  # rewind_statusline HOME: make settings.json and the manifest say an older installer wrote `<node> <cli> status`
  rs_cli="$1/.wasitme/current/engine/dist/src/cli/main.js"
  OLDCMD="$NODE $rs_cli status"
  node -e 'const fs = require("fs"), f = process.argv[1], d = JSON.parse(fs.readFileSync(f, "utf8")); d.statusLine = { type: "command", command: process.argv[2] }; fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");' "$1/.claude/settings.json" "$OLDCMD"
  OLDSHA=$(node "$T_REPO/scripts/lib/jsonutil.mjs" sha256 "$1/.claude/settings.json")
  awk -F '\t' -v OFS='\t' -v sha="$OLDSHA" -v cmd="$OLDCMD" '$1 == "statusline" { $4 = sha; $5 = cmd } { print }' "$1/.wasitme/install-manifest" >"$SB/mf" && cat "$SB/mf" >"$1/.wasitme/install-manifest"
}
later_edits() {  # later_edits FILE: what Claude Code and the person do to settings.json after the install
  node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.enabledPlugins={"other@place":true};d.theme="light";fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")' "$1"
}
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
SLS="$H/.local/bin/wasitme-statusline"
mkdir -p "$H/.claude"
printf '{\n  "theme": "dark"\n}\n' >"$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "install with the status line (settings.json existed)"
rewind_statusline "$H"
later_edits "$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "re-run refreshes the stale status line"
assert_eq "$SLS" "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')" "the command was updated"
assert_eq "light" "$(json_get "$H/.claude/settings.json" 'd.theme')" "the later edits are still there after the refresh"
assert_eq "-" "$(awk -F '\t' '$1 == "statusline" { print $4 }' "$H/.wasitme/install-manifest")" "the manifest no longer promises an exact restore: the file changed since the install"
uninst
assert_rc 0 "uninstall"
assert_file "$H/.claude/settings.json" "settings.json still exists"
assert_eq "light" "$(json_get "$H/.claude/settings.json" 'd.theme')" "the theme change made after the install survives the uninstall"
assert_eq "true" "$(json_get "$H/.claude/settings.json" 'd.enabledPlugins["other@place"]')" "and so does Claude Code's own plugin key"
assert_eq "undefined" "$(json_get "$H/.claude/settings.json" 'd.statusLine')" "only our statusLine was removed"
assert_contains "$(out)" "the file changed after the install" "the uninstaller says why it did not restore the backup"
assert_eq "1" "$(ls "$H/.claude" | grep -c wasitme-bak)" "the backup of the original is kept"
# The same when the installer created settings.json: an exact restore would delete the whole file.
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
SLS="$H/.local/bin/wasitme-statusline"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --statusline --agents claude-code
assert_rc 0 "install with the status line (no settings.json before)"
assert_file_has "$H/.wasitme/install-manifest" "$(printf 'statusline\t%s\t-\t' "$H/.claude/settings.json")" "the manifest records that we created the file"
rewind_statusline "$H"
later_edits "$H/.claude/settings.json"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "re-run refreshes the stale status line"
assert_eq "$SLS" "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')" "the command was updated"
uninst
assert_rc 0 "uninstall"
assert_file "$H/.claude/settings.json" "the settings.json the person has since written into is NOT deleted"
assert_eq "light" "$(json_get "$H/.claude/settings.json" 'd.theme')" "their edits survive"
assert_eq "undefined" "$(json_get "$H/.claude/settings.json" 'd.statusLine')" "only our statusLine was removed"
# And when nothing else changed since the install, the exact restore still happens (the refresh alone is ours).
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{\n  "theme": "dark"\n}\n' >"$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$SB/settings.orig"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
rewind_statusline "$H"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "re-run refreshes the stale status line"
assert_eq "-rw-------" "$(ls -l "$H/.wasitme/install-manifest" | cut -c1-10)" "the manifest stays 0600"
uninst
assert_rc 0 "uninstall"
assert_same_file "$SB/settings.orig" "$H/.claude/settings.json" "untouched otherwise: settings.json comes back byte for byte"
assert_eq "0" "$(ls "$H/.claude" | grep -c wasitme-bak)" "and the backup is consumed"

t_section "no status line is added where Claude Code is not installed"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
export WASITME_CLAUDE="$SB/nonexistent/claude" WASITME_CODEX="$SB/nonexistent/codex"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin
assert_rc 0 "--yes with neither agent present"
assert_missing "$H/.claude" "no ~/.claude was created"
assert_contains "$(out)" "Claude Code was not found on this Mac" "the skip reason is shown"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --statusline
assert_rc 0 "an explicit --statusline is still honoured"
assert_eq "command" "$(json_get "$H/.claude/settings.json" 'd.statusLine.type')" "and adds it"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
export WASITME_CLAUDE="$SB/nonexistent/claude" WASITME_CODEX="$SB/nonexistent/codex"
mkdir -p "$H/.claude"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin
assert_rc 0 "a ~/.claude folder means Claude Code is configured here"
assert_eq "command" "$(json_get "$H/.claude/settings.json" 'd.statusLine.type')" "so the status line is added"

t_section "an existing status line is never touched"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{"statusLine":{"type":"command","command":"ccstatusline"}}\n' >"$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$SB/settings.orig"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin
assert_rc 0 "install succeeds"
assert_same_file "$SB/settings.orig" "$H/.claude/settings.json" "settings.json byte-identical"
assert_eq "0" "$(ls "$H/.claude" | grep -c wasitme-bak)" "no backup made when nothing is edited"
assert_contains "$(out)" "you already have a status line" "result explains the skip"
assert_contains "$(out)" "$H/.local/bin/wasitme statusline install --wrap" "the engine command that wraps yours is shown, with --wrap (without it the engine leaves an existing status line alone)"
assert_file "$H/.local/bin/wasitme-statusline" "the status-line shim is installed even so (wasitme statusline install needs it)"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --statusline
assert_rc 1 "--statusline explicitly requested but impossible is an error, not a silent skip"
assert_contains "$(err)" "was requested but is not possible" "message says so"

t_section "the status line needs its script and its own shim path"
sb_new
make_fixture "$SB_SRC" 0.1.0 no-sl-script
H=$SB_HOME
mkdir -p "$H/.claude"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "a source without packaging/statusline.sh still installs"
assert_contains "$(out)" "this source has no packaging/statusline.sh" "the status line is skipped, and why"
assert_missing "$H/.local/bin/wasitme-statusline" "no status-line shim without its script"
assert_missing "$H/.claude/settings.json" "settings.json untouched"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude" "$H/.local/bin"
printf '#!/bin/sh\necho mine\n' >"$H/.local/bin/wasitme-statusline"
cp "$H/.local/bin/wasitme-statusline" "$SB/sl.orig"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "someone else's wasitme-statusline is no reason to fail"
assert_same_file "$SB/sl.orig" "$H/.local/bin/wasitme-statusline" "it is left exactly as it was"
assert_contains "$(out)" "belongs to something else" "the status line is skipped, and why"
assert_missing "$H/.claude/settings.json" "settings.json untouched"
assert_file_lacks "$H/.wasitme/install-manifest" "wasitme-statusline" "and it is not recorded as ours"

t_section "an invalid settings.json is never touched"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.claude"
printf '{ "theme": ' >"$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$SB/settings.orig"
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin
assert_rc 0 "install succeeds"
assert_same_file "$SB/settings.orig" "$H/.claude/settings.json" "broken settings.json byte-identical"
assert_contains "$(out)" "not valid JSON" "result explains the skip"

t_section "no settings.json at all"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --statusline --agents claude-code
assert_rc 0 "install with --statusline and no ~/.claude"
assert_file "$H/.claude/settings.json" "settings.json created"
assert_eq "command" "$(json_get "$H/.claude/settings.json" 'd.statusLine.type')" "with our statusLine"
assert_file_has "$H/.wasitme/install-manifest" "$(printf 'createddir\t%s' "$H/.claude")" "the folder we created is recorded"
assert_file_has "$H/.wasitme/install-manifest" "$(printf 'statusline\t%s\t-\t' "$H/.claude/settings.json")" "no backup recorded (there was nothing to back up)"

t_section "claude or codex not installed"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
export WASITME_CLAUDE="$SB/nonexistent/claude" WASITME_CODEX="$SB/nonexistent/codex"
inst_from --yes --no-app --no-scan-agent --no-statusline
assert_rc 0 "install succeeds without either CLI"
assert_contains "$(out)" "the 'claude' command was not found" "claude skip reason shown"
assert_contains "$(out)" "claude plugin marketplace add $H/.wasitme/current" "the manual commands are printed"
assert_contains "$(out)" "the 'codex' command was not found" "codex skip reason shown"
inst_from --yes --no-app --no-scan-agent --no-statusline --claude-plugin
assert_rc 1 "--claude-plugin without claude is an error"
assert_contains "$(err)" "was requested but is not possible" "message says so"

t_section "only the agents you track"
sb_new
make_fixture "$SB_SRC" 0.1.0
inst_from --yes --no-app --no-scan-agent --no-statusline --agents codex
assert_rc 0 "install tracking only codex"
assert_not_contains "$(shimlog)" "claude" "claude plugin not touched when claude is not tracked"
assert_contains "$(shimlog)" "codex plugin add wasitme@wasitme-codex" "codex plugin installed"
assert_eq '["codex"]' "$(json_get "$SB_HOME/.wasitme/engine.json" 'd.agents')" "engine.json records the tracked agents"

if [ "$T_OS" = Darwin ]; then
  t_section "macOS: scan agent, app, bundle, plists (fake swift, fake codesign)"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  CUR="$H/.wasitme/current"
  APP="$H/Applications/wasitme.app"
  LA="$H/Library/LaunchAgents"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "app + scan agent install"
  assert_contains "$(shimlog)" "swift build -c release --package-path $SB/tmp/wasitme-install." "swift build ran on a scratch copy of macos/ inside the temp work dir"
  assert_missing "$SB_SRC/macos/.build" "and the source tree stayed pristine"
  assert_contains "$(shimlog)" "--show-bin-path" "bin path asked from swift"
  assert_contains "$(shimenv)" "swift-env DEVELOPER_DIR=$DEV_DIR" "DEVELOPER_DIR was set for swift"
  assert_eq "xcode-select -p" "$(grep '^xcode-select' "$SHIM_LOG" | sort -u)" "xcode-select was only ever read"
  assert_eq "codesign --force --sign - $H/Applications/.wasitme.app.stage
codesign --verify --deep --strict $H/Applications/.wasitme.app.stage
codesign --verify --deep --strict $APP" "$(grep '^codesign' "$SHIM_LOG")" "sign the stage, verify the stage, verify the installed app"
  assert_eq "launchctl bootstrap gui/$T_UID $LA/$LABEL_SCAN.plist
launchctl bootstrap gui/$T_UID $LA/$LABEL_APP.plist" "$(grep '^launchctl' "$SHIM_LOG")" "both agents bootstrapped into the user's gui domain"
  assert_missing "$H/Applications/.wasitme.app.stage" "no stage left behind"
  assert_missing "$H/Applications/.wasitme.app.prev" "no parked app left behind"
  assert_file "$APP/Contents/MacOS/WasitmeApp" "executable in the bundle"
  assert_eq "-rwxr-xr-x" "$(ls -l "$APP/Contents/MacOS/WasitmeApp" | cut -c1-10)" "executable bit kept"
  assert_file "$APP/Contents/Resources/fake.bundle/hello.txt" "SwiftPM resource bundles are copied into Resources"
  INFO="$APP/Contents/Info.plist"
  assert_eq "OK" "$(plutil -lint "$INFO" | sed 's/^.*: //')" "Info.plist is a valid plist"
  assert_eq "true" "$(plist_get "$INFO" LSUIElement)" "LSUIElement: no Dock icon"
  assert_eq "dev.wasitme.app" "$(plist_get "$INFO" CFBundleIdentifier)" "bundle identifier"
  assert_eq "WasitmeApp" "$(plist_get "$INFO" CFBundleExecutable)" "bundle executable"
  assert_eq "APPL" "$(plist_get "$INFO" CFBundlePackageType)" "package type"
  assert_eq "0.1.0" "$(plist_get "$INFO" CFBundleShortVersionString)" "bundle version"
  assert_eq "14.0" "$(plist_get "$INFO" LSMinimumSystemVersion)" "minimum macOS (14.0, as the README says)"
  assert_eq "en" "$(plist_get "$INFO" CFBundleDevelopmentRegion)" "development region (as macos/support/Info.plist.template)"
  assert_eq "" "$(plist_get "$INFO" CFBundleIconFile)" "no icon in this source, so no CFBundleIconFile pointing at nothing"
  assert_eq "APPL????" "$(cat "$APP/Contents/PkgInfo")" "PkgInfo"
  # The resources build-app.sh ships: without ui/ the app shows its placeholder page, without fonts/ the system font.
  for f in app.html app.js app.css; do
    assert_same_file "$SB_SRC/ui/dist/$f" "$APP/Contents/Resources/ui/$f" "the Control Center page: ui/$f is in the bundle"
  done
  assert_file "$APP/Contents/Resources/ui/fonts/Test-Regular.woff2" "the page's web fonts are in the bundle"
  assert_file "$APP/Contents/Resources/ui/fonts/OFL.txt" "with their licence"
  assert_missing "$APP/Contents/Resources/ui/shots" "ui/dist/shots (test screenshots) is never copied"
  assert_file "$APP/Contents/Resources/fonts/Test-Regular.ttf" "the bundled app fonts (FontRegistry) are in the bundle"
  assert_file "$APP/Contents/Resources/fonts/OFL.txt" "with their licence"
  assert_contains "$(out)" "mac app              installed" "the app is reported installed"
  SP="$LA/$LABEL_SCAN.plist"
  assert_eq "OK" "$(plutil -lint "$SP" | sed 's/^.*: //')" "scan plist is valid"
  assert_eq "$LABEL_SCAN" "$(plist_get "$SP" Label)" "scan label (with the test suffix)"
  ARGS=$(plutil -extract ProgramArguments json -o - "$SP" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).join("\n"))')
  HR=$(cd -P "$H" && pwd -P)
  PERM=""
  if node --permission -e 0 >/dev/null 2>&1; then PERM=--permission; elif node --experimental-permission -e 0 >/dev/null 2>&1; then PERM=--experimental-permission; fi
  if [ -n "$PERM" ]; then
    WANT="$NODE
$PERM
--allow-fs-read=$H/.claude*
--allow-fs-read=$H/.codex*
--allow-fs-read=$H/.wasitme
--allow-fs-read=$HR/.wasitme
--allow-fs-write=$H/.wasitme
--allow-fs-write=$HR/.wasitme
$HR/.wasitme/current/engine/dist/src/cli/main.js
scan
--no-project-files"
  else
    WANT="$NODE
$HR/.wasitme/current/engine/dist/src/cli/main.js
scan
--no-project-files"
  fi
  assert_eq "$WANT" "$ARGS" "scan: absolute node, the sandbox flags (one per path, ~/.claude* and ~/.codex* wildcards, both spellings of ~/.wasitme), the cli via current/, scan --no-project-files"
  assert_eq "900" "$(plist_get "$SP" StartInterval)" "scan every 15 minutes (900 s, D46)"
  assert_eq "$(json_get "$H/.wasitme/engine.json" 'd.scanArgs.join("\n")')" "$(printf '%s\n' "$ARGS" | sed '1d;$d' | sed '$d' | sed '$d')" "engine.json scanArgs = the plist's node arguments (the app and doctor use the same grants)"
  assert_eq "Background" "$(plist_get "$SP" ProcessType)" "scan runs as a background process"
  assert_eq "10" "$(plist_get "$SP" Nice)" "scan is niced"
  assert_eq "true" "$(plist_get "$SP" LowPriorityIO)" "scan uses low-priority IO"
  assert_eq "/dev/null" "$(plist_get "$SP" StandardOutPath)" "scan output is dropped (quiet)"
  assert_eq "$H/.wasitme/logs/scan.log" "$(plist_get "$SP" StandardErrorPath)" "scan errors go to ~/.wasitme/logs"
  assert_eq "drwx------" "$(ls -ld "$H/.wasitme/logs" | cut -c1-10)" "the logs folder is private (700)"
  AP="$LA/$LABEL_APP.plist"
  assert_eq "OK" "$(plutil -lint "$AP" | sed 's/^.*: //')" "app plist is valid"
  assert_eq "$LABEL_APP" "$(plist_get "$AP" Label)" "app label (with the test suffix)"
  assert_eq "$APP/Contents/MacOS/WasitmeApp" "$(plist_get "$AP" ProgramArguments.0)" "app: program is the bundle executable"
  assert_eq "--supervised" "$(plist_get "$AP" ProgramArguments.1)" "app: started --supervised"
  assert_eq "" "$(plist_get "$AP" EnvironmentVariables)" "app: no environment block with the default config folders"
  assert_eq "true" "$(plist_get "$AP" RunAtLoad)" "app starts at login"
  assert_eq "false" "$(plist_get "$AP" KeepAlive.SuccessfulExit)" "conditional KeepAlive: restart only after a crash, Quit stays quit"
  assert_eq "Aqua" "$(plist_get "$AP" LimitLoadToSessionType)" "app only loads in a GUI session"
  assert_contains "$(plist_get "$AP" ProcessType)" "Interactive" "app is an interactive process"
  EJ="$H/.wasitme/engine.json"
  assert_eq "$LABEL_SCAN" "$(json_get "$EJ" 'd.scanLabel')" "engine.json: scan label (hooks kickstart this)"
  assert_eq "$LABEL_APP" "$(json_get "$EJ" 'd.appLabel')" "engine.json: app label"
  assert_eq "$APP" "$(json_get "$EJ" 'd.app')" "engine.json: app path"
  assert_eq "$NODE" "$(json_get "$EJ" 'd.node')" "engine.json still has the absolute node"
  # Cross-package contract: the Claude Code plugin's hooks find the scan label in the engine.json this installer wrote
  # (dry run: the hook prints the launchctl command instead of running it).
  HOOK_OUT=$(env -i PATH=/usr/bin:/bin HOME="$H" WASITME_HOOK_DRY_RUN=1 /bin/sh "$T_REPO/plugin/scripts/session-start.sh" 2>&1 </dev/null)
  assert_eq "/bin/launchctl kickstart gui/$T_UID/$LABEL_SCAN" "$HOOK_OUT" "the plugin's SessionStart hook kicks the installed scan agent"
  MF="$H/.wasitme/install-manifest"
  assert_file_has "$MF" "$(printf 'app\t%s' "$APP")" "manifest: app"
  assert_file_has "$MF" "$(printf 'launchagent\t%s\t%s' "$LABEL_SCAN" "$SP")" "manifest: scan agent"
  assert_file_has "$MF" "$(printf 'launchagent\t%s\t%s' "$LABEL_APP" "$AP")" "manifest: app agent"
  assert_dir "$H/.wasitme/logs" "log folder exists for the agents"

  t_section "macOS: re-run replaces the app and reloads the agents"
  : >"$SHIM_LOG"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "second run succeeds"
  assert_eq "launchctl bootout gui/$T_UID/$LABEL_SCAN
launchctl print gui/$T_UID/$LABEL_SCAN
launchctl bootstrap gui/$T_UID $LA/$LABEL_SCAN.plist
launchctl bootout gui/$T_UID/$LABEL_APP
launchctl print gui/$T_UID/$LABEL_APP
launchctl bootstrap gui/$T_UID $LA/$LABEL_APP.plist" "$(grep '^launchctl' "$SHIM_LOG")" "our own agents are booted out (once), launchd is asked until it has let go, and only then are they loaded again"
  assert_missing "$H/Applications/.wasitme.app.prev" "no parked app left behind after the swap"
  assert_eq "1" "$(ls "$H/Applications" | wc -l | tr -d ' ')" "only wasitme.app lives in ~/Applications"
  assert_eq "$LABEL_SCAN" "$(json_get "$EJ" 'd.scanLabel')" "engine.json still has the scan label after a full re-run"

  t_section "macOS: a re-run that skips a component does not make engine.json forget it"
  inst_from $CORE_ONLY
  assert_rc 0 "re-run with every optional component off"
  assert_eq "$LABEL_SCAN" "$(json_get "$EJ" 'd.scanLabel')" "scanLabel is still set (the agent is still installed and loaded)"
  assert_eq "$LABEL_APP" "$(json_get "$EJ" 'd.appLabel')" "appLabel is still set"
  assert_eq "$APP" "$(json_get "$EJ" 'd.app')" "app is still set"
  assert_file "$LA/$LABEL_SCAN.plist" "and the scan plist really is still there"
  assert_eq "$NODE" "$(json_get "$EJ" 'd.node')" "node is still recorded"

  t_section "macOS: a re-load waits until launchd has let go of the old job"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  LA="$H/Library/LaunchAgents"
  inst_from --yes --no-app --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "first install"
  : >"$SHIM_LOG"
  export SHIM_LAUNCHCTL_PRINT_LOADED=3
  inst_from --yes --no-app --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "re-run while launchd is slow to unload the job"
  assert_eq "launchctl bootout gui/$T_UID/$LABEL_SCAN
launchctl print gui/$T_UID/$LABEL_SCAN
launchctl print gui/$T_UID/$LABEL_SCAN
launchctl print gui/$T_UID/$LABEL_SCAN
launchctl print gui/$T_UID/$LABEL_SCAN
launchctl bootstrap gui/$T_UID $LA/$LABEL_SCAN.plist" "$(grep '^launchctl' "$SHIM_LOG")" "three polls still say loaded, the fourth says gone, and only then does bootstrap run"
  assert_not_contains "$(err)" "Could not find service" "the expected non-zero exit of the poll is not shown as an error"
  assert_not_contains "$(out)" "next login" "no 'load at next login' fallback was needed"
  : >"$SHIM_LOG"
  export SHIM_LAUNCHCTL_PRINT_LOADED=99 WASITME_AGENT_WAIT_TRIES=3
  inst_from --yes --no-app --no-claude-plugin --no-codex-plugin --no-statusline
  unset SHIM_LAUNCHCTL_PRINT_LOADED WASITME_AGENT_WAIT_TRIES
  assert_rc 0 "a job that never goes away does not hang the installer"
  assert_eq "3" "$(grep -c '^launchctl print' "$SHIM_LOG")" "the wait is bounded"
  assert_contains "$(err)" "still lists $LABEL_SCAN" "and says so"
  assert_contains "$(shimlog)" "launchctl bootstrap gui/$T_UID $LA/$LABEL_SCAN.plist" "bootstrap is still attempted"
  : >"$SHIM_LOG"
  inst_from --dry-run --yes --no-app --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "dry run of a re-run"
  assert_line "$T_OUT" "[dry-run] launchctl bootout gui/$T_UID/$LABEL_SCAN" "the unload is planned"
  assert_line "$T_OUT" "[dry-run] (wait until launchd has unloaded $LABEL_SCAN)" "and so is the wait"
  assert_eq "0" "$(grep -c '^launchctl' "$SHIM_LOG")" "a dry run never calls launchctl, not even to poll"

  t_section "macOS: the app needs its Control Center page and fonts; a checkout without ui/dist builds one in a scratch copy"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 "macos-fake no-ui"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 3 "no ui/dist and no TypeScript: the app fails (the engine stays installed)"
  assert_contains "$(out)" "no built Control Center page (ui/dist)" "the reason is stated"
  assert_contains "$(out)" "use a release tarball" "and the way out"
  assert_eq "0" "$(grep -c '^swift' "$SHIM_LOG")" "it is found out before a minute of Swift build"
  assert_missing "$SB_HOME/Applications/wasitme.app" "no placeholder app is installed"
  assert_file "$SB_HOME/.local/bin/wasitme" "the engine is installed all the same"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 "macos-fake ui-src"
  rm -rf "$SB_SRC/node_modules"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 3 "ui/ sources but no TypeScript to build them: the app fails"
  assert_contains "$(out)" "node ui/scripts/build.mjs" "and the fix is named"
  assert_missing "$SB_HOME/Applications/wasitme.app" "no placeholder app is installed"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 "macos-fake no-fonts"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 3 "no bundled fonts: the app fails"
  assert_contains "$(out)" "no bundled fonts" "the reason is stated"
  assert_missing "$SB_HOME/Applications/wasitme.app" "no app with the wrong type is installed"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 "macos-fake ui-src"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 0 "ui/ sources + TypeScript next to them: the page is built"
  assert_contains "$(out)" "Building the Control Center page" "the build is announced"
  assert_eq "built app.html" "$(cat "$SB_HOME/Applications/wasitme.app/Contents/Resources/ui/app.html")" "the freshly built page is what the bundle carries"
  assert_file "$SB_HOME/Applications/wasitme.app/Contents/Resources/ui/fonts/Built-Regular.woff2" "with its fonts"
  assert_missing "$SB_SRC/ui/dist" "the source tree got no ui/dist (built in a scratch copy)"
  assert_missing "$SB_SRC/ui/src/gen" "nor anything else"

  t_section "macOS: the app icon is rendered from the design's SVG (sips + iconutil)"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  mkdir -p "$SB_SRC/design/system/glyphs"
  printf '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="200" fill="#1d3557"/></svg>\n' >"$SB_SRC/design/system/glyphs/appicon-1024.svg"
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 0 "install with an icon source"
  if [ -f "$SB_HOME/Applications/wasitme.app/Contents/Resources/AppIcon.icns" ]; then
    t_pass
    assert_eq "AppIcon" "$(plist_get "$SB_HOME/Applications/wasitme.app/Contents/Info.plist" CFBundleIconFile)" "CFBundleIconFile names it"
  else
    # sips renders SVG on current macOS; an older one may not, and then the app keeps the generic icon (a warning).
    assert_contains "$(err)" "the app gets the generic icon" "no icon: a warning, never a failure"
  fi

  t_section "macOS: a custom CLAUDE_CONFIG_DIR / CODEX_HOME reaches the app as well as the scan agent"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  H=$SB_HOME
  mkdir -p "$SB/cfg/claude" "$SB/cfg/codex"
  # No --home here (it pins the default folders): HOME itself is the sandbox, launchctl and every tool are shims.
  T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
  HOME="$H" CLAUDE_CONFIG_DIR="$SB/cfg/claude" CODEX_HOME="$SB/cfg/codex" WASITME_TTY="$SB/no-tty" PATH="$SB/shims:$BASE_PATH" \
    "$SH_BIN" "$T_REPO/scripts/install.sh" --from "$SB_SRC" --yes --no-claude-plugin --no-codex-plugin --no-statusline >"$T_OUT" 2>"$T_ERR" </dev/null
  T_RC=$?
  assert_rc 0 "install with custom config folders"
  AP="$H/Library/LaunchAgents/$LABEL_APP.plist"
  SP="$H/Library/LaunchAgents/$LABEL_SCAN.plist"
  assert_eq "$SB/cfg/claude" "$(plist_get "$SP" EnvironmentVariables.WASITME_CLAUDE_DIR)" "scan agent: the Claude Code folder"
  assert_eq "$SB/cfg/claude" "$(plist_get "$AP" EnvironmentVariables.CLAUDE_CONFIG_DIR)" "app agent: the same Claude Code folder, under the name the app passes to the engine"
  assert_eq "$SB/cfg/codex" "$(plist_get "$AP" EnvironmentVariables.CODEX_HOME)" "app agent: the same Codex folder"
  assert_eq "$SB/cfg/claude" "$(json_get "$H/.wasitme/engine.json" 'd.claudeDir')" "engine.json records the Claude Code folder"
  assert_eq "$SB/cfg/codex" "$(json_get "$H/.wasitme/engine.json" 'd.codexDir')" "engine.json records the Codex folder"
  HOME="$H" WASITME_TTY="$SB/no-tty" PATH="$SB/shims:$BASE_PATH" "$SH_BIN" "$H/.wasitme/current/scripts/uninstall.sh" --yes >"$T_OUT" 2>"$T_ERR" </dev/null
  T_RC=$?
  assert_rc 0 "and it uninstalls"
  assert_missing "$AP" "app plist removed"

  t_section "macOS: a --home install with no label suffix and no launchctl never names the real scan agent"
  sb_new
  make_fixture "$SB_SRC" 0.1.0
  H=$SB_HOME
  unset WASITME_LABEL_SUFFIX WASITME_LAUNCHCTL
  inst_from --yes --no-app --scan-agent --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "install with the scan agent"
  assert_contains "$(out)" "launchctl skipped" "launchd is left alone under --home"
  SUF="home-$(printf '%s' "$H" | cksum | awk '{ print $1 }')"
  assert_file "$H/Library/LaunchAgents/dev.wasitme.scan.$SUF.plist" "the sandbox plist carries a label derived from the home"
  assert_missing "$H/Library/LaunchAgents/dev.wasitme.scan.plist" "never the real label"
  assert_eq "dev.wasitme.scan.$SUF" "$(plist_get "$H/Library/LaunchAgents/dev.wasitme.scan.$SUF.plist" Label)" "inside the plist too"
  assert_line "$H/.wasitme/engine.env" "scan_label=" "engine.env advertises no label: launchd never loaded the job"
  assert_eq "null" "$(json_get "$H/.wasitme/engine.json" 'd.scanLabel')" "engine.json neither"
  assert_eq "" "$(env -i PATH=/usr/bin:/bin HOME="$H" WASITME_HOOK_DRY_RUN=1 /bin/sh "$T_REPO/plugin/scripts/session-end.sh" 2>&1 </dev/null)" "so the plugin's hooks kick nothing"
  assert_eq "0" "$(grep -c '^launchctl' "$SHIM_LOG")" "launchctl never ran"
  uninst --yes
  assert_rc 0 "uninstall finds the same derived label"
  assert_eq "." "$(tree_of "$H")" "and leaves the home empty"

  t_section "macOS: --no-app and --no-scan-agent"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  inst_from --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --no-statusline
  assert_rc 0 "install without app or agents"
  assert_eq "0" "$(grep -c '^swift' "$SHIM_LOG")" "swift never ran"
  assert_eq "0" "$(grep -c '^launchctl' "$SHIM_LOG")" "launchctl never ran"
  assert_missing "$SB_HOME/Applications" "no ~/Applications created"
  assert_missing "$SB_HOME/Library" "no ~/Library created"

  t_section "macOS: no toolchain / no macos folder"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  export WASITME_DEVELOPER_DIRS=/nonexistent
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  unset WASITME_DEVELOPER_DIRS
  assert_rc 0 "missing toolchain is a clear skip, not a failure"
  assert_contains "$(out)" "no Swift toolchain found" "reason shown"
  assert_contains "$(out)" "xcode-select --install" "the exact hint is shown"
  assert_missing "$SB_HOME/Applications" "no app directory created"
  export WASITME_DEVELOPER_DIRS=/nonexistent
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent --app
  unset WASITME_DEVELOPER_DIRS
  assert_rc 1 "--app with no toolchain is an error"
  sb_new
  make_fixture "$SB_SRC" 0.1.0
  inst_from --yes --no-claude-plugin --no-codex-plugin --no-statusline --no-scan-agent
  assert_rc 0 "no macos/ folder is a clear skip"
  assert_contains "$(out)" "no macos/ folder" "reason shown"

  t_section "macOS: toolchain detection order (never touches xcode-select)"
  sb_new
  make_fixture "$SB_SRC" 0.1.0 macos-fake
  for n in A B C; do mkdir -p "$SB/dev$n/usr/bin"; printf '#!/bin/sh\nexit 0\n' >"$SB/dev$n/usr/bin/swift"; chmod +x "$SB/dev$n/usr/bin/swift"; done
  export WASITME_DEVELOPER_DIRS="$SB/devA:$SB/devB"
  export SHIM_XCODE_P="$SB/devC"
  inst_from --dry-run --yes --app --no-scan-agent --no-claude-plugin --no-codex-plugin --no-statusline
  assert_contains "$(out)" "env DEVELOPER_DIR=$SB/devC " "the active xcode-select dir wins when it is valid"
  export SHIM_XCODE_P="$SB/not-there"
  inst_from --dry-run --yes --app --no-scan-agent --no-claude-plugin --no-codex-plugin --no-statusline
  assert_contains "$(out)" "env DEVELOPER_DIR=$SB/devA " "otherwise the first valid Xcode location is used"
  export WASITME_DEVELOPER_DIRS="$SB/nope:$SB/devB"
  inst_from --dry-run --yes --app --no-scan-agent --no-claude-plugin --no-codex-plugin --no-statusline
  assert_contains "$(out)" "env DEVELOPER_DIR=$SB/devB " "invalid candidates are skipped"
  export DEVELOPER_DIR="$SB/devC"
  inst_from --dry-run --yes --app --no-scan-agent --no-claude-plugin --no-codex-plugin --no-statusline
  unset DEVELOPER_DIR
  assert_contains "$(out)" "env DEVELOPER_DIR=$SB/devC " "a valid DEVELOPER_DIR from the environment wins"
  unset WASITME_DEVELOPER_DIRS SHIM_XCODE_P
  assert_not_contains "$(shimlog)" "xcode-select -s" "xcode-select is never switched"
fi

t_section "building the engine when the source has no dist/"
sb_new
make_fixture "$SB_SRC" 0.3.0 no-dist
write_fake_cli "$SB/built-cli.js" 0.3.0
export SHIM_CLI_FILE="$SB/built-cli.js"
inst_from $CORE_ONLY
assert_rc 0 "install builds the engine in a scratch copy"
assert_contains "$(shimlog)" "npm ci --ignore-scripts --no-audit --no-fund" "npm ci runs with --ignore-scripts"
assert_contains "$(shimlog)" "npm run build -w engine" "the build script runs for the engine workspace"
assert_contains "$(shimenv)" "npm-cwd $SB/tmp/wasitme-install." "npm ran inside a scratch directory, not in the source"
assert_missing "$SB_SRC/engine/dist" "the source tree got no dist/"
assert_missing "$SB_SRC/node_modules" "the source tree got no node_modules"
assert_eq "wasitme 0.3.0" "$("$SB_HOME/.local/bin/wasitme" --version)" "the freshly built engine is what was installed"
assert_contains "$(out)" "downloads TypeScript from the npm registry" "the network use is announced before it happens"

sb_new
make_fixture "$SB_SRC" 0.3.0 no-dist
export WASITME_NPM="$SB/nonexistent/npm"
inst_from $CORE_ONLY
assert_rc 1 "no npm and no prebuilt dist/ is a clear error"
assert_contains "$(err)" "npm was not found" "message explains"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was created"

sb_new
make_fixture "$SB_SRC" 0.3.0 no-dist
export SHIM_FAIL_NPM="run build"
inst_from $CORE_ONLY
assert_rc 1 "a failing build stops the install"
assert_contains "$(err)" "building the engine failed" "message explains"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was installed after a failed build"

sb_new
make_fixture "$SB_SRC" 0.3.0
inst_from $CORE_ONLY
assert_rc 0 "a checkout whose dist/ is current installs"
assert_not_contains "$(err)" "newer than its built engine/dist" "no stale-build warning when dist/ is newer than src/"

sb_new
make_fixture "$SB_SRC" 0.3.0
touch -t 203001010000 "$SB_SRC/engine/src/cli/main.js"   # a source edit after the last build
inst_from $CORE_ONLY
assert_rc 0 "a stale dist/ still installs (warn, never write to the source tree)"
assert_contains "$(err)" "has changes newer than its built engine/dist" "a stale local build is called out"
assert_contains "$(err)" "Run 'npm run build' in $SB_SRC first" "the warning says how to fix it"
assert_missing "$SB_SRC/node_modules" "the source tree was not written to"

t_done
