#!/bin/sh
# The one-line path: install.sh piped to sh fetches (or is given) a tarball and hands over to the installer
# inside it. Nothing here touches the network: curl is a recording shim that copies a local file.
# T_RC is set in this file and read by assert_rc in harness.sh. The linter looks at one file at a time
# and would call it unused (SC2034); this single directive, before the first command, covers the file.
# shellcheck disable=SC2034
. "$(dirname "$0")/harness.sh"

INSTALL_SH="$T_REPO/scripts/install.sh"

# piped ARGS...: run install.sh the way `curl | sh` does (the script arrives on stdin).
piped() {
  T_OUT="$SB/out.txt"
  T_ERR="$SB/err.txt"
  cat "$INSTALL_SH" | PATH="$SB/shims:$BASE_PATH" "$SH_BIN" -s -- --home "$SB_HOME" "$@" >"$T_OUT" 2>"$T_ERR"
  T_RC=$?
}
make_tgz() { tar -czf "$1" -C "$2" .; }
sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

t_section "piped, from a local tarball"
sb_new
make_fixture "$SB_SRC" 0.1.0
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
H=$SB_HOME
piped --tarball "$SB/wasitme.tgz" $CORE_ONLY
assert_rc 0 "piped install from a tarball"
assert_eq "wasitme 0.1.0" "$("$H/.local/bin/wasitme" --version)" "engine installed and runnable"
assert_eq "0" "$(ls -A "$SB/tmp" | wc -l | tr -d ' ')" "the extracted tarball and the work dir are removed afterwards"
assert_file "$H/.wasitme/versions/0.1.0/scripts/uninstall.sh" "the uninstaller came from the tarball"

t_section "GitHub-style tarball with one top-level folder"
sb_new
make_fixture "$SB_SRC" 0.1.0
mkdir -p "$SB/nest"
cp -R "$SB_SRC" "$SB/nest/wasitme-main"
tar -czf "$SB/nested.tgz" -C "$SB/nest" wasitme-main
piped --tarball "$SB/nested.tgz" $CORE_ONLY
assert_rc 0 "install from a nested tarball"
assert_file "$SB_HOME/.wasitme/versions/0.1.0/engine/dist/src/cli/main.js" "installed"

t_section "checksum"
sb_new
make_fixture "$SB_SRC" 0.1.0
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
piped --tarball "$SB/wasitme.tgz" --sha256 "$(sha_of "$SB/wasitme.tgz")" $CORE_ONLY
assert_rc 0 "a matching --sha256 passes"
sb_new
make_fixture "$SB_SRC" 0.1.0
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
piped --tarball "$SB/wasitme.tgz" --sha256 0000000000000000000000000000000000000000000000000000000000000000 $CORE_ONLY
assert_rc 1 "a wrong --sha256 stops everything"
assert_contains "$(err)" "SHA-256 mismatch" "message says so"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was installed"

t_section "unsafe or broken tarballs"
sb_new
mkdir -p "$SB/evil/a/b"
printf 'x\n' >"$SB/evil/payload.txt"
( cd "$SB/evil/a/b" && tar -czPf "$SB/dotdot.tgz" ../../payload.txt )
piped --tarball "$SB/dotdot.tgz" $CORE_ONLY
assert_rc 1 "a tarball with '..' paths is refused"
assert_contains "$(err)" "unsafe paths" "message says so"
assert_missing "$SB/evil/a/payload.txt" "nothing was extracted"
tar -czPf "$SB/abs.tgz" "$SB/evil/payload.txt"
piped --tarball "$SB/abs.tgz" $CORE_ONLY
assert_rc 1 "a tarball with absolute paths is refused"
assert_contains "$(err)" "unsafe paths" "message says so"
printf 'this is not a tarball\n' >"$SB/garbage.tgz"
piped --tarball "$SB/garbage.tgz" $CORE_ONLY
assert_rc 1 "garbage instead of a tarball"
assert_contains "$(err)" "not a readable .tar.gz" "message says so"
piped --tarball "$SB/missing.tgz" $CORE_ONLY
assert_rc 1 "a missing tarball"
assert_contains "$(err)" "no such file" "message says so"
mkdir -p "$SB/empty"
printf 'nothing here\n' >"$SB/empty/README"
make_tgz "$SB/empty.tgz" "$SB/empty"
piped --tarball "$SB/empty.tgz" $CORE_ONLY
assert_rc 1 "a tarball that is not wasitme"
assert_contains "$(err)" "has no scripts/install.sh" "message says so"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was installed by any of these"

t_section "lifecycle scripts never run"
sb_new
make_fixture "$SB_SRC" 0.1.0
printf '{ "name": "wasitme", "version": "0.1.0", "type": "module", "bin": { "wasitme": "dist/src/cli/main.js" }, "dependencies": {}, "scripts": { "preinstall": "touch %s/pwned-pre", "install": "touch %s/pwned-install", "postinstall": "touch %s/pwned-post", "prepare": "touch %s/pwned-prepare" } }\n' "$SB/outside" "$SB/outside" "$SB/outside" "$SB/outside" >"$SB_SRC/engine/package.json"
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
piped --tarball "$SB/wasitme.tgz" $CORE_ONLY
assert_rc 0 "install a tarball whose package.json has lifecycle scripts"
assert_eq "0" "$(ls "$SB/outside" | wc -l | tr -d ' ')" "none of preinstall/install/postinstall/prepare ran"
assert_eq "0" "$(grep -c '^npm' "$SHIM_LOG")" "npm was not even invoked (the tarball ships a built engine)"

