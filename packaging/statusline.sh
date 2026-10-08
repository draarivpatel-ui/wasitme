#!/bin/sh
# wasitme status line for Claude Code (`statusLine.command`). D59, WP-62.
#
# Prints one segment, "wasitme: <state>[ +n]", from ~/.wasitme/glance.json (the first agent's `statusLine`), or
# "wasitme: out of date" once the file is older than its own `staleAfterSec` (docs/CONTRACT.md display rules: the
# default is 7,200 s; a file dated more than 5 minutes ahead is out of date too). It never names a cause or a quality
# word (the glance rule). Nothing is printed when there is nothing trustworthy to say (no file, another schema, a file
# that does not promise `privacy.containsText: false`).
#
# Wrapping: if ~/.wasitme/backups/statusline.cmd exists (written by `wasitme statusline install --wrap` when the user
# already had a status line), that command runs first with this script's stdin passed through, its output is printed
# unchanged, and " · <segment>" is appended to its LAST line (or the segment alone when it printed nothing). There is
# no extra timeout: Claude Code cancels a running status script on the next update.
#
# Safety:
#   - Claude Code's JSON arrives on stdin. This script never reads it; it only forwards it to the wrapped command. So
#     nothing in it (model ids, paths, escapes, megabytes) can reach this script's own output.
#   - The segment is checked by a `case` allow-list (lower-case letters, digits, space, apostrophe, plus, colon, hyphen)
#     before it is printed. A glance whose line fails the check is not echoed: the segment is rebuilt from the file's
#     `state` instead (an unknown state is "can't tell which", the contract's rule).
#   - Files are read only if they are regular files, not symlinks, owned by this user.
#
# Speed: pure sh built-ins (parameter expansion, `read`, `case`, arithmetic); the one external command is `date +%s`.
# No node on this path (measured in engine/test/output/statusline.test.ts and reported in the WP-62 notes).
#
# POSIX sh. Prints nothing on any error and always exits 0 (a failing status line must not disturb the prompt).
# WASITME_STATUSLINE_NOW=<epoch seconds> replaces the clock (tests only; it spares the `date` call too).

