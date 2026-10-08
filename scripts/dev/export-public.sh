#!/bin/sh
# export-public.sh - build the PUBLIC tree from this repository, into a new directory, as ONE fresh commit.
#
# Usage: scripts/dev/export-public.sh [options] OUT_DIR
#   OUT_DIR               a directory that does not exist yet, or is empty, and is outside this repository
#   --ref REF             what to export (default HEAD). Only committed content is exported; uncommitted changes are not.
#   --name NAME           author and committer name for the single commit   (default "wasitme maintainer")
#   --email EMAIL         author and committer email; must be a GitHub noreply address
#                         (default OWNER@users.noreply.github.com, a PLACEHOLDER: pass your own before you push)
#   --message TEXT        commit message (default "Initial commit")
#   --owner NAME          the GitHub account or organisation the repository will live under. Replaces the OWNER placeholder
#                         in repository paths such as github.com/OWNER/... (the advisory link, package metadata, the installer's
#                         download URL) before the commit. Without it the placeholders stay and the script says how many files
#                         still carry one.
#   --require-email-config  fail instead of warning when no forbidden email or no forbidden phrase is configured
#                         (WASITME_FORBIDDEN_EMAILS and WASITME_FORBIDDEN_PHRASES, or a gitignored .ci-local.env), so
#                         neither scan can be skipped by accident
#   --no-checks           skip the post-export checks (check-repo --strict, the git-identity check, the changelog and
#                         link tests). The path and phrase assertions below always run.
#   --keep                keep OUT_DIR when an assertion or check fails (it is removed otherwise)
#   -h, --help
#
# What it does, in order:
#   1. `git archive REF`, which leaves out every path marked `export-ignore` in .gitattributes (the single list of
#      internal files: STATUS, MERGE, PLAN, PREPUBLISH, private notes, the maintainer's tooling, spike code and scratch
#      work).
#   2. Asserts the result: none of the internal paths below exist, the public files exist, and none of the configured
#      private phrases appears in any text file (case-insensitively). A path below that .gitattributes does not leave
#      out is a failure. The phrases are never written in a tracked file, so this guard does not publish what it
#      guards: they come from WASITME_FORBIDDEN_PHRASES or the gitignored .ci-local.env (see .ci-local.env.example),
#      comma separated, at least 5 characters each. A hit names the phrase by its position in that list, never by its
#      text. With none configured the scan is skipped with a warning (an error with --require-email-config).
#   3. `git init`, then one commit authored and committed with the placeholder (or given) noreply identity, dated in
#      UTC (+0000) so it does not carry this machine's time zone. The new repository ignores your global git config
#      (name, email, hooks, signing), has no remote, and keeps that identity as its local one, so a later commit there
#      cannot pick up a personal address by accident.
#   4. Runs the repository checks on the new tree: scripts/check-repo.mjs --strict (home paths, the configured
#      forbidden emails, remote assets), check-repo --git-identity (every commit's author, committer and message), the
#      changelog fragment check, and the documentation link test.
#
# It never pushes, never adds a remote, never touches this repository's history or config, and never reads anything
# outside this repository except to create OUT_DIR. Publishing the result is the maintainer's decision (docs/PREPUBLISH.md).
#
# Exit codes: 0 exported and checked, 1 an assertion or check failed (OUT_DIR is removed unless --keep), 2 usage or
# configuration error.
#
# POSIX sh. Needs git, tar, grep, find and (unless --no-checks) node 22+.

set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P) || exit 2

NAME="wasitme maintainer"
EMAIL="OWNER@users.noreply.github.com"
MESSAGE="Initial commit"
REF=HEAD
CHECKS=1
REQUIRE_CONFIG=0
KEEP=0
OWNER_NAME=""
OUT=""

