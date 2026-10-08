#!/bin/sh
# wasitme installer: installs the engine (CLI), and optionally the Mac menu bar app, scheduled scan, the
# Claude Code and Codex plugins and a Claude Code status line. Local-only: it never sends anything anywhere.
#
#   curl -fsSL <release-url>/install.sh | sh            (once the project is published; see D15)
#   sh scripts/install.sh --from <checkout-or-extracted-tarball>      (local development)
#   sh scripts/install.sh --tarball wasitme.tar.gz
#
# The whole script is wrapped in main() and main is called on the LAST line, so a truncated download
# runs nothing. Release-like dogfooding: a `git archive` of a tag (or a release tarball). Quick local test of a
# checkout: `npm run build && sh scripts/install.sh --from .` -- everything is COPIED into ~/.wasitme/versions/<v>,
# so later edits to the checkout do not change what is installed (re-run the installer to pick them up).
set -eu
LC_ALL=C
export LC_ALL
umask 022

# The account in this URL is filled in when the public tree is built (scripts/dev/export-public.sh --owner); while it
# is still the placeholder, the installer refuses to download (D15).
# scripts/release.sh writes the install.sh release asset from this file with both lines below stamped: the URL pinned
# to that release's own tarball (releases/download/v<version>/wasitme-<version>.tgz) and the tarball's SHA-256, which
# a download through the default URL must then match (SECURITY.md, install step 1). The copy in the repository and inside the
# tarball keeps the "latest" URL (the tarball's stable asset name, wasitme.tar.gz) and no checksum.
WASITME_DEFAULT_URL="https://github.com/draarivpatel-ui/wasitme/releases/latest/download/wasitme.tar.gz"
WASITME_DEFAULT_SHA256=""