orig_path=$PATH
PATH=/usr/bin:/bin
nl='
'
seg=
home_dir=${WASITME_HOME:-}
case $home_dir in
  /*) ;;
  *) home_dir=${HOME:-}/.wasitme ;;
esac
case $home_dir in
  /*) ;;
  *) home_dir= ;;
esac

# ---- the segment ---------------------------------------------------------------------------------------------------
# owned_by_me FILE: FILE is owned by the user running this script (a file of anyone else is never trusted).
# `test -O` is not in POSIX (ShellCheck SC3067), but macOS /bin/sh, dash, bash, ksh and zsh all have it; a shell
# without it makes the test fail, which means "not trusted": nothing is read and nothing is printed. It is a built-in.
# The POSIX way (`ls -ldn` and `id -u`) is two or three extra processes on every status line refresh, which this script
# is built to avoid (see Speed above), so the one SC3067 finding is silenced here, on this one line, on purpose.
# shellcheck disable=SC3067
owned_by_me() { [ -O "$1" ]; }

glance=$home_dir/glance.json
if [ -n "$home_dir" ] && [ -f "$glance" ] && [ ! -L "$glance" ] && owned_by_me "$glance"; then
  line=
  IFS= read -r line < "$glance" || [ -n "$line" ] || line=
  # The engine's compact form only: it starts with the schema and ends with the privacy promise. (Both checks are
  # anchored, so they cost nothing; the `${x#*pat}` forms below are quadratic in the length of x in some shells, so they
  # only ever see `head`, the part of the line up to the first agent's `n`, about a kilobyte, never the whole file.)
  case $line in
    '{"schema":"wasitme.glance/1",'*'"privacy":{"containsText":false}}') ;;
    *) line= ;;
  esac
  head=
  if [ -n "$line" ] && [ "${#line}" -le 20000 ]; then
    head=${line%%'"n":{'*}
    [ "${#head}" -le 4000 ] || head=
  fi
  if [ -n "$head" ]; then
    # --- staleness: generatedAt (UTC, "YYYY-MM-DDTHH:MM:SSZ") against staleAfterSec (default 7200)
    stale=1
    t=${head#*'"generatedAt":"'}
    t=${t%%'"'*}
    case $t in
      20[2-9][0-9]-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]Z)
        yy=${t%%-*}
        r=${t#*-}
        mm=${r%%-*}
        r=${r#*-}
        dd=${r%%T*}
        r=${r#*T}
        hh=${r%%:*}
        r=${r#*:}
        mi=${r%%:*}
        ss=${r#*:}
        ss=${ss%Z}
        mm=${mm#0}
        dd=${dd#0}
        hh=${hh#0}
        mi=${mi#0}
        ss=${ss#0}
        case $mm in [1-9] | 1[0-2]) ok=1 ;; *) ok= ;; esac
        case $dd in [1-9] | [12][0-9] | 3[01]) ;; *) ok= ;; esac
        case $hh in '' | [0-9] | 1[0-9] | 2[0-3]) ;; *) ok= ;; esac
        case $mi in '' | [0-9] | [1-5][0-9]) ;; *) ok= ;; esac
        case $ss in '' | [0-9] | [1-5][0-9]) ;; *) ok= ;; esac
        if [ -n "$ok" ]; then
          : "${hh:=0}" "${mi:=0}" "${ss:=0}"
          limit=${head#*'"staleAfterSec":'}
          limit=${limit%%[!0-9]*}
          case $limit in '' | *[!0-9]* | ??????????*) limit=7200 ;; esac
          [ "$limit" -gt 0 ] || limit=7200
          # days since 1970-01-01 (civil-from-days inverse; years 2020..2099 only, so no leap-century cases)
          y=$yy
          if [ "$mm" -le 2 ]; then y=$((y - 1)); m=$((mm + 9)); else m=$((mm - 3)); fi
          era=$((y / 400))
          yoe=$((y - era * 400))
          doy=$(((153 * m + 2) / 5 + dd - 1))
          doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
          days=$((era * 146097 + doe - 719468))
          gen=$((days * 86400 + hh * 3600 + mi * 60 + ss))
          now=${WASITME_STATUSLINE_NOW:-}
          [ -n "$now" ] || now=$(date +%s 2>/dev/null)
          case $now in
            '' | *[!0-9]*) ;;
            *)
              age=$((now - gen))
              if [ "$age" -le "$limit" ] && [ "$age" -ge -300 ]; then stale=; fi
              ;;
          esac
        fi
        ;;
    esac

    if [ -n "$stale" ]; then
      seg='wasitme: out of date'
    else
      # --- the engine's own line, if it has the glance shape
      sl=${head#*'"statusLine":"'}
      sl=${sl%%'"'*}
      case $sl in
        'wasitme: '?*) shape=1 ;;
        *) shape= ;;
      esac
      case $sl in
        *[!abcdefghijklmnopqrstuvwxyz0123456789\ \'+:-]*) shape= ;;
      esac
      [ "${#sl}" -le 80 ] || shape=
      if [ -n "$shape" ]; then
        seg=$sl
      else
        # --- rebuilt from the state: unknown states are "can't tell which"
        st=${head#*'"state":"'}
        st=${st%%'"'*}
        rs=${head#*'"reason":'}
        case $st in
          insufficient)
            case $rs in
              '"calibration_pending"'*) seg='wasitme: timeline only' ;;
              *) seg='wasitme: too early to tell' ;;
            esac
            ;;
          none) seg='wasitme: no detectable change' ;;
          you) seg='wasitme: your side' ;;
          agent) seg='wasitme: agent side' ;;
          *) seg="wasitme: can't tell which" ;;
        esac
      fi
    fi
  fi
fi

# ---- the user's own status line, if wasitme wraps one ---------------------------------------------------------------
cmd=
cmdfile=$home_dir/backups/statusline.cmd
if [ -n "$home_dir" ] && [ -f "$cmdfile" ] && [ ! -L "$cmdfile" ] && owned_by_me "$cmdfile"; then
  while IFS= read -r l || [ -n "$l" ]; do
    cmd=$cmd$l$nl
    [ "${#cmd}" -le 8192 ] || { cmd=; break; }
  done < "$cmdfile"
fi

if [ -n "$cmd" ]; then
  out=$(PATH=$orig_path /bin/sh -c "$cmd")
  if [ -n "$out" ] && [ -n "$seg" ]; then
    last=${out##*"$nl"}
    head=${out%"$last"}
    printf '%s%s \302\267 %s\n' "$head" "$last" "$seg"
  elif [ -n "$out" ]; then
    printf '%s\n' "$out"
  elif [ -n "$seg" ]; then
    printf '%s\n' "$seg"
  fi
elif [ -n "$seg" ]; then
  printf '%s\n' "$seg"
fi
exit 0
