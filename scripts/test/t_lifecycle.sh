#!/bin/sh
# End to end, in one temp HOME seeded with synthetic agent config and logs: install 0.1.0 -> update to 0.2.0 -> update
# to 0.3.0 -> uninstall. claude and codex are STATEFUL stand-ins (fake-agents.mjs: they keep plugin bookkeeping the way
# the spikes observed the real CLIs doing it); launchctl, codesign, swift and pkill are recording shims. Nothing real is
# touched: no real ~/.claude, ~/.codex, ~/Library, launchd or login.
#
# What it checks (the WP-70 acceptance list):
#   - the agents' log folders are byte-identical after every step;
#   - every config change stays inside an allow-list (settings.json gains only statusLine plus the plugin keys Claude
#     Code itself writes there; config.toml gains only wasitme's two tables; the CLIs' own plugin registries; our files);
#   - after uninstall the home is byte-identical except the history wasitme keeps on purpose and what Claude Code
#     itself leaves in settings.json (its three plugin keys as {}, observed in S-INST; the original is kept as a backup);
#   - the background scan's exact ProgramArguments, run with the real node, can read the logs (and ~/.claude.json)
#     and write ~/.wasitme, and nothing else; the same for the session hook's snapshot command;
#   - updates keep the Claude plugin's saved options (D50) and move Codex to the new version (D49).
# T_RC, T_OUT and T_ERR are set in this file and read by assert_rc, out and err in harness.sh. The linter looks at one file at a time
# and would call them unused (SC2034); this single directive, before the first command, covers the file.
# shellcheck disable=SC2034
. "$(dirname "$0")/harness.sh"

if [ "$T_OS" != Darwin ]; then printf '%s: skipped (the LaunchAgent half is macOS only)\n' "$T_NAME"; exit 0; fi
PERM=""
if node --permission -e 0 >/dev/null 2>&1; then PERM=--permission; elif node --experimental-permission -e 0 >/dev/null 2>&1; then PERM=--experimental-permission; fi

# A stand-in engine that probes the sandbox: what it may do (read logs, write ~/.wasitme) and what it must not.
probe_cli() {  # probe_cli FILE VERSION
  cat >"$1" <<EOF
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("wasitme $2"); process.exit(0); }
if (a[0] === "--help") { console.log("usage:\\n  wasitme scan\\n  wasitme hook session-start\\n  wasitme doctor [--repair]"); process.exit(0); }
const home = process.env.HOME;
const r = [];
const t = (n, f) => { try { f(); r.push(n + "=ok"); } catch (e) { r.push(n + "=" + (e.code || "error")); } };
if (a[0] === "doctor") {
  if (process.env.SHIM_ENGINE_LOG) fs.appendFileSync(process.env.SHIM_ENGINE_LOG, "engine " + a.join(" ") + " WASITME_INSTALLER_ACTIVE=" + (process.env.WASITME_INSTALLER_ACTIVE || "") + "\\n");
  process.exit(0);
}
if (a[0] === "scan") {
  t("listClaude", () => fs.readdirSync(home + "/.claude"));
  t("readClaudeLog", () => fs.readFileSync(home + "/.claude/projects/-u-app/s1.jsonl"));
  t("readClaudeJson", () => fs.readFileSync(home + "/.claude.json"));
  t("readCodexLog", () => fs.readFileSync(home + "/.codex/sessions/2026/10/01/rollout-1.jsonl"));
  t("readCodexConfig", () => fs.readFileSync(home + "/.codex/config.toml"));
  t("readOutside", () => fs.readFileSync(home + "/Documents/secret.txt"));
  t("writeClaude", () => fs.writeFileSync(home + "/.claude/injected.txt", "x"));
  t("spawn", () => execFileSync("/bin/echo", ["x"]));
  t("writeWasitme", () => fs.writeFileSync(home + "/.wasitme/glance.json", "{}\\n"));
  fs.writeFileSync(home + "/.wasitme/scan-result", r.join(" ") + "\\n");
  console.log("scanned");
}
if (a[0] === "hook") {
  const cwd = a[a.indexOf("--cwd") + 1];
  t("readProject", () => fs.readFileSync(cwd + "/CLAUDE.md"));
  t("readClaudeLog", () => fs.readFileSync(home + "/.claude/projects/-u-app/s1.jsonl"));
  t("writeProject", () => fs.writeFileSync(cwd + "/x.txt", "x"));
  fs.mkdirSync(home + "/.wasitme/state", { recursive: true });
  fs.writeFileSync(home + "/.wasitme/state/hook-result", a.slice(0, 2).join(" ") + " " + r.join(" ") + "\\n");
}
EOF
}

