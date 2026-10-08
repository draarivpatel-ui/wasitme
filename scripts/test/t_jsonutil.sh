#!/bin/sh
# scripts/lib/jsonutil.mjs: package/marketplace validation and the settings.json status line edits.
. "$(dirname "$0")/harness.sh"
J="$T_REPO/scripts/lib/jsonutil.mjs"
W="$T_ROOT/j"
mkdir -p "$W"

# jr ARGS...: run the helper; sets R (stdout), RC, ER (stderr)
jr() {
  R=$(node "$J" "$@" 2>"$W/err")
  RC=$?
  ER=$(cat "$W/err")
}

t_section "package"
printf '{"name":"wasitme","version":"1.2.3","bin":{"wasitme":"./dist/src/cli/main.js"},"dependencies":{}}' >"$W/p.json"
jr package "$W/p.json"
assert_eq 0 "$RC" "valid package.json accepted"
assert_contains "$R" "version=1.2.3" "version printed"
assert_contains "$R" "bin=dist/src/cli/main.js" "leading ./ stripped from bin"
assert_contains "$R" "deps=0" "dependency count printed"
printf '{"name":"wasitme","version":"1.2.3","bin":"dist/cli.js","dependencies":{"x":"1"}}' >"$W/p2.json"
jr package "$W/p2.json"
assert_contains "$R" "bin=dist/cli.js" "string-form bin accepted"
assert_contains "$R" "deps=1" "runtime dependencies are counted"
for bad in '"1.0"' '"../1.0.0"' '"1.0.0/../x"' '"latest"' '1' 'null'; do
  printf '{"version":%s,"bin":"a.js"}' "$bad" >"$W/p3.json"
  jr package "$W/p3.json"
  assert_eq 4 "$RC" "version $bad rejected"
done
for bad in '"/abs/main.js"' '"../up.js"' '"a/../../b.js"' '"a b.js"' 'null'; do
  printf '{"version":"1.0.0","bin":{"wasitme":%s}}' "$bad" >"$W/p4.json"
  jr package "$W/p4.json"
  assert_eq 4 "$RC" "bin $bad rejected"
done
printf 'not json' >"$W/p5.json"
jr package "$W/p5.json"
assert_eq 4 "$RC" "invalid JSON rejected"
jr package "$W/missing.json"
assert_eq 4 "$RC" "missing file rejected"

t_section "marketplace"
printf '{"name":"wasitme","owner":{"name":"x"},"plugins":[{"name":"wasitme","source":"./plugin"}]}' >"$W/m.json"
jr marketplace "$W/m.json"
assert_eq 0 "$RC" "valid marketplace accepted"
assert_contains "$R" "name=wasitme" "marketplace name printed"
assert_contains "$R" "plugin=wasitme" "plugin name printed"
assert_contains "$R" "source=./plugin" "local source printed"
printf '{"name":"has space","plugins":[{"name":"a","source":"./p"}]}' >"$W/m2.json"
jr marketplace "$W/m2.json"; assert_eq 4 "$RC" "marketplace name with a space rejected"
printf '{"name":"ok","plugins":[]}' >"$W/m3.json"
jr marketplace "$W/m3.json"; assert_eq 4 "$RC" "empty plugin list rejected"
printf '{"name":"ok","plugins":[{"name":"a","source":"./../x"}]}' >"$W/m4.json"
jr marketplace "$W/m4.json"; assert_eq 4 "$RC" "source with .. rejected"
printf '{"name":"ok","plugins":[{"name":"--evil"}]}' >"$W/m5.json"
jr marketplace "$W/m5.json"; assert_eq 4 "$RC" "option-like plugin names (leading dash) rejected"
printf '{"name":"ok","plugins":[{"name":"a b"}]}' >"$W/m6.json"
jr marketplace "$W/m6.json"; assert_eq 4 "$RC" "plugin name with a space rejected"
printf '{"name":"ok","plugins":[{"name":"a","source":{"source":"github","repo":"x/y"}}]}' >"$W/m7.json"
jr marketplace "$W/m7.json"; assert_eq 0 "$RC" "object-form (remote) source is accepted and not listed"
assert_not_contains "$R" "source=" "remote sources are not reported as local"

