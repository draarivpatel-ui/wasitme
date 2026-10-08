#!/bin/sh
# release.sh - build wasitme's release assets from a commit (WP-95). It never pushes, tags,
# uploads or publishes anything: it writes files into --out and checks them. Publishing is the maintainer's call (D15).
#
#   sh scripts/release.sh [--ref REV | --worktree] [--out DIR] [--strict] [--no-verify] [--keep]
#   sh scripts/release.sh --check-stage DIR [--strict]     the manifest and content checks alone, on an unpacked tree
#
#   --ref REV       build from this commit (default HEAD). The source is `git archive`, so only committed files count.
#   --worktree      build from the working tree as it is now (tracked and untracked files, never ignored ones), through
#                   a temporary git index: for testing a change before it is committed. The real index is not touched.
#   --out DIR       where the assets go (default: release/ in the repository, which git ignores)
#   --strict        the publishing gate (release.yml uses it): OWNER placeholders left in public files, a changelog that
#                   has not been folded for this version, or no forbidden-email configuration are failures, not notes
#   --no-verify     skip installing the built tarball into a temp HOME (it is never skipped under --strict)
#   --keep          keep the work directory and print where it is
#
# Assets (in --out):
#   wasitme-<v>.tgz   the release tarball: exactly the allow-list below, with a prebuilt engine (engine/dist/src)
#                     and Control Center page (ui/dist), so installing it runs no npm and downloads nothing
#   wasitme.tar.gz    the same bytes under the stable name install.sh's default URL (releases/latest/download/) expects
#   install.sh        scripts/install.sh with its default URL pinned to releases/download/v<v>/wasitme-<v>.tgz and that
#                     tarball's SHA-256 stamped in, so `curl ... | sh` checks what it downloaded (SECURITY.md, install step 1)
#   SHA256SUMS        sha256sum format, for the three files above
#
# Checks, each of which stops the release:
#   - the tarball holds exactly the allow-list: every file matches a pattern below, every required file is there, there
#     are no symbolic links, and no tests/, reference/, node_modules/, out/ or development-only engine folders;
#   - scripts/check-repo.mjs --strict on the staged tree: no absolute home path, no configured forbidden address
#     (WASITME_FORBIDDEN_EMAILS, or the repository's .ci-local.env), no remote asset URL in shipped HTML/CSS;
#   - the plugin manifests carry the engine's version (scripts/plugin-manifests.mjs --check);
#   - unless --no-verify: the asset install.sh installs the tarball into a throwaway HOME (--dry-run first, then for
#     real with npm made unavailable, so a missing prebuilt engine fails), the installed command runs `doctor`, the
#     status line it installs is the one `wasitme statusline show` calls wasitme's, and the uninstaller then leaves the
#     throwaway HOME empty. Nothing outside the work directory is touched; no claude/codex/launchctl is run.
#
# POSIX sh. Exit codes: 0 assets written and checked, 1 a check failed, 2 usage.
set -eu
umask 022
LC_ALL=C
export LC_ALL

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
WASITME_RELEASE_NAME="wasitme"
STABLE_ASSET="wasitme.tar.gz"   # must equal the file name at the end of install.sh's WASITME_DEFAULT_URL

say() { printf '%s\n' "$*"; }
note() { printf 'note: %s\n' "$*"; }
die() { printf 'release: error: %s\n' "$*" >&2; exit 1; }
usage_die() { printf 'release: %s (see --help)\n' "$*" >&2; exit 2; }
usage() { sed -n '2,/^# POSIX sh/p' "$0" | sed 's/^# \{0,1\}//'; }