fixture() {  # fixture VERSION
  make_fixture "$SB_SRC" "$1" macos-fake
  probe_cli "$SB_SRC/engine/dist/src/cli/main.js" "$1"
}

sb_new
export SHIM_STATEFUL=1
H=$SB_HOME
W="$H/.wasitme"
CUR="$W/current"
# ---- a synthetic home: agent config, logs, someone else's LaunchAgent, a shell profile, a project, a private file --
mkdir -p "$H/.claude/projects/-u-app" "$H/.codex/sessions/2026/10/01" "$H/Library/LaunchAgents" "$H/code/app" "$H/Documents"
printf '{\n  "theme": "dark",\n  "env": { "CANARY": "leak-canary-claude-123" }\n}\n' >"$H/.claude/settings.json"
printf '{"type":"user","message":"synthetic prompt","sessionId":"s1"}\n{"type":"assistant","message":"synthetic answer"}\n' >"$H/.claude/projects/-u-app/s1.jsonl"
printf '{"type":"user","message":"second"}\n' >"$H/.claude/projects/-u-app/s2.jsonl"
printf '{"numStartups": 3}\n' >"$H/.claude.json"
printf '# my codex config\nmodel = "gpt-x"\nnotify = ["say", "done"] # keep me\n\n[mcp_servers.demo]\ncommand = "demo"\nenv = { TOKEN = "leak-canary-codex-456" }\n' >"$H/.codex/config.toml"
chmod 600 "$H/.codex/config.toml"
printf '{"type":"session_meta","payload":{"source":"cli"}}\n' >"$H/.codex/sessions/2026/10/01/rollout-1.jsonl"
printf '<plist>someone else</plist>\n' >"$H/Library/LaunchAgents/com.other.agent.plist"
printf '# my profile\nexport EDITOR=vi\n' >"$H/.zprofile"
printf 'project instructions\n' >"$H/code/app/CLAUDE.md"
printf 'private\n' >"$H/Documents/secret.txt"
fs_snapshot "$H" >"$SB/home.pre"
fs_snapshot "$H/.claude/projects" >"$SB/claude-logs.pre"
fs_snapshot "$H/.codex/sessions" >"$SB/codex-logs.pre"

logs_unchanged() {  # logs_unchanged STEP
  fs_snapshot "$H/.claude/projects" >"$SB/claude-logs.now"
  fs_snapshot "$H/.codex/sessions" >"$SB/codex-logs.now"
  assert_same_file "$SB/claude-logs.pre" "$SB/claude-logs.now" "$1: Claude Code's log folder is byte-identical"
  assert_same_file "$SB/codex-logs.pre" "$SB/codex-logs.now" "$1: Codex's log folder is byte-identical"
}