usage() { sed -n '2,/^# POSIX sh/p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "export-public: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case $1 in
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF=$2; shift 2 ;;
    --name) [ $# -ge 2 ] || die "--name needs a value"; NAME=$2; shift 2 ;;
    --email) [ $# -ge 2 ] || die "--email needs a value"; EMAIL=$2; shift 2 ;;
    --message) [ $# -ge 2 ] || die "--message needs a value"; MESSAGE=$2; shift 2 ;;
    --require-email-config) REQUIRE_CONFIG=1; shift ;;
    --no-checks) CHECKS=0; shift ;;
    --owner) [ $# -ge 2 ] || die "--owner needs a value"; OWNER_NAME=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) [ -z "$OUT" ] || die "only one OUT_DIR, got a second: $1"; OUT=$1; shift ;;
  esac
done
[ -n "$OUT" ] || { usage >&2; exit 2; }

# The identity must be a GitHub noreply address on one line: a personal address in the first public commit is the
# one thing this script exists to prevent.
case $EMAIL in
  *[!A-Za-z0-9+._@-]*) die "--email must be a GitHub noreply address (letters, digits, + . _ - only)" ;;
  ?*@users.noreply.github.com) ;;
  *) die "--email must be a GitHub noreply address (ID+name@users.noreply.github.com)" ;;
esac
case $NAME in
  ''|*'
'*) die "--name must be a single non-empty line" ;;
esac
case $MESSAGE in '') die "--message must not be empty" ;; esac
if [ -n "$OWNER_NAME" ]; then
  # A GitHub login: letters, digits and single hyphens, not starting or ending with one, at most 39 characters.
  case $OWNER_NAME in
    *[!A-Za-z0-9-]*|-*|*-|*--*) die "--owner must be a GitHub account name (letters, digits and single hyphens)" ;;
  esac
  [ "${#OWNER_NAME}" -le 39 ] || die "--owner is longer than a GitHub account name can be (39)"
fi

git -C "$ROOT" rev-parse --verify --quiet "$REF^{commit}" >/dev/null 2>&1 || die "not a commit in this repository: $REF"

# The private phrases (step 2): WASITME_FORBIDDEN_PHRASES, else the gitignored .ci-local.env of this checkout, then of
# the main worktree. The file is read as data, never sourced, the way loadForbiddenPhrases in scripts/check-repo.mjs
# reads it (scripts/test/export-public.test.mjs checks that the two agree). Read before anything is written.
env_setting() { # FILE KEY: the value of the last KEY=value line; quotes or a trailing " # comment" are dropped
  es_v=$(tr -d '\r' <"$1" | sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$2[[:space:]]*=[[:space:]]*//p" | tail -n 1 | sed 's/[[:space:]]*$//')
  case $es_v in
    \"*\"|\'*\') es_v=${es_v#?}; es_v=${es_v%?} ;;
    *) es_v=$(printf '%s\n' "$es_v" | sed 's/[[:space:]]\{1,\}#.*$//') ;;
  esac
  printf '%s' "$es_v"
}
blank() { case $1 in *[![:space:]]*) return 1 ;; esac; return 0; }
PHRASE_SRC=WASITME_FORBIDDEN_PHRASES
PHRASES_RAW=${WASITME_FORBIDDEN_PHRASES:-}
if blank "$PHRASES_RAW"; then
  PHRASES_RAW=""
  PHRASE_SRC=.ci-local.env
  main_wt=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || main_wt=""
  case $main_wt in */.git) main_wt=${main_wt%/.git} ;; *) main_wt="" ;; esac
  for f in "$ROOT/.ci-local.env" ${main_wt:+"$main_wt/.ci-local.env"}; do
    [ -f "$f" ] || continue
    PHRASES_RAW=$(env_setting "$f" WASITME_FORBIDDEN_PHRASES)
    blank "$PHRASES_RAW" || break
    PHRASES_RAW=""
  done
