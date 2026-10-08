#!/bin/sh
# ci-local.sh - the local CI gate: GitHub Actions takes over only after the maintainer says "go" (D15), so
# until then a work package merges into main only after this passes. It mirrors .github/workflows/ci.yml and adds the
# checks that need this Mac (Swift, the Claude CLI) or the full history (git-identity).
#
# Usage: scripts/ci-local.sh [options]
#   --list              print the steps and exit
#   --only a,b          run only these steps          (names from --list)
#   --skip a,b          skip these steps
#   --keep-going        do not stop at the first failure (the summary still exits 1)
#   --capture           also run app-capture: a release build of the macOS app and its offscreen --capture with the
#                       memory budgets enforced (minutes; macOS only). Naming it in --only requests it too.
#   --prepublish        pre-publish strictness (D27): every SKIP becomes a FAIL (a gate that did not
#                       run is not green); check-repo ignores its allow-list and requires the forbidden-email config;
#                       the canary scan requires testdata/hostile/CANARIES.txt; copy-lint requires copy-scope files;
#                       git-identity checks every commit's author/committer email. Expected to be RED while known
#                       scrub items remain.
#   -h, --help
# Environment:
#   CI_LOCAL_NO_HEAVY=1      do not route heavy steps (npm test, swift) through scripts/dev/heavy.sh
#   CI_LOCAL_CLT_DIR=DIR     Command Line Tools location (default /Library/Developer/CommandLineTools)
#   CI_LOCAL_KEEP_LOGS=1     keep the per-step logs and print their directory
#   CI_LOCAL_SHELLCHECK=BIN  shellcheck to run (default: shellcheck on PATH)
#   CI_LOCAL_CAPTURE=1       the same as --capture
#
# Steps run in order and stop at the first failure (fail-fast) unless --keep-going; every run ends with a summary table.
# A step that cannot apply (no claude CLI, no shellcheck) reports SKIP with the reason, never a silent pass. Only a
# step that called skip() is a SKIP: any other exit status, 77 included, is a FAIL.
# app-capture is opt-in (--capture, CI_LOCAL_CAPTURE=1 or --only app-capture). Not requested, it is a SKIP, so
# --prepublish fails until it is run: a memory budget nobody measured is not green.
# Heavy steps (the engine tests, swift build/test, the canvas build and render, the installer suites) go through scripts/dev/heavy.sh so the machine stays usable;
# light steps do not, because queueing behind other agents' jobs costs minutes for a sub-second command.
# check-repo reads WASITME_FORBIDDEN_EMAILS or a gitignored .ci-local.env (see .ci-local.env.example); without either it
# prints "SKIPPED forbidden-email", this script repeats that line under the table, and the last line says
# "forbidden-email rule NOT run".
# Tool output is shown live; a failing step's output is directly above the table. Each step runs in the background
# while this script waits, so INT/TERM (a harness timeout, Ctrl-C) stops the step's whole process tree at once instead
# of after it finishes, and heavy.sh releases its lock.
#
# POSIX sh. Exit codes: 0 all selected steps passed (or skipped), 1 a step failed, 2 usage error.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd -P) || exit 2
cd "$ROOT" || exit 2

STEPS="npm-ci typecheck test no-network changelog privacy-selftest hygiene-selftests privacy-scan sh-syntax shellcheck script-tests installer-tests installer-tests-dash plugin-sh-tests plugin-fixtures plugin-mod-tests design-tests copy-lint repo-greps git-identity mod-allowlist swift-macros swift-build swift-test swift-build-clt ui-build ui-test ui-render app-capture installer-heavy plugin-validate"
CLT_DIR=${CI_LOCAL_CLT_DIR:-/Library/Developer/CommandLineTools}

