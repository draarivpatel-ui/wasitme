#!/bin/sh
# Guided setup: questions are read from a terminal (here: a file of answers via WASITME_TTY), one per component.
. "$(dirname "$0")/harness.sh"

# answers "line1" "line2" ...: write the answer file and point the installer at it.
answers() {
  : >"$SB/answers.txt"
  for a in "$@"; do printf '%s\n' "$a" >>"$SB/answers.txt"; done
  export WASITME_TTY="$SB/answers.txt"
}
fresh() {
  sb_new
  make_fixture "$SB_SRC" 0.1.0 "${1:-}"
  H=$SB_HOME
  mkdir -p "$H/.claude" "$H/.codex"
  PRE=$(tree_of "$H")
}
NOFLAGS="--no-app --no-scan-agent"

t_section "choosing one agent, accepting the plugin and the status line"
fresh
answers 1 y y y
inst_from --guided $NOFLAGS
assert_rc 0 "guided install"
assert_contains "$(out)" "Everything stays on this Mac" "the intro says it is local-only"
assert_contains "$(out)" "uninstall.sh" "the intro says how to undo it"
assert_contains "$(out)" "Which agents should wasitme track?" "agents question"
assert_contains "$(out)" "1) Claude Code  (found)" "Claude Code shown as found"
assert_contains "$(out)" "2) Codex        (found)" "Codex shown as found"
assert_contains "$(out)" "Add the wasitme plugin to Claude Code?" "claude plugin question"
assert_contains "$(out)" "runs inside Claude Code with your permissions" "the mod disclosure comes before the plugin question (D50, P-A)"
assert_contains "$(out)" "calls: \$.clock.every, \$.clock.now" "with the exact calls line"
q_disc=$(grep -n "runs inside Claude Code with your permissions" "$T_OUT" | head -1 | cut -d: -f1)
q_ask=$(grep -n "Add the wasitme plugin to Claude Code?" "$T_OUT" | head -1 | cut -d: -f1)
assert_eq "yes" "$( [ "$q_disc" -lt "$q_ask" ] && echo yes || echo no )" "the disclosure is printed before the question"
assert_not_contains "$(out)" "Add the wasitme report skill to Codex?" "no codex question when codex is not tracked"
assert_contains "$(out)" "Show wasitme in Claude Code's status line?" "status line question"
assert_contains "$(out)" "Go ahead?" "final confirmation"
assert_contains "$(shimlog)" "claude plugin install wasitme@wasitme" "claude plugin installed"
assert_not_contains "$(shimlog)" "codex" "codex untouched"
assert_eq '["claude-code"]' "$(json_get "$H/.wasitme/engine.json" 'd.agents')" "engine.json records the chosen agent"
assert_eq "command" "$(json_get "$H/.claude/settings.json" 'd.statusLine.type')" "status line added"

t_section "both agents; decline Claude, accept Codex, decline the status line"
fresh
answers a n y n y
inst_from --guided $NOFLAGS
assert_rc 0 "guided install"
assert_contains "$(out)" "Skills only: no hooks, and your notify setting is never touched" "the Codex question says what it adds"
assert_eq "codex plugin marketplace add $H/.wasitme/current/plugin-codex
codex plugin add wasitme@wasitme-codex" "$(shimlog)" "only the codex plugin was installed"
assert_missing "$H/.claude/settings.json" "settings.json was not created"
assert_eq '["claude-code", "codex"]' "$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).agents).replace(/,/g,", "))' "$H/.wasitme/engine.json")" "both agents recorded"
assert_contains "$(out)" "you chose no" "declined components are listed as such"
assert_not_contains "$(out)" "/hooks" "no Codex hook review: the Codex plugin has no hooks (D32)"

t_section "Enter accepts every default"
fresh
answers "" "" "" "" ""
inst_from --guided $NOFLAGS
assert_rc 0 "all defaults"
assert_contains "$(shimlog)" "claude plugin install" "claude plugin installed by default"
assert_contains "$(shimlog)" "codex plugin add" "codex plugin installed by default"
assert_eq "command" "$(json_get "$H/.claude/settings.json" 'd.statusLine.type')" "status line added by default"

t_section "agent numbers in any order"
fresh
answers "2, 1" y
inst_from --guided $NOFLAGS --no-claude-plugin --no-codex-plugin --no-statusline
assert_rc 0 "2, 1"
assert_eq '["claude-code","codex"]' "$(json_get "$H/.wasitme/engine.json" 'd.agents')" "the order is stable: claude-code then codex"