t_section "statusline-state"
CMD="/usr/bin/node /opt/wasitme/main.js status"
jr statusline-state "$W/nope.json" "$CMD";             assert_eq "absent-file" "$R" "missing settings.json -> absent-file"
printf '{"theme":"dark"}\n' >"$W/s1.json"
jr statusline-state "$W/s1.json" "$CMD";               assert_eq "none" "$R" "no statusLine key -> none"
printf '{"statusLine":null}\n' >"$W/s2.json"
jr statusline-state "$W/s2.json" "$CMD";               assert_eq "none" "$R" "statusLine: null counts as none"
printf '{"statusLine":{"type":"command","command":"%s"}}\n' "$CMD" >"$W/s3.json"
jr statusline-state "$W/s3.json" "$CMD";               assert_eq "ours" "$R" "same command -> ours"
printf '{"statusLine":{"type":"command","command":"ccstatusline"}}\n' >"$W/s4.json"
jr statusline-state "$W/s4.json" "$CMD";               assert_eq "present" "$R" "different command -> present"
printf '{ nope' >"$W/s5.json"
jr statusline-state "$W/s5.json" "$CMD";               assert_eq "invalid" "$R" "broken JSON -> invalid"
printf '[1,2]' >"$W/s6.json"
jr statusline-state "$W/s6.json" "$CMD";               assert_eq "invalid" "$R" "JSON array -> invalid"
: >"$W/s7.json"
jr statusline-state "$W/s7.json" "$CMD";               assert_eq "none" "$R" "empty file is treated as an empty object"

t_section "statusline-add"
# 4-space indent, trailing newline, mode 600: all preserved; other keys untouched; backup identical.
printf '{\n    "theme": "dark",\n    "env": { "A": "1" }\n}\n' >"$W/a1.json"
chmod 600 "$W/a1.json"
cp "$W/a1.json" "$W/a1.orig"
jr statusline-add "$W/a1.json" "$CMD" "$W/a1.bak"
assert_eq 0 "$RC" "add succeeds when there is no statusLine"
assert_contains "$R" "backup=$W/a1.bak" "backup path reported"
assert_same_file "$W/a1.orig" "$W/a1.bak" "backup is byte-identical to the original"
assert_eq "dark" "$(json_get "$W/a1.json" 'd.theme')" "other keys preserved"
assert_eq "1" "$(json_get "$W/a1.json" 'd.env.A')" "nested keys preserved"
assert_eq "command" "$(json_get "$W/a1.json" 'd.statusLine.type')" "statusLine.type is command"
assert_eq "$CMD" "$(json_get "$W/a1.json" 'd.statusLine.command')" "statusLine.command is ours"
assert_eq "0" "$(json_get "$W/a1.json" 'd.statusLine.padding')" "statusLine.padding is 0 (the engine's own fragment)"
assert_file_has "$W/a1.json" '    "theme": "dark"' "4-space indentation preserved"
assert_eq "-rw-------" "$(ls -l "$W/a1.json" | cut -c1-10)" "file mode preserved (600)"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
assert_eq "$(shasum -a 256 "$W/a1.json" | cut -d' ' -f1)" "$SHA" "reported sha matches the written file"
case $(tail -c1 "$W/a1.json" | od -An -c | tr -d ' ') in '\n') t_pass ;; *) t_fail "trailing newline kept" ;; esac
jr statusline-add "$W/a1.json" "$CMD" "$W/a1.bak2"
assert_eq 10 "$RC" "second add refuses: a statusLine now exists"
assert_missing "$W/a1.bak2" "no backup made on refusal"

printf '{"statusLine":{"type":"command","command":"mine"}}' >"$W/a2.json"
cp "$W/a2.json" "$W/a2.orig"
jr statusline-add "$W/a2.json" "$CMD" "$W/a2.bak"
assert_eq 10 "$RC" "existing foreign statusLine -> exit 10"
assert_same_file "$W/a2.orig" "$W/a2.json" "foreign statusLine file untouched"
assert_missing "$W/a2.bak" "no backup made when nothing changes"

printf '{ broken' >"$W/a3.json"
cp "$W/a3.json" "$W/a3.orig"
jr statusline-add "$W/a3.json" "$CMD" "$W/a3.bak"
assert_eq 12 "$RC" "invalid JSON -> exit 12"
assert_same_file "$W/a3.orig" "$W/a3.json" "invalid file untouched"
assert_missing "$W/a3.bak" "no backup for an invalid file"

jr statusline-add "$W/a4.json" "$CMD" "$W/a4.bak"
assert_eq 0 "$RC" "add creates settings.json when absent"
assert_contains "$R" "backup=-" "no backup when the file did not exist"
assert_eq "-rw-------" "$(ls -l "$W/a4.json" | cut -c1-10)" "a newly created settings.json is private (600)"
assert_eq "$CMD" "$(json_get "$W/a4.json" 'd.statusLine.command')" "created file has our statusLine"

