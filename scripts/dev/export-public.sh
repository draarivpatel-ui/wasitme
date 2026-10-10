#!/bin/sh
# export-public.sh - build the PUBLIC tree from this repository: into a new directory as ONE fresh commit, or (--onto)
# as one ordinary commit on top of a clone of the public repository.
#
# Usage: scripts/dev/export-public.sh [options] OUT_DIR
#        scripts/dev/export-public.sh [options] --onto DIR
#   OUT_DIR               a directory that does not exist yet, or is empty, and is outside this repository
#   --onto DIR            update mode, for a public repository that already exists (see "Update mode" below): DIR is a
#                         local clone of it, outside this repository, with main checked out and nothing uncommitted
#   --ref REF             what to export (default HEAD). Only committed content is exported; uncommitted changes are not.
#   --name NAME           author and committer name for the commit   (default "wasitme maintainer")
#   --email EMAIL         author and committer email; must be a GitHub noreply address
#                         (default OWNER@users.noreply.github.com, a PLACEHOLDER: pass your own before you push;
#                         --onto refuses the placeholder)
#   --message TEXT        commit message (default "Initial commit"; with --onto "Update from the development tree")
#   --owner NAME          the GitHub account or organisation the repository will live under. Replaces the OWNER placeholder
#                         in repository paths such as github.com/OWNER/... (the advisory link, package metadata, the installer's
#                         download URL) before the commit. Without it the placeholders stay and the script says how many files
#                         still carry one (--onto refuses such a tree: the public repository already names its owner).
#   --require-email-config  fail instead of warning when no forbidden email or no forbidden phrase is configured
#                         (WASITME_FORBIDDEN_EMAILS and WASITME_FORBIDDEN_PHRASES, or a gitignored .ci-local.env), so
#                         neither scan can be skipped by accident
#   --no-checks           skip the post-export checks (check-repo --strict, the git-identity check, the changelog and
#                         link tests). The path and phrase assertions below always run.
#   --keep                keep OUT_DIR when an assertion or check fails (it is removed otherwise). With --onto: keep the
#                         failed tree in its temporary folder (the path is printed), or leave a commit whose checks
#                         failed on DIR's main (it is undone otherwise)
#   -h, --help
#
# What it does, in order:
#   1. `git archive REF`, which leaves out every path marked `export-ignore` in .gitattributes (the single list of
#      internal files: STATUS, MERGE, PLAN, PREPUBLISH, private notes, the maintainer's tooling, spike code and scratch
#      work).
#   2. Asserts the result: none of the internal paths below exist, the public files exist, and none of the configured
#      private phrases appears in any file's contents (text or binary: media metadata is a place a name hides) or in
#      any file or folder name (case-insensitively; a phrase stored as UTF-16 or inside compressed data is not seen).
#      A path below that .gitattributes does not leave out is a failure. The phrases are never written in a tracked file, so this guard does not publish what it
#      guards: they come from WASITME_FORBIDDEN_PHRASES or the gitignored .ci-local.env (see .ci-local.env.example),
#      comma separated, at least 5 characters each. A hit names the phrase by its position in that list, never by its
#      text (a path that holds it is printed with the phrase replaced by [phrase]). With none configured the scan is skipped with a warning (an error with --require-email-config).
#   3. `git init`, then one commit authored and committed with the placeholder (or given) noreply identity, dated in
#      UTC (+0000) so it does not carry this machine's time zone. The new repository ignores your global git config
#      (name, email, hooks, signing), has no remote, and keeps that identity as its local one, so a later commit there
#      cannot pick up a personal address by accident.
#   4. Runs the repository checks on the new tree: scripts/check-repo.mjs --strict (home paths, the configured
#      forbidden emails, remote assets), check-repo --git-identity (every commit's author, committer and message), the
#      changelog fragment check, and the documentation link test.
#
# Update mode (--onto DIR). Once the public repository is public it is never force-pushed or replaced; later changes
# reach it as ordinary commits on top of its own history (docs/DECISIONS.md, D79). This mode makes that commit:
#   - Before anything is built it refuses, changing nothing (exit 2), when --email is the placeholder, or DIR is missing,
#     is inside this repository or contains it, is not the top folder of a git repository, is a checkout of this
#     repository, has no commits, does not have main checked out, has a merge (cherry-pick, revert, rebase) in progress,
#     is a shallow clone, has uncommitted changes, untracked files (ignored files are fine) or files marked
#     assume-unchanged or skip-worktree, lacks commits that its last fetch saw on origin/main, or when the author or
#     committer email of its HEAD is not a GitHub noreply address. Unless --no-checks, check-repo --git-identity must
#     also pass on DIR's whole history first. Inherited GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG*, author and committer dates
#     and the like are dropped, replace refs are ignored, and a partial clone never fetches.
#   - Steps 1 and 2 are the same code, run in a temporary folder instead of OUT_DIR. A tree that still carries an OWNER
#     placeholder fails (exit 1).
#   - If the new tree is identical to the tree of DIR's HEAD it prints "nothing to update" and exits 0: no commit.
#   - Otherwise step 3 is ONE commit on top of DIR's HEAD with the same identity rules and UTC dates, holding exactly the
#     exported files: every tracked file is added, changed or removed to match, whatever DIR's .gitignore says. main
#     then fast-forwards to it, through git only, which updates DIR's working tree and leaves ignored files alone (if
#     one sits where the export adds a file, git refuses and nothing changes: exit 2).
#   - Step 4 runs on DIR; the identity check covers every commit in it. If a check fails, main goes back to the commit
#     it was on (a checkout that overwrites no local change and no ignored file), unless --keep. On success DIR's local
#     user.name and user.email become the export identity, so a tag made there later cannot carry a personal address.
#   - It never fetches or pushes and never adds or changes a remote. It prints the push command for the maintainer.
#
# It never pushes, never adds a remote, never touches this repository's history or config, and never reads anything
# outside this repository except to create OUT_DIR (or, with --onto, to update DIR). Publishing the result is the
# maintainer's decision (docs/PREPUBLISH.md).
#
# Exit codes: 0 exported and checked (with --onto also: nothing to update), 1 an assertion or check failed (OUT_DIR is
# removed, or DIR's main goes back to its previous commit, unless --keep), 2 usage or configuration error, or --onto
# refused (nothing changed).
#
# POSIX sh. Needs git, tar, grep, find and (unless --no-checks) node 22+.

