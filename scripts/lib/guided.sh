# shellcheck shell=sh
# wasitme installer: guided setup on /dev/tty (works under `curl | sh`, where stdin is the script itself).
# WASITME_TTY points the prompts at a file of answers for tests. Sourced after common.sh.
#
# ASK_RESULT is set here and read by the files that call ask_yn (install_main.sh, plugins.sh, uninstall.sh). The linter
# looks at one file at a time and would call it unused (SC2034); this directive, before the first command, covers the file.
# shellcheck disable=SC2034

tty_open() {
  TTY_DEV=${WASITME_TTY:-/dev/tty}
  if ( : <"$TTY_DEV" ) 2>/dev/null; then
    exec 3<"$TTY_DEV"
    return 0
  fi
  return 1
}

read_answer() {  # sets ANSWER; running out of input aborts before anything is changed
  if IFS= read -r ANSWER <&3; then return 0; fi
  if [ "${ASK_SOFT:-0}" = 1 ]; then ANSWER=""; printf '\n'; return 0; fi   # a question asked after the changes: its default
  printf '\n' >&2
  die "input ended before every question was answered; nothing was changed"
}

ask_yn() {  # ask_yn QUESTION DEFAULT(yes|no) -> ASK_RESULT=yes|no
  ay_tries=0
  while :; do
    if [ "$2" = yes ]; then ay_hint="[Y/n]"; else ay_hint="[y/N]"; fi
    printf '%s %s ' "$1" "$ay_hint"
    read_answer
    case $ANSWER in
      '') ASK_RESULT=$2; return 0 ;;
      [Yy]|[Yy][Ee][Ss]) ASK_RESULT=yes; return 0 ;;
      [Nn]|[Nn][Oo]) ASK_RESULT=no; return 0 ;;
    esac
    ay_tries=$((ay_tries + 1))
    if [ "$ay_tries" -ge 3 ]; then die "no usable answer; nothing was changed"; fi
    say "Please answer y or n."
  done
}

found_note() { if [ "$1" = 1 ]; then printf 'found'; else printf 'not found on this Mac'; fi; }

# Sets WANT_AGENTS (space-separated: claude-code codex).
ask_agents() {
  say ""
  say "Which agents should wasitme track?"
  say "  1) Claude Code  ($(found_note "$CLAUDE_FOUND"))"
  say "  2) Codex        ($(found_note "$CODEX_FOUND"))"
  aa_tries=0
  while :; do
    printf 'Numbers to track, e.g. 1,2   (a = both, Enter = %s): ' "$(printf '%s' "$WANT_AGENTS" | sed 's/ /, /')"
    read_answer
    aa_new=""
    aa_ok=1
    case $ANSWER in
      '') aa_new=$WANT_AGENTS ;;
      [Aa]|[Aa][Ll][Ll]) aa_new="claude-code codex" ;;
      *)
        for aa_tok in $(printf '%s' "$ANSWER" | tr ',' ' '); do
          case $aa_tok in
            1) case " $aa_new " in *" claude-code "*) ;; *) aa_new="$aa_new claude-code" ;; esac ;;
            2) case " $aa_new " in *" codex "*) ;; *) aa_new="$aa_new codex" ;; esac ;;
            *) aa_ok=0 ;;
          esac
        done ;;
    esac
    aa_new=${aa_new# }
    if [ "$aa_ok" = 1 ] && [ -n "$aa_new" ]; then
      # Keep a stable order regardless of how the numbers were typed.
      WANT_AGENTS=""
      case " $aa_new " in *" claude-code "*) WANT_AGENTS="claude-code" ;; esac
      case " $aa_new " in *" codex "*) WANT_AGENTS="${WANT_AGENTS:+$WANT_AGENTS }codex" ;; esac
      return 0
    fi
    aa_tries=$((aa_tries + 1))
    if [ "$aa_tries" -ge 3 ]; then die "no usable answer; nothing was changed"; fi
    say "Please type 1, 2, 1,2 or a."
  done
}

guided_intro() {
  say ""
  say "wasitme setup"
  say "Everything stays on this Mac: wasitme reads your agents' session logs and config locally, sends nothing"
  say "anywhere, and never runs anything it finds there. Every step below can be undone with the uninstaller:"
  say "  sh $CURRENT_LINK/scripts/uninstall.sh"
}