# ---- The allow-list (the release tarball, plus what the installer's app assembly needs from design/system) ----------
# allowed REL: is this path (relative to wasitme-<v>/) allowed in the tarball?
allowed() {
  case $1 in
    */tests/*|tests/*|*/reference/*|*/node_modules/*|*/out/*|out/*|*/.DS_Store|.DS_Store) return 1 ;;
    engine/dist/src/synth/*|engine/dist/src/analysis/calibration/*) return 1 ;;
  esac
  case $1 in
    VERSION|LICENSE|README.md|THIRD_PARTY_NOTICES.md) return 0 ;;
    .claude-plugin/marketplace.json) return 0 ;;
    plugin/*|plugin-codex/*) return 0 ;;
    engine/package.json|engine/dist/src/*.js|engine/dist/src/*.json) return 0 ;;
    ui/dist/app.html|ui/dist/app.js|ui/dist/app.css|ui/dist/fonts/*.woff2|ui/dist/fonts/OFL.txt|ui/dist/fonts/MODIFICATIONS.txt) return 0 ;;
    macos/Package.swift|macos/Sources/*|macos/support/*) return 0 ;;
    contract/*.schema.json) return 0 ;;
    packaging/statusline.sh) return 0 ;;
    scripts/install.sh|scripts/uninstall.sh|scripts/lib/*) return 0 ;;
    design/system/fonts/app/*.ttf|design/system/fonts/OFL.txt|design/system/glyphs/appicon-1024.svg) return 0 ;;
  esac
  return 1
}
REQUIRED="VERSION LICENSE README.md THIRD_PARTY_NOTICES.md .claude-plugin/marketplace.json
plugin/.claude-plugin/plugin.json plugin/hooks/hooks.json plugin/scripts/run.sh plugin/scripts/session-start.sh
plugin/scripts/session-end.sh plugin/skills/report/SKILL.md plugin-codex/.codex-plugin/plugin.json plugin-codex/plugin.json
plugin-codex/.agents/plugins/marketplace.json plugin-codex/skills/report/SKILL.md engine/package.json
engine/dist/src/cli/main.js ui/dist/app.html ui/dist/app.js ui/dist/app.css ui/dist/fonts/OFL.txt macos/Package.swift
packaging/statusline.sh scripts/install.sh scripts/uninstall.sh scripts/lib/common.sh scripts/lib/jsonutil.mjs
design/system/fonts/OFL.txt contract/glance.v1.schema.json contract/snapshot.v1.schema.json"

# check_stage DIR: the manifest checks and the content scan on an unpacked release tree. Prints every problem.
check_stage() {
  cs_dir=$1
  [ -d "$cs_dir" ] || die "--check-stage: no such directory: $cs_dir"
  cs_bad=0
  cs_links=$(cd "$cs_dir" && find . -type l | sed 's|^\./||')
  if [ -n "$cs_links" ]; then
    printf '%s\n' "$cs_links" | sed 's/^/  symbolic link (not allowed): /' >&2
    cs_bad=1
  fi
  cs_list=$(cd "$cs_dir" && find . -type f | sed 's|^\./||' | sort)
  cs_unexpected=$(printf '%s\n' "$cs_list" | while IFS= read -r f; do [ -n "$f" ] || continue; allowed "$f" || printf '%s\n' "$f"; done)
  if [ -n "$cs_unexpected" ]; then
    printf '%s\n' "$cs_unexpected" | sed 's/^/  not on the allow-list: /' >&2
    cs_bad=1
  fi
  for f in $REQUIRED; do
    [ -f "$cs_dir/$f" ] || { printf '  required but missing: %s\n' "$f" >&2; cs_bad=1; }
  done
  cs_n=$(printf '%s\n' "$cs_list" | grep -c . || true)
  # Content: home paths, forbidden addresses, remote assets (scripts/check-repo.mjs, strict: no allow-list).
  set -- --root "$cs_dir" --strict --walk-all --rules abs-home-path,forbidden-email,remote-asset-url
  if [ "$STRICT" = 1 ]; then set -- "$@" --require-email-config; fi
  if ! emails_env node "$ROOT/scripts/check-repo.mjs" "$@" 2>"$WORK/check-repo.err"; then
    grep -v 'NOT SCANNED' "$WORK/check-repo.err" >&2 || true
    cs_bad=1
  fi
  if grep -q 'SKIPPED forbidden-email' "$WORK/check-repo.err"; then note "the forbidden-email rule was SKIPPED (no WASITME_FORBIDDEN_EMAILS and no .ci-local.env); --strict requires it"; fi
  [ "$cs_bad" = 0 ] || die "the staged release tree failed its checks (listed above)"
  say "  manifest: $cs_n files, all on the allow-list, every required file present, no links; content scan clean"
}

# The forbidden-address list for check-repo, without ever printing it: the environment's, else the repository's (or,
# in a git worktree, the main checkout's) gitignored .ci-local.env, read as data (one KEY=value line), never sourced.
emails_env() {
  ee_val=${WASITME_FORBIDDEN_EMAILS:-}
  if [ -z "$ee_val" ]; then
    for ee_f in "$ROOT/.ci-local.env" "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')/.ci-local.env"; do
      [ -f "$ee_f" ] || continue
      ee_val=$(sed -n 's/^[[:space:]]*WASITME_FORBIDDEN_EMAILS[[:space:]]*=[[:space:]]*//p' "$ee_f" | head -n 1)
      [ -n "$ee_val" ] && break
    done
  fi
  if [ -n "$ee_val" ]; then WASITME_FORBIDDEN_EMAILS=$ee_val "$@"; else "$@"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi
}

