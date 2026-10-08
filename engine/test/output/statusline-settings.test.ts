/**
 * Installing and removing wasitme's status line in Claude Code's settings.json (WP-62): a targeted text edit with an
 * EXACT restore. Every case runs in a temp CLAUDE_CONFIG_DIR and WASITME_HOME; the real settings are never read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installStatusLine, ourFragment, statusLineFiles, statusLineState, StatusLineError, uninstallStatusLine } from "../../src/statusline/settings.js";
import { ROOT } from "./cases.js";

const SCRIPT = `${ROOT}packaging/statusline.sh`;

interface Env { root: string; claude: string; home: string; settings: string; files: ReturnType<typeof statusLineFiles>; cleanup(): void }
function env(): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wasitme-sl-")));
  const claude = join(root, "claude");
  const home = join(root, "wasitme");
  mkdirSync(claude);
  mkdirSync(home);
  const files = statusLineFiles(claude, home);
  return { root, claude, home, settings: files.settings, files, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const USER_CMD = { type: "command", command: "~/.claude/my-status.sh --fancy \"x\" 'y' $HOME", padding: 1 };

/** Settings files in the shapes real ones come in. */
const SHAPES: Record<string, string | null> = {
  "no file": null,
  "empty object": "{}\n",
  "empty object, no newline": "{}",
  "compact": '{"model":"opus","env":{"A":"1"}}',
  "pretty, 2 spaces": `${JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"], deny: [] }, env: { A: "1" } }, null, 2)}\n`,
  "pretty, 4 spaces": `${JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }, null, 4)}\n`,
  "pretty, tabs": `${JSON.stringify({ a: 1, b: [1, 2, { c: 3 }] }, null, "\t")}\n`,
  "CRLF": `${JSON.stringify({ a: 1, b: { c: 2 } }, null, 2).replace(/\n/g, "\r\n")}\r\n`,
  "odd spacing": '{ "a" : 1 ,\n   "b":   [ 1,2 , 3 ]  ,"c":{"statusLine":"not the top level"} }\n',
  "BOM": "\ufeff{\n  \"a\": 1\n}\n",
  "a key named like it, nested": `${JSON.stringify({ env: { statusLine: "x" }, list: [{ statusLine: 1 }] }, null, 2)}\n`,
  "unicode and escapes": `${JSON.stringify({ greeting: "héllo ☃ \"q\" \\ /", e: "\u001b[2J" }, null, 2)}\n`,
  "existing status line, last": `${JSON.stringify({ model: "opus", statusLine: USER_CMD }, null, 2)}\n`,
  "existing status line, first": `${JSON.stringify({ statusLine: USER_CMD, model: "opus", env: {} }, null, 2)}\n`,
  "existing status line, only key": `${JSON.stringify({ statusLine: USER_CMD }, null, 2)}\n`,
  "existing status line, compact": `{"a":1,"statusLine":${JSON.stringify(USER_CMD)},"z":2}`,
  "existing status line, odd value": '{\n  "statusLine":   {"type":"command"  ,\n "command": "echo hi"},\n  "x": 1\n}\n',
  "existing status line, not a command": `${JSON.stringify({ statusLine: { type: "text", text: "hello" }, a: 1 }, null, 2)}\n`,
  "existing status line, a string": '{"statusLine": "legacy", "a": 1}\n',
  "duplicate keys (last wins)": '{\n  "statusLine": {"type":"command","command":"first"},\n  "statusLine": {"type":"command","command":"second"}\n}\n',
};

for (const [name, text] of Object.entries(SHAPES)) {
  test(`status line settings (${name}): install changes only the status line; uninstall restores the file byte for byte`, () => {
    const e = env();
    try {
      if (text !== null) writeFileSync(e.settings, text, { mode: 0o644 });
      const before = existsSync(e.settings) ? readFileSync(e.settings, "utf8") : null;
      const mode = existsSync(e.settings) ? lstatSync(e.settings).mode & 0o777 : null;
      const r = installStatusLine(e.files, SCRIPT);
      assert.equal(r.changed, true);
      const after = readFileSync(e.settings, "utf8");
      const parsed = JSON.parse(after.replace(/^\ufeff/, ""));
      assert.deepEqual(parsed.statusLine, { type: "command", command: SCRIPT, padding: 0 }, "wasitme's line is set");
      if (before !== null) {
        const old = JSON.parse(before.replace(/^\ufeff/, ""));
        for (const k of Object.keys(old)) if (k !== "statusLine") assert.deepEqual(parsed[k], old[k], `key ${k} untouched`);
        assert.equal(lstatSync(e.settings).mode & 0o777, mode, "file mode kept");
        // everything outside the one span is the same text
        const i = after.indexOf(ourFragment(SCRIPT));
        assert.ok(i >= 0);
      }
      assert.equal(statusLineState(e.files, SCRIPT), "ours");
      // a second install is a no-op
      assert.equal(installStatusLine(e.files, SCRIPT).changed, false);
      assert.equal(readFileSync(e.settings, "utf8"), after);
      // the user's own command (if any) is kept for the wrapper
      const was = before === null ? undefined : JSON.parse(before.replace(/^\ufeff/, "")).statusLine;
      const wrapped = typeof was === "object" && was !== null && was.type === "command" && typeof was.command === "string";
      assert.equal(existsSync(join(e.files.backups, "statusline.cmd")), wrapped, "the user's command is saved exactly when there was one");
      assert.equal(r.wrapped, wrapped);
      // uninstall: byte-exact
      const u = uninstallStatusLine(e.files, SCRIPT);
      assert.equal(u.restored, true);
      if (before === null) assert.ok(!existsSync(e.settings), "a file that did not exist is removed again");
      else assert.equal(readFileSync(e.settings, "utf8"), before, "restored byte for byte");
      assert.ok(!existsSync(join(e.files.backups, "statusline.json")), "the backup is gone");
      assert.ok(!existsSync(join(e.files.backups, "statusline.cmd")));
      assert.notEqual(statusLineState(e.files, SCRIPT), "ours");
    } finally {
      e.cleanup();
    }
  });
}