set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P) || exit 2

NAME="wasitme maintainer"
EMAIL="OWNER@users.noreply.github.com"
MESSAGE="Initial commit"
MESSAGE_SET=0
REF=HEAD
CHECKS=1
REQUIRE_CONFIG=0
KEEP=0
OWNER_NAME=""
OUT=""
ONTO=""

usage() { sed -n '2,/^# POSIX sh/p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "export-public: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case $1 in
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF=$2; shift 2 ;;
    --name) [ $# -ge 2 ] || die "--name needs a value"; NAME=$2; shift 2 ;;
    --email) [ $# -ge 2 ] || die "--email needs a value"; EMAIL=$2; shift 2 ;;
    --message) [ $# -ge 2 ] || die "--message needs a value"; MESSAGE=$2; MESSAGE_SET=1; shift 2 ;;
    --onto)
      [ $# -ge 2 ] && [ -n "$2" ] || die "--onto needs a directory"
      [ -z "$ONTO" ] || die "only one --onto DIR, got a second: $2"
      ONTO=$2; shift 2 ;;
    --require-email-config) REQUIRE_CONFIG=1; shift ;;
    --no-checks) CHECKS=0; shift ;;
    --owner) [ $# -ge 2 ] || die "--owner needs a value"; OWNER_NAME=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) [ -z "$OUT" ] || die "only one OUT_DIR, got a second: $1"; OUT=$1; shift ;;
  esac
done
if [ -n "$ONTO" ]; then
  [ -z "$OUT" ] || die "give either OUT_DIR (a fresh export) or --onto DIR (an update), not both"
  [ "$MESSAGE_SET" = 1 ] || MESSAGE="Update from the development tree"
fi
[ -n "$OUT" ] || [ -n "$ONTO" ] || { usage >&2; exit 2; }

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
if [ -n "$ONTO" ]; then
  [ "$EMAIL" != "OWNER@users.noreply.github.com" ] ||
    die "--onto adds to the public history: pass your own GitHub noreply address with --email (the default is a placeholder)"
  printf '%s\n' "$EMAIL" | grep -E -i -q '^([0-9]+\+)?[a-z0-9]([a-z0-9-]*[a-z0-9])?@users\.noreply\.github\.com$' ||
    die "--email must be a GitHub noreply address (ID+name@users.noreply.github.com)"
  # Nothing inherited may steer git in DIR: another repository, index or config, or dates (which would override the UTC
  # ones). CDPATH could change where a relative `cd` lands. Every git run, the checkers' included, ignores replace refs
  # (which could show a history other than the real one) and never fetches a missing object from a partial clone.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR \
    GIT_NAMESPACE GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_AUTHOR_DATE GIT_COMMITTER_DATE CDPATH
  export GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1
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

# The configured forbidden addresses (step 4, and --onto's check of DIR's history) come from THIS repository's config,
# never from the exported tree (which has none), and travel to the checker through its environment, so they are never
# printed. $1 is the function that reports a failure (die before anything is written, fail after).
EMAILS=""
EMAIL_FLAG=""
EMAILS_LOADED=0
load_forbidden_emails() {
  command -v node >/dev/null 2>&1 || "$1" "node is needed for the checks (pass --no-checks to skip them)"
  EMAILS=$(node --input-type=module -e '
    const { pathToFileURL } = await import("node:url");
    const m = await import(pathToFileURL(process.argv[2]).href);
    process.stdout.write(m.loadForbiddenEmails(process.argv[3]).literals.join(","));
  ' -- _ "$ROOT/scripts/check-repo.mjs" "$ROOT") || "$1" "could not read the forbidden-email configuration"
  EMAIL_FLAG=""
  [ "$REQUIRE_CONFIG" = 1 ] && EMAIL_FLAG="--require-email-config"
  EMAILS_LOADED=1
}

# git in DIR (--onto) with no global or system configuration, no hook or fsmonitor program, no signing and no background
# maintenance. Never called with a variable assignment in front (POSIX leaves its scope on a function call unspecified).
ongit() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$ONTO" -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false -c commit.gpgSign=false -c maintenance.auto=false -c gc.auto=0 "$@"
}
# GitHub noreply, as isGithubNoreply in scripts/check-repo.mjs: [ID+]login[[bot]]@users.noreply.github.com, or noreply@github.com.
is_noreply() {
  printf '%s\n' "$1" | grep -E -i -q '^([0-9]+\+)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\[bot\])?@users\.noreply\.github\.com$|^noreply@github\.com$'
}
# A path as a shell word, for the commands printed at the end.
shell_word() {
  case $1 in
    ''|*[!A-Za-z0-9_./+:@%=-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

if [ -n "$ONTO" ]; then
  # DIR (--onto): an existing clone of the public repository, checked before anything is built or written.
  [ -d "$ONTO" ] || die "--onto: no such directory: $ONTO"
  ONTO=$(cd "$ONTO" && pwd -P) || die "--onto: cannot enter $ONTO"
  case "$ONTO/" in
    "$ROOT/"*) die "--onto: DIR must be outside this repository" ;;
  esac
  case "$ROOT/" in
    "$ONTO/"*) die "--onto: DIR must not contain this repository" ;;
  esac
  top=$(ongit rev-parse --show-toplevel 2>/dev/null) || die "--onto: not a git repository with a working tree: $ONTO"
  top=$(cd "$top" 2>/dev/null && pwd -P) || top=""
  [ "$top" = "$ONTO" ] || die "--onto: $ONTO is inside a git repository but is not its top folder"
  # Fail closed: a folder whose repository cannot be compared with this one is refused.
  onto_common=$(ongit rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
    onto_common=$(cd "$onto_common" && pwd -P) || die "--onto: cannot find the git folder of $ONTO"
  root_common=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
    root_common=$(cd "$root_common" && pwd -P) || die "cannot find the git folder of this repository"
  [ "$onto_common" != "$root_common" ] || die "--onto: $ONTO is a checkout of this development repository, not a clone of the public one"
  OLDHEAD=$(ongit rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) ||
    die "--onto: $ONTO has no commits (the first public commit is a fresh export: give OUT_DIR instead of --onto)"
  branch=$(ongit symbolic-ref -q HEAD 2>/dev/null) || branch=""
  case $branch in
    refs/heads/main) ;;
    refs/heads/*) die "--onto: $ONTO must have main checked out, not ${branch#refs/heads/}" ;;
    *) die "--onto: $ONTO must have main checked out (its HEAD is detached)" ;;
  esac
  for op in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD REBASE_HEAD; do
    if ongit rev-parse -q --verify "$op" >/dev/null 2>&1; then
      die "--onto: $ONTO has a merge, cherry-pick, revert or rebase in progress ($op); finish or abort it first"
    fi
  done
  # The whole history is checked for identities, so it must all be there.
  [ "$(ongit rev-parse --is-shallow-repository 2>/dev/null)" = false ] ||
    die "--onto: $ONTO is a shallow clone; fetch its whole history first (git -C $(shell_word "$ONTO") fetch --unshallow)"
  # Untracked files count too: the checks in step 4 would scan them as if they were part of the export. The flags do not
  # depend on DIR's status settings.
  dirty=$(ongit status --porcelain --untracked-files=normal --ignore-submodules=none) || die "--onto: git status failed in $ONTO"
  [ -z "$dirty" ] || die "--onto: $ONTO has uncommitted changes or untracked files (git status lists them); commit, remove or ignore them first"
  # Files git status does not look at (marked assume-unchanged or skip-worktree, as in a sparse checkout).
  if ongit ls-files -v | grep -q '^[a-zS] '; then
    die "--onto: $ONTO has files marked assume-unchanged or skip-worktree (a sparse checkout?); clear the marks first"
  fi
  # Public commits the clone has fetched but main lacks: a commit on that stale main could not be pushed. (Only refs
  # already in DIR are compared; nothing is fetched.)
  if ongit rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1 &&
    ! ongit merge-base --is-ancestor refs/remotes/origin/main "$OLDHEAD" 2>/dev/null; then
    die "--onto: $ONTO's main does not contain origin/main as of its last fetch: run git -C $(shell_word "$ONTO") pull --ff-only first"
  fi
  OLD_SHORT=$(ongit rev-parse --short "$OLDHEAD")
  if ! is_noreply "$(ongit log -1 --format=%ae "$OLDHEAD")" || ! is_noreply "$(ongit log -1 --format=%ce "$OLDHEAD")"; then
    die "--onto: the author or committer email of $ONTO's HEAD ($OLD_SHORT) is not a GitHub noreply address (value not shown); refusing to add to that history"
  fi
  if [ "$CHECKS" = 1 ]; then
    load_forbidden_emails die
    echo "export-public: check-repo --git-identity on $ONTO before the update"
    # shellcheck disable=SC2086 # EMAIL_FLAG is empty or one fixed flag
    WASITME_FORBIDDEN_EMAILS="$EMAILS" node "$ROOT/scripts/check-repo.mjs" --root "$ONTO" --git-identity $EMAIL_FLAG ||
      die "--onto: the history in $ONTO fails the identity check (above); nothing was changed"
  fi
else
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
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/wasitme-export.XXXXXX") || die "cannot create a temporary directory"
FAILED=1
STAGE=build # --onto: build (DIR untouched), applying (main is moving to the new commit), committed (main is on it)
cleanup() {
  if [ -n "$ONTO" ]; then cleanup_onto; return; fi
  rm -rf "$TMP"
  if [ "$FAILED" = 1 ] && [ "$KEEP" = 0 ]; then
    # OUT_DIR was empty or new when we started, so everything in it is ours.
    if [ "$CREATED" = 1 ]; then rm -rf "$OUT"; else find "$OUT" -mindepth 1 -delete 2>/dev/null; fi
  fi
}
cleanup_onto() {
  if [ "$FAILED" = 1 ] && [ "$KEEP" = 1 ] && [ "$STAGE" = build ] && [ -d "$TMP/tree" ]; then
    echo "export-public: the failed tree is kept in $TMP/tree (--keep); delete that folder when you are done" >&2
    return
  fi
  rm -rf "$TMP"
  [ "$FAILED" = 1 ] && [ "$STAGE" != build ] || return 0
  if [ "$(ongit rev-parse -q --verify HEAD 2>/dev/null)" = "$OLDHEAD" ]; then
    # main never moved. Say so if the working tree did anyway (an interrupted fast-forward).
    if [ -n "$(ongit status --porcelain --untracked-files=no 2>/dev/null)" ]; then
      echo "export-public: the update of $ONTO stopped part-way: main did not move, but git status there lists changes" >&2
    fi
    return 0
  fi
  if [ "$KEEP" = 1 ]; then
    echo "export-public: the commit stays on $ONTO's main (--keep). Undo it with: git -C $(shell_word "$ONTO") reset --keep $OLD_SHORT" >&2
    return
  fi
  # Put main back where it was, only if it is still on the new commit. The checkout refuses rather than overwrite a
  # local change or an ignored file.
  if [ "$(ongit symbolic-ref -q HEAD 2>/dev/null)" = refs/heads/main ] &&
    [ "$(ongit rev-parse -q --verify HEAD 2>/dev/null)" = "$NEWC" ] &&
    ongit checkout -q --no-overwrite-ignore -B main "$OLDHEAD"; then
    echo "export-public: $ONTO is back on its previous commit ($OLD_SHORT); the failed commit is not on main" >&2
  else
    echo "export-public: could not put $ONTO back on its previous commit; look at it, then: git -C $(shell_word "$ONTO") reset --keep $OLD_SHORT" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "export-public: FAIL: $*" >&2; exit 1; }

# The tree is built and asserted in OUT_DIR, or (--onto) in a temporary folder, by the same code.
if [ -n "$ONTO" ]; then
  TREE="$TMP/tree"
  mkdir "$TREE" || fail "cannot create a temporary directory"
else
  TREE=$OUT
fi

# ---- 1. export --------------------------------------------------------------------------------------------------
git -C "$ROOT" archive --format=tar -o "$TMP/tree.tar" "$REF" || fail "git archive failed"
tar -xf "$TMP/tree.tar" -C "$TREE" || fail "could not unpack the archive"
rm -f "$TREE/pax_global_header" # older GNU tar unpacks git's commit-id comment as a file

# The OWNER placeholder, in every text file that has one. The files are rewritten in place (same inode, same mode).
# The pattern is spelled in two pieces so this script does not rewrite itself when it is exported and run again.
PLACEHOLDER="OWNER""/wasitme"
if [ -n "$OWNER_NAME" ]; then
  find "$TREE" -type f -exec grep -Il -F -e "$PLACEHOLDER" {} + 2>/dev/null | while IFS= read -r f; do
    sed "s|$PLACEHOLDER|$OWNER_NAME/wasitme|g" "$f" > "$TMP/owner.swap" && cat "$TMP/owner.swap" > "$f" || exit 1
  done || fail "could not replace the OWNER placeholder"
  # SECURITY.md's note that the advisory link is still a placeholder is false once the owner is in: drop that line.
  if [ -f "$TREE/SECURITY.md" ]; then
    grep -v -F '*(placeholder: `OWNER`' "$TREE/SECURITY.md" > "$TMP/owner.swap" && cat "$TMP/owner.swap" > "$TREE/SECURITY.md" ||
      fail "could not drop the placeholder note from SECURITY.md"
  fi
fi
LEFT=$(find "$TREE" -type f -exec grep -Il -F -e "$PLACEHOLDER" {} + 2>/dev/null | wc -l | tr -d ' ')

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
  if [ -e "$TREE/$p" ] || [ -L "$TREE/$p" ]; then echo "export-public: FAIL: internal path in the export: $p" >&2; bad=1; fi
done
for p in $MUST_SHIP; do
  [ -e "$TREE/$p" ] || { echo "export-public: FAIL: missing from the export: $p" >&2; bad=1; }
done
# Private notes under any directory, and local secrets or caches, wherever they sit.
stray=$(find "$TREE" \( -name CLAUDE.local.md -o -name .ci-local.env -o -name '*.cache.jsonl' -o -name .DS_Store \) -print 2>/dev/null | head -n 5)
if [ -n "$stray" ]; then echo "export-public: FAIL: local files in the export:" >&2; echo "$stray" | sed "s|^$TREE/|  |" >&2; bad=1; fi
# The configured private phrases, case-insensitively, in the contents of every file (binary files too: without -I,
# grep -l reads them and still prints only the file name) and in every file and folder name under the tree. Like the
# forbidden emails, a phrase is never printed: the message names its position in the configured list, and a path that
# holds it is shown with the phrase replaced by [phrase] (a path the mask cannot place prints as [path]).
mask_phrase() {  # mask_phrase PHRASE: paths on stdin, each shown indented, with the phrase masked wherever it is in one
  PH=$1 awk 'BEGIN { p = tolower(ENVIRON["PH"]) }
    { out = ""; rest = $0
      while ((i = index(tolower(rest), p)) > 0) { out = out substr(rest, 1, i - 1) "[phrase]"; rest = substr(rest, i + length(p)) }
      print "  " out rest }'
}
n=0
for ph in $PHRASES; do
  n=$((n + 1))
  hits=$(grep -rl -i -F -e "$ph" "$TREE" 2>/dev/null | sed "s|^$TREE/||" | head -n 5)
  names=$(cd "$TREE" && find . -mindepth 1 -print 2>/dev/null | sed 's|^\./||' | grep -i -F -e "$ph" | head -n 5)
  if [ -n "$hits" ] || [ -n "$names" ]; then
    echo "export-public: FAIL: forbidden phrase $n of $PHRASE_COUNT (in $PHRASE_SRC) found in:" >&2
    if [ -n "$hits" ]; then echo "$hits" | mask_phrase "$ph" >&2; fi
    if [ -n "$names" ]; then echo "  (a file or folder name:)" >&2; echo "$names" | mask_phrase "$ph" >&2; fi
    bad=1
  fi
done
set +f
IFS=$OLDIFS
[ "$bad" = 0 ] || fail "the export is not clean; fix .gitattributes or the files above"
if [ -n "$ONTO" ] && [ "$LEFT" -gt 0 ]; then
  fail "$LEFT file(s) still carry the OWNER placeholder, and the public repository already names its owner: pass --owner USERNAME"
fi

# ---- 3. one commit -----------------------------------------------------------------------------------------------
# A repository that ignores every global and system setting: no personal identity, hooks, signing or templates.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL"
if [ -z "$ONTO" ]; then
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
  TARGET=$OUT
else
  # The new tree, staged from the exported folder into a temporary index of DIR's repository: exactly the exported
  # files (-f: whatever a .gitignore says), byte for byte (no line-ending conversion), with their modes and symlinks
  # whatever DIR's own settings say about its file system. Only DIR's object store is written.
  ONTO_GIT=$(ongit rev-parse --absolute-git-dir) || fail "cannot find the git folder of $ONTO"
  ( cd "$TREE" && GIT_DIR="$ONTO_GIT" GIT_WORK_TREE="$TREE" GIT_INDEX_FILE="$TMP/index" \
      git -c core.autocrlf=false -c core.fileMode=true -c core.symlinks=true -c core.hooksPath=/dev/null \
      -c core.fsmonitor=false add -A -f ) || fail "could not stage the new tree"
  STAGED=$(GIT_DIR="$ONTO_GIT" GIT_INDEX_FILE="$TMP/index" git ls-files | wc -l | tr -d ' ')
  EXPORTED=$(find "$TREE" ! -type d | wc -l | tr -d ' ')
  [ "$STAGED" = "$EXPORTED" ] || fail "staged $STAGED files, but the export has $EXPORTED"
  NEWTREE=$(GIT_DIR="$ONTO_GIT" GIT_INDEX_FILE="$TMP/index" git write-tree) || fail "git write-tree failed"
  if [ "$NEWTREE" = "$(ongit rev-parse "$OLDHEAD^{tree}")" ]; then
    FAILED=0
    echo "export-public: nothing to update: $ONTO already holds this export of $REF (its HEAD, $OLD_SHORT, has the same tree)."
    echo "  No commit was made and nothing in $ONTO was changed."
    exit 0
  fi
  # One ordinary commit on top of HEAD, its message cleaned up the way `git commit -m` does it, dated in UTC.
  printf '%s\n' "$MESSAGE" | ongit stripspace > "$TMP/message" || fail "could not prepare the commit message"
  [ -s "$TMP/message" ] || fail "the commit message is empty"
  NEWC=$(TZ=UTC0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$ONTO" -c commit.gpgSign=false \
    commit-tree --no-gpg-sign -p "$OLDHEAD" -F "$TMP/message" "$NEWTREE") || fail "git commit-tree failed"
  # main fast-forwards to it: git updates the index and working tree, and refuses (changing nothing) if an untracked or
  # ignored file is in the way, instead of overwriting it. DIR's own merge settings (squash, autostash) do not apply.
  STAGE=applying
  if ! ongit -c branch.main.mergeOptions= -c merge.autoStash=false \
    merge -q --ff-only --no-squash --no-overwrite-ignore --no-verify-signatures --no-stat "$NEWC"; then
    if [ "$(ongit rev-parse -q --verify HEAD)" = "$OLDHEAD" ] && [ -z "$(ongit status --porcelain --untracked-files=no)" ]; then
      die "--onto: could not move $ONTO's main to the new commit (git's reason is above; an ignored file where the export adds one: move it away). Nothing was changed"
    fi
    fail "the update of $ONTO stopped part-way (git's reason is above); look at git status there"
  fi
  STAGE=committed
  [ "$(ongit rev-parse HEAD)" = "$NEWC" ] || fail "$ONTO's main is not on the new commit"
  [ -z "$(ongit status --porcelain --untracked-files=no)" ] || fail "$ONTO does not match the new commit after the update"
  COMMITS=$(ongit rev-list --count "$OLDHEAD..HEAD")
  [ "$COMMITS" = 1 ] || fail "expected exactly one new commit, found $COMMITS"
  FILES=$(ongit ls-files | wc -l | tr -d ' ')
  TARGET=$ONTO
fi

# ---- 4. checks on the new tree -----------------------------------------------------------------------------------
if [ "$CHECKS" = 1 ]; then
  [ "$EMAILS_LOADED" = 1 ] || load_forbidden_emails fail
  [ -f "$TARGET/scripts/check-repo.mjs" ] || fail "the export has no scripts/check-repo.mjs"
  echo "export-public: check-repo --strict on the new tree"
  # shellcheck disable=SC2086 # EMAIL_FLAG is empty or one fixed flag
  WASITME_FORBIDDEN_EMAILS="$EMAILS" node "$TARGET/scripts/check-repo.mjs" --root "$TARGET" --strict $EMAIL_FLAG || fail "check-repo --strict found problems"
  echo "export-public: check-repo --git-identity on the new tree"
  # shellcheck disable=SC2086
  WASITME_FORBIDDEN_EMAILS="$EMAILS" node "$TARGET/scripts/check-repo.mjs" --root "$TARGET" --git-identity $EMAIL_FLAG || fail "the commit identity check failed"
  echo "export-public: changelog fragments"
  ( cd "$TARGET" && node scripts/assemble-changelog.mjs --check ) || fail "changelog fragments are not well-formed"
  if [ -f "$TARGET/scripts/test/doc-links.test.mjs" ]; then
    echo "export-public: documentation links in the new tree"
    ( cd "$TARGET" && node --test scripts/test/doc-links.test.mjs ) >"$TMP/links.log" 2>&1 || { cat "$TMP/links.log" >&2; fail "a link in the public documentation does not resolve"; }
  fi
  if [ -z "$EMAILS" ]; then
    echo "export-public: WARNING: no forbidden email is configured, so that scan did NOT run. Set WASITME_FORBIDDEN_EMAILS (or .ci-local.env) and re-run before you publish, or use --require-email-config." >&2
  fi
fi
if [ "$PHRASE_COUNT" = 0 ]; then
  echo "export-public: WARNING: no forbidden phrase is configured, so the private-phrase scan did NOT run. Set WASITME_FORBIDDEN_PHRASES (or .ci-local.env) and re-run before you publish, or use --require-email-config." >&2
fi

if [ -n "$ONTO" ]; then
  # A tag or commit made in DIR later uses this identity, not whatever the machine's global config says.
  ongit config user.name "$NAME" && ongit config user.email "$EMAIL" ||
    echo "export-public: warning: could not set $ONTO's local git identity; check git config user.email there before you tag" >&2
  FAILED=0
  CHANGES=$(ongit diff --no-renames --name-status "$OLDHEAD" HEAD |
    awk '{ k = substr($1, 1, 1); c[k]++ } END { printf "%d added, %d changed, %d deleted", c["A"], c["M"] + c["T"], c["D"] }')
  HASH=$(ongit rev-parse --short HEAD)
  ALL=$(ongit rev-list --count HEAD)
  W=$(shell_word "$ONTO")
  echo ""
  echo "export-public: committed onto $ONTO"
  echo "  one new commit ($HASH) on main, on top of $OLD_SHORT: $CHANGES; $FILES files, $ALL commits in its history."
  echo "  identity: $NAME <$EMAIL> (now also $ONTO's local git identity)"
  echo "  Nothing was fetched or pushed, and no remote was added or changed. Review the commit, then push it yourself:"
  echo "    git -C $W show --stat"
  echo "    git -C $W push origin main"
  case " $(ongit remote | tr '\n' ' ') " in
    *" origin "*) ;;
    *) echo "  ($ONTO has no remote named origin: it should be a clone of the public repository.)" ;;
  esac
  exit 0
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