# Every changed path must be one wasitme may touch. Configs get a content check of their own below.
ALLOW='^(\.wasitme(/.*)?|\.local|\.local/bin|\.local/bin/wasitme|\.local/bin/wasitme-statusline|Applications(/.*)?|Library/LaunchAgents/dev\.wasitme\.(scan|menubar)\.[A-Za-z0-9._-]+\.plist|\.claude/settings\.json|\.claude/settings\.json\.wasitme-bak-[0-9]+|\.claude/plugins(/.*)?|\.codex/config\.toml|\.codex/plugins(/.*)?)$'
config_within_allow_list() {  # config_within_allow_list STEP
  fs_snapshot "$H" >"$SB/home.now"
  snapshot_changes "$SB/home.pre" "$SB/home.now" >"$SB/changed"
  bad=$(grep -Ev "$ALLOW" "$SB/changed" || true)
  assert_eq "" "$bad" "$1: every changed path is on the allow-list"
  # settings.json: wasitme adds statusLine; Claude Code adds its own plugin keys; every seed key is deep-equal.
  assert_eq "enabledPlugins,extraKnownMarketplaces,pluginConfigs,statusLine" "$(settings_diff)" "$1: settings.json differs from the seed only by statusLine and Claude Code's own plugin keys"
  # config.toml: the seed, then exactly the two tables Codex writes for wasitme (S-CX 2.2).
  # (Codex appends tables, so after a re-registration their order may differ; the content may not.)
  cx_src=$(cd -P "$CUR/plugin-codex" && pwd -P)
  assert_eq "ok" "$(node -e '
    const fs = require("fs"); const [seedF, cfgF, src] = process.argv.slice(1);
    const seed = fs.readFileSync(seedF, "utf8"), cfg = fs.readFileSync(cfgF, "utf8");
    if (!cfg.startsWith(seed)) { console.log("the seed is not kept byte for byte at the top"); process.exit(); }
    const blocks = cfg.slice(seed.length).split(/\n(?=\[)/).map((b) => b.trim()).filter(Boolean).sort();
    const want = [`[marketplaces.wasitme-codex]\nsource_type = "local"\nsource = "${src}"`, `[plugins."wasitme@wasitme-codex"]\nenabled = true`].sort();
    console.log(JSON.stringify(blocks) === JSON.stringify(want) ? "ok" : "extra or wrong tables: " + JSON.stringify(blocks));
  ' "$SB/config.seed" "$H/.codex/config.toml" "$cx_src")" "$1: config.toml is the seed byte for byte plus exactly wasitme's two tables, pointing at the current version's resolved root"
}
cp "$H/.claude/settings.json" "$SB/settings.seed"
settings_diff() {  # the keys of settings.json that are new or changed against the seed, sorted
  node -e '
    const fs = require("fs"); const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const extra = Object.keys(b).filter((k) => !(k in a)); const changed = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    console.log([...extra.sort(), ...changed.map((k) => "changed:" + k)].join(","));' "$SB/settings.seed" "$H/.claude/settings.json"
}
cp "$H/.codex/config.toml" "$SB/config.seed"

FLAGS="--yes --agents claude-code,codex --claude-plugin --codex-plugin --statusline --scan-agent --app"

t_section "install 0.1.0"
fixture 0.1.0
inst_from $FLAGS
assert_rc 0 "install"
logs_unchanged "install"
config_within_allow_list "install"
CR="$H/.claude/plugins/installed_plugins.json"
assert_eq "$CUR" "$(json_get "$H/.claude/plugins/known_marketplaces.json" 'd.wasitme.path')" "Claude Code keeps the marketplace at the unresolved current symlink (D32)"
assert_eq "0.1.0" "$(json_get "$CR" 'd["wasitme@wasitme"].version')" "Claude Code has 0.1.0 installed"
SJ="$H/.claude/settings.json"
assert_eq "$W/glance.json" "$(json_get "$SJ" 'd.pluginConfigs["wasitme@wasitme"].options.glancePath')" "and its glancePath option is the absolute path (D50)"
assert_eq "$CUR" "$(json_get "$SJ" 'd.extraKnownMarketplaces.wasitme.source.path')" "settings.json names the marketplace at current too"
BAK=$(ls "$H/.claude"/settings.json.wasitme-bak-* 2>/dev/null | head -1)
assert_same_file "$SB/settings.seed" "$BAK" "the status line's backup is the person's own file (taken before Claude Code wrote its plugin keys)"
assert_dir "$H/.codex/plugins/cache/wasitme-codex/wasitme/0.1.0" "Codex cached 0.1.0"
# Exactly the root the installer staged, file for file (Codex copies the whole marketplace root), and nothing named
# hooks* anywhere in the cache: a plugin's hooks would land at hooks/hooks.json, never at the cache root.
assert_eq "$(tree_of "$SB_SRC/plugin-codex")" "$(tree_of "$H/.codex/plugins/cache/wasitme-codex/wasitme/0.1.0")" "Codex cached exactly the plugin-codex root"
assert_eq "" "$(find "$H/.codex/plugins/cache" -name 'hooks*')" "with no hooks file anywhere (skills only)"
assert_same_file "$SB_SRC/plugin-codex/skills/report/SKILL.md" "$H/.codex/plugins/cache/wasitme-codex/wasitme/0.1.0/skills/report/SKILL.md" "the skill arrives byte for byte"
assert_eq "" "$(find "$W/versions/0.1.0" -perm -u+w | head -1)" "the version folder is read-only"
assert_contains "$(cat "$SHIM_ENGINE_LOG")" "engine doctor --repair WASITME_INSTALLER_ACTIVE=1" "the installed engine's doctor --repair ran, flagged so it cannot call back into the installer"

t_section "the scan agent's exact command, run with the real node"
SP="$H/Library/LaunchAgents/$LABEL_SCAN.plist"
plutil -extract ProgramArguments json -o - "$SP" | node -e 'for (const a of JSON.parse(require("fs").readFileSync(0, "utf8"))) console.log(a)' >"$SB/args"
set --
while IFS= read -r a; do set -- "$@" "$a"; done <"$SB/args"
assert_eq "--no-project-files" "$(eval "printf '%s' \"\${$#}\"")" "the last argument is --no-project-files"
( cd / && env -i HOME="$H" PATH=/usr/bin:/bin "$@" >/dev/null 2>&1 )
RC=$?
assert_eq "0" "$RC" "it runs (exit 0) the way launchd would start it: cwd /, an empty environment but HOME"
if [ -n "$PERM" ]; then
  assert_eq "listClaude=ok readClaudeLog=ok readClaudeJson=ok readCodexLog=ok readCodexConfig=ok readOutside=ERR_ACCESS_DENIED writeClaude=ERR_ACCESS_DENIED spawn=ERR_ACCESS_DENIED writeWasitme=ok" "$(cat "$W/scan-result" 2>/dev/null)" "under the sandbox it reads both agents' logs and ~/.claude.json, writes ~/.wasitme, and nothing else (no other files, no child processes)"