# ---- Arguments ----------------------------------------------------------------------------------------------------------
REF=HEAD; FROM_WORKTREE=0; OUT=""; STRICT=0; VERIFY=1; KEEP=0; CHECK_ONLY=""
while [ $# -gt 0 ]; do
  case $1 in
    --ref) [ $# -ge 2 ] || usage_die "--ref needs a revision"; REF=$2; shift ;;
    --worktree) FROM_WORKTREE=1 ;;
    --out) [ $# -ge 2 ] || usage_die "--out needs a directory"; OUT=$2; shift ;;
    --strict) STRICT=1 ;;
    --no-verify) VERIFY=0 ;;
    --keep) KEEP=1 ;;
    --check-stage) [ $# -ge 2 ] || usage_die "--check-stage needs a directory"; CHECK_ONLY=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage_die "unknown option: $1" ;;
  esac
  shift
done
if [ "$FROM_WORKTREE" = 1 ] && [ "$REF" != HEAD ]; then usage_die "--worktree and --ref contradict each other"; fi
if [ "$STRICT" = 1 ] && [ "$VERIFY" = 0 ]; then usage_die "--strict always verifies; drop --no-verify"; fi
if [ "$STRICT" = 1 ] && [ "$FROM_WORKTREE" = 1 ]; then usage_die "--strict releases a commit; drop --worktree"; fi

command -v node >/dev/null 2>&1 || die "node is needed (22 or newer)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || die "node 22 or newer is needed (found $(node --version))"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-release.XXXXXX") || die "could not create a work directory"
WORK=$(cd "$WORK" && pwd -P)
cleanup() {
  if [ "$KEEP" = 1 ]; then say "work directory kept: $WORK"; else chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "$CHECK_ONLY" ]; then
  say "Checking $CHECK_ONLY"
  check_stage "$CHECK_ONLY"
  exit 0
fi