# No trailing newline stays that way; tabs stay tabs.
printf '{\n\t"theme": "dark"\n}' >"$W/a5.json"
jr statusline-add "$W/a5.json" "$CMD" "$W/a5.bak"
assert_file_has "$W/a5.json" "$(printf '\t"theme"')" "tab indentation preserved"
case $(tail -c1 "$W/a5.json" | od -An -c | tr -d ' ') in '}') t_pass ;; *) t_fail "missing trailing newline stays missing" ;; esac

# Dotfile managers symlink settings.json: the link must survive, the target gets the edit.
mkdir -p "$W/dots"
printf '{"theme":"light"}\n' >"$W/dots/settings.json"
ln -s "$W/dots/settings.json" "$W/a6.json"
jr statusline-add "$W/a6.json" "$CMD" "$W/a6.bak"
assert_eq 0 "$RC" "add through a symlink succeeds"
assert_link "$W/a6.json" "$W/dots/settings.json" "the symlink is still a symlink"
assert_eq "$CMD" "$(json_get "$W/dots/settings.json" 'd.statusLine.command')" "the link target was edited"

# Failed write: the backup must not be left behind.
mkdir -p "$W/ro"
printf '{"a":1}\n' >"$W/ro/settings.json"
chmod 555 "$W/ro"
jr statusline-add "$W/ro/settings.json" "$CMD" "$W/ro.bak"
chmod 755 "$W/ro"
if [ "$(id -u)" != 0 ]; then
  assert_eq 1 "$RC" "unwritable directory -> exit 1"
  assert_missing "$W/ro.bak" "backup removed after a failed write"
  assert_eq '{"a":1}' "$(tr -d '\n' <"$W/ro/settings.json")" "original untouched after a failed write"
fi

t_section "statusline-replace"
NEWCMD="/other/node /opt/wasitme/main.js status"
# Our statusLine: the command changes, nothing else does (including keys the user added to the statusLine object).
printf '{\n    "theme": "dark",\n    "statusLine": { "type": "command", "command": "%s", "padding": 2 }\n}\n' "$CMD" >"$W/rp1.json"
chmod 600 "$W/rp1.json"
jr statusline-replace "$W/rp1.json" "$CMD" "$NEWCMD"
assert_eq 0 "$RC" "replace succeeds when the statusLine is the one we added"
assert_eq "$NEWCMD" "$(json_get "$W/rp1.json" 'd.statusLine.command')" "the command is the new one"
assert_eq "2" "$(json_get "$W/rp1.json" 'd.statusLine.padding')" "a key the user added to the statusLine is kept"
assert_eq "dark" "$(json_get "$W/rp1.json" 'd.theme')" "other keys preserved"
assert_file_has "$W/rp1.json" '    "theme": "dark"' "indentation preserved"
assert_eq "-rw-------" "$(ls -l "$W/rp1.json" | cut -c1-10)" "file mode preserved"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
assert_eq "$(shasum -a 256 "$W/rp1.json" | cut -d' ' -f1)" "$SHA" "reported sha matches the written file"
jr statusline-replace "$W/rp1.json" "$CMD" "$NEWCMD"
assert_eq 10 "$RC" "replacing again with the old command no longer matches: exit 10"
# The user's own statusLine is never replaced.
printf '{"statusLine":{"type":"command","command":"mine"}}\n' >"$W/rp2.json"
cp "$W/rp2.json" "$W/rp2.orig"
jr statusline-replace "$W/rp2.json" "$CMD" "$NEWCMD"
assert_eq 10 "$RC" "a statusLine that is not ours -> exit 10"
assert_same_file "$W/rp2.orig" "$W/rp2.json" "and the file is untouched"
printf '{"theme":"dark"}\n' >"$W/rp3.json"
jr statusline-replace "$W/rp3.json" "$CMD" "$NEWCMD"
assert_eq 10 "$RC" "no statusLine at all -> exit 10"
jr statusline-replace "$W/rp-missing.json" "$CMD" "$NEWCMD"
assert_eq 10 "$RC" "no settings.json -> exit 10"
assert_missing "$W/rp-missing.json" "and none is created"
printf '{ broken' >"$W/rp4.json"
cp "$W/rp4.json" "$W/rp4.orig"
jr statusline-replace "$W/rp4.json" "$CMD" "$NEWCMD"
assert_eq 12 "$RC" "invalid JSON -> exit 12"
assert_same_file "$W/rp4.orig" "$W/rp4.json" "invalid file untouched"
# Through a dotfile symlink.
mkdir -p "$W/rpdots"
printf '{"statusLine":{"type":"command","command":"%s"}}\n' "$CMD" >"$W/rpdots/settings.json"
ln -s "$W/rpdots/settings.json" "$W/rp5.json"
jr statusline-replace "$W/rp5.json" "$CMD" "$NEWCMD"
assert_eq 0 "$RC" "replace through a symlink"
assert_link "$W/rp5.json" "$W/rpdots/settings.json" "the symlink survives"
assert_eq "$NEWCMD" "$(json_get "$W/rpdots/settings.json" 'd.statusLine.command')" "the link target was edited"
# add -> replace -> restore: the original bytes still come back (the checksum the manifest keeps is the replaced file's).
cp "$W/a1.orig" "$W/rp6.json"
jr statusline-add "$W/rp6.json" "$CMD" "$W/rp6.bak"
jr statusline-replace "$W/rp6.json" "$CMD" "$NEWCMD"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
jr statusline-restore "$W/rp6.json" "$W/rp6.bak" "$SHA" "$NEWCMD"
assert_eq "restored" "$R" "restore after a replace puts the original bytes back"
assert_same_file "$W/a1.orig" "$W/rp6.json" "byte-identical to the file before wasitme"
# And a replace undone by a replace gives back the exact bytes (the rollback path).
cp "$W/a1.orig" "$W/rp7.json"
jr statusline-add "$W/rp7.json" "$CMD" "$W/rp7.bak"
cp "$W/rp7.json" "$W/rp7.added"
jr statusline-replace "$W/rp7.json" "$CMD" "$NEWCMD"
jr statusline-replace "$W/rp7.json" "$NEWCMD" "$CMD"
assert_same_file "$W/rp7.added" "$W/rp7.json" "replacing back reproduces the earlier file exactly"
jr statusline-replace "$W/rp7.json" "$CMD"
assert_eq 2 "$RC" "missing arguments -> exit 2"