fi
# One phrase per line, trimmed. A phrase may contain spaces, so only commas (and newlines) separate them.
PHRASES=$(printf '%s\n' "$PHRASES_RAW" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$')
PHRASE_COUNT=0
if [ -n "$PHRASES" ]; then
  PHRASE_COUNT=$(printf '%s\n' "$PHRASES" | wc -l | tr -d ' ')
  if printf '%s\n' "$PHRASES" | grep -q -v '.....'; then
    die "a forbidden-phrase entry in $PHRASE_SRC is shorter than 5 characters; refusing (it would match almost everything)"
  fi
elif [ "$REQUIRE_CONFIG" = 1 ]; then
  die "no forbidden phrase configured (set WASITME_FORBIDDEN_PHRASES or add it to .ci-local.env); --require-email-config makes that an error"
fi
if [ "$REF" = HEAD ] && [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  echo "export-public: warning: uncommitted changes in this repository are NOT exported (only committed content is)" >&2
fi

# OUT_DIR: new or empty, and neither inside this repository nor an ancestor of it.
if [ -e "$OUT" ] && [ ! -d "$OUT" ]; then die "OUT_DIR exists and is not a directory: $OUT"; fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then die "OUT_DIR is not empty: $OUT"; fi
CREATED=0
if [ ! -d "$OUT" ]; then mkdir -p "$OUT" || die "cannot create $OUT"; CREATED=1; fi
OUT=$(cd "$OUT" && pwd -P) || die "cannot enter $OUT"
case "$OUT/" in
  "$ROOT/"*) [ "$CREATED" = 1 ] && rmdir "$OUT" 2>/dev/null; die "OUT_DIR must be outside this repository" ;;
esac
case "$ROOT/" in
  "$OUT/"*) die "OUT_DIR must not contain this repository" ;;
esac

TMP=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-export.XXXXXX") || die "cannot create a temporary directory"
FAILED=1
cleanup() {
  rm -rf "$TMP"
  if [ "$FAILED" = 1 ] && [ "$KEEP" = 0 ]; then
    # OUT_DIR was empty or new when we started, so everything in it is ours.
    if [ "$CREATED" = 1 ]; then rm -rf "$OUT"; else find "$OUT" -mindepth 1 -delete 2>/dev/null; fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "export-public: FAIL: $*" >&2; exit 1; }

# ---- 1. export --------------------------------------------------------------------------------------------------
git -C "$ROOT" archive --format=tar -o "$TMP/tree.tar" "$REF" || fail "git archive failed"
tar -xf "$TMP/tree.tar" -C "$OUT" || fail "could not unpack the archive"
rm -f "$OUT/pax_global_header" # older GNU tar unpacks git's commit-id comment as a file

# The OWNER placeholder, in every text file that has one. The files are rewritten in place (same inode, same mode).
# The pattern is spelled in two pieces so this script does not rewrite itself when it is exported and run again.
PLACEHOLDER="OWNER""/wasitme"
if [ -n "$OWNER_NAME" ]; then
  find "$OUT" -type f -exec grep -Il -F -e "$PLACEHOLDER" {} + 2>/dev/null | while IFS= read -r f; do
    sed "s|$PLACEHOLDER|$OWNER_NAME/wasitme|g" "$f" > "$TMP/owner.swap" && cat "$TMP/owner.swap" > "$f" || exit 1
  done || fail "could not replace the OWNER placeholder"
  # SECURITY.md's note that the advisory link is still a placeholder is false once the owner is in: drop that line.
  if [ -f "$OUT/SECURITY.md" ]; then
    grep -v -F '*(placeholder: `OWNER`' "$OUT/SECURITY.md" > "$TMP/owner.swap" && cat "$TMP/owner.swap" > "$OUT/SECURITY.md" ||
      fail "could not drop the placeholder note from SECURITY.md"
  fi
fi
LEFT=$(find "$OUT" -type f -exec grep -Il -F -e "$PLACEHOLDER" {} + 2>/dev/null | wc -l | tr -d ' ')

