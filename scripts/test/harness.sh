# shellcheck shell=sh
# Tiny test harness for the installer tests. Source it from a t_*.sh file. POSIX sh.
#
# Safety model: every test runs the installer against a throw-away --home inside a temp root, with recording
# shims (shim.sh) injected for claude, codex, launchctl, codesign, xcode-select, npm, curl, pkill, pgrep, open and swift. Nothing
# here touches the real ~/.claude, ~/.codex, ~/Library or launchd. All fixtures are generated, 100% synthetic.
#
# The names this file sets (T_UID, T_OS, LABEL_SCAN, LABEL_APP, CORE_ONLY) are the tests' inputs: the t_*.sh files that
# source it read them. The linter looks at one file at a time and would call them unused (SC2034); each was checked with
# grep to be read by a test. This single directive, before the first command, covers the whole file.
# shellcheck disable=SC2034

T_DIR=${T_DIR:-$(cd "$(dirname "$0")" && pwd)}
T_REPO=$(cd "$T_DIR/../.." && pwd)
SH_BIN=$(command -v "${WASITME_TEST_SH:-sh}")
T_NAME=$(basename "$0" .sh)
T_PASS=0
T_FAIL=0
T_N=0
T_UID=$(id -u)
T_OS=$(uname -s)

# A clean slate: nothing from the developer's own environment may leak into a test.
for t_v in $(env | sed -n 's/^\(WASITME_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$t_v"; done
unset CLAUDE_CONFIG_DIR CODEX_HOME DEVELOPER_DIR
BASE_PATH=$PATH

T_TMP=${TMPDIR:-/tmp}
T_TMP=${T_TMP%/}   # macOS TMPDIR ends in a slash; keep expected paths free of "//"
T_ROOT=$(mktemp -d "$T_TMP/wasitme-t.XXXXXX")
t_cleanup() {
  chmod -R u+w "$T_ROOT" 2>/dev/null
  rm -rf "$T_ROOT"
}
trap t_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- assertions -------------------------------------------------------------------------------------------
t_pass() { T_PASS=$((T_PASS + 1)); }
t_fail() {
  T_FAIL=$((T_FAIL + 1))
  printf '  FAIL [%s] %s\n' "$T_NAME" "$1"
  shift
  for t_l in "$@"; do printf '       %s\n' "$t_l"; done
}
t_section() { printf '%s: %s\n' "$T_NAME" "$1"; }

assert_eq() { if [ "$1" = "$2" ]; then t_pass; else t_fail "$3" "expected: $1" "actual:   $2"; fi; }
assert_contains() {
  case $1 in
    *"$2"*) t_pass ;;
    *) t_fail "$3" "missing:  $2" "in:       $(printf '%s' "$1" | head -c 900)" ;;
  esac
}
assert_not_contains() {
  case $1 in
    *"$2"*) t_fail "$3" "unexpected: $2" "in:         $(printf '%s' "$1" | head -c 900)" ;;
    *) t_pass ;;
  esac
}
assert_file() { if [ -f "$1" ]; then t_pass; else t_fail "${2:-missing file: $1}"; fi; }
assert_dir() { if [ -d "$1" ]; then t_pass; else t_fail "${2:-missing directory: $1}"; fi; }
assert_missing() { if [ ! -e "$1" ] && [ ! -L "$1" ]; then t_pass; else t_fail "${2:-should not exist: $1}"; fi; }
assert_link() {  # assert_link LINK TARGET
  t_got=$(readlink "$1" 2>/dev/null || true)
  if [ "$t_got" = "$2" ]; then t_pass; else t_fail "${3:-symlink $1}" "expected -> $2" "actual   -> $t_got"; fi
}
assert_file_has() {  # assert_file_has FILE TEXT [MSG]  (fixed string)
  if [ -f "$1" ] && grep -qF -- "$2" "$1"; then t_pass; else t_fail "${3:-$1 should contain: $2}" "$( [ -f "$1" ] && head -c 600 "$1" )"; fi
}
assert_file_lacks() {
  if [ -f "$1" ] && grep -qF -- "$2" "$1"; then t_fail "${3:-$1 should NOT contain: $2}"; else t_pass; fi
}
assert_line() {  # assert_line FILE EXACT-LINE [MSG]: some whole line of FILE equals the text
  if [ -f "$1" ] && grep -qxF -- "$2" "$1"; then t_pass; else t_fail "${3:-$1 should have the line: $2}" "$( [ -f "$1" ] && head -c 1500 "$1" )"; fi
}
assert_no_line() {
  if [ -f "$1" ] && grep -qxF -- "$2" "$1"; then t_fail "${3:-$1 should NOT have the line: $2}"; else t_pass; fi
}
assert_same_file() {  # assert_same_file A B MSG
  if cmp -s "$1" "$2"; then t_pass; else t_fail "$3" "files differ: $1 vs $2"; fi
}
assert_rc() {  # assert_rc EXPECTED [MSG]  (uses T_RC from inst/uninst)
  if [ "$T_RC" = "$1" ]; then t_pass; else
    t_fail "${2:-exit code}" "expected rc $1, got $T_RC" "stdout: $(head -c 700 "$T_OUT")" "stderr: $(head -c 700 "$T_ERR")"
  fi
}
out() { cat "$T_OUT"; }
err() { cat "$T_ERR"; }
shimlog() { cat "$SHIM_LOG"; }
shimenv() { cat "$SHIM_ENV_LOG"; }
# Files and directories under a path, as a sorted list (for "nothing changed" comparisons).
tree_of() { ( cd "$1" && find . | sort ); }
count_lines() { if [ -s "$1" ]; then wc -l <"$1" | tr -d ' '; else printf '0'; fi; }
# count_glob PATH...: how many of the given paths exist. Pass a glob, quoted up to the wildcard, as in
# `count_glob "$DIR"/*.bak`: it counts the entries of DIR whose names match (visible ones only, as with `ls`; a dangling
# symlink counts too), and prints 0 when nothing matches (an unmatched glob stays a literal path that does not exist).
count_glob() {
  cg_n=0
  for cg_f in "$@"; do
    if [ -e "$cg_f" ] || [ -L "$cg_f" ]; then cg_n=$((cg_n + 1)); fi
  done
  printf '%s\n' "$cg_n"
}

