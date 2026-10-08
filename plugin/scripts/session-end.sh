#!/bin/sh
# wasitme plugin hook: SessionEnd. Kicks the scan LaunchAgent exactly like session-start.sh (same guards, same
# silence); the session's last exchanges are then in the next glance. When WP-12 adds the in-process project
# snapshot to session-start.sh, SessionEnd still only kicks the scan.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
here=${0%/*}
case $here in
  /*) ;;
  *) exit 0 ;; # only ever run by absolute path ("${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh")
esac
[ -f "$here/session-start.sh" ] || exit 0
exec /bin/sh "$here/session-start.sh" --session-end
