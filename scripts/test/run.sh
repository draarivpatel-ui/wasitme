#!/bin/sh
# Runs every installer test, one file at a time, and exits non-zero if any file failed.
#
#   sh scripts/test/run.sh [name-filter]
#   WASITME_TEST_SH=dash sh scripts/test/run.sh        # run the tests AND the installer under dash
#   WASITME_TEST_SKIP_HEAVY=1 sh scripts/test/run.sh   # skip the real `swift build` test
#
# Files named t_heavy_*.sh run through scripts/dev/heavy.sh (one at a time, low priority, with a timeout) because
# they compile Swift. Everything runs in temp homes with injected shims: no real ~/.claude, ~/.codex, ~/Library
# or launchd is ever touched, and nothing is downloaded.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
SH_BIN=$(command -v "${WASITME_TEST_SH:-sh}")
FILTER=${1:-}
SKIP_HEAVY=${WASITME_TEST_SKIP_HEAVY:-0}
failed=0
ran=0

for t in "$HERE"/t_*.sh; do
  base=$(basename "$t")
  case $base in *"$FILTER"*) ;; *) continue ;; esac
  ran=$((ran + 1))
  case $base in
    t_heavy_*)
      if [ "$SKIP_HEAVY" = 1 ]; then printf '%s: skipped (WASITME_TEST_SKIP_HEAVY=1)\n' "$base"; continue; fi
      "$REPO/scripts/dev/heavy.sh" perl -e 'alarm 900; exec @ARGV' "$SH_BIN" "$t" || failed=$((failed + 1)) ;;
    *)
      "$SH_BIN" "$t" || failed=$((failed + 1)) ;;
  esac
done

echo
if [ "$ran" -eq 0 ]; then echo "no test files matched '$FILTER'"; exit 1; fi
if [ "$failed" -gt 0 ]; then echo "$failed of $ran installer test file(s) FAILED"; exit 1; fi
echo "all $ran installer test file(s) passed"