t_section "statusline-restore"
# Untouched since we edited it: exact original bytes come back, backup is consumed.
cp "$W/a1.orig" "$W/r1.json"
jr statusline-add "$W/r1.json" "$CMD" "$W/r1.bak"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
jr statusline-restore "$W/r1.json" "$W/r1.bak" "$SHA" "$CMD"
assert_eq "restored" "$R" "untouched file is restored from the backup"
assert_same_file "$W/a1.orig" "$W/r1.json" "restored bytes equal the original"
assert_missing "$W/r1.bak" "backup consumed after restore"

# Edited afterwards: only our statusLine goes, the user's edit stays, backup stays.
cp "$W/a1.orig" "$W/r2.json"
jr statusline-add "$W/r2.json" "$CMD" "$W/r2.bak"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.added="by user";fs.writeFileSync(f,JSON.stringify(d,null,4)+"\n")' "$W/r2.json"
jr statusline-restore "$W/r2.json" "$W/r2.bak" "$SHA" "$CMD"
assert_eq "removed" "$R" "edited file: only our statusLine is removed"
assert_eq "by user" "$(json_get "$W/r2.json" 'd.added')" "the user's later edit is kept"
assert_eq "undefined" "$(json_get "$W/r2.json" 'd.statusLine')" "our statusLine is gone"
assert_file "$W/r2.bak" "backup kept when we could not restore byte-for-byte"

# The user replaced our statusLine with theirs: leave it.
cp "$W/a1.orig" "$W/r3.json"
jr statusline-add "$W/r3.json" "$CMD" "$W/r3.bak"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.statusLine={type:"command",command:"theirs"};fs.writeFileSync(f,JSON.stringify(d,null,4)+"\n")' "$W/r3.json"
jr statusline-restore "$W/r3.json" "$W/r3.bak" "$SHA" "$CMD"
assert_eq "left" "$R" "a statusLine that is not ours is left alone"
assert_eq "theirs" "$(json_get "$W/r3.json" 'd.statusLine.command')" "their statusLine intact"

# File we created: deleted again if untouched.
rm -f "$W/r4.json"
jr statusline-add "$W/r4.json" "$CMD" "$W/r4.bak"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
jr statusline-restore "$W/r4.json" "-" "$SHA" "$CMD"
assert_eq "restored" "$R" "created file reported as restored"
assert_missing "$W/r4.json" "the settings.json we created is deleted again"
jr statusline-restore "$W/r4.json" "-" "$SHA" "$CMD"
assert_eq "absent" "$R" "restoring a missing file is harmless"