usage() {
  cat <<'EOF'
wasitme installer

Usage: sh install.sh [options]

Source (one of; the default downloads a release tarball from GitHub, so it needs a published release):
  --from DIR          install from a local checkout (run `npm run build` in it first) or an extracted tarball
  --tarball FILE      install from a local .tar.gz
  --url URL           download this https tarball
  --sha256 HEX        require the downloaded/given tarball to have this SHA-256

Choices (asked one by one on the terminal when there is one; flags skip the question):
  --guided            always ask (needs a terminal)
  --yes, -y           ask nothing, accept the defaults below
  --agents LIST       claude-code,codex (default: whichever is found)
  --app / --no-app                        Mac menu bar app, built locally (default: yes if a Swift toolchain exists)
  --scan-agent / --no-scan-agent          a sandboxed background `wasitme scan` every 15 minutes (macOS, default yes)
  --claude-plugin / --no-claude-plugin    Claude Code plugin (default yes if `claude` is installed)
  --codex-plugin / --no-codex-plugin      Codex report skill, no hooks (default yes if `codex` is installed)
  --statusline / --no-statusline          Claude Code status line, only if you have none (and Claude Code is there); settings.json is
                                          backed up first. Your own status line is never touched; wasitme's own is kept pointing at
                                          the current node on re-runs

Updating: run the installer again with a newer source. The new version goes into ~/.wasitme/versions/<v> and one
symlink flip (~/.wasitme/current) moves the engine and both plugins together; the previous version is kept for a
rollback, older ones are removed.
  --update                  install the newer source with exactly the parts you have now (read from the install record),
                            asking nothing: the app is rebuilt if it is installed, and a running app is quit and started
                            again in the background. Needs a source: --from DIR, --tarball FILE, or the release URL.
                            To update from a checkout, run that checkout's installer: sh DIR/scripts/install.sh --from DIR --update
  --no-relaunch             (with --update) quit a running app for the update and leave it closed; it starts at your
                            next login, or open it yourself
  --accept-plugin-changes   go ahead even if the new Claude Code plugin hooks or calls more than the installed one
                            (otherwise the update stops and shows the difference, or asks when guided)
  --repair                  re-apply the installed version with the node found now: command, engine.json, the scan
                            agent, the plugins' registration (what `wasitme doctor --repair` runs; asks nothing)
  --add PART                add one part to the installed version, asking nothing: scan-agent (or scan), claude-plugin,
                            codex-plugin, statusline (from the installed copy), or app (needs --from or --tarball of the
                            same version: the app is built from sources the installed copy does not keep; that source's
                            engine replaces the installed one if they differ). A part that is already installed is left
                            as it is (--repair re-applies it), and one that cannot be installed here stops the run (exit
                            1) with the reason. Remove a part with: sh ~/.wasitme/current/scripts/uninstall.sh --only PART

Other:
  --status [--json]   print, as JSON, which parts are installed and which could be added here (the Mac app's Settings);
                      reads only, changes nothing, exit 0. Run from an installed copy
  --from-app          (with --update or --add; what the Mac app runs) start the run detached and return at once; its
                      output goes to ~/.wasitme/state/last-action.log and its result to last-action.json
  --dry-run, -n       print every command and file write instead of doing it; changes nothing
  --prefix DIR       put the `wasitme` command in DIR/bin instead of ~/.local/bin (wasitme itself lives in ~/.wasitme)
  --home DIR          treat DIR as the home directory (tests, sandboxes); never touches launchd unless
                      WASITME_LAUNCHCTL points at a replacement
  --app-executable N  executable product name inside macos/ (default WasitmeApp)
  --allow-root        permit running as root (e.g. in a container)
  --help, -h

Needs Node.js 22 or newer. Never uses sudo, never changes xcode-select, and edits a shell profile only after you
answer yes to adding the PATH line (it is backed up first).
Exit codes: 0 done, 1 failed (rolled back), 2 usage, 3 installed but a part failed (that part was rolled back),
4 stopped before changing anything: the new Claude Code plugin asks for more (see --accept-plugin-changes).
Undo everything: sh ~/.wasitme/current/scripts/uninstall.sh
EOF
}

boot_die() { printf 'error: %s\n' "$*" >&2; exit 1; }
boot_usage_die() { printf 'error: %s\n(run with --help for usage)\n' "$*" >&2; exit 2; }

BOOT_TMP=""
boot_cleanup() {
  boot_rc=$?
  trap - EXIT INT TERM HUP
  if [ -n "$BOOT_TMP" ]; then rm -rf "$BOOT_TMP"; fi
  exit "$boot_rc"
}

# Looks at the source-related options only; every option is passed on unchanged otherwise.
pre_scan() {
  ps_next=""
  for ps_a in "$@"; do
    if [ -n "$ps_next" ]; then
      case $ps_next in
        from) P_FROM=$ps_a ;;
        home) P_HOME=$ps_a ;;
        tarball) P_TARBALL=$ps_a ;;
        url) P_URL=$ps_a ;;
        sha256) P_SHA=$ps_a ;;
        skip) ;;
      esac
      ps_next=""
      continue
    fi
    case $ps_a in
      --from) ps_next=from ;;
      --tarball) ps_next=tarball ;;
      --url) ps_next=url ;;
      --sha256) ps_next=sha256 ;;
      --prefix|--agents|--app-executable) ps_next=skip ;;
      --home) ps_next=home ;;
      --from-app) P_FROM_APP=1 ;;
      --add) P_ADD=1; ps_next=skip ;;
      --dry-run|-n) P_DRY=1 ;;
      --repair) P_REPAIR=1 ;;
      --status) P_STATUS=1 ;;
      --json) P_JSON=1 ;;
      --update) P_UPDATE=1 ;;
      --no-relaunch) P_NO_RELAUNCH=1 ;;
      --help|-h) P_HELP=1 ;;
    esac
  done
  if [ -n "$ps_next" ] && [ "$ps_next" != skip ] && [ "$ps_next" != home ]; then boot_usage_die "--$ps_next needs a value"; fi
  return 0
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    boot_die "need shasum or sha256sum to verify --sha256"
  fi
}

download() {  # download URL OUT
  if [ -n "${WASITME_CURL:-}" ] || command -v curl >/dev/null 2>&1; then
    "${WASITME_CURL:-curl}" -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "$2" "$1"
  else
    boot_die "need curl or wget to download wasitme (or pass --from / --tarball)"
  fi
}