command -v git >/dev/null 2>&1 || die "git is needed"
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "$ROOT is not a git checkout"
OUT=${OUT:-$ROOT/release}
case $OUT in /*) ;; *) OUT="$(pwd -P)/$OUT" ;; esac

# ---- 1. The source tree ------------------------------------------------------------------------------------------------
if [ "$FROM_WORKTREE" = 1 ]; then
  GIT_INDEX_FILE="$WORK/index" git -C "$ROOT" add -A >/dev/null 2>&1 || die "could not read the working tree into a temporary index"
  TREE=$(GIT_INDEX_FILE="$WORK/index" git -C "$ROOT" write-tree) || die "git write-tree failed"
  SOURCE_DESC="the working tree (tree $TREE, on top of $(git -C "$ROOT" rev-parse --short HEAD))"
  STAMP_EPOCH=$(git -C "$ROOT" log -1 --format=%ct HEAD)
else
  COMMIT=$(git -C "$ROOT" rev-parse --verify --quiet "$REF^{commit}") || die "no such commit: $REF"
  TREE=$(git -C "$ROOT" rev-parse "$COMMIT^{tree}")
  SOURCE_DESC="commit $COMMIT"
  STAMP_EPOCH=$(git -C "$ROOT" log -1 --format=%ct "$COMMIT")
fi
SRCX="$WORK/src"
mkdir -p "$SRCX"
git -C "$ROOT" archive --format=tar "$TREE" | tar -xf - -C "$SRCX" || die "git archive failed"
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$SRCX/engine/package.json") || die "engine/package.json is not readable"
case $VERSION in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "engine/package.json has no plain X.Y.Z version (got '$VERSION')" ;;
esac
case $VERSION in *[!0-9A-Za-z.+-]*) die "version '$VERSION' has characters a file name should not have" ;; esac
NAME="$WASITME_RELEASE_NAME-$VERSION"
say "wasitme $VERSION from $SOURCE_DESC"

# ---- 2. Gates that need no build ---------------------------------------------------------------------------------------
# The pattern spells the placeholder in two pieces, so the public export's --owner (which rewrites every whole
# placeholder it finds) cannot turn this gate into one that flags the real owner's URLs. export-public.sh is left out
# because its usage text names the placeholder it replaces; it is not a link anyone follows.
PLACEHOLDERS=$(git -C "$ROOT" grep -n -I -E 'github\.com/OWNER/|(^|[^A-Za-z0-9_])OWNER''/wasitme' "$TREE" -- . \
  ':(exclude)docs/PLAN.md' ':(exclude)docs/DECISIONS.md' ':(exclude)docs/STATUS.md' ':(exclude)docs/MERGE.md' \
  ':(exclude)docs/research' ':(exclude)docs/spikes' ':(exclude)spikes-tracked' ':(exclude)scripts/test' \
  ':(exclude)scripts/release.sh' ':(exclude)scripts/dev/export-public.sh' 2>/dev/null | sed "s|^$TREE:||" | cut -c1-160 || true)
if [ -n "$PLACEHOLDERS" ]; then
  if [ "$STRICT" = 1 ]; then
    printf '%s\n' "$PLACEHOLDERS" | sed 's/^/  PLACEHOLDER: /' >&2
    die "OWNER placeholders are still in public files (above); replace OWNER with the real GitHub owner first"
  fi
  say "PLACEHOLDER: the GitHub owner is not known yet; these stay OWNER until the repository exists (--strict refuses them):"
  printf '%s\n' "$PLACEHOLDERS" | sed 's/^/  /'
fi
if ! node "$SRCX/scripts/assemble-changelog.mjs" --root "$SRCX" --verify-release "$VERSION" >"$WORK/changelog.txt" 2>&1; then
  if [ "$STRICT" = 1 ]; then cat "$WORK/changelog.txt" >&2; die "CHANGELOG.md has no notes for $VERSION, or fragments are left in changelog.d"; fi
  note "the changelog is not folded for $VERSION yet. Before tagging: node scripts/assemble-changelog.mjs --release $VERSION (then commit CHANGELOG.md)"
fi
node "$SRCX/scripts/plugin-manifests.mjs" --check >"$WORK/manifests.txt" 2>&1 || { cat "$WORK/manifests.txt" >&2; die "the plugin manifests do not match engine/package.json (node scripts/plugin-manifests.mjs)"; }

# ---- 3. Build the engine and the Control Center page (the repository's own TypeScript; nothing is downloaded) -------
TS="$ROOT/node_modules/typescript/bin/tsc"
[ -f "$TS" ] || die "TypeScript is not installed in $ROOT (run 'npm ci' there once; the release build uses the locked version)"
ln -s "$ROOT/node_modules" "$SRCX/node_modules"
say "Building the engine"
( cd "$SRCX/engine" && NODE_DISABLE_COMPILE_CACHE=1 node "$TS" -p tsconfig.json ) >"$WORK/tsc.txt" 2>&1 || { tail -n 30 "$WORK/tsc.txt" >&2; die "the engine build failed"; }
say "Building the Control Center page"
NODE_DISABLE_COMPILE_CACHE=1 node "$SRCX/ui/scripts/build.mjs" >"$WORK/ui.txt" 2>&1 || { tail -n 30 "$WORK/ui.txt" >&2; die "the ui build failed"; }
rm -f "$SRCX/node_modules"

# ---- 4. Stage exactly the allow-list -------------------------------------------------------------------------------------
STAGE_PARENT="$WORK/stage"
STAGE="$STAGE_PARENT/$NAME"
mkdir -p "$STAGE"
stage() {  # stage REL...: copy from the source tree, keeping the relative path
  for st_r in "$@"; do
    [ -e "$SRCX/$st_r" ] || die "the source has no $st_r"
    mkdir -p "$STAGE/$(dirname "$st_r")"
    cp -R "$SRCX/$st_r" "$STAGE/$st_r"
  done
}
printf '%s\n' "$VERSION" >"$STAGE/VERSION"
stage LICENSE README.md THIRD_PARTY_NOTICES.md .claude-plugin/marketplace.json plugin plugin-codex \
  engine/package.json engine/dist/src ui/dist/app.html ui/dist/app.js ui/dist/app.css ui/dist/fonts \
  macos/Package.swift macos/Sources macos/support packaging/statusline.sh \
  scripts/install.sh scripts/uninstall.sh scripts/lib \
  design/system/fonts/app design/system/fonts/OFL.txt design/system/glyphs/appicon-1024.svg
for st_s in "$SRCX"/contract/*.schema.json; do stage "contract/$(basename "$st_s")"; done
rm -rf "$STAGE/plugin/tests" "$STAGE/plugin/reference" "$STAGE/engine/dist/src/synth" "$STAGE/engine/dist/src/analysis/calibration"
find "$STAGE" -name .DS_Store -exec rm -f {} + 2>/dev/null || true
say "Checking the staged tree"
check_stage "$STAGE"

# ---- 5. Pack: sorted names, one fixed time, numeric owner 0, gzip without a name or time stamp --------------------------
mkdir -p "$OUT"
STAMP=$(TZ=UTC node -e 'const d = new Date(Number(process.argv[1]) * 1000); const p = (n) => String(n).padStart(2, "0"); console.log(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}`)' "$STAMP_EPOCH")
( cd "$STAGE_PARENT" && find "$NAME" -exec env TZ=UTC touch -h -t "$STAMP" {} + )
( cd "$STAGE_PARENT" && find "$NAME" -type f | sort ) >"$WORK/files"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  set -- --owner=0 --group=0 --numeric-owner
else
  set -- --uid 0 --gid 0 --uname '' --gname ''
fi
TGZ="$OUT/$NAME.tgz"
( cd "$STAGE_PARENT" && tar -cf - "$@" -T "$WORK/files" ) | gzip -n -9 >"$TGZ.tmp" || die "packing the tarball failed"
mv -f "$TGZ.tmp" "$TGZ"
cp "$TGZ" "$OUT/$STABLE_ASSET"
TGZ_SHA=$(sha256_of "$TGZ")

# ---- 6. The install.sh asset: pinned to this release's tarball, with its checksum ----------------------------------------
DEFAULT_LINE=$(sed -n 's/^WASITME_DEFAULT_URL="\(.*\)"$/\1/p' "$STAGE/scripts/install.sh")
case $DEFAULT_LINE in
  */releases/latest/download/"$STABLE_ASSET") ;;
  *) die "scripts/install.sh's WASITME_DEFAULT_URL ('$DEFAULT_LINE') does not end in releases/latest/download/$STABLE_ASSET, the stable asset this script writes" ;;
