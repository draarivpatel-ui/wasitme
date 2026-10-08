#!/bin/sh
# Static checks: every script parses under sh and dash, stays POSIX, ends with main, and has a working --help.
# T_RC is set in this file and read by assert_rc in harness.sh. The linter looks at one file at a time
# and would call it unused (SC2034); this single directive, before the first command, covers the file.
# shellcheck disable=SC2034
. "$(dirname "$0")/harness.sh"

t_section "syntax and portability"
SCRIPTS="$T_REPO/scripts/install.sh $T_REPO/scripts/uninstall.sh $T_REPO/scripts/release.sh $T_REPO/scripts/lib/common.sh $T_REPO/scripts/lib/engine.sh $T_REPO/scripts/lib/app_bundle.sh $T_REPO/scripts/lib/macos.sh $T_REPO/scripts/lib/plugins.sh $T_REPO/scripts/lib/guided.sh $T_REPO/scripts/lib/install_main.sh"
TESTS="$T_DIR/run.sh $T_DIR/harness.sh $T_DIR/shim.sh $(ls "$T_DIR"/t_*.sh)"

for f in $SCRIPTS $TESTS; do
  if "$SH_BIN" -n "$f" 2>"$T_ROOT/syn.err"; then t_pass; else t_fail "sh -n $f" "$(cat "$T_ROOT/syn.err")"; fi
  if command -v dash >/dev/null 2>&1; then
    if dash -n "$f" 2>"$T_ROOT/syn.err"; then t_pass; else t_fail "dash -n $f" "$(cat "$T_ROOT/syn.err")"; fi
  fi
done

for f in "$T_REPO/scripts/lib/jsonutil.mjs" "$T_REPO/scripts/lib/from-app.mjs" "$T_DIR/fake-agents.mjs"; do
  if node --check "$f" 2>"$T_ROOT/syn.err"; then t_pass; else t_fail "node --check $(basename "$f")" "$(cat "$T_ROOT/syn.err")"; fi
done

# The PATH check is the one place a shell profile may be edited, and only after ask_yn returned yes.
pm=$(sed -n '/^path_check()/,/^}/p' "$T_REPO/scripts/lib/install_main.sh")
assert_contains "$pm" 'ask_yn "Add that line to $pc_rc for you?' "the PATH check asks before editing a shell profile"
assert_contains "$pm" '[ "$ASK_RESULT" = yes ] || return 0' "and edits it only on a yes"
assert_contains "$pm" '[ "$GUIDED" = 1 ] && [ "$DRY" = 0 ] || return 0' "and never without a terminal or under --dry-run"

# The mod disclosure the installer prints (D50, P-A) is exactly the frozen allow-list the plugin's CI check enforces.
calls_js=$(sed -n '/^const ALLOWED_CALLS = \[/,/^\]/p' "$T_REPO/plugin/tests/check-calls.mjs" | sed -n "s/^[[:space:]]*'\([a-z.]*\)'.*/\$.\1/p" | tr '\n' ',' | sed 's/,$//; s/,/, /g')
calls_sh=$(sed -n "s/^WASITME_MOD_CALLS='\(.*\)'$/\1/p" "$T_REPO/scripts/lib/common.sh")
assert_eq "$calls_js" "$calls_sh" "WASITME_MOD_CALLS equals plugin/tests/check-calls.mjs ALLOWED_CALLS"

# The app bundle's resources are listed once, in scripts/lib/app_bundle.sh. The developer build and the installer both
# copy and render through it and keep no list of their own (t_heavy_real_app checks the result on a real build).
for f in "$T_REPO/macos/scripts/build-app.sh" "$T_REPO/scripts/lib/macos.sh"; do
  body=$(grep -v '^[[:space:]]*#' "$f")
  assert_contains "$body" 'app_bundle_resources "' "$(basename "$f") copies the app's resources with app_bundle_resources"
  assert_contains "$body" 'app_bundle_icon "' "$(basename "$f") renders the app icon with app_bundle_icon"
  for pat in 'app.html' 'MODIFICATIONS.txt' '512x512@2x'; do
    assert_not_contains "$body" "$pat" "$(basename "$f") keeps no resource list of its own ($pat belongs in app_bundle.sh)"
  done
