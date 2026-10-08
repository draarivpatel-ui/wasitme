#!/bin/sh
# scripts/release.sh (WP-95): the release tarball, its allow-list, the stamped install.sh, SHA256SUMS, and the install
# from the tarball into a throwaway HOME that release.sh runs itself. The full build runs from the working tree
# (--worktree, a temporary git index), so it tests the change in front of you, committed or not. Nothing is published.
. "$(dirname "$0")/harness.sh"

REL="$T_REPO/scripts/release.sh"

t_section "install.sh's default URL names an asset release.sh writes"
DEF=$(sed -n 's/^WASITME_DEFAULT_URL="\(.*\)"$/\1/p' "$T_REPO/scripts/install.sh")
assert_contains "$DEF" "/releases/latest/download/" "the repository copy downloads the latest release"
assert_eq "wasitme.tar.gz" "${DEF##*/}" "under the stable asset name"
assert_file_has "$REL" 'STABLE_ASSET="wasitme.tar.gz"' "which is the name release.sh writes"
assert_line "$T_REPO/scripts/install.sh" 'WASITME_DEFAULT_SHA256=""' "the repository copy carries no checksum (release.sh stamps the asset)"

t_section "--check-stage: the allow-list, the required files and the content scan"
sb_new
ST="$SB/stage/wasitme-9.9.9"
mkdir -p "$ST"
for f in $(sed -n '/^REQUIRED="/,/"$/p' "$REL" | sed 's/^REQUIRED="//; s/"$//'); do
  mkdir -p "$ST/$(dirname "$f")"
  printf 'synthetic\n' >"$ST/$f"
done
check() { T_OUT="$SB/out.txt"; T_ERR="$SB/err.txt"; "$SH_BIN" "$REL" --check-stage "$ST" >"$T_OUT" 2>"$T_ERR"; T_RC=$?; }
check
assert_rc 0 "a tree with exactly the required files passes"
assert_contains "$(out)" "all on the allow-list" "and says so"
mkdir -p "$ST/plugin/tests" && printf 'x\n' >"$ST/plugin/tests/a.test.ts"
check
assert_rc 1 "plugin/tests is never shipped"
assert_contains "$(err)" "not on the allow-list: plugin/tests/a.test.ts" "the file is named"
rm -rf "$ST/plugin/tests"
printf 'x\n' >"$ST/CLAUDE.md"
check
assert_rc 1 "a file outside the allow-list (internal notes)"
assert_contains "$(err)" "not on the allow-list: CLAUDE.md" "is named"
rm -f "$ST/CLAUDE.md"
mkdir -p "$ST/engine/dist/src/synth" && printf 'x\n' >"$ST/engine/dist/src/synth/gen.js"
check
assert_rc 1 "the development-only engine folders are refused"
rm -rf "$ST/engine/dist/src/synth"
mkdir -p "$ST/ui/dist/out" && printf 'x\n' >"$ST/ui/dist/out/a.png"
check
assert_rc 1 "an out/ folder is refused"
rm -rf "$ST/ui/dist/out"
ln -s ../LICENSE "$ST/engine/LICENSE"
check
assert_rc 1 "a symbolic link is refused"
assert_contains "$(err)" "symbolic link (not allowed): engine/LICENSE" "and named"
rm -f "$ST/engine/LICENSE"
rm -f "$ST/packaging/statusline.sh"
check
assert_rc 1 "a required file that is missing"
assert_contains "$(err)" "required but missing: packaging/statusline.sh" "is named"
printf 'synthetic\n' >"$ST/packaging/statusline.sh"
# A home path in the shipped (compiled) engine; assembled from pieces so this file does not trip the repo greps.
printf 'const p = "%s";\n' "$(printf '/%s/%s/%s' Users jdoe projects)" >"$ST/engine/dist/src/leak.js"
check
assert_rc 1 "an absolute home path inside engine/dist is found (dist/ is scanned in a release tree)"
assert_contains "$(err)" "engine/dist/src/leak.js:1: [abs-home-path]" "the file and line are named"
assert_not_contains "$(err)$(out)" "jdoe" "the name itself is never echoed"
rm -f "$ST/engine/dist/src/leak.js"
printf '<link rel="stylesheet" href="https://fonts.example.test/x.css">\n' >"$ST/ui/dist/app.html"
check
assert_rc 1 "a shipped page that loads a remote stylesheet"
assert_contains "$(err)" "[remote-asset-url]" "is a finding"
printf 'synthetic\n' >"$ST/ui/dist/app.html"
check
assert_rc 0 "clean again"

# The full build needs the repository's own TypeScript (npm ci) and git; without them this is a loud skip.
if [ ! -f "$T_REPO/node_modules/typescript/bin/tsc" ] || ! git -C "$T_REPO" rev-parse --git-dir >/dev/null 2>&1; then
  printf '%s: the full release build was skipped (needs git and npm ci in %s)\n' "$T_NAME" "$T_REPO"
  t_done
fi

