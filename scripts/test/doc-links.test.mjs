// Tests of scripts/lib/doc-links.mjs, and the real check: every relative link and #anchor in this repository's Markdown
// resolves, and no document that ships links to a path that does not ship (the export-ignore list in .gitattributes).
// scripts/dev/export-public.sh runs this same file inside the exported tree, where there is no .gitattributes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorsOf, checkLinks, internalPaths, linksIntoInternal, linksOf, markdownFiles, maskCode, slugify } from "../lib/doc-links.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "wasitme-doclinks-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

test("slugify follows GitHub's heading anchors", () => {
  assert.equal(slugify("14. Calibration"), "14-calibration");
  assert.equal(slugify("What the calibration runs so far show"), "what-the-calibration-runs-so-far-show");
  assert.equal(slugify("The `--until` flag, and [a link](x.md)!"), "the---until-flag-and-a-link");
  assert.equal(slugify("Honest limits & caveats"), "honest-limits--caveats");
  assert.equal(slugify("Über die Grenze"), "über-die-grenze");
});

test("anchorsOf numbers repeated headings and ignores headings inside code fences", () => {
  const a = anchorsOf("# Same\n\n## Same\n\n```md\n# not a heading\n```\n\nSetext\n======\n\n<a id=\"custom\"></a>\n");
  assert.deepEqual([...a].sort(), ["custom", "same", "same-1", "setext"]);
});

test("linksOf ignores code and reads inline, angle-bracket and reference links", () => {
  const text = [
    "See [a](a.md) and [b](<b c.md#x> \"title\") and `[no](code.md)`.",
    "```",
    "[no](fenced.md)",
    "```",
    "[ref]: other.md#top",
  ].join("\n");
  assert.deepEqual(linksOf(text).map((l) => l.target), ["a.md", "b c.md#x", "other.md#top"]);
  assert.equal(maskCode("a `b` c").length, "a `b` c".length);
});

test("linksOf reads HTML image sources: <img src> and every <source srcset> candidate, not code", () => {
  const text = [
    "<picture>",
    "  <source media=\"(prefers-color-scheme: dark)\" srcset=\"docs/images/a-dark.png, docs/images/a-dark@2x.png 2x\">",
    "  <img src='docs/images/a.png' alt=\"x\" width=\"800\">",
    "</picture>",
    "`<img src=\"code.png\">`",
  ].join("\n");
  assert.deepEqual(linksOf(text).map((l) => `${l.line} ${l.target}`), ["2 docs/images/a-dark.png", "2 docs/images/a-dark@2x.png", "3 docs/images/a.png"]);
  const root = tree({ "README.md": "<img src=\"docs/missing.png\" alt=\"x\">\n<source srcset=\"docs/ok.png\">\n", "docs/ok.png": "png" });
  try {
    assert.deepEqual(checkLinks(root).map((p) => `${p.file}:${p.line} ${p.target} -> ${p.problem}`), ["README.md:1 docs/missing.png -> file or folder does not exist"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkLinks finds a missing file, a missing anchor and a link that leaves the repository; accepts good ones", () => {
  const root = tree({
    "README.md": [
      "# Top",
      "[ok](docs/A.md) [ok anchor](docs/A.md#second-part) [self](#top) [dir](docs/) [ext](https://example.com/x)",
      "[missing](docs/NOPE.md) [bad anchor](docs/A.md#nope) [escape](../outside.md) [self bad](#nothing)",
      "[line](docs/A.md#L3)",
    ].join("\n"),
    "docs/A.md": "# A\n\n## Second part\n\ntext\n",
  });
  try {
    const got = checkLinks(root).map((p) => `${p.file}:${p.line} ${p.target} -> ${p.problem}`);
    assert.deepEqual(got, [
      "README.md:3 docs/NOPE.md -> file or folder does not exist",
      "README.md:3 docs/A.md#nope -> no heading or anchor \"#nope\" in docs/A.md",
      "README.md:3 ../outside.md -> leaves the repository",
      "README.md:3 #nothing -> no heading or anchor \"#nothing\" in README.md",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linksIntoInternal flags a shipped document that links to an export-ignored path, and only that", () => {
  const root = tree({
    ".gitattributes": "# internal\n.gitattributes export-ignore\ndocs/STATUS.md export-ignore\ndocs/private export-ignore\n",
    "README.md": "[status](docs/STATUS.md) [fine](docs/OK.md) [priv](docs/private/notes.md#x)\n",
    "docs/OK.md": "ok\n",
    "docs/STATUS.md": "[readme](../README.md) [mine](OK.md)\n",
    "docs/private/notes.md": "[any](../OK.md)\n",
  });
  try {
    assert.deepEqual(internalPaths(root), [".gitattributes", "docs/STATUS.md", "docs/private"]);
    const got = linksIntoInternal(root).map((l) => `${l.file}:${l.line} ${l.target} -> ${l.internal}`);
    assert.deepEqual(got, ["README.md:1 docs/STATUS.md -> docs/STATUS.md", "README.md:1 docs/private/notes.md#x -> docs/private"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("internalPaths refuses a glob it could not check, and is empty without a .gitattributes", () => {
  const withGlob = tree({ ".gitattributes": "docs/*.md export-ignore\n" });
  const none = tree({ "README.md": "x\n" });
  try {
    assert.throws(() => internalPaths(withGlob), /not a plain path/);
    assert.deepEqual(internalPaths(none), []);
  } finally {
    rmSync(withGlob, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  }
});

test("every relative link and heading anchor in this repository's Markdown resolves", () => {
  const files = markdownFiles(ROOT);
  assert.ok(files.length > 5, `found only ${files.length} Markdown files; is ROOT right?`);
  const problems = checkLinks(ROOT, files);
  assert.deepEqual(problems.map((p) => `${p.file}:${p.line} (${p.target}): ${p.problem}`), []);
});

test("no document that ships links to a path that does not ship", () => {
  const got = linksIntoInternal(ROOT);
  assert.deepEqual(got.map((l) => `${l.file}:${l.line} (${l.target}) is internal: ${l.internal}`), []);
});