else
  printf '%s: this node has no permission flag; the sandbox half of the check was skipped\n' "$T_NAME"
fi
assert_missing "$H/.claude/injected.txt" "nothing was written into ~/.claude"

t_section "the session hook's snapshot command, run with the real node"
# (the fixture's plugin has no scripts; the repo's real hook script reads the engine.env this install wrote)
LINE=$(printf '{"session_id":"life-1","cwd":"%s/code/app"}' "$H" | env -i PATH=/usr/bin:/bin HOME="$H" WASITME_HOOK_DRY_RUN=1 /bin/sh "$T_REPO/plugin/scripts/session-start.sh" 2>&1 | head -n 1)
if [ -n "$PERM" ]; then
  assert_contains "$LINE" "$PERM --allow-fs-read=$W" "the hook runs the engine under the recorded permission flag"
  assert_contains "$LINE" "hook session-start --cwd $H/code/app --session life-1" "with --cwd and --session (D60)"
  set -f
  set -- $LINE
  set +f
  (cd "$H/code/app" && env -i HOME="$H" PATH=/usr/bin:/bin "$@" >/dev/null 2>&1)
  assert_eq "hook session-start readProject=ok readClaudeLog=ERR_ACCESS_DENIED writeProject=ERR_ACCESS_DENIED" "$(cat "$W/state/hook-result" 2>/dev/null)" "the snapshot reads the project and nothing else, and writes only ~/.wasitme"
  assert_missing "$H/code/app/x.txt" "the project was not written to"
fi

t_section "update to 0.2.0: options kept, Codex moved, logs untouched"
printf '{"showBand":"false"}' | env CLAUDE_CONFIG_DIR="$H/.claude" HOME="$H" node "$T_DIR/fake-agents.mjs" claude plugin configure wasitme@wasitme --values-stdin >/dev/null
fixture 0.2.0
inst_from $FLAGS
assert_rc 0 "update"
assert_link "$CUR" "versions/0.2.0" "current flipped"
assert_eq "0.2.0" "$(json_get "$CR" 'd["wasitme@wasitme"].version')" "claude plugin update recorded 0.2.0"
assert_eq "false" "$(json_get "$SJ" 'd.pluginConfigs["wasitme@wasitme"].options.showBand')" "the person's own option survived the update (no uninstall, no marketplace remove: D50)"
assert_eq "$W/glance.json" "$(json_get "$SJ" 'd.pluginConfigs["wasitme@wasitme"].options.glancePath')" "and so did glancePath"
assert_dir "$H/.codex/plugins/cache/wasitme-codex/wasitme/0.2.0" "Codex now runs 0.2.0"
assert_missing "$H/.codex/plugins/cache/wasitme-codex/wasitme/0.1.0" "and dropped its 0.1.0 copy"
assert_eq "$(tree_of "$SB_SRC/plugin-codex")" "$(tree_of "$H/.codex/plugins/cache/wasitme-codex/wasitme/0.2.0")" "and its cache is exactly the new plugin-codex root"
assert_dir "$W/versions/0.1.0" "0.1.0 is kept for a rollback"
logs_unchanged "update to 0.2.0"
config_within_allow_list "update to 0.2.0"
assert_eq "0" "$(env CODEX_HOME="$H/.codex" HOME="$H" node "$T_DIR/fake-agents.mjs" codex plugin list >/dev/null 2>&1; echo $?)" "codex plugin list works (its registered folder exists)"