t_section "declining the final confirmation changes nothing"
fresh
answers a y y y n
inst_from --guided $NOFLAGS
assert_rc 0 "declined"
assert_contains "$(out)" "Nothing was changed" "says so"
assert_eq "$PRE" "$(tree_of "$H")" "the home is untouched"
assert_eq "0" "$(count_lines "$SHIM_LOG")" "no tool was run"

t_section "running out of answers aborts before any change"
fresh
answers 1
inst_from --guided $NOFLAGS
assert_rc 1 "input ends early"
assert_contains "$(err)" "input ended before every question was answered" "message explains"
assert_eq "$PRE" "$(tree_of "$H")" "nothing was changed"

t_section "unusable answers"
fresh
answers x y 9
inst_from --guided $NOFLAGS
assert_rc 1 "three bad agent answers"
assert_contains "$(err)" "no usable answer" "message explains"
assert_eq "$PRE" "$(tree_of "$H")" "nothing was changed"
fresh
answers 1 maybe perhaps whatever
inst_from --guided $NOFLAGS
assert_rc 1 "three bad yes/no answers"
assert_eq "$PRE" "$(tree_of "$H")" "nothing was changed"

t_section "questions are skipped when they do not apply or a flag already decided"
fresh
printf '{"statusLine":{"type":"command","command":"theirs"}}\n' >"$H/.claude/settings.json"
answers 1 y y
inst_from --guided $NOFLAGS
assert_rc 0 "an existing status line means no status line question"
assert_not_contains "$(out)" "Show wasitme in Claude Code's status line?" "not asked"
assert_contains "$(out)" "you already have a status line" "the reason is shown"
fresh
answers 1 y
inst_from --guided $NOFLAGS --no-statusline --claude-plugin
assert_rc 0 "flags decide their own components"
assert_not_contains "$(out)" "Add the wasitme plugin to Claude Code?" "--claude-plugin skips the question"
assert_not_contains "$(out)" "status line?" "--no-statusline skips the question"
assert_contains "$(shimlog)" "claude plugin install" "and the choice was honoured"

t_section "our own status line from an older installer: updated without a question"
fresh
printf '{"theme":"dark"}\n' >"$H/.claude/settings.json"
inst_from --yes $NOFLAGS --no-claude-plugin --no-codex-plugin --agents claude-code
assert_rc 0 "first install adds the status line"
# Rewind to what an installer from before the status-line shim wrote (`<node> <cli> status`), in settings.json and in
# the manifest.
OLDCMD="$(command -v node) $H/.wasitme/current/engine/dist/src/cli/main.js status"
node -e 'const fs = require("fs"), f = process.argv[1], d = JSON.parse(fs.readFileSync(f, "utf8")); d.statusLine = { type: "command", command: process.argv[2] }; fs.writeFileSync(f, JSON.stringify(d) + "\n");' "$H/.claude/settings.json" "$OLDCMD"
OLDSHA=$(node "$T_REPO/scripts/lib/jsonutil.mjs" sha256 "$H/.claude/settings.json")
awk -F '\t' -v OFS='\t' -v sha="$OLDSHA" -v cmd="$OLDCMD" '$1 == "statusline" { $4 = sha; $5 = cmd } { print }' "$H/.wasitme/install-manifest" >"$SB/mf" && cat "$SB/mf" >"$H/.wasitme/install-manifest"
answers 1 y
inst_from --guided $NOFLAGS --no-claude-plugin --no-codex-plugin
assert_rc 0 "guided re-run"
assert_not_contains "$(out)" "Show wasitme in Claude Code's status line?" "no status line question: it is already ours"
assert_contains "$(out)" "updated to the current command" "it was updated"
assert_eq "$H/.local/bin/wasitme-statusline" "$(json_get "$H/.claude/settings.json" 'd.statusLine.command')" "pointing at the status-line shim (no node)"

t_section "no Claude Code at all: no status line question"
sb_new
make_fixture "$SB_SRC" 0.1.0
H=$SB_HOME
mkdir -p "$H/.codex"
export WASITME_CLAUDE="$SB/nonexistent/claude"
answers a y
inst_from --guided $NOFLAGS --no-codex-plugin
assert_rc 0 "guided install tracking both agents, Claude Code absent"
assert_not_contains "$(out)" "Show wasitme in Claude Code's status line?" "not asked"
assert_contains "$(out)" "Claude Code was not found on this Mac" "the reason is shown"
assert_missing "$H/.claude" "and nothing was created for it"