esac
PINNED="${DEFAULT_LINE%/releases/latest/download/$STABLE_ASSET}/releases/download/v$VERSION/$NAME.tgz"
sed -e "s|^WASITME_DEFAULT_URL=\".*\"\$|WASITME_DEFAULT_URL=\"$PINNED\"|" \
    -e "s|^WASITME_DEFAULT_SHA256=\"\"\$|WASITME_DEFAULT_SHA256=\"$TGZ_SHA\"|" "$STAGE/scripts/install.sh" >"$OUT/install.sh.tmp"
[ "$(grep -c -e "^WASITME_DEFAULT_URL=\"$PINNED\"\$" -e "^WASITME_DEFAULT_SHA256=\"$TGZ_SHA\"\$" "$OUT/install.sh.tmp")" = 2 ] ||
  die "could not stamp the URL and checksum into install.sh (its two WASITME_DEFAULT_ lines changed shape)"
chmod 755 "$OUT/install.sh.tmp"
mv -f "$OUT/install.sh.tmp" "$OUT/install.sh"
if [ "$STRICT" = 1 ] && grep -q "^WASITME_DEFAULT_URL=.*OWNER" "$OUT/install.sh"; then
  die "the install.sh asset still downloads from an OWNER placeholder URL"
fi

( cd "$OUT" && for f in "$NAME.tgz" "$STABLE_ASSET" install.sh; do printf '%s  %s\n' "$(sha256_of "$f")" "$f"; done ) >"$OUT/SHA256SUMS"

