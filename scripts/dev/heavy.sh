#!/bin/sh
# Run a CPU/IO-heavy command (full real-log scan, swift build, xcodebuild, calibration) one at a time, at low
# priority, so the machine stays responsive while you use it. Usage: scripts/dev/heavy.sh <command> [args...]
# The lock records the holder's PID; it is only broken when that process is gone, and only removed by its holder.
# WASITME_HEAVY_LANE=long: a second, separate lock for ONE long single-core job (the overnight calibration run), so it
# doesn't stall short heavy jobs (builds, tests) for hours. At most one long job + one short job run at a time.
# Re-entrant: a heavy job that itself calls heavy.sh (ci-local.sh run through heavy.sh, say) already holds a slot and
# already runs at low priority, so the nested call runs straight away instead of waiting on its own parent forever.
if [ -n "${WASITME_HEAVY_HELD:-}" ]; then exec "$@"; fi
BASE="${TMPDIR:-/tmp}/wasitme-heavy${WASITME_HEAVY_LANE:+-$WASITME_HEAVY_LANE}"
# Optional CPU boost (time-boxed): `$TMPDIR/wasitme-heavy.boost` holds "<start-epoch> <end-epoch>". While now is
# inside that window, short-lane jobs get 2 slots at normal priority and calibration may use up to 4 workers (keep total CPU at or below about 85%). A clock
# that went backward (now < start) ends the boost (AGENTS.md: timestamps can go backward).
BOOST=0
if [ -r "${TMPDIR:-/tmp}/wasitme-heavy.boost" ]; then
  read -r b_start b_end < "${TMPDIR:-/tmp}/wasitme-heavy.boost" 2>/dev/null || true
  now=$(date +%s)
  case "$b_start$b_end" in *[!0-9]*|'') ;; *) [ "$now" -ge "$b_start" ] && [ "$now" -lt "$b_end" ] && BOOST=1 ;; esac
fi
SLOTS=1; [ "$BOOST" = 1 ] && [ -z "${WASITME_HEAVY_LANE:-}" ] && SLOTS=2
LOCK="$BASE.lock"
waited=0
take() { i=1; while [ "$i" -le "$SLOTS" ]; do
  if [ "$i" = 1 ]; then LOCK="$BASE.lock"; else LOCK="$BASE.lock.$i"; fi
  if mkdir "$LOCK" 2>/dev/null; then return 0; fi
  holder=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null; continue; fi
  i=$((i + 1)); done; LOCK="$BASE.lock"; return 1; }
while ! take; do
  holder=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null; continue          # holder died: reclaim
  fi
  if [ -z "$holder" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null; continue                              # pid never written: reclaim after 2 min
  fi
  sleep 3; waited=$((waited + 3))
done
echo $$ > "$LOCK/pid"
export WASITME_HEAVY_HELD="$LOCK"
cleanup() { [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -f "$LOCK/pid" && rmdir "$LOCK" 2>/dev/null; }
trap cleanup EXIT INT TERM
[ "$waited" -gt 0 ] && echo "heavy.sh: waited ${waited}s for lock" >&2
# A laptop can overheat under parallel builds and test runs. Heavy jobs run at background QoS (efficiency cores, throttled I/O)
# and lowest priority, with worker/test concurrency capped unless the caller sets a lower value.
export WASITME_CAL_WORKERS="${WASITME_CAL_WORKERS:-1}" WASITME_RENDER_JOBS="${WASITME_RENDER_JOBS:-1}" UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-2}"
if [ "$BOOST" = 1 ]; then export WASITME_CAL_MAX_WORKERS=4; nice -n 5 "$@"; exit $?; fi
if command -v taskpolicy >/dev/null 2>&1; then taskpolicy -b nice -n 19 "$@"; exit $?; fi
nice -n 19 "$@"