t_section "update to 0.3.0: 0.1.0 is pruned once nothing points at it"
fixture 0.3.0
inst_from $FLAGS
assert_rc 0 "update"
assert_missing "$W/versions/0.1.0" "0.1.0 removed"
assert_dir "$W/versions/0.2.0" "0.2.0 kept (previous)"
assert_eq "0" "$(env CODEX_HOME="$H/.codex" HOME="$H" node "$T_DIR/fake-agents.mjs" codex plugin list >/dev/null 2>&1; echo $?)" "codex plugin list still works: the pruned folder was not the one Codex uses"
logs_unchanged "update to 0.3.0"
config_within_allow_list "update to 0.3.0"

t_section "repair (what doctor --repair runs) with a node that moved"
mkdir -p "$SB/node2"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v node)" >"$SB/node2/node"
chmod +x "$SB/node2/node"
: >"$SHIM_LOG"
WASITME_TTY="$SB/no-tty" PATH="$SB/node2:$SB/shims:$BASE_PATH" "$SH_BIN" "$CUR/scripts/install.sh" --repair --home "$H" >"$SB/out.txt" 2>"$SB/err.txt" </dev/null
T_RC=$?; T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
assert_rc 0 "install.sh --repair from the installed copy"
assert_eq "$SB/node2/node" "$(json_get "$W/engine.json" 'd.node')" "engine.json follows the node found now"
assert_line "$W/engine.env" "node=$SB/node2/node" "so does engine.env (the hooks)"
assert_eq "$SB/node2/node" "$(plist_get "$H/Library/LaunchAgents/$LABEL_SCAN.plist" ProgramArguments.0)" "and the scan agent"
assert_file_has "$H/.local/bin/wasitme" "$SB/node2/node" "and the command"
assert_not_contains "$(shimlog)" "swift build" "the app is not rebuilt"
assert_not_contains "$(shimlog)" "plugin install" "no plugin is reinstalled"
assert_not_contains "$(shimlog)" "uninstall" "nothing is uninstalled"
logs_unchanged "repair"
config_within_allow_list "repair"

t_section "uninstall: the home is byte-identical except the history wasitme keeps"
fs_snapshot "$H" >"$SB/home.before-dry"
uninst --dry-run --yes
assert_rc 0 "dry run"
fs_snapshot "$H" >"$SB/home.after-dry"
assert_same_file "$SB/home.before-dry" "$SB/home.after-dry" "a dry-run uninstall changes nothing"
uninst --yes
assert_rc 0 "uninstall"
fs_snapshot "$H" >"$SB/home.post"
snapshot_changes "$SB/home.pre" "$SB/home.post" >"$SB/changed"
assert_eq ".claude/settings.json
$(basename "$(dirname "$BAK")")/$(basename "$BAK")
.wasitme
.wasitme/glance.json
.wasitme/scan-result
.wasitme/state
.wasitme/state/hook-result" "$(cat "$SB/changed")" "left: what the engine itself wrote (history), and settings.json + its backup; config.toml, the profile, the LaunchAgents folder, every log: byte-identical"
assert_eq "enabledPlugins,extraKnownMarketplaces,pluginConfigs" "$(settings_diff)" "settings.json: statusLine is gone; only Claude Code's own plugin keys remain"
assert_eq "{}|{}|{}" "$(json_get "$SJ" '[d.enabledPlugins, d.extraKnownMarketplaces, d.pluginConfigs].map((x) => JSON.stringify(x)).join("|")')" "and they are empty (what the real CLI leaves, S-INST)"
assert_same_file "$SB/settings.seed" "$BAK" "the backup kept next to it is the original, byte for byte"
assert_contains "$(out)" "your file from before the install is kept at $BAK" "and the uninstaller says where"
logs_unchanged "uninstall"
assert_missing "$H/.claude/plugins" "Claude Code's plugin registry is back to nothing (plugin uninstall + marketplace remove)"
assert_missing "$H/.codex/plugins" "Codex's plugin cache is empty again (plugin remove before marketplace remove)"

t_done