# ---- 7. Install it, use it, uninstall it, in a throwaway HOME -------------------------------------------------------------
if [ "$VERIFY" = 1 ]; then
  say "Verifying: installing the tarball into a throwaway HOME"
  VH="$WORK/verify/home"
  mkdir -p "$VH" "$WORK/verify/tmp"
  VH=$(cd "$VH" && pwd -P)
  (
    # Nothing from this shell's own wasitme or agent setup may leak into the check.
    for v in $(env | sed -n 's/^\(WASITME_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
    unset CLAUDE_CONFIG_DIR CODEX_HOME NODE_OPTIONS
    export TMPDIR="$WORK/verify/tmp"
    export WASITME_NPM=/nonexistent/npm WASITME_CLAUDE=/nonexistent/claude WASITME_CODEX=/nonexistent/codex
    set -- --home "$VH" --yes --no-app --no-scan-agent --no-claude-plugin --no-codex-plugin --agents claude-code --statusline
    sh "$OUT/install.sh" --tarball "$TGZ" --sha256 "$TGZ_SHA" "$@" --dry-run >"$WORK/verify/dry.txt" 2>&1 || { cat "$WORK/verify/dry.txt" >&2; exit 11; }
    [ -z "$(ls -A "$VH")" ] || exit 12
    case $PINNED in
      *OWNER*)
        # The pinned URL is still a placeholder (refused before any download), so the download path cannot run yet.
        sh "$OUT/install.sh" --tarball "$TGZ" --sha256 "$TGZ_SHA" "$@" >"$WORK/verify/install.txt" 2>&1 || { cat "$WORK/verify/install.txt" >&2; exit 13; } ;;
      *)
        # The real path: no source option at all, so the stamped URL and checksum are used. curl is a stand-in that
        # hands over the local tarball instead of downloading it (and records the URL it was asked for).
        printf '#!/bin/sh\nwhile [ $# -gt 1 ]; do [ "$1" = -o ] && o=$2; shift; done\nprintf "%%s\\n" "$1" >"%s"\ncp "%s" "$o"\n' "$WORK/verify/url.txt" "$TGZ" >"$WORK/verify/curl"
        chmod +x "$WORK/verify/curl"
        WASITME_CURL="$WORK/verify/curl" sh "$OUT/install.sh" "$@" >"$WORK/verify/install.txt" 2>&1 || { cat "$WORK/verify/install.txt" >&2; exit 13; }
        [ "$(cat "$WORK/verify/url.txt")" = "$PINNED" ] || exit 23 ;;
    esac
    grep -q 'SHA-256 matches' "$WORK/verify/install.txt" || exit 14
    if grep -q 'Building the engine' "$WORK/verify/install.txt"; then exit 15; fi
    [ "$(cat "$VH/.wasitme/current/VERSION")" = "$VERSION" ] || exit 16
    # doctor exits 1 when its report lists problems. A throwaway HOME has no agent logs, so "No Claude Code or Codex
    # logs were found" is the one problem expected here; any other problem, or any other exit status, fails.
    drc=0
    HOME="$VH" "$VH/.local/bin/wasitme" doctor >"$WORK/verify/doctor.txt" 2>&1 </dev/null || drc=$?
    case $drc in
      0) ;;
      1)
        grep -qx 'Problems:' "$WORK/verify/doctor.txt" || { cat "$WORK/verify/doctor.txt" >&2; exit 17; }
        if sed '1,/^Problems:$/d' "$WORK/verify/doctor.txt" | grep -v '^  No Claude Code or Codex logs were found' | grep -q .; then
          cat "$WORK/verify/doctor.txt" >&2; exit 17
        fi ;;
      *) cat "$WORK/verify/doctor.txt" >&2; exit 17 ;;
    esac
    HOME="$VH" "$VH/.local/bin/wasitme" statusline show >"$WORK/verify/sl.txt" 2>&1 </dev/null || { cat "$WORK/verify/sl.txt" >&2; exit 18; }
    grep -qx 'Status line: wasitme' "$WORK/verify/sl.txt" || { cat "$WORK/verify/sl.txt" >&2; exit 19; }
    printf '{}' | HOME="$VH" "$VH/.local/bin/wasitme-statusline" >/dev/null 2>&1 || exit 20
    sh "$VH/.wasitme/current/scripts/uninstall.sh" --home "$VH" --yes --purge >"$WORK/verify/uninstall.txt" 2>&1 || { cat "$WORK/verify/uninstall.txt" >&2; exit 21; }
    [ -z "$(ls -A "$VH")" ] || { ls -A "$VH" >&2; exit 22; }
  ) || {
    vrc=$?
    case $vrc in
      11) why="the dry run of the asset install.sh failed" ;;
      12) why="the dry run changed the throwaway HOME" ;;
      13) why="installing the tarball failed" ;;
      14) why="the asset install.sh did not check the tarball's SHA-256" ;;
      15) why="the tarball has no prebuilt engine: installing it built one with npm" ;;
      16) why="the installed VERSION is not $VERSION" ;;
      17) why="the installed 'wasitme doctor' failed" ;;
      18|19) why="'wasitme statusline show' does not recognise the status line the installer added" ;;
      20) why="the installed status-line command failed" ;;
      21) why="the uninstaller failed" ;;
      22) why="the uninstaller left files in the throwaway HOME (listed above)" ;;
      23) why="the asset install.sh did not download from its pinned release URL" ;;
      *) why="exit $vrc" ;;
    esac
    die "verification: $why"
  }
  say "  install (dry run, then real, no npm), doctor, status line, uninstall --purge: ok"
fi

say ""
say "Release assets for wasitme $VERSION in $OUT:"
( cd "$OUT" && for f in "$NAME.tgz" "$STABLE_ASSET" install.sh SHA256SUMS; do printf '  %-24s %8s bytes\n' "$f" "$(wc -c <"$f" | tr -d ' ')"; done )
say "  SHA-256 of $NAME.tgz: $TGZ_SHA"
say "Nothing was published, tagged or uploaded."
exit 0
