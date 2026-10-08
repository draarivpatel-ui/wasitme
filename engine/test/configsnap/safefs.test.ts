import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { defaultAvoidDirs } from "../../src/extract/configsnap/index.js";
import { isProtected, listMarkedChildren, makeGuard, readCapped, resolveSafe } from "../../src/extract/configsnap/safefs.js";
import { Fixture } from "./helpers.js";

const fx = new Fixture();
after(() => fx.cleanup());

const noGuard = makeGuard([]);

test("readCapped: regular file, missing file, directory", () => {
  const p = fx.write("plain/a.txt", "hello\nworld\n");
  const r = readCapped(p, 1024, noGuard);
  assert.equal(r.access, "ok");
  assert.equal(r.buf!.toString(), "hello\nworld\n");
  assert.equal(r.size, 12);
  assert.equal(r.capped, false);

  assert.equal(readCapped(fx.path("plain", "nope.txt"), 1024, noGuard).access, "missing");
  assert.equal(readCapped(fx.path("plain", "a.txt", "child"), 1024, noGuard).access, "missing"); // ENOTDIR
  assert.equal(readCapped(fx.path("plain"), 1024, noGuard).access, "not-file");
});

test("readCapped never reads more than the cap and reports the real size", () => {
  const p = fx.write("big/b.txt", Buffer.alloc(3 * 1024 * 1024, 97));
  const r = readCapped(p, 1 << 20, noGuard);
  assert.equal(r.access, "ok");
  assert.equal(r.buf!.length, 1 << 20);
  assert.equal(r.size, 3 * 1024 * 1024);
  assert.equal(r.capped, true);
});

test("readCapped: empty file", () => {
  const r = readCapped(fx.write("empty/e.txt", ""), 1024, noGuard);
  assert.equal(r.access, "ok");
  assert.equal(r.buf!.length, 0);
  assert.equal(r.capped, false);
});

test("readCapped follows a symlink to a regular file", () => {
  const target = fx.write("dotfiles/CLAUDE.md", "linked");
  fx.link("home1/CLAUDE.md", target);
  const r = readCapped(fx.path("home1", "CLAUDE.md"), 1024, noGuard);
  assert.equal(r.access, "ok");
  assert.equal(r.buf!.toString(), "linked");
});

test("readCapped follows relative symlinks and symlinked directory components", () => {
  fx.write("real/dir/f.txt", "deep");
  fx.link("rel/link.txt", "../real/dir/f.txt");
  assert.equal(readCapped(fx.path("rel", "link.txt"), 64, noGuard).buf!.toString(), "deep");
  fx.link("dirlink", fx.path("real", "dir"));
  assert.equal(readCapped(fx.path("dirlink", "f.txt"), 64, noGuard).buf!.toString(), "deep");
});

test("readCapped: dangling symlink is missing, loops are unreadable (no hang)", () => {
  fx.link("dangling/l", fx.path("nowhere", "x"));
  assert.equal(readCapped(fx.path("dangling", "l"), 64, noGuard).access, "missing");
  fx.link("loop/a", fx.path("loop", "b"));
  fx.link("loop/b", fx.path("loop", "a"));
  assert.equal(readCapped(fx.path("loop", "a"), 64, noGuard).access, "unreadable");
});

test("readCapped: a symlink to a directory is not-file", () => {
  fx.mkdir("somedir");
  fx.link("dl/d", fx.path("somedir"));
  assert.equal(readCapped(fx.path("dl", "d"), 64, noGuard).access, "not-file");
});

test("readCapped: a FIFO or device symlinked in cannot hang the reader", { skip: process.platform === "win32" }, () => {
  const fifo = fx.path("special", "fifo");
  fx.mkdir("special");
  execFileSync("mkfifo", [fifo]);
  const t0 = Date.now();
  assert.equal(readCapped(fifo, 64, noGuard).access, "not-file");
  fx.link("special/zero", "/dev/zero");
  assert.equal(readCapped(fx.path("special", "zero"), 64, noGuard).access, "not-file");
  assert.ok(Date.now() - t0 < 2000);
});