t_section "download through a (fake) curl"
sb_new
make_fixture "$SB_SRC" 0.1.0
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
export SHIM_CURL_FILE="$SB/wasitme.tgz"
inst --url https://example.test/wasitme.tar.gz $CORE_ONLY
assert_rc 0 "install via --url"
assert_contains "$(shimlog)" "curl -fsSL --proto =https --tlsv1.2 --retry 2 -o $SB/tmp/wasitme-src." "curl runs with strict TLS and https-only"
assert_contains "$(shimlog)" "wasitme.tar.gz https://example.test/wasitme.tar.gz" "and fetches exactly the requested URL"
assert_eq "wasitme 0.1.0" "$("$SB_HOME/.local/bin/wasitme" --version)" "downloaded engine installed"
assert_contains "$(out)" "Downloading https://example.test/wasitme.tar.gz" "the download is announced"
assert_eq "0" "$(ls -A "$SB/tmp" | wc -l | tr -d ' ')" "downloaded files removed afterwards"

sb_new
make_fixture "$SB_SRC" 0.1.0
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
export SHIM_CURL_FILE="$SB/wasitme.tgz"
inst --url http://example.test/wasitme.tar.gz $CORE_ONLY
assert_rc 1 "plain http is refused"
assert_contains "$(err)" "must start with https://" "message says so"
assert_eq "0" "$(count_lines "$SHIM_LOG")" "curl was not called"

sb_new
export SHIM_CURL_FILE="$SB/does-not-matter"
export SHIM_FAIL_CURL="https://"
inst --url https://example.test/wasitme.tar.gz $CORE_ONLY
assert_rc 1 "a failed download stops the install"
assert_contains "$(err)" "download failed" "message says so"
assert_not_contains "$(err)" "--from DIR" "an explicit --url gets no hint about unpublished releases"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was installed"

t_section "a failed download from an unstamped installer's default URL says how to install without a release"
# The copy in a checkout (with the owner filled in, as in the public tree) points at the latest release, which may not
# be published yet.
sb_new
sed -e 's|^WASITME_DEFAULT_URL=.*|WASITME_DEFAULT_URL="https://example.test/releases/latest/download/wasitme.tar.gz"|' \
    "$T_REPO/scripts/install.sh" >"$SB/install-unstamped.sh"
export SHIM_FAIL_CURL="https://"
INSTALL_SH="$SB/install-unstamped.sh"
piped $CORE_ONLY
assert_rc 1 "a failed download stops the install"
assert_contains "$(shimlog)" "https://example.test/releases/latest/download/wasitme.tar.gz" "the default URL was tried"
assert_contains "$(err)" "download failed" "message says so"
assert_contains "$(err)" "--from DIR" "and how to install from a checkout"
assert_contains "$(err)" "--tarball FILE" "or from a local tarball"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was installed"
INSTALL_SH="$T_REPO/scripts/install.sh"