test("status line settings: the user's command is saved verbatim for the wrapper, and only when there was one", () => {
  const e = env();
  try {
    writeFileSync(e.settings, `${JSON.stringify({ statusLine: USER_CMD }, null, 2)}\n`);
    assert.equal(installStatusLine(e.files, SCRIPT).wrapped, true);
    assert.equal(readFileSync(join(e.files.backups, "statusline.cmd"), "utf8"), `${USER_CMD.command}\n`);
    assert.equal(lstatSync(join(e.files.backups, "statusline.cmd")).mode & 0o777, 0o600);
    uninstallStatusLine(e.files, SCRIPT);
    writeFileSync(e.settings, `${JSON.stringify({ a: 1 }, null, 2)}\n`);
    assert.equal(installStatusLine(e.files, SCRIPT).wrapped, false);
    assert.ok(!existsSync(join(e.files.backups, "statusline.cmd")));
  } finally {
    e.cleanup();
  }
});

test("status line settings: uninstall leaves a status line the user changed since, and still removes the backups", () => {
  const e = env();
  try {
    writeFileSync(e.settings, `${JSON.stringify({ a: 1 }, null, 2)}\n`);
    installStatusLine(e.files, SCRIPT);
    const mine = readFileSync(e.settings, "utf8").replace(ourFragment(SCRIPT), JSON.stringify({ type: "command", command: "/usr/local/bin/other" }));
    writeFileSync(e.settings, mine);
    const u = uninstallStatusLine(e.files, SCRIPT);
    assert.deepEqual([u.restored, u.why], [false, "not_ours"]);
    assert.equal(readFileSync(e.settings, "utf8"), mine, "untouched");
    assert.ok(!existsSync(join(e.files.backups, "statusline.json")));
    assert.equal(statusLineState(e.files, SCRIPT), "other");
  } finally {
    e.cleanup();
  }
});

test("status line settings: edits made elsewhere in the file between install and uninstall survive the restore", () => {
  const e = env();
  try {
    const original = `${JSON.stringify({ model: "opus", statusLine: USER_CMD, env: {} }, null, 2)}\n`;
    writeFileSync(e.settings, original);
    installStatusLine(e.files, SCRIPT);
    writeFileSync(e.settings, readFileSync(e.settings, "utf8").replace('"model": "opus"', '"model": "sonnet"'));
    uninstallStatusLine(e.files, SCRIPT);
    assert.equal(readFileSync(e.settings, "utf8"), original.replace('"model": "opus"', '"model": "sonnet"'));
  } finally {
    e.cleanup();
  }
});

test("status line settings: no backup (deleted) still removes wasitme's member and leaves valid JSON", () => {
  for (const text of [`${JSON.stringify({ a: 1 }, null, 2)}\n`, `${JSON.stringify({ a: 1, b: 2 }, null, 2)}\n`, "{}\n"]) {
    const e = env();
    try {
      writeFileSync(e.settings, text);
      installStatusLine(e.files, SCRIPT);
      rmSync(join(e.files.backups, "statusline.json"));
      const u = uninstallStatusLine(e.files, SCRIPT);
      assert.equal(u.restored, true);
      assert.deepEqual(JSON.parse(readFileSync(e.settings, "utf8")), JSON.parse(text));
    } finally {
      e.cleanup();
    }
  }
});

test("status line settings: unsafe files are refused and never changed", () => {
  const e = env();
  try {
    for (const bad of ["not json", "[1,2]", '{"a":', '{"a":1,}', "", "// comment\n{}"]) {
      writeFileSync(e.settings, bad);
      assert.throws(() => installStatusLine(e.files, SCRIPT), StatusLineError, bad);
      assert.equal(readFileSync(e.settings, "utf8"), bad, "unchanged");
      assert.ok(!existsSync(join(e.files.backups, "statusline.json")), "no backup for a refused edit");
    }
    rmSync(e.settings);
    assert.throws(() => installStatusLine(e.files, "/no/such/script"), (x: unknown) => x instanceof StatusLineError && x.kind === "script_missing");
    assert.throws(() => installStatusLine(e.files, "relative/script.sh"), StatusLineError);
    const noFolder = statusLineFiles(join(e.root, "missing-claude-dir"), e.home);
    assert.throws(() => installStatusLine(noFolder, SCRIPT), (x: unknown) => x instanceof StatusLineError && x.kind === "claude_folder_missing");
    // a script that is not executable would leave a dead status line
    const plain = join(e.root, "plain.sh");
    writeFileSync(plain, "#!/bin/sh\n");
    chmodSync(plain, 0o644);
    assert.throws(() => installStatusLine(e.files, plain), (x: unknown) => x instanceof StatusLineError && x.kind === "script_missing");
  } finally {
    e.cleanup();
  }
});

test("status line settings: a symlinked settings file is not followed", () => {
  const e = env();
  try {
    writeFileSync(join(e.root, "real.json"), "{}\n");
    symlinkSync(join(e.root, "real.json"), e.settings);
    assert.throws(() => installStatusLine(e.files, SCRIPT), StatusLineError);
    assert.equal(readFileSync(join(e.root, "real.json"), "utf8"), "{}\n");
  } finally {
    e.cleanup();
  }
});