t_section "no claude or codex command: no question, a clear reason"
fresh
export WASITME_CLAUDE="$SB/nonexistent/claude" WASITME_CODEX="$SB/nonexistent/codex"
answers 1 y y
inst_from --guided $NOFLAGS
assert_rc 0 "install"
assert_not_contains "$(out)" "Add the wasitme plugin to Claude Code?" "not asked when claude is missing"
assert_contains "$(out)" "the 'claude' command was not found" "the reason is shown"

t_section "PATH check: the shell profile is edited only after a yes, and the uninstaller undoes it exactly"
fresh
export SHELL=/bin/zsh
printf '# my profile\nexport EDITOR=vi' >"$H/.zprofile"
cp "$H/.zprofile" "$SB/zprofile.orig"
answers 1 n n y
inst_from --guided $NOFLAGS
assert_rc 0 "guided install, PATH question unanswered"
assert_contains "$(out)" "echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $H/.zprofile" "the exact line to add is shown"
assert_contains "$(out)" "Add that line to $H/.zprofile for you?" "and offered"
assert_same_file "$SB/zprofile.orig" "$H/.zprofile" "no answer means no: the profile is untouched"
assert_eq "false" "$(json_get "$H/.wasitme/engine.json" 'd.onPath')" "engine.json: onPath false"
answers 1 n n y y
inst_from --guided $NOFLAGS
assert_rc 0 "guided re-run, PATH question answered yes"
assert_file_has "$H/.zprofile" 'export PATH="$HOME/.local/bin:$PATH"' "the line was added"
assert_file_has "$H/.zprofile" "# my profile" "the rest is kept"
BAK=$(ls "$H"/.zprofile.wasitme-bak-* 2>/dev/null | head -1)
assert_same_file "$SB/zprofile.orig" "$BAK" "a byte-identical backup was made first"
assert_file_has "$H/.wasitme/install-manifest" "$(printf 'rcline\t%s\t%s' "$H/.zprofile" "$BAK")" "manifest: the edit is recorded"
answers 1 n n y
inst_from --guided $NOFLAGS
assert_rc 0 "a third run"
assert_not_contains "$(out)" "Add that line to" "not offered again once added"
uninst --yes
assert_rc 0 "uninstall"
assert_same_file "$SB/zprofile.orig" "$H/.zprofile" "the profile is restored byte for byte"
assert_missing "$BAK" "and the backup is gone"
fresh
export SHELL=/bin/zsh
answers 1 n n y
inst_from --yes $NOFLAGS
assert_rc 0 "--yes never asks the PATH question"
assert_missing "$H/.zprofile" "and never creates a profile"
unset SHELL

t_section "guided mode needs a terminal"
fresh
export WASITME_TTY="$SB/nonexistent-tty"
inst_from --guided $NOFLAGS
assert_rc 2 "--guided without a terminal"
assert_contains "$(err)" "needs a terminal" "message explains"

if [ "$T_OS" = Darwin ]; then
  t_section "macOS: the app and scan questions"
  fresh macos-fake
  answers 1 n y n n y
  inst_from --guided
  assert_rc 0 "guided install with app"
  assert_contains "$(out)" "Run a quiet background scan every 15 minutes" "scan question (900 s, D46)"
  assert_contains "$(out)" "Install the menu bar app?" "app question"
  assert_contains "$(out)" "no Apple account and no download" "the app question says what it needs"
  assert_contains "$(shimlog)" "swift build" "the app was built"
  assert_eq "launchctl bootstrap gui/$T_UID $H/Library/LaunchAgents/$LABEL_APP.plist" "$(grep '^launchctl' "$SHIM_LOG")" "only the app's agent was loaded (scan declined)"
  assert_missing "$H/Library/LaunchAgents/$LABEL_SCAN.plist" "scan plist not written"

  t_section "macOS: no toolchain means no app question"
  fresh macos-fake
  export WASITME_DEVELOPER_DIRS=/nonexistent
  answers 1 n n n y
  inst_from --guided
  unset WASITME_DEVELOPER_DIRS
  assert_rc 0 "guided install without a toolchain"
  assert_not_contains "$(out)" "Install the menu bar app?" "no app question"
  assert_contains "$(out)" "no Swift toolchain found" "the reason is shown"
fi

t_done