done
assert_contains "$(cat "$T_REPO/macos/scripts/build-app.sh")" '. "$ROOT/../scripts/lib/app_bundle.sh"' "build-app.sh sources the shared list"
assert_contains "$(cat "$T_REPO/scripts/install.sh")" '. "$LIB_DIR/app_bundle.sh"' "install.sh sources the shared list before macos.sh"

# The last non-blank line must be the call to main, so a truncated download runs nothing.
for f in "$T_REPO/scripts/install.sh" "$T_REPO/scripts/uninstall.sh"; do
  assert_eq 'main "$@"' "$(grep -v '^[[:space:]]*$' "$f" | tail -n 1)" "$(basename "$f"): main is called on the last line"
done

# Bashisms that would break dash/busybox. Comments are ignored.
for f in $SCRIPTS; do
  body=$(grep -v '^[[:space:]]*#' "$f")
  for pat in '\[\[ ' ' \]\]' '^[[:space:]]*local ' 'echo -e' '^[[:space:]]*function ' '^[[:space:]]*source ' '<<<' '\$'"'" '\${[A-Za-z_]*//' '\[ .* == ' ' -a "' 'pushd ' 'declare '; do
    if printf '%s\n' "$body" | grep -Eq -- "$pat"; then t_fail "$(basename "$f") uses a non-POSIX construct matching: $pat"; else t_pass; fi
  done
done

# Only install.sh may talk to the network, and only through curl/wget in download().
for f in "$T_REPO"/scripts/lib/*.sh "$T_REPO/scripts/uninstall.sh"; do
  if grep -v '^[[:space:]]*#' "$f" | grep -Eq '(^|[^A-Za-z_])(curl|wget|nc|ssh|scp)( |$)'; then t_fail "$(basename "$f") must not use network tools"; else t_pass; fi
done
if grep -Eq 'node:(http|https|net|dns|tls|dgram|http2)|fetch\(|XMLHttpRequest|WebSocket' "$T_REPO/scripts/lib/jsonutil.mjs"; then t_fail "jsonutil.mjs must not use network APIs"; else t_pass; fi
if grep -Eq "^import .* from \"[^n]" "$T_REPO/scripts/lib/jsonutil.mjs"; then t_fail "jsonutil.mjs may only import node: built-ins"; else t_pass; fi

# No sudo, no edits to shell rc files, no xcode-select switching, no npm outside the build step.
for f in $SCRIPTS; do
  body=$(grep -v '^[[:space:]]*#' "$f")
  # Mentioning sudo in a message ("run sudo xcodebuild -license yourself") is fine; invoking it is not.
  if printf '%s\n' "$body" | grep -Eq '(^|[;&|(]|then|do|else)[[:space:]]*(run[[:space:]]+)?sudo[[:space:]]'; then t_fail "$(basename "$f") invokes sudo"; else t_pass; fi
  # Shell profiles: only install_main.sh's PATH check names them, and it edits one only after a [y/N] yes (README "Install").
  case $f in
    */install_main.sh) ;;
    *) case $body in *".zshrc"*|*".bashrc"*|*".profile"*|*".zprofile"*) t_fail "$(basename "$f") touches shell rc files" ;; *) t_pass ;; esac ;;
  esac
  case $body in *"xcode-select -s"*|*"xcode-select --switch"*) t_fail "$(basename "$f") switches xcode-select" ;; *) t_pass ;; esac
done

# --help works for both scripts and says what matters.
T_OUT="$T_ROOT/h.out"; T_ERR="$T_ROOT/h.err"
"$SH_BIN" "$T_REPO/scripts/install.sh" --help >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 0 "install.sh --help exits 0"
for flag in --dry-run --yes --no-app --no-claude-plugin --no-codex-plugin --no-statusline --prefix --home --from --tarball --guided --repair --accept-plugin-changes; do
  assert_contains "$(out)" "$flag" "install.sh --help documents $flag"
done
"$SH_BIN" "$T_REPO/scripts/uninstall.sh" --help >"$T_OUT" 2>"$T_ERR" </dev/null; T_RC=$?
assert_rc 0 "uninstall.sh --help exits 0"
assert_contains "$(out)" "--purge" "uninstall.sh --help documents --purge"

t_done