t_done() {
  printf '%s: %s passed, %s failed\n' "$T_NAME" "$T_PASS" "$T_FAIL"
  if [ "$T_FAIL" -gt 0 ]; then exit 1; fi
  exit 0
}

# ---- sandbox ---------------------------------------------------------------------------------------------------
make_shims() {
  for ms_n in claude codex launchctl codesign xcode-select npm curl pkill pgrep open; do
    {
      printf '#!/bin/sh\n'
      printf 'exec "%s" "%s/shim.sh" %s "$@"\n' "$SH_BIN" "$T_DIR" "$ms_n"
    } >"$SB/shims/$ms_n"
    chmod +x "$SB/shims/$ms_n"
  done
  mkdir -p "$DEV_DIR/usr/bin"
  {
    printf '#!/bin/sh\n'
    printf 'exec "%s" "%s/shim.sh" swift "$@"\n' "$SH_BIN" "$T_DIR"
  } >"$DEV_DIR/usr/bin/swift"
  chmod +x "$DEV_DIR/usr/bin/swift"
}

# sb_new [HOME-DIRNAME]: fresh sandbox with its own home, shims and environment.
sb_new() {
  for sb_v in $(env | sed -n 's/^\(SHIM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$sb_v"; done
  T_N=$((T_N + 1))
  SB="$T_ROOT/sb$T_N"
  mkdir -p "$SB/tmp" "$SB/shims" "$SB/outside"
  SB_HOME="$SB/${1:-home}"
  mkdir -p "$SB_HOME"
  SB_SRC="$SB/src"
  DEV_DIR="$SB/Xcode.app/Contents/Developer"
  SHIM_LOG="$SB/shim.log"
  SHIM_ENV_LOG="$SB/shim.env"
  : >"$SHIM_LOG"
  : >"$SHIM_ENV_LOG"
  make_shims
  export SHIM_LOG SHIM_ENV_LOG
  INST_PATH_EXTRA=""   # directories put in front of PATH for inst/uninst (e.g. a second node)
  export WASITME_CLAUDE="$SB/shims/claude" WASITME_CODEX="$SB/shims/codex"
  export WASITME_CODESIGN="$SB/shims/codesign" WASITME_LAUNCHCTL="$SB/shims/launchctl"
  export WASITME_XCODE_SELECT="$SB/shims/xcode-select" WASITME_NPM="$SB/shims/npm" WASITME_CURL="$SB/shims/curl"
  export WASITME_PKILL="$SB/shims/pkill" WASITME_PGREP="$SB/shims/pgrep" WASITME_OPEN="$SB/shims/open"
  SHIM_APP_STATE="$SB/app-running"   # the stand-in app: absent = not running, else who started it (launchd or user)
  export SHIM_APP_STATE
  SHIM_ENGINE_LOG="$SB/engine.log"   # what the stand-in engine was asked to do (doctor, ...)
  export SHIM_ENGINE_LOG
  export WASITME_DEVELOPER_DIRS="$DEV_DIR"
  export WASITME_LABEL_SUFFIX="test-$T_N-$$"
  export WASITME_SH="$SH_BIN"
  export TMPDIR="$SB/tmp"
  LABEL_SCAN="dev.wasitme.scan.$WASITME_LABEL_SUFFIX"
  LABEL_APP="dev.wasitme.menubar.$WASITME_LABEL_SUFFIX"
}

# write_fake_cli FILE VERSION [OPTIONS]: a stand-in engine CLI. `--version` prints "wasitme VERSION"; `--help` prints a
# usage text; every other call is logged to $SHIM_ENGINE_LOG and echoed. OPTIONS (space-separated):
#   fail       every call fails
#   noversion  `--version` is an unknown command (exit 2), like the engine CLI before WP-30
#   doctor     the usage lists `wasitme doctor`, so the installer runs `doctor --repair`
write_fake_cli() {
  mkdir -p "$(dirname "$1")"
  case " ${3:-} " in
    *" fail "*) printf 'console.error("broken engine"); process.exit(1);\n' >"$1"; return 0 ;;
  esac
  {
    printf 'import fs from "node:fs";\nconst a = process.argv.slice(2);\n'
    case " ${3:-} " in
      *" noversion "*) printf 'if (a[0] === "--version") { console.error("wasitme: unknown command"); process.exit(2); }\n' ;;
      *) printf 'if (a[0] === "--version") { console.log("wasitme %s"); process.exit(0); }\n' "$2" ;;
    esac
    case " ${3:-} " in
      *" doctor "*) printf 'if (a[0] === "--help") { console.log("usage:\\n  wasitme scan\\n  wasitme doctor [--repair]"); process.exit(0); }\n' ;;
      *) printf 'if (a[0] === "--help") { console.log("usage:\\n  wasitme scan\\n  wasitme hook session-start"); process.exit(0); }\n' ;;
    esac
    printf 'if (process.env.SHIM_ENGINE_LOG) fs.appendFileSync(process.env.SHIM_ENGINE_LOG, "engine " + a.join(" ") + " WASITME_INSTALLER_ACTIVE=" + (process.env.WASITME_INSTALLER_ACTIVE || "") + "\\n");\n'
    printf 'if (a[0] === "doctor" && process.env.SHIM_DOCTOR_FAIL) { console.log("doctor: 1 problem"); process.exit(1); }\n'
    printf 'if (a[0] === "doctor" && process.env.SHIM_DOCTOR_PROBLEMS) { console.log("wasitme doctor\\n  home  present\\n\\nProblems:\\n  No results yet. Run: wasitme scan"); process.exit(1); }\n'
    printf 'console.log("fake wasitme " + a.join(" "));\n'
  } >"$1"
}