# A recorded checksum of "-" (the installer could not promise an exact restore) never matches: only our key goes.
cp "$W/a1.orig" "$W/r5.json"
jr statusline-add "$W/r5.json" "$CMD" "$W/r5.bak"
jr statusline-restore "$W/r5.json" "$W/r5.bak" "-" "$CMD"
assert_eq "removed" "$R" "sha '-': the surgical path, never the byte-for-byte restore"
assert_file "$W/r5.json" "the file is not deleted"
assert_eq "undefined" "$(json_get "$W/r5.json" 'd.statusLine')" "our statusLine is gone"
assert_file "$W/r5.bak" "the backup is kept"
rm -f "$W/r6.json"
jr statusline-add "$W/r6.json" "$CMD" "$W/r6.bak"
jr statusline-restore "$W/r6.json" "-" "-" "$CMD"
assert_eq "removed" "$R" "sha '-' on a file we created: the file stays"
assert_file "$W/r6.json" "not deleted"

t_section "hooks-list (growth check)"
printf '{"modules":["../mod/register.ts"],"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"/bin/sh a.sh","async":true}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"/bin/sh b.sh","timeout":10}]}]}}' >"$W/h1.json"
jr hooks-list "$W/h1.json"
assert_eq 0 "$RC" "hooks.json accepted"
assert_eq "$(printf 'hook\tSessionEnd\t*\tcommand\t/bin/sh b.sh\nhook\tSessionStart\tstartup|resume\tcommand\t/bin/sh a.sh\nmodule\t../mod/register.ts')" "$R" "one sorted line per hook (a missing matcher is *) and per module; async/timeout do not matter"
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"x\\ny"}]}]}}' >"$W/h2.json"
jr hooks-list "$W/h2.json"
assert_eq "$(printf 'hook\tSessionStart\t*\tcommand\tx y')" "$R" "a newline inside a command cannot forge a second line"
printf '[1]' >"$W/h3.json"; jr hooks-list "$W/h3.json"; assert_eq 4 "$RC" "not an object -> 4"

t_section "validate-calls"
printf 'Validating x\n./register.tsx hooks: session.start\n./register.tsx calls: $.clock.now (via load), $.fs.read, $.ui.open\n./other.tsx calls: $.fs.read, $.state.get\n' >"$W/v.txt"
jr validate-calls "$W/v.txt"
assert_eq "$(printf '%s\n' '$.clock.now' '$.fs.read' '$.state.get' '$.ui.open')" "$R" "calls from every module, '(via ...)' stripped, de-duplicated and sorted"

t_section "codex-root"
CR="$W/cx"
mkroot() {  # mkroot V1 V2: a Codex root with .codex-plugin/plugin.json at V1 and plugin.json at V2 (- = absent)
  rm -rf "$CR"; mkdir -p "$CR/.agents/plugins" "$CR/.codex-plugin" "$CR/skills/report"
  printf '{"name":"wasitme-codex","plugins":[{"name":"wasitme","source":"./"}]}' >"$CR/.agents/plugins/marketplace.json"
  [ "$1" = - ] || printf '{"name":"wasitme","version":"%s"}' "$1" >"$CR/.codex-plugin/plugin.json"
  [ "$2" = - ] || printf '{"name":"wasitme","version":"%s"}' "$2" >"$CR/plugin.json"
}
mkroot 0.2.0 0.2.0
jr codex-root "$CR" 0.2.0
assert_eq 0 "$RC" "a root whose two plugin.json files match the release is accepted"
assert_eq "$(printf 'name=wasitme-codex\nplugin=wasitme')" "$R" "marketplace and plugin names"
mkroot 0.2.0 -; jr codex-root "$CR" 0.2.0; assert_eq 0 "$RC" "either manifest alone is enough (S-CX 2.4)"
mkroot 0.2.0 9.9.9; jr codex-root "$CR" 0.2.0
assert_eq 4 "$RC" "two plugin.json files with different versions are refused (Codex would install the root one)"
assert_contains "$ER" "generated from one source" "message says why"
mkroot 0.1.0 0.1.0; jr codex-root "$CR" 0.2.0; assert_eq 4 "$RC" "a root older than the engine it ships with is refused"
mkroot - -; jr codex-root "$CR" 0.2.0; assert_eq 4 "$RC" "no plugin.json at all is refused"
mkroot 0.2.0 0.2.0; mkdir -p "$CR/hooks"; jr codex-root "$CR" 0.2.0
assert_eq 4 "$RC" "a hooks folder is refused: Codex gets skills only"
mkroot 0.2.0 0.2.0; printf '{"name":"wasitme-codex","plugins":[{"name":"wasitme","source":"./plugin"}]}' >"$CR/.agents/plugins/marketplace.json"
jr codex-root "$CR" 0.2.0; assert_eq 4 "$RC" "the plugin's source must be the root itself"