# Gets a source tree into BOOT_TMP/src and sets SRC. Never runs anything from the tarball, never runs npm.
obtain_remote() {
  tmp_base=${TMPDIR:-/tmp}
  BOOT_TMP=$(mktemp -d "${tmp_base%/}/wasitme-src.XXXXXX") || boot_die "could not create a temp directory"
  tgz=$P_TARBALL
  if [ -z "$tgz" ]; then
    # The URL comes from --url or from the stamped default, never from the environment: a released installer must not be
    # steerable to another tarball by a variable set somewhere in the shell that pipes it to sh.
    url=${P_URL:-$WASITME_DEFAULT_URL}
    case $url in
      https://*) ;;
      *) boot_die "the download URL must start with https:// (got '$url')" ;;
    esac
    case $url in
      *OWNER*) boot_die "this installer has no published release URL yet (the project is not public). Use --from DIR or --tarball FILE." ;;
    esac
    # A released install.sh knows the SHA-256 of the tarball it was published with (scripts/release.sh stamps it).
    if [ -z "$P_SHA" ] && [ "$url" = "$WASITME_DEFAULT_URL" ] && [ -n "$WASITME_DEFAULT_SHA256" ]; then P_SHA=$WASITME_DEFAULT_SHA256; fi
    # --url with no --sha256 on a released installer: allowed (it is how a pinned older release is fetched), but never silently.
    if [ -z "$P_SHA" ] && [ -n "$WASITME_DEFAULT_SHA256" ]; then
      printf 'Note: no checksum for %s (this installer knows only the SHA-256 of its own release tarball). To check it, pass --sha256 HEX from that release'"'"'s SHA256SUMS.\n' "$url"
    fi
    tgz="$BOOT_TMP/wasitme.tar.gz"
    if [ "$P_DRY" = 1 ]; then
      printf '[dry-run] download %s\n' "$url"
      printf '[dry-run] extract it, then continue with the installer inside it (re-run with --from DIR for the full plan)\n'
      printf '\nDry run: nothing was changed.\n'
      exit 0
    fi
    printf 'Downloading %s\n' "$url"
    if ! download "$url" "$tgz"; then
      # An unstamped installer (the copy in a checkout or source tree) points at the latest release, which may not exist yet.
      if [ "$url" = "$WASITME_DEFAULT_URL" ] && [ -z "$WASITME_DEFAULT_SHA256" ]; then
        boot_die "download failed: $url (if no release is published yet, install from a checkout with --from DIR, or from a local tarball with --tarball FILE)"
      fi
      boot_die "download failed: $url"
    fi
  else
    [ -f "$tgz" ] || boot_die "--tarball: no such file: $tgz"
  fi
  if [ -n "$P_SHA" ]; then
    got=$(sha256_file "$tgz")
    [ "$got" = "$P_SHA" ] || boot_die "SHA-256 mismatch: expected $P_SHA, got $got"
    printf 'SHA-256 matches: the tarball is intact.\n'
  fi
  # Refuse absolute paths and '..' before extracting anything.
  if ! tar -tzf "$tgz" >"$BOOT_TMP/listing" 2>/dev/null; then boot_die "$tgz is not a readable .tar.gz"; fi
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$BOOT_TMP/listing"; then boot_die "$tgz contains unsafe paths (absolute or '..'); refusing to extract it"; fi
  mkdir "$BOOT_TMP/src"
  tar -xzf "$tgz" -C "$BOOT_TMP/src" || boot_die "could not extract $tgz"
  SRC="$BOOT_TMP/src"
  if [ ! -f "$SRC/scripts/install.sh" ]; then   # GitHub-style archives nest everything in one top folder
    set -- "$SRC"/*
    if [ $# -eq 1 ] && [ -d "$1" ] && [ -f "$1/scripts/install.sh" ]; then SRC=$1; fi
  fi
  [ -f "$SRC/scripts/install.sh" ] || boot_die "the tarball has no scripts/install.sh; is it a wasitme release?"
}

main() {
  P_FROM=""; P_TARBALL=""; P_URL=""; P_SHA=""; P_DRY=0; P_HELP=0; P_REPAIR=0; P_UPDATE=0; P_NO_RELAUNCH=0; P_ADD=0; P_FROM_APP=0; P_STATUS=0; P_JSON=0; P_HOME=
  pre_scan "$@"
  if [ "$P_HELP" = 1 ]; then usage; exit 0; fi
  if [ -n "$P_FROM" ] && [ -n "$P_TARBALL$P_URL" ]; then boot_usage_die "--from cannot be combined with --tarball or --url"; fi
  if [ -n "$P_TARBALL" ] && [ -n "$P_URL" ]; then boot_usage_die "--tarball and --url cannot be combined"; fi
  if [ -n "$P_SHA" ] && [ -z "$P_TARBALL$P_URL" ]; then boot_usage_die "--sha256 only applies to --tarball or --url"; fi
  if [ "$P_REPAIR" = 1 ] && [ -n "$P_FROM$P_TARBALL$P_URL" ]; then boot_usage_die "--repair re-applies the installed version; it takes no --from, --tarball or --url"; fi
  if [ "$P_JSON" = 1 ] && [ "$P_STATUS" = 0 ]; then boot_usage_die "--json belongs to --status"; fi
  if [ "$P_STATUS" = 1 ] && [ -n "$P_FROM$P_TARBALL$P_URL" ]; then boot_usage_die "--status reads the installed copy; it takes no --from, --tarball or --url"; fi
  if [ "$P_UPDATE" = 1 ] && [ "$P_REPAIR" = 1 ]; then boot_usage_die "--update installs a newer version and --repair re-applies the installed one; use one of them"; fi
  if [ "$P_UPDATE" = 1 ] && [ "$P_ADD" = 1 ]; then boot_usage_die "--update keeps the parts you have; add a part afterwards with --add PART"; fi
  if [ "$P_NO_RELAUNCH" = 1 ] && [ "$P_UPDATE" = 0 ]; then boot_usage_die "--no-relaunch belongs to --update (a running app is quit for the update and left closed)"; fi

  here=""
  if [ -f "$0" ]; then here=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || here=""; fi

  # --from-app (the Mac app's Update and Add buttons): the same command, run detached from the app by lib/from-app.mjs;
  # this call returns at once and the result lands in ~/.wasitme/state/last-action.json. The detached run comes back
  # here with WASITME_FROM_APP_STAGE=inner and carries on as a normal non-interactive run.
  if [ "$P_FROM_APP" = 1 ] && [ "${WASITME_FROM_APP_STAGE:-}" != inner ]; then
    [ "$P_UPDATE" = 1 ] || [ "$P_ADD" = 1 ] || boot_usage_die "--from-app is for --update and --add"
    [ "$P_DRY" = 0 ] || boot_usage_die "--from-app cannot be a dry run"
    [ -n "$here" ] && [ -f "$here/lib/common.sh" ] || boot_die "--from-app runs from an installed copy: sh ~/.wasitme/current/scripts/install.sh --update --from-app"
    case $P_HOME in ''|/*) ;; *) boot_usage_die "--home must be an absolute path" ;; esac
    fa_user=${P_HOME:-${HOME:-}}
    fa_user=${fa_user%/}
    [ -n "$fa_user" ] || boot_die "HOME is not set"
    LIB_DIR="$here/lib"
    # shellcheck source=lib/common.sh
    . "$LIB_DIR/common.sh"
    if [ "$P_UPDATE" = 1 ]; then fa_action=update; else fa_action=add; fi
    from_app_launch "$fa_action" "$fa_user/.wasitme" "$fa_user" "$here/$(basename "$0")" "$@"
  fi

  # Local development (this script sits next to its lib/ and was given a source directory), or --repair / --add without a
  # source, which run from the installed copy in ~/.wasitme/current/scripts against that same version (no download).
  if { [ -n "$P_FROM" ] || [ "$P_REPAIR" = 1 ] || [ "$P_STATUS" = 1 ] || { [ "$P_ADD" = 1 ] && [ -z "$P_TARBALL$P_URL" ]; }; } && [ -n "$here" ] && [ -f "$here/lib/common.sh" ]; then
    LIB_DIR="$here/lib"
    # shellcheck source=lib/common.sh
    . "$LIB_DIR/common.sh"
    # shellcheck source=lib/engine.sh
    . "$LIB_DIR/engine.sh"
    # shellcheck source=lib/app_bundle.sh
    . "$LIB_DIR/app_bundle.sh"
    # shellcheck source=lib/macos.sh
    . "$LIB_DIR/macos.sh"
    # shellcheck source=lib/plugins.sh
    . "$LIB_DIR/plugins.sh"
    # shellcheck source=lib/guided.sh
    . "$LIB_DIR/guided.sh"
    # shellcheck source=lib/install_main.sh
    . "$LIB_DIR/install_main.sh"
    install_main "$@"
    exit 0
  fi

  # Otherwise (piped from curl, or no --from): get a source tree, then hand over to ITS installer so the
  # installer logic always matches the payload it installs.
  if [ "${WASITME_DELEGATED:-0}" = 1 ]; then boot_die "the source tree's installer is missing its lib/ folder; cannot continue"; fi
  if [ "$P_REPAIR" = 1 ]; then boot_die "--repair must be run from an installed copy: sh ~/.wasitme/current/scripts/install.sh --repair"; fi
  if [ "$P_STATUS" = 1 ]; then boot_die "--status must be run from an installed copy: sh ~/.wasitme/current/scripts/install.sh --status"; fi
  if [ "$P_ADD" = 1 ] && [ -z "$P_FROM$P_TARBALL$P_URL" ]; then boot_die "--add must be run from an installed copy (sh ~/.wasitme/current/scripts/install.sh --add PART) or with --from / --tarball"; fi
  trap boot_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  if [ -n "$P_FROM" ]; then
    SRC=$(cd "$P_FROM" 2>/dev/null && pwd) || boot_die "--from: no such directory: $P_FROM"
    [ -f "$SRC/scripts/install.sh" ] || boot_die "$SRC has no scripts/install.sh"
  else
    obtain_remote
  fi

  # Rebuild the arguments: drop the source options, point --from at the tree we have.
  n=$#
  i=0
  while [ "$i" -lt "$n" ]; do
    a=$1
    shift
    i=$((i + 1))
    case $a in
      --from|--tarball|--url|--sha256) shift; i=$((i + 1)) ;;
      *) set -- "$@" "$a" ;;
    esac
  done
  set -- --from "$SRC" "$@"
  if WASITME_DELEGATED=1 "${WASITME_SH:-sh}" "$SRC/scripts/install.sh" "$@"; then rc=0; else rc=$?; fi
  exit "$rc"
}

main "$@"