t_section "a full release from the working tree"
sb_new
OUT="$SB/out"
GS_BEFORE=$(git -C "$T_REPO" status --porcelain)
IDX_BEFORE=$(git -C "$T_REPO" diff --cached --name-status)
T_OUT="$SB/rel.out"; T_ERR="$SB/rel.err"
"$SH_BIN" "$REL" --worktree --out "$OUT" >"$T_OUT" 2>"$T_ERR"
T_RC=$?
assert_rc 0 "release.sh --worktree"
V=$(node -p 'require(process.argv[1]).version' "$T_REPO/engine/package.json")
for f in "wasitme-$V.tgz" wasitme.tar.gz install.sh SHA256SUMS; do assert_file "$OUT/$f" "asset $f written"; done
assert_same_file "$OUT/wasitme-$V.tgz" "$OUT/wasitme.tar.gz" "the stable-name asset is the same tarball"
assert_eq "OK OK OK" "$(cd "$OUT" && shasum -a 256 -c SHA256SUMS | awk '{ print $2 }' | tr '\n' ' ' | sed 's/ $//')" "SHA256SUMS checks out for all three"
SHA=$(shasum -a 256 "$OUT/wasitme-$V.tgz" | cut -d' ' -f1)
assert_line "$OUT/install.sh" "WASITME_DEFAULT_SHA256=\"$SHA\"" "install.sh carries the tarball's SHA-256"
assert_eq "wasitme-$V.tgz" "$(sed -n 's/^WASITME_DEFAULT_URL="\(.*\)"$/\1/p' "$OUT/install.sh" | sed 's|.*/||')" "and downloads that exact tarball"
assert_contains "$(sed -n 's/^WASITME_DEFAULT_URL="\(.*\)"$/\1/p' "$OUT/install.sh")" "/releases/download/v$V/" "from the release of this version"
assert_eq "-rwxr-xr-x" "$(ls -l "$OUT/install.sh" | cut -c1-10)" "install.sh is executable"
tar -tzf "$OUT/wasitme-$V.tgz" >"$SB/list"
assert_eq "wasitme-$V" "$(cut -d/ -f1 "$SB/list" | sort -u)" "one top folder, wasitme-<version>"
for f in VERSION LICENSE README.md engine/dist/src/cli/main.js engine/package.json ui/dist/app.html ui/dist/app.js \
  ui/dist/app.css packaging/statusline.sh scripts/install.sh scripts/uninstall.sh scripts/lib/common.sh \
  plugin/hooks/hooks.json plugin-codex/.codex-plugin/plugin.json macos/Package.swift design/system/fonts/OFL.txt \
  design/system/glyphs/appicon-1024.svg; do
  assert_line "$SB/list" "wasitme-$V/$f" "the tarball has $f"
done
for bad in CLAUDE.md docs/ plugin/tests/ engine/dist/test/ engine/dist/src/synth/ engine/dist/src/analysis/calibration/ \
  engine/src/ ui/src/ ui/dist/shots/ macos/Tests/ spikes-tracked/ testdata/ .github/ node_modules/ changelog.d/; do
  assert_eq "0" "$(grep -c "^wasitme-$V/$bad" "$SB/list")" "the tarball has no $bad"
done
assert_eq "$V" "$(tar -xzOf "$OUT/wasitme-$V.tgz" "wasitme-$V/VERSION")" "VERSION is stamped"
assert_contains "$(out)" "install (dry run, then real, no npm), doctor, status line, uninstall --purge: ok" "it installed the tarball into a throwaway HOME, used it and removed it"
assert_contains "$(out)" "Nothing was published" "and says nothing was published"
if grep -q '^WASITME_DEFAULT_URL=.*OWNER' "$T_REPO/scripts/install.sh"; then
  assert_contains "$(out)" "PLACEHOLDER: the GitHub owner is not known yet" "the OWNER placeholders are listed"
fi
assert_eq "$GS_BEFORE" "$(git -C "$T_REPO" status --porcelain)" "the checkout's files are exactly as they were"
assert_eq "$IDX_BEFORE" "$(git -C "$T_REPO" diff --cached --name-status)" "and so is its index (a temporary one was used)"
assert_eq "0" "$(ls -A "$SB/tmp" | wc -l | tr -d ' ')" "the work directory was removed"

t_section "the same tree builds the same bytes"
"$SH_BIN" "$REL" --worktree --no-verify --out "$SB/out2" >"$SB/rel2.out" 2>&1
assert_same_file "$OUT/wasitme-$V.tgz" "$SB/out2/wasitme-$V.tgz" "a second build of the same tree is byte-identical (sorted, fixed time, owner 0, gzip -n)"

t_section "--strict is the publishing gate"
"$SH_BIN" "$REL" --strict --worktree >"$SB/s.out" 2>"$SB/s.err"
assert_eq "2" "$?" "--strict releases a commit, never a working tree"
if grep -q '^WASITME_DEFAULT_URL=.*OWNER' "$T_REPO/scripts/install.sh"; then
  T_OUT="$SB/s.out"; T_ERR="$SB/s.err"
  "$SH_BIN" "$REL" --strict --out "$SB/out3" >"$T_OUT" 2>"$T_ERR"
  T_RC=$?
  assert_rc 1 "--strict refuses while OWNER placeholders remain"
  assert_contains "$(err)" "OWNER placeholders are still in public files" "and says so"
  assert_contains "$(err)" "PLACEHOLDER: scripts/install.sh" "naming each one"
  assert_missing "$SB/out3" "before building anything"
fi

t_done