describe() {
  case $1 in
    npm-ci)             echo "npm ci (lockfile install)" ;;
    typecheck)          echo "engine typecheck (tsc)" ;;
    test)               echo "engine tests (heavy)" ;;
    no-network)         echo "no network code: engine, plugin mod + scripts, macOS app" ;;
    changelog)          echo "changelog fragments are well-formed" ;;
    privacy-selftest)   echo "check-privacy self-test" ;;
    hygiene-selftests)  echo "check-no-network and assemble-changelog self-tests" ;;
    privacy-scan)       echo "canaries must not leak into docs/contracts" ;;
    sh-syntax)          echo "sh -n (and dash -n) / bash -n / zsh -n on every script (by shebang)" ;;
    shellcheck)         echo "shellcheck on sh/bash scripts" ;;
    script-tests)       echo "tests of these scripts (scripts/test)" ;;
    installer-tests)    echo "installer, uninstaller and release.sh suites (temp homes, recording shims)" ;;
    installer-tests-dash) echo "the same suites with dash as the shell (Ubuntu's /bin/sh)" ;;
    installer-heavy)    echo "real Swift builds through the installer: fixture package and the real app (heavy)" ;;
    plugin-sh-tests)    echo "plugin hook scripts and run.sh (throwaway HOME)" ;;
    plugin-fixtures)    echo "plugin fixtures and design tokens in sync" ;;
    plugin-mod-tests)   echo "claude plugin test plugin (temp config dir)" ;;
    design-tests)       echo "design system: generated files current, contrast, glyphs, screens (Swift probe on macOS)" ;;
    copy-lint)          echo "copy lint (DESIGN.md §3, D31)" ;;
    repo-greps)         echo "home paths, forbidden email, remote assets, string-built JS" ;;
    git-identity)       echo "commit emails are GitHub noreply, no forbidden address (--prepublish)" ;;
    mod-allowlist)      echo "plugin/ stays inside the frozen mod capability allow-list (D25)" ;;
    swift-macros)       echo "no SDK macros whose plugin needs Xcode in macos/" ;;
    swift-build)        echo "swift build in macos/ (heavy)" ;;
    swift-test)         echo "swift test in macos/ (heavy)" ;;
    swift-build-clt)    echo "swift build with only the Command Line Tools (heavy)" ;;
    ui-build)           echo "build the Control Center canvas, ui/dist (heavy)" ;;
    ui-test)            echo "canvas model tests (ui/test/model.test.mjs)" ;;
    ui-render)          echo "canvas render smoke: design pairs in one headless Chrome (heavy)" ;;
    app-capture)        echo "release app's offscreen --capture, memory budgets enforced (heavy, opt-in: --capture)" ;;
    plugin-validate)    echo "claude plugin validate --strict (temp config dir)" ;;
  esac
}

usage() { sed -n '2,/^# POSIX sh/p' "$0" | sed 's/^# \{0,1\}//'; }

is_step() { case " $STEPS " in *" $1 "*) return 0 ;; esac; return 1; }
in_csv() { case ",$2," in *",$1,"*) return 0 ;; esac; return 1; }

ONLY=""
SKIP=""
KEEP_GOING=0
PREPUBLISH=0
REPO_FLAGS=""
PRIVACY_FLAGS=""
COPY_FLAGS=""
CAPTURE=0
if [ "${CI_LOCAL_CAPTURE:-0}" = 1 ]; then CAPTURE=1; fi
while [ $# -gt 0 ]; do
  case $1 in
    --list) for s in $STEPS; do printf '%-20s %s\n' "$s" "$(describe "$s")"; done; exit 0 ;;
    --only) [ $# -ge 2 ] || { echo "ci-local: --only needs a value" >&2; exit 2; }; ONLY=$2; shift 2 ;;
    --skip) [ $# -ge 2 ] || { echo "ci-local: --skip needs a value" >&2; exit 2; }; SKIP=$2; shift 2 ;;
    --keep-going) KEEP_GOING=1; shift ;;
    --capture) CAPTURE=1; shift ;;
    --prepublish)
      PREPUBLISH=1
      REPO_FLAGS="--strict --require-email-config"
      PRIVACY_FLAGS="--require-canaries"
      COPY_FLAGS="--require-copy"
      shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ci-local: unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
for name in $(printf '%s' "$ONLY,$SKIP" | tr ',' ' '); do
  is_step "$name" || { echo "ci-local: unknown step: $name (try --list)" >&2; exit 2; }