# ---- 2. assertions ----------------------------------------------------------------------------------------------
# Never in the public tree, whatever .gitattributes says. (One path per line.)
MUST_NOT_SHIP='CLAUDE.local.md
.ci-local.env
.gitattributes
docs/private
docs/STATUS.md
docs/MERGE.md
docs/PLAN.md
docs/PREPUBLISH.md
docs/GUARDRAILS.md
docs/TESTING-FOUNDER.md
docs/research/06-local-log-structure.md
engine/reference
engine/scripts/g0.mjs
spikes-tracked
design/system/_verify'

# The public tree must still be a working project (an over-broad exclusion would otherwise ship an empty shell).
MUST_SHIP='README.md
LICENSE
AGENTS.md
CLAUDE.md
SECURITY.md
CONTRIBUTING.md
CODE_OF_CONDUCT.md
THIRD_PARTY_NOTICES.md
docs/METHOD.md
docs/PRIVACY.md
docs/DECISIONS.md
engine/package.json
scripts/ci-local.sh
scripts/dev/heavy.sh'

bad=0
OLDIFS=$IFS
IFS='
'
set -f # the lists below are literal text, never globs
for p in $MUST_NOT_SHIP; do
  if [ -e "$OUT/$p" ] || [ -L "$OUT/$p" ]; then echo "export-public: FAIL: internal path in the export: $p" >&2; bad=1; fi
done
for p in $MUST_SHIP; do
  [ -e "$OUT/$p" ] || { echo "export-public: FAIL: missing from the export: $p" >&2; bad=1; }
done
# Private notes under any directory, and local secrets or caches, wherever they sit.
stray=$(find "$OUT" \( -name CLAUDE.local.md -o -name .ci-local.env -o -name '*.cache.jsonl' -o -name .DS_Store \) -print 2>/dev/null | head -n 5)
if [ -n "$stray" ]; then echo "export-public: FAIL: local files in the export:" >&2; echo "$stray" | sed "s|^$OUT/|  |" >&2; bad=1; fi
# The configured private phrases, case-insensitively, in every text file. Like the forbidden emails, a phrase is never
# printed: the message names its position in the configured list.
n=0
for ph in $PHRASES; do
  n=$((n + 1))
  hits=$(grep -rIl -i -F -e "$ph" "$OUT" 2>/dev/null | head -n 5)
  if [ -n "$hits" ]; then
    echo "export-public: FAIL: forbidden phrase $n of $PHRASE_COUNT (in $PHRASE_SRC) found in:" >&2
    echo "$hits" | sed "s|^$OUT/|  |" >&2
    bad=1
  fi
done
set +f
IFS=$OLDIFS
[ "$bad" = 0 ] || fail "the export is not clean; fix .gitattributes or the files above"

# ---- 3. one commit -----------------------------------------------------------------------------------------------
# A repository that ignores every global and system setting: no personal identity, hooks, signing or templates.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL"
git -C "$OUT" init -q || fail "git init failed"
git -C "$OUT" symbolic-ref HEAD refs/heads/main || fail "could not name the branch"
git -C "$OUT" config user.name "$NAME"
git -C "$OUT" config user.email "$EMAIL"
git -C "$OUT" config commit.gpgsign false
git -C "$OUT" config core.hooksPath /dev/null
git -C "$OUT" add -A || fail "git add failed"
# No automatic maintenance: a commit of ~1,000 new objects starts a detached `git maintenance` repack that would still be
# writing into OUT after this script returns (or while a failed check removes OUT). TZ=UTC0 dates the commit in UTC
# (+0000 for author and committer), so it does not carry this machine's time zone.
TZ=UTC0 git -C "$OUT" -c maintenance.auto=false -c gc.auto=0 commit -q -m "$MESSAGE" || fail "git commit failed"
COMMITS=$(git -C "$OUT" rev-list --all --count)
[ "$COMMITS" = 1 ] || fail "expected exactly one commit, found $COMMITS"
FILES=$(git -C "$OUT" ls-files | wc -l | tr -d ' ')

