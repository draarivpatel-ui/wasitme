#!/bin/sh
# Preflight and argument validation: everything that must stop the installer BEFORE it changes anything.
. "$(dirname "$0")/harness.sh"

home_untouched() {  # home_untouched MSG: the sandbox home is still empty
  assert_eq "." "$(tree_of "$SB_HOME")" "$1"
}

t_section "node"
sb_new
make_fixture "$SB_SRC" 0.1.0

# A PATH with the basic tools but no node.
mkdir -p "$SB/nonode"
for tool in uname id tar cp mv rm mkdir ln readlink sed awk grep cat dirname mktemp tr head cksum basename date find ls sleep chmod kill env; do
  p=$(command -v "$tool" 2>/dev/null || true)
  case $p in /*) ln -s "$p" "$SB/nonode/$tool" ;; esac
done
T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
PATH="$SB/nonode" "$SH_BIN" "$T_REPO/scripts/install.sh" --home "$SB_HOME" --from "$SB_SRC" --yes >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 1 "missing node stops the installer"
assert_contains "$(err)" "Node.js 22 or newer" "message names the required Node version"
assert_contains "$(err)" "no 'node' was found" "message says node is missing"
assert_contains "$(err)" "brew install node" "message gives the Homebrew hint"
assert_contains "$(err)" "https://nodejs.org/en/download" "message gives the download page"
home_untouched "missing node: nothing was created"

# An old node.
mkdir -p "$SB/oldnode"
printf '#!/bin/sh\necho 18.20.4\n' >"$SB/oldnode/node"
chmod +x "$SB/oldnode/node"
PATH="$SB/oldnode:$BASE_PATH" "$SH_BIN" "$T_REPO/scripts/install.sh" --home "$SB_HOME" --from "$SB_SRC" --yes >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 1 "node 18 is rejected"
assert_contains "$(err)" "too old" "message says node is too old"
assert_contains "$(err)" "18.20.4" "message shows the version found"
home_untouched "old node: nothing was created"

# A node that does not run at all.
mkdir -p "$SB/badnode"
printf '#!/bin/sh\nexit 3\n' >"$SB/badnode/node"
chmod +x "$SB/badnode/node"
PATH="$SB/badnode:$BASE_PATH" "$SH_BIN" "$T_REPO/scripts/install.sh" --home "$SB_HOME" --from "$SB_SRC" --yes >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 1 "a broken node is rejected"
assert_contains "$(err)" "did not run" "message says node did not run"

t_section "operating system and user"
sb_new
make_fixture "$SB_SRC" 0.1.0
export WASITME_OS=Plan9
inst_from $CORE_ONLY
unset WASITME_OS
assert_rc 1 "unsupported OS stops the installer"
assert_contains "$(err)" "supports macOS and Linux" "message names the supported systems"
home_untouched "unsupported OS: nothing was created"

mkdir -p "$SB/root"
printf '#!/bin/sh\nif [ "${1:-}" = "-u" ]; then echo 0; else /usr/bin/id "$@"; fi\n' >"$SB/root/id"
chmod +x "$SB/root/id"
T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
PATH="$SB/root:$SB/shims:$BASE_PATH" "$SH_BIN" "$T_REPO/scripts/install.sh" --home "$SB_HOME" --from "$SB_SRC" $CORE_ONLY >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 1 "running as root is refused"
assert_contains "$(err)" "do not run this installer with sudo" "message explains why"
home_untouched "root: nothing was created"
PATH="$SB/root:$SB/shims:$BASE_PATH" "$SH_BIN" "$T_REPO/scripts/install.sh" --home "$SB_HOME" --from "$SB_SRC" --allow-root $CORE_ONLY >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 0 "--allow-root lets it proceed (containers)"

t_section "arguments"
sb_new
make_fixture "$SB_SRC" 0.1.0
for pair in "--app --no-app" "--no-claude-plugin --claude-plugin" "--codex-plugin --no-codex-plugin" "--statusline --no-statusline" "--scan-agent --no-scan-agent" "--guided --yes"; do
  # shellcheck disable=SC2086
  inst_from $pair
  assert_rc 2 "contradiction refused: $pair"
done
inst_from --bogus
assert_rc 2 "unknown option refused"
assert_contains "$(err)" "unknown option: --bogus" "unknown option is named"
inst_from --agents nonsense --yes
assert_rc 2 "unknown agent refused"
inst_from --agents "" --yes
assert_rc 2 "empty --agents refused"
inst_from --app-executable "../evil" --yes
assert_rc 2 "--app-executable must be a plain file name"
inst_from --prefix relative/path --yes
assert_rc 2 "--prefix must be absolute"
T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
"$SH_BIN" "$T_REPO/scripts/install.sh" --home relative --from "$SB_SRC" --yes >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 2 "--home must be absolute"
inst --tarball "$SB/x.tgz" --from "$SB_SRC" --yes
assert_rc 2 "--from and --tarball cannot be combined"
inst --sha256 abc --from "$SB_SRC" --yes
assert_rc 2 "--sha256 needs a tarball or url"
inst_from --home
assert_rc 2 "an option missing its value is refused"
home_untouched "bad arguments: nothing was created"

t_section "paths"
sb_new
make_fixture "$SB_SRC" 0.1.0
T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
for bad in "$SB/ho'me" "$SB/ho\"me" "$SB/ho\$me" "$SB/ho;me" "$SB/ho&me" "$SB/ho<me"; do
  "$SH_BIN" "$T_REPO/scripts/install.sh" --home "$bad" --from "$SB_SRC" $CORE_ONLY >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
  assert_rc 1 "unsupported character in home refused: $bad"
  assert_contains "$(err)" "characters this installer does not support" "path message for $bad"
done
inst_from --prefix "$SB/pre'fix" $CORE_ONLY
assert_rc 1 "unsupported character in prefix refused"
assert_contains "$(err)" "prefix" "message names the prefix"
inst_from --prefix "$SB/a/../b" $CORE_ONLY
assert_rc 1 "'..' in the prefix refused"

t_section "terminal"
sb_new
make_fixture "$SB_SRC" 0.1.0
inst_from
assert_rc 2 "no terminal and no --yes: refuses instead of guessing or hanging"
assert_contains "$(err)" "--yes" "message tells how to proceed"
home_untouched "no terminal: nothing was created"
export WASITME_TTY=/nonexistent/tty
inst_from --guided
unset WASITME_TTY
assert_rc 2 "--guided without a terminal is refused"
inst_from --dry-run
assert_rc 0 "--dry-run needs no terminal (it asks nothing and changes nothing)"
home_untouched "dry-run: nothing was created"

t_section "source tree"
sb_new
inst --from "$SB/nope" $CORE_ONLY
assert_rc 1 "--from a missing directory"
assert_contains "$(err)" "no such directory" "message says so"

make_fixture "$SB_SRC" 0.1.0
rm "$SB_SRC/scripts/uninstall.sh"
inst_from $CORE_ONLY
assert_rc 1 "a source without an uninstaller is refused"
assert_contains "$(err)" "without an uninstaller" "message explains"
home_untouched "no uninstaller: nothing was created"

sb_new
make_fixture "$SB_SRC" 0.1.0
printf '{ "name": "wasitme", "version": "0.1.0", "bin": { "wasitme": "dist/src/cli/main.js" }, "dependencies": { "left-pad": "1.0.0" } }\n' >"$SB_SRC/engine/package.json"
inst_from $CORE_ONLY
assert_rc 1 "an engine with runtime dependencies is refused"
assert_contains "$(err)" "runtime dependencies" "message explains"

sb_new
make_fixture "$SB_SRC" "../../evil"
inst_from $CORE_ONLY
assert_rc 1 "a path-like version is refused"
assert_contains "$(err)" "semantic version" "message explains"
home_untouched "bad version: nothing was created"

sb_new
make_fixture "$SB_SRC" 0.1.0
rm "$SB_SRC/engine/package.json"
inst_from $CORE_ONLY
assert_rc 1 "not a wasitme tree"
assert_contains "$(err)" "not a wasitme source tree" "message explains"

sb_new
make_fixture "$SB_SRC" 0.1.0
ln -s /etc/hosts "$SB_SRC/engine/dist/src/cli/evil-link"
inst_from $CORE_ONLY
assert_rc 1 "symbolic links inside the payload are refused"
assert_contains "$(err)" "symbolic links" "message explains"
home_untouched "symlink payload: nothing was created"
# The same for the install scripts that travel with the engine (the uninstaller and --repair run them later) and for
# the files copied one by one.
for sl_where in scripts/lib/extra.sh scripts/uninstall.sh LICENSE engine/package.json; do
  sb_new
  make_fixture "$SB_SRC" 0.1.0
  # The link points at a faithful copy of the file, so nothing but the link itself can be the reason for the refusal.
  if [ -f "$SB_SRC/$sl_where" ]; then mv "$SB_SRC/$sl_where" "$SB/outside/linked"; else printf 'x\n' >"$SB/outside/linked"; fi
  ln -s "$SB/outside/linked" "$SB_SRC/$sl_where"
  inst_from $CORE_ONLY
  assert_rc 1 "a symlink at $sl_where is refused"
  assert_contains "$(err)" "symbolic links" "message explains ($sl_where)"
  home_untouched "symlink at $sl_where: nothing was created"
done

t_section "~/.wasitme must be a real folder of yours (the engine and the hooks refuse anything else)"
sb_new
make_fixture "$SB_SRC" 0.1.0
mkdir -p "$SB/elsewhere"
ln -s "$SB/elsewhere" "$SB_HOME/.wasitme"
inst_from $CORE_ONLY
assert_rc 1 "a symlinked ~/.wasitme is refused before anything is installed"
assert_contains "$(err)" "is a symbolic link" "message says what is wrong"
assert_contains "$(err)" "Move the real folder into place" "and how to fix it"
assert_eq "." "$(tree_of "$SB/elsewhere")" "nothing was written through the link"
assert_eq "$(printf '.\n./.wasitme')" "$(tree_of "$SB_HOME")" "nothing was created in the home either"
sb_new
make_fixture "$SB_SRC" 0.1.0
printf 'not a folder\n' >"$SB_HOME/.wasitme"
inst_from $CORE_ONLY
assert_rc 1 "a file named ~/.wasitme is refused"
assert_contains "$(err)" "is not a folder" "message says what is wrong"

t_done