test("avoided folders are never touched, even through symlinks", () => {
  const docs = fx.path("Documents");
  const guard = makeGuard([docs]);
  assert.equal(isProtected(join(docs, "x"), guard), true);
  assert.equal(isProtected(docs, guard), true);
  assert.equal(isProtected(join(fx.home, "DocumentsOther"), guard), false);
  assert.equal(isProtected(join(fx.home, "documents", "x"), guard), true, "case-insensitive");

  // Real file inside the avoided folder: reported protected, content not returned.
  const secret = fx.write("Documents/dotfiles/CLAUDE.md", "SECRET");
  fx.link("prot/CLAUDE.md", secret);
  const r = readCapped(fx.path("prot", "CLAUDE.md"), 64, guard);
  assert.equal(r.access, "protected");
  assert.equal(r.buf, undefined);

  // A DANGLING link into the avoided folder is "protected", not "missing": proof the target was never even lstat'ed.
  fx.link("prot/dangling.md", join(docs, "does", "not", "exist.md"));
  assert.equal(readCapped(fx.path("prot", "dangling.md"), 64, guard).access, "protected");

  // Relative link that escapes into it via "..".
  fx.link("prot/rel.md", "../Documents/dotfiles/CLAUDE.md");
  assert.equal(readCapped(fx.path("prot", "rel.md"), 64, guard).access, "protected");

  // Chain: link -> link -> avoided.
  fx.link("prot/hop2.md", fx.path("prot", "dangling.md"));
  assert.equal(readCapped(fx.path("prot", "hop2.md"), 64, guard).access, "protected");

  // A directory component that links into it.
  fx.link("prot/dirlink", docs);
  assert.equal(readCapped(fx.path("prot", "dirlink", "dotfiles", "CLAUDE.md"), 64, guard).access, "protected");

  // Without the guard the same read works (so the guard, not the fixture, is what blocks it).
  assert.equal(readCapped(fx.path("prot", "CLAUDE.md"), 64, noGuard).buf!.toString(), "SECRET");
});

test("makeGuard also matches the resolved spelling when home is behind a symlink", () => {
  fx.mkdir("real-home/Documents");
  fx.link("fake-home", fx.path("real-home"));
  const guard = makeGuard([fx.path("fake-home", "Documents")]);
  fx.write("real-home/Documents/x.md", "s");
  assert.equal(readCapped(fx.path("fake-home", "Documents", "x.md"), 8, guard).access, "protected");
  fx.write("real-home/other/y.md", "ok");
  fx.link("real-home/link.md", fx.path("real-home", "Documents", "x.md"));
  assert.equal(readCapped(fx.path("fake-home", "link.md"), 8, guard).access, "protected");
});

test("defaultAvoidDirs: macOS protected folders only on darwin", () => {
  const d = defaultAvoidDirs("/Users/x", "darwin");
  assert.ok(d.includes(join("/Users/x", "Documents")));
  assert.ok(d.includes(join("/Users/x", "Desktop")));
  assert.ok(d.includes(join("/Users/x", "Downloads")));
  assert.ok(d.includes(join("/Users/x", "Library", "Mobile Documents")));
  assert.deepEqual(defaultAvoidDirs("/home/x", "linux"), []);
  assert.deepEqual(defaultAvoidDirs("C:\\Users\\x", "win32"), []);
});

test("resolveSafe: dot segments and root", () => {
  fx.mkdir("a/b");
  const r = resolveSafe(fx.path("a", "b", "..", "b", "."), noGuard);
  assert.equal(r.status, "ok");
  assert.equal(resolveSafe("/", noGuard).status, "ok");
});

test("listMarkedChildren: counts dirs with the marker, follows file-system symlinks, skips dot dirs", () => {
  fx.write("skills1/alpha/SKILL.md", "x");
  fx.write("skills1/beta/SKILL.md", "x");
  fx.write("skills1/no-marker/readme.md", "x");
  fx.write("skills1/.system/SKILL.md", "x");
  fx.write("skills1/loose-file.md", "x");
  fx.write("shared/gamma/SKILL.md", "x");
  fx.link("skills1/gamma", fx.path("shared", "gamma"));
  fx.mkdir("shared/empty");
  fx.link("skills1/empty-link", fx.path("shared", "empty"));
  fx.link("skills1/dangling-link", fx.path("shared", "gone"));
  const r = listMarkedChildren(fx.path("skills1"), "SKILL.md", noGuard);
  assert.equal(r.access, "ok");
  assert.deepEqual(r.names, ["alpha", "beta", "gamma"]);
  assert.equal(r.partial, false);
});

test("listMarkedChildren: symlinked entries into an avoided folder are counted by name, unverified, flagged partial", () => {
  const docs = fx.path("Documents2");
  fx.write("Documents2/skills/zed/SKILL.md", "x");
  fx.write("skills2/real/SKILL.md", "x");
  fx.link("skills2/zed", fx.path("Documents2", "skills", "zed"));
  const guard = makeGuard([docs]);
  const r = listMarkedChildren(fx.path("skills2"), "SKILL.md", guard);
  assert.deepEqual(r.names, ["real", "zed"]);
  assert.equal(r.partial, true);
});

test("listMarkedChildren: missing dir, file instead of dir, entry limit", () => {
  assert.equal(listMarkedChildren(fx.path("nope"), "SKILL.md", noGuard).access, "missing");
  fx.write("afile", "x");
  assert.equal(listMarkedChildren(fx.path("afile"), "SKILL.md", noGuard).access, "missing");
  for (let i = 0; i < 12; i++) fx.write(`many/s${String(i).padStart(2, "0")}/SKILL.md`, "x");
  const r = listMarkedChildren(fx.path("many"), "SKILL.md", noGuard, 5);
  assert.equal(r.names.length, 5);
  assert.equal(r.partial, true);
});