# ---- 4. checks on the new tree -----------------------------------------------------------------------------------
if [ "$CHECKS" = 1 ]; then
  command -v node >/dev/null 2>&1 || fail "node is needed for the checks (pass --no-checks to skip them)"
  # The configured forbidden addresses come from THIS repository's config, never from the new tree (which has none),
  # and travel to the checker through its environment, so they are never printed.
  EMAILS=$(node --input-type=module -e '
    const { pathToFileURL } = await import("node:url");
    const m = await import(pathToFileURL(process.argv[2]).href);
    process.stdout.write(m.loadForbiddenEmails(process.argv[3]).literals.join(","));
  ' -- _ "$ROOT/scripts/check-repo.mjs" "$ROOT") || fail "could not read the forbidden-email configuration"
  EMAIL_FLAG=""
  [ "$REQUIRE_CONFIG" = 1 ] && EMAIL_FLAG="--require-email-config"
  [ -f "$OUT/scripts/check-repo.mjs" ] || fail "the export has no scripts/check-repo.mjs"
  echo "export-public: check-repo --strict on the new tree"
  # shellcheck disable=SC2086 # EMAIL_FLAG is empty or one fixed flag
  WASITME_FORBIDDEN_EMAILS="$EMAILS" node "$OUT/scripts/check-repo.mjs" --root "$OUT" --strict $EMAIL_FLAG || fail "check-repo --strict found problems"
  echo "export-public: check-repo --git-identity on the new tree"
  # shellcheck disable=SC2086
  WASITME_FORBIDDEN_EMAILS="$EMAILS" node "$OUT/scripts/check-repo.mjs" --root "$OUT" --git-identity $EMAIL_FLAG || fail "the commit identity check failed"
  echo "export-public: changelog fragments"
  ( cd "$OUT" && node scripts/assemble-changelog.mjs --check ) || fail "changelog fragments are not well-formed"
  if [ -f "$OUT/scripts/test/doc-links.test.mjs" ]; then
    echo "export-public: documentation links in the new tree"
    ( cd "$OUT" && node --test scripts/test/doc-links.test.mjs ) >"$TMP/links.log" 2>&1 || { cat "$TMP/links.log" >&2; fail "a link in the public documentation does not resolve"; }
  fi
  if [ -z "$EMAILS" ]; then
    echo "export-public: WARNING: no forbidden email is configured, so that scan did NOT run. Set WASITME_FORBIDDEN_EMAILS (or .ci-local.env) and re-run before you publish, or use --require-email-config." >&2
  fi
fi
if [ "$PHRASE_COUNT" = 0 ]; then
  echo "export-public: WARNING: no forbidden phrase is configured, so the private-phrase scan did NOT run. Set WASITME_FORBIDDEN_PHRASES (or .ci-local.env) and re-run before you publish, or use --require-email-config." >&2
fi

FAILED=0
HASH=$(git -C "$OUT" rev-parse --short HEAD)
echo ""
echo "export-public: wrote $OUT"
echo "  $FILES files, one commit ($HASH) on branch main, no remote."
echo "  identity: $NAME <$EMAIL>"
case $EMAIL in
  OWNER@users.noreply.github.com)
    echo "  This identity is a PLACEHOLDER. Before you push, re-run with your own GitHub noreply address:"
    echo "    scripts/dev/export-public.sh --name 'Your Name' --email 'ID+username@users.noreply.github.com' --owner USERNAME NEW_DIR" ;;
esac
if [ "$LEFT" -gt 0 ]; then
  echo "  $LEFT file(s) still carry the OWNER placeholder (SECURITY.md, the issue-form config, package metadata, the installer URL):"
  echo "  re-run with --owner USERNAME (the GitHub account or organisation the repository will live under)."
fi
echo "  Nothing was pushed. Pushing is the maintainer's decision (docs/PREPUBLISH.md)."
exit 0