t_section "a released install.sh checks the tarball against the SHA-256 it was stamped with"
# scripts/release.sh writes the install.sh asset with these two lines stamped; this is the same edit.
stamp() {  # stamp SHA > file
  sed -e 's|^WASITME_DEFAULT_URL=.*|WASITME_DEFAULT_URL="https://example.test/releases/download/v0.1.0/wasitme-0.1.0.tgz"|' \
      -e "s|^WASITME_DEFAULT_SHA256=.*|WASITME_DEFAULT_SHA256=\"$1\"|" "$T_REPO/scripts/install.sh"
}
sb_new
make_fixture "$SB_SRC" 0.1.0
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
stamp "$(sha_of "$SB/wasitme.tgz")" >"$SB/install-stamped.sh"
assert_eq "2" "$(grep -c -e '^WASITME_DEFAULT_URL="https://example.test/' -e "^WASITME_DEFAULT_SHA256=\"$(sha_of "$SB/wasitme.tgz")\"" "$SB/install-stamped.sh")" "both lines were stamped (the sed patterns still match install.sh)"
export SHIM_CURL_FILE="$SB/wasitme.tgz"
INSTALL_SH="$SB/install-stamped.sh"
piped $CORE_ONLY
assert_rc 0 "the stamped default URL downloads and installs"
assert_contains "$(shimlog)" "https://example.test/releases/download/v0.1.0/wasitme-0.1.0.tgz" "from the pinned release URL"
assert_contains "$(out)" "SHA-256 matches" "after checking the stamped SHA-256"
sb_new
make_fixture "$SB_SRC" 0.1.0
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
stamp "$(sha_of "$SB/wasitme.tgz")" >"$SB/install-stamped.sh"
make_fixture "$SB_SRC" 0.1.0 doctor
make_tgz "$SB/swapped.tgz" "$SB_SRC"
export SHIM_CURL_FILE="$SB/swapped.tgz"
INSTALL_SH="$SB/install-stamped.sh"
piped $CORE_ONLY
assert_rc 1 "a tarball that is not the one the script was released with is refused"
assert_contains "$(err)" "SHA-256 mismatch" "message says so"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was installed"
piped --url https://example.test/other.tgz $CORE_ONLY
assert_rc 0 "an explicit --url is not held to the stamped checksum (only the default URL is)"
assert_contains "$(out)" "no checksum" "but the skipped check is said out loud, with how to add one"
assert_contains "$(out)" "--sha256" "names the option"
# Nothing in the environment may redirect a released installer away from its pinned tarball: the URL is a flag or nothing.
sb_new
make_fixture "$SB_SRC" 0.1.0
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
stamp "$(sha_of "$SB/wasitme.tgz")" >"$SB/install-stamped.sh"
make_fixture "$SB_SRC" 0.1.0 doctor
make_tgz "$SB/swapped.tgz" "$SB_SRC"
export SHIM_CURL_FILE="$SB/wasitme.tgz"
INSTALL_SH="$SB/install-stamped.sh"
WASITME_TARBALL_URL="https://example.test/other.tgz" piped $CORE_ONLY
assert_rc 0 "an environment variable does not change the download"
assert_contains "$(shimlog)" "https://example.test/releases/download/v0.1.0/wasitme-0.1.0.tgz" "the pinned URL was fetched"
assert_not_contains "$(shimlog)" "other.tgz" "not the one from the environment"
assert_contains "$(out)" "SHA-256 matches" "and the stamped checksum was checked"
INSTALL_SH="$T_REPO/scripts/install.sh"

# The public export fills in the owner (scripts/dev/export-public.sh --owner), so the same test runs in both trees.
# The placeholder is spelled in two pieces so the export does not rewrite this check too.
if grep -q -F "OWNER""/wasitme" "$T_REPO/scripts/install.sh"; then
  t_section "the default URL is a placeholder until the project is public"
  sb_new
  inst $CORE_ONLY
  assert_rc 1 "no source given and no published URL"
  assert_contains "$(err)" "no published release URL yet" "message says so"
  assert_contains "$(err)" "--from DIR or --tarball FILE" "and names the alternatives"
  assert_eq "0" "$(count_lines "$SHIM_LOG")" "nothing was downloaded"
  assert_eq "." "$(tree_of "$SB_HOME")" "nothing was installed"
else
  t_section "the default URL is the project's latest GitHub release (the owner is filled in)"
  sb_new
  inst $CORE_ONLY
  assert_rc 1 "the (fake) download is empty, so the install stops"
  assert_contains "$(shimlog)" "https://github.com/" "the download goes to GitHub"
  assert_contains "$(shimlog)" "/wasitme/releases/latest/download/wasitme.tar.gz" "and asks for the latest release's tarball"
  assert_eq "." "$(tree_of "$SB_HOME")" "nothing was installed"
fi

t_section "piped with --from hands over to the installer in that tree"
sb_new
make_fixture "$SB_SRC" 0.1.0
piped --from "$SB_SRC" $CORE_ONLY
assert_rc 0 "piped install with --from"
assert_file "$SB_HOME/.wasitme/versions/0.1.0/engine/dist/src/cli/main.js" "installed"

t_section "a tree whose installer has no lib folder cannot loop forever"
sb_new
make_fixture "$SB_SRC" 0.1.0
rm -rf "$SB_SRC/scripts/lib"
piped --from "$SB_SRC" $CORE_ONLY
assert_rc 1 "missing lib/ is a clear error"
assert_contains "$(err)" "missing its lib/ folder" "message says so"

t_section "a truncated download runs nothing"
sb_new
make_fixture "$SB_SRC" 0.1.0
T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"
sed '$d' "$INSTALL_SH" | PATH="$SB/shims:$BASE_PATH" "$SH_BIN" -s -- --home "$SB_HOME" --from "$SB_SRC" $CORE_ONLY >"$T_OUT" 2>"$T_ERR"
T_RC=$?
assert_rc 0 "a script cut off before main is called exits quietly"
assert_eq "" "$(out)" "prints nothing"
assert_eq "." "$(tree_of "$SB_HOME")" "installs nothing"

t_section "dry run through a tarball"
sb_new
make_fixture "$SB_SRC" 0.1.0
make_tgz "$SB/wasitme.tgz" "$SB_SRC"
piped --tarball "$SB/wasitme.tgz" --dry-run --yes
assert_rc 0 "dry run via tarball"
assert_contains "$(out)" "Dry run: nothing was changed" "says so"
assert_eq "." "$(tree_of "$SB_HOME")" "nothing was installed"
assert_eq "0" "$(ls -A "$SB/tmp" | wc -l | tr -d ' ')" "the extracted tarball was removed"

t_done