# make_fixture DIR VERSION [OPTIONS]: a synthetic source tree, with the real installer scripts. OPTIONS, space-separated:
#   macos-fake | macos-real   a macos/ folder (a placeholder, or the tiny real Swift package)
#   no-dist                   no prebuilt engine/dist (the installer builds it with npm)
#   no-codex                  no plugin-codex/ root
#   noversion | doctor | fail passed on to write_fake_cli
make_fixture() {
  mf_d=$1
  mf_v=$2
  mf_o=" ${3:-} "
  rm -rf "$mf_d"
  mkdir -p "$mf_d/engine/src/cli" "$mf_d/.claude-plugin" "$mf_d/plugin/hooks" "$mf_d/scripts"
  printf '{ "name": "wasitme-monorepo", "private": true, "workspaces": ["engine"] }\n' >"$mf_d/package.json"
  printf '{ "lockfileVersion": 3 }\n' >"$mf_d/package-lock.json"
  printf '{ "name": "wasitme", "version": "%s", "type": "module", "bin": { "wasitme": "dist/src/cli/main.js" }, "dependencies": {} }\n' "$mf_v" >"$mf_d/engine/package.json"
  printf '{ "compilerOptions": {} }\n' >"$mf_d/engine/tsconfig.json"
  mf_cli_opts=""
  for mf_x in noversion doctor fail; do case $mf_o in *" $mf_x "*) mf_cli_opts="$mf_cli_opts $mf_x" ;; esac; done
  write_fake_cli "$mf_d/engine/src/cli/main.js" "$mf_v" "$mf_cli_opts"
  if case $mf_o in *" no-dist "*) false ;; *) true ;; esac; then
    mkdir -p "$mf_d/engine/dist/test"
    write_fake_cli "$mf_d/engine/dist/src/cli/main.js" "$mf_v" "$mf_cli_opts"
    printf 'test only\n' >"$mf_d/engine/dist/test/x.test.js"
  fi
  printf 'MIT License (synthetic fixture)\n' >"$mf_d/LICENSE"
  printf '{ "name": "wasitme", "owner": { "name": "Test" }, "plugins": [ { "name": "wasitme", "source": "./plugin" } ] }\n' >"$mf_d/.claude-plugin/marketplace.json"
  mkdir -p "$mf_d/plugin/.claude-plugin"
  printf '{ "name": "wasitme", "version": "%s" }\n' "$mf_v" >"$mf_d/plugin/.claude-plugin/plugin.json"
  printf '{ "modules": ["../mod/register.ts"], "hooks": { "SessionStart": [ { "matcher": "startup|resume", "hooks": [ { "type": "command", "command": "/bin/sh \\"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh\\"", "async": true } ] } ] } }\n' >"$mf_d/plugin/hooks/hooks.json"
  printf '$.clock.now, $.fs.read\n' >"$mf_d/plugin/.fake-calls"   # what the stand-in `claude plugin validate` reports
  mkdir -p "$mf_d/plugin/tests" && printf 'not shipped\n' >"$mf_d/plugin/tests/x.test.ts"
  if case $mf_o in *" no-codex "*) false ;; *) true ;; esac; then
    mkdir -p "$mf_d/plugin-codex/.agents/plugins" "$mf_d/plugin-codex/.codex-plugin" "$mf_d/plugin-codex/skills/report"
    printf '{ "name": "wasitme-codex", "plugins": [ { "name": "wasitme", "source": "./" } ] }\n' >"$mf_d/plugin-codex/.agents/plugins/marketplace.json"
    printf '{ "name": "wasitme", "version": "%s" }\n' "$mf_v" >"$mf_d/plugin-codex/.codex-plugin/plugin.json"
    printf '{ "$schema": "https://example.invalid/agent-plugin.json", "name": "wasitme", "version": "%s" }\n' "$mf_v" >"$mf_d/plugin-codex/plugin.json"
    printf '%s\n' '---' 'name: report' '---' 'synthetic' >"$mf_d/plugin-codex/skills/report/SKILL.md"
  fi
  cp "$T_REPO/scripts/install.sh" "$T_REPO/scripts/uninstall.sh" "$mf_d/scripts/"
  cp -R "$T_REPO/scripts/lib" "$mf_d/scripts/lib"
  # The real status-line script (plain sh; it only reads ~/.wasitme/glance.json). `no-sl-script` leaves it out.
  case $mf_o in
    *" no-sl-script "*) ;;
    *) mkdir -p "$mf_d/packaging" && cp "$T_REPO/packaging/statusline.sh" "$mf_d/packaging/statusline.sh" ;;
  esac
  # Development-only engine folders the installer must not copy (engine/package.json `files` leaves them out too).
  if case $mf_o in *" no-dist "*) false ;; *) true ;; esac; then
    mkdir -p "$mf_d/engine/dist/src/synth" "$mf_d/engine/dist/src/analysis/calibration"
    printf 'dev only\n' >"$mf_d/engine/dist/src/synth/gen.js"
    printf 'dev only\n' >"$mf_d/engine/dist/src/analysis/calibration/run.js"
  fi
  case $mf_o in
    *" macos-fake "*) mkdir -p "$mf_d/macos" && printf '// synthetic fixture\n' >"$mf_d/macos/Package.swift" ;;
    *" macos-real "*) cp -R "$T_DIR/fixtures/app-pkg" "$mf_d/macos" && rm -rf "$mf_d/macos/.build" "$mf_d/macos/.swiftpm" ;;  # an IDE may have indexed the fixture
  esac
  # What the app bundle carries besides the executable (build-app.sh's set): a built Control Center page (ui/dist) and
  # the bundled fonts. Synthetic stand-ins. `no-ui`: no ui/dist; `ui-src`: no ui/dist but a stand-in ui/ build script and
  # a stand-in TypeScript next to the source; `no-fonts`: no design/system/fonts.
  case $mf_o in
    *" macos-fake "*|*" macos-real "*)
      case $mf_o in
        *" no-ui "*|*" ui-src "*) ;;
        *)
          mkdir -p "$mf_d/ui/dist/fonts"
          for mf_x in app.html app.js app.css; do printf 'synthetic %s\n' "$mf_x" >"$mf_d/ui/dist/$mf_x"; done
          printf 'synthetic woff2\n' >"$mf_d/ui/dist/fonts/Test-Regular.woff2"
          printf 'OFL (synthetic)\n' >"$mf_d/ui/dist/fonts/OFL.txt"
          mkdir -p "$mf_d/ui/dist/shots" && printf 'test screenshot\n' >"$mf_d/ui/dist/shots/x.png" ;;
      esac
      case $mf_o in
        *" ui-src "*)
          mkdir -p "$mf_d/ui/scripts" "$mf_d/ui/src" "$mf_d/ui/static" "$mf_d/design/system/glyphs" "$mf_d/design/system/generated" "$mf_d/design/system/screens" "$mf_d/node_modules/typescript/bin"
          printf '{}\n' >"$mf_d/design/system/tokens.json"
          printf ':root{}\n' >"$mf_d/design/system/generated/tokens.css"
          printf '.x{}\n' >"$mf_d/design/system/screens/components.css"
          printf 'export {};\n' >"$mf_d/ui/src/main.ts"
          printf '{ "name": "wasitme-ui", "private": true }\n' >"$mf_d/ui/package.json"
          printf '// stand-in tsc\n' >"$mf_d/node_modules/typescript/bin/tsc"
          cat >"$mf_d/ui/scripts/build.mjs" <<'MFEOF'