done
if in_csv app-capture "$ONLY"; then CAPTURE=1; fi

LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-ci-local.XXXXXX") || exit 2
cleanup() {
  if [ "${CI_LOCAL_KEEP_LOGS:-0}" = 1 ]; then echo "ci-local: logs kept in $LOGDIR"; else rm -rf "$LOGDIR"; fi
}
trap cleanup EXIT

# Every process below `$1` (children first-come), from one ps snapshot. Used to stop a step's whole tree on a signal:
# a POSIX shell without a terminal has no job control (dash refuses `set -m`), so process groups cannot be relied on.
descendants() {
  ps -A -o pid= -o ppid= 2>/dev/null | awk -v root="$1" '
    { kids[$2] = kids[$2] " " $1 }
    END { n = 1; q[1] = root; while (n > 0) { p = q[n]; n--; c = split(kids[p], a, " "); for (i = 1; i <= c; i++) { print a[i]; n++; q[n] = a[i] } } }'
}
child=""
on_signal() {
  trap - INT TERM
  if [ -n "$child" ]; then
    pids=$(descendants "$child")
    # shellcheck disable=SC2086 # a list of PIDs
    kill -TERM "$child" $pids 2>/dev/null
  fi
  echo "ci-local: interrupted; stopped the running step" >&2
  exit "$1"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

HEAVY=""
if [ "${CI_LOCAL_NO_HEAVY:-0}" != 1 ] && [ -x "$ROOT/scripts/dev/heavy.sh" ]; then HEAVY="$ROOT/scripts/dev/heavy.sh"; fi
heavy() { if [ -n "$HEAVY" ]; then "$HEAVY" "$@"; else "$@"; fi; }

# skip REASON: this step does not apply here. Under --prepublish a skipped gate is a failure (it did not run).
# skip_ok REASON: a skip that is fine even under --prepublish (the check is covered elsewhere or is pre-publish only).
# Both leave a marker file: only a step that called one of them is recorded as SKIP; a bare exit 77 is a FAIL.
skip() {
  echo "SKIP: $1"
  printf '%s\n' "$1" > "$LOGDIR/$CURRENT.skip"
  if [ "$PREPUBLISH" = 1 ]; then
    echo "ci-local: --prepublish does not accept a skipped gate; this step FAILS"
    return 1
  fi
  return 77
}
skip_ok() { echo "SKIP: $1"; printf '%s\n' "$1" > "$LOGDIR/$CURRENT.skip"; return 77; }

# Every file a check could look at, one per line: tracked + untracked-not-ignored in a git checkout, else a find.
# -z then NUL->newline: without it git quotes non-ASCII names ("caf\303\251.sh") and they would never be checked.
all_files() {
  top=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null) || top=""
  if [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$ROOT" ]; then
    git -C "$ROOT" ls-files -z --cached --others --exclude-standard | tr '\0' '\n'
  else
    find . \( -name .git -o -name node_modules -o -name .build -o -name dist \) -prune -o -type f -print | sed 's|^\./||'
  fi
}

# Shell scripts by shebang (or .sh), as "interp<TAB>path" lines. Interpreters: sh, bash, zsh.
shell_scripts() {
  all_files | while IFS= read -r f; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    first=$(head -c 200 "$f" 2>/dev/null | head -n 1 | tr -d '\r')
    case $first in
      '#!'*bash*) interp="bash" ;;
      '#!'*zsh*) interp="zsh" ;;
      '#!/bin/sh'*|'#!'*' sh'*) interp="sh" ;;
      '#!'*) continue ;;
      *) case $f in *.sh) interp="sh" ;; *) continue ;; esac ;;
    esac
    printf '%s\t%s\n' "$interp" "$f"
  done
}

