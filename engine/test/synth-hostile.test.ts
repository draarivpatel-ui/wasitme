/**
 * The hostile corpus: the committed small tier equals what the generator writes, its canary list is
 * complete by construction, and every fixture really is the trap it claims to be (checked against the
 * shared readJsonl / fs helpers). The full tier (25 MB lines, symlink loops) is generated into a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateHostile, type HostileManifest } from "../src/synth/hostile.js";
import { readTree } from "../src/synth/testkit.js";
import { writeTree } from "../src/synth/write.js";
import { entries, walkFiles } from "../src/readers/fs.js";
import { readJsonl } from "../src/util.js";

const HOSTILE = fileURLToPath(new URL("../../../testdata/hostile/", import.meta.url));

function manifest(): HostileManifest {
  return JSON.parse(readFileSync(join(HOSTILE, "HOSTILE-MANIFEST.json"), "utf8")) as HostileManifest;
}

function treeFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(r);
      else if (e.isFile()) out.push(r);
    }
  };
  visit("");
  return out.sort();
}

async function stats(path: string): Promise<{ objects: number; badLines: number; truncatedTail: number }> {
  const s = { badLines: 0, truncatedTail: 0 };
  let objects = 0;
  for await (const _ of readJsonl(path, s)) objects++;
  return { objects, ...s };
}

test("the committed testdata/hostile tree is exactly the generator's small tier", () => {
  const h = generateHostile("small");
  const root = mkdtempSync(join(tmpdir(), "wasitme-hostile-"));
  try {
    writeTree(join(root, "fresh"), h.files, h.links);
    const fresh = readTree(join(root, "fresh"));
    const committed = readTree(HOSTILE);
    fresh.delete(".wasitme-synth");
    committed.delete(".wasitme-synth");
    assert.deepEqual([...committed.keys()], [...fresh.keys()], "same files (regenerate: node engine/dist/src/synth/cli.js --scenario hostile --out testdata/hostile --replace)");
    for (const [p, e] of fresh) assert.equal(committed.get(p)!.sha256, e.sha256, p);
    assert.equal(h.links.length, 0, "the small tier has no symlinks (they cannot be committed portably)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CANARIES.txt lists every planted sentinel, and only those", () => {
  const m = manifest();
  const canaryLines = readFileSync(join(HOSTILE, "CANARIES.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("# "));
  assert.deepEqual(canaryLines, m.canaries.map((c) => c.value));
  assert.equal(new Set(canaryLines).size, canaryLines.length, "no duplicates");

  const idsInTree = new Set<string>();
  const text: string[] = [];
  for (const rel of treeFiles(HOSTILE)) {
    if (rel === "CANARIES.txt" || rel === "HOSTILE-MANIFEST.json" || rel === ".wasitme-synth") continue;
    const data = readFileSync(join(HOSTILE, rel)).toString("utf8");
    text.push(data);
    // The id also appears in file and directory names (a path canary); count those too.
    for (const hit of (data + "\n" + rel).matchAll(/synthcanary(\d{5})/gi)) idsInTree.add(`SYNTHCANARY${hit[1]}`);
  }
  assert.deepEqual([...idsInTree].sort(), m.canaries.map((c) => c.id).sort(), "ids found in the tree = ids registered");
  const all = text.join("\n");
  for (const c of m.canaries) {
    assert.ok(all.includes(c.value) || treeFiles(HOSTILE).some((p) => p.includes(c.value)), `canary not found in the tree: ${c.id} ${c.kind}`);
    assert.ok(c.where.length > 0, `manifest says where ${c.value} is planted`);
  }
  for (const kind of ["anthropic-key", "openai-key", "github-token", "aws-access-key-id", "email", "private-key-body", "path", "branch", "slug", "tool-input-sentinel", "tool-output-sentinel", "system-prompt-sentinel", "thinking-sentinel", "instructions-sentinel", "queued-sentinel", "prompt-sentinel", "response-sentinel"]) {
    assert.ok(m.canaries.some((c) => c.kind === kind), `kind ${kind}`);
  }
  assert.ok(m.canaries.some((c) => c.where.some((p) => p.startsWith("claude/"))) && m.canaries.some((c) => c.where.some((p) => p.startsWith("codex/"))), "planted in both agents' logs");
});

test("the generic secret shapes match the planted secrets, and the planted ones are off-spec on purpose", () => {
  const m = manifest();
  const tree = treeFiles(HOSTILE).filter((p) => p.endsWith(".jsonl")).map((p) => readFileSync(join(HOSTILE, p), "utf8")).join("\n");
  for (const pat of m.patterns) assert.ok(new RegExp(pat).test(tree), `pattern ${pat} matches something in the tree`);
  for (const c of m.canaries.filter((x) => x.kind === "anthropic-key")) assert.ok(c.value.length < 100, "shorter than a real key");
  for (const c of m.canaries.filter((x) => x.kind === "github-token")) assert.match(c.value, /^ghp_[A-Za-z0-9]{36}$/);
  for (const c of m.canaries.filter((x) => x.kind === "aws-access-key-id")) assert.match(c.value, /^AKIA[0-9A-Z]{16}$/);
  for (const c of m.canaries.filter((x) => x.kind === "email")) assert.match(c.value, /@example\.invalid$/);
});

test("control characters and bidi marks are JSON-escaped on disk but parse to the hostile characters", async () => {
  const rawOk = new Set(manifest().files.filter((f) => ["binary-garbage", "malformed", "bom-crlf"].includes(f.kind)).map((f) => f.path));
  for (const rel of treeFiles(HOSTILE)) {
    if (rawOk.has(rel)) continue; // these exist to carry raw bytes
    const text = readFileSync(join(HOSTILE, rel)).toString("utf8");
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, `${rel}: raw control character`);
    assert.doesNotMatch(text, /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/, `${rel}: raw bidi / zero-width mark`);
  }
  const m = manifest();
  assert.ok(m.poison.length >= 12 && m.poison.every((p) => p.escaped.length > 0));
  const labels = treeFiles(HOSTILE).find((p) => p.includes("hostile-labels"))!;
  const recs: Record<string, unknown>[] = [];
  for await (const r of readJsonl(join(HOSTILE, labels), { badLines: 0, truncatedTail: 0 })) recs.push(r);
  const first = recs.find((r) => r.type === "user")!;
  assert.equal(first.version, "\u001b[31m2.1.289\u001b[0m");
  assert.equal(first.entrypoint, 'cli"><img src=x onerror=alert(1)>');
  assert.equal(first.permissionMode, "default\u2066");
  assert.ok(String(first.gitBranch).includes("</script>"));
  const assistant = recs.find((r) => r.type === "assistant")!;
  assert.equal((assistant.message as { model: string }).model, "claude-opus-5-5\u202e");
  assert.equal(assistant.effort, "<script>alert(1)</script>");
  const codex = treeFiles(HOSTILE).find((p) => p.startsWith("codex/sessions") && readFileSync(join(HOSTILE, p), "utf8").includes("\\u001b[31m0.160.0"))!;
  const meta: Record<string, unknown>[] = [];
  for await (const r of readJsonl(join(HOSTILE, codex), { badLines: 0, truncatedTail: 0 })) meta.push(r);
  assert.equal((meta[0]!.payload as { cli_version: string }).cli_version, "\u001b[31m0.160.0\u001b[0m");
});

test("every planted file reads back with exactly the planted bad lines and truncated tail (readJsonl)", async () => {
  const m = manifest();
  let checked = 0;
  for (const f of m.files) {
    if (!f.path.endsWith(".jsonl") || f.badLines === null) continue;
    const full = join(HOSTILE, f.path);
    if (lstatSync(full).isDirectory()) continue;
    const s = await stats(full);
    assert.equal(s.badLines, f.badLines, `${f.path} (${f.kind}) bad lines`);
    assert.equal(s.truncatedTail, f.truncatedTail, `${f.path} (${f.kind}) truncated tail`);
    if (["zero-byte", "blank-only", "non-jsonl", "binary-garbage"].includes(f.kind)) assert.equal(s.objects, 0, `${f.path} has no records`);
    checked++;
  }
  assert.ok(checked >= 15, `${checked} files checked`);
  const kinds = new Set(m.files.map((f) => f.kind));
  for (const k of ["secrets", "poison-labels", "malformed", "bom-crlf", "deep-nesting", "line-separators", "binary-garbage", "zero-byte", "blank-only", "non-jsonl", "dir-named-jsonl", "orphan-subagent", "archived-duplicate", "legacy-format", "fork-of-nothing"]) assert.ok(kinds.has(k), k);
});

test("U+2028 / U+2029 inside strings survive readJsonl, and a smuggled record stays inside its prompt", async () => {
  const path = join(HOSTILE, treeFiles(HOSTILE).find((p) => p.includes("hostile-lineseps"))!);
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.includes("\u2028") && raw.includes("\u2029"), "raw separators are on disk");
  const recs: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for await (const r of readJsonl(path, { badLines: 0, truncatedTail: 0 })) recs.push(r);
  assert.equal(recs.length, raw.split("\n").filter(Boolean).length, "one record per newline-terminated line");
  const prompts = recs.filter((r) => r.type === "user" && r.origin?.kind === "human");
  assert.equal(prompts.length, 2);
  assert.match(String(prompts[0]!.message.content), /^first half\u2028\{"type":"user"/, "the smuggled record is just text");
  assert.ok(raw.split(/\r\n|\r|\n|\u2028|\u2029/).length > raw.split("\n").length, "a readline-style splitter would see extra lines");
});

test("deep nesting: the record parses, and its depth is what the manifest says", async () => {
  const path = join(HOSTILE, treeFiles(HOSTILE).find((p) => p.includes("hostile-deep"))!);
  let depth = 0;
  for await (const r of readJsonl(path, { badLines: 0, truncatedTail: 0 })) {
    let v: unknown = r.toolUseResult;
    let d = 0;
    while (v && typeof v === "object" && "a" in (v as object)) { v = (v as { a: unknown }).a; d++; }
    depth = Math.max(depth, d);
  }
  assert.equal(depth, 3000);
});

test("full tier: a 25 MB line is one skipped bad line and reading resumes; 200k-deep JSON parses but overflows recursion; symlinks never escape", async () => {
  const h = generateHostile("full");
  const root = mkdtempSync(join(tmpdir(), "wasitme-hostile-full-"));
  try {
    writeTree(join(root, "tree"), h.files, h.links);
    const tree = join(root, "tree");
    const big = treeFiles(tree).filter((p) => p.includes("hostile-big"));
    const m = JSON.parse(readFileSync(join(tree, "HOSTILE-MANIFEST.json"), "utf8")) as HostileManifest;
    const huge = m.files.find((f) => f.kind === "huge-line" && f.path.startsWith("claude/"))!;
    const hugeStats = await stats(join(tree, huge.path));
    assert.equal(hugeStats.badLines, 1, "the 25 MB line is skipped");
    assert.equal(hugeStats.objects, 3, "the records before and after it still parse (prompt, prompt, answer)");
    assert.ok(readFileSync(join(tree, huge.path)).length > 25 * 1024 * 1024);
    const codexHuge = m.files.find((f) => f.kind === "huge-line" && f.path.startsWith("codex/"))!;
    const cs = await stats(join(tree, codexHuge.path));
    assert.equal(cs.badLines, 1);
    assert.ok(cs.objects >= 6);

    const long = m.files.find((f) => f.kind === "long-line")!;
    const ls = await stats(join(tree, long.path));
    assert.deepEqual([ls.badLines, ls.objects], [0, 3], "a 1.2 MB line is under the cap");

    const deep = m.files.find((f) => f.kind === "deep-nesting-200k")!;
    const walk = (v: unknown): number => (v && typeof v === "object" ? 1 + Math.max(0, ...Object.values(v).map(walk)) : 0);
    let parsed = 0;
    for await (const r of readJsonl(join(tree, deep.path), { badLines: 0, truncatedTail: 0 })) {
      if (r.toolUseResult === undefined) continue;
      parsed++;
      assert.throws(() => walk(r), RangeError, "a hand-written recursive walker overflows the stack on this record");
    }
    assert.equal(parsed, 1, "the 200,000-deep record parses");
    assert.ok(big.length >= 3);

    // Symlinks: loop, mutual pair, and a directory outside the scanned tree.
    const links = join(tree, "claude", "projects", "-Users-syn-user-code-hostile-links");
    for (const name of ["loop", "a", "b", "outside-link"]) assert.ok(lstatSync(join(links, name)).isSymbolicLink(), name);
    assert.ok(entries(links).filter((e) => ["loop", "a", "b", "outside-link"].includes(e.name)).every((e) => !e.isDir && !e.isFile), "the shared fs helper reports symlinked dirs as neither dirs nor files");
    const found = walkFiles(join(tree, "claude", "projects"), (n) => n.endsWith(".jsonl"));
    assert.ok(found.length > 10);
    assert.ok(found.every((p) => !p.includes(`${join(tree, "outside")}`) && !p.includes("/outside/")), "walkFiles terminates and never returns a file from outside the tree");
    const outsideSession = treeFiles(join(tree, "outside"))[0]!;
    assert.ok(readFileSync(join(tree, "outside", outsideSession), "utf8").includes('"version":"9.9.9"'));
    assert.ok(!found.some((p) => readFileSync(p).toString("utf8", 0, 4000).includes('"version":"9.9.9"')), "no outside-tree record leaks into the walk");
    const canary = m.canaries.filter((c) => c.kind === "big-line-sentinel");
    assert.equal(canary.length, 2);
    assert.ok(readFileSync(join(tree, huge.path), "utf8").includes(canary[0]!.value), "canary at the start of the huge line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