// Stand-in for ui/scripts/build.mjs: writes ui/dist next to itself, and fails unless TypeScript is reachable the way
// the real build finds it (node_modules beside ui/).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ui = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.accessSync(path.join(ui, "..", "node_modules", "typescript", "bin", "tsc"));
fs.mkdirSync(path.join(ui, "dist", "fonts"), { recursive: true });
for (const f of ["app.html", "app.js", "app.css"]) fs.writeFileSync(path.join(ui, "dist", f), "built " + f + "\n");
fs.writeFileSync(path.join(ui, "dist", "fonts", "Built-Regular.woff2"), "woff2\n");
fs.writeFileSync(path.join(ui, "dist", "fonts", "OFL.txt"), "OFL\n");
MFEOF
          ;;
      esac
      case $mf_o in
        *" no-fonts "*) ;;
        *)
          mkdir -p "$mf_d/design/system/fonts/app"
          printf 'synthetic ttf\n' >"$mf_d/design/system/fonts/app/Test-Regular.ttf"
          printf 'OFL (synthetic)\n' >"$mf_d/design/system/fonts/OFL.txt" ;;
      esac ;;
  esac
}

# inst ARGS...: run the installer in the sandbox. Sets T_RC, T_OUT, T_ERR. Never has a terminal: the real /dev/tty is never
# read (WASITME_TTY points at a file of answers, or at nothing).
inst() {
  T_OUT="$SB/out.txt"
  T_ERR="$SB/err.txt"
  WASITME_TTY="${WASITME_TTY:-$SB/no-tty}" PATH="${INST_PATH_EXTRA:+$INST_PATH_EXTRA:}$SB/shims:$BASE_PATH" "$SH_BIN" "$T_REPO/scripts/install.sh" --home "$SB_HOME" "$@" >"$T_OUT" 2>"$T_ERR" </dev/null
  T_RC=$?
}
# Same, from the fixture tree.
inst_from() { inst --from "$SB_SRC" "$@"; }