swift_pkg_dir() {
  for c in macos macos/*; do
    if [ -f "$c/Package.swift" ]; then echo "$c"; return 0; fi
  done
  return 1
}
# Swift sources that a package should build (spike/reference code and build output excluded).
has_swift_sources() {
  [ -d macos ] || return 1
  [ -n "$(find macos \( -name .build -o -name .swiftpm -o -name reference \) -prune -o -name '*.swift' -print 2>/dev/null | head -n 1)" ]
}
# The package directory, or a FAIL when Swift sources exist without a Package.swift where the steps look (the build
# would silently be skipped), or a skip when there are no Swift sources at all.
swift_pkg_or_explain() {
  if pkg=$(swift_pkg_dir); then return 0; fi
  if has_swift_sources; then
    echo "FAIL: macos/ has Swift sources but no Package.swift at macos/ or macos/*/; the Swift steps cannot find what to build"
    return 1
  fi
  skip "no Swift package under macos/"
}

clt_is_default() {
  dev=$(xcode-select -p 2>/dev/null || true)
  case $dev in *CommandLineTools*) return 0 ;; esac
  return 1
}

# ---- steps: return 0 pass, 77 skip (after skip/skip_ok), anything else fail ---------------------------------------

step_npm_ci() {
  [ -f package-lock.json ] || { skip "no package-lock.json"; return; }
  npm ci
}
step_typecheck() { npm run typecheck; }
step_test() { heavy npm test; }
step_no_network() {
  # The engine, the plugin's mod (whose host API module is "claude-code") and hook scripts, and the macOS app sources.
  # Not scripts/: the installer downloads releases with curl by design. Mirrors ci.yml.
  set --
  for d in engine/src plugin/mod plugin/scripts macos/Sources ui/src; do  # ui/scripts + ui/test are dev tooling (headless Chrome)
    if [ -d "$d" ]; then set -- "$@" "$d"; fi
  done
  node scripts/check-no-network.mjs --host-module claude-code "$@"
}
step_changelog() { node scripts/assemble-changelog.mjs --check; }
step_privacy_selftest() { node scripts/check-privacy.mjs --self-test; }
step_hygiene_selftests() {
  node scripts/check-no-network.mjs --self-test || return 1
  node scripts/assemble-changelog.mjs --self-test
}
step_privacy_scan() {
  # Mirrors ci.yml: skips (exit 0, loudly) until testdata/hostile/CANARIES.txt exists; --prepublish requires it.
  set --
  for p in docs contract design README.md CHANGELOG.md changelog.d; do
    if [ -e "$p" ]; then set -- "$@" "$p"; fi
  done
  [ $# -gt 0 ] || { skip "no docs/contract/design/README/CHANGELOG to scan"; return; }
  # shellcheck disable=SC2086 # PRIVACY_FLAGS is a fixed flag list
  node scripts/check-privacy.mjs $PRIVACY_FLAGS "$@"
}
step_sh_syntax() {
  list="$LOGDIR/shell-scripts.tsv"
  shell_scripts > "$list"
  status=0
  checked=0
  have_dash=0
  if command -v dash >/dev/null 2>&1; then have_dash=1; fi
  TAB=$(printf '\t')
  while IFS="$TAB" read -r interp f; do
    if ! command -v "$interp" >/dev/null 2>&1; then
      echo "skip  $f ($interp is not installed)"
      continue
    fi
    if "$interp" -n "$f"; then
      # macOS /bin/sh is bash in POSIX mode and accepts bashisms that Ubuntu's sh (dash) rejects: check with dash too.
      if [ "$interp" = sh ] && [ "$have_dash" = 1 ]; then
        if dash -n "$f"; then echo "ok    $f (sh -n, dash -n)"; else echo "FAIL  $f (shell syntax error under dash -n)"; status=1; continue; fi
      else
        echo "ok    $f ($interp -n)"
      fi
      checked=$((checked + 1))
    else
      echo "FAIL  $f (shell syntax error under $interp -n)"
      status=1
    fi
  done < "$list"
  [ "$status" = 0 ] || return 1
  [ "$checked" -gt 0 ] || { skip "no shell scripts found"; return; }
  return 0
}
step_shellcheck() {
  sc=${CI_LOCAL_SHELLCHECK:-shellcheck}
  command -v "$sc" >/dev/null 2>&1 || { skip "shellcheck is not installed (brew install shellcheck); ci.yml runs it on ubuntu"; return; }
  list="$LOGDIR/shellcheck.tsv"
  shell_scripts > "$list"
  status=0
  checked=0
  TAB=$(printf '\t')
  while IFS="$TAB" read -r interp f; do
    case $interp in sh|bash) ;; *) continue ;; esac # zsh scripts are skipped: ShellCheck cannot check them
    checked=$((checked + 1))
    "$sc" --severity=warning --shell="$interp" "$f" || status=1
  done < "$list"
  [ "$checked" -gt 0 ] || { skip "no sh/bash scripts found"; return; }
  echo "shellcheck: $checked script(s) checked"
  return "$status"
}
step_script_tests() {
  set -- scripts/test/*.test.mjs
  [ -e "$1" ] || { skip "no scripts/test/*.test.mjs"; return; }
  node --test "$@"
}
# The installer suites (scripts/test/t_*.sh) build throwaway homes with recording shims for claude, codex, launchctl,
# codesign and swift: nothing real is touched. run.sh routes its own t_heavy_* files through heavy.sh.
step_installer_tests() {
  [ -f scripts/test/run.sh ] || { skip "no scripts/test/run.sh"; return; }
  heavy env WASITME_TEST_SKIP_HEAVY=1 sh scripts/test/run.sh
}
step_installer_tests_dash() {
  [ -f scripts/test/run.sh ] || { skip "no scripts/test/run.sh"; return; }
  command -v dash >/dev/null 2>&1 || { skip "dash is not installed; ci.yml runs this on ubuntu"; return; }
  heavy env WASITME_TEST_SKIP_HEAVY=1 WASITME_TEST_SH=dash sh scripts/test/run.sh
}
step_installer_heavy() {
  [ -f scripts/test/run.sh ] || { skip "no scripts/test/run.sh"; return; }
  [ "$(uname -s)" = Darwin ] || { skip "the app builds need macOS"; return; }
  command -v swift >/dev/null 2>&1 || { skip "swift is not installed"; return; }
  sh scripts/test/run.sh t_heavy_
}
step_plugin_sh_tests() {
  [ -f plugin/tests/hooks.sh ] || { skip "no plugin/tests yet"; return; }
  sh plugin/tests/hooks.sh || return 1
  if [ -f plugin/tests/run-sh.sh ]; then sh plugin/tests/run-sh.sh; fi
}
step_plugin_fixtures() {
  [ -f plugin/tests/fixtures/sync.mjs ] || { skip "no plugin fixtures yet"; return; }
  node plugin/tests/fixtures/sync.mjs --check
}
step_plugin_mod_tests() {
  [ -d plugin/mod ] || { skip "no plugin/mod yet"; return; }
  claude_bin=$(command -v claude) || { skip "the claude CLI is not installed"; return; }
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-claude-modtest.XXXXXX") || return 1
  mkdir -p "$tmp/claude"
  # A temp HOME and CLAUDE_CONFIG_DIR, as in plugin-validate: the mod tests run locally and need no login (#LESSONS).
  rc=0
  HOME="$tmp" CLAUDE_CONFIG_DIR="$tmp/claude" "$claude_bin" plugin test plugin </dev/null || rc=1
  rm -rf "$tmp"
  return "$rc"
}
# The design system's own checks (design/system/gen/test.mjs): tokens.json and every generated file agree, colour pairs
# pass WCAG, glyphs and screens are well-formed. The engine, app and plugin checks compare their copies against
# design/system/generated, so without this a token edited without `node design/system/gen/build.mjs` goes unnoticed.
step_design_tests() {
  [ -f design/system/gen/test.mjs ] || { skip "no design/system yet"; return; }
  node design/system/gen/test.mjs
}
step_copy_lint() {
  # shellcheck disable=SC2086 # COPY_FLAGS is a fixed flag list
  node scripts/lint-copy.mjs $COPY_FLAGS
}
step_repo_greps() {
  # shellcheck disable=SC2086 # REPO_FLAGS is a fixed, space-separated flag list
  node scripts/check-repo.mjs $REPO_FLAGS
}
step_git_identity() {
  # Commit metadata is not a file, so no scan above sees it. Rewriting history (and changing user.email) is the
  # maintainer's decision before publishing (D27), so this gate only runs under --prepublish.
  [ "$PREPUBLISH" = 1 ] || { skip_ok "runs under --prepublish only (history rewrite is the maintainer's call)"; return; }
  node scripts/check-repo.mjs --git-identity --require-email-config
}
step_mod_allowlist() {
  # The frozen mod capability allow-list (D25); the same script runs in ci.yml. Comments are masked, so prose that
  # mentions `$.fs` is not a call.
  [ -d plugin ] || { skip "no plugin/ directory yet"; return; }
  node scripts/check-mod-allowlist.mjs plugin || return 1
  # The exact check: the host's own `calls:` and `hooks:` lines from `claude plugin validate`, held to the allow-list in
  # plugin/tests/check-calls.mjs (it runs claude with a throwaway HOME and CLAUDE_CONFIG_DIR; no login). The grep above
  # only forbids known-bad calls, so a new call outside the frozen list would pass it alone.
  if [ -f plugin/tests/check-calls.mjs ]; then
    if command -v claude >/dev/null 2>&1; then
      node plugin/tests/check-calls.mjs || return 1
    else
      echo "check-calls: the claude CLI is not installed; only the static check ran"
    fi
  fi
}
step_swift_macros() { node scripts/swift-macros.mjs; }
step_swift_build() {
  swift_pkg_or_explain || return
  command -v swift >/dev/null 2>&1 || { skip "swift is not installed"; return; }
  ( cd "$pkg" && heavy swift build )
}
step_swift_test() {
  swift_pkg_or_explain || return
  command -v swift >/dev/null 2>&1 || { skip "swift is not installed"; return; }
  # Under the Command Line Tools, swift test needs the testing macro plugin path (macos/README.md). Verified 2026-10-04
  # with a throwaway package: with that flag a Swift Testing test passes under the CLT, while an XCTest test fails there
  # ("unable to resolve module dependency: 'XCTest'"), so tests meant to run on a CLT-only machine must use Swift Testing.
  set --
  if clt_is_default; then
    plugins="$(xcode-select -p)/usr/lib/swift/host/plugins/testing"
    if [ -d "$plugins" ]; then set -- -Xswiftc -plugin-path -Xswiftc "$plugins"; fi
  fi
  ( cd "$pkg" && heavy swift test "$@" )
}
step_swift_build_clt() {
  swift_pkg_or_explain || return
  [ -x "$CLT_DIR/usr/bin/swift" ] || { skip "no Command Line Tools at $CLT_DIR"; return; }
  if clt_is_default; then skip_ok "the selected toolchain already is the Command Line Tools (swift-build covers it)"; return; fi
  ( cd "$pkg" && heavy env DEVELOPER_DIR="$CLT_DIR" "$CLT_DIR/usr/bin/swift" build --scratch-path .build/clt )
}
# The Control Center canvas (ui/, WP-41). Its build runs tsc and bundles; the model tests need ui/build from it, and the
# render smoke needs ui/dist plus one headless Chrome (design pairs only: 20 shots, the CSP negative control).
step_ui_build() {
  [ -f ui/package.json ] || { skip "no ui/ canvas"; return; }
  heavy node ui/scripts/build.mjs
}
step_ui_test() {
  [ -f ui/package.json ] || { skip "no ui/ canvas"; return; }
  if [ ! -f ui/build/pages.js ]; then heavy node ui/scripts/build.mjs || return 1; fi
  node --test --test-concurrency=2 ui/test/model.test.mjs
}
step_ui_render() {
  [ -f ui/package.json ] || { skip "no ui/ canvas"; return; }
  chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
  [ -x "$chrome" ] || { skip "no Chrome at $chrome (set CHROME=...)"; return; }
  if [ ! -f ui/dist/app.js ]; then heavy node ui/scripts/build.mjs || return 1; fi
  heavy env CHROME="$chrome" WASITME_RENDER_JOBS=1 node ui/test/render.mjs --design
}
# The release app's offscreen capture (macos/README.md, "Offscreen capture") with the D48 memory budgets. A release build
# fails the capture on a budget that is over (a debug build only prints them), so this builds with -c release, and it
# also fails on any budget line that says OVER and on a capture that reported no enforced budget at all. The PNGs land in
# the per-step log directory (CI_LOCAL_KEEP_LOGS=1 keeps them). The capture opens no window, Dock icon or status item and
# renders the contract fixtures only: it never opens the wasitme home folder (AppMain branches into CaptureRunner before
# the instance lock, and CaptureRunner never reads options.home). Opt-in: the release build plus 347 PNGs and a WebKit
# process take minutes.
step_app_capture() {
  [ "$CAPTURE" = 1 ] || { skip "opt-in: pass --capture or CI_LOCAL_CAPTURE=1 (release build + offscreen capture, minutes)"; return; }
  [ "$(uname -s)" = Darwin ] || { skip "the app capture needs macOS"; return; }
  swift_pkg_or_explain || return
  command -v swift >/dev/null 2>&1 || { skip "swift is not installed"; return; }
  # Without the real canvas the Control Center budget would measure the placeholder page, not what ships.
  [ -f ui/package.json ] || { skip "no ui/ canvas to measure the Control Center with"; return; }
  if [ ! -f ui/dist/app.js ]; then heavy node ui/scripts/build.mjs || return 1; fi
  ( cd "$pkg" && heavy swift build -c release ) || return 1
  app="$pkg/.build/release/WasitmeApp"
  [ -x "$app" ] || { echo "FAIL: swift build -c release left no executable at $app"; return 1; }
  out="$LOGDIR/capture"
  log="$LOGDIR/capture.out"
  rc=0
  heavy "$app" --capture "$out" --fixtures contract/fixtures --canvas ui/dist > "$log" 2>&1 || rc=$?
  cat "$log"
  if grep -q '^memory budget .*: OVER$' "$log"; then echo "FAIL: a memory budget is over (D48; the lines above say which)"; return 1; fi
  [ "$rc" = 0 ] || { echo "FAIL: the capture exited $rc (its FAILED lines are above)"; return 1; }
  grep -q '^memory budget (release build, enforced): ' "$log" || {
    echo "FAIL: the capture reported no enforced memory budget (a debug binary only prints them)"
    return 1
  }
  echo "app-capture: PNGs and index.json in $out (removed at exit unless CI_LOCAL_KEEP_LOGS=1)"
}
step_plugin_validate() {
  if [ ! -d plugin ] && [ ! -f .claude-plugin/marketplace.json ]; then skip "no plugin/ yet"; return; fi
  claude_bin=$(command -v claude) || { skip "the claude CLI is not installed"; return; }
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-claude-validate.XXXXXX") || return 1
  mkdir -p "$tmp/claude"
  rc=0
  validated=0
  # A temp HOME and CLAUDE_CONFIG_DIR: validation must never read or write the real ~/.claude (#LESSONS). It is a
  # local manifest check and needs no login.
  if [ -f .claude-plugin/marketplace.json ]; then
    validated=1
    HOME="$tmp" CLAUDE_CONFIG_DIR="$tmp/claude" "$claude_bin" plugin validate --strict . || rc=1
  fi
  if [ -f plugin/.claude-plugin/plugin.json ]; then
    validated=1
    HOME="$tmp" CLAUDE_CONFIG_DIR="$tmp/claude" "$claude_bin" plugin validate --strict plugin || rc=1
  fi
  rm -rf "$tmp"
  if [ "$rc" = 0 ] && [ "$validated" = 0 ]; then skip "no plugin manifest to validate yet"; return; fi
  return "$rc"
}

# ---- runner ------------------------------------------------------------------------------------------------------

SUMMARY="$LOGDIR/summary.tsv"
: > "$SUMMARY"
# "-" stands in for an empty field: read(1) merges adjacent tab delimiters, which would shift the columns.
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "${3:--}" "${4:--}" >> "$SUMMARY"; }

# Run step function $1 in the background, its output live on the terminal and in $LOGDIR/$CURRENT.log, its exit status
# in $LOGDIR/$CURRENT.rc. `wait` (unlike a foreground child) returns as soon as a trapped signal arrives.
run_step() {
  fifo="$LOGDIR/$CURRENT.fifo"
  mkfifo "$fifo" || return 1
  tee "$LOGDIR/$CURRENT.log" < "$fifo" &
  teepid=$!
  ( "$1"; echo $? > "$LOGDIR/$CURRENT.rc" ) > "$fifo" 2>&1 &
  child=$!
  wait "$child"
  child=""
  wait "$teepid"
  rm -f "$fifo"
}

failed_step=""
for name in $STEPS; do
  if [ -n "$ONLY" ] && ! in_csv "$name" "$ONLY"; then record "$name" "-" "" "not selected"; continue; fi
  if in_csv "$name" "$SKIP"; then record "$name" "SKIP" "" "skipped by --skip"; continue; fi
  if [ -n "$failed_step" ] && [ "$KEEP_GOING" = 0 ]; then record "$name" "NOT RUN" "" "stopped at $failed_step"; continue; fi

  CURRENT=$name
  fn="step_$(printf '%s' "$name" | tr '-' '_')"
  printf '\n==> %s: %s\n' "$name" "$(describe "$name")"
  start=$(date +%s)
  run_step "$fn"
  rc=$(cat "$LOGDIR/$name.rc" 2>/dev/null || echo 1)
  secs=$(( $(date +%s) - start ))
  reason=""
  if [ -f "$LOGDIR/$name.skip" ]; then reason=$(head -n 1 "$LOGDIR/$name.skip"); fi
  case $rc in
    0)  record "$name" "PASS" "$secs" "" ;;
    77)
      if [ -n "$reason" ]; then
        record "$name" "SKIP" "$secs" "$reason"
      else
        # A tool that happens to exit 77 (sysexits EX_NOPERM, a stray process.exit) must not turn a gate green.
        record "$name" "FAIL" "$secs" "exit 77 without a SKIP (only skip() may skip)"; [ -n "$failed_step" ] || failed_step=$name
      fi ;;
    *)
      if [ -n "$reason" ] && [ "$PREPUBLISH" = 1 ]; then note="skipped, not allowed under --prepublish: $reason"; else note="exit $rc"; fi
      record "$name" "FAIL" "$secs" "$note"; [ -n "$failed_step" ] || failed_step=$name ;;
  esac
done

echo
echo "ci-local summary"
printf '%-20s %-8s %6s  %s\n' STEP RESULT TIME NOTE
passed=0; skipped=0; failures=0
TAB=$(printf '\t')
while IFS="$TAB" read -r s result secs note; do
  case $result in PASS) passed=$((passed + 1)) ;; SKIP) skipped=$((skipped + 1)) ;; FAIL) failures=$((failures + 1)) ;; esac
  if [ "$secs" = "-" ]; then t=""; else t="${secs}s"; fi
  if [ "$note" = "-" ]; then note=""; fi
  printf '%-20s %-8s %6s  %s\n' "$s" "$result" "$t" "$note"
done < "$SUMMARY"

# Anything a step reported as SKIPPED inside a passing run (e.g. the forbidden-email rule) must stay visible.
notes=$(cat "$LOGDIR"/*.log 2>/dev/null | grep 'SKIPPED' | sort -u)
if [ -n "$notes" ]; then
  echo
  echo "Heads-up (a check ran with part of itself skipped):"
  printf '%s\n' "$notes" | sed 's/^/  /'
fi

qualifier=""
if [ -n "$ONLY$SKIP" ]; then qualifier="PARTIAL: --only/--skip used; "; fi
if printf '%s\n' "$notes" | grep -q 'SKIPPED forbidden-email'; then qualifier="${qualifier}forbidden-email rule NOT run; "; fi
[ "$PREPUBLISH" = 1 ] && qualifier="${qualifier}--prepublish; "

echo
if [ "$failures" -gt 0 ]; then
  echo "ci-local: FAIL (${qualifier}$failures failed, $passed passed, $skipped skipped; first failure: $failed_step)"
  exit 1
fi
echo "ci-local: PASS (${qualifier}$passed passed, $skipped skipped)"
exit 0
