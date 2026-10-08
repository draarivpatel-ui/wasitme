/**
 * Reader follow-ups owed to WP-12 (D47f, D51, D52f, D39): cmdCalls, promptEnglish, provider, cross-file origins,
 * dependencies (Claude ParseResult.deps, Codex depKey), and fs.ts never treating a symlinked file as a file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptEnglish } from "../../src/language.js";
import { claudeReader } from "../../src/readers/claude.js";
import { codexReader } from "../../src/readers/codex.js";
import { entries } from "../../src/readers/fs.js";
import { makeHash } from "../../src/util.js";
import { ENGINE_VERSION } from "../../src/version.js";
import { makeRoot, parseSession, pause, replayInto, SessionBuilder, text, toolUseBlock, withRoot, writeSession } from "../fixtures/claude/builder.js";
import { Rollout, testCtx, uuid, writeTree } from "../fixtures/codex/build.js";
import { REPO } from "./helpers.js";

test("promptEnglish: English → 1, other languages / scripts → 0, nothing to judge → undefined", () => {
  for (const s of [
    "please fix the failing test in the parser",
    "why does this break when I run it twice?",
    "lgtm", "continue", "ok go ahead", "refactor parser.ts to use the new API",
    "that's wrong, use the other file instead",
    "Can you add a `--json` flag?\n```ts\nconst x = 1;\n```",
  ]) assert.equal(promptEnglish(s), 1, s);
  for (const s of [
    "por favor arregla el test que falla en el parser",
    "peux-tu corriger le test qui échoue dans le parseur ?",
    "kannst du bitte den Test reparieren, der nicht funktioniert",
    "parserで失敗しているテストを直してください",
    "исправь, пожалуйста, падающий тест",
    "não funciona, você pode corrigir isso?",
  ]) assert.equal(promptEnglish(s), 0, s);
  for (const s of ["", "   ", "42", "🙂🙂", "/tmp/x.ts", "```\ncode only\n```"]) assert.equal(promptEnglish(s), undefined, JSON.stringify(s));
});

test("Claude: cmdCalls counts command calls that ran; rejected and blocked ones are taken back", async () => {
  const s = new SessionBuilder("sess-cmd");
  s.prompt("run the tests and then the linter");
  s.response([toolUseBlock("b1", "Bash", { command: "npm test" }), toolUseBlock("b2", "Bash", { command: "npm run lint" }), toolUseBlock("b3", "Bash", { command: "rm -rf x" }), toolUseBlock("r1", "Read", { file_path: "/synthetic/a.ts" })]);
  s.toolResult("b1", { isError: true, content: "Exit code 1" });
  s.toolResult("b2");
  s.toolResult("b3", { isError: true, content: "The user doesn't want to proceed with this tool use.", denial: "user" });
  s.toolResult("r1");
  const [x] = (await parseSession(s)).exchanges;
  assert.ok(x);
  assert.equal(x.toolCalls, 4);
  assert.equal(x.cmdCalls, 2, "b1 and b2 ran; b3 was rejected");
  assert.ok((x.toolErrorsCmd ?? 0) <= (x.cmdCalls ?? 0));
  assert.equal(x.promptEnglish, 1);
  assert.equal("provider" in x, false, "no Claude log record names a backend: provider stays unset");
});

test("Claude: origins are the opening records' uuids (salted), aligned with exchanges", async () => {
  const s = new SessionBuilder("sess-orig");
  s.prompt("one");
  s.response([text("a")]);
  s.prompt("two");
  s.response([text("b")]);
  const r = await parseSession(s);
  assert.equal(r.origins?.length, r.exchanges.length);
  assert.ok(r.origins!.every((o) => typeof o === "string" && /^o-[0-9a-f]{12}$/.test(o)));
  assert.notEqual(r.origins![0], r.origins![1]);
});

test("Claude: parse reports the sessions it actually replays (ParseResult.deps), not every earlier session", async () => {
  const root = makeRoot();
  const P = "-synthetic-dep";
  const a = new SessionBuilder("sess-a");
  a.prompt("first");
  a.response([text("x")]);
  writeSession(root, P, a);
  await pause();
  const c = new SessionBuilder("sess-c", { start: "2026-09-01T12:00:00.000Z" });
  c.prompt("unrelated");
  c.response([text("z")]);
  writeSession(root, P, c);
  await pause();
  const b = new SessionBuilder("sess-b", { start: "2026-09-02T10:00:00.000Z" });
  replayInto(b, a.records);
  b.prompt("second");
  b.response([text("y")]);
  writeSession(root, P, b);
  await withRoot(root, async () => {
    const sources = claudeReader.list();
    for (const s of sources) assert.equal(s.depKey, undefined, "no pre-parse dependency digest for Claude");
    const byKey = new Map(sources.map((s) => [s.key, s]));
    const rb = await claudeReader.parse(byKey.get(`${P}/sess-b.jsonl`)!, { hash: makeHash("t"), now: new Date("2026-10-04T00:00:00Z"), timeZone: "UTC" });
    assert.deepEqual(rb.deps, [makeHash("t")(`${P}/sess-a.jsonl`, "k-")], "b replays a (not c, created in between), as a salted key id");
    const ra = await claudeReader.parse(byKey.get(`${P}/sess-a.jsonl`)!, { hash: makeHash("t"), now: new Date("2026-10-04T00:00:00Z"), timeZone: "UTC" });
    assert.deepEqual(ra.deps, []);
  });
});

test("Codex: provider (salted label), cmdCalls, promptEnglish and UUID-turn origins on human prompts", async () => {
  const id = uuid(1), turn = uuid(100);
  const content = new Rollout("2026-09-01T10:00:00Z").meta({ id, provider: "synthetic-gateway" })
    .started(turn).ctx(turn).user(turn, "please run the tests").cmd(turn).cmd(turn, { status: "failed", exit: 2 }).fileChange(turn, { "/synthetic/a.ts": "update" })
    .usage(turn, "r1", { input: 10, output: 2 }).complete(turn).text();
  const { root } = writeTree([{ id, content }]);
  const prev = process.env.WASITME_CODEX_DIR;
  process.env.WASITME_CODEX_DIR = root;
  try {
    const sources = codexReader.list();
    codexReader.depKeys!(sources);
    const r = await codexReader.parse(sources[0]!, testCtx());
    const [x] = r.exchanges;
    assert.ok(x);
    assert.match(x.provider ?? "", /^h:[0-9a-f]{8}$/);
    assert.equal(x.cmdCalls, 2);
    assert.equal(x.toolErrorsCmd, 1);
    assert.equal(x.promptEnglish, 1);
    assert.match(r.origins?.[0] ?? "", /^o-[0-9a-f]{12}$/);
    assert.equal(sources[0]!.depKey, undefined, "a lone main thread depends on nothing else");
  } finally {
    if (prev === undefined) delete process.env.WASITME_CODEX_DIR; else process.env.WASITME_CODEX_DIR = prev;
  }
});

test("Codex: depKey of a parent moves when its subagent's rollout changes; a linked child depends on its parent's existence", async () => {
  const P = uuid(10), C = uuid(11), tp = uuid(200), tc = uuid(201);
  const parent = new Rollout("2026-09-01T10:00:00Z").meta({ id: P, threadSource: "user" })
    .started(tp).ctx(tp).user(tp, "spawn a helper").subActivity(tp, C).usage(tp, "rp", { input: 5, output: 1 }).complete(tp).text();
  const child = new Rollout("2026-09-01T10:00:05Z").meta({ id: C, parent: P, source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1 } } }, threadSource: "subagent" })
    .started(tc).ctx(tc, { root: tp }).cmd(tc).usage(tc, "rc", { input: 3, output: 1 }, tp).complete(tc).text();
  const { root, paths } = writeTree([{ id: P, content: parent, stamp: "2026-09-01T10-00-00" }, { id: C, content: child, stamp: "2026-09-01T10-00-05" }]);
  const prev = process.env.WASITME_CODEX_DIR;
  process.env.WASITME_CODEX_DIR = root;
  try {
    const keyOf = () => {
      const s = codexReader.list();
      codexReader.depKeys!(s);
      return new Map(s.map((x) => [x.files[0]!.path, x.depKey]));
    };
    const k1 = keyOf();
    const childPath = paths.get(C)!, parentPath = paths.get(P)!;
    assert.ok(k1.get(parentPath), "parent depends on its child");
    assert.ok(k1.get(childPath), "child depends on its parent (linking)");
    writeFileSync(childPath, readFileSync(childPath, "utf8") + "\n");
    const k2 = keyOf();
    assert.notEqual(k2.get(parentPath), k1.get(parentPath));
    // WP-12 review: rewritten in place at the same size with its mtime restored (only ctime moves), and replaced by a
    // rename at the same size and mtime (a new inode): the parent's dependency key still moves.
    const st = statSync(childPath);
    const body = readFileSync(childPath, "utf8");
    const swapped = body.replace('"input_tokens":3', '"input_tokens":4');
    assert.notEqual(swapped, body);
    writeFileSync(childPath, swapped);
    utimesSync(childPath, st.atimeMs / 1000, st.mtimeMs / 1000); // the same mtime to the sub-millisecond, not a whole-ms Date
    const k3 = keyOf();
    assert.notEqual(k3.get(parentPath), k2.get(parentPath), "same size, same mtime, new bytes");
    writeFileSync(childPath + ".tmp", swapped);
    utimesSync(childPath + ".tmp", st.atimeMs / 1000, st.mtimeMs / 1000);
    renameSync(childPath + ".tmp", childPath);
    assert.notEqual(keyOf().get(parentPath), k3.get(parentPath), "replaced by rename (new inode)");
  } finally {
    if (prev === undefined) delete process.env.WASITME_CODEX_DIR; else process.env.WASITME_CODEX_DIR = prev;
  }
});

test("fs.entries(): a symlinked file is neither a file nor a directory (never followed)", () => {
  const root = makeRoot();
  mkdirSync(join(root, "d"));
  writeFileSync(join(root, "outside.jsonl"), "{}\n");
  writeFileSync(join(root, "d", "real.jsonl"), "{}\n");
  symlinkSync(join(root, "outside.jsonl"), join(root, "d", "link.jsonl"));
  const es = new Map(entries(join(root, "d")).map((e) => [e.name, e]));
  assert.equal(es.get("real.jsonl")!.isFile, true);
  assert.equal(es.get("link.jsonl")!.isFile, false);
  assert.equal(es.get("link.jsonl")!.isDir, false);
});

test("ENGINE_VERSION matches engine/package.json", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "engine", "package.json"), "utf8")) as { version: string };
  assert.equal(ENGINE_VERSION, pkg.version);
});