t_section "known-marketplace"
printf '{"wasitme":{"source":{"source":"directory","path":"/x/current"}}}' >"$W/km.json"
jr known-marketplace "$W/km.json" wasitme; assert_eq "present" "$R" "a registered name"
jr known-marketplace "$W/km.json" other; assert_eq "absent" "$R" "another name"
jr known-marketplace "$W/none.json" wasitme; assert_eq "absent" "$R" "no file"

t_section "toml-remove (the Codex fallback)"
printf '# top\nmodel = "x"\n\n[marketplaces.wasitme-codex]\nsource_type = "local"\nsource = "/v/plugin-codex"\n\n[plugins."wasitme@wasitme-codex"]\nenabled = true\n\n[plugins."other@m"]\nenabled = true\n' >"$W/c.toml"
chmod 640 "$W/c.toml"
jr toml-remove "$W/c.toml" 'plugins."wasitme@wasitme-codex"' 'marketplaces.wasitme-codex'
assert_eq "removed=2" "$R" "both tables found"
assert_eq "$(printf '# top\nmodel = "x"\n\n[plugins."other@m"]\nenabled = true')" "$(cat "$W/c.toml")" "exactly those tables are gone; another plugin's table is kept"
assert_eq "-rw-r-----" "$(ls -l "$W/c.toml" | cut -c1-10)" "the file keeps its mode"
jr toml-remove "$W/c.toml" 'plugins."wasitme@wasitme-codex"'; assert_eq "removed=0" "$R" "a second run removes nothing"

t_section "rc-add / rc-remove (the PATH line)"
LINE='export PATH="$HOME/.local/bin:$PATH"'
printf '# mine\nexport A=1' >"$W/rc"
cp "$W/rc" "$W/rc.orig"
jr rc-add "$W/rc" "$LINE" "$W/rc.bak"
assert_eq 0 "$RC" "rc-add"
assert_same_file "$W/rc.orig" "$W/rc.bak" "backup first, byte for byte"
assert_contains "$(cat "$W/rc")" "$(printf 'export A=1\n# Added by the wasitme installer')" "a missing final newline is added before the block"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
jr rc-remove "$W/rc" "$W/rc.bak" "$SHA" "$LINE"
assert_eq "restored" "$R" "untouched since: the original bytes come back"
assert_same_file "$W/rc.orig" "$W/rc" "byte for byte"
assert_missing "$W/rc.bak" "and the backup is consumed"
jr rc-add "$W/rc" "$LINE" "$W/rc.bak"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
printf 'export B=2\n' >>"$W/rc"
jr rc-remove "$W/rc" "$W/rc.bak" "$SHA" "$LINE"
assert_eq "removed" "$R" "edited since: only the two wasitme lines are removed"
assert_eq "$(printf '# mine\nexport A=1\nexport B=2')" "$(cat "$W/rc")" "the person's later line is kept"
jr rc-remove "$W/rc" "-" "x" "$LINE"; assert_eq "left" "$R" "nothing of ours left: left alone"
jr rc-add "$W/new-rc" "$LINE" "$W/new-rc.bak"
assert_contains "$R" "backup=-" "a profile that did not exist has no backup"
SHA=$(printf '%s\n' "$R" | sed -n 's/^sha=//p')
jr rc-remove "$W/new-rc" "-" "$SHA" "$LINE"
assert_missing "$W/new-rc" "and is deleted again"

t_section "sha256 and usage"
printf 'hello' >"$W/h.txt"
jr sha256 "$W/h.txt"
assert_eq "$(shasum -a 256 "$W/h.txt" | cut -d' ' -f1)" "$R" "sha256 matches shasum"
jr sha256 "$W/none.txt"; assert_eq "-" "$R" "sha256 of a missing file is -"
jr nonsense; assert_eq 2 "$RC" "unknown command -> exit 2"
jr statusline-add "$W/x.json"; assert_eq 2 "$RC" "missing arguments -> exit 2"

t_done