uninst() {
  T_OUT="$SB/out.txt"
  T_ERR="$SB/err.txt"
  WASITME_TTY="${WASITME_TTY:-$SB/no-tty}" PATH="$SB/shims:$BASE_PATH" "$SH_BIN" "$T_REPO/scripts/uninstall.sh" --home "$SB_HOME" "$@" >"$T_OUT" 2>"$T_ERR" </dev/null
  T_RC=$?
}

# The flags that turn every optional component off.
CORE_ONLY="--yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --no-statusline"

# fs_snapshot DIR > FILE: every entry under DIR as "path<TAB>kind<TAB>mode<TAB>sha256|link target", sorted. Files are
# compared by content and mode, symlinks by target, folders by mode (mtimes are ignored).
fs_snapshot() {
  node -e '
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    const root = process.argv[1], out = [];
    const walk = (rel) => {
      const abs = path.join(root, rel), st = fs.lstatSync(abs), mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) out.push([rel, "L", mode, fs.readlinkSync(abs)]);
      else if (st.isDirectory()) { out.push([rel, "D", mode, ""]); for (const e of fs.readdirSync(abs)) walk(path.join(rel, e)); }
      else out.push([rel, "F", mode, crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16)]);
    };
    for (const e of fs.readdirSync(root)) walk(e);
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    process.stdout.write(out.map((r) => r.join("\t")).join("\n") + (out.length ? "\n" : ""));
  ' "$1"
}

# snapshot_changes A B: the paths whose line differs between two fs_snapshot files (added, removed or changed).
snapshot_changes() {
  node -e '
    const fs = require("fs");
    const read = (f) => new Map(fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => [l.split("\t")[0], l]));
    const a = read(process.argv[1]), b = read(process.argv[2]);
    const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
    for (const k of keys) if (a.get(k) !== b.get(k)) console.log(k);
  ' "$1" "$2"
}

json_get() {  # json_get FILE JS-EXPRESSION-ON-d  -> prints the value (uses node)
  node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = eval(process.argv[2]); console.log(typeof v === "object" ? JSON.stringify(v) : String(v));' "$1" "$2"
}

plist_get() {  # plist_get FILE KEYPATH -> raw value (macOS plutil)
  plutil -extract "$2" raw -o - "$1" 2>/dev/null
}
